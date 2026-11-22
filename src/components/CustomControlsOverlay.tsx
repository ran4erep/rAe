import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  clampPct,
  ControlButtonSize,
  CustomControlProfile,
  dispatchTargetActions,
  expandControlTarget,
  getTargetAriaLabel,
  getTargetDisplayLabel,
  SingleControlTarget,
  singleTargetKey,
  StickDirection,
  TargetHoldManager,
} from '../emulator/controls/customProfiles';
import { triggerHaptic } from '../emulator/haptics';
import { JoystickState } from '../emulator/types';
import { useSuppressBrowserTouchHold } from '../hooks/useSuppressBrowserTouchHold';
import { CustomSelection } from './CustomEditToolbar';

interface CustomControlsOverlayProps {
  fullscreenOverlay?: boolean;
  profile: CustomControlProfile;
  editMode: boolean;
  selection: CustomSelection;
  onSelect: (sel: CustomSelection) => void;
  onOpenButtonPicker: (buttonId: string) => void;
  onMoveButton: (buttonId: string, xPct: number, yPct: number) => void;
  onMoveStick: (xPct: number, yPct: number) => void;
  onKeyEvent: (rawCode: number, isDown: boolean) => void;
  onJoystickChange: (patch: Partial<JoystickState>) => void;
  onMouseMove: (dx: number, dy: number) => void;
  onMouseButton: (left?: boolean, right?: boolean) => void;
  onUserInteract: () => void;
}

const BUTTON_SIZE_CLASSES: Record<ControlButtonSize, string> = {
  sm: 'min-w-[44px] h-9 px-2.5 text-[11px]',
  md: 'min-w-[58px] h-11 px-3.5 text-xs',
  lg: 'min-w-[76px] h-14 px-4 text-sm',
};

const STICK_SIZE_CLASSES: Record<ControlButtonSize, { pad: string; knob: string }> = {
  sm: { pad: 'w-24 h-24', knob: 'w-10 h-10' },
  md: { pad: 'w-32 h-32', knob: 'w-14 h-14' },
  lg: { pad: 'w-40 h-40', knob: 'w-16 h-16' },
};

export const CustomControlsOverlay: React.FC<CustomControlsOverlayProps> = React.memo(
  ({
    fullscreenOverlay = false,
    profile,
    editMode,
    selection,
    onSelect,
    onOpenButtonPicker,
    onMoveButton,
    onMoveStick,
    onKeyEvent,
    onJoystickChange,
    onMouseMove,
    onMouseButton,
    onUserInteract,
  }) => {
    const touchSurfaceRef = useRef<HTMLDivElement | null>(null);
    useSuppressBrowserTouchHold(touchSurfaceRef);

    // Active play state refs (kept outside React render loop for minimal CPU load)
    const holdManagerRef = useRef<TargetHoldManager>(new TargetHoldManager());
    const [pressedButtons, setPressedButtons] = useState<Record<string, boolean>>({});
    const [stickActiveDirs, setStickActiveDirs] = useState({
      up: false,
      down: false,
      left: false,
      right: false,
    });

    // Stick DOM refs
    const stickPadRef = useRef<HTMLDivElement | null>(null);
    const stickKnobRef = useRef<HTMLDivElement | null>(null);
    const stickPointerId = useRef<number | null>(null);
    const prevStickDirKey = useRef<string>('0000');

    // Background mouse trackpad refs
    const bgMousePointer = useRef<{
      id: number;
      startX: number;
      startY: number;
      lastX: number;
      lastY: number;
      downTime: number;
      moved: boolean;
      tapHoldDrag: boolean;
    } | null>(null);
    const bgMouseGlowRef = useRef<HTMLDivElement | null>(null);
    const bgRectRef = useRef<{ left: number; top: number } | null>(null);
    const lastBgTapUpTime = useRef<number>(0);
    const bgSubpixelRem = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
    const bgClickTimer = useRef<number | null>(null);

    // Edit-mode zero-re-render drag ref
    const dragRef = useRef<{
      kind: 'button' | 'stick';
      id: string;
      pointerId: number;
      startX: number;
      startY: number;
      origXPct: number;
      origYPct: number;
      latestXPct: number;
      latestYPct: number;
      moved: boolean;
      el: HTMLElement;
    } | null>(null);

    const stickRef = useRef(profile.stick);
    stickRef.current = profile.stick;

    const releaseAllHeldControls = useCallback(() => {
      prevStickDirKey.current = '0000';
      if (stickKnobRef.current) {
        stickKnobRef.current.style.transform = 'translate3d(0px, 0px, 0)';
      }

      const actions = holdManagerRef.current.releaseAll();
      if (actions.length > 0) {
        dispatchTargetActions(actions, { onKeyEvent, onJoystickChange, onMouseButton });
      }
      setPressedButtons({});
      setStickActiveDirs({ up: false, down: false, left: false, right: false });
    }, [onJoystickChange, onKeyEvent, onMouseButton]);

    useEffect(() => {
      if (editMode) {
        releaseAllHeldControls();
      }
    }, [editMode, releaseAllHeldControls]);

    useEffect(() => {
      return () => {
        if (bgClickTimer.current !== null) window.clearTimeout(bgClickTimer.current);
        releaseAllHeldControls();
      };
    }, [releaseAllHeldControls]);

    // ---------------- Background Borderless Mouse Trackpad ----------------
    const updateBgGlow = (clientX: number, clientY: number, visible: boolean) => {
      const glow = bgMouseGlowRef.current;
      const surface = touchSurfaceRef.current;
      if (!glow || !surface) return;
      if (!visible) {
        glow.style.opacity = '0';
        return;
      }
      let rect = bgRectRef.current;
      if (!rect) {
        const b = surface.getBoundingClientRect();
        rect = { left: b.left, top: b.top };
        bgRectRef.current = rect;
      }
      const lx = clientX - rect.left - 34;
      const ly = clientY - rect.top - 34;
      glow.style.transform = `translate3d(${lx.toFixed(1)}px, ${ly.toFixed(1)}px, 0px)`;
      glow.style.opacity = '1';
    };

    const handleBgPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.target !== e.currentTarget && e.target !== bgMouseGlowRef.current) return;
      e.preventDefault();
      onUserInteract();

      if (editMode) {
        onSelect(null);
        return;
      }

      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Ignore
      }

      const b = e.currentTarget.getBoundingClientRect();
      bgRectRef.current = { left: b.left, top: b.top };
      updateBgGlow(e.clientX, e.clientY, true);

      const now = performance.now();
      const isTapHoldDrag = now - lastBgTapUpTime.current < 240;
      if (isTapHoldDrag) {
        onMouseButton(true, undefined);
        triggerHaptic(10);
      }

      bgMousePointer.current = {
        id: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        downTime: now,
        moved: false,
        tapHoldDrag: isTapHoldDrag,
      };
    };

    const handleBgPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
      const p = bgMousePointer.current;
      if (!p || p.id !== e.pointerId || editMode) return;
      e.preventDefault();
      updateBgGlow(e.clientX, e.clientY, true);

      const dx = e.clientX - p.lastX;
      const dy = e.clientY - p.lastY;
      p.lastX = e.clientX;
      p.lastY = e.clientY;

      if (!p.moved && Math.hypot(e.clientX - p.startX, e.clientY - p.startY) > 5) {
        p.moved = true;
      }

      if (dx !== 0 || dy !== 0) {
        const fx = bgSubpixelRem.current.x + dx * 1.45;
        const fy = bgSubpixelRem.current.y + dy * 1.45;
        const ix = Math.trunc(fx);
        const iy = Math.trunc(fy);
        bgSubpixelRem.current.x = fx - ix;
        bgSubpixelRem.current.y = fy - iy;
        if (ix !== 0 || iy !== 0) {
          onMouseMove(ix, iy);
        }
      }
    };

    const handleBgPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
      const p = bgMousePointer.current;
      if (!p || p.id !== e.pointerId) return;
      bgMousePointer.current = null;
      bgRectRef.current = null;
      updateBgGlow(0, 0, false);

      if (p.tapHoldDrag) {
        onMouseButton(false, undefined);
        lastBgTapUpTime.current = 0;
        return;
      }

      const now = performance.now();
      if (!p.moved && now - p.downTime < 260) {
        lastBgTapUpTime.current = now;
        triggerHaptic(8);
        if (bgClickTimer.current !== null) window.clearTimeout(bgClickTimer.current);
        onMouseButton(true, undefined);
        bgClickTimer.current = window.setTimeout(() => {
          onMouseButton(false, undefined);
          bgClickTimer.current = null;
        }, 65);
      }
    };

    // ---------------- Customizable 8-way Stick (Play Mode) ----------------
    const updatePlayStick = (clientX: number, clientY: number) => {
      const el = stickPadRef.current;
      const stickCfg = stickRef.current;
      if (!el || !stickCfg) return;
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const radius = rect.width * 0.42;
      let dx = clientX - cx;
      let dy = clientY - cy;
      const dist = Math.hypot(dx, dy);
      if (dist > radius) {
        dx = (dx / dist) * radius;
        dy = (dy / dist) * radius;
      }

      if (stickKnobRef.current) {
        stickKnobRef.current.style.transform = `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0)`;
      }

      const dead = radius * 0.24;
      const next = {
        left: dx < -dead,
        right: dx > dead,
        up: dy < -dead,
        down: dy > dead,
      };
      const dirKey = `${next.up ? 1 : 0}${next.down ? 1 : 0}${next.left ? 1 : 0}${next.right ? 1 : 0}`;
      if (dirKey !== prevStickDirKey.current) {
        prevStickDirKey.current = dirKey;
        if (dirKey !== '0000') triggerHaptic(8);
        const dirs: StickDirection[] = ['up', 'down', 'left', 'right'];
        const nextTargets: SingleControlTarget[] = [];
        const seenKeys = new Set<string>();
        for (const d of dirs) {
          if (!next[d]) continue;
          for (const single of expandControlTarget(stickCfg[d])) {
            const k = singleTargetKey(single);
            if (!seenKeys.has(k)) {
              seenKeys.add(k);
              nextTargets.push(single);
            }
          }
        }
        const actions = holdManagerRef.current.setSource('stick', nextTargets);
        dispatchTargetActions(actions, { onKeyEvent, onJoystickChange, onMouseButton });
        setStickActiveDirs(next);
      }
    };

    const handleStickPlayDown = (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      onUserInteract();
      stickPointerId.current = e.pointerId;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Ignore
      }
      updatePlayStick(e.clientX, e.clientY);
    };

    const handleStickPlayMove = (e: React.PointerEvent<HTMLDivElement>) => {
      if (stickPointerId.current !== e.pointerId) return;
      e.preventDefault();
      e.stopPropagation();
      updatePlayStick(e.clientX, e.clientY);
    };

    const handleStickPlayUp = (e: React.PointerEvent<HTMLDivElement>) => {
      if (stickPointerId.current !== e.pointerId) return;
      e.stopPropagation();
      stickPointerId.current = null;
      prevStickDirKey.current = '0000';
      if (stickKnobRef.current) {
        stickKnobRef.current.style.transform = 'translate3d(0px, 0px, 0)';
      }
      const cleared = { up: false, down: false, left: false, right: false };
      const actions = holdManagerRef.current.setSource('stick', []);
      dispatchTargetActions(actions, { onKeyEvent, onJoystickChange, onMouseButton });
      setStickActiveDirs(cleared);
    };

    // ---------------- Edit-Mode Zero-Render Dragging ----------------
    const startEditDrag = (
      kind: 'button' | 'stick',
      id: string,
      origXPct: number,
      origYPct: number,
      e: React.PointerEvent<HTMLElement>
    ) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Ignore
      }
      onSelect(kind === 'button' ? { kind: 'button', id } : { kind: 'stick' });
      dragRef.current = {
        kind,
        id,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        origXPct,
        origYPct,
        latestXPct: origXPct,
        latestYPct: origYPct,
        moved: false,
        el: e.currentTarget,
      };
    };

    const moveEditDrag = (e: React.PointerEvent<HTMLElement>) => {
      const d = dragRef.current;
      const surface = touchSurfaceRef.current;
      if (!d || d.pointerId !== e.pointerId || !surface) return;
      e.preventDefault();
      e.stopPropagation();

      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (!d.moved && Math.hypot(dx, dy) > 5) {
        d.moved = true;
      }

      const rect = surface.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      const minX = d.kind === 'stick' ? 6 : 4;
      const maxX = d.kind === 'stick' ? 94 : 96;
      const minY = d.kind === 'stick' ? 10 : 6;
      const maxY = d.kind === 'stick' ? 90 : 94;

      const nextX = clampPct(d.origXPct + (dx / rect.width) * 100, minX, maxX);
      const nextY = clampPct(d.origYPct + (dy / rect.height) * 100, minY, maxY);
      d.latestXPct = nextX;
      d.latestYPct = nextY;

      d.el.style.left = `${nextX}%`;
      d.el.style.top = `${nextY}%`;
    };

    const endEditDrag = (e: React.PointerEvent<HTMLElement>) => {
      const d = dragRef.current;
      if (!d || d.pointerId !== e.pointerId) return;
      e.stopPropagation();
      dragRef.current = null;

      if (d.moved) {
        if (d.kind === 'button') {
          onMoveButton(d.id, d.latestXPct, d.latestYPct);
        } else {
          onMoveStick(d.latestXPct, d.latestYPct);
        }
      } else if (d.kind === 'button') {
        onOpenButtonPicker(d.id);
      }
    };

    const stick = profile.stick;
    const stickDims = stick ? STICK_SIZE_CLASSES[stick.size] : null;
    const isStickSelected = editMode && selection?.kind === 'stick';

    return (
      <div
        ref={touchSurfaceRef}
        data-testid="custom-mouse-surface"
        onPointerDown={handleBgPointerDown}
        onPointerMove={handleBgPointerMove}
        onPointerUp={handleBgPointerUp}
        onPointerCancel={handleBgPointerUp}
        onContextMenu={(e) => e.preventDefault()}
        className={`relative w-full h-full overflow-hidden touch-none cursor-crosshair pointer-events-auto emulator-touch-surface ${
          fullscreenOverlay ? 'amiga-keyboard-translucent' : 'bg-[#1A1C20]'
        }`}
        aria-label="Кастомное управление"
      >
        {/* Subtle direct-DOM touch glow for mouse cursor feedback */}
        <div
          ref={bgMouseGlowRef}
          aria-hidden="true"
          className="pointer-events-none absolute top-0 left-0 w-[68px] h-[68px] rounded-full bg-white/15 blur-md opacity-0 transition-opacity duration-100 will-change-transform"
        />

        {/* Movable, Customizable 8-Way Stick (only when added by user) */}
        {stick && stickDims && (
          <div
            data-testid="custom-stick"
            style={{
              left: `${stick.xPct}%`,
              top: `${stick.yPct}%`,
              transform: 'translate(-50%, -50%)',
            }}
            onPointerDown={(e) =>
              editMode ? startEditDrag('stick', 'stick', stick.xPct, stick.yPct, e) : undefined
            }
            onPointerMove={(e) => (editMode ? moveEditDrag(e) : undefined)}
            onPointerUp={(e) => (editMode ? endEditDrag(e) : undefined)}
            onPointerCancel={(e) => (editMode ? endEditDrag(e) : undefined)}
            className={`absolute z-20 select-none ${
              editMode
                ? `cursor-grab active:cursor-grabbing rounded-full p-1 bg-black/20 ${
                    isStickSelected ? 'ring-2 ring-[#E07A22]' : 'ring-1 ring-dashed ring-white/45'
                  }`
                : ''
            }`}
          >
            <div
              ref={stickPadRef}
              role="application"
              aria-label="Настраиваемый 8-позиционный стик"
              onPointerDown={!editMode ? handleStickPlayDown : undefined}
              onPointerMove={!editMode ? handleStickPlayMove : undefined}
              onPointerUp={!editMode ? handleStickPlayUp : undefined}
              onPointerCancel={!editMode ? handleStickPlayUp : undefined}
              onContextMenu={(e) => e.preventDefault()}
              className={`relative rounded-full flex items-center justify-center ${stickDims.pad} ${
                fullscreenOverlay
                  ? 'bg-[#191A1D]/80 border-2 border-[#3C3B38] shadow-[inset_0_4px_12px_rgba(0,0,0,0.85)]'
                  : 'bg-[#191A1D] border-2 border-[#3C3B38] shadow-[inset_0_4px_12px_rgba(0,0,0,0.85)]'
              }`}
            >
              <span className={`absolute top-1.5 text-[10px] font-bold pointer-events-none ${stickActiveDirs.up ? 'text-[#E07A22]' : 'text-[#A29E95]'}`}>
                {editMode ? getTargetDisplayLabel(stick.up) : '▲'}
              </span>
              <span className={`absolute bottom-1.5 text-[10px] font-bold pointer-events-none ${stickActiveDirs.down ? 'text-[#E07A22]' : 'text-[#A29E95]'}`}>
                {editMode ? getTargetDisplayLabel(stick.down) : '▼'}
              </span>
              <span className={`absolute left-1.5 text-[10px] font-bold pointer-events-none ${stickActiveDirs.left ? 'text-[#E07A22]' : 'text-[#A29E95]'}`}>
                {editMode ? getTargetDisplayLabel(stick.left) : '◀'}
              </span>
              <span className={`absolute right-1.5 text-[10px] font-bold pointer-events-none ${stickActiveDirs.right ? 'text-[#E07A22]' : 'text-[#A29E95]'}`}>
                {editMode ? getTargetDisplayLabel(stick.right) : '▶'}
              </span>

              <div
                ref={stickKnobRef}
                className={`rounded-full bg-gradient-to-b from-[#E1463A] to-[#A62118] border border-[#F5786E]/45 shadow-[0_6px_14px_rgba(0,0,0,0.75)] pointer-events-none will-change-transform ${stickDims.knob} ${
                  fullscreenOverlay ? 'opacity-85' : ''
                }`}
              />
            </div>
          </div>
        )}

        {/* Movable Custom Buttons */}
        {profile.buttons.map((btn) => {
          const isSelected = editMode && selection?.kind === 'button' && selection.id === btn.id;
          const isPressed = Boolean(pressedButtons[btn.id]);
          const label = getTargetDisplayLabel(btn.target, btn.label);
          const isAccent = btn.target.kind === 'joy' && btn.target.dir === 'fire1';
          const isMouseBtn = btn.target.kind === 'mouse';
          const variantCls = isAccent
            ? 'amiga-key-accent'
            : isMouseBtn
              ? 'amiga-key-ivory'
              : 'amiga-key-grey';

          return (
            <button
              key={btn.id}
              type="button"
              data-testid={`custom-btn-${btn.id}`}
              data-custom-btn="true"
              data-pressed={isPressed ? 'true' : 'false'}
              aria-label={getTargetAriaLabel(btn.target, btn.label)}
              style={{
                left: `${btn.xPct}%`,
                top: `${btn.yPct}%`,
                transform: 'translate(-50%, -50%)',
              }}
                onPointerDown={(e) => {
                if (editMode) {
                  startEditDrag('button', btn.id, btn.xPct, btn.yPct, e);
                  return;
                }
                e.preventDefault();
                e.stopPropagation();
                onUserInteract();
                triggerHaptic(10);
                try {
                  e.currentTarget.setPointerCapture(e.pointerId);
                } catch {
                  // Ignore
                }
                const actions = holdManagerRef.current.setSource(
                  `btn:${btn.id}`,
                  expandControlTarget(btn.target)
                );
                setPressedButtons((p) => ({ ...p, [btn.id]: true }));
                dispatchTargetActions(actions, {
                  onKeyEvent,
                  onJoystickChange,
                  onMouseButton,
                });
              }}
              onPointerMove={(e) => {
                if (editMode) moveEditDrag(e);
              }}
              onPointerUp={(e) => {
                if (editMode) {
                  endEditDrag(e);
                  return;
                }
                e.stopPropagation();
                const actions = holdManagerRef.current.setSource(`btn:${btn.id}`, []);
                if (actions.length > 0) {
                  dispatchTargetActions(actions, {
                    onKeyEvent,
                    onJoystickChange,
                    onMouseButton,
                  });
                }
                setPressedButtons((p) => ({ ...p, [btn.id]: false }));
              }}
              onPointerCancel={(e) => {
                if (editMode) {
                  endEditDrag(e);
                  return;
                }
                const actions = holdManagerRef.current.setSource(`btn:${btn.id}`, []);
                if (actions.length > 0) {
                  dispatchTargetActions(actions, {
                    onKeyEvent,
                    onJoystickChange,
                    onMouseButton,
                  });
                }
                setPressedButtons((p) => ({ ...p, [btn.id]: false }));
              }}
              onContextMenu={(e) => e.preventDefault()}
              className={`absolute z-20 rounded-md font-semibold flex items-center justify-center whitespace-nowrap select-none ${
                BUTTON_SIZE_CLASSES[btn.size]
              } ${variantCls} ${
                isSelected
                  ? 'ring-2 ring-[#E07A22] ring-offset-1 ring-offset-black cursor-grab active:cursor-grabbing'
                  : editMode
                    ? 'ring-1 ring-white/45 cursor-grab active:cursor-grabbing'
                    : ''
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>
    );
  }
);

CustomControlsOverlay.displayName = 'CustomControlsOverlay';

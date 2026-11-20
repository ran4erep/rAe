import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, FolderCog, Joystick, Plus, SlidersHorizontal } from 'lucide-react';
import {
  clampPct,
  computeStickTransition,
  createNewProfile,
  CustomButtonSize,
  CustomButtonTarget,
  CustomControlButton,
  CustomControlProfile,
  CustomProfilesStore,
  CustomStickConfig,
  deleteProfileFromStore,
  EMPTY_STICK_DIRS,
  formatStickTargetLabel,
  getActiveProfile,
  StickDirsState,
} from '../emulator/controls/customControls';
import { triggerHaptic } from '../emulator/haptics';
import { AMIGA_RAW } from '../emulator/keyboard/amigaKeyMap';
import { JoystickState } from '../emulator/types';
import { useSuppressBrowserTouchHold } from '../hooks/useSuppressBrowserTouchHold';
import {
  ButtonEditorModal,
  ProfileManagerModal,
  StickEditorModal,
} from './CustomControlsEditorModal';
import { CustomSelect } from './CustomSelect';

interface CustomControlsDeckProps {
  store: CustomProfilesStore;
  onUpdateStore: (next: CustomProfilesStore) => void;
  fullscreenOverlay?: boolean;
  onKeyEvent: (rawCode: number, isDown: boolean) => void;
  onJoystickChange: (patch: Partial<JoystickState>) => void;
  onMouseMove: (dx: number, dy: number) => void;
  onMouseButton: (left?: boolean, right?: boolean) => void;
  onUserInteract: () => void;
}

const STICK_SIZE_CLS: Record<CustomButtonSize, string> = {
  sm: 'w-26 h-26',
  md: 'w-32 h-32',
  lg: 'w-40 h-40',
};

const STICK_BALL_CLS: Record<CustomButtonSize, string> = {
  sm: 'w-11 h-11',
  md: 'w-14 h-14',
  lg: 'w-16 h-16',
};

const BTN_SIZE_CLS: Record<CustomButtonSize, string> = {
  sm: 'min-w-[48px] h-8 px-2 text-[10px]',
  md: 'min-w-[60px] h-10 px-2.5 text-[11px]',
  lg: 'min-w-[74px] h-13 px-3 text-xs',
};

function shortStickBadge(target: CustomStickConfig['up'], fallbackGlyph: string): string {
  if (target.kind === 'none') return '·';
  if (target.kind === 'joy') return fallbackGlyph;
  const lbl = formatStickTargetLabel(target);
  if (lbl === 'UP') return '↑';
  if (lbl === 'DOWN') return '↓';
  if (lbl === 'LEFT') return '←';
  if (lbl === 'RIGHT') return '→';
  if (lbl === 'SPACE') return 'SPC';
  if (lbl === 'RETURN') return 'RET';
  return lbl.slice(0, 4);
}

export const CustomControlsDeck: React.FC<CustomControlsDeckProps> = React.memo(
  ({
    store,
    onUpdateStore,
    fullscreenOverlay = false,
    onKeyEvent,
    onJoystickChange,
    onMouseMove,
    onMouseButton,
    onUserInteract,
  }) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    useSuppressBrowserTouchHold(containerRef);

    const activeProfile = getActiveProfile(store);

    const [editing, setEditing] = useState(false);
    const [stickModalOpen, setStickModalOpen] = useState(false);
    const [profilesModalOpen, setProfilesModalOpen] = useState(false);
    const [editingButtonId, setEditingButtonId] = useState<string | null>(null);

    // Stick play state (zero re-renders during drag via stickBallRef)
    const padRef = useRef<HTMLDivElement | null>(null);
    const stickBallRef = useRef<HTMLDivElement | null>(null);
    const padBoundsRef = useRef<{ cx: number; cy: number; radius: number } | null>(null);
    const stickPointerIdRef = useRef<number | null>(null);
    const prevDirsRef = useRef<StickDirsState>({ ...EMPTY_STICK_DIRS });
    const [activeDirs, setActiveDirs] = useState<StickDirsState>({ ...EMPTY_STICK_DIRS });

    // Multi-touch active button tracking
    const activePointersRef = useRef<Map<number, CustomButtonTarget>>(new Map());
    const [pressedButtons, setPressedButtons] = useState<Record<string, boolean>>({});

    // Empty-space mouse trackpad state (used in non-fullscreen deck)
    const spacePointerRef = useRef<{
      id: number;
      startX: number;
      startY: number;
      lastX: number;
      lastY: number;
      downTime: number;
      moved: boolean;
    } | null>(null);
    const subpixelRemRef = useRef({ x: 0, y: 0 });
    const tapClickTimerRef = useRef<number | null>(null);

    // Drag-to-reposition state during Edit Mode (zero React re-renders while dragging)
    const dragItemRef = useRef<{
      kind: 'stick' | 'button';
      id?: string;
      pointerId: number;
      startX: number;
      startY: number;
      origXPct: number;
      origYPct: number;
      curXPct: number;
      curYPct: number;
      moved: boolean;
      rect: DOMRect;
      el: HTMLElement;
    } | null>(null);

    const stickConfigRef = useRef(activeProfile.stick);
    stickConfigRef.current = activeProfile.stick;

    const emitTarget = useCallback(
      (target: CustomButtonTarget, isDown: boolean) => {
        if (target.kind === 'key') {
          onKeyEvent(target.rawCode, isDown);
        } else if (target.kind === 'joy_fire1') {
          onJoystickChange({ fire1: isDown });
        } else if (target.kind === 'joy_fire2') {
          onJoystickChange({ fire2: isDown });
        } else if (target.kind === 'mouse_lmb') {
          onMouseButton(isDown, undefined);
        } else if (target.kind === 'mouse_rmb') {
          onMouseButton(undefined, isDown);
        }
      },
      [onJoystickChange, onKeyEvent, onMouseButton]
    );

    const releaseAllActive = useCallback(() => {
      // Release stick transitions
      const prev = prevDirsRef.current;
      if (prev.up || prev.down || prev.left || prev.right) {
        const res = computeStickTransition(prev, EMPTY_STICK_DIRS, stickConfigRef.current);
        for (const k of res.keysUp) onKeyEvent(k, false);
        if (res.joyPatch) onJoystickChange(res.joyPatch);
        prevDirsRef.current = { ...EMPTY_STICK_DIRS };
        setActiveDirs({ ...EMPTY_STICK_DIRS });
      }
      stickPointerIdRef.current = null;
      padBoundsRef.current = null;
      if (stickBallRef.current) {
        stickBallRef.current.style.transform = 'translate3d(0px, 0px, 0)';
      }

      // Release held custom buttons
      if (activePointersRef.current.size > 0) {
        for (const target of activePointersRef.current.values()) {
          emitTarget(target, false);
        }
        activePointersRef.current.clear();
        setPressedButtons({});
      }
    }, [emitTarget, onJoystickChange, onKeyEvent]);

    // Cleanup on unmount or profile switch
    useEffect(() => {
      return () => {
        releaseAllActive();
        if (tapClickTimerRef.current !== null) {
          window.clearTimeout(tapClickTimerRef.current);
          tapClickTimerRef.current = null;
        }
      };
    }, [releaseAllActive, activeProfile.id]);

    const updateActiveProfile = useCallback(
      (updater: (prof: CustomControlProfile) => CustomControlProfile) => {
        onUpdateStore({
          ...store,
          profiles: store.profiles.map((p) => (p.id === activeProfile.id ? updater(p) : p)),
        });
      },
      [activeProfile.id, onUpdateStore, store]
    );

    // Stick pointer handlers (Play Mode)
    const updateStickFromPoint = (clientX: number, clientY: number) => {
      let bounds = padBoundsRef.current;
      if (!bounds) {
        const el = padRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        bounds = {
          cx: rect.left + rect.width / 2,
          cy: rect.top + rect.height / 2,
          radius: rect.width * 0.42,
        };
        padBoundsRef.current = bounds;
      }
      const { cx, cy, radius } = bounds;
      let dx = clientX - cx;
      let dy = clientY - cy;
      const dist = Math.hypot(dx, dy);
      if (dist > radius && dist > 0) {
        dx = (dx / dist) * radius;
        dy = (dy / dist) * radius;
      }

      if (stickBallRef.current) {
        stickBallRef.current.style.transform = `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0)`;
      }

      const dead = radius * 0.24;
      const next: StickDirsState = {
        left: dx < -dead,
        right: dx > dead,
        up: dy < -dead,
        down: dy > dead,
      };
      const prev = prevDirsRef.current;
      if (
        next.up !== prev.up ||
        next.down !== prev.down ||
        next.left !== prev.left ||
        next.right !== prev.right
      ) {
        const delta = computeStickTransition(prev, next, activeProfile.stick);
        prevDirsRef.current = next;
        setActiveDirs(next);
        if (next.up || next.down || next.left || next.right) triggerHaptic(8);
        for (const k of delta.keysUp) onKeyEvent(k, false);
        for (const k of delta.keysDown) onKeyEvent(k, true);
        if (delta.joyPatch) onJoystickChange(delta.joyPatch);
      }
    };

    const handleStickPlayDown = (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      onUserInteract();
      stickPointerIdRef.current = e.pointerId;
      const el = e.currentTarget;
      const rect = el.getBoundingClientRect();
      padBoundsRef.current = {
        cx: rect.left + rect.width / 2,
        cy: rect.top + rect.height / 2,
        radius: rect.width * 0.42,
      };
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // Ignore
      }
      updateStickFromPoint(e.clientX, e.clientY);
    };

    const handleStickPlayMove = (e: React.PointerEvent<HTMLDivElement>) => {
      if (stickPointerIdRef.current !== e.pointerId) return;
      e.preventDefault();
      updateStickFromPoint(e.clientX, e.clientY);
    };

    const handleStickPlayUp = (e: React.PointerEvent<HTMLDivElement>) => {
      if (stickPointerIdRef.current !== e.pointerId) return;
      stickPointerIdRef.current = null;
      padBoundsRef.current = null;
      if (stickBallRef.current) {
        stickBallRef.current.style.transform = 'translate3d(0px, 0px, 0)';
      }
      const prev = prevDirsRef.current;
      if (prev.up || prev.down || prev.left || prev.right) {
        const delta = computeStickTransition(prev, EMPTY_STICK_DIRS, activeProfile.stick);
        prevDirsRef.current = { ...EMPTY_STICK_DIRS };
        setActiveDirs({ ...EMPTY_STICK_DIRS });
        for (const k of delta.keysUp) onKeyEvent(k, false);
        if (delta.joyPatch) onJoystickChange(delta.joyPatch);
      }
    };

    // Edit Mode Dragging Handlers
    const startEditDrag = (
      kind: 'stick' | 'button',
      e: React.PointerEvent<HTMLElement>,
      origXPct: number,
      origYPct: number,
      id?: string
    ) => {
      e.preventDefault();
      e.stopPropagation();
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Ignore
      }
      dragItemRef.current = {
        kind,
        id,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        origXPct,
        origYPct,
        curXPct: origXPct,
        curYPct: origYPct,
        moved: false,
        rect,
        el: e.currentTarget,
      };
    };

    const moveEditDrag = (e: React.PointerEvent<HTMLElement>) => {
      const d = dragItemRef.current;
      if (!d || d.pointerId !== e.pointerId) return;
      e.preventDefault();
      const dxPx = e.clientX - d.startX;
      const dyPx = e.clientY - d.startY;
      if (!d.moved && Math.hypot(dxPx, dyPx) > 6) {
        d.moved = true;
      }
      if (!d.moved) return;
      const nextX = clampPct(d.origXPct + (dxPx / Math.max(1, d.rect.width)) * 100, 5, 95);
      const nextY = clampPct(d.origYPct + (dyPx / Math.max(1, d.rect.height)) * 100, 12, 92);
      d.curXPct = nextX;
      d.curYPct = nextY;
      d.el.style.left = `${nextX}%`;
      d.el.style.top = `${nextY}%`;
    };

    const endEditDrag = (e: React.PointerEvent<HTMLElement>) => {
      const d = dragItemRef.current;
      if (!d || d.pointerId !== e.pointerId) return;
      dragItemRef.current = null;

      if (d.moved) {
        if (d.kind === 'stick') {
          updateActiveProfile((prof) => ({
            ...prof,
            stick: { ...prof.stick, xPct: d.curXPct, yPct: d.curYPct },
          }));
        } else if (d.id) {
          const btnId = d.id;
          updateActiveProfile((prof) => ({
            ...prof,
            buttons: prof.buttons.map((b) =>
              b.id === btnId ? { ...b, xPct: d.curXPct, yPct: d.curYPct } : b
            ),
          }));
        }
      } else {
        if (d.kind === 'stick') {
          setStickModalOpen(true);
        } else if (d.id) {
          setEditingButtonId(d.id);
        }
      }
    };

    // Empty-space mouse trackpad handlers (active in non-fullscreen mobile deck)
    const handleSpaceDown = (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      onUserInteract();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Ignore
      }
      spacePointerRef.current = {
        id: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        downTime: performance.now(),
        moved: false,
      };
    };

    const handleSpaceMove = (e: React.PointerEvent<HTMLDivElement>) => {
      const p = spacePointerRef.current;
      if (!p || p.id !== e.pointerId) return;
      e.preventDefault();
      const dx = e.clientX - p.lastX;
      const dy = e.clientY - p.lastY;
      p.lastX = e.clientX;
      p.lastY = e.clientY;
      if (!p.moved && Math.hypot(e.clientX - p.startX, e.clientY - p.startY) > 5) {
        p.moved = true;
      }
      if (dx !== 0 || dy !== 0) {
        const fx = subpixelRemRef.current.x + dx * 1.4;
        const fy = subpixelRemRef.current.y + dy * 1.4;
        const ix = Math.trunc(fx);
        const iy = Math.trunc(fy);
        subpixelRemRef.current.x = fx - ix;
        subpixelRemRef.current.y = fy - iy;
        if (ix !== 0 || iy !== 0) onMouseMove(ix, iy);
      }
    };

    const handleSpaceUp = (e: React.PointerEvent<HTMLDivElement>) => {
      const p = spacePointerRef.current;
      if (!p || p.id !== e.pointerId) return;
      spacePointerRef.current = null;
      if (!p.moved && performance.now() - p.downTime < 260) {
        triggerHaptic(8);
        if (tapClickTimerRef.current !== null) window.clearTimeout(tapClickTimerRef.current);
        onMouseButton(true, undefined);
        tapClickTimerRef.current = window.setTimeout(() => {
          onMouseButton(false, undefined);
          tapClickTimerRef.current = null;
        }, 65);
      }
    };

    const handleAddButton = () => {
      const idx = activeProfile.buttons.length;
      const newBtn: CustomControlButton = {
        id: `btn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
        label: 'SPACE',
        target: { kind: 'key', rawCode: AMIGA_RAW.SPACE },
        xPct: clampPct(58 + ((idx % 3) - 1) * 13, 42, 90),
        yPct: clampPct(34 + (Math.floor(idx / 3) % 3) * 16, 26, 82),
        size: 'md',
      };
      updateActiveProfile((prof) => ({
        ...prof,
        buttons: [...prof.buttons, newBtn],
      }));
      setEditingButtonId(newBtn.id);
    };

    const editingButton = editingButtonId
      ? activeProfile.buttons.find((b) => b.id === editingButtonId) ?? null
      : null;

    const stick = activeProfile.stick;

    return (
      <div
        ref={containerRef}
        data-testid="custom-controls-deck"
        className={`relative w-full h-full emulator-touch-surface select-none ${
          fullscreenOverlay
            ? editing
              ? 'bg-black/45 pointer-events-auto amiga-keyboard-translucent'
              : 'pointer-events-none amiga-keyboard-translucent'
            : editing
              ? 'bg-[#1B1A19] pointer-events-auto'
              : 'bg-[#242321] pointer-events-auto'
        }`}
        aria-label="Настраиваемое управление"
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* In non-fullscreen play mode, empty area acts as mouse cursor touchpad */}
        {!fullscreenOverlay && !editing && (
          <div
            data-testid="custom-mouse-space"
            onPointerDown={handleSpaceDown}
            onPointerMove={handleSpaceMove}
            onPointerUp={handleSpaceUp}
            onPointerCancel={handleSpaceUp}
            className="absolute inset-0 touch-none cursor-crosshair"
            aria-label="Свободная область управления курсором мыши"
          />
        )}

        {/* Top compact toolbar (Play mode: profile chip + Customize; Edit mode: full editor actions + non-overlapping hint) */}
        <div
          className={`absolute top-1.5 left-1/2 -translate-x-1/2 z-30 pointer-events-auto flex flex-col items-center gap-1 px-2 py-1 rounded-lg border shadow-lg max-w-[97%] ${
            editing
              ? 'bg-[#1A1C22]/95 border-[#E07A22]/60'
              : 'bg-[#14161A]/70 border-white/15 backdrop-blur-[2px]'
          }`}
        >
          {!editing ? (
            <div className="flex items-center gap-1.5">
              <CustomSelect
                ariaLabel="Активный профиль управления"
                value={activeProfile.id}
                options={store.profiles.map((p) => ({ value: p.id, label: p.name }))}
                onChange={(id) => {
                  releaseAllActive();
                  onUpdateStore({ ...store, activeProfileId: id });
                }}
                className="min-w-[110px] max-w-[160px]"
              />
              <button
                type="button"
                onClick={() => {
                  releaseAllActive();
                  setEditing(true);
                }}
                aria-label="Настроить кастомное управление"
                className="h-6 px-2 rounded bg-[#C8342A]/90 hover:bg-[#D94035] text-[10px] font-bold text-white flex items-center gap-1 whitespace-nowrap"
              >
                <SlidersHorizontal className="w-3 h-3" />
                Настроить
              </button>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-center gap-1 flex-nowrap">
                <button
                  type="button"
                  onClick={() => setProfilesModalOpen(true)}
                  className="h-7 px-2 rounded bg-[#2A2D33] hover:bg-[#353941] text-[10px] sm:text-[11px] font-semibold text-[#F2EFE9] flex items-center gap-1 whitespace-nowrap"
                >
                  <FolderCog className="w-3 h-3 text-[#E07A22]" />
                  Профили
                </button>
                <button
                  type="button"
                  onClick={handleAddButton}
                  className="h-7 px-2 rounded bg-[#2A2D33] hover:bg-[#353941] text-[10px] sm:text-[11px] font-semibold text-[#F2EFE9] flex items-center gap-1 whitespace-nowrap"
                >
                  <Plus className="w-3 h-3 text-[#8BC49A]" />
                  Кнопка
                </button>
                <button
                  type="button"
                  onClick={() => setStickModalOpen(true)}
                  aria-label="Стик (↑↓←→)"
                  className="h-7 px-2 rounded bg-[#2A2D33] hover:bg-[#353941] text-[10px] sm:text-[11px] font-semibold text-[#F2EFE9] flex items-center gap-1 whitespace-nowrap"
                >
                  <Joystick className="w-3 h-3 text-[#E07A22]" />
                  Стик
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="h-7 px-2 rounded bg-[#C8342A] hover:bg-[#D94035] text-[10px] sm:text-[11px] font-bold text-white flex items-center gap-1 whitespace-nowrap"
                >
                  <Check className="w-3 h-3" />
                  Готово
                </button>
              </div>
              <span className="text-[9px] sm:text-[10px] text-[#BDB9B0] text-center leading-tight whitespace-nowrap">
                Перетащите для сдвига · Тап по элементу для настройки
              </span>
            </>
          )}
        </div>

        {/* Customizable 8-way Stick */}
        {stick.enabled && (
          <div
            style={{
              left: `${stick.xPct}%`,
              top: `${stick.yPct}%`,
              transform: 'translate(-50%, -50%)',
            }}
            onPointerDown={
              editing
                ? (e) => startEditDrag('stick', e, stick.xPct, stick.yPct)
                : undefined
            }
            onPointerMove={editing ? moveEditDrag : undefined}
            onPointerUp={editing ? endEditDrag : undefined}
            onPointerCancel={editing ? endEditDrag : undefined}
            className={`absolute z-10 pointer-events-auto ${
              editing ? 'cursor-move ring-2 ring-dashed ring-[#E07A22] rounded-full p-1' : ''
            }`}
          >
            <div
              ref={padRef}
              onPointerDown={!editing ? handleStickPlayDown : undefined}
              onPointerMove={!editing ? handleStickPlayMove : undefined}
              onPointerUp={!editing ? handleStickPlayUp : undefined}
              onPointerCancel={!editing ? handleStickPlayUp : undefined}
              onContextMenu={(e) => e.preventDefault()}
              role="application"
              aria-label="Настраиваемый стик"
              className={`relative rounded-full flex items-center justify-center ${STICK_SIZE_CLS[stick.size]} ${
                fullscreenOverlay
                  ? 'bg-[#191A1D]/45 border-2 border-white/25 backdrop-blur-[2px] shadow-[0_4px_14px_rgba(0,0,0,0.45)]'
                  : 'bg-[#191A1D] border-2 border-[#3C3B38] shadow-[inset_0_4px_12px_rgba(0,0,0,0.85)]'
              }`}
            >
              <span className={`absolute top-1.5 text-[10px] font-bold pointer-events-none drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)] ${activeDirs.up ? 'text-[#E07A22]' : 'text-white/85'}`}>
                {shortStickBadge(stick.up, '▲')}
              </span>
              <span className={`absolute bottom-1.5 text-[10px] font-bold pointer-events-none drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)] ${activeDirs.down ? 'text-[#E07A22]' : 'text-white/85'}`}>
                {shortStickBadge(stick.down, '▼')}
              </span>
              <span className={`absolute left-1.5 text-[10px] font-bold pointer-events-none drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)] ${activeDirs.left ? 'text-[#E07A22]' : 'text-white/85'}`}>
                {shortStickBadge(stick.left, '◀')}
              </span>
              <span className={`absolute right-1.5 text-[10px] font-bold pointer-events-none drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)] ${activeDirs.right ? 'text-[#E07A22]' : 'text-white/85'}`}>
                {shortStickBadge(stick.right, '▶')}
              </span>

              <div
                ref={stickBallRef}
                className={`rounded-full bg-gradient-to-b from-[#E1463A] to-[#A62118] border border-[#F5786E]/45 shadow-[0_6px_14px_rgba(0,0,0,0.75)] pointer-events-none will-change-transform ${
                  STICK_BALL_CLS[stick.size]
                } ${fullscreenOverlay ? 'opacity-85' : ''}`}
              />
            </div>
          </div>
        )}

        {/* Custom Game Buttons */}
        {activeProfile.buttons.map((btn) => {
          const isFire = btn.target.kind === 'joy_fire1' || btn.target.kind === 'joy_fire2';
          const isAccent = btn.target.kind === 'joy_fire1';
          const isPressed = Boolean(pressedButtons[btn.id]);
          const shapeCls = isFire ? 'rounded-full aspect-square' : 'rounded-md';
          const variantCls = isAccent ? 'amiga-key-accent' : 'amiga-key-grey';

          return (
            <button
              key={btn.id}
              type="button"
              aria-label={`Кнопка ${btn.label}`}
              data-pressed={isPressed ? 'true' : 'false'}
              style={{
                left: `${btn.xPct}%`,
                top: `${btn.yPct}%`,
                transform: 'translate(-50%, -50%)',
              }}
              onPointerDown={(e) => {
                if (editing) {
                  startEditDrag('button', e, btn.xPct, btn.yPct, btn.id);
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
                activePointersRef.current.set(e.pointerId, btn.target);
                setPressedButtons((p) => ({ ...p, [btn.id]: true }));
                emitTarget(btn.target, true);
              }}
              onPointerMove={(e) => {
                if (editing) moveEditDrag(e);
              }}
              onPointerUp={(e) => {
                if (editing) {
                  endEditDrag(e);
                  return;
                }
                const target = activePointersRef.current.get(e.pointerId);
                if (!target) return;
                activePointersRef.current.delete(e.pointerId);
                setPressedButtons((p) => ({ ...p, [btn.id]: false }));
                emitTarget(target, false);
              }}
              onPointerCancel={(e) => {
                if (editing) {
                  endEditDrag(e);
                  return;
                }
                const target = activePointersRef.current.get(e.pointerId);
                if (!target) return;
                activePointersRef.current.delete(e.pointerId);
                setPressedButtons((p) => ({ ...p, [btn.id]: false }));
                emitTarget(target, false);
              }}
              onContextMenu={(e) => e.preventDefault()}
              className={`absolute z-10 pointer-events-auto font-display font-bold tracking-wide flex items-center justify-center leading-none ${shapeCls} ${variantCls} ${BTN_SIZE_CLS[btn.size]} ${
                editing ? 'cursor-move ring-2 ring-dashed ring-[#E07A22]' : ''
              }`}
            >
              {btn.label}
            </button>
          );
        })}

        {/* Stick 4-direction Editor Modal */}
        {stickModalOpen && (
          <StickEditorModal
            stick={activeProfile.stick}
            onChangeStick={(nextStick) =>
              updateActiveProfile((prof) => ({ ...prof, stick: nextStick }))
            }
            onClose={() => setStickModalOpen(false)}
          />
        )}

        {/* Button Key Picker & Label Editor Modal */}
        {editingButton && (
          <ButtonEditorModal
            button={editingButton}
            onChangeButton={(nextBtn) =>
              updateActiveProfile((prof) => ({
                ...prof,
                buttons: prof.buttons.map((b) => (b.id === nextBtn.id ? nextBtn : b)),
              }))
            }
            onDeleteButton={(id) => {
              updateActiveProfile((prof) => ({
                ...prof,
                buttons: prof.buttons.filter((b) => b.id !== id),
              }));
              setEditingButtonId(null);
            }}
            onClose={() => setEditingButtonId(null)}
          />
        )}

        {/* Profile Manager Modal */}
        {profilesModalOpen && (
          <ProfileManagerModal
            profiles={store.profiles}
            activeProfileId={activeProfile.id}
            onSelectProfile={(id) => {
              releaseAllActive();
              onUpdateStore({ ...store, activeProfileId: id });
            }}
            onCreateProfile={(name) => {
              releaseAllActive();
              onUpdateStore(createNewProfile(store, name, activeProfile));
            }}
            onRenameProfile={(id, name) => {
              onUpdateStore({
                ...store,
                profiles: store.profiles.map((p) => (p.id === id ? { ...p, name } : p)),
              });
            }}
            onDeleteProfile={(id) => {
              releaseAllActive();
              onUpdateStore(deleteProfileFromStore(store, id));
            }}
            onClose={() => setProfilesModalOpen(false)}
          />
        )}
      </div>
    );
  }
);

CustomControlsDeck.displayName = 'CustomControlsDeck';

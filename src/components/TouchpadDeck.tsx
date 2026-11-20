import React, { useRef, useState } from 'react';
import { triggerHaptic } from '../emulator/haptics';
import { useSuppressBrowserTouchHold } from '../hooks/useSuppressBrowserTouchHold';

interface TouchpadDeckProps {
  fullscreenOverlay?: boolean;
  onMouseMove: (dx: number, dy: number) => void;
  onMouseButton: (left?: boolean, right?: boolean) => void;
  onUserInteract: () => void;
}

export const TouchpadDeck: React.FC<TouchpadDeckProps> = React.memo(
  ({ fullscreenOverlay = false, onMouseMove, onMouseButton, onUserInteract }) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    useSuppressBrowserTouchHold(containerRef);
    const padPointer = useRef<{
      id: number;
      startX: number;
      startY: number;
      lastX: number;
      lastY: number;
      downTime: number;
      moved: boolean;
      tapHoldDrag: boolean;
    } | null>(null);

    const touchpadRef = useRef<HTMLDivElement | null>(null);
    const touchpadGlowRef = useRef<HTMLDivElement | null>(null);
    const padRectRef = useRef<{ left: number; top: number } | null>(null);

    const lastTapUpTime = useRef<number>(0);
    const subpixelRem = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
    const clickTimer = useRef<number | null>(null);

    const [lmbPressed, setLmbPressed] = useState(false);
    const [rmbPressed, setRmbPressed] = useState(false);

    const updateTouchpadGlow = (clientX: number, clientY: number, visible: boolean) => {
      const glow = touchpadGlowRef.current;
      const pad = touchpadRef.current;
      if (!glow || !pad) return;
      if (!visible) {
        glow.style.opacity = '0';
        return;
      }
      let rect = padRectRef.current;
      if (!rect) {
        const b = pad.getBoundingClientRect();
        rect = { left: b.left, top: b.top };
        padRectRef.current = rect;
      }
      const lx = clientX - rect.left - 36;
      const ly = clientY - rect.top - 36;
      glow.style.transform = `translate3d(${lx.toFixed(1)}px, ${ly.toFixed(1)}px, 0px)`;
      glow.style.opacity = '1';
    };

    const handlePadDown = (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      onUserInteract();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Ignore in synthetic environments
      }

      const b = e.currentTarget.getBoundingClientRect();
      padRectRef.current = { left: b.left, top: b.top };
      updateTouchpadGlow(e.clientX, e.clientY, true);

      const now = performance.now();
      // Double-tap-and-hold on trackpad holds LMB while dragging (just like a laptop trackpad)
      const isTapHoldDrag = now - lastTapUpTime.current < 240;
      if (isTapHoldDrag) {
        setLmbPressed(true);
        onMouseButton(true, undefined);
        triggerHaptic(10);
      }

      padPointer.current = {
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

    const handlePadMove = (e: React.PointerEvent<HTMLDivElement>) => {
      const p = padPointer.current;
      if (!p || p.id !== e.pointerId) return;
      e.preventDefault();
      updateTouchpadGlow(e.clientX, e.clientY, true);

      const dx = e.clientX - p.lastX;
      const dy = e.clientY - p.lastY;
      p.lastX = e.clientX;
      p.lastY = e.clientY;

      if (!p.moved && Math.hypot(e.clientX - p.startX, e.clientY - p.startY) > 5) {
        p.moved = true;
      }

      if (dx !== 0 || dy !== 0) {
        const fx = subpixelRem.current.x + dx * 1.45;
        const fy = subpixelRem.current.y + dy * 1.45;
        const ix = Math.trunc(fx);
        const iy = Math.trunc(fy);
        subpixelRem.current.x = fx - ix;
        subpixelRem.current.y = fy - iy;
        if (ix !== 0 || iy !== 0) {
          onMouseMove(ix, iy);
        }
      }
    };

    const handlePadUp = (e: React.PointerEvent<HTMLDivElement>) => {
      const p = padPointer.current;
      if (!p || p.id !== e.pointerId) return;
      padPointer.current = null;
      padRectRef.current = null;
      updateTouchpadGlow(0, 0, false);

      if (p.tapHoldDrag) {
        setLmbPressed(false);
        onMouseButton(false, undefined);
        lastTapUpTime.current = 0;
        return;
      }

      const now = performance.now();
      if (!p.moved && now - p.downTime < 260) {
        lastTapUpTime.current = now;
        triggerHaptic(8);
        if (clickTimer.current !== null) {
          window.clearTimeout(clickTimer.current);
        }
        onMouseButton(true, undefined);
        clickTimer.current = window.setTimeout(() => {
          onMouseButton(false, undefined);
          clickTimer.current = null;
        }, 65);
      }
    };

    const lmbButton = (extraClass: string) => (
      <button
        type="button"
        aria-label="Левая кнопка мыши"
        data-pressed={lmbPressed ? 'true' : 'false'}
        onPointerDown={(e) => {
          e.preventDefault();
          onUserInteract();
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            // Ignore
          }
          triggerHaptic(10);
          setLmbPressed(true);
          onMouseButton(true, undefined);
        }}
        onPointerUp={() => {
          setLmbPressed(false);
          onMouseButton(false, undefined);
        }}
        onPointerCancel={() => {
          setLmbPressed(false);
          onMouseButton(false, undefined);
        }}
        onContextMenu={(e) => e.preventDefault()}
        className={`rounded-md amiga-key-grey text-xs font-bold tracking-wide ${extraClass}`}
      >
        LMB
      </button>
    );

    const rmbButton = (extraClass: string) => (
      <button
        type="button"
        aria-label="Правая кнопка мыши"
        data-pressed={rmbPressed ? 'true' : 'false'}
        onPointerDown={(e) => {
          e.preventDefault();
          onUserInteract();
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            // Ignore
          }
          triggerHaptic(10);
          setRmbPressed(true);
          onMouseButton(undefined, true);
        }}
        onPointerUp={() => {
          setRmbPressed(false);
          onMouseButton(undefined, false);
        }}
        onPointerCancel={() => {
          setRmbPressed(false);
          onMouseButton(undefined, false);
        }}
        onContextMenu={(e) => e.preventDefault()}
        className={`rounded-md amiga-key-grey text-xs font-bold tracking-wide ${extraClass}`}
      >
        RMB
      </button>
    );

    if (fullscreenOverlay) {
      return (
        <div
          ref={containerRef}
          className="w-full h-full flex flex-row pointer-events-none emulator-touch-surface amiga-keyboard-translucent"
          aria-label="Сенсорный тачпад мыши"
          onContextMenu={(e) => e.preventDefault()}
        >
          {/* Left vertical split: Top half LMB, Bottom half RMB */}
          <div
            data-testid="fullscreen-mouse-buttons"
            className="w-12 sm:w-14 h-full shrink-0 flex flex-col gap-1.5 p-1.5 pointer-events-auto"
          >
            {lmbButton('w-full flex-1')}
            {rmbButton('w-full flex-1')}
          </div>

          {/* Seamless borderless full-area touchpad surface */}
          <div
            ref={touchpadRef}
            role="application"
            aria-label="Область тачпада мыши"
            data-testid="touchpad-surface"
            onPointerDown={handlePadDown}
            onPointerMove={handlePadMove}
            onPointerUp={handlePadUp}
            onPointerCancel={handlePadUp}
            onContextMenu={(e) => e.preventDefault()}
            className="pointer-events-auto relative flex-1 h-full overflow-hidden touch-none cursor-crosshair bg-transparent"
          >
            <div
              ref={touchpadGlowRef}
              data-testid="touchpad-glow"
              aria-hidden="true"
              className="pointer-events-none absolute top-0 left-0 w-[72px] h-[72px] rounded-full bg-white/15 blur-md opacity-0 transition-opacity duration-100 will-change-transform"
            />
          </div>
        </div>
      );
    }

    return (
      <div
        ref={containerRef}
        className="w-full h-full flex flex-col emulator-touch-surface bg-[#242321] px-2.5 pt-2.5 pb-safe gap-2.5"
        aria-label="Сенсорный тачпад мыши"
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* Laptop-style Trackpad Surface with direct-DOM touch glow */}
        <div
          ref={touchpadRef}
          role="application"
          aria-label="Область тачпада мыши"
          data-testid="touchpad-surface"
          onPointerDown={handlePadDown}
          onPointerMove={handlePadMove}
          onPointerUp={handlePadUp}
          onPointerCancel={handlePadUp}
          onContextMenu={(e) => e.preventDefault()}
          className="pointer-events-auto relative flex-1 rounded-xl overflow-hidden touch-none cursor-crosshair min-h-[150px] bg-[#16181B] border border-[#383A40] shadow-[inset_0_3px_12px_rgba(0,0,0,0.75)]"
        >
          <div
            ref={touchpadGlowRef}
            data-testid="touchpad-glow"
            aria-hidden="true"
            className="pointer-events-none absolute top-0 left-0 w-[72px] h-[72px] rounded-full bg-white/20 blur-md opacity-0 transition-opacity duration-100 will-change-transform"
          />
        </div>

        {/* Dedicated Laptop Mouse Buttons (uniform grey hardware design) */}
        <div className="shrink-0 flex gap-2.5 pointer-events-auto h-14">
          {lmbButton('flex-1 h-full')}
          {rmbButton('flex-1 h-full')}
        </div>
      </div>
    );
  }
);

TouchpadDeck.displayName = 'TouchpadDeck';

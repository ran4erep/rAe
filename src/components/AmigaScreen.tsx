import React, { useRef } from 'react';
import { triggerHaptic } from '../emulator/haptics';
import { FB_HEIGHT, FB_WIDTH } from '../emulator/hardware/chipset';
import { useSuppressBrowserTouchHold } from '../hooks/useSuppressBrowserTouchHold';

interface AmigaScreenProps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  scanlines: boolean;
  paused: boolean;
  aspectRatio?: number;
  fullscreen?: boolean;
  onMouseMove: (dx: number, dy: number) => void;
  onMouseButton: (left?: boolean, right?: boolean) => void;
  onUserInteract: () => void;
}

export const AmigaScreen: React.FC<AmigaScreenProps> = React.memo(
  ({ canvasRef, scanlines, paused, aspectRatio = 4 / 3, fullscreen = false, onMouseMove, onMouseButton, onUserInteract }) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    useSuppressBrowserTouchHold(containerRef);
    const touchRef = useRef<{
      id: number;
      startX: number;
      startY: number;
      lastX: number;
      lastY: number;
      downTime: number;
      moved: boolean;
    } | null>(null);

    const desktopMouseLast = useRef<{ x: number; y: number } | null>(null);
    const subpixelRem = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
    const tapClickTimer = useRef<number | null>(null);

    const emitScaledDelta = (rawDx: number, rawDy: number, sensitivity: number) => {
      const fx = subpixelRem.current.x + rawDx * sensitivity;
      const fy = subpixelRem.current.y + rawDy * sensitivity;
      const ix = Math.trunc(fx);
      const iy = Math.trunc(fy);
      subpixelRem.current.x = fx - ix;
      subpixelRem.current.y = fy - iy;
      if (ix !== 0 || iy !== 0) {
        onMouseMove(ix, iy);
      }
    };

    const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      onUserInteract();

      if (e.pointerType === 'mouse') {
        desktopMouseLast.current = { x: e.clientX, y: e.clientY };
        if (e.button === 2) {
          onMouseButton(undefined, true);
        } else if (e.button === 0) {
          onMouseButton(true, undefined);
        }
        return;
      }

      // Touch / Pen: dragging moves cursor freely without holding LMB; quick tap clicks LMB
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Ignore in synthetic environments
      }
      touchRef.current = {
        id: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        downTime: performance.now(),
        moved: false,
      };
    };

    const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (e.pointerType === 'mouse') {
        const prev = desktopMouseLast.current;
        desktopMouseLast.current = { x: e.clientX, y: e.clientY };
        if (!prev) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const scale = rect.width > 0 ? 320 / rect.width : 1;
        emitScaledDelta(e.clientX - prev.x, e.clientY - prev.y, Math.max(0.65, scale));
        return;
      }

      const t = touchRef.current;
      if (!t || t.id !== e.pointerId) return;
      const dx = e.clientX - t.lastX;
      const dy = e.clientY - t.lastY;
      t.lastX = e.clientX;
      t.lastY = e.clientY;

      if (!t.moved && Math.hypot(e.clientX - t.startX, e.clientY - t.startY) > 5) {
        t.moved = true;
      }

      if (dx !== 0 || dy !== 0) {
        const rect = e.currentTarget.getBoundingClientRect();
        const scale = rect.width > 0 ? 320 / rect.width : 1;
        emitScaledDelta(dx, dy, Math.max(1.05, scale * 1.1));
      }
    };

    const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (e.pointerType === 'mouse') {
        if (e.button === 2) {
          onMouseButton(undefined, false);
        } else if (e.button === 0) {
          onMouseButton(false, undefined);
        }
        return;
      }

      const t = touchRef.current;
      if (!t || t.id !== e.pointerId) return;
      touchRef.current = null;

      // Quick tap without drag -> crisp LMB click
      if (!t.moved && performance.now() - t.downTime < 280) {
        triggerHaptic(8);
        if (tapClickTimer.current !== null) {
          window.clearTimeout(tapClickTimer.current);
        }
        onMouseButton(true, undefined);
        tapClickTimer.current = window.setTimeout(() => {
          onMouseButton(false, undefined);
          tapClickTimer.current = null;
        }, 65);
      }
    };

    const handlePointerLeave = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (e.pointerType === 'mouse') {
        desktopMouseLast.current = null;
      }
    };

    return (
      <div
        ref={containerRef}
        className={`w-full h-full flex items-center justify-center emulator-touch-surface ${
          fullscreen ? 'bg-black p-0' : 'bg-[#0D0E11] p-0 lg:p-3'
        }`}
        style={{ containerType: 'size' }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* Exact aspect-preserving CRT frame filling user width cleanly without borders */}
        <div
          style={{
            width: `min(100cqw, calc(100cqh * ${aspectRatio}))`,
            height: `min(100cqh, calc(100cqw / ${aspectRatio}))`,
          }}
          className={`relative bg-black overflow-hidden ${
            fullscreen
              ? ''
              : 'lg:rounded-lg lg:border lg:border-[#34363D] shadow-[inset_0_0_18px_rgba(0,0,0,0.9),0_4px_20px_rgba(0,0,0,0.45)]'
          }`}
        >
          <canvas
            ref={canvasRef}
            width={FB_WIDTH}
            height={FB_HEIGHT}
            data-testid="amiga-crt-canvas"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onPointerLeave={handlePointerLeave}
            onContextMenu={(e) => e.preventDefault()}
            className="w-full h-full block crt-canvas touch-none cursor-crosshair"
          />

          {scanlines && (
            <div
              className="pointer-events-none absolute inset-0 crt-scanlines opacity-55"
              aria-hidden="true"
            />
          )}

          {/* Subtle CRT glass vignette */}
          <div
            className="pointer-events-none absolute inset-0 shadow-[inset_0_0_24px_rgba(0,0,0,0.42)]"
            aria-hidden="true"
          />

          {paused && (
            <div className="absolute inset-0 bg-black/55 flex items-center justify-center">
              <span className="font-display tracking-widest text-sm font-bold text-[#F2EFE9] bg-[#1C1E22]/90 border border-white/15 px-4 py-1.5 rounded-md">
                ПАУЗА
              </span>
            </div>
          )}
        </div>
      </div>
    );
  }
);

AmigaScreen.displayName = 'AmigaScreen';

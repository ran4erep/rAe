import React, { useEffect, useRef, useState } from 'react';
import { EmuPerfSnapshot } from '../emulator/performanceStats';
import { triggerHaptic } from '../emulator/haptics';
import { FB_HEIGHT, FB_WIDTH } from '../emulator/hardware/chipset';
import { useSuppressBrowserTouchHold } from '../hooks/useSuppressBrowserTouchHold';

interface AmigaScreenProps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  scanlines: boolean;
  paused: boolean;
  pointerLockAllowed?: boolean;
  emuPerf?: EmuPerfSnapshot | null;
  aspectRatio?: number;
  fullscreen?: boolean;
  onMouseMove: (dx: number, dy: number) => void;
  onMouseButton: (left?: boolean, right?: boolean, middle?: boolean) => void;
  onUserInteract: () => void;
}

export const AmigaScreen: React.FC<AmigaScreenProps> = React.memo(
  ({
    canvasRef,
    scanlines,
    paused,
    pointerLockAllowed = true,
    emuPerf = null,
    aspectRatio = 4 / 3,
    fullscreen = false,
    onMouseMove,
    onMouseButton,
    onUserInteract,
  }) => {
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

    const [pointerLocked, setPointerLocked] = useState(false);
    const [showLockHint, setShowLockHint] = useState(false);
    const lockHintTimerRef = useRef<number | null>(null);
    const pointerLockRejectedRef = useRef(false);
    const suppressCaptureReleaseRef = useRef(false);
    const onMouseButtonRef = useRef(onMouseButton);
    onMouseButtonRef.current = onMouseButton;

    useEffect(() => {
      const handleLockChange = () => {
        const canvas = canvasRef.current;
        const locked = Boolean(canvas && document.pointerLockElement === canvas);
        setPointerLocked(locked);
        if (locked) {
          pointerLockRejectedRef.current = false;
          desktopMouseLast.current = null;
          setShowLockHint(true);
          if (lockHintTimerRef.current !== null) {
            window.clearTimeout(lockHintTimerRef.current);
          }
          lockHintTimerRef.current = window.setTimeout(() => {
            setShowLockHint(false);
            lockHintTimerRef.current = null;
          }, 2400);
        } else {
          setShowLockHint(false);
          suppressCaptureReleaseRef.current = false;
          if (lockHintTimerRef.current !== null) {
            window.clearTimeout(lockHintTimerRef.current);
            lockHintTimerRef.current = null;
          }
          onMouseButtonRef.current(false, false, false);
        }
      };

      const handleLockError = () => {
        pointerLockRejectedRef.current = true;
        suppressCaptureReleaseRef.current = false;
        setPointerLocked(false);
      };

      document.addEventListener('pointerlockchange', handleLockChange);
      document.addEventListener('pointerlockerror', handleLockError);
      return () => {
        document.removeEventListener('pointerlockchange', handleLockChange);
        document.removeEventListener('pointerlockerror', handleLockError);
        if (lockHintTimerRef.current !== null) {
          window.clearTimeout(lockHintTimerRef.current);
          lockHintTimerRef.current = null;
        }
      };
    }, [canvasRef]);

    useEffect(() => {
      if (!pointerLockAllowed && canvasRef.current && document.pointerLockElement === canvasRef.current) {
        try {
          document.exitPointerLock?.();
        } catch {
          // Ignore exit errors
        }
      }
    }, [canvasRef, pointerLockAllowed]);

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
        const canvas = e.currentTarget;
        const isAlreadyLocked = document.pointerLockElement === canvas;

        if (!isAlreadyLocked && pointerLockAllowed && typeof canvas.requestPointerLock === 'function' && !pointerLockRejectedRef.current) {
          suppressCaptureReleaseRef.current = true;
          try {
            const maybePromise = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
            if (maybePromise && typeof maybePromise.catch === 'function') {
              maybePromise.catch(() => {
                pointerLockRejectedRef.current = true;
                suppressCaptureReleaseRef.current = false;
              });
            }
          } catch {
            pointerLockRejectedRef.current = true;
            suppressCaptureReleaseRef.current = false;
          }
          desktopMouseLast.current = { x: e.clientX, y: e.clientY };
          return;
        }

        desktopMouseLast.current = { x: e.clientX, y: e.clientY };
        if (e.button === 2) {
          onMouseButton(undefined, true);
        } else if (e.button === 1) {
          onMouseButton(undefined, undefined, true);
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
        const w = e.currentTarget.clientWidth;
        const scale = w > 0 ? Math.max(0.65, 320 / w) : 1;

        if (document.pointerLockElement === e.currentTarget) {
          if (e.movementX !== 0 || e.movementY !== 0) {
            emitScaledDelta(e.movementX, e.movementY, scale);
          }
          return;
        }

        const prev = desktopMouseLast.current;
        desktopMouseLast.current = { x: e.clientX, y: e.clientY };
        if (!prev) return;
        emitScaledDelta(e.clientX - prev.x, e.clientY - prev.y, scale);
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
        if (suppressCaptureReleaseRef.current) {
          suppressCaptureReleaseRef.current = false;
          return;
        }
        if (e.button === 2) {
          onMouseButton(undefined, false);
        } else if (e.button === 1) {
          onMouseButton(undefined, undefined, false);
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
      if (e.pointerType === 'mouse' && document.pointerLockElement !== e.currentTarget) {
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
            data-pointer-locked={pointerLocked ? 'true' : 'false'}
            title="Кликните в экран для захвата мыши (Esc — освободить курсор)"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onPointerLeave={handlePointerLeave}
            onContextMenu={(e) => e.preventDefault()}
            className={`w-full h-full block crt-canvas touch-none ${
              pointerLocked ? 'cursor-none' : 'cursor-crosshair'
            }`}
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

          {showLockHint && pointerLocked && (
            <div
              data-testid="pointer-lock-hint"
              className="pointer-events-none absolute top-2.5 left-1/2 -translate-x-1/2 z-10 rounded-md bg-[#121316]/88 border border-white/15 px-3 py-1 text-[11px] font-medium text-[#F2EFE9] shadow-lg whitespace-nowrap"
            >
              Мышь захвачена · <span className="font-mono text-[#E07A22]">Esc</span> — освободить
            </div>
          )}

          {emuPerf && (
            <div
              data-testid="emu-perf-hud"
              className="pointer-events-none absolute bottom-2 right-2 z-10 max-w-[calc(100%-1rem)] rounded-md bg-[#121316]/85 border border-white/15 px-2 py-1 sm:px-2.5 sm:py-1.5 font-mono tabular-nums text-[9.5px] sm:text-[10.5px] leading-tight text-[#E6E2D9] shadow-lg"
            >
              <div className="flex items-center gap-1.5 font-semibold whitespace-nowrap">
                <span
                  className={`w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full shrink-0 ${
                    emuPerf.verdict === 'optimal'
                      ? 'bg-[#58B87C]'
                      : emuPerf.verdict === 'tight'
                        ? 'bg-[#E07A22]'
                        : emuPerf.verdict === 'lagging'
                          ? 'bg-[#FF6B63]'
                          : 'bg-[#8D8980]'
                  }`}
                />
                <span>
                  {emuPerf.verdict === 'paused'
                    ? 'ЭМУЛЯЦИЯ: ПАУЗА'
                    : emuPerf.verdict === 'warming'
                      ? 'ЭМУЛЯЦИЯ: ЗАМЕР...'
                      : `ЭМУЛЯЦИЯ ${emuPerf.speedPct}%`}
                </span>
                <span
                  className={
                    emuPerf.verdict === 'optimal'
                      ? 'text-[#7AD39B]'
                      : emuPerf.verdict === 'tight'
                        ? 'text-[#F09A49]'
                        : emuPerf.verdict === 'lagging'
                          ? 'text-[#FF8C85]'
                          : 'text-[#A7A39A]'
                  }
                >
                  {emuPerf.verdict === 'warming'
                    ? '· анализ нагрузки'
                    : emuPerf.verdict === 'paused'
                      ? '· остановлена'
                      : emuPerf.verdict === 'optimal'
                        ? '· как на реальной Amiga'
                        : emuPerf.verdict === 'tight'
                          ? '· нагрузка на пределе'
                          : '· тормозит эмулятор'}
                </span>
              </div>
              {emuPerf.verdict !== 'paused' && emuPerf.verdict !== 'warming' && (
                <>
                  <div className="mt-0.5 text-[#BDB9B0] whitespace-nowrap">
                    {emuPerf.emulatedHz.toFixed(1)}/{emuPerf.targetHz} Гц · Кадр{' '}
                    {emuPerf.frameMs.toFixed(1)}/{emuPerf.budgetMs.toFixed(1)} мс ({emuPerf.loadPct}%)
                  </div>
                  <div className="mt-0.5 text-[9px] sm:text-[10px] text-[#9B968D] whitespace-nowrap">
                    Ядро {emuPerf.coreMs.toFixed(1)} мс · Экран {emuPerf.blitMs.toFixed(1)} мс
                    {emuPerf.droppedPerSec > 0 ? ` · Пропуск ${emuPerf.droppedPerSec}/с` : ''}
                  </div>
                </>
              )}
            </div>
          )}

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

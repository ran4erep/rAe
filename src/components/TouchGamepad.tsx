import React, { useRef, useState } from 'react';
import { triggerHaptic } from '../emulator/haptics';
import { AMIGA_RAW } from '../emulator/keyboard/amigaKeyMap';
import { JoystickState } from '../emulator/types';
import { useSuppressBrowserTouchHold } from '../hooks/useSuppressBrowserTouchHold';

interface TouchGamepadProps {
  fullscreenOverlay?: boolean;
  onJoystickChange: (patch: Partial<JoystickState>) => void;
  onMouseButton: (left?: boolean, right?: boolean) => void;
  onKeyPulse: (rawCode: number, isDown: boolean) => void;
  onUserInteract: () => void;
}

export const TouchGamepad: React.FC<TouchGamepadProps> = React.memo(
  ({ fullscreenOverlay = false, onJoystickChange, onMouseButton, onKeyPulse, onUserInteract }) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    useSuppressBrowserTouchHold(containerRef);
    const padRef = useRef<HTMLDivElement | null>(null);
    const knobRef = useRef<HTMLDivElement | null>(null);
    const padPointerId = useRef<number | null>(null);
    const prevDirKey = useRef<string>('0000');
    const [activeDirs, setActiveDirs] = useState({
      up: false,
      down: false,
      left: false,
      right: false,
    });
    const [fire1, setFire1] = useState(false);
    const [fire2, setFire2] = useState(false);
    const [lmb, setLmb] = useState(false);
    const [rmb, setRmb] = useState(false);
    const [pressedQuick, setPressedQuick] = useState<Record<number, boolean>>({});

    const setKnobTransform = (x: number, y: number) => {
      if (knobRef.current) {
        knobRef.current.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      }
    };

    const updateStickFromPoint = (clientX: number, clientY: number) => {
      const el = padRef.current;
      if (!el) return;
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

      const dead = radius * 0.24;
      const next = {
        left: dx < -dead,
        right: dx > dead,
        up: dy < -dead,
        down: dy > dead,
      };
      const dirKey = `${next.up ? 1 : 0}${next.down ? 1 : 0}${next.left ? 1 : 0}${next.right ? 1 : 0}`;
      if (dirKey !== prevDirKey.current) {
        prevDirKey.current = dirKey;
        if (dirKey !== '0000') triggerHaptic(8);
        onJoystickChange(next);
        setActiveDirs(next);
      }
      setKnobTransform(dx, dy);
    };

    const handlePadDown = (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      onUserInteract();
      padPointerId.current = e.pointerId;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Ignore
      }
      updateStickFromPoint(e.clientX, e.clientY);
    };

    const handlePadMove = (e: React.PointerEvent<HTMLDivElement>) => {
      if (padPointerId.current !== e.pointerId) return;
      e.preventDefault();
      updateStickFromPoint(e.clientX, e.clientY);
    };

    const handlePadUp = (e: React.PointerEvent<HTMLDivElement>) => {
      if (padPointerId.current !== e.pointerId) return;
      padPointerId.current = null;
      prevDirKey.current = '0000';
      setKnobTransform(0, 0);
      const cleared = { up: false, down: false, left: false, right: false };
      setActiveDirs(cleared);
      onJoystickChange(cleared);
    };

    const quickKeys = [
      { label: 'ESC', code: AMIGA_RAW.ESC, aria: 'Escape' },
      { label: 'SPACE', code: AMIGA_RAW.SPACE, aria: 'Space' },
      { label: 'F1', code: AMIGA_RAW.F1, aria: 'F1' },
      { label: 'HELP', code: AMIGA_RAW.HELP, aria: 'Amiga Help' },
      { label: 'RET', code: AMIGA_RAW.RETURN, aria: 'Return' },
    ];

    const renderQuickKeyButton = (k: (typeof quickKeys)[number], extraCls: string) => (
      <button
        key={k.code}
        type="button"
        aria-label={k.aria}
        data-pressed={pressedQuick[k.code] ? 'true' : 'false'}
        onPointerDown={(e) => {
          e.preventDefault();
          onUserInteract();
          triggerHaptic(10);
          setPressedQuick((p) => ({ ...p, [k.code]: true }));
          onKeyPulse(k.code, true);
        }}
        onPointerUp={() => {
          setPressedQuick((p) => ({ ...p, [k.code]: false }));
          onKeyPulse(k.code, false);
        }}
        onPointerCancel={() => {
          setPressedQuick((p) => ({ ...p, [k.code]: false }));
          onKeyPulse(k.code, false);
        }}
        onContextMenu={(e) => e.preventDefault()}
        className={`rounded-[4px] amiga-key-grey text-[10px] sm:text-[11px] font-semibold ${extraCls}`}
      >
        {k.label}
      </button>
    );

    const renderStick = () => (
      <div className="flex flex-col items-center justify-center pointer-events-auto">
        <div
          ref={padRef}
          onPointerDown={handlePadDown}
          onPointerMove={handlePadMove}
          onPointerUp={handlePadUp}
          onPointerCancel={handlePadUp}
          onContextMenu={(e) => e.preventDefault()}
          role="application"
          aria-label="8-позиционный джойстик"
          className={`relative rounded-full flex items-center justify-center ${
            fullscreenOverlay
              ? 'w-32 h-32 sm:w-36 sm:h-36 bg-[#191A1D]/80 border-2 border-[#3C3B38] shadow-[inset_0_4px_12px_rgba(0,0,0,0.85)]'
              : 'w-40 h-40 bg-[#191A1D] border-2 border-[#3C3B38] shadow-[inset_0_4px_12px_rgba(0,0,0,0.85)]'
          }`}
        >
          <span className={`absolute top-2 text-xs font-bold ${activeDirs.up ? 'text-[#E07A22]' : 'text-[#8C8880]'}`}>▲</span>
          <span className={`absolute bottom-2 text-xs font-bold ${activeDirs.down ? 'text-[#E07A22]' : 'text-[#8C8880]'}`}>▼</span>
          <span className={`absolute left-2 text-xs font-bold ${activeDirs.left ? 'text-[#E07A22]' : 'text-[#8C8880]'}`}>◀</span>
          <span className={`absolute right-2 text-xs font-bold ${activeDirs.right ? 'text-[#E07A22]' : 'text-[#8C8880]'}`}>▶</span>

          <div
            ref={knobRef}
            className={`rounded-full bg-gradient-to-b from-[#E1463A] to-[#A62118] border border-[#F5786E]/45 shadow-[0_6px_14px_rgba(0,0,0,0.75)] pointer-events-none will-change-transform ${
              fullscreenOverlay ? 'w-14 h-14 opacity-85' : 'w-16 h-16'
            }`}
          />
        </div>
      </div>
    );

    const renderActionCluster = () => (
      <div
        className={`flex flex-col items-center pointer-events-auto ${
          fullscreenOverlay ? 'gap-1.5 w-[144px] sm:w-[154px]' : 'gap-3 flex-1 max-w-[175px]'
        }`}
      >
        <div className="flex items-center justify-center gap-2.5 w-full">
          <button
            type="button"
            aria-label="Fire 1 джойстика"
            data-pressed={fire1 ? 'true' : 'false'}
            onPointerDown={(e) => {
              e.preventDefault();
              onUserInteract();
              triggerHaptic(14);
              setFire1(true);
              onJoystickChange({ fire1: true });
            }}
            onPointerUp={() => {
              setFire1(false);
              onJoystickChange({ fire1: false });
            }}
            onPointerCancel={() => {
              setFire1(false);
              onJoystickChange({ fire1: false });
            }}
            onContextMenu={(e) => e.preventDefault()}
            className={`rounded-full amiga-key-accent font-display font-bold tracking-wide flex items-center justify-center ${
              fullscreenOverlay ? 'w-[64px] h-[64px] sm:w-[70px] sm:h-[70px] text-xs' : 'w-20 h-20 text-sm'
            }`}
          >
            FIRE 1
          </button>

          <button
            type="button"
            aria-label="Fire 2 джойстика"
            data-pressed={fire2 ? 'true' : 'false'}
            onPointerDown={(e) => {
              e.preventDefault();
              onUserInteract();
              triggerHaptic(12);
              setFire2(true);
              onJoystickChange({ fire2: true });
            }}
            onPointerUp={() => {
              setFire2(false);
              onJoystickChange({ fire2: false });
            }}
            onPointerCancel={() => {
              setFire2(false);
              onJoystickChange({ fire2: false });
            }}
            onContextMenu={(e) => e.preventDefault()}
            className={`rounded-full amiga-key-grey font-display font-bold flex items-center justify-center ${
              fullscreenOverlay ? 'w-13 h-13 sm:w-14 sm:h-14 text-[11px]' : 'w-16 h-16 text-xs'
            }`}
          >
            FIRE 2
          </button>
        </div>

        <div className={`flex items-center gap-2 w-full ${fullscreenOverlay ? 'h-7 sm:h-8' : 'h-11'}`}>
          <button
            type="button"
            aria-label="Левая кнопка мыши"
            data-pressed={lmb ? 'true' : 'false'}
            onPointerDown={(e) => {
              e.preventDefault();
              onUserInteract();
              triggerHaptic(10);
              setLmb(true);
              onMouseButton(true, undefined);
            }}
            onPointerUp={() => {
              setLmb(false);
              onMouseButton(false, undefined);
            }}
            onPointerCancel={() => {
              setLmb(false);
              onMouseButton(false, undefined);
            }}
            onContextMenu={(e) => e.preventDefault()}
            className="flex-1 h-full rounded-[4px] text-xs font-semibold amiga-key-ivory"
          >
            LMB
          </button>
          <button
            type="button"
            aria-label="Правая кнопка мыши"
            data-pressed={rmb ? 'true' : 'false'}
            onPointerDown={(e) => {
              e.preventDefault();
              onUserInteract();
              triggerHaptic(10);
              setRmb(true);
              onMouseButton(undefined, true);
            }}
            onPointerUp={() => {
              setRmb(false);
              onMouseButton(undefined, false);
            }}
            onPointerCancel={() => {
              setRmb(false);
              onMouseButton(undefined, false);
            }}
            onContextMenu={(e) => e.preventDefault()}
            className="flex-1 h-full rounded-[4px] text-xs font-semibold amiga-key-ivory"
          >
            RMB
          </button>
        </div>
      </div>
    );

    if (fullscreenOverlay) {
      return (
        <div
          ref={containerRef}
          className="w-full h-full flex items-end justify-between gap-4 px-3 sm:px-5 py-2 sm:py-3 pointer-events-none emulator-touch-surface amiga-keyboard-translucent"
          aria-label="Игровой джойстик"
          onContextMenu={(e) => e.preventDefault()}
        >
          {/* Left bottom: 8-way Touch Stick */}
          {renderStick()}

          {/* Right side: Vertical Quick Keyboard Keys stacked above Gamepad Buttons */}
          <div className="flex flex-col items-end justify-end gap-2 h-full min-h-0 pointer-events-none">
            <div
              data-testid="gamepad-vertical-keys"
              className="pointer-events-auto flex flex-col gap-1 w-[72px] sm:w-[80px]"
              aria-label="Дополнительные клавиши клавиатуры"
            >
              {quickKeys.map((k) => renderQuickKeyButton(k, 'w-full h-6 sm:h-7'))}
            </div>
            {renderActionCluster()}
          </div>
        </div>
      );
    }

    return (
      <div
        ref={containerRef}
        className="w-full h-full flex flex-col justify-between emulator-touch-surface bg-[#242321] px-3 pt-2.5 pb-safe"
        aria-label="Игровой джойстик"
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* Top quick game keys row (non-fullscreen mobile deck) */}
        <div className="flex items-center gap-1.5 shrink-0 h-10">
          {quickKeys.map((k) => renderQuickKeyButton(k, 'flex-1 h-full'))}
        </div>

        {/* Main thumb controls: 8-way stick + Fire 1 / Fire 2 + LMB / RMB */}
        <div className="flex-1 flex justify-between items-center gap-4 min-h-0 py-2">
          {renderStick()}
          {renderActionCluster()}
        </div>
      </div>
    );
  }
);

TouchGamepad.displayName = 'TouchGamepad';

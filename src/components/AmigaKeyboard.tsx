import React, { useCallback, useEffect, useRef, useState } from 'react';
import { triggerHaptic } from '../emulator/haptics';
import {
  AMIGA_BOTTOM_ROW,
  AMIGA_CAPSLOCK_KEY,
  AMIGA_FUNCTION_ROW,
  AMIGA_HOME_ROW,
  AMIGA_NUMBER_ROW,
  AMIGA_NUMPAD_ROWS,
  AMIGA_QWERTY_ROW,
  AMIGA_RAW,
  AMIGA_SPACE_ROW,
  AmigaKeyDef,
} from '../emulator/keyboard/amigaKeyMap';
import { TouchKeyboardController } from '../emulator/keyboard/touchKeyboardLogic';
import { useSuppressBrowserTouchHold } from '../hooks/useSuppressBrowserTouchHold';

export type KeyboardSubMode = 'qwerty' | 'numpad';

interface AmigaKeyboardProps {
  mode: KeyboardSubMode;
  capsLock: boolean;
  fullscreenOverlay?: boolean;
  onKeyEvent: (rawCode: number, isDown: boolean) => void;
  onMouseButton: (left?: boolean, right?: boolean) => void;
  onWarmReset: () => void;
  onUserInteract: () => void;
}

const AmigaLogoGlyph: React.FC<{ filled: boolean }> = ({ filled }) => (
  <svg
    viewBox="0 0 18 16"
    className="w-3.5 h-3.5 inline-block pointer-events-none"
    aria-hidden="true"
  >
    <path
      d="M9 1.5L2.2 14.5h3.1l1.3-2.7h4.8l1.3 2.7h3.1L9 1.5zm-1.1 7.6L9 6.5l1.1 2.6H7.9z"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={filled ? '0.6' : '1.4'}
      strokeLinejoin="round"
    />
  </svg>
);

const ReturnArrowGlyph: React.FC = () => (
  <svg
    viewBox="0 0 18 14"
    className="w-4 h-3.5 inline-block pointer-events-none"
    aria-hidden="true"
  >
    <path
      d="M14.5 2v6.5H4.2m3-3L3.8 8.5l3.4 3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const AmigaKeyboard: React.FC<AmigaKeyboardProps> = React.memo(
  ({
    mode,
    capsLock,
    fullscreenOverlay = false,
    onKeyEvent,
    onMouseButton,
    onWarmReset,
    onUserInteract,
  }) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    useSuppressBrowserTouchHold(containerRef);
    const controllerRef = useRef(new TouchKeyboardController());
    const pendingTimersRef = useRef<Set<number>>(new Set());
    const [pressedMap, setPressedMap] = useState<Record<number, boolean>>({});
    const [shiftActive, setShiftActive] = useState(false);
    const [auxPressed, setAuxPressed] = useState<{ lmb: boolean; rmb: boolean }>({
      lmb: false,
      rmb: false,
    });

    const syncVisualState = useCallback(() => {
      const ctrl = controllerRef.current;
      const next: Record<number, boolean> = {};
      for (const code of ctrl.getPressedCodesSnapshot()) {
        next[code] = true;
      }
      setPressedMap(next);
      setShiftActive(ctrl.isShiftActive());
    }, []);

    // Cleanup any held keys or timers on unmount
    useEffect(() => {
      const ctrl = controllerRef.current;
      const timers = pendingTimersRef.current;
      return () => {
        for (const t of timers) window.clearTimeout(t);
        timers.clear();
        for (const act of ctrl.resetAll()) {
          if (act.type === 'key' && act.down !== undefined) {
            onKeyEvent(act.code, act.down);
          }
        }
      };
    }, [onKeyEvent]);

    const applyControllerActions = useCallback(
      (actions: ReturnType<TouchKeyboardController['pointerDown']>) => {
        for (const act of actions) {
          if (act.type === 'key' && act.down !== undefined) {
            onKeyEvent(act.code, act.down);
          } else if (act.type === 'delayedCombo' && act.modifierCode !== undefined) {
            const targetCode = act.code;
            const modCode = act.modifierCode;
            const timerId = window.setTimeout(() => {
              pendingTimersRef.current.delete(timerId);
              onKeyEvent(targetCode, false);
              for (const rel of controllerRef.current.completeDelayedCombo(modCode)) {
                if (rel.type === 'key' && rel.down !== undefined) {
                  onKeyEvent(rel.code, rel.down);
                }
              }
              syncVisualState();
            }, 45);
            pendingTimersRef.current.add(timerId);
          }
        }
        syncVisualState();
      },
      [onKeyEvent, syncVisualState]
    );

    const handleKeyDown = useCallback(
      (def: AmigaKeyDef, e: React.PointerEvent<HTMLButtonElement>) => {
        e.preventDefault();
        onUserInteract();
        triggerHaptic(10);
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // Synthetic events may lack active pointer capture
        }
        const actions = controllerRef.current.pointerDown(e.pointerId, def.code);
        applyControllerActions(actions);
      },
      [applyControllerActions, onUserInteract]
    );

    const handleKeyMove = useCallback(
      (def: AmigaKeyDef, e: React.PointerEvent<HTMLButtonElement>) => {
        if (!def.isModifier) return;
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const keyBtn = el?.closest<HTMLElement>('[data-amiga-key]');
        const rawAttr = keyBtn?.dataset.amigaKey;
        const hoveredCode = rawAttr !== undefined ? Number(rawAttr) : null;
        if (controllerRef.current.pointerMove(e.pointerId, hoveredCode)) {
          syncVisualState();
        }
      },
      [syncVisualState]
    );

    const handleKeyUp = useCallback(
      (def: AmigaKeyDef, e: React.PointerEvent<HTMLButtonElement>) => {
        e.preventDefault();
        if (def.isModifier) {
          const el = document.elementFromPoint(e.clientX, e.clientY);
          const keyBtn = el?.closest<HTMLElement>('[data-amiga-key]');
          const rawAttr = keyBtn?.dataset.amigaKey;
          const hoveredCode = rawAttr !== undefined ? Number(rawAttr) : null;
          controllerRef.current.pointerMove(e.pointerId, hoveredCode);
        }
        const actions = controllerRef.current.pointerUp(e.pointerId);
        applyControllerActions(actions);
      },
      [applyControllerActions]
    );

    // Accessible keyboard/click fallback for AT/automated activation where detail === 0
    const handleClickFallback = useCallback(
      (def: AmigaKeyDef, e: React.MouseEvent<HTMLButtonElement>) => {
        if (e.detail !== 0) return;
        onUserInteract();
        triggerHaptic(10);
        onKeyEvent(def.code, true);
        setTimeout(() => onKeyEvent(def.code, false), 45);
      },
      [onKeyEvent, onUserInteract]
    );

    const renderKeyCap = (def: AmigaKeyDef, extraClass = '') => {
      const isPressed = Boolean(pressedMap[def.code]);
      const variantCls =
        def.variant === 'accent'
          ? 'amiga-key-accent'
          : def.variant === 'grey'
            ? 'amiga-key-grey'
            : 'amiga-key-ivory';

      const isAlphaKey =
        !def.amigaLogo &&
        !def.returnIcon &&
        def.label.length === 1 &&
        def.label >= 'A' &&
        def.label <= 'Z';
      const displayPrimary = isAlphaKey
        ? shiftActive !== capsLock
          ? def.label.toUpperCase()
          : def.label.toLowerCase()
        : shiftActive && def.shiftLabel
          ? def.shiftLabel
          : def.label;

      return (
        <button
          key={`${def.code}-${def.ariaLabel}`}
          type="button"
          aria-label={def.ariaLabel}
          data-amiga-key={def.code}
          data-pressed={isPressed ? 'true' : 'false'}
          data-caps-active={def.isCapsLock ? (capsLock ? 'true' : 'false') : undefined}
          style={{ flex: def.flex ?? 1 }}
          onPointerDown={(e) => handleKeyDown(def, e)}
          onPointerMove={(e) => handleKeyMove(def, e)}
          onPointerUp={(e) => handleKeyUp(def, e)}
          onPointerCancel={(e) => handleKeyUp(def, e)}
          onClick={(e) => handleClickFallback(def, e)}
          onContextMenu={(e) => e.preventDefault()}
          className={`relative h-full min-w-0 rounded-[4px] flex items-center justify-center leading-none transition-transform duration-75 focus-visible:outline-2 focus-visible:outline-[#E07A22] ${variantCls} ${extraClass}`}
        >
          {def.shiftLabel && !shiftActive && (
            <span className="text-[7px] leading-none opacity-65 font-mono absolute top-0.5 right-0.5 pointer-events-none">
              {def.shiftLabel}
            </span>
          )}

          {def.amigaLogo ? (
            <span className="flex items-center gap-0.5 text-[10px] font-bold pointer-events-none">
              <AmigaLogoGlyph filled={def.amigaLogo === 'filled'} />
            </span>
          ) : def.returnIcon ? (
            <ReturnArrowGlyph />
          ) : (
            <span
              className={`font-semibold tracking-tight truncate px-0.5 pointer-events-none ${
                def.label.length >= 4
                  ? 'text-[9px]'
                  : def.label.length >= 2
                    ? 'text-[10px]'
                    : def.code === AMIGA_RAW.TILDE
                      ? 'text-[13px] font-bold pt-1'
                      : 'text-[12px]'
              }`}
            >
              {displayPrimary}
            </span>
          )}

          {def.isCapsLock && (
            <span
              className={`w-2.5 h-1 rounded-full absolute bottom-[4px] left-1/2 -translate-x-1/2 pointer-events-none ${
                capsLock
                  ? 'bg-[#3DD668] shadow-[0_0_4px_rgba(61,214,104,0.85)]'
                  : 'bg-black/35'
              }`}
              aria-hidden="true"
            />
          )}
        </button>
      );
    };

    const arrowUp: AmigaKeyDef = { code: AMIGA_RAW.UP, label: '↑', ariaLabel: 'Arrow Up', variant: 'grey', flex: 1 };
    const arrowDown: AmigaKeyDef = { code: AMIGA_RAW.DOWN, label: '↓', ariaLabel: 'Arrow Down', variant: 'grey', flex: 1 };
    const arrowLeft: AmigaKeyDef = { code: AMIGA_RAW.LEFT, label: '←', ariaLabel: 'Arrow Left', variant: 'grey', flex: 1 };
    const arrowRight: AmigaKeyDef = { code: AMIGA_RAW.RIGHT, label: '→', ariaLabel: 'Arrow Right', variant: 'grey', flex: 1 };

    const qRowH = fullscreenOverlay ? 'h-[28px] sm:h-[32px]' : 'h-[39px]';
    const fRowH = fullscreenOverlay ? 'h-[24px] sm:h-[28px]' : 'h-[34px]';
    const npRowH = fullscreenOverlay ? 'h-[31px] sm:h-[36px]' : 'h-[42px]';

    return (
      <div
        ref={containerRef}
        className={`relative w-full h-full flex flex-col emulator-touch-surface ${
          fullscreenOverlay
            ? 'amiga-keyboard-translucent justify-end px-2 pb-1.5 pt-1 pointer-events-none'
            : mode === 'numpad'
              ? 'bg-[#242321] justify-center px-2 pt-2.5 pb-safe'
              : 'bg-[#242321] justify-center px-1 pt-2 pb-safe'
        }`}
        aria-label={mode === 'numpad' ? 'Цифровой блок и системные клавиши Amiga' : 'Полная QWERTY клавиатура Amiga'}
        onContextMenu={(e) => e.preventDefault()}
      >
        {mode === 'numpad' ? (
          <div
            className={`w-full max-w-[440px] mx-auto flex flex-col gap-1.5 ${
              fullscreenOverlay
                ? 'pointer-events-auto bg-[#1B1A18]/55 rounded-lg p-1.5 border border-white/10'
                : ''
            }`}
          >
            {/* Top Function Row */}
            <div className={`${fRowH} flex gap-1`}>
              {AMIGA_FUNCTION_ROW.map((k) => renderKeyCap(k))}
            </div>

            <div className="flex gap-1.5">
              {/* 18-Key Amiga Numpad */}
              <div className="flex-[4] flex flex-col gap-1.5">
                {AMIGA_NUMPAD_ROWS.map((row, rIdx) => (
                  <div key={rIdx} className={`${npRowH} flex gap-1.5`}>
                    {row.map((k) => renderKeyCap(k))}
                  </div>
                ))}
              </div>

              {/* Right Quick Column */}
              <div className="flex-[1.3] flex flex-col gap-1.5">
                <div className={`${npRowH} flex`}>{renderKeyCap(AMIGA_FUNCTION_ROW[12])}</div>
                <div className={`${npRowH} flex`}>{renderKeyCap(AMIGA_FUNCTION_ROW[11])}</div>
                <div className={`${npRowH} flex`}>{renderKeyCap(AMIGA_HOME_ROW[0])}</div>
                <div className={`${npRowH} flex`}>{renderKeyCap(AMIGA_SPACE_ROW[1])}</div>
                <button
                  type="button"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    onUserInteract();
                    triggerHaptic(14);
                  }}
                  onPointerUp={(e) => {
                    e.preventDefault();
                    onWarmReset();
                  }}
                  onClick={(e) => {
                    if (e.detail === 0) onWarmReset();
                  }}
                  onContextMenu={(e) => e.preventDefault()}
                  aria-label="Сброс Ctrl + Left Amiga + Right Amiga"
                  className={`${npRowH} rounded-[4px] amiga-key-accent text-[10px] font-bold leading-tight px-1 text-center`}
                >
                  CTRL
                  <br />
                  A+A
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div
            className={`w-full mx-auto flex flex-col ${
              fullscreenOverlay
                ? 'max-w-[660px] gap-[3px] pointer-events-auto bg-[#1B1A18]/55 rounded-lg p-1.5 border border-white/10'
                : 'max-w-[540px] gap-[5px]'
            }`}
          >
            {/* Row 1: Function & System Row (Esc, F1-F10, Del, Help) */}
            <div className={`${fRowH} flex gap-[3px]`}>
              {AMIGA_FUNCTION_ROW.map((k) => renderKeyCap(k))}
            </div>

            {/* Row 2: Numbers & Symbols + Backspace */}
            <div className={`${qRowH} flex gap-[3px]`}>
              {AMIGA_NUMBER_ROW.map((k) => renderKeyCap(k))}
            </div>

            {/* Row 3: Tab + QWERTYUIOP + [ ] \ */}
            <div className={`${qRowH} flex gap-[3px]`}>
              {AMIGA_QWERTY_ROW.map((k) => renderKeyCap(k))}
            </div>

            {/* Row 4: Ctrl + ASDFGHJKL + ; ' + Return */}
            <div className={`${qRowH} flex gap-[3px]`}>
              {AMIGA_HOME_ROW.map((k) => renderKeyCap(k))}
            </div>

            {/* Row 5: L-Shift + ZXCVBNM + , . / + R-Shift */}
            <div className={`${qRowH} flex gap-[3px]`}>
              {AMIGA_BOTTOM_ROW.map((k) => renderKeyCap(k))}
            </div>

            {/* Row 6: L-Alt + Left Amiga + Space + Right Amiga + R-Alt */}
            <div className={`${qRowH} flex gap-[4px]`}>
              {AMIGA_SPACE_ROW.map((k) => renderKeyCap(k))}
            </div>

            {/* Row 7: LMB / RMB + Caps Lock + Full Amiga Cursor Arrows */}
            <div className={`${qRowH} flex gap-[3px] pt-0.5`}>
              <button
                type="button"
                aria-label="Левая кнопка мыши Amiga"
                data-pressed={auxPressed.lmb ? 'true' : 'false'}
                style={{ flex: 1.05 }}
                onPointerDown={(e) => {
                  e.preventDefault();
                  onUserInteract();
                  triggerHaptic(10);
                  setAuxPressed((p) => ({ ...p, lmb: true }));
                  onMouseButton(true, undefined);
                }}
                onPointerUp={() => {
                  setAuxPressed((p) => ({ ...p, lmb: false }));
                  onMouseButton(false, undefined);
                }}
                onPointerCancel={() => {
                  setAuxPressed((p) => ({ ...p, lmb: false }));
                  onMouseButton(false, undefined);
                }}
                onContextMenu={(e) => e.preventDefault()}
                className="h-full min-w-0 rounded-[4px] amiga-key-grey flex items-center justify-center leading-none text-[10px] font-semibold"
              >
                LMB
              </button>
              <button
                type="button"
                aria-label="Правая кнопка мыши Amiga"
                data-pressed={auxPressed.rmb ? 'true' : 'false'}
                style={{ flex: 1.05 }}
                onPointerDown={(e) => {
                  e.preventDefault();
                  onUserInteract();
                  triggerHaptic(10);
                  setAuxPressed((p) => ({ ...p, rmb: true }));
                  onMouseButton(undefined, true);
                }}
                onPointerUp={() => {
                  setAuxPressed((p) => ({ ...p, rmb: false }));
                  onMouseButton(undefined, false);
                }}
                onPointerCancel={() => {
                  setAuxPressed((p) => ({ ...p, rmb: false }));
                  onMouseButton(undefined, false);
                }}
                onContextMenu={(e) => e.preventDefault()}
                className="h-full min-w-0 rounded-[4px] amiga-key-grey flex items-center justify-center leading-none text-[10px] font-semibold"
              >
                RMB
              </button>

              {renderKeyCap(AMIGA_CAPSLOCK_KEY)}

              {renderKeyCap(arrowLeft)}
              {renderKeyCap(arrowUp)}
              {renderKeyCap(arrowDown)}
              {renderKeyCap(arrowRight)}
            </div>
          </div>
        )}
      </div>
    );
  }
);

AmigaKeyboard.displayName = 'AmigaKeyboard';

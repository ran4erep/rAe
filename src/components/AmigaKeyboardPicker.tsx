import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import {
  ControlButtonSize,
  ControlTarget,
  SingleControlTarget,
  singleTargetsEqual,
  targetsEqual,
} from '../emulator/controls/customProfiles';
import { PickerGestureSession, PickerGestureSnapshot } from '../emulator/controls/pickerGesture';
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
  BROWSER_CODE_TO_AMIGA,
} from '../emulator/keyboard/amigaKeyMap';
import { triggerHaptic } from '../emulator/haptics';

interface AmigaKeyboardPickerProps {
  title: string;
  currentTarget: ControlTarget;
  showSizeSelector?: boolean;
  currentSize?: ControlButtonSize;
  onChangeSize?: (size: ControlButtonSize) => void;
  hideFireButtons?: boolean;
  joystickConnected?: boolean;
  onSelectTarget: (target: ControlTarget) => void;
  onClose: () => void;
}

const ARROW_DEFS: AmigaKeyDef[] = [
  { code: AMIGA_RAW.LEFT, label: '←', ariaLabel: 'Arrow Left', variant: 'grey', flex: 1 },
  { code: AMIGA_RAW.UP, label: '↑', ariaLabel: 'Arrow Up', variant: 'grey', flex: 1 },
  { code: AMIGA_RAW.DOWN, label: '↓', ariaLabel: 'Arrow Down', variant: 'grey', flex: 1 },
  { code: AMIGA_RAW.RIGHT, label: '→', ariaLabel: 'Arrow Right', variant: 'grey', flex: 1 },
];

export const AmigaKeyboardPicker: React.FC<AmigaKeyboardPickerProps> = ({
  title,
  currentTarget,
  showSizeSelector = false,
  currentSize = 'md',
  onChangeSize,
  hideFireButtons = false,
  joystickConnected = true,
  onSelectTarget,
  onClose,
}) => {
  const [subMode, setSubMode] = useState<'qwerty' | 'numpad'>('qwerty');
  const sessionRef = useRef<PickerGestureSession>(new PickerGestureSession());
  const [gesture, setGesture] = useState<PickerGestureSnapshot>(() =>
    sessionRef.current.getSnapshot()
  );

  const onSelectRef = useRef(onSelectTarget);
  onSelectRef.current = onSelectTarget;

  const syncSnapshot = useCallback(() => {
    setGesture(sessionRef.current.getSnapshot());
  }, []);

  const commitIfReady = useCallback(
    (result: ControlTarget | null) => {
      syncSnapshot();
      if (result) {
        onSelectRef.current(result);
      }
    },
    [syncSnapshot]
  );

  // Allow picking single keys or 2-key combos directly from a physical keyboard while open
  useEffect(() => {
    const session = sessionRef.current;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const raw = BROWSER_CODE_TO_AMIGA[e.code];
      if (raw === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      session.physicalKeyDown(e.code, { kind: 'key', code: raw });
      syncSnapshot();
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const raw = BROWSER_CODE_TO_AMIGA[e.code];
      if (raw === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      const result = session.physicalKeyUp(e.code);
      commitIfReady(result);
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true, passive: false });
    window.addEventListener('keyup', handleKeyUp, { capture: true, passive: false });
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
      window.removeEventListener('keyup', handleKeyUp, { capture: true });
    };
  }, [commitIfReady, syncSnapshot]);

  const handleTargetPointerDown = useCallback(
    (target: SingleControlTarget, e: React.PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      triggerHaptic(8);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic events may lack active pointer capture
      }
      sessionRef.current.pointerDown(e.pointerId, target);
      syncSnapshot();
    },
    [syncSnapshot]
  );

  const handleTargetPointerUp = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const result = sessionRef.current.pointerUp(e.pointerId);
      commitIfReady(result);
    },
    [commitIfReady]
  );

  const handleTargetPointerCancel = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      sessionRef.current.pointerCancel(e.pointerId);
      syncSnapshot();
    },
    [syncSnapshot]
  );

  const handleTargetKeyboardClick = useCallback(
    (target: SingleControlTarget, e: React.MouseEvent<HTMLButtonElement>) => {
      if (e.detail !== 0) return; // Pointer clicks are handled by pointerDown + pointerUp
      e.preventDefault();
      triggerHaptic(8);
      const syntheticId = -1;
      sessionRef.current.pointerDown(syntheticId, target);
      const result = sessionRef.current.pointerUp(syntheticId);
      commitIfReady(result);
    },
    [commitIfReady]
  );

  const isTargetHighlighted = (target: SingleControlTarget): boolean => {
    if (gesture.isCapturing) {
      if (gesture.capturedTargets.some((t) => singleTargetsEqual(t, target))) return true;
      if (gesture.heldTargets.some((t) => singleTargetsEqual(t, target))) return true;
      return false;
    }
    if (currentTarget.kind === 'combo') {
      return (
        singleTargetsEqual(currentTarget.targets[0], target) ||
        singleTargetsEqual(currentTarget.targets[1], target)
      );
    }
    return targetsEqual(currentTarget, target);
  };

  const isTargetPressed = (target: SingleControlTarget): boolean =>
    gesture.heldTargets.some((t) => singleTargetsEqual(t, target));

  const renderKeyCap = (def: AmigaKeyDef) => {
    const target: SingleControlTarget = { kind: 'key', code: def.code };
    const isActive = isTargetHighlighted(target);
    const isPressed = isTargetPressed(target);
    const variantCls =
      def.variant === 'accent'
        ? 'amiga-key-accent'
        : def.variant === 'grey'
          ? 'amiga-key-grey'
          : 'amiga-key-ivory';

    return (
      <button
        key={`${def.code}-${def.ariaLabel}`}
        type="button"
        aria-label={def.ariaLabel}
        data-pressed={isPressed ? 'true' : 'false'}
        style={{ flex: def.flex ?? 1 }}
        onPointerDown={(e) => handleTargetPointerDown(target, e)}
        onPointerUp={handleTargetPointerUp}
        onPointerCancel={handleTargetPointerCancel}
        onClick={(e) => handleTargetKeyboardClick(target, e)}
        onContextMenu={(e) => e.preventDefault()}
        className={`relative h-full min-w-0 rounded-[4px] flex items-center justify-center leading-none transition-transform select-none ${variantCls} ${
          isActive ? 'z-10 outline-2 outline-[#E07A22] outline-offset-0' : ''
        }`}
      >
        <span
          className={`font-semibold tracking-tight truncate px-0.5 pointer-events-none ${
            def.label.length >= 4 ? 'text-[9px]' : def.label.length >= 2 ? 'text-[10px]' : 'text-[12px]'
          }`}
        >
          {def.label}
        </span>
      </button>
    );
  };

  const renderExtraTargetBtn = (
    target: SingleControlTarget,
    label: string,
    variant: 'accent' | 'ivory' | 'grey' = 'grey'
  ) => {
    const isActive = isTargetHighlighted(target);
    const isPressed = isTargetPressed(target);
    const cls =
      variant === 'accent'
        ? 'amiga-key-accent'
        : variant === 'ivory'
          ? 'amiga-key-ivory'
          : 'amiga-key-grey';
    return (
      <button
        key={label}
        type="button"
        data-pressed={isPressed ? 'true' : 'false'}
        onPointerDown={(e) => handleTargetPointerDown(target, e)}
        onPointerUp={handleTargetPointerUp}
        onPointerCancel={handleTargetPointerCancel}
        onClick={(e) => handleTargetKeyboardClick(target, e)}
        onContextMenu={(e) => e.preventDefault()}
        className={`h-7 px-2.5 rounded-[4px] text-[10px] font-semibold whitespace-nowrap select-none ${cls} ${
          isActive ? 'z-10 outline-2 outline-[#E07A22] outline-offset-0' : ''
        }`}
      >
        {label}
      </button>
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-[1.5px] p-1 sm:p-3"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-full max-w-[680px] bg-[#242321] border border-white/15 rounded-xl shadow-2xl overflow-hidden flex flex-col touch-none select-none"
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* Compact Header */}
        <div className="px-3 py-2 bg-[#1B1C1F] border-b border-white/10 flex items-center justify-between gap-2 flex-wrap">
          <span className="text-xs sm:text-sm font-bold text-[#F2EFE9] truncate">{title}</span>

          <div className="flex items-center gap-1.5 flex-wrap">
            {showSizeSelector && onChangeSize && (
              <div className="flex items-center gap-0.5 bg-[#121316] p-0.5 rounded-md border border-white/10">
                {(['sm', 'md', 'lg'] as ControlButtonSize[]).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => onChangeSize(s)}
                    className={`h-6 px-2 rounded text-[10px] font-semibold uppercase ${
                      currentSize === s ? 'bg-[#C8342A] text-white' : 'text-[#BDB9B0] hover:text-white'
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}

            <div className="flex items-center gap-0.5 bg-[#121316] p-0.5 rounded-md border border-white/10">
              <button
                type="button"
                onClick={() => setSubMode('qwerty')}
                className={`h-6 px-2 rounded text-[10px] font-semibold ${
                  subMode === 'qwerty' ? 'bg-[#E07A22] text-[#141518]' : 'text-[#BDB9B0] hover:text-white'
                }`}
              >
                QWERTY
              </button>
              <button
                type="button"
                onClick={() => setSubMode('numpad')}
                className={`h-6 px-2 rounded text-[10px] font-semibold ${
                  subMode === 'numpad' ? 'bg-[#E07A22] text-[#141518]' : 'text-[#BDB9B0] hover:text-white'
                }`}
              >
                Numpad
              </button>
            </div>

            <button
              type="button"
              onClick={onClose}
              aria-label="Закрыть клавиатуру"
              className="w-7 h-7 rounded-md bg-[#2A2D33] hover:bg-[#353941] flex items-center justify-center text-[#E6E2D9]"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Extra Mouse & Joystick Actions Strip */}
        <div className="px-2 py-1.5 bg-[#1C1D20] border-b border-white/8 flex flex-wrap items-center gap-1.5">
          <div className="flex items-center gap-1">
            <span className="text-[10px] font-semibold text-[#9A968D] mr-0.5">Мышь:</span>
            {renderExtraTargetBtn({ kind: 'mouse', button: 'left' }, 'ЛКМ', 'ivory')}
            {renderExtraTargetBtn({ kind: 'mouse', button: 'right' }, 'ПКМ', 'ivory')}
          </div>
          {joystickConnected && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[10px] font-semibold text-[#9A968D] mr-0.5">Джойстик:</span>
              {!hideFireButtons && (
                <>
                  {renderExtraTargetBtn({ kind: 'joy', dir: 'fire1' }, 'FIRE 1', 'accent')}
                  {renderExtraTargetBtn({ kind: 'joy', dir: 'fire2' }, 'FIRE 2')}
                </>
              )}
              {renderExtraTargetBtn({ kind: 'joy', dir: 'up' }, 'JOY ↑')}
              {renderExtraTargetBtn({ kind: 'joy', dir: 'down' }, 'JOY ↓')}
              {renderExtraTargetBtn({ kind: 'joy', dir: 'left' }, 'JOY ←')}
              {renderExtraTargetBtn({ kind: 'joy', dir: 'right' }, 'JOY →')}
            </div>
          )}
        </div>

        {/* Authentic Amiga Keyboard */}
        <div className="p-2 flex flex-col gap-1 touch-none">
          {subMode === 'numpad' ? (
            <div className="w-full max-w-[420px] mx-auto flex flex-col gap-1">
              <div className="h-[26px] flex gap-1">
                {AMIGA_FUNCTION_ROW.map((k) => renderKeyCap(k))}
              </div>
              {AMIGA_NUMPAD_ROWS.map((row, rIdx) => (
                <div key={rIdx} className="h-[32px] flex gap-1">
                  {row.map((k) => renderKeyCap(k))}
                </div>
              ))}
            </div>
          ) : (
            <div className="w-full flex flex-col gap-[3px]">
              <div className="h-[24px] sm:h-[28px] flex gap-[3px]">
                {AMIGA_FUNCTION_ROW.map((k) => renderKeyCap(k))}
              </div>
              <div className="h-[28px] sm:h-[32px] flex gap-[3px]">
                {AMIGA_NUMBER_ROW.map((k) => renderKeyCap(k))}
              </div>
              <div className="h-[28px] sm:h-[32px] flex gap-[3px]">
                {AMIGA_QWERTY_ROW.map((k) => renderKeyCap(k))}
              </div>
              <div className="h-[28px] sm:h-[32px] flex gap-[3px]">
                {AMIGA_HOME_ROW.map((k) => renderKeyCap(k))}
              </div>
              <div className="h-[28px] sm:h-[32px] flex gap-[3px]">
                {AMIGA_BOTTOM_ROW.map((k) => renderKeyCap(k))}
              </div>
              <div className="h-[28px] sm:h-[32px] flex gap-[3px]">
                {AMIGA_SPACE_ROW.map((k) => renderKeyCap(k))}
              </div>
              <div className="h-[28px] sm:h-[32px] flex gap-[3px]">
                {renderKeyCap(AMIGA_CAPSLOCK_KEY)}
                {ARROW_DEFS.map((k) => renderKeyCap(k))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

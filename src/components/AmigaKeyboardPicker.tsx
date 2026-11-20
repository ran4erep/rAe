import React, { useState } from 'react';
import { X } from 'lucide-react';
import {
  ControlButtonSize,
  ControlTarget,
  targetsEqual,
} from '../emulator/controls/customProfiles';
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

  const arrowDefs: AmigaKeyDef[] = [
    { code: AMIGA_RAW.LEFT, label: '←', ariaLabel: 'Arrow Left', variant: 'grey', flex: 1 },
    { code: AMIGA_RAW.UP, label: '↑', ariaLabel: 'Arrow Up', variant: 'grey', flex: 1 },
    { code: AMIGA_RAW.DOWN, label: '↓', ariaLabel: 'Arrow Down', variant: 'grey', flex: 1 },
    { code: AMIGA_RAW.RIGHT, label: '→', ariaLabel: 'Arrow Right', variant: 'grey', flex: 1 },
  ];

  const renderKeyCap = (def: AmigaKeyDef) => {
    const target: ControlTarget = { kind: 'key', code: def.code };
    const isActive = targetsEqual(currentTarget, target);
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
        style={{ flex: def.flex ?? 1 }}
        onClick={() => onSelectTarget(target)}
        className={`relative h-full min-w-0 rounded-[4px] flex items-center justify-center leading-none transition-transform active:scale-[0.96] ${variantCls} ${
          isActive ? 'ring-2 ring-[#E07A22] ring-offset-1 ring-offset-[#1C1E22]' : ''
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

  const renderExtraTargetBtn = (target: ControlTarget, label: string, accent = false) => {
    const isActive = targetsEqual(currentTarget, target);
    return (
      <button
        key={label}
        type="button"
        onClick={() => onSelectTarget(target)}
        className={`h-7 px-2 rounded-[4px] text-[10px] font-semibold whitespace-nowrap ${
          accent ? 'amiga-key-accent' : 'amiga-key-grey'
        } ${isActive ? 'ring-2 ring-[#E07A22]' : ''}`}
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
      <div className="w-full max-w-[680px] bg-[#242321] border border-white/15 rounded-xl shadow-2xl overflow-hidden flex flex-col">
        {/* Compact Header */}
        <div className="px-3 py-2 bg-[#1B1C1F] border-b border-white/10 flex items-center justify-between gap-2 flex-wrap">
          <span className="text-xs sm:text-sm font-bold text-[#F2EFE9] truncate">{title}</span>

          <div className="flex items-center gap-2">
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

        {/* Extra Joystick & Mouse Actions Strip */}
        <div className="px-2 py-1.5 bg-[#1C1D20] border-b border-white/8 flex items-center gap-1.5 overflow-x-auto">
          {joystickConnected && !hideFireButtons && (
            <>
              {renderExtraTargetBtn({ kind: 'joy', dir: 'fire1' }, 'FIRE 1', true)}
              {renderExtraTargetBtn({ kind: 'joy', dir: 'fire2' }, 'FIRE 2')}
            </>
          )}
          {joystickConnected && (
            <>
              {renderExtraTargetBtn({ kind: 'joy', dir: 'up' }, 'JOY ↑')}
              {renderExtraTargetBtn({ kind: 'joy', dir: 'down' }, 'JOY ↓')}
              {renderExtraTargetBtn({ kind: 'joy', dir: 'left' }, 'JOY ←')}
              {renderExtraTargetBtn({ kind: 'joy', dir: 'right' }, 'JOY →')}
            </>
          )}
          {renderExtraTargetBtn({ kind: 'mouse', button: 'left' }, 'ЛКМ')}
          {renderExtraTargetBtn({ kind: 'mouse', button: 'right' }, 'ПКМ')}
        </div>

        {/* Authentic Amiga Keyboard */}
        <div className="p-2 flex flex-col gap-1">
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
                {arrowDefs.map((k) => renderKeyCap(k))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

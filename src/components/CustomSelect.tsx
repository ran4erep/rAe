import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

export interface CustomSelectOption<T extends string = string> {
  value: T;
  label: string;
  group?: string;
  disabled?: boolean;
}

interface CustomSelectProps<T extends string = string> {
  value: T;
  options: ReadonlyArray<CustomSelectOption<T>>;
  onChange: (value: T) => void;
  ariaLabel: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  menuClassName?: string;
  size?: 'sm' | 'md';
}

interface MenuPosition {
  left: number;
  top?: number;
  bottom?: number;
  minWidth: number;
  maxWidth: number;
  maxHeight: number;
}

export function CustomSelect<T extends string = string>({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder = 'Выбрать...',
  disabled = false,
  className = '',
  menuClassName = '',
  size = 'sm',
}: CustomSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<MenuPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();

  const selectedOption = options.find((opt) => opt.value === value) ?? null;

  const computeAndOpen = () => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const spaceBelow = vh - rect.bottom - 8;
    const spaceAbove = rect.top - 8;
    const openUp = spaceBelow < 160 && spaceAbove > spaceBelow;

    const maxWidth = Math.min(280, vw - 16);
    const minWidth = Math.min(Math.max(rect.width, 168), maxWidth);
    const left = Math.max(8, Math.min(rect.left, vw - minWidth - 8));
    const availableHeight = openUp ? spaceAbove : spaceBelow;
    const maxHeight = Math.max(110, Math.min(260, availableHeight));

    setMenuPos(
      openUp
        ? {
            left,
            bottom: vh - rect.top + 4,
            minWidth,
            maxWidth,
            maxHeight,
          }
        : {
            left,
            top: rect.bottom + 4,
            minWidth,
            maxWidth,
            maxHeight,
          }
    );
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const enabled = options.filter((o) => !o.disabled);
        if (enabled.length === 0) return;
        const idx = enabled.findIndex((o) => o.value === value);
        const nextIdx =
          e.key === 'ArrowDown'
            ? (idx + 1) % enabled.length
            : (idx - 1 + enabled.length) % enabled.length;
        onChange(enabled[nextIdx].value);
      }
    };

    const handleResize = () => setOpen(false);

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleResize);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleResize);
    };
  }, [open, options, value, onChange]);

  const heightCls = size === 'md' ? 'h-9 text-xs px-2.5' : 'h-8 text-xs px-2';

  let lastGroup: string | undefined;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={ariaLabel}
        onClick={() => {
          if (disabled) return;
          if (open) setOpen(false);
          else computeAndOpen();
        }}
        className={`${heightCls} inline-flex items-center justify-between gap-1.5 rounded-md bg-[#121316] border text-left font-semibold text-[#F2EFE9] transition-colors focus:outline-none disabled:opacity-45 disabled:pointer-events-none ${
          open ? 'border-[#E07A22]' : 'border-white/15 hover:border-white/28'
        } ${className}`}
      >
        <span className="truncate">{selectedOption ? selectedOption.label : placeholder}</span>
        <ChevronDown
          className={`w-3.5 h-3.5 shrink-0 text-[#9E9A90] transition-transform duration-150 ${
            open ? 'rotate-180 text-[#E07A22]' : ''
          }`}
          aria-hidden="true"
        />
      </button>

      {open &&
        menuPos &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={menuRef}
            id={listboxId}
            role="listbox"
            aria-label={ariaLabel}
            style={{
              left: menuPos.left,
              top: menuPos.top,
              bottom: menuPos.bottom,
              minWidth: menuPos.minWidth,
              maxWidth: menuPos.maxWidth,
              maxHeight: menuPos.maxHeight,
            }}
            className={`fixed z-[90] overflow-y-auto rounded-lg bg-[#1A1C21] border border-white/18 shadow-2xl py-1 select-none ${menuClassName}`}
          >
            {options.map((opt) => {
              const isSelected = opt.value === value;
              const showGroupHeader = opt.group && opt.group !== lastGroup;
              if (opt.group) lastGroup = opt.group;

              return (
                <React.Fragment key={opt.value}>
                  {showGroupHeader && (
                    <div className="px-2.5 pt-2 pb-1 text-[10px] font-semibold text-[#8D8980] tracking-wide">
                      {opt.group}
                    </div>
                  )}
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    disabled={opt.disabled}
                    onClick={() => {
                      if (opt.disabled) return;
                      onChange(opt.value);
                      setOpen(false);
                      triggerRef.current?.focus();
                    }}
                    className={`w-full min-h-[36px] px-2.5 py-1.5 text-left text-xs font-medium flex items-center justify-between gap-2 transition-colors disabled:opacity-40 disabled:pointer-events-none ${
                      isSelected
                        ? 'bg-[#C8342A]/22 text-[#F2EFE9]'
                        : 'text-[#D6D2C9] hover:bg-[#262931] hover:text-white'
                    }`}
                  >
                    <span className="truncate">{opt.label}</span>
                    {isSelected && <Check className="w-3.5 h-3.5 shrink-0 text-[#E07A22]" aria-hidden="true" />}
                  </button>
                </React.Fragment>
              );
            })}
          </div>,
          document.body
        )}
    </>
  );
}

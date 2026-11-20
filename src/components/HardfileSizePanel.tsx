import React, { useEffect, useId, useRef, useState } from 'react';
import { HardfileStatus } from '../emulator/types';

interface HardfileSizePanelProps {
  dh0: HardfileStatus;
  targetSizeMB: number;
  driveLabel?: string;
  sliderLabel?: string;
  compact?: boolean;
  onChangeSizeMB: (sizeMB: number) => void;
}

export function formatStorageBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} КБ`;
  }
  return `${Math.max(0, Math.round(bytes))} Б`;
}

export const HardfileSizePanel: React.FC<HardfileSizePanelProps> = ({
  dh0,
  targetSizeMB,
  driveLabel = 'DH0:',
  sliderLabel,
  compact = false,
  onChangeSizeMB,
}) => {
  const sliderId = useId();
  const actualMB =
    dh0.mounted && dh0.sizeBytes > 0
      ? Math.max(1, Math.min(64, Math.round(dh0.sizeBytes / (1024 * 1024))))
      : targetSizeMB;
  const minMB = dh0.mounted ? Math.max(1, dh0.minSizeMB) : 1;
  const maxMB = 64;

  const [draftMB, setDraftMB] = useState<number | null>(null);
  const draftRef = useRef<number | null>(null);
  const debounceTimerRef = useRef<number | null>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    setDraftMB(null);
    draftRef.current = null;
  }, [actualMB, targetSizeMB, dh0.mounted]);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  const displayMB = Math.max(minMB, Math.min(maxMB, draftMB ?? actualMB));
  const previewTotalBytes =
    draftMB !== null
      ? displayMB * 1024 * 1024
      : dh0.mounted
        ? dh0.sizeBytes
        : displayMB * 1024 * 1024;
  const usedBytes = dh0.mounted ? Math.min(dh0.usedBytes, previewTotalBytes) : 0;
  const freeBytes = Math.max(0, previewTotalBytes - usedBytes);
  const usedPct =
    previewTotalBytes > 0 ? Math.min(100, Math.round((usedBytes / previewTotalBytes) * 1000) / 10) : 0;

  const barColorClass =
    usedPct >= 95 ? 'bg-[#D94035]' : usedPct >= 80 ? 'bg-[#E07A22]' : 'bg-[#58B87C]';

  const commitDraft = () => {
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    const pending = draftRef.current;
    draftRef.current = null;
    setDraftMB(null);
    if (pending !== null && pending !== actualMB) {
      onChangeSizeMB(pending);
    }
  };

  const sliderDisabled = dh0.mounted && !dh0.canResize;

  const usedRatio = previewTotalBytes > 0 ? Math.min(1, Math.max(usedBytes > 0 ? 0.02 : 0, usedBytes / previewTotalBytes)) : 0;
  const resolvedLabel =
    sliderLabel ?? (dh0.mounted ? `Размер диска (${driveLabel})` : `Объём нового ${driveLabel}`);

  return (
    <div className={compact ? 'space-y-1.5 pt-1' : 'space-y-2 pt-2 border-t border-white/6'}>
      {dh0.mounted && (
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2 text-[11px] leading-tight">
            <span className="text-[#BDB9B0] font-mono">
              Занято: <strong className="text-[#F2EFE9] font-semibold">{formatStorageBytes(usedBytes)}</strong>
            </span>
            <span className="text-[#8BC49A] font-mono">
              Свободно: <strong className="font-semibold">{formatStorageBytes(freeBytes)}</strong>
            </span>
          </div>
          <div
            role="progressbar"
            aria-label={`Заполненность жёсткого диска ${driveLabel}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(usedPct)}
            className="w-full h-2 rounded-full bg-[#24272E] overflow-hidden border border-white/8"
          >
            <div
              className={`h-full w-full origin-left transition-transform duration-150 ${barColorClass}`}
              style={{ transform: `scaleX(${usedRatio})` }}
            />
          </div>
        </div>
      )}

      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2 text-[11px]">
          <label htmlFor={sliderId} className="text-[#A7A39A]">
            {resolvedLabel}
          </label>
          <span className="font-mono font-semibold text-[#7AD39B]">
            {displayMB} МБ{dh0.mounted ? ` (${usedPct.toFixed(0)}%)` : ''}
          </span>
        </div>
        <input
          id={sliderId}
          type="range"
          min={minMB}
          max={maxMB}
          step={1}
          value={displayMB}
          disabled={sliderDisabled}
          aria-label={`Регулировка доступной памяти ${driveLabel} в мегабайтах`}
          className="w-full h-1.5 accent-[#58B87C] bg-[#2A2D33] rounded-lg cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed"
          onPointerDown={() => {
            draggingRef.current = true;
          }}
          onChange={(e) => {
            const nextVal = Math.max(minMB, Math.min(maxMB, Number(e.target.value) || minMB));
            draftRef.current = nextVal;
            setDraftMB(nextVal);
            if (!draggingRef.current) {
              if (debounceTimerRef.current !== null) {
                window.clearTimeout(debounceTimerRef.current);
              }
              debounceTimerRef.current = window.setTimeout(() => {
                commitDraft();
              }, 220);
            }
          }}
          onPointerUp={() => {
            draggingRef.current = false;
            commitDraft();
          }}
          onTouchEnd={() => {
            draggingRef.current = false;
            commitDraft();
          }}
          onBlur={() => {
            draggingRef.current = false;
            commitDraft();
          }}
        />
        {sliderDisabled && (
          <p className="text-[10px] text-[#8D8980]">
            Для RDB-образа с разметкой разделов размер фиксирован.
          </p>
        )}
      </div>
    </div>
  );
};

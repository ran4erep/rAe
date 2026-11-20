import React, { useState } from 'react';
import { X } from 'lucide-react';
import {
  AmigaConfig,
  ChipRamKB,
  ChipsetModel,
  FrameSkipMode,
  OverscanMode,
  SlowRamKB,
  VideoStandard,
} from '../emulator/types';
import { getPresetViewport } from '../emulator/hardware/overscan';

type SettingsCategory = 'system' | 'display' | 'audio' | 'performance';

const CATEGORIES: ReadonlyArray<{ id: SettingsCategory; label: string }> = [
  { id: 'system', label: 'Система' },
  { id: 'display', label: 'Видео' },
  { id: 'audio', label: 'Звук' },
  { id: 'performance', label: 'CPU и ввод' },
];

const OVERSCAN_OPTIONS: ReadonlyArray<{ id: OverscanMode; label: string }> = [
  { id: 'auto', label: 'Авто' },
  { id: 'none', label: 'Стандарт' },
  { id: 'tv', label: 'ТВ' },
  { id: 'max', label: 'Макс' },
];

interface SettingsDrawerProps {
  open: boolean;
  config: AmigaConfig;
  onClose: () => void;
  onUpdateConfig: (patch: Partial<AmigaConfig>) => void;
}

interface ToggleRowProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

const ToggleRow: React.FC<ToggleRowProps> = ({ label, checked, onChange }) => (
  <label className="flex items-center justify-between gap-3 min-h-[44px] py-2 cursor-pointer select-none">
    <span className="text-sm font-medium text-[#F2EFE9]">{label}</span>
    <span className="relative inline-flex shrink-0 items-center">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className="inline-flex h-6 w-11 items-center rounded-full bg-[#121316] border border-white/15 transition-colors peer-checked:bg-[#C8342A] peer-checked:border-[#C8342A] peer-focus-visible:ring-2 peer-focus-visible:ring-[#E07A22] after:content-[''] after:block after:h-4 after:w-4 after:translate-x-1 after:rounded-full after:bg-[#F2EFE9] after:transition-transform peer-checked:after:translate-x-6"
      />
    </span>
  </label>
);

export const SettingsDrawer: React.FC<SettingsDrawerProps> = ({
  open,
  config,
  onClose,
  onUpdateConfig,
}) => {
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>('system');

  if (!open) return null;

  const volumeRatio = Math.max(0, Math.min(1, config.audioVolume));
  const volumePercent = Math.round(volumeRatio * 100);

  const overscanPreset =
    config.overscan === 'auto'
      ? null
      : getPresetViewport(config.overscan, config.videoStandard);
  const overscanSummary = overscanPreset
    ? `${overscanPreset.width}×${overscanPreset.height}`
    : 'Авто (DIW)';

  const segBtn = (active: boolean) =>
    `flex-1 h-10 rounded-md text-xs font-semibold transition-colors whitespace-nowrap px-2 ${
      active
        ? 'bg-[#C8342A] text-white'
        : 'bg-[#16181C] text-[#BDB9B0] hover:bg-[#262930]'
    }`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70"
      role="dialog"
      aria-modal="true"
      aria-label="Настройки"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full sm:max-w-md max-h-[85dvh] bg-[#1E2025] border-t sm:border border-white/12 rounded-t-2xl sm:rounded-xl flex flex-col overflow-hidden shadow-2xl">
        <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between gap-3">
          <h2 className="text-base font-bold text-[#F2EFE9]">Настройки</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть настройки"
            className="w-10 h-10 rounded-lg bg-[#2A2D33] hover:bg-[#353941] flex items-center justify-center text-[#E6E2D9]"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Category Tabs */}
        <div className="px-4 pt-3 pb-2 border-b border-white/8 bg-[#191B20]">
          <div
            role="tablist"
            aria-label="Категории настроек"
            className="flex items-center gap-1 p-1 bg-[#121316] rounded-lg"
          >
            {CATEGORIES.map((cat) => {
              const selected = activeCategory === cat.id;
              return (
                <button
                  key={cat.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setActiveCategory(cat.id)}
                  className={`flex-auto h-9 px-2.5 rounded-md text-xs font-semibold whitespace-nowrap transition-colors ${
                    selected
                      ? 'bg-[#C8342A] text-white'
                      : 'text-[#BDB9B0] hover:text-[#F2EFE9] hover:bg-[#22252C]'
                  }`}
                >
                  {cat.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 min-h-[260px]">
          {activeCategory === 'system' && (
            <div className="space-y-4">
              <div className="space-y-2">
                <span className="block text-xs font-semibold text-[#D6D2C9]">Чипсет</span>
                <div className="flex gap-1.5 p-1 bg-[#121316] rounded-lg">
                  {(['OCS', 'ECS'] as ChipsetModel[]).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => onUpdateConfig({ chipset: m })}
                      className={segBtn(config.chipset === m)}
                    >
                      {m === 'OCS' ? 'OCS (A500)' : 'ECS (A500+)'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <span className="block text-xs font-semibold text-[#D6D2C9]">Chip RAM</span>
                <div className="flex gap-1.5 p-1 bg-[#121316] rounded-lg">
                  {([512, 1024, 2048] as ChipRamKB[]).map((kb) => (
                    <button
                      key={kb}
                      type="button"
                      onClick={() => onUpdateConfig({ chipRamKB: kb })}
                      className={segBtn(config.chipRamKB === kb)}
                    >
                      {kb === 512 ? '512 КБ' : kb === 1024 ? '1 МБ' : '2 МБ'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <span className="block text-xs font-semibold text-[#D6D2C9]">Slow RAM (A501)</span>
                <div className="flex gap-1.5 p-1 bg-[#121316] rounded-lg">
                  {([0, 512] as SlowRamKB[]).map((kb) => (
                    <button
                      key={kb}
                      type="button"
                      onClick={() => onUpdateConfig({ slowRamKB: kb })}
                      className={segBtn(config.slowRamKB === kb)}
                    >
                      {kb === 0 ? 'Выкл' : '+512 КБ'}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeCategory === 'display' && (
            <div className="space-y-4">
              <div className="space-y-2">
                <span className="block text-xs font-semibold text-[#D6D2C9]">Видеостандарт</span>
                <div className="flex gap-1.5 p-1 bg-[#121316] rounded-lg">
                  {(['PAL', 'NTSC'] as VideoStandard[]).map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => onUpdateConfig({ videoStandard: v })}
                      className={segBtn(config.videoStandard === v)}
                    >
                      {v === 'PAL' ? 'PAL 50 Гц' : 'NTSC 60 Гц'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="block text-xs font-semibold text-[#D6D2C9]">
                    Оверскан (поля экрана)
                  </span>
                  <span
                    data-testid="overscan-resolution-label"
                    className="text-[11px] font-mono tabular-nums text-[#E07A22]"
                  >
                    {overscanSummary}
                  </span>
                </div>
                <div
                  role="radiogroup"
                  aria-label="Оверскан"
                  className="flex gap-1.5 p-1 bg-[#121316] rounded-lg"
                >
                  {OVERSCAN_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      role="radio"
                      aria-checked={config.overscan === opt.id}
                      onClick={() => onUpdateConfig({ overscan: opt.id })}
                      className={segBtn(config.overscan === opt.id)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <span className="block text-xs font-semibold text-[#D6D2C9]">Пропуск кадров</span>
                <div className="flex gap-1.5 p-1 bg-[#121316] rounded-lg">
                  {([0, 1, 2] as FrameSkipMode[]).map((fs) => (
                    <button
                      key={fs}
                      type="button"
                      onClick={() => onUpdateConfig({ frameSkip: fs })}
                      className={segBtn(config.frameSkip === fs)}
                    >
                      {fs === 0 ? '0 (50 FPS)' : fs === 1 ? '1 (25 FPS)' : '2 (17 FPS)'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="divide-y divide-white/8 border-t border-white/10 pt-2">
                <ToggleRow
                  label="Автообрезка рамок (Auto-Crop)"
                  checked={config.autoCrop}
                  onChange={(checked) => onUpdateConfig({ autoCrop: checked })}
                />
                <ToggleRow
                  label="Сканлайны CRT 1084S"
                  checked={config.crtScanlines}
                  onChange={(checked) => onUpdateConfig({ crtScanlines: checked })}
                />
              </div>
            </div>
          )}

          {activeCategory === 'audio' && (
            <div className="space-y-4">
              <div className="space-y-2.5">
                <div className="flex items-baseline justify-between">
                  <label htmlFor="amiga-master-volume" className="text-sm font-medium text-[#F2EFE9]">
                    Громкость
                  </label>
                  <span className="text-xs font-mono tabular-nums text-[#E07A22]">
                    {volumePercent}%
                  </span>
                </div>
                <div className="relative h-8 flex items-center">
                  <div
                    aria-hidden="true"
                    className="w-full h-2.5 rounded-full bg-[#121316] border border-white/12 overflow-hidden"
                  >
                    <div
                      data-testid="volume-fill-bar"
                      className="h-full w-full origin-left bg-gradient-to-r from-[#C8342A] to-[#E07A22]"
                      style={{ transform: `scaleX(${volumeRatio})` }}
                    />
                  </div>
                  <input
                    id="amiga-master-volume"
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={volumePercent}
                    onChange={(e) => onUpdateConfig({ audioVolume: Number(e.target.value) / 100 })}
                    className="amiga-range-input absolute inset-0 w-full h-full cursor-pointer"
                  />
                </div>
              </div>

              <div className="divide-y divide-white/8 border-t border-white/10 pt-2">
                <ToggleRow
                  label="Фильтр Paula LED (4.4 кГц)"
                  checked={config.audioLedFilter}
                  onChange={(checked) => onUpdateConfig({ audioLedFilter: checked })}
                />
                <ToggleRow
                  label="Звук дисковода"
                  checked={config.floppyAudioEnabled}
                  onChange={(checked) => onUpdateConfig({ floppyAudioEnabled: checked })}
                />
              </div>
            </div>
          )}

          {activeCategory === 'performance' && (
            <div className="divide-y divide-white/8">
              <ToggleRow
                label="Джойстик подключен"
                checked={config.joystickConnected}
                onChange={(checked) => onUpdateConfig({ joystickConnected: checked })}
              />
              <ToggleRow
                label="Эко-режим CPU"
                checked={config.ecoCpuMode}
                onChange={(checked) => onUpdateConfig({ ecoCpuMode: checked })}
              />
              <ToggleRow
                label="Виброотдача"
                checked={config.hapticsEnabled}
                onChange={(checked) => onUpdateConfig({ hapticsEnabled: checked })}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

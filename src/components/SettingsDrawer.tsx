import React, { useState } from 'react';
import { Bug, Copy, Download, FileText, Gamepad2, HardDriveDownload, RotateCcw, SlidersHorizontal, X } from 'lucide-react';
import {
  AmigaConfig,
  ChipRamKB,
  ChipsetModel,
  FastRamKB,
  FrameSkipMode,
  ResolvedVideoStandard,
  SlowRamKB,
  VideoStandard,
} from '../emulator/types';
import {
  formatOverscanSetting,
  getMaxOverscanHeight,
  getMinOverscanHeight,
  getOverscanViewport,
  getStdOverscanHeight,
  OVERSCAN_HEIGHT_STEP,
  OVERSCAN_MAX_WIDTH,
  OVERSCAN_MIN_WIDTH,
  OVERSCAN_WIDTH_STEP,
} from '../emulator/hardware/overscan';
import {
  countCalibratedBindings,
  GamepadCalibrationProfile,
} from '../emulator/controls/gamepadCalibration';
import {
  CPU_OVERCLOCK_MAX_MHZ,
  CPU_OVERCLOCK_STEP_MHZ,
  getEffectiveCpuMhz,
  getEffectiveOverclockMultiplier,
  overclockMultiplierFromMhz,
  sanitizeCpuOverclock,
} from '../emulator/hardware/cpuOverclock';

type SettingsCategory = 'system' | 'display' | 'audio' | 'performance' | 'debug';

const BASE_CATEGORIES: ReadonlyArray<{ id: SettingsCategory; label: string }> = [
  { id: 'system', label: 'Система' },
  { id: 'display', label: 'Видео' },
  { id: 'audio', label: 'Звук' },
  { id: 'performance', label: 'CPU и ввод' },
];

const DEBUG_CATEGORY: { id: SettingsCategory; label: string } = {
  id: 'debug',
  label: 'Отладка',
};

interface SettingsDrawerProps {
  open: boolean;
  overlayOnly?: boolean;
  debugUnlocked: boolean;
  config: AmigaConfig;
  activeVideoStandard: ResolvedVideoStandard;
  gamepadCalibration: GamepadCalibrationProfile | null;
  onClose: () => void;
  onUpdateConfig: (patch: Partial<AmigaConfig>) => void;
  onOpenOverscanAdjust: () => void;
  onOpenGamepadCalibration: () => void;
  onResetGamepadCalibration: () => void;
  onDownloadTriageReport: () => void;
  onCopyTriageReport: () => void;
  onDownloadDebugDump: () => void;
  onDownloadLiveSavestate: () => void;
}

interface ToggleRowProps {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  testId?: string;
}

const ToggleRow: React.FC<ToggleRowProps> = ({ label, hint, checked, onChange, testId }) => (
  <label className="flex items-center justify-between gap-3 min-h-[44px] py-2 cursor-pointer select-none">
    <span className="min-w-0">
      <span className="block text-sm font-medium text-[#F2EFE9]">{label}</span>
      {hint && <span className="block text-[11px] leading-snug text-[#9B968D] mt-0.5">{hint}</span>}
    </span>
    <span className="relative inline-flex shrink-0 items-center">
      <input
        type="checkbox"
        data-testid={testId}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer opacity-0"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none inline-flex h-6 w-11 items-center rounded-full bg-[#121316] border border-white/15 transition-colors peer-checked:bg-[#C8342A] peer-checked:border-[#C8342A] peer-focus-visible:ring-2 peer-focus-visible:ring-[#E07A22] after:content-[''] after:block after:h-4 after:w-4 after:translate-x-1 after:rounded-full after:bg-[#F2EFE9] after:transition-transform peer-checked:after:translate-x-6"
      />
    </span>
  </label>
);

export const SettingsDrawer: React.FC<SettingsDrawerProps> = ({
  open,
  overlayOnly = false,
  debugUnlocked,
  config,
  activeVideoStandard,
  gamepadCalibration,
  onClose,
  onUpdateConfig,
  onOpenOverscanAdjust,
  onOpenGamepadCalibration,
  onResetGamepadCalibration,
  onDownloadTriageReport,
  onCopyTriageReport,
  onDownloadDebugDump,
  onDownloadLiveSavestate,
}) => {
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>('system');

  if (!open) return null;

  const categories = debugUnlocked ? [...BASE_CATEGORIES, DEBUG_CATEGORY] : BASE_CATEGORIES;
  const effectiveCategory: SettingsCategory =
    activeCategory === 'debug' && !debugUnlocked ? 'system' : activeCategory;

  const volumeRatio = Math.max(0, Math.min(1, config.audioVolume));
  const volumePercent = Math.round(volumeRatio * 100);

  const overscanViewport = getOverscanViewport(config.overscan, activeVideoStandard);
  const overscanSummary = `${overscanViewport.width}×${overscanViewport.height} px`;
  const minOverscanH = getMinOverscanHeight(activeVideoStandard);
  const stdOverscanH = getStdOverscanHeight(activeVideoStandard);
  const maxOverscanH = getMaxOverscanHeight(activeVideoStandard);
  const overscanWidthRatio =
    (overscanViewport.width - OVERSCAN_MIN_WIDTH) / (OVERSCAN_MAX_WIDTH - OVERSCAN_MIN_WIDTH);
  const overscanHeightSpan = maxOverscanH - minOverscanH;
  const overscanHeightRatio =
    overscanHeightSpan > 0 ? (overscanViewport.height - minOverscanH) / overscanHeightSpan : 0;
  const overscanExtraW = overscanViewport.width - OVERSCAN_MIN_WIDTH;
  const overscanExtraH = overscanViewport.height - stdOverscanH;
  const calibratedCount = countCalibratedBindings(gamepadCalibration);
  const baseFps = activeVideoStandard === 'NTSC' ? 60 : 50;
  const cpuOverclockValue = sanitizeCpuOverclock(config.cpuOverclock, 1);
  const minCpuMhz = getEffectiveCpuMhz(config.chipset, activeVideoStandard, false, 1);
  const effectiveCpuMhz = getEffectiveCpuMhz(
    config.chipset,
    activeVideoStandard,
    config.ecoCpuMode,
    cpuOverclockValue
  );
  const effectiveMultiplier = getEffectiveOverclockMultiplier(
    config.chipset,
    activeVideoStandard,
    config.ecoCpuMode,
    cpuOverclockValue
  );
  const sliderCpuMhz =
    config.ecoCpuMode && cpuOverclockValue <= 1
      ? minCpuMhz
      : Math.max(minCpuMhz, Math.min(CPU_OVERCLOCK_MAX_MHZ, effectiveCpuMhz));
  const cpuOverclockSpan = CPU_OVERCLOCK_MAX_MHZ - minCpuMhz;
  const cpuOverclockRatio =
    cpuOverclockSpan > 0 ? (sliderCpuMhz - minCpuMhz) / cpuOverclockSpan : 0;

  const segBtn = (active: boolean) =>
    `flex-1 h-10 rounded-md text-xs font-semibold transition-colors whitespace-nowrap px-2 ${
      active
        ? 'bg-[#C8342A] text-white'
        : 'bg-[#16181C] text-[#BDB9B0] hover:bg-[#262930]'
    }`;

  return (
    <div
      className={
        overlayOnly
          ? 'fixed inset-0 z-50 flex items-end sm:items-center justify-center lg:items-stretch lg:justify-end bg-black/70 lg:bg-black/45'
          : 'fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 lg:static lg:inset-auto lg:z-auto lg:block lg:bg-transparent lg:w-[400px] xl:w-[430px] lg:h-full lg:shrink-0'
      }
      role="dialog"
      aria-modal={overlayOnly ? 'true' : undefined}
      aria-label="Настройки"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={
          overlayOnly
            ? 'w-full sm:max-w-md max-h-[85dvh] lg:max-w-none lg:w-[420px] lg:max-h-none lg:h-full bg-[#1E2025] border-t sm:border lg:border-t-0 lg:border-r-0 lg:border-b-0 lg:border-l border-white/12 rounded-t-2xl sm:rounded-xl lg:rounded-none lg:rounded-l-xl flex flex-col overflow-hidden shadow-2xl'
            : 'w-full sm:max-w-md max-h-[85dvh] lg:max-w-none lg:w-full lg:max-h-none lg:h-full bg-[#1E2025] border-t sm:border lg:border-t-0 lg:border-r-0 lg:border-b-0 lg:border-l border-white/10 rounded-t-2xl sm:rounded-xl lg:rounded-none flex flex-col overflow-hidden shadow-2xl lg:shadow-none'
        }
      >
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
            className="flex items-center gap-1 p-1 bg-[#121316] rounded-lg overflow-x-auto"
          >
            {categories.map((cat) => {
              const selected = effectiveCategory === cat.id;
              return (
                <button
                  key={cat.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setActiveCategory(cat.id)}
                  className={`flex-1 min-w-fit h-9 px-2 sm:px-2.5 rounded-md text-[11px] sm:text-xs font-semibold whitespace-nowrap transition-colors ${
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
          {effectiveCategory === 'system' && (() => {
            const isA1200 = config.chipset === 'AGA';
            return (
              <div className="space-y-4">
                <div className="space-y-2">
                  <span className="block text-xs font-semibold text-[#D6D2C9]">
                    Модель компьютера
                  </span>
                  <div className="flex gap-1.5 p-1 bg-[#121316] rounded-lg">
                    <button
                      type="button"
                      data-testid="model-a500-btn"
                      onClick={() => {
                        if (isA1200) {
                          onUpdateConfig({
                            chipset: 'ECS',
                            chipRamKB: 1024,
                            slowRamKB: 512,
                            fastRamKB: 0,
                          });
                        }
                      }}
                      className={segBtn(!isA1200)}
                    >
                      Amiga 500
                    </button>
                    <button
                      type="button"
                      data-testid="model-a1200-btn"
                      onClick={() => {
                        if (!isA1200) {
                          onUpdateConfig({
                            chipset: 'AGA',
                            chipRamKB: 2048,
                            slowRamKB: 0,
                          });
                        }
                      }}
                      className={segBtn(isA1200)}
                    >
                      Amiga 1200 (AGA)
                    </button>
                  </div>
                </div>

                {!isA1200 ? (
                  <>
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
                      <span className="block text-xs font-semibold text-[#D6D2C9]">
                        Slow RAM (A501)
                      </span>
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
                  </>
                ) : (
                  <>
                    <div className="px-3 py-2 rounded-lg bg-[#16181C] border border-white/8 flex items-center justify-between gap-2 text-xs">
                      <span className="text-[#BDB9B0]">Видео и CPU</span>
                      <span className="font-mono text-[#E07A22] font-semibold">
                        AGA (Alice/Lisa) · 68EC020
                      </span>
                    </div>

                    <div className="space-y-2">
                      <span className="block text-xs font-semibold text-[#D6D2C9]">Chip RAM</span>
                      <div className="flex gap-1.5 p-1 bg-[#121316] rounded-lg">
                        {([1024, 2048] as ChipRamKB[]).map((kb) => (
                          <button
                            key={kb}
                            type="button"
                            onClick={() => onUpdateConfig({ chipRamKB: kb })}
                            className={segBtn(config.chipRamKB === kb)}
                          >
                            {kb === 1024 ? '1 МБ' : '2 МБ'}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-2">
                      <span className="block text-xs font-semibold text-[#D6D2C9]">
                        Fast RAM (Zorro II)
                      </span>
                      <div className="grid grid-cols-5 gap-1 p-1 bg-[#121316] rounded-lg">
                        {([0, 1024, 2048, 4096, 8192] as FastRamKB[]).map((kb) => (
                          <button
                            key={kb}
                            type="button"
                            onClick={() => onUpdateConfig({ fastRamKB: kb })}
                            className={`h-10 rounded-md text-[11px] font-semibold transition-colors whitespace-nowrap px-1 ${
                              config.fastRamKB === kb
                                ? 'bg-[#C8342A] text-white'
                                : 'bg-[#16181C] text-[#BDB9B0] hover:bg-[#262930]'
                            }`}
                          >
                            {kb === 0 ? 'Выкл' : `${kb / 1024} МБ`}
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            );
          })()}

          {effectiveCategory === 'display' && (
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="block text-xs font-semibold text-[#D6D2C9]">Видеостандарт</span>
                  {config.videoStandard === 'auto' && (
                    <span
                      data-testid="video-standard-active-label"
                      className="text-[11px] font-mono tabular-nums text-[#E07A22]"
                    >
                      Авто ({activeVideoStandard === 'PAL' ? 'PAL 50 Гц' : 'NTSC 60 Гц'})
                    </span>
                  )}
                </div>
                <div className="flex gap-1.5 p-1 bg-[#121316] rounded-lg">
                  {(['auto', 'PAL', 'NTSC'] as VideoStandard[]).map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => onUpdateConfig({ videoStandard: v })}
                      className={segBtn(config.videoStandard === v)}
                    >
                      {v === 'auto' ? 'Авто' : v === 'PAL' ? 'PAL 50 Гц' : 'NTSC 60 Гц'}
                    </button>
                  ))}
                </div>
              </div>

              {/* Mobile / Fullscreen Overlay: open separate non-blocking panel below screen */}
              <div
                className={`${
                  overlayOnly ? 'flex' : 'flex lg:hidden'
                } bg-[#16181C] border border-white/10 rounded-lg p-3 items-center justify-between gap-3`}
              >
                <div className="min-w-0">
                  <span className="block text-xs font-semibold text-[#F2EFE9]">
                    Оверскан (поля экрана)
                  </span>
                  <span
                    data-testid="overscan-resolution-label"
                    className="block text-[11px] font-mono tabular-nums text-[#E07A22] mt-0.5"
                  >
                    {overscanSummary}
                  </span>
                </div>
                <button
                  type="button"
                  data-testid="overscan-adjust-btn"
                  onClick={onOpenOverscanAdjust}
                  className="h-9 px-3 rounded-lg bg-[#C8342A] hover:bg-[#D94035] text-xs font-semibold text-white inline-flex items-center gap-1.5 shrink-0 transition-colors"
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                  Отрегулировать
                </button>
              </div>

              {/* Desktop Inline Side Panel: sliders directly inside Settings (screen stays visible beside) */}
              {!overlayOnly && (
                <div className="hidden lg:block space-y-3 bg-[#16181C] border border-white/10 rounded-lg p-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-xs font-semibold text-[#F2EFE9]">
                      Оверскан (поля экрана)
                    </span>
                    <span
                      data-testid="overscan-desktop-resolution-label"
                      className="text-[11px] font-mono tabular-nums text-[#E07A22]"
                    >
                      {overscanSummary}
                    </span>
                  </div>

                  {/* Width Slider */}
                  <div className="space-y-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <label
                        htmlFor="amiga-overscan-width"
                        className="text-xs font-medium text-[#D6D2C9]"
                      >
                        Ширина
                      </label>
                      <span className="text-xs font-mono tabular-nums text-[#F2EFE9]">
                        {overscanViewport.width} px
                        {overscanExtraW > 0 ? ` (+${overscanExtraW})` : ''}
                      </span>
                    </div>
                    <div className="relative h-7 flex items-center">
                      <div
                        aria-hidden="true"
                        className="w-full h-2.5 rounded-full bg-[#121316] border border-white/12 overflow-hidden"
                      >
                        <div
                          className="h-full w-full origin-left bg-gradient-to-r from-[#C8342A] to-[#E07A22]"
                          style={{ transform: `scaleX(${overscanWidthRatio})` }}
                        />
                      </div>
                      <input
                        id="amiga-overscan-width"
                        data-testid="overscan-width-slider"
                        type="range"
                        min={OVERSCAN_MIN_WIDTH}
                        max={OVERSCAN_MAX_WIDTH}
                        step={OVERSCAN_WIDTH_STEP}
                        value={overscanViewport.width}
                        onChange={(e) =>
                          onUpdateConfig({
                            overscan: formatOverscanSetting(
                              Number(e.target.value),
                              overscanViewport.height,
                              activeVideoStandard
                            ),
                          })
                        }
                        className="amiga-range-input absolute inset-0 w-full h-full cursor-pointer"
                      />
                    </div>
                    <div className="flex items-center justify-between text-[10px] font-mono tabular-nums text-[#8F8B82]">
                      <span>{OVERSCAN_MIN_WIDTH} px</span>
                      <span>{OVERSCAN_MAX_WIDTH} px</span>
                    </div>
                  </div>

                  {/* Height Slider */}
                  <div className="space-y-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <label
                        htmlFor="amiga-overscan-height"
                        className="text-xs font-medium text-[#D6D2C9]"
                      >
                        Высота ({activeVideoStandard})
                      </label>
                      <span className="text-xs font-mono tabular-nums text-[#F2EFE9]">
                        {overscanViewport.height} px
                        {overscanExtraH !== 0
                          ? ` (${overscanExtraH > 0 ? `+${overscanExtraH}` : overscanExtraH})`
                          : ''}
                      </span>
                    </div>
                    <div className="relative h-7 flex items-center">
                      <div
                        aria-hidden="true"
                        className="w-full h-2.5 rounded-full bg-[#121316] border border-white/12 overflow-hidden"
                      >
                        <div
                          className="h-full w-full origin-left bg-gradient-to-r from-[#C8342A] to-[#E07A22]"
                          style={{ transform: `scaleX(${overscanHeightRatio})` }}
                        />
                      </div>
                      <input
                        id="amiga-overscan-height"
                        data-testid="overscan-height-slider"
                        type="range"
                        min={minOverscanH}
                        max={maxOverscanH}
                        step={OVERSCAN_HEIGHT_STEP}
                        value={overscanViewport.height}
                        onChange={(e) =>
                          onUpdateConfig({
                            overscan: formatOverscanSetting(
                              overscanViewport.width,
                              Number(e.target.value),
                              activeVideoStandard
                            ),
                          })
                        }
                        className="amiga-range-input absolute inset-0 w-full h-full cursor-pointer"
                      />
                    </div>
                    <div className="flex items-center justify-between text-[10px] font-mono tabular-nums text-[#8F8B82]">
                      <span>{minOverscanH} px</span>
                      <span>{maxOverscanH} px</span>
                    </div>
                  </div>
                </div>
              )}

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
                      {fs === 0
                        ? `0 (${baseFps} FPS)`
                        : fs === 1
                          ? `1 (${Math.round(baseFps / 2)} FPS)`
                          : `2 (${Math.round(baseFps / 3)} FPS)`}
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

          {effectiveCategory === 'audio' && (
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

          {effectiveCategory === 'performance' && (
            <div className="space-y-4">
              <div className="space-y-2.5">
                <div className="flex items-baseline justify-between gap-2">
                  <label
                    htmlFor="amiga-cpu-overclock"
                    className="block text-sm font-medium text-[#F2EFE9]"
                  >
                    Разгон CPU
                  </label>
                  <span
                    data-testid="cpu-overclock-mhz-label"
                    className="text-xs font-mono tabular-nums text-[#E07A22]"
                  >
                    {effectiveCpuMhz.toFixed(1)} МГц (
                    {config.ecoCpuMode && cpuOverclockValue <= 1
                      ? 'Эко'
                      : `${effectiveMultiplier.toFixed(1)}×`}
                    )
                  </span>
                </div>
                <div className="relative h-8 flex items-center">
                  <div
                    aria-hidden="true"
                    className="w-full h-2.5 rounded-full bg-[#121316] border border-white/12 overflow-hidden"
                  >
                    <div
                      data-testid="cpu-overclock-fill-bar"
                      className="h-full w-full origin-left bg-gradient-to-r from-[#C8342A] to-[#E07A22]"
                      style={{ transform: `scaleX(${cpuOverclockRatio})` }}
                    />
                  </div>
                  <input
                    id="amiga-cpu-overclock"
                    data-testid="cpu-overclock-slider"
                    type="range"
                    min={minCpuMhz}
                    max={CPU_OVERCLOCK_MAX_MHZ}
                    step={CPU_OVERCLOCK_STEP_MHZ}
                    value={sliderCpuMhz}
                    onChange={(e) => {
                      const nextMult = overclockMultiplierFromMhz(
                        config.chipset,
                        activeVideoStandard,
                        Number(e.target.value)
                      );
                      onUpdateConfig(
                        nextMult > 1
                          ? { cpuOverclock: nextMult, ecoCpuMode: false }
                          : { cpuOverclock: 1 }
                      );
                    }}
                    className="amiga-range-input absolute inset-0 w-full h-full cursor-pointer"
                  />
                </div>
              </div>

              <div className="divide-y divide-white/8 border-t border-white/10 pt-2">
                <ToggleRow
                  label="Джойстик подключен"
                  checked={config.joystickConnected}
                  onChange={(checked) => onUpdateConfig({ joystickConnected: checked })}
                />
                <ToggleRow
                  label="Эко-режим CPU"
                  checked={config.ecoCpuMode}
                  onChange={(checked) =>
                    onUpdateConfig(
                      checked ? { ecoCpuMode: true, cpuOverclock: 1 } : { ecoCpuMode: false }
                    )
                  }
                />
                <ToggleRow
                  label="Виброотдача"
                  checked={config.hapticsEnabled}
                  onChange={(checked) => onUpdateConfig({ hapticsEnabled: checked })}
                />
                <ToggleRow
                  label="Производительность эмуляции"
                  checked={config.showEmuPerf}
                  onChange={(checked) => onUpdateConfig({ showEmuPerf: checked })}
                  testId="toggle-emu-perf"
                />
              </div>

              <div className="bg-[#16181C] border border-white/10 rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="block text-xs font-semibold text-[#F2EFE9]">
                      Физический геймпад
                    </span>
                    <span
                      data-testid="gamepad-calibration-status"
                      className="block text-[11px] text-[#9B968D] truncate mt-0.5"
                    >
                      {gamepadCalibration
                        ? `Откалиброван (${calibratedCount} кнопок) · ${gamepadCalibration.padId}`
                        : 'Стандартная схема (W3C)'}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    data-testid="gamepad-calibration-btn"
                    onClick={onOpenGamepadCalibration}
                    className="flex-1 h-9 px-3 rounded-lg bg-[#2A2D33] hover:bg-[#353941] border border-white/10 text-xs font-semibold text-[#F2EFE9] inline-flex items-center justify-center gap-1.5 transition-colors"
                  >
                    <Gamepad2 className="w-4 h-4 text-[#E07A22]" />
                    Калибровка геймпада
                  </button>
                  {gamepadCalibration && (
                    <button
                      type="button"
                      data-testid="gamepad-calibration-clear-btn"
                      onClick={onResetGamepadCalibration}
                      aria-label="Сбросить калибровку геймпада"
                      title="Сбросить на стандартную схему"
                      className="h-9 px-2.5 rounded-lg bg-[#2A2D33] hover:bg-[#462626] text-xs font-medium text-[#D8D4CC] hover:text-[#FF9E98] inline-flex items-center gap-1 shrink-0 transition-colors"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Сброс
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {effectiveCategory === 'debug' && debugUnlocked && (
            <div className="space-y-2.5" data-testid="settings-debug-panel">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid="download-triage-btn"
                  onClick={onDownloadTriageReport}
                  aria-label="Скачать компактный triage-лог (.txt)"
                  title="Лёгкий текстовый лог (~3 КБ): дизассемблер 68k, вердикт зависания и события без Base64"
                  className="flex-1 min-w-0 h-10 px-2.5 sm:px-3 rounded-lg bg-[#252A33] hover:bg-[#2F3540] border border-[#E07A22]/35 text-[11px] sm:text-xs font-semibold text-[#F2EFE9] flex items-center justify-between gap-1.5 transition-colors"
                >
                  <span className="inline-flex items-center gap-1.5 min-w-0 truncate">
                    <FileText className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-[#E07A22] shrink-0" />
                    <span className="truncate">Triage-лог</span>
                  </span>
                  <span className="inline-flex items-center gap-1 text-[10px] font-mono text-[#E07A22] shrink-0">
                    <Download className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                    .txt
                  </span>
                </button>
                <button
                  type="button"
                  data-testid="copy-triage-btn"
                  onClick={onCopyTriageReport}
                  aria-label="Скопировать triage-лог в буфер обмена"
                  title="Скопировать компактный triage-лог для вставки в чат"
                  className="h-10 px-2.5 sm:px-3 rounded-lg bg-[#23262D] hover:bg-[#2C3039] border border-white/10 text-[11px] sm:text-xs font-semibold text-[#E6E2D9] inline-flex items-center gap-1.5 shrink-0 transition-colors"
                >
                  <Copy className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-[#8BC49A] shrink-0" />
                  <span>Копировать</span>
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  data-testid="download-debug-dump-btn"
                  onClick={onDownloadDebugDump}
                  aria-label="Скачать дамп отладки (память и код CPU)"
                  className="h-10 px-2 sm:px-3 rounded-lg bg-[#23262D] hover:bg-[#2C3039] border border-white/10 text-[11px] sm:text-xs font-semibold text-[#E6E2D9] flex items-center justify-between gap-1 transition-colors"
                >
                  <span className="inline-flex items-center gap-1 min-w-0">
                    <Bug className="w-3.5 h-3.5 text-[#E07A22] shrink-0" />
                    <span className="whitespace-nowrap">Дамп отладки</span>
                  </span>
                  <span className="inline-flex items-center gap-0.5 text-[10px] font-mono text-[#8BC49A] shrink-0">
                    <Download className="w-3 h-3" />
                    .json
                  </span>
                </button>
                <button
                  type="button"
                  data-testid="download-live-savestate-btn"
                  onClick={onDownloadLiveSavestate}
                  aria-label="Скачать текущий сейвстейт для диагностики"
                  title="Скачать полный сейвстейт (.json) с дампом CPU, памяти и дискет"
                  className="h-10 px-2 sm:px-3 rounded-lg bg-[#23262D] hover:bg-[#2C3039] border border-white/10 text-[11px] sm:text-xs font-semibold text-[#E6E2D9] flex items-center justify-between gap-1 transition-colors"
                >
                  <span className="inline-flex items-center gap-1 min-w-0">
                    <HardDriveDownload className="w-3.5 h-3.5 text-[#8BC49A] shrink-0" />
                    <span className="whitespace-nowrap">Сейвстейт</span>
                  </span>
                  <span className="inline-flex items-center gap-0.5 text-[10px] font-mono text-[#8BC49A] shrink-0">
                    <Download className="w-3 h-3" />
                    .json
                  </span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

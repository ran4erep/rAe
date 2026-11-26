import React from 'react';
import { Check, SlidersHorizontal } from 'lucide-react';
import { AmigaConfig, ResolvedVideoStandard } from '../emulator/types';
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

interface OverscanAdjustPanelProps {
  config: AmigaConfig;
  activeVideoStandard: ResolvedVideoStandard;
  fullscreen?: boolean;
  onUpdateConfig: (patch: Partial<AmigaConfig>) => void;
  onDone: () => void;
}

export const OverscanAdjustPanel: React.FC<OverscanAdjustPanelProps> = ({
  config,
  activeVideoStandard,
  fullscreen = false,
  onUpdateConfig,
  onDone,
}) => {
  const viewport = getOverscanViewport(config.overscan, activeVideoStandard);
  const minH = getMinOverscanHeight(activeVideoStandard);
  const stdH = getStdOverscanHeight(activeVideoStandard);
  const maxH = getMaxOverscanHeight(activeVideoStandard);

  const widthRatio =
    (viewport.width - OVERSCAN_MIN_WIDTH) / (OVERSCAN_MAX_WIDTH - OVERSCAN_MIN_WIDTH);
  const heightSpan = maxH - minH;
  const heightRatio = heightSpan > 0 ? (viewport.height - minH) / heightSpan : 0;

  const extraW = viewport.width - OVERSCAN_MIN_WIDTH;
  const extraH = viewport.height - stdH;

  return (
    <section
      data-testid="overscan-adjust-panel"
      aria-label="Регулировка оверскана (полей экрана)"
      className={
        fullscreen
          ? 'bg-[#191B20]/94 border border-white/15 rounded-xl px-3.5 py-2.5 shadow-2xl backdrop-blur-sm'
          : 'w-full h-full lg:h-auto bg-[#1B1D22] border-t border-white/12 px-3 sm:px-4 lg:px-6 pt-3 sm:pt-4 lg:py-3 pb-3 flex flex-col justify-start overflow-y-auto'
      }
    >
      <div className="max-w-[780px] w-full mx-auto space-y-2.5">
        {/* Header + Done */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <SlidersHorizontal className="w-4 h-4 text-[#E07A22] shrink-0" />
            <h3 className="text-xs sm:text-sm font-bold text-[#F2EFE9] truncate">
              Поля экрана (Оверскан)
            </h3>
            <span
              data-testid="overscan-panel-resolution"
              className="text-[11px] font-mono tabular-nums text-[#E07A22] bg-[#121316] border border-white/10 rounded px-1.5 py-0.5 shrink-0"
            >
              {viewport.width}×{viewport.height}
            </span>
          </div>

          <button
            type="button"
            data-testid="overscan-adjust-done-btn"
            onClick={onDone}
            className="h-7 px-3 rounded bg-[#C8342A] hover:bg-[#D94035] text-[11px] font-semibold text-white inline-flex items-center gap-1 shrink-0"
          >
            <Check className="w-3.5 h-3.5" />
            Готово
          </button>
        </div>

        {/* Sliders Side-by-Side on Desktop/Landscape, Stacked on Narrow Phones */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-2">
          {/* Width Slider */}
          <div className="space-y-0.5">
            <div className="flex items-baseline justify-between gap-2">
              <label
                htmlFor="overscan-live-width"
                className="text-[11px] font-medium text-[#BDB9B0]"
              >
                Ширина
              </label>
              <span
                data-testid="overscan-live-width-value"
                className="text-xs font-mono tabular-nums text-[#F2EFE9]"
              >
                {viewport.width} px{extraW > 0 ? ` (+${extraW})` : ''}
              </span>
            </div>
            <div className="relative h-7 flex items-center">
              <div
                aria-hidden="true"
                className="w-full h-2.5 rounded-full bg-[#121316] border border-white/12 overflow-hidden"
              >
                <div
                  className="h-full w-full origin-left bg-gradient-to-r from-[#C8342A] to-[#E07A22]"
                  style={{ transform: `scaleX(${widthRatio})` }}
                />
              </div>
              <input
                id="overscan-live-width"
                data-testid="overscan-live-width-slider"
                type="range"
                min={OVERSCAN_MIN_WIDTH}
                max={OVERSCAN_MAX_WIDTH}
                step={OVERSCAN_WIDTH_STEP}
                value={viewport.width}
                onChange={(e) =>
                  onUpdateConfig({
                    overscan: formatOverscanSetting(
                      Number(e.target.value),
                      viewport.height,
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
          <div className="space-y-0.5">
            <div className="flex items-baseline justify-between gap-2">
              <label
                htmlFor="overscan-live-height"
                className="text-[11px] font-medium text-[#BDB9B0]"
              >
                Высота ({activeVideoStandard})
              </label>
              <span
                data-testid="overscan-live-height-value"
                className="text-xs font-mono tabular-nums text-[#F2EFE9]"
              >
                {viewport.height} px
                {extraH !== 0 ? ` (${extraH > 0 ? `+${extraH}` : extraH})` : ''}
              </span>
            </div>
            <div className="relative h-7 flex items-center">
              <div
                aria-hidden="true"
                className="w-full h-2.5 rounded-full bg-[#121316] border border-white/12 overflow-hidden"
              >
                <div
                  className="h-full w-full origin-left bg-gradient-to-r from-[#C8342A] to-[#E07A22]"
                  style={{ transform: `scaleX(${heightRatio})` }}
                />
              </div>
              <input
                id="overscan-live-height"
                data-testid="overscan-live-height-slider"
                type="range"
                min={minH}
                max={maxH}
                step={OVERSCAN_HEIGHT_STEP}
                value={viewport.height}
                onChange={(e) =>
                  onUpdateConfig({
                    overscan: formatOverscanSetting(
                      viewport.width,
                      Number(e.target.value),
                      activeVideoStandard
                    ),
                  })
                }
                className="amiga-range-input absolute inset-0 w-full h-full cursor-pointer"
              />
            </div>
            <div className="flex items-center justify-between text-[10px] font-mono tabular-nums text-[#8F8B82]">
              <span>{minH} px</span>
              <span>{maxH} px</span>
            </div>
          </div>
        </div>

        {config.autoCrop && (
          <div className="flex items-center justify-between gap-2 text-[11px] text-[#E07A22] bg-[#121316]/80 border border-[#E07A22]/25 rounded-md px-2.5 py-1">
            <span className="truncate">
              Включён Auto-Crop: экран автоматически обрезает тёмные края.
            </span>
            <button
              type="button"
              onClick={() => onUpdateConfig({ autoCrop: false })}
              className="shrink-0 font-semibold underline hover:text-[#F2EFE9]"
            >
              Отключить Auto-Crop
            </button>
          </div>
        )}
      </div>
    </section>
  );
};

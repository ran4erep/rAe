import React, { useState } from 'react';
import {
  Check,
  EyeOff,
  Gamepad2,
  Hash,
  Keyboard,
  LayoutGrid,
  Maximize2,
  Minimize2,
  MousePointer,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  SlidersHorizontal,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { AmigaStatusSnapshot } from '../emulator/types';
import { FloppyDiskIcon } from './FloppyDiskIcon';

export type FullscreenOverlayMode = 'qwerty' | 'numpad' | 'mouse' | 'gamepad' | 'custom' | 'hidden';

interface HardwareTopBarProps {
  status: AmigaStatusSnapshot;
  audioEnabled: boolean;
  isFullscreen: boolean;
  fullscreenOverlayMode: FullscreenOverlayMode;
  joystickConnected?: boolean;
  customEditMode?: boolean;
  onToggleCustomEditMode?: () => void;
  onChangeFullscreenOverlayMode: (mode: FullscreenOverlayMode) => void;
  onToggleFullscreen: () => void;
  onTogglePause: () => void;
  onToggleAudio: () => void;
  onWarmReset: () => void;
  onOpenDisks: () => void;
  onOpenSettings: () => void;
}

export const HardwareTopBar: React.FC<HardwareTopBarProps> = React.memo(
  ({
    status,
    audioEnabled,
    isFullscreen,
    fullscreenOverlayMode,
    joystickConnected = true,
    customEditMode = false,
    onToggleCustomEditMode,
    onChangeFullscreenOverlayMode,
    onToggleFullscreen,
    onTogglePause,
    onToggleAudio,
    onWarmReset,
    onOpenDisks,
    onOpenSettings,
  }) => {
    const [overlayMenuOpen, setOverlayMenuOpen] = useState(false);

    const renderFloppyLedClass = (drive: AmigaStatusSnapshot['df0']) =>
      drive.activeIo
        ? drive.stepPhase
          ? 'bg-[#FFE066] shadow-[0_0_9px_rgba(255,224,102,0.95)]'
          : 'bg-[#FF8C1A] shadow-[0_0_7px_rgba(255,140,26,0.9)]'
        : drive.motorOn
          ? 'bg-[#C96B16] shadow-[0_0_4px_rgba(201,107,22,0.5)]'
          : drive.inserted
            ? 'bg-[#6D4E26]'
            : 'bg-[#36373C]';

    const renderHdfLedClass = (dh0: AmigaStatusSnapshot['dh0']) =>
      dh0.activeIo
        ? 'bg-[#FFE066] shadow-[0_0_8px_rgba(255,224,102,0.95)]'
        : dh0.mounted
          ? 'bg-[#43A068] shadow-[0_0_4px_rgba(67,160,104,0.45)]'
          : 'bg-[#36373C]';

    const OverlayModeIcon =
      fullscreenOverlayMode === 'gamepad'
        ? Gamepad2
        : fullscreenOverlayMode === 'custom'
          ? LayoutGrid
          : fullscreenOverlayMode === 'qwerty'
            ? Keyboard
            : fullscreenOverlayMode === 'numpad'
              ? Hash
              : fullscreenOverlayMode === 'mouse'
                ? MousePointer
                : EyeOff;

    if (isFullscreen) {
      const overlayChoices: Array<{ id: FullscreenOverlayMode; label: string; Icon: React.FC<{ className?: string }> }> = [
        ...(joystickConnected ? [{ id: 'gamepad' as const, label: 'Джойстик', Icon: Gamepad2 }] : []),
        { id: 'custom', label: 'Своё управление', Icon: LayoutGrid },
        { id: 'qwerty', label: 'QWERTY', Icon: Keyboard },
        { id: 'numpad', label: 'Numpad', Icon: Hash },
        { id: 'mouse', label: 'Мышь', Icon: MousePointer },
        { id: 'hidden', label: 'Скрыть управление', Icon: EyeOff },
      ];

      return (
        <aside
          className="relative w-11 shrink-0 h-full bg-[#1C1E22]/92 border-r border-white/12 py-2 px-1 flex flex-col items-center justify-between gap-2 z-30 select-none"
          aria-label="Вертикальная панель управления"
        >
          {/* Compact Top Brand Strip + PWR & Vertical DF0/DF1 LEDs */}
          <div className="flex flex-col items-center gap-1.5" aria-label="Индикаторы оборудования">
            <span className="w-5 h-1 bg-[#D63329] rounded-[1px]" aria-hidden="true" />
            <span
              title="Power / Audio Filter LED"
              className={`w-2.5 h-1.5 rounded-[1px] transition-colors duration-150 ${
                status.powerLed
                  ? 'bg-[#E33E33] shadow-[0_0_5px_rgba(227,62,51,0.7)]'
                  : 'bg-[#5A2420]'
              }`}
            />
            <div
              className="grid grid-cols-2 gap-x-0.5 gap-y-[3px]"
              aria-label="Индикаторы дискет DF0/DF1 (слева) и дисков DH0/DH1 (справа)"
            >
              <span
                data-testid="led-df0"
                title="DF0 Floppy Drive LED"
                className={`w-2.5 h-1.5 rounded-[1.5px] transition-colors duration-75 ${renderFloppyLedClass(status.df0)}`}
              />
              <span
                data-testid="led-dh0"
                title={status.dh0.mounted ? `DH0 Система: ${status.dh0.name}` : 'DH0 Система (извлечён)'}
                className={`w-2.5 h-1.5 rounded-[1.5px] transition-colors duration-75 ${renderHdfLedClass(status.dh0)}`}
              />
              <span
                data-testid="led-df1"
                title="DF1 Floppy Drive LED"
                className={`w-2.5 h-1.5 rounded-[1.5px] transition-colors duration-75 ${renderFloppyLedClass(status.df1)}`}
              />
              <span
                data-testid="led-dh1"
                title={status.dh1.mounted ? `DH1 HDF: ${status.dh1.name}` : 'DH1 Hardfile LED (не подключён)'}
                className={`w-2.5 h-1.5 rounded-[1.5px] transition-colors duration-75 ${renderHdfLedClass(status.dh1)}`}
              />
            </div>
          </div>

          {/* Vertical Icon-Only Action Buttons */}
          <div className="flex flex-col items-center gap-1.5">
            <div className="relative">
              <button
                type="button"
                onClick={() => setOverlayMenuOpen((v) => !v)}
                aria-label="Выбрать сенсорное управление поверх экрана"
                title="Сенсорное управление"
                className={`h-7 w-7 flex items-center justify-center rounded-md active:scale-[0.95] transition-colors ${
                  fullscreenOverlayMode === 'hidden'
                    ? 'bg-[#2A2D33] text-[#9B968D]'
                    : 'bg-[#353941] text-[#F2EFE9] ring-1 ring-white/20'
                }`}
              >
                <OverlayModeIcon className="w-3.5 h-3.5" />
              </button>

              {overlayMenuOpen && (
                <div
                  className="absolute left-9 top-0 bg-[#1C1E22]/95 border border-white/15 rounded-lg p-1 flex items-center gap-1 shadow-xl z-40"
                  role="menu"
                  aria-label="Режим управления в полноэкранном режиме"
                >
                  {overlayChoices.map(({ id, label, Icon }) => (
                    <button
                      key={id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={fullscreenOverlayMode === id}
                      aria-label={label}
                      title={label}
                      onClick={() => {
                        onChangeFullscreenOverlayMode(id);
                        setOverlayMenuOpen(false);
                      }}
                      className={`h-8 w-8 rounded-md flex items-center justify-center transition-colors ${
                        fullscreenOverlayMode === id
                          ? 'bg-[#C8342A] text-white'
                          : 'bg-[#2A2D33] text-[#D8D4CC] hover:bg-[#353941]'
                      }`}
                    >
                      <Icon className="w-4 h-4" />
                    </button>
                  ))}
                </div>
              )}
            </div>

            {fullscreenOverlayMode === 'custom' && onToggleCustomEditMode && (
              <button
                type="button"
                onClick={() => {
                  setOverlayMenuOpen(false);
                  onToggleCustomEditMode();
                }}
                aria-label={customEditMode ? 'Завершить настройку управления' : 'Настроить кастомное управление'}
                title={customEditMode ? 'Готово' : 'Настроить кнопки и стик'}
                className={`h-7 w-7 flex items-center justify-center rounded-md active:scale-[0.95] transition-colors ${
                  customEditMode
                    ? 'bg-[#E07A22] text-[#141518]'
                    : 'bg-[#2A2D33] hover:bg-[#353941] text-[#E07A22]'
                }`}
              >
                {customEditMode ? <Check className="w-3.5 h-3.5" /> : <Pencil className="w-3.5 h-3.5" />}
              </button>
            )}

            <button
              type="button"
              onClick={onToggleAudio}
              aria-label={audioEnabled ? 'Выключить звук Paula' : 'Включить звук Paula'}
              title={audioEnabled ? 'Звук включён' : 'Звук выключен'}
              className="h-7 w-7 flex items-center justify-center rounded-md bg-[#2A2D33] hover:bg-[#353941] active:scale-[0.95] text-[#E6E2D9] transition-colors"
            >
              {audioEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5 text-[#9B968D]" />}
            </button>

            <button
              type="button"
              onClick={onTogglePause}
              aria-label={status.paused ? 'Продолжить эмуляцию' : 'Пауза эмуляции'}
              title={status.paused ? 'Продолжить' : 'Пауза'}
              className="h-7 w-7 flex items-center justify-center rounded-md bg-[#2A2D33] hover:bg-[#353941] active:scale-[0.95] text-[#E6E2D9] transition-colors"
            >
              {status.paused ? <Play className="w-3.5 h-3.5 text-[#E07A22]" /> : <Pause className="w-3.5 h-3.5" />}
            </button>

            <button
              type="button"
              onClick={onWarmReset}
              aria-label="Сброс Amiga (Ctrl+A+A)"
              title="Сброс Amiga"
              className="h-7 w-7 flex items-center justify-center rounded-md bg-[#2A2D33] hover:bg-[#353941] active:scale-[0.95] text-[#E6E2D9] transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>

            <button
              type="button"
              onClick={onOpenSettings}
              aria-label="Настройки чипсета и экрана"
              title="Настройки"
              className="h-7 w-7 flex items-center justify-center rounded-md bg-[#2A2D33] hover:bg-[#353941] active:scale-[0.95] text-[#E6E2D9] transition-colors"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
            </button>

            <button
              type="button"
              onClick={onOpenDisks}
              aria-label="Дискеты, HDF, архивы и Kickstart ROM"
              title="Диски, HDF, архивы и ROM"
              className="h-7 w-7 flex items-center justify-center rounded-md bg-[#C8342A] hover:bg-[#D94035] active:scale-[0.95] text-white transition-colors"
            >
              <FloppyDiskIcon className="w-3.5 h-3.5" />
            </button>

            <button
              type="button"
              onClick={() => {
                setOverlayMenuOpen(false);
                onToggleFullscreen();
              }}
              aria-label="Выйти из полноэкранного режима"
              title="Выйти из полноэкранного режима"
              className="h-7 w-7 flex items-center justify-center rounded-md bg-[#2A2D33] hover:bg-[#353941] active:scale-[0.95] text-[#E6E2D9] transition-colors"
            >
              <Minimize2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </aside>
      );
    }

    return (
      <header className="h-11 shrink-0 bg-[#1C1E22] border-b border-white/10 px-2.5 lg:px-5 flex items-center justify-between gap-2 select-none">
        {/* Zone 1: Commodore Amiga 500 wordmark + real hardware LEDs */}
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-2 shrink-0">
            <span
              className="w-1.5 h-5 bg-[#D63329] rounded-[1px]"
              aria-hidden="true"
            />
            <span className="font-display font-bold tracking-wider text-sm lg:text-base text-[#F2EFE9] whitespace-nowrap">
              AMIGA 500
            </span>
          </div>

          {/* Authentic hardware LEDs wired directly to CIA-A LED & DF0/DF1 motors */}
          <div
            className="flex items-center gap-2 sm:gap-3 text-[10px] sm:text-[11px] font-mono tabular-nums text-[#A7A39A]"
            aria-label="Индикаторы оборудования"
          >
            <span className="flex items-center gap-1 whitespace-nowrap" title="Power / Audio Filter LED">
              <span
                className={`w-2 h-1.5 rounded-[1px] transition-colors duration-150 ${
                  status.powerLed
                    ? 'bg-[#E33E33] shadow-[0_0_5px_rgba(227,62,51,0.7)]'
                    : 'bg-[#5A2420]'
                }`}
              />
              <span className="hidden xs:inline sm:inline">PWR</span>
            </span>
            <div
              className="flex items-center gap-1 sm:gap-1.5"
              aria-label="Индикаторы дискет DF0/DF1 (слева) и дисков DH0/DH1 (справа)"
            >
              {/* Левый столбец: дискеты DF0 и DF1 */}
              <div className="flex flex-col justify-center gap-[3px]">
                <span
                  className="flex items-center gap-1 whitespace-nowrap leading-none"
                  title="DF0 Floppy Drive LED"
                >
                  <span
                    data-testid="led-df0"
                    className={`w-2.5 h-[5px] rounded-[1.5px] transition-colors duration-75 ${renderFloppyLedClass(status.df0)}`}
                  />
                  <span className="hidden sm:inline text-[8.5px] leading-none">
                    DF0:{String(status.df0.track).padStart(2, '0')}
                  </span>
                </span>

                <span
                  className="flex items-center gap-1 whitespace-nowrap leading-none"
                  title="DF1 Floppy Drive LED"
                >
                  <span
                    data-testid="led-df1"
                    className={`w-2.5 h-[5px] rounded-[1.5px] transition-colors duration-75 ${renderFloppyLedClass(status.df1)}`}
                  />
                  <span className="hidden sm:inline text-[8.5px] leading-none">
                    DF1:{String(status.df1.track).padStart(2, '0')}
                  </span>
                </span>
              </div>

              {/* Правый столбец: жёсткие диски DH0 и DH1 */}
              <div className="flex flex-col justify-center gap-[3px]">
                <span
                  className="flex items-center gap-1 whitespace-nowrap leading-none"
                  title={status.dh0.mounted ? `DH0 Система: ${status.dh0.name}` : 'DH0 Система (извлечён)'}
                >
                  <span
                    data-testid="led-dh0"
                    className={`w-2.5 h-[5px] rounded-[1.5px] transition-colors duration-75 ${renderHdfLedClass(status.dh0)}`}
                  />
                  <span className="hidden sm:inline text-[8.5px] leading-none">DH0</span>
                </span>

                <span
                  className="flex items-center gap-1 whitespace-nowrap leading-none"
                  title={status.dh1.mounted ? `DH1 HDF: ${status.dh1.name}` : 'DH1 Hardfile (не подключён)'}
                >
                  <span
                    data-testid="led-dh1"
                    className={`w-2.5 h-[5px] rounded-[1.5px] transition-colors duration-75 ${renderHdfLedClass(status.dh1)}`}
                  />
                  <span className="hidden sm:inline text-[8.5px] leading-none">DH1</span>
                </span>
              </div>
            </div>
            <span className="hidden md:inline text-[#8D8980] whitespace-nowrap">
              {status.chipset} · {status.videoStandard} · {status.fps} FPS
            </span>
          </div>
        </div>

        {/* Zone 2 & 3: Icon-only hardware action buttons */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={onToggleAudio}
            aria-label={audioEnabled ? 'Выключить звук Paula' : 'Включить звук Paula'}
            title={audioEnabled ? 'Звук включён' : 'Звук выключен'}
            className="h-8 w-8 flex items-center justify-center rounded-md bg-[#2A2D33] hover:bg-[#353941] active:scale-[0.97] text-[#E6E2D9] transition-colors"
          >
            {audioEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4 text-[#9B968D]" />}
          </button>

          <button
            type="button"
            onClick={onTogglePause}
            aria-label={status.paused ? 'Продолжить эмуляцию' : 'Пауза эмуляции'}
            title={status.paused ? 'Продолжить' : 'Пауза'}
            className="h-8 w-8 flex items-center justify-center rounded-md bg-[#2A2D33] hover:bg-[#353941] active:scale-[0.97] text-[#E6E2D9] transition-colors"
          >
            {status.paused ? <Play className="w-4 h-4 text-[#E07A22]" /> : <Pause className="w-4 h-4" />}
          </button>

          <button
            type="button"
            onClick={onWarmReset}
            aria-label="Сброс Amiga (Ctrl+A+A)"
            title="Сброс Amiga"
            className="h-8 w-8 flex items-center justify-center rounded-md bg-[#2A2D33] hover:bg-[#353941] active:scale-[0.97] text-[#E6E2D9] transition-colors"
          >
            <RotateCcw className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={onOpenSettings}
            aria-label="Настройки чипсета и экрана"
            title="Настройки чипсета и экрана"
            className="h-8 w-8 flex items-center justify-center rounded-md bg-[#2A2D33] hover:bg-[#353941] active:scale-[0.97] text-[#E6E2D9] transition-colors"
          >
            <SlidersHorizontal className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={onOpenDisks}
            aria-label="Дискеты, HDF, архивы и Kickstart ROM"
            title="Диски ADF/ADZ/LHA/HDF и ROM"
            className="h-8 w-8 flex items-center justify-center rounded-md bg-[#C8342A] hover:bg-[#D94035] active:scale-[0.97] text-white transition-colors"
          >
            <FloppyDiskIcon className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={onToggleFullscreen}
            aria-label="Полноэкранный режим"
            title="Полноэкранный режим"
            className="h-8 w-8 flex items-center justify-center rounded-md bg-[#2A2D33] hover:bg-[#353941] active:scale-[0.97] text-[#E6E2D9] transition-colors"
          >
            <Maximize2 className="w-4 h-4" />
          </button>
        </div>
      </header>
    );
  }
);

HardwareTopBar.displayName = 'HardwareTopBar';

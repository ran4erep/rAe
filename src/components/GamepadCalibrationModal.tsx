import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronLeft,
  Gamepad2,
  RotateCcw,
  SkipForward,
  X,
} from 'lucide-react';
import {
  captureGamepadBaseline,
  detectGamepadCalibrationInput,
  formatGamepadInputSource,
  GAMEPAD_CALIBRATION_STEPS,
  GamepadActionId,
  GamepadBaseline,
  GamepadCalibrationBindings,
  GamepadCalibrationProfile,
  GamepadInputSource,
  isGamepadAtRest,
} from '../emulator/controls/gamepadCalibration';
import { GamepadLike } from '../emulator/controls/physicalGamepad';

interface GamepadCalibrationModalProps {
  open: boolean;
  overlayOnly?: boolean;
  existingCalibration: GamepadCalibrationProfile | null;
  onSave: (profile: GamepadCalibrationProfile) => void;
  onResetToDefault: () => void;
  onClose: () => void;
}

function findActiveGamepad(): { pad: GamepadLike; id: string } | null {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') {
    return null;
  }
  const pads = navigator.getGamepads();
  for (let i = 0; i < pads.length; i++) {
    const p = pads[i];
    if (p && p.connected !== false) {
      return { pad: p, id: p.id || `Геймпад #${i + 1}` };
    }
  }
  return null;
}

export const GamepadCalibrationModal: React.FC<GamepadCalibrationModalProps> = ({
  open,
  overlayOnly = false,
  existingCalibration,
  onSave,
  onResetToDefault,
  onClose,
}) => {
  const [padId, setPadId] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [bindings, setBindings] = useState<GamepadCalibrationBindings>({});
  const [waitingRelease, setWaitingRelease] = useState(false);
  const [lastCapturedText, setLastCapturedText] = useState<string | null>(null);
  const [singleRebindMode, setSingleRebindMode] = useState(false);

  const baselineRef = useRef<GamepadBaseline | null>(null);
  const waitingReleaseRef = useRef(false);
  const stepIndexRef = useRef(0);
  const singleRebindRef = useRef(false);
  const advanceTimerRef = useRef<number | null>(null);

  stepIndexRef.current = stepIndex;
  singleRebindRef.current = singleRebindMode;

  const resetWizardState = useCallback(() => {
    if (advanceTimerRef.current !== null) {
      window.clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
    }
    const found = findActiveGamepad();
    setPadId(found?.id ?? null);
    setStepIndex(0);
    setBindings(existingCalibration ? { ...existingCalibration.bindings } : {});
    setLastCapturedText(null);
    setSingleRebindMode(false);
    if (found) {
      baselineRef.current = captureGamepadBaseline(found.pad);
      const atRest = isGamepadAtRest(found.pad, baselineRef.current);
      waitingReleaseRef.current = !atRest;
      setWaitingRelease(!atRest);
    } else {
      baselineRef.current = null;
      waitingReleaseRef.current = false;
      setWaitingRelease(false);
    }
  }, [existingCalibration]);

  useEffect(() => {
    if (!open) {
      if (advanceTimerRef.current !== null) {
        window.clearTimeout(advanceTimerRef.current);
        advanceTimerRef.current = null;
      }
      return;
    }
    resetWizardState();
  }, [open, resetWizardState]);

  useEffect(() => {
    if (!open) return;

    let disposed = false;
    let rafId = 0;

    const handlePadChange = () => {
      const found = findActiveGamepad();
      setPadId(found?.id ?? null);
      if (found && !baselineRef.current) {
        baselineRef.current = captureGamepadBaseline(found.pad);
      } else if (!found) {
        baselineRef.current = null;
      }
    };

    window.addEventListener('gamepadconnected', handlePadChange);
    window.addEventListener('gamepaddisconnected', handlePadChange);

    const pollLoop = () => {
      if (disposed) return;
      rafId = requestAnimationFrame(pollLoop);

      const found = findActiveGamepad();
      if (!found) {
        setPadId((prev) => (prev !== null ? null : prev));
        baselineRef.current = null;
        return;
      }

      setPadId((prev) => (prev !== found.id ? found.id : prev));

      if (!baselineRef.current) {
        baselineRef.current = captureGamepadBaseline(found.pad);
        const atRest = isGamepadAtRest(found.pad, baselineRef.current);
        waitingReleaseRef.current = !atRest;
        setWaitingRelease(!atRest);
        return;
      }

      if (stepIndexRef.current >= GAMEPAD_CALIBRATION_STEPS.length) {
        return;
      }

      if (waitingReleaseRef.current) {
        if (isGamepadAtRest(found.pad, baselineRef.current)) {
          waitingReleaseRef.current = false;
          setWaitingRelease(false);
          baselineRef.current = captureGamepadBaseline(found.pad);
        }
        return;
      }

      const detected = detectGamepadCalibrationInput(found.pad, baselineRef.current);
      if (!detected) return;

      const curStep = GAMEPAD_CALIBRATION_STEPS[stepIndexRef.current];
      if (!curStep) return;

      waitingReleaseRef.current = true;
      setWaitingRelease(true);
      setLastCapturedText(formatGamepadInputSource(detected));
      setBindings((prev) => ({ ...prev, [curStep.id]: detected }));

      if (advanceTimerRef.current !== null) {
        window.clearTimeout(advanceTimerRef.current);
      }
      const nextStep = singleRebindRef.current
        ? GAMEPAD_CALIBRATION_STEPS.length
        : stepIndexRef.current + 1;
      advanceTimerRef.current = window.setTimeout(() => {
        if (disposed) return;
        setLastCapturedText(null);
        setSingleRebindMode(false);
        setStepIndex(nextStep);
        const latest = findActiveGamepad();
        if (latest) {
          baselineRef.current = captureGamepadBaseline(latest.pad);
          const atRest = isGamepadAtRest(latest.pad, baselineRef.current);
          waitingReleaseRef.current = !atRest;
          setWaitingRelease(!atRest);
        }
      }, 280);
    };

    rafId = requestAnimationFrame(pollLoop);

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      window.removeEventListener('gamepadconnected', handlePadChange);
      window.removeEventListener('gamepaddisconnected', handlePadChange);
      if (advanceTimerRef.current !== null) {
        window.clearTimeout(advanceTimerRef.current);
        advanceTimerRef.current = null;
      }
    };
  }, [open]);

  if (!open) return null;

  const isSummary = stepIndex >= GAMEPAD_CALIBRATION_STEPS.length;
  const currentStep = !isSummary ? GAMEPAD_CALIBRATION_STEPS[stepIndex] : null;
  const totalSteps = GAMEPAD_CALIBRATION_STEPS.length;
  const assignedCount = GAMEPAD_CALIBRATION_STEPS.reduce(
    (acc, step) => (bindings[step.id] ? acc + 1 : acc),
    0
  );

  const handleSkip = () => {
    if (!currentStep) return;
    if (advanceTimerRef.current !== null) {
      window.clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
    }
    setLastCapturedText(null);
    setBindings((prev) => ({ ...prev, [currentStep.id]: null }));
    if (singleRebindMode) {
      setSingleRebindMode(false);
      setStepIndex(totalSteps);
    } else {
      setStepIndex((prev) => Math.min(totalSteps, prev + 1));
    }
  };

  const handleBack = () => {
    if (advanceTimerRef.current !== null) {
      window.clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
    }
    setLastCapturedText(null);
    setSingleRebindMode(false);
    setStepIndex((prev) => Math.max(0, prev - 1));
  };

  const handleRebindSingle = (idx: number) => {
    if (advanceTimerRef.current !== null) {
      window.clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
    }
    const found = findActiveGamepad();
    if (found) {
      baselineRef.current = captureGamepadBaseline(found.pad);
      const atRest = isGamepadAtRest(found.pad, baselineRef.current);
      waitingReleaseRef.current = !atRest;
      setWaitingRelease(!atRest);
    }
    setLastCapturedText(null);
    setSingleRebindMode(true);
    setStepIndex(idx);
  };

  const handleSave = () => {
    const profile: GamepadCalibrationProfile = {
      version: 1,
      padId: padId || existingCalibration?.padId || 'Геймпад',
      updatedAt: Date.now(),
      bindings,
    };
    onSave(profile);
    onClose();
  };

  const renderStepIcon = (id: GamepadActionId) => {
    switch (id) {
      case 'up':
        return <ArrowUp className="w-7 h-7 text-[#E07A22]" />;
      case 'down':
        return <ArrowDown className="w-7 h-7 text-[#E07A22]" />;
      case 'left':
        return <ArrowLeft className="w-7 h-7 text-[#E07A22]" />;
      case 'right':
        return <ArrowRight className="w-7 h-7 text-[#E07A22]" />;
      default:
        return <Gamepad2 className="w-7 h-7 text-[#E07A22]" />;
    }
  };

  return (
    <div
      className={
        overlayOnly
          ? 'fixed inset-0 z-[55] flex items-end sm:items-center justify-center lg:items-stretch lg:justify-end bg-black/70 lg:bg-black/45'
          : 'fixed inset-0 z-[55] flex items-end sm:items-center justify-center bg-black/70 lg:static lg:inset-auto lg:z-auto lg:block lg:bg-transparent lg:w-[400px] xl:w-[430px] lg:h-full lg:shrink-0'
      }
      role="dialog"
      aria-modal={overlayOnly ? 'true' : undefined}
      aria-label="Калибровка геймпада"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={
          overlayOnly
            ? 'w-full sm:max-w-md max-h-[88dvh] lg:max-w-none lg:w-[440px] lg:max-h-none lg:h-full bg-[#1E2025] border-t sm:border lg:border-t-0 lg:border-r-0 lg:border-b-0 lg:border-l border-white/12 rounded-t-2xl sm:rounded-xl lg:rounded-none lg:rounded-l-xl flex flex-col overflow-hidden shadow-2xl'
            : 'w-full sm:max-w-md max-h-[88dvh] lg:max-w-none lg:w-full lg:max-h-none lg:h-full bg-[#1E2025] border-t sm:border lg:border-t-0 lg:border-r-0 lg:border-b-0 lg:border-l border-white/10 rounded-t-2xl sm:rounded-xl lg:rounded-none flex flex-col overflow-hidden shadow-2xl lg:shadow-none'
        }
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Gamepad2 className="w-5 h-5 text-[#E07A22] shrink-0" />
            <h2 className="text-base font-bold text-[#F2EFE9] truncate">Калибровка геймпада</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть калибровку геймпада"
            className="w-10 h-10 rounded-lg bg-[#2A2D33] hover:bg-[#353941] flex items-center justify-center text-[#E6E2D9] shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Connected Pad Status Bar */}
        <div className="px-4 py-2 border-b border-white/8 bg-[#17191E] flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${
                padId ? 'bg-[#58B87C]' : 'bg-[#E07A22]'
              }`}
            />
            <span className="text-xs text-[#D8D4CC] truncate" data-testid="calibration-pad-name">
              {padId ? padId : 'Геймпад не обнаружен'}
            </span>
          </div>
          {existingCalibration && (
            <button
              type="button"
              data-testid="calibration-reset-default-btn"
              onClick={() => {
                onResetToDefault();
                onClose();
              }}
              className="h-7 px-2 rounded bg-[#2A2D33] hover:bg-[#353941] text-[11px] font-medium text-[#BDB9B0] hover:text-white inline-flex items-center gap-1 shrink-0"
            >
              <RotateCcw className="w-3 h-3" />
              Сброс
            </button>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {!padId && !isSummary ? (
            <div
              data-testid="calibration-wait-pad"
              className="h-full min-h-[240px] flex flex-col items-center justify-center text-center gap-3 px-4"
            >
              <div className="w-14 h-14 rounded-2xl bg-[#14161A] border border-white/10 flex items-center justify-center">
                <Gamepad2 className="w-7 h-7 text-[#E07A22]" />
              </div>
              <div className="space-y-1 max-w-xs">
                <p className="text-sm font-semibold text-[#F2EFE9]">
                  Нажмите любую кнопку на геймпаде
                </p>
                <p className="text-xs text-[#9B968D] leading-relaxed">
                  Подключите USB или Bluetooth геймпад и нажмите любую кнопку или пошевелите стиком,
                  чтобы браузер его активировал.
                </p>
              </div>
            </div>
          ) : !isSummary && currentStep ? (
            <div className="space-y-4">
              {/* Progress */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-[#BDB9B0]">
                    Шаг {stepIndex + 1} из {totalSteps}
                  </span>
                  <span className="font-mono text-[#E07A22]">
                    Назначено: {assignedCount}/{totalSteps}
                  </span>
                </div>
                <div className="w-full h-1.5 rounded-full bg-[#121316] overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-[#C8342A] to-[#E07A22] transition-all duration-200"
                    style={{ width: `${((stepIndex + 1) / totalSteps) * 100}%` }}
                  />
                </div>
              </div>

              {/* Active Prompt Card */}
              <div
                data-testid="calibration-active-step"
                data-step-id={currentStep.id}
                className="bg-[#14161A] border border-white/10 rounded-xl p-5 flex flex-col items-center text-center gap-3"
              >
                <div className="w-14 h-14 rounded-2xl bg-[#1E2025] border border-[#E07A22]/30 flex items-center justify-center">
                  {renderStepIcon(currentStep.id)}
                </div>

                <div className="space-y-1">
                  <h3 className="text-base font-bold text-[#F2EFE9]">{currentStep.title}</h3>
                  <p className="text-xs text-[#BDB9B0]">{currentStep.prompt}</p>
                </div>

                <div className="min-h-[34px] flex items-center justify-center">
                  {lastCapturedText ? (
                    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-md bg-[#2B5B40]/35 border border-[#58B87C]/40 text-xs font-mono text-[#8BC49A]">
                      <Check className="w-3.5 h-3.5" />
                      {lastCapturedText}
                    </span>
                  ) : waitingRelease ? (
                    <span className="text-xs font-medium text-[#E07A22]">
                      Отпустите кнопку или верните стик в центр...
                    </span>
                  ) : (
                    <span className="text-xs text-[#8D8980]">
                      Ожидание нажатия на геймпаде...
                    </span>
                  )}
                </div>

                {bindings[currentStep.id] !== undefined && (
                  <p className="text-[11px] font-mono text-[#9B968D]">
                    Сейчас: {formatGamepadInputSource(bindings[currentStep.id])}
                  </p>
                )}
              </div>

              {/* Quick Step List */}
              <div className="space-y-1.5">
                <p className="text-[11px] font-semibold text-[#9B968D] uppercase tracking-wide">
                  Порядок калибровки
                </p>
                <div className="grid grid-cols-2 gap-1.5">
                  {GAMEPAD_CALIBRATION_STEPS.map((step, idx) => {
                    const isCurrent = idx === stepIndex;
                    const bound = bindings[step.id];
                    return (
                      <button
                        key={step.id}
                        type="button"
                        onClick={() => handleRebindSingle(idx)}
                        className={`px-2.5 py-1.5 rounded-lg border text-left transition-colors ${
                          isCurrent
                            ? 'bg-[#C8342A]/20 border-[#C8342A] text-white'
                            : 'bg-[#16181C] border-white/8 text-[#D8D4CC] hover:bg-[#22252C]'
                        }`}
                      >
                        <div className="text-[11px] font-semibold truncate">{step.shortLabel}</div>
                        <div className="text-[10px] font-mono text-[#9B968D] truncate">
                          {bound === undefined
                            ? '—'
                            : formatGamepadInputSource(bound as GamepadInputSource | null)}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : (
            /* Summary Screen */
            <div className="space-y-3" data-testid="calibration-summary">
              <div className="bg-[#16181C] border border-[#58B87C]/30 rounded-lg p-3 flex items-center gap-2.5">
                <Check className="w-4 h-4 text-[#7AD39B] shrink-0" />
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-[#F2EFE9]">
                    Калибровка завершена ({assignedCount} из {totalSteps})
                  </p>
                  <p className="text-[11px] text-[#9B968D]">
                    Нажмите на любую строку, чтобы переназначить кнопку.
                  </p>
                </div>
              </div>

              <div className="space-y-1.5">
                {GAMEPAD_CALIBRATION_STEPS.map((step, idx) => {
                  const bound = bindings[step.id];
                  return (
                    <button
                      key={step.id}
                      type="button"
                      onClick={() => handleRebindSingle(idx)}
                      className="w-full px-3 py-2 rounded-lg bg-[#16181C] hover:bg-[#22252C] border border-white/8 flex items-center justify-between gap-2 text-left transition-colors"
                    >
                      <span className="text-xs font-medium text-[#F2EFE9]">{step.title}</span>
                      <span
                        className={`text-[11px] font-mono ${
                          bound ? 'text-[#E07A22]' : 'text-[#8D8980]'
                        }`}
                      >
                        {bound === undefined
                          ? 'Не назначено'
                          : formatGamepadInputSource(bound)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-4 py-3 border-t border-white/10 bg-[#181A1F] flex items-center justify-between gap-2 shrink-0">
          {!isSummary ? (
            <>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleBack}
                  disabled={stepIndex === 0}
                  className="h-9 px-3 rounded-lg bg-[#2A2D33] hover:bg-[#353941] disabled:opacity-40 text-xs font-semibold text-[#E6E2D9] inline-flex items-center gap-1"
                >
                  <ChevronLeft className="w-4 h-4" />
                  Назад
                </button>
                <button
                  type="button"
                  data-testid="calibration-skip-btn"
                  onClick={handleSkip}
                  disabled={!padId}
                  className="h-9 px-3 rounded-lg bg-[#2A2D33] hover:bg-[#353941] disabled:opacity-40 text-xs font-semibold text-[#E6E2D9] inline-flex items-center gap-1"
                >
                  <SkipForward className="w-3.5 h-3.5" />
                  Пропустить
                </button>
              </div>
              <button
                type="button"
                data-testid="calibration-finish-early-btn"
                onClick={handleSave}
                disabled={assignedCount === 0}
                className="h-9 px-3.5 rounded-lg bg-[#C8342A] hover:bg-[#D94035] disabled:opacity-40 text-xs font-semibold text-white inline-flex items-center gap-1.5"
              >
                <Check className="w-4 h-4" />
                Сохранить
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setStepIndex(0)}
                className="h-9 px-3 rounded-lg bg-[#2A2D33] hover:bg-[#353941] text-xs font-semibold text-[#E6E2D9]"
              >
                Пройти заново
              </button>
              <button
                type="button"
                data-testid="calibration-save-btn"
                onClick={handleSave}
                disabled={assignedCount === 0}
                className="h-9 px-4 rounded-lg bg-[#C8342A] hover:bg-[#D94035] disabled:opacity-40 text-xs font-semibold text-white inline-flex items-center gap-1.5"
              >
                <Check className="w-4 h-4" />
                Сохранить калибровку
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

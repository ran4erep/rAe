import { GamepadButtonLike, GamepadLike } from './physicalGamepad';
import { StorageLike } from '../settingsStorage';

export type GamepadActionId =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'fire1'
  | 'fire2'
  | 'space'
  | 'return'
  | 'lmb'
  | 'rmb'
  | 'esc';

export interface GamepadCalibrationStepMeta {
  id: GamepadActionId;
  title: string;
  prompt: string;
  shortLabel: string;
  group: 'direction' | 'action';
}

export const GAMEPAD_CALIBRATION_STEPS: readonly GamepadCalibrationStepMeta[] = [
  {
    id: 'up',
    title: 'Вверх',
    prompt: 'Отклоните стик или нажмите крестовину ВВЕРХ',
    shortLabel: 'Вверх (▲)',
    group: 'direction',
  },
  {
    id: 'down',
    title: 'Вниз',
    prompt: 'Отклоните стик или нажмите крестовину ВНИЗ',
    shortLabel: 'Вниз (▼)',
    group: 'direction',
  },
  {
    id: 'left',
    title: 'Влево',
    prompt: 'Отклоните стик или нажмите крестовину ВЛЕВО',
    shortLabel: 'Влево (◀)',
    group: 'direction',
  },
  {
    id: 'right',
    title: 'Вправо',
    prompt: 'Отклоните стик или нажмите крестовину ВПРАВО',
    shortLabel: 'Вправо (▶)',
    group: 'direction',
  },
  {
    id: 'fire1',
    title: 'Огонь 1 (A)',
    prompt: 'Нажмите основную кнопку действия (Огонь 1)',
    shortLabel: 'Огонь 1',
    group: 'action',
  },
  {
    id: 'fire2',
    title: 'Огонь 2 (B)',
    prompt: 'Нажмите вторую кнопку действия (Огонь 2 / Прыжок)',
    shortLabel: 'Огонь 2',
    group: 'action',
  },
  {
    id: 'space',
    title: 'Пробел (Space)',
    prompt: 'Нажмите кнопку для клавиши ПРОБЕЛ (Space)',
    shortLabel: 'Space',
    group: 'action',
  },
  {
    id: 'return',
    title: 'Enter (Return)',
    prompt: 'Нажмите кнопку для клавиши ENTER (Return)',
    shortLabel: 'Enter',
    group: 'action',
  },
  {
    id: 'lmb',
    title: 'Левая кнопка мыши',
    prompt: 'Нажмите кнопку для ЛЕВОЙ кнопки мыши (LMB)',
    shortLabel: 'ЛКМ',
    group: 'action',
  },
  {
    id: 'rmb',
    title: 'Правая кнопка мыши',
    prompt: 'Нажмите кнопку для ПРАВОЙ кнопки мыши (RMB)',
    shortLabel: 'ПКМ',
    group: 'action',
  },
  {
    id: 'esc',
    title: 'Пауза / Esc',
    prompt: 'Нажмите кнопку для клавиши ESC (Меню / Пауза)',
    shortLabel: 'Esc',
    group: 'action',
  },
];

export type GamepadInputSource =
  | { kind: 'button'; index: number }
  | { kind: 'axis'; index: number; dir: 1 | -1; rest: number }
  | { kind: 'hat'; index: number; value: number; rest: number };

export type GamepadCalibrationBindings = Partial<
  Record<GamepadActionId, GamepadInputSource | null>
>;

export interface GamepadCalibrationProfile {
  version: 1;
  padId: string;
  updatedAt: number;
  bindings: GamepadCalibrationBindings;
}

export interface GamepadBaseline {
  restAxes: number[];
  restButtons: boolean[];
}

export const GAMEPAD_CALIBRATION_STORAGE_KEY = 'amiga_gamepad_calibration_v1';

const CALIBRATION_BUTTON_THRESHOLD = 0.55;
const CALIBRATION_AXIS_DELTA = 0.55;
const CALIBRATION_HAT_REST_MIN = 1.15;
const CALIBRATION_HAT_DELTA = 0.35;
const RELEASE_AXIS_TOLERANCE = 0.28;

export function isCalibrationButtonDown(btn: GamepadButtonLike | undefined): boolean {
  if (!btn) return false;
  return btn.pressed || (btn.value !== undefined && btn.value > CALIBRATION_BUTTON_THRESHOLD);
}

export function captureGamepadBaseline(pad: GamepadLike): GamepadBaseline {
  const restAxes: number[] = new Array(pad.axes.length);
  for (let i = 0; i < pad.axes.length; i++) {
    const v = pad.axes[i];
    restAxes[i] = Number.isFinite(v) ? v : 0;
  }
  const restButtons: boolean[] = new Array(pad.buttons.length);
  for (let i = 0; i < pad.buttons.length; i++) {
    restButtons[i] = isCalibrationButtonDown(pad.buttons[i]);
  }
  return { restAxes, restButtons };
}

export function isGamepadAtRest(pad: GamepadLike, baseline: GamepadBaseline): boolean {
  for (let i = 0; i < pad.buttons.length; i++) {
    if (isCalibrationButtonDown(pad.buttons[i])) return false;
  }
  for (let i = 0; i < pad.axes.length; i++) {
    const v = pad.axes[i];
    if (!Number.isFinite(v)) continue;
    const rest = baseline.restAxes[i] ?? 0;
    if (Math.abs(v - rest) > RELEASE_AXIS_TOLERANCE) return false;
  }
  return true;
}

export function detectGamepadCalibrationInput(
  pad: GamepadLike,
  baseline: GamepadBaseline
): GamepadInputSource | null {
  for (let i = 0; i < pad.buttons.length; i++) {
    const down = isCalibrationButtonDown(pad.buttons[i]);
    if (down && !baseline.restButtons[i]) {
      return { kind: 'button', index: i };
    }
  }

  let bestIndex = -1;
  let bestDelta = 0;
  let bestVal = 0;
  let bestRest = 0;
  let bestIsHat = false;

  for (let i = 0; i < pad.axes.length; i++) {
    const val = pad.axes[i];
    if (!Number.isFinite(val)) continue;
    const rest = baseline.restAxes[i] ?? 0;
    const delta = Math.abs(val - rest);

    if (Math.abs(rest) > CALIBRATION_HAT_REST_MIN) {
      if (Math.abs(val) <= 1.05 && delta > CALIBRATION_HAT_DELTA && delta > bestDelta) {
        bestIndex = i;
        bestDelta = delta;
        bestVal = val;
        bestRest = rest;
        bestIsHat = true;
      }
      continue;
    }

    if (delta > CALIBRATION_AXIS_DELTA && delta > bestDelta) {
      bestIndex = i;
      bestDelta = delta;
      bestVal = val;
      bestRest = rest;
      bestIsHat = false;
    }
  }

  if (bestIndex < 0) return null;

  if (bestIsHat) {
    return {
      kind: 'hat',
      index: bestIndex,
      value: Math.round(bestVal * 1000) / 1000,
      rest: Math.round(bestRest * 1000) / 1000,
    };
  }

  const normalizedRest = Math.abs(bestRest) < 0.25 ? 0 : Math.round(bestRest * 100) / 100;
  return {
    kind: 'axis',
    index: bestIndex,
    dir: bestVal > bestRest ? 1 : -1,
    rest: normalizedRest,
  };
}

export function isGamepadInputActive(pad: GamepadLike, src: GamepadInputSource): boolean {
  if (src.kind === 'button') {
    const btn = src.index < pad.buttons.length ? pad.buttons[src.index] : undefined;
    if (!btn) return false;
    return btn.pressed || (btn.value !== undefined && btn.value > 0.5);
  }
  if (src.index >= pad.axes.length) return false;
  const val = pad.axes[src.index];
  if (!Number.isFinite(val)) return false;

  if (src.kind === 'hat') {
    return Math.abs(val - src.rest) > 0.2 && Math.abs(val - src.value) <= 0.16;
  }

  if (src.rest === 0) {
    return src.dir > 0 ? val > 0.32 : val < -0.32;
  }
  return src.dir > 0 ? val > src.rest + 0.45 : val < src.rest - 0.45;
}

export function formatGamepadInputSource(src: GamepadInputSource | null | undefined): string {
  if (!src) return 'Пропущено';
  if (src.kind === 'button') {
    return `Кнопка #${src.index + 1}`;
  }
  if (src.kind === 'hat') {
    return `Крестовина (ось #${src.index + 1} · ${src.value.toFixed(2)})`;
  }
  return `Ось #${src.index + 1} (${src.dir > 0 ? '+' : '−'})`;
}

export function countCalibratedBindings(profile: GamepadCalibrationProfile | null): number {
  if (!profile) return 0;
  let count = 0;
  for (let i = 0; i < GAMEPAD_CALIBRATION_STEPS.length; i++) {
    const id = GAMEPAD_CALIBRATION_STEPS[i].id;
    if (profile.bindings[id]) count++;
  }
  return count;
}

function resolveStorage(storage?: StorageLike | null): StorageLike | null {
  if (storage !== undefined) return storage;
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Ignore storage access errors
  }
  return null;
}

function sanitizeSource(raw: unknown): GamepadInputSource | null | undefined {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  if (
    obj.kind === 'button' &&
    typeof obj.index === 'number' &&
    Number.isInteger(obj.index) &&
    obj.index >= 0 &&
    obj.index < 64
  ) {
    return { kind: 'button', index: obj.index };
  }
  if (
    obj.kind === 'axis' &&
    typeof obj.index === 'number' &&
    Number.isInteger(obj.index) &&
    obj.index >= 0 &&
    obj.index < 32 &&
    (obj.dir === 1 || obj.dir === -1) &&
    typeof obj.rest === 'number' &&
    Number.isFinite(obj.rest)
  ) {
    return { kind: 'axis', index: obj.index, dir: obj.dir, rest: obj.rest };
  }
  if (
    obj.kind === 'hat' &&
    typeof obj.index === 'number' &&
    Number.isInteger(obj.index) &&
    obj.index >= 0 &&
    obj.index < 32 &&
    typeof obj.value === 'number' &&
    Number.isFinite(obj.value) &&
    typeof obj.rest === 'number' &&
    Number.isFinite(obj.rest)
  ) {
    return { kind: 'hat', index: obj.index, value: obj.value, rest: obj.rest };
  }
  return undefined;
}

export function sanitizeGamepadCalibration(raw: unknown): GamepadCalibrationProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1 || !obj.bindings || typeof obj.bindings !== 'object') return null;
  const rawBindings = obj.bindings as Record<string, unknown>;
  const bindings: GamepadCalibrationBindings = {};
  let hasAny = false;
  for (let i = 0; i < GAMEPAD_CALIBRATION_STEPS.length; i++) {
    const id = GAMEPAD_CALIBRATION_STEPS[i].id;
    const sanitized = sanitizeSource(rawBindings[id]);
    if (sanitized !== undefined) {
      bindings[id] = sanitized;
      if (sanitized !== null) hasAny = true;
    }
  }
  if (!hasAny) return null;
  return {
    version: 1,
    padId: typeof obj.padId === 'string' && obj.padId.trim() ? obj.padId.trim() : 'Геймпад',
    updatedAt: typeof obj.updatedAt === 'number' && Number.isFinite(obj.updatedAt) ? obj.updatedAt : Date.now(),
    bindings,
  };
}

export function loadGamepadCalibration(storage?: StorageLike | null): GamepadCalibrationProfile | null {
  const store = resolveStorage(storage);
  if (!store) return null;
  try {
    const raw = store.getItem(GAMEPAD_CALIBRATION_STORAGE_KEY);
    if (!raw) return null;
    return sanitizeGamepadCalibration(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveGamepadCalibration(
  profile: GamepadCalibrationProfile,
  storage?: StorageLike | null
): void {
  const store = resolveStorage(storage);
  if (!store) return;
  try {
    const clean = sanitizeGamepadCalibration(profile);
    if (!clean) return;
    store.setItem(GAMEPAD_CALIBRATION_STORAGE_KEY, JSON.stringify(clean));
  } catch {
    // Ignore storage errors
  }
}

export function clearGamepadCalibration(storage?: StorageLike | null): void {
  const store = resolveStorage(storage);
  if (!store) return;
  try {
    store.setItem(GAMEPAD_CALIBRATION_STORAGE_KEY, '');
  } catch {
    // Ignore storage errors
  }
}

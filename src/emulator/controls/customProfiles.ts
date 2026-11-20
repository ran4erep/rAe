import { AMIGA_KEY_NAMES, AMIGA_RAW } from '../keyboard/amigaKeyMap';
import { JoystickState } from '../types';

export type StickDirection = 'up' | 'down' | 'left' | 'right';
export type ControlButtonSize = 'sm' | 'md' | 'lg';

export type ControlTarget =
  | { kind: 'key'; code: number }
  | { kind: 'joy'; dir: 'up' | 'down' | 'left' | 'right' | 'fire1' | 'fire2' }
  | { kind: 'mouse'; button: 'left' | 'right' };

export interface CustomButtonConfig {
  id: string;
  xPct: number;
  yPct: number;
  size: ControlButtonSize;
  target: ControlTarget;
  label?: string;
}

export interface CustomStickConfig {
  xPct: number;
  yPct: number;
  size: ControlButtonSize;
  up: ControlTarget;
  down: ControlTarget;
  left: ControlTarget;
  right: ControlTarget;
}

export interface CustomControlProfile {
  id: string;
  name: string;
  stick: CustomStickConfig | null;
  buttons: CustomButtonConfig[];
}

export interface CustomProfilesState {
  version: 2;
  activeProfileId: string;
  profiles: CustomControlProfile[];
}

export const CUSTOM_PROFILES_STORAGE_KEY = 'amiga500_custom_control_profiles_v2';

export interface StickDirsState {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

export interface EmittedTargetAction {
  target: ControlTarget;
  down: boolean;
}

export function clampPct(value: number, min = 4, max = 96): number {
  if (!Number.isFinite(value)) return 50;
  return Math.max(min, Math.min(max, Math.round(value * 10) / 10));
}

export function targetKey(target: ControlTarget): string {
  if (target.kind === 'key') return `key:${target.code}`;
  if (target.kind === 'joy') return `joy:${target.dir}`;
  return `mouse:${target.button}`;
}

export function targetsEqual(a: ControlTarget, b: ControlTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'key' && b.kind === 'key') return a.code === b.code;
  if (a.kind === 'joy' && b.kind === 'joy') return a.dir === b.dir;
  if (a.kind === 'mouse' && b.kind === 'mouse') return a.button === b.button;
  return false;
}

const JOY_LABELS: Record<Extract<ControlTarget, { kind: 'joy' }>['dir'], string> = {
  up: 'JOY ↑',
  down: 'JOY ↓',
  left: 'JOY ←',
  right: 'JOY →',
  fire1: 'FIRE 1',
  fire2: 'FIRE 2',
};

const COMPACT_KEY_LABELS: Partial<Record<number, string>> = {
  [AMIGA_RAW.SPACE]: 'SPACE',
  [AMIGA_RAW.RETURN]: 'RET',
  [AMIGA_RAW.BACKSPACE]: '⌫',
  [AMIGA_RAW.ESC]: 'ESC',
  [AMIGA_RAW.HELP]: 'HELP',
  [AMIGA_RAW.UP]: '↑',
  [AMIGA_RAW.DOWN]: '↓',
  [AMIGA_RAW.LEFT]: '←',
  [AMIGA_RAW.RIGHT]: '→',
  [AMIGA_RAW.LSHIFT]: 'L-SHF',
  [AMIGA_RAW.RSHIFT]: 'R-SHF',
  [AMIGA_RAW.LALT]: 'L-ALT',
  [AMIGA_RAW.RALT]: 'R-ALT',
  [AMIGA_RAW.LAMIGA]: 'L-AMI',
  [AMIGA_RAW.RAMIGA]: 'R-AMI',
  [AMIGA_RAW.CAPSLOCK]: 'CAPS',
};

export function getTargetDisplayLabel(target: ControlTarget, customLabel?: string): string {
  const trimmed = customLabel?.trim();
  if (trimmed) return trimmed;
  if (target.kind === 'key') {
    return COMPACT_KEY_LABELS[target.code] ?? AMIGA_KEY_NAMES[target.code] ?? `KEY $${target.code.toString(16)}`;
  }
  if (target.kind === 'joy') {
    return JOY_LABELS[target.dir];
  }
  return target.button === 'left' ? 'ЛКМ' : 'ПКМ';
}

export function getTargetAriaLabel(target: ControlTarget, customLabel?: string): string {
  if (target.kind === 'key') {
    const name = AMIGA_KEY_NAMES[target.code] ?? `Key ${target.code}`;
    return customLabel?.trim() ? `${customLabel.trim()} (${name})` : name;
  }
  if (target.kind === 'joy') {
    return JOY_LABELS[target.dir];
  }
  return target.button === 'left' ? 'Левая кнопка мыши' : 'Правая кнопка мыши';
}

/**
 * Computes exact minimal press/release transitions for an 8-way stick
 * mapped to arbitrary keyboard keys, joystick directions, or mouse buttons.
 */
export function computeStickTransition(
  prevActiveMap: Map<string, ControlTarget>,
  nextDirs: StickDirsState,
  stick: Pick<CustomStickConfig, 'up' | 'down' | 'left' | 'right'>
): { nextActiveMap: Map<string, ControlTarget>; actions: EmittedTargetAction[] } {
  const nextActiveMap = new Map<string, ControlTarget>();
  const dirs: StickDirection[] = ['up', 'down', 'left', 'right'];

  for (const d of dirs) {
    if (nextDirs[d]) {
      const target = stick[d];
      nextActiveMap.set(targetKey(target), target);
    }
  }

  const actions: EmittedTargetAction[] = [];

  for (const [k, target] of prevActiveMap.entries()) {
    if (!nextActiveMap.has(k)) {
      actions.push({ target, down: false });
    }
  }
  for (const [k, target] of nextActiveMap.entries()) {
    if (!prevActiveMap.has(k)) {
      actions.push({ target, down: true });
    }
  }

  return { nextActiveMap, actions };
}

/**
 * Helper to apply an EmittedTargetAction array onto machine callbacks.
 * Groups joystick patches into a single call to minimize overhead.
 */
export function dispatchTargetActions(
  actions: EmittedTargetAction[],
  handlers: {
    onKeyEvent: (rawCode: number, isDown: boolean) => void;
    onJoystickChange: (patch: Partial<JoystickState>) => void;
    onMouseButton: (left?: boolean, right?: boolean) => void;
  }
): void {
  if (actions.length === 0) return;

  let joyPatch: Partial<JoystickState> | null = null;
  let leftMouse: boolean | undefined;
  let rightMouse: boolean | undefined;

  for (const act of actions) {
    const t = act.target;
    if (t.kind === 'key') {
      handlers.onKeyEvent(t.code, act.down);
    } else if (t.kind === 'joy') {
      if (!joyPatch) joyPatch = {};
      joyPatch[t.dir] = act.down;
    } else {
      if (t.button === 'left') leftMouse = act.down;
      else rightMouse = act.down;
    }
  }

  if (joyPatch) {
    handlers.onJoystickChange(joyPatch);
  }
  if (leftMouse !== undefined || rightMouse !== undefined) {
    handlers.onMouseButton(leftMouse, rightMouse);
  }
}

export function createDefaultStickConfig(): CustomStickConfig {
  return {
    xPct: 18,
    yPct: 72,
    size: 'md',
    up: { kind: 'joy', dir: 'up' },
    down: { kind: 'joy', dir: 'down' },
    left: { kind: 'joy', dir: 'left' },
    right: { kind: 'joy', dir: 'right' },
  };
}

export function createDefaultProfilesState(): CustomProfilesState {
  return {
    version: 2,
    activeProfileId: 'profile_1',
    profiles: [
      {
        id: 'profile_1',
        name: 'Профиль 1',
        stick: null,
        buttons: [],
      },
    ],
  };
}

function isValidTarget(raw: unknown): raw is ControlTarget {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  if (r.kind === 'key') {
    return typeof r.code === 'number' && Number.isInteger(r.code) && r.code >= 0 && r.code <= 0x67;
  }
  if (r.kind === 'joy') {
    return (
      r.dir === 'up' ||
      r.dir === 'down' ||
      r.dir === 'left' ||
      r.dir === 'right' ||
      r.dir === 'fire1' ||
      r.dir === 'fire2'
    );
  }
  if (r.kind === 'mouse') {
    return r.button === 'left' || r.button === 'right';
  }
  return false;
}

function isValidSize(raw: unknown): raw is ControlButtonSize {
  return raw === 'sm' || raw === 'md' || raw === 'lg';
}

export function sanitizeProfilesState(raw: unknown): CustomProfilesState {
  const fallback = createDefaultProfilesState();
  if (!raw || typeof raw !== 'object') return fallback;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.profiles) || obj.profiles.length === 0) return fallback;

  const profiles: CustomControlProfile[] = [];
  const baseStick = createDefaultStickConfig();

  for (let i = 0; i < obj.profiles.length; i++) {
    const p = obj.profiles[i] as Record<string, unknown> | null;
    if (!p || typeof p !== 'object') continue;

    const id = typeof p.id === 'string' && p.id.trim() ? p.id.trim() : `profile_${i + 1}`;
    const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 40) : `Профиль ${i + 1}`;

    let stick: CustomStickConfig | null = null;
    if (p.stick && typeof p.stick === 'object') {
      const rawStick = p.stick as Record<string, unknown>;
      if (rawStick.enabled !== false) {
        stick = {
          xPct: clampPct(typeof rawStick.xPct === 'number' ? rawStick.xPct : baseStick.xPct, 6, 94),
          yPct: clampPct(typeof rawStick.yPct === 'number' ? rawStick.yPct : baseStick.yPct, 10, 90),
          size: isValidSize(rawStick.size) ? rawStick.size : 'md',
          up: isValidTarget(rawStick.up) ? rawStick.up : baseStick.up,
          down: isValidTarget(rawStick.down) ? rawStick.down : baseStick.down,
          left: isValidTarget(rawStick.left) ? rawStick.left : baseStick.left,
          right: isValidTarget(rawStick.right) ? rawStick.right : baseStick.right,
        };
      }
    }

    const buttons: CustomButtonConfig[] = [];
    if (Array.isArray(p.buttons)) {
      for (let bIdx = 0; bIdx < p.buttons.length; bIdx++) {
        const b = p.buttons[bIdx] as Record<string, unknown> | null;
        if (!b || typeof b !== 'object' || !isValidTarget(b.target)) continue;
        buttons.push({
          id: typeof b.id === 'string' && b.id.trim() ? b.id.trim() : `btn_${bIdx + 1}`,
          xPct: clampPct(typeof b.xPct === 'number' ? b.xPct : 50, 4, 96),
          yPct: clampPct(typeof b.yPct === 'number' ? b.yPct : 50, 6, 94),
          size: isValidSize(b.size) ? b.size : 'md',
          target: b.target,
          label: typeof b.label === 'string' && b.label.trim() ? b.label.trim().slice(0, 10) : undefined,
        });
      }
    }

    profiles.push({ id, name, stick, buttons });
  }

  if (profiles.length === 0) return fallback;
  const requestedId = typeof obj.activeProfileId === 'string' ? obj.activeProfileId : '';
  const hasActive = profiles.some((p) => p.id === requestedId);

  return {
    version: 2,
    activeProfileId: hasActive ? requestedId : profiles[0].id,
    profiles,
  };
}

export function loadCustomProfiles(): CustomProfilesState {
  try {
    if (typeof localStorage === 'undefined') return createDefaultProfilesState();
    const raw = localStorage.getItem(CUSTOM_PROFILES_STORAGE_KEY);
    if (!raw) return createDefaultProfilesState();
    return sanitizeProfilesState(JSON.parse(raw));
  } catch {
    return createDefaultProfilesState();
  }
}

export function saveCustomProfiles(state: CustomProfilesState): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(CUSTOM_PROFILES_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage quota or private mode errors
  }
}

export function getActiveProfile(state: CustomProfilesState): CustomControlProfile {
  return state.profiles.find((p) => p.id === state.activeProfileId) ?? state.profiles[0];
}

export function createProfile(state: CustomProfilesState, name: string): CustomProfilesState {
  const trimmed = name.trim().slice(0, 40) || `Профиль ${state.profiles.length + 1}`;
  const id = `prof_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  const nextProfile: CustomControlProfile = {
    id,
    name: trimmed,
    stick: null,
    buttons: [],
  };

  return {
    version: 2,
    activeProfileId: id,
    profiles: [...state.profiles, nextProfile],
  };
}

export function renameProfile(state: CustomProfilesState, profileId: string, name: string): CustomProfilesState {
  const trimmed = name.trim().slice(0, 40);
  if (!trimmed) return state;
  return {
    ...state,
    profiles: state.profiles.map((p) => (p.id === profileId ? { ...p, name: trimmed } : p)),
  };
}

export function deleteProfile(state: CustomProfilesState, profileId: string): CustomProfilesState {
  const remaining = state.profiles.filter((p) => p.id !== profileId);
  if (remaining.length === 0) {
    return createDefaultProfilesState();
  }
  const activeStillExists = remaining.some((p) => p.id === state.activeProfileId);
  return {
    ...state,
    activeProfileId: activeStillExists ? state.activeProfileId : remaining[0].id,
    profiles: remaining,
  };
}

export function updateActiveProfile(
  state: CustomProfilesState,
  updater: (profile: CustomControlProfile) => CustomControlProfile
): CustomProfilesState {
  return {
    ...state,
    profiles: state.profiles.map((p) => (p.id === state.activeProfileId ? updater(p) : p)),
  };
}

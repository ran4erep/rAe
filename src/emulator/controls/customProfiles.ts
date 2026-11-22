import { AMIGA_KEY_NAMES, AMIGA_RAW } from '../keyboard/amigaKeyMap';
import { JoystickState } from '../types';

export type StickDirection = 'up' | 'down' | 'left' | 'right';
export type ControlButtonSize = 'sm' | 'md' | 'lg';

export type SingleControlTarget =
  | { kind: 'key'; code: number }
  | { kind: 'joy'; dir: 'up' | 'down' | 'left' | 'right' | 'fire1' | 'fire2' }
  | { kind: 'mouse'; button: 'left' | 'right' };

export type ControlTarget =
  | SingleControlTarget
  | { kind: 'combo'; targets: [SingleControlTarget, SingleControlTarget] };

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
  target: SingleControlTarget;
  down: boolean;
}

const MODIFIER_KEY_CODES = new Set<number>([
  AMIGA_RAW.LSHIFT,
  AMIGA_RAW.RSHIFT,
  AMIGA_RAW.CTRL,
  AMIGA_RAW.LALT,
  AMIGA_RAW.RALT,
  AMIGA_RAW.LAMIGA,
  AMIGA_RAW.RAMIGA,
]);

export function isModifierControlTarget(target: SingleControlTarget): boolean {
  return target.kind === 'key' && MODIFIER_KEY_CODES.has(target.code);
}

/**
 * Orders a 2-target combo so any modifier key (Shift/Ctrl/Alt/Amiga) comes first.
 * This ensures AmigaOS/games see the modifier pressed before the main key and released after.
 */
export function normalizeComboTargets(
  first: SingleControlTarget,
  second: SingleControlTarget
): [SingleControlTarget, SingleControlTarget] {
  if (isModifierControlTarget(second) && !isModifierControlTarget(first)) {
    return [second, first];
  }
  return [first, second];
}

export function expandControlTarget(target: ControlTarget): SingleControlTarget[] {
  if (target.kind === 'combo') {
    return [target.targets[0], target.targets[1]];
  }
  return [target];
}

export function clampPct(value: number, min = 4, max = 96): number {
  if (!Number.isFinite(value)) return 50;
  return Math.max(min, Math.min(max, Math.round(value * 10) / 10));
}

export function singleTargetKey(target: SingleControlTarget): string {
  if (target.kind === 'key') return `key:${target.code}`;
  if (target.kind === 'joy') return `joy:${target.dir}`;
  return `mouse:${target.button}`;
}

export function targetKey(target: ControlTarget): string {
  if (target.kind === 'combo') {
    return `combo:${singleTargetKey(target.targets[0])}+${singleTargetKey(target.targets[1])}`;
  }
  return singleTargetKey(target);
}

export function singleTargetsEqual(a: SingleControlTarget, b: SingleControlTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'key' && b.kind === 'key') return a.code === b.code;
  if (a.kind === 'joy' && b.kind === 'joy') return a.dir === b.dir;
  if (a.kind === 'mouse' && b.kind === 'mouse') return a.button === b.button;
  return false;
}

export function targetsEqual(a: ControlTarget, b: ControlTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'combo' && b.kind === 'combo') {
    return (
      singleTargetsEqual(a.targets[0], b.targets[0]) &&
      singleTargetsEqual(a.targets[1], b.targets[1])
    );
  }
  if (a.kind !== 'combo' && b.kind !== 'combo') {
    return singleTargetsEqual(a, b);
  }
  return false;
}

const JOY_LABELS: Record<Extract<SingleControlTarget, { kind: 'joy' }>['dir'], string> = {
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

const COMBO_PART_LABELS: Partial<Record<number, string>> = {
  [AMIGA_RAW.LSHIFT]: 'L⇧',
  [AMIGA_RAW.RSHIFT]: 'R⇧',
  [AMIGA_RAW.SPACE]: 'SPC',
  [AMIGA_RAW.RETURN]: 'RET',
  [AMIGA_RAW.BACKSPACE]: '⌫',
  [AMIGA_RAW.LALT]: 'L-ALT',
  [AMIGA_RAW.RALT]: 'R-ALT',
  [AMIGA_RAW.LAMIGA]: 'L-AMI',
  [AMIGA_RAW.RAMIGA]: 'R-AMI',
};

function getSingleTargetDisplayLabel(target: SingleControlTarget, inCombo = false): string {
  if (target.kind === 'key') {
    if (inCombo && COMBO_PART_LABELS[target.code]) {
      return COMBO_PART_LABELS[target.code]!;
    }
    return COMPACT_KEY_LABELS[target.code] ?? AMIGA_KEY_NAMES[target.code] ?? `KEY $${target.code.toString(16)}`;
  }
  if (target.kind === 'joy') {
    return JOY_LABELS[target.dir];
  }
  return target.button === 'left' ? 'ЛКМ' : 'ПКМ';
}

export function getTargetDisplayLabel(target: ControlTarget, customLabel?: string): string {
  const trimmed = customLabel?.trim();
  if (trimmed) return trimmed;
  if (target.kind === 'combo') {
    return `${getSingleTargetDisplayLabel(target.targets[0], true)}+${getSingleTargetDisplayLabel(target.targets[1], true)}`;
  }
  return getSingleTargetDisplayLabel(target, false);
}

function getSingleTargetAriaLabel(target: SingleControlTarget): string {
  if (target.kind === 'key') {
    return AMIGA_KEY_NAMES[target.code] ?? `Key ${target.code}`;
  }
  if (target.kind === 'joy') {
    return JOY_LABELS[target.dir];
  }
  return target.button === 'left' ? 'Левая кнопка мыши' : 'Правая кнопка мыши';
}

export function getTargetAriaLabel(target: ControlTarget, customLabel?: string): string {
  const baseName =
    target.kind === 'combo'
      ? `${getSingleTargetAriaLabel(target.targets[0])} + ${getSingleTargetAriaLabel(target.targets[1])}`
      : getSingleTargetAriaLabel(target);
  return customLabel?.trim() ? `${customLabel.trim()} (${baseName})` : baseName;
}

/**
 * Computes exact minimal press/release transitions for an 8-way stick
 * mapped to arbitrary keyboard keys, joystick directions, mouse buttons, or 2-action combos.
 */
export function computeStickTransition(
  prevActiveMap: Map<string, SingleControlTarget>,
  nextDirs: StickDirsState,
  stick: Pick<CustomStickConfig, 'up' | 'down' | 'left' | 'right'>
): { nextActiveMap: Map<string, SingleControlTarget>; actions: EmittedTargetAction[] } {
  const nextActiveMap = new Map<string, SingleControlTarget>();
  const dirs: StickDirection[] = ['up', 'down', 'left', 'right'];

  for (const d of dirs) {
    if (nextDirs[d]) {
      const expanded = expandControlTarget(stick[d]);
      for (const single of expanded) {
        nextActiveMap.set(singleTargetKey(single), single);
      }
    }
  }

  const actions: EmittedTargetAction[] = [];

  // Release in reverse order so secondary keys release before modifiers
  const toRelease: SingleControlTarget[] = [];
  for (const [k, target] of prevActiveMap.entries()) {
    if (!nextActiveMap.has(k)) {
      toRelease.push(target);
    }
  }
  for (let i = toRelease.length - 1; i >= 0; i--) {
    actions.push({ target: toRelease[i], down: false });
  }

  for (const [k, target] of nextActiveMap.entries()) {
    if (!prevActiveMap.has(k)) {
      actions.push({ target, down: true });
    }
  }

  return { nextActiveMap, actions };
}

/**
 * Reference-counted hold tracker shared across all custom overlay controls (buttons + stick).
 * Prevents overlapping combos or stick directions from prematurely releasing a shared modifier/key,
 * and guarantees press order ([0] then [1]) and reverse release order ([1] then [0]).
 */
export class TargetHoldManager {
  private readonly sources = new Map<string, SingleControlTarget[]>();
  private readonly refCounts = new Map<string, { target: SingleControlTarget; count: number }>();

  public setSource(sourceId: string, nextTargets: SingleControlTarget[]): EmittedTargetAction[] {
    const prevTargets = this.sources.get(sourceId) ?? [];
    if (nextTargets.length === 0) {
      this.sources.delete(sourceId);
    } else {
      this.sources.set(sourceId, nextTargets);
    }

    const actions: EmittedTargetAction[] = [];

    // Increment new targets first (in order) so shared targets stay held during transitions
    for (let i = 0; i < nextTargets.length; i++) {
      const t = nextTargets[i];
      const k = singleTargetKey(t);
      const entry = this.refCounts.get(k);
      if (!entry || entry.count === 0) {
        this.refCounts.set(k, { target: t, count: 1 });
        actions.push({ target: t, down: true });
      } else {
        entry.count++;
      }
    }

    // Decrement previous targets in reverse order so secondary keys release before modifiers
    for (let i = prevTargets.length - 1; i >= 0; i--) {
      const t = prevTargets[i];
      const k = singleTargetKey(t);
      const entry = this.refCounts.get(k);
      if (!entry) continue;
      entry.count--;
      if (entry.count <= 0) {
        this.refCounts.delete(k);
        actions.push({ target: entry.target, down: false });
      }
    }

    return actions;
  }

  public releaseAll(): EmittedTargetAction[] {
    if (this.refCounts.size === 0) {
      this.sources.clear();
      return [];
    }
    const actions: EmittedTargetAction[] = [];
    // Release non-modifiers before modifiers
    const entries = Array.from(this.refCounts.values());
    for (let i = entries.length - 1; i >= 0; i--) {
      if (!isModifierControlTarget(entries[i].target)) {
        actions.push({ target: entries[i].target, down: false });
      }
    }
    for (let i = entries.length - 1; i >= 0; i--) {
      if (isModifierControlTarget(entries[i].target)) {
        actions.push({ target: entries[i].target, down: false });
      }
    }
    this.sources.clear();
    this.refCounts.clear();
    return actions;
  }
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

function isValidSingleTarget(raw: unknown): raw is SingleControlTarget {
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

function isValidTarget(raw: unknown): raw is ControlTarget {
  if (isValidSingleTarget(raw)) return true;
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  if (r.kind === 'combo' && Array.isArray(r.targets) && r.targets.length === 2) {
    const [a, b] = r.targets;
    return isValidSingleTarget(a) && isValidSingleTarget(b) && !singleTargetsEqual(a, b);
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

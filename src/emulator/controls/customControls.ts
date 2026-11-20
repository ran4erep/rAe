import { AMIGA_KEY_NAMES, AMIGA_RAW } from '../keyboard/amigaKeyMap';
import { JoystickState } from '../types';

export type StickDirection = 'up' | 'down' | 'left' | 'right';

export type StickBindingTarget =
  | { kind: 'none' }
  | { kind: 'joy'; dir: StickDirection }
  | { kind: 'key'; rawCode: number };

export type CustomButtonTarget =
  | { kind: 'key'; rawCode: number }
  | { kind: 'joy_fire1' }
  | { kind: 'joy_fire2' }
  | { kind: 'mouse_lmb' }
  | { kind: 'mouse_rmb' };

export type CustomButtonSize = 'sm' | 'md' | 'lg';

export interface CustomControlButton {
  id: string;
  label: string;
  target: CustomButtonTarget;
  xPct: number;
  yPct: number;
  size: CustomButtonSize;
}

export interface CustomStickConfig {
  enabled: boolean;
  xPct: number;
  yPct: number;
  size: CustomButtonSize;
  up: StickBindingTarget;
  down: StickBindingTarget;
  left: StickBindingTarget;
  right: StickBindingTarget;
}

export interface CustomControlProfile {
  id: string;
  name: string;
  stick: CustomStickConfig;
  buttons: CustomControlButton[];
}

export interface CustomProfilesStore {
  activeProfileId: string;
  profiles: CustomControlProfile[];
}

export const CUSTOM_PROFILES_STORAGE_KEY = 'amiga500_custom_control_profiles_v1';

export interface StickDirsState {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

export const EMPTY_STICK_DIRS: StickDirsState = {
  up: false,
  down: false,
  left: false,
  right: false,
};

export function clampPct(val: number, min = 6, max = 94): number {
  if (!Number.isFinite(val)) return 50;
  return Math.max(min, Math.min(max, Math.round(val * 10) / 10));
}

export function formatStickTargetLabel(target: StickBindingTarget): string {
  if (target.kind === 'none') return '—';
  if (target.kind === 'joy') {
    switch (target.dir) {
      case 'up':
        return 'JOY ▲';
      case 'down':
        return 'JOY ▼';
      case 'left':
        return 'JOY ◀';
      case 'right':
        return 'JOY ▶';
    }
  }
  return AMIGA_KEY_NAMES[target.rawCode] ?? `KEY $${target.rawCode.toString(16).toUpperCase()}`;
}

export function formatButtonTargetLabel(target: CustomButtonTarget): string {
  switch (target.kind) {
    case 'joy_fire1':
      return 'FIRE 1';
    case 'joy_fire2':
      return 'FIRE 2';
    case 'mouse_lmb':
      return 'LMB';
    case 'mouse_rmb':
      return 'RMB';
    case 'key':
      return AMIGA_KEY_NAMES[target.rawCode] ?? `K$${target.rawCode.toString(16).toUpperCase()}`;
  }
}

export function createDefaultProfiles(): CustomControlProfile[] {
  return [
    {
      id: 'preset-arrows-mouse',
      name: 'Стрелки + Мышь',
      stick: {
        enabled: true,
        xPct: 19,
        yPct: 72,
        size: 'md',
        up: { kind: 'key', rawCode: AMIGA_RAW.UP },
        down: { kind: 'key', rawCode: AMIGA_RAW.DOWN },
        left: { kind: 'key', rawCode: AMIGA_RAW.LEFT },
        right: { kind: 'key', rawCode: AMIGA_RAW.RIGHT },
      },
      buttons: [
        { id: 'b-lmb', label: 'LMB', target: { kind: 'mouse_lmb' }, xPct: 88, yPct: 78, size: 'md' },
        { id: 'b-rmb', label: 'RMB', target: { kind: 'mouse_rmb' }, xPct: 74, yPct: 82, size: 'md' },
        { id: 'b-space', label: 'SPACE', target: { kind: 'key', rawCode: AMIGA_RAW.SPACE }, xPct: 88, yPct: 58, size: 'md' },
        { id: 'b-ret', label: 'RET', target: { kind: 'key', rawCode: AMIGA_RAW.RETURN }, xPct: 74, yPct: 62, size: 'sm' },
        { id: 'b-esc', label: 'ESC', target: { kind: 'key', rawCode: AMIGA_RAW.ESC }, xPct: 88, yPct: 38, size: 'sm' },
        { id: 'b-f1', label: 'F1', target: { kind: 'key', rawCode: AMIGA_RAW.F1 }, xPct: 88, yPct: 22, size: 'sm' },
      ],
    },
    {
      id: 'preset-wasd',
      name: 'WASD + Прыжок',
      stick: {
        enabled: true,
        xPct: 19,
        yPct: 72,
        size: 'md',
        up: { kind: 'key', rawCode: AMIGA_RAW.W },
        down: { kind: 'key', rawCode: AMIGA_RAW.S },
        left: { kind: 'key', rawCode: AMIGA_RAW.A },
        right: { kind: 'key', rawCode: AMIGA_RAW.D },
      },
      buttons: [
        { id: 'b-space', label: 'SPACE', target: { kind: 'key', rawCode: AMIGA_RAW.SPACE }, xPct: 86, yPct: 74, size: 'lg' },
        { id: 'b-ctrl', label: 'CTRL', target: { kind: 'key', rawCode: AMIGA_RAW.CTRL }, xPct: 72, yPct: 78, size: 'md' },
        { id: 'b-ret', label: 'RET', target: { kind: 'key', rawCode: AMIGA_RAW.RETURN }, xPct: 88, yPct: 50, size: 'sm' },
        { id: 'b-esc', label: 'ESC', target: { kind: 'key', rawCode: AMIGA_RAW.ESC }, xPct: 88, yPct: 32, size: 'sm' },
      ],
    },
    {
      id: 'preset-joy-keys',
      name: 'Джойстик + Клавиши',
      stick: {
        enabled: true,
        xPct: 19,
        yPct: 72,
        size: 'md',
        up: { kind: 'joy', dir: 'up' },
        down: { kind: 'joy', dir: 'down' },
        left: { kind: 'joy', dir: 'left' },
        right: { kind: 'joy', dir: 'right' },
      },
      buttons: [
        { id: 'b-fire1', label: 'FIRE 1', target: { kind: 'joy_fire1' }, xPct: 86, yPct: 74, size: 'lg' },
        { id: 'b-fire2', label: 'FIRE 2', target: { kind: 'joy_fire2' }, xPct: 71, yPct: 78, size: 'md' },
        { id: 'b-space', label: 'SPACE', target: { kind: 'key', rawCode: AMIGA_RAW.SPACE }, xPct: 88, yPct: 50, size: 'sm' },
        { id: 'b-f1', label: 'F1', target: { kind: 'key', rawCode: AMIGA_RAW.F1 }, xPct: 88, yPct: 34, size: 'sm' },
        { id: 'b-esc', label: 'ESC', target: { kind: 'key', rawCode: AMIGA_RAW.ESC }, xPct: 88, yPct: 18, size: 'sm' },
      ],
    },
  ];
}

export function createDefaultStore(): CustomProfilesStore {
  const profiles = createDefaultProfiles();
  return {
    activeProfileId: profiles[0].id,
    profiles,
  };
}

function sanitizeStickTarget(raw: unknown, fallback: StickBindingTarget): StickBindingTarget {
  if (!raw || typeof raw !== 'object') return fallback;
  const obj = raw as Record<string, unknown>;
  if (obj.kind === 'none') return { kind: 'none' };
  if (obj.kind === 'joy' && (obj.dir === 'up' || obj.dir === 'down' || obj.dir === 'left' || obj.dir === 'right')) {
    return { kind: 'joy', dir: obj.dir };
  }
  if (obj.kind === 'key' && typeof obj.rawCode === 'number' && Number.isInteger(obj.rawCode) && obj.rawCode >= 0 && obj.rawCode <= 0x7f) {
    return { kind: 'key', rawCode: obj.rawCode };
  }
  return fallback;
}

function sanitizeButtonTarget(raw: unknown): CustomButtonTarget | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.kind === 'joy_fire1' || obj.kind === 'joy_fire2' || obj.kind === 'mouse_lmb' || obj.kind === 'mouse_rmb') {
    return { kind: obj.kind };
  }
  if (obj.kind === 'key' && typeof obj.rawCode === 'number' && Number.isInteger(obj.rawCode) && obj.rawCode >= 0 && obj.rawCode <= 0x7f) {
    return { kind: 'key', rawCode: obj.rawCode };
  }
  return null;
}

function sanitizeSize(raw: unknown): CustomButtonSize {
  return raw === 'sm' || raw === 'md' || raw === 'lg' ? raw : 'md';
}

export function sanitizeProfile(raw: unknown, index = 0): CustomControlProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : `profile-${index}`;
  const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim().slice(0, 32) : `Профиль ${index + 1}`;
  const rawStick = (obj.stick && typeof obj.stick === 'object' ? obj.stick : {}) as Record<string, unknown>;

  const stick: CustomStickConfig = {
    enabled: rawStick.enabled !== false,
    xPct: clampPct(typeof rawStick.xPct === 'number' ? rawStick.xPct : 16, 8, 92),
    yPct: clampPct(typeof rawStick.yPct === 'number' ? rawStick.yPct : 72, 12, 88),
    size: sanitizeSize(rawStick.size),
    up: sanitizeStickTarget(rawStick.up, { kind: 'key', rawCode: AMIGA_RAW.UP }),
    down: sanitizeStickTarget(rawStick.down, { kind: 'key', rawCode: AMIGA_RAW.DOWN }),
    left: sanitizeStickTarget(rawStick.left, { kind: 'key', rawCode: AMIGA_RAW.LEFT }),
    right: sanitizeStickTarget(rawStick.right, { kind: 'key', rawCode: AMIGA_RAW.RIGHT }),
  };

  const buttons: CustomControlButton[] = [];
  if (Array.isArray(obj.buttons)) {
    for (let i = 0; i < obj.buttons.length && i < 32; i++) {
      const b = obj.buttons[i];
      if (!b || typeof b !== 'object') continue;
      const bObj = b as Record<string, unknown>;
      const target = sanitizeButtonTarget(bObj.target);
      if (!target) continue;
      const btnId = typeof bObj.id === 'string' && bObj.id.trim() ? bObj.id : `btn-${i}`;
      const label =
        typeof bObj.label === 'string' && bObj.label.trim()
          ? bObj.label.trim().slice(0, 10)
          : formatButtonTargetLabel(target);
      buttons.push({
        id: btnId,
        label,
        target,
        xPct: clampPct(typeof bObj.xPct === 'number' ? bObj.xPct : 80, 5, 95),
        yPct: clampPct(typeof bObj.yPct === 'number' ? bObj.yPct : 50, 8, 92),
        size: sanitizeSize(bObj.size),
      });
    }
  }

  return { id, name, stick, buttons };
}

export function loadCustomProfilesStore(storage?: Pick<Storage, 'getItem'> | null): CustomProfilesStore {
  try {
    const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!store) return createDefaultStore();
    const rawJson = store.getItem(CUSTOM_PROFILES_STORAGE_KEY);
    if (!rawJson) return createDefaultStore();
    const parsed = JSON.parse(rawJson) as Record<string, unknown>;
    if (!parsed || !Array.isArray(parsed.profiles)) return createDefaultStore();

    const profiles: CustomControlProfile[] = [];
    for (let i = 0; i < parsed.profiles.length; i++) {
      const p = sanitizeProfile(parsed.profiles[i], i);
      if (p) profiles.push(p);
    }
    if (profiles.length === 0) return createDefaultStore();

    const activeId =
      typeof parsed.activeProfileId === 'string' && profiles.some((p) => p.id === parsed.activeProfileId)
        ? parsed.activeProfileId
        : profiles[0].id;

    return { activeProfileId: activeId, profiles };
  } catch {
    return createDefaultStore();
  }
}

export function saveCustomProfilesStore(
  store: CustomProfilesStore,
  storage?: Pick<Storage, 'setItem'> | null
): void {
  try {
    const target = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!target) return;
    target.setItem(CUSTOM_PROFILES_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Ignore storage quota / private mode restrictions
  }
}

export function getActiveProfile(store: CustomProfilesStore): CustomControlProfile {
  return store.profiles.find((p) => p.id === store.activeProfileId) ?? store.profiles[0];
}

export function createNewProfile(
  store: CustomProfilesStore,
  name: string,
  baseProfile?: CustomControlProfile
): CustomProfilesStore {
  const cleanName = name.trim().slice(0, 32) || `Профиль ${store.profiles.length + 1}`;
  const template = baseProfile ?? getActiveProfile(store);
  const id = `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const cloned: CustomControlProfile = {
    id,
    name: cleanName,
    stick: {
      ...template.stick,
      up: { ...template.stick.up },
      down: { ...template.stick.down },
      left: { ...template.stick.left },
      right: { ...template.stick.right },
    },
    buttons: template.buttons.map((b, idx) => ({
      ...b,
      id: `${b.id}-${idx}-${Math.random().toString(36).slice(2, 5)}`,
      target: { ...b.target },
    })),
  };
  return {
    activeProfileId: id,
    profiles: [...store.profiles, cloned],
  };
}

export function deleteProfileFromStore(store: CustomProfilesStore, profileId: string): CustomProfilesStore {
  if (store.profiles.length <= 1) return store;
  const remaining = store.profiles.filter((p) => p.id !== profileId);
  if (remaining.length === 0) return store;
  const nextActive =
    store.activeProfileId === profileId || !remaining.some((p) => p.id === store.activeProfileId)
      ? remaining[0].id
      : store.activeProfileId;
  return {
    activeProfileId: nextActive,
    profiles: remaining,
  };
}

export interface StickTransitionResult {
  keysDown: number[];
  keysUp: number[];
  joyPatch: Partial<JoystickState> | null;
}

const DIRS: StickDirection[] = ['up', 'down', 'left', 'right'];

/**
 * Computes exact key press/release and joystick state deltas when the touch stick moves
 * from `prevDirs` to `nextDirs`. Safely reference-counts shared targets so two stick
 * directions bound to the same key/joy never prematurely release while one is still held.
 */
export function computeStickTransition(
  prevDirs: StickDirsState,
  nextDirs: StickDirsState,
  stick: CustomStickConfig
): StickTransitionResult {
  const prevKeys = new Set<number>();
  const nextKeys = new Set<number>();
  const prevJoy: Record<StickDirection, boolean> = { up: false, down: false, left: false, right: false };
  const nextJoy: Record<StickDirection, boolean> = { up: false, down: false, left: false, right: false };

  for (const dir of DIRS) {
    const binding = stick[dir];
    if (prevDirs[dir]) {
      if (binding.kind === 'key') prevKeys.add(binding.rawCode);
      else if (binding.kind === 'joy') prevJoy[binding.dir] = true;
    }
    if (nextDirs[dir]) {
      if (binding.kind === 'key') nextKeys.add(binding.rawCode);
      else if (binding.kind === 'joy') nextJoy[binding.dir] = true;
    }
  }

  const keysUp: number[] = [];
  for (const code of prevKeys) {
    if (!nextKeys.has(code)) keysUp.push(code);
  }

  const keysDown: number[] = [];
  for (const code of nextKeys) {
    if (!prevKeys.has(code)) keysDown.push(code);
  }

  let joyChanged = false;
  const joyPatch: Partial<JoystickState> = {};
  for (const dir of DIRS) {
    if (prevJoy[dir] !== nextJoy[dir]) {
      joyPatch[dir] = nextJoy[dir];
      joyChanged = true;
    }
  }

  return {
    keysDown,
    keysUp,
    joyPatch: joyChanged ? joyPatch : null,
  };
}

export interface KeyPickerGroup {
  title: string;
  items: Array<{ label: string; target: CustomButtonTarget }>;
}

export const AMIGA_CUSTOM_PICKER_GROUPS: KeyPickerGroup[] = [
  {
    title: 'Мышь и Джойстик',
    items: [
      { label: 'LMB (ЛКМ)', target: { kind: 'mouse_lmb' } },
      { label: 'RMB (ПКМ)', target: { kind: 'mouse_rmb' } },
      { label: 'FIRE 1', target: { kind: 'joy_fire1' } },
      { label: 'FIRE 2', target: { kind: 'joy_fire2' } },
    ],
  },
  {
    title: 'Основные игровые',
    items: [
      { label: 'SPACE', target: { kind: 'key', rawCode: AMIGA_RAW.SPACE } },
      { label: 'RETURN', target: { kind: 'key', rawCode: AMIGA_RAW.RETURN } },
      { label: 'ESC', target: { kind: 'key', rawCode: AMIGA_RAW.ESC } },
      { label: 'CTRL', target: { kind: 'key', rawCode: AMIGA_RAW.CTRL } },
      { label: 'L-SHIFT', target: { kind: 'key', rawCode: AMIGA_RAW.LSHIFT } },
      { label: 'L-ALT', target: { kind: 'key', rawCode: AMIGA_RAW.LALT } },
      { label: 'L-AMIGA', target: { kind: 'key', rawCode: AMIGA_RAW.LAMIGA } },
      { label: 'HELP', target: { kind: 'key', rawCode: AMIGA_RAW.HELP } },
      { label: 'TAB', target: { kind: 'key', rawCode: AMIGA_RAW.TAB } },
      { label: 'DEL', target: { kind: 'key', rawCode: AMIGA_RAW.DEL } },
      { label: 'BACKSPACE', target: { kind: 'key', rawCode: AMIGA_RAW.BACKSPACE } },
    ],
  },
  {
    title: 'Стрелки',
    items: [
      { label: '↑ UP', target: { kind: 'key', rawCode: AMIGA_RAW.UP } },
      { label: '↓ DOWN', target: { kind: 'key', rawCode: AMIGA_RAW.DOWN } },
      { label: '← LEFT', target: { kind: 'key', rawCode: AMIGA_RAW.LEFT } },
      { label: '→ RIGHT', target: { kind: 'key', rawCode: AMIGA_RAW.RIGHT } },
    ],
  },
  {
    title: 'Функциональные F1–F10',
    items: [
      { label: 'F1', target: { kind: 'key', rawCode: AMIGA_RAW.F1 } },
      { label: 'F2', target: { kind: 'key', rawCode: AMIGA_RAW.F2 } },
      { label: 'F3', target: { kind: 'key', rawCode: AMIGA_RAW.F3 } },
      { label: 'F4', target: { kind: 'key', rawCode: AMIGA_RAW.F4 } },
      { label: 'F5', target: { kind: 'key', rawCode: AMIGA_RAW.F5 } },
      { label: 'F6', target: { kind: 'key', rawCode: AMIGA_RAW.F6 } },
      { label: 'F7', target: { kind: 'key', rawCode: AMIGA_RAW.F7 } },
      { label: 'F8', target: { kind: 'key', rawCode: AMIGA_RAW.F8 } },
      { label: 'F9', target: { kind: 'key', rawCode: AMIGA_RAW.F9 } },
      { label: 'F10', target: { kind: 'key', rawCode: AMIGA_RAW.F10 } },
    ],
  },
  {
    title: 'Буквы A–Z',
    items: [
      AMIGA_RAW.A, AMIGA_RAW.B, AMIGA_RAW.C, AMIGA_RAW.D, AMIGA_RAW.E, AMIGA_RAW.F, AMIGA_RAW.G,
      AMIGA_RAW.H, AMIGA_RAW.I, AMIGA_RAW.J, AMIGA_RAW.K, AMIGA_RAW.L, AMIGA_RAW.M, AMIGA_RAW.N,
      AMIGA_RAW.O, AMIGA_RAW.P, AMIGA_RAW.Q, AMIGA_RAW.R, AMIGA_RAW.S, AMIGA_RAW.T, AMIGA_RAW.U,
      AMIGA_RAW.V, AMIGA_RAW.W, AMIGA_RAW.X, AMIGA_RAW.Y, AMIGA_RAW.Z,
    ].map((code) => ({
      label: AMIGA_KEY_NAMES[code] ?? String(code),
      target: { kind: 'key', rawCode: code } as CustomButtonTarget,
    })),
  },
  {
    title: 'Цифры 0–9 и Numpad',
    items: [
      AMIGA_RAW.KEY_1, AMIGA_RAW.KEY_2, AMIGA_RAW.KEY_3, AMIGA_RAW.KEY_4, AMIGA_RAW.KEY_5,
      AMIGA_RAW.KEY_6, AMIGA_RAW.KEY_7, AMIGA_RAW.KEY_8, AMIGA_RAW.KEY_9, AMIGA_RAW.KEY_0,
      AMIGA_RAW.NP_0, AMIGA_RAW.NP_1, AMIGA_RAW.NP_2, AMIGA_RAW.NP_3, AMIGA_RAW.NP_4,
      AMIGA_RAW.NP_5, AMIGA_RAW.NP_6, AMIGA_RAW.NP_7, AMIGA_RAW.NP_8, AMIGA_RAW.NP_9,
      AMIGA_RAW.NP_ENTER, AMIGA_RAW.NP_PLUS, AMIGA_RAW.NP_MINUS, AMIGA_RAW.NP_STAR, AMIGA_RAW.NP_SLASH,
    ].map((code) => ({
      label: AMIGA_KEY_NAMES[code] ?? String(code),
      target: { kind: 'key', rawCode: code } as CustomButtonTarget,
    })),
  },
];

export const STICK_KEY_OPTIONS: Array<{ label: string; rawCode: number }> = [
  { label: '↑ UP (Стрелка вверх)', rawCode: AMIGA_RAW.UP },
  { label: '↓ DOWN (Стрелка вниз)', rawCode: AMIGA_RAW.DOWN },
  { label: '← LEFT (Стрелка влево)', rawCode: AMIGA_RAW.LEFT },
  { label: '→ RIGHT (Стрелка вправо)', rawCode: AMIGA_RAW.RIGHT },
  { label: 'W', rawCode: AMIGA_RAW.W },
  { label: 'A', rawCode: AMIGA_RAW.A },
  { label: 'S', rawCode: AMIGA_RAW.S },
  { label: 'D', rawCode: AMIGA_RAW.D },
  { label: 'Q', rawCode: AMIGA_RAW.Q },
  { label: 'E', rawCode: AMIGA_RAW.E },
  { label: 'Z', rawCode: AMIGA_RAW.Z },
  { label: 'X', rawCode: AMIGA_RAW.X },
  { label: 'O', rawCode: AMIGA_RAW.O },
  { label: 'P', rawCode: AMIGA_RAW.P },
  { label: 'SPACE', rawCode: AMIGA_RAW.SPACE },
  { label: 'CTRL', rawCode: AMIGA_RAW.CTRL },
  { label: 'L-SHIFT', rawCode: AMIGA_RAW.LSHIFT },
  { label: 'R-SHIFT', rawCode: AMIGA_RAW.RSHIFT },
  { label: 'L-ALT', rawCode: AMIGA_RAW.LALT },
  { label: 'RETURN', rawCode: AMIGA_RAW.RETURN },
  { label: 'NUM 8', rawCode: AMIGA_RAW.NP_8 },
  { label: 'NUM 2', rawCode: AMIGA_RAW.NP_2 },
  { label: 'NUM 4', rawCode: AMIGA_RAW.NP_4 },
  { label: 'NUM 6', rawCode: AMIGA_RAW.NP_6 },
  { label: 'NUM 5', rawCode: AMIGA_RAW.NP_5 },
  { label: 'NUM 0', rawCode: AMIGA_RAW.NP_0 },
];

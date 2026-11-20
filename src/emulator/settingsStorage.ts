import { isValidOverscanMode } from './hardware/overscan';
import {
  AmigaConfig,
  ChipRamKB,
  ChipsetModel,
  DEFAULT_AMIGA_CONFIG,
  FrameSkipMode,
  OverscanMode,
  SlowRamKB,
  VideoStandard,
} from './types';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const SETTINGS_STORAGE_KEY = 'amiga500_settings_v1';
export const LEGACY_OVERSCAN_STORAGE_KEY = 'amiga_overscan_mode';
export const LEGACY_TURBO_FLOPPY_STORAGE_KEY = 'amiga_turbo_floppy';

function resolveStorage(storage?: StorageLike | null): StorageLike | null {
  if (storage !== undefined) return storage;
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Ignore restricted storage access
  }
  return null;
}

function isChipset(v: unknown): v is ChipsetModel {
  return v === 'OCS' || v === 'ECS';
}

function isVideoStandard(v: unknown): v is VideoStandard {
  return v === 'PAL' || v === 'NTSC';
}

function isChipRamKB(v: unknown): v is ChipRamKB {
  return v === 512 || v === 1024 || v === 2048;
}

function isSlowRamKB(v: unknown): v is SlowRamKB {
  return v === 0 || v === 512;
}

function isFastRamKB(v: unknown): v is 0 | 1024 | 2048 {
  return v === 0 || v === 1024 || v === 2048;
}

function isFrameSkipMode(v: unknown): v is FrameSkipMode {
  return v === 0 || v === 1 || v === 2;
}

function sanitizeVolume(v: unknown, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(1, Math.round(v * 100) / 100));
}

export function sanitizeAmigaConfig(
  raw: unknown,
  fallback: AmigaConfig = DEFAULT_AMIGA_CONFIG
): AmigaConfig {
  if (!raw || typeof raw !== 'object') {
    return { ...fallback };
  }
  const obj = raw as Record<string, unknown>;
  return {
    chipset: isChipset(obj.chipset) ? obj.chipset : fallback.chipset,
    videoStandard: isVideoStandard(obj.videoStandard) ? obj.videoStandard : fallback.videoStandard,
    chipRamKB: isChipRamKB(obj.chipRamKB) ? obj.chipRamKB : fallback.chipRamKB,
    slowRamKB: isSlowRamKB(obj.slowRamKB) ? obj.slowRamKB : fallback.slowRamKB,
    fastRamKB: isFastRamKB(obj.fastRamKB) ? obj.fastRamKB : fallback.fastRamKB,
    audioEnabled: typeof obj.audioEnabled === 'boolean' ? obj.audioEnabled : fallback.audioEnabled,
    audioVolume: sanitizeVolume(obj.audioVolume, fallback.audioVolume),
    audioLedFilter:
      typeof obj.audioLedFilter === 'boolean' ? obj.audioLedFilter : fallback.audioLedFilter,
    crtScanlines:
      typeof obj.crtScanlines === 'boolean' ? obj.crtScanlines : fallback.crtScanlines,
    overscan: isValidOverscanMode(obj.overscan) ? obj.overscan : fallback.overscan,
    autoCrop: typeof obj.autoCrop === 'boolean' ? obj.autoCrop : fallback.autoCrop,
    frameSkip: isFrameSkipMode(obj.frameSkip) ? obj.frameSkip : fallback.frameSkip,
    ecoCpuMode: typeof obj.ecoCpuMode === 'boolean' ? obj.ecoCpuMode : fallback.ecoCpuMode,
    hapticsEnabled:
      typeof obj.hapticsEnabled === 'boolean' ? obj.hapticsEnabled : fallback.hapticsEnabled,
    floppyAudioEnabled:
      typeof obj.floppyAudioEnabled === 'boolean'
        ? obj.floppyAudioEnabled
        : fallback.floppyAudioEnabled,
    turboFloppy: typeof obj.turboFloppy === 'boolean' ? obj.turboFloppy : fallback.turboFloppy,
    joystickConnected:
      typeof obj.joystickConnected === 'boolean'
        ? obj.joystickConnected
        : fallback.joystickConnected,
  };
}

export function loadSavedAmigaConfig(storage?: StorageLike | null): AmigaConfig {
  const store = resolveStorage(storage);
  if (!store) return { ...DEFAULT_AMIGA_CONFIG };

  let legacyOverscan: OverscanMode | undefined;
  let legacyTurboFloppy: boolean | undefined;

  try {
    const rawOverscan = store.getItem(LEGACY_OVERSCAN_STORAGE_KEY);
    if (isValidOverscanMode(rawOverscan)) {
      legacyOverscan = rawOverscan;
    }
    const rawTurbo = store.getItem(LEGACY_TURBO_FLOPPY_STORAGE_KEY);
    if (rawTurbo === '1' || rawTurbo === 'true') {
      legacyTurboFloppy = true;
    } else if (rawTurbo === '0' || rawTurbo === 'false') {
      legacyTurboFloppy = false;
    }
  } catch {
    // Ignore storage read errors
  }

  const baseFallback: AmigaConfig = {
    ...DEFAULT_AMIGA_CONFIG,
    ...(legacyOverscan !== undefined ? { overscan: legacyOverscan } : {}),
    ...(legacyTurboFloppy !== undefined ? { turboFloppy: legacyTurboFloppy } : {}),
  };

  try {
    const rawJson = store.getItem(SETTINGS_STORAGE_KEY);
    if (!rawJson) return baseFallback;
    const parsed: unknown = JSON.parse(rawJson);
    return sanitizeAmigaConfig(parsed, baseFallback);
  } catch {
    return baseFallback;
  }
}

export function saveAmigaConfig(config: AmigaConfig, storage?: StorageLike | null): void {
  const store = resolveStorage(storage);
  if (!store) return;
  try {
    const normalized = sanitizeAmigaConfig(config);
    store.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Ignore quota / private browsing storage errors
  }
}

export function hasConfigChanged(current: AmigaConfig, patch: Partial<AmigaConfig>): boolean {
  const keys = Object.keys(patch) as Array<keyof AmigaConfig>;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (patch[key] !== undefined && current[key] !== patch[key]) {
      return true;
    }
  }
  return false;
}

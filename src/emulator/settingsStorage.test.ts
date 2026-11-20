import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasConfigChanged,
  LEGACY_OVERSCAN_STORAGE_KEY,
  LEGACY_TURBO_FLOPPY_STORAGE_KEY,
  loadSavedAmigaConfig,
  sanitizeAmigaConfig,
  saveAmigaConfig,
  SETTINGS_STORAGE_KEY,
  StorageLike,
} from './settingsStorage';
import { AmigaConfig, DEFAULT_AMIGA_CONFIG } from './types';

function createMemoryStorage(initial: Record<string, string> = {}): StorageLike {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

test('loadSavedAmigaConfig returns defaults when storage is empty or unavailable', () => {
  assert.deepEqual(loadSavedAmigaConfig(null), DEFAULT_AMIGA_CONFIG);
  assert.deepEqual(loadSavedAmigaConfig(createMemoryStorage()), DEFAULT_AMIGA_CONFIG);
});

test('saveAmigaConfig and loadSavedAmigaConfig round-trip every setting cleanly', () => {
  const store = createMemoryStorage();
  const custom: AmigaConfig = {
    chipset: 'OCS',
    videoStandard: 'NTSC',
    chipRamKB: 512,
    slowRamKB: 0,
    fastRamKB: 2048,
    audioEnabled: false,
    audioVolume: 0.55,
    audioLedFilter: false,
    crtScanlines: true,
    overscan: 'tv',
    autoCrop: true,
    frameSkip: 2,
    ecoCpuMode: true,
    hapticsEnabled: false,
    floppyAudioEnabled: false,
    turboFloppy: true,
    joystickConnected: false,
  };

  saveAmigaConfig(custom, store);
  const loaded = loadSavedAmigaConfig(store);
  assert.deepEqual(loaded, custom);
});

test('loadSavedAmigaConfig migrates legacy overscan and turboFloppy keys when unified key is absent', () => {
  const store = createMemoryStorage({
    [LEGACY_OVERSCAN_STORAGE_KEY]: 'max',
    [LEGACY_TURBO_FLOPPY_STORAGE_KEY]: '1',
  });

  const loaded = loadSavedAmigaConfig(store);
  assert.equal(loaded.overscan, 'max');
  assert.equal(loaded.turboFloppy, true);
  assert.equal(loaded.chipset, DEFAULT_AMIGA_CONFIG.chipset);
});

test('sanitizeAmigaConfig rejects invalid values and clamps volume safely', () => {
  const dirty = {
    chipset: 'AGA',
    videoStandard: 'SECAM',
    chipRamKB: 999,
    slowRamKB: 256,
    fastRamKB: 4096,
    audioEnabled: 'yes',
    audioVolume: 3.5,
    audioLedFilter: 0,
    crtScanlines: true,
    overscan: 'huge',
    autoCrop: 'true',
    frameSkip: 9,
    ecoCpuMode: true,
    hapticsEnabled: false,
    floppyAudioEnabled: null,
    turboFloppy: true,
    joystickConnected: false,
  };

  const sanitized = sanitizeAmigaConfig(dirty);
  assert.equal(sanitized.chipset, DEFAULT_AMIGA_CONFIG.chipset);
  assert.equal(sanitized.videoStandard, DEFAULT_AMIGA_CONFIG.videoStandard);
  assert.equal(sanitized.chipRamKB, DEFAULT_AMIGA_CONFIG.chipRamKB);
  assert.equal(sanitized.slowRamKB, DEFAULT_AMIGA_CONFIG.slowRamKB);
  assert.equal(sanitized.fastRamKB, DEFAULT_AMIGA_CONFIG.fastRamKB);
  assert.equal(sanitized.audioEnabled, DEFAULT_AMIGA_CONFIG.audioEnabled);
  assert.equal(sanitized.audioVolume, 1);
  assert.equal(sanitized.audioLedFilter, DEFAULT_AMIGA_CONFIG.audioLedFilter);
  assert.equal(sanitized.crtScanlines, true);
  assert.equal(sanitized.overscan, DEFAULT_AMIGA_CONFIG.overscan);
  assert.equal(sanitized.autoCrop, DEFAULT_AMIGA_CONFIG.autoCrop);
  assert.equal(sanitized.frameSkip, DEFAULT_AMIGA_CONFIG.frameSkip);
  assert.equal(sanitized.ecoCpuMode, true);
  assert.equal(sanitized.hapticsEnabled, false);
  assert.equal(sanitized.floppyAudioEnabled, DEFAULT_AMIGA_CONFIG.floppyAudioEnabled);
  assert.equal(sanitized.turboFloppy, true);
  assert.equal(sanitized.joystickConnected, false);
});

test('loadSavedAmigaConfig handles corrupt JSON without throwing', () => {
  const store = createMemoryStorage({
    [SETTINGS_STORAGE_KEY]: '{not-valid-json',
  });
  assert.deepEqual(loadSavedAmigaConfig(store), DEFAULT_AMIGA_CONFIG);
});

test('hasConfigChanged avoids redundant state and storage writes on identical patches', () => {
  assert.equal(hasConfigChanged(DEFAULT_AMIGA_CONFIG, { chipset: 'ECS' }), false);
  assert.equal(hasConfigChanged(DEFAULT_AMIGA_CONFIG, { audioVolume: 1.0 }), false);
  assert.equal(hasConfigChanged(DEFAULT_AMIGA_CONFIG, { chipset: 'OCS' }), true);
  assert.equal(hasConfigChanged(DEFAULT_AMIGA_CONFIG, { crtScanlines: true }), true);
});

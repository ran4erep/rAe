import test from 'node:test';
import assert from 'node:assert/strict';
import { AMIGA_RAW } from '../keyboard/amigaKeyMap';
import {
  computeStickTransition,
  createDefaultStore,
  createNewProfile,
  CustomStickConfig,
  deleteProfileFromStore,
  EMPTY_STICK_DIRS,
  getActiveProfile,
  loadCustomProfilesStore,
  saveCustomProfilesStore,
} from './customControls';

test('computeStickTransition emits exact key presses and releases without stuck keys', () => {
  const stick: CustomStickConfig = {
    enabled: true,
    xPct: 16,
    yPct: 72,
    size: 'md',
    up: { kind: 'key', rawCode: AMIGA_RAW.W },
    down: { kind: 'key', rawCode: AMIGA_RAW.S },
    left: { kind: 'key', rawCode: AMIGA_RAW.A },
    right: { kind: 'key', rawCode: AMIGA_RAW.D },
  };

  // Center -> Up + Right diagonal
  const t1 = computeStickTransition(
    EMPTY_STICK_DIRS,
    { up: true, down: false, left: false, right: true },
    stick
  );
  assert.deepEqual(t1.keysDown.sort(), [AMIGA_RAW.W, AMIGA_RAW.D].sort());
  assert.deepEqual(t1.keysUp, []);
  assert.equal(t1.joyPatch, null);

  // Up + Right -> Up + Left (releases D, keeps W, presses A)
  const t2 = computeStickTransition(
    { up: true, down: false, left: false, right: true },
    { up: true, down: false, left: true, right: false },
    stick
  );
  assert.deepEqual(t2.keysDown, [AMIGA_RAW.A]);
  assert.deepEqual(t2.keysUp, [AMIGA_RAW.D]);

  // Up + Left -> Center (releases W and A)
  const t3 = computeStickTransition(
    { up: true, down: false, left: true, right: false },
    EMPTY_STICK_DIRS,
    stick
  );
  assert.deepEqual(t3.keysDown, []);
  assert.deepEqual(t3.keysUp.sort(), [AMIGA_RAW.W, AMIGA_RAW.A].sort());
});

test('computeStickTransition safely handles mixed joystick + key bindings and shared keys', () => {
  const stick: CustomStickConfig = {
    enabled: true,
    xPct: 16,
    yPct: 72,
    size: 'md',
    up: { kind: 'key', rawCode: AMIGA_RAW.SPACE },
    down: { kind: 'key', rawCode: AMIGA_RAW.SPACE },
    left: { kind: 'joy', dir: 'left' },
    right: { kind: 'joy', dir: 'right' },
  };

  // Up + Left
  const t1 = computeStickTransition(
    EMPTY_STICK_DIRS,
    { up: true, down: false, left: true, right: false },
    stick
  );
  assert.deepEqual(t1.keysDown, [AMIGA_RAW.SPACE]);
  assert.deepEqual(t1.joyPatch, { left: true });

  // Switch Up -> Down (both mapped to SPACE: SPACE must NOT release!)
  const t2 = computeStickTransition(
    { up: true, down: false, left: true, right: false },
    { up: false, down: true, left: false, right: true },
    stick
  );
  assert.deepEqual(t2.keysDown, []);
  assert.deepEqual(t2.keysUp, []);
  assert.deepEqual(t2.joyPatch, { left: false, right: true });

  // Release all
  const t3 = computeStickTransition(
    { up: false, down: true, left: false, right: true },
    EMPTY_STICK_DIRS,
    stick
  );
  assert.deepEqual(t3.keysUp, [AMIGA_RAW.SPACE]);
  assert.deepEqual(t3.joyPatch, { right: false });
});

test('custom profiles store persists and sanitizes safely in storage', () => {
  const mem = new Map<string, string>();
  const mockStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      mem.set(k, v);
    },
  };

  const initial = loadCustomProfilesStore(mockStorage);
  assert.ok(initial.profiles.length >= 3);

  const withCustom = createNewProfile(initial, 'Chaos Engine Custom');
  const active = getActiveProfile(withCustom);
  assert.equal(active.name, 'Chaos Engine Custom');
  active.stick.up = { kind: 'key', rawCode: AMIGA_RAW.SPACE };

  saveCustomProfilesStore(withCustom, mockStorage);
  const reloaded = loadCustomProfilesStore(mockStorage);
  assert.equal(reloaded.activeProfileId, active.id);
  const reloadedActive = getActiveProfile(reloaded);
  assert.equal(reloadedActive.name, 'Chaos Engine Custom');
  assert.deepEqual(reloadedActive.stick.up, { kind: 'key', rawCode: AMIGA_RAW.SPACE });

  // Deleting all but one never leaves empty store
  let pruned = reloaded;
  for (const p of [...reloaded.profiles]) {
    pruned = deleteProfileFromStore(pruned, p.id);
  }
  assert.equal(pruned.profiles.length, 1);

  // Corrupted storage falls back cleanly
  mem.set('amiga500_custom_control_profiles_v1', '{bad json');
  const fallback = loadCustomProfilesStore(mockStorage);
  assert.equal(fallback.profiles.length, createDefaultStore().profiles.length);
});

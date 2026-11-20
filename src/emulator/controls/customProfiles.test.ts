import test from 'node:test';
import assert from 'node:assert/strict';
import { AMIGA_RAW } from '../keyboard/amigaKeyMap';
import {
  computeStickTransition,
  createDefaultProfilesState,
  createDefaultStickConfig,
  createProfile,
  CustomStickConfig,
  deleteProfile,
  getActiveProfile,
  getTargetDisplayLabel,
  renameProfile,
  sanitizeProfilesState,
  updateActiveProfile,
} from './customProfiles';

test('default profile starts clean with no pre-built buttons or stick', () => {
  const state = createDefaultProfilesState();
  assert.equal(state.profiles.length, 1);
  const active = getActiveProfile(state);
  assert.equal(active.stick, null);
  assert.equal(active.buttons.length, 0);
});

test('computeStickTransition diffs key bindings cleanly across cardinal and diagonal moves', () => {
  const wasdStick: Pick<CustomStickConfig, 'up' | 'down' | 'left' | 'right'> = {
    up: { kind: 'key', code: AMIGA_RAW.W },
    down: { kind: 'key', code: AMIGA_RAW.S },
    left: { kind: 'key', code: AMIGA_RAW.A },
    right: { kind: 'key', code: AMIGA_RAW.D },
  };

  let active = new Map();

  let res = computeStickTransition(active, { up: true, down: false, left: false, right: false }, wasdStick);
  active = res.nextActiveMap;
  assert.deepEqual(res.actions, [{ target: { kind: 'key', code: AMIGA_RAW.W }, down: true }]);

  res = computeStickTransition(active, { up: true, down: false, left: false, right: true }, wasdStick);
  active = res.nextActiveMap;
  assert.deepEqual(res.actions, [{ target: { kind: 'key', code: AMIGA_RAW.D }, down: true }]);

  res = computeStickTransition(active, { up: false, down: false, left: false, right: true }, wasdStick);
  active = res.nextActiveMap;
  assert.deepEqual(res.actions, [{ target: { kind: 'key', code: AMIGA_RAW.W }, down: false }]);

  res = computeStickTransition(active, { up: false, down: false, left: false, right: false }, wasdStick);
  assert.equal(res.nextActiveMap.size, 0);
  assert.deepEqual(res.actions, [{ target: { kind: 'key', code: AMIGA_RAW.D }, down: false }]);
});

test('profile CRUD creates clean profile, adds stick/button, renames, and safely deletes', () => {
  let state = createDefaultProfilesState();
  state = createProfile(state, 'Chaos Engine');
  assert.equal(state.profiles.length, 2);
  assert.equal(getActiveProfile(state).name, 'Chaos Engine');
  assert.equal(getActiveProfile(state).stick, null);
  assert.equal(getActiveProfile(state).buttons.length, 0);

  const newId = state.activeProfileId;
  state = renameProfile(state, newId, 'Dune 2');
  assert.equal(getActiveProfile(state).name, 'Dune 2');

  state = updateActiveProfile(state, (p) => ({
    ...p,
    stick: createDefaultStickConfig(),
    buttons: [
      { id: 'b_extra', xPct: 50, yPct: 50, size: 'sm', target: { kind: 'key', code: AMIGA_RAW.F2 } },
    ],
  }));
  assert.ok(getActiveProfile(state).stick !== null);
  assert.equal(getActiveProfile(state).buttons.length, 1);

  state = deleteProfile(state, newId);
  assert.equal(state.profiles.length, 1);

  state = deleteProfile(state, state.profiles[0].id);
  assert.equal(state.profiles.length, 1);
  assert.equal(getActiveProfile(state).buttons.length, 0);
});

test('sanitizeProfilesState clamps out-of-bounds coordinates and handles null/corrupt input', () => {
  assert.equal(sanitizeProfilesState(null).profiles.length, 1);
  const sanitized = sanitizeProfilesState({
    activeProfileId: 'missing',
    profiles: [
      {
        id: 'p1',
        name: 'Test',
        stick: {
          xPct: -50,
          yPct: 200,
          size: 'invalid',
          up: { kind: 'key', code: AMIGA_RAW.UP },
          down: { kind: 'key', code: AMIGA_RAW.DOWN },
          left: { kind: 'key', code: AMIGA_RAW.LEFT },
          right: { kind: 'key', code: AMIGA_RAW.RIGHT },
        },
        buttons: [
          { id: 'b1', xPct: 120, yPct: -10, size: 'lg', target: { kind: 'key', code: AMIGA_RAW.SPACE } },
          { id: 'bad', xPct: 50, yPct: 50, target: { kind: 'key', code: 9999 } },
        ],
      },
    ],
  });

  assert.equal(sanitized.activeProfileId, 'p1');
  assert.equal(sanitized.profiles[0].stick?.xPct, 6);
  assert.equal(sanitized.profiles[0].stick?.yPct, 90);
  assert.equal(sanitized.profiles[0].stick?.size, 'md');
  assert.equal(sanitized.profiles[0].buttons.length, 1);
  assert.equal(sanitized.profiles[0].buttons[0].xPct, 96);
  assert.equal(sanitized.profiles[0].buttons[0].yPct, 6);
});

test('getTargetDisplayLabel formats keys, joystick, mouse, and custom overrides', () => {
  assert.equal(getTargetDisplayLabel({ kind: 'key', code: AMIGA_RAW.SPACE }), 'SPACE');
  assert.equal(getTargetDisplayLabel({ kind: 'joy', dir: 'fire1' }), 'FIRE 1');
  assert.equal(getTargetDisplayLabel({ kind: 'mouse', button: 'left' }), 'ЛКМ');
  assert.equal(getTargetDisplayLabel({ kind: 'key', code: AMIGA_RAW.F1 }, 'Меню'), 'Меню');
});

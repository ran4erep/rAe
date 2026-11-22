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
  dispatchTargetActions,
  expandControlTarget,
  getActiveProfile,
  getTargetAriaLabel,
  getTargetDisplayLabel,
  normalizeComboTargets,
  renameProfile,
  sanitizeProfilesState,
  TargetHoldManager,
  targetsEqual,
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
          { id: 'b_mmb_invalid', xPct: 75, yPct: 75, size: 'md', target: { kind: 'mouse', button: 'middle' } },
          { id: 'b_rmb', xPct: 75, yPct: 75, size: 'md', target: { kind: 'mouse', button: 'right' } },
          {
            id: 'b_combo',
            xPct: 60,
            yPct: 60,
            size: 'md',
            target: {
              kind: 'combo',
              targets: [
                { kind: 'key', code: AMIGA_RAW.LSHIFT },
                { kind: 'key', code: AMIGA_RAW.A },
              ],
            },
          },
          {
            id: 'b_combo_dup',
            xPct: 60,
            yPct: 60,
            target: {
              kind: 'combo',
              targets: [
                { kind: 'key', code: AMIGA_RAW.A },
                { kind: 'key', code: AMIGA_RAW.A },
              ],
            },
          },
          { id: 'bad', xPct: 50, yPct: 50, target: { kind: 'key', code: 9999 } },
        ],
      },
    ],
  });

  assert.equal(sanitized.activeProfileId, 'p1');
  assert.equal(sanitized.profiles[0].stick?.xPct, 6);
  assert.equal(sanitized.profiles[0].stick?.yPct, 90);
  assert.equal(sanitized.profiles[0].stick?.size, 'md');
  assert.equal(sanitized.profiles[0].buttons.length, 3);
  assert.equal(sanitized.profiles[0].buttons[0].xPct, 96);
  assert.equal(sanitized.profiles[0].buttons[0].yPct, 6);
  assert.deepEqual(sanitized.profiles[0].buttons[1].target, { kind: 'mouse', button: 'right' });
  assert.deepEqual(sanitized.profiles[0].buttons[2].target, {
    kind: 'combo',
    targets: [
      { kind: 'key', code: AMIGA_RAW.LSHIFT },
      { kind: 'key', code: AMIGA_RAW.A },
    ],
  });
});

test('getTargetDisplayLabel and dispatchTargetActions handle keys, joystick, L/R mouse, and combos', () => {
  assert.equal(getTargetDisplayLabel({ kind: 'key', code: AMIGA_RAW.SPACE }), 'SPACE');
  assert.equal(getTargetDisplayLabel({ kind: 'joy', dir: 'fire1' }), 'FIRE 1');
  assert.equal(getTargetDisplayLabel({ kind: 'mouse', button: 'left' }), 'ЛКМ');
  assert.equal(getTargetDisplayLabel({ kind: 'mouse', button: 'right' }), 'ПКМ');
  assert.equal(getTargetAriaLabel({ kind: 'mouse', button: 'right' }), 'Правая кнопка мыши');
  assert.equal(getTargetDisplayLabel({ kind: 'key', code: AMIGA_RAW.F1 }, 'Меню'), 'Меню');

  const shiftA = {
    kind: 'combo' as const,
    targets: [
      { kind: 'key' as const, code: AMIGA_RAW.LSHIFT },
      { kind: 'key' as const, code: AMIGA_RAW.A },
    ] as [
      { kind: 'key'; code: number },
      { kind: 'key'; code: number },
    ],
  };
  assert.equal(getTargetDisplayLabel(shiftA), 'L⇧+A');
  assert.equal(getTargetAriaLabel(shiftA), 'L-SHIFT + A');
  assert.equal(targetsEqual(shiftA, { ...shiftA }), true);

  const mouseCalls: Array<[boolean | undefined, boolean | undefined]> = [];
  dispatchTargetActions(
    [
      { target: { kind: 'mouse', button: 'left' }, down: true },
      { target: { kind: 'mouse', button: 'right' }, down: false },
    ],
    {
      onKeyEvent: () => {},
      onJoystickChange: () => {},
      onMouseButton: (l, r) => mouseCalls.push([l, r]),
    }
  );
  assert.deepEqual(mouseCalls, [[true, false]]);
});

test('normalizeComboTargets puts modifiers first and TargetHoldManager ref-counts overlapping combos cleanly', () => {
  assert.deepEqual(
    normalizeComboTargets(
      { kind: 'key', code: AMIGA_RAW.A },
      { kind: 'key', code: AMIGA_RAW.LSHIFT }
    ),
    [
      { kind: 'key', code: AMIGA_RAW.LSHIFT },
      { kind: 'key', code: AMIGA_RAW.A },
    ]
  );

  const mgr = new TargetHoldManager();
  const comboShiftA = expandControlTarget({
    kind: 'combo',
    targets: [
      { kind: 'key', code: AMIGA_RAW.LSHIFT },
      { kind: 'key', code: AMIGA_RAW.A },
    ],
  });
  const comboShiftB = expandControlTarget({
    kind: 'combo',
    targets: [
      { kind: 'key', code: AMIGA_RAW.LSHIFT },
      { kind: 'key', code: AMIGA_RAW.B },
    ],
  });

  // Press Shift+A: presses LSHIFT first, then A
  assert.deepEqual(mgr.setSource('btn:1', comboShiftA), [
    { target: { kind: 'key', code: AMIGA_RAW.LSHIFT }, down: true },
    { target: { kind: 'key', code: AMIGA_RAW.A }, down: true },
  ]);

  // Press Shift+B while Shift+A is held: LSHIFT stays held, only B presses
  assert.deepEqual(mgr.setSource('btn:2', comboShiftB), [
    { target: { kind: 'key', code: AMIGA_RAW.B }, down: true },
  ]);

  // Release Shift+A: only A releases, LSHIFT stays held because btn:2 holds it
  assert.deepEqual(mgr.setSource('btn:1', []), [
    { target: { kind: 'key', code: AMIGA_RAW.A }, down: false },
  ]);

  // Release Shift+B: releases B first (reverse order), then LSHIFT
  assert.deepEqual(mgr.setSource('btn:2', []), [
    { target: { kind: 'key', code: AMIGA_RAW.B }, down: false },
    { target: { kind: 'key', code: AMIGA_RAW.LSHIFT }, down: false },
  ]);

  // Test releaseAll releases non-modifiers before modifiers
  mgr.setSource('btn:1', comboShiftA);
  assert.deepEqual(mgr.releaseAll(), [
    { target: { kind: 'key', code: AMIGA_RAW.A }, down: false },
    { target: { kind: 'key', code: AMIGA_RAW.LSHIFT }, down: false },
  ]);
});

test('computeStickTransition expands combo bindings and preserves shared modifiers across diagonals', () => {
  const comboStick: Pick<CustomStickConfig, 'up' | 'down' | 'left' | 'right'> = {
    up: {
      kind: 'combo',
      targets: [
        { kind: 'key', code: AMIGA_RAW.LSHIFT },
        { kind: 'key', code: AMIGA_RAW.W },
      ],
    },
    down: { kind: 'key', code: AMIGA_RAW.S },
    left: { kind: 'key', code: AMIGA_RAW.A },
    right: {
      kind: 'combo',
      targets: [
        { kind: 'key', code: AMIGA_RAW.LSHIFT },
        { kind: 'key', code: AMIGA_RAW.D },
      ],
    },
  };

  let active = new Map();
  let res = computeStickTransition(active, { up: true, down: false, left: false, right: false }, comboStick);
  active = res.nextActiveMap;
  assert.deepEqual(res.actions, [
    { target: { kind: 'key', code: AMIGA_RAW.LSHIFT }, down: true },
    { target: { kind: 'key', code: AMIGA_RAW.W }, down: true },
  ]);

  res = computeStickTransition(active, { up: true, down: false, left: false, right: true }, comboStick);
  active = res.nextActiveMap;
  assert.deepEqual(res.actions, [{ target: { kind: 'key', code: AMIGA_RAW.D }, down: true }]);

  res = computeStickTransition(active, { up: false, down: false, left: false, right: false }, comboStick);
  assert.equal(res.nextActiveMap.size, 0);
  assert.deepEqual(res.actions, [
    { target: { kind: 'key', code: AMIGA_RAW.D }, down: false },
    { target: { kind: 'key', code: AMIGA_RAW.W }, down: false },
    { target: { kind: 'key', code: AMIGA_RAW.LSHIFT }, down: false },
  ]);
});


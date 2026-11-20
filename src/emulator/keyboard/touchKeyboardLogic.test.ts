import test from 'node:test';
import assert from 'node:assert/strict';
import { AMIGA_RAW } from './amigaKeyMap';
import { TouchKeyboardController } from './touchKeyboardLogic';

test('Modifier does NOT latch when tapped alone (releases immediately on pointerUp)', () => {
  const ctrl = new TouchKeyboardController();
  const down = ctrl.pointerDown(1, AMIGA_RAW.LSHIFT);
  assert.deepEqual(down, [{ type: 'key', code: AMIGA_RAW.LSHIFT, down: true }]);
  assert.equal(ctrl.isShiftActive(), true);

  const up = ctrl.pointerUp(1);
  assert.deepEqual(up, [{ type: 'key', code: AMIGA_RAW.LSHIFT, down: false }]);
  assert.equal(ctrl.isShiftActive(), false);
});

test('Multi-touch allows holding Shift with one finger while typing another key with a second finger', () => {
  const ctrl = new TouchKeyboardController();

  assert.deepEqual(ctrl.pointerDown(1, AMIGA_RAW.LSHIFT), [
    { type: 'key', code: AMIGA_RAW.LSHIFT, down: true },
  ]);
  assert.deepEqual(ctrl.pointerDown(2, AMIGA_RAW.A), [
    { type: 'key', code: AMIGA_RAW.A, down: true },
  ]);
  assert.equal(ctrl.isShiftActive(), true);
  assert.equal(ctrl.isKeyPressed(AMIGA_RAW.A), true);

  // Release A while Shift remains held
  assert.deepEqual(ctrl.pointerUp(2), [
    { type: 'key', code: AMIGA_RAW.A, down: false },
  ]);
  assert.equal(ctrl.isShiftActive(), true);
  assert.equal(ctrl.isKeyPressed(AMIGA_RAW.A), false);

  // Release Shift
  assert.deepEqual(ctrl.pointerUp(1), [
    { type: 'key', code: AMIGA_RAW.LSHIFT, down: false },
  ]);
  assert.equal(ctrl.isShiftActive(), false);
});

test('Slide from Shift onto another key and release types target key with Shift held and releases both', () => {
  const ctrl = new TouchKeyboardController();

  assert.deepEqual(ctrl.pointerDown(10, AMIGA_RAW.LSHIFT), [
    { type: 'key', code: AMIGA_RAW.LSHIFT, down: true },
  ]);

  // Drag finger over KEY_1 ('1' / '!')
  assert.equal(ctrl.pointerMove(10, AMIGA_RAW.KEY_1), true);
  assert.equal(ctrl.isKeyPressed(AMIGA_RAW.KEY_1), true);
  assert.equal(ctrl.isShiftActive(), true);

  // Drag further onto KEY_2 ('2' / '@')
  assert.equal(ctrl.pointerMove(10, AMIGA_RAW.KEY_2), true);
  assert.equal(ctrl.isKeyPressed(AMIGA_RAW.KEY_1), false);
  assert.equal(ctrl.isKeyPressed(AMIGA_RAW.KEY_2), true);

  // Release on KEY_2: presses KEY_2 down while LSHIFT is still down, then schedules delayed release
  const upActions = ctrl.pointerUp(10);
  assert.deepEqual(upActions, [
    { type: 'key', code: AMIGA_RAW.KEY_2, down: true },
    { type: 'delayedCombo', code: AMIGA_RAW.KEY_2, modifierCode: AMIGA_RAW.LSHIFT },
  ]);

  // Complete delayed combo releases LSHIFT cleanly
  const completeActions = ctrl.completeDelayedCombo(AMIGA_RAW.LSHIFT);
  assert.deepEqual(completeActions, [
    { type: 'key', code: AMIGA_RAW.LSHIFT, down: false },
  ]);
  assert.equal(ctrl.isShiftActive(), false);
});

test('Regular non-modifier key does not accidentally slide onto adjacent keys', () => {
  const ctrl = new TouchKeyboardController();
  ctrl.pointerDown(5, AMIGA_RAW.Q);
  assert.equal(ctrl.pointerMove(5, AMIGA_RAW.W), false);
  assert.deepEqual(ctrl.pointerUp(5), [{ type: 'key', code: AMIGA_RAW.Q, down: false }]);
});

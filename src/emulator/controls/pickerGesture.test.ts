import test from 'node:test';
import assert from 'node:assert/strict';
import { AMIGA_RAW } from '../keyboard/amigaKeyMap';
import { PickerGestureSession } from './pickerGesture';

test('single tap waits for pointerUp before committing single target', () => {
  const session = new PickerGestureSession();
  const space = { kind: 'key' as const, code: AMIGA_RAW.SPACE };

  session.pointerDown(1, space);
  assert.equal(session.getSnapshot().isCapturing, true);
  assert.deepEqual(session.getSnapshot().heldTargets, [space]);

  const result = session.pointerUp(1);
  assert.deepEqual(result, space);
  assert.equal(session.getSnapshot().isCapturing, false);
});

test('holding Shift and pressing A waits until both fingers are released and produces Shift+A combo', () => {
  const session = new PickerGestureSession();
  const lshift = { kind: 'key' as const, code: AMIGA_RAW.LSHIFT };
  const keyA = { kind: 'key' as const, code: AMIGA_RAW.A };

  // Finger 1 holds Left Shift
  session.pointerDown(1, lshift);
  assert.equal(session.getSnapshot().capturedTargets.length, 1);

  // Finger 2 presses A
  session.pointerDown(2, keyA);
  assert.equal(session.getSnapshot().capturedTargets.length, 2);

  // Finger 2 releases A first — still waiting for Finger 1!
  assert.equal(session.pointerUp(2), null);
  assert.equal(session.getSnapshot().isCapturing, true);

  // Finger 1 releases Left Shift — now all fingers are up, commits combo!
  const result = session.pointerUp(1);
  assert.deepEqual(result, {
    kind: 'combo',
    targets: [lshift, keyA],
  });
});

test('releasing Shift before second key still waits for second finger release', () => {
  const session = new PickerGestureSession();
  const lshift = { kind: 'key' as const, code: AMIGA_RAW.LSHIFT };
  const keyF1 = { kind: 'key' as const, code: AMIGA_RAW.F1 };

  session.pointerDown(1, lshift);
  session.pointerDown(2, keyF1);

  // Release Shift first
  assert.equal(session.pointerUp(1), null);
  // Release F1 second -> commits combo
  assert.deepEqual(session.pointerUp(2), {
    kind: 'combo',
    targets: [lshift, keyF1],
  });
});

test('pressing non-modifier first and Shift second normalizes Shift to first slot', () => {
  const session = new PickerGestureSession();
  const keyQ = { kind: 'key' as const, code: AMIGA_RAW.Q };
  const rshift = { kind: 'key' as const, code: AMIGA_RAW.RSHIFT };

  session.pointerDown(1, keyQ);
  session.pointerDown(2, rshift);
  assert.equal(session.pointerUp(2), null);
  assert.deepEqual(session.pointerUp(1), {
    kind: 'combo',
    targets: [rshift, keyQ],
  });
});

test('tapping another key while holding Shift replaces second key in combo', () => {
  const session = new PickerGestureSession();
  const lshift = { kind: 'key' as const, code: AMIGA_RAW.LSHIFT };
  const keyA = { kind: 'key' as const, code: AMIGA_RAW.A };
  const keyB = { kind: 'key' as const, code: AMIGA_RAW.B };

  session.pointerDown(1, lshift);
  session.pointerDown(2, keyA);
  assert.equal(session.pointerUp(2), null);

  // Oops, wanted B instead of A while still holding Shift
  session.pointerDown(3, keyB);
  assert.equal(session.pointerUp(3), null);

  assert.deepEqual(session.pointerUp(1), {
    kind: 'combo',
    targets: [lshift, keyB],
  });
});

test('physical keyboard chord waits until all physical keys are released', () => {
  const session = new PickerGestureSession();
  const ctrl = { kind: 'key' as const, code: AMIGA_RAW.CTRL };
  const keyC = { kind: 'key' as const, code: AMIGA_RAW.C };

  session.physicalKeyDown('ControlLeft', ctrl);
  // Ignore key repeat
  session.physicalKeyDown('ControlLeft', ctrl);
  session.physicalKeyDown('KeyC', keyC);

  assert.equal(session.physicalKeyUp('KeyC'), null);
  assert.deepEqual(session.physicalKeyUp('ControlLeft'), {
    kind: 'combo',
    targets: [ctrl, keyC],
  });
});

test('pointerCancel clears abandoned gesture without false commit', () => {
  const session = new PickerGestureSession();
  session.pointerDown(1, { kind: 'key', code: AMIGA_RAW.ESC });
  session.pointerCancel(1);
  assert.equal(session.getSnapshot().isCapturing, false);
  assert.equal(session.getSnapshot().capturedTargets.length, 0);
});

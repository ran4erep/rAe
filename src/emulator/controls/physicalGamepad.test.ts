import test from 'node:test';
import assert from 'node:assert/strict';
import { AMIGA_RAW } from '../keyboard/amigaKeyMap';
import { JoystickState } from '../types';
import {
  GamepadButtonLike,
  GamepadLike,
  hasAnyConnectedGamepad,
  PhysicalGamepadSink,
  PhysicalGamepadTracker,
} from './physicalGamepad';

function makePad(
  axes: number[] = [0, 0, 0, 0],
  pressedIndices: number[] = [],
  connected = true
): GamepadLike {
  const buttons: GamepadButtonLike[] = Array.from({ length: 16 }, (_, idx) => ({
    pressed: pressedIndices.includes(idx),
    value: pressedIndices.includes(idx) ? 1 : 0,
  }));
  return { connected, axes, buttons };
}

function createMockSink() {
  const joy: JoystickState = {
    up: false,
    down: false,
    left: false,
    right: false,
    fire1: false,
    fire2: false,
  };
  const keyEvents: Array<{ code: number; down: boolean }> = [];
  const mouseEvents: Array<{ left?: boolean; right?: boolean }> = [];
  let joyCalls = 0;
  let pressWakes = 0;

  const sink: PhysicalGamepadSink = {
    setJoystick: (patch) => {
      joyCalls++;
      Object.assign(joy, patch);
    },
    setKey: (code, down) => {
      keyEvents.push({ code, down });
    },
    setMouseButtons: (left, right) => {
      mouseEvents.push({ left, right });
    },
    onAnyPress: () => {
      pressWakes++;
    },
  };

  return {
    joy,
    keyEvents,
    mouseEvents,
    getJoyCalls: () => joyCalls,
    getPressWakes: () => pressWakes,
    sink,
  };
}

test('PhysicalGamepadTracker maps left stick, A/B, X/Y, L1/R1, and Start accurately and only on edge transitions', () => {
  const tracker = new PhysicalGamepadTracker();
  const mock = createMockSink();

  // Idle frame -> no calls
  tracker.poll([makePad([0.1, -0.1], [])], mock.sink);
  assert.equal(mock.getJoyCalls(), 0);
  assert.equal(mock.keyEvents.length, 0);
  assert.equal(mock.mouseEvents.length, 0);

  // Move stick up-left + press A (0) + X (2) + L1 (4) + Start (9)
  tracker.poll([makePad([-0.8, -0.7], [0, 2, 4, 9])], mock.sink);
  assert.deepEqual(mock.joy, {
    up: true,
    down: false,
    left: true,
    right: false,
    fire1: true,
    fire2: false,
  });
  assert.deepEqual(mock.keyEvents, [
    { code: AMIGA_RAW.SPACE, down: true },
    { code: AMIGA_RAW.ESC, down: true },
  ]);
  assert.deepEqual(mock.mouseEvents, [{ left: true, right: undefined }]);
  assert.equal(mock.getPressWakes(), 1);

  // Polling identical state again emits zero calls
  tracker.poll([makePad([-0.8, -0.7], [0, 2, 4, 9])], mock.sink);
  assert.equal(mock.getJoyCalls(), 1);
  assert.equal(mock.keyEvents.length, 2);
  assert.equal(mock.mouseEvents.length, 1);

  // Release X & L1, press B (1), Y (3), R1 (5), move stick down-right
  tracker.poll([makePad([0.9, 0.9], [0, 1, 3, 5, 9])], mock.sink);
  assert.deepEqual(mock.joy, {
    up: false,
    down: true,
    left: false,
    right: true,
    fire1: true,
    fire2: true,
  });
  assert.deepEqual(mock.keyEvents.slice(2), [
    { code: AMIGA_RAW.SPACE, down: false },
    { code: AMIGA_RAW.RETURN, down: true },
  ]);
  assert.deepEqual(mock.mouseEvents.slice(1), [{ left: false, right: true }]);

  // releaseAll resets every held state cleanly
  tracker.releaseAll(mock.sink);
  assert.deepEqual(mock.joy, {
    up: false,
    down: false,
    left: false,
    right: false,
    fire1: false,
    fire2: false,
  });
  assert.deepEqual(mock.keyEvents.slice(4), [
    { code: AMIGA_RAW.RETURN, down: false },
    { code: AMIGA_RAW.ESC, down: false },
  ]);
  assert.deepEqual(mock.mouseEvents.slice(2), [{ left: undefined, right: false }]);
});

test('PhysicalGamepadTracker also supports D-pad (buttons 12..15) and detects connected pads safely', () => {
  assert.equal(hasAnyConnectedGamepad([null, undefined]), false);
  assert.equal(hasAnyConnectedGamepad([null, makePad([0, 0], [], false)]), false);
  assert.equal(hasAnyConnectedGamepad([null, makePad([0, 0], [], true)]), true);

  const tracker = new PhysicalGamepadTracker();
  const mock = createMockSink();

  tracker.poll([null, makePad([0, 0], [12, 15])], mock.sink);
  assert.deepEqual(mock.joy, {
    up: true,
    down: false,
    left: false,
    right: true,
    fire1: false,
    fire2: false,
  });
});

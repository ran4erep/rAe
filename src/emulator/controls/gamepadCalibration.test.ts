import test from 'node:test';
import assert from 'node:assert/strict';
import { AMIGA_RAW } from '../keyboard/amigaKeyMap';
import { StorageLike } from '../settingsStorage';
import {
  captureGamepadBaseline,
  countCalibratedBindings,
  detectGamepadCalibrationInput,
  formatGamepadInputSource,
  GamepadCalibrationProfile,
  isGamepadAtRest,
  loadGamepadCalibration,
  saveGamepadCalibration,
} from './gamepadCalibration';
import { GamepadButtonLike, GamepadLike, PhysicalGamepadSink, PhysicalGamepadTracker } from './physicalGamepad';
import { JoystickState } from '../types';

function makePad(axes: number[], pressedButtons: number[] = []): GamepadLike {
  const buttons: GamepadButtonLike[] = Array.from({ length: 16 }, (_, idx) => ({
    pressed: pressedButtons.includes(idx),
    value: pressedButtons.includes(idx) ? 1 : 0,
  }));
  return { id: 'Exotic DirectInput Pad', connected: true, axes, buttons };
}

function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

test('detectGamepadCalibrationInput detects buttons, standard axes, trigger axes, and DirectInput POV hat switches', () => {
  // Exotic pad where axis 9 rests at 3.2857 (DirectInput POV hat) and axis 2 rests at -1 (trigger)
  const restPad = makePad([0, 0, -1, 0, 0, 0, 0, 0, 0, 3.2857], []);
  const baseline = captureGamepadBaseline(restPad);

  assert.equal(isGamepadAtRest(restPad, baseline), true);
  assert.equal(detectGamepadCalibrationInput(restPad, baseline), null);

  // Detect exotic button #7
  const btnPad = makePad([0, 0, -1, 0, 0, 0, 0, 0, 0, 3.2857], [7]);
  assert.equal(isGamepadAtRest(btnPad, baseline), false);
  assert.deepEqual(detectGamepadCalibrationInput(btnPad, baseline), { kind: 'button', index: 7 });

  // Detect standard axis #3 negative
  const axisPad = makePad([0, 0, -1, -0.85, 0, 0, 0, 0, 0, 3.2857], []);
  assert.deepEqual(detectGamepadCalibrationInput(axisPad, baseline), {
    kind: 'axis',
    index: 3,
    dir: -1,
    rest: 0,
  });

  // Detect trigger axis #2 resting at -1 pressed to +0.8
  const triggerPad = makePad([0, 0, 0.8, 0, 0, 0, 0, 0, 0, 3.2857], []);
  assert.deepEqual(detectGamepadCalibrationInput(triggerPad, baseline), {
    kind: 'axis',
    index: 2,
    dir: 1,
    rest: -1,
  });

  // Detect POV hat axis #9 (resting at 3.2857 -> UP is -1)
  const hatPad = makePad([0, 0, -1, 0, 0, 0, 0, 0, 0, -1], []);
  assert.deepEqual(detectGamepadCalibrationInput(hatPad, baseline), {
    kind: 'hat',
    index: 9,
    value: -1,
    rest: 3.286,
  });
});

test('PhysicalGamepadTracker uses calibrated profile for exotic gamepads and persists cleanly', () => {
  const profile: GamepadCalibrationProfile = {
    version: 1,
    padId: 'Exotic USB Arcade Stick',
    updatedAt: 123456,
    bindings: {
      up: { kind: 'hat', index: 9, value: -1, rest: 3.286 },
      down: { kind: 'hat', index: 9, value: 0.143, rest: 3.286 },
      left: { kind: 'axis', index: 2, dir: -1, rest: 0 },
      right: { kind: 'axis', index: 2, dir: 1, rest: 0 },
      fire1: { kind: 'button', index: 11 },
      fire2: null,
      space: { kind: 'button', index: 6 },
      return: { kind: 'button', index: 7 },
      lmb: { kind: 'button', index: 8 },
      rmb: { kind: 'button', index: 10 },
      esc: { kind: 'button', index: 12 },
    },
  };

  const storage = createMemoryStorage();
  saveGamepadCalibration(profile, storage);
  const loaded = loadGamepadCalibration(storage);
  assert.deepEqual(loaded, profile);
  assert.equal(countCalibratedBindings(loaded), 10);
  assert.equal(formatGamepadInputSource(profile.bindings.fire1), 'Кнопка #12');
  assert.equal(formatGamepadInputSource(null), 'Пропущено');

  const tracker = new PhysicalGamepadTracker();
  tracker.setCalibration(loaded);

  const joy: JoystickState = {
    up: false,
    down: false,
    left: false,
    right: false,
    fire1: false,
    fire2: false,
  };
  const keys: Array<{ code: number; down: boolean }> = [];
  const mouse: Array<{ left?: boolean; right?: boolean }> = [];
  const sink: PhysicalGamepadSink = {
    setJoystick: (patch) => Object.assign(joy, patch),
    setKey: (code, down) => keys.push({ code, down }),
    setMouseButtons: (left, right) => mouse.push({ left, right }),
  };

  // Press POV hat UP (-1), axis 2 right (+0.9), button 11 (Fire1), button 6 (Space), button 8 (LMB)
  tracker.poll([makePad([0, 0, 0.9, 0, 0, 0, 0, 0, 0, -1], [11, 6, 8])], sink);
  assert.deepEqual(joy, {
    up: true,
    down: false,
    left: false,
    right: true,
    fire1: true,
    fire2: false,
  });
  assert.deepEqual(keys, [{ code: AMIGA_RAW.SPACE, down: true }]);
  assert.deepEqual(mouse, [{ left: true, right: undefined }]);

  // Release all
  tracker.poll([makePad([0, 0, 0, 0, 0, 0, 0, 0, 0, 3.2857], [])], sink);
  assert.deepEqual(joy, {
    up: false,
    down: false,
    left: false,
    right: false,
    fire1: false,
    fire2: false,
  });
  assert.deepEqual(keys, [
    { code: AMIGA_RAW.SPACE, down: true },
    { code: AMIGA_RAW.SPACE, down: false },
  ]);
  assert.deepEqual(mouse, [
    { left: true, right: undefined },
    { left: false, right: undefined },
  ]);
});

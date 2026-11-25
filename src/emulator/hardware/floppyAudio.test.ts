import test from 'node:test';
import assert from 'node:assert/strict';
import { FloppySoundStateMachine } from './floppyAudio';

test('UAE driveclick state machine plays snatch -> spin on first motor start with disk, then startup -> spin afterwards', () => {
  const sm = new FloppySoundStateMachine();
  sm.onInsert(0, true);

  const firstStart = sm.onMotor(0, true);
  assert.equal(firstStart.length, 1);
  assert.deepEqual(firstStart[0], {
    type: 'startMotor',
    drive: 0,
    intro: 'snatch',
    loop: 'spin',
    volume: 0.45,
  });

  const stop1 = sm.onMotor(0, false);
  assert.deepEqual(stop1, [{ type: 'stopMotor', drive: 0 }]);

  // Second motor start with same disk uses `startup` instead of `snatch`
  const secondStart = sm.onMotor(0, true);
  assert.deepEqual(secondStart, [
    {
      type: 'startMotor',
      drive: 0,
      intro: 'startup',
      loop: 'spin',
      volume: 0.45,
    },
  ]);

  // Eject resets hasSpun; re-inserting triggers `snatch` again
  sm.onMotor(0, false);
  sm.onInsert(0, false);
  sm.onInsert(0, true);
  const afterReinsert = sm.onMotor(0, true);
  assert.equal(afterReinsert[0].type, 'startMotor');
  if (afterReinsert[0].type === 'startMotor') {
    assert.equal(afterReinsert[0].intro, 'snatch');
  }
});

test('UAE driveclick plays spinnd at attenuated volume when spinning without a disk', () => {
  const sm = new FloppySoundStateMachine();
  const emptySpin = sm.onMotor(1, true);
  assert.deepEqual(emptySpin, [
    {
      type: 'startMotor',
      drive: 1,
      intro: 'startup',
      loop: 'spinnd',
      volume: 0.14,
    },
  ]);
});

test('UAE driveclick suppresses idle polling clicks when drive is empty and motor is off', () => {
  const sm = new FloppySoundStateMachine();
  assert.deepEqual(sm.onStep(0, 1), []);
  assert.deepEqual(sm.onStep(0, 0), []);
});

test('UAE driveclick noclick suppresses repeated step at cylinder 0 -> 0 and emits track click when motor is on or disk is inserted', () => {
  const sm = new FloppySoundStateMachine();
  sm.onMotor(0, true);
  // Initial prevCyl is 0; stepping to 0 is silenced ("noclick")
  assert.deepEqual(sm.onStep(0, 0), []);

  // Stepping to cylinder 1 with motor on & no disk emits attenuated click
  const step1 = sm.onStep(0, 1);
  assert.equal(step1.length, 1);
  assert.equal(step1[0].type, 'click');
  if (step1[0].type === 'click') {
    assert.equal(step1[0].cylinder, 1);
    assert.equal(step1[0].volume, 0.24);
  }

  // With disk inserted, steps emit full-volume clicks even during recalibration
  sm.onMotor(0, false);
  sm.onInsert(0, true);
  const step0 = sm.onStep(0, 0);
  assert.equal(step0.length, 1);
  if (step0[0].type === 'click') {
    assert.equal(step0[0].volume, 0.6);
  }
  // Stepping 0 -> 0 again is silenced
  assert.deepEqual(sm.onStep(0, 0), []);
});

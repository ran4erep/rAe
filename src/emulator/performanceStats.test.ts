import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyEmuPerf, evaluateEmuPerformance } from './performanceStats';

test('evaluateEmuPerformance reports optimal 100% speed even when internal Amiga game lags (low host frame time)', () => {
  const perf = evaluateEmuPerformance({
    paused: false,
    videoStandard: 'PAL',
    steps: 50,
    renderedFrames: 50,
    droppedFrames: 0,
    elapsedMs: 1000,
    coreMsSum: 95, // 1.9 ms/frame
    blitMsSum: 25, // 0.5 ms/frame
  });

  assert.equal(perf.verdict, 'optimal');
  assert.equal(perf.targetHz, 50);
  assert.equal(perf.budgetMs, 20);
  assert.equal(perf.speedPct, 100);
  assert.equal(perf.emulatedHz, 50);
  assert.equal(perf.coreMs, 1.9);
  assert.equal(perf.blitMs, 0.5);
  assert.equal(perf.frameMs, 2.4);
  assert.equal(perf.loadPct, 12);
  assert.equal(perf.droppedPerSec, 0);
});

test('evaluateEmuPerformance absorbs minor 60Hz-rAF PAL beat jitter when no frames were dropped', () => {
  const perf = evaluateEmuPerformance({
    paused: false,
    videoStandard: 'PAL',
    steps: 49,
    renderedFrames: 49,
    droppedFrames: 0,
    elapsedMs: 1002,
    coreMsSum: 100,
    blitMsSum: 20,
  });

  assert.equal(perf.speedPct, 100);
  assert.equal(perf.verdict, 'optimal');
});

test('evaluateEmuPerformance flags tight when host load approaches budget or frames drop slightly', () => {
  const perf = evaluateEmuPerformance({
    paused: false,
    videoStandard: 'PAL',
    steps: 46,
    renderedFrames: 46,
    droppedFrames: 2,
    elapsedMs: 1000,
    coreMsSum: 700,
    blitMsSum: 140,
  });

  assert.equal(perf.verdict, 'tight');
  assert.equal(perf.speedPct, 92);
  assert.equal(perf.loadPct, 91);
  assert.equal(perf.droppedPerSec, 2);
});

test('evaluateEmuPerformance flags lagging when emulation falls behind real-time or exceeds budget', () => {
  const perf = evaluateEmuPerformance({
    paused: false,
    videoStandard: 'NTSC',
    steps: 36,
    renderedFrames: 36,
    droppedFrames: 12,
    elapsedMs: 1000,
    coreMsSum: 720, // 20 ms/frame on 16.67 ms NTSC budget
    blitMsSum: 108, // 3 ms/frame
  });

  assert.equal(perf.verdict, 'lagging');
  assert.equal(perf.targetHz, 60);
  assert.equal(perf.speedPct, 60);
  assert.equal(perf.frameMs, 23);
  assert.equal(perf.loadPct, 138);
});

test('evaluateEmuPerformance returns paused verdict cleanly without NaN', () => {
  const perf = evaluateEmuPerformance({
    paused: true,
    videoStandard: 'PAL',
    steps: 0,
    renderedFrames: 0,
    droppedFrames: 0,
    elapsedMs: 0,
    coreMsSum: 0,
    blitMsSum: 0,
  });
  assert.equal(perf.verdict, 'paused');
  assert.equal(perf.speedPct, 0);
  const empty = createEmptyEmuPerf('NTSC');
  assert.equal(empty.targetHz, 60);
  assert.equal(empty.verdict, 'warming');
});

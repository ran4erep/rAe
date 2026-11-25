import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCpuCyclesPerScanline,
  CPU_OVERCLOCK_MAX_MULTIPLIER,
  ECO_A1200_CYCLES_PER_SCANLINE,
  ECO_A500_CYCLES_PER_SCANLINE,
  getEffectiveCpuMhz,
  getEffectiveOverclockMultiplier,
  NTSC_CYCLES_PER_SCANLINE,
  overclockMultiplierFromMhz,
  PAL_CYCLES_PER_SCANLINE,
  sanitizeCpuOverclock,
} from './cpuOverclock';

test('computeCpuCyclesPerScanline scales up to 100 MHz ceiling on both A500 and A1200', () => {
  assert.equal(computeCpuCyclesPerScanline(false, true, false, 1), PAL_CYCLES_PER_SCANLINE);
  assert.equal(computeCpuCyclesPerScanline(false, false, false, 1), NTSC_CYCLES_PER_SCANLINE);
  assert.equal(computeCpuCyclesPerScanline(false, true, false, 1.5), Math.round(PAL_CYCLES_PER_SCANLINE * 1.5));
  assert.equal(computeCpuCyclesPerScanline(false, true, false, 10), PAL_CYCLES_PER_SCANLINE * 10);

  // Always returns an exact integer for chipset.getHpos() and cpu.runCycles()
  assert.equal(Number.isInteger(computeCpuCyclesPerScanline(false, false, false, 7.3)), true);

  // A1200 base clock is 2x A500 (14.18 MHz), both cap cleanly at 100.0 MHz (6400 PAL cycles/line)
  assert.equal(computeCpuCyclesPerScanline(true, true, false, 1), PAL_CYCLES_PER_SCANLINE * 2);
  assert.equal(computeCpuCyclesPerScanline(false, true, false, 14.2), 6400);
  assert.equal(computeCpuCyclesPerScanline(true, true, false, 14.2), 6400);

  // Eco mode applies only when overclock is 1x; overclock > 1 overrides eco mode
  assert.equal(computeCpuCyclesPerScanline(false, true, true, 1), ECO_A500_CYCLES_PER_SCANLINE);
  assert.equal(computeCpuCyclesPerScanline(true, true, true, 1), ECO_A1200_CYCLES_PER_SCANLINE);
  assert.equal(computeCpuCyclesPerScanline(false, true, true, 1.8), Math.round(PAL_CYCLES_PER_SCANLINE * 1.8));
});

test('getEffectiveCpuMhz and overclockMultiplierFromMhz map slider frequencies accurately up to 100 MHz', () => {
  assert.equal(getEffectiveCpuMhz('ECS', 'PAL', false, 1), 7.1);
  assert.equal(getEffectiveCpuMhz('ECS', 'PAL', false, 14.097), 100.0);
  assert.equal(getEffectiveCpuMhz('AGA', 'PAL', false, 1), 14.2);
  assert.equal(getEffectiveCpuMhz('AGA', 'PAL', false, 14.097), 100.0);
  assert.equal(getEffectiveOverclockMultiplier('AGA', 'PAL', false, 14.097), 7.0);
  assert.equal(getEffectiveOverclockMultiplier('ECS', 'PAL', false, 14.097), 14.1);
  assert.equal(getEffectiveCpuMhz('ECS', 'PAL', true, 1), 3.8);

  // Round-trip MHz slider values on PAL A500 & A1200
  const m50A500 = overclockMultiplierFromMhz('ECS', 'PAL', 50);
  assert.equal(getEffectiveCpuMhz('ECS', 'PAL', false, m50A500), 50.0);

  const m100A500 = overclockMultiplierFromMhz('ECS', 'PAL', 100);
  assert.equal(getEffectiveCpuMhz('ECS', 'PAL', false, m100A500), 100.0);

  const m100A1200 = overclockMultiplierFromMhz('AGA', 'PAL', 100);
  assert.equal(getEffectiveCpuMhz('AGA', 'PAL', false, m100A1200), 100.0);

  assert.equal(overclockMultiplierFromMhz('ECS', 'PAL', 7.1), 1);
  assert.equal(overclockMultiplierFromMhz('AGA', 'PAL', 14.2), 1);
});

test('sanitizeCpuOverclock clamps range [1, 14.2] and preserves fine MHz-derived multipliers', () => {
  assert.equal(sanitizeCpuOverclock(7.0484), 7.048);
  assert.equal(sanitizeCpuOverclock(0.2), 1);
  assert.equal(sanitizeCpuOverclock(99), CPU_OVERCLOCK_MAX_MULTIPLIER);
  assert.equal(sanitizeCpuOverclock(Number.NaN, 1.5), 1.5);
  assert.equal(sanitizeCpuOverclock('fast', 1), 1);
});

import { ChipsetModel, CpuOverclockMultiplier, ResolvedVideoStandard } from '../types';

export const PAL_CYCLES_PER_SCANLINE = 454;  // 227 CCK = 454 CPU cycles = 45.4 E-clocks
export const NTSC_CYCLES_PER_SCANLINE = 455; // 227.5 CCK = 455 CPU cycles = 45.5 E-clocks
export const ECO_A500_CYCLES_PER_SCANLINE = 240;
export const ECO_A1200_CYCLES_PER_SCANLINE = 360;

export const PAL_BASE_CPU_MHZ = 7.09379;
export const NTSC_BASE_CPU_MHZ = 7.15909;

export const CPU_OVERCLOCK_MIN = 1;
export const CPU_OVERCLOCK_MAX_MHZ = 100;
export const CPU_OVERCLOCK_MAX_MULTIPLIER = 14.2;
export const CPU_OVERCLOCK_STEP_MHZ = 0.1;

// Precomputed scanline cycle ceilings for 100.0 MHz (identical for A500 and A1200)
const PAL_MAX_CYCLES_100MHZ = Math.round((PAL_CYCLES_PER_SCANLINE * CPU_OVERCLOCK_MAX_MHZ) / PAL_BASE_CPU_MHZ);
const NTSC_MAX_CYCLES_100MHZ = Math.round((NTSC_CYCLES_PER_SCANLINE * CPU_OVERCLOCK_MAX_MHZ) / NTSC_BASE_CPU_MHZ);

export function sanitizeCpuOverclock(value: unknown, fallback = 1): CpuOverclockMultiplier {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const clamped = value < CPU_OVERCLOCK_MIN
    ? CPU_OVERCLOCK_MIN
    : value > CPU_OVERCLOCK_MAX_MULTIPLIER
      ? CPU_OVERCLOCK_MAX_MULTIPLIER
      : value;
  return Math.round(clamped * 1000) / 1000;
}

/**
 * Computes emulated 68000/68EC020 cycles executed per scanline as an exact integer,
 * capped at 100.0 MHz on both A500 and A1200.
 * Only CPU cycle budget scales — VBlank, Copper, Paula audio, and CIA E-clocks stay at 1x native rate.
 */
export function computeCpuCyclesPerScanline(
  isAga: boolean,
  isPal: boolean,
  ecoCpuMode: boolean,
  cpuOverclock: CpuOverclockMultiplier
): number {
  const baseCycles = isPal ? PAL_CYCLES_PER_SCANLINE : NTSC_CYCLES_PER_SCANLINE;
  const nominal = isAga ? baseCycles << 1 : baseCycles;
  if (cpuOverclock > 1) {
    const maxCycles = isPal ? PAL_MAX_CYCLES_100MHZ : NTSC_MAX_CYCLES_100MHZ;
    const scaled = Math.round(nominal * cpuOverclock);
    return scaled > maxCycles ? maxCycles : scaled;
  }
  if (ecoCpuMode) {
    return isAga ? ECO_A1200_CYCLES_PER_SCANLINE : ECO_A500_CYCLES_PER_SCANLINE;
  }
  return nominal;
}

/**
 * Returns effective Amiga CPU clock in MHz (capped at 100.0 MHz) for display in Settings.
 */
export function getEffectiveCpuMhz(
  chipset: ChipsetModel,
  videoStandard: ResolvedVideoStandard,
  ecoCpuMode: boolean,
  cpuOverclock: CpuOverclockMultiplier
): number {
  const isAga = chipset === 'AGA';
  const isPal = videoStandard === 'PAL';
  const baseMhz = isPal ? PAL_BASE_CPU_MHZ : NTSC_BASE_CPU_MHZ;
  const nominalMhz = isAga ? baseMhz * 2 : baseMhz;
  const baseCycles = isPal ? PAL_CYCLES_PER_SCANLINE : NTSC_CYCLES_PER_SCANLINE;
  const nominalCycles = isAga ? baseCycles << 1 : baseCycles;
  const activeCycles = computeCpuCyclesPerScanline(isAga, isPal, ecoCpuMode, cpuOverclock);
  const mhz = Math.round(((nominalMhz * activeCycles) / nominalCycles) * 10) / 10;
  return mhz > CPU_OVERCLOCK_MAX_MHZ ? CPU_OVERCLOCK_MAX_MHZ : mhz;
}

/**
 * Returns the effective clock multiplier (activeCycles / nominalCycles) capped for the active chipset.
 */
export function getEffectiveOverclockMultiplier(
  chipset: ChipsetModel,
  videoStandard: ResolvedVideoStandard,
  ecoCpuMode: boolean,
  cpuOverclock: CpuOverclockMultiplier
): number {
  const isAga = chipset === 'AGA';
  const isPal = videoStandard === 'PAL';
  const baseCycles = isPal ? PAL_CYCLES_PER_SCANLINE : NTSC_CYCLES_PER_SCANLINE;
  const nominalCycles = isAga ? baseCycles << 1 : baseCycles;
  const activeCycles = computeCpuCyclesPerScanline(isAga, isPal, ecoCpuMode, cpuOverclock);
  return Math.round((activeCycles / nominalCycles) * 10) / 10;
}

/**
 * Converts a target MHz frequency from the UI slider into a normalized CPU overclock multiplier.
 */
export function overclockMultiplierFromMhz(
  chipset: ChipsetModel,
  videoStandard: ResolvedVideoStandard,
  targetMhz: number
): CpuOverclockMultiplier {
  if (!Number.isFinite(targetMhz)) return 1;
  const minMhz = getEffectiveCpuMhz(chipset, videoStandard, false, 1);
  if (targetMhz <= minMhz) return 1;
  const clampedMhz = targetMhz > CPU_OVERCLOCK_MAX_MHZ ? CPU_OVERCLOCK_MAX_MHZ : targetMhz;
  const isAga = chipset === 'AGA';
  const isPal = videoStandard === 'PAL';
  const baseMhz = isPal ? PAL_BASE_CPU_MHZ : NTSC_BASE_CPU_MHZ;
  const nominalMhz = isAga ? baseMhz * 2 : baseMhz;
  return sanitizeCpuOverclock(clampedMhz / nominalMhz, 1);
}

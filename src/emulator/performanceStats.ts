import { NTSC_FPS, PAL_FPS, ResolvedVideoStandard } from './types';

export type EmuPerfVerdict = 'warming' | 'optimal' | 'tight' | 'lagging' | 'paused';

export interface EmuPerfInput {
  paused: boolean;
  videoStandard: ResolvedVideoStandard;
  steps: number;
  renderedFrames: number;
  droppedFrames: number;
  elapsedMs: number;
  coreMsSum: number;
  blitMsSum: number;
}

export interface EmuPerfSnapshot {
  verdict: EmuPerfVerdict;
  videoStandard: ResolvedVideoStandard;
  targetHz: number;
  budgetMs: number;
  emulatedHz: number;
  speedPct: number;
  coreMs: number;
  blitMs: number;
  frameMs: number;
  loadPct: number;
  droppedPerSec: number;
}

export function createEmptyEmuPerf(videoStandard: ResolvedVideoStandard = 'PAL'): EmuPerfSnapshot {
  const targetHz = videoStandard === 'NTSC' ? NTSC_FPS : PAL_FPS;
  return {
    verdict: 'warming',
    videoStandard,
    targetHz,
    budgetMs: 1000 / targetHz,
    emulatedHz: 0,
    speedPct: 0,
    coreMs: 0,
    blitMs: 0,
    frameMs: 0,
    loadPct: 0,
    droppedPerSec: 0,
  };
}

export function evaluateEmuPerformance(input: EmuPerfInput): EmuPerfSnapshot {
  const targetHz = input.videoStandard === 'NTSC' ? NTSC_FPS : PAL_FPS;
  const budgetMs = 1000 / targetHz;

  if (input.paused) {
    return {
      verdict: 'paused',
      videoStandard: input.videoStandard,
      targetHz,
      budgetMs,
      emulatedHz: 0,
      speedPct: 0,
      coreMs: 0,
      blitMs: 0,
      frameMs: 0,
      loadPct: 0,
      droppedPerSec: 0,
    };
  }

  const safeElapsedMs = input.elapsedMs > 1 ? input.elapsedMs : 1;
  const steps = input.steps > 0 ? input.steps : 0;
  const emulatedHz = steps > 0 ? Math.min(targetHz * 2, (steps * 1000) / safeElapsedMs) : 0;
  // Clamp small rAF phase jitter (e.g. 98..102% during smooth 50Hz-on-60Hz pacing) only if no drops
  const rawSpeedPct = (emulatedHz * 100) / targetHz;
  const droppedPerSec = input.droppedFrames > 0 ? (input.droppedFrames * 1000) / safeElapsedMs : 0;
  const speedPct =
    droppedPerSec === 0 && rawSpeedPct >= 97 && rawSpeedPct <= 103
      ? 100
      : Math.max(0, Math.round(rawSpeedPct));

  const coreMs = steps > 0 ? input.coreMsSum / steps : 0;
  const blitMs = steps > 0 ? input.blitMsSum / steps : 0;
  const frameMs = coreMs + blitMs;
  const loadPct = Math.max(0, Math.round((frameMs / budgetMs) * 100));

  let verdict: EmuPerfVerdict;
  if (steps === 0 || speedPct < 85 || loadPct >= 100) {
    verdict = 'lagging';
  } else if (speedPct < 95 || loadPct >= 82 || droppedPerSec >= 1) {
    verdict = 'tight';
  } else {
    verdict = 'optimal';
  }

  return {
    verdict,
    videoStandard: input.videoStandard,
    targetHz,
    budgetMs,
    emulatedHz: Math.round(emulatedHz * 10) / 10,
    speedPct,
    coreMs: Math.round(coreMs * 10) / 10,
    blitMs: Math.round(blitMs * 10) / 10,
    frameMs: Math.round(frameMs * 10) / 10,
    loadPct,
    droppedPerSec: Math.round(droppedPerSec * 10) / 10,
  };
}

export interface SecretTapState {
  count: number;
  lastTapMs: number;
}

export const SECRET_UNLOCK_TAP_COUNT = 5;
export const SECRET_UNLOCK_MAX_GAP_MS = 650;

export function createInitialSecretTapState(): SecretTapState {
  return { count: 0, lastTapMs: -1 };
}

/**
 * Pure, zero-timer detector for N consecutive rapid taps.
 * Keeps CPU usage at zero when idle by comparing event timestamps on demand.
 */
export function registerSecretTap(
  state: SecretTapState,
  nowMs: number,
  requiredTaps = SECRET_UNLOCK_TAP_COUNT,
  maxGapMs = SECRET_UNLOCK_MAX_GAP_MS
): { state: SecretTapState; unlockedNow: boolean } {
  const withinWindow = state.lastTapMs >= 0 && nowMs - state.lastTapMs <= maxGapMs;
  const nextCount = withinWindow ? state.count + 1 : 1;

  if (nextCount >= requiredTaps) {
    return {
      state: { count: 0, lastTapMs: -1 },
      unlockedNow: true,
    };
  }

  return {
    state: { count: nextCount, lastTapMs: nowMs },
    unlockedNow: false,
  };
}

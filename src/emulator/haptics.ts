/**
 * Lightweight zero-overhead haptic feedback helper for mobile touch controls.
 * Never allocates or runs in loops; only fires on discrete user press transitions.
 */

let hapticsEnabled = true;

export function setHapticsEnabled(enabled: boolean): void {
  hapticsEnabled = enabled;
}

export function isHapticsEnabled(): boolean {
  return hapticsEnabled;
}

export function triggerHaptic(durationMs = 10): void {
  if (!hapticsEnabled) return;
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate(durationMs);
    } catch {
      // Ignore on unsupported or restricted webviews
    }
  }
}

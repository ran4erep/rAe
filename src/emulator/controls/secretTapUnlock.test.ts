import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialSecretTapState,
  registerSecretTap,
  SECRET_UNLOCK_MAX_GAP_MS,
} from './secretTapUnlock';

test('unlocks on 5 rapid consecutive taps within gap window', () => {
  let state = createInitialSecretTapState();
  for (let i = 0; i < 4; i++) {
    const res = registerSecretTap(state, 1000 + i * 180);
    assert.equal(res.unlockedNow, false);
    assert.equal(res.state.count, i + 1);
    state = res.state;
  }

  const fifth = registerSecretTap(state, 1000 + 4 * 180);
  assert.equal(fifth.unlockedNow, true);
  assert.equal(fifth.state.count, 0);
  assert.equal(fifth.state.lastTapMs, -1);
});

test('resets tap streak when pause exceeds maxGapMs', () => {
  let state = createInitialSecretTapState();
  state = registerSecretTap(state, 100).state;
  state = registerSecretTap(state, 250).state;
  state = registerSecretTap(state, 400).state;
  assert.equal(state.count, 3);

  // Slow pause resets streak back to 1
  const slow = registerSecretTap(state, 400 + SECRET_UNLOCK_MAX_GAP_MS + 50);
  assert.equal(slow.unlockedNow, false);
  assert.equal(slow.state.count, 1);

  // Need 4 more rapid taps from here
  state = slow.state;
  for (let i = 1; i <= 3; i++) {
    const r = registerSecretTap(state, slow.state.lastTapMs + i * 150);
    assert.equal(r.unlockedNow, false);
    state = r.state;
  }
  const finalTap = registerSecretTap(state, state.lastTapMs + 150);
  assert.equal(finalTap.unlockedNow, true);
});

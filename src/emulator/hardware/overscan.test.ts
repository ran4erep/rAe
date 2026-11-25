import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AutoOverscanTracker,
  computeAutoOverscanViewport,
  computePhysicalAspect,
  DENISE_MAX_H_LO,
  DENISE_MIN_H_LO,
  getPresetViewport,
  isValidOverscanMode,
  MAX_FB_HEIGHT,
  MAX_FB_WIDTH,
  NTSC_MAX_LINE,
  NTSC_MIN_LINE,
  PAL_MAX_LINE,
  PAL_MIN_LINE,
} from './overscan';

test('Overscan presets stay within max framebuffer bounds and preserve physical aspect ratios', () => {
  assert.equal(isValidOverscanMode('auto'), true);
  assert.equal(isValidOverscanMode('none'), true);
  assert.equal(isValidOverscanMode('tv'), true);
  assert.equal(isValidOverscanMode('max'), true);
  assert.equal(isValidOverscanMode('ultra'), false);
  assert.equal(isValidOverscanMode(null), false);

  const palNone = getPresetViewport('none', 'PAL');
  const palTv = getPresetViewport('tv', 'PAL');
  const palMax = getPresetViewport('max', 'PAL');
  assert.deepEqual(palNone, { hOriginLo: 0x81, width: 640, startLine: 44, height: 256 });
  assert.deepEqual(palTv, { hOriginLo: 0x71, width: 704, startLine: 36, height: 272 });
  assert.deepEqual(palMax, { hOriginLo: 0x65, width: 752, startLine: 26, height: 286 });

  const ntscNone = getPresetViewport('none', 'NTSC');
  const ntscTv = getPresetViewport('tv', 'NTSC');
  const ntscMax = getPresetViewport('max', 'NTSC');
  assert.deepEqual(ntscNone, { hOriginLo: 0x81, width: 640, startLine: 44, height: 200 });
  assert.deepEqual(ntscTv, { hOriginLo: 0x71, width: 704, startLine: 32, height: 224 });
  assert.deepEqual(ntscMax, { hOriginLo: 0x65, width: 752, startLine: 22, height: 240 });

  for (const vp of [palNone, palTv, palMax, ntscNone, ntscTv, ntscMax]) {
    assert.ok(vp.width <= MAX_FB_WIDTH && (vp.width & 1) === 0);
    assert.ok(vp.height <= MAX_FB_HEIGHT && (vp.height & 1) === 0);
    assert.ok(vp.hOriginLo >= DENISE_MIN_H_LO);
    assert.ok(vp.hOriginLo + (vp.width >>> 1) <= DENISE_MAX_H_LO);
  }

  // Exact 4:3 on standard PAL 640x256 and NTSC 640x200
  assert.ok(Math.abs(computePhysicalAspect(640, 256, 'PAL') - 4 / 3) < 1e-6);
  assert.ok(Math.abs(computePhysicalAspect(640, 200, 'NTSC') - 4 / 3) < 1e-6);
  // TV & Max PAL overscan remain close to 4:3 without distorting pixels
  assert.ok(computePhysicalAspect(704, 272, 'PAL') > 1.35 && computePhysicalAspect(704, 272, 'PAL') < 1.41);
  assert.ok(computePhysicalAspect(752, 286, 'PAL') > 1.38 && computePhysicalAspect(752, 286, 'PAL') < 1.43);
});

test('computeAutoOverscanViewport fits Alien Breed, Chaos Engine, Tower Assault, and TV/Max DIW without clipping', () => {
  // Standard Kickstart / Workbench stays exact 640x256
  assert.deepEqual(
    computeAutoOverscanViewport({ minH: 0x81, maxH: 0x1c1, minV: 44, maxV: 300 }, 'PAL'),
    { hOriginLo: 0x81, width: 640, startLine: 44, height: 256 }
  );

  // Smaller 320x200 game in PAL stays exact standard 640x256 (Auto-Crop handles shrinking)
  assert.deepEqual(
    computeAutoOverscanViewport({ minH: 0x81, maxH: 0x1c1, minV: 44, maxV: 244 }, 'PAL'),
    { hOriginLo: 0x81, width: 640, startLine: 44, height: 256 }
  );

  // Alien Breed ($3081..$30C1 -> V=48..304, H=$81..$1C1): shifts startLine cleanly to 48 with zero wasted borders!
  const ab = computeAutoOverscanViewport({ minH: 0x81, maxH: 0x1c1, minV: 48, maxV: 304 }, 'PAL');
  assert.equal(ab.hOriginLo, 0x81);
  assert.equal(ab.width, 640);
  assert.ok(ab.startLine <= 48 && ab.startLine + ab.height >= 304);
  assert.equal(ab.height, 256);

  // Chaos Engine ($2F7C..$2FC1 -> V=47..303, H=$7C..$1C1): uncovers left 5px and bottom 4 lines!
  const ce = computeAutoOverscanViewport({ minH: 0x7c, maxH: 0x1c1, minV: 47, maxV: 303 }, 'PAL');
  assert.ok(ce.hOriginLo <= 0x7c && ce.hOriginLo + (ce.width >>> 1) >= 0x1c1);
  assert.ok(ce.startLine <= 47 && ce.startLine + ce.height >= 303);
  assert.equal(ce.width & 7, 0);

  // Alien Breed Tower Assault ($287B..$2DBD -> V=40..301, H=$7B..$1BD)
  const ta = computeAutoOverscanViewport({ minH: 0x7b, maxH: 0x1bd, minV: 40, maxV: 301 }, 'PAL');
  assert.ok(ta.hOriginLo <= 0x7b && ta.hOriginLo + (ta.width >>> 1) >= 0x1bd);
  assert.ok(ta.startLine <= 40 && ta.startLine + ta.height >= 301);

  // TV overscan ($2471..$34D1 -> V=36..308, H=$71..$1D1)
  const tv = computeAutoOverscanViewport({ minH: 0x71, maxH: 0x1d1, minV: 36, maxV: 308 }, 'PAL');
  assert.deepEqual(tv, { hOriginLo: 0x71, width: 704, startLine: 36, height: 272 });

  // Extreme / out-of-blanking DIW clamps safely to physical Denise limits
  const extremePal = computeAutoOverscanViewport({ minH: 0x10, maxH: 0x1ff, minV: 0, maxV: 350 }, 'PAL');
  assert.deepEqual(extremePal, {
    hOriginLo: DENISE_MIN_H_LO,
    width: MAX_FB_WIDTH,
    startLine: PAL_MIN_LINE,
    height: PAL_MAX_LINE - PAL_MIN_LINE,
  });

  const extremeNtsc = computeAutoOverscanViewport({ minH: 0x10, maxH: 0x1ff, minV: 0, maxV: 300 }, 'NTSC');
  assert.deepEqual(extremeNtsc, {
    hOriginLo: DENISE_MIN_H_LO,
    width: MAX_FB_WIDTH,
    startLine: NTSC_MIN_LINE,
    height: NTSC_MAX_LINE - NTSC_MIN_LINE,
  });
});

test('AutoOverscanTracker expands in 2 frames, ignores blank frames, and shrinks only after 20 stable frames', () => {
  const tracker = new AutoOverscanTracker();
  tracker.reset('PAL');
  assert.deepEqual(tracker.current, { hOriginLo: 0x81, width: 640, startLine: 44, height: 256 });

  // Frame 1 of TV overscan: pending, not yet applied (filters 1-frame copper glitches)
  assert.equal(tracker.update(true, 0x71, 0x1d1, 36, 308, 'PAL'), false);
  // Frame 2 of TV overscan: expands immediately!
  assert.equal(tracker.update(true, 0x71, 0x1d1, 36, 308, 'PAL'), true);
  assert.deepEqual(tracker.current, { hOriginLo: 0x71, width: 704, startLine: 36, height: 272 });

  // Blank loading frames must preserve the active overscan viewport
  for (let i = 0; i < 30; i++) {
    assert.equal(tracker.update(false, 0x3ff, 0, 0x3ff, 0, 'PAL'), false);
  }
  assert.deepEqual(tracker.current, { hOriginLo: 0x71, width: 704, startLine: 36, height: 272 });

  // Returning to standard 640x256 holds for 19 frames, then shrinks cleanly on frame 20
  for (let i = 0; i < 19; i++) {
    assert.equal(tracker.update(true, 0x81, 0x1c1, 44, 300, 'PAL'), false);
  }
  assert.equal(tracker.update(true, 0x81, 0x1c1, 44, 300, 'PAL'), true);
  assert.deepEqual(tracker.current, { hOriginLo: 0x81, width: 640, startLine: 44, height: 256 });
});

test('Numeric overscan levels (0..100) scale monotonically within physical Denise bounds for PAL and NTSC', async () => {
  const { getOverscanViewport, overscanToLevel } = await import('./overscan');

  assert.equal(isValidOverscanMode(0), true);
  assert.equal(isValidOverscanMode(50), true);
  assert.equal(isValidOverscanMode(100), true);
  assert.equal(isValidOverscanMode(-1), false);
  assert.equal(isValidOverscanMode(101), false);
  assert.equal(isValidOverscanMode(Number.NaN), false);

  assert.equal(overscanToLevel(0), 0);
  assert.equal(overscanToLevel(42.6), 43);
  assert.equal(overscanToLevel('none'), 0);
  assert.equal(overscanToLevel('tv'), 56);
  assert.equal(overscanToLevel('max'), 100);

  assert.deepEqual(getOverscanViewport(0, 'PAL'), { hOriginLo: 0x81, width: 640, startLine: 44, height: 256 });
  assert.deepEqual(getOverscanViewport(100, 'PAL'), { hOriginLo: 0x65, width: 752, startLine: 26, height: 286 });
  assert.deepEqual(getOverscanViewport(0, 'NTSC'), { hOriginLo: 0x81, width: 640, startLine: 44, height: 200 });
  assert.deepEqual(getOverscanViewport(100, 'NTSC'), { hOriginLo: 0x65, width: 752, startLine: 22, height: 240 });

  for (const std of ['PAL', 'NTSC'] as const) {
    let prevW = 0;
    let prevH = 0;
    for (let lvl = 0; lvl <= 100; lvl++) {
      const vp = getOverscanViewport(lvl, std);
      assert.ok(vp.width >= prevW, `${std} width must be monotonic at level ${lvl}`);
      assert.ok(vp.height >= prevH, `${std} height must be monotonic at level ${lvl}`);
      assert.equal(vp.width & 3, 0);
      assert.equal(vp.height & 1, 0);
      assert.ok(vp.width <= MAX_FB_WIDTH && vp.height <= MAX_FB_HEIGHT);
      assert.ok(vp.hOriginLo >= DENISE_MIN_H_LO);
      assert.ok(vp.hOriginLo + (vp.width >>> 1) <= DENISE_MAX_H_LO);
      prevW = vp.width;
      prevH = vp.height;
    }
  }
});

test('Pixel-exact WxH overscan dimensions resolve cleanly without allocations and clamp within Denise bounds', async () => {
  const {
    formatOverscanSetting,
    getOverscanViewport,
    parseOverscanDimensionsPacked,
  } = await import('./overscan');

  assert.equal(isValidOverscanMode('704x272'), true);
  assert.equal(isValidOverscanMode('640x200'), true);
  assert.equal(isValidOverscanMode('752x286'), true);
  assert.equal(isValidOverscanMode('600x256'), false);
  assert.equal(isValidOverscanMode('704x999'), false);
  assert.equal(isValidOverscanMode('bad'), false);

  assert.equal(parseOverscanDimensionsPacked('704x272'), (704 << 16) | 272);
  assert.equal(formatOverscanSetting(640, 256, 'PAL'), 'none');
  assert.equal(formatOverscanSetting(640, 200, 'NTSC'), 'none');
  assert.equal(formatOverscanSetting(703, 271, 'PAL'), '704x272');

  assert.deepEqual(getOverscanViewport('704x272', 'PAL'), {
    hOriginLo: 0x71,
    width: 704,
    startLine: 36,
    height: 272,
  });
  assert.deepEqual(getOverscanViewport('752x286', 'PAL'), {
    hOriginLo: 0x65,
    width: 752,
    startLine: 26,
    height: 286,
  });
  assert.deepEqual(getOverscanViewport('704x224', 'NTSC'), {
    hOriginLo: 0x71,
    width: 704,
    startLine: 32,
    height: 224,
  });
  assert.deepEqual(getOverscanViewport('752x240', 'NTSC'), {
    hOriginLo: 0x65,
    width: 752,
    startLine: 22,
    height: 240,
  });

  // PAL trimmed below 256 (e.g. 640x200 for Cadaver / NTSC-window PAL games)
  const { computeOverscanDisplayAspect, getMinOverscanHeight } = await import('./overscan');
  assert.equal(getMinOverscanHeight('PAL'), 200);
  assert.equal(getMinOverscanHeight('NTSC'), 200);
  assert.equal(formatOverscanSetting(640, 200, 'PAL'), '640x200');
  assert.deepEqual(getOverscanViewport('640x200', 'PAL'), {
    hOriginLo: 0x81,
    width: 640,
    startLine: 44,
    height: 200,
  });
  assert.deepEqual(getOverscanViewport('704x224', 'PAL'), {
    hOriginLo: 0x71,
    width: 704,
    startLine: 44,
    height: 224,
  });
  // Manual PAL <256 uses V-SIZE 4:3 stretching when Auto-Crop is off, preserving Auto-Crop PAR when on
  assert.ok(Math.abs(computeOverscanDisplayAspect(640, 200, 'PAL', false) - 4 / 3) < 1e-6);
  assert.ok(computeOverscanDisplayAspect(640, 200, 'PAL', true) > 1.55);
});



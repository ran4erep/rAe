import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoCropTracker, cropPhysicalAspect, detectActiveContentBounds, FULL_CROP } from './autoCrop';
import { FB_HEIGHT, FB_WIDTH } from './chipset';

function makeFb(fill = 0xff000000): Uint32Array {
  const fb = new Uint32Array(FB_WIDTH * FB_HEIGHT);
  fb.fill(fill);
  return fb;
}

function drawRect(fb: Uint32Array, x0: number, y0: number, w: number, h: number, color = 0xffffffff): void {
  for (let y = y0; y < y0 + h && y < FB_HEIGHT; y++) {
    for (let x = x0; x < x0 + w && x < FB_WIDTH; x++) {
      fb[y * FB_WIDTH + x] = color;
    }
  }
}

test('Kickstart white background keeps full 640x256 4:3 frame without cropping', () => {
  const fb = makeFb(0xffffffff);
  drawRect(fb, 200, 80, 120, 80, 0xff2222aa);
  const bounds = detectActiveContentBounds(fb);
  assert.deepEqual(bounds, FULL_CROP);
});

test('Detects 320x200 game window inside 640x256 PAL frame with black bottom border', () => {
  const fb = makeFb(0xff000000);
  drawRect(fb, 0, 0, 640, 200, 0xff3388cc);
  const bounds = detectActiveContentBounds(fb);
  assert.ok(bounds !== null);
  assert.equal(bounds.x, 0);
  assert.equal(bounds.y, 0);
  assert.equal(bounds.w, 640);
  assert.ok(bounds.h >= 200 && bounds.h <= 212);
  assert.ok(cropPhysicalAspect(bounds) > 1.55);
});

test('AutoCropTracker preserves crop on black fade-out frames and shrinks smoothly after hysteresis', () => {
  const tracker = new AutoCropTracker();
  const gameFb = makeFb(0xff000000);
  drawRect(gameFb, 32, 20, 560, 190, 0xff44aa55);

  // First few samples hold full crop before shrinking (~8 samples hysteresis)
  for (let i = 0; i < 6; i++) {
    const res = tracker.update(gameFb);
    assert.deepEqual(res.rect, FULL_CROP);
  }
  for (let i = 0; i < 3; i++) {
    tracker.update(gameFb);
  }
  const shrunk = tracker.getCurrent();
  assert.ok(shrunk.w < 640 && shrunk.h < 256);

  // Blank black transition frame must keep the active game crop
  const blackFb = makeFb(0xff000000);
  const onBlack = tracker.update(blackFb);
  assert.equal(onBlack.changed, false);
  assert.deepEqual(onBlack.rect, shrunk);

  // Expanding content (e.g. back to full 640x256 screen) recovers quickly within 2 updates
  const fullFb = makeFb(0xffffffff);
  tracker.update(fullFb);
  const expanded = tracker.update(fullFb);
  assert.equal(expanded.changed, true);
  assert.deepEqual(expanded.rect, FULL_CROP);
});

test('AutoCropTracker adapts cleanly to 704x272 TV overscan buffers and NTSC aspect ratio', () => {
  const w = 704;
  const h = 272;
  const fb = new Uint32Array(w * h);
  fb.fill(0xff000000);
  // Active overscan content spanning left/right overscan region (x=16..688, y=10..262)
  for (let y = 10; y < 262; y++) {
    for (let x = 16; x < 688; x++) {
      fb[y * w + x] = 0xff22cc66;
    }
  }
  const bounds = detectActiveContentBounds(fb, w, h);
  assert.ok(bounds !== null);
  assert.equal(bounds.x, 0);
  assert.equal(bounds.w, 704);
  assert.ok(bounds.y <= 10 && bounds.y + bounds.h >= 262);

  // Dimension switch in AutoCropTracker resets immediately to the new overscan size
  const tracker = new AutoCropTracker();
  const switched = tracker.update(fb, w, h);
  assert.equal(switched.changed, true);
  assert.deepEqual(switched.rect, { x: 0, y: 0, w: 704, h: 272 });

  // NTSC 640x200 crop yields exact 4:3 physical aspect
  assert.ok(Math.abs(cropPhysicalAspect({ x: 0, y: 0, w: 640, h: 200 }, 'NTSC') - 4 / 3) < 1e-6);
});

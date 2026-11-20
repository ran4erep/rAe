/**
 * UAE-style Automatic Overscan / Black-Border Crop Tracker (Zero-GC, ultra-low CPU).
 *
 * Real Amiga OCS/ECS games frequently use a smaller Display Window (e.g. 320x200 NTSC-in-PAL
 * or 288x216) leaving black borders around the active image while Kickstart/Workbench fills 640x256.
 * This tracker samples the 640x256 framebuffer sparsely (every 4px horizontally, 2px vertically
 * -> ~20k integer reads ≈ 0.03ms) with temporal hysteresis so borders crop cleanly without jitter.
 */

import { VideoStandard } from '../types';
import { computePhysicalAspect, STD_FB_HEIGHT, STD_FB_WIDTH } from './overscan';

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const FULL_CROP: CropRect = { x: 0, y: 0, w: STD_FB_WIDTH, h: STD_FB_HEIGHT };

// Minimum retained window so small loading text isn't zoomed disproportionately
const MIN_CROP_W = 480;
const MIN_CROP_H = 160;
const DARK_THRESHOLD = 20; // RGB component <= 20 considered black/blank border

function isNearBlack(abgr: number): boolean {
  const r = abgr & 0xff;
  const g = (abgr >>> 8) & 0xff;
  const b = (abgr >>> 16) & 0xff;
  return r <= DARK_THRESHOLD && g <= DARK_THRESHOLD && b <= DARK_THRESHOLD;
}

/**
 * Computes physical display aspect ratio for a crop of the Amiga framebuffer.
 */
export function cropPhysicalAspect(crop: CropRect, videoStandard: VideoStandard = 'PAL'): number {
  return computePhysicalAspect(crop.w, crop.h, videoStandard);
}

/**
 * Pure single-frame dark-border detector (returns null if the frame is entirely blank/black).
 */
export function detectActiveContentBounds(
  fb: Uint32Array,
  width = STD_FB_WIDTH,
  height = STD_FB_HEIGHT
): CropRect | null {
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;

  for (let y = 0; y < height; y += 2) {
    const rowOff = y * width;
    const edgePx = fb[rowOff];
    const darkRowBg = isNearBlack(edgePx);

    if (!darkRowBg) {
      // Non-black background (e.g. Kickstart 1.3 white screen or colored border) uses full row
      if (y < minY) minY = y;
      if (y + 1 > maxY) maxY = y + 1;
      minX = 0;
      maxX = width - 1;
      continue;
    }

    let rowMinX = width;
    let rowMaxX = -1;
    for (let x = 0; x < width; x += 4) {
      if (!isNearBlack(fb[rowOff + x])) {
        if (x < rowMinX) rowMinX = x;
        rowMaxX = x + 3;
      }
    }
    if (rowMaxX >= 0) {
      if (y < minY) minY = y;
      if (y + 1 > maxY) maxY = y + 1;
      if (rowMinX < minX) minX = rowMinX;
      if (rowMaxX > maxX) maxX = rowMaxX;
    }
  }

  if (maxX < 0 || maxY < 0) return null;

  // Add small safety padding and snap margins near frame edges to 0 / full
  let x0 = Math.max(0, minX - 8);
  let x1 = Math.min(width, maxX + 9);
  let y0 = Math.max(0, minY - 4);
  let y1 = Math.min(height, maxY + 5);

  if (x0 <= 12) x0 = 0;
  if (x1 >= width - 12) x1 = width;
  if (y0 <= 8) y0 = 0;
  if (y1 >= height - 8) y1 = height;

  let w = x1 - x0;
  let h = y1 - y0;

  const minW = Math.min(MIN_CROP_W, width);
  const minH = Math.min(MIN_CROP_H, height);

  if (w < minW) {
    const pad = (minW - w) >>> 1;
    x0 = Math.max(0, x0 - pad);
    x1 = Math.min(width, x0 + minW);
    x0 = Math.max(0, x1 - minW);
    w = x1 - x0;
  }
  if (h < minH) {
    const pad = (minH - h) >>> 1;
    y0 = Math.max(0, y0 - pad);
    y1 = Math.min(height, y0 + minH);
    y0 = Math.max(0, y1 - minH);
    h = y1 - y0;
  }

  // Ensure even dimensions for clean putImageData & scaling
  x0 &= ~1;
  y0 &= ~1;
  w = Math.min(width - x0, (w + 1) & ~1);
  h = Math.min(height - y0, (h + 1) & ~1);

  return { x: x0, y: y0, w, h };
}

export class AutoCropTracker {
  private fbWidth = STD_FB_WIDTH;
  private fbHeight = STD_FB_HEIGHT;
  private current: CropRect = { ...FULL_CROP };
  private pending: CropRect | null = null;
  private shrinkHoldCount = 0;
  private expandHoldCount = 0;

  public reset(width = this.fbWidth, height = this.fbHeight): CropRect {
    this.fbWidth = width;
    this.fbHeight = height;
    this.current = { x: 0, y: 0, w: width, h: height };
    this.pending = null;
    this.shrinkHoldCount = 0;
    this.expandHoldCount = 0;
    return this.current;
  }

  public getCurrent(): CropRect {
    return this.current;
  }

  public update(
    fb: Uint32Array,
    width = STD_FB_WIDTH,
    height = STD_FB_HEIGHT
  ): { rect: CropRect; changed: boolean } {
    if (width !== this.fbWidth || height !== this.fbHeight) {
      return { rect: this.reset(width, height), changed: true };
    }

    const detected = detectActiveContentBounds(fb, width, height);
    if (!detected) {
      // Blank/fade-out frame: preserve current crop without snapping
      return { rect: this.current, changed: false };
    }

    const cur = this.current;
    const needsExpand =
      detected.x < cur.x ||
      detected.y < cur.y ||
      detected.x + detected.w > cur.x + cur.w ||
      detected.y + detected.h > cur.y + cur.h;

    if (needsExpand) {
      // Union with current so expanding never cuts off content
      const ux0 = Math.min(cur.x, detected.x);
      const uy0 = Math.min(cur.y, detected.y);
      const ux1 = Math.max(cur.x + cur.w, detected.x + detected.w);
      const uy1 = Math.max(cur.y + cur.h, detected.y + detected.h);
      const next: CropRect = { x: ux0, y: uy0, w: ux1 - ux0, h: uy1 - uy0 };
      this.shrinkHoldCount = 0;
      this.expandHoldCount++;
      if (this.expandHoldCount >= 2) {
        this.current = next;
        this.pending = null;
        this.expandHoldCount = 0;
        return { rect: this.current, changed: true };
      }
      return { rect: this.current, changed: false };
    }

    this.expandHoldCount = 0;

    // Check if shrinking meaningfully (>12px change on width or height)
    const diffW = cur.w - detected.w;
    const diffH = cur.h - detected.h;
    const diffPos = Math.abs(cur.x - detected.x) + Math.abs(cur.y - detected.y);
    if (diffW < 12 && diffH < 12 && diffPos < 12) {
      this.shrinkHoldCount = 0;
      this.pending = null;
      return { rect: this.current, changed: false };
    }

    if (
      this.pending &&
      Math.abs(this.pending.x - detected.x) <= 8 &&
      Math.abs(this.pending.y - detected.y) <= 8 &&
      Math.abs(this.pending.w - detected.w) <= 8 &&
      Math.abs(this.pending.h - detected.h) <= 8
    ) {
      this.shrinkHoldCount++;
      // Keep the outer union of pending samples so transient darker frames don't over-crop
      const px0 = Math.min(this.pending.x, detected.x);
      const py0 = Math.min(this.pending.y, detected.y);
      const px1 = Math.max(this.pending.x + this.pending.w, detected.x + detected.w);
      const py1 = Math.max(this.pending.y + this.pending.h, detected.y + detected.h);
      this.pending = { x: px0, y: py0, w: px1 - px0, h: py1 - py0 };
    } else {
      this.pending = detected;
      this.shrinkHoldCount = 1;
    }

    if (this.shrinkHoldCount >= 8) {
      this.current = this.pending;
      this.pending = null;
      this.shrinkHoldCount = 0;
      return { rect: this.current, changed: true };
    }

    return { rect: this.current, changed: false };
  }
}

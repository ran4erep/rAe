/**
 * Commodore Amiga OCS/ECS Overscan Geometry & Zero-GC Auto-Overscan Tracker.
 *
 * Real Amiga games frequently open Display Windows (DIWSTRT/DIWSTOP/DIWHIGH) beyond
 * the classic 320x256 PAL / 320x200 NTSC bounds (e.g. Chaos Engine $2F7C/$2FC1,
 * Alien Breed $3081/$30C1, Turrican/Team17 352x272, Pinball Dreams/demos up to 376x286).
 *
 * Keeping all viewport math pure and zero-allocation lets the emulator render ONLY the
 * active overscan pixels (minimal host CPU load) while preventing clipped game edges.
 */

import { OverscanMode, VideoStandard } from '../types';

export const STD_FB_WIDTH = 640;
export const STD_FB_HEIGHT = 256;

// Maximum physical Denise visible raster (376 lo-res = 752 hi-res, 286 PAL lines 26..311)
export const MAX_FB_WIDTH = 752;
export const MAX_FB_HEIGHT = 286;

// Physical OCS/ECS Denise horizontal blanking limits in lo-res H coordinates
// Center of standard [$81..$1C1] is $121 (289); [$65..$1DD] is symmetric (+/-28 lo-res = 376 lo-res)
export const DENISE_STD_H_START = 0x81;
export const DENISE_STD_H_STOP = 0x1c1;
export const DENISE_MIN_H_LO = 0x65;
export const DENISE_MAX_H_LO = 0x1dd;

export const PAL_STD_START_LINE = 44; // $2C
export const PAL_STD_HEIGHT = 256;    // lines 44..299
export const PAL_MIN_LINE = 26;       // First visible non-VBlank PAL line
export const PAL_MAX_LINE = 312;      // Exclusive upper bound (lines 26..311 = 286 lines)

export const NTSC_STD_START_LINE = 44; // $2C (standard 320x200 = $2C..$F4)
export const NTSC_STD_HEIGHT = 200;    // lines 44..243
export const NTSC_MIN_LINE = 22;       // First visible non-VBlank NTSC line
export const NTSC_MAX_LINE = 262;      // Exclusive upper bound (lines 22..261 = 240 lines)

export interface OverscanViewport {
  hOriginLo: number;
  width: number;
  startLine: number;
  height: number;
}

export interface ActiveDiwBounds {
  minH: number;
  maxH: number;
  minV: number;
  maxV: number;
}

export const OVERSCAN_MIN_LEVEL = 0;
export const OVERSCAN_MAX_LEVEL = 100;

export const OVERSCAN_MIN_WIDTH = STD_FB_WIDTH; // 640
export const OVERSCAN_MAX_WIDTH = MAX_FB_WIDTH; // 752
export const OVERSCAN_MIN_HEIGHT = NTSC_STD_HEIGHT; // 200 (both PAL and NTSC allow trimming down to 200px)
export const OVERSCAN_WIDTH_STEP = 4;
export const OVERSCAN_HEIGHT_STEP = 2;

export type OverscanPreset = 'auto' | 'none' | 'tv' | 'max';

const PAL_PRESETS: Record<Exclude<OverscanPreset, 'auto'>, OverscanViewport> = {
  none: { hOriginLo: 0x81, width: 640, startLine: 44, height: 256 },
  tv: { hOriginLo: 0x71, width: 704, startLine: 36, height: 272 },
  max: { hOriginLo: 0x65, width: 752, startLine: 26, height: 286 },
};

const NTSC_PRESETS: Record<Exclude<OverscanPreset, 'auto'>, OverscanViewport> = {
  none: { hOriginLo: 0x81, width: 640, startLine: 44, height: 200 },
  tv: { hOriginLo: 0x71, width: 704, startLine: 32, height: 224 },
  max: { hOriginLo: 0x65, width: 752, startLine: 22, height: 240 },
};

export function getStdOverscanHeight(videoStandard: VideoStandard): number {
  return videoStandard === 'NTSC' ? NTSC_STD_HEIGHT : PAL_STD_HEIGHT;
}

export function getMinOverscanHeight(_videoStandard: VideoStandard): number {
  return OVERSCAN_MIN_HEIGHT;
}

export function getMaxOverscanHeight(videoStandard: VideoStandard): number {
  return videoStandard === 'NTSC'
    ? NTSC_MAX_LINE - NTSC_MIN_LINE
    : PAL_MAX_LINE - PAL_MIN_LINE;
}

export function snapOverscanWidth(width: number): number {
  if (!Number.isFinite(width)) return OVERSCAN_MIN_WIDTH;
  const clamped = width < OVERSCAN_MIN_WIDTH
    ? OVERSCAN_MIN_WIDTH
    : width > OVERSCAN_MAX_WIDTH
      ? OVERSCAN_MAX_WIDTH
      : width;
  return OVERSCAN_MIN_WIDTH + Math.round((clamped - OVERSCAN_MIN_WIDTH) / OVERSCAN_WIDTH_STEP) * OVERSCAN_WIDTH_STEP;
}

export function snapOverscanHeight(height: number, videoStandard: VideoStandard): number {
  const minH = getMinOverscanHeight(videoStandard);
  const maxH = getMaxOverscanHeight(videoStandard);
  if (!Number.isFinite(height)) return minH;
  const clamped = height < minH ? minH : height > maxH ? maxH : height;
  return minH + (Math.round((clamped - minH) / OVERSCAN_HEIGHT_STEP) << 1);
}

/**
 * Zero-regex, fast parser for "WxH" custom overscan strings (e.g. "704x272").
 * Returns packed `(width << 16) | height`, or -1 when invalid.
 */
export function parseOverscanDimensionsPacked(value: string): number {
  const xIdx = value.indexOf('x');
  if (xIdx <= 0 || xIdx >= value.length - 1) return -1;
  const w = Number(value.slice(0, xIdx));
  const h = Number(value.slice(xIdx + 1));
  if (!Number.isInteger(w) || !Number.isInteger(h)) return -1;
  if (w < OVERSCAN_MIN_WIDTH || w > OVERSCAN_MAX_WIDTH) return -1;
  if (h < NTSC_STD_HEIGHT || h > MAX_FB_HEIGHT) return -1;
  return (w << 16) | h;
}

export function isValidOverscanMode(value: unknown): value is OverscanMode {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= OVERSCAN_MIN_LEVEL && value <= OVERSCAN_MAX_LEVEL;
  }
  if (value === 'auto' || value === 'none' || value === 'tv' || value === 'max') {
    return true;
  }
  if (typeof value === 'string') {
    return parseOverscanDimensionsPacked(value) >= 0;
  }
  return false;
}

export function normalizeOverscanMode(mode: OverscanMode): OverscanMode {
  if (typeof mode === 'number') return clampOverscanLevel(mode);
  if (typeof mode === 'string') {
    const packed = parseOverscanDimensionsPacked(mode);
    if (packed >= 0) {
      const w = snapOverscanWidth(packed >>> 16);
      const rawH = packed & 0xffff;
      const clampedH = rawH < NTSC_STD_HEIGHT ? NTSC_STD_HEIGHT : rawH > MAX_FB_HEIGHT ? MAX_FB_HEIGHT : rawH;
      const evenH = clampedH & ~1;
      return `${w}x${evenH}`;
    }
  }
  return mode;
}

export function formatOverscanSetting(
  width: number,
  height: number,
  videoStandard: VideoStandard
): OverscanMode {
  const w = snapOverscanWidth(width);
  const stdH = getStdOverscanHeight(videoStandard);
  const h = snapOverscanHeight(height, videoStandard);
  if (w === OVERSCAN_MIN_WIDTH && h === stdH) {
    return 'none';
  }
  return `${w}x${h}`;
}

export function clampOverscanLevel(level: number): number {
  if (!Number.isFinite(level)) return OVERSCAN_MIN_LEVEL;
  const rounded = Math.round(level);
  if (rounded < OVERSCAN_MIN_LEVEL) return OVERSCAN_MIN_LEVEL;
  if (rounded > OVERSCAN_MAX_LEVEL) return OVERSCAN_MAX_LEVEL;
  return rounded;
}

export function overscanToLevel(mode: OverscanMode): number {
  if (typeof mode === 'number') return clampOverscanLevel(mode);
  if (mode === 'tv') return 56;
  if (mode === 'max') return OVERSCAN_MAX_LEVEL;
  return OVERSCAN_MIN_LEVEL;
}

export function copyCustomOverscanViewport(
  width: number,
  height: number,
  videoStandard: VideoStandard,
  out: OverscanViewport
): void {
  const w = snapOverscanWidth(width);
  const sideLo = (w - OVERSCAN_MIN_WIDTH) >>> 2;
  out.hOriginLo = DENISE_STD_H_START - sideLo;
  out.width = OVERSCAN_MIN_WIDTH + (sideLo << 2);

  const isNtsc = videoStandard === 'NTSC';
  const stdStart = isNtsc ? NTSC_STD_START_LINE : PAL_STD_START_LINE;
  const stdH = isNtsc ? NTSC_STD_HEIGHT : PAL_STD_HEIGHT;
  const minLine = isNtsc ? NTSC_MIN_LINE : PAL_MIN_LINE;
  const maxLine = isNtsc ? NTSC_MAX_LINE : PAL_MAX_LINE;

  const h = snapOverscanHeight(height, videoStandard);
  let startLine: number;
  if (h < stdH) {
    // 200..254 lines in PAL: anchor at standard line 44 ($2C), matching NTSC-in-PAL game windows (e.g. Cadaver)
    startLine = stdStart;
  } else {
    const extraLines = h - stdH;
    startLine = stdStart - (extraLines >>> 1);
    if (startLine < minLine) startLine = minLine;
    if (startLine + h > maxLine) startLine = maxLine - h;
  }

  out.startLine = startLine;
  out.height = h;
}

export function copyOverscanLevelViewport(
  level: number,
  videoStandard: VideoStandard,
  out: OverscanViewport
): void {
  const clamped = clampOverscanLevel(level);
  const t = clamped / OVERSCAN_MAX_LEVEL;

  const maxSideLo = DENISE_STD_H_START - DENISE_MIN_H_LO; // 28 lo-res px each side
  const sideLo = Math.round(maxSideLo * t);
  const width = STD_FB_WIDTH + (sideLo << 2);

  const isNtsc = videoStandard === 'NTSC';
  const stdH = isNtsc ? NTSC_STD_HEIGHT : PAL_STD_HEIGHT;
  const minLine = isNtsc ? NTSC_MIN_LINE : PAL_MIN_LINE;
  const maxLine = isNtsc ? NTSC_MAX_LINE : PAL_MAX_LINE;
  const maxExtra = maxLine - minLine - stdH;
  const maxPairs = maxExtra >>> 1;
  const extraLines = Math.round(maxPairs * t) << 1;

  copyCustomOverscanViewport(width, stdH + extraLines, videoStandard, out);
}

export function getPresetViewport(
  mode: Exclude<OverscanPreset, 'auto'>,
  videoStandard: VideoStandard
): OverscanViewport {
  const src = videoStandard === 'NTSC' ? NTSC_PRESETS[mode] : PAL_PRESETS[mode];
  return {
    hOriginLo: src.hOriginLo,
    width: src.width,
    startLine: src.startLine,
    height: src.height,
  };
}

export function copyPresetViewport(
  mode: Exclude<OverscanPreset, 'auto'>,
  videoStandard: VideoStandard,
  out: OverscanViewport
): void {
  const src = videoStandard === 'NTSC' ? NTSC_PRESETS[mode] : PAL_PRESETS[mode];
  out.hOriginLo = src.hOriginLo;
  out.width = src.width;
  out.startLine = src.startLine;
  out.height = src.height;
}

export function copyOverscanViewport(
  mode: OverscanMode,
  videoStandard: VideoStandard,
  out: OverscanViewport
): void {
  if (typeof mode === 'number') {
    copyOverscanLevelViewport(mode, videoStandard, out);
    return;
  }
  if (mode === 'auto') {
    copyPresetViewport('none', videoStandard, out);
    return;
  }
  if (mode === 'none' || mode === 'tv' || mode === 'max') {
    copyPresetViewport(mode, videoStandard, out);
    return;
  }
  const packed = parseOverscanDimensionsPacked(mode);
  if (packed >= 0) {
    copyCustomOverscanViewport(packed >>> 16, packed & 0xffff, videoStandard, out);
    return;
  }
  copyPresetViewport('none', videoStandard, out);
}

export function getOverscanViewport(
  mode: OverscanMode,
  videoStandard: VideoStandard
): OverscanViewport {
  const out: OverscanViewport = { hOriginLo: 0x81, width: 640, startLine: 44, height: 256 };
  copyOverscanViewport(mode, videoStandard, out);
  return out;
}

export function viewportsEqual(a: OverscanViewport, b: OverscanViewport): boolean {
  return (
    a.hOriginLo === b.hOriginLo &&
    a.width === b.width &&
    a.startLine === b.startLine &&
    a.height === b.height
  );
}

/**
 * Computes physical CRT aspect ratio for a framebuffer or crop rectangle.
 * Preserves authentic Amiga pixel aspect ratio (PAR) across all overscan sizes:
 * - PAL: 640x256 -> exact 4:3 (hi-res pixel SAR = 8/15)
 * - NTSC: 640x200 -> exact 4:3 (hi-res pixel SAR = 5/12)
 */
export function computePhysicalAspect(
  width: number,
  height: number,
  videoStandard: VideoStandard = 'PAL'
): number {
  if (width <= 0 || height <= 0) return 4 / 3;
  if (videoStandard === 'NTSC') {
    return (width * 5) / (height * 12);
  }
  return (width * 8) / (height * 15);
}

/**
 * Computes CSS display aspect ratio for the CRT viewport.
 * When PAL height is manually trimmed below 256 (200..254 px), stretches vertically
 * like a 1084S V-SIZE dial (exact 4:3 at 640x200) so 200-line PAL games fill the screen
 * without black borders, matching NTSC 640x200 scaling.
 */
export function computeOverscanDisplayAspect(
  cropW: number,
  cropH: number,
  videoStandard: VideoStandard,
  autoCrop: boolean
): number {
  if (!autoCrop && videoStandard === 'PAL' && cropH > 0 && cropH < PAL_STD_HEIGHT) {
    return (cropW * 8) / (PAL_STD_HEIGHT * 15);
  }
  return computePhysicalAspect(cropW, cropH, videoStandard);
}

/**
 * Pure computation of the ideal Auto-Overscan viewport from observed hardware DIW bounds.
 * Writes directly into `out` (zero heap allocation when called from hot frame loop).
 */
export function computeAutoOverscanViewportInto(
  minH: number,
  maxH: number,
  minV: number,
  maxV: number,
  videoStandard: VideoStandard,
  out: OverscanViewport
): OverscanViewport {
  const isNtsc = videoStandard === 'NTSC';
  const stdStartV = isNtsc ? NTSC_STD_START_LINE : PAL_STD_START_LINE;
  const stdH = isNtsc ? NTSC_STD_HEIGHT : PAL_STD_HEIGHT;
  const stdStopV = stdStartV + stdH;
  const minLimitV = isNtsc ? NTSC_MIN_LINE : PAL_MIN_LINE;
  const maxLimitV = isNtsc ? NTSC_MAX_LINE : PAL_MAX_LINE;
  const maxTotalH = maxLimitV - minLimitV;

  // Clamp observed DIW to physical Denise visible limits
  let h0 = minH < DENISE_MIN_H_LO ? DENISE_MIN_H_LO : minH;
  if (h0 > DENISE_MAX_H_LO - 16) h0 = DENISE_MAX_H_LO - 16;
  let h1 = maxH > DENISE_MAX_H_LO ? DENISE_MAX_H_LO : maxH;
  if (h1 < h0 + 16) h1 = h0 + 16;
  if (h1 > DENISE_MAX_H_LO) h1 = DENISE_MAX_H_LO;

  let v0 = minV < minLimitV ? minLimitV : minV;
  if (v0 > maxLimitV - 16) v0 = maxLimitV - 16;
  let v1 = maxV > maxLimitV ? maxLimitV : maxV;
  if (v1 < v0 + 16) v1 = v0 + 16;
  if (v1 > maxLimitV) v1 = maxLimitV;

  // Horizontal: stay at exact standard [$81..$1C1] if DIW fits completely inside it
  let hOriginLo: number;
  let width: number;
  if (h0 >= DENISE_STD_H_START && h1 <= DENISE_STD_H_STOP) {
    hOriginLo = DENISE_STD_H_START;
    width = STD_FB_WIDTH;
  } else {
    const spanLo = h1 - h0;
    const reqLo = spanLo > 320 ? spanLo : 320;
    const maxLo = DENISE_MAX_H_LO - DENISE_MIN_H_LO; // 376
    let loW = (reqLo + 3) & ~3; // 4 lo-res (8 hi-res) alignment
    if (loW > maxLo) loW = maxLo;
    const extra = loW - spanLo;
    hOriginLo = h0 - (extra >>> 1);
    if (hOriginLo < DENISE_MIN_H_LO) hOriginLo = DENISE_MIN_H_LO;
    if (hOriginLo + loW > DENISE_MAX_H_LO) hOriginLo = DENISE_MAX_H_LO - loW;
    width = loW << 1;
  }

  // Vertical: stay at exact standard [44..300] (PAL) / [44..244] (NTSC) if DIW fits inside it
  let startLine: number;
  let height: number;
  if (v0 >= stdStartV && v1 <= stdStopV) {
    startLine = stdStartV;
    height = stdH;
  } else {
    const spanV = v1 - v0;
    const reqH = spanV > stdH ? spanV : stdH;
    let h = (reqH + 1) & ~1; // Even height
    if (h > maxTotalH) h = maxTotalH;
    const extra = h - spanV;
    startLine = v0 - (extra >>> 1);
    if (startLine < minLimitV) startLine = minLimitV;
    if (startLine + h > maxLimitV) startLine = maxLimitV - h;
    height = h;
  }

  out.hOriginLo = hOriginLo;
  out.width = width;
  out.startLine = startLine;
  out.height = height;
  return out;
}

export function computeAutoOverscanViewport(
  bounds: ActiveDiwBounds,
  videoStandard: VideoStandard
): OverscanViewport {
  const out: OverscanViewport = { hOriginLo: 0x81, width: 640, startLine: 44, height: 256 };
  return computeAutoOverscanViewportInto(
    bounds.minH,
    bounds.maxH,
    bounds.minV,
    bounds.maxV,
    videoStandard,
    out
  );
}

/**
 * Hysteresis-stabilized Auto-Overscan tracker (zero heap allocations per frame).
 * - Expands/unclips within 2 consecutive frames so game edges are never cut off.
 * - Ignores blank/fade-out frames to avoid jitter during disk loads.
 * - Shrinks/re-centers only after 20 stable frames (~0.4s) when returning to a smaller window.
 */
export class AutoOverscanTracker {
  public readonly current: OverscanViewport = { hOriginLo: 0x81, width: 640, startLine: 44, height: 256 };
  private readonly target: OverscanViewport = { hOriginLo: 0x81, width: 640, startLine: 44, height: 256 };
  private readonly pending: OverscanViewport = { hOriginLo: 0x81, width: 640, startLine: 44, height: 256 };
  private hasPending = false;
  private expandHold = 0;
  private shrinkHold = 0;

  public reset(videoStandard: VideoStandard): void {
    copyPresetViewport('none', videoStandard, this.current);
    this.hasPending = false;
    this.expandHold = 0;
    this.shrinkHold = 0;
  }

  /**
   * Feeds active hardware DIW bounds for the completed frame.
   * Returns `true` ONLY when `this.current` changed.
   */
  public update(
    active: boolean,
    minH: number,
    maxH: number,
    minV: number,
    maxV: number,
    videoStandard: VideoStandard
  ): boolean {
    if (!active || maxH <= minH || maxV <= minV) {
      return false;
    }

    const tgt = computeAutoOverscanViewportInto(minH, maxH, minV, maxV, videoStandard, this.target);
    const cur = this.current;

    if (viewportsEqual(cur, tgt)) {
      this.hasPending = false;
      this.expandHold = 0;
      this.shrinkHold = 0;
      return false;
    }

    const curRightLo = cur.hOriginLo + (cur.width >>> 1);
    const curBottom = cur.startLine + cur.height;
    const tgtRightLo = tgt.hOriginLo + (tgt.width >>> 1);
    const tgtBottom = tgt.startLine + tgt.height;

    const exposesOutside =
      tgt.hOriginLo < cur.hOriginLo ||
      tgtRightLo > curRightLo ||
      tgt.startLine < cur.startLine ||
      tgtBottom > curBottom;

    if (exposesOutside) {
      this.shrinkHold = 0;
      if (this.hasPending && viewportsEqual(this.pending, tgt)) {
        this.expandHold++;
      } else {
        this.pending.hOriginLo = tgt.hOriginLo;
        this.pending.width = tgt.width;
        this.pending.startLine = tgt.startLine;
        this.pending.height = tgt.height;
        this.hasPending = true;
        this.expandHold = 1;
      }

      if (this.expandHold >= 2) {
        cur.hOriginLo = tgt.hOriginLo;
        cur.width = tgt.width;
        cur.startLine = tgt.startLine;
        cur.height = tgt.height;
        this.hasPending = false;
        this.expandHold = 0;
        return true;
      }
      return false;
    }

    // Target fits inside current (shrinking or pure re-centering): apply after 20 stable frames
    this.expandHold = 0;
    if (this.hasPending && viewportsEqual(this.pending, tgt)) {
      this.shrinkHold++;
    } else {
      this.pending.hOriginLo = tgt.hOriginLo;
      this.pending.width = tgt.width;
      this.pending.startLine = tgt.startLine;
      this.pending.height = tgt.height;
      this.hasPending = true;
      this.shrinkHold = 1;
    }

    if (this.shrinkHold >= 20) {
      cur.hOriginLo = tgt.hOriginLo;
      cur.width = tgt.width;
      cur.startLine = tgt.startLine;
      cur.height = tgt.height;
      this.hasPending = false;
      this.shrinkHold = 0;
      return true;
    }

    return false;
  }
}

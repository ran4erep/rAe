/**
 * Commodore Amiga OCS / ECS / AGA Custom Chipset (Agnus/Alice, Denise/Lisa, Paula).
 * Optimized for minimal host CPU load:
 * - Zero heap allocations in scanline / Copper / Blitter / Denise / Lisa loops
 * - Precomputed 4096-entry 12-bit RGB -> ABGR32 LUT & EHB half-brite LUT
 * - Full 640x256 framebuffer (sharp Hi-Res Workbench + pixel-doubled Lo-Res games)
 * - Supports 1-8 bitplanes, 256 24-bit colors, EHB (64 colors), HAM6/HAM8, Dual Playfield, 8 Sprites (16/32/64px)
 */

import { ChipsetModel, JoystickState, OverscanMode, ResolvedVideoStandard } from '../types';
import { FloppyController } from './floppy';
import {
  AutoOverscanTracker,
  copyOverscanViewport,
  MAX_FB_HEIGHT,
  MAX_FB_WIDTH,
  OverscanViewport,
  STD_FB_HEIGHT,
  STD_FB_WIDTH,
} from './overscan';

export const FB_WIDTH = STD_FB_WIDTH;
export const FB_HEIGHT = STD_FB_HEIGHT;
export { MAX_FB_WIDTH, MAX_FB_HEIGHT };

// Precomputed 12-bit OCS/ECS RGB (0x0RGB) -> Little-Endian 32-bit ABGR (ImageData Uint32)
const RGB12_TO_ABGR32 = new Uint32Array(4096);
const RGB12_TO_EHB32 = new Uint32Array(4096);
for (let c = 0; c < 4096; c++) {
  const r4 = (c >>> 8) & 0xf;
  const g4 = (c >>> 4) & 0xf;
  const b4 = c & 0xf;
  const r8 = (r4 << 4) | r4;
  const g8 = (g4 << 4) | g4;
  const b8 = (b4 << 4) | b4;
  RGB12_TO_ABGR32[c] = (0xff000000 | (b8 << 16) | (g8 << 8) | r8) >>> 0;
  RGB12_TO_EHB32[c] =
    (0xff000000 | ((b8 >>> 1) << 16) | ((g8 >>> 1) << 8) | (r8 >>> 1)) >>> 0;
}
// AGA BPLCON3 PF2OF playfield 2 color table offset LUT
const PF2OF_TABLE = new Uint8Array([0, 2, 4, 8, 16, 32, 64, 128]);

export interface PaulaAudioChannel {
  lc: number;
  len: number;
  per: number;
  vol: number;
  curAddr: number;
  wordsLeft: number;
  phase: number;
  active: boolean;
  lastSample: number;
}

// Interrupt bits (INTENA / INTREQ)
export const INT_TBE = 1 << 0;
export const INT_DSKBLK = 1 << 1;
export const INT_SOFT = 1 << 2;
export const INT_PORTS = 1 << 3; // CIA-A (IPL 2)
export const INT_COPER = 1 << 4; // Copper (IPL 3)
export const INT_VERTB = 1 << 5; // Vertical Blank (IPL 3)
export const INT_BLIT = 1 << 6;  // Blitter finished (IPL 3)
export const INT_AUD0 = 1 << 7;  // Audio 0-3 (IPL 4)
export const INT_AUD1 = 1 << 8;
export const INT_AUD2 = 1 << 9;
export const INT_AUD3 = 1 << 10;
export const INT_RBF = 1 << 11;  // Serial receive (IPL 5)
export const INT_DSKSYN = 1 << 12; // Disk sync (IPL 5)
export const INT_EXTER = 1 << 13; // CIA-B (IPL 6)
export const INT_INTEN = 1 << 14; // Master IRQ enable

// DMACON bits
export const DMA_AUD0 = 1 << 0;
export const DMA_AUD1 = 1 << 1;
export const DMA_AUD2 = 1 << 2;
export const DMA_AUD3 = 1 << 3;
export const DMA_DISK = 1 << 4;
export const DMA_SPRITE = 1 << 5;
export const DMA_BLITTER = 1 << 6;
export const DMA_COPPER = 1 << 7;
export const DMA_BITPLANE = 1 << 8;
export const DMA_MASTER = 1 << 9;

export interface CpuProbeSource {
  readonly cycles: number;
  readonly pc: number;
  readonly sr: number;
}

export class AmigaChipset {
  public chipset: ChipsetModel = 'ECS';
  public videoStandard: ResolvedVideoStandard = 'PAL';
  public overscanMode: OverscanMode = 'none';

  // Raw custom register mirror ($DFF000 - $DFF1FE, 256 words)
  public readonly regs = new Uint16Array(256);

  // Core control registers
  public dmacon = 0;
  public intena = 0;
  public intreq = 0;
  public adkcon = 0;
  public lastIntenaMaskWriteVal = 0;
  public lastIntenaMaskWriteResult = 0;
  public lastIntenaMaskWritePc = 0;
  public ramIntenaWriteCount = 0;
  public lastRamIntenaWriteVal = 0;
  public lastRamIntenaWriteResult = 0;
  public lastRamIntenaWritePc = 0;
  public lastDmaconWriteVal = 0;
  public lastDmaconWriteResult = 0;
  public lastDmaconWritePc = 0;
  public lastCop1lcWritePc = 0;

  // Fixed zero-allocation 16-entry circular buffers for discrete RAM INTENA/DMACON writes (on-demand read only)
  private static readonly REG_HIST_CAP = 16;
  private readonly ramIntenaHistPc = new Uint32Array(AmigaChipset.REG_HIST_CAP);
  private readonly ramIntenaHistVal = new Uint16Array(AmigaChipset.REG_HIST_CAP);
  private readonly ramIntenaHistRes = new Uint16Array(AmigaChipset.REG_HIST_CAP);
  private ramIntenaHistIdx = 0;
  public ramDmaconWriteCount = 0;
  private readonly ramDmaconHistPc = new Uint32Array(AmigaChipset.REG_HIST_CAP);
  private readonly ramDmaconHistVal = new Uint16Array(AmigaChipset.REG_HIST_CAP);
  private readonly ramDmaconHistRes = new Uint16Array(AmigaChipset.REG_HIST_CAP);
  private ramDmaconHistIdx = 0;

  // Beam position
  public vpos = 0;
  public hpos = 0;
  public lof = 1; // Long frame toggle (stays 1 when non-interlaced; toggles when BPLCON0 LACE=1)
  public beamCon0 = 0x0020; // ECS BEAMCON0 bit 5 = PAL timing
  private cycleSource: CpuProbeSource | null = null;
  private scanlineStartCycles = 0;
  private scanlineCycleBudget = 0;

  // Zero-overhead NTSC PAL-raster-wait deadlock detector (active only when !isPalTiming())
  private ntscVposrPolls = 0;
  private ntscVposrSawEarly = false;
  private ntscVposrSawLate = false;
  private ntscVposrLargeGaps = 0;
  private ntscVposrLastCycle = 0;
  private ntscVposrPcMin = 0xffffffff;
  private ntscVposrPcMax = 0;
  private ntscInputPolled = false;
  private ntscPalDeadlockStreak = 0;
  private ntscSawPalCopperWrap = false;
  private ntscPalCopperStreak = 0;
  private ntscPalDiwStreak = 0;
  private ntscDiwStopWritten = false;

  // Zero-overhead sticky VERTB INTREQR poll detector (rescues RAM busy-waits when ROM L3 clears INTREQ)
  private vertbRamPollCount = 0;
  private vertbRamPollPcMin = 0xffffffff;
  private vertbRamPollPcMax = 0;
  private vertbRamPollStreak = 0;
  private vertbPollAssistFrames = 0;
  private vertbPollShadow = false;

  // Copper state
  public cop1lc = 0;
  public cop2lc = 0;
  public copPc = 0;
  public copCon = 0;
  public copWaitV = 0;
  public copWaitH = 0;
  public copMaskV = 0;
  public copMaskH = 0;
  public copWaiting = false;
  public copSkipNext = false;
  public copHpos = 0;

  // Blitter state
  public bltCon0 = 0;
  public bltCon1 = 0;
  public bltAfwm = 0xffff;
  public bltAlwm = 0xffff;
  public bltApt = 0;
  public bltBpt = 0;
  public bltCpt = 0;
  public bltDpt = 0;
  public bltAmod = 0;
  public bltBmod = 0;
  public bltCmod = 0;
  public bltDmod = 0;
  public bltAdat = 0;
  public bltBdat = 0;
  public bltCdat = 0;
  public bltSizV = 0;
  public bltZero = false;

  // Bitplane & Display window registers (8 pointers for AGA, 6 for OCS/ECS)
  public readonly bplPt = new Uint32Array(8);
  public bplCon0 = 0;
  public bplCon1 = 0;
  public bplCon2 = 0x0024;
  public bplCon3 = 0x0c00; // AGA PF2OF=3 (offset 8) default
  public bplCon4 = 0x0011; // AGA ESPRM=1, OSPRM=1 (sprite palette base 16) default
  public fmode = 0x0000;   // AGA Fetch Mode ($1FC): bits 1..0 BPL, bits 3..2 SPR
  public bpl1Mod = 0;
  public bpl2Mod = 0;
  public diwStrt = 0x2c81;
  public diwStop = 0x2cc1;
  public ddfStrt = 0x0038;
  public ddfStop = 0x00d0;
  public diwHigh = 0;
  public diwVStart = 0x2c;
  public diwVStop = 0x12c;
  public diwHStart = 0x81;
  public diwHStop = 0x1c1;

  // 32 (OCS/ECS 12-bit) / 256 (AGA 24-bit) hardware color registers + cached ABGR32 values
  public readonly colorReg = new Uint16Array(32);
  public readonly colorReg24 = new Uint32Array(256);
  public readonly colorAbgr = new Uint32Array(256);
  public readonly colorEhbAbgr = new Uint32Array(32);

  // 8 Hardware Sprites (16px OCS/ECS + 32px/64px AGA FMODE)
  public readonly sprPt = new Uint32Array(8);
  public readonly sprPos = new Uint16Array(8);
  public readonly sprCtl = new Uint16Array(8);
  public readonly sprData = new Uint16Array(8);
  public readonly sprDatb = new Uint16Array(8);
  public readonly sprDataLo = new Uint32Array(8);
  public readonly sprDataHi = new Uint32Array(8);
  public readonly sprDatbLo = new Uint32Array(8);
  public readonly sprDatbHi = new Uint32Array(8);
  private readonly sprArmed = new Uint8Array(8);         // Manual SPRxDATA arm
  private readonly sprDmaOn = new Uint8Array(8);         // Agnus/Alice DMA active for frame/chain
  private readonly sprDmaStreaming = new Uint8Array(8);  // Sprite DMA latched on at line === vStart until line === vStop
  private readonly sprDmaLineActive = new Uint8Array(8); // DMA fetched DATA/DATB on current scanline
  private sprHeadersFetchedThisFrame = false;

  // Floppy DMA registers (asynchronous scanline-paced Paula Disk DMA)
  public dskPt = 0;
  public dskLen = 0;
  public dskSync = 0x4489;
  private dskLenLatch = 0;
  public dskDmaActive = false;
  public dskDmaWordsLeft = 0;
  private dskDmaWrite = false;
  private dskDmaNeedSync = false;
  private dskDmaDelay = 0;
  private dskWordEqual = false;
  public turboFloppy = false;
  public onDiskDmaStart: ((wordCount: number, isWrite: boolean) => void) | null = null;
  private readonly readChip16Bound = (addr: number): number => this.readChip16(addr);
  private readonly writeChip16Bound = (addr: number, val: number): void => this.writeChip16(addr, val);

  // Paula 4-channel DMA Audio
  public readonly audio: PaulaAudioChannel[] = Array.from({ length: 4 }, () => ({
    lc: 0,
    len: 1,
    per: 400,
    vol: 0,
    curAddr: 0,
    wordsLeft: 0,
    phase: 0,
    active: false,
    lastSample: 0,
  }));

  // Input hardware state (Port 0 Mouse, Port 1 Joystick)
  public mouseX = 0;
  public mouseY = 0;
  public mouseRight = false;
  public mouseMiddle = false;
  public joy1Connected = true;
  public readonly joy1: JoystickState = {
    up: false,
    down: false,
    left: false,
    right: false,
    fire1: false,
    fire2: false,
  };

  // Backing framebuffer storage allocated ONCE at max Denise overscan (752 x 286, zero GC)
  private readonly fbStorage = new Uint32Array(MAX_FB_WIDTH * MAX_FB_HEIGHT);
  public fbWidth = FB_WIDTH;
  public fbHeight = FB_HEIGHT;
  public viewStartLine = 44;
  public viewHOriginLo = 0x81;
  // Active viewport slice into fbStorage (updated without copy only when viewport changes)
  public framebuffer: Uint32Array = this.fbStorage.subarray(0, FB_WIDTH * FB_HEIGHT);
  // Reusable scanline pixel index scratchpad (zero GC)
  private readonly lineIndices = new Uint8Array(MAX_FB_WIDTH);

  // Preallocated mid-scanline Copper palette change buffers (zero GC, 0% cost on normal scanlines)
  private static readonly MAX_MIDLINE_COLOR_CHANGES = 256;
  private readonly midlineColorX = new Uint16Array(AmigaChipset.MAX_MIDLINE_COLOR_CHANGES);
  private readonly midlineColorIdx = new Uint8Array(AmigaChipset.MAX_MIDLINE_COLOR_CHANGES);
  private readonly midlineColorVal = new Uint32Array(AmigaChipset.MAX_MIDLINE_COLOR_CHANGES);
  private readonly lineStartColorAbgr = new Uint32Array(256);
  private readonly lineStartColorEhb = new Uint32Array(32);
  private readonly workColorAbgr = new Uint32Array(256);
  private readonly workColorEhb = new Uint32Array(32);
  private midlineColorCount = 0;
  private midlinePaletteSaved = false;
  private midlineSavedCount = 32;
  private static readonly MAX_MIDLINE_BPLAM_CHANGES = 128;
  private readonly midlineBplamX = new Uint16Array(AmigaChipset.MAX_MIDLINE_BPLAM_CHANGES);
  private readonly midlineBplamVal = new Uint8Array(AmigaChipset.MAX_MIDLINE_BPLAM_CHANGES);
  private midlineBplamCount = 0;
  private lineStartBplam = 0;
  private inCopperVisibleSpan = false;

  // Overscan state (zero heap allocations per frame)
  private readonly autoOverscan = new AutoOverscanTracker();
  private readonly presetScratch: OverscanViewport = {
    hOriginLo: 0x81,
    width: FB_WIDTH,
    startLine: 44,
    height: FB_HEIGHT,
  };
  private frameDiwActive = false;
  private frameDiwMinV = 0x3ff;
  private frameDiwMaxV = 0;
  private frameDiwMinH = 0x3ff;
  private frameDiwMaxH = 0;
  private pendingAutoViewport = false;

  private chipRam: Uint8Array;
  private chipMask: number;
  private floppy: FloppyController;
  private onIplChange: (ipl: number) => void;

  constructor(
    chipRam: Uint8Array,
    floppy: FloppyController,
    onIplChange: (ipl: number) => void
  ) {
    this.chipRam = chipRam;
    this.chipMask = chipRam.length - 1;
    this.floppy = floppy;
    this.onIplChange = onIplChange;
    this.reset();
  }

  public attachChipRam(chipRam: Uint8Array): void {
    this.chipRam = chipRam;
    this.chipMask = chipRam.length - 1;
  }

  public attachCycleSource(source: CpuProbeSource): void {
    this.cycleSource = source;
  }

  private resetNtscDeadlockFrame(resetStreak: boolean): void {
    this.ntscVposrPolls = 0;
    this.ntscVposrSawEarly = false;
    this.ntscVposrSawLate = false;
    this.ntscVposrLargeGaps = 0;
    this.ntscVposrLastCycle = 0;
    this.ntscVposrPcMin = 0xffffffff;
    this.ntscVposrPcMax = 0;
    this.ntscInputPolled = false;
    this.ntscSawPalCopperWrap = false;
    if (resetStreak) {
      this.ntscPalDeadlockStreak = 0;
      this.ntscPalCopperStreak = 0;
      this.ntscPalDiwStreak = 0;
    }
  }

  public noteNtscInputPoll(): void {
    if (this.isPalTiming() || this.ntscInputPolled) return;
    const src = this.cycleSource;
    if (src !== null) {
      const ipl = src.sr & 0x0700;
      if (ipl !== 0 && ipl !== 0x0700) return;
    }
    this.ntscInputPolled = true;
  }

  public checkNtscPalRasterDeadlock(): boolean {
    if (this.isPalTiming() || this.cycleSource === null) {
      this.ntscPalDeadlockStreak = 0;
      return false;
    }
    const src = this.cycleSource;
    const endIpl = src.sr & 0x0700;
    const pcSpan = this.ntscVposrPcMax >= this.ntscVposrPcMin
      ? (this.ntscVposrPcMax - this.ntscVposrPcMin)
      : 0xffffffff;
    const nearEndPc =
      endIpl === 0 || endIpl === 0x0700
        ? Math.abs((src.pc >>> 0) - this.ntscVposrPcMin) <= 64
        : true;
    const stuckThisFrame =
      !this.ntscInputPolled &&
      this.ntscVposrPolls >= 400 &&
      this.ntscVposrSawEarly &&
      this.ntscVposrSawLate &&
      this.ntscVposrLargeGaps <= 6 &&
      pcSpan <= 48 &&
      nearEndPc;
    if (!stuckThisFrame) {
      this.ntscPalDeadlockStreak = 0;
      return false;
    }
    this.ntscPalDeadlockStreak++;
    if (this.ntscPalDeadlockStreak >= 15) {
      this.resetNtscDeadlockFrame(true);
      return true;
    }
    return false;
  }

  public checkNtscNeedsPal(allowGeometryDetect: boolean): 'deadlock' | 'diw' | 'copper' | null {
    if (this.isPalTiming()) {
      this.ntscPalDeadlockStreak = 0;
      this.ntscPalCopperStreak = 0;
      this.ntscPalDiwStreak = 0;
      return null;
    }
    if (this.checkNtscPalRasterDeadlock()) {
      return 'deadlock';
    }
    if (!allowGeometryDetect) {
      this.ntscPalCopperStreak = 0;
      this.ntscPalDiwStreak = 0;
      return null;
    }
    if (this.ntscSawPalCopperWrap) {
      this.ntscPalCopperStreak++;
      if (this.ntscPalCopperStreak >= 4) {
        this.resetNtscDeadlockFrame(true);
        return 'copper';
      }
    } else {
      this.ntscPalCopperStreak = 0;
    }
    if (
      this.ntscDiwStopWritten &&
      this.frameDiwActive &&
      this.diwVStop > 262 &&
      this.diwVStop <= 312 &&
      this.diwVStart < this.diwVStop &&
      this.diwHStop > this.diwHStart
    ) {
      this.ntscPalDiwStreak++;
      if (this.ntscPalDiwStreak >= 6) {
        this.resetNtscDeadlockFrame(true);
        return 'diw';
      }
    } else {
      this.ntscPalDiwStreak = 0;
    }
    return null;
  }

  public beginScanline(line: number, startCycles: number, cycleBudget: number): void {
    this.vpos = line;
    this.hpos = 0;
    this.scanlineStartCycles = startCycles;
    this.scanlineCycleBudget = cycleBudget;
  }

  public getHpos(): number {
    if (this.scanlineCycleBudget > 0 && this.cycleSource !== null) {
      const elapsed = this.cycleSource.cycles - this.scanlineStartCycles;
      if (elapsed <= 0) return 0;
      const hp = ((elapsed * 227) / this.scanlineCycleBudget) | 0;
      return hp > 226 ? 226 : hp;
    }
    return this.hpos & 0xff;
  }

  private applyViewport(vp: OverscanViewport): void {
    const dimChanged = this.fbWidth !== vp.width || this.fbHeight !== vp.height;
    this.viewHOriginLo = vp.hOriginLo;
    this.viewStartLine = vp.startLine;
    this.fbWidth = vp.width;
    this.fbHeight = vp.height;
    if (dimChanged) {
      this.framebuffer = this.fbStorage.subarray(0, vp.width * vp.height);
      this.framebuffer.fill(0xff000000);
    }
  }

  public setOverscanConfig(
    mode: OverscanMode,
    videoStandard: ResolvedVideoStandard,
    forceResetAuto = false
  ): void {
    const modeChanged = this.overscanMode !== mode;
    const stdChanged = this.videoStandard !== videoStandard;
    this.overscanMode = mode;
    this.videoStandard = videoStandard;
    if (stdChanged) {
      this.resetNtscDeadlockFrame(true);
      this.ntscDiwStopWritten = false;
      if (((this.beamCon0 & 0x0020) !== 0) !== (videoStandard === 'PAL')) {
        this.beamCon0 = videoStandard === 'PAL' ? 0x0020 : 0x0000;
      }
    }

    if (mode === 'auto') {
      if (forceResetAuto || modeChanged || stdChanged) {
        this.pendingAutoViewport = false;
        this.autoOverscan.reset(videoStandard);
        this.applyViewport(this.autoOverscan.current);
      }
    } else {
      this.pendingAutoViewport = false;
      copyOverscanViewport(mode, videoStandard, this.presetScratch);
      this.applyViewport(this.presetScratch);
    }
  }

  public isPalTiming(): boolean {
    return this.chipset !== 'OCS'
      ? (this.beamCon0 & 0x0020) !== 0
      : this.videoStandard === 'PAL';
  }

  public reset(): void {
    this.regs.fill(0);
    this.dmacon = 0;
    this.intena = 0;
    this.intreq = 0;
    this.adkcon = 0;
    this.lastIntenaMaskWriteVal = 0;
    this.lastIntenaMaskWriteResult = 0;
    this.lastIntenaMaskWritePc = 0;
    this.ramIntenaWriteCount = 0;
    this.lastRamIntenaWriteVal = 0;
    this.lastRamIntenaWriteResult = 0;
    this.lastRamIntenaWritePc = 0;
    this.lastDmaconWriteVal = 0;
    this.lastDmaconWriteResult = 0;
    this.lastDmaconWritePc = 0;
    this.lastCop1lcWritePc = 0;
    this.ramIntenaHistIdx = 0;
    this.ramIntenaHistPc.fill(0);
    this.ramIntenaHistVal.fill(0);
    this.ramIntenaHistRes.fill(0);
    this.ramDmaconWriteCount = 0;
    this.ramDmaconHistIdx = 0;
    this.ramDmaconHistPc.fill(0);
    this.ramDmaconHistVal.fill(0);
    this.ramDmaconHistRes.fill(0);
    this.vpos = 0;
    this.hpos = 0;
    this.scanlineStartCycles = 0;
    this.scanlineCycleBudget = 0;
    this.ntscDiwStopWritten = false;
    this.resetNtscDeadlockFrame(true);
    this.vertbRamPollCount = 0;
    this.vertbRamPollPcMin = 0xffffffff;
    this.vertbRamPollPcMax = 0;
    this.vertbRamPollStreak = 0;
    this.vertbPollAssistFrames = 0;
    this.vertbPollShadow = false;
    this.lof = 1;
    this.beamCon0 = this.videoStandard === 'PAL' ? 0x0020 : 0x0000;
    this.midlineColorCount = 0;
    this.midlinePaletteSaved = false;
    this.midlineBplamCount = 0;
    this.lineStartBplam = 0;
    this.inCopperVisibleSpan = false;
    this.cop1lc = 0;
    this.cop2lc = 0;
    this.copPc = 0;
    this.copCon = 0;
    this.copWaiting = false;
    this.copSkipNext = false;
    this.copHpos = 0;

    this.bplPt.fill(0);
    this.bplCon0 = 0;
    this.bplCon1 = 0;
    this.bplCon2 = 0x0024;
    this.bplCon3 = 0x0c00;
    this.bplCon4 = 0x0011;
    this.fmode = 0;
    this.bpl1Mod = 0;
    this.bpl2Mod = 0;
    this.diwStrt = 0x2c81;
    this.diwStop = 0x2cc1;
    this.ddfStrt = 0x0038;
    this.ddfStop = 0x00d0;
    this.diwHigh = 0;
    this.diwVStart = 0x2c;
    this.diwVStop = 0x12c;
    this.diwHStart = 0x81;
    this.diwHStop = 0x1c1;
    this.setOverscanConfig(this.overscanMode, this.videoStandard, true);

    this.colorReg.fill(0);
    this.colorReg24.fill(0);
    this.colorAbgr.fill(0xff000000);
    for (let i = 0; i < 32; i++) {
      this.colorEhbAbgr[i] = RGB12_TO_EHB32[0];
    }

    this.sprPt.fill(0);
    this.sprPos.fill(0);
    this.sprCtl.fill(0);
    this.sprData.fill(0);
    this.sprDatb.fill(0);
    this.sprDataLo.fill(0);
    this.sprDataHi.fill(0);
    this.sprDatbLo.fill(0);
    this.sprDatbHi.fill(0);
    this.sprArmed.fill(0);
    this.sprDmaOn.fill(0);
    this.sprDmaStreaming.fill(0);
    this.sprDmaLineActive.fill(0);
    this.sprHeadersFetchedThisFrame = false;

    this.dskPt = 0;
    this.dskLen = 0;
    this.dskLenLatch = 0;
    this.dskSync = 0x4489;
    this.dskDmaActive = false;
    this.dskDmaWordsLeft = 0;
    this.dskDmaWrite = false;
    this.dskDmaNeedSync = false;
    this.dskDmaDelay = 0;
    this.dskWordEqual = false;

    for (let i = 0; i < 4; i++) {
      const ch = this.audio[i];
      ch.lc = 0;
      ch.len = 1;
      ch.per = 400;
      ch.vol = 0;
      ch.active = false;
      ch.curAddr = 0;
      ch.wordsLeft = 0;
      ch.phase = 0;
      ch.lastSample = 0;
    }

    this.framebuffer.fill(0xff000000);
    this.updateIpl();
  }

  private readChip16(addr: number): number {
    const a = addr & this.chipMask & ~1;
    return (this.chipRam[a] << 8) | this.chipRam[a + 1];
  }

  private writeChip16(addr: number, val: number): void {
    const a = addr & this.chipMask & ~1;
    this.chipRam[a] = (val >>> 8) & 0xff;
    this.chipRam[a + 1] = val & 0xff;
  }

  /** On-demand chronological log of recent RAM writes to INTENA (allocates only when called by debug/triage). */
  public getRamIntenaHistory(): Array<{ pc: number; val: number; result: number }> {
    const cap = AmigaChipset.REG_HIST_CAP;
    const total = Math.min(this.ramIntenaWriteCount, cap);
    const out: Array<{ pc: number; val: number; result: number }> = [];
    const start = this.ramIntenaWriteCount >= cap ? this.ramIntenaHistIdx : 0;
    for (let i = 0; i < total; i++) {
      const slot = (start + i) & (cap - 1);
      out.push({
        pc: this.ramIntenaHistPc[slot] >>> 0,
        val: this.ramIntenaHistVal[slot] & 0xffff,
        result: this.ramIntenaHistRes[slot] & 0xffff,
      });
    }
    return out;
  }

  /** On-demand chronological log of recent RAM writes to DMACON (allocates only when called by debug/triage). */
  public getRamDmaconHistory(): Array<{ pc: number; val: number; result: number }> {
    const cap = AmigaChipset.REG_HIST_CAP;
    const total = Math.min(this.ramDmaconWriteCount, cap);
    const out: Array<{ pc: number; val: number; result: number }> = [];
    const start = this.ramDmaconWriteCount >= cap ? this.ramDmaconHistIdx : 0;
    for (let i = 0; i < total; i++) {
      const slot = (start + i) & (cap - 1);
      out.push({
        pc: this.ramDmaconHistPc[slot] >>> 0,
        val: this.ramDmaconHistVal[slot] & 0xffff,
        result: this.ramDmaconHistRes[slot] & 0xffff,
      });
    }
    return out;
  }

  public requestIrq(bits: number): void {
    this.intreq |= bits & 0x3fff;
    if (
      (bits & INT_VERTB) !== 0 &&
      this.vertbPollAssistFrames > 0 &&
      (this.intena & (INT_INTEN | INT_VERTB)) === (INT_INTEN | INT_VERTB)
    ) {
      this.vertbPollShadow = true;
    }
    this.updateIpl();
  }

  public clearIrq(bits: number): void {
    this.intreq &= ~(bits & 0x3fff);
    this.updateIpl();
  }

  public updateIpl(): void {
    if ((this.intena & INT_INTEN) === 0) {
      this.onIplChange(0);
      return;
    }
    const active = this.intena & this.intreq & 0x3fff;
    let ipl = 0;
    if (active & INT_EXTER) ipl = 6;
    else if (active & (INT_DSKSYN | INT_RBF)) ipl = 5;
    else if (active & (INT_AUD0 | INT_AUD1 | INT_AUD2 | INT_AUD3)) ipl = 4;
    else if (active & (INT_BLIT | INT_VERTB | INT_COPER)) ipl = 3;
    else if (active & INT_PORTS) ipl = 2;
    else if (active & (INT_SOFT | INT_DSKBLK | INT_TBE)) ipl = 1;
    this.onIplChange(ipl);
  }

  /**
   * Computes authentic Amiga JOY1DAT hardware word from digital joystick directions.
   * Hardware mapping:
   * Right = bit 1; Left = bit 9; Down = bit 1 ^ bit 0; Up = bit 9 ^ bit 8.
   */
  public encodeJoy1Dat(): number {
    if (!this.joy1Connected) return 0;
    const j = this.joy1;
    let lo = 0;
    let hi = 0;
    if (j.right) lo |= 0x02;
    if (j.left) hi |= 0x02;
    const bit0 = (j.down ? 1 : 0) ^ (j.right ? 1 : 0);
    const bit8 = (j.up ? 1 : 0) ^ (j.left ? 1 : 0);
    lo |= bit0;
    hi |= bit8;
    return (hi << 8) | lo;
  }

  public readReg16(offset: number): number {
    const reg = offset & 0x1fe;
    switch (reg) {
      case 0x002: { // DMACONR
        let val = this.dmacon & 0x07ff;
        if (this.bltZero) val |= 0x2000; // BZERO
        // BBUSY (bit 14) is 0 because synchronous Blitter completes cleanly
        return val;
      }
      case 0x004: { // VPOSR (Agnus ID + V8)
        // OCS PAL=$00, OCS NTSC=$10, ECS PAL=$20, ECS NTSC=$30
        const pal = this.isPalTiming();
        if (!pal && this.cycleSource !== null) {
          const src = this.cycleSource;
          const ipl = src.sr & 0x0700;
          if (ipl === 0 || ipl === 0x0700) {
            const polls = this.ntscVposrPolls;
            const cyc = src.cycles;
            if (polls > 0 && cyc - this.ntscVposrLastCycle > 300) {
              this.ntscVposrLargeGaps++;
            }
            this.ntscVposrLastCycle = cyc;
            this.ntscVposrPolls = polls + 1;
            const pc = src.pc >>> 0;
            if (pc < this.ntscVposrPcMin) this.ntscVposrPcMin = pc;
            if (pc > this.ntscVposrPcMax) this.ntscVposrPcMax = pc;
            if (this.vpos <= 60) this.ntscVposrSawEarly = true;
            if (this.vpos >= 258) this.ntscVposrSawLate = true;
          }
        }
        // OCS PAL=$00, NTSC=$10; ECS PAL=$20, NTSC=$30; AGA Alice PAL=$22, NTSC=$32
        let id = 0x00;
        if (this.chipset === 'ECS') id |= 0x20;
        else if (this.chipset === 'AGA') id |= 0x22;
        if (!pal) id |= 0x10;
        return ((this.lof & 1) << 15) | (id << 8) | ((this.vpos >>> 8) & 1);
      }
      case 0x006: // VHPOSR
        return ((this.vpos & 0xff) << 8) | this.getHpos();
      case 0x00a: // JOY0DAT (Mouse Y high byte, X low byte)
        if (!this.isPalTiming()) this.noteNtscInputPoll();
        return ((this.mouseY & 0xff) << 8) | (this.mouseX & 0xff);
      case 0x00c: // JOY1DAT (Joystick port 2)
        if (!this.isPalTiming()) this.noteNtscInputPoll();
        return this.encodeJoy1Dat();
      case 0x00e: // CLXDAT
        return 0;
      case 0x010: // ADKCONR
        return this.adkcon & 0x7fff;
      case 0x016: { // POTGOR / POTINP (active-low secondary mouse/joy buttons)
        if (!this.isPalTiming()) this.noteNtscInputPoll();
        let val = 0x5500;
        if (this.mouseRight) val &= ~0x0400;  // Port 0 RMB (bit 10)
        if (this.mouseMiddle) val &= ~0x0100; // Port 0 MMB (bit 8)
        if (this.joy1Connected && this.joy1.fire2) val &= ~0x4000;  // Port 1 Fire 2 (bit 14)
        return val;
      }
      case 0x018: // SERDATR (TBE=1, TSRE=1)
        return 0x3000;
      case 0x01a: { // DSKBYTR
        const dmaOn =
          this.dskDmaActive &&
          (this.dmacon & (DMA_MASTER | DMA_DISK)) === (DMA_MASTER | DMA_DISK);
        let val = 0x8000 | this.floppy.peekCurrentMfmByte();
        if (dmaOn) val |= 0x4000;
        if ((this.dskLen & 0x4000) !== 0) val |= 0x2000;
        if (this.dskWordEqual) val |= 0x1000;
        return val;
      }
      case 0x01c: // INTENAR
        return this.intena & 0x7fff;
      case 0x01e: { // INTREQR
        const src = this.cycleSource;
        if (src !== null) {
          const pc = src.pc >>> 0;
          if (pc < 0xf80000 && (src.sr & 0x0700) < 0x0300) {
            if (
              this.vertbPollAssistFrames > 0 ||
              (this.intena & (INT_INTEN | INT_VERTB)) === (INT_INTEN | INT_VERTB)
            ) {
              this.vertbRamPollCount++;
              if (pc < this.vertbRamPollPcMin) this.vertbRamPollPcMin = pc;
              if (pc > this.vertbRamPollPcMax) this.vertbRamPollPcMax = pc;
            }
            if (this.vertbPollShadow) {
              if (this.vertbPollAssistFrames < 16) this.vertbPollAssistFrames = 16;
              return (this.intreq & 0x7fff) | INT_VERTB;
            }
          }
        }
        return this.intreq & 0x7fff;
      }
      case 0x07c: // DENISEID / LISAID (OCS=$FFFF, ECS=$00FC, AGA Lisa=$00F8)
        return this.chipset === 'AGA' ? 0x00f8 : this.chipset === 'ECS' ? 0x00fc : 0xffff;
      default:
        return this.regs[reg >>> 1];
    }
  }

  public writeReg16(offset: number, val: number): void {
    const reg = offset & 0x1fe;
    const v = val & 0xffff;
    this.regs[reg >>> 1] = v;

    // Color registers $180 - $1BE (fast hot path for OCS/ECS + 256-color 24-bit banked AGA)
    if (reg >= 0x180 && reg <= 0x1be) {
      const idx = (reg - 0x180) >>> 1;
      if (this.chipset !== 'AGA') {
        const c12 = v & 0x0fff;
        const abgr = RGB12_TO_ABGR32[c12];
        if (this.inCopperVisibleSpan) {
          const pxX = (((this.copHpos - 2) << 1) - this.viewHOriginLo) << 1;
          if (pxX > 0 && this.midlineColorCount < AmigaChipset.MAX_MIDLINE_COLOR_CHANGES) {
            if (!this.midlinePaletteSaved) {
              this.lineStartColorAbgr.set(this.colorAbgr.subarray(0, 32));
              if ((this.bplCon0 & 0x0c00) === 0 && ((this.bplCon0 >>> 12) & 7) === 6) {
                this.lineStartColorEhb.set(this.colorEhbAbgr);
              }
              this.midlinePaletteSaved = true;
              this.midlineSavedCount = 32;
            }
            const n = this.midlineColorCount++;
            this.midlineColorX[n] = pxX;
            this.midlineColorIdx[n] = idx;
            this.midlineColorVal[n] = abgr;
          }
        }
        this.colorReg[idx] = c12;
        this.colorAbgr[idx] = abgr;
        this.colorEhbAbgr[idx] = RGB12_TO_EHB32[c12];
        return;
      }

      const bank = (this.bplCon3 >>> 13) & 7;
      const loct = (this.bplCon3 & 0x0200) !== 0;
      const bankIdx = (bank << 5) | idx;
      const r4 = (v >>> 8) & 0xf;
      const g4 = (v >>> 4) & 0xf;
      const b4 = v & 0xf;
      let r8: number;
      let g8: number;
      let b8: number;
      if (loct) {
        const prev24 = this.colorReg24[bankIdx];
        r8 = ((prev24 >>> 16) & 0xf0) | r4;
        g8 = ((prev24 >>> 8) & 0xf0) | g4;
        b8 = (prev24 & 0xf0) | b4;
      } else {
        r8 = (r4 << 4) | r4;
        g8 = (g4 << 4) | g4;
        b8 = (b4 << 4) | b4;
        if (bank === 0) {
          const c12 = v & 0x0fff;
          this.colorReg[idx] = c12;
          this.colorEhbAbgr[idx] = RGB12_TO_EHB32[c12];
        }
      }
      this.colorReg24[bankIdx] = ((r8 << 16) | (g8 << 8) | b8) >>> 0;
      const abgr = (0xff000000 | (b8 << 16) | (g8 << 8) | r8) >>> 0;
      if (this.inCopperVisibleSpan) {
        const pxX = (((this.copHpos - 2) << 1) - this.viewHOriginLo) << 1;
        if (pxX > 0 && this.midlineColorCount < AmigaChipset.MAX_MIDLINE_COLOR_CHANGES) {
          if (!this.midlinePaletteSaved) {
            this.lineStartColorAbgr.set(this.colorAbgr);
            const bpuNow = ((this.bplCon0 >>> 12) & 7) | ((this.bplCon0 & 0x0010) !== 0 ? 8 : 0);
            if ((this.bplCon0 & 0x0c00) === 0 && bpuNow === 6 && (this.bplCon2 & 0x0200) === 0) {
              this.lineStartColorEhb.set(this.colorEhbAbgr);
            }
            this.midlinePaletteSaved = true;
            this.midlineSavedCount = 256;
          }
          const n = this.midlineColorCount++;
          this.midlineColorX[n] = pxX;
          this.midlineColorIdx[n] = bankIdx;
          this.midlineColorVal[n] = abgr;
        }
      }
      this.colorAbgr[bankIdx] = abgr;
      return;
    }

    // Bitplane pointers $0E0 - $0FE (6 planes on OCS/ECS, 8 planes on AGA)
    if (reg >= 0x0e0 && reg <= (this.chipset === 'AGA' ? 0x0fe : 0x0f6)) {
      const idx = (reg - 0x0e0) >>> 2;
      if ((reg & 2) === 0) {
        this.bplPt[idx] = ((v & 0x1f) << 16) | (this.bplPt[idx] & 0xffff);
      } else {
        this.bplPt[idx] = (this.bplPt[idx] & 0x1f0000) | (v & 0xfffe);
      }
      return;
    }

    // Sprite pointers $120 - $13E
    if (reg >= 0x120 && reg <= 0x13e) {
      const idx = (reg - 0x120) >>> 2;
      if ((reg & 2) === 0) {
        this.sprPt[idx] = ((v & 0x1f) << 16) | (this.sprPt[idx] & 0xffff);
      } else {
        this.sprPt[idx] = (this.sprPt[idx] & 0x1f0000) | (v & 0xfffe);
        this.sprDmaStreaming[idx] = 0;
        if (this.sprHeadersFetchedThisFrame) {
          this.sprDmaOn[idx] =
            this.sprPt[idx] !== 0 && (this.sprPos[idx] !== 0 || this.sprCtl[idx] !== 0) ? 1 : 0;
        }
      }
      return;
    }

    // Sprite POS/CTL/DATA/DATB $140 - $17E
    if (reg >= 0x140 && reg <= 0x17e) {
      const idx = (reg - 0x140) >>> 3;
      const sub = (reg >>> 1) & 3;
      if (sub === 0) {
        this.sprPos[idx] = v;
      } else if (sub === 1) {
        this.sprCtl[idx] = v;
        this.sprArmed[idx] = 0;
        this.sprDmaStreaming[idx] = 0;
        if (this.sprHeadersFetchedThisFrame) {
          this.sprDmaOn[idx] =
            this.sprPt[idx] !== 0 && (this.sprPos[idx] !== 0 || v !== 0) ? 1 : 0;
        }
      } else if (sub === 2) {
        this.sprData[idx] = v;
        this.sprDataLo[idx] =
          this.chipset === 'AGA' && ((this.fmode >>> 2) & 3) !== 0 ? (v << 16) >>> 0 : v;
        this.sprDataHi[idx] = 0;
        this.sprArmed[idx] = 1;
      } else {
        this.sprDatb[idx] = v;
        this.sprDatbLo[idx] =
          this.chipset === 'AGA' && ((this.fmode >>> 2) & 3) !== 0 ? (v << 16) >>> 0 : v;
        this.sprDatbHi[idx] = 0;
      }
      return;
    }

    // Audio channels $0A0 - $0DE
    if (reg >= 0x0a0 && reg <= 0x0de) {
      const chIdx = (reg - 0x0a0) >>> 4;
      const sub = reg & 0x0e;
      const ch = this.audio[chIdx];
      if (sub === 0x00) ch.lc = ((v & 0x1f) << 16) | (ch.lc & 0xffff);
      else if (sub === 0x02) ch.lc = (ch.lc & 0x1f0000) | (v & 0xfffe);
      else if (sub === 0x04) ch.len = v === 0 ? 0x10000 : v;
      else if (sub === 0x06) ch.per = v < 124 ? 124 : v;
      else if (sub === 0x08) {
        const vol = v & 0x7f;
        ch.vol = vol > 64 ? 64 : vol;
      }
      else if (sub === 0x0a) {
        // Direct AUDxDAT write
        ch.lastSample = ((v << 16) >> 24);
      }
      return;
    }

    switch (reg) {
      case 0x020: this.dskPt = ((v & 0x1f) << 16) | (this.dskPt & 0xffff); break;
      case 0x022: this.dskPt = (this.dskPt & 0x1f0000) | (v & 0xfffe); break;
      case 0x024: { // DSKLEN (writing twice with bit 15 set arms asynchronous Paula Disk DMA)
        const prev = this.dskLenLatch;
        this.dskLenLatch = v;
        this.dskLen = v;
        if ((v & 0x8000) === 0) {
          // Bit 15 = 0 immediately aborts any in-flight Disk DMA (used by custom trackloaders)
          this.dskDmaActive = false;
          this.dskDmaWordsLeft = 0;
          this.dskDmaDelay = 0;
          this.dskWordEqual = false;
        } else if ((prev & 0x8000) !== 0) {
          const wordCount = v & 0x3fff;
          this.dskDmaActive = true;
          this.dskDmaWordsLeft = wordCount;
          this.dskDmaWrite = (v & 0x4000) !== 0;
          this.dskDmaNeedSync = (this.adkcon & 0x0400) !== 0;
          this.dskWordEqual = false;
          // Give CPU realistic startup window before DMA/DSKBLK fires (prevents clearing INTREQ/flags mid-setup)
          this.dskDmaDelay = this.turboFloppy ? 4 : 2;
          if (this.dskDmaWrite && wordCount > 0) {
            this.floppy.beginDiskDmaWrite();
          }
          this.onDiskDmaStart?.(wordCount, this.dskDmaWrite);
          this.dskLenLatch = 0;
        }
        break;
      }
      case 0x02a: // VPOSW
        this.lof = (v >>> 15) & 1;
        break;
      case 0x02e: this.copCon = v & 0x0002; break;
      case 0x040: this.bltCon0 = v; break;
      case 0x042: this.bltCon1 = v; break;
      case 0x044: this.bltAfwm = v; break;
      case 0x046: this.bltAlwm = v; break;
      case 0x048: this.bltCpt = ((v & 0x1f) << 16) | (this.bltCpt & 0xffff); break;
      case 0x04a: this.bltCpt = (this.bltCpt & 0x1f0000) | (v & 0xfffe); break;
      case 0x04c: this.bltBpt = ((v & 0x1f) << 16) | (this.bltBpt & 0xffff); break;
      case 0x04e: this.bltBpt = (this.bltBpt & 0x1f0000) | (v & 0xfffe); break;
      case 0x050: this.bltApt = ((v & 0x1f) << 16) | (this.bltApt & 0xffff); break;
      case 0x052: this.bltApt = (this.bltApt & 0x1f0000) | (v & 0xfffe); break;
      case 0x054: this.bltDpt = ((v & 0x1f) << 16) | (this.bltDpt & 0xffff); break;
      case 0x056: this.bltDpt = (this.bltDpt & 0x1f0000) | (v & 0xfffe); break;
      case 0x058: { // BLTSIZE (starts OCS Blitter immediately)
        const height = (v >>> 6) & 0x3ff;
        const width = v & 0x3f;
        this.runBlitter(width === 0 ? 64 : width, height === 0 ? 1024 : height);
        break;
      }
      case 0x05a: // ECS/AGA BLTCON0L (updates low minterm byte without clobbering channel/shift bits)
        if (this.chipset !== 'OCS') {
          this.bltCon0 = (this.bltCon0 & 0xff00) | (v & 0xff);
        }
        break;
      case 0x05c: // ECS BLTSIZV
        this.bltSizV = v & 0x7fff;
        break;
      case 0x05e: { // ECS BLTSIZH (triggers ECS Blitter)
        const w = v & 0x7ff;
        const h = this.bltSizV;
        this.runBlitter(w === 0 ? 2048 : w, h === 0 ? 32768 : h);
        break;
      }
      case 0x060: this.bltCmod = (v << 16) >> 16; break;
      case 0x062: this.bltBmod = (v << 16) >> 16; break;
      case 0x064: this.bltAmod = (v << 16) >> 16; break;
      case 0x066: this.bltDmod = (v << 16) >> 16; break;
      case 0x070: this.bltCdat = v; break;
      case 0x072: this.bltBdat = v; break;
      case 0x074: this.bltAdat = v; break;
      case 0x07e: this.dskSync = v; break;
      case 0x080: this.cop1lc = ((v & 0x1f) << 16) | (this.cop1lc & 0xffff); break;
      case 0x082:
        this.cop1lc = (this.cop1lc & 0x1f0000) | (v & 0xfffe);
        this.lastCop1lcWritePc = this.cycleSource !== null ? this.cycleSource.pc & 0x00ffffff : 0;
        break;
      case 0x084: this.cop2lc = ((v & 0x1f) << 16) | (this.cop2lc & 0xffff); break;
      case 0x086: this.cop2lc = (this.cop2lc & 0x1f0000) | (v & 0xfffe); break;
      case 0x088: // COPJMP1
        this.copPc = this.cop1lc;
        this.copWaiting = false;
        this.copSkipNext = false;
        break;
      case 0x08a: // COPJMP2
        this.copPc = this.cop2lc;
        this.copWaiting = false;
        this.copSkipNext = false;
        break;
      case 0x08e:
        this.diwStrt = v;
        this.diwVStart = (v >>> 8) & 0xff;
        this.diwHStart = v & 0xff;
        break;
      case 0x090: {
        this.diwStop = v;
        this.ntscDiwStopWritten = true;
        const vs = (v >>> 8) & 0xff;
        this.diwVStop = (vs & 0x80) === 0 ? (vs | 0x100) : vs;
        this.diwHStop = (v & 0xff) | 0x100;
        break;
      }
      case 0x092: this.ddfStrt = v & (this.chipset !== 'OCS' ? 0x01fc : 0x00fc); break;
      case 0x094: this.ddfStop = v & (this.chipset !== 'OCS' ? 0x01fc : 0x00fc); break;
      case 0x096: { // DMACON
        const prev = this.dmacon;
        if (v & 0x8000) this.dmacon |= v & 0x07ff;
        else this.dmacon &= ~(v & 0x07ff);
        const wrPc = this.cycleSource !== null ? this.cycleSource.pc & 0x00ffffff : 0;
        this.lastDmaconWriteVal = v;
        this.lastDmaconWriteResult = this.dmacon;
        this.lastDmaconWritePc = wrPc;
        if (wrPc > 0 && wrPc < 0xf80000) {
          const slot = this.ramDmaconHistIdx;
          this.ramDmaconHistPc[slot] = wrPc;
          this.ramDmaconHistVal[slot] = v;
          this.ramDmaconHistRes[slot] = this.dmacon;
          this.ramDmaconHistIdx = (slot + 1) & (AmigaChipset.REG_HIST_CAP - 1);
          this.ramDmaconWriteCount++;
        }
        // Trigger audio channel DMA reload on rising edge
        const master = (this.dmacon & DMA_MASTER) !== 0;
        for (let i = 0; i < 4; i++) {
          const bit = 1 << i;
          const nowOn = master && (this.dmacon & bit) !== 0;
          const wasOn = (prev & DMA_MASTER) !== 0 && (prev & bit) !== 0;
          const ch = this.audio[i];
          if (nowOn && !wasOn) {
            ch.curAddr = ch.lc;
            ch.wordsLeft = ch.len;
            ch.phase = 0;
            ch.active = true;
            this.requestIrq(INT_AUD0 << i);
          } else if (!nowOn) {
            ch.active = false;
          }
        }
        break;
      }
      case 0x09a: // INTENA
        if (v & 0x8000) this.intena |= v & 0x7fff;
        else this.intena &= ~(v & 0x7fff);
        {
          const wrPc = this.cycleSource !== null ? this.cycleSource.pc & 0x00ffffff : 0;
          if ((v & 0x3fff) !== 0) {
            this.lastIntenaMaskWriteVal = v;
            this.lastIntenaMaskWriteResult = this.intena;
            this.lastIntenaMaskWritePc = wrPc;
          }
          if (wrPc > 0 && wrPc < 0xf80000) {
            this.ramIntenaWriteCount++;
            this.lastRamIntenaWriteVal = v;
            this.lastRamIntenaWriteResult = this.intena;
            this.lastRamIntenaWritePc = wrPc;
            const slot = this.ramIntenaHistIdx;
            this.ramIntenaHistPc[slot] = wrPc;
            this.ramIntenaHistVal[slot] = v;
            this.ramIntenaHistRes[slot] = this.intena;
            this.ramIntenaHistIdx = (slot + 1) & (AmigaChipset.REG_HIST_CAP - 1);
          }
        }
        this.updateIpl();
        break;
      case 0x09c: // INTREQ
        if (v & 0x8000) {
          this.intreq |= v & 0x3fff;
        } else {
          this.intreq &= ~(v & 0x3fff);
          if (this.vertbPollShadow && (v & INT_VERTB) !== 0) {
            const wrPc = this.cycleSource !== null ? this.cycleSource.pc >>> 0 : 0;
            if (wrPc < 0xf80000) {
              this.vertbPollShadow = false;
              if (this.vertbPollAssistFrames > 0 && this.vertbPollAssistFrames < 16) {
                this.vertbPollAssistFrames = 16;
              }
            }
          }
        }
        this.updateIpl();
        break;
      case 0x09e: // ADKCON
        if (v & 0x8000) this.adkcon |= v & 0x7fff;
        else this.adkcon &= ~(v & 0x7fff);
        if (this.dskDmaActive && this.dskDmaDelay > 0) {
          this.dskDmaNeedSync = (this.adkcon & 0x0400) !== 0;
        } else if (this.dskDmaNeedSync && (this.adkcon & 0x0400) === 0) {
          this.dskDmaNeedSync = false;
        }
        break;
      case 0x100: this.bplCon0 = v; break;
      case 0x102: this.bplCon1 = v; break;
      case 0x104: this.bplCon2 = v; break;
      case 0x106: if (this.chipset !== 'OCS') this.bplCon3 = v; break;
      case 0x108: this.bpl1Mod = (v << 16) >> 16; break;
      case 0x10a: this.bpl2Mod = (v << 16) >> 16; break;
      case 0x10c:
        if (this.chipset === 'AGA') {
          if (this.inCopperVisibleSpan) {
            const prevBplam = (this.bplCon4 >>> 8) & 0xff;
            const nextBplam = (v >>> 8) & 0xff;
            if (nextBplam !== prevBplam) {
              const pxX = (((this.copHpos - 2) << 1) - this.viewHOriginLo) << 1;
              if (pxX > 0 && this.midlineBplamCount < AmigaChipset.MAX_MIDLINE_BPLAM_CHANGES) {
                if (!this.midlinePaletteSaved) {
                  this.lineStartColorAbgr.set(this.colorAbgr);
                  this.midlinePaletteSaved = true;
                  this.midlineSavedCount = 256;
                }
                const n = this.midlineBplamCount++;
                this.midlineBplamX[n] = pxX;
                this.midlineBplamVal[n] = nextBplam;
              } else if (pxX <= 0 && this.midlineBplamCount === 0) {
                this.lineStartBplam = nextBplam;
              }
            }
          }
          this.bplCon4 = v;
        }
        break;
      case 0x1dc: // ECS/AGA BEAMCON0
        if (this.chipset !== 'OCS') {
          this.beamCon0 = v;
        }
        break;
      case 0x1e4:
        this.diwHigh = v;
        if (this.chipset !== 'OCS') {
          this.diwVStart = ((this.diwStrt >>> 8) & 0xff) | ((v & 0x07) << 8);
          this.diwHStart = (this.diwStrt & 0xff) | ((v & 0x20) << 3);
          this.diwVStop = ((this.diwStop >>> 8) & 0xff) | (v & 0x0700);
          this.diwHStop = (this.diwStop & 0xff) | ((v & 0x2000) >>> 5);
        }
        break;
      case 0x1fc: // AGA FMODE
        if (this.chipset === 'AGA') {
          this.fmode = v;
        }
        break;
    }
  }

  /**
   * Advances asynchronous Paula Disk DMA by up to `maxWords` on the current scanline.
   * Preserves authentic hardware cancellation semantics and streaming decode (e.g. RNC loaders).
   */
  public stepDiskDma(maxWords: number): void {
    if (!this.dskDmaActive) return;
    if ((this.dmacon & (DMA_MASTER | DMA_DISK)) !== (DMA_MASTER | DMA_DISK)) return;
    if (this.dskDmaDelay > 0) {
      this.dskDmaDelay--;
      return;
    }

    if (this.dskDmaWordsLeft <= 0) {
      this.dskDmaActive = false;
      this.dskWordEqual = false;
      this.requestIrq(INT_DSKBLK);
      return;
    }

    if (this.dskDmaWrite) {
      const chunk = Math.min(maxWords, this.dskDmaWordsLeft);
      this.floppy.streamDiskDmaWriteWords(this.dskPt, chunk, this.readChip16Bound);
      this.dskPt = (this.dskPt + (chunk << 1)) & 0x001ffffe;
      this.dskDmaWordsLeft -= chunk;
      if (this.dskDmaWordsLeft <= 0) {
        this.floppy.finishDiskDmaWrite();
        this.dskDmaActive = false;
        this.dskWordEqual = false;
        this.requestIrq(INT_DSKBLK);
      }
      return;
    }

    if (this.dskDmaNeedSync) {
      if (!this.floppy.alignToWordSync(this.dskSync)) {
        return; // No disk / no sync word yet
      }
      this.dskDmaNeedSync = false;
      this.dskWordEqual = true;
      this.requestIrq(INT_DSKSYN);
      // Separate DSKSYN from data/DSKBLK by at least one scanline so DSKSYN handlers clearing $1002 never drop DSKBLK
      return;
    }

    const chunk = Math.min(maxWords, this.dskDmaWordsLeft);
    const read = this.floppy.streamDiskDmaWords(this.dskPt, chunk, this.writeChip16Bound);
    if (read <= 0) {
      this.dskDmaActive = false;
      this.dskWordEqual = false;
      this.requestIrq(INT_DSKBLK);
      return;
    }
    this.dskPt = (this.dskPt + (read << 1)) & 0x001ffffe;
    this.dskDmaWordsLeft -= read;
    if (this.dskDmaWordsLeft <= 0) {
      this.dskDmaActive = false;
      this.dskWordEqual = false;
      this.requestIrq(INT_DSKBLK);
    }
  }

  /**
   * OCS/ECS Blitter Line-Draw Mode (BLTCON1 bit 0 = 1).
   * Used by Kickstart graphics.library Draw()/AreaDraw() (Workbench hand logo) and vector games.
   */
  private runBlitterLine(lengthPixels: number): void {
    const con0 = this.bltCon0;
    const con1 = this.bltCon1;
    const useC = (con0 & 0x0200) !== 0;
    const useD = (con0 & 0x0100) !== 0;
    const lf = con0 & 0xff;

    let ash = (con0 >>> 12) & 0xf;
    let bsh = (con1 >>> 12) & 0xf;
    let sign = (con1 & 0x0040) !== 0;
    const sud = (con1 & 0x0010) !== 0; // 1 = X major, 0 = Y major
    const sul = (con1 & 0x0008) !== 0; // Minor axis sign (1 = negative)
    const aul = (con1 & 0x0004) !== 0; // Major axis sign (1 = negative)
    const oneDot = (con1 & 0x0002) !== 0; // SING: one dot per scanline for Area Fill

    let apt = (this.bltApt << 16) >> 16; // 16-bit signed Bresenham error term
    const amod = this.bltAmod; // 4*dy - 4*dx (diagonal step)
    const bmod = this.bltBmod; // 4*dy (straight step)
    const cmod = this.bltCmod; // Bitplane row width in bytes
    let cpt = this.bltCpt & this.chipMask;
    let dpt = this.bltDpt & this.chipMask;
    const aMask = this.bltAdat & this.bltAfwm;
    const bTex = this.bltBdat;

    let allZero = true;
    let singleDotPlotted = false;

    for (let i = 0; i < lengthPixels; i++) {
      const cVal = useC ? this.readChip16(cpt) : this.bltCdat;
      const aVal = oneDot && singleDotPlotted ? 0 : ((aMask >>> ash) & 0xffff);
      const bVal = ((bTex >>> bsh) & 1) !== 0 ? 0xffff : 0x0000;

      let dVal = 0;
      if (lf === 0xca) {
        dVal = (aVal & bVal) | (~aVal & cVal);
      } else if (lf === 0x4a) {
        dVal = (aVal & bVal) ^ cVal;
      } else {
        if (lf & 0x01) dVal |= ~aVal & ~bVal & ~cVal;
        if (lf & 0x02) dVal |= ~aVal & ~bVal & cVal;
        if (lf & 0x04) dVal |= ~aVal & bVal & ~cVal;
        if (lf & 0x08) dVal |= ~aVal & bVal & cVal;
        if (lf & 0x10) dVal |= aVal & ~bVal & ~cVal;
        if (lf & 0x20) dVal |= aVal & ~bVal & cVal;
        if (lf & 0x40) dVal |= aVal & bVal & ~cVal;
        if (lf & 0x80) dVal |= aVal & bVal & cVal;
      }
      dVal &= 0xffff;

      if (dVal !== 0) allZero = false;
      if (useD) {
        this.writeChip16(i === 0 ? dpt : cpt, dVal);
      }
      if (oneDot) singleDotPlotted = true;

      bsh = (bsh - 1) & 0xf;

      let stepX = 0;
      let stepY = 0;
      if (sud) {
        stepX = aul ? -1 : 1;
        if (!sign) stepY = sul ? -1 : 1;
      } else {
        stepY = aul ? -1 : 1;
        if (!sign) stepX = sul ? -1 : 1;
      }

      if (!sign) {
        apt = (apt + amod) | 0;
      } else {
        apt = (apt + bmod) | 0;
      }
      sign = ((apt << 16) >> 16) < 0;

      if (stepX > 0) {
        ash++;
        if (ash >= 16) {
          ash = 0;
          cpt = (cpt + 2) & this.chipMask;
        }
      } else if (stepX < 0) {
        ash--;
        if (ash < 0) {
          ash = 15;
          cpt = (cpt - 2) & this.chipMask;
        }
      }

      if (stepY > 0) {
        cpt = (cpt + cmod) & this.chipMask;
        singleDotPlotted = false;
      } else if (stepY < 0) {
        cpt = (cpt - cmod) & this.chipMask;
        singleDotPlotted = false;
      }
      if (i === 0) dpt = cpt;
    }

    this.bltApt = apt & 0xffff;
    this.bltCpt = cpt;
    this.bltDpt = cpt;
    this.bltCon0 = (con0 & 0x0fff) | (ash << 12);
    this.bltCon1 = (con1 & 0x0fbf) | (bsh << 12) | (sign ? 0x0040 : 0);
    this.bltZero = allZero;
    this.requestIrq(INT_BLIT);
  }

  /**
   * High-speed OCS/ECS Blitter (supports Line-Draw Mode, all 256 minterms, A/B barrel shifts,
   * first/last word masks, descending mode, area fill, and fast common paths).
   */
  public runBlitter(widthWords: number, heightLines: number): void {
    const con0 = this.bltCon0;
    const con1 = this.bltCon1;
    if ((con1 & 0x0001) !== 0) {
      this.runBlitterLine(heightLines);
      return;
    }
    const useA = (con0 & 0x0800) !== 0;
    const useB = (con0 & 0x0400) !== 0;
    const useC = (con0 & 0x0200) !== 0;
    const useD = (con0 & 0x0100) !== 0;
    const lf = con0 & 0xff;
    const ash = (con0 >>> 12) & 0xf;
    const bsh = (con1 >>> 12) & 0xf;
    const desc = (con1 & 0x0002) !== 0;
    const fillMode = (con1 & 0x0018) !== 0;
    const step = desc ? -2 : 2;
    const modSign = desc ? -1 : 1;

    let apt = this.bltApt;
    let bpt = this.bltBpt;
    let cpt = this.bltCpt;
    let dpt = this.bltDpt;
    const amod = this.bltAmod * modSign;
    const bmod = this.bltBmod * modSign;
    const cmod = this.bltCmod * modSign;
    const dmod = this.bltDmod * modSign;
    const afwm = this.bltAfwm;
    const alwm = this.bltAlwm;

    let allZero = true;

    // Fast path 1: Clear memory (lf == 0x00, useD only)
    if (lf === 0x00 && useD && !useA && !useB && !useC && !fillMode) {
      for (let y = 0; y < heightLines; y++) {
        for (let x = 0; x < widthWords; x++) {
          this.writeChip16(dpt, 0);
          dpt = (dpt + step) & this.chipMask;
        }
        dpt = (dpt + dmod) & this.chipMask;
      }
      this.bltDpt = dpt;
      this.bltZero = true;
      this.requestIrq(INT_BLIT);
      return;
    }

    // Fast path 2: Straight unshifted copy A -> D (lf == 0xF0, ash == 0)
    if (lf === 0xf0 && useA && useD && !useB && !useC && ash === 0 && !fillMode && afwm === 0xffff && alwm === 0xffff) {
      for (let y = 0; y < heightLines; y++) {
        for (let x = 0; x < widthWords; x++) {
          const w = this.readChip16(apt);
          if (w !== 0) allZero = false;
          this.writeChip16(dpt, w);
          apt = (apt + step) & this.chipMask;
          dpt = (dpt + step) & this.chipMask;
        }
        apt = (apt + amod) & this.chipMask;
        dpt = (dpt + dmod) & this.chipMask;
      }
      this.bltApt = apt;
      this.bltDpt = dpt;
      this.bltZero = allZero;
      this.requestIrq(INT_BLIT);
      return;
    }

    // General OCS/ECS Blitter path (all 256 minterms, shifts, masks, fill)
    let aOld = 0;
    let bOld = 0;
    const incFill = (con1 & 0x0008) !== 0;

    for (let y = 0; y < heightLines; y++) {
      let fillCarry = (con1 & 0x0004) !== 0 ? 1 : 0;
      for (let x = 0; x < widthWords; x++) {
        let aRaw = this.bltAdat;
        if (useA) {
          aRaw = this.readChip16(apt);
          apt = (apt + step) & this.chipMask;
        }
        if (x === 0) aRaw &= afwm;
        if (x === widthWords - 1) aRaw &= alwm;

        let aVal: number;
        if (ash === 0) {
          aVal = aRaw;
        } else if (desc) {
          aVal = (((aRaw << ash) | (aOld >>> (16 - ash))) & 0xffff);
        } else {
          aVal = (((aRaw >>> ash) | (aOld << (16 - ash))) & 0xffff);
        }
        aOld = aRaw;

        let bRaw = this.bltBdat;
        if (useB) {
          bRaw = this.readChip16(bpt);
          bpt = (bpt + step) & this.chipMask;
        }
        let bVal: number;
        if (bsh === 0) {
          bVal = bRaw;
        } else if (desc) {
          bVal = (((bRaw << bsh) | (bOld >>> (16 - bsh))) & 0xffff);
        } else {
          bVal = (((bRaw >>> bsh) | (bOld << (16 - bsh))) & 0xffff);
        }
        bOld = bRaw;

        let cVal = this.bltCdat;
        if (useC) {
          cVal = this.readChip16(cpt);
          cpt = (cpt + step) & this.chipMask;
        }

        // Compute minterm result (fast paths for most used cookie-cut & OR)
        let dVal = 0;
        if (lf === 0xca) {
          dVal = (aVal & bVal) | (~aVal & cVal);
        } else if (lf === 0xfc) {
          dVal = aVal | bVal;
        } else if (lf === 0xf0) {
          dVal = aVal;
        } else if (lf === 0xcc) {
          dVal = bVal;
        } else if (lf === 0xaa) {
          dVal = cVal;
        } else if (lf === 0xfa) {
          dVal = aVal | cVal;
        } else {
          if (lf & 0x01) dVal |= ~aVal & ~bVal & ~cVal;
          if (lf & 0x02) dVal |= ~aVal & ~bVal & cVal;
          if (lf & 0x04) dVal |= ~aVal & bVal & ~cVal;
          if (lf & 0x08) dVal |= ~aVal & bVal & cVal;
          if (lf & 0x10) dVal |= aVal & ~bVal & ~cVal;
          if (lf & 0x20) dVal |= aVal & ~bVal & cVal;
          if (lf & 0x40) dVal |= aVal & bVal & ~cVal;
          if (lf & 0x80) dVal |= aVal & bVal & cVal;
        }
        dVal &= 0xffff;

        if (fillMode) {
          let filled = 0;
          for (let bit = 0; bit < 16; bit++) {
            const b = (dVal >>> bit) & 1;
            const outBit = incFill ? (fillCarry | b) : (fillCarry ^ b);
            fillCarry ^= b;
            if (outBit) filled |= 1 << bit;
          }
          dVal = filled;
        }

        if (dVal !== 0) allZero = false;
        if (useD) {
          this.writeChip16(dpt, dVal);
          dpt = (dpt + step) & this.chipMask;
        }
      }
      if (useA) apt = (apt + amod) & this.chipMask;
      if (useB) bpt = (bpt + bmod) & this.chipMask;
      if (useC) cpt = (cpt + cmod) & this.chipMask;
      if (useD) dpt = (dpt + dmod) & this.chipMask;
    }

    this.bltApt = apt;
    this.bltBpt = bpt;
    this.bltCpt = cpt;
    this.bltDpt = dpt;
    this.bltZero = allZero;
    this.requestIrq(INT_BLIT);
  }

  /**
   * Starts a new video frame (reloads Copper PC from COP1LC).
   */
  public startFrame(): void {
    if (this.pendingAutoViewport) {
      this.pendingAutoViewport = false;
      if (this.overscanMode === 'auto') {
        this.applyViewport(this.autoOverscan.current);
      }
    }
    this.vpos = 0;
    this.hpos = 0;
    this.scanlineStartCycles = 0;
    this.scanlineCycleBudget = 0;
    if (!this.isPalTiming()) {
      this.resetNtscDeadlockFrame(false);
    } else if (this.ntscPalDeadlockStreak !== 0 || this.ntscVposrPolls !== 0) {
      this.resetNtscDeadlockFrame(true);
    }
    this.vertbRamPollCount = 0;
    this.vertbRamPollPcMin = 0xffffffff;
    this.vertbRamPollPcMax = 0;
    this.vertbPollShadow = false;
    if ((this.intena & (INT_INTEN | INT_VERTB)) !== (INT_INTEN | INT_VERTB)) {
      this.vertbRamPollStreak = 0;
      this.vertbPollAssistFrames = 0;
    } else if (this.vertbPollAssistFrames > 0) {
      this.vertbPollAssistFrames--;
    }
    // Authentic Agnus LOF: toggles every frame when interlaced (BPLCON0 LACE=1), stays 1 (long frame) otherwise
    this.lof = (this.bplCon0 & 0x0004) !== 0 ? (this.lof ^ 1) : 1;
    this.midlineColorCount = 0;
    this.midlinePaletteSaved = false;
    this.midlineBplamCount = 0;
    this.lineStartBplam = this.chipset === 'AGA' ? ((this.bplCon4 >>> 8) & 0xff) : 0;
    this.inCopperVisibleSpan = false;
    this.copPc = this.cop1lc;
    this.copWaiting = false;
    this.copSkipNext = false;
    this.copHpos = 0;
    this.sprHeadersFetchedThisFrame = false;
    this.sprDmaOn.fill(0);
    this.sprDmaStreaming.fill(0);
    this.sprDmaLineActive.fill(0);
    this.frameDiwActive = false;
    this.frameDiwMinV = 0x3ff;
    this.frameDiwMaxV = 0;
    this.frameDiwMinH = 0x3ff;
    this.frameDiwMaxH = 0;
  }

  /**
   * Finalizes frame overscan tracking (zero allocation, ~0.001ms in Auto mode, no-op in preset modes).
   * Viewport changes are queued for the next startFrame() so the just-rendered frame is never cleared.
   */
  public finishFrame(): void {
    this.scanlineCycleBudget = 0;
    const src = this.cycleSource;
    const pcSpan = this.vertbRamPollPcMax >= this.vertbRamPollPcMin
      ? (this.vertbRamPollPcMax - this.vertbRamPollPcMin)
      : 0xffffffff;
    const stuckVertbPoll =
      this.vertbRamPollCount >= 200 &&
      pcSpan <= 64 &&
      (this.intena & (INT_INTEN | INT_VERTB)) === (INT_INTEN | INT_VERTB) &&
      src !== null &&
      (src.sr & 0x0700) < 0x0300 &&
      (src.pc >>> 0) < 0xf80000;
    if (stuckVertbPoll) {
      this.vertbRamPollStreak++;
      if (this.vertbRamPollStreak >= 2) {
        this.vertbPollAssistFrames = 16;
      }
    } else {
      this.vertbRamPollStreak = 0;
    }
    if (this.overscanMode !== 'auto') return;
    if (
      this.autoOverscan.update(
        this.frameDiwActive,
        this.frameDiwMinH,
        this.frameDiwMaxH,
        this.frameDiwMinV,
        this.frameDiwMaxV,
        this.videoStandard
      )
    ) {
      this.pendingAutoViewport = true;
    }
  }

  /**
   * Fetches hardware sprite POS/CTL headers on line 25 PAL / 20 NTSC (after VBlank Copper loads SPRxPTH/L).
   * Supports AGA FMODE 32-bit (8-byte header) and 64-bit (16-byte header) sprite fetches.
   */
  public fetchSpriteHeaders(): void {
    this.sprHeadersFetchedThisFrame = true;
    this.sprArmed.fill(0);
    this.sprDmaStreaming.fill(0);
    this.sprDmaLineActive.fill(0);
    if ((this.dmacon & (DMA_MASTER | DMA_SPRITE)) === (DMA_MASTER | DMA_SPRITE)) {
      const sprFmode = this.chipset === 'AGA' ? (this.fmode >>> 2) & 3 : 0;
      const ctlOff = sprFmode === 3 ? 8 : sprFmode !== 0 ? 4 : 2;
      const hdrBytes = sprFmode === 3 ? 16 : sprFmode !== 0 ? 8 : 4;
      for (let s = 0; s < 8; s++) {
        const ptr = this.sprPt[s];
        if (ptr !== 0) {
          const pos = this.readChip16(ptr);
          const ctl = this.readChip16(ptr + ctlOff);
          this.sprPos[s] = pos;
          this.sprCtl[s] = ctl;
          this.sprPt[s] = (ptr + hdrBytes) & this.chipMask;
          this.sprDmaOn[s] = pos !== 0 || ctl !== 0 ? 1 : 0;
        } else {
          this.sprPos[s] = 0;
          this.sprCtl[s] = 0;
          this.sprDmaOn[s] = 0;
        }
      }
    } else {
      this.sprDmaOn.fill(0);
    }
  }

  private consumeDuplicatePalWrapWaits(): void {
    // Some games (e.g. Alien Breed) emit duplicate WAIT $FFD7 $FFFE on PAL line 255;
    // consume trailing line-255 wrap waits so line 256 (vp=0) does not re-wait for line 255.
    let guard = 0;
    while (guard++ < 4) {
      const nextIr1 = this.readChip16(this.copPc);
      const nextIr2 = this.readChip16(this.copPc + 2);
      if (
        (nextIr1 & 1) === 1 &&
        (nextIr2 & 1) === 0 &&
        (nextIr1 >>> 8) === 0xff &&
        (nextIr1 & 0xfe) >= 0xd0 &&
        !(nextIr1 === 0xffff && nextIr2 === 0xfffe)
      ) {
        this.copPc = (this.copPc + 4) & this.chipMask;
      } else {
        break;
      }
    }
  }

  /**
   * Runs Copper instructions eligible for the current scanline `line` up to horizontal clock `maxHpos`.
   * Calling with `maxHpos = 0xae` before `renderScanline` executes start-of-line moves (e.g. $8603)
   * while deferring HBlank waits (e.g. $E7DF, $FFE1) to the post-scanline `maxHpos = 0xfe` pass.
   */
  public runCopperLine(line: number, maxHpos = 0xfe): void {
    if ((this.dmacon & (DMA_MASTER | DMA_COPPER)) !== (DMA_MASTER | DMA_COPPER)) {
      if (maxHpos >= 0xfe) this.copHpos = 0;
      else {
        this.midlineColorCount = 0;
        this.midlineBplamCount = 0;
      }
      return;
    }
    const visiblePass = maxHpos < 0xfe;
    const effMaxHpos = maxHpos >= 0xfe ? 0xe2 : maxHpos;
    if (visiblePass) {
      this.midlineColorCount = 0;
      this.midlinePaletteSaved = false;
      this.midlineBplamCount = 0;
      this.lineStartBplam = this.chipset === 'AGA' ? ((this.bplCon4 >>> 8) & 0xff) : 0;
      this.inCopperVisibleSpan = true;
    }

    // Zero-allocation Bitplane DMA even-slot Copper contention parameters for `line`
    let bplStartH = 0x200;
    let bplEndH = 0;
    let bplUnitMask = 7;
    let bplBurstCCK = 8;
    let bplBurstMask = 0x0f;
    const refreshBplContention = (): void => {
      bplBurstMask = 0x0f;
      if (
        (this.dmacon & (DMA_MASTER | DMA_BITPLANE)) !== (DMA_MASTER | DMA_BITPLANE) ||
        line < this.diwVStart ||
        line >= this.diwVStop
      ) {
        bplStartH = 0x200;
        bplEndH = 0;
        return;
      }
      const isAga = this.chipset === 'AGA';
      const bpuRaw = ((this.bplCon0 >>> 12) & 7) | (isAga && (this.bplCon0 & 0x0010) !== 0 ? 8 : 0);
      const bpu = bpuRaw > 8 ? 8 : bpuRaw;
      if (bpu === 0) {
        bplStartH = 0x200;
        bplEndH = 0;
        return;
      }
      const hires = (this.bplCon0 & 0x8000) !== 0;
      const shres = isAga && (this.bplCon0 & 0x0040) !== 0;
      const bplFmode = isAga ? (this.fmode & 3) : 0;
      const fShift = bplFmode === 3 ? 2 : bplFmode !== 0 ? 1 : 0;
      const effDdfStop = this.ddfStop > 0x00d8 ? 0x00d8 : this.ddfStop;
      if (effDdfStop < this.ddfStrt) {
        bplStartH = 0x200;
        bplEndH = 0;
        return;
      }
      const ddfSpan = effDdfStop - this.ddfStrt;
      if (shres) {
        const unitSize = 2 << fShift;
        bplUnitMask = unitSize - 1;
        bplBurstCCK = unitSize < 8 ? unitSize : 8;
        const nUnits =
          bplFmode === 3
            ? ((ddfSpan + 7) >>> 3) + 1
            : bplFmode !== 0
              ? ((ddfSpan + 3) >>> 2) + 1
              : ((ddfSpan + 1) >>> 1) + 1;
        const maxU = bplFmode === 0 ? 104 : bplFmode === 3 ? 28 : 56;
        bplStartH = this.ddfStrt;
        bplEndH = bplStartH + (nUnits > maxU ? maxU : nUnits) * unitSize;
        if (bpu >= 2) {
          const evenTaken = bpu >>> 1;
          const totalEven = bplBurstCCK >>> 1;
          bplBurstMask = evenTaken >= totalEven ? 0 : evenTaken === 1 ? 0x07 : evenTaken === 2 ? 0x05 : 0x01;
        }
      } else if (hires) {
        const unitSize = 4 << fShift;
        bplUnitMask = unitSize - 1;
        bplBurstCCK = unitSize < 8 ? unitSize : 8;
        const nUnits =
          bplFmode === 3
            ? ((ddfSpan + 15) >>> 4) + 1
            : bplFmode !== 0
              ? ((ddfSpan + 7) >>> 3) + 1
              : ((ddfSpan + 3) >>> 2) + 1;
        const maxU = bplFmode === 0 ? 52 : bplFmode === 3 ? 14 : 28;
        bplStartH = this.ddfStrt;
        bplEndH = bplStartH + (nUnits > maxU ? maxU : nUnits) * unitSize;
        if (bpu >= 2) {
          if (bplBurstCCK === 4) {
            bplBurstMask = bpu >= 4 ? 0x00 : 0x01;
          } else {
            const evenTaken = bpu >>> 1;
            bplBurstMask = evenTaken >= 4 ? 0x00 : evenTaken === 1 ? 0x07 : evenTaken === 2 ? 0x05 : 0x01;
          }
        }
      } else {
        if (bpu <= 4) return;
        const unitSize = 8 << fShift;
        bplUnitMask = unitSize - 1;
        bplBurstCCK = 8;
        const nUnits =
          bplFmode === 3
            ? ((ddfSpan + 31) >>> 5) + 1
            : bplFmode !== 0
              ? ((ddfSpan + 15) >>> 4) + 1
              : ((ddfSpan + 7) >>> 3) + 1;
        const maxU = bplFmode === 0 ? 28 : bplFmode === 3 ? 7 : 14;
        bplStartH = this.ddfStrt;
        bplEndH = bplStartH + (nUnits > maxU ? maxU : nUnits) * unitSize;
        // 8-CCK LoRes burst: even slots {0,1,2,3} = {free, BPL6, BPL7, BPL5}
        bplBurstMask = bpu === 5 ? 0x07 : bpu === 6 ? 0x05 : bpu === 7 ? 0x01 : 0x00;
      }
    };
    refreshBplContention();

    const vp = line & 0xff;
    let guard = 0;

    while (guard++ < 512) {
      if (this.copWaiting) {
        // Check vertical match (classic Amiga $FFFF $FFFE waits forever)
        if (this.copWaitV === 0xff && this.copWaitH === 0xfe) {
          if (maxHpos >= 0xfe) this.copHpos = 0;
          this.inCopperVisibleSpan = false;
          return;
        }
        const maskedVp = vp & this.copMaskV;
        const targetVp = this.copWaitV & this.copMaskV;
        if (maskedVp < targetVp) {
          if (maxHpos >= 0xfe) this.copHpos = 0;
          this.inCopperVisibleSpan = false;
          return;
        }
        const waitHMasked = this.copWaitH & this.copMaskH;
        if (maskedVp === targetVp && waitHMasked > effMaxHpos) {
          this.inCopperVisibleSpan = false;
          return;
        }
        const isNextMove = (this.readChip16(this.copPc) & 1) === 0;
        const wasPalWrap =
          this.copWaitV === 0xff &&
          line === 255 &&
          (this.copWaitH >= 0xde || (this.copWaitH >= 0xd0 && !isNextMove));
        this.copWaiting = false;
        if (maskedVp === targetVp && waitHMasked > this.copHpos) {
          this.copHpos = waitHMasked;
        }
        // Standard PAL line-255 wrap wait ($FFE1 $FFFE) completes at end of line 255,
        // so the following WAIT (e.g. $0901) evaluates cleanly on line 256 (vp=0).
        if (wasPalWrap) {
          if (!this.isPalTiming()) this.ntscSawPalCopperWrap = true;
          this.consumeDuplicatePalWrapWaits();
          if (maxHpos >= 0xfe) this.copHpos = 0;
          this.inCopperVisibleSpan = false;
          return;
        }
      }

      if (maxHpos >= 0xfe ? this.copHpos >= 0xe2 : this.copHpos > effMaxHpos) {
        if (maxHpos >= 0xfe) this.copHpos -= 0xe2;
        this.inCopperVisibleSpan = false;
        return;
      }

      const ir1 = this.readChip16(this.copPc);
      const ir2 = this.readChip16(this.copPc + 2);
      this.copPc = (this.copPc + 4) & this.chipMask;

      if ((ir1 & 1) === 0) {
        const reg = ir1 & 0x01fe;
        // OCS Copper with CDANG=1 stops below $040; ECS/AGA with CDANG=1 allows all registers ($000..$1FE)
        const minReg = (this.copCon & 2) !== 0 ? (this.chipset !== 'OCS' ? 0x000 : 0x040) : 0x080;
        // Whole-scanline display/DMA register writes at H >= $D0 (right border / end of DDF) are meant
        // for the following scanline; defer them to Phase 2 so they don't retroactively apply to pixel 0
        // or tear 32-bit BPLxPT pairs before renderScanline finishes the current line.
        if (
          visiblePass &&
          !this.copSkipNext &&
          this.copHpos >= 0xd0 &&
          reg >= minReg &&
          ((reg >= 0x0e0 && reg <= 0x10a) ||
            (reg >= 0x08e && reg <= 0x096) ||
            (reg >= 0x120 && reg <= 0x17e) ||
            reg === 0x1e4 ||
            reg === 0x1fc)
        ) {
          this.copPc = (this.copPc - 4) & this.chipMask;
          this.inCopperVisibleSpan = false;
          return;
        }
        // MOVE consumes 2 Copper cycles (4 CCK fast-path, or skips busy Bitplane DMA even slots)
        if (bplBurstMask === 0x0f) {
          this.copHpos += 4;
        } else {
          let h = this.copHpos;
          while (h >= bplStartH && h < bplEndH) {
            const inU = (h - bplStartH) & bplUnitMask;
            if (inU < bplBurstCCK && ((bplBurstMask >>> (inU >>> 1)) & 1) === 0) {
              h += 2;
              continue;
            }
            break;
          }
          h += 2;
          while (h >= bplStartH && h < bplEndH) {
            const inU = (h - bplStartH) & bplUnitMask;
            if (inU < bplBurstCCK && ((bplBurstMask >>> (inU >>> 1)) & 1) === 0) {
              h += 2;
              continue;
            }
            break;
          }
          this.copHpos = h + 2;
        }
        if (this.copSkipNext) {
          this.copSkipNext = false;
          continue;
        }
        if (reg < minReg) {
          // Stop Copper until next VBlank
          this.copWaitV = 0xff;
          this.copWaitH = 0xfe;
          this.copWaiting = true;
          if (maxHpos >= 0xfe) this.copHpos = 0;
          this.inCopperVisibleSpan = false;
          return;
        }
        this.writeReg16(reg, ir2);
        if (reg === 0x100 || reg === 0x1fc || reg === 0x092 || reg === 0x094 || reg === 0x096) {
          refreshBplContention();
        }
      } else {
        // WAIT (ir2 bit 0 = 0) or SKIP (ir2 bit 0 = 1)
        const waitV = (ir1 >>> 8) & 0xff;
        const waitH = ir1 & 0xfe;
        const maskV = ((ir2 >>> 8) & 0x7f) | 0x80;
        const maskH = ir2 & 0xfe;

        if ((ir2 & 1) === 0) {
          // WAIT
          this.copSkipNext = false;
          if (waitV === 0xff && waitH === 0xfe) {
            this.copWaitV = 0xff;
            this.copWaitH = 0xfe;
            this.copWaiting = true;
            if (maxHpos >= 0xfe) this.copHpos = 0;
            this.inCopperVisibleSpan = false;
            return;
          }
          const maskedVp = vp & maskV;
          const targetVp = waitV & maskV;
          const waitHMasked = waitH & maskH;
          if (
            (line === 255 && this.copHpos >= 0xde && waitV < 0xff) ||
            maskedVp < targetVp ||
            (maskedVp === targetVp &&
              (waitHMasked > effMaxHpos ||
                (this.copHpos >= 0xdc && waitHMasked < (this.copHpos & maskH))))
          ) {
            this.copWaitV = waitV;
            this.copWaitH = waitH;
            this.copMaskV = maskV;
            this.copMaskH = maskH;
            this.copWaiting = true;
            if (maxHpos >= 0xfe) this.copHpos = 0;
            this.inCopperVisibleSpan = false;
            return;
          }
          if (maskedVp === targetVp && waitHMasked > this.copHpos) {
            this.copHpos = waitHMasked;
          }
          if (
            waitV === 0xff &&
            line === 255 &&
            (waitH >= 0xde || (waitH >= 0xd0 && (this.readChip16(this.copPc) & 1) !== 0))
          ) {
            if (!this.isPalTiming()) this.ntscSawPalCopperWrap = true;
            this.consumeDuplicatePalWrapWaits();
            if (maxHpos >= 0xfe) this.copHpos = 0;
            this.inCopperVisibleSpan = false;
            return;
          }
        } else {
          // SKIP compares current beam (vp, copHpos) against masked (waitV, waitH)
          if (this.copSkipNext) {
            this.copSkipNext = false;
            this.copHpos += 4;
            continue;
          }
          const maskedVp = vp & maskV;
          const targetVp = waitV & maskV;
          const skip =
            maskedVp > targetVp ||
            (maskedVp === targetVp && (this.copHpos & maskH) >= (waitH & maskH));
          this.copSkipNext = skip;
          this.copHpos += 4;
        }
      }
    }
    this.inCopperVisibleSpan = false;
    if (maxHpos >= 0xfe) {
      this.copHpos = this.copHpos >= 0xe2 ? this.copHpos - 0xe2 : 0;
    }
  }

  /**
   * Renders one visible PAL/NTSC scanline into the active ABGR32 overscan framebuffer.
   * Always advances bitplane DMA pointers inside the active display window (DIWSTRT..DIWSTOP)
   * even on clipped overscan lines or frameskipped frames.
   */
  public renderScanline(line: number, drawPixels = true): void {
    const fbW = this.fbWidth;
    const fbH = this.fbHeight;
    const y = line - this.viewStartLine;
    const visible = drawPixels && y >= 0 && y < fbH;

    const fb = this.framebuffer;
    const rowOff = y * fbW;
    const isAga = this.chipset === 'AGA';
    const bplam = isAga
      ? (this.midlineBplamCount > 0 ? this.lineStartBplam : ((this.bplCon4 >>> 8) & 0xff))
      : 0;
    const bg = this.colorAbgr[bplam];

    const dmaOk = (this.dmacon & (DMA_MASTER | DMA_BITPLANE)) === (DMA_MASTER | DMA_BITPLANE);
    const bpuRaw = ((this.bplCon0 >>> 12) & 7) | (isAga && (this.bplCon0 & 0x0010) !== 0 ? 8 : 0);
    const bpu = bpuRaw > 8 ? 8 : bpuRaw;
    const hires = (this.bplCon0 & 0x8000) !== 0;
    const shres = isAga && (this.bplCon0 & 0x0040) !== 0;
    const homod = (this.bplCon0 & 0x0800) !== 0;
    const ham8 = isAga && homod && (bpu === 8 || bpu === 7);
    const ham6 = homod && bpu === 6;
    const ham = ham8 || ham6;
    const dpf = (this.bplCon0 & 0x0400) !== 0;
    const killEhb = isAga && (this.bplCon2 & 0x0200) !== 0;
    const ehb = !ham && !dpf && bpu === 6 && !killEhb;

    const vStart = this.diwVStart;
    const vStop = this.diwVStop;

    const brdrBlnk =
      (this.bplCon3 & 0x0020) !== 0 &&
      (isAga || (this.chipset === 'ECS' && (this.bplCon0 & 0x0001) !== 0));
    const brdrSprt =
      (this.bplCon3 & 0x0002) !== 0 &&
      (isAga || (this.chipset === 'ECS' && (this.bplCon0 & 0x0001) !== 0));

    this.stepSpritesOnLine(line);

    if (!dmaOk || bpu === 0 || line < vStart || line >= vStop) {
      if (visible) {
        if (brdrBlnk) {
          fb.fill(0xff000000, rowOff, rowOff + fbW);
          if (brdrSprt) {
            this.renderSpritesOnLine(rowOff, true);
          }
        } else {
        if (this.midlineColorCount === 0 && this.midlineBplamCount === 0) {
          fb.fill(bg, rowOff, rowOff + fbW);
        } else {
          this.fillMidlineBgSpans(rowOff, fbW, bplam);
        }
        this.renderSpritesOnLine(rowOff, true);
      }
    }
    this.midlineColorCount = 0;
    this.midlineBplamCount = 0;
    return;
  }

    if (this.diwHStop > this.diwHStart) {
      this.frameDiwActive = true;
      if (this.overscanMode === 'auto') {
        if (line < this.frameDiwMinV) this.frameDiwMinV = line;
        const nextLine = line + 1;
        if (nextLine > this.frameDiwMaxV) this.frameDiwMaxV = nextLine;
        if (this.diwHStart < this.frameDiwMinH) this.frameDiwMinH = this.diwHStart;
        if (this.diwHStop > this.frameDiwMaxH) this.frameDiwMaxH = this.diwHStop;
      }
    }

    const mask = this.chipMask;
    const bplFmode = isAga ? (this.fmode & 3) : 0;
    // Hardware Agnus/Alice bitplane DMA stops no later than $D8 on PAL/NTSC scanlines
    const effDdfStop = this.ddfStop > 0x00d8 ? 0x00d8 : this.ddfStop;
    const ddfSpan = effDdfStop >= this.ddfStrt ? (effDdfStop - this.ddfStrt) : 0;

    let numBytes: number;
    if (bplFmode === 0) {
      const fetchUnits = ((ddfSpan + 7) >>> 3) + 1;
      const wordsPerLine = shres
        ? Math.min(104, fetchUnits << 2)
        : hires
          ? Math.min(52, fetchUnits << 1)
          : Math.min(28, fetchUnits);
      numBytes = wordsPerLine << 1;
    } else if (bplFmode === 3) {
      // AGA 64-bit fetch mode (8 bytes/unit): hardware rounds span up to fetch block size
      const fetchUnits = shres
        ? ((ddfSpan + 7) >>> 3) + 1
        : hires
          ? ((ddfSpan + 15) >>> 4) + 1
          : ((ddfSpan + 31) >>> 5) + 1;
      const maxBytes = shres ? 224 : hires ? 112 : 56;
      const b = fetchUnits << 3;
      numBytes = b > maxBytes ? maxBytes : b;
    } else {
      // AGA 32-bit fetch mode (4 bytes/unit): hardware rounds span up to fetch block size
      const fetchUnits = shres
        ? ((ddfSpan + 3) >>> 2) + 1
        : hires
          ? ((ddfSpan + 7) >>> 3) + 1
          : ((ddfSpan + 15) >>> 4) + 1;
      const maxBytes = shres ? 224 : hires ? 112 : 56;
      const b = fetchUnits << 2;
      numBytes = b > maxBytes ? maxBytes : b;
    }

    if (!visible) {
      for (let p = 0; p < bpu; p++) {
        const mod = (p & 1) === 0 ? this.bpl1Mod : this.bpl2Mod;
        this.bplPt[p] = (this.bplPt[p] + numBytes + mod) & mask;
      }
      this.midlineColorCount = 0;
      this.midlineBplamCount = 0;
      return;
    }

    const chip = this.chipRam;
    const colors = this.colorAbgr;
    const ehbColors = this.colorEhbAbgr;
    const indices = this.lineIndices;
    indices.fill(0, 0, fbW);

    const ptrAlignMask = bplFmode === 3 ? ~7 : bplFmode !== 0 ? ~3 : ~1;
    const p0 = (this.bplPt[0] & ptrAlignMask) >>> 0;
    const p1 = bpu > 1 ? (this.bplPt[1] & ptrAlignMask) >>> 0 : 0;
    const p2 = bpu > 2 ? (this.bplPt[2] & ptrAlignMask) >>> 0 : 0;
    const p3 = bpu > 3 ? (this.bplPt[3] & ptrAlignMask) >>> 0 : 0;
    const p4 = bpu > 4 ? (this.bplPt[4] & ptrAlignMask) >>> 0 : 0;
    const p5 = bpu > 5 ? (this.bplPt[5] & ptrAlignMask) >>> 0 : 0;
    const p6 = bpu > 6 ? (this.bplPt[6] & ptrAlignMask) >>> 0 : 0;
    const p7 = bpu > 7 ? (this.bplPt[7] & ptrAlignMask) >>> 0 : 0;

    const pf1ScrollLo = isAga
      ? ((this.bplCon1 & 0x0f) | ((this.bplCon1 >>> 6) & 0x30))
      : (this.bplCon1 & 0x0f);
    const pf2ScrollLo = isAga
      ? (((this.bplCon1 >>> 4) & 0x0f) | ((this.bplCon1 >>> 10) & 0x30))
      : ((this.bplCon1 >>> 4) & 0x0f);
    const pf1Half = isAga ? ((this.bplCon1 >>> 9) & 1) : 0;
    const pf2Half = isAga ? ((this.bplCon1 >>> 13) & 1) : 0;
    const wrapMaskLo = bplFmode === 3 ? 63 : bplFmode !== 0 ? 31 : 15;
    const wrapMaskHi = wrapMaskLo;

    const hOriginLo = this.viewHOriginLo;
    const viewLoWidth = fbW >>> 1;
    const hShiftLo = 0x81 - hOriginLo;

    let diwHStartLo = this.diwHStart - hOriginLo;
    let diwHStopLo = this.diwHStop - hOriginLo;
    if (diwHStartLo < 0) diwHStartLo = 0;
    if (diwHStopLo > viewLoWidth) diwHStopLo = viewLoWidth;
    if (diwHStopLo < diwHStartLo) diwHStopLo = diwHStartLo;

    const pf2Offset = isAga ? PF2OF_TABLE[(this.bplCon3 >>> 10) & 7] : 8;
    const minX = diwHStartLo << 1;
    const maxX = diwHStopLo << 1;
    if (brdrBlnk) {
      if (minX > 0) fb.fill(0xff000000, rowOff, rowOff + minX);
      if (maxX > minX) fb.fill(bg, rowOff + minX, rowOff + maxX);
      if (maxX < fbW) fb.fill(0xff000000, rowOff + maxX, rowOff + fbW);
    } else {
      fb.fill(bg, rowOff, rowOff + fbW);
    }

    if (ham8) {
      // AGA HAM8 (262,144 colors): BPL1-6 = 6-bit value/RGB[7:2], BPL7-8 = control
      const c24_0 = this.colorReg24[bplam];
      let holdR = (c24_0 >>> 16) & 0xff;
      let holdG = (c24_0 >>> 8) & 0xff;
      let holdB = c24_0 & 0xff;

      if (hires || shres) {
        const hShiftHi = hShiftLo << 1;
        const fetchPxHires = (this.ddfStrt - 0x3c) << 2;
        const scrollHi = (pf1ScrollLo << 1) | pf1Half;
        let outX = fetchPxHires + ((scrollHi - fetchPxHires) & wrapMaskHi) + hShiftHi;
        const stepBit = shres ? 2 : 1;

        for (let byteIdx = 0; byteIdx < numBytes; byteIdx++) {
          const b0 = chip[(p0 + byteIdx) & mask];
          const b1 = chip[(p1 + byteIdx) & mask];
          const b2 = chip[(p2 + byteIdx) & mask];
          const b3 = chip[(p3 + byteIdx) & mask];
          const b4 = chip[(p4 + byteIdx) & mask];
          const b5 = chip[(p5 + byteIdx) & mask];
          const b6 = chip[(p6 + byteIdx) & mask];
          const b7 = bpu > 7 ? chip[(p7 + byteIdx) & mask] : 0;

          for (let bit = 7; bit >= 0; bit -= stepBit) {
            const data6 =
              ((b0 >>> bit) & 1) |
              (((b1 >>> bit) & 1) << 1) |
              (((b2 >>> bit) & 1) << 2) |
              (((b3 >>> bit) & 1) << 3) |
              (((b4 >>> bit) & 1) << 4) |
              (((b5 >>> bit) & 1) << 5);
            const ctrl = ((b6 >>> bit) & 1) | (((b7 >>> bit) & 1) << 1);

            if (ctrl === 0) {
              const c24 = this.colorReg24[data6 ^ bplam];
              holdR = (c24 >>> 16) & 0xff;
              holdG = (c24 >>> 8) & 0xff;
              holdB = c24 & 0xff;
            } else if (ctrl === 1) {
              holdB = (holdB & 0x03) | (data6 << 2);
            } else if (ctrl === 2) {
              holdR = (holdR & 0x03) | (data6 << 2);
            } else {
              holdG = (holdG & 0x03) | (data6 << 2);
            }

            if (outX >= minX && outX < maxX) {
              fb[rowOff + outX] = (0xff000000 | (holdB << 16) | (holdG << 8) | holdR) >>> 0;
              indices[outX] = data6;
            }
            outX++;
          }
        }
      } else {
        const fetchPx = (this.ddfStrt - 0x38) << 1;
        let outPx = fetchPx + ((pf1ScrollLo - fetchPx) & wrapMaskLo) + hShiftLo;
        for (let byteIdx = 0; byteIdx < numBytes; byteIdx++) {
          const b0 = chip[(p0 + byteIdx) & mask];
          const b1 = chip[(p1 + byteIdx) & mask];
          const b2 = chip[(p2 + byteIdx) & mask];
          const b3 = chip[(p3 + byteIdx) & mask];
          const b4 = chip[(p4 + byteIdx) & mask];
          const b5 = chip[(p5 + byteIdx) & mask];
          const b6 = chip[(p6 + byteIdx) & mask];
          const b7 = bpu > 7 ? chip[(p7 + byteIdx) & mask] : 0;

          for (let bit = 7; bit >= 0; bit--) {
            const data6 =
              ((b0 >>> bit) & 1) |
              (((b1 >>> bit) & 1) << 1) |
              (((b2 >>> bit) & 1) << 2) |
              (((b3 >>> bit) & 1) << 3) |
              (((b4 >>> bit) & 1) << 4) |
              (((b5 >>> bit) & 1) << 5);
            const ctrl = ((b6 >>> bit) & 1) | (((b7 >>> bit) & 1) << 1);

            if (ctrl === 0) {
              const c24 = this.colorReg24[data6 ^ bplam];
              holdR = (c24 >>> 16) & 0xff;
              holdG = (c24 >>> 8) & 0xff;
              holdB = c24 & 0xff;
            } else if (ctrl === 1) {
              holdB = (holdB & 0x03) | (data6 << 2);
            } else if (ctrl === 2) {
              holdR = (holdR & 0x03) | (data6 << 2);
            } else {
              holdG = (holdG & 0x03) | (data6 << 2);
            }

            if (outPx >= diwHStartLo && outPx < diwHStopLo) {
              const abgr = (0xff000000 | (holdB << 16) | (holdG << 8) | holdR) >>> 0;
              const x2 = outPx << 1;
              fb[rowOff + x2] = abgr;
              fb[rowOff + x2 + 1] = abgr;
              indices[x2] = data6;
              indices[x2 + 1] = data6;
            }
            outPx++;
          }
        }
      }
    } else if (hires || shres) {
      // Hi-Res / AGA SHRES rendering (1..4 planes OCS/ECS, 1..8 planes AGA)
      const activeBpu = isAga ? bpu : (bpu > 4 ? 4 : bpu);
      const hShiftHi = hShiftLo << 1;
      const fetchPxHires = (this.ddfStrt - 0x3c) << 2;
      const scrollHi1 = (pf1ScrollLo << 1) | pf1Half;
      const startPx1 = fetchPxHires + ((scrollHi1 - fetchPxHires) & wrapMaskHi) + hShiftHi;
      const stepBit = shres ? 2 : 1;

      if (dpf) {
        const pf2Prio = (this.bplCon2 & 0x0040) !== 0;
        const scrollHi2 = (pf2ScrollLo << 1) | pf2Half;
        const startPx2 = fetchPxHires + ((scrollHi2 - fetchPxHires) & wrapMaskHi) + hShiftHi;
        if (startPx1 === startPx2 && !shres) {
          let outX = startPx1;
          for (let byteIdx = 0; byteIdx < numBytes; byteIdx++) {
            const b0 = activeBpu > 0 ? chip[(p0 + byteIdx) & mask] : 0;
            const b1 = activeBpu > 1 ? chip[(p1 + byteIdx) & mask] : 0;
            const b2 = activeBpu > 2 ? chip[(p2 + byteIdx) & mask] : 0;
            const b3 = activeBpu > 3 ? chip[(p3 + byteIdx) & mask] : 0;
            const b4 = activeBpu > 4 ? chip[(p4 + byteIdx) & mask] : 0;
            const b5 = activeBpu > 5 ? chip[(p5 + byteIdx) & mask] : 0;
            const b6 = activeBpu > 6 ? chip[(p6 + byteIdx) & mask] : 0;
            const b7 = activeBpu > 7 ? chip[(p7 + byteIdx) & mask] : 0;

            for (let bit = 7; bit >= 0; bit--) {
              if (outX >= minX && outX < maxX) {
                const c1 =
                  ((b0 >>> bit) & 1) |
                  (((b2 >>> bit) & 1) << 1) |
                  (((b4 >>> bit) & 1) << 2) |
                  (((b6 >>> bit) & 1) << 3);
                const c2 =
                  ((b1 >>> bit) & 1) |
                  (((b3 >>> bit) & 1) << 1) |
                  (((b5 >>> bit) & 1) << 2) |
                  (((b7 >>> bit) & 1) << 3);
                const colIdx = pf2Prio
                  ? (c2 !== 0 ? ((pf2Offset + c2) & 0xff) : c1)
                  : (c1 !== 0 ? c1 : (c2 !== 0 ? ((pf2Offset + c2) & 0xff) : 0));
                indices[outX] = colIdx;
                fb[rowOff + outX] = colors[colIdx ^ bplam];
              }
              outX++;
            }
          }
        } else {
          const totalPx = numBytes << 3;
          const shiftPx = shres ? 1 : 0;
          for (let outX = minX; outX < maxX; outX++) {
            const s1 = (outX - startPx1) << shiftPx;
            const s2 = (outX - startPx2) << shiftPx;
            let c1 = 0;
            let c2 = 0;
            if (s1 >= 0 && s1 < totalPx) {
              const bi = s1 >>> 3;
              const bit = 7 - (s1 & 7);
              c1 =
                (activeBpu > 0 ? ((chip[(p0 + bi) & mask] >>> bit) & 1) : 0) |
                (activeBpu > 2 ? (((chip[(p2 + bi) & mask] >>> bit) & 1) << 1) : 0) |
                (activeBpu > 4 ? (((chip[(p4 + bi) & mask] >>> bit) & 1) << 2) : 0) |
                (activeBpu > 6 ? (((chip[(p6 + bi) & mask] >>> bit) & 1) << 3) : 0);
            }
            if (s2 >= 0 && s2 < totalPx) {
              const bi = s2 >>> 3;
              const bit = 7 - (s2 & 7);
              c2 =
                (activeBpu > 1 ? ((chip[(p1 + bi) & mask] >>> bit) & 1) : 0) |
                (activeBpu > 3 ? (((chip[(p3 + bi) & mask] >>> bit) & 1) << 1) : 0) |
                (activeBpu > 5 ? (((chip[(p5 + bi) & mask] >>> bit) & 1) << 2) : 0) |
                (activeBpu > 7 ? (((chip[(p7 + bi) & mask] >>> bit) & 1) << 3) : 0);
            }
            const colIdx = pf2Prio
              ? (c2 !== 0 ? ((pf2Offset + c2) & 0xff) : c1)
              : (c1 !== 0 ? c1 : (c2 !== 0 ? ((pf2Offset + c2) & 0xff) : 0));
            indices[outX] = colIdx;
            fb[rowOff + outX] = colors[colIdx ^ bplam];
          }
        }
      } else if (activeBpu <= 4) {
        let outX = startPx1;
        for (let byteIdx = 0; byteIdx < numBytes; byteIdx++) {
          const b0 = activeBpu > 0 ? chip[(p0 + byteIdx) & mask] : 0;
          const b1 = activeBpu > 1 ? chip[(p1 + byteIdx) & mask] : 0;
          const b2 = activeBpu > 2 ? chip[(p2 + byteIdx) & mask] : 0;
          const b3 = activeBpu > 3 ? chip[(p3 + byteIdx) & mask] : 0;

          for (let bit = 7; bit >= 0; bit -= stepBit) {
            if (outX >= minX && outX < maxX) {
              const idx =
                ((b0 >>> bit) & 1) |
                (((b1 >>> bit) & 1) << 1) |
                (((b2 >>> bit) & 1) << 2) |
                (((b3 >>> bit) & 1) << 3);
              indices[outX] = idx;
              fb[rowOff + outX] = colors[idx ^ bplam];
            }
            outX++;
          }
        }
      } else {
        // AGA Hi-Res / SHRES 5..8 bitplanes (up to 256 colors)
        let outX = startPx1;
        for (let byteIdx = 0; byteIdx < numBytes; byteIdx++) {
          const b0 = chip[(p0 + byteIdx) & mask];
          const b1 = chip[(p1 + byteIdx) & mask];
          const b2 = chip[(p2 + byteIdx) & mask];
          const b3 = chip[(p3 + byteIdx) & mask];
          const b4 = chip[(p4 + byteIdx) & mask];
          const b5 = activeBpu > 5 ? chip[(p5 + byteIdx) & mask] : 0;
          const b6 = activeBpu > 6 ? chip[(p6 + byteIdx) & mask] : 0;
          const b7 = activeBpu > 7 ? chip[(p7 + byteIdx) & mask] : 0;

          for (let bit = 7; bit >= 0; bit -= stepBit) {
            if (outX >= minX && outX < maxX) {
              const idx =
                ((b0 >>> bit) & 1) |
                (((b1 >>> bit) & 1) << 1) |
                (((b2 >>> bit) & 1) << 2) |
                (((b3 >>> bit) & 1) << 3) |
                (((b4 >>> bit) & 1) << 4) |
                (((b5 >>> bit) & 1) << 5) |
                (((b6 >>> bit) & 1) << 6) |
                (((b7 >>> bit) & 1) << 7);
              indices[outX] = idx;
              fb[rowOff + outX] = ehb && idx >= 32 ? ehbColors[idx & 31] : colors[idx ^ bplam];
            }
            outX++;
          }
        }
      }
    } else if (ham) {
      // Authentic Amiga HAM6 (Hold-And-Modify, 6 bitplanes; 24-bit base palette on AGA, 12-bit on OCS/ECS)
      const fetchPx = (this.ddfStrt - 0x38) << 1;
      const startPx = fetchPx + ((pf1ScrollLo - fetchPx) & wrapMaskLo) + hShiftLo;
      let outPx = startPx;

      if (isAga) {
        const c24_0 = this.colorReg24[bplam];
        let holdR = (c24_0 >>> 16) & 0xff;
        let holdG = (c24_0 >>> 8) & 0xff;
        let holdB = c24_0 & 0xff;

        for (let byteIdx = 0; byteIdx < numBytes; byteIdx++) {
          const b0 = chip[(p0 + byteIdx) & mask];
          const b1 = chip[(p1 + byteIdx) & mask];
          const b2 = chip[(p2 + byteIdx) & mask];
          const b3 = chip[(p3 + byteIdx) & mask];
          const b4 = chip[(p4 + byteIdx) & mask];
          const b5 = chip[(p5 + byteIdx) & mask];

          for (let bit = 7; bit >= 0; bit--) {
            const data4 =
              ((b0 >>> bit) & 1) |
              (((b1 >>> bit) & 1) << 1) |
              (((b2 >>> bit) & 1) << 2) |
              (((b3 >>> bit) & 1) << 3);
            const ctrl = ((b4 >>> bit) & 1) | (((b5 >>> bit) & 1) << 1);

            if (ctrl === 0) {
              const c24 = this.colorReg24[data4 ^ bplam];
              holdR = (c24 >>> 16) & 0xff;
              holdG = (c24 >>> 8) & 0xff;
              holdB = c24 & 0xff;
            } else if (ctrl === 1) {
              holdB = (holdB & 0x0f) | (data4 << 4);
            } else if (ctrl === 2) {
              holdR = (holdR & 0x0f) | (data4 << 4);
            } else {
              holdG = (holdG & 0x0f) | (data4 << 4);
            }

            if (outPx >= diwHStartLo && outPx < diwHStopLo) {
              const abgr = (0xff000000 | (holdB << 16) | (holdG << 8) | holdR) >>> 0;
              const x2 = outPx << 1;
              fb[rowOff + x2] = abgr;
              fb[rowOff + x2 + 1] = abgr;
              indices[x2] = data4;
              indices[x2 + 1] = data4;
            }
            outPx++;
          }
        }
      } else {
        let holdR = (this.colorReg[0] >>> 8) & 0xf;
        let holdG = (this.colorReg[0] >>> 4) & 0xf;
        let holdB = this.colorReg[0] & 0xf;

        for (let byteIdx = 0; byteIdx < numBytes; byteIdx++) {
          const b0 = chip[(p0 + byteIdx) & mask];
          const b1 = chip[(p1 + byteIdx) & mask];
          const b2 = chip[(p2 + byteIdx) & mask];
          const b3 = chip[(p3 + byteIdx) & mask];
          const b4 = chip[(p4 + byteIdx) & mask];
          const b5 = chip[(p5 + byteIdx) & mask];

          for (let bit = 7; bit >= 0; bit--) {
            const data4 =
              ((b0 >>> bit) & 1) |
              (((b1 >>> bit) & 1) << 1) |
              (((b2 >>> bit) & 1) << 2) |
              (((b3 >>> bit) & 1) << 3);
            const ctrl = ((b4 >>> bit) & 1) | (((b5 >>> bit) & 1) << 1);

            if (ctrl === 0) {
              const c12 = this.colorReg[data4];
              holdR = (c12 >>> 8) & 0xf;
              holdG = (c12 >>> 4) & 0xf;
              holdB = c12 & 0xf;
            } else if (ctrl === 1) {
              holdB = data4;
            } else if (ctrl === 2) {
              holdR = data4;
            } else {
              holdG = data4;
            }

            if (outPx >= diwHStartLo && outPx < diwHStopLo) {
              const abgr = RGB12_TO_ABGR32[(holdR << 8) | (holdG << 4) | holdB];
              const x2 = outPx << 1;
              fb[rowOff + x2] = abgr;
              fb[rowOff + x2 + 1] = abgr;
              indices[x2] = data4;
              indices[x2 + 1] = data4;
            }
            outPx++;
          }
        }
      }
    } else if (dpf) {
      // Dual Playfield Mode (Odd planes = PF1, Even planes = PF2 offset by PF2OF on AGA or 8 on OCS/ECS)
      const pf2Prio = (this.bplCon2 & 0x0040) !== 0;
      const fetchPx = (this.ddfStrt - 0x38) << 1;
      const startPx1 = fetchPx + ((pf1ScrollLo - fetchPx) & wrapMaskLo) + hShiftLo;
      const startPx2 = fetchPx + ((pf2ScrollLo - fetchPx) & wrapMaskLo) + hShiftLo;
      const totalPx = numBytes << 3;
      for (let outPx = diwHStartLo; outPx < diwHStopLo; outPx++) {
        const s1 = outPx - startPx1;
        const s2 = outPx - startPx2;
        let c1 = 0;
        let c2 = 0;
        if (s1 >= 0 && s1 < totalPx) {
          const bi = s1 >>> 3;
          const bit = 7 - (s1 & 7);
          c1 =
            (bpu > 0 ? ((chip[(p0 + bi) & mask] >>> bit) & 1) : 0) |
            (bpu > 2 ? (((chip[(p2 + bi) & mask] >>> bit) & 1) << 1) : 0) |
            (bpu > 4 ? (((chip[(p4 + bi) & mask] >>> bit) & 1) << 2) : 0) |
            (bpu > 6 ? (((chip[(p6 + bi) & mask] >>> bit) & 1) << 3) : 0);
        }
        if (s2 >= 0 && s2 < totalPx) {
          const bi = s2 >>> 3;
          const bit = 7 - (s2 & 7);
          c2 =
            (bpu > 1 ? ((chip[(p1 + bi) & mask] >>> bit) & 1) : 0) |
            (bpu > 3 ? (((chip[(p3 + bi) & mask] >>> bit) & 1) << 1) : 0) |
            (bpu > 5 ? (((chip[(p5 + bi) & mask] >>> bit) & 1) << 2) : 0) |
            (bpu > 7 ? (((chip[(p7 + bi) & mask] >>> bit) & 1) << 3) : 0);
        }
        const colIdx = pf2Prio
          ? (c2 !== 0 ? ((pf2Offset + c2) & 0xff) : c1)
          : (c1 !== 0 ? c1 : (c2 !== 0 ? ((pf2Offset + c2) & 0xff) : 0));
        const abgr = colors[colIdx ^ bplam];
        const x2 = outPx << 1;
        fb[rowOff + x2] = abgr;
        fb[rowOff + x2 + 1] = abgr;
        indices[x2] = colIdx;
        indices[x2 + 1] = colIdx;
      }
    } else if (!isAga || bpu <= 6) {
      // Standard Lo-Res 1..6 bitplanes (zero-overhead OCS/ECS hot loop + AGA EHB/KILLEHB/BPLAM)
      const fetchPx = (this.ddfStrt - 0x38) << 1;
      const startPx1 = fetchPx + ((pf1ScrollLo - fetchPx) & wrapMaskLo) + hShiftLo;
      const startPx2 = fetchPx + ((pf2ScrollLo - fetchPx) & wrapMaskLo) + hShiftLo;

      if (startPx1 === startPx2) {
        let outPx = startPx1;
        for (let byteIdx = 0; byteIdx < numBytes; byteIdx++) {
          const b0 = bpu > 0 ? chip[(p0 + byteIdx) & mask] : 0;
          const b1 = bpu > 1 ? chip[(p1 + byteIdx) & mask] : 0;
          const b2 = bpu > 2 ? chip[(p2 + byteIdx) & mask] : 0;
          const b3 = bpu > 3 ? chip[(p3 + byteIdx) & mask] : 0;
          const b4 = bpu > 4 ? chip[(p4 + byteIdx) & mask] : 0;
          const b5 = bpu > 5 ? chip[(p5 + byteIdx) & mask] : 0;

          for (let bit = 7; bit >= 0; bit--) {
            if (outPx >= diwHStartLo && outPx < diwHStopLo) {
              const idx =
                ((b0 >>> bit) & 1) |
                (((b1 >>> bit) & 1) << 1) |
                (((b2 >>> bit) & 1) << 2) |
                (((b3 >>> bit) & 1) << 3) |
                (((b4 >>> bit) & 1) << 4) |
                (((b5 >>> bit) & 1) << 5);
              const abgr = ehb && idx >= 32 ? ehbColors[idx & 31] : colors[idx ^ bplam];
              const x2 = outPx << 1;
              fb[rowOff + x2] = abgr;
              fb[rowOff + x2 + 1] = abgr;
              indices[x2] = idx;
              indices[x2 + 1] = idx;
            }
            outPx++;
          }
        }
      } else {
        const totalPx = numBytes << 3;
        for (let outPx = diwHStartLo; outPx < diwHStopLo; outPx++) {
          const s1 = outPx - startPx1;
          const s2 = outPx - startPx2;
          let idx = 0;
          if (s1 >= 0 && s1 < totalPx) {
            const bi = s1 >>> 3;
            const bit = 7 - (s1 & 7);
            if (bpu > 0) idx |= (chip[(p0 + bi) & mask] >>> bit) & 1;
            if (bpu > 2) idx |= ((chip[(p2 + bi) & mask] >>> bit) & 1) << 2;
            if (bpu > 4) idx |= ((chip[(p4 + bi) & mask] >>> bit) & 1) << 4;
          }
          if (s2 >= 0 && s2 < totalPx) {
            const bi = s2 >>> 3;
            const bit = 7 - (s2 & 7);
            if (bpu > 1) idx |= ((chip[(p1 + bi) & mask] >>> bit) & 1) << 1;
            if (bpu > 3) idx |= ((chip[(p3 + bi) & mask] >>> bit) & 1) << 3;
            if (bpu > 5) idx |= ((chip[(p5 + bi) & mask] >>> bit) & 1) << 5;
          }
          const abgr = ehb && idx >= 32 ? ehbColors[idx & 31] : colors[idx ^ bplam];
          const x2 = outPx << 1;
          fb[rowOff + x2] = abgr;
          fb[rowOff + x2 + 1] = abgr;
          indices[x2] = idx;
          indices[x2 + 1] = idx;
        }
      }
    } else {
      // AGA Lo-Res 7..8 bitplanes (128 / 256 colors)
      const fetchPx = (this.ddfStrt - 0x38) << 1;
      const startPx1 = fetchPx + ((pf1ScrollLo - fetchPx) & wrapMaskLo) + hShiftLo;
      const startPx2 = fetchPx + ((pf2ScrollLo - fetchPx) & wrapMaskLo) + hShiftLo;

      if (startPx1 === startPx2) {
        let outPx = startPx1;
        for (let byteIdx = 0; byteIdx < numBytes; byteIdx++) {
          const b0 = chip[(p0 + byteIdx) & mask];
          const b1 = chip[(p1 + byteIdx) & mask];
          const b2 = chip[(p2 + byteIdx) & mask];
          const b3 = chip[(p3 + byteIdx) & mask];
          const b4 = chip[(p4 + byteIdx) & mask];
          const b5 = chip[(p5 + byteIdx) & mask];
          const b6 = chip[(p6 + byteIdx) & mask];
          const b7 = bpu > 7 ? chip[(p7 + byteIdx) & mask] : 0;

          for (let bit = 7; bit >= 0; bit--) {
            if (outPx >= diwHStartLo && outPx < diwHStopLo) {
              const idx =
                ((b0 >>> bit) & 1) |
                (((b1 >>> bit) & 1) << 1) |
                (((b2 >>> bit) & 1) << 2) |
                (((b3 >>> bit) & 1) << 3) |
                (((b4 >>> bit) & 1) << 4) |
                (((b5 >>> bit) & 1) << 5) |
                (((b6 >>> bit) & 1) << 6) |
                (((b7 >>> bit) & 1) << 7);
              const abgr = colors[idx ^ bplam];
              const x2 = outPx << 1;
              fb[rowOff + x2] = abgr;
              fb[rowOff + x2 + 1] = abgr;
              indices[x2] = idx;
              indices[x2 + 1] = idx;
            }
            outPx++;
          }
        }
      } else {
        const totalPx = numBytes << 3;
        for (let outPx = diwHStartLo; outPx < diwHStopLo; outPx++) {
          const s1 = outPx - startPx1;
          const s2 = outPx - startPx2;
          let idx = 0;
          if (s1 >= 0 && s1 < totalPx) {
            const bi = s1 >>> 3;
            const bit = 7 - (s1 & 7);
            idx |=
              ((chip[(p0 + bi) & mask] >>> bit) & 1) |
              (((chip[(p2 + bi) & mask] >>> bit) & 1) << 2) |
              (((chip[(p4 + bi) & mask] >>> bit) & 1) << 4) |
              (((chip[(p6 + bi) & mask] >>> bit) & 1) << 6);
          }
          if (s2 >= 0 && s2 < totalPx) {
            const bi = s2 >>> 3;
            const bit = 7 - (s2 & 7);
            idx |=
              (((chip[(p1 + bi) & mask] >>> bit) & 1) << 1) |
              (((chip[(p3 + bi) & mask] >>> bit) & 1) << 3) |
              (((chip[(p5 + bi) & mask] >>> bit) & 1) << 5);
            if (bpu > 7) idx |= ((chip[(p7 + bi) & mask] >>> bit) & 1) << 7;
          }
          const abgr = colors[idx ^ bplam];
          const x2 = outPx << 1;
          fb[rowOff + x2] = abgr;
          fb[rowOff + x2 + 1] = abgr;
          indices[x2] = idx;
          indices[x2 + 1] = idx;
        }
      }
    }

    // Advance bitplane pointers by fetched bytes + odd/even modulo
    for (let p = 0; p < bpu; p++) {
      const mod = (p & 1) === 0 ? this.bpl1Mod : this.bpl2Mod;
      this.bplPt[p] = (this.bplPt[p] + numBytes + mod) & mask;
    }

    // Apply mid-scanline Copper palette / BPLAM changes (zero overhead when both counts === 0)
    if ((this.midlineColorCount > 0 || this.midlineBplamCount > 0) && !ham) {
      this.applyMidlineColors(rowOff, brdrBlnk ? minX : 0, brdrBlnk ? maxX : fbW, ehb, bplam);
    }
    this.midlineColorCount = 0;
    this.midlineBplamCount = 0;

    // Composite 8 Hardware Sprites on top
    this.renderSpritesOnLine(rowOff, false);
  }

  private fillMidlineBgSpans(rowOff: number, fbW: number, startBplam: number): void {
    const fb = this.framebuffer;
    const colorCount = this.midlineColorCount;
    const bplamCount = this.midlineBplamCount;

    if (bplamCount === 0) {
      let curBg = this.lineStartColorAbgr[startBplam];
      let curX = 0;
      for (let e = 0; e < colorCount; e++) {
        const x = this.midlineColorX[e];
        const endX = x < fbW ? x : fbW;
        if (endX > curX) {
          fb.fill(curBg, rowOff + curX, rowOff + endX);
          curX = endX;
        }
        if (this.midlineColorIdx[e] === startBplam) {
          curBg = this.midlineColorVal[e];
        }
        if (curX >= fbW) break;
      }
      if (curX < fbW) {
        fb.fill(curBg, rowOff + curX, rowOff + fbW);
      }
      return;
    }

    const abgr = this.workColorAbgr;
    abgr.set(this.lineStartColorAbgr);
    let curBplam = startBplam;
    let curBg = abgr[curBplam];
    let curX = 0;
    let eCol = 0;
    let eBpl = 0;
    while (curX < fbW && (eCol < colorCount || eBpl < bplamCount)) {
      const nextColX = eCol < colorCount ? this.midlineColorX[eCol] : fbW;
      const nextBplX = eBpl < bplamCount ? this.midlineBplamX[eBpl] : fbW;
      const nextX = nextColX <= nextBplX ? nextColX : nextBplX;
      const endX = nextX < fbW ? nextX : fbW;
      if (endX > curX) {
        fb.fill(curBg, rowOff + curX, rowOff + endX);
        curX = endX;
      }
      if (curX >= fbW) break;
      if (nextColX <= nextBplX) {
        abgr[this.midlineColorIdx[eCol]] = this.midlineColorVal[eCol];
        eCol++;
      } else {
        curBplam = this.midlineBplamVal[eBpl];
        eBpl++;
      }
      curBg = abgr[curBplam];
    }
    if (curX < fbW) {
      fb.fill(curBg, rowOff + curX, rowOff + fbW);
    }
  }

  private applyMidlineColors(
    rowOff: number,
    startX: number,
    limitX: number,
    ehb: boolean,
    startBplam: number
  ): void {
    const fb = this.framebuffer;
    const indices = this.lineIndices;
    const nCopy = this.midlineSavedCount;
    const abgr = this.workColorAbgr;
    const ehbArr = this.workColorEhb;
    if (nCopy === 32 && this.midlineBplamCount === 0) {
      abgr.set(this.lineStartColorAbgr.subarray(0, 32));
    } else {
      abgr.set(this.lineStartColorAbgr);
    }
    if (ehb) ehbArr.set(this.lineStartColorEhb);

    const isAga = this.chipset === 'AGA';
    const count = this.midlineColorCount;
    const bplamCount = this.midlineBplamCount;
    let curX = startX;
    let curBplam = startBplam;
    let eCol = 0;
    let eBpl = 0;

    while (curX < limitX) {
      const nextColX = eCol < count ? this.midlineColorX[eCol] : limitX;
      const nextBplX = eBpl < bplamCount ? this.midlineBplamX[eBpl] : limitX;
      const targetX = nextColX <= nextBplX ? nextColX : nextBplX;
      const endX = targetX < limitX ? targetX : limitX;
      if (endX > curX) {
        if (ehb) {
          for (let x = curX; x < endX; x++) {
            const idx = indices[x];
            fb[rowOff + x] = idx >= 32 ? ehbArr[idx & 31] : abgr[idx & 31];
          }
        } else if (isAga) {
          for (let x = curX; x < endX; x++) {
            fb[rowOff + x] = abgr[indices[x] ^ curBplam];
          }
        } else {
          for (let x = curX; x < endX; x++) {
            fb[rowOff + x] = abgr[indices[x] & 31];
          }
        }
        curX = endX;
      }
      if (curX >= limitX || (eCol >= count && eBpl >= bplamCount)) break;
      if (nextColX <= nextBplX) {
        const cIdx = this.midlineColorIdx[eCol];
        const cVal = this.midlineColorVal[eCol];
        abgr[cIdx] = cVal;
        if (ehb && cIdx < 32) {
          ehbArr[cIdx] = (((cVal >>> 1) & 0x007f7f7f) | 0xff000000) >>> 0;
        }
        eCol++;
      } else {
        curBplam = this.midlineBplamVal[eBpl];
        eBpl++;
      }
    }
  }

  private stepSpritesOnLine(line: number): void {
    const spriteHeaderLine = this.isPalTiming() ? 25 : 20;
    if (line < spriteHeaderLine) {
      this.sprDmaStreaming.fill(0);
      this.sprDmaLineActive.fill(0);
      return;
    }
    if ((this.dmacon & (DMA_MASTER | DMA_SPRITE)) !== (DMA_MASTER | DMA_SPRITE)) {
      this.sprDmaLineActive.fill(0);
      return;
    }
    const sprFmode = this.chipset === 'AGA' ? (this.fmode >>> 2) & 3 : 0;
    const mask = this.chipMask;

    for (let s = 0; s < 8; s++) {
      if (this.sprDmaOn[s] === 0) {
        this.sprDmaStreaming[s] = 0;
        this.sprDmaLineActive[s] = 0;
        continue;
      }
      const pos = this.sprPos[s];
      const ctl = this.sprCtl[s];
      const vStart = ((pos >>> 8) & 0xff) | ((ctl & 0x04) << 6);
      const vStop = ((ctl >>> 8) & 0xff) | ((ctl & 0x02) << 7);

      if (this.sprDmaStreaming[s] === 0) {
        if (line === vStart && vStart !== vStop) {
          this.sprDmaStreaming[s] = 1;
        } else {
          this.sprDmaLineActive[s] = 0;
          continue;
        }
      } else if (line === vStop) {
        this.sprDmaStreaming[s] = 0;
        this.sprDmaLineActive[s] = 0;
        const ptr = this.sprPt[s];
        if (ptr !== 0) {
          const ctlOff = sprFmode === 3 ? 8 : sprFmode !== 0 ? 4 : 2;
          const hdrBytes = sprFmode === 3 ? 16 : sprFmode !== 0 ? 8 : 4;
          const nextPos = this.readChip16(ptr);
          const nextCtl = this.readChip16(ptr + ctlOff);
          this.sprPos[s] = nextPos;
          this.sprCtl[s] = nextCtl;
          this.sprPt[s] = (ptr + hdrBytes) & mask;
          if (nextPos === 0 && nextCtl === 0) {
            this.sprDmaOn[s] = 0;
          }
        } else {
          this.sprDmaOn[s] = 0;
        }
        continue;
      }

      const ptr = this.sprPt[s];
      if (ptr !== 0) {
        if (sprFmode === 0) {
          const da = this.readChip16(ptr);
          const db = this.readChip16(ptr + 2);
          this.sprData[s] = da;
          this.sprDatb[s] = db;
          this.sprDataLo[s] = da;
          this.sprDatbLo[s] = db;
          this.sprPt[s] = (ptr + 4) & mask;
        } else if (sprFmode === 3) {
          const daHi = (this.readChip16(ptr) << 16) | this.readChip16(ptr + 2);
          const daLo = (this.readChip16(ptr + 4) << 16) | this.readChip16(ptr + 6);
          const dbHi = (this.readChip16(ptr + 8) << 16) | this.readChip16(ptr + 10);
          const dbLo = (this.readChip16(ptr + 12) << 16) | this.readChip16(ptr + 14);
          this.sprDataLo[s] = daHi >>> 0;
          this.sprDataHi[s] = daLo >>> 0;
          this.sprDatbLo[s] = dbHi >>> 0;
          this.sprDatbHi[s] = dbLo >>> 0;
          this.sprData[s] = (daHi >>> 16) & 0xffff;
          this.sprDatb[s] = (dbHi >>> 16) & 0xffff;
          this.sprPt[s] = (ptr + 16) & mask;
        } else {
          const da = (this.readChip16(ptr) << 16) | this.readChip16(ptr + 2);
          const db = (this.readChip16(ptr + 4) << 16) | this.readChip16(ptr + 6);
          this.sprDataLo[s] = da >>> 0;
          this.sprDatbLo[s] = db >>> 0;
          this.sprData[s] = (da >>> 16) & 0xffff;
          this.sprDatb[s] = (db >>> 16) & 0xffff;
          this.sprPt[s] = (ptr + 8) & mask;
        }
        this.sprDmaLineActive[s] = 1;
      } else {
        this.sprDmaStreaming[s] = 0;
        this.sprDmaLineActive[s] = 0;
        this.sprDmaOn[s] = 0;
      }
    }
  }

  private renderSpritesOnLine(rowOff: number, emptyBg: boolean): void {
    const dmaActive = this.sprDmaLineActive;
    const manualArmed = this.sprArmed;
    if (
      (dmaActive[0] | manualArmed[0] |
       dmaActive[1] | manualArmed[1] |
       dmaActive[2] | manualArmed[2] |
       dmaActive[3] | manualArmed[3] |
       dmaActive[4] | manualArmed[4] |
       dmaActive[5] | manualArmed[5] |
       dmaActive[6] | manualArmed[6] |
       dmaActive[7] | manualArmed[7]) === 0
    ) {
      return;
    }

    const fb = this.framebuffer;
    const colors = this.colorAbgr;
    const indices = this.lineIndices;
    const hOriginLo = this.viewHOriginLo;
    const viewLoWidth = this.fbWidth >>> 1;
    const dpf = (this.bplCon0 & 0x0400) !== 0;
    const pf1P = this.bplCon2 & 0x07;
    const pf2P = (this.bplCon2 >>> 3) & 0x07;
    const isAga = this.chipset === 'AGA';
    const brdrSprt =
      (this.bplCon3 & 0x0002) !== 0 &&
      (isAga || (this.chipset === 'ECS' && (this.bplCon0 & 0x0001) !== 0));
    let clipMinLo = 0;
    let clipMaxLo = viewLoWidth;
    if (
      !brdrSprt &&
      (this.bplCon3 & 0x0020) !== 0 &&
      (isAga || (this.chipset === 'ECS' && (this.bplCon0 & 0x0001) !== 0))
    ) {
      const d0 = this.diwHStart - hOriginLo;
      const d1 = this.diwHStop - hOriginLo;
      if (d0 > clipMinLo) clipMinLo = d0;
      if (d1 < clipMaxLo) clipMaxLo = d1;
      if (clipMaxLo <= clipMinLo) return;
    }
    const sprFmode = isAga ? (this.fmode >>> 2) & 3 : 0;
    const sprWidth = sprFmode === 3 ? 64 : sprFmode !== 0 ? 32 : 16;
    const dpfBound = isAga ? Math.max(8, PF2OF_TABLE[(this.bplCon3 >>> 10) & 7]) : 8;
    const evenPalBank = isAga ? (this.bplCon4 & 0x00f0) : 16;
    const oddPalBank = isAga ? ((this.bplCon4 & 0x000f) << 4) : 16;

    for (let k = 3; k >= 0; k--) {
      const e = k << 1;
      const o = e + 1;
      const eOn = (dmaActive[e] | manualArmed[e]) !== 0;
      const oOn = (dmaActive[o] | manualArmed[o]) !== 0;
      if (!eOn && !oOn) continue;

      const attached = (this.sprCtl[o] & 0x0080) !== 0;

      if (sprWidth === 16) {
        if (attached) {
          const posE = this.sprPos[e];
          const ctlE = this.sprCtl[e];
          const hE = (((posE & 0xff) << 1) | (ctlE & 1)) - hOriginLo;
          const posO = this.sprPos[o];
          const ctlO = this.sprCtl[o];
          const hO = (((posO & 0xff) << 1) | (ctlO & 1)) - hOriginLo;

          const datAe = eOn ? this.sprData[e] : 0;
          const datBe = eOn ? this.sprDatb[e] : 0;
          const datAo = oOn ? this.sprData[o] : 0;
          const datBo = oOn ? this.sprDatb[o] : 0;

          if (eOn && oOn && hE === hO) {
            for (let bit = 15; bit >= 0; bit--) {
              const col4 =
                ((datAe >>> bit) & 1) |
                (((datBe >>> bit) & 1) << 1) |
                (((datAo >>> bit) & 1) << 2) |
                (((datBo >>> bit) & 1) << 3);
              if (col4 === 0) continue;
              const sx = hE + (15 - bit);
              if (sx < clipMinLo || sx >= clipMaxLo) continue;
              const abgr = colors[evenPalBank + col4];
              const x2 = sx << 1;
              if (emptyBg) {
                fb[rowOff + x2] = abgr;
                fb[rowOff + x2 + 1] = abgr;
              } else {
                const i0 = indices[x2];
                const i1 = indices[x2 + 1];
                if (i0 === 0 || (!dpf ? k < pf2P : i0 < dpfBound ? k < pf1P : k < pf2P)) {
                  fb[rowOff + x2] = abgr;
                }
                if (i1 === 0 || (!dpf ? k < pf2P : i1 < dpfBound ? k < pf1P : k < pf2P)) {
                  fb[rowOff + x2 + 1] = abgr;
                }
              }
            }
          } else {
            let minSx = clipMaxLo;
            let maxSx = clipMinLo;
            if (eOn) {
              if (hE < minSx) minSx = hE;
              if (hE + 16 > maxSx) maxSx = hE + 16;
            }
            if (oOn) {
              if (hO < minSx) minSx = hO;
              if (hO + 16 > maxSx) maxSx = hO + 16;
            }
            if (minSx < clipMinLo) minSx = clipMinLo;
            if (maxSx > clipMaxLo) maxSx = clipMaxLo;
            for (let sx = minSx; sx < maxSx; sx++) {
              let col4 = 0;
              if (eOn) {
                const de = sx - hE;
                if (de >= 0 && de < 16) {
                  const bit = 15 - de;
                  col4 |= ((datAe >>> bit) & 1) | (((datBe >>> bit) & 1) << 1);
                }
              }
              if (oOn) {
                const dOdd = sx - hO;
                if (dOdd >= 0 && dOdd < 16) {
                  const bit = 15 - dOdd;
                  col4 |= (((datAo >>> bit) & 1) << 2) | (((datBo >>> bit) & 1) << 3);
                }
              }
              if (col4 === 0) continue;
              const abgr = colors[evenPalBank + col4];
              const x2 = sx << 1;
              if (emptyBg) {
                fb[rowOff + x2] = abgr;
                fb[rowOff + x2 + 1] = abgr;
              } else {
                const i0 = indices[x2];
                const i1 = indices[x2 + 1];
                if (i0 === 0 || (!dpf ? k < pf2P : i0 < dpfBound ? k < pf1P : k < pf2P)) {
                  fb[rowOff + x2] = abgr;
                }
                if (i1 === 0 || (!dpf ? k < pf2P : i1 < dpfBound ? k < pf1P : k < pf2P)) {
                  fb[rowOff + x2 + 1] = abgr;
                }
              }
            }
          }
        } else {
          const baseColorO = oddPalBank + (k << 2);
          const baseColorE = evenPalBank + (k << 2);
          if (oOn) {
            const datA = this.sprData[o];
            const datB = this.sprDatb[o];
            const pos = this.sprPos[o];
            const ctl = this.sprCtl[o];
            const hStart = (((pos & 0xff) << 1) | (ctl & 1)) - hOriginLo;
            for (let bit = 15; bit >= 0; bit--) {
              const pxCol = ((datA >>> bit) & 1) | (((datB >>> bit) & 1) << 1);
              if (pxCol === 0) continue;
              const sx = hStart + (15 - bit);
              if (sx < clipMinLo || sx >= clipMaxLo) continue;
              const abgr = colors[baseColorO + pxCol];
              const x2 = sx << 1;
              if (emptyBg) {
                fb[rowOff + x2] = abgr;
                fb[rowOff + x2 + 1] = abgr;
              } else {
                const i0 = indices[x2];
                const i1 = indices[x2 + 1];
                if (i0 === 0 || (!dpf ? k < pf2P : i0 < dpfBound ? k < pf1P : k < pf2P)) {
                  fb[rowOff + x2] = abgr;
                }
                if (i1 === 0 || (!dpf ? k < pf2P : i1 < dpfBound ? k < pf1P : k < pf2P)) {
                  fb[rowOff + x2 + 1] = abgr;
                }
              }
            }
          }
          if (eOn) {
            const datA = this.sprData[e];
            const datB = this.sprDatb[e];
            const pos = this.sprPos[e];
            const ctl = this.sprCtl[e];
            const hStart = (((pos & 0xff) << 1) | (ctl & 1)) - hOriginLo;
            for (let bit = 15; bit >= 0; bit--) {
              const pxCol = ((datA >>> bit) & 1) | (((datB >>> bit) & 1) << 1);
              if (pxCol === 0) continue;
              const sx = hStart + (15 - bit);
              if (sx < clipMinLo || sx >= clipMaxLo) continue;
              const abgr = colors[baseColorE + pxCol];
              const x2 = sx << 1;
              if (emptyBg) {
                fb[rowOff + x2] = abgr;
                fb[rowOff + x2 + 1] = abgr;
              } else {
                const i0 = indices[x2];
                const i1 = indices[x2 + 1];
                if (i0 === 0 || (!dpf ? k < pf2P : i0 < dpfBound ? k < pf1P : k < pf2P)) {
                  fb[rowOff + x2] = abgr;
                }
                if (i1 === 0 || (!dpf ? k < pf2P : i1 < dpfBound ? k < pf1P : k < pf2P)) {
                  fb[rowOff + x2 + 1] = abgr;
                }
              }
            }
          }
        }
      } else {
        // AGA 32px / 64px wide sprites (FMODE sprite width 2x / 4x)
        const hE = (((this.sprPos[e] & 0xff) << 1) | (this.sprCtl[e] & 1)) - hOriginLo;
        const hO = (((this.sprPos[o] & 0xff) << 1) | (this.sprCtl[o] & 1)) - hOriginLo;
        if (attached) {
          let minSx = clipMaxLo;
          let maxSx = clipMinLo;
          if (eOn) {
            if (hE < minSx) minSx = hE;
            if (hE + sprWidth > maxSx) maxSx = hE + sprWidth;
          }
          if (oOn) {
            if (hO < minSx) minSx = hO;
            if (hO + sprWidth > maxSx) maxSx = hO + sprWidth;
          }
          if (minSx < clipMinLo) minSx = clipMinLo;
          if (maxSx > clipMaxLo) maxSx = clipMaxLo;
          for (let sx = minSx; sx < maxSx; sx++) {
            let col4 = 0;
            if (eOn) {
              const de = sx - hE;
              if (de >= 0 && de < sprWidth) {
                const wA = de < 32 ? this.sprDataLo[e] : this.sprDataHi[e];
                const wB = de < 32 ? this.sprDatbLo[e] : this.sprDatbHi[e];
                const bit = 31 - (de & 31);
                col4 |= ((wA >>> bit) & 1) | (((wB >>> bit) & 1) << 1);
              }
            }
            if (oOn) {
              const dOdd = sx - hO;
              if (dOdd >= 0 && dOdd < sprWidth) {
                const wA = dOdd < 32 ? this.sprDataLo[o] : this.sprDataHi[o];
                const wB = dOdd < 32 ? this.sprDatbLo[o] : this.sprDatbHi[o];
                const bit = 31 - (dOdd & 31);
                col4 |= (((wA >>> bit) & 1) << 2) | (((wB >>> bit) & 1) << 3);
              }
            }
            if (col4 === 0) continue;
            const abgr = colors[evenPalBank + col4];
            const x2 = sx << 1;
            if (emptyBg) {
              fb[rowOff + x2] = abgr;
              fb[rowOff + x2 + 1] = abgr;
            } else {
              const i0 = indices[x2];
              const i1 = indices[x2 + 1];
              if (i0 === 0 || (!dpf ? k < pf2P : i0 < dpfBound ? k < pf1P : k < pf2P)) {
                fb[rowOff + x2] = abgr;
              }
              if (i1 === 0 || (!dpf ? k < pf2P : i1 < dpfBound ? k < pf1P : k < pf2P)) {
                fb[rowOff + x2 + 1] = abgr;
              }
            }
          }
        } else {
          if (oOn) {
            const baseColorO = oddPalBank + (k << 2);
            for (let dx = 0; dx < sprWidth; dx++) {
              const sx = hO + dx;
              if (sx < clipMinLo || sx >= clipMaxLo) continue;
              const wA = dx < 32 ? this.sprDataLo[o] : this.sprDataHi[o];
              const wB = dx < 32 ? this.sprDatbLo[o] : this.sprDatbHi[o];
              const bit = 31 - (dx & 31);
              const pxCol = ((wA >>> bit) & 1) | (((wB >>> bit) & 1) << 1);
              if (pxCol === 0) continue;
              const abgr = colors[baseColorO + pxCol];
              const x2 = sx << 1;
              if (emptyBg) {
                fb[rowOff + x2] = abgr;
                fb[rowOff + x2 + 1] = abgr;
              } else {
                const i0 = indices[x2];
                const i1 = indices[x2 + 1];
                if (i0 === 0 || (!dpf ? k < pf2P : i0 < dpfBound ? k < pf1P : k < pf2P)) {
                  fb[rowOff + x2] = abgr;
                }
                if (i1 === 0 || (!dpf ? k < pf2P : i1 < dpfBound ? k < pf1P : k < pf2P)) {
                  fb[rowOff + x2 + 1] = abgr;
                }
              }
            }
          }
          if (eOn) {
            const baseColorE = evenPalBank + (k << 2);
            for (let dx = 0; dx < sprWidth; dx++) {
              const sx = hE + dx;
              if (sx < clipMinLo || sx >= clipMaxLo) continue;
              const wA = dx < 32 ? this.sprDataLo[e] : this.sprDataHi[e];
              const wB = dx < 32 ? this.sprDatbLo[e] : this.sprDatbHi[e];
              const bit = 31 - (dx & 31);
              const pxCol = ((wA >>> bit) & 1) | (((wB >>> bit) & 1) << 1);
              if (pxCol === 0) continue;
              const abgr = colors[baseColorE + pxCol];
              const x2 = sx << 1;
              if (emptyBg) {
                fb[rowOff + x2] = abgr;
                fb[rowOff + x2 + 1] = abgr;
              } else {
                const i0 = indices[x2];
                const i1 = indices[x2 + 1];
                if (i0 === 0 || (!dpf ? k < pf2P : i0 < dpfBound ? k < pf1P : k < pf2P)) {
                  fb[rowOff + x2] = abgr;
                }
                if (i1 === 0 || (!dpf ? k < pf2P : i1 < dpfBound ? k < pf1P : k < pf2P)) {
                  fb[rowOff + x2 + 1] = abgr;
                }
              }
            }
          }
        }
      }
    }
  }

  public serializeRegs(): number[] {
    const out = new Array<number>(this.regs.length + 12);
    for (let i = 0; i < this.regs.length; i++) out[i] = this.regs[i];
    const base = this.regs.length;
    out[base] = this.dmacon;
    out[base + 1] = this.intena;
    out[base + 2] = this.intreq;
    out[base + 3] = this.adkcon;
    out[base + 4] = this.cop1lc;
    out[base + 5] = this.cop2lc;
    out[base + 6] = this.bplCon0;
    out[base + 7] = this.bplCon1;
    out[base + 8] = this.bplCon2;
    out[base + 9] = this.diwStrt;
    out[base + 10] = this.diwStop;
    out[base + 11] = this.dskPt;
    return out;
  }

  public deserializeRegs(data: number[]): void {
    const len = Math.min(this.regs.length, data.length);
    for (let i = 0; i < len; i++) {
      this.regs[i] = data[i];
    }
    this.colorAbgr.fill(0xff000000);
    this.colorReg24.fill(0);
    for (let i = 0; i < 32; i++) {
      const c12 = this.regs[(0x180 >>> 1) + i] & 0x0fff;
      this.colorReg[i] = c12;
      const abgr = RGB12_TO_ABGR32[c12];
      this.colorAbgr[i] = abgr;
      this.colorEhbAbgr[i] = RGB12_TO_EHB32[c12];
      const r8 = abgr & 0xff;
      const g8 = (abgr >>> 8) & 0xff;
      const b8 = (abgr >>> 16) & 0xff;
      this.colorReg24[i] = ((r8 << 16) | (g8 << 8) | b8) >>> 0;
    }
    const base = this.regs.length;
    if (data.length >= base + 12) {
      this.dmacon = data[base];
      this.intena = data[base + 1];
      this.intreq = data[base + 2];
      this.adkcon = data[base + 3];
      this.cop1lc = data[base + 4];
      this.cop2lc = data[base + 5];
      this.bplCon0 = data[base + 6];
      this.bplCon1 = data[base + 7];
      this.bplCon2 = data[base + 8];
      this.diwStrt = data[base + 9];
      this.diwStop = data[base + 10];
      this.dskPt = data[base + 11];
    }
    const ddfMask = this.chipset !== 'OCS' ? 0x01fc : 0x00fc;
    this.ddfStrt = (this.regs[0x092 >>> 1] & ddfMask) || 0x0038;
    this.ddfStop = (this.regs[0x094 >>> 1] & ddfMask) || 0x00d0;
    this.bpl1Mod = (this.regs[0x108 >>> 1] << 16) >> 16;
    this.bpl2Mod = (this.regs[0x10a >>> 1] << 16) >> 16;
    this.bplCon3 = this.chipset !== 'OCS' ? this.regs[0x106 >>> 1] : 0x0c00;
    this.bplCon4 = this.chipset === 'AGA' ? this.regs[0x10c >>> 1] : 0x0011;
    this.fmode = this.chipset === 'AGA' ? this.regs[0x1fc >>> 1] : 0;
    this.diwVStart = (this.diwStrt >>> 8) & 0xff;
    this.diwHStart = this.diwStrt & 0xff;
    const vs = (this.diwStop >>> 8) & 0xff;
    this.diwVStop = (vs & 0x80) === 0 ? (vs | 0x100) : vs;
    this.diwHStop = (this.diwStop & 0xff) | 0x100;
    this.diwHigh = this.regs[0x1e4 >>> 1];
    if (this.chipset !== 'OCS' && this.diwHigh !== 0) {
      this.diwVStart = ((this.diwStrt >>> 8) & 0xff) | ((this.diwHigh & 0x07) << 8);
      this.diwHStart = (this.diwStrt & 0xff) | ((this.diwHigh & 0x20) << 3);
      this.diwVStop = ((this.diwStop >>> 8) & 0xff) | (this.diwHigh & 0x0700);
      this.diwHStop = (this.diwStop & 0xff) | ((this.diwHigh & 0x2000) >>> 5);
    }
    this.updateIpl();
  }
}

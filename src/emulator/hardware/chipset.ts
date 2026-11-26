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
// PUAE blit_cycle_diagram CCKs per word indexed by (BLTCON0 >>> 8) & 0x0F (USEA,USEB,USEC,USED)
const BLIT_CCK_TABLE = new Uint8Array([2, 2, 2, 3, 3, 3, 3, 4, 2, 2, 2, 3, 3, 3, 3, 4]);

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

// Zero-allocation intra-frame audio event types (recorded for PaulaAudioEngine)
export const AUD_EVT_START = 1;
export const AUD_EVT_STOP = 2;
export const AUD_EVT_PER = 3;
export const AUD_EVT_VOL = 4;
export const AUD_EVT_LCLEN = 5;

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

  // Zero-overhead rescue for WHDLoad slaves (e.g. ReunionAGA v1.1 with CUSTOM1=1 Skip Intro)
  // that enter the game with DMACON display/master bits disabled after setting a display Copper list.
  private missingVideoDmaFrames = 0;
  private hadVideoDmaSinceCopWrite = false;
  private rescuedMissingDmaCop1lc = 0;

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
  private copWaitBlit = false;
  private copDeferredLine = -1;
  public copHpos = 0;

  // Blitter state (both instantaneous unit-test mode and scanline-incremental DMA mode)
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
  public bltPending = false;
  private bltDoneCycle = 0;
  public bltActive = false;
  private bltIsLine = false;
  private bltFastMode = 0; // 0 = general, 1 = clear (LF=$00 D-only), 2 = copy A->D (LF=$F0 unshifted)
  private bltWidthWords = 0;
  private bltRowsLeft = 0;
  private bltWordsLeftInRow = 0;
  private bltStep = 2;
  private bltAmodS = 0;
  private bltBmodS = 0;
  private bltCmodS = 0;
  private bltDmodS = 0;
  private bltAOld = 0;
  private bltBOld = 0;
  private bltBhold = 0;
  private bltFillCarry = 0;
  private bltUseMask = 0;
  private bltLf = 0;
  private bltAsh = 0;
  private bltBsh = 0;
  private bltDesc = false;
  private bltFillMode = false;
  private bltIncFill = false;
  private bltAccumZero = true;
  private bltPerWordCck = 2;
  private bltCckAccum = 0;
  private bltLastSyncHpos = 0;
  private bltLineBplStartH = 0;
  private bltLineBplEndH = 0;
  private bltLineBplSlots = 0;
  private bltLinePixelsLeft = 0;
  private bltLineAptErr = 0;
  private bltLineSingleDot = false;
  private bltLineFirstPixel = true;
  private bltLineSign = false;
  private bltLineAsh = 0;
  private bltLineBsh = 0;
  private bltLineUseC = false;
  private bltLineUseD = false;
  private bltLineUseA = false;
  private bltLineUseB = false;
  private bltLineBlineB = 0;
  private bltLineSud = false;
  private bltLineSul = false;
  private bltLineAul = false;
  private bltLineOneDot = false;

  // Bitplane & Display window registers (8 pointers for AGA, 6 for OCS/ECS)
  public readonly bplPt = new Uint32Array(8);
  public readonly bplDat = new Uint16Array(8);
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
  private diwHighWritten = false;
  private diwHStartSubHi = 0;
  private diwHStopSubHi = 0;
  private vdiwActive = false;
  private vdiwStateLine = -1;

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

  // Zero-allocation horizontal sprite multiplexer queue (PUAE decide_sprites_3)
  private static readonly MAX_SPR_MUX_EVENTS = 128;
  private sprSteppedLine = -1;
  private sprBeamHalfH = 0;
  private sprMuxCount = 0;
  private readonly sprMuxNum = new Uint8Array(AmigaChipset.MAX_SPR_MUX_EVENTS);
  private readonly sprMuxPos = new Uint16Array(AmigaChipset.MAX_SPR_MUX_EVENTS);
  private readonly sprMuxCtl = new Uint16Array(AmigaChipset.MAX_SPR_MUX_EVENTS);
  private readonly sprMuxData = new Uint16Array(AmigaChipset.MAX_SPR_MUX_EVENTS);
  private readonly sprMuxDatb = new Uint16Array(AmigaChipset.MAX_SPR_MUX_EVENTS);
  private readonly sprMuxDataLo = new Uint32Array(AmigaChipset.MAX_SPR_MUX_EVENTS);
  private readonly sprMuxDataHi = new Uint32Array(AmigaChipset.MAX_SPR_MUX_EVENTS);
  private readonly sprMuxDatbLo = new Uint32Array(AmigaChipset.MAX_SPR_MUX_EVENTS);
  private readonly sprMuxDatbHi = new Uint32Array(AmigaChipset.MAX_SPR_MUX_EVENTS);
  private readonly sprMuxConsumed = new Uint8Array(AmigaChipset.MAX_SPR_MUX_EVENTS);
  private readonly sprMuxUsed = new Uint8Array(AmigaChipset.MAX_SPR_MUX_EVENTS);

  // Denise/Lisa Collision Detection ($098 CLXCON, $10E CLXCON2, $00E CLXDAT) & POTGO ($034)
  public clxCon = 0;
  public clxCon2 = 0;
  public clxDat = 0;
  public potGo = 0;
  private readonly sprColMask = new Uint8Array(MAX_FB_WIDTH);
  private readonly clxBplLine = new Uint8Array(MAX_FB_WIDTH);
  private sprColMinSx = 0;
  private sprColMaxSx = 0;
  private ciaIrqChecker: (() => number) | null = null;

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
  private readonly audRawPer = new Uint32Array([400, 400, 400, 400]);
  private readonly audDatClocksLeft = new Int32Array(4);
  public audDatPendingMask = 0;
  public audStartPendingMask = 0;
  private readonly audStartClocksLeft = new Int32Array(4);
  public readonly audClockRem = new Int32Array(4);
  public audioSteppedInFrame = false;
  public frameAudClocks = 0;
  public audSawActivityInFrame = false;

  // Frame-start audio snapshot + zero-alloc event ring for exact scanline-synced mixing
  public readonly audSnapActive = new Uint8Array(4);
  public readonly audSnapCurAddr = new Uint32Array(4);
  public readonly audSnapWordsLeft = new Int32Array(4);
  public readonly audSnapLc = new Uint32Array(4);
  public readonly audSnapLen = new Int32Array(4);
  public readonly audSnapPer = new Uint16Array(4);
  public readonly audSnapVol = new Uint8Array(4);
  public readonly audSnapClockRem = new Int32Array(4);

  public static readonly MAX_AUD_EVENTS = 1024;
  public readonly audEvtClock = new Int32Array(AmigaChipset.MAX_AUD_EVENTS);
  public readonly audEvtType = new Uint8Array(AmigaChipset.MAX_AUD_EVENTS);
  public readonly audEvtCh = new Uint8Array(AmigaChipset.MAX_AUD_EVENTS);
  public readonly audEvtArg1 = new Int32Array(AmigaChipset.MAX_AUD_EVENTS);
  public readonly audEvtArg2 = new Int32Array(AmigaChipset.MAX_AUD_EVENTS);
  public readonly audEvtArg3 = new Int32Array(AmigaChipset.MAX_AUD_EVENTS);
  public audEvtCount = 0;

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
  // Reusable scanline pixel index & Dual-Playfield source scratchpads (zero GC)
  private readonly lineIndices = new Uint8Array(MAX_FB_WIDTH);
  private readonly lineDpfSrc = new Uint8Array(MAX_FB_WIDTH);

  // Preallocated mid-scanline Copper palette change buffers (zero GC, 0% cost on normal scanlines)
  private static readonly MAX_MIDLINE_COLOR_CHANGES = 256;
  private readonly midlineColorX = new Uint16Array(AmigaChipset.MAX_MIDLINE_COLOR_CHANGES);
  private readonly midlineColorIdx = new Uint8Array(AmigaChipset.MAX_MIDLINE_COLOR_CHANGES);
  private readonly midlineColorVal = new Uint32Array(AmigaChipset.MAX_MIDLINE_COLOR_CHANGES);
  private readonly lineStartColorAbgr = new Uint32Array(256);
  private readonly lineStartColorEhb = new Uint32Array(32);
  private readonly lineStartColor24 = new Uint32Array(256);
  private readonly workColorAbgr = new Uint32Array(256);
  private readonly workColorEhb = new Uint32Array(32);
  private readonly workColor24 = new Uint32Array(256);
  private midlineColorCount = 0;
  private midlinePaletteSaved = false;
  private midlineSavedCount = 32;
  private static readonly MAX_MIDLINE_BPLAM_CHANGES = 128;
  private readonly midlineBplamX = new Uint16Array(AmigaChipset.MAX_MIDLINE_BPLAM_CHANGES);
  private readonly midlineBplamVal = new Uint8Array(AmigaChipset.MAX_MIDLINE_BPLAM_CHANGES);
  private midlineBplamCount = 0;
  private lineStartBplam = 0;
  private inCopperVisibleSpan = false;
  private lineDisplayPhase = false;
  private inSync = false;
  private syncedHpos = 0;
  private copLineCleared = -1;

  // Preallocated mid-scanline display/bitplane split buffers (zero GC, 0% cost on normal scanlines)
  private static readonly MAX_LINE_SPLITS = 256;
  private readonly splitHpos = new Uint16Array(AmigaChipset.MAX_LINE_SPLITS);
  private readonly splitReg = new Uint16Array(AmigaChipset.MAX_LINE_SPLITS);
  private readonly splitVal = new Uint16Array(AmigaChipset.MAX_LINE_SPLITS);
  private lineSplitCount = 0;
  private lineSplitLine = -1;
  private lineStartCaptured = false;
  private bplDatWrittenOnLine = false;
  private readonly lineStartBplPt = new Uint32Array(8);
  private readonly lineStartBplDat = new Uint16Array(8);
  private readonly workBplPt = new Uint32Array(8);
  private readonly workBplDat = new Uint16Array(8);
  private readonly lineFetchedPlanes = new Uint8Array(8 * 256);
  private lineStartDmacon = 0;
  private lineStartBplCon0 = 0;
  private lineStartBplCon1 = 0;
  private lineStartBplCon2 = 0;
  private lineStartBplCon3 = 0;
  private lineStartBpl1Mod = 0;
  private lineStartBpl2Mod = 0;
  private lineStartDdfStrt = 0x0038;
  private lineStartDdfStop = 0x00d0;
  private lineStartDiwHStart = 0x81;
  private lineStartDiwHStop = 0x1c1;
  private lineStartDiwHStartSubHi = 0;
  private lineStartDiwHStopSubHi = 0;
  private lineStartDiwVStart = 0x2c;
  private lineStartDiwVStop = 0x12c;
  private lineStartDiwHigh = 0;
  private lineStartVdiwActive = false;
  private lineStartFmode = 0;
  private readonly splitPf1Idx = new Uint8Array(MAX_FB_WIDTH);
  private readonly splitPf2Idx = new Uint8Array(MAX_FB_WIDTH);

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

  public setCiaIrqChecker(fn: (() => number) | null): void {
    this.ciaIrqChecker = fn;
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

  private updateVdiwState(line: number): void {
    const hardDisV = this.chipset !== 'OCS' && (this.beamCon0 & 0x4000) !== 0;
    const pal = this.isPalTiming();
    const vbEndLine = (pal ? 312 : 262) + (this.lof & 1) - 1;
    const forceOff = !hardDisV && (line === 0 || line >= vbEndLine);
    const start = line === this.diwVStart && !forceOff;
    const end = line === this.diwVStop || forceOff;
    if (start && !end) {
      this.vdiwActive = true;
    } else if (end) {
      this.vdiwActive = false;
    }
    this.vdiwStateLine = line;
  }

  private resetScanlineEvents(line: number): void {
    this.midlineColorCount = 0;
    this.midlinePaletteSaved = false;
    this.midlineBplamCount = 0;
    this.lineStartBplam = this.chipset === 'AGA' ? ((this.bplCon4 >>> 8) & 0xff) : 0;
    this.lineSplitCount = 0;
    this.lineStartCaptured = false;
    this.bplDatWrittenOnLine = false;
    this.lineSplitLine = line;
    this.sprSteppedLine = -1;
    this.sprBeamHalfH = 0;
    this.sprMuxCount = 0;
    this.syncedHpos = 0;
    this.copLineCleared = -1;
    this.copDeferredLine = -1;
    this.lineDisplayPhase = true;
  }

  public beginScanline(line: number, startCycles: number, cycleBudget: number): void {
    this.vpos = line;
    this.hpos = 0;
    this.scanlineStartCycles = startCycles;
    this.scanlineCycleBudget = cycleBudget;
    this.bltLastSyncHpos = 0;
    this.updateVdiwState(line);
    this.resetScanlineEvents(line);
    if (this.bltActive) {
      this.initScanlineBlitterWindow(line);
    }
  }

  /**
   * Chronologically synchronizes Blitter, Sprites, and Copper up to horizontal color clock `targetHpos`.
   * Zero overhead when already synced or idle; prevents mid-line CPU/Copper/Blitter ordering races.
   */
  public syncToHpos(targetHpos: number, allowPalWrap = false): void {
    if (this.inSync || !this.lineDisplayPhase) return;
    const h = targetHpos > 227 ? 227 : targetHpos;
    this.inSync = true;
    try {
      if (this.bltPending) {
        if (this.bltActive) {
          if (h > this.bltLastSyncHpos) {
            this.stepBlitterToHpos(h);
          }
        } else if (this.cycleSource === null || this.cycleSource.cycles >= this.bltDoneCycle) {
          this.bltPending = false;
          this.requestIrq(INT_BLIT);
        }
      }
      if (h >= 0x18 && this.sprSteppedLine !== this.vpos) {
        this.stepSpritesOnLine(this.vpos);
        this.sprSteppedLine = this.vpos;
      }
      if (this.sprMuxCount > 0) {
        const halfH = h << 1;
        if (halfH > this.sprBeamHalfH) {
          this.decideSpritesUntil(halfH);
        }
      }
      if ((this.dmacon & (DMA_MASTER | DMA_COPPER)) === (DMA_MASTER | DMA_COPPER)) {
        this.runCopperInternal(this.vpos, h, allowPalWrap, true);
      }
      if (h > this.syncedHpos) {
        this.syncedHpos = h;
      }
    } finally {
      this.inSync = false;
    }
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
    this.missingVideoDmaFrames = 0;
    this.hadVideoDmaSinceCopWrite = false;
    this.rescuedMissingDmaCop1lc = 0;
    this.lof = 1;
    this.beamCon0 = this.videoStandard === 'PAL' ? 0x0020 : 0x0000;
    this.midlineColorCount = 0;
    this.midlinePaletteSaved = false;
    this.midlineBplamCount = 0;
    this.lineStartBplam = 0;
    this.inCopperVisibleSpan = false;
    this.lineDisplayPhase = false;
    this.lineSplitCount = 0;
    this.lineStartCaptured = false;
    this.lineSplitLine = -1;
    this.cop1lc = 0;
    this.cop2lc = 0;
    this.copPc = 0;
    this.copCon = 0;
    this.copWaiting = false;
    this.copSkipNext = false;
    this.copWaitBlit = false;
    this.copDeferredLine = -1;
    this.copHpos = 0;

    this.bplPt.fill(0);
    this.bplDat.fill(0);
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
    this.diwHighWritten = false;
    this.diwHStartSubHi = 0;
    this.diwHStopSubHi = 0;
    this.vdiwActive = false;
    this.vdiwStateLine = -1;
    this.diwVStart = 0x2c;
    this.diwVStop = 0x12c;
    this.diwHStart = 0x81;
    this.diwHStop = 0x1c1;
    this.inSync = false;
    this.syncedHpos = 0;
    this.copLineCleared = -1;
    this.bplDatWrittenOnLine = false;
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
    this.sprSteppedLine = -1;
    this.sprBeamHalfH = 0;
    this.sprMuxCount = 0;
    this.clxCon = 0;
    this.clxCon2 = 0;
    this.clxDat = 0;
    this.potGo = 0;
    this.sprColMask.fill(0);

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
    this.audRawPer.fill(400);
    this.audDatClocksLeft.fill(0);
    this.audDatPendingMask = 0;
    this.audStartPendingMask = 0;
    this.audStartClocksLeft.fill(0);
    this.audClockRem.fill(0);
    this.audioSteppedInFrame = false;
    this.frameAudClocks = 0;
    this.audSawActivityInFrame = false;
    this.audSnapActive.fill(0);
    this.audEvtCount = 0;

    this.bltZero = false;
    this.bltPending = false;
    this.bltDoneCycle = 0;
    this.bltActive = false;
    this.bltAOld = 0;
    this.bltBOld = 0;
    this.bltBhold = 0;
    this.bltCckAccum = 0;
    this.bltLastSyncHpos = 0;
    this.framebuffer.fill(0xff000000);
    this.updateIpl();
  }

  /**
   * Advances or completes any in-flight Blitter DMA up to current scanline HPos (or cycle threshold).
   * Zero-cost fast path (`if (!this.bltPending) return;`) when idle.
   */
  public syncBlitter(): void {
    if (!this.bltPending) return;
    if (this.bltActive) {
      const targetHpos = this.inCopperVisibleSpan
        ? (this.copHpos > 227 ? 227 : this.copHpos)
        : this.getHpos();
      this.stepBlitterToHpos(targetHpos);
      return;
    }
    if (this.cycleSource === null || this.cycleSource.cycles >= this.bltDoneCycle) {
      this.bltPending = false;
      this.requestIrq(INT_BLIT);
    }
  }

  /**
   * Advances incremental Blitter DMA for the remainder of the current scanline (called once per line).
   */
  public endScanlineBlitter(lineCcks = 227): void {
    if (!this.bltActive) {
      if (this.bltPending) this.syncBlitter();
      return;
    }
    this.stepBlitterToHpos(lineCcks);
  }

  private maybeBlit(): void {
    if (!this.bltActive) return;
    this.syncBlitter();
    if (
      this.bltActive &&
      (this.dmacon & (DMA_MASTER | DMA_BLITTER)) === (DMA_MASTER | DMA_BLITTER)
    ) {
      this.finishBlitterImmediate();
    }
  }

  private getWriteHpos(): number {
    if (this.inCopperVisibleSpan) {
      return this.copHpos >= 2 ? this.copHpos - 2 : 0;
    }
    if (this.lineDisplayPhase && this.scanlineCycleBudget > 0) {
      return this.getHpos();
    }
    return -1;
  }

  private captureLineStartDisplay(): void {
    this.lineStartCaptured = true;
    this.lineStartBplPt.set(this.bplPt);
    this.lineStartBplDat.set(this.bplDat);
    this.lineStartDmacon = this.dmacon;
    this.lineStartBplCon0 = this.bplCon0;
    this.lineStartBplCon1 = this.bplCon1;
    this.lineStartBplCon2 = this.bplCon2;
    this.lineStartBplCon3 = this.bplCon3;
    this.lineStartBpl1Mod = this.bpl1Mod;
    this.lineStartBpl2Mod = this.bpl2Mod;
    this.lineStartDdfStrt = this.ddfStrt;
    this.lineStartDdfStop = this.ddfStop;
    this.lineStartDiwHStart = this.diwHStart;
    this.lineStartDiwHStop = this.diwHStop;
    this.lineStartDiwHStartSubHi = this.diwHStartSubHi;
    this.lineStartDiwHStopSubHi = this.diwHStopSubHi;
    this.lineStartDiwVStart = this.diwVStart;
    this.lineStartDiwVStop = this.diwVStop;
    this.lineStartDiwHigh = this.diwHigh;
    this.lineStartVdiwActive =
      this.vdiwStateLine === this.vpos
        ? this.vdiwActive
        : (this.vpos >= this.diwVStart && this.vpos < this.diwVStop);
    this.lineStartFmode = this.fmode;
  }

  private recordDisplaySplit(writeHpos: number, reg: number, v: number): boolean {
    if (writeHpos < 0) return true;
    const effStartH = this.ddfStrt < 0x18 ? 0x18 : this.ddfStrt;
    if (this.lineSplitCount === 0) {
      if (writeHpos < effStartH) return true;
      const vActive =
        this.vdiwStateLine === this.vpos
          ? this.vdiwActive
          : (this.vpos >= this.diwVStart && this.vpos < this.diwVStop);
      const isGlobalDisplayReg =
        reg === 0x08e ||
        reg === 0x090 ||
        reg === 0x1e4 ||
        reg === 0x096 ||
        reg === 0x100;
      if (!vActive && !isGlobalDisplayReg) return true;
      this.captureLineStartDisplay();
    } else if (writeHpos < effStartH) {
      // Pre-DDF CPU write on a line that already has splits: update lineStart directly.
      // Return whether a later split overrides `reg` (only mutate live `this.*` if not overridden).
      let overridden = false;
      const n = this.lineSplitCount;
      for (let i = 0; i < n; i++) {
        if (this.splitReg[i] === reg) {
          overridden = true;
          break;
        }
      }
      return !overridden;
    }

    const count = this.lineSplitCount;
    if (count >= AmigaChipset.MAX_LINE_SPLITS) return true;
    let ins = count;
    while (ins > 0 && this.splitHpos[ins - 1] > writeHpos) {
      this.splitHpos[ins] = this.splitHpos[ins - 1];
      this.splitReg[ins] = this.splitReg[ins - 1];
      this.splitVal[ins] = this.splitVal[ins - 1];
      ins--;
    }
    this.splitHpos[ins] = writeHpos;
    this.splitReg[ins] = reg;
    this.splitVal[ins] = v;
    this.lineSplitCount = count + 1;

    if (ins === count) return true;
    for (let i = ins + 1; i <= count; i++) {
      if (this.splitReg[i] === reg) return false;
    }
    return true;
  }

  private recordMidlineColor(writeHpos: number, idx: number, abgr: number, c12: number, has12: boolean): boolean {
    const pxX = ((writeHpos << 1) - this.viewHOriginLo) << 1;
    const isAga = this.chipset === 'AGA';
    const count = this.midlineColorCount;
    if (pxX <= 0) {
      if (count > 0 && this.midlinePaletteSaved) {
        this.lineStartColorAbgr[idx] = abgr;
        if (isAga) {
          this.lineStartColor24[idx] = (((abgr & 0xff) << 16) | (abgr & 0xff00) | ((abgr >>> 16) & 0xff)) >>> 0;
        }
        if (has12 && idx < 32) {
          this.lineStartColorEhb[idx] = RGB12_TO_EHB32[c12];
        }
        for (let i = 0; i < count; i++) {
          if (this.midlineColorIdx[i] === idx) return false;
        }
      }
      return true;
    }
    if (count >= AmigaChipset.MAX_MIDLINE_COLOR_CHANGES) return true;
    if (!this.midlinePaletteSaved) {
      if (isAga) {
        this.lineStartColorAbgr.set(this.colorAbgr);
        this.lineStartColor24.set(this.colorReg24);
        this.midlineSavedCount = 256;
      } else {
        this.lineStartColorAbgr.set(this.colorAbgr.subarray(0, 32));
        this.midlineSavedCount = 32;
      }
      this.lineStartColorEhb.set(this.colorEhbAbgr);
      this.midlinePaletteSaved = true;
    }
    let ins = count;
    while (ins > 0 && this.midlineColorX[ins - 1] > pxX) {
      this.midlineColorX[ins] = this.midlineColorX[ins - 1];
      this.midlineColorIdx[ins] = this.midlineColorIdx[ins - 1];
      this.midlineColorVal[ins] = this.midlineColorVal[ins - 1];
      ins--;
    }
    this.midlineColorX[ins] = pxX;
    this.midlineColorIdx[ins] = idx;
    this.midlineColorVal[ins] = abgr;
    this.midlineColorCount = count + 1;
    if (ins === count) return true;
    for (let i = ins + 1; i <= count; i++) {
      if (this.midlineColorIdx[i] === idx) return false;
    }
    return true;
  }

  private decideSpritesUntil(targetHalfH: number): void {
    const startH = this.sprBeamHalfH;
    if (targetHalfH <= startH) return;
    const dmaActive = this.sprDmaLineActive;
    const manualArmed = this.sprArmed;
    const activeAny =
      dmaActive[0] | manualArmed[0] |
      dmaActive[1] | manualArmed[1] |
      dmaActive[2] | manualArmed[2] |
      dmaActive[3] | manualArmed[3] |
      dmaActive[4] | manualArmed[4] |
      dmaActive[5] | manualArmed[5] |
      dmaActive[6] | manualArmed[6] |
      dmaActive[7] | manualArmed[7];
    if (activeAny !== 0) {
      for (let s = 0; s < 8; s++) {
        if ((dmaActive[s] | manualArmed[s]) === 0) continue;
        const pos = this.sprPos[s];
        const ctl = this.sprCtl[s];
        const hLo = ((pos & 0xff) << 1) | (ctl & 1);
        if (pos === 0 && (ctl & 0x11) === 0) continue;
        if (hLo >= startH && hLo < targetHalfH) {
          const n = this.sprMuxCount;
          if (n < AmigaChipset.MAX_SPR_MUX_EVENTS) {
            this.sprMuxNum[n] = s;
            this.sprMuxPos[n] = pos;
            this.sprMuxCtl[n] = ctl;
            this.sprMuxData[n] = this.sprData[s];
            this.sprMuxDatb[n] = this.sprDatb[s];
            this.sprMuxDataLo[n] = this.sprDataLo[s];
            this.sprMuxDataHi[n] = this.sprDataHi[s];
            this.sprMuxDatbLo[n] = this.sprDatbLo[s];
            this.sprMuxDatbHi[n] = this.sprDatbHi[s];
            this.sprMuxUsed[n] = 0;
            this.sprMuxCount = n + 1;
          }
        }
      }
    }
    this.sprBeamHalfH = targetHalfH;
  }

  private scheduleBlitDone(ccks: number): void {
    const src = this.cycleSource;
    if (src === null) {
      this.bltPending = false;
      this.requestIrq(INT_BLIT);
      return;
    }
    const cyclesPerCck =
      this.scanlineCycleBudget > 0
        ? this.scanlineCycleBudget / 227
        : this.chipset === 'AGA'
          ? 4
          : 2;
    const rawCycles = Math.round(ccks * cyclesPerCck);
    const delayCycles = rawCycles < 24 ? 24 : rawCycles;
    this.bltPending = true;
    this.bltDoneCycle = src.cycles + delayCycles;
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
    if (this.ciaIrqChecker !== null) {
      this.intreq |= this.ciaIrqChecker();
    }
    const audBits = (bits >>> 7) & 0x0f;
    if (audBits !== 0) {
      this.audStartPendingMask &= ~audBits;
    }
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
        if (this.lineDisplayPhase && this.scanlineCycleBudget > 0 && !this.inSync) {
          this.syncToHpos(this.getHpos());
        }
        this.syncBlitter();
        let val = this.dmacon & 0x07ff;
        if (this.bltZero) val |= 0x2000; // BZERO
        if (this.bltPending) val |= 0x4000; // BBUSY
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
      case 0x00e: { // CLXDAT (read clears collision latch)
        if (this.lineDisplayPhase && this.scanlineCycleBudget > 0 && !this.inSync) {
          this.syncToHpos(this.getHpos());
        }
        const val = this.clxDat & 0x7fff;
        this.clxDat = 0;
        return val;
      }
      case 0x010: // ADKCONR
        return this.adkcon & 0x7fff;
      case 0x016: { // POTGOR / POTINP (active-low secondary mouse/joy buttons + POTGO output pins)
        if (!this.isPalTiming()) this.noteNtscInputPoll();
        const outMask = this.potGo & 0xaa00;
        const drivenMask = outMask >>> 1;
        let val = (0x5500 & ~drivenMask) | (this.potGo & drivenMask);
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
        if (this.lineDisplayPhase && this.scanlineCycleBudget > 0 && !this.inSync) {
          this.syncToHpos(this.getHpos());
        }
        this.syncBlitter();
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
    if (!this.inSync && !this.inCopperVisibleSpan && this.lineDisplayPhase && this.scanlineCycleBudget > 0) {
      this.syncToHpos(this.getHpos());
    }
    this.regs[reg >>> 1] = v;

    // Color registers $180 - $1BE (fast hot path for OCS/ECS + 256-color 24-bit banked AGA)
    if (reg >= 0x180 && reg <= 0x1be) {
      const idx = (reg - 0x180) >>> 1;
      const writeHpos = this.getWriteHpos();
      if (this.chipset !== 'AGA') {
        const c12 = v & 0x0fff;
        const abgr = RGB12_TO_ABGR32[c12];
        const applyLive = writeHpos < 0 || this.recordMidlineColor(writeHpos, idx, abgr, c12, true);
        if (applyLive) {
          this.colorReg[idx] = c12;
          this.colorAbgr[idx] = abgr;
          this.colorEhbAbgr[idx] = RGB12_TO_EHB32[c12];
        }
        return;
      }

      if ((this.bplCon2 & 0x0100) !== 0) return; // AGA RDRAM=1 disables palette register writes
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
      }
      const c24 = ((r8 << 16) | (g8 << 8) | b8) >>> 0;
      const abgr = (0xff000000 | (b8 << 16) | (g8 << 8) | r8) >>> 0;
      const applyLive = writeHpos < 0 || this.recordMidlineColor(writeHpos, bankIdx, abgr, v & 0x0fff, !loct && bank === 0);
      if (applyLive) {
        this.colorReg24[bankIdx] = c24;
        if (!loct && bank === 0) {
          const c12 = v & 0x0fff;
          this.colorReg[idx] = c12;
          this.colorEhbAbgr[idx] = RGB12_TO_EHB32[c12];
        }
        this.colorAbgr[bankIdx] = abgr;
      }
      return;
    }

    // Bitplane pointers $0E0 - $0FE (6 planes on OCS/ECS, 8 planes on AGA)
    if (reg >= 0x0e0 && reg <= (this.chipset === 'AGA' ? 0x0fe : 0x0f6)) {
      const idx = (reg - 0x0e0) >>> 2;
      const writeHpos = this.getWriteHpos();
      const applyLive = writeHpos < 0 || this.recordDisplaySplit(writeHpos, reg, v);
      const isBeforeDdf = writeHpos >= 0 && this.lineSplitCount > 0 && writeHpos < (this.ddfStrt < 0x18 ? 0x18 : this.ddfStrt);
      if (isBeforeDdf) {
        if ((reg & 2) === 0) {
          this.lineStartBplPt[idx] = ((v & 0x1f) << 16) | (this.lineStartBplPt[idx] & 0xffff);
        } else {
          this.lineStartBplPt[idx] = (this.lineStartBplPt[idx] & 0x1f0000) | (v & 0xfffe);
        }
      }
      if (applyLive) {
        if ((reg & 2) === 0) {
          this.bplPt[idx] = ((v & 0x1f) << 16) | (this.bplPt[idx] & 0xffff);
        } else {
          this.bplPt[idx] = (this.bplPt[idx] & 0x1f0000) | (v & 0xfffe);
        }
      }
      return;
    }

    // Sprite pointers $120 - $13E
    if (reg >= 0x120 && reg <= 0x13e) {
      const writeHpos = this.getWriteHpos();
      if (writeHpos >= 0x18 && this.sprSteppedLine !== this.vpos) {
        this.stepSpritesOnLine(this.vpos);
        this.sprSteppedLine = this.vpos;
      }
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
      const writeHpos = this.getWriteHpos();
      if (writeHpos >= 0) {
        if (writeHpos >= 0x18 && this.sprSteppedLine !== this.vpos) {
          this.stepSpritesOnLine(this.vpos);
          this.sprSteppedLine = this.vpos;
        }
        const writeHalfH = writeHpos << 1;
        let targetHalfH = writeHalfH;
        if (sub <= 1) {
          targetHalfH = writeHalfH + 2;
        } else if ((this.sprCtl[idx] & 1) === 0) {
          targetHalfH = writeHalfH + 1;
        }
        if (targetHalfH > this.sprBeamHalfH) {
          this.decideSpritesUntil(targetHalfH);
        }
      }
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
        if (this.chipset === 'AGA') {
          const rep = ((v << 16) | v) >>> 0;
          this.sprDataLo[idx] = rep;
          this.sprDataHi[idx] = rep;
        } else {
          this.sprDataLo[idx] = v;
          this.sprDataHi[idx] = 0;
        }
        this.sprArmed[idx] = 1;
      } else {
        this.sprDatb[idx] = v;
        if (this.chipset === 'AGA') {
          const rep = ((v << 16) | v) >>> 0;
          this.sprDatbLo[idx] = rep;
          this.sprDatbHi[idx] = rep;
        } else {
          this.sprDatbLo[idx] = v;
          this.sprDatbHi[idx] = 0;
        }
      }
      return;
    }

    // Audio channels $0A0 - $0DE
    if (reg >= 0x0a0 && reg <= 0x0de) {
      const chIdx = (reg - 0x0a0) >>> 4;
      const sub = reg & 0x0e;
      const ch = this.audio[chIdx];
      const runningDma = ch.active && (this.audStartPendingMask & (1 << chIdx)) === 0;
      if (sub === 0x00) {
        ch.lc = ((v & 0x1f) << 16) | (ch.lc & 0xffff);
        if (runningDma) {
          this.pushAudioEvent(AUD_EVT_LCLEN, chIdx, this.getAudioEventClock(), ch.lc, ch.len, 0);
        }
      } else if (sub === 0x02) {
        ch.lc = (ch.lc & 0x1f0000) | (v & 0xfffe);
        if (runningDma) {
          this.pushAudioEvent(AUD_EVT_LCLEN, chIdx, this.getAudioEventClock(), ch.lc, ch.len, 0);
        }
      } else if (sub === 0x04) {
        ch.len = v === 0 ? 0x10000 : v;
        if (runningDma) {
          this.pushAudioEvent(AUD_EVT_LCLEN, chIdx, this.getAudioEventClock(), ch.lc, ch.len, 0);
        }
      } else if (sub === 0x06) {
        this.audRawPer[chIdx] = v === 0 ? 65536 : v;
        const nextPer = v < 124 ? 124 : v;
        if (nextPer !== ch.per) {
          ch.per = nextPer;
          if (runningDma) {
            this.pushAudioEvent(AUD_EVT_PER, chIdx, this.getAudioEventClock(), nextPer, 0, 0);
          }
        }
      } else if (sub === 0x08) {
        const vol = v & 0x7f;
        const nextVol = vol > 64 ? 64 : vol;
        if (nextVol !== ch.vol) {
          ch.vol = nextVol;
          if (nextVol > 0 && runningDma) {
            this.audSawActivityInFrame = true;
          }
          if (runningDma) {
            this.pushAudioEvent(AUD_EVT_VOL, chIdx, this.getAudioEventClock(), nextVol, 0, 0);
          }
        }
      } else if (sub === 0x0a) {
        // Direct AUDxDAT write
        ch.lastSample = ((v << 16) >> 24);
        if (!ch.active) {
          // Authentic Paula behavior: writing AUDxDAT with DMA off clocks out 1 word (2 * rawPer color clocks)
          // and fires INT_AUDx (used by audio.device with AUDxPER=1 to enter its Level 4 ISR).
          this.audDatClocksLeft[chIdx] = this.audRawPer[chIdx] << 1;
          this.audDatPendingMask |= 1 << chIdx;
        }
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
      case 0x034: this.potGo = v & 0xff00; break;
      case 0x040: this.maybeBlit(); this.bltCon0 = v; break;
      case 0x042: this.maybeBlit(); this.bltCon1 = v; break;
      case 0x044: this.maybeBlit(); this.bltAfwm = v; break;
      case 0x046: this.maybeBlit(); this.bltAlwm = v; break;
      case 0x048: this.maybeBlit(); this.bltCpt = ((v & 0x1f) << 16) | (this.bltCpt & 0xffff); break;
      case 0x04a: this.maybeBlit(); this.bltCpt = (this.bltCpt & 0x1f0000) | (v & 0xfffe); break;
      case 0x04c: this.maybeBlit(); this.bltBpt = ((v & 0x1f) << 16) | (this.bltBpt & 0xffff); break;
      case 0x04e: this.maybeBlit(); this.bltBpt = (this.bltBpt & 0x1f0000) | (v & 0xfffe); break;
      case 0x050: this.maybeBlit(); this.bltApt = ((v & 0x1f) << 16) | (this.bltApt & 0xffff); break;
      case 0x052: this.maybeBlit(); this.bltApt = (this.bltApt & 0x1f0000) | (v & 0xfffe); break;
      case 0x054: this.maybeBlit(); this.bltDpt = ((v & 0x1f) << 16) | (this.bltDpt & 0xffff); break;
      case 0x056: this.maybeBlit(); this.bltDpt = (this.bltDpt & 0x1f0000) | (v & 0xfffe); break;
      case 0x058: { // BLTSIZE (starts OCS Blitter immediately)
        const height = (v >>> 6) & 0x3ff;
        const width = v & 0x3f;
        this.runBlitter(width === 0 ? 64 : width, height === 0 ? 1024 : height);
        break;
      }
      case 0x05a: // ECS/AGA BLTCON0L (updates low minterm byte without clobbering channel/shift bits)
        this.maybeBlit();
        if (this.chipset !== 'OCS') {
          this.bltCon0 = (this.bltCon0 & 0xff00) | (v & 0xff);
        }
        break;
      case 0x05c: // ECS BLTSIZV
        this.maybeBlit();
        this.bltSizV = v & 0x7fff;
        break;
      case 0x05e: { // ECS BLTSIZH (triggers ECS Blitter)
        const w = v & 0x7ff;
        const h = this.bltSizV;
        this.runBlitter(w === 0 ? 2048 : w, h === 0 ? 32768 : h);
        break;
      }
      case 0x060: this.maybeBlit(); this.bltCmod = ((v & 0xfffe) << 16) >> 16; break;
      case 0x062: this.maybeBlit(); this.bltBmod = ((v & 0xfffe) << 16) >> 16; break;
      case 0x064: this.maybeBlit(); this.bltAmod = ((v & 0xfffe) << 16) >> 16; break;
      case 0x066: this.maybeBlit(); this.bltDmod = ((v & 0xfffe) << 16) >> 16; break;
      case 0x070: this.maybeBlit(); this.bltCdat = v; break;
      case 0x072: {
        this.maybeBlit();
        this.bltBdat = v;
        const bsh = (this.bltCon1 >>> 12) & 0xf;
        if (bsh === 0) this.bltBhold = v;
        else if ((this.bltCon1 & 2) !== 0) this.bltBhold = (v << bsh) & 0xffff;
        else this.bltBhold = (v >>> bsh) & 0xffff;
        break;
      }
      case 0x074: this.maybeBlit(); this.bltAdat = v; break;
      case 0x07e: this.dskSync = v; break;
      case 0x080: this.cop1lc = ((v & 0x1f) << 16) | (this.cop1lc & 0xffff); break;
      case 0x082:
        this.cop1lc = (this.cop1lc & 0x1f0000) | (v & 0xfffe);
        this.lastCop1lcWritePc = this.cycleSource !== null ? this.cycleSource.pc & 0x00ffffff : 0;
        if (
          this.lastCop1lcWritePc > 0 &&
          this.lastCop1lcWritePc < 0xf80000 &&
          this.cop1lc >= 0x200 &&
          this.cop1lc !== this.rescuedMissingDmaCop1lc
        ) {
          this.hadVideoDmaSinceCopWrite =
            (this.dmacon & (DMA_MASTER | DMA_COPPER | DMA_BITPLANE)) !== 0;
          if (this.hadVideoDmaSinceCopWrite) {
            this.missingVideoDmaFrames = 0;
          }
        }
        break;
      case 0x084: this.cop2lc = ((v & 0x1f) << 16) | (this.cop2lc & 0xffff); break;
      case 0x086: this.cop2lc = (this.cop2lc & 0x1f0000) | (v & 0xfffe); break;
      case 0x088: // COPJMP1
        this.copPc = this.cop1lc;
        this.copWaiting = false;
        this.copSkipNext = false;
        this.copWaitBlit = false;
        this.copDeferredLine = -1;
        break;
      case 0x08a: // COPJMP2
        this.copPc = this.cop2lc;
        this.copWaiting = false;
        this.copSkipNext = false;
        this.copWaitBlit = false;
        this.copDeferredLine = -1;
        break;
      case 0x08e: {
        if (this.bltActive) this.syncBlitter();
        const wh = this.getWriteHpos();
        const applyLive = wh < 0 || this.recordDisplaySplit(wh, 0x08e, v);
        if (wh >= 0 && this.lineSplitCount > 0 && wh < (this.ddfStrt < 0x18 ? 0x18 : this.ddfStrt)) {
          this.lineStartDiwVStart = (v >>> 8) & 0xff;
          this.lineStartDiwHStart = v & 0xff;
          if (this.chipset !== 'OCS') {
            this.lineStartDiwHStartSubHi = 0;
            this.lineStartDiwHigh &= ~0x0027;
          }
        }
        if (applyLive) {
          this.diwStrt = v;
          this.diwVStart = (v >>> 8) & 0xff;
          this.diwHStart = v & 0xff;
          if (this.chipset !== 'OCS') {
            this.diwHigh &= ~0x0027;
            this.diwHStartSubHi = 0;
            this.diwHighWritten = false;
            this.regs[0x1e4 >>> 1] = this.diwHigh;
          }
          if (this.vdiwStateLine === this.vpos) this.updateVdiwState(this.vpos);
          if (this.bltActive) this.initScanlineBlitterWindow(this.vpos);
        }
        break;
      }
      case 0x090: {
        if (this.bltActive) this.syncBlitter();
        this.ntscDiwStopWritten = true;
        const wh = this.getWriteHpos();
        const applyLive = wh < 0 || this.recordDisplaySplit(wh, 0x090, v);
        const vs = (v >>> 8) & 0xff;
        const v8 = (vs & 0x80) === 0 ? 0x100 : 0;
        if (wh >= 0 && this.lineSplitCount > 0 && wh < (this.ddfStrt < 0x18 ? 0x18 : this.ddfStrt)) {
          this.lineStartDiwVStop = vs | v8;
          this.lineStartDiwHStop = (v & 0xff) | 0x100;
          if (this.chipset !== 'OCS') {
            this.lineStartDiwHStopSubHi = 0;
            this.lineStartDiwHigh = (this.lineStartDiwHigh & ~0x2700) | 0x2000 | v8;
          }
        }
        if (applyLive) {
          this.diwStop = v;
          this.diwVStop = vs | v8;
          this.diwHStop = (v & 0xff) | 0x100;
          if (this.chipset !== 'OCS') {
            this.diwHigh = (this.diwHigh & ~0x2700) | 0x2000 | v8;
            this.diwHStopSubHi = 0;
            this.diwHighWritten = false;
            this.regs[0x1e4 >>> 1] = this.diwHigh;
          }
          if (this.vdiwStateLine === this.vpos) this.updateVdiwState(this.vpos);
          if (this.bltActive) this.initScanlineBlitterWindow(this.vpos);
        }
        break;
      }
      case 0x092: {
        if (this.bltActive) this.syncBlitter();
        const masked = v & (this.chipset !== 'OCS' ? 0x01fe : 0x00fc);
        const wh = this.getWriteHpos();
        const applyLive = wh < 0 || this.recordDisplaySplit(wh, 0x092, masked);
        if (wh >= 0 && this.lineSplitCount > 0 && wh < (this.ddfStrt < 0x18 ? 0x18 : this.ddfStrt)) {
          this.lineStartDdfStrt = masked;
        }
        if (applyLive) {
          this.ddfStrt = masked;
          if (this.bltActive) this.initScanlineBlitterWindow(this.vpos);
        }
        break;
      }
      case 0x094: {
        if (this.bltActive) this.syncBlitter();
        const masked = v & (this.chipset !== 'OCS' ? 0x01fe : 0x00fc);
        const wh = this.getWriteHpos();
        const applyLive = wh < 0 || this.recordDisplaySplit(wh, 0x094, masked);
        if (wh >= 0 && this.lineSplitCount > 0 && wh < (this.ddfStrt < 0x18 ? 0x18 : this.ddfStrt)) {
          this.lineStartDdfStop = masked;
        }
        if (applyLive) {
          this.ddfStop = masked;
          if (this.bltActive) this.initScanlineBlitterWindow(this.vpos);
        }
        break;
      }
      case 0x096: { // DMACON
        if (this.bltActive) this.syncBlitter();
        const wh = this.getWriteHpos();
        if (wh >= 0) {
          this.recordDisplaySplit(wh, 0x096, v);
          if (this.lineSplitCount > 0 && wh < (this.ddfStrt < 0x18 ? 0x18 : this.ddfStrt)) {
            if (v & 0x8000) this.lineStartDmacon |= v & 0x07ff;
            else this.lineStartDmacon &= ~(v & 0x07ff);
          }
        }
        const prev = this.dmacon;
        if (v & 0x8000) this.dmacon |= v & 0x07ff;
        else this.dmacon &= ~(v & 0x07ff);
        if (this.bltActive) this.initScanlineBlitterWindow(this.vpos);
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
        if ((this.dmacon & (DMA_MASTER | DMA_COPPER | DMA_BITPLANE)) !== 0) {
          this.hadVideoDmaSinceCopWrite = true;
          this.missingVideoDmaFrames = 0;
        }
        // Trigger audio channel DMA reload on rising edge (startup INT_AUDx fires ~1 scanline later
        // when Paula completes the first DMA fetch slot, so an immediate INTREQ clear after DMACON does not lose it).
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
            this.audClockRem[i] = 0;
            this.audDatPendingMask &= ~bit;
            this.audStartPendingMask |= bit;
            this.audStartClocksLeft[i] = 227 + this.getHpos();
          } else if (!nowOn) {
            if (ch.active && (this.audStartPendingMask & bit) === 0) {
              this.pushAudioEvent(AUD_EVT_STOP, i, this.getAudioEventClock(), 0, 0, 0);
              // Authentic Paula 010/011 -> 000 exit: disabling active audio DMA finishes the current word
              // (2 * rawPer color clocks) and asserts INT_AUDx (used by ProTracker/PS3M/Worms DC stop-wait loops).
              this.audDatClocksLeft[i] = this.audRawPer[i] << 1;
              this.audDatPendingMask |= bit;
            }
            ch.active = false;
            this.audStartPendingMask &= ~bit;
            this.audStartClocksLeft[i] = 0;
          }
        }
        break;
      }
      case 0x098: this.clxCon = v; break;
      case 0x09a: // INTENA
        this.syncBlitter();
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
        this.syncBlitter();
        if (v & 0x8000) {
          this.intreq |= v & 0x3fff;
        } else {
          this.intreq &= ~(v & 0x3fff);
          if (this.ciaIrqChecker !== null) {
            this.intreq |= this.ciaIrqChecker();
          }
          if (this.vertbPollShadow && (v & INT_VERTB) !== 0) {
            const src = this.cycleSource;
            if (src !== null && (src.pc >>> 0) < 0xf80000 && (src.sr & 0x0700) < 0x0300) {
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
      case 0x100: {
        if (this.bltActive) this.syncBlitter();
        const wh = this.getWriteHpos();
        const applyLive = wh < 0 || this.recordDisplaySplit(wh, 0x100, v);
        if (wh >= 0 && this.lineSplitCount > 0 && wh < (this.ddfStrt < 0x18 ? 0x18 : this.ddfStrt)) {
          this.lineStartBplCon0 = v;
        }
        if (applyLive) {
          this.bplCon0 = v;
          if (this.bltActive) this.initScanlineBlitterWindow(this.vpos);
        }
        break;
      }
      case 0x102: {
        const wh = this.getWriteHpos();
        const applyLive = wh < 0 || this.recordDisplaySplit(wh, 0x102, v);
        if (wh >= 0 && this.lineSplitCount > 0 && wh < (this.ddfStrt < 0x18 ? 0x18 : this.ddfStrt)) {
          this.lineStartBplCon1 = v;
        }
        if (applyLive) this.bplCon1 = v;
        break;
      }
      case 0x104: {
        const wh = this.getWriteHpos();
        const applyLive = wh < 0 || this.recordDisplaySplit(wh, 0x104, v);
        if (wh >= 0 && this.lineSplitCount > 0 && wh < (this.ddfStrt < 0x18 ? 0x18 : this.ddfStrt)) {
          this.lineStartBplCon2 = v;
        }
        if (applyLive) this.bplCon2 = v;
        break;
      }
      case 0x106:
        if (this.chipset !== 'OCS') {
          const wh = this.getWriteHpos();
          const applyLive = wh < 0 || this.recordDisplaySplit(wh, 0x106, v);
          if (wh >= 0 && this.lineSplitCount > 0 && wh < (this.ddfStrt < 0x18 ? 0x18 : this.ddfStrt)) {
            this.lineStartBplCon3 = v;
          }
          if (applyLive) this.bplCon3 = v;
        }
        break;
      case 0x108: {
        const mod = ((v & 0xfffe) << 16) >> 16;
        const wh = this.getWriteHpos();
        const applyLive = wh < 0 || this.recordDisplaySplit(wh, 0x108, v);
        if (wh >= 0 && this.lineSplitCount > 0 && wh < (this.ddfStrt < 0x18 ? 0x18 : this.ddfStrt)) {
          this.lineStartBpl1Mod = mod;
        }
        if (applyLive) this.bpl1Mod = mod;
        break;
      }
      case 0x10a: {
        const mod = ((v & 0xfffe) << 16) >> 16;
        const wh = this.getWriteHpos();
        const applyLive = wh < 0 || this.recordDisplaySplit(wh, 0x10a, v);
        if (wh >= 0 && this.lineSplitCount > 0 && wh < (this.ddfStrt < 0x18 ? 0x18 : this.ddfStrt)) {
          this.lineStartBpl2Mod = mod;
        }
        if (applyLive) this.bpl2Mod = mod;
        break;
      }
      case 0x10c:
        if (this.chipset === 'AGA') {
          const wh = this.getWriteHpos();
          if (wh >= 0) {
            const prevBplam = (this.bplCon4 >>> 8) & 0xff;
            const nextBplam = (v >>> 8) & 0xff;
            if (nextBplam !== prevBplam) {
              const pxX = ((wh << 1) - this.viewHOriginLo) << 1;
              if (pxX > 0 && this.midlineBplamCount < AmigaChipset.MAX_MIDLINE_BPLAM_CHANGES) {
                if (!this.midlinePaletteSaved) {
                  this.lineStartColorAbgr.set(this.colorAbgr);
                  this.lineStartColor24.set(this.colorReg24);
                  this.lineStartColorEhb.set(this.colorEhbAbgr);
                  this.midlinePaletteSaved = true;
                  this.midlineSavedCount = 256;
                }
                const cnt = this.midlineBplamCount;
                let ins = cnt;
                while (ins > 0 && this.midlineBplamX[ins - 1] > pxX) {
                  this.midlineBplamX[ins] = this.midlineBplamX[ins - 1];
                  this.midlineBplamVal[ins] = this.midlineBplamVal[ins - 1];
                  ins--;
                }
                this.midlineBplamX[ins] = pxX;
                this.midlineBplamVal[ins] = nextBplam;
                this.midlineBplamCount = cnt + 1;
              } else if (pxX <= 0) {
                this.lineStartBplam = nextBplam;
              }
            }
          }
          this.bplCon4 = v;
        }
        break;
      case 0x10e: // ECS/AGA CLXCON2
        if (this.chipset !== 'OCS') this.clxCon2 = v;
        break;
      case 0x110:
      case 0x112:
      case 0x114:
      case 0x116:
      case 0x118:
      case 0x11a:
      case 0x11c:
      case 0x11e: {
        const p = (reg - 0x110) >>> 1;
        const wh = this.getWriteHpos();
        if (wh >= 0 && reg === 0x110) {
          if (!this.lineStartCaptured && this.lineSplitCount === 0) {
            this.captureLineStartDisplay();
          }
          this.bplDatWrittenOnLine = true;
          const cnt = this.lineSplitCount;
          if (cnt < AmigaChipset.MAX_LINE_SPLITS) {
            let ins = cnt;
            while (ins > 0 && this.splitHpos[ins - 1] > wh) {
              this.splitHpos[ins] = this.splitHpos[ins - 1];
              this.splitReg[ins] = this.splitReg[ins - 1];
              this.splitVal[ins] = this.splitVal[ins - 1];
              ins--;
            }
            this.splitHpos[ins] = wh;
            this.splitReg[ins] = reg;
            this.splitVal[ins] = v;
            this.lineSplitCount = cnt + 1;
          }
        } else if (wh >= 0 && this.lineSplitCount > 0) {
          this.recordDisplaySplit(wh, reg, v);
        }
        this.bplDat[p] = v;
        break;
      }
      case 0x1dc: // ECS/AGA BEAMCON0
        if (this.chipset !== 'OCS') {
          this.beamCon0 = v;
        }
        break;
      case 0x1e4: {
        if (this.bltActive) this.syncBlitter();
        const wh = this.getWriteHpos();
        const applyLive = wh < 0 || this.recordDisplaySplit(wh, 0x1e4, v);
        const vMask = this.chipset === 'AGA' ? 7 : 15;
        if (wh >= 0 && this.chipset !== 'OCS' && this.lineSplitCount > 0 && wh < (this.ddfStrt < 0x18 ? 0x18 : this.ddfStrt)) {
          this.lineStartDiwHigh = v;
          this.lineStartDiwVStart = (this.lineStartDiwVStart & 0xff) | ((v & vMask) << 8);
          this.lineStartDiwHStart = (this.lineStartDiwHStart & 0xff) | ((v & 0x20) << 3);
          this.lineStartDiwVStop = (this.lineStartDiwVStop & 0xff) | (v & (vMask << 8));
          this.lineStartDiwHStop = (this.lineStartDiwHStop & 0xff) | ((v & 0x2000) >>> 5);
          this.lineStartDiwHStartSubHi = this.chipset === 'AGA' ? ((v >>> 4) & 1) : 0;
          this.lineStartDiwHStopSubHi = this.chipset === 'AGA' ? ((v >>> 12) & 1) : 0;
        }
        if (applyLive) {
          this.diwHigh = v;
          if (this.chipset !== 'OCS') {
            this.diwHighWritten = true;
            this.diwVStart = ((this.diwStrt >>> 8) & 0xff) | ((v & vMask) << 8);
            this.diwHStart = (this.diwStrt & 0xff) | ((v & 0x20) << 3);
            this.diwVStop = ((this.diwStop >>> 8) & 0xff) | (v & (vMask << 8));
            this.diwHStop = (this.diwStop & 0xff) | ((v & 0x2000) >>> 5);
            this.diwHStartSubHi = this.chipset === 'AGA' ? ((v >>> 4) & 1) : 0;
            this.diwHStopSubHi = this.chipset === 'AGA' ? ((v >>> 12) & 1) : 0;
            if (this.vdiwStateLine === this.vpos) this.updateVdiwState(this.vpos);
          }
          if (this.bltActive) this.initScanlineBlitterWindow(this.vpos);
        }
        break;
      }
      case 0x1fc: // AGA FMODE
        if (this.chipset === 'AGA') {
          if (this.bltActive) this.syncBlitter();
          const wh = this.getWriteHpos();
          const applyLive = wh < 0 || this.recordDisplaySplit(wh, 0x1fc, v);
          if (wh >= 0 && this.lineSplitCount > 0 && wh < (this.ddfStrt < 0x18 ? 0x18 : this.ddfStrt)) {
            this.lineStartFmode = v;
          }
          if (applyLive) {
            this.fmode = v;
            if (this.bltActive) this.initScanlineBlitterWindow(this.vpos);
          }
        }
        break;
    }
  }

  public stepAudDatPending(clocksPerLine = 227): void {
    let mask = this.audDatPendingMask;
    if (mask === 0) return;
    let irqBits = 0;
    for (let i = 0; i < 4; i++) {
      const bit = 1 << i;
      if ((mask & bit) === 0) continue;
      const rem = this.audDatClocksLeft[i] - clocksPerLine;
      if (rem <= 0) {
        this.audDatClocksLeft[i] = 0;
        mask &= ~bit;
        if (!this.audio[i].active) {
          irqBits |= INT_AUD0 << i;
        }
      } else {
        this.audDatClocksLeft[i] = rem;
      }
    }
    this.audDatPendingMask = mask;
    if (irqBits !== 0) {
      this.requestIrq(irqBits);
    }
  }

  private getAudioEventClock(): number {
    return this.frameAudClocks + this.getHpos();
  }

  private pushAudioEvent(
    type: number,
    chIdx: number,
    clock: number,
    arg1: number,
    arg2: number,
    arg3: number
  ): void {
    let idx = this.audEvtCount;
    if (idx >= AmigaChipset.MAX_AUD_EVENTS) return;
    while (idx > 0 && this.audEvtClock[idx - 1] > clock) {
      this.audEvtClock[idx] = this.audEvtClock[idx - 1];
      this.audEvtType[idx] = this.audEvtType[idx - 1];
      this.audEvtCh[idx] = this.audEvtCh[idx - 1];
      this.audEvtArg1[idx] = this.audEvtArg1[idx - 1];
      this.audEvtArg2[idx] = this.audEvtArg2[idx - 1];
      this.audEvtArg3[idx] = this.audEvtArg3[idx - 1];
      idx--;
    }
    this.audEvtClock[idx] = clock;
    this.audEvtType[idx] = type;
    this.audEvtCh[idx] = chIdx;
    this.audEvtArg1[idx] = arg1;
    this.audEvtArg2[idx] = arg2;
    this.audEvtArg3[idx] = arg3;
    this.audEvtCount++;
  }

  /**
   * Scanline-level Paula audio & DMA step (zero heap allocations, ~1ns fast exit when idle).
   * Delivers DMACON startup INT_AUDx after ~1 scanline, advances curAddr/wordsLeft on exact
   * scanlines so mid-frame wraparounds, short buffers, and re-triggers fire INT_AUDx on time.
   */
  public stepAudioScanline(clocksPerLine = 227): void {
    this.audioSteppedInFrame = true;
    const lineStartClock = this.frameAudClocks;
    const lineEndClock = lineStartClock + clocksPerLine;
    this.frameAudClocks = lineEndClock;

    const dmaAudioOn = (this.dmacon & (DMA_MASTER | 0x0f)) > DMA_MASTER;
    if ((this.audDatPendingMask | this.audStartPendingMask) === 0 && !dmaAudioOn) {
      return;
    }

    if (this.audDatPendingMask !== 0) {
      this.stepAudDatPending(clocksPerLine);
    }

    let irqBits = 0;
    let startMask = this.audStartPendingMask;
    const mask = this.chipMask;

    for (let i = 0; i < 4; i++) {
      const bit = 1 << i;
      const ch = this.audio[i];
      if (!ch.active) continue;

      let rem: number;
      if ((startMask & bit) !== 0) {
        const remStart = this.audStartClocksLeft[i] - clocksPerLine;
        if (remStart > 0) {
          this.audStartClocksLeft[i] = remStart;
          continue;
        }
        this.audStartClocksLeft[i] = 0;
        startMask &= ~bit;
        irqBits |= INT_AUD0 << i;
        const startClock = lineEndClock + remStart; // exact sub-line clock when startup completes
        if (ch.vol > 0) this.audSawActivityInFrame = true;
        this.pushAudioEvent(
          AUD_EVT_START,
          i,
          startClock,
          ch.curAddr,
          ch.wordsLeft,
          ((ch.per & 0xffff) << 7) | (ch.vol & 0x7f)
        );
        if (ch.lc !== ch.curAddr || ch.len !== ch.wordsLeft) {
          this.pushAudioEvent(AUD_EVT_LCLEN, i, startClock, ch.lc, ch.len, 0);
        }
        rem = -remStart;
      } else {
        rem = this.audClockRem[i] + clocksPerLine;
      }

      const effPer = ch.per < 124 ? 124 : ch.per;
      if (rem >= effPer) {
        let samples = 1;
        rem -= effPer;
        if (rem >= effPer) {
          const extra = (rem / effPer) | 0;
          samples += extra;
          rem -= extra * effPer;
        }
        const prevOdd = ch.curAddr & 1;
        const wordsDone = (prevOdd + samples) >>> 1;
        const newOdd = (prevOdd + samples) & 1;
        if (wordsDone < ch.wordsLeft) {
          ch.wordsLeft -= wordsDone;
          ch.curAddr = (ch.curAddr + samples) & mask;
        } else {
          const afterFirst = wordsDone - ch.wordsLeft;
          const len = ch.len > 0 ? ch.len : 1;
          const intoLoop = afterFirst % len;
          ch.wordsLeft = len - intoLoop;
          ch.curAddr = (ch.lc + (intoLoop << 1) + newOdd) & mask;
          irqBits |= INT_AUD0 << i;
        }
      }
      this.audClockRem[i] = rem;
    }

    this.audStartPendingMask = startMask;
    if (irqBits !== 0) {
      this.requestIrq(irqBits);
    }
  }

  /**
   * Advances one active Paula DMA channel mathematically in O(1) without mixing PCM samples.
   * Keeps INT_AUDx buffer-completion interrupts running when WebAudio is muted/suspended or channel vol === 0.
   */
  public advanceAudioChannelSilent(chIdx: number, isPal = true): void {
    const ch = this.audio[chIdx];
    if (!ch.active) return;
    const clocksPerFrame = isPal ? 3546895 / 50 : 3579545 / 59.94006;
    const effPer = ch.per < 124 ? 124 : ch.per;
    const totalPhase = ch.phase + clocksPerFrame / effPer;
    const samples = totalPhase | 0;
    ch.phase = totalPhase - samples;
    if (samples <= 0) return;

    const wordsDone = ((ch.curAddr & 1) + samples) >>> 1;
    const newOdd = (ch.curAddr + samples) & 1;
    const mask = this.chipMask;
    if (wordsDone < ch.wordsLeft) {
      ch.wordsLeft -= wordsDone;
      ch.curAddr = (ch.curAddr + samples) & mask;
    } else {
      const afterFirstWrap = wordsDone - ch.wordsLeft;
      const len = ch.len > 0 ? ch.len : 1;
      const intoLoop = afterFirstWrap % len;
      ch.wordsLeft = len - intoLoop;
      ch.curAddr = (ch.lc + (intoLoop << 1) + newOdd) & mask;
      this.requestIrq(INT_AUD0 << chIdx);
    }
  }

  public advanceAudioDmaSilent(isPal = true): void {
    if ((this.dmacon & (DMA_MASTER | 0x0f)) <= DMA_MASTER && this.audStartPendingMask === 0) return;
    if (this.audStartPendingMask !== 0) {
      let irqBits = 0;
      for (let i = 0; i < 4; i++) {
        if ((this.audStartPendingMask & (1 << i)) !== 0) {
          this.audStartClocksLeft[i] = 0;
          irqBits |= INT_AUD0 << i;
        }
      }
      this.audStartPendingMask = 0;
      if (irqBits !== 0) this.requestIrq(irqBits);
    }
    for (let c = 0; c < 4; c++) {
      if (this.audio[c].active) {
        this.advanceAudioChannelSilent(c, isPal);
      }
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

  private initScanlineBlitterWindow(line: number): void {
    if (
      (this.dmacon & (DMA_MASTER | DMA_BITPLANE)) !== (DMA_MASTER | DMA_BITPLANE) ||
      line < this.diwVStart ||
      line >= this.diwVStop
    ) {
      this.bltLineBplStartH = 0;
      this.bltLineBplEndH = 0;
      this.bltLineBplSlots = 0;
      return;
    }
    const isAga = this.chipset === 'AGA';
    const bpuRaw = ((this.bplCon0 >>> 12) & 7) | (isAga && (this.bplCon0 & 0x0010) !== 0 ? 8 : 0);
    const bpu = bpuRaw > 8 ? 8 : bpuRaw;
    if (bpu === 0) {
      this.bltLineBplStartH = 0;
      this.bltLineBplEndH = 0;
      this.bltLineBplSlots = 0;
      return;
    }
    const hires = (this.bplCon0 & 0x8000) !== 0;
    const shres = isAga && (this.bplCon0 & 0x0040) !== 0;
    const bplFmode = isAga ? (this.fmode & 3) : 0;
    const fShift = bplFmode === 3 ? 2 : bplFmode !== 0 ? 1 : 0;
    const effDdfStop = this.ddfStop > 0x00d8 ? 0x00d8 : this.ddfStop;
    if (effDdfStop < this.ddfStrt) {
      this.bltLineBplStartH = 0;
      this.bltLineBplEndH = 0;
      this.bltLineBplSlots = 0;
      return;
    }
    const ddfSpan = effDdfStop - this.ddfStrt;
    let numBytes: number;
    let unitCcks: number;
    let fetchUnits: number;
    if (bplFmode === 0) {
      unitCcks = 8;
      fetchUnits = ((ddfSpan + 7) >>> 3) + 1;
      const maxU = 28;
      if (fetchUnits > maxU) fetchUnits = maxU;
      const wordsPerLine = shres
        ? Math.min(104, fetchUnits << 2)
        : hires
          ? Math.min(52, fetchUnits << 1)
          : Math.min(28, fetchUnits);
      numBytes = wordsPerLine << 1;
    } else if (bplFmode === 3) {
      unitCcks = shres ? 8 : hires ? 16 : 32;
      fetchUnits = shres
        ? ((ddfSpan + 7) >>> 3) + 1
        : hires
          ? ((ddfSpan + 15) >>> 4) + 1
          : ((ddfSpan + 31) >>> 5) + 1;
      const maxBytes = shres ? 224 : hires ? 112 : 56;
      const b = fetchUnits << 3;
      numBytes = b > maxBytes ? maxBytes : b;
      fetchUnits = numBytes >>> 3;
    } else {
      unitCcks = shres ? 8 : hires ? 8 : 16;
      fetchUnits = shres
        ? ((ddfSpan + 7) >>> 3) + 1
        : hires
          ? ((ddfSpan + 7) >>> 3) + 1
          : ((ddfSpan + 15) >>> 4) + 1;
      const maxBytes = shres ? 224 : hires ? 112 : 56;
      const b = shres ? (fetchUnits << 3) : (fetchUnits << 2);
      numBytes = b > maxBytes ? maxBytes : b;
      fetchUnits = shres ? (numBytes >>> 3) : (numBytes >>> 2);
    }
    let slots = (numBytes >>> (1 + fShift)) * bpu;
    if (slots > 220) slots = 220;
    this.bltLineBplStartH = this.ddfStrt;
    const endH = this.ddfStrt + fetchUnits * unitCcks;
    this.bltLineBplEndH = endH > 0xe2 ? 0xe2 : endH;
    this.bltLineBplSlots = slots;
  }

  private stepBlitterToHpos(targetHpos: number): void {
    if (!this.bltActive) return;
    const deltaH = targetHpos - this.bltLastSyncHpos;
    if (deltaH <= 0) return;
    const prevH = this.bltLastSyncHpos;
    this.bltLastSyncHpos = targetHpos;
    if ((this.dmacon & (DMA_MASTER | DMA_BLITTER)) !== (DMA_MASTER | DMA_BLITTER)) return;

    let freeCcks = deltaH;
    if (this.bltLineBplSlots > 0 && this.bltLineBplEndH > this.bltLineBplStartH) {
      const o0 = prevH > this.bltLineBplStartH ? prevH : this.bltLineBplStartH;
      const o1 = targetHpos < this.bltLineBplEndH ? targetHpos : this.bltLineBplEndH;
      if (o1 > o0) {
        const span = this.bltLineBplEndH - this.bltLineBplStartH;
        let bplUsed = Math.floor(((o1 - o0) * this.bltLineBplSlots) / span);
        if (bplUsed > o1 - o0) bplUsed = o1 - o0;
        freeCcks -= bplUsed;
      }
    }
    let sysCcks = 10;
    if (this.dskDmaActive) sysCcks += 3;
    if ((this.dmacon & (DMA_MASTER | DMA_SPRITE)) === (DMA_MASTER | DMA_SPRITE)) sysCcks += 8;
    freeCcks -= ((deltaH * sysCcks) / 227) | 0;
    if ((this.dmacon & 0x0400) === 0 && freeCcks > 1) {
      // BLTPRI=0 yields a small share of free Chip bus slots to CPU
      freeCcks = ((freeCcks * 4) / 5) | 0;
    }
    if (freeCcks <= 0) return;

    this.bltCckAccum += freeCcks;
    this.advanceBlitterCcks();
  }

  private advanceBlitterCcks(): void {
    if (!this.bltActive) return;
    if (this.bltIsLine) {
      const pixels = (this.bltCckAccum / 4) | 0;
      if (pixels <= 0) return;
      const runPx = pixels < this.bltLinePixelsLeft ? pixels : this.bltLinePixelsLeft;
      this.bltCckAccum -= runPx * 4;
      this.stepBlitterLinePixels(runPx);
      if (this.bltLinePixelsLeft <= 0) {
        this.bltApt = this.bltLineAptErr & 0xffff;
        this.bltDpt = this.bltCpt;
        this.bltCon0 = (this.bltCon0 & 0x0fff) | (this.bltLineAsh << 12);
        this.bltCon1 = (this.bltCon1 & 0x0fbf) | (this.bltLineBsh << 12) | (this.bltLineSign ? 0x0040 : 0);
        this.bltZero = this.bltAccumZero;
        this.bltActive = false;
        this.bltPending = false;
        this.bltCckAccum = 0;
        this.requestIrq(INT_BLIT);
      }
      return;
    }

    const perWord = this.bltPerWordCck;
    let wordsBudget = (this.bltCckAccum / perWord) | 0;
    if (wordsBudget <= 0) return;

    const mask = this.chipMask;
    const step = this.bltStep;
    let wordsDone = 0;

    if (this.bltFastMode === 1) {
      let dpt = this.bltDpt;
      const dmod = this.bltDmodS;
      while (wordsBudget > 0 && this.bltRowsLeft > 0) {
        const take = wordsBudget < this.bltWordsLeftInRow ? wordsBudget : this.bltWordsLeftInRow;
        for (let i = 0; i < take; i++) {
          this.writeChip16(dpt, 0);
          dpt = (dpt + step) & mask;
        }
        wordsDone += take;
        wordsBudget -= take;
        this.bltWordsLeftInRow -= take;
        if (this.bltWordsLeftInRow === 0) {
          dpt = (dpt + dmod) & mask;
          this.bltRowsLeft--;
          this.bltWordsLeftInRow = this.bltWidthWords;
        }
      }
      this.bltDpt = dpt;
    } else if (this.bltFastMode === 2) {
      let apt = this.bltApt;
      let dpt = this.bltDpt;
      const amod = this.bltAmodS;
      const dmod = this.bltDmodS;
      let allZero = this.bltAccumZero;
      while (wordsBudget > 0 && this.bltRowsLeft > 0) {
        const take = wordsBudget < this.bltWordsLeftInRow ? wordsBudget : this.bltWordsLeftInRow;
        for (let i = 0; i < take; i++) {
          const w = this.readChip16(apt);
          if (w !== 0) allZero = false;
          this.writeChip16(dpt, w);
          apt = (apt + step) & mask;
          dpt = (dpt + step) & mask;
        }
        wordsDone += take;
        wordsBudget -= take;
        this.bltWordsLeftInRow -= take;
        if (this.bltWordsLeftInRow === 0) {
          apt = (apt + amod) & mask;
          dpt = (dpt + dmod) & mask;
          this.bltRowsLeft--;
          this.bltWordsLeftInRow = this.bltWidthWords;
        }
      }
      this.bltApt = apt;
      this.bltDpt = dpt;
      this.bltAccumZero = allZero;
    } else {
      const useA = (this.bltUseMask & 8) !== 0;
      const useB = (this.bltUseMask & 4) !== 0;
      const useC = (this.bltUseMask & 2) !== 0;
      const useD = (this.bltUseMask & 1) !== 0;
      const lf = this.bltLf;
      const ash = this.bltAsh;
      const bsh = this.bltBsh;
      const desc = this.bltDesc;
      const fillMode = this.bltFillMode;
      const incFill = this.bltIncFill;
      const afwm = this.bltAfwm;
      const alwm = this.bltAlwm;
      const amod = this.bltAmodS;
      const bmod = this.bltBmodS;
      const cmod = this.bltCmodS;
      const dmod = this.bltDmodS;
      let apt = this.bltApt;
      let bpt = this.bltBpt;
      let cpt = this.bltCpt;
      let dpt = this.bltDpt;
      let aOld = this.bltAOld;
      let bOld = this.bltBOld;
      let fillCarry = this.bltFillCarry;
      let allZero = this.bltAccumZero;

      while (wordsBudget > 0 && this.bltRowsLeft > 0) {
        const take = wordsBudget < this.bltWordsLeftInRow ? wordsBudget : this.bltWordsLeftInRow;
        for (let i = 0; i < take; i++) {
          const isFirst = this.bltWordsLeftInRow === this.bltWidthWords;
          const isLast = this.bltWordsLeftInRow === 1;
          let aRaw = this.bltAdat;
          if (useA) {
            aRaw = this.readChip16(apt);
            apt = (apt + step) & mask;
          }
          if (isFirst) aRaw &= afwm;
          if (isLast) aRaw &= alwm;

          let aVal: number;
          if (ash === 0) {
            aVal = aRaw;
          } else if (desc) {
            aVal = ((aRaw << ash) | (aOld >>> (16 - ash))) & 0xffff;
          } else {
            aVal = ((aRaw >>> ash) | (aOld << (16 - ash))) & 0xffff;
          }
          aOld = aRaw;

          let bVal: number;
          if (useB) {
            const bRaw = this.readChip16(bpt);
            bpt = (bpt + step) & mask;
            if (bsh === 0) {
              bVal = bRaw;
            } else if (desc) {
              bVal = ((bRaw << bsh) | (bOld >>> (16 - bsh))) & 0xffff;
            } else {
              bVal = ((bRaw >>> bsh) | (bOld << (16 - bsh))) & 0xffff;
            }
            bOld = bRaw;
            this.bltBhold = bVal;
          } else {
            bVal = this.bltBhold;
          }

          let cVal = this.bltCdat;
          if (useC) {
            cVal = this.readChip16(cpt);
            cpt = (cpt + step) & mask;
          }

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
            dpt = (dpt + step) & mask;
          }
          this.bltWordsLeftInRow--;
        }
        wordsDone += take;
        wordsBudget -= take;
        if (this.bltWordsLeftInRow === 0) {
          if (useA) apt = (apt + amod) & mask;
          if (useB) bpt = (bpt + bmod) & mask;
          if (useC) cpt = (cpt + cmod) & mask;
          if (useD) dpt = (dpt + dmod) & mask;
          this.bltRowsLeft--;
          this.bltWordsLeftInRow = this.bltWidthWords;
          fillCarry = (this.bltCon1 & 0x0004) !== 0 ? 1 : 0;
        }
      }
      this.bltApt = apt;
      this.bltBpt = bpt;
      this.bltCpt = cpt;
      this.bltDpt = dpt;
      this.bltAOld = aOld;
      this.bltBOld = bOld;
      this.bltFillCarry = fillCarry;
      this.bltAccumZero = allZero;
    }

    this.bltCckAccum -= wordsDone * perWord;
    if (this.bltRowsLeft <= 0) {
      this.bltZero = this.bltAccumZero;
      this.bltActive = false;
      this.bltPending = false;
      this.bltCckAccum = 0;
      this.requestIrq(INT_BLIT);
    }
  }

  private stepBlitterLinePixels(count: number): void {
    const lf = this.bltLf;
    const amod = this.bltAmod;
    const bmod = this.bltBmod;
    const cmod = this.bltCmod;
    const aMask = this.bltAdat & this.bltAfwm;
    const bTex = this.bltBdat;
    const mask = this.chipMask;
    const useA = this.bltLineUseA;
    const useB = this.bltLineUseB;
    const useC = this.bltLineUseC;
    const sud = this.bltLineSud;
    const sul = this.bltLineSul;
    const aul = this.bltLineAul;
    const oneDot = this.bltLineOneDot;

    let ash = this.bltLineAsh;
    let bsh = this.bltLineBsh;
    let sign = this.bltLineSign;
    let apt = this.bltLineAptErr;
    let bpt = this.bltBpt;
    let blineb = this.bltLineBlineB;
    let bOld = this.bltBOld;
    let bDatCur = bTex;
    let cpt = this.bltCpt;
    let dpt = this.bltDpt;
    let allZero = this.bltAccumZero;
    let singleDotPlotted = this.bltLineSingleDot;
    let firstPixel = this.bltLineFirstPixel;

    for (let i = 0; i < count; i++) {
      const cVal = useC ? this.readChip16(cpt) : this.bltCdat;
      if (useB) {
        const bRaw = this.readChip16(bpt);
        bpt = (bpt + bmod) & mask;
        blineb = (((bOld << 16) | bRaw) >>> bsh) & 0xffff;
        bOld = bRaw;
        bDatCur = bRaw;
      }
      const aVal = (aMask >>> ash) & 0xffff;
      const bVal = (blineb & 1) !== 0 ? 0xffff : 0x0000;

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
      const drawPixel = !oneDot || !singleDotPlotted;
      if (oneDot) singleDotPlotted = true;
      if (useC && drawPixel) {
        this.writeChip16(firstPixel ? dpt : cpt, dVal);
      }

      if (useA) {
        if (!sign) {
          apt = (apt + amod) | 0;
        } else {
          apt = (apt + bmod) | 0;
        }
      }

      let stepX = 0;
      let stepY = 0;
      if (sud) {
        stepX = aul ? -1 : 1;
        if (!sign) stepY = sul ? -1 : 1;
      } else {
        stepY = aul ? -1 : 1;
        if (!sign) stepX = sul ? -1 : 1;
      }

      if (stepX > 0) {
        ash++;
        if (ash >= 16) {
          ash = 0;
          cpt = (cpt + 2) & mask;
        }
      } else if (stepX < 0) {
        ash--;
        if (ash < 0) {
          ash = 15;
          cpt = (cpt - 2) & mask;
        }
      }

      if (stepY > 0) {
        if (useC) {
          cpt = (cpt + cmod) & mask;
          singleDotPlotted = false;
        }
      } else if (stepY < 0) {
        if (useC) {
          cpt = (cpt - cmod) & mask;
          singleDotPlotted = false;
        }
      }

      if (useA) {
        sign = ((apt << 16) >> 16) < 0;
      }

      bsh = (bsh - 1) & 0xf;
      if (!useB) {
        blineb = ((bTex >>> bsh) | (bTex << (16 - bsh))) & 0xffff;
      }

      if (firstPixel) {
        dpt = cpt;
        firstPixel = false;
      }
    }

    this.bltLineAsh = ash;
    this.bltLineBsh = bsh;
    this.bltLineSign = sign;
    this.bltLineAptErr = apt;
    this.bltBpt = bpt;
    this.bltBOld = bOld;
    this.bltBdat = bDatCur;
    this.bltLineBlineB = blineb;
    this.bltCpt = cpt;
    this.bltDpt = dpt;
    this.bltAccumZero = allZero;
    this.bltLineSingleDot = singleDotPlotted;
    this.bltLineFirstPixel = firstPixel;
    this.bltLinePixelsLeft -= count;
  }

  private finishBlitterImmediate(): void {
    while (this.bltActive) {
      this.bltCckAccum = 0x100000;
      this.advanceBlitterCcks();
    }
  }

  /**
   * OCS/ECS Blitter Line-Draw Mode (BLTCON1 bit 0 = 1).
   * Matches PUAE blitter.c: USEA error update, USEB texture, USEC read/write/Y-step, BLTSING, BLTSIGN.
   */
  private runBlitterLine(lengthPixels: number, incremental: boolean): void {
    const con0 = this.bltCon0;
    const con1 = this.bltCon1;
    this.bltIsLine = true;
    this.bltLf = con0 & 0xff;
    this.bltLineUseA = (con0 & 0x0800) !== 0;
    this.bltLineUseB = (con0 & 0x0400) !== 0;
    this.bltLineUseC = (con0 & 0x0200) !== 0;
    this.bltLineUseD = (con0 & 0x0100) !== 0;
    this.bltLineAsh = (con0 >>> 12) & 0xf;
    const bsh = (con1 >>> 12) & 0xf;
    this.bltLineBsh = bsh;
    this.bltBOld = 0;
    this.bltLineBlineB = (((this.bltBdat >>> bsh) | (this.bltBdat << (16 - bsh))) & 0xffff);
    this.bltLineSign = (con1 & 0x0040) !== 0;
    this.bltLineSud = (con1 & 0x0010) !== 0;
    this.bltLineSul = (con1 & 0x0008) !== 0;
    this.bltLineAul = (con1 & 0x0004) !== 0;
    this.bltLineOneDot = (con1 & 0x0002) !== 0;
    this.bltLineAptErr = (this.bltApt << 16) >> 16;
    this.bltCpt = this.bltCpt & this.chipMask;
    this.bltDpt = this.bltDpt & this.chipMask;
    this.bltAccumZero = true;
    this.bltLineSingleDot = false;
    this.bltLineFirstPixel = true;
    this.bltLinePixelsLeft = lengthPixels;

    if (incremental) {
      this.bltActive = true;
      this.bltPending = true;
      this.bltCckAccum = 0;
      this.bltLastSyncHpos = this.inCopperVisibleSpan
        ? (this.copHpos > 227 ? 227 : this.copHpos)
        : this.getHpos();
      this.initScanlineBlitterWindow(this.vpos);
      return;
    }

    this.stepBlitterLinePixels(lengthPixels);
    this.bltApt = this.bltLineAptErr & 0xffff;
    this.bltDpt = this.bltCpt;
    this.bltCon0 = (con0 & 0x0fff) | (this.bltLineAsh << 12);
    this.bltCon1 = (con1 & 0x0fbf) | (this.bltLineBsh << 12) | (this.bltLineSign ? 0x0040 : 0);
    this.bltZero = this.bltAccumZero;
    this.scheduleBlitDone(lengthPixels * 4);
  }

  /**
   * High-speed OCS/ECS/AGA Blitter (supports Line-Draw Mode, all 256 minterms, A/B barrel shifts,
   * first/last word masks, descending mode, area fill, and incremental DMA pacing during scanlines).
   */
  public runBlitter(widthWords: number, heightLines: number): void {
    if (this.bltActive) {
      this.finishBlitterImmediate();
    } else {
      this.syncBlitter();
    }
    this.bltPending = false;
    const incremental = this.scanlineCycleBudget > 0;
    const con0 = this.bltCon0;
    const con1 = this.bltCon1;
    if ((con1 & 0x0001) !== 0) {
      this.runBlitterLine(heightLines, incremental);
      return;
    }

    const useMask = (con0 >>> 8) & 0x0f;
    const useA = (useMask & 8) !== 0;
    const useB = (useMask & 4) !== 0;
    const useC = (useMask & 2) !== 0;
    const useD = (useMask & 1) !== 0;
    const lf = con0 & 0xff;
    const ash = (con0 >>> 12) & 0xf;
    const bsh = (con1 >>> 12) & 0xf;
    const desc = (con1 & 0x0002) !== 0;
    const fillMode = (con1 & 0x0018) !== 0;
    const step = desc ? -2 : 2;
    const modSign = desc ? -1 : 1;
    const amod = this.bltAmod * modSign;
    const bmod = this.bltBmod * modSign;
    const cmod = this.bltCmod * modSign;
    const dmod = this.bltDmod * modSign;
    let perWord = BLIT_CCK_TABLE[useMask];
    if (fillMode && useD && !useC) perWord++;

    if (incremental) {
      this.bltIsLine = false;
      this.bltUseMask = useMask;
      this.bltLf = lf;
      this.bltAsh = ash;
      this.bltBsh = bsh;
      this.bltDesc = desc;
      this.bltFillMode = fillMode;
      this.bltIncFill = (con1 & 0x0008) !== 0;
      this.bltStep = step;
      this.bltAmodS = amod;
      this.bltBmodS = bmod;
      this.bltCmodS = cmod;
      this.bltDmodS = dmod;
      this.bltWidthWords = widthWords;
      this.bltRowsLeft = heightLines;
      this.bltWordsLeftInRow = widthWords;
      this.bltAOld = 0;
      this.bltBOld = 0;
      this.bltFillCarry = (con1 & 0x0004) !== 0 ? 1 : 0;
      this.bltAccumZero = true;
      this.bltPerWordCck = perWord;
      this.bltFastMode =
        lf === 0x00 && useD && !useA && !useB && !useC && !fillMode
          ? 1
          : lf === 0xf0 && useA && useD && !useB && !useC && ash === 0 && !fillMode && this.bltAfwm === 0xffff && this.bltAlwm === 0xffff
            ? 2
            : 0;
      this.bltActive = true;
      this.bltPending = true;
      this.bltCckAccum = 0;
      this.bltLastSyncHpos = this.inCopperVisibleSpan
        ? (this.copHpos > 227 ? 227 : this.copHpos)
        : this.getHpos();
      this.initScanlineBlitterWindow(this.vpos);
      return;
    }

    let apt = this.bltApt;
    let bpt = this.bltBpt;
    let cpt = this.bltCpt;
    let dpt = this.bltDpt;
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
      this.scheduleBlitDone(widthWords * heightLines * perWord);
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
      this.scheduleBlitDone(widthWords * heightLines * perWord);
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

        let bVal: number;
        if (useB) {
          const bRaw = this.readChip16(bpt);
          bpt = (bpt + step) & this.chipMask;
          if (bsh === 0) {
            bVal = bRaw;
          } else if (desc) {
            bVal = (((bRaw << bsh) | (bOld >>> (16 - bsh))) & 0xffff);
          } else {
            bVal = (((bRaw >>> bsh) | (bOld << (16 - bsh))) & 0xffff);
          }
          bOld = bRaw;
          this.bltBhold = bVal;
        } else {
          bVal = this.bltBhold;
        }

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
    this.scheduleBlitDone(widthWords * heightLines * perWord);
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
    this.vdiwActive = false;
    this.vdiwStateLine = -1;
    this.lineSplitCount = 0;
    this.lineStartCaptured = false;
    this.bplDatWrittenOnLine = false;
    this.copPc = this.cop1lc;
    this.copWaiting = false;
    this.copSkipNext = false;
    this.copWaitBlit = false;
    this.copDeferredLine = -1;
    this.copHpos = 0;
    this.sprHeadersFetchedThisFrame = false;
    this.sprSteppedLine = -1;
    this.sprBeamHalfH = 0;
    this.sprMuxCount = 0;
    this.sprDmaOn.fill(0);
    this.sprDmaStreaming.fill(0);
    this.sprDmaLineActive.fill(0);
    this.frameDiwActive = false;
    this.frameDiwMinV = 0x3ff;
    this.frameDiwMaxV = 0;
    this.frameDiwMinH = 0x3ff;
    this.frameDiwMaxH = 0;

    // Capture frame-start audio state for exact scanline-synced mixing (zero allocations)
    this.audioSteppedInFrame = false;
    this.frameAudClocks = 0;
    this.audEvtCount = 0;
    let sawActive = false;
    for (let i = 0; i < 4; i++) {
      const ch = this.audio[i];
      const running = ch.active && (this.audStartPendingMask & (1 << i)) === 0;
      this.audSnapActive[i] = running ? 1 : 0;
      if (running) {
        this.audSnapCurAddr[i] = ch.curAddr;
        this.audSnapWordsLeft[i] = ch.wordsLeft;
        this.audSnapLc[i] = ch.lc;
        this.audSnapLen[i] = ch.len;
        this.audSnapPer[i] = ch.per < 124 ? 124 : ch.per;
        this.audSnapVol[i] = ch.vol;
        this.audSnapClockRem[i] = this.audClockRem[i];
        if (ch.vol > 0) sawActive = true;
      }
    }
    this.audSawActivityInFrame = sawActive;
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

    if (
      !this.hadVideoDmaSinceCopWrite &&
      (this.dmacon & (DMA_MASTER | DMA_COPPER | DMA_BITPLANE)) === 0 &&
      this.lastCop1lcWritePc > 0 &&
      this.lastCop1lcWritePc < 0xf80000 &&
      this.cop1lc >= 0x200 &&
      this.cop1lc !== this.rescuedMissingDmaCop1lc &&
      src !== null &&
      (src.pc >>> 0) < 0xf80000 &&
      ((this.dmacon & 0x000f) !== 0 || (this.intena & INT_INTEN) !== 0)
    ) {
      const frames = ++this.missingVideoDmaFrames;
      const threshold = (this.dmacon & 0x000f) !== 0 ? 15 : 60;
      if (frames >= threshold) {
        if (this.hasValidDisplayCopperList(this.cop1lc)) {
          this.rescuedMissingDmaCop1lc = this.cop1lc;
          this.writeReg16(0x096, 0x83e0);
        } else {
          this.missingVideoDmaFrames = 0;
        }
      }
    } else {
      this.missingVideoDmaFrames = 0;
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

  private hasValidDisplayCopperList(addr: number): boolean {
    if ((addr & 1) !== 0 || addr < 0x200 || addr >= this.chipMask - 8) return false;
    let p = addr;
    let displayMoves = 0;
    for (let i = 0; i < 48; i++) {
      const ir1 = this.readChip16(p);
      const ir2 = this.readChip16(p + 2);
      p = (p + 4) & this.chipMask;
      if (ir1 === 0xffff && ir2 === 0xfffe) {
        return i > 0 && displayMoves >= 3;
      }
      if ((ir1 & 1) === 0) {
        const reg = ir1 & 0x01fe;
        if (reg < 0x040) return false;
        if (
          (reg >= 0x08e && reg <= 0x10c) ||
          (reg >= 0x120 && reg <= 0x13e) ||
          (reg >= 0x180 && reg <= 0x1be) ||
          reg === 0x1fc
        ) {
          displayMoves++;
        }
      }
    }
    return displayMoves >= 3;
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
   * Returns next horizontal color clock (0..0xE1) where Copper is ready to wake on `line`,
   * or `-1` if Copper DMA is disabled or waiting past the visible span.
   */
  public getNextCopperWakeHpos(line: number): number {
    if ((this.dmacon & (DMA_MASTER | DMA_COPPER)) !== (DMA_MASTER | DMA_COPPER)) {
      return -1;
    }
    if (this.copDeferredLine === line) {
      return -1;
    }
    if (!this.copWaiting) {
      return this.copHpos <= 0xe1 ? this.copHpos : -1;
    }
    if (this.copWaitV === 0xff && this.copWaitH === 0xfe) {
      return -1;
    }
    const vp = line & 0xff;
    const maskedVp = vp & this.copMaskV;
    const targetVp = this.copWaitV & this.copMaskV;
    if (maskedVp < targetVp) {
      return -1;
    }
    const waitHMasked = this.copWaitH & this.copMaskH;
    if (maskedVp === targetVp && waitHMasked > 0xe1) {
      return -1;
    }
    const isNextMove = (this.readChip16(this.copPc) & 1) === 0;
    if (
      this.copWaitV === 0xff &&
      line === 255 &&
      (this.copWaitH >= 0xde || (this.copWaitH >= 0xd0 && !isNextMove))
    ) {
      return -1;
    }
    const wakeH = maskedVp === targetVp && waitHMasked > this.copHpos ? waitHMasked : this.copHpos;
    if (wakeH > 0xe1) return -1;
    if (this.copWaitBlit && this.bltPending) {
      if (this.bltActive) {
        return wakeH + 8 <= 0xe1 ? wakeH + 8 : 0xe1;
      }
      if (this.cycleSource !== null && this.cycleSource.cycles < this.bltDoneCycle) {
        return wakeH + 8 <= 0xe1 ? wakeH + 8 : 0xe1;
      }
    }
    return wakeH;
  }

  /**
   * Completes Copper execution at end of scanline (`H=0xE2`, including PAL line-255 wrap)
   * and closes `lineDisplayPhase` for chronological `stepFrame` execution.
   */
  public finishScanlineCopper(line: number): void {
    this.lineDisplayPhase = false;
    if ((this.dmacon & (DMA_MASTER | DMA_COPPER)) !== (DMA_MASTER | DMA_COPPER)) {
      this.copHpos = 0;
      return;
    }
    this.runCopperInternal(line, 0xe2, true, true);
  }

  /**
   * Runs Copper instructions eligible for the current scanline `line` up to horizontal clock `maxHpos`.
   * Calling with `maxHpos = 0xae`/`0xe1` before `renderScanline` preserves Phase-1 H>=$D0 deferral for
   * standalone calls; `stepFrame` uses chronological `syncToHpos` + `finishScanlineCopper`.
   */
  public runCopperLine(line: number, maxHpos = 0xfe): void {
    this.runCopperInternal(line, maxHpos, maxHpos >= 0xfe, false);
    if (maxHpos >= 0xfe) {
      this.lineDisplayPhase = false;
    }
  }

  private runCopperInternal(
    line: number,
    maxHpos: number,
    allowPalWrap: boolean,
    chronological: boolean
  ): void {
    if ((this.dmacon & (DMA_MASTER | DMA_COPPER)) !== (DMA_MASTER | DMA_COPPER)) {
      if (!chronological) {
        if (maxHpos >= 0xfe) this.copHpos = 0;
        else {
          this.midlineColorCount = 0;
          this.midlineBplamCount = 0;
        }
      } else if (allowPalWrap) {
        this.copHpos = 0;
      }
      return;
    }
    const visiblePass = !allowPalWrap && maxHpos < 0xfe;
    const endOfLine = allowPalWrap || (!chronological && maxHpos >= 0xfe);
    const effMaxHpos = endOfLine ? 0xe2 : maxHpos;
    if (visiblePass) {
      if (this.copLineCleared !== line) {
        this.midlineColorCount = 0;
        this.midlinePaletteSaved = false;
        this.midlineBplamCount = 0;
        this.lineStartBplam = this.chipset === 'AGA' ? ((this.bplCon4 >>> 8) & 0xff) : 0;
        this.copLineCleared = line;
      }
      this.inCopperVisibleSpan = true;
    } else if (chronological) {
      this.inCopperVisibleSpan = !allowPalWrap;
    }

    // Zero-allocation Bitplane DMA even-slot Copper contention parameters for `line`
    let bplStartH = 0x200;
    let bplEndH = 0;
    let bplUnitMask = 7;
    let bplBurstCCK = 8;
    let bplBurstMask = 0x0f;
    const refreshBplContention = (): void => {
      bplBurstMask = 0x0f;
      const vActive =
        this.vdiwStateLine === line
          ? this.vdiwActive
          : (line >= this.diwVStart && line < this.diwVStop);
      if (
        (this.dmacon & (DMA_MASTER | DMA_BITPLANE)) !== (DMA_MASTER | DMA_BITPLANE) ||
        !vActive
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
        const unitSize = bplFmode === 0 ? 2 : 8;
        bplUnitMask = unitSize - 1;
        bplBurstCCK = unitSize < 8 ? unitSize : 8;
        const nUnits =
          bplFmode !== 0
            ? ((ddfSpan + 7) >>> 3) + 1
            : ((ddfSpan + 1) >>> 1) + 1;
        const maxU = bplFmode === 0 ? 104 : 28;
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
        bplBurstMask = bpu === 5 ? 0x07 : bpu === 6 ? 0x05 : bpu === 7 ? 0x01 : 0x00;
      }
    };
    refreshBplContention();

    const vp = line & 0xff;
    let guard = 0;

    while (guard++ < 512) {
      if (this.copWaiting) {
        if (this.copWaitV === 0xff && this.copWaitH === 0xfe) {
          if (endOfLine) this.copHpos = 0;
          this.inCopperVisibleSpan = false;
          return;
        }
        const maskedVp = vp & this.copMaskV;
        const targetVp = this.copWaitV & this.copMaskV;
        if (maskedVp < targetVp) {
          if (endOfLine) this.copHpos = 0;
          this.inCopperVisibleSpan = false;
          return;
        }
        const waitHMasked = this.copWaitH & this.copMaskH;
        if (maskedVp === targetVp && waitHMasked > effMaxHpos) {
          this.inCopperVisibleSpan = false;
          return;
        }
        if (this.copWaitBlit) {
          if (chronological) {
            if (this.bltActive) {
              const lim = maxHpos > 227 ? 227 : maxHpos;
              if (lim > this.bltLastSyncHpos) this.stepBlitterToHpos(lim);
            } else if (this.cycleSource === null || this.cycleSource.cycles >= this.bltDoneCycle) {
              this.bltPending = false;
              this.requestIrq(INT_BLIT);
            }
          } else {
            this.syncBlitter();
          }
          if (this.bltPending) {
            if (endOfLine) this.copHpos = 0;
            this.inCopperVisibleSpan = false;
            return;
          }
          this.copWaitBlit = false;
        }
        const isNextMove = (this.readChip16(this.copPc) & 1) === 0;
        const wasPalWrap =
          this.copWaitV === 0xff &&
          line === 255 &&
          (this.copWaitH >= 0xde || (this.copWaitH >= 0xd0 && !isNextMove));
        if (wasPalWrap && !allowPalWrap) {
          this.inCopperVisibleSpan = false;
          return;
        }
        this.copWaiting = false;
        if (maskedVp === targetVp && waitHMasked > this.copHpos) {
          this.copHpos = waitHMasked;
        }
        if (wasPalWrap) {
          if (!this.isPalTiming()) this.ntscSawPalCopperWrap = true;
          this.consumeDuplicatePalWrapWaits();
          if (endOfLine) this.copHpos = 0;
          this.inCopperVisibleSpan = false;
          return;
        }
      }

      if (endOfLine ? this.copHpos >= 0xe2 : this.copHpos > effMaxHpos) {
        if (endOfLine) this.copHpos -= 0xe2;
        this.inCopperVisibleSpan = false;
        return;
      }

      const ir1 = this.readChip16(this.copPc);
      const ir2 = this.readChip16(this.copPc + 2);
      this.copPc = (this.copPc + 4) & this.chipMask;

      if ((ir1 & 1) === 0) {
        const reg = ir1 & 0x01fe;
        const minReg = (this.copCon & 2) !== 0 ? (this.chipset !== 'OCS' ? 0x000 : 0x040) : 0x080;
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
          this.copDeferredLine = line;
          this.inCopperVisibleSpan = false;
          return;
        }
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
          this.copWaitV = 0xff;
          this.copWaitH = 0xfe;
          this.copWaiting = true;
          if (endOfLine) this.copHpos = 0;
          this.inCopperVisibleSpan = false;
          return;
        }
        this.writeReg16(reg, ir2);
        if (reg === 0x100 || reg === 0x1fc || reg === 0x092 || reg === 0x094 || reg === 0x096 || reg === 0x08e || reg === 0x090 || reg === 0x1e4) {
          refreshBplContention();
        }
      } else {
        const waitV = (ir1 >>> 8) & 0xff;
        const waitH = ir1 & 0xfe;
        const maskV = ((ir2 >>> 8) & 0x7f) | 0x80;
        const maskH = ir2 & 0xfe;

        if ((ir2 & 1) === 0) {
          this.copSkipNext = false;
          if (waitV === 0xff && waitH === 0xfe) {
            this.copWaitV = 0xff;
            this.copWaitH = 0xfe;
            this.copWaitBlit = false;
            this.copWaiting = true;
            if (endOfLine) this.copHpos = 0;
            this.inCopperVisibleSpan = false;
            return;
          }
          const waitForBlit = (ir2 & 0x8000) === 0;
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
            this.copWaitBlit = waitForBlit;
            this.copWaiting = true;
            if (endOfLine) this.copHpos = 0;
            this.inCopperVisibleSpan = false;
            return;
          }
          if (waitForBlit) {
            if (chronological) {
              if (this.bltActive) {
                const lim = maxHpos > 227 ? 227 : maxHpos;
                if (lim > this.bltLastSyncHpos) this.stepBlitterToHpos(lim);
              } else if (this.cycleSource === null || this.cycleSource.cycles >= this.bltDoneCycle) {
                this.bltPending = false;
                this.requestIrq(INT_BLIT);
              }
            } else {
              this.syncBlitter();
            }
            if (this.bltPending) {
              this.copWaitV = waitV;
              this.copWaitH = waitH;
              this.copMaskV = maskV;
              this.copMaskH = maskH;
              this.copWaitBlit = true;
              this.copWaiting = true;
              if (endOfLine) this.copHpos = 0;
              this.inCopperVisibleSpan = false;
              return;
            }
          }
          const isNextMove = (this.readChip16(this.copPc) & 1) === 0;
          const isPalWrapWait =
            waitV === 0xff &&
            line === 255 &&
            (waitH >= 0xde || (waitH >= 0xd0 && !isNextMove));
          if (isPalWrapWait && !allowPalWrap) {
            this.copWaitV = waitV;
            this.copWaitH = waitH;
            this.copMaskV = maskV;
            this.copMaskH = maskH;
            this.copWaitBlit = false;
            this.copWaiting = true;
            this.inCopperVisibleSpan = false;
            return;
          }
          if (maskedVp === targetVp && waitHMasked > this.copHpos) {
            this.copHpos = waitHMasked;
          }
          if (isPalWrapWait) {
            if (!this.isPalTiming()) this.ntscSawPalCopperWrap = true;
            this.consumeDuplicatePalWrapWaits();
            if (endOfLine) this.copHpos = 0;
            this.inCopperVisibleSpan = false;
            return;
          }
        } else {
          if (this.copSkipNext) {
            this.copSkipNext = false;
            this.copHpos += 4;
            continue;
          }
          const maskedVp = vp & maskV;
          const targetVp = waitV & maskV;
          let blitBusy = false;
          if ((ir2 & 0x8000) === 0) {
            if (!chronological) this.syncBlitter();
            blitBusy = this.bltPending;
          }
          const skip =
            !blitBusy &&
            (maskedVp > targetVp ||
              (maskedVp === targetVp && (this.copHpos & maskH) >= (waitH & maskH)));
          this.copSkipNext = skip;
          this.copHpos += 4;
        }
      }
    }
    this.inCopperVisibleSpan = false;
    if (endOfLine) {
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
    const bypass = isAga && (this.bplCon0 & 0x0020) !== 0;
    const ham8 = isAga && homod && bpu === 8 && !bypass;
    const ham6 = homod && (isAga ? bpu === 6 : ((bpu === 5 || bpu === 6) && !hires && !shres)) && !bypass;
    const ham = ham8 || ham6;
    const dpf = (this.bplCon0 & 0x0400) !== 0;
    const killEhb = this.chipset !== 'OCS' && (this.bplCon2 & 0x0200) !== 0;
    const ehb = !ham && !dpf && bpu === 6 && !killEhb && !bypass;
    const bypassMask = bypass
      ? (homod && bpu === 8 ? 0xfc : homod && bpu === 6 ? 0x0f : (!dpf && bpu === 6 && !killEhb ? 0x1f : 0xff))
      : (!isAga && !ham && !dpf && bpu === 6 && killEhb ? 0x1f : 0xff);

    const vActive =
      this.vdiwStateLine === line
        ? this.vdiwActive
        : (line >= this.diwVStart && line < this.diwVStop);

    const ecsena = this.chipset !== 'OCS' && (this.bplCon0 & 0x0001) !== 0;
    const brdrBlnk = ecsena && (this.bplCon3 & 0x0020) !== 0;
    const brdrSprt = ecsena && (this.bplCon3 & 0x0002) !== 0;

    if (this.sprSteppedLine !== line) {
      this.stepSpritesOnLine(line);
      this.sprSteppedLine = line;
    }

    if (
      (this.lineSplitLine === line && this.lineSplitCount > 0) ||
      this.bplDatWrittenOnLine ||
      (ham && (this.midlineColorCount > 0 || this.midlineBplamCount > 0))
    ) {
      this.renderScanlineSplit(line, visible, rowOff, fbW);
      return;
    }

    if (!dmaOk || bpu === 0 || !vActive) {
      if (visible) {
        if (brdrBlnk) {
          fb.fill(0xff000000, rowOff, rowOff + fbW);
          if (brdrSprt) {
            this.renderSpritesOnLine(line, rowOff, true, true);
          }
        } else {
          if (this.midlineColorCount === 0 && this.midlineBplamCount === 0) {
            fb.fill(bg, rowOff, rowOff + fbW);
          } else {
            this.fillMidlineBgSpans(rowOff, fbW, bplam);
          }
          if (brdrSprt || !dmaOk || bpu === 0) {
            this.renderSpritesOnLine(line, rowOff, true, brdrSprt);
          }
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
      // AGA 32-bit fetch mode: PUAE fetchunits[] = {16, 8, 8} (SHRES fetches 8 bytes per 8-CCK block)
      const fetchUnits = shres
        ? ((ddfSpan + 7) >>> 3) + 1
        : hires
          ? ((ddfSpan + 7) >>> 3) + 1
          : ((ddfSpan + 15) >>> 4) + 1;
      const maxBytes = shres ? 224 : hires ? 112 : 56;
      const b = shres ? (fetchUnits << 3) : (fetchUnits << 2);
      numBytes = b > maxBytes ? maxBytes : b;
    }

    if (!visible) {
      const isOcs7 = !isAga && !hires && !shres && bpu === 7;
      this.advanceBitplanePointers(line, isOcs7 ? 4 : bpu, numBytes, isAga, bplFmode, mask);
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
    const isOcs7Planes = !isAga && !hires && !shres && bpu === 7;
    const dmaBpu = isOcs7Planes ? 4 : bpu;
    const effBpu = isOcs7Planes ? 6 : bpu;
    const pf1P = this.bplCon2 & 0x07;
    const pf2P = (this.bplCon2 >>> 3) & 0x07;
    const doWeirdFix = !isAga && (pf1P >= 5 || pf2P >= 5);

    const wrapMaskLo = bplFmode === 3 ? 63 : bplFmode !== 0 ? 31 : 15;
    const wrapMaskHi = shres ? (bplFmode === 3 ? 31 : bplFmode !== 0 ? 15 : 7) : wrapMaskLo;

    const hOriginLo = this.viewHOriginLo;
    const viewLoWidth = fbW >>> 1;
    const hShiftLo = 0x81 - hOriginLo;

    let minX = ((this.diwHStart - hOriginLo) << 1) + (isAga ? this.diwHStartSubHi : 0);
    let maxX = ((this.diwHStop - hOriginLo) << 1) + (isAga ? this.diwHStopSubHi : 0);
    if (minX < 0) minX = 0;
    if (maxX > fbW) maxX = fbW;
    if (maxX < minX) maxX = minX;
    let diwHStartLo = minX >>> 1;
    let diwHStopLo = (maxX + 1) >>> 1;
    if (diwHStartLo < 0) diwHStartLo = 0;
    if (diwHStopLo > viewLoWidth) diwHStopLo = viewLoWidth;
    if (diwHStopLo < diwHStartLo) diwHStopLo = diwHStartLo;

    const pf2Offset = isAga ? PF2OF_TABLE[(this.bplCon3 >>> 10) & 7] : 8;
    const en6 = (this.clxCon >>> 6) & 0x3f;
    const mv6 = this.clxCon & 0x3f;
    const clxEnMask = this.chipset !== 'OCS' ? ((this.clxCon2 & 0xc0) | en6) : en6;
    const clxMvMask = this.chipset !== 'OCS' ? (((this.clxCon2 & 0x03) << 6) | mv6) : mv6;
    const clxOddEn = clxEnMask & 0x55;
    const clxEvenEn = clxEnMask & 0xaa;
    if (brdrBlnk) {
      if (minX > 0) fb.fill(0xff000000, rowOff, rowOff + minX);
      if (maxX > minX) fb.fill(bg, rowOff + minX, rowOff + maxX);
      if (maxX < fbW) fb.fill(0xff000000, rowOff + maxX, rowOff + fbW);
    } else {
      fb.fill(bg, rowOff, rowOff + fbW);
    }

    if (ham8) {
      // Authentic AGA Lisa HAM8 (262,144 colors): BPL1-2 = control, BPL3-8 = 6-bit value/RGB[7:2]
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
          const b7 = chip[(p7 + byteIdx) & mask];

          for (let bit = 7; bit >= 0; bit -= stepBit) {
            const ctrl = ((b0 >>> bit) & 1) | (((b1 >>> bit) & 1) << 1);
            const data6 =
              ((b2 >>> bit) & 1) |
              (((b3 >>> bit) & 1) << 1) |
              (((b4 >>> bit) & 1) << 2) |
              (((b5 >>> bit) & 1) << 3) |
              (((b6 >>> bit) & 1) << 4) |
              (((b7 >>> bit) & 1) << 5);
            const pv = ((data6 << 2) | ctrl) ^ bplam;
            const ctrlEff = pv & 3;

            if (ctrlEff === 0) {
              const c24 = this.colorReg24[pv >>> 2];
              holdR = (c24 >>> 16) & 0xff;
              holdG = (c24 >>> 8) & 0xff;
              holdB = c24 & 0xff;
            } else if (ctrlEff === 1) {
              holdB = (holdB & 0x03) | (data6 << 2);
            } else if (ctrlEff === 2) {
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
          const b7 = chip[(p7 + byteIdx) & mask];

          for (let bit = 7; bit >= 0; bit--) {
            const ctrl = ((b0 >>> bit) & 1) | (((b1 >>> bit) & 1) << 1);
            const data6 =
              ((b2 >>> bit) & 1) |
              (((b3 >>> bit) & 1) << 1) |
              (((b4 >>> bit) & 1) << 2) |
              (((b5 >>> bit) & 1) << 3) |
              (((b6 >>> bit) & 1) << 4) |
              (((b7 >>> bit) & 1) << 5);
            const pv = ((data6 << 2) | ctrl) ^ bplam;
            const ctrlEff = pv & 3;

            if (ctrlEff === 0) {
              const c24 = this.colorReg24[pv >>> 2];
              holdR = (c24 >>> 16) & 0xff;
              holdG = (c24 >>> 8) & 0xff;
              holdB = c24 & 0xff;
            } else if (ctrlEff === 1) {
              holdB = (holdB & 0x03) | (data6 << 2);
            } else if (ctrlEff === 2) {
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
        const dpfSrc = this.lineDpfSrc;
        dpfSrc.fill(0, 0, fbW);
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
                let colIdx = 0;
                if (pf2Prio) {
                  if (c2 !== 0) {
                    colIdx = (pf2Offset + c2) & 0xff;
                    dpfSrc[outX] = 2;
                  } else if (c1 !== 0) {
                    colIdx = c1;
                    dpfSrc[outX] = 1;
                  }
                } else {
                  if (c1 !== 0) {
                    colIdx = c1;
                    dpfSrc[outX] = 1;
                  } else if (c2 !== 0) {
                    colIdx = (pf2Offset + c2) & 0xff;
                    dpfSrc[outX] = 2;
                  }
                }
                indices[outX] = colIdx;
                if (clxEnMask !== 0) {
                  this.clxBplLine[outX] =
                    (c1 & 1) | ((c1 & 2) << 1) | ((c1 & 4) << 2) | ((c1 & 8) << 3) |
                    ((c2 & 1) << 1) | ((c2 & 2) << 2) | ((c2 & 4) << 3) | ((c2 & 8) << 4);
                }
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
            let colIdx = 0;
            if (pf2Prio) {
              if (c2 !== 0) {
                colIdx = (pf2Offset + c2) & 0xff;
                dpfSrc[outX] = 2;
              } else if (c1 !== 0) {
                colIdx = c1;
                dpfSrc[outX] = 1;
              }
            } else {
              if (c1 !== 0) {
                colIdx = c1;
                dpfSrc[outX] = 1;
              } else if (c2 !== 0) {
                colIdx = (pf2Offset + c2) & 0xff;
                dpfSrc[outX] = 2;
              }
            }
            indices[outX] = colIdx;
            if (clxEnMask !== 0) {
              this.clxBplLine[outX] =
                (c1 & 1) | ((c1 & 2) << 1) | ((c1 & 4) << 2) | ((c1 & 8) << 3) |
                ((c2 & 1) << 1) | ((c2 & 2) << 2) | ((c2 & 4) << 3) | ((c2 & 8) << 4);
            }
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
                (((b0 >>> bit) & 1) |
                 (((b1 >>> bit) & 1) << 1) |
                 (((b2 >>> bit) & 1) << 2) |
                 (((b3 >>> bit) & 1) << 3)) & bypassMask;
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
                (((b0 >>> bit) & 1) |
                 (((b1 >>> bit) & 1) << 1) |
                 (((b2 >>> bit) & 1) << 2) |
                 (((b3 >>> bit) & 1) << 3) |
                 (((b4 >>> bit) & 1) << 4) |
                 (((b5 >>> bit) & 1) << 5) |
                 (((b6 >>> bit) & 1) << 6) |
                 (((b7 >>> bit) & 1) << 7)) & bypassMask;
              indices[outX] = idx;
              fb[rowOff + outX] = ehb && idx >= 32 ? ehbColors[idx & 31] : colors[idx ^ bplam];
            }
            outX++;
          }
        }
      }
    } else if (ham) {
      // Authentic Amiga HAM6 (Hold-And-Modify, 5..6 bitplanes; 24-bit base palette on AGA, 12-bit on OCS/ECS)
      const fetchPx = (this.ddfStrt - 0x38) << 1;
      const startPx = fetchPx + ((pf1ScrollLo - fetchPx) & wrapMaskLo) + hShiftLo;
      let outPx = startPx;

      if (isAga) {
        const c24_0 = this.colorReg24[bplam];
        let holdR = (c24_0 >>> 16) & 0xff;
        let holdG = (c24_0 >>> 8) & 0xff;
        let holdB = c24_0 & 0xff;
        const hamXor = bplam & 0x3f;

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
            const pv = ((ctrl << 4) | data4) ^ hamXor;
            const ctrlEff = (pv >>> 4) & 3;

            if (ctrlEff === 0) {
              const c24 = this.colorReg24[pv & 0x0f];
              holdR = (c24 >>> 16) & 0xff;
              holdG = (c24 >>> 8) & 0xff;
              holdB = c24 & 0xff;
            } else {
              const c8 = (data4 << 4) | data4;
              if (ctrlEff === 1) holdB = c8;
              else if (ctrlEff === 2) holdR = c8;
              else holdG = c8;
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
          const b5 = bpu > 5 ? chip[(p5 + byteIdx) & mask] : 0;

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
      const dpfSrc = this.lineDpfSrc;
      dpfSrc.fill(0, 0, fbW);
      const pf2Prio = (this.bplCon2 & 0x0040) !== 0;
      const fetchPx = (this.ddfStrt - 0x38) << 1;
      const startPx1 = fetchPx + ((pf1ScrollLo - fetchPx) & wrapMaskLo) + hShiftLo;
      const startPx2 = fetchPx + ((pf2ScrollLo - fetchPx) & wrapMaskLo) + hShiftLo;
      const totalPx = numBytes << 3;

      if (pf1Half === 0 && pf2Half === 0) {
        const weirdPf1 = doWeirdFix && pf1P >= 5;
        const weirdPf2 = doWeirdFix && pf2P >= 5;
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
          let colIdx = 0;
          let srcPf = 0;
          if (pf2Prio) {
            if (c2 !== 0) {
              colIdx = weirdPf2 ? 0 : ((pf2Offset + c2) & 0xff);
              srcPf = 2;
            } else if (c1 !== 0) {
              colIdx = weirdPf1 ? 0 : c1;
              srcPf = 1;
            }
          } else {
            if (c1 !== 0) {
              colIdx = weirdPf1 ? 0 : c1;
              srcPf = 1;
            } else if (c2 !== 0) {
              colIdx = weirdPf2 ? 0 : ((pf2Offset + c2) & 0xff);
              srcPf = 2;
            }
          }
          const abgr = colors[colIdx ^ bplam];
          const x2 = outPx << 1;
          fb[rowOff + x2] = abgr;
          fb[rowOff + x2 + 1] = abgr;
          indices[x2] = colIdx;
          indices[x2 + 1] = colIdx;
          if (srcPf !== 0) {
            dpfSrc[x2] = srcPf;
            dpfSrc[x2 + 1] = srcPf;
          }
          if (clxEnMask !== 0) {
            const rawB =
              (c1 & 1) | ((c1 & 2) << 1) | ((c1 & 4) << 2) | ((c1 & 8) << 3) |
              ((c2 & 1) << 1) | ((c2 & 2) << 2) | ((c2 & 4) << 3) | ((c2 & 8) << 4);
            this.clxBplLine[x2] = rawB;
            this.clxBplLine[x2 + 1] = rawB;
          }
        }
        if ((minX & 1) !== 0 && minX > 0) {
          const edgeX = minX - 1;
          fb[rowOff + edgeX] = brdrBlnk ? 0xff000000 : bg;
          indices[edgeX] = 0;
          dpfSrc[edgeX] = 0;
        }
        if ((maxX & 1) !== 0 && maxX < fbW) {
          fb[rowOff + maxX] = brdrBlnk ? 0xff000000 : bg;
          indices[maxX] = 0;
          dpfSrc[maxX] = 0;
        }
      } else {
        const startHi1 = (startPx1 << 1) + pf1Half;
        const startHi2 = (startPx2 << 1) + pf2Half;
        const totalHi = totalPx << 1;
        const weirdPf1 = doWeirdFix && pf1P >= 5;
        const weirdPf2 = doWeirdFix && pf2P >= 5;
        for (let outX = minX; outX < maxX; outX++) {
          const d1 = outX - startHi1;
          const d2 = outX - startHi2;
          let c1 = 0;
          let c2 = 0;
          if (d1 >= 0 && d1 < totalHi) {
            const s1 = d1 >>> 1;
            const bi = s1 >>> 3;
            const bit = 7 - (s1 & 7);
            c1 =
              (bpu > 0 ? ((chip[(p0 + bi) & mask] >>> bit) & 1) : 0) |
              (bpu > 2 ? (((chip[(p2 + bi) & mask] >>> bit) & 1) << 1) : 0) |
              (bpu > 4 ? (((chip[(p4 + bi) & mask] >>> bit) & 1) << 2) : 0) |
              (bpu > 6 ? (((chip[(p6 + bi) & mask] >>> bit) & 1) << 3) : 0);
          }
          if (d2 >= 0 && d2 < totalHi) {
            const s2 = d2 >>> 1;
            const bi = s2 >>> 3;
            const bit = 7 - (s2 & 7);
            c2 =
              (bpu > 1 ? ((chip[(p1 + bi) & mask] >>> bit) & 1) : 0) |
              (bpu > 3 ? (((chip[(p3 + bi) & mask] >>> bit) & 1) << 1) : 0) |
              (bpu > 5 ? (((chip[(p5 + bi) & mask] >>> bit) & 1) << 2) : 0) |
              (bpu > 7 ? (((chip[(p7 + bi) & mask] >>> bit) & 1) << 3) : 0);
          }
          let colIdx = 0;
          let srcPf = 0;
          if (pf2Prio) {
            if (c2 !== 0) {
              colIdx = weirdPf2 ? 0 : ((pf2Offset + c2) & 0xff);
              srcPf = 2;
            } else if (c1 !== 0) {
              colIdx = weirdPf1 ? 0 : c1;
              srcPf = 1;
            }
          } else {
            if (c1 !== 0) {
              colIdx = weirdPf1 ? 0 : c1;
              srcPf = 1;
            } else if (c2 !== 0) {
              colIdx = weirdPf2 ? 0 : ((pf2Offset + c2) & 0xff);
              srcPf = 2;
            }
          }
          indices[outX] = colIdx;
          if (srcPf !== 0) dpfSrc[outX] = srcPf;
          fb[rowOff + outX] = colors[colIdx ^ bplam];
          if (clxEnMask !== 0) {
            this.clxBplLine[outX] =
              (c1 & 1) | ((c1 & 2) << 1) | ((c1 & 4) << 2) | ((c1 & 8) << 3) |
              ((c2 & 1) << 1) | ((c2 & 2) << 2) | ((c2 & 4) << 3) | ((c2 & 8) << 4);
          }
        }
      }
    } else if (!isAga || bpu <= 6) {
      // Standard Lo-Res 1..6 bitplanes (zero-overhead OCS/ECS hot loop + 7-plane static BPL5/6DAT + weird_bitplane_fix)
      const fetchPx = (this.ddfStrt - 0x38) << 1;
      const startPx1 = fetchPx + ((pf1ScrollLo - fetchPx) & wrapMaskLo) + hShiftLo;
      const startPx2 = fetchPx + ((pf2ScrollLo - fetchPx) & wrapMaskLo) + hShiftLo;
      const weirdSingle = !isAga && effBpu >= 5 && pf2P >= 5;
      const dat4 = isOcs7Planes ? this.bplDat[4] : 0;
      const dat5 = isOcs7Planes ? this.bplDat[5] : 0;

      if (pf1Half === 0 && pf2Half === 0) {
        if (startPx1 === startPx2) {
          let outPx = startPx1;
          for (let byteIdx = 0; byteIdx < numBytes; byteIdx++) {
            const b0 = effBpu > 0 ? chip[(p0 + byteIdx) & mask] : 0;
            const b1 = effBpu > 1 ? chip[(p1 + byteIdx) & mask] : 0;
            const b2 = effBpu > 2 ? chip[(p2 + byteIdx) & mask] : 0;
            const b3 = effBpu > 3 ? chip[(p3 + byteIdx) & mask] : 0;
            const b4 = isOcs7Planes
              ? ((byteIdx & 1) === 0 ? (dat4 >>> 8) & 0xff : dat4 & 0xff)
              : effBpu > 4 ? chip[(p4 + byteIdx) & mask] : 0;
            const b5 = isOcs7Planes
              ? ((byteIdx & 1) === 0 ? (dat5 >>> 8) & 0xff : dat5 & 0xff)
              : effBpu > 5 ? chip[(p5 + byteIdx) & mask] : 0;

            for (let bit = 7; bit >= 0; bit--) {
              if (outPx >= diwHStartLo && outPx < diwHStopLo) {
                let idx =
                  (((b0 >>> bit) & 1) |
                   (((b1 >>> bit) & 1) << 1) |
                   (((b2 >>> bit) & 1) << 2) |
                   (((b3 >>> bit) & 1) << 3) |
                   (((b4 >>> bit) & 1) << 4) |
                   (((b5 >>> bit) & 1) << 5)) & bypassMask;
                if (weirdSingle && (idx & 0x10) !== 0) idx = 0x10;
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
              if (effBpu > 0) idx |= (chip[(p0 + bi) & mask] >>> bit) & 1;
              if (effBpu > 2) idx |= ((chip[(p2 + bi) & mask] >>> bit) & 1) << 2;
              if (isOcs7Planes) idx |= ((dat4 >>> (((((bi & 1) ^ 1) << 3) + bit))) & 1) << 4;
              else if (effBpu > 4) idx |= ((chip[(p4 + bi) & mask] >>> bit) & 1) << 4;
            }
            if (s2 >= 0 && s2 < totalPx) {
              const bi = s2 >>> 3;
              const bit = 7 - (s2 & 7);
              if (effBpu > 1) idx |= ((chip[(p1 + bi) & mask] >>> bit) & 1) << 1;
              if (effBpu > 3) idx |= ((chip[(p3 + bi) & mask] >>> bit) & 1) << 3;
              if (isOcs7Planes) idx |= ((dat5 >>> (((((bi & 1) ^ 1) << 3) + bit))) & 1) << 5;
              else if (effBpu > 5) idx |= ((chip[(p5 + bi) & mask] >>> bit) & 1) << 5;
            }
            idx &= bypassMask;
            if (weirdSingle && (idx & 0x10) !== 0) idx = 0x10;
            const abgr = ehb && idx >= 32 ? ehbColors[idx & 31] : colors[idx ^ bplam];
            const x2 = outPx << 1;
            fb[rowOff + x2] = abgr;
            fb[rowOff + x2 + 1] = abgr;
            indices[x2] = idx;
            indices[x2 + 1] = idx;
          }
        }
        if ((minX & 1) !== 0 && minX > 0) {
          const edgeX = minX - 1;
          fb[rowOff + edgeX] = brdrBlnk ? 0xff000000 : bg;
          indices[edgeX] = 0;
        }
        if ((maxX & 1) !== 0 && maxX < fbW) {
          fb[rowOff + maxX] = brdrBlnk ? 0xff000000 : bg;
          indices[maxX] = 0;
        }
      } else if (startPx1 === startPx2 && pf1Half === pf2Half) {
        let outX = (startPx1 << 1) + pf1Half;
        for (let byteIdx = 0; byteIdx < numBytes; byteIdx++) {
          const b0 = effBpu > 0 ? chip[(p0 + byteIdx) & mask] : 0;
          const b1 = effBpu > 1 ? chip[(p1 + byteIdx) & mask] : 0;
          const b2 = effBpu > 2 ? chip[(p2 + byteIdx) & mask] : 0;
          const b3 = effBpu > 3 ? chip[(p3 + byteIdx) & mask] : 0;
          const b4 = effBpu > 4 ? chip[(p4 + byteIdx) & mask] : 0;
          const b5 = effBpu > 5 ? chip[(p5 + byteIdx) & mask] : 0;

          for (let bit = 7; bit >= 0; bit--) {
            const idx =
              (((b0 >>> bit) & 1) |
               (((b1 >>> bit) & 1) << 1) |
               (((b2 >>> bit) & 1) << 2) |
               (((b3 >>> bit) & 1) << 3) |
               (((b4 >>> bit) & 1) << 4) |
               (((b5 >>> bit) & 1) << 5)) & bypassMask;
            const abgr = ehb && idx >= 32 ? ehbColors[idx & 31] : colors[idx ^ bplam];
            if (outX >= minX && outX < maxX) {
              fb[rowOff + outX] = abgr;
              indices[outX] = idx;
            }
            const xNext = outX + 1;
            if (xNext >= minX && xNext < maxX) {
              fb[rowOff + xNext] = abgr;
              indices[xNext] = idx;
            }
            outX += 2;
          }
        }
      } else {
        const startHi1 = (startPx1 << 1) + pf1Half;
        const startHi2 = (startPx2 << 1) + pf2Half;
        const totalHi = numBytes << 4;
        for (let outX = minX; outX < maxX; outX++) {
          const d1 = outX - startHi1;
          const d2 = outX - startHi2;
          let idx = 0;
          if (d1 >= 0 && d1 < totalHi) {
            const s1 = d1 >>> 1;
            const bi = s1 >>> 3;
            const bit = 7 - (s1 & 7);
            if (effBpu > 0) idx |= (chip[(p0 + bi) & mask] >>> bit) & 1;
            if (effBpu > 2) idx |= ((chip[(p2 + bi) & mask] >>> bit) & 1) << 2;
            if (effBpu > 4) idx |= ((chip[(p4 + bi) & mask] >>> bit) & 1) << 4;
          }
          if (d2 >= 0 && d2 < totalHi) {
            const s2 = d2 >>> 1;
            const bi = s2 >>> 3;
            const bit = 7 - (s2 & 7);
            if (effBpu > 1) idx |= ((chip[(p1 + bi) & mask] >>> bit) & 1) << 1;
            if (effBpu > 3) idx |= ((chip[(p3 + bi) & mask] >>> bit) & 1) << 3;
            if (effBpu > 5) idx |= ((chip[(p5 + bi) & mask] >>> bit) & 1) << 5;
          }
          idx &= bypassMask;
          const abgr = ehb && idx >= 32 ? ehbColors[idx & 31] : colors[idx ^ bplam];
          fb[rowOff + outX] = abgr;
          indices[outX] = idx;
        }
      }
    } else {
      // AGA Lo-Res 7..8 bitplanes (128 / 256 colors)
      const fetchPx = (this.ddfStrt - 0x38) << 1;
      const startPx1 = fetchPx + ((pf1ScrollLo - fetchPx) & wrapMaskLo) + hShiftLo;
      const startPx2 = fetchPx + ((pf2ScrollLo - fetchPx) & wrapMaskLo) + hShiftLo;

      if (pf1Half === 0 && pf2Half === 0) {
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
                  (((b0 >>> bit) & 1) |
                   (((b1 >>> bit) & 1) << 1) |
                   (((b2 >>> bit) & 1) << 2) |
                   (((b3 >>> bit) & 1) << 3) |
                   (((b4 >>> bit) & 1) << 4) |
                   (((b5 >>> bit) & 1) << 5) |
                   (((b6 >>> bit) & 1) << 6) |
                   (((b7 >>> bit) & 1) << 7)) & bypassMask;
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
            idx &= bypassMask;
            const abgr = colors[idx ^ bplam];
            const x2 = outPx << 1;
            fb[rowOff + x2] = abgr;
            fb[rowOff + x2 + 1] = abgr;
            indices[x2] = idx;
            indices[x2 + 1] = idx;
          }
        }
      } else if (startPx1 === startPx2 && pf1Half === pf2Half) {
        let outX = (startPx1 << 1) + pf1Half;
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
            const idx =
              (((b0 >>> bit) & 1) |
               (((b1 >>> bit) & 1) << 1) |
               (((b2 >>> bit) & 1) << 2) |
               (((b3 >>> bit) & 1) << 3) |
               (((b4 >>> bit) & 1) << 4) |
               (((b5 >>> bit) & 1) << 5) |
               (((b6 >>> bit) & 1) << 6) |
               (((b7 >>> bit) & 1) << 7)) & bypassMask;
            const abgr = colors[idx ^ bplam];
            if (outX >= minX && outX < maxX) {
              fb[rowOff + outX] = abgr;
              indices[outX] = idx;
            }
            const xNext = outX + 1;
            if (xNext >= minX && xNext < maxX) {
              fb[rowOff + xNext] = abgr;
              indices[xNext] = idx;
            }
            outX += 2;
          }
        }
      } else {
        const startHi1 = (startPx1 << 1) + pf1Half;
        const startHi2 = (startPx2 << 1) + pf2Half;
        const totalHi = numBytes << 4;
        for (let outX = minX; outX < maxX; outX++) {
          const d1 = outX - startHi1;
          const d2 = outX - startHi2;
          let idx = 0;
          if (d1 >= 0 && d1 < totalHi) {
            const s1 = d1 >>> 1;
            const bi = s1 >>> 3;
            const bit = 7 - (s1 & 7);
            idx |=
              ((chip[(p0 + bi) & mask] >>> bit) & 1) |
              (((chip[(p2 + bi) & mask] >>> bit) & 1) << 2) |
              (((chip[(p4 + bi) & mask] >>> bit) & 1) << 4) |
              (((chip[(p6 + bi) & mask] >>> bit) & 1) << 6);
          }
          if (d2 >= 0 && d2 < totalHi) {
            const s2 = d2 >>> 1;
            const bi = s2 >>> 3;
            const bit = 7 - (s2 & 7);
            idx |=
              (((chip[(p1 + bi) & mask] >>> bit) & 1) << 1) |
              (((chip[(p3 + bi) & mask] >>> bit) & 1) << 3) |
              (((chip[(p5 + bi) & mask] >>> bit) & 1) << 5);
            if (bpu > 7) idx |= ((chip[(p7 + bi) & mask] >>> bit) & 1) << 7;
          }
          idx &= bypassMask;
          const abgr = colors[idx ^ bplam];
          fb[rowOff + outX] = abgr;
          indices[outX] = idx;
        }
      }
    }

    // Advance bitplane pointers by fetched bytes + odd/even modulo (with AGA BSCAN2 & unaligned carry quirk)
    this.advanceBitplanePointers(line, dmaBpu, numBytes, isAga, bplFmode, mask);

    // Apply mid-scanline Copper palette / BPLAM changes (zero overhead when both counts === 0)
    if ((this.midlineColorCount > 0 || this.midlineBplamCount > 0) && !ham) {
      this.applyMidlineColors(rowOff, brdrBlnk ? minX : 0, brdrBlnk ? maxX : fbW, ehb, bplam);
    }
    this.midlineColorCount = 0;
    this.midlineBplamCount = 0;

    // Hardware Playfield 1 vs Playfield 2 collision (CLXDAT bit 0)
    if (clxOddEn !== 0 && clxEvenEn !== 0 && (this.clxDat & 1) === 0 && maxX > minX) {
      const colPlanes = dpf ? this.clxBplLine : indices;
      const xStep = hires || shres ? 1 : 2;
      for (let x = minX; x < maxX; x += xStep) {
        const pBits = colPlanes[x];
        if (((pBits ^ clxMvMask) & clxOddEn) === 0 && ((pBits ^ clxMvMask) & clxEvenEn) === 0) {
          this.clxDat |= 1;
          break;
        }
      }
    }

    // Composite 8 Hardware Sprites on top (+ SPR vs SPR / SPR vs PF hardware collision)
    this.renderSpritesOnLine(line, rowOff, false, brdrSprt);
  }

  private advanceBitplanePointers(
    line: number,
    bpu: number,
    numBytes: number,
    isAga: boolean,
    bplFmode: number,
    mask: number
  ): void {
    if (!isAga || (bplFmode === 0 && (this.fmode & 0x4000) === 0)) {
      for (let p = 0; p < bpu; p++) {
        const mod = (p & 1) === 0 ? this.bpl1Mod : this.bpl2Mod;
        this.bplPt[p] = (this.bplPt[p] + numBytes + mod) & mask;
      }
      return;
    }
    const bscan2 = (this.fmode & 0x4000) !== 0;
    const bscanMod = bscan2
      ? ((((this.diwStrt >>> 8) ^ (line ^ 1)) & 1) !== 0 ? this.bpl2Mod : this.bpl1Mod)
      : 0;
    for (let p = 0; p < bpu; p++) {
      const nextPt = (this.bplPt[p] + numBytes) & mask;
      let mod = bscan2 ? bscanMod : ((p & 1) === 0 ? this.bpl1Mod : this.bpl2Mod);
      if (bplFmode === 3) {
        if ((nextPt & 6) + (mod & 6) >= 8) mod -= 8;
      } else if (bplFmode !== 0) {
        if ((nextPt & 2) !== 0 && (mod & 2) !== 0) mod -= 4;
      }
      this.bplPt[p] = (nextPt + mod) & mask;
    }
  }

  private advanceWorkBitplanePointers(
    line: number,
    bpu: number,
    isAga: boolean,
    bplFmode: number,
    fmode: number,
    diwStrt: number,
    bpl1Mod: number,
    bpl2Mod: number,
    mask: number
  ): void {
    const wp = this.workBplPt;
    if (!isAga || (bplFmode === 0 && (fmode & 0x4000) === 0)) {
      for (let p = 0; p < bpu; p++) {
        const mod = (p & 1) === 0 ? bpl1Mod : bpl2Mod;
        wp[p] = (wp[p] + mod) & mask;
      }
      return;
    }
    const bscan2 = (fmode & 0x4000) !== 0;
    const bscanMod = bscan2
      ? ((((diwStrt >>> 8) ^ (line ^ 1)) & 1) !== 0 ? bpl2Mod : bpl1Mod)
      : 0;
    for (let p = 0; p < bpu; p++) {
      const nextPt = wp[p];
      let mod = bscan2 ? bscanMod : ((p & 1) === 0 ? bpl1Mod : bpl2Mod);
      if (bplFmode === 3) {
        if ((nextPt & 6) + (mod & 6) >= 8) mod -= 8;
      } else if (bplFmode !== 0) {
        if ((nextPt & 2) !== 0 && (mod & 2) !== 0) mod -= 4;
      }
      wp[p] = (nextPt + mod) & mask;
    }
  }

  private renderScanlineSplit(line: number, visible: boolean, rowOff: number, fbW: number): void {
    const isAga = this.chipset === 'AGA';
    const isEcsOrAga = this.chipset !== 'OCS';
    const chip = this.chipRam;
    const mask = this.chipMask;
    const fb = this.framebuffer;
    const indices = this.lineIndices;
    const dpfSrc = this.lineDpfSrc;
    const fetched = this.lineFetchedPlanes;
    const wp = this.workBplPt;
    const wd = this.workBplDat;

    const splitCount = this.lineSplitLine === line ? this.lineSplitCount : 0;
    const hasStart = splitCount > 0 && this.lineStartCaptured;

    if (hasStart) {
      wp.set(this.lineStartBplPt);
      wd.set(this.lineStartBplDat);
    } else {
      wp.set(this.bplPt);
      wd.set(this.bplDat);
    }

    let wDmacon = hasStart ? this.lineStartDmacon : this.dmacon;
    let wBplCon0 = hasStart ? this.lineStartBplCon0 : this.bplCon0;
    let wBplCon1 = hasStart ? this.lineStartBplCon1 : this.bplCon1;
    let wBplCon2 = hasStart ? this.lineStartBplCon2 : this.bplCon2;
    let wBplCon3 = hasStart ? this.lineStartBplCon3 : this.bplCon3;
    let wBpl1Mod = hasStart ? this.lineStartBpl1Mod : this.bpl1Mod;
    let wBpl2Mod = hasStart ? this.lineStartBpl2Mod : this.bpl2Mod;
    let wDdfStrt = hasStart ? this.lineStartDdfStrt : this.ddfStrt;
    let wDdfStop = hasStart ? this.lineStartDdfStop : this.ddfStop;
    let wDiwHStart = hasStart ? this.lineStartDiwHStart : this.diwHStart;
    let wDiwHStop = hasStart ? this.lineStartDiwHStop : this.diwHStop;
    let wDiwHStartSubHi = hasStart ? this.lineStartDiwHStartSubHi : this.diwHStartSubHi;
    let wDiwHStopSubHi = hasStart ? this.lineStartDiwHStopSubHi : this.diwHStopSubHi;
    let wDiwVStart = hasStart ? this.lineStartDiwVStart : this.diwVStart;
    let wDiwVStop = hasStart ? this.lineStartDiwVStop : this.diwVStop;
    let wDiwHigh = hasStart ? this.lineStartDiwHigh : this.diwHigh;
    let wVActive = hasStart
      ? this.lineStartVdiwActive
      : (this.vdiwStateLine === line ? this.vdiwActive : (line >= this.diwVStart && line < this.diwVStop));
    let wFmode = hasStart ? this.lineStartFmode : this.fmode;

    const applySplitReg = (reg: number, v: number): void => {
      if (reg >= 0x0e0 && reg <= 0x0fe) {
        const idx = (reg - 0x0e0) >>> 2;
        if ((reg & 2) === 0) wp[idx] = ((v & 0x1f) << 16) | (wp[idx] & 0xffff);
        else wp[idx] = (wp[idx] & 0x1f0000) | (v & 0xfffe);
      } else if (reg >= 0x110 && reg <= 0x11e) {
        wd[(reg - 0x110) >>> 1] = v;
      } else if (reg === 0x096) {
        if (v & 0x8000) wDmacon |= v & 0x07ff;
        else wDmacon &= ~(v & 0x07ff);
      } else if (reg === 0x100) {
        wBplCon0 = v;
      } else if (reg === 0x102) {
        wBplCon1 = v;
      } else if (reg === 0x104) {
        wBplCon2 = v;
      } else if (reg === 0x106) {
        if (isEcsOrAga) wBplCon3 = v;
      } else if (reg === 0x108) {
        wBpl1Mod = ((v & 0xfffe) << 16) >> 16;
      } else if (reg === 0x10a) {
        wBpl2Mod = ((v & 0xfffe) << 16) >> 16;
      } else if (reg === 0x092) {
        wDdfStrt = v;
      } else if (reg === 0x094) {
        wDdfStop = v;
      } else if (reg === 0x08e) {
        wDiwVStart = (v >>> 8) & 0xff;
        wDiwHStart = v & 0xff;
        if (isEcsOrAga) {
          wDiwHigh &= ~0x0027;
          wDiwHStartSubHi = 0;
        }
        wVActive = line === wDiwVStart ? true : line === wDiwVStop ? false : wVActive;
      } else if (reg === 0x090) {
        const vs = (v >>> 8) & 0xff;
        const v8 = (vs & 0x80) === 0 ? 0x100 : 0;
        wDiwVStop = vs | v8;
        wDiwHStop = (v & 0xff) | 0x100;
        if (isEcsOrAga) {
          wDiwHigh = (wDiwHigh & ~0x2700) | 0x2000 | v8;
          wDiwHStopSubHi = 0;
        }
        wVActive = line === wDiwVStop ? false : wVActive;
      } else if (reg === 0x1e4 && isEcsOrAga) {
        const vMask = isAga ? 7 : 15;
        wDiwHigh = v;
        wDiwVStart = (wDiwVStart & 0xff) | ((v & vMask) << 8);
        wDiwHStart = (wDiwHStart & 0xff) | ((v & 0x20) << 3);
        wDiwVStop = (wDiwVStop & 0xff) | (v & (vMask << 8));
        wDiwHStop = (wDiwHStop & 0xff) | ((v & 0x2000) >>> 5);
        wDiwHStartSubHi = isAga ? ((v >>> 4) & 1) : 0;
        wDiwHStopSubHi = isAga ? ((v >>> 12) & 1) : 0;
        wVActive = line === wDiwVStart ? true : line === wDiwVStop ? false : wVActive;
      } else if (reg === 0x1fc && isAga) {
        wFmode = v;
      }
    };

    // Phase A: simulate chronological Agnus bitplane DMA fetches into `lineFetchedPlanes` & apply modulos at end-of-DDF
    let fetchedBytes = 0;
    let fetchH = wDdfStrt;
    let modApplied = false;
    let modDmaBpu = 0;
    let modBplFmode = isAga ? (wFmode & 3) : 0;
    let fetchStarted = false;
    let fetchLineDdfStrt = wDdfStrt;
    let lastUnitEndH = 0;
    let sIdx = 0;

    const stepDmaUntil = (limitH: number): void => {
      const dmaOn = (wDmacon & (DMA_MASTER | DMA_BITPLANE)) === (DMA_MASTER | DMA_BITPLANE);
      const bpuRaw = ((wBplCon0 >>> 12) & 7) | (isAga && (wBplCon0 & 0x0010) !== 0 ? 8 : 0);
      const bpu = bpuRaw > 8 ? 8 : bpuRaw;
      const hires = (wBplCon0 & 0x8000) !== 0;
      const shres = isAga && (wBplCon0 & 0x0040) !== 0;
      const bplFmode = isAga ? (wFmode & 3) : 0;
      const effStop = wDdfStop > 0x00d8 ? 0x00d8 : wDdfStop;

      if (!dmaOn || bpu === 0 || !wVActive || effStop < wDdfStrt) {
        return;
      }
      if (!fetchStarted) {
        fetchH = wDdfStrt;
        fetchLineDdfStrt = wDdfStrt;
        lastUnitEndH = wDdfStrt;
        fetchStarted = true;
      }
      const bytesPerUnit = bplFmode === 3 ? 8 : bplFmode !== 0 ? (shres ? 8 : 4) : 2;
      const unitCcks = bplFmode === 3
        ? (shres ? 8 : hires ? 16 : 32)
        : bplFmode !== 0
          ? (shres ? 8 : hires ? 8 : 16)
          : (shres ? 2 : hires ? 4 : 8);
      const unitModDelay = unitCcks < 8 ? unitCcks : 8;
      const maxBytes = bplFmode === 0
        ? (shres ? 208 : hires ? 104 : 56)
        : (shres ? 224 : hires ? 112 : 56);
      const alignMask = bplFmode === 3 ? ~7 : bplFmode !== 0 ? ~3 : ~1;
      const dmaBpu = !isAga && !hires && !shres && bpu === 7 ? 4 : bpu;
      if (dmaBpu > modDmaBpu) modDmaBpu = dmaBpu;
      modBplFmode = bplFmode;

      while (fetchH <= effStop && fetchH < limitH && fetchedBytes + bytesPerUnit <= maxBytes) {
        if (visible) {
          for (let p = 0; p < dmaBpu; p++) {
            const addr = (wp[p] & alignMask) >>> 0;
            const dstBase = (p << 8) + fetchedBytes;
            for (let b = 0; b < bytesPerUnit; b++) {
              fetched[dstBase + b] = chip[(addr + b) & mask];
            }
            wp[p] = (wp[p] + bytesPerUnit) & mask;
          }
        } else {
          for (let p = 0; p < dmaBpu; p++) {
            wp[p] = (wp[p] + bytesPerUnit) & mask;
          }
        }
        lastUnitEndH = fetchH + unitModDelay;
        fetchedBytes += bytesPerUnit;
        fetchH += unitCcks;
      }
      if (!modApplied && fetchStarted && (fetchH > effStop || fetchedBytes + bytesPerUnit > maxBytes) && lastUnitEndH <= limitH) {
        this.advanceWorkBitplanePointers(line, modDmaBpu, isAga, modBplFmode, wFmode, wDiwVStart << 8, wBpl1Mod, wBpl2Mod, mask);
        modApplied = true;
      }
    };

    while (sIdx < splitCount) {
      const sh = this.splitHpos[sIdx];
      stepDmaUntil(sh);
      while (sIdx < splitCount && this.splitHpos[sIdx] === sh) {
        applySplitReg(this.splitReg[sIdx], this.splitVal[sIdx]);
        sIdx++;
      }
    }
    stepDmaUntil(0xe2);
    if (!modApplied && fetchStarted && fetchedBytes > 0) {
      this.advanceWorkBitplanePointers(line, modDmaBpu, isAga, modBplFmode, wFmode, wDiwVStart << 8, wBpl1Mod, wBpl2Mod, mask);
    }

    if (splitCount > 0) {
      this.bplPt.set(wp);
      this.bplDat.set(wd);
    }

    if (!visible) {
      this.midlineColorCount = 0;
      this.midlineBplamCount = 0;
      this.lineSplitCount = 0;
      this.lineStartCaptured = false;
      this.bplDatWrittenOnLine = false;
      return;
    }

    // Phase B: reset work registers to line-start & render horizontal segments across [0, fbW)
    if (hasStart) {
      wd.set(this.lineStartBplDat);
      wDmacon = this.lineStartDmacon;
      wBplCon0 = this.lineStartBplCon0;
      wBplCon1 = this.lineStartBplCon1;
      wBplCon2 = this.lineStartBplCon2;
      wBplCon3 = this.lineStartBplCon3;
      wDdfStrt = this.lineStartDdfStrt;
      wDdfStop = this.lineStartDdfStop;
      wDiwHStart = this.lineStartDiwHStart;
      wDiwHStop = this.lineStartDiwHStop;
      wDiwHStartSubHi = this.lineStartDiwHStartSubHi;
      wDiwHStopSubHi = this.lineStartDiwHStopSubHi;
      wDiwVStart = this.lineStartDiwVStart;
      wDiwVStop = this.lineStartDiwVStop;
      wDiwHigh = this.lineStartDiwHigh;
      wVActive = this.lineStartVdiwActive;
      wFmode = this.lineStartFmode;
    }

    const workCols = this.workColorAbgr;
    const workEhb = this.workColorEhb;
    const work24 = this.workColor24;
    if (this.midlinePaletteSaved) {
      workCols.set(this.lineStartColorAbgr);
      workEhb.set(this.lineStartColorEhb);
      if (isAga) work24.set(this.lineStartColor24);
    } else {
      workCols.set(this.colorAbgr);
      workEhb.set(this.colorEhbAbgr);
      if (isAga) work24.set(this.colorReg24);
    }

    let curBplam = isAga
      ? (this.midlineBplamCount > 0 ? this.lineStartBplam : ((this.bplCon4 >>> 8) & 0xff))
      : 0;
    const colorCount = this.midlineColorCount;
    const bplamCount = this.midlineBplamCount;

    indices.fill(0, 0, fbW);
    dpfSrc.fill(0, 0, fbW);

    const hOriginLo = this.viewHOriginLo;
    const hShiftLo = 0x81 - hOriginLo;
    const hShiftHi = hShiftLo << 1;
    const effFetchDdfStrt = fetchStarted ? fetchLineDdfStrt : wDdfStrt;
    const fetchPx = (effFetchDdfStrt - 0x38) << 1;
    const fetchPxHires = (effFetchDdfStrt - 0x3c) << 2;
    const totalLoPx = fetchedBytes << 3;
    const totalHiPx = fetchedBytes << 4;

    let holdR8 = isAga ? ((work24[curBplam] >>> 16) & 0xff) : (((this.colorReg[0] >>> 8) & 0xf) * 17);
    let holdG8 = isAga ? ((work24[curBplam] >>> 8) & 0xff) : (((this.colorReg[0] >>> 4) & 0xf) * 17);
    let holdB8 = isAga ? (work24[curBplam] & 0xff) : ((this.colorReg[0] & 0xf) * 17);
    let holdInitialized = false;

    let segStartX = 0;
    let eSplit = 0;
    let eCol = 0;
    let eBpl = 0;
    const en6 = (this.clxCon >>> 6) & 0x3f;
    const mv6 = this.clxCon & 0x3f;
    const clxEnMask = this.chipset !== 'OCS' ? ((this.clxCon2 & 0xc0) | en6) : en6;
    const clxMvMask = this.chipset !== 'OCS' ? (((this.clxCon2 & 0x03) << 6) | mv6) : mv6;
    const clxOddEn = clxEnMask & 0x55;
    const clxEvenEn = clxEnMask & 0xaa;
    let splitDpfUsed = false;
    let splitMinX = fbW;
    let splitMaxX = 0;
    let directBplEndX = 0;

    while (segStartX < fbW) {
      const nextSplitX = eSplit < splitCount ? (((this.splitHpos[eSplit] << 1) - hOriginLo) << 1) : fbW;
      const nextColX = eCol < colorCount ? this.midlineColorX[eCol] : fbW;
      const nextBplX = eBpl < bplamCount ? this.midlineBplamX[eBpl] : fbW;
      let segEndX = nextSplitX <= nextColX ? nextSplitX : nextColX;
      if (nextBplX < segEndX) segEndX = nextBplX;
      if (segEndX > fbW) segEndX = fbW;

      if (segEndX > segStartX) {
        const ecsena = isEcsOrAga && (wBplCon0 & 0x0001) !== 0;
        const brdrBlnk = ecsena && (wBplCon3 & 0x0020) !== 0;
        const segBg = brdrBlnk ? 0xff000000 : workCols[curBplam];

        const dmaOk = (wDmacon & (DMA_MASTER | DMA_BITPLANE)) === (DMA_MASTER | DMA_BITPLANE);
        const bpuRaw = ((wBplCon0 >>> 12) & 7) | (isAga && (wBplCon0 & 0x0010) !== 0 ? 8 : 0);
        const bpu = bpuRaw > 8 ? 8 : bpuRaw;
        const hires = (wBplCon0 & 0x8000) !== 0;
        const shres = isAga && (wBplCon0 & 0x0040) !== 0;
        const homod = (wBplCon0 & 0x0800) !== 0;
        const bypass = isAga && (wBplCon0 & 0x0020) !== 0;
        const ham8 = isAga && homod && bpu === 8 && !bypass;
        const ham6 = homod && (isAga ? bpu === 6 : ((bpu === 5 || bpu === 6) && !hires && !shres)) && !bypass;
        const ham = ham8 || ham6;
        const dpf = (wBplCon0 & 0x0400) !== 0;
        const killEhb = isEcsOrAga && (wBplCon2 & 0x0200) !== 0;
        const ehb = !ham && !dpf && bpu === 6 && !killEhb && !bypass;
        const bypassMask = bypass
          ? (homod && bpu === 8 ? 0xfc : homod && bpu === 6 ? 0x0f : (!dpf && bpu === 6 && !killEhb ? 0x1f : 0xff))
          : (!isAga && !ham && !dpf && bpu === 6 && killEhb ? 0x1f : 0xff);

        let minX = ((wDiwHStart - hOriginLo) << 1) + (isAga ? wDiwHStartSubHi : 0);
        let maxX = ((wDiwHStop - hOriginLo) << 1) + (isAga ? wDiwHStopSubHi : 0);
        if (minX < 0) minX = 0;
        if (maxX > fbW) maxX = fbW;
        if (maxX < minX) maxX = minX;

        if (!dmaOk || bpu === 0 || !wVActive || fetchedBytes === 0) {
          const bgStart = segStartX > directBplEndX ? segStartX : directBplEndX;
          if (segEndX > bgStart) {
            fb.fill(segBg, rowOff + bgStart, rowOff + segEndX);
          }
        } else {
          if (wDiwHStop > wDiwHStart) {
            this.frameDiwActive = true;
            if (this.overscanMode === 'auto') {
              if (line < this.frameDiwMinV) this.frameDiwMinV = line;
              if (line + 1 > this.frameDiwMaxV) this.frameDiwMaxV = line + 1;
              if (wDiwHStart < this.frameDiwMinH) this.frameDiwMinH = wDiwHStart;
              if (wDiwHStop > this.frameDiwMaxH) this.frameDiwMaxH = wDiwHStop;
            }
          }

          const actStart = segStartX > minX ? segStartX : minX;
          const actEnd = segEndX < maxX ? segEndX : maxX;
          if (actEnd > actStart) {
            if (actStart < splitMinX) splitMinX = actStart;
            if (actEnd > splitMaxX) splitMaxX = actEnd;
          }
          if (actStart > segStartX) {
            fb.fill(segBg, rowOff + segStartX, rowOff + actStart);
          }
          if (actEnd < segEndX) {
            fb.fill(segBg, rowOff + actEnd, rowOff + segEndX);
          }

          if (actEnd > actStart) {
            if (dpf) splitDpfUsed = true;
            const bplFmode = isAga ? (wFmode & 3) : 0;
            const wrapMaskLo = bplFmode === 3 ? 63 : bplFmode !== 0 ? 31 : 15;
            const wrapMaskHi = shres ? (bplFmode === 3 ? 31 : bplFmode !== 0 ? 15 : 7) : wrapMaskLo;
            const pf1ScrollLo = isAga
              ? ((wBplCon1 & 0x0f) | ((wBplCon1 >>> 6) & 0x30))
              : (wBplCon1 & 0x0f);
            const pf2ScrollLo = isAga
              ? (((wBplCon1 >>> 4) & 0x0f) | ((wBplCon1 >>> 10) & 0x30))
              : ((wBplCon1 >>> 4) & 0x0f);
            const pf1Half = isAga ? ((wBplCon1 >>> 9) & 1) : 0;
            const pf2Half = isAga ? ((wBplCon1 >>> 13) & 1) : 0;
            const pf1P = wBplCon2 & 0x07;
            const pf2P = (wBplCon2 >>> 3) & 0x07;
            const doWeirdFix = !isAga && (pf1P >= 5 || pf2P >= 5);
            const isOcs7 = !isAga && !hires && !shres && bpu === 7;
            const effBpu = isOcs7 ? 6 : bpu;
            const pf2Offset = isAga ? PF2OF_TABLE[(wBplCon3 >>> 10) & 7] : 8;

            if (ham) {
              if (!holdInitialized) {
                if (isAga) {
                  const c24_0 = work24[curBplam];
                  holdR8 = (c24_0 >>> 16) & 0xff;
                  holdG8 = (c24_0 >>> 8) & 0xff;
                  holdB8 = c24_0 & 0xff;
                } else {
                  const c0 = workCols[0];
                  holdR8 = c0 & 0xff;
                  holdG8 = (c0 >>> 8) & 0xff;
                  holdB8 = (c0 >>> 16) & 0xff;
                }
                holdInitialized = true;
              }
              if (ham8) {
                const startHi = hires || shres
                  ? (fetchPxHires + ((((pf1ScrollLo << 1) | pf1Half) - fetchPxHires) & wrapMaskHi) + hShiftHi)
                  : (((fetchPx + ((pf1ScrollLo - fetchPx) & wrapMaskLo) + hShiftLo) << 1) + pf1Half);
                const pxStep = hires || shres ? (shres ? 2 : 1) : 1;
                const totalRange = hires || shres ? (fetchedBytes << (shres ? 2 : 3)) : totalHiPx;
                let prevLo = -1;
                for (let outX = actStart; outX < actEnd; outX++) {
                  const d = outX - startHi;
                  if (d < 0 || d >= totalRange) {
                    fb[rowOff + outX] = segBg;
                    continue;
                  }
                  const pxIdx = (hires || shres) ? (d * pxStep) : (d >>> 1);
                  const bi = pxIdx >>> 3;
                  const bit = 7 - (pxIdx & 7);
                  if (hires || shres || pxIdx !== prevLo) {
                    prevLo = pxIdx;
                    const ctrl = ((fetched[bi] >>> bit) & 1) | (((fetched[256 + bi] >>> bit) & 1) << 1);
                    const data6 =
                      ((fetched[512 + bi] >>> bit) & 1) |
                      (((fetched[768 + bi] >>> bit) & 1) << 1) |
                      (((fetched[1024 + bi] >>> bit) & 1) << 2) |
                      (((fetched[1280 + bi] >>> bit) & 1) << 3) |
                      (((fetched[1536 + bi] >>> bit) & 1) << 4) |
                      (((fetched[1792 + bi] >>> bit) & 1) << 5);
                    const pv = ((data6 << 2) | ctrl) ^ curBplam;
                    const ctrlEff = pv & 3;
                    if (ctrlEff === 0) {
                      const c24 = work24[pv >>> 2];
                      holdR8 = (c24 >>> 16) & 0xff;
                      holdG8 = (c24 >>> 8) & 0xff;
                      holdB8 = c24 & 0xff;
                    } else if (ctrlEff === 1) {
                      holdB8 = (holdB8 & 0x03) | (data6 << 2);
                    } else if (ctrlEff === 2) {
                      holdR8 = (holdR8 & 0x03) | (data6 << 2);
                    } else {
                      holdG8 = (holdG8 & 0x03) | (data6 << 2);
                    }
                    indices[outX] = data6;
                  } else {
                    indices[outX] = indices[outX - 1];
                  }
                  fb[rowOff + outX] = (0xff000000 | (holdB8 << 16) | (holdG8 << 8) | holdR8) >>> 0;
                }
              } else {
                const startHi = ((fetchPx + ((pf1ScrollLo - fetchPx) & wrapMaskLo) + hShiftLo) << 1) + pf1Half;
                const hamXor = isAga ? (curBplam & 0x3f) : 0;
                let prevLo = -1;
                for (let outX = actStart; outX < actEnd; outX++) {
                  const d = outX - startHi;
                  if (d < 0 || d >= totalHiPx) {
                    fb[rowOff + outX] = segBg;
                    continue;
                  }
                  const pxIdx = d >>> 1;
                  if (pxIdx !== prevLo) {
                    prevLo = pxIdx;
                    const bi = pxIdx >>> 3;
                    const bit = 7 - (pxIdx & 7);
                    const data4 =
                      ((fetched[bi] >>> bit) & 1) |
                      (((fetched[256 + bi] >>> bit) & 1) << 1) |
                      (((fetched[512 + bi] >>> bit) & 1) << 2) |
                      (((fetched[768 + bi] >>> bit) & 1) << 3);
                    const ctrl = ((fetched[1024 + bi] >>> bit) & 1) | (bpu > 5 ? (((fetched[1280 + bi] >>> bit) & 1) << 1) : 0);
                    const pv = ((ctrl << 4) | data4) ^ hamXor;
                    const ctrlEff = (pv >>> 4) & 3;
                    if (ctrlEff === 0) {
                      if (isAga) {
                        const c24 = work24[pv & 0x0f];
                        holdR8 = (c24 >>> 16) & 0xff;
                        holdG8 = (c24 >>> 8) & 0xff;
                        holdB8 = c24 & 0xff;
                      } else {
                        const abgr0 = workCols[data4];
                        holdR8 = abgr0 & 0xff;
                        holdG8 = (abgr0 >>> 8) & 0xff;
                        holdB8 = (abgr0 >>> 16) & 0xff;
                      }
                    } else {
                      const c8 = (data4 << 4) | data4;
                      if (ctrlEff === 1) holdB8 = c8;
                      else if (ctrlEff === 2) holdR8 = c8;
                      else holdG8 = c8;
                    }
                    indices[outX] = data4;
                  } else {
                    indices[outX] = indices[outX - 1];
                  }
                  fb[rowOff + outX] = (0xff000000 | (holdB8 << 16) | (holdG8 << 8) | holdR8) >>> 0;
                }
              }
            } else {
              const startHi1 = hires || shres
                ? (fetchPxHires + ((((pf1ScrollLo << 1) | pf1Half) - fetchPxHires) & wrapMaskHi) + hShiftHi)
                : (((fetchPx + ((pf1ScrollLo - fetchPx) & wrapMaskLo) + hShiftLo) << 1) + pf1Half);
              const startHi2 = hires || shres
                ? (fetchPxHires + ((((pf2ScrollLo << 1) | pf2Half) - fetchPxHires) & wrapMaskHi) + hShiftHi)
                : (((fetchPx + ((pf2ScrollLo - fetchPx) & wrapMaskLo) + hShiftLo) << 1) + pf2Half);
              const totalPlanePx = hires || shres ? (shres ? (fetchedBytes << 2) : (fetchedBytes << 3)) : totalHiPx;
              const weirdPf1 = doWeirdFix && pf1P >= 5;
              const weirdPf2 = doWeirdFix && pf2P >= 5;
              const weirdSingle = !isAga && !dpf && effBpu >= 5 && pf2P >= 5;
              const activeBpu = !isAga && (hires || shres) ? (effBpu > 4 ? 4 : effBpu) : effBpu;
              const shShift = shres ? 1 : (hires ? 0 : -1);

              for (let outX = actStart; outX < actEnd; outX++) {
                const d1 = outX - startHi1;
                const d2 = outX - startHi2;
                let s1 = -1;
                let s2 = -1;
                if (d1 >= 0 && d1 < totalPlanePx) s1 = shShift >= 0 ? (d1 << shShift) : (d1 >>> 1);
                if (d2 >= 0 && d2 < totalPlanePx) s2 = shShift >= 0 ? (d2 << shShift) : (d2 >>> 1);

                if (dpf) {
                  let c1 = 0;
                  let c2 = 0;
                  if (s1 >= 0) {
                    const bi = s1 >>> 3;
                    const bit = 7 - (s1 & 7);
                    c1 =
                      (activeBpu > 0 ? ((fetched[bi] >>> bit) & 1) : 0) |
                      (activeBpu > 2 ? (((fetched[512 + bi] >>> bit) & 1) << 1) : 0) |
                      (activeBpu > 4 ? (((fetched[1024 + bi] >>> bit) & 1) << 2) : 0) |
                      (activeBpu > 6 ? (((fetched[1536 + bi] >>> bit) & 1) << 3) : 0);
                  }
                  if (s2 >= 0) {
                    const bi = s2 >>> 3;
                    const bit = 7 - (s2 & 7);
                    c2 =
                      (activeBpu > 1 ? ((fetched[256 + bi] >>> bit) & 1) : 0) |
                      (activeBpu > 3 ? (((fetched[768 + bi] >>> bit) & 1) << 1) : 0) |
                      (activeBpu > 5 ? (((fetched[1280 + bi] >>> bit) & 1) << 2) : 0) |
                      (activeBpu > 7 ? (((fetched[1792 + bi] >>> bit) & 1) << 3) : 0);
                  }
                  let colIdx = 0;
                  let srcPf = 0;
                  if ((wBplCon2 & 0x40) !== 0) {
                    if (c2 !== 0) { colIdx = weirdPf2 ? 0 : ((pf2Offset + c2) & 0xff); srcPf = 2; }
                    else if (c1 !== 0) { colIdx = weirdPf1 ? 0 : c1; srcPf = 1; }
                  } else {
                    if (c1 !== 0) { colIdx = weirdPf1 ? 0 : c1; srcPf = 1; }
                    else if (c2 !== 0) { colIdx = weirdPf2 ? 0 : ((pf2Offset + c2) & 0xff); srcPf = 2; }
                  }
                  indices[outX] = colIdx;
                  if (clxEnMask !== 0) {
                    this.clxBplLine[outX] =
                      (c1 & 1) | ((c1 & 2) << 1) | ((c1 & 4) << 2) | ((c1 & 8) << 3) |
                      ((c2 & 1) << 1) | ((c2 & 2) << 2) | ((c2 & 4) << 3) | ((c2 & 8) << 4);
                  }
                  if (srcPf !== 0) dpfSrc[outX] = srcPf;
                  fb[rowOff + outX] = workCols[colIdx ^ curBplam];
                } else {
                  let idx = 0;
                  if (s1 >= 0) {
                    const bi = s1 >>> 3;
                    const bit = 7 - (s1 & 7);
                    if (activeBpu > 0) idx |= (fetched[bi] >>> bit) & 1;
                    if (activeBpu > 2) idx |= ((fetched[512 + bi] >>> bit) & 1) << 2;
                    if (isOcs7) idx |= ((wd[4] >>> ((((bi & 1) ^ 1) << 3) + bit)) & 1) << 4;
                    else if (activeBpu > 4) idx |= ((fetched[1024 + bi] >>> bit) & 1) << 4;
                    if (activeBpu > 6) idx |= ((fetched[1536 + bi] >>> bit) & 1) << 6;
                  }
                  if (s2 >= 0) {
                    const bi = s2 >>> 3;
                    const bit = 7 - (s2 & 7);
                    if (activeBpu > 1) idx |= ((fetched[256 + bi] >>> bit) & 1) << 1;
                    if (activeBpu > 3) idx |= ((fetched[768 + bi] >>> bit) & 1) << 3;
                    if (isOcs7) idx |= ((wd[5] >>> ((((bi & 1) ^ 1) << 3) + bit)) & 1) << 5;
                    else if (activeBpu > 5) idx |= ((fetched[1280 + bi] >>> bit) & 1) << 5;
                    if (activeBpu > 7) idx |= ((fetched[1792 + bi] >>> bit) & 1) << 7;
                  }
                  idx &= bypassMask;
                  if (weirdSingle && (idx & 0x10) !== 0) idx = 0x10;
                  indices[outX] = idx;
                  fb[rowOff + outX] = ehb && idx >= 32 ? workEhb[idx & 31] : workCols[idx ^ curBplam];
                }
              }
            }
          }
        }
      }

      if (segEndX >= fbW) break;
      segStartX = segEndX;

      while (eSplit < splitCount && (((this.splitHpos[eSplit] << 1) - hOriginLo) << 1) <= segStartX) {
        const reg = this.splitReg[eSplit];
        const val = this.splitVal[eSplit];
        applySplitReg(reg, val);
        if (reg === 0x110 && !fetchStarted) {
          // Direct Copper/CPU BPL1DAT pixel shift when bitplane DMA is off
          const bpuRaw = ((wBplCon0 >>> 12) & 7) | (isAga && (wBplCon0 & 0x0010) !== 0 ? 8 : 0);
          const bpu = bpuRaw > 8 ? 8 : bpuRaw;
          const hires = (wBplCon0 & 0x8000) !== 0;
          if (bpu > 0) {
            const xBase = ((this.splitHpos[eSplit] << 1) - hOriginLo) << 1;
            const pxW = hires ? 1 : 2;
            let minX = ((wDiwHStart - hOriginLo) << 1) + (isAga ? wDiwHStartSubHi : 0);
            let maxX = ((wDiwHStop - hOriginLo) << 1) + (isAga ? wDiwHStopSubHi : 0);
            if (minX < 0) minX = 0;
            if (maxX > fbW) maxX = fbW;
            const endDirect = xBase + (16 * pxW);
            const clippedEnd = endDirect < maxX ? endDirect : maxX;
            if (clippedEnd > directBplEndX) directBplEndX = clippedEnd;
            for (let bit = 15; bit >= 0; bit--) {
              let idx = 0;
              for (let p = 0; p < bpu; p++) idx |= ((wd[p] >>> bit) & 1) << p;
              const abgr = workCols[idx ^ curBplam];
              const ox = xBase + (15 - bit) * pxW;
              for (let s = 0; s < pxW; s++) {
                const xx = ox + s;
                if (xx >= minX && xx < maxX) {
                  fb[rowOff + xx] = abgr;
                  indices[xx] = idx;
                }
              }
            }
          }
        }
        eSplit++;
      }
      while (eCol < colorCount && this.midlineColorX[eCol] <= segStartX) {
        const cIdx = this.midlineColorIdx[eCol];
        const cVal = this.midlineColorVal[eCol];
        workCols[cIdx] = cVal;
        if (isAga) {
          work24[cIdx] = (((cVal & 0xff) << 16) | (cVal & 0xff00) | ((cVal >>> 16) & 0xff)) >>> 0;
        }
        if (cIdx < 32) {
          workEhb[cIdx] = (((cVal >>> 1) & 0x007f7f7f) | 0xff000000) >>> 0;
        }
        eCol++;
      }
      while (eBpl < bplamCount && this.midlineBplamX[eBpl] <= segStartX) {
        curBplam = this.midlineBplamVal[eBpl];
        eBpl++;
      }
    }

    if (clxOddEn !== 0 && clxEvenEn !== 0 && (this.clxDat & 1) === 0 && splitMaxX > splitMinX) {
      const colPlanes = splitDpfUsed ? this.clxBplLine : indices;
      for (let x = splitMinX; x < splitMaxX; x++) {
        const pBits = colPlanes[x];
        if (((pBits ^ clxMvMask) & clxOddEn) === 0 && ((pBits ^ clxMvMask) & clxEvenEn) === 0) {
          this.clxDat |= 1;
          break;
        }
      }
    }

    this.midlineColorCount = 0;
    this.midlineBplamCount = 0;
    this.lineSplitCount = 0;
    this.lineStartCaptured = false;
    this.bplDatWrittenOnLine = false;

    const ecsenaEnd = isEcsOrAga && (this.bplCon0 & 0x0001) !== 0;
    const brdrSprt = ecsenaEnd && (this.bplCon3 & 0x0002) !== 0;
    this.renderSpritesOnLine(line, rowOff, !fetchStarted, brdrSprt);
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
    const isEcsOrAga = this.chipset !== 'OCS';
    const isAga = this.chipset === 'AGA';
    const sprFmode = isAga ? (this.fmode >>> 2) & 3 : 0;
    const sscan2 = isAga && (this.fmode & 0x8000) !== 0;
    const mask = this.chipMask;

    let bplStealThresh = 0x200;
    if (
      this.ddfStrt < 0x38 &&
      (this.dmacon & (DMA_MASTER | DMA_BITPLANE)) === (DMA_MASTER | DMA_BITPLANE)
    ) {
      const bpuRaw = ((this.bplCon0 >>> 12) & 7) | (isAga && (this.bplCon0 & 0x0010) !== 0 ? 8 : 0);
      const vActive =
        this.vdiwStateLine === line
          ? this.vdiwActive
          : (line >= this.diwVStart && line < this.diwVStop);
      if (bpuRaw > 0 && vActive) {
        bplStealThresh = this.ddfStrt;
      }
    }

    for (let s = 0; s < 8; s++) {
      if (this.sprDmaOn[s] === 0) {
        this.sprDmaStreaming[s] = 0;
        this.sprDmaLineActive[s] = 0;
        continue;
      }
      if (0x18 + (s << 2) >= bplStealThresh) {
        this.sprDmaLineActive[s] = 0;
        continue;
      }
      const pos = this.sprPos[s];
      const ctl = this.sprCtl[s];
      const vStart = ((pos >>> 8) & 0xff) | ((ctl & 0x04) << 6) | (isEcsOrAga ? ((ctl & 0x40) << 3) : 0);
      const vStop = ((ctl >>> 8) & 0xff) | ((ctl & 0x02) << 7) | (isEcsOrAga ? ((ctl & 0x20) << 4) : 0);

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

      if (sscan2 && (pos & 0x80) !== 0 && ((line ^ vStart) & 1) !== 0) {
        this.sprDmaLineActive[s] = 1;
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

  private recordSprCol(
    sx: number,
    k: number,
    emptyBg: boolean,
    diwHStartLo: number,
    diwHStopLo: number,
    colPlanes: Uint8Array,
    clxEnMask: number,
    clxMvMask: number,
    clxOddEn: number,
    clxEvenEn: number
  ): void {
    const pairBit = 1 << k;
    const prev = this.sprColMask[sx];
    if ((prev & pairBit) === 0) {
      if (prev !== 0) {
        if (k === 2) {
          if ((prev & 8) !== 0) this.clxDat |= 0x4000;
        } else if (k === 1) {
          if ((prev & 4) !== 0) this.clxDat |= 0x1000;
          if ((prev & 8) !== 0) this.clxDat |= 0x2000;
        } else if (k === 0) {
          if ((prev & 2) !== 0) this.clxDat |= 0x0200;
          if ((prev & 4) !== 0) this.clxDat |= 0x0400;
          if ((prev & 8) !== 0) this.clxDat |= 0x0800;
        }
      }
      this.sprColMask[sx] = prev | pairBit;
      if (sx < this.sprColMinSx) this.sprColMinSx = sx;
      if (sx + 1 > this.sprColMaxSx) this.sprColMaxSx = sx + 1;
      if (!emptyBg && clxEnMask !== 0 && sx >= diwHStartLo && sx < diwHStopLo) {
        const x2 = sx << 1;
        const p0 = colPlanes[x2];
        const p1 = colPlanes[x2 + 1];
        if (clxOddEn !== 0 && (((p0 ^ clxMvMask) & clxOddEn) === 0 || ((p1 ^ clxMvMask) & clxOddEn) === 0)) {
          this.clxDat |= 1 << (1 + k);
        }
        if (clxEvenEn !== 0 && (((p0 ^ clxMvMask) & clxEvenEn) === 0 || ((p1 ^ clxMvMask) & clxEvenEn) === 0)) {
          this.clxDat |= 1 << (5 + k);
        }
      }
    }
  }

  private renderSpritesOnLine(
    line: number,
    rowOff: number,
    emptyBg: boolean,
    brdrSprt: boolean
  ): void {
    const dmaActive = this.sprDmaLineActive;
    const manualArmed = this.sprArmed;
    if (
      this.sprMuxCount === 0 &&
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
    const fbW = this.fbWidth;
    const colors = this.colorAbgr;
    const indices = this.lineIndices;
    const dpfSrc = this.lineDpfSrc;
    const hOriginLo = this.viewHOriginLo;
    const viewLoWidth = fbW >>> 1;
    const dpf = (this.bplCon0 & 0x0400) !== 0;
    const pf1P = this.bplCon2 & 0x07;
    const pf2P = (this.bplCon2 >>> 3) & 0x07;
    const isAga = this.chipset === 'AGA';
    const shresMode = this.chipset !== 'OCS' && (this.bplCon0 & 0x0040) !== 0;
    const ecsShres = !isAga && shresMode;
    const canSubHi = isAga || ecsShres;
    const spres = isAga ? ((this.bplCon3 >>> 6) & 3) : 0;
    // 0 = LORES (2 hires px), 1 = HIRES (1 hires px), 2 = SHRES (0.5 hires px -> step 2)
    const sprPxRes = isAga
      ? (spres === 0 ? (shresMode ? 1 : 0) : spres - 1)
      : (ecsShres ? 1 : 0);

    let clipMinHi = 0;
    let clipMaxHi = fbW;
    if (!brdrSprt && !emptyBg) {
      const d0 = (this.diwHStart - hOriginLo) << 1;
      const d1 = (this.diwHStop - hOriginLo) << 1;
      if (d0 > clipMinHi) clipMinHi = d0;
      if (d1 < clipMaxHi) clipMaxHi = d1;
      if (clipMaxHi <= clipMinHi) {
        this.sprMuxCount = 0;
        return;
      }
    }

    const sprFmode = isAga ? (this.fmode >>> 2) & 3 : 0;
    const sprWidth = sprFmode === 3 ? 64 : sprFmode !== 0 ? 32 : 16;
    const evenPalBank = isAga ? (this.bplCon4 & 0x00f0) : 16;
    const oddPalBank = isAga ? ((this.bplCon4 & 0x000f) << 4) : 16;
    const trackAutoBrdr = brdrSprt && this.overscanMode === 'auto';
    let drawnMinLo = 0x3ff;
    let drawnMaxLo = 0;

    this.sprColMinSx = viewLoWidth;
    this.sprColMaxSx = 0;
    const colPlanes = dpf ? this.clxBplLine : indices;
    const en6 = (this.clxCon >>> 6) & 0x3f;
    const mv6 = this.clxCon & 0x3f;
    const clxEnMask = this.chipset !== 'OCS' ? ((this.clxCon2 & 0xc0) | en6) : en6;
    const clxMvMask = this.chipset !== 'OCS' ? (((this.clxCon2 & 0x03) << 6) | mv6) : mv6;
    const clxOddEn = clxEnMask & 0x55;
    const clxEvenEn = clxEnMask & 0xaa;
    let diwHStartLo = this.diwHStart - hOriginLo;
    let diwHStopLo = this.diwHStop - hOriginLo;
    if (diwHStartLo < 0) diwHStartLo = 0;
    if (diwHStopLo > viewLoWidth) diwHStopLo = viewLoWidth;

    const dxStep = sprPxRes === 2 ? 2 : 1;
    const pxWidthHi = sprPxRes === 0 ? 2 : 1;
    const maxK = ecsShres ? 1 : 3;

    if (this.sprMuxCount > 0) {
      this.decideSpritesUntil(512);
      const muxCount = this.sprMuxCount;
      const sprStepShift = sprPxRes === 2 ? 1 : 0;
      const maxWordShift = sprWidth === 16 ? 15 : 31;
      for (let k = maxK; k >= 0; k--) {
        const e = k << 1;
        const o = e + 1;
        const oddEnSp = ((this.clxCon >>> (12 + k)) & 1) !== 0;
        const baseColorO = oddPalBank + (k << 2);
        const baseColorE = evenPalBank + (k << 2);
        for (let m = 0; m < muxCount; m++) {
          if (this.sprMuxUsed[m] !== 0) continue;
          const s = this.sprMuxNum[m];
          if ((s >>> 1) !== k) continue;
          this.sprMuxUsed[m] = 1;
          const posM = this.sprMuxPos[m];
          const ctlM = this.sprMuxCtl[m];
          const hLoM = ((posM & 0xff) << 1) | (ctlM & 1);
          const subHiM = canSubHi ? ((ctlM >>> 4) & 1) : 0;
          const hHiM = ((hLoM - hOriginLo) << 1) + subHiM;

          let partner = -1;
          for (let m2 = m + 1; m2 < muxCount; m2++) {
            if (this.sprMuxUsed[m2] !== 0) continue;
            if (this.sprMuxNum[m2] === (s ^ 1)) {
              const pPos = this.sprMuxPos[m2];
              const pCtl = this.sprMuxCtl[m2];
              const pHLo = ((pPos & 0xff) << 1) | (pCtl & 1);
              if (pHLo === hLoM && ((s === e ? pCtl : ctlM) & 0x0080) !== 0) {
                partner = m2;
                this.sprMuxUsed[m2] = 1;
                break;
              }
            }
          }

          if (partner >= 0 || (s === o && (ctlM & 0x0080) !== 0)) {
            const mEven = s === e ? m : partner;
            const mOdd = s === o ? m : partner;
            for (let dx = 0; dx < sprWidth; dx += dxStep) {
              const bit = maxWordShift - (dx & maxWordShift);
              let col4 = 0;
              if (mEven >= 0) {
                const wAe = sprWidth === 16 ? this.sprMuxData[mEven] : dx < 32 ? this.sprMuxDataLo[mEven] : this.sprMuxDataHi[mEven];
                const wBe = sprWidth === 16 ? this.sprMuxDatb[mEven] : dx < 32 ? this.sprMuxDatbLo[mEven] : this.sprMuxDatbHi[mEven];
                col4 |= ((wAe >>> bit) & 1) | (((wBe >>> bit) & 1) << 1);
              }
              if (mOdd >= 0) {
                const wAo = sprWidth === 16 ? this.sprMuxData[mOdd] : dx < 32 ? this.sprMuxDataLo[mOdd] : this.sprMuxDataHi[mOdd];
                const wBo = sprWidth === 16 ? this.sprMuxDatb[mOdd] : dx < 32 ? this.sprMuxDatbLo[mOdd] : this.sprMuxDatbHi[mOdd];
                col4 |= (((wAo >>> bit) & 1) << 2) | (((wBo >>> bit) & 1) << 3);
              }
              if (col4 === 0) continue;
              const hx = hHiM + (pxWidthHi === 2 ? dx << 1 : (dx >>> sprStepShift));
              if (trackAutoBrdr) {
                const abs0 = hOriginLo + (hx >> 1);
                const abs1 = hOriginLo + ((hx + pxWidthHi + 1) >> 1);
                if (abs0 < drawnMinLo) drawnMinLo = abs0;
                if (abs1 > drawnMaxLo) drawnMaxLo = abs1;
              }
              if (hx + pxWidthHi <= clipMinHi || hx >= clipMaxHi) continue;
              const sx = hx >> 1;
              if (sx >= 0 && sx < viewLoWidth && ((col4 & 3) !== 0 || (oddEnSp && (col4 & 12) !== 0))) {
                this.recordSprCol(sx, k, emptyBg, diwHStartLo, diwHStopLo, colPlanes, clxEnMask, clxMvMask, clxOddEn, clxEvenEn);
              }
              const abgr = colors[oddPalBank + col4];
              for (let sub = 0; sub < pxWidthHi; sub++) {
                const px = hx + sub;
                if (px < clipMinHi || px >= clipMaxHi) continue;
                if (emptyBg) fb[rowOff + px] = abgr;
                else if (!dpf) { if (indices[px] === 0 || k < pf2P) fb[rowOff + px] = abgr; }
                else { const d = dpfSrc[px]; if (d === 0 || (d === 1 ? k < pf1P : k < pf2P)) fb[rowOff + px] = abgr; }
              }
            }
          } else {
            const isOdd = s === o;
            const baseCol = isOdd ? baseColorO : baseColorE;
            for (let dx = 0; dx < sprWidth; dx += dxStep) {
              const wA = sprWidth === 16 ? this.sprMuxData[m] : dx < 32 ? this.sprMuxDataLo[m] : this.sprMuxDataHi[m];
              const wB = sprWidth === 16 ? this.sprMuxDatb[m] : dx < 32 ? this.sprMuxDatbLo[m] : this.sprMuxDatbHi[m];
              const bit = maxWordShift - (dx & maxWordShift);
              const pxCol = ((wA >>> bit) & 1) | (((wB >>> bit) & 1) << 1);
              if (pxCol === 0) continue;
              const hx = hHiM + (pxWidthHi === 2 ? dx << 1 : (dx >>> sprStepShift));
              if (trackAutoBrdr) {
                const abs0 = hOriginLo + (hx >> 1);
                const abs1 = hOriginLo + ((hx + pxWidthHi + 1) >> 1);
                if (abs0 < drawnMinLo) drawnMinLo = abs0;
                if (abs1 > drawnMaxLo) drawnMaxLo = abs1;
              }
              if (hx + pxWidthHi <= clipMinHi || hx >= clipMaxHi) continue;
              const sx = hx >> 1;
              if ((!isOdd || oddEnSp) && sx >= 0 && sx < viewLoWidth) {
                this.recordSprCol(sx, k, emptyBg, diwHStartLo, diwHStopLo, colPlanes, clxEnMask, clxMvMask, clxOddEn, clxEvenEn);
              }
              const abgr = colors[baseCol + pxCol];
              for (let sub = 0; sub < pxWidthHi; sub++) {
                const px = hx + sub;
                if (px < clipMinHi || px >= clipMaxHi) continue;
                if (emptyBg) fb[rowOff + px] = abgr;
                else if (!dpf) { if (indices[px] === 0 || k < pf2P) fb[rowOff + px] = abgr; }
                else { const d = dpfSrc[px]; if (d === 0 || (d === 1 ? k < pf1P : k < pf2P)) fb[rowOff + px] = abgr; }
              }
            }
          }
        }
      }
      this.sprMuxUsed.fill(0, 0, muxCount);
      this.sprMuxCount = 0;
      if (trackAutoBrdr && drawnMaxLo > drawnMinLo) {
        this.frameDiwActive = true;
        if (drawnMinLo < this.frameDiwMinH) this.frameDiwMinH = drawnMinLo;
        if (drawnMaxLo > this.frameDiwMaxH) this.frameDiwMaxH = drawnMaxLo;
        const minRas = this.isPalTiming() ? 26 : 22;
        const maxRas = this.isPalTiming() ? 312 : 262;
        if (line >= minRas && line < maxRas) {
          if (line < this.frameDiwMinV) this.frameDiwMinV = line;
          if (line + 1 > this.frameDiwMaxV) this.frameDiwMaxV = line + 1;
        }
      }
      if (this.sprColMaxSx > this.sprColMinSx) {
        this.sprColMask.fill(0, this.sprColMinSx, this.sprColMaxSx);
      }
      return;
    }

    for (let k = maxK; k >= 0; k--) {
      const e = k << 1;
      const o = e + 1;
      const eOn = (dmaActive[e] | manualArmed[e]) !== 0;
      const oOn = (dmaActive[o] | manualArmed[o]) !== 0;
      if (!eOn && !oOn) continue;

      const attached = (this.sprCtl[o] & 0x0080) !== 0;
      const oddEnSp = ((this.clxCon >>> (12 + k)) & 1) !== 0;

      const posE = this.sprPos[e];
      const ctlE = this.sprCtl[e];
      const hLoE = ((posE & 0xff) << 1) | (ctlE & 1);
      const subHiE = canSubHi ? ((ctlE >>> 4) & 1) : 0;
      const hHiE = ((hLoE - hOriginLo) << 1) + subHiE;

      const posO = this.sprPos[o];
      const ctlO = this.sprCtl[o];
      const hLoO = ((posO & 0xff) << 1) | (ctlO & 1);
      const subHiO = canSubHi ? ((ctlO >>> 4) & 1) : 0;
      const hHiO = ((hLoO - hOriginLo) << 1) + subHiO;

      if (sprPxRes === 0 && subHiE === 0 && subHiO === 0) {
        // Fast LoRes 2x path (99% of Amiga games, zero extra branches)
        const hE = hLoE - hOriginLo;
        const hO = hLoO - hOriginLo;
        const clipMinLo = clipMinHi >>> 1;
        const clipMaxLo = clipMaxHi >>> 1;

        if (sprWidth === 16) {
          if (attached) {
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
                if (trackAutoBrdr) {
                  const absLo = hOriginLo + sx;
                  if (absLo < drawnMinLo) drawnMinLo = absLo;
                  if (absLo + 1 > drawnMaxLo) drawnMaxLo = absLo + 1;
                }
                if (sx < clipMinLo || sx >= clipMaxLo) continue;
                if ((col4 & 3) !== 0 || (oddEnSp && (col4 & 12) !== 0)) {
                  this.recordSprCol(sx, k, emptyBg, diwHStartLo, diwHStopLo, colPlanes, clxEnMask, clxMvMask, clxOddEn, clxEvenEn);
                }
                const abgr = colors[oddPalBank + col4];
                const x2 = sx << 1;
                if (emptyBg) {
                  fb[rowOff + x2] = abgr;
                  fb[rowOff + x2 + 1] = abgr;
                } else if (!dpf) {
                  if (indices[x2] === 0 || k < pf2P) fb[rowOff + x2] = abgr;
                  if (indices[x2 + 1] === 0 || k < pf2P) fb[rowOff + x2 + 1] = abgr;
                } else {
                  const d0 = dpfSrc[x2];
                  if (d0 === 0 || (d0 === 1 ? k < pf1P : k < pf2P)) fb[rowOff + x2] = abgr;
                  const d1 = dpfSrc[x2 + 1];
                  if (d1 === 0 || (d1 === 1 ? k < pf1P : k < pf2P)) fb[rowOff + x2 + 1] = abgr;
                }
              }
            } else {
              let minSx = viewLoWidth;
              let maxSx = -16;
              if (eOn) {
                if (hE < minSx) minSx = hE;
                if (hE + 16 > maxSx) maxSx = hE + 16;
              }
              if (oOn) {
                if (hO < minSx) minSx = hO;
                if (hO + 16 > maxSx) maxSx = hO + 16;
              }
              if (!trackAutoBrdr) {
                if (minSx < clipMinLo) minSx = clipMinLo;
                if (maxSx > clipMaxLo) maxSx = clipMaxLo;
              }
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
                if (trackAutoBrdr) {
                  const absLo = hOriginLo + sx;
                  if (absLo < drawnMinLo) drawnMinLo = absLo;
                  if (absLo + 1 > drawnMaxLo) drawnMaxLo = absLo + 1;
                }
                if (sx < clipMinLo || sx >= clipMaxLo) continue;
                if ((col4 & 3) !== 0 || (oddEnSp && (col4 & 12) !== 0)) {
                  this.recordSprCol(sx, k, emptyBg, diwHStartLo, diwHStopLo, colPlanes, clxEnMask, clxMvMask, clxOddEn, clxEvenEn);
                }
                const abgr = colors[oddPalBank + col4];
                const x2 = sx << 1;
                if (emptyBg) {
                  fb[rowOff + x2] = abgr;
                  fb[rowOff + x2 + 1] = abgr;
                } else if (!dpf) {
                  if (indices[x2] === 0 || k < pf2P) fb[rowOff + x2] = abgr;
                  if (indices[x2 + 1] === 0 || k < pf2P) fb[rowOff + x2 + 1] = abgr;
                } else {
                  const d0 = dpfSrc[x2];
                  if (d0 === 0 || (d0 === 1 ? k < pf1P : k < pf2P)) fb[rowOff + x2] = abgr;
                  const d1 = dpfSrc[x2 + 1];
                  if (d1 === 0 || (d1 === 1 ? k < pf1P : k < pf2P)) fb[rowOff + x2 + 1] = abgr;
                }
              }
            }
          } else {
            const baseColorO = oddPalBank + (k << 2);
            const baseColorE = evenPalBank + (k << 2);
            if (oOn) {
              const datA = this.sprData[o];
              const datB = this.sprDatb[o];
              for (let bit = 15; bit >= 0; bit--) {
                const pxCol = ((datA >>> bit) & 1) | (((datB >>> bit) & 1) << 1);
                if (pxCol === 0) continue;
                const sx = hO + (15 - bit);
                if (trackAutoBrdr) {
                  const absLo = hOriginLo + sx;
                  if (absLo < drawnMinLo) drawnMinLo = absLo;
                  if (absLo + 1 > drawnMaxLo) drawnMaxLo = absLo + 1;
                }
                if (sx < clipMinLo || sx >= clipMaxLo) continue;
                if (oddEnSp) {
                  this.recordSprCol(sx, k, emptyBg, diwHStartLo, diwHStopLo, colPlanes, clxEnMask, clxMvMask, clxOddEn, clxEvenEn);
                }
                const abgr = colors[baseColorO + pxCol];
                const x2 = sx << 1;
                if (emptyBg) {
                  fb[rowOff + x2] = abgr;
                  fb[rowOff + x2 + 1] = abgr;
                } else if (!dpf) {
                  if (indices[x2] === 0 || k < pf2P) fb[rowOff + x2] = abgr;
                  if (indices[x2 + 1] === 0 || k < pf2P) fb[rowOff + x2 + 1] = abgr;
                } else {
                  const d0 = dpfSrc[x2];
                  if (d0 === 0 || (d0 === 1 ? k < pf1P : k < pf2P)) fb[rowOff + x2] = abgr;
                  const d1 = dpfSrc[x2 + 1];
                  if (d1 === 0 || (d1 === 1 ? k < pf1P : k < pf2P)) fb[rowOff + x2 + 1] = abgr;
                }
              }
            }
            if (eOn) {
              const datA = this.sprData[e];
              const datB = this.sprDatb[e];
              for (let bit = 15; bit >= 0; bit--) {
                const pxCol = ((datA >>> bit) & 1) | (((datB >>> bit) & 1) << 1);
                if (pxCol === 0) continue;
                const sx = hE + (15 - bit);
                if (trackAutoBrdr) {
                  const absLo = hOriginLo + sx;
                  if (absLo < drawnMinLo) drawnMinLo = absLo;
                  if (absLo + 1 > drawnMaxLo) drawnMaxLo = absLo + 1;
                }
                if (sx < clipMinLo || sx >= clipMaxLo) continue;
                this.recordSprCol(sx, k, emptyBg, diwHStartLo, diwHStopLo, colPlanes, clxEnMask, clxMvMask, clxOddEn, clxEvenEn);
                const abgr = colors[baseColorE + pxCol];
                const x2 = sx << 1;
                if (emptyBg) {
                  fb[rowOff + x2] = abgr;
                  fb[rowOff + x2 + 1] = abgr;
                } else if (!dpf) {
                  if (indices[x2] === 0 || k < pf2P) fb[rowOff + x2] = abgr;
                  if (indices[x2 + 1] === 0 || k < pf2P) fb[rowOff + x2 + 1] = abgr;
                } else {
                  const d0 = dpfSrc[x2];
                  if (d0 === 0 || (d0 === 1 ? k < pf1P : k < pf2P)) fb[rowOff + x2] = abgr;
                  const d1 = dpfSrc[x2 + 1];
                  if (d1 === 0 || (d1 === 1 ? k < pf1P : k < pf2P)) fb[rowOff + x2 + 1] = abgr;
                }
              }
            }
          }
        } else {
          // AGA 32px / 64px wide LoRes sprites (FMODE sprite width 2x / 4x)
          if (attached) {
            let minSx = viewLoWidth;
            let maxSx = -64;
            if (eOn) {
              if (hE < minSx) minSx = hE;
              if (hE + sprWidth > maxSx) maxSx = hE + sprWidth;
            }
            if (oOn) {
              if (hO < minSx) minSx = hO;
              if (hO + sprWidth > maxSx) maxSx = hO + sprWidth;
            }
            if (!trackAutoBrdr) {
              if (minSx < clipMinLo) minSx = clipMinLo;
              if (maxSx > clipMaxLo) maxSx = clipMaxLo;
            }
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
              if (trackAutoBrdr) {
                const absLo = hOriginLo + sx;
                if (absLo < drawnMinLo) drawnMinLo = absLo;
                if (absLo + 1 > drawnMaxLo) drawnMaxLo = absLo + 1;
              }
              if (sx < clipMinLo || sx >= clipMaxLo) continue;
              if ((col4 & 3) !== 0 || (oddEnSp && (col4 & 12) !== 0)) {
                this.recordSprCol(sx, k, emptyBg, diwHStartLo, diwHStopLo, colPlanes, clxEnMask, clxMvMask, clxOddEn, clxEvenEn);
              }
              const abgr = colors[oddPalBank + col4];
              const x2 = sx << 1;
              if (emptyBg) {
                fb[rowOff + x2] = abgr;
                fb[rowOff + x2 + 1] = abgr;
              } else if (!dpf) {
                if (indices[x2] === 0 || k < pf2P) fb[rowOff + x2] = abgr;
                if (indices[x2 + 1] === 0 || k < pf2P) fb[rowOff + x2 + 1] = abgr;
              } else {
                const d0 = dpfSrc[x2];
                if (d0 === 0 || (d0 === 1 ? k < pf1P : k < pf2P)) fb[rowOff + x2] = abgr;
                const d1 = dpfSrc[x2 + 1];
                if (d1 === 0 || (d1 === 1 ? k < pf1P : k < pf2P)) fb[rowOff + x2 + 1] = abgr;
              }
            }
          } else {
            if (oOn) {
              const baseColorO = oddPalBank + (k << 2);
              for (let dx = 0; dx < sprWidth; dx++) {
                const sx = hO + dx;
                const wA = dx < 32 ? this.sprDataLo[o] : this.sprDataHi[o];
                const wB = dx < 32 ? this.sprDatbLo[o] : this.sprDatbHi[o];
                const bit = 31 - (dx & 31);
                const pxCol = ((wA >>> bit) & 1) | (((wB >>> bit) & 1) << 1);
                if (pxCol === 0) continue;
                if (trackAutoBrdr) {
                  const absLo = hOriginLo + sx;
                  if (absLo < drawnMinLo) drawnMinLo = absLo;
                  if (absLo + 1 > drawnMaxLo) drawnMaxLo = absLo + 1;
                }
                if (sx < clipMinLo || sx >= clipMaxLo) continue;
                if (oddEnSp) {
                  this.recordSprCol(sx, k, emptyBg, diwHStartLo, diwHStopLo, colPlanes, clxEnMask, clxMvMask, clxOddEn, clxEvenEn);
                }
                const abgr = colors[baseColorO + pxCol];
                const x2 = sx << 1;
                if (emptyBg) {
                  fb[rowOff + x2] = abgr;
                  fb[rowOff + x2 + 1] = abgr;
                } else if (!dpf) {
                  if (indices[x2] === 0 || k < pf2P) fb[rowOff + x2] = abgr;
                  if (indices[x2 + 1] === 0 || k < pf2P) fb[rowOff + x2 + 1] = abgr;
                } else {
                  const d0 = dpfSrc[x2];
                  if (d0 === 0 || (d0 === 1 ? k < pf1P : k < pf2P)) fb[rowOff + x2] = abgr;
                  const d1 = dpfSrc[x2 + 1];
                  if (d1 === 0 || (d1 === 1 ? k < pf1P : k < pf2P)) fb[rowOff + x2 + 1] = abgr;
                }
              }
            }
            if (eOn) {
              const baseColorE = evenPalBank + (k << 2);
              for (let dx = 0; dx < sprWidth; dx++) {
                const sx = hE + dx;
                const wA = dx < 32 ? this.sprDataLo[e] : this.sprDataHi[e];
                const wB = dx < 32 ? this.sprDatbLo[e] : this.sprDatbHi[e];
                const bit = 31 - (dx & 31);
                const pxCol = ((wA >>> bit) & 1) | (((wB >>> bit) & 1) << 1);
                if (pxCol === 0) continue;
                if (trackAutoBrdr) {
                  const absLo = hOriginLo + sx;
                  if (absLo < drawnMinLo) drawnMinLo = absLo;
                  if (absLo + 1 > drawnMaxLo) drawnMaxLo = absLo + 1;
                }
                if (sx < clipMinLo || sx >= clipMaxLo) continue;
                this.recordSprCol(sx, k, emptyBg, diwHStartLo, diwHStopLo, colPlanes, clxEnMask, clxMvMask, clxOddEn, clxEvenEn);
                const abgr = colors[baseColorE + pxCol];
                const x2 = sx << 1;
                if (emptyBg) {
                  fb[rowOff + x2] = abgr;
                  fb[rowOff + x2 + 1] = abgr;
                } else if (!dpf) {
                  if (indices[x2] === 0 || k < pf2P) fb[rowOff + x2] = abgr;
                  if (indices[x2 + 1] === 0 || k < pf2P) fb[rowOff + x2 + 1] = abgr;
                } else {
                  const d0 = dpfSrc[x2];
                  if (d0 === 0 || (d0 === 1 ? k < pf1P : k < pf2P)) fb[rowOff + x2] = abgr;
                  const d1 = dpfSrc[x2 + 1];
                  if (d1 === 0 || (d1 === 1 ? k < pf1P : k < pf2P)) fb[rowOff + x2 + 1] = abgr;
                }
              }
            }
          }
        }
      } else {
        // ECS/AGA Hi-Res / SHRES / 70ns subpixel sprite path
        const sprStepShift = sprPxRes === 2 ? 1 : 0;
        const maxWordShift = sprWidth === 16 ? 15 : 31;
        if (attached) {
          const spanHi = (sprWidth >> sprStepShift) * pxWidthHi;
          let minXHi = clipMaxHi;
          let maxXHi = clipMinHi;
          if (eOn) {
            if (hHiE < minXHi) minXHi = hHiE;
            if (hHiE + spanHi > maxXHi) maxXHi = hHiE + spanHi;
          }
          if (oOn) {
            if (hHiO < minXHi) minXHi = hHiO;
            if (hHiO + spanHi > maxXHi) maxXHi = hHiO + spanHi;
          }
          if (!trackAutoBrdr) {
            if (minXHi < clipMinHi) minXHi = clipMinHi;
            if (maxXHi > clipMaxHi) maxXHi = clipMaxHi;
          }
          for (let hx = minXHi; hx < maxXHi; hx += pxWidthHi) {
            let col4 = 0;
            if (eOn) {
              const de = pxWidthHi === 2 ? (hx - hHiE) >> 1 : ((hx - hHiE) << sprStepShift);
              if (de >= 0 && de < sprWidth) {
                const wA = sprWidth === 16 ? this.sprData[e] : de < 32 ? this.sprDataLo[e] : this.sprDataHi[e];
                const wB = sprWidth === 16 ? this.sprDatb[e] : de < 32 ? this.sprDatbLo[e] : this.sprDatbHi[e];
                const bit = maxWordShift - (de & maxWordShift);
                col4 |= ((wA >>> bit) & 1) | (((wB >>> bit) & 1) << 1);
              }
            }
            if (oOn) {
              const dOdd = pxWidthHi === 2 ? (hx - hHiO) >> 1 : ((hx - hHiO) << sprStepShift);
              if (dOdd >= 0 && dOdd < sprWidth) {
                const wA = sprWidth === 16 ? this.sprData[o] : dOdd < 32 ? this.sprDataLo[o] : this.sprDataHi[o];
                const wB = sprWidth === 16 ? this.sprDatb[o] : dOdd < 32 ? this.sprDatbLo[o] : this.sprDatbHi[o];
                const bit = maxWordShift - (dOdd & maxWordShift);
                col4 |= (((wA >>> bit) & 1) << 2) | (((wB >>> bit) & 1) << 3);
              }
            }
            if (col4 === 0) continue;
            if (trackAutoBrdr) {
              const abs0 = hOriginLo + (hx >> 1);
              const abs1 = hOriginLo + ((hx + pxWidthHi + 1) >> 1);
              if (abs0 < drawnMinLo) drawnMinLo = abs0;
              if (abs1 > drawnMaxLo) drawnMaxLo = abs1;
            }
            if (hx + pxWidthHi <= clipMinHi || hx >= clipMaxHi) continue;
            const sx = hx >> 1;
            if (sx >= 0 && sx < viewLoWidth && ((col4 & 3) !== 0 || (oddEnSp && (col4 & 12) !== 0))) {
              this.recordSprCol(sx, k, emptyBg, diwHStartLo, diwHStopLo, colPlanes, clxEnMask, clxMvMask, clxOddEn, clxEvenEn);
            }
            const abgr = colors[oddPalBank + col4];
            for (let sub = 0; sub < pxWidthHi; sub++) {
              const px = hx + sub;
              if (px < clipMinHi || px >= clipMaxHi) continue;
              if (emptyBg) {
                fb[rowOff + px] = abgr;
              } else if (!dpf) {
                if (indices[px] === 0 || k < pf2P) fb[rowOff + px] = abgr;
              } else {
                const d = dpfSrc[px];
                if (d === 0 || (d === 1 ? k < pf1P : k < pf2P)) fb[rowOff + px] = abgr;
              }
            }
          }
        } else {
          if (oOn) {
            const baseColorO = oddPalBank + (k << 2);
            for (let dx = 0; dx < sprWidth; dx += dxStep) {
              const wA = sprWidth === 16 ? this.sprData[o] : dx < 32 ? this.sprDataLo[o] : this.sprDataHi[o];
              const wB = sprWidth === 16 ? this.sprDatb[o] : dx < 32 ? this.sprDatbLo[o] : this.sprDatbHi[o];
              const bit = maxWordShift - (dx & maxWordShift);
              const pxCol = ((wA >>> bit) & 1) | (((wB >>> bit) & 1) << 1);
              if (pxCol === 0) continue;
              const hx = hHiO + (pxWidthHi === 2 ? dx << 1 : (dx >>> sprStepShift));
              if (trackAutoBrdr) {
                const abs0 = hOriginLo + (hx >> 1);
                const abs1 = hOriginLo + ((hx + pxWidthHi + 1) >> 1);
                if (abs0 < drawnMinLo) drawnMinLo = abs0;
                if (abs1 > drawnMaxLo) drawnMaxLo = abs1;
              }
              if (hx + pxWidthHi <= clipMinHi || hx >= clipMaxHi) continue;
              const sx = hx >> 1;
              if (oddEnSp && sx >= 0 && sx < viewLoWidth) {
                this.recordSprCol(sx, k, emptyBg, diwHStartLo, diwHStopLo, colPlanes, clxEnMask, clxMvMask, clxOddEn, clxEvenEn);
              }
              const abgr = colors[baseColorO + pxCol];
              for (let sub = 0; sub < pxWidthHi; sub++) {
                const px = hx + sub;
                if (px < clipMinHi || px >= clipMaxHi) continue;
                if (emptyBg) {
                  fb[rowOff + px] = abgr;
                } else if (!dpf) {
                  if (indices[px] === 0 || k < pf2P) fb[rowOff + px] = abgr;
                } else {
                  const d = dpfSrc[px];
                  if (d === 0 || (d === 1 ? k < pf1P : k < pf2P)) fb[rowOff + px] = abgr;
                }
              }
            }
          }
          if (eOn) {
            const baseColorE = evenPalBank + (k << 2);
            for (let dx = 0; dx < sprWidth; dx += dxStep) {
              const wA = sprWidth === 16 ? this.sprData[e] : dx < 32 ? this.sprDataLo[e] : this.sprDataHi[e];
              const wB = sprWidth === 16 ? this.sprDatb[e] : dx < 32 ? this.sprDatbLo[e] : this.sprDatbHi[e];
              const bit = maxWordShift - (dx & maxWordShift);
              const pxCol = ((wA >>> bit) & 1) | (((wB >>> bit) & 1) << 1);
              if (pxCol === 0) continue;
              const hx = hHiE + (pxWidthHi === 2 ? dx << 1 : (dx >>> sprStepShift));
              if (trackAutoBrdr) {
                const abs0 = hOriginLo + (hx >> 1);
                const abs1 = hOriginLo + ((hx + pxWidthHi + 1) >> 1);
                if (abs0 < drawnMinLo) drawnMinLo = abs0;
                if (abs1 > drawnMaxLo) drawnMaxLo = abs1;
              }
              if (hx + pxWidthHi <= clipMinHi || hx >= clipMaxHi) continue;
              const sx = hx >> 1;
              if (sx >= 0 && sx < viewLoWidth) {
                this.recordSprCol(sx, k, emptyBg, diwHStartLo, diwHStopLo, colPlanes, clxEnMask, clxMvMask, clxOddEn, clxEvenEn);
              }
              const abgr = colors[baseColorE + pxCol];
              for (let sub = 0; sub < pxWidthHi; sub++) {
                const px = hx + sub;
                if (px < clipMinHi || px >= clipMaxHi) continue;
                if (emptyBg) {
                  fb[rowOff + px] = abgr;
                } else if (!dpf) {
                  if (indices[px] === 0 || k < pf2P) fb[rowOff + px] = abgr;
                } else {
                  const d = dpfSrc[px];
                  if (d === 0 || (d === 1 ? k < pf1P : k < pf2P)) fb[rowOff + px] = abgr;
                }
              }
            }
          }
        }
      }
    }

    if (trackAutoBrdr && drawnMaxLo > drawnMinLo) {
      this.frameDiwActive = true;
      if (drawnMinLo < this.frameDiwMinH) this.frameDiwMinH = drawnMinLo;
      if (drawnMaxLo > this.frameDiwMaxH) this.frameDiwMaxH = drawnMaxLo;
      const minRas = this.isPalTiming() ? 26 : 22;
      const maxRas = this.isPalTiming() ? 312 : 262;
      if (line >= minRas && line < maxRas) {
        if (line < this.frameDiwMinV) this.frameDiwMinV = line;
        if (line + 1 > this.frameDiwMaxV) this.frameDiwMaxV = line + 1;
      }
    }

    if (this.sprColMaxSx > this.sprColMinSx) {
      this.sprColMask.fill(0, this.sprColMinSx, this.sprColMaxSx);
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
    const ddfMask = this.chipset !== 'OCS' ? 0x01fe : 0x00fc;
    this.ddfStrt = (this.regs[0x092 >>> 1] & ddfMask) || 0x0038;
    this.ddfStop = (this.regs[0x094 >>> 1] & ddfMask) || 0x00d0;
    this.bpl1Mod = ((this.regs[0x108 >>> 1] & 0xfffe) << 16) >> 16;
    this.bpl2Mod = ((this.regs[0x10a >>> 1] & 0xfffe) << 16) >> 16;
    this.bplCon3 = this.chipset !== 'OCS' ? this.regs[0x106 >>> 1] : 0x0c00;
    this.bplCon4 = this.chipset === 'AGA' ? this.regs[0x10c >>> 1] : 0x0011;
    this.fmode = this.chipset === 'AGA' ? this.regs[0x1fc >>> 1] : 0;
    this.clxCon = this.regs[0x098 >>> 1];
    this.clxCon2 = this.chipset !== 'OCS' ? this.regs[0x10e >>> 1] : 0;
    this.clxDat = 0;
    this.potGo = this.regs[0x034 >>> 1] & 0xff00;
    this.sprColMask.fill(0);
    this.diwVStart = (this.diwStrt >>> 8) & 0xff;
    this.diwHStart = this.diwStrt & 0xff;
    const vs = (this.diwStop >>> 8) & 0xff;
    this.diwVStop = (vs & 0x80) === 0 ? (vs | 0x100) : vs;
    this.diwHStop = (this.diwStop & 0xff) | 0x100;
    this.diwHigh = this.regs[0x1e4 >>> 1];
    this.diwHighWritten = false;
    this.diwHStartSubHi = 0;
    this.diwHStopSubHi = 0;
    this.vdiwActive = false;
    this.vdiwStateLine = -1;
    this.sprSteppedLine = -1;
    this.sprMuxCount = 0;
    this.lineSplitCount = 0;
    this.lineStartCaptured = false;
    this.bplDatWrittenOnLine = false;
    this.inSync = false;
    if (this.chipset !== 'OCS' && this.diwHigh !== 0) {
      const vMask = this.chipset === 'AGA' ? 7 : 15;
      const hiVStart = ((this.diwStrt >>> 8) & 0xff) | ((this.diwHigh & vMask) << 8);
      const hiHStart = (this.diwStrt & 0xff) | ((this.diwHigh & 0x20) << 3);
      const hiVStop = ((this.diwStop >>> 8) & 0xff) | (this.diwHigh & (vMask << 8));
      const hiHStop = (this.diwStop & 0xff) | ((this.diwHigh & 0x2000) >>> 5);
      this.diwHighWritten = true;
      this.diwVStart = hiVStart;
      this.diwHStart = hiHStart;
      if ((this.diwHigh & (vMask << 8)) !== 0 || (vs & 0x80) !== 0 || hiVStop > hiVStart) {
        this.diwVStop = hiVStop;
      }
      this.diwHStop = hiHStop;
      if (this.chipset === 'AGA') {
        this.diwHStartSubHi = (this.diwHigh >>> 4) & 1;
        this.diwHStopSubHi = (this.diwHigh >>> 12) & 1;
      }
    }
    this.audDatClocksLeft.fill(0);
    this.audDatPendingMask = 0;
    this.audStartPendingMask = 0;
    this.audStartClocksLeft.fill(0);
    this.audClockRem.fill(0);
    this.audioSteppedInFrame = false;
    this.frameAudClocks = 0;
    this.audSawActivityInFrame = false;
    this.audSnapActive.fill(0);
    this.audEvtCount = 0;
    const audioMaster = (this.dmacon & DMA_MASTER) !== 0;
    for (let i = 0; i < 4; i++) {
      const regBase = (0x0a0 >>> 1) + (i << 3);
      const lc = ((this.regs[regBase] & 0x1f) << 16) | (this.regs[regBase + 1] & 0xfffe);
      const lenReg = this.regs[regBase + 2];
      const perReg = this.regs[regBase + 3];
      const volReg = this.regs[regBase + 4] & 0x7f;
      const ch = this.audio[i];
      ch.lc = lc;
      ch.len = lenReg === 0 ? 0x10000 : lenReg;
      this.audRawPer[i] = perReg === 0 ? 65536 : perReg;
      ch.per = perReg < 124 ? 124 : perReg;
      ch.vol = volReg > 64 ? 64 : volReg;
      const nowOn = audioMaster && (this.dmacon & (1 << i)) !== 0;
      ch.active = nowOn;
      ch.curAddr = lc;
      ch.wordsLeft = nowOn ? ch.len : 0;
      ch.phase = 0;
      ch.lastSample = 0;
    }
    this.bltPending = false;
    this.bltDoneCycle = 0;
    this.bltActive = false;
    this.bltCckAccum = 0;
    this.bltLastSyncHpos = 0;
    this.copWaitBlit = false;
    this.copDeferredLine = -1;
    this.missingVideoDmaFrames = 0;
    this.hadVideoDmaSinceCopWrite = (this.dmacon & (DMA_MASTER | DMA_COPPER | DMA_BITPLANE)) !== 0;
    this.rescuedMissingDmaCop1lc = 0;
    this.updateIpl();
  }
}

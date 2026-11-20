/**
 * Commodore Amiga OCS / ECS Custom Chipset (Agnus, Denise, Paula).
 * Optimized for minimal host CPU load:
 * - Zero heap allocations in scanline / Copper / Blitter / Denise loops
 * - Precomputed 4096-entry 12-bit RGB -> ABGR32 LUT & EHB half-brite LUT
 * - Full 640x256 framebuffer (sharp Hi-Res Workbench + pixel-doubled Lo-Res games)
 * - Supports 1-6 bitplanes, EHB (64 colors), HAM6 (4096 colors), Dual Playfield, 8 Hardware Sprites
 */

import { ChipsetModel, JoystickState, OverscanMode, VideoStandard } from '../types';
import { FloppyController } from './floppy';
import {
  AutoOverscanTracker,
  copyPresetViewport,
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

export class AmigaChipset {
  public chipset: ChipsetModel = 'ECS';
  public videoStandard: VideoStandard = 'PAL';
  public overscanMode: OverscanMode = 'auto';

  // Raw custom register mirror ($DFF000 - $DFF1FE, 256 words)
  public readonly regs = new Uint16Array(256);

  // Core control registers
  public dmacon = 0;
  public intena = 0;
  public intreq = 0;
  public adkcon = 0;

  // Beam position
  public vpos = 0;
  public hpos = 0;
  public lof = 1; // Long frame toggle (stays 1 when non-interlaced; toggles when BPLCON0 LACE=1)
  public beamCon0 = 0x0020; // ECS BEAMCON0 bit 5 = PAL timing

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

  // Bitplane & Display window registers
  public readonly bplPt = new Uint32Array(6);
  public bplCon0 = 0;
  public bplCon1 = 0;
  public bplCon2 = 0x0024;
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

  // 32 hardware color registers (12-bit RGB444) + cached ABGR32 values
  public readonly colorReg = new Uint16Array(32);
  public readonly colorAbgr = new Uint32Array(32);
  public readonly colorEhbAbgr = new Uint32Array(32);

  // 8 Hardware Sprites
  public readonly sprPt = new Uint32Array(8);
  public readonly sprPos = new Uint16Array(8);
  public readonly sprCtl = new Uint16Array(8);
  public readonly sprData = new Uint16Array(8);
  public readonly sprDatb = new Uint16Array(8);
  private readonly sprArmed = new Uint8Array(8);         // Manual SPRxDATA arm
  private readonly sprDmaOn = new Uint8Array(8);         // Agnus DMA active for frame/chain
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
  public turboFloppy = false;
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
  private static readonly MAX_MIDLINE_COLOR_CHANGES = 128;
  private readonly midlineColorX = new Uint16Array(AmigaChipset.MAX_MIDLINE_COLOR_CHANGES);
  private readonly midlineColorIdx = new Uint8Array(AmigaChipset.MAX_MIDLINE_COLOR_CHANGES);
  private readonly midlineColorVal = new Uint16Array(AmigaChipset.MAX_MIDLINE_COLOR_CHANGES);
  private readonly lineStartColorAbgr = new Uint32Array(32);
  private readonly lineStartColorEhb = new Uint32Array(32);
  private readonly workColorAbgr = new Uint32Array(32);
  private readonly workColorEhb = new Uint32Array(32);
  private midlineColorCount = 0;
  private midlinePaletteSaved = false;
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
    videoStandard: VideoStandard,
    forceResetAuto = false
  ): void {
    const modeChanged = this.overscanMode !== mode;
    const stdChanged = this.videoStandard !== videoStandard;
    this.overscanMode = mode;
    this.videoStandard = videoStandard;
    if (stdChanged) {
      this.beamCon0 = videoStandard === 'PAL' ? 0x0020 : 0x0000;
    }

    if (mode === 'auto') {
      if (forceResetAuto || modeChanged || stdChanged) {
        this.pendingAutoViewport = false;
        this.autoOverscan.reset(videoStandard);
        this.applyViewport(this.autoOverscan.current);
      }
    } else {
      this.pendingAutoViewport = false;
      copyPresetViewport(mode, videoStandard, this.presetScratch);
      this.applyViewport(this.presetScratch);
    }
  }

  public isPalTiming(): boolean {
    return this.chipset === 'ECS'
      ? (this.beamCon0 & 0x0020) !== 0
      : this.videoStandard === 'PAL';
  }

  public reset(): void {
    this.regs.fill(0);
    this.dmacon = 0;
    this.intena = 0;
    this.intreq = 0;
    this.adkcon = 0;
    this.vpos = 0;
    this.hpos = 0;
    this.lof = 1;
    this.beamCon0 = this.videoStandard === 'PAL' ? 0x0020 : 0x0000;
    this.midlineColorCount = 0;
    this.midlinePaletteSaved = false;
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
    for (let i = 0; i < 32; i++) {
      this.colorAbgr[i] = RGB12_TO_ABGR32[0];
      this.colorEhbAbgr[i] = RGB12_TO_EHB32[0];
    }

    this.sprPt.fill(0);
    this.sprPos.fill(0);
    this.sprCtl.fill(0);
    this.sprData.fill(0);
    this.sprDatb.fill(0);
    this.sprArmed.fill(0);
    this.sprDmaOn.fill(0);
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

  public requestIrq(bits: number): void {
    this.intreq |= bits & 0x3fff;
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
        let id = 0x00;
        if (this.chipset === 'ECS') id |= 0x20;
        if (this.videoStandard === 'NTSC') id |= 0x10;
        return ((this.lof & 1) << 15) | (id << 8) | ((this.vpos >>> 8) & 1);
      }
      case 0x006: // VHPOSR
        return ((this.vpos & 0xff) << 8) | (this.hpos & 0xff);
      case 0x00a: // JOY0DAT (Mouse Y high byte, X low byte)
        return ((this.mouseY & 0xff) << 8) | (this.mouseX & 0xff);
      case 0x00c: // JOY1DAT (Joystick port 2)
        return this.encodeJoy1Dat();
      case 0x00e: // CLXDAT
        return 0;
      case 0x010: // ADKCONR
        return this.adkcon & 0x7fff;
      case 0x016: { // POTGOR / POTINP (active-low secondary mouse/joy buttons)
        let val = 0x5500;
        if (this.mouseRight) val &= ~0x0400;  // Port 0 RMB (bit 10)
        if (this.mouseMiddle) val &= ~0x0100; // Port 0 MMB (bit 8)
        if (this.joy1Connected && this.joy1.fire2) val &= ~0x4000;  // Port 1 Fire 2 (bit 14)
        return val;
      }
      case 0x018: // SERDATR (TBE=1, TSRE=1)
        return 0x3000;
      case 0x01a: // DSKBYTR
        return 0x8000;
      case 0x01c: // INTENAR
        return this.intena & 0x7fff;
      case 0x01e: // INTREQR
        return this.intreq & 0x7fff;
      case 0x07c: // DENISEID (OCS = $FFFF open bus, ECS = $00FC)
        return this.chipset === 'ECS' ? 0x00fc : 0xffff;
      default:
        return this.regs[reg >>> 1];
    }
  }

  public writeReg16(offset: number, val: number): void {
    const reg = offset & 0x1fe;
    const v = val & 0xffff;
    this.regs[reg >>> 1] = v;

    // Color registers $180 - $1BE (fast hot path)
    if (reg >= 0x180 && reg <= 0x1be) {
      const idx = (reg - 0x180) >>> 1;
      const c12 = v & 0x0fff;
      if (this.inCopperVisibleSpan) {
        const pxX = (((this.copHpos - 2) << 1) - this.viewHOriginLo) << 1;
        if (pxX > 0 && this.midlineColorCount < AmigaChipset.MAX_MIDLINE_COLOR_CHANGES) {
          if (!this.midlinePaletteSaved) {
            this.lineStartColorAbgr.set(this.colorAbgr);
            if ((this.bplCon0 & 0x0c00) === 0 && ((this.bplCon0 >>> 12) & 7) === 6) {
              this.lineStartColorEhb.set(this.colorEhbAbgr);
            }
            this.midlinePaletteSaved = true;
          }
          const n = this.midlineColorCount++;
          this.midlineColorX[n] = pxX;
          this.midlineColorIdx[n] = idx;
          this.midlineColorVal[n] = c12;
        }
      }
      this.colorReg[idx] = c12;
      this.colorAbgr[idx] = RGB12_TO_ABGR32[c12];
      this.colorEhbAbgr[idx] = RGB12_TO_EHB32[c12];
      return;
    }

    // Bitplane pointers $0E0 - $0F6
    if (reg >= 0x0e0 && reg <= 0x0f6) {
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
        if (this.sprHeadersFetchedThisFrame) {
          this.sprDmaOn[idx] =
            this.sprPt[idx] !== 0 && (this.sprPos[idx] !== 0 || v !== 0) ? 1 : 0;
        }
      } else if (sub === 2) {
        this.sprData[idx] = v;
        this.sprArmed[idx] = 1;
      } else {
        this.sprDatb[idx] = v;
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
        } else if ((prev & 0x8000) !== 0) {
          const wordCount = v & 0x3fff;
          if (wordCount > 0 && (this.dmacon & (DMA_MASTER | DMA_DISK)) === (DMA_MASTER | DMA_DISK)) {
            this.dskDmaActive = true;
            this.dskDmaWordsLeft = wordCount;
            this.dskDmaWrite = (v & 0x4000) !== 0;
            this.dskDmaNeedSync = (this.adkcon & 0x0400) !== 0;
            // Authentic Paula startup latency (~128us) so immediate DSKLEN=$4000 aborts never disturb head position
            this.dskDmaDelay = this.turboFloppy ? 1 : 2;
            if (this.dskDmaWrite) {
              this.floppy.beginDiskDmaWrite();
            }
          }
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
      case 0x082: this.cop1lc = (this.cop1lc & 0x1f0000) | (v & 0xfffe); break;
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
        const vs = (v >>> 8) & 0xff;
        this.diwVStop = (vs & 0x80) === 0 ? (vs | 0x100) : vs;
        this.diwHStop = (v & 0xff) | 0x100;
        break;
      }
      case 0x092: this.ddfStrt = v & 0x00fc; break;
      case 0x094: this.ddfStop = v & 0x00fc; break;
      case 0x096: { // DMACON
        const prev = this.dmacon;
        if (v & 0x8000) this.dmacon |= v & 0x07ff;
        else this.dmacon &= ~(v & 0x07ff);
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
        this.updateIpl();
        break;
      case 0x09c: // INTREQ
        if (v & 0x8000) this.intreq |= v & 0x3fff;
        else this.intreq &= ~(v & 0x3fff);
        this.updateIpl();
        break;
      case 0x09e: // ADKCON
        if (v & 0x8000) this.adkcon |= v & 0x7fff;
        else this.adkcon &= ~(v & 0x7fff);
        break;
      case 0x100: this.bplCon0 = v; break;
      case 0x102: this.bplCon1 = v; break;
      case 0x104: this.bplCon2 = v; break;
      case 0x108: this.bpl1Mod = (v << 16) >> 16; break;
      case 0x10a: this.bpl2Mod = (v << 16) >> 16; break;
      case 0x1dc: // ECS BEAMCON0
        if (this.chipset === 'ECS') {
          this.beamCon0 = v;
        }
        break;
      case 0x1e4:
        this.diwHigh = v;
        if (this.chipset === 'ECS') {
          this.diwVStart = ((this.diwStrt >>> 8) & 0xff) | ((v & 0x07) << 8);
          this.diwHStart = (this.diwStrt & 0xff) | ((v & 0x20) << 3);
          this.diwVStop = ((this.diwStop >>> 8) & 0xff) | (v & 0x0700);
          this.diwHStop = (this.diwStop & 0xff) | ((v & 0x2000) >>> 5);
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

    if (this.dskDmaWrite) {
      const chunk = Math.min(maxWords, this.dskDmaWordsLeft);
      this.floppy.streamDiskDmaWriteWords(this.dskPt, chunk, this.readChip16Bound);
      this.dskPt = (this.dskPt + (chunk << 1)) & 0x001ffffe;
      this.dskDmaWordsLeft -= chunk;
      if (this.dskDmaWordsLeft <= 0) {
        this.floppy.finishDiskDmaWrite();
        this.dskDmaActive = false;
        this.requestIrq(INT_DSKBLK);
      }
      return;
    }

    if (this.dskDmaNeedSync) {
      if (!this.floppy.alignToWordSync(this.dskSync)) {
        return; // No disk / no sync word yet
      }
      this.dskDmaNeedSync = false;
      this.requestIrq(INT_DSKSYN);
    }

    const chunk = Math.min(maxWords, this.dskDmaWordsLeft);
    const read = this.floppy.streamDiskDmaWords(this.dskPt, chunk, this.writeChip16Bound);
    if (read <= 0) {
      this.dskDmaActive = false;
      this.requestIrq(INT_DSKBLK);
      return;
    }
    this.dskPt = (this.dskPt + (read << 1)) & 0x001ffffe;
    this.dskDmaWordsLeft -= read;
    if (this.dskDmaWordsLeft <= 0) {
      this.dskDmaActive = false;
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
    // Authentic Agnus LOF: toggles every frame when interlaced (BPLCON0 LACE=1), stays 1 (long frame) otherwise
    this.lof = (this.bplCon0 & 0x0004) !== 0 ? (this.lof ^ 1) : 1;
    this.midlineColorCount = 0;
    this.midlinePaletteSaved = false;
    this.inCopperVisibleSpan = false;
    this.copPc = this.cop1lc;
    this.copWaiting = false;
    this.copSkipNext = false;
    this.copHpos = 0;
    this.sprHeadersFetchedThisFrame = false;
    this.sprDmaOn.fill(0);
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
   */
  public fetchSpriteHeaders(): void {
    this.sprHeadersFetchedThisFrame = true;
    this.sprArmed.fill(0);
    this.sprDmaLineActive.fill(0);
    if ((this.dmacon & (DMA_MASTER | DMA_SPRITE)) === (DMA_MASTER | DMA_SPRITE)) {
      for (let s = 0; s < 8; s++) {
        const ptr = this.sprPt[s];
        if (ptr !== 0) {
          const pos = this.readChip16(ptr);
          const ctl = this.readChip16(ptr + 2);
          this.sprPos[s] = pos;
          this.sprCtl[s] = ctl;
          this.sprPt[s] = (ptr + 4) & this.chipMask;
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
      else this.midlineColorCount = 0;
      return;
    }
    const visiblePass = maxHpos < 0xfe;
    if (visiblePass) {
      this.midlineColorCount = 0;
      this.midlinePaletteSaved = false;
      this.inCopperVisibleSpan = true;
    }
    const vp = line & 0xff;
    let guard = 0;

    while (guard++ < 256) {
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
        if (maskedVp === targetVp && waitHMasked > maxHpos) {
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
          this.consumeDuplicatePalWrapWaits();
          if (maxHpos >= 0xfe) this.copHpos = 0;
          this.inCopperVisibleSpan = false;
          return;
        }
      }

      if (this.copHpos > maxHpos) {
        if (maxHpos >= 0xfe) this.copHpos = 0;
        this.inCopperVisibleSpan = false;
        return;
      }

      const ir1 = this.readChip16(this.copPc);
      const ir2 = this.readChip16(this.copPc + 2);
      this.copPc = (this.copPc + 4) & this.chipMask;

      if ((ir1 & 1) === 0) {
        // MOVE instruction consumes 4 color clocks (2 bus cycles = 8 hi-res px)
        this.copHpos += 4;
        const reg = ir1 & 0x01fe;
        if (this.copSkipNext) {
          this.copSkipNext = false;
          continue;
        }
        // Copper cannot write below $040 (or $080 if CDANG=0)
        const minReg = (this.copCon & 2) !== 0 ? 0x040 : 0x080;
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
            (maskedVp === targetVp && waitHMasked > maxHpos)
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
            this.consumeDuplicatePalWrapWaits();
            if (maxHpos >= 0xfe) this.copHpos = 0;
            this.inCopperVisibleSpan = false;
            return;
          }
        } else {
          // SKIP
          const maskedVp = vp & maskV;
          const targetVp = waitV & maskV;
          const skip =
            maskedVp > targetVp ||
            (maskedVp === targetVp && (waitH & maskH) <= maxHpos);
          this.copSkipNext = skip;
        }
      }
    }
    this.inCopperVisibleSpan = false;
    if (maxHpos >= 0xfe) this.copHpos = 0;
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
    const bg = this.colorAbgr[0];

    const dmaOk = (this.dmacon & (DMA_MASTER | DMA_BITPLANE)) === (DMA_MASTER | DMA_BITPLANE);
    const bpu = (this.bplCon0 >>> 12) & 7;
    const hires = (this.bplCon0 & 0x8000) !== 0;
    const ham = (this.bplCon0 & 0x0800) !== 0 && bpu === 6;
    const dpf = (this.bplCon0 & 0x0400) !== 0;
    const ehb = !ham && !dpf && bpu === 6;

    // Pre-resolved Display Window vertical bounds (DIWSTRT / DIWSTOP / ECS DIWHIGH)
    const vStart = this.diwVStart;
    const vStop = this.diwVStop;

    // Step Agnus Sprite DMA independently of Bitplane DMA / DIW vertical clipping
    this.stepSpritesOnLine(line);

    if (!dmaOk || bpu === 0 || line < vStart || line >= vStop) {
      if (visible) {
        if (this.midlineColorCount === 0) {
          fb.fill(bg, rowOff, rowOff + fbW);
        } else {
          this.fillMidlineBgSpans(rowOff, fbW);
        }
        this.renderSpritesOnLine(rowOff, true);
      }
      this.midlineColorCount = 0;
      return;
    }

    // Track active hardware DIW bounding box in Auto-Overscan mode (zero GC, 4 integer checks)
    if (this.overscanMode === 'auto' && this.diwHStop > this.diwHStart) {
      this.frameDiwActive = true;
      if (line < this.frameDiwMinV) this.frameDiwMinV = line;
      const nextLine = line + 1;
      if (nextLine > this.frameDiwMaxV) this.frameDiwMaxV = nextLine;
      if (this.diwHStart < this.frameDiwMinH) this.frameDiwMinH = this.diwHStart;
      if (this.diwHStop > this.frameDiwMaxH) this.frameDiwMaxH = this.diwHStop;
    }

    const mask = this.chipMask;

    // Authentic OCS/ECS Agnus bitplane DMA runs in 8-color-clock fetch units:
    // fetches start at DDFSTRT and stop after the first 8-clock unit with start >= DDFSTOP.
    // Example: DDFSTRT=$34, DDFSTOP=$CC -> span=$98 -> 20 words;
    //          DDFSTRT=$30, DDFSTOP=$CC -> span=$9C -> 21 words (smooth-scroll extra word).
    const ddfSpan = this.ddfStop >= this.ddfStrt ? (this.ddfStop - this.ddfStrt) : 0;
    const fetchUnits = ((ddfSpan + 7) >>> 3) + 1;
    const wordsPerLine = hires
      ? Math.min(52, fetchUnits << 1)
      : Math.min(28, fetchUnits);
    const numBytes = wordsPerLine << 1;

    if (!visible) {
      // Advance bitplane DMA pointers even on overscan or frameskipped lines (zero pixel cost)
      for (let p = 0; p < bpu; p++) {
        const mod = (p & 1) === 0 ? this.bpl1Mod : this.bpl2Mod;
        this.bplPt[p] = (this.bplPt[p] + numBytes + mod) & mask;
      }
      this.midlineColorCount = 0;
      return;
    }

    const chip = this.chipRam;
    const colors = this.colorAbgr;
    const ehbColors = this.colorEhbAbgr;
    const indices = this.lineIndices;
    indices.fill(0, 0, fbW);

    const pf1Scroll = this.bplCon1 & 0x0f;
    const pf2Scroll = (this.bplCon1 >>> 4) & 0x0f;

    const hOriginLo = this.viewHOriginLo;
    const viewLoWidth = fbW >>> 1;
    const hShiftLo = 0x81 - hOriginLo;

    // Horizontal Display Window bounds relative to active overscan viewport origin
    let diwHStartLo = this.diwHStart - hOriginLo;
    let diwHStopLo = this.diwHStop - hOriginLo;
    if (diwHStartLo < 0) diwHStartLo = 0;
    if (diwHStopLo > viewLoWidth) diwHStopLo = viewLoWidth;
    if (diwHStopLo < diwHStartLo) diwHStopLo = diwHStartLo;

    if (hires) {
      // Hi-Res rendering (1..4 bitplanes) with Denise global phase scroll delay
      const activeBpu = bpu > 4 ? 4 : bpu;
      const hShiftHi = hShiftLo << 1;
      const fetchPxHires = (this.ddfStrt - 0x3c) << 2;
      const startPx1 = fetchPxHires + (((pf1Scroll << 1) - fetchPxHires) & 31) + hShiftHi;
      const minX = diwHStartLo << 1;
      const maxX = diwHStopLo << 1;
      fb.fill(bg, rowOff, rowOff + fbW);
      if (dpf) {
        // Hi-Res Dual Playfield: odd planes (0,2) = PF1 (colors 1..3), even planes (1,3) = PF2 (colors 9..11)
        const pf2Prio = (this.bplCon2 & 0x0040) !== 0;
        const startPx2 = fetchPxHires + (((pf2Scroll << 1) - fetchPxHires) & 31) + hShiftHi;
        if (startPx1 === startPx2) {
          let outX = startPx1;
          for (let byteIdx = 0; byteIdx < numBytes; byteIdx++) {
            const b0 = activeBpu > 0 ? chip[(this.bplPt[0] + byteIdx) & mask] : 0;
            const b1 = activeBpu > 1 ? chip[(this.bplPt[1] + byteIdx) & mask] : 0;
            const b2 = activeBpu > 2 ? chip[(this.bplPt[2] + byteIdx) & mask] : 0;
            const b3 = activeBpu > 3 ? chip[(this.bplPt[3] + byteIdx) & mask] : 0;

            for (let bit = 7; bit >= 0; bit--) {
              if (outX >= minX && outX < maxX) {
                const c1 = ((b0 >>> bit) & 1) | (((b2 >>> bit) & 1) << 1);
                const c2 = ((b1 >>> bit) & 1) | (((b3 >>> bit) & 1) << 1);
                const colIdx = pf2Prio
                  ? (c2 !== 0 ? (8 + c2) : c1)
                  : (c1 !== 0 ? c1 : (c2 !== 0 ? (8 + c2) : 0));
                indices[outX] = colIdx;
                fb[rowOff + outX] = colors[colIdx];
              }
              outX++;
            }
          }
        } else {
          const totalPx = numBytes << 3;
          for (let outX = minX; outX < maxX; outX++) {
            const s1 = outX - startPx1;
            const s2 = outX - startPx2;
            let c1 = 0;
            let c2 = 0;
            if (s1 >= 0 && s1 < totalPx) {
              const bi = s1 >>> 3;
              const bit = 7 - (s1 & 7);
              c1 =
                (activeBpu > 0 ? ((chip[(this.bplPt[0] + bi) & mask] >>> bit) & 1) : 0) |
                (activeBpu > 2 ? (((chip[(this.bplPt[2] + bi) & mask] >>> bit) & 1) << 1) : 0);
            }
            if (s2 >= 0 && s2 < totalPx) {
              const bi = s2 >>> 3;
              const bit = 7 - (s2 & 7);
              c2 =
                (activeBpu > 1 ? ((chip[(this.bplPt[1] + bi) & mask] >>> bit) & 1) : 0) |
                (activeBpu > 3 ? (((chip[(this.bplPt[3] + bi) & mask] >>> bit) & 1) << 1) : 0);
            }
            const colIdx = pf2Prio
              ? (c2 !== 0 ? (8 + c2) : c1)
              : (c1 !== 0 ? c1 : (c2 !== 0 ? (8 + c2) : 0));
            indices[outX] = colIdx;
            fb[rowOff + outX] = colors[colIdx];
          }
        }
      } else {
        let outX = startPx1;
        for (let byteIdx = 0; byteIdx < numBytes; byteIdx++) {
          const b0 = activeBpu > 0 ? chip[(this.bplPt[0] + byteIdx) & mask] : 0;
          const b1 = activeBpu > 1 ? chip[(this.bplPt[1] + byteIdx) & mask] : 0;
          const b2 = activeBpu > 2 ? chip[(this.bplPt[2] + byteIdx) & mask] : 0;
          const b3 = activeBpu > 3 ? chip[(this.bplPt[3] + byteIdx) & mask] : 0;

          for (let bit = 7; bit >= 0; bit--) {
            if (outX >= minX && outX < maxX) {
              const idx =
                ((b0 >>> bit) & 1) |
                (((b1 >>> bit) & 1) << 1) |
                (((b2 >>> bit) & 1) << 2) |
                (((b3 >>> bit) & 1) << 3);
              indices[outX] = idx;
              fb[rowOff + outX] = colors[idx];
            }
            outX++;
          }
        }
      }
    } else if (ham) {
      // Authentic Amiga HAM6 (4096-color Hold-And-Modify, 6 bitplanes)
      let holdR = (this.colorReg[0] >>> 8) & 0xf;
      let holdG = (this.colorReg[0] >>> 4) & 0xf;
      let holdB = this.colorReg[0] & 0xf;
      const fetchPx = (this.ddfStrt - 0x38) << 1;
      const startPx = fetchPx + ((pf1Scroll - fetchPx) & 15) + hShiftLo;
      fb.fill(bg, rowOff, rowOff + fbW);
      let outPx = startPx;

      for (let byteIdx = 0; byteIdx < numBytes; byteIdx++) {
        const b0 = chip[(this.bplPt[0] + byteIdx) & mask];
        const b1 = chip[(this.bplPt[1] + byteIdx) & mask];
        const b2 = chip[(this.bplPt[2] + byteIdx) & mask];
        const b3 = chip[(this.bplPt[3] + byteIdx) & mask];
        const b4 = chip[(this.bplPt[4] + byteIdx) & mask];
        const b5 = chip[(this.bplPt[5] + byteIdx) & mask];

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
    } else if (dpf) {
      // Dual Playfield Mode (Odd planes = PF1 colors 0..7, Even planes = PF2 colors 8..15)
      const pf2Prio = (this.bplCon2 & 0x0040) !== 0;
      const fetchPx = (this.ddfStrt - 0x38) << 1;
      const startPx1 = fetchPx + ((pf1Scroll - fetchPx) & 15) + hShiftLo;
      const startPx2 = fetchPx + ((pf2Scroll - fetchPx) & 15) + hShiftLo;
      const totalPx = numBytes << 3;
      fb.fill(bg, rowOff, rowOff + fbW);
      for (let outPx = diwHStartLo; outPx < diwHStopLo; outPx++) {
        const s1 = outPx - startPx1;
        const s2 = outPx - startPx2;
        let c1 = 0;
        let c2 = 0;
        if (s1 >= 0 && s1 < totalPx) {
          const bi = s1 >>> 3;
          const bit = 7 - (s1 & 7);
          c1 =
            (bpu > 0 ? ((chip[(this.bplPt[0] + bi) & mask] >>> bit) & 1) : 0) |
            (bpu > 2 ? (((chip[(this.bplPt[2] + bi) & mask] >>> bit) & 1) << 1) : 0) |
            (bpu > 4 ? (((chip[(this.bplPt[4] + bi) & mask] >>> bit) & 1) << 2) : 0);
        }
        if (s2 >= 0 && s2 < totalPx) {
          const bi = s2 >>> 3;
          const bit = 7 - (s2 & 7);
          c2 =
            (bpu > 1 ? ((chip[(this.bplPt[1] + bi) & mask] >>> bit) & 1) : 0) |
            (bpu > 3 ? (((chip[(this.bplPt[3] + bi) & mask] >>> bit) & 1) << 1) : 0) |
            (bpu > 5 ? (((chip[(this.bplPt[5] + bi) & mask] >>> bit) & 1) << 2) : 0);
        }
        const colIdx = pf2Prio
          ? (c2 !== 0 ? (8 + c2) : c1)
          : (c1 !== 0 ? c1 : (c2 !== 0 ? (8 + c2) : 0));
        const abgr = colors[colIdx];
        const x2 = outPx << 1;
        fb[rowOff + x2] = abgr;
        fb[rowOff + x2 + 1] = abgr;
        indices[x2] = colIdx;
        indices[x2 + 1] = colIdx;
      }
    } else {
      // Standard Lo-Res (1..5 bitplanes = 2..32 colors, or 6 bitplanes = 64-color EHB)
      // Denise shift registers latch BPLxDAT when the global 4-bit horizontal counter matches BPLCON1,
      // so unaligned DDFSTRT (e.g. $34) automatically adds the hardware phase delay to reach X=0.
      const fetchPx = (this.ddfStrt - 0x38) << 1;
      const startPx1 = fetchPx + ((pf1Scroll - fetchPx) & 15) + hShiftLo;
      const startPx2 = fetchPx + ((pf2Scroll - fetchPx) & 15) + hShiftLo;
      fb.fill(bg, rowOff, rowOff + fbW);

      if (startPx1 === startPx2) {
        let outPx = startPx1;
        for (let byteIdx = 0; byteIdx < numBytes; byteIdx++) {
          const b0 = bpu > 0 ? chip[(this.bplPt[0] + byteIdx) & mask] : 0;
          const b1 = bpu > 1 ? chip[(this.bplPt[1] + byteIdx) & mask] : 0;
          const b2 = bpu > 2 ? chip[(this.bplPt[2] + byteIdx) & mask] : 0;
          const b3 = bpu > 3 ? chip[(this.bplPt[3] + byteIdx) & mask] : 0;
          const b4 = bpu > 4 ? chip[(this.bplPt[4] + byteIdx) & mask] : 0;
          const b5 = bpu > 5 ? chip[(this.bplPt[5] + byteIdx) & mask] : 0;

          for (let bit = 7; bit >= 0; bit--) {
            if (outPx >= diwHStartLo && outPx < diwHStopLo) {
              const idx =
                ((b0 >>> bit) & 1) |
                (((b1 >>> bit) & 1) << 1) |
                (((b2 >>> bit) & 1) << 2) |
                (((b3 >>> bit) & 1) << 3) |
                (((b4 >>> bit) & 1) << 4) |
                (((b5 >>> bit) & 1) << 5);
              const abgr = ehb && idx >= 32 ? ehbColors[idx & 31] : colors[idx & 31];
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
        // Independent odd/even bitplane scroll delays (used by parallax/shadow tricks)
        const totalPx = numBytes << 3;
        for (let outPx = diwHStartLo; outPx < diwHStopLo; outPx++) {
          const s1 = outPx - startPx1;
          const s2 = outPx - startPx2;
          let idx = 0;
          if (s1 >= 0 && s1 < totalPx) {
            const bi = s1 >>> 3;
            const bit = 7 - (s1 & 7);
            if (bpu > 0) idx |= (chip[(this.bplPt[0] + bi) & mask] >>> bit) & 1;
            if (bpu > 2) idx |= ((chip[(this.bplPt[2] + bi) & mask] >>> bit) & 1) << 2;
            if (bpu > 4) idx |= ((chip[(this.bplPt[4] + bi) & mask] >>> bit) & 1) << 4;
          }
          if (s2 >= 0 && s2 < totalPx) {
            const bi = s2 >>> 3;
            const bit = 7 - (s2 & 7);
            if (bpu > 1) idx |= ((chip[(this.bplPt[1] + bi) & mask] >>> bit) & 1) << 1;
            if (bpu > 3) idx |= ((chip[(this.bplPt[3] + bi) & mask] >>> bit) & 1) << 3;
            if (bpu > 5) idx |= ((chip[(this.bplPt[5] + bi) & mask] >>> bit) & 1) << 5;
          }
          const abgr = ehb && idx >= 32 ? ehbColors[idx & 31] : colors[idx & 31];
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

    // Apply mid-scanline Copper palette changes (zero overhead when midlineColorCount === 0)
    if (this.midlineColorCount > 0 && !ham) {
      this.applyMidlineColors(rowOff, fbW, ehb);
    }
    this.midlineColorCount = 0;

    // Composite 8 Hardware Sprites on top
    this.renderSpritesOnLine(rowOff, false);
  }

  private fillMidlineBgSpans(rowOff: number, fbW: number): void {
    const fb = this.framebuffer;
    let curBg = this.lineStartColorAbgr[0];
    let curX = 0;
    const count = this.midlineColorCount;
    for (let e = 0; e < count; e++) {
      const x = this.midlineColorX[e];
      const endX = x < fbW ? x : fbW;
      if (endX > curX) {
        fb.fill(curBg, rowOff + curX, rowOff + endX);
        curX = endX;
      }
      if (this.midlineColorIdx[e] === 0) {
        curBg = RGB12_TO_ABGR32[this.midlineColorVal[e]];
      }
      if (curX >= fbW) break;
    }
    if (curX < fbW) {
      fb.fill(curBg, rowOff + curX, rowOff + fbW);
    }
  }

  private applyMidlineColors(rowOff: number, fbW: number, ehb: boolean): void {
    const fb = this.framebuffer;
    const indices = this.lineIndices;
    const abgr = this.workColorAbgr;
    const ehbArr = this.workColorEhb;
    abgr.set(this.lineStartColorAbgr);
    if (ehb) ehbArr.set(this.lineStartColorEhb);

    let curX = 0;
    const count = this.midlineColorCount;
    for (let e = 0; e <= count; e++) {
      const targetX = e < count ? this.midlineColorX[e] : fbW;
      const endX = targetX < fbW ? targetX : fbW;
      if (endX > curX) {
        if (ehb) {
          for (let x = curX; x < endX; x++) {
            const idx = indices[x];
            fb[rowOff + x] = idx >= 32 ? ehbArr[idx & 31] : abgr[idx & 31];
          }
        } else {
          for (let x = curX; x < endX; x++) {
            fb[rowOff + x] = abgr[indices[x] & 31];
          }
        }
        curX = endX;
      }
      if (e < count) {
        const cIdx = this.midlineColorIdx[e];
        const cVal = this.midlineColorVal[e];
        abgr[cIdx] = RGB12_TO_ABGR32[cVal];
        if (ehb) ehbArr[cIdx] = RGB12_TO_EHB32[cVal];
      }
    }
  }

  private stepSpritesOnLine(line: number): void {
    const spriteHeaderLine = this.isPalTiming() ? 25 : 20;
    if (line < spriteHeaderLine) {
      this.sprDmaLineActive.fill(0);
      return;
    }
    if ((this.dmacon & (DMA_MASTER | DMA_SPRITE)) !== (DMA_MASTER | DMA_SPRITE)) {
      this.sprDmaLineActive.fill(0);
      return;
    }
    for (let s = 0; s < 8; s++) {
      if (this.sprDmaOn[s] === 0) {
        this.sprDmaLineActive[s] = 0;
        continue;
      }
      const pos = this.sprPos[s];
      const ctl = this.sprCtl[s];
      const vStart = ((pos >>> 8) & 0xff) | ((ctl & 0x04) << 6);
      const vStop = ((ctl >>> 8) & 0xff) | ((ctl & 0x02) << 7);

      if (line >= vStart && line < vStop) {
        const ptr = this.sprPt[s];
        if (ptr !== 0) {
          this.sprData[s] = this.readChip16(ptr);
          this.sprDatb[s] = this.readChip16(ptr + 2);
          this.sprPt[s] = (ptr + 4) & this.chipMask;
          this.sprDmaLineActive[s] = 1;
        } else {
          this.sprDmaLineActive[s] = 0;
          this.sprDmaOn[s] = 0;
        }
      } else if (line === vStop) {
        this.sprDmaLineActive[s] = 0;
        const ptr = this.sprPt[s];
        if (ptr !== 0) {
          const nextPos = this.readChip16(ptr);
          const nextCtl = this.readChip16(ptr + 2);
          this.sprPos[s] = nextPos;
          this.sprCtl[s] = nextCtl;
          this.sprPt[s] = (ptr + 4) & this.chipMask;
          if (nextPos === 0 && nextCtl === 0) {
            this.sprDmaOn[s] = 0;
          }
        } else {
          this.sprDmaOn[s] = 0;
        }
      } else {
        this.sprDmaLineActive[s] = 0;
      }
    }
  }

  private renderSpritesOnLine(rowOff: number, emptyBg: boolean): void {
    const dmaActive = this.sprDmaLineActive;
    const manualArmed = this.sprArmed;
    // Fast skip when no sprites are active on this scanline (0 heap alloc, ~1ns)
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

    // Draw sprite pairs from pair 3 (SPR6/7) down to pair 0 (SPR0/1)
    for (let k = 3; k >= 0; k--) {
      const e = k << 1;
      const o = e + 1;
      const eOn = (dmaActive[e] | manualArmed[e]) !== 0;
      const oOn = (dmaActive[o] | manualArmed[o]) !== 0;
      if (!eOn && !oOn) continue;

      const attached = (this.sprCtl[o] & 0x0080) !== 0;

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
            if (sx < 0 || sx >= viewLoWidth) continue;
            const abgr = colors[16 + col4];
            const x2 = sx << 1;
            if (emptyBg) {
              fb[rowOff + x2] = abgr;
              fb[rowOff + x2 + 1] = abgr;
            } else {
              const i0 = indices[x2];
              const i1 = indices[x2 + 1];
              if (i0 === 0 || (!dpf ? k < pf2P : i0 < 8 ? k < pf1P : k < pf2P)) {
                fb[rowOff + x2] = abgr;
              }
              if (i1 === 0 || (!dpf ? k < pf2P : i1 < 8 ? k < pf1P : k < pf2P)) {
                fb[rowOff + x2 + 1] = abgr;
              }
            }
          }
        } else {
          let minSx = viewLoWidth;
          let maxSx = 0;
          if (eOn) {
            if (hE < minSx) minSx = hE;
            if (hE + 16 > maxSx) maxSx = hE + 16;
          }
          if (oOn) {
            if (hO < minSx) minSx = hO;
            if (hO + 16 > maxSx) maxSx = hO + 16;
          }
          if (minSx < 0) minSx = 0;
          if (maxSx > viewLoWidth) maxSx = viewLoWidth;
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
            const abgr = colors[16 + col4];
            const x2 = sx << 1;
            if (emptyBg) {
              fb[rowOff + x2] = abgr;
              fb[rowOff + x2 + 1] = abgr;
            } else {
              const i0 = indices[x2];
              const i1 = indices[x2 + 1];
              if (i0 === 0 || (!dpf ? k < pf2P : i0 < 8 ? k < pf1P : k < pf2P)) {
                fb[rowOff + x2] = abgr;
              }
              if (i1 === 0 || (!dpf ? k < pf2P : i1 < 8 ? k < pf1P : k < pf2P)) {
                fb[rowOff + x2 + 1] = abgr;
              }
            }
          }
        }
      } else {
        const baseColor = 16 + (k << 2);
        // Odd sprite first, then even sprite on top
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
            if (sx < 0 || sx >= viewLoWidth) continue;
            const abgr = colors[baseColor + pxCol];
            const x2 = sx << 1;
            if (emptyBg) {
              fb[rowOff + x2] = abgr;
              fb[rowOff + x2 + 1] = abgr;
            } else {
              const i0 = indices[x2];
              const i1 = indices[x2 + 1];
              if (i0 === 0 || (!dpf ? k < pf2P : i0 < 8 ? k < pf1P : k < pf2P)) {
                fb[rowOff + x2] = abgr;
              }
              if (i1 === 0 || (!dpf ? k < pf2P : i1 < 8 ? k < pf1P : k < pf2P)) {
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
            if (sx < 0 || sx >= viewLoWidth) continue;
            const abgr = colors[baseColor + pxCol];
            const x2 = sx << 1;
            if (emptyBg) {
              fb[rowOff + x2] = abgr;
              fb[rowOff + x2 + 1] = abgr;
            } else {
              const i0 = indices[x2];
              const i1 = indices[x2 + 1];
              if (i0 === 0 || (!dpf ? k < pf2P : i0 < 8 ? k < pf1P : k < pf2P)) {
                fb[rowOff + x2] = abgr;
              }
              if (i1 === 0 || (!dpf ? k < pf2P : i1 < 8 ? k < pf1P : k < pf2P)) {
                fb[rowOff + x2 + 1] = abgr;
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
    for (let i = 0; i < 32; i++) {
      const c12 = this.regs[(0x180 >>> 1) + i] & 0x0fff;
      this.colorReg[i] = c12;
      this.colorAbgr[i] = RGB12_TO_ABGR32[c12];
      this.colorEhbAbgr[i] = RGB12_TO_EHB32[c12];
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
    this.ddfStrt = (this.regs[0x092 >>> 1] & 0x00fc) || 0x0038;
    this.ddfStop = (this.regs[0x094 >>> 1] & 0x00fc) || 0x00d0;
    this.bpl1Mod = (this.regs[0x108 >>> 1] << 16) >> 16;
    this.bpl2Mod = (this.regs[0x10a >>> 1] << 16) >> 16;
    this.diwVStart = (this.diwStrt >>> 8) & 0xff;
    this.diwHStart = this.diwStrt & 0xff;
    const vs = (this.diwStop >>> 8) & 0xff;
    this.diwVStop = (vs & 0x80) === 0 ? (vs | 0x100) : vs;
    this.diwHStop = (this.diwStop & 0xff) | 0x100;
    this.diwHigh = this.regs[0x1e4 >>> 1];
    if (this.chipset === 'ECS' && this.diwHigh !== 0) {
      this.diwVStart = ((this.diwStrt >>> 8) & 0xff) | ((this.diwHigh & 0x07) << 8);
      this.diwHStart = (this.diwStrt & 0xff) | ((this.diwHigh & 0x20) << 3);
      this.diwVStop = ((this.diwStop >>> 8) & 0xff) | (this.diwHigh & 0x0700);
      this.diwHStop = (this.diwStop & 0xff) | ((this.diwHigh & 0x2000) >>> 5);
    }
    this.updateIpl();
  }
}

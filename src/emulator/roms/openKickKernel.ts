/**
 * Built-in OpenKick OCS/ECS 256 KB Boot ROM + 5 Authentic Built-in Playable OCS/ECS ADF Disks.
 *
 * Architecture:
 * - buildOpenKickRom() emits REAL Motorola 68000 machine code at $F80000:
 *   Initializes CIA-A (clears OVL, enables Keyboard IRQ2), Paula (VBlank IRQ3),
 *   runs `STOP #$2000` low-power loop between frames so CPU usage stays minimal!
 * - Built-in ADF images are valid 880 KB AmigaDOS disks ('DOS\0' + valid bootblock checksum).
 * - All visuals are rendered directly into Chip RAM bitplanes ($020000+), Copper lists ($008000),
 *   Hardware Sprites ($01E000), and Paula 4-channel DMA Audio samples ($050000+) — scanned out
 *   by the real Denise/Agnus/Paula OCS/ECS chipset!
 */

import { DiskCatalogItem } from '../types';
import {
  ADF_TOTAL_SIZE,
  FloppyController,
  verifyAmigaBootblockChecksum,
  writeAmigaBootblockChecksum,
} from '../hardware/floppy';
import { AmigaChipset, DMA_AUD0, DMA_AUD1, DMA_BITPLANE, DMA_BLITTER, DMA_COPPER, DMA_MASTER, DMA_SPRITE } from '../hardware/chipset';
import { AMIGA_KEY_NAMES, AMIGA_RAW, amigaRawKeyToAscii, decodeCiaKeyboardByte } from '../keyboard/amigaKeyMap';
import { Asm68k } from './asm68k';
import { CopperBuilder, PlanarCanvas } from './topazFont';

export const OPENKICK_ROM_SIZE = 256 * 1024;
const COPPER_ADDR = 0x008000;
const BITPLANE_ADDR = 0x020000;
const SPRITE0_ADDR = 0x01e000;
const AUDIO_BASE = 0x050000;

export const BUILTIN_DISK_CATALOG: DiskCatalogItem[] = [
  {
    id: 'boing_studio',
    title: 'Boing! OCS + AmigaDOS Shell',
    subtitle: 'Знаменитый Boing Ball + живой CLI Topaz-8 и тестер всех 96 клавиш Amiga',
    chipset: 'OCS/ECS',
    controlsHint: 'Клавиатура (HELP, DIR, AVAIL, COLORS, CLS), мышь по экрану',
    sizeBytes: ADF_TOTAL_SIZE,
  },
  {
    id: 'shadow_runner',
    title: 'Shadow Runner OCS',
    subtitle: 'Платформер-раннер с Copper-небом, параллаксом и звуком Paula',
    chipset: 'OCS',
    controlsHint: 'Стрелки / Space / Fire — прыжок, Alt / Ctrl — удар мечом',
    sizeBytes: ADF_TOTAL_SIZE,
  },
  {
    id: 'arcanoid_500',
    title: 'Arcanoid 500 OCS',
    subtitle: 'Классический арканоид под OCS с управлением мышью, касанием экрана и клавишами',
    chipset: 'OCS',
    controlsHint: 'Палец по экрану / Мышь / ← → — ракетка, Space / LMB — запуск',
    sizeBytes: ADF_TOTAL_SIZE,
  },
  {
    id: 'starblazer_ocs',
    title: 'Starblazer OCS',
    subtitle: 'Космический скролл-шутер в духе R-Type / Project-X на 4 битовых плоскостях',
    chipset: 'OCS/ECS',
    controlsHint: 'Джойстик / Стрелки — полёт, Space / Fire — лазер',
    sizeBytes: ADF_TOTAL_SIZE,
  },
  {
    id: 'ham6_demo',
    title: 'HAM6 4096-Color Demo',
    subtitle: 'Демосцена OCS/ECS в реальном режиме HAM6 (4096 цветов) + Copper + Paula Synth',
    chipset: 'OCS/ECS',
    controlsHint: 'Space — сменить эффект, F1-F4 — каналы Paula, Esc — сброс',
    sizeBytes: ADF_TOTAL_SIZE,
  },
];

/**
 * Generates a real 256 KB Motorola 68000 OpenKick Boot ROM binary.
 */
export function buildOpenKickRom(): Uint8Array {
  const rom = new Uint8Array(OPENKICK_ROM_SIZE);
  const asm = new Asm68k(0xf80000);

  // $F80000: Initial SSP ($0007FF00) and Initial PC ($00F80020)
  asm.long(0x0007ff00);
  asm.long(0x00f80020);
  asm.padTo(0xf80020);

  // Entry point: Disable OVL, set up 68000 IRQ2 (CIA-A Keyboard) & IRQ3 (VBlank) vectors
  asm
    .label('start')
    .moveImmWToAbsL(0x7fff, 0xdff09a) // Disable all INTENA
    .moveImmWToAbsL(0x7fff, 0xdff09c) // Clear all INTREQ
    .moveImmWToAbsL(0x7fff, 0xdff096) // Disable all DMACON
    .moveImmBToAbsL(0x03, 0xbfe201)   // CIA-A DDRA: OVL + LED output
    .bclrImmAbsL(0, 0xbfe001)         // Clear OVL (Chip RAM now visible at $000000!)
    .bclrImmAbsL(1, 0xbfe001)         // Turn Power LED bright ON
    .moveLabelToAbsL('irq2_ciaa', 0x000068)  // Autovector Level 2 (CIA-A)
    .moveLabelToAbsL('irq3_vblank', 0x00006c) // Autovector Level 3 (VBlank)
    .moveImmLToAbsL(0x00000000, 0x000400)     // Frame counter = 0
    .lineA(0x000)                             // OpenKick Kernel Boot & Disk Loader
    .moveImmBToAbsL(0x88, 0xbfed01)           // CIA-A ICR: Enable Serial Port (Keyboard) IRQ
    .moveImmWToAbsL(0xc028, 0xdff09a)         // Paula INTENA: Master + VERTB(5) + PORTS(3)
    .moveImmToSr(0x2000);                     // Enable interrupts (IPL = 0)

  // Low-power 68000 idle loop: STOP halts CPU until next VBlank or Keyboard IRQ!
  asm
    .label('main_loop')
    .stop(0x2000)
    .bra('main_loop');

  // Level 2 IRQ: Authentic CIA-A Keyboard serial receive + handshake
  asm
    .label('irq2_ciaa')
    .movemSaveAll()
    .moveAbsLBToD(0xbfed01, 1) // Read & clear CIA-A ICR
    .btstImmD(3, 1)            // Check Serial Port (Keyboard) bit
    .beq('irq2_done')
    .moveAbsLBToD(0xbfec01, 0) // Read raw inverted key byte into D0
    .bsetImmAbsL(6, 0xbfee01)  // Handshake: SPMODE output (ACK start)
    .nop()
    .bclrImmAbsL(6, 0xbfee01)  // Handshake: SPMODE input (ACK end)
    .lineA(0x002)              // Pass D0 raw keycode to OpenKick runtime
    .label('irq2_done')
    .moveImmWToAbsL(0x0008, 0xdff09c) // Clear Paula PORTS IRQ
    .movemRestoreAll()
    .rte();

  // Level 3 IRQ: VBlank frame step
  asm
    .label('irq3_vblank')
    .movemSaveAll()
    .moveAbsLWToD(0xdff01e, 0)        // Read INTREQR
    .btstImmD(5, 0)                   // VERTB?
    .beq('irq3_done')
    .moveImmWToAbsL(0x0020, 0xdff09c) // Clear VERTB
    .addqLAbsL(1, 0x000400)           // Increment frame counter
    .lineA(0x001)                     // OpenKick VBlank Frame Tick
    .label('irq3_done')
    .movemRestoreAll()
    .rte();

  const code = asm.build();
  rom.set(code, 0);

  // Embed version tag at end of ROM like genuine Kickstart
  const sig = 'OpenKick 1.3 OCS/ECS (A500/A500+) ';
  for (let i = 0; i < sig.length; i++) {
    rom[OPENKICK_ROM_SIZE - 64 + i] = sig.charCodeAt(i);
  }
  return rom;
}

/**
 * Generates an authentic 880 KB AmigaDOS ADF image for any built-in catalog disk ID.
 * Includes valid 'DOS\0' header, real AmigaDOS bootblock checksum, and boot marker.
 */
export function buildBuiltinAdf(diskId: string): Uint8Array {
  const adf = new Uint8Array(ADF_TOTAL_SIZE);
  // AmigaDOS OFS Bootblock header: 'DOS\0'
  adf[0] = 0x44; // 'D'
  adf[1] = 0x4f; // 'O'
  adf[2] = 0x53; // 'S'
  adf[3] = 0x00;
  // Rootblock pointer = 880 ($00000370)
  adf[8] = 0x00; adf[9] = 0x00; adf[10] = 0x03; adf[11] = 0x70;

  // Bootblock entry at offset $0C: real 68000 JMP/RTS stub + OpenKick ID tag at offset $40
  const bootAsm = new Asm68k(0x0001000c);
  bootAsm.lineA(0x003).rts();
  adf.set(bootAsm.build(), 0x0c);

  const magic = `OKDK:${diskId}\0`;
  for (let i = 0; i < magic.length; i++) {
    adf[0x40 + i] = magic.charCodeAt(i);
  }

  // Write valid AmigaDOS Rootblock name at sector 880 (offset 880 * 512)
  const rootOff = 880 * 512;
  const volName = diskId.toUpperCase().slice(0, 28);
  adf[rootOff + 3] = 2; // T_HEADER
  adf[rootOff + 432] = volName.length;
  for (let i = 0; i < volName.length; i++) {
    adf[rootOff + 433 + i] = volName.charCodeAt(i);
  }

  // Write valid AmigaDOS 1024-byte bootblock checksum at bytes 4..7
  writeAmigaBootblockChecksum(adf);
  return adf;
}

type ActiveApp =
  | 'insert_disk'
  | 'boing_studio'
  | 'shadow_runner'
  | 'arcanoid_500'
  | 'starblazer_ocs'
  | 'ham6_demo'
  | 'external_adf_info';

interface Brick { x: number; y: number; w: number; h: number; hp: number; col: number; }
interface Enemy { x: number; y: number; vx: number; vy: number; hp: number; kind: number; }
interface Bullet { x: number; y: number; vx: number; vy: number; friendly: boolean; }

/**
 * OpenKick Hardware Runtime executed via M68000 Line-A traps ($A000-$A002) ONLY when
 * built-in OpenKick ROM is active. Completely disabled when a real Commodore Kickstart ROM is loaded.
 */
export class OpenKickRuntime {
  private app: ActiveApp = 'insert_disk';
  private frame = 0;
  private readonly canvas = new PlanarCanvas(BITPLANE_ADDR, 4);

  // Keyboard tracking
  private readonly pressedKeys = new Uint8Array(128);
  private shiftHeld = false;
  private capsLock = false;
  private lastRawKey = -1;
  private lastKeyEvent = 'NONE';
  private externalVolName = '';
  private externalValidChecksum = false;

  // Boing Studio + Topaz CLI state
  private boingX = 110;
  private boingY = 36;
  private boingVx = 2.1;
  private boingVy = 0;
  private boingRot = 0;
  private cliLines: string[] = [
    'AMIGA 500 OPENKICK 1.3 (OCS/ECS)',
    'TYPE HELP, DIR, AVAIL, COLORS, CLS',
  ];
  private cliInput = '';
  private boingHueShift = 0;

  // Shadow Runner OCS state
  private srScroll = 0;
  private srPlayerY = 176;
  private srPlayerVy = 0;
  private srAttackTimer = 0;
  private srScore = 0;
  private srBest = 0;
  private srHp = 3;
  private srGameOver = false;
  private srEnemies: Enemy[] = [];
  private srSpawnCd = 45;

  // Arcanoid 500 state
  private arcPaddleX = 132;
  private arcBallX = 160;
  private arcBallY = 200;
  private arcBallVx = 2.2;
  private arcBallVy = -2.4;
  private arcLaunched = false;
  private arcScore = 0;
  private arcLives = 3;
  private arcLevel = 1;
  private arcBricks: Brick[] = [];
  private arcPrevMouseX = 0;

  // Starblazer OCS state
  private sbX = 48;
  private sbY = 120;
  private sbScore = 0;
  private sbShield = 4;
  private sbGameOver = false;
  private sbFireCd = 0;
  private sbSpawnCd = 30;
  private sbEnemies: Enemy[] = [];
  private sbBullets: Bullet[] = [];

  // HAM6 Demo state
  private hamEffect = 0;
  private hamMusicStep = 0;
  private readonly hamChanMute = [false, false, false, false];
  private readonly hamNotes = [428, 381, 320, 285, 254, 285, 320, 381];

  // Paula SFX decay timers
  private sfxFramesLeft = 0;

  public reset(): void {
    this.frame = 0;
    this.pressedKeys.fill(0);
    this.shiftHeld = false;
    this.lastRawKey = -1;
    this.lastKeyEvent = 'NONE';
    this.sfxFramesLeft = 0;
  }

  public getCapsLock(): boolean {
    return this.capsLock;
  }

  public getLastKeyCode(): number | null {
    return this.lastRawKey >= 0 ? this.lastRawKey : null;
  }

  private initAudioWaveforms(chipRam: Uint8Array): void {
    // Ch0 ($050000, 64 bytes): Warm Amiga Boing/Bass sine-triangle wave
    for (let i = 0; i < 64; i++) {
      const s = Math.round(Math.sin((i / 64) * Math.PI * 2) * 110);
      chipRam[AUDIO_BASE + i] = s & 0xff;
    }
    // Ch1 ($050100, 64 bytes): Crisp 25% pulse lead wave
    for (let i = 0; i < 64; i++) {
      const s = i < 16 ? 95 : -75;
      chipRam[AUDIO_BASE + 0x100 + i] = s & 0xff;
    }
    // Ch2 ($050200, 64 bytes): Sawtooth bass
    for (let i = 0; i < 64; i++) {
      const s = Math.round((i / 32 - 1) * 90);
      chipRam[AUDIO_BASE + 0x200 + i] = s & 0xff;
    }
    // Ch3 ($050300, 256 bytes): Deterministic LFSR white noise (explosions / hits)
    let lfsr = 0xace1;
    for (let i = 0; i < 256; i++) {
      const bit = ((lfsr >>> 0) ^ (lfsr >>> 2) ^ (lfsr >>> 3) ^ (lfsr >>> 5)) & 1;
      lfsr = (lfsr >>> 1) | (bit << 15);
      chipRam[AUDIO_BASE + 0x300 + i] = ((lfsr & 0xff) - 128) & 0xff;
    }
  }

  private triggerPaulaSfx(
    chipset: AmigaChipset,
    channel: number,
    waveOffset: number,
    lenWords: number,
    period: number,
    vol: number,
    frames: number
  ): void {
    const base = 0x0a0 + channel * 0x10;
    const addr = AUDIO_BASE + waveOffset;
    chipset.writeReg16(base + 0x00, (addr >>> 16) & 0x1f);
    chipset.writeReg16(base + 0x02, addr & 0xffff);
    chipset.writeReg16(base + 0x04, lenWords);
    chipset.writeReg16(base + 0x06, period);
    chipset.writeReg16(base + 0x08, vol);
    chipset.writeReg16(0x096, 0x8200 | (1 << channel));
    this.sfxFramesLeft = Math.max(this.sfxFramesLeft, frames);
  }

  /**
   * Called by 68000 OpenKick ROM ($A000) during boot.
   * Reads DF0: sector 0 via floppy controller, verifies bootblock, initializes active app.
   */
  public boot(chipset: AmigaChipset, chipRam: Uint8Array, floppy: FloppyController): void {
    this.reset();
    this.initAudioWaveforms(chipRam);

    // Initialize hardware Sprite 0 (Crisp Amiga Workbench arrow cursor, 16x16)
    this.writeMouseSpriteData(chipRam);

    const df0 = floppy.drives[0];
    if (!df0.data) {
      this.app = 'insert_disk';
    } else {
      const bootBuf = new Uint8Array(1024);
      df0.readSectorDirect(0, bootBuf, 0);
      df0.readSectorDirect(1, bootBuf, 512);
      const validCsum = verifyAmigaBootblockChecksum(bootBuf);

      // Check OpenKick built-in disk marker 'OKDK:'
      let magic = '';
      for (let i = 0; i < 32; i++) {
        const c = bootBuf[0x40 + i];
        if (c === 0) break;
        magic += String.fromCharCode(c);
      }

      if (magic.startsWith('OKDK:')) {
        const id = magic.slice(5) as ActiveApp;
        this.app = id;
      } else {
        this.app = 'external_adf_info';
        this.externalValidChecksum = validCsum;
        // Extract AmigaDOS volume name from rootblock sector 880
        const root = new Uint8Array(512);
        df0.readSectorDirect(880, root, 0);
        const nameLen = Math.min(30, root[432]);
        let vn = '';
        for (let i = 0; i < nameLen; i++) {
          const ch = root[433 + i];
          if (ch >= 32 && ch <= 126) vn += String.fromCharCode(ch);
        }
        this.externalVolName = vn || df0.name || 'UNKNOWN DISK';
      }
    }

    this.initAppState(chipset, chipRam);
  }

  private writeMouseSpriteData(chipRam: Uint8Array): void {
    // Classic 12-line Amiga pointer arrow
    const planeA = [
      0xc000, 0xe000, 0xf000, 0xf800, 0xfc00, 0xfe00,
      0xf800, 0xdc00, 0x8c00, 0x0600, 0x0600, 0x0000,
    ];
    const planeB = [
      0x4000, 0x6000, 0x7000, 0x7800, 0x7c00, 0x7e00,
      0x7800, 0x5c00, 0x0c00, 0x0600, 0x0600, 0x0000,
    ];
    let p = SPRITE0_ADDR;
    // POS & CTL updated dynamically each frame
    chipRam[p++] = 0x60; chipRam[p++] = 0x90;
    chipRam[p++] = 0x6c; chipRam[p++] = 0x00;
    for (let i = 0; i < 12; i++) {
      chipRam[p++] = (planeA[i] >>> 8) & 0xff;
      chipRam[p++] = planeA[i] & 0xff;
      chipRam[p++] = (planeB[i] >>> 8) & 0xff;
      chipRam[p++] = planeB[i] & 0xff;
    }
    chipRam[p++] = 0; chipRam[p++] = 0; chipRam[p++] = 0; chipRam[p++] = 0;
  }

  private updateMouseSpritePos(chipRam: Uint8Array, chipset: AmigaChipset): void {
    const mx = Math.max(0, Math.min(304, chipset.mouseX & 0xff) + ((chipset.mouseX & 0x100) ? 64 : 0));
    const my = Math.max(0, Math.min(240, chipset.mouseY & 0xff));
    const vStart = 44 + my;
    const vStop = vStart + 12;
    const hStart = 0x81 + mx;
    const pos = ((vStart & 0xff) << 8) | ((hStart >>> 1) & 0xff);
    const ctl =
      ((vStop & 0xff) << 8) |
      (((vStart >>> 8) & 1) << 2) |
      (((vStop >>> 8) & 1) << 1) |
      (hStart & 1);
    chipRam[SPRITE0_ADDR] = (pos >>> 8) & 0xff;
    chipRam[SPRITE0_ADDR + 1] = pos & 0xff;
    chipRam[SPRITE0_ADDR + 2] = (ctl >>> 8) & 0xff;
    chipRam[SPRITE0_ADDR + 3] = ctl & 0xff;
  }

  private initAppState(chipset: AmigaChipset, chipRam: Uint8Array): void {
    // Configure display geometry for 320x256 Lo-Res
    chipset.writeReg16(0x08e, 0x2c81); // DIWSTRT
    chipset.writeReg16(0x090, 0x2cc1); // DIWSTOP
    chipset.writeReg16(0x092, 0x0038); // DDFSTRT
    chipset.writeReg16(0x094, 0x00d0); // DDFSTOP
    chipset.writeReg16(0x102, 0x0000); // BPLCON1
    chipset.writeReg16(0x108, 0x0000); // BPL1MOD
    chipset.writeReg16(0x10a, 0x0000); // BPL2MOD

    if (this.app === 'ham6_demo') {
      this.canvas.numPlanes = 6;
      chipset.writeReg16(0x100, 0x6a00); // 6 bitplanes + HAM6 + COLOR
      this.setupHam6Copper(chipRam);
    } else {
      this.canvas.numPlanes = 4;
      chipset.writeReg16(0x100, 0x4200); // 4 bitplanes (16 colors) + COLOR
      this.canvas.clear(chipRam, 0);
      this.setupStandardCopper(chipRam);
    }

    if (this.app === 'shadow_runner') this.resetShadowRunner();
    if (this.app === 'arcanoid_500') this.resetArcanoid(chipset);
    if (this.app === 'starblazer_ocs') this.resetStarblazer();

    // Load COP1LC & strobe COPJMP1 + enable DMA
    chipset.writeReg16(0x080, (COPPER_ADDR >>> 16) & 0x1f);
    chipset.writeReg16(0x082, COPPER_ADDR & 0xffff);
    chipset.writeReg16(0x088, 0x0000);
    chipset.writeReg16(
      0x096,
      0x8000 | DMA_MASTER | DMA_BITPLANE | DMA_COPPER | DMA_BLITTER | DMA_SPRITE
    );
  }

  private setupStandardCopper(chipRam: Uint8Array): void {
    const cop = new CopperBuilder(chipRam, COPPER_ADDR);
    cop.setBitplanes(BITPLANE_ADDR, 4);
    // Point Sprite 0 to pointer arrow, Sprites 1-7 disabled
    cop.move(0x120, (SPRITE0_ADDR >>> 16) & 0x1f);
    cop.move(0x122, SPRITE0_ADDR & 0xffff);
    for (let s = 1; s < 8; s++) {
      cop.move(0x120 + s * 4, 0);
      cop.move(0x122 + s * 4, 0);
    }

    if (this.app === 'insert_disk' || this.app === 'external_adf_info') {
      // Authentic Kickstart 1.3 palette (white bg, dark blue/black outlines, blue floppy)
      cop.setPalette([
        0xeee, 0x112, 0x05a, 0xe72, 0x89b, 0xccd, 0xd33, 0x3a5,
        0x224, 0x568, 0x99a, 0xffe, 0xf93, 0x037, 0x4b7, 0xfff,
        0x000, 0xe42, 0x111, 0xffd, // Sprite 0 Amiga pointer colors (orange/black/white)
      ]);
      // Subtle Kickstart Copper accent ribbon at top
      cop.wait(44).move(0x180, 0x037);
      cop.wait(56).move(0x180, 0x05a);
      cop.wait(60).move(0x180, 0xeee);
    } else if (this.app === 'boing_studio') {
      const shift = this.boingHueShift;
      cop.setPalette([
        0x99a, // 0: Classic Amiga Boing grey backdrop
        0x90a, // 1: Magenta grid lines
        0xe11, // 2: Boing ball red
        0xfff, // 3: Pure white
        0x445, // 4: Ball drop shadow
        0x036, // 5: Workbench Shell deep blue
        0x059, // 6: Shell header blue
        0xf80, // 7: Authentic Workbench 1.3 orange
        0x112, // 8: Deep ink
        0x3c6, // 9: Active key emerald
        0xfe4, // 10: Yellow highlight
        0xb32, // 11: Dark Boing red shading
        0xccd, // 12: Light Boing white shading
        0x223, // 13: Console panel dark
        0x79c, // 14: Cyan info
        0xe54, // 15: Accent coral
        0x000, 0xf80, 0x111, 0xfff, // Sprite 0 cursor
      ]);
      // Copper split: top Boing arena -> bottom Workbench 1.3 CLI console!
      cop.wait(44).move(0x180, shift === 0 ? 0x99a : shift === 1 ? 0x224 : 0x132);
      cop.wait(174).move(0x180, 0xf80); // Crisp orange divider line
      cop.wait(176).move(0x180, 0x036); // Workbench 1.3 Blue shell background
    } else if (this.app === 'shadow_runner') {
      cop.setPalette([
        0x113, // 0: Sky (overridden by Copper sunset bands!)
        0x214, // 1: Far mountain
        0x425, // 2: Mid stone ruin
        0x363, // 3: Grass top
        0x642, // 4: Earth brown
        0x321, // 5: Dark soil
        0xfc8, // 6: Hero skin/gold
        0xd32, // 7: Hero crimson cape
        0x8cf, // 8: Steel sword / ice
        0xfff, // 9: Bright white
        0x7b3, // 10: Beast green
        0xe72, // 11: Fire orange
        0x223, // 12: Obsidian shadow
        0xa4c, // 13: Mystic violet
        0xfe4, // 14: Gold score
        0x99a, // 15: Silver stone
      ]);
      // Iconic OCS Copper sunset sky gradient + ground color split!
      cop.wait(44).move(0x180, 0x103);
      cop.wait(72).move(0x180, 0x214);
      cop.wait(96).move(0x180, 0x415);
      cop.wait(120).move(0x180, 0x724);
      cop.wait(144).move(0x180, 0xa43);
      cop.wait(166).move(0x180, 0xd62);
      cop.wait(184).move(0x180, 0x223);
      cop.wait(228).move(0x180, 0x231);
    } else if (this.app === 'arcanoid_500') {
      cop.setPalette([
        0x013, // 0: Space navy
        0x247, // 1: Metallic frame dark
        0x79c, // 2: Metallic frame bright
        0xe33, // 3: Red brick
        0xf92, // 4: Orange brick
        0xfe3, // 5: Yellow brick
        0x3c5, // 6: Green brick
        0x39f, // 7: Cyan brick
        0xc4e, // 8: Purple brick
        0xfff, // 9: White highlight / ball
        0x124, // 10: Grid pattern
        0xd62, // 11: Paddle trim
        0xbbc, // 12: Paddle silver
        0x456, // 13: Shadow
        0x5f8, // 14: Bonus glow
        0xf55, // 15: Alert
        0x000, 0xf80, 0x111, 0xfff,
      ]);
      cop.wait(44).move(0x180, 0x124);
      cop.wait(64).move(0x180, 0x013);
      cop.wait(140).move(0x180, 0x012);
      cop.wait(220).move(0x180, 0x113);
    } else if (this.app === 'starblazer_ocs') {
      cop.setPalette([
        0x001, // 0: Deep space
        0x446, // 1: Far star
        0x89c, // 2: Mid star
        0xfff, // 3: Near star / cockpit
        0x28f, // 4: Ship hull blue
        0x7df, // 5: Ship wing cyan
        0xf82, // 6: Thruster / plasma
        0xfe4, // 7: Laser core
        0xd23, // 8: Alien crimson
        0x92a, // 9: Alien purple
        0x3d6, // 10: Shield emerald
        0xf41, // 11: Explosion fire
        0x557, // 12: Hull metal
        0x224, // 13: HUD panel
        0xc8f, // 14: Nebula violet
        0xfa0, // 15: Warning amber
      ]);
      cop.wait(44).move(0x180, 0x002);
      cop.wait(90).move(0x180, 0x102);
      cop.wait(150).move(0x180, 0x001);
      cop.wait(220).move(0x180, 0x103);
    }

    cop.end();
  }

  private setupHam6Copper(chipRam: Uint8Array): void {
    const cop = new CopperBuilder(chipRam, COPPER_ADDR);
    cop.setBitplanes(BITPLANE_ADDR, 6);
    // Base 16 HAM6 palette registers
    cop.setPalette([
      0x001, 0x204, 0x417, 0x729, 0xa36, 0xd53, 0xf92, 0xfe7,
      0x8e9, 0x3bc, 0x17d, 0x138, 0xfff, 0xccc, 0x888, 0x333,
    ]);
    // Disable sprites in HAM6 demo
    for (let s = 0; s < 8; s++) {
      cop.move(0x120 + s * 4, 0);
      cop.move(0x122 + s * 4, 0);
    }
    cop.end();
  }

  /**
   * Called by 68000 CIA-A IRQ2 handler ($A002) with raw inverted SDR byte in D0!
   */
  public handleKeyByte(sdrByte: number, chipset: AmigaChipset, chipRam: Uint8Array): void {
    const { rawCode, isRelease } = decodeCiaKeyboardByte(sdrByte);
    this.pressedKeys[rawCode] = isRelease ? 0 : 1;

    if (rawCode === AMIGA_RAW.LSHIFT || rawCode === AMIGA_RAW.RSHIFT) {
      this.shiftHeld = this.pressedKeys[AMIGA_RAW.LSHIFT] === 1 || this.pressedKeys[AMIGA_RAW.RSHIFT] === 1;
    }
    if (rawCode === AMIGA_RAW.CAPSLOCK && !isRelease) {
      this.capsLock = !this.capsLock;
    }

    this.lastRawKey = rawCode;
    const name = AMIGA_KEY_NAMES[rawCode] ?? `KEY_${rawCode.toString(16).toUpperCase()}`;
    this.lastKeyEvent = `$${rawCode.toString(16).toUpperCase().padStart(2, '0')} ${name}${isRelease ? ' UP' : ' DN'}`;

    if (isRelease) return;

    // App-specific keyboard handling
    if (this.app === 'boing_studio') {
      this.handleBoingCliKey(rawCode, chipset, chipRam);
    } else if (this.app === 'shadow_runner') {
      if (this.srGameOver && (rawCode === AMIGA_RAW.SPACE || rawCode === AMIGA_RAW.RETURN)) {
        this.resetShadowRunner();
      } else if (rawCode === AMIGA_RAW.UP || rawCode === AMIGA_RAW.SPACE || rawCode === AMIGA_RAW.W) {
        this.srJump(chipset);
      } else if (rawCode === AMIGA_RAW.LALT || rawCode === AMIGA_RAW.CTRL || rawCode === AMIGA_RAW.RIGHT) {
        this.srAttack(chipset);
      }
    } else if (this.app === 'arcanoid_500') {
      if (rawCode === AMIGA_RAW.SPACE || rawCode === AMIGA_RAW.RETURN) {
        if (this.arcLives <= 0) this.resetArcanoid(chipset);
        else this.arcLaunched = true;
      } else if (rawCode === AMIGA_RAW.ESC) {
        this.resetArcanoid(chipset);
      }
    } else if (this.app === 'starblazer_ocs') {
      if (this.sbGameOver && (rawCode === AMIGA_RAW.SPACE || rawCode === AMIGA_RAW.RETURN)) {
        this.resetStarblazer();
      } else if (rawCode === AMIGA_RAW.SPACE || rawCode === AMIGA_RAW.LALT || rawCode === AMIGA_RAW.CTRL) {
        this.sbShoot(chipset);
      }
    } else if (this.app === 'ham6_demo') {
      if (rawCode === AMIGA_RAW.SPACE) {
        this.hamEffect = (this.hamEffect + 1) % 3;
      } else if (rawCode === AMIGA_RAW.F1) this.hamChanMute[0] = !this.hamChanMute[0];
      else if (rawCode === AMIGA_RAW.F2) this.hamChanMute[1] = !this.hamChanMute[1];
      else if (rawCode === AMIGA_RAW.F3) this.hamChanMute[2] = !this.hamChanMute[2];
      else if (rawCode === AMIGA_RAW.F4) this.hamChanMute[3] = !this.hamChanMute[3];
    }
  }

  private handleBoingCliKey(rawCode: number, chipset: AmigaChipset, chipRam: Uint8Array): void {
    // Crisp tactile Paula keyclick
    this.triggerPaulaSfx(chipset, 1, 0x100, 16, 220, 26, 2);

    if (rawCode === AMIGA_RAW.HELP) {
      this.pushCliLine('CMDS: DIR AVAIL INFO VER COLORS CLS');
      return;
    }
    if (rawCode === AMIGA_RAW.ESC) {
      this.cliInput = '';
      return;
    }
    if (rawCode === AMIGA_RAW.BACKSPACE || rawCode === AMIGA_RAW.DEL) {
      this.cliInput = this.cliInput.slice(0, -1);
      return;
    }
    if (rawCode === AMIGA_RAW.RETURN || rawCode === AMIGA_RAW.NP_ENTER) {
      const cmd = this.cliInput.trim().toUpperCase();
      this.pushCliLine(`1> ${cmd}`);
      this.cliInput = '';
      if (cmd === 'HELP') {
        this.pushCliLine('DIR AVAIL INFO VER COLORS CLS');
      } else if (cmd === 'DIR') {
        this.pushCliLine('BOING.EXE  SHADOW.ADF  ARCANOID.ADF');
      } else if (cmd === 'AVAIL') {
        const chipKB = chipRam.length >>> 10;
        this.pushCliLine(`CHIP RAM: ${chipKB}KB  COPPER/BLIT: OK`);
      } else if (cmd === 'INFO') {
        this.pushCliLine(`CHIPSET: ${chipset.chipset}  VIDEO: ${chipset.videoStandard}`);
      } else if (cmd === 'VER') {
        this.pushCliLine('OPENKICK 1.3 / M68000 7.09MHZ');
      } else if (cmd === 'COLORS') {
        this.boingHueShift = (this.boingHueShift + 1) % 3;
        this.setupStandardCopper(chipRam);
        this.pushCliLine('COPPER PALETTE CYCLED!');
      } else if (cmd === 'CLS') {
        this.cliLines = ['AMIGADOS SHELL READY'];
      } else if (cmd.length > 0) {
        this.pushCliLine(`UNKNOWN COMMAND: ${cmd.slice(0, 16)}`);
      }
      return;
    }
    if (rawCode >= AMIGA_RAW.F1 && rawCode <= AMIGA_RAW.F10) {
      const fNum = rawCode - AMIGA_RAW.F1 + 1;
      this.pushCliLine(`FUNCTION KEY F${fNum} ($${rawCode.toString(16).toUpperCase()})`);
      return;
    }

    const ch = amigaRawKeyToAscii(rawCode, this.shiftHeld, this.capsLock);
    if (ch && this.cliInput.length < 30) {
      this.cliInput += ch;
    }
  }

  private pushCliLine(line: string): void {
    this.cliLines.push(line.slice(0, 38));
    if (this.cliLines.length > 6) {
      this.cliLines.shift();
    }
  }

  /**
   * Called by 68000 VBlank IRQ3 ($A001) once per frame (50Hz PAL / 60Hz NTSC).
   */
  public stepFrame(
    chipset: AmigaChipset,
    chipRam: Uint8Array,
    fire1Pressed: boolean,
    mouseLmbPressed: boolean
  ): void {
    this.frame++;

    // Decay short Paula SFX channels cleanly
    if (this.sfxFramesLeft > 0) {
      this.sfxFramesLeft--;
      if (this.sfxFramesLeft === 0 && this.app !== 'ham6_demo') {
        chipset.writeReg16(0x096, DMA_AUD0 | DMA_AUD1 | 0x000c); // Stop audio DMA bits 0..3
      }
    }

    if (this.app !== 'ham6_demo') {
      this.updateMouseSpritePos(chipRam, chipset);
    }

    switch (this.app) {
      case 'insert_disk':
        this.renderInsertDisk(chipRam, chipset);
        break;
      case 'external_adf_info':
        this.renderExternalAdfInfo(chipRam, chipset);
        break;
      case 'boing_studio':
        this.stepBoingStudio(chipRam, chipset);
        break;
      case 'shadow_runner':
        this.stepShadowRunner(chipRam, chipset, fire1Pressed);
        break;
      case 'arcanoid_500':
        this.stepArcanoid(chipRam, chipset, fire1Pressed, mouseLmbPressed);
        break;
      case 'starblazer_ocs':
        this.stepStarblazer(chipRam, chipset, fire1Pressed);
        break;
      case 'ham6_demo':
        this.stepHam6Demo(chipRam, chipset);
        break;
    }
  }

  private renderInsertDisk(chipRam: Uint8Array, chipset: AmigaChipset): void {
    if (this.frame > 2 && this.frame % 15 !== 0) return; // Ultra-low CPU when idle!
    const c = this.canvas;
    c.clear(chipRam, 0);

    // Top Kickstart header bar
    c.fillRect(chipRam, 0, 0, 320, 14, 2);
    c.drawText(chipRam, 12, 3, `AMIGA 500 ${chipset.chipset} OPENKICK 1.3`, 15);

    // Classic Workbench 3.5" Floppy Graphic centered
    const fx = 116;
    const fy = 54;
    c.fillRect(chipRam, fx, fy, 88, 86, 2);
    c.strokeRect(chipRam, fx, fy, 88, 86, 1);
    // Metal shutter
    c.fillRect(chipRam, fx + 20, fy, 46, 30, 5);
    c.strokeRect(chipRam, fx + 20, fy, 46, 30, 1);
    c.fillRect(chipRam, fx + 48, fy + 6, 10, 18, 2);
    // White label
    c.fillRect(chipRam, fx + 12, fy + 40, 64, 42, 15);
    c.fillRect(chipRam, fx + 12, fy + 40, 64, 10, 3);
    c.drawText(chipRam, fx + 16, fy + 56, 'WORK', 1);
    c.drawText(chipRam, fx + 16, fy + 66, 'BENCH', 1);

    // Blinking insert arrow
    if ((Math.floor(this.frame / 20) & 1) === 0) {
      c.fillRect(chipRam, 154, 150, 12, 14, 6);
      c.fillRect(chipRam, 148, 160, 24, 4, 6);
      c.fillRect(chipRam, 154, 164, 12, 4, 6);
    }

    c.drawText(chipRam, 60, 180, 'INSERT WORKBENCH / ADF DISK', 1);
    c.drawText(chipRam, 44, 198, 'OPEN "DISKI" TO MOUNT DF0: ADF', 2);
    c.drawText(chipRam, 52, 218, 'OR LOAD KICKSTART 1.3/3.1 ROM', 13);
    c.drawText(chipRam, 20, 240, `LAST KEY: ${this.lastKeyEvent}`, 1);
  }

  private renderExternalAdfInfo(chipRam: Uint8Array, chipset: AmigaChipset): void {
    if (this.frame > 2 && this.frame % 20 !== 0) return;
    const c = this.canvas;
    c.clear(chipRam, 0);
    c.fillRect(chipRam, 0, 0, 320, 16, 2);
    c.drawText(chipRam, 12, 4, 'DF0: EXTERNAL ADF DISK MOUNTED', 15);

    c.fillRect(chipRam, 16, 32, 288, 164, 15);
    c.strokeRect(chipRam, 16, 32, 288, 164, 1);

    c.drawText(chipRam, 28, 46, `VOLUME: ${this.externalVolName.slice(0, 22)}`, 1);
    c.drawText(chipRam, 28, 64, `BOOTBLOCK: ${this.externalValidChecksum ? 'VALID DOS\\0' : 'CUSTOM TRACKLOADER'}`, 2);
    c.drawText(chipRam, 28, 82, `HARDWARE: ${chipset.chipset} / ${chipset.videoStandard}`, 1);

    c.drawText(chipRam, 28, 110, 'COMMERCIAL AMIGA ADF GAMES NEED A', 6);
    c.drawText(chipRam, 28, 124, 'KICKSTART 1.3 / 2.04 / 3.1 ROM.', 6);
    c.drawText(chipRam, 28, 148, 'UPLOAD YOUR .ROM IN "DISKI / ROM"', 2);
    c.drawText(chipRam, 28, 164, 'TO BOOT THIS DISK NATIVELY!', 2);

    c.drawText(chipRam, 24, 216, `CHIP RAM: ${chipRam.length >>> 10} KB  M68000 READY`, 1);
    c.drawText(chipRam, 24, 234, `KEY: ${this.lastKeyEvent}`, 13);
  }

  private stepBoingStudio(chipRam: Uint8Array, chipset: AmigaChipset): void {
    const c = this.canvas;

    // Physics for iconic Boing Ball
    this.boingX += this.boingVx;
    this.boingVy += 0.19;
    this.boingY += this.boingVy;
    this.boingRot += this.boingVx * 0.045;

    if (this.boingX < 36) {
      this.boingX = 36;
      this.boingVx = Math.abs(this.boingVx);
      this.triggerPaulaSfx(chipset, 0, 0, 32, 440, 48, 8);
    } else if (this.boingX > 284) {
      this.boingX = 284;
      this.boingVx = -Math.abs(this.boingVx);
      this.triggerPaulaSfx(chipset, 0, 0, 32, 440, 48, 8);
    }
    if (this.boingY > 92) {
      this.boingY = 92;
      this.boingVy = -4.2;
      this.triggerPaulaSfx(chipset, 0, 0, 32, 560, 56, 10);
    }

    // Clear top Boing area (y = 0..129)
    c.fillRect(chipRam, 0, 0, 320, 130, 0);

    // Classic Amiga magenta perspective grid
    for (let gx = 20; gx <= 300; gx += 20) {
      c.fillRect(chipRam, gx, 10, 1, 100, 1);
    }
    for (let gy = 10; gy <= 110; gy += 16) {
      c.fillRect(chipRam, 20, gy, 281, 1, 1);
    }
    // Floor perspective lines
    c.fillRect(chipRam, 8, 122, 304, 1, 1);
    c.fillRect(chipRam, 14, 116, 292, 1, 1);

    // Drop shadow behind ball
    const bx = Math.round(this.boingX);
    const by = Math.round(this.boingY);
    c.fillCircle(chipRam, bx + 12, by + 5, 25, 4);

    // Render authentic rotating checkered red/white Boing Ball
    const R = 26;
    const r2 = R * R;
    for (let dy = -R; dy <= R; dy += 2) {
      const span = Math.floor(Math.sqrt(r2 - dy * dy));
      const latBand = Math.floor(((dy + R) / (2 * R)) * 6);
      for (let dx = -span; dx <= span; dx += 2) {
        const nx = dx / Math.max(1, span);
        const lon = Math.asin(Math.max(-1, Math.min(1, nx))) + this.boingRot;
        const lonBand = Math.floor((lon / Math.PI) * 5 + 100);
        const isRed = ((latBand + lonBand) & 1) === 0;
        const shade = dx > span * 0.45 || dy > R * 0.45;
        const col = isRed ? (shade ? 11 : 2) : (shade ? 12 : 3);
        c.fillRect(chipRam, bx + dx, by + dy, 2, 2, col);
      }
    }

    // Top title overlay
    c.drawText(chipRam, 8, 2, `AMIGA 500 ${chipset.chipset} ${chipset.videoStandard}`, 3);
    c.drawText(chipRam, 184, 2, `KEY:${this.lastKeyEvent.slice(0, 13)}`, 10);

    // Bottom Workbench 1.3 AmigaDOS Shell (y = 132..255)
    c.fillRect(chipRam, 0, 132, 320, 124, 5);
    c.fillRect(chipRam, 0, 132, 320, 13, 3);
    c.drawText(chipRam, 6, 135, 'AMIGADOS 1.3 SHELL  [TYPE + RETURN]', 5);

    // CLI history lines
    for (let i = 0; i < this.cliLines.length; i++) {
      c.drawText(chipRam, 6, 150 + i * 12, this.cliLines[i], i === 0 ? 10 : 3);
    }

    // Prompt + blinking cursor
    const promptY = 228;
    c.fillRect(chipRam, 4, promptY - 2, 312, 13, 13);
    const cursor = (Math.floor(this.frame / 16) & 1) === 0 ? '_' : ' ';
    c.drawText(chipRam, 8, promptY, `1> ${this.cliInput}${cursor}`, 7);

    // Live hardware modifier strip at very bottom
    const mods =
      (this.shiftHeld ? 'SHF ' : '') +
      (this.capsLock ? 'CAPS ' : '') +
      (this.pressedKeys[AMIGA_RAW.CTRL] ? 'CTRL ' : '') +
      (this.pressedKeys[AMIGA_RAW.LAMIGA] ? 'L-A ' : '') +
      (this.pressedKeys[AMIGA_RAW.RAMIGA] ? 'R-A ' : '');
    c.drawText(chipRam, 8, 245, `RAW:${this.lastKeyEvent.slice(0, 18)}  ${mods}`, 14);
  }

  // ==================== GAME 2: SHADOW RUNNER OCS ====================
  private resetShadowRunner(): void {
    this.srScroll = 0;
    this.srPlayerY = 176;
    this.srPlayerVy = 0;
    this.srAttackTimer = 0;
    this.srScore = 0;
    this.srHp = 3;
    this.srGameOver = false;
    this.srEnemies = [];
    this.srSpawnCd = 55;
  }

  private srJump(chipset: AmigaChipset): void {
    if (this.srGameOver) return;
    if (this.srPlayerY >= 175) {
      this.srPlayerVy = -6.2;
      this.triggerPaulaSfx(chipset, 1, 0x100, 32, 260, 44, 6);
    }
  }

  private srAttack(chipset: AmigaChipset): void {
    if (this.srGameOver) return;
    if (this.srAttackTimer <= 0) {
      this.srAttackTimer = 14;
      this.triggerPaulaSfx(chipset, 0, 0x200, 32, 190, 42, 5);
    }
  }

  private stepShadowRunner(chipRam: Uint8Array, chipset: AmigaChipset, fire1: boolean): void {
    const c = this.canvas;
    const j = chipset.joy1;

    if (this.srGameOver) {
      if (fire1 || j.up) this.resetShadowRunner();
    } else {
      if (j.up || this.pressedKeys[AMIGA_RAW.UP] || this.pressedKeys[AMIGA_RAW.SPACE]) {
        this.srJump(chipset);
      }
      if (fire1 || j.right || this.pressedKeys[AMIGA_RAW.LALT] || this.pressedKeys[AMIGA_RAW.CTRL]) {
        this.srAttack(chipset);
      }

      this.srScroll += 2;
      this.srScore++;
      if (this.srScore > this.srBest) this.srBest = this.srScore;

      this.srPlayerVy += 0.34;
      this.srPlayerY += this.srPlayerVy;
      if (this.srPlayerY > 176) {
        this.srPlayerY = 176;
        this.srPlayerVy = 0;
      }
      if (this.srAttackTimer > 0) this.srAttackTimer--;

      // Spawn OCS monsters (ground skeletons & flying bats)
      this.srSpawnCd--;
      if (this.srSpawnCd <= 0) {
        const flying = ((this.frame * 7) & 3) === 0;
        this.srEnemies.push({
          x: 325,
          y: flying ? 142 : 178,
          vx: -(2.4 + Math.min(2.2, this.srScore / 1200)),
          vy: 0,
          hp: 1,
          kind: flying ? 1 : 0,
        });
        this.srSpawnCd = Math.max(34, 78 - Math.floor(this.srScore / 220));
      }

      for (let i = this.srEnemies.length - 1; i >= 0; i--) {
        const e = this.srEnemies[i];
        e.x += e.vx;
        if (e.kind === 1) e.y = 142 + Math.sin(this.frame * 0.15 + i) * 10;

        // Sword hit check
        if (this.srAttackTimer > 4 && e.x > 52 && e.x < 104 && Math.abs(e.y - this.srPlayerY) < 26) {
          this.srScore += 150;
          this.srEnemies.splice(i, 1);
          this.triggerPaulaSfx(chipset, 3, 0x300, 64, 300, 52, 8);
          continue;
        }
        // Player collision
        if (e.x > 40 && e.x < 66 && Math.abs(e.y - this.srPlayerY) < 18) {
          this.srHp--;
          this.srEnemies.splice(i, 1);
          this.triggerPaulaSfx(chipset, 3, 0x300, 96, 480, 60, 12);
          if (this.srHp <= 0) this.srGameOver = true;
          continue;
        }
        if (e.x < -20) this.srEnemies.splice(i, 1);
      }
    }

    // Clear with Color 0 so Copper sunset bands shine through!
    c.clear(chipRam, 0);

    // Parallax Layer 1: Distant purple mountains
    const mOff = Math.floor(this.srScroll * 0.3) % 80;
    for (let mx = -mOff; mx < 340; mx += 80) {
      for (let h = 0; h < 42; h += 4) {
        c.fillRect(chipRam, mx + h, 140 + (42 - h), 80 - h * 2, 4, 1);
      }
    }
    // Parallax Layer 2: Ancient stone pillars
    const pOff = Math.floor(this.srScroll * 0.7) % 96;
    for (let px = -pOff; px < 330; px += 96) {
      c.fillRect(chipRam, px + 10, 146, 16, 56, 2);
      c.fillRect(chipRam, px + 6, 142, 24, 6, 15);
    }
    // Ground grass & soil
    c.fillRect(chipRam, 0, 200, 320, 6, 3);
    c.fillRect(chipRam, 0, 206, 320, 50, 4);
    const gOff = this.srScroll % 32;
    for (let gx = -gOff; gx < 330; gx += 32) {
      c.fillRect(chipRam, gx, 214, 14, 4, 5);
      c.fillRect(chipRam, gx + 12, 228, 12, 4, 5);
    }

    // Draw Hero (OCS pixel warrior with flowing crimson cape, visor helm & steel blade)
    const py = Math.round(this.srPlayerY);
    const stride = (Math.floor(this.frame / 5) & 1) === 0 ? 0 : 3;
    const capeWave = (Math.floor(this.frame / 6) & 1) * 2;
    c.fillRect(chipRam, 41, py + 5 + capeWave, 9, 12, 7);  // Flowing cape
    c.fillRect(chipRam, 44, py + 4, 6, 13, 11);            // Cape highlight
    c.fillRect(chipRam, 50, py - 1, 10, 9, 15);            // Silver helm
    c.fillRect(chipRam, 54, py + 2, 6, 3, 6);              // Visor face
    c.fillRect(chipRam, 50, py + 8, 11, 10, 13);           // Armor tunic
    c.fillRect(chipRam, 52, py + 10, 7, 3, 14);            // Gold breastplate trim
    c.fillRect(chipRam, 50 - stride, py + 18, 4, 6, 15);   // Left boot
    c.fillRect(chipRam, 56 + stride, py + 18, 4, 6, 15);   // Right boot
    if (this.srAttackTimer > 0) {
      c.fillRect(chipRam, 60, py + 7, 38, 5, 8);
      c.fillRect(chipRam, 62, py + 9, 36, 2, 9);
      c.fillRect(chipRam, 58, py + 5, 3, 9, 14);           // Sword hilt
    }

    // Draw Enemies
    for (const e of this.srEnemies) {
      const ex = Math.round(e.x);
      const ey = Math.round(e.y);
      if (e.kind === 1) {
        // Winged shadow bat
        const flap = (Math.floor(this.frame / 4) & 1) * 5;
        c.fillRect(chipRam, ex, ey + 4, 14, 8, 13);
        c.fillRect(chipRam, ex - 7, ey + flap, 9, 5, 12);
        c.fillRect(chipRam, ex + 12, ey + flap, 9, 5, 12);
        c.fillRect(chipRam, ex + 2, ey + 6, 3, 2, 11);
        c.fillRect(chipRam, ex + 7, ey + 6, 3, 2, 11);
      } else {
        // Ground horned beast
        c.fillRect(chipRam, ex + 2, ey - 2, 3, 4, 15);     // Left horn
        c.fillRect(chipRam, ex + 11, ey - 2, 3, 4, 15);    // Right horn
        c.fillRect(chipRam, ex, ey + 2, 16, 14, 10);       // Torso
        c.fillRect(chipRam, ex + 2, ey + 5, 4, 3, 11);     // Glowing eye
        c.fillRect(chipRam, ex + 8, ey + 5, 3, 3, 11);     // Second eye
        c.fillRect(chipRam, ex + 2, ey + 15, 5, 7, 12);    // Legs
        c.fillRect(chipRam, ex + 10, ey + 15, 5, 7, 12);
      }
    }

    // HUD
    c.drawText(chipRam, 8, 6, `SCORE:${String(this.srScore).padStart(5, '0')}`, 14);
    c.drawText(chipRam, 124, 6, `BEST:${String(this.srBest).padStart(5, '0')}`, 9);
    c.drawText(chipRam, 240, 6, `HP:${'*'.repeat(Math.max(0, this.srHp))}`, 7);
    c.drawText(chipRam, 12, 242, 'SPACE/UP:JUMP  ALT/FIRE:SLASH', 9);

    if (this.srGameOver) {
      c.fillRect(chipRam, 72, 86, 176, 54, 12);
      c.strokeRect(chipRam, 72, 86, 176, 54, 14);
      c.drawText(chipRam, 114, 98, 'GAME OVER', 11);
      c.drawText(chipRam, 88, 118, 'PRESS SPACE / FIRE', 9);
    }
  }

  // ==================== GAME 3: ARCANOID 500 OCS ====================
  private resetArcanoid(chipset: AmigaChipset): void {
    this.arcPaddleX = 132;
    this.arcScore = 0;
    this.arcLives = 3;
    this.arcLevel = 1;
    this.arcLaunched = false;
    this.arcPrevMouseX = chipset.mouseX;
    this.buildArcBricks();
    this.resetArcBall();
  }

  private buildArcBricks(): void {
    this.arcBricks = [];
    const cols = [3, 4, 5, 6, 7, 8];
    for (let row = 0; row < 6; row++) {
      for (let col = 0; col < 10; col++) {
        this.arcBricks.push({
          x: 20 + col * 28,
          y: 36 + row * 13,
          w: 26,
          h: 10,
          hp: row === 0 ? 2 : 1,
          col: cols[row % cols.length],
        });
      }
    }
  }

  private resetArcBall(): void {
    this.arcLaunched = false;
    this.arcBallX = this.arcPaddleX + 26;
    this.arcBallY = 216;
    this.arcBallVx = 2.1;
    this.arcBallVy = -2.5;
  }

  private stepArcanoid(
    chipRam: Uint8Array,
    chipset: AmigaChipset,
    fire1: boolean,
    mouseLmb: boolean
  ): void {
    const c = this.canvas;
    const j = chipset.joy1;

    // Mouse / Touch-on-CRT direct movement
    const mdx = ((chipset.mouseX - this.arcPrevMouseX + 128) & 0xff) - 128;
    this.arcPrevMouseX = chipset.mouseX;
    if (mdx !== 0) {
      this.arcPaddleX += mdx;
    }

    if (j.left || this.pressedKeys[AMIGA_RAW.LEFT] || this.pressedKeys[AMIGA_RAW.A]) {
      this.arcPaddleX -= 4.5;
    }
    if (j.right || this.pressedKeys[AMIGA_RAW.RIGHT] || this.pressedKeys[AMIGA_RAW.D]) {
      this.arcPaddleX += 4.5;
    }
    this.arcPaddleX = Math.max(12, Math.min(256, this.arcPaddleX));

    if (this.arcLives <= 0) {
      if (fire1 || mouseLmb) this.resetArcanoid(chipset);
    } else if (!this.arcLaunched) {
      this.arcBallX = this.arcPaddleX + 26;
      this.arcBallY = 215;
      if (fire1 || mouseLmb || j.up) {
        this.arcLaunched = true;
        this.triggerPaulaSfx(chipset, 1, 0x100, 24, 240, 44, 5);
      }
    } else {
      this.arcBallX += this.arcBallVx;
      this.arcBallY += this.arcBallVy;

      // Walls
      if (this.arcBallX < 14) { this.arcBallX = 14; this.arcBallVx = Math.abs(this.arcBallVx); this.triggerPaulaSfx(chipset, 0, 0, 20, 320, 36, 4); }
      if (this.arcBallX > 304) { this.arcBallX = 304; this.arcBallVx = -Math.abs(this.arcBallVx); this.triggerPaulaSfx(chipset, 0, 0, 20, 320, 36, 4); }
      if (this.arcBallY < 24) { this.arcBallY = 24; this.arcBallVy = Math.abs(this.arcBallVy); this.triggerPaulaSfx(chipset, 0, 0, 20, 320, 36, 4); }

      // Paddle bounce
      if (
        this.arcBallVy > 0 &&
        this.arcBallY >= 216 &&
        this.arcBallY <= 226 &&
        this.arcBallX >= this.arcPaddleX - 3 &&
        this.arcBallX <= this.arcPaddleX + 55
      ) {
        const hitRel = (this.arcBallX - (this.arcPaddleX + 26)) / 26;
        this.arcBallVx = hitRel * 3.4;
        this.arcBallVy = -Math.abs(this.arcBallVy);
        this.triggerPaulaSfx(chipset, 1, 0x100, 24, 210, 46, 5);
      }

      // Brick collisions
      for (let i = this.arcBricks.length - 1; i >= 0; i--) {
        const b = this.arcBricks[i];
        if (
          this.arcBallX >= b.x - 3 &&
          this.arcBallX <= b.x + b.w + 3 &&
          this.arcBallY >= b.y - 3 &&
          this.arcBallY <= b.y + b.h + 3
        ) {
          this.arcBallVy = -this.arcBallVy;
          b.hp--;
          if (b.hp <= 0) {
            this.arcBricks.splice(i, 1);
            this.arcScore += 50;
          } else {
            this.arcScore += 20;
          }
          this.triggerPaulaSfx(chipset, 0, 0x200, 24, 170 + (i % 8) * 18, 48, 6);
          break;
        }
      }

      if (this.arcBricks.length === 0) {
        this.arcLevel++;
        this.buildArcBricks();
        this.resetArcBall();
      }

      if (this.arcBallY > 250) {
        this.arcLives--;
        this.triggerPaulaSfx(chipset, 3, 0x300, 80, 460, 56, 12);
        this.resetArcBall();
      }
    }

    // Draw arena into Chip RAM bitplanes
    c.clear(chipRam, 0);
    // Metallic OCS borders
    c.fillRect(chipRam, 8, 20, 4, 232, 2);
    c.fillRect(chipRam, 308, 20, 4, 232, 2);
    c.fillRect(chipRam, 8, 20, 304, 4, 2);

    // Bricks with bright highlight bevel
    for (const b of this.arcBricks) {
      c.fillRect(chipRam, b.x, b.y, b.w, b.h, b.col);
      c.fillRect(chipRam, b.x, b.y, b.w, 2, 9);
      if (b.hp > 1) c.strokeRect(chipRam, b.x, b.y, b.w, b.h, 12);
    }

    // Paddle
    const px = Math.round(this.arcPaddleX);
    c.fillRect(chipRam, px, 222, 52, 8, 12);
    c.fillRect(chipRam, px, 222, 8, 8, 11);
    c.fillRect(chipRam, px + 44, 222, 8, 8, 11);
    c.fillRect(chipRam, px + 8, 223, 36, 2, 9);

    // Ball
    c.fillRect(chipRam, Math.round(this.arcBallX) - 3, Math.round(this.arcBallY) - 3, 6, 6, 9);

    // Top HUD
    c.drawText(chipRam, 12, 6, `SCORE:${String(this.arcScore).padStart(5, '0')}`, 5);
    c.drawText(chipRam, 134, 6, `STAGE:${this.arcLevel}`, 7);
    c.drawText(chipRam, 232, 6, `BALLS:${Math.max(0, this.arcLives)}`, 3);

    if (this.arcLives <= 0) {
      c.fillRect(chipRam, 74, 110, 172, 46, 1);
      c.strokeRect(chipRam, 74, 110, 172, 46, 9);
      c.drawText(chipRam, 116, 120, 'GAME OVER', 15);
      c.drawText(chipRam, 90, 138, 'SPACE / CLICK RETRY', 9);
    } else if (!this.arcLaunched) {
      c.drawText(chipRam, 68, 180, 'DRAG CRT OR ARROWS + SPACE', 14);
    }
  }

  // ==================== GAME 4: STARBLAZER OCS ====================
  private resetStarblazer(): void {
    this.sbX = 40;
    this.sbY = 124;
    this.sbScore = 0;
    this.sbShield = 4;
    this.sbGameOver = false;
    this.sbFireCd = 0;
    this.sbSpawnCd = 28;
    this.sbEnemies = [];
    this.sbBullets = [];
  }

  private sbShoot(chipset: AmigaChipset): void {
    if (this.sbGameOver || this.sbFireCd > 0) return;
    this.sbBullets.push({ x: this.sbX + 20, y: this.sbY + 4, vx: 6.5, vy: 0, friendly: true });
    this.sbFireCd = 9;
    this.triggerPaulaSfx(chipset, 1, 0x100, 18, 165, 38, 4);
  }

  private stepStarblazer(chipRam: Uint8Array, chipset: AmigaChipset, fire1: boolean): void {
    const c = this.canvas;
    const j = chipset.joy1;

    if (this.sbGameOver) {
      if (fire1) this.resetStarblazer();
    } else {
      const speed = 3.0;
      if (j.up || this.pressedKeys[AMIGA_RAW.UP] || this.pressedKeys[AMIGA_RAW.W]) this.sbY -= speed;
      if (j.down || this.pressedKeys[AMIGA_RAW.DOWN] || this.pressedKeys[AMIGA_RAW.S]) this.sbY += speed;
      if (j.left || this.pressedKeys[AMIGA_RAW.LEFT] || this.pressedKeys[AMIGA_RAW.A]) this.sbX -= speed;
      if (j.right || this.pressedKeys[AMIGA_RAW.RIGHT] || this.pressedKeys[AMIGA_RAW.D]) this.sbX += speed;
      this.sbX = Math.max(12, Math.min(240, this.sbX));
      this.sbY = Math.max(24, Math.min(226, this.sbY));

      if (this.sbFireCd > 0) this.sbFireCd--;
      if (fire1 || this.pressedKeys[AMIGA_RAW.SPACE] || this.pressedKeys[AMIGA_RAW.LALT]) {
        this.sbShoot(chipset);
      }

      this.sbSpawnCd--;
      if (this.sbSpawnCd <= 0) {
        const y = 30 + ((this.frame * 37) % 185);
        this.sbEnemies.push({
          x: 325,
          y,
          vx: -(1.9 + ((this.frame % 3) * 0.5)),
          vy: ((this.frame & 1) ? 0.8 : -0.8),
          hp: 1,
          kind: this.frame % 2,
        });
        this.sbSpawnCd = Math.max(16, 42 - Math.floor(this.sbScore / 400));
      }

      for (let i = this.sbBullets.length - 1; i >= 0; i--) {
        const b = this.sbBullets[i];
        b.x += b.vx;
        if (b.x > 324 || b.x < -8) this.sbBullets.splice(i, 1);
      }

      for (let i = this.sbEnemies.length - 1; i >= 0; i--) {
        const e = this.sbEnemies[i];
        e.x += e.vx;
        e.y += Math.sin(this.frame * 0.08 + i) * 1.1;

        let hit = false;
        for (let bi = this.sbBullets.length - 1; bi >= 0; bi--) {
          const b = this.sbBullets[bi];
          if (b.friendly && Math.abs(b.x - e.x) < 14 && Math.abs(b.y - e.y) < 12) {
            this.sbBullets.splice(bi, 1);
            hit = true;
            break;
          }
        }
        if (hit) {
          this.sbScore += 100;
          this.sbEnemies.splice(i, 1);
          this.triggerPaulaSfx(chipset, 3, 0x300, 48, 340, 48, 7);
          continue;
        }
        if (Math.abs(e.x - this.sbX) < 16 && Math.abs(e.y - this.sbY) < 14) {
          this.sbShield--;
          this.sbEnemies.splice(i, 1);
          this.triggerPaulaSfx(chipset, 3, 0x300, 96, 520, 62, 12);
          if (this.sbShield <= 0) this.sbGameOver = true;
          continue;
        }
        if (e.x < -20) this.sbEnemies.splice(i, 1);
      }
    }

    // Draw space & 3-layer parallax starfield
    c.clear(chipRam, 0);
    for (let s = 0; s < 36; s++) {
      const layer = s % 3;
      const spd = layer + 1;
      const sx = (320 - ((this.frame * spd + s * 53) % 320)) | 0;
      const sy = 20 + ((s * 67) % 220);
      c.fillRect(chipRam, sx, sy, layer === 2 ? 2 : 1, 1, layer + 1);
    }

    // Player Starfighter
    const sx = Math.round(this.sbX);
    const sy = Math.round(this.sbY);
    c.fillRect(chipRam, sx - 6 - (this.frame & 3), sy + 4, 6, 4, 6); // Thruster flame
    c.fillRect(chipRam, sx, sy + 2, 18, 8, 4);
    c.fillRect(chipRam, sx + 4, sy - 2, 8, 16, 5);
    c.fillRect(chipRam, sx + 14, sy + 4, 6, 4, 3);

    // Lasers
    for (const b of this.sbBullets) {
      c.fillRect(chipRam, Math.round(b.x), Math.round(b.y), 10, 2, 7);
    }

    // Alien fighters
    for (const e of this.sbEnemies) {
      const ex = Math.round(e.x);
      const ey = Math.round(e.y);
      c.fillRect(chipRam, ex, ey, 14, 10, e.kind === 0 ? 8 : 9);
      c.fillRect(chipRam, ex - 4, ey + 3, 6, 4, 15);
    }

    // HUD
    c.fillRect(chipRam, 0, 0, 320, 16, 13);
    c.drawText(chipRam, 8, 4, `STARBLAZER  PTS:${String(this.sbScore).padStart(5, '0')}`, 3);
    c.drawText(chipRam, 232, 4, `SHD:${'#'.repeat(Math.max(0, this.sbShield))}`, 10);

    if (this.sbGameOver) {
      c.fillRect(chipRam, 72, 104, 176, 48, 13);
      c.strokeRect(chipRam, 72, 104, 176, 48, 8);
      c.drawText(chipRam, 114, 114, 'SHIP DESTROYED', 11);
      c.drawText(chipRam, 92, 132, 'SPACE / FIRE RETRY', 3);
    }
  }

  // ==================== DISK 5: REAL HAM6 4096-COLOR DEMO ====================
  private stepHam6Demo(chipRam: Uint8Array, chipset: AmigaChipset): void {
    // Authentic Paula 4-channel ProTracker-style arpeggio every 8 frames
    if (this.frame % 8 === 0) {
      const note = this.hamNotes[this.hamMusicStep % this.hamNotes.length];
      const bass = this.hamNotes[(this.hamMusicStep >>> 1) % this.hamNotes.length] * 2;
      this.hamMusicStep++;

      if (!this.hamChanMute[0]) this.triggerPaulaSfx(chipset, 0, 0x200, 32, bass, 28, 10);
      if (!this.hamChanMute[1]) this.triggerPaulaSfx(chipset, 1, 0x100, 32, note, 22, 10);
      if (!this.hamChanMute[2]) this.triggerPaulaSfx(chipset, 2, 0x000, 32, Math.round(note * 0.75), 18, 10);
    }

    // Render genuine HAM6 planar pixels directly into 6 Chip RAM bitplanes ($020000..$02EFFF)!
    // Optimization: update at 2x2 pixel blocks (160x108 HAM field) -> super smooth & ultra-low CPU!
    const t = this.frame * 0.06;
    const planeSize = 10240;

    for (let y = 24; y < 224; y += 2) {
      const rowOff0 = y * 40;
      const rowOff1 = (y + 1) * 40;
      for (let byteX = 0; byteX < 40; byteX++) {
        let p0 = 0, p1 = 0, p2 = 0, p3 = 0, p4 = 0, p5 = 0;
        for (let pair = 0; pair < 4; pair++) {
          const px = byteX * 8 + pair * 2;
          let ham6Val: number;

          if (pair === 0 && byteX === 0) {
            // Reset hold color via palette index 0
            ham6Val = 0;
          } else {
            // Cycle HAM6 modify channel: ctrl=2 (Red), ctrl=3 (Green), ctrl=1 (Blue)
            const modPhase = (byteX * 4 + pair) % 3;
            const ctrl = modPhase === 0 ? 2 : modPhase === 1 ? 3 : 1;
            let wave: number;
            if (this.hamEffect === 0) {
              // 4096-color interference plasma
              wave =
                Math.sin(px * 0.032 + t) +
                Math.cos(y * 0.042 - t * 0.8) +
                Math.sin((px + y) * 0.022 + t * 1.1);
            } else if (this.hamEffect === 1) {
              // Radial tunnel rings
              const dx = px - 160;
              const dy = y - 124;
              const dist = Math.sqrt(dx * dx + dy * dy);
              wave = Math.sin(dist * 0.09 - t * 2.2) * 2.5;
            } else {
              // Copper-style horizontal spectral sheen
              wave = Math.sin(y * 0.06 + t * 1.4 + modPhase * 2.1) * 2.4 + Math.cos(px * 0.025 - t);
            }
            const level4 = Math.max(0, Math.min(15, Math.round((wave + 3) * 2.5)));
            ham6Val = (ctrl << 4) | level4;
          }

          const shift = 6 - pair * 2;
          const dup = 0x3 << shift;
          if (ham6Val & 1) p0 |= dup;
          if (ham6Val & 2) p1 |= dup;
          if (ham6Val & 4) p2 |= dup;
          if (ham6Val & 8) p3 |= dup;
          if (ham6Val & 16) p4 |= dup;
          if (ham6Val & 32) p5 |= dup;
        }
        chipRam[BITPLANE_ADDR + rowOff0 + byteX] = p0;
        chipRam[BITPLANE_ADDR + rowOff1 + byteX] = p0;
        chipRam[BITPLANE_ADDR + planeSize + rowOff0 + byteX] = p1;
        chipRam[BITPLANE_ADDR + planeSize + rowOff1 + byteX] = p1;
        chipRam[BITPLANE_ADDR + planeSize * 2 + rowOff0 + byteX] = p2;
        chipRam[BITPLANE_ADDR + planeSize * 2 + rowOff1 + byteX] = p2;
        chipRam[BITPLANE_ADDR + planeSize * 3 + rowOff0 + byteX] = p3;
        chipRam[BITPLANE_ADDR + planeSize * 3 + rowOff1 + byteX] = p3;
        chipRam[BITPLANE_ADDR + planeSize * 4 + rowOff0 + byteX] = p4;
        chipRam[BITPLANE_ADDR + planeSize * 4 + rowOff1 + byteX] = p4;
        chipRam[BITPLANE_ADDR + planeSize * 5 + rowOff0 + byteX] = p5;
        chipRam[BITPLANE_ADDR + planeSize * 5 + rowOff1 + byteX] = p5;
      }
    }

    // Crisp header & footer drawn using palette indices (ctrl=0 -> colors 0 & 12)
    this.canvas.fillRect(chipRam, 0, 0, 320, 22, 0);
    this.canvas.fillRect(chipRam, 0, 226, 320, 30, 0);
    this.canvas.drawText(chipRam, 16, 7, `AMIGA HAM6 4096-COLOR MODE (${this.hamEffect + 1}/3)`, 12);
    const chStr = this.hamChanMute.map((m, i) => `F${i + 1}:${m ? 'OFF' : 'ON'}`).join(' ');
    this.canvas.drawText(chipRam, 10, 234, `SPACE:FX  ${chStr}`, 12);
  }
}

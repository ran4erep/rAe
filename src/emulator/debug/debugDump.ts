/**
 * On-demand Amiga 500 Debug Dump Generator.
 * Runs ONLY when explicitly requested by the user (0% runtime CPU overhead).
 * Captures CPU state, fault/PC history, memory around PC, stack, exception vectors,
 * decoded Copper lists, chipset/CIA/floppy/hardfile registers, screen summary, and full RAM.
 */

import { AmigaMachine } from '../hardware/amigaMachine';
import {
  DMA_AUD0,
  DMA_AUD1,
  DMA_AUD2,
  DMA_AUD3,
  DMA_BITPLANE,
  DMA_BLITTER,
  DMA_COPPER,
  DMA_DISK,
  DMA_MASTER,
  DMA_SPRITE,
  INT_AUD0,
  INT_AUD1,
  INT_AUD2,
  INT_AUD3,
  INT_BLIT,
  INT_COPER,
  INT_DSKBLK,
  INT_DSKSYN,
  INT_EXTER,
  INT_INTEN,
  INT_PORTS,
  INT_RBF,
  INT_SOFT,
  INT_TBE,
  INT_VERTB,
} from '../hardware/chipset';
import { verifyAmigaBootblockChecksum } from '../hardware/floppy';
import { AmigaConfig } from '../types';

export const CUSTOM_REG_NAMES: Record<number, string> = {
  0x020: 'DSKPTH', 0x022: 'DSKPTL', 0x024: 'DSKLEN', 0x026: 'DSKDAT',
  0x028: 'REFPTR', 0x02a: 'VPOSW',  0x02c: 'VHPOSW', 0x02e: 'COPCON',
  0x030: 'SERDAT', 0x032: 'SERPER', 0x034: 'POTGO',  0x036: 'JOYTEST',
  0x040: 'BLTCON0',0x042: 'BLTCON1',0x044: 'BLTAFWM',0x046: 'BLTALWM',
  0x048: 'BLTCPTH',0x04a: 'BLTCPTL',0x04c: 'BLTBPTH',0x04e: 'BLTBPTL',
  0x050: 'BLTAPTH',0x052: 'BLTAPTL',0x054: 'BLTDPTH',0x056: 'BLTDPTL',
  0x058: 'BLTSIZE',0x05a: 'BLTCON0L',0x05c: 'BLTSIZV',0x05e: 'BLTSIZH',
  0x060: 'BLTCMOD',0x062: 'BLTBMOD',0x064: 'BLTAMOD',0x066: 'BLTDMOD',
  0x070: 'BLTCDAT',0x072: 'BLTBDAT',0x074: 'BLTADAT',0x07e: 'DSKSYNC',
  0x080: 'COP1LCH',0x082: 'COP1LCL',0x084: 'COP2LCH',0x086: 'COP2LCL',
  0x088: 'COPJMP1',0x08a: 'COPJMP2',0x08c: 'COPINS', 0x08e: 'DIWSTRT',
  0x090: 'DIWSTOP',0x092: 'DDFSTRT',0x094: 'DDFSTOP',0x096: 'DMACON',
  0x098: 'CLXCON', 0x09a: 'INTENA', 0x09c: 'INTREQ', 0x09e: 'ADKCON',
  0x0a0: 'AUD0LCH',0x0a2: 'AUD0LCL',0x0a4: 'AUD0LEN',0x0a6: 'AUD0PER',0x0a8: 'AUD0VOL',
  0x0b0: 'AUD1LCH',0x0b2: 'AUD1LCL',0x0b4: 'AUD1LEN',0x0b6: 'AUD1PER',0x0b8: 'AUD1VOL',
  0x0c0: 'AUD2LCH',0x0c2: 'AUD2LCL',0x0c4: 'AUD2LEN',0x0c6: 'AUD2PER',0x0c8: 'AUD2VOL',
  0x0d0: 'AUD3LCH',0x0d2: 'AUD3LCL',0x0d4: 'AUD3LEN',0x0d6: 'AUD3PER',0x0d8: 'AUD3VOL',
  0x0e0: 'BPL1PTH',0x0e2: 'BPL1PTL',0x0e4: 'BPL2PTH',0x0e6: 'BPL2PTL',
  0x0e8: 'BPL3PTH',0x0ea: 'BPL3PTL',0x0ec: 'BPL4PTH',0x0ee: 'BPL4PTL',
  0x0f0: 'BPL5PTH',0x0f2: 'BPL5PTL',0x0f4: 'BPL6PTH',0x0f6: 'BPL6PTL',
  0x0f8: 'BPL7PTH',0x0fa: 'BPL7PTL',0x0fc: 'BPL8PTH',0x0fe: 'BPL8PTL',
  0x100: 'BPLCON0',0x102: 'BPLCON1',0x104: 'BPLCON2',0x106: 'BPLCON3',
  0x108: 'BPL1MOD',0x10a: 'BPL2MOD',0x10c: 'BPLCON4',
  0x110: 'BPL1DAT',0x112: 'BPL2DAT',0x114: 'BPL3DAT',0x116: 'BPL4DAT',
  0x118: 'BPL5DAT',0x11a: 'BPL6DAT',0x11c: 'BPL7DAT',0x11e: 'BPL8DAT',
  0x120: 'SPR0PTH',0x122: 'SPR0PTL',0x124: 'SPR1PTH',0x126: 'SPR1PTL',
  0x128: 'SPR2PTH',0x12a: 'SPR2PTL',0x12c: 'SPR3PTH',0x12e: 'SPR3PTL',
  0x130: 'SPR4PTH',0x132: 'SPR4PTL',0x134: 'SPR5PTH',0x136: 'SPR5PTL',
  0x138: 'SPR6PTH',0x13a: 'SPR6PTL',0x13c: 'SPR7PTH',0x13e: 'SPR7PTL',
  0x140: 'SPR0POS',0x142: 'SPR0CTL',0x144: 'SPR0DATA',0x146: 'SPR0DATB',
  0x148: 'SPR1POS',0x14a: 'SPR1CTL',0x14c: 'SPR1DATA',0x14e: 'SPR1DATB',
  0x150: 'SPR2POS',0x152: 'SPR2CTL',0x154: 'SPR2DATA',0x156: 'SPR2DATB',
  0x158: 'SPR3POS',0x15a: 'SPR3CTL',0x15c: 'SPR3DATA',0x15e: 'SPR3DATB',
  0x160: 'SPR4POS',0x162: 'SPR4CTL',0x164: 'SPR4DATA',0x166: 'SPR4DATB',
  0x168: 'SPR5POS',0x16a: 'SPR5CTL',0x16c: 'SPR5DATA',0x16e: 'SPR5DATB',
  0x170: 'SPR6POS',0x172: 'SPR6CTL',0x174: 'SPR6DATA',0x176: 'SPR6DATB',
  0x178: 'SPR7POS',0x17a: 'SPR7CTL',0x17c: 'SPR7DATA',0x17e: 'SPR7DATB',
  0x1e4: 'DIWHIGH',0x1fc: 'FMODE',
};

for (let i = 0; i < 32; i++) {
  CUSTOM_REG_NAMES[0x180 + i * 2] = `COLOR${i.toString().padStart(2, '0')}`;
}

export const VECTOR_NAMES: Record<number, string> = {
  0: 'Initial SSP',
  1: 'Initial PC',
  2: 'Bus Error',
  3: 'Address Error',
  4: 'Illegal Instruction',
  5: 'Zero Divide',
  6: 'CHK Instruction',
  7: 'TRAPV Instruction',
  8: 'Privilege Violation',
  9: 'Trace',
  10: 'Line-A Emulator ($Axxx)',
  11: 'Line-F Emulator ($Fxxx)',
  15: 'Uninitialized Interrupt',
  24: 'Spurious Interrupt',
  25: 'Level 1 IRQ (TBE/DSKBLK/SOFT)',
  26: 'Level 2 IRQ (CIA-A PORTS)',
  27: 'Level 3 IRQ (VERTB/COPER/BLIT)',
  28: 'Level 4 IRQ (Audio 0-3)',
  29: 'Level 5 IRQ (RBF/DSKSYN)',
  30: 'Level 6 IRQ (CIA-B EXTER)',
  31: 'Level 7 NMI',
};

export function hex(val: number, width: number): string {
  return '0x' + ((val >>> 0).toString(16).toUpperCase().padStart(width, '0'));
}

export function uint8ToBase64(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64');
}

export function base64ToUint8(b64: string): Uint8Array {
  if (!b64) return new Uint8Array(0);
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

export function bytesToHexString(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    if (i > 0) out += ' ';
    out += bytes[i].toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

export function decodeDmaconFlags(dmacon: number): string[] {
  const flags: string[] = [];
  if (dmacon & DMA_MASTER) flags.push('DMAEN');
  if (dmacon & DMA_BITPLANE) flags.push('BPLEN');
  if (dmacon & DMA_COPPER) flags.push('COPEN');
  if (dmacon & DMA_BLITTER) flags.push('BLTEN');
  if (dmacon & DMA_SPRITE) flags.push('SPREN');
  if (dmacon & DMA_DISK) flags.push('DSKEN');
  if (dmacon & DMA_AUD0) flags.push('AUD0');
  if (dmacon & DMA_AUD1) flags.push('AUD1');
  if (dmacon & DMA_AUD2) flags.push('AUD2');
  if (dmacon & DMA_AUD3) flags.push('AUD3');
  if (dmacon & (1 << 10)) flags.push('BLTPRI');
  return flags;
}

export function decodeIntFlags(mask: number): string[] {
  const flags: string[] = [];
  if (mask & INT_INTEN) flags.push('INTEN');
  if (mask & INT_EXTER) flags.push('EXTER');
  if (mask & INT_DSKSYN) flags.push('DSKSYN');
  if (mask & INT_RBF) flags.push('RBF');
  if (mask & INT_AUD3) flags.push('AUD3');
  if (mask & INT_AUD2) flags.push('AUD2');
  if (mask & INT_AUD1) flags.push('AUD1');
  if (mask & INT_AUD0) flags.push('AUD0');
  if (mask & INT_BLIT) flags.push('BLIT');
  if (mask & INT_VERTB) flags.push('VERTB');
  if (mask & INT_COPER) flags.push('COPER');
  if (mask & INT_PORTS) flags.push('PORTS');
  if (mask & INT_SOFT) flags.push('SOFT');
  if (mask & INT_DSKBLK) flags.push('DSKBLK');
  if (mask & INT_TBE) flags.push('TBE');
  return flags;
}

export function classifyAddressRegion(
  addr: number,
  ovl: boolean,
  chipRamSize: number,
  slowRamSize: number,
  fastRamSize: number,
  expBase: number
): string {
  const a = addr & 0x00ffffff;
  if (a < 0x200000) {
    if (ovl && a < 0x080000) return 'kickstart_rom_overlay';
    if (a < chipRamSize || a < 0x100000) return 'chip_ram';
    return 'unmapped';
  }
  if (fastRamSize > 0 && a >= 0x200000 && a < 0x200000 + fastRamSize) return 'fast_ram';
  if (slowRamSize > 0 && a >= 0xc00000 && a < 0xc00000 + slowRamSize) return 'slow_ram';
  if (a >= 0xdf0000 && a < 0xe00000) return 'custom_chips';
  if (a >= 0xbfd000 && a < 0xbff000) return 'cia';
  if (expBase > 0 && a >= expBase && a < expBase + 0x10000) return 'expansion_rom';
  if (a >= 0xf80000) return 'kickstart_rom';
  return 'unmapped';
}

export function decodeCopperListFromPeek(
  peek16: (addr: number) => number,
  startAddr: number,
  maxInsns = 180
): string[] {
  const addr0 = startAddr & 0x00fffffe;
  if (addr0 === 0) return [];
  const out: string[] = [];
  for (let i = 0; i < maxInsns; i++) {
    const pc = (addr0 + i * 4) & 0x00fffffe;
    const ir1 = peek16(pc);
    const ir2 = peek16((pc + 2) & 0x00fffffe);
    if ((ir1 & 1) === 0) {
      const reg = ir1 & 0x1fe;
      const name = CUSTOM_REG_NAMES[reg] ?? `REG_${hex(reg, 3)}`;
      out.push(`${hex(pc, 6)}: MOVE ${name} ($DFF${reg.toString(16).toUpperCase().padStart(3, '0')}) <- ${hex(ir2, 4)}`);
    } else {
      const vp = (ir1 >>> 8) & 0xff;
      const hp = ir1 & 0xfe;
      const bfd = (ir2 & 0x8000) !== 0 ? 1 : 0;
      const vm = (ir2 >>> 8) & 0x7f;
      const hm = ir2 & 0xfe;
      const isSkip = (ir2 & 1) !== 0;
      out.push(
        `${hex(pc, 6)}: ${isSkip ? 'SKIP' : 'WAIT'} V>=${hex(vp, 2)} H>=${hex(hp, 2)} (mask V=${hex(vm, 2)} H=${hex(hm, 2)} BFD=${bfd})`
      );
      if (!isSkip && vp === 0xff && hp === 0xfe) {
        break;
      }
    }
  }
  return out;
}

function decodeCopperList(machine: AmigaMachine, startAddr: number, maxInsns = 180): string[] {
  return decodeCopperListFromPeek((addr) => machine.memory.peek16(addr), startAddr, maxInsns);
}

export function buildCustomRegsNonZero(regs: ArrayLike<number>, limit = 256): Record<string, string> {
  const customRegsNonZero: Record<string, string> = {};
  const n = Math.min(limit, regs.length);
  for (let i = 0; i < n; i++) {
    const val = regs[i];
    if (val !== 0) {
      const regOff = i * 2;
      const label = CUSTOM_REG_NAMES[regOff] ?? `REG_${regOff.toString(16).toUpperCase().padStart(3, '0')}`;
      customRegsNonZero[`$DFF${regOff.toString(16).toUpperCase().padStart(3, '0')} (${label})`] = hex(val, 4);
    }
  }
  return customRegsNonZero;
}

export function buildExceptionVectorsFromPeek(
  peek32: (addr: number) => number,
  chipRam: Uint8Array
): AmigaDebugDump['cpu']['exceptionVectors'] {
  const exceptionVectors: AmigaDebugDump['cpu']['exceptionVectors'] = [];
  for (let v = 0; v < 48; v++) {
    const off = v * 4;
    const chipLw =
      off + 3 < chipRam.length
        ? ((chipRam[off] << 24) |
            (chipRam[off + 1] << 16) |
            (chipRam[off + 2] << 8) |
            chipRam[off + 3]) >>>
          0
        : 0;
    const vecName =
      VECTOR_NAMES[v] ??
      (v >= 32 && v <= 47 ? `TRAP #${v - 32}` : `Vector ${v}`);
    exceptionVectors.push({
      vector: v,
      offset: hex(off, 3),
      name: vecName,
      busValue: hex(peek32(off), 8),
      chipRamValue: hex(chipLw, 8),
    });
  }
  return exceptionVectors;
}

export function summarizeFramebuffer(machine: AmigaMachine): {
  width: number;
  height: number;
  nonBlackPixels: number;
  uniqueSampledColors: number;
  topNonBlackY: number | null;
  dominantColorAbgrHex: string;
} {
  const fb = machine.getFramebuffer();
  const { width, height } = machine.getFramebufferSize();
  const counts = new Map<number, number>();
  let nonBlackPixels = 0;
  let topNonBlackY: number | null = null;

  for (let y = 0; y < height; y++) {
    const rowOff = y * width;
    for (let x = 0; x < width; x++) {
      const px = fb[rowOff + x] >>> 0;
      const rgb = px & 0x00ffffff;
      if (rgb !== 0) {
        nonBlackPixels++;
        if (topNonBlackY === null) topNonBlackY = y;
      }
      if ((x & 3) === 0 && (y & 3) === 0) {
        counts.set(px, (counts.get(px) ?? 0) + 1);
      }
    }
  }

  let dominantColor = 0xff000000;
  let maxCount = -1;
  for (const [color, c] of counts) {
    if (c > maxCount) {
      maxCount = c;
      dominantColor = color;
    }
  }

  return {
    width,
    height,
    nonBlackPixels,
    uniqueSampledColors: counts.size,
    topNonBlackY,
    dominantColorAbgrHex: hex(dominantColor, 8),
  };
}

export interface AmigaDebugDump {
  format: 'amiga500-debug-dump-v1';
  timestamp: string;
  machine: {
    frameCount: number;
    measuredFps: number;
    paused: boolean;
    romName: string;
    isOpenKick: boolean;
    powerLed: boolean;
    capsLock: boolean;
    ovl: boolean;
    config: AmigaConfig;
  };
  diagnostics: {
    pc: string;
    pcRegion: string;
    cpuStopped: boolean;
    recentFaultCount: number;
    pcStuckLikely: boolean;
    screenSummary: ReturnType<typeof summarizeFramebuffer>;
  };
  cpu: {
    pc: string;
    sr: string;
    srFlags: {
      T: boolean;
      S: boolean;
      IPL: number;
      X: boolean;
      N: boolean;
      Z: boolean;
      V: boolean;
      C: boolean;
    };
    usp: string;
    ssp: string;
    stopped: boolean;
    pendingIpl: number;
    cycles: number;
    d: string[];
    a: string[];
    recentFaults: Array<{
      vector: number;
      name: string;
      pc: string;
      opcode: string;
      sr: string;
      sp: string;
      cycles: number;
    }>;
    recentFramePcs: string[];
    codeAroundPc: {
      startAddr: string;
      pcOffsetBytes: number;
      wordsHex: string[];
    };
    stack: {
      activeSp: string;
      ssp: string;
      usp: string;
      activeLongsHex: string[];
      sspLongsHex: string[];
    };
    exceptionVectors: Array<{
      vector: number;
      offset: string;
      name: string;
      busValue: string;
      chipRamValue: string;
    }>;
  };
  chipset: {
    dmacon: string;
    dmaconFlags: string[];
    intena: string;
    intenaFlags: string[];
    intreq: string;
    intreqFlags: string[];
    adkcon: string;
    vpos: number;
    hpos: number;
    lof: number;
    beamCon0: string;
    copper: {
      cop1lc: string;
      cop2lc: string;
      copPc: string;
      copCon: string;
      copWaiting: boolean;
      copWaitV: number;
      copWaitH: number;
      copMaskV: number;
      copMaskH: number;
      cop1Decoded: string[];
      cop2Decoded: string[];
    };
    display: {
      bplCon0: string;
      bplCon1: string;
      bplCon2: string;
      bpl1Mod: number;
      bpl2Mod: number;
      diwStrt: string;
      diwStop: string;
      ddfStrt: string;
      ddfStop: string;
      diwHigh: string;
      bplPtHex: string[];
      paletteHex: string[];
    };
    sprites: Array<{ index: number; pt: string; pos: string; ctl: string }>;
    blitter: {
      bltCon0: string;
      bltCon1: string;
      bltAfwm: string;
      bltAlwm: string;
      bltApt: string;
      bltBpt: string;
      bltCpt: string;
      bltDpt: string;
      bltAmod: number;
      bltBmod: number;
      bltCmod: number;
      bltDmod: number;
      bltSizV: number;
      bltZero: boolean;
    };
    diskDma: {
      dskPt: string;
      dskLen: string;
      dskSync: string;
      dskDmaActive: boolean;
      dskDmaWordsLeft: number;
    };
    audio: Array<{
      channel: number;
      lc: string;
      len: number;
      per: number;
      vol: number;
      active: boolean;
    }>;
    customRegsNonZero: Record<string, string>;
  };
  cia: {
    ciaA: {
      pra: string;
      prb: string;
      ddra: string;
      ddrb: string;
      ta: string;
      taLatch: string;
      tb: string;
      tbLatch: string;
      tod: string;
      sdr: string;
      icrData: string;
      icrMask: string;
      cra: string;
      crb: string;
      ovlActive: boolean;
      powerLedBright: boolean;
    };
    ciaB: {
      pra: string;
      prb: string;
      ddra: string;
      ddrb: string;
      ta: string;
      taLatch: string;
      tb: string;
      tbLatch: string;
      tod: string;
      sdr: string;
      icrData: string;
      icrMask: string;
      cra: string;
      crb: string;
    };
  };
  storage: {
    df0: {
      inserted: boolean;
      name: string;
      sizeBytes: number;
      cylinder: number;
      side: number;
      motorOn: boolean;
      selected: boolean;
      writeProtected: boolean;
      diskChanged: boolean;
      trackBytePos: number;
      ioSeq: number;
      bootblockValid: boolean;
      bootblockHeaderHex: string;
    };
    df1: {
      inserted: boolean;
      name: string;
      sizeBytes: number;
      cylinder: number;
      side: number;
      motorOn: boolean;
      selected: boolean;
      writeProtected: boolean;
      diskChanged: boolean;
      trackBytePos: number;
      bootblockValid: boolean;
      bootblockHeaderHex: string;
    };
    dh0: {
      mounted: boolean;
      name: string;
      sizeBytes: number;
      isRdb: boolean;
      hasReadSinceReset: boolean;
      partitions: Array<{ dosName: string; dosTypeStr: string; volumeName: string; bootPri: number }>;
    };
    dh1: {
      mounted: boolean;
      name: string;
      sizeBytes: number;
      isRdb: boolean;
      hasReadSinceReset: boolean;
      partitions: Array<{ dosName: string; dosTypeStr: string; volumeName: string; bootPri: number }>;
    };
  };
  memory: {
    ovl: boolean;
    chipRamSize: number;
    slowRamSize: number;
    fastRamSize: number;
    romHeaderHex: string;
    chipRamBase64: string;
    slowRamBase64: string;
    fastRamBase64: string;
  };
}

export function buildAmigaDebugDump(machine: AmigaMachine): AmigaDebugDump {
  const { cpu, chipset, cia, memory, floppy, hardfile } = machine;
  const status = machine.getStatusSnapshot();
  const faults = cpu.getRecentFaults();
  const framePcs = machine.getRecentPcHistory();

  let pcStuckLikely = false;
  if (framePcs.length >= 20) {
    const tail = new Set(framePcs.slice(-20));
    pcStuckLikely = tail.size <= 3;
  }

  // Code window around PC (64 bytes before to 192 bytes after)
  const pcAligned = cpu.pc & 0x00fffffe;
  const codeStart = Math.max(0, pcAligned - 64) & 0x00fffffe;
  const codeWordCount = 128; // 256 bytes
  const wordsHex: string[] = [];
  for (let i = 0; i < codeWordCount; i++) {
    wordsHex.push(hex(memory.peek16((codeStart + i * 2) & 0x00fffffe), 4));
  }

  // Stack inspection (32 longwords from A7, plus 16 from SSP if in User mode)
  const activeSp = cpu.a[7] >>> 0;
  const activeLongsHex: string[] = [];
  for (let i = 0; i < 32; i++) {
    activeLongsHex.push(hex(memory.peek32((activeSp + i * 4) & 0x00fffffe), 8));
  }
  const sspLongsHex: string[] = [];
  if ((cpu.sr & 0x2000) === 0) {
    const sspAddr = cpu.ssp >>> 0;
    for (let i = 0; i < 16; i++) {
      sspLongsHex.push(hex(memory.peek32((sspAddr + i * 4) & 0x00fffffe), 8));
    }
  }

  // Exception vectors 0..31 plus TRAP #0..15 (32..47)
  const exceptionVectors: AmigaDebugDump['cpu']['exceptionVectors'] = [];
  for (let v = 0; v < 48; v++) {
    const off = v * 4;
    const chipLw =
      off + 3 < memory.chipRam.length
        ? ((memory.chipRam[off] << 24) |
            (memory.chipRam[off + 1] << 16) |
            (memory.chipRam[off + 2] << 8) |
            memory.chipRam[off + 3]) >>>
          0
        : 0;
    const vecName =
      VECTOR_NAMES[v] ??
      (v >= 32 && v <= 47 ? `TRAP #${v - 32}` : `Vector ${v}`);
    exceptionVectors.push({
      vector: v,
      offset: hex(off, 3),
      name: vecName,
      busValue: hex(memory.peek32(off), 8),
      chipRamValue: hex(chipLw, 8),
    });
  }

  // Custom regs non-zero map
  const customRegsNonZero: Record<string, string> = {};
  for (let i = 0; i < chipset.regs.length; i++) {
    const val = chipset.regs[i];
    if (val !== 0) {
      const regOff = i * 2;
      const label = CUSTOM_REG_NAMES[regOff] ?? `REG_${regOff.toString(16).toUpperCase().padStart(3, '0')}`;
      customRegsNonZero[`$DFF${regOff.toString(16).toUpperCase().padStart(3, '0')} (${label})`] = hex(val, 4);
    }
  }

  const d0 = floppy.drives[0];
  const d1 = floppy.drives[1];
  const h0 = hardfile.units[0];
  const h1 = hardfile.units[1];

  return {
    format: 'amiga500-debug-dump-v1',
    timestamp: new Date().toISOString(),
    machine: {
      frameCount: machine.frameCount,
      measuredFps: machine.measuredFps,
      paused: machine.paused,
      romName: machine.romName,
      isOpenKick: machine.isOpenKick,
      powerLed: status.powerLed,
      capsLock: status.capsLock,
      ovl: memory.ovl,
      config: { ...machine.config },
    },
    diagnostics: {
      pc: hex(cpu.pc, 6),
      pcRegion: classifyAddressRegion(
        cpu.pc,
        memory.ovl,
        memory.chipRamSize,
        memory.slowRamSize,
        memory.fastRamSize,
        hardfile.configuredBase
      ),
      cpuStopped: cpu.stopped,
      recentFaultCount: faults.length,
      pcStuckLikely,
      screenSummary: summarizeFramebuffer(machine),
    },
    cpu: {
      pc: hex(cpu.pc, 8),
      sr: hex(cpu.sr, 4),
      srFlags: {
        T: (cpu.sr & 0x8000) !== 0,
        S: (cpu.sr & 0x2000) !== 0,
        IPL: (cpu.sr >>> 8) & 7,
        X: (cpu.sr & 0x0010) !== 0,
        N: (cpu.sr & 0x0008) !== 0,
        Z: (cpu.sr & 0x0004) !== 0,
        V: (cpu.sr & 0x0002) !== 0,
        C: (cpu.sr & 0x0001) !== 0,
      },
      usp: hex(cpu.usp, 8),
      ssp: hex(cpu.ssp, 8),
      stopped: cpu.stopped,
      pendingIpl: cpu.pendingIpl,
      cycles: cpu.cycles,
      d: Array.from(cpu.d, (v) => hex(v, 8)),
      a: Array.from(cpu.a, (v) => hex(v, 8)),
      recentFaults: faults.map((f) => ({
        vector: f.vector,
        name: VECTOR_NAMES[f.vector] ?? `Vector ${f.vector}`,
        pc: hex(f.pc, 8),
        opcode: hex(f.opcode, 4),
        sr: hex(f.sr, 4),
        sp: hex(f.sp, 8),
        cycles: f.cycles,
      })),
      recentFramePcs: framePcs.map((p) => hex(p, 6)),
      codeAroundPc: {
        startAddr: hex(codeStart, 6),
        pcOffsetBytes: pcAligned - codeStart,
        wordsHex,
      },
      stack: {
        activeSp: hex(activeSp, 8),
        ssp: hex(cpu.ssp, 8),
        usp: hex(cpu.usp, 8),
        activeLongsHex,
        sspLongsHex,
      },
      exceptionVectors,
    },
    chipset: {
      dmacon: hex(chipset.dmacon, 4),
      dmaconFlags: decodeDmaconFlags(chipset.dmacon),
      intena: hex(chipset.intena, 4),
      intenaFlags: decodeIntFlags(chipset.intena),
      intreq: hex(chipset.intreq, 4),
      intreqFlags: decodeIntFlags(chipset.intreq),
      adkcon: hex(chipset.adkcon, 4),
      vpos: chipset.vpos,
      hpos: chipset.getHpos(),
      lof: chipset.lof,
      beamCon0: hex(chipset.beamCon0, 4),
      copper: {
        cop1lc: hex(chipset.cop1lc, 6),
        cop2lc: hex(chipset.cop2lc, 6),
        copPc: hex(chipset.copPc, 6),
        copCon: hex(chipset.copCon, 4),
        copWaiting: chipset.copWaiting,
        copWaitV: chipset.copWaitV,
        copWaitH: chipset.copWaitH,
        copMaskV: chipset.copMaskV,
        copMaskH: chipset.copMaskH,
        cop1Decoded: decodeCopperList(machine, chipset.cop1lc),
        cop2Decoded: chipset.cop2lc !== chipset.cop1lc ? decodeCopperList(machine, chipset.cop2lc) : [],
      },
      display: {
        bplCon0: hex(chipset.bplCon0, 4),
        bplCon1: hex(chipset.bplCon1, 4),
        bplCon2: hex(chipset.bplCon2, 4),
        bpl1Mod: chipset.bpl1Mod,
        bpl2Mod: chipset.bpl2Mod,
        diwStrt: hex(chipset.diwStrt, 4),
        diwStop: hex(chipset.diwStop, 4),
        ddfStrt: hex(chipset.ddfStrt, 4),
        ddfStop: hex(chipset.ddfStop, 4),
        diwHigh: hex(chipset.diwHigh, 4),
        bplPtHex: Array.from(
          chipset.bplPt.subarray(0, status.chipset === 'AGA' ? 8 : 6),
          (p) => hex(p, 6)
        ),
        paletteHex:
          status.chipset === 'AGA'
            ? Array.from(chipset.colorReg24, (c) => hex(c, 6))
            : Array.from(chipset.colorReg, (c) => hex(c, 3)),
      },
      sprites: Array.from({ length: 8 }, (_, i) => ({
        index: i,
        pt: hex(chipset.sprPt[i], 6),
        pos: hex(chipset.sprPos[i], 4),
        ctl: hex(chipset.sprCtl[i], 4),
      })),
      blitter: {
        bltCon0: hex(chipset.bltCon0, 4),
        bltCon1: hex(chipset.bltCon1, 4),
        bltAfwm: hex(chipset.bltAfwm, 4),
        bltAlwm: hex(chipset.bltAlwm, 4),
        bltApt: hex(chipset.bltApt, 6),
        bltBpt: hex(chipset.bltBpt, 6),
        bltCpt: hex(chipset.bltCpt, 6),
        bltDpt: hex(chipset.bltDpt, 6),
        bltAmod: chipset.bltAmod,
        bltBmod: chipset.bltBmod,
        bltCmod: chipset.bltCmod,
        bltDmod: chipset.bltDmod,
        bltSizV: chipset.bltSizV,
        bltZero: chipset.bltZero,
      },
      diskDma: {
        dskPt: hex(chipset.dskPt, 6),
        dskLen: hex(chipset.dskLen, 4),
        dskSync: hex(chipset.dskSync, 4),
        dskDmaActive: chipset.dskDmaActive,
        dskDmaWordsLeft: chipset.dskDmaWordsLeft,
      },
      audio: chipset.audio.map((ch, idx) => ({
        channel: idx,
        lc: hex(ch.lc, 6),
        len: ch.len,
        per: ch.per,
        vol: ch.vol,
        active: ch.active,
      })),
      customRegsNonZero,
    },
    cia: {
      ciaA: {
        pra: hex(cia.praA, 2),
        prb: hex(cia.prbA, 2),
        ddra: hex(cia.ddraA, 2),
        ddrb: hex(cia.ddrbA, 2),
        ta: hex(cia.taA, 4),
        taLatch: hex(cia.taLatchA, 4),
        tb: hex(cia.tbA, 4),
        tbLatch: hex(cia.tbLatchA, 4),
        tod: hex(cia.todA, 6),
        sdr: hex(cia.sdrA, 2),
        icrData: hex(cia.icrDataA, 2),
        icrMask: hex(cia.icrMaskA, 2),
        cra: hex(cia.craA, 2),
        crb: hex(cia.crbA, 2),
        ovlActive: cia.isOvlActive(),
        powerLedBright: cia.isPowerLedBright(),
      },
      ciaB: {
        pra: hex(cia.praB, 2),
        prb: hex(cia.prbB, 2),
        ddra: hex(cia.ddraB, 2),
        ddrb: hex(cia.ddrbB, 2),
        ta: hex(cia.taB, 4),
        taLatch: hex(cia.taLatchB, 4),
        tb: hex(cia.tbB, 4),
        tbLatch: hex(cia.tbLatchB, 4),
        tod: hex(cia.todB, 6),
        sdr: hex(cia.sdrB, 2),
        icrData: hex(cia.icrDataB, 2),
        icrMask: hex(cia.icrMaskB, 2),
        cra: hex(cia.craB, 2),
        crb: hex(cia.crbB, 2),
      },
    },
    storage: {
      df0: {
        inserted: d0.data !== null,
        name: d0.name,
        sizeBytes: d0.data?.length ?? 0,
        cylinder: d0.cylinder,
        side: d0.side,
        motorOn: d0.motorOn,
        selected: d0.selected,
        writeProtected: d0.writeProtected,
        diskChanged: d0.diskChanged,
        trackBytePos: d0.trackBytePos,
        ioSeq: floppy.ioSeq,
        bootblockValid: d0.data ? verifyAmigaBootblockChecksum(d0.data) : false,
        bootblockHeaderHex: d0.data ? bytesToHexString(d0.data.subarray(0, 64)) : '',
      },
      df1: {
        inserted: d1.data !== null,
        name: d1.name,
        sizeBytes: d1.data?.length ?? 0,
        cylinder: d1.cylinder,
        side: d1.side,
        motorOn: d1.motorOn,
        selected: d1.selected,
        writeProtected: d1.writeProtected,
        diskChanged: d1.diskChanged,
        trackBytePos: d1.trackBytePos,
        bootblockValid: d1.data ? verifyAmigaBootblockChecksum(d1.data) : false,
        bootblockHeaderHex: d1.data ? bytesToHexString(d1.data.subarray(0, 64)) : '',
      },
      dh0: {
        mounted: h0.data !== null,
        name: h0.name,
        sizeBytes: h0.data?.length ?? 0,
        isRdb: h0.isRdb,
        hasReadSinceReset: h0.hasReadSinceReset,
        partitions: h0.partitions.map((p) => ({
          dosName: p.dosName,
          dosTypeStr: p.dosTypeStr,
          volumeName: p.volumeName,
          bootPri: p.bootPri,
        })),
      },
      dh1: {
        mounted: h1.data !== null,
        name: h1.name,
        sizeBytes: h1.data?.length ?? 0,
        isRdb: h1.isRdb,
        hasReadSinceReset: h1.hasReadSinceReset,
        partitions: h1.partitions.map((p) => ({
          dosName: p.dosName,
          dosTypeStr: p.dosTypeStr,
          volumeName: p.volumeName,
          bootPri: p.bootPri,
        })),
      },
    },
    memory: {
      ovl: memory.ovl,
      chipRamSize: memory.chipRamSize,
      slowRamSize: memory.slowRamSize,
      fastRamSize: memory.fastRamSize,
      romHeaderHex: bytesToHexString(memory.rom.subarray(0, 64)),
      chipRamBase64: uint8ToBase64(memory.chipRam),
      slowRamBase64: uint8ToBase64(memory.slowRam),
      fastRamBase64: uint8ToBase64(memory.fastRam),
    },
  };
}

export function formatDebugDumpFilename(machine: AmigaMachine, now = new Date()): string {
  const rawLabel =
    machine.floppy.drives[0].name ||
    machine.hardfile.units[1].name ||
    machine.hardfile.units[0].name ||
    'amiga500';
  const cleanLabel =
    rawLabel
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32) || 'amiga500';
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `debug-${cleanLabel}-${stamp}.json`;
}

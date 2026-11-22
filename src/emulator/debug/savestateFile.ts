/**
 * Diagnostic Amiga 500 Savestate Exporter & Importer (`amiga500-savestate-v1`).
 * Runs ONLY on explicit user export/import (0% runtime CPU overhead).
 * Places human/AI-readable CPU, Fault, Copper, Chipset, CIA, Screen, and Storage diagnostics
 * at the TOP of the JSON, followed by the full replayable savestate + DF0/DF1 disk payload.
 */

import { AmigaMachine } from '../hardware/amigaMachine';
import { verifyAmigaBootblockChecksum } from '../hardware/floppy';
import {
  SaveSlotData,
  SaveSlotDiskPayload,
  SaveSlotIndex,
  SerializedAmigaState,
} from '../types';
import {
  AmigaDebugDump,
  base64ToUint8,
  buildCustomRegsNonZero,
  buildExceptionVectorsFromPeek,
  bytesToHexString,
  classifyAddressRegion,
  decodeCopperListFromPeek,
  decodeDmaconFlags,
  decodeIntFlags,
  hex,
  summarizeFramebuffer,
  uint8ToBase64,
  VECTOR_NAMES,
} from './debugDump';

export interface SerializedDiskBlob {
  name: string;
  base64: string;
}

export interface AmigaDiagnosticSavestateFile {
  format: 'amiga500-savestate-v1';
  timestamp: string;
  source: 'live' | `slot-${SaveSlotIndex}`;
  machine: AmigaDebugDump['machine'] & {
    activeVideoStandard: string;
    romHeaderHex: string;
  };
  diagnostics: {
    pc: string;
    pcRegion: string;
    cpuStopped: boolean;
    recentFaultCount: number;
    pcStuckLikely: boolean;
    screenSummary: ReturnType<typeof summarizeFramebuffer> | null;
  };
  cpu: AmigaDebugDump['cpu'];
  chipset: AmigaDebugDump['chipset'];
  cia: AmigaDebugDump['cia'];
  storage: AmigaDebugDump['storage'];
  savestate: {
    state: SerializedAmigaState;
    df0Disk: SerializedDiskBlob | null;
    df1Disk: SerializedDiskBlob | null;
    screenshotDataUrl: string | null;
  };
}

function buildSrFlags(sr: number) {
  return {
    T: (sr & 0x8000) !== 0,
    S: (sr & 0x2000) !== 0,
    IPL: (sr >>> 8) & 7,
    X: (sr & 0x0010) !== 0,
    N: (sr & 0x0008) !== 0,
    Z: (sr & 0x0004) !== 0,
    V: (sr & 0x0002) !== 0,
    C: (sr & 0x0001) !== 0,
  };
}

function buildCodeWindow(peek16: (addr: number) => number, pc: number) {
  const pcAligned = pc & 0x00fffffe;
  const codeStart = Math.max(0, pcAligned - 64) & 0x00fffffe;
  const wordsHex: string[] = new Array(128);
  for (let i = 0; i < 128; i++) {
    wordsHex[i] = hex(peek16((codeStart + i * 2) & 0x00fffffe), 4);
  }
  return {
    startAddr: hex(codeStart, 6),
    pcOffsetBytes: pcAligned - codeStart,
    wordsHex,
  };
}

function buildStackView(
  peek32: (addr: number) => number,
  activeSp: number,
  ssp: number,
  sr: number
) {
  const activeLongsHex: string[] = new Array(32);
  for (let i = 0; i < 32; i++) {
    activeLongsHex[i] = hex(peek32((activeSp + i * 4) & 0x00fffffe), 8);
  }
  const sspLongsHex: string[] = [];
  if ((sr & 0x2000) === 0) {
    const sspAddr = ssp >>> 0;
    for (let i = 0; i < 16; i++) {
      sspLongsHex.push(hex(peek32((sspAddr + i * 4) & 0x00fffffe), 8));
    }
  }
  return {
    activeSp: hex(activeSp, 8),
    ssp: hex(ssp, 8),
    usp: hex(activeSp, 8),
    activeLongsHex,
    sspLongsHex,
  };
}

export function buildDiagnosticSavestateFromMachine(
  machine: AmigaMachine,
  screenshotDataUrl: string | null = null
): AmigaDiagnosticSavestateFile {
  const { cpu, chipset, cia, memory, floppy, hardfile } = machine;
  const bundle = machine.exportSaveBundle();
  const status = machine.getStatusSnapshot();
  const faults = cpu.getRecentFaults();
  const framePcs = machine.getRecentPcHistory();

  let pcStuckLikely = false;
  if (framePcs.length >= 20) {
    const tail = new Set(framePcs.slice(-20));
    pcStuckLikely = tail.size <= 3;
  }

  const peek16 = (addr: number) => memory.peek16(addr);
  const peek32 = (addr: number) => memory.peek32(addr);
  const activeSp = cpu.a[7] >>> 0;
  const stackView = buildStackView(peek32, activeSp, cpu.ssp, cpu.sr);
  stackView.usp = hex(cpu.usp, 8);

  const d0 = floppy.drives[0];
  const d1 = floppy.drives[1];
  const h0 = hardfile.units[0];
  const h1 = hardfile.units[1];

  return {
    format: 'amiga500-savestate-v1',
    timestamp: new Date(bundle.state.timestamp).toISOString(),
    source: 'live',
    machine: {
      frameCount: machine.frameCount,
      measuredFps: machine.measuredFps,
      paused: machine.paused,
      romName: machine.romName,
      isOpenKick: machine.isOpenKick,
      powerLed: status.powerLed,
      capsLock: status.capsLock,
      ovl: memory.ovl,
      activeVideoStandard: machine.getActiveVideoStandard(),
      romHeaderHex: bytesToHexString(memory.rom.subarray(0, 64)),
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
      srFlags: buildSrFlags(cpu.sr),
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
      codeAroundPc: buildCodeWindow(peek16, cpu.pc),
      stack: stackView,
      exceptionVectors: buildExceptionVectorsFromPeek(peek32, memory.chipRam),
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
        cop1Decoded: decodeCopperListFromPeek(peek16, chipset.cop1lc),
        cop2Decoded:
          chipset.cop2lc !== chipset.cop1lc ? decodeCopperListFromPeek(peek16, chipset.cop2lc) : [],
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
      customRegsNonZero: buildCustomRegsNonZero(chipset.regs),
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
    savestate: {
      state: bundle.state,
      df0Disk: bundle.df0Disk
        ? { name: bundle.df0Disk.name, base64: uint8ToBase64(bundle.df0Disk.bytes) }
        : null,
      df1Disk: bundle.df1Disk
        ? { name: bundle.df1Disk.name, base64: uint8ToBase64(bundle.df1Disk.bytes) }
        : null,
      screenshotDataUrl,
    },
  };
}

export function buildDiagnosticSavestateFromSlot(
  slot: SaveSlotIndex,
  data: SaveSlotData
): AmigaDiagnosticSavestateFile {
  const st = data.state;
  const chipRam = base64ToUint8(st.chipRamBase64);
  const slowRam = st.slowRamBase64 ? base64ToUint8(st.slowRamBase64) : new Uint8Array(0);
  const fastRam = st.fastRamBase64 ? base64ToUint8(st.fastRamBase64) : new Uint8Array(0);
  const regs = st.customRegs ?? [];
  const ovl = st.ovl ?? ((st.ciaA?.[0] ?? 0) & 0x01) !== 0;

  const peek8 = (addr: number): number => {
    const a = addr & 0x00ffffff;
    if (a < 0x200000) {
      if (ovl && a < 0x080000) return 0xff;
      if (a < chipRam.length) return chipRam[a];
      if (a < 0x100000 && chipRam.length > 0) return chipRam[a & (chipRam.length - 1)];
      return 0xff;
    }
    if (a >= 0xc00000 && a < 0xc00000 + slowRam.length) return slowRam[a - 0xc00000];
    if (fastRam.length > 0 && a >= 0x200000 && a < 0x200000 + fastRam.length) {
      return fastRam[a - 0x200000];
    }
    if (a >= 0xdff000 && a < 0xe00000) {
      const w = regs[(a & 0x1fe) >>> 1] ?? 0;
      return (a & 1) === 0 ? (w >>> 8) & 0xff : w & 0xff;
    }
    return 0xff;
  };
  const peek16 = (addr: number): number => {
    const a = addr & 0x00fffffe;
    return ((peek8(a) << 8) | peek8((a + 1) & 0x00ffffff)) & 0xffff;
  };
  const peek32 = (addr: number): number => {
    const a = addr & 0x00fffffe;
    return ((peek16(a) << 16) | peek16((a + 2) & 0x00ffffff)) >>> 0;
  };

  const regAt = (offset: number): number => regs[offset >>> 1] ?? 0;
  const baseIdx = 256;
  const dmacon = regs.length >= baseIdx + 12 ? regs[baseIdx] : regAt(0x096);
  const intena = regs.length >= baseIdx + 12 ? regs[baseIdx + 1] : regAt(0x09a);
  const intreq = regs.length >= baseIdx + 12 ? regs[baseIdx + 2] : regAt(0x09c);
  const adkcon = regs.length >= baseIdx + 12 ? regs[baseIdx + 3] : regAt(0x09e);
  const cop1lc =
    regs.length >= baseIdx + 12 ? regs[baseIdx + 4] : ((regAt(0x080) << 16) | regAt(0x082)) >>> 0;
  const cop2lc =
    regs.length >= baseIdx + 12 ? regs[baseIdx + 5] : ((regAt(0x084) << 16) | regAt(0x086)) >>> 0;
  const bplCon0 = regs.length >= baseIdx + 12 ? regs[baseIdx + 6] : regAt(0x100);
  const bplCon1 = regs.length >= baseIdx + 12 ? regs[baseIdx + 7] : regAt(0x102);
  const bplCon2 = regs.length >= baseIdx + 12 ? regs[baseIdx + 8] : regAt(0x104);
  const diwStrt = regs.length >= baseIdx + 12 ? regs[baseIdx + 9] : regAt(0x08e);
  const diwStop = regs.length >= baseIdx + 12 ? regs[baseIdx + 10] : regAt(0x090);
  const dskPt =
    regs.length >= baseIdx + 12 ? regs[baseIdx + 11] : ((regAt(0x020) << 16) | regAt(0x022)) >>> 0;

  const isAga = st.config?.chipset === 'AGA';
  const paletteHex: string[] = isAga && Array.isArray(st.agaColors24)
    ? st.agaColors24.map((c) => hex(c, 6))
    : Array.from({ length: 32 }, (_, i) => hex(regAt(0x180 + i * 2) & 0x0fff, 3));
  const bplCount = isAga ? 8 : 6;
  const bplPtHex: string[] = new Array(bplCount);
  for (let i = 0; i < bplCount; i++) {
    const p = st.bplPt?.[i] ?? (((regAt(0x0e0 + i * 4) << 16) | regAt(0x0e2 + i * 4)) >>> 0);
    bplPtHex[i] = hex(p, 6);
  }
  const sprites = Array.from({ length: 8 }, (_, i) => ({
    index: i,
    pt: hex(st.sprPt?.[i] ?? (((regAt(0x120 + i * 4) << 16) | regAt(0x122 + i * 4)) >>> 0), 6),
    pos: hex(regAt(0x140 + i * 8), 4),
    ctl: hex(regAt(0x142 + i * 8), 4),
  }));

  const ciaA = st.ciaA ?? [];
  const ciaB = st.ciaB ?? [];
  const dRegs = st.cpuRegs.slice(0, 8);
  const aRegs = st.cpuRegs.slice(8, 16);
  const activeSp = (aRegs[7] ?? 0) >>> 0;
  const stackView = buildStackView(peek32, activeSp, st.ssp, st.sr);
  stackView.usp = hex(st.usp, 8);

  const df0Bytes = data.df0Disk?.bytes ?? null;
  const df1Bytes = data.df1Disk?.bytes ?? null;
  const df0St = st.df0State;
  const df1St = st.df1State;

  return {
    format: 'amiga500-savestate-v1',
    timestamp: new Date(data.timestamp || st.timestamp).toISOString(),
    source: `slot-${slot}`,
    machine: {
      frameCount: st.frameCount ?? 0,
      measuredFps: 0,
      paused: false,
      romName: st.romName,
      isOpenKick: st.isOpenKick ?? false,
      powerLed: ((ciaA[0] ?? 0) & 0x02) === 0,
      capsLock: false,
      ovl,
      activeVideoStandard:
        st.activeVideoStandard ?? (st.config.videoStandard === 'NTSC' ? 'NTSC' : 'PAL'),
      romHeaderHex: '',
      config: { ...st.config },
    },
    diagnostics: {
      pc: hex(st.pc, 6),
      pcRegion: classifyAddressRegion(
        st.pc,
        ovl,
        chipRam.length,
        slowRam.length,
        fastRam.length,
        0
      ),
      cpuStopped: Boolean(st.stopped),
      recentFaultCount: 0,
      pcStuckLikely: false,
      screenSummary: null,
    },
    cpu: {
      pc: hex(st.pc, 8),
      sr: hex(st.sr, 4),
      srFlags: buildSrFlags(st.sr),
      usp: hex(st.usp, 8),
      ssp: hex(st.ssp, 8),
      stopped: Boolean(st.stopped),
      pendingIpl: 0,
      cycles: 0,
      d: dRegs.map((v) => hex(v, 8)),
      a: aRegs.map((v) => hex(v, 8)),
      recentFaults: [],
      recentFramePcs: [],
      codeAroundPc: buildCodeWindow(peek16, st.pc),
      stack: stackView,
      exceptionVectors: buildExceptionVectorsFromPeek(peek32, chipRam),
    },
    chipset: {
      dmacon: hex(dmacon, 4),
      dmaconFlags: decodeDmaconFlags(dmacon),
      intena: hex(intena, 4),
      intenaFlags: decodeIntFlags(intena),
      intreq: hex(intreq, 4),
      intreqFlags: decodeIntFlags(intreq),
      adkcon: hex(adkcon, 4),
      vpos: 0,
      hpos: 0,
      lof: 0,
      beamCon0: hex(st.beamCon0 ?? regAt(0x1dc), 4),
      copper: {
        cop1lc: hex(cop1lc, 6),
        cop2lc: hex(cop2lc, 6),
        copPc: hex(st.copPc ?? cop1lc, 6),
        copCon: hex(regAt(0x02e), 4),
        copWaiting: Boolean(st.copWaiting),
        copWaitV: st.copWaitV ?? 0,
        copWaitH: st.copWaitH ?? 0,
        copMaskV: st.copMaskV ?? 0x7f,
        copMaskH: st.copMaskH ?? 0xfe,
        cop1Decoded: decodeCopperListFromPeek(peek16, cop1lc),
        cop2Decoded: cop2lc !== cop1lc ? decodeCopperListFromPeek(peek16, cop2lc) : [],
      },
      display: {
        bplCon0: hex(bplCon0, 4),
        bplCon1: hex(bplCon1, 4),
        bplCon2: hex(bplCon2, 4),
        bpl1Mod: (regAt(0x108) << 16) >> 16,
        bpl2Mod: (regAt(0x10a) << 16) >> 16,
        diwStrt: hex(diwStrt, 4),
        diwStop: hex(diwStop, 4),
        ddfStrt: hex(regAt(0x092), 4),
        ddfStop: hex(regAt(0x094), 4),
        diwHigh: hex(regAt(0x1e4), 4),
        bplPtHex,
        paletteHex,
      },
      sprites,
      blitter: {
        bltCon0: hex(regAt(0x040), 4),
        bltCon1: hex(regAt(0x042), 4),
        bltAfwm: hex(regAt(0x044), 4),
        bltAlwm: hex(regAt(0x046), 4),
        bltApt: hex(((regAt(0x050) << 16) | regAt(0x052)) >>> 0, 6),
        bltBpt: hex(((regAt(0x04c) << 16) | regAt(0x04e)) >>> 0, 6),
        bltCpt: hex(((regAt(0x048) << 16) | regAt(0x04a)) >>> 0, 6),
        bltDpt: hex(((regAt(0x054) << 16) | regAt(0x056)) >>> 0, 6),
        bltAmod: (regAt(0x064) << 16) >> 16,
        bltBmod: (regAt(0x062) << 16) >> 16,
        bltCmod: (regAt(0x060) << 16) >> 16,
        bltDmod: (regAt(0x066) << 16) >> 16,
        bltSizV: 0,
        bltZero: false,
      },
      diskDma: {
        dskPt: hex(dskPt, 6),
        dskLen: hex(regAt(0x024), 4),
        dskSync: hex(regAt(0x07e), 4),
        dskDmaActive: false,
        dskDmaWordsLeft: 0,
      },
      audio: Array.from({ length: 4 }, (_, ch) => ({
        channel: ch,
        lc: hex(((regAt(0x0a0 + ch * 16) << 16) | regAt(0x0a2 + ch * 16)) >>> 0, 6),
        len: regAt(0x0a4 + ch * 16),
        per: regAt(0x0a6 + ch * 16),
        vol: regAt(0x0a8 + ch * 16),
        active: false,
      })),
      customRegsNonZero: buildCustomRegsNonZero(regs, 256),
    },
    cia: {
      ciaA: {
        pra: hex(ciaA[0] ?? 0, 2),
        prb: hex(ciaA[1] ?? 0, 2),
        ddra: hex(ciaA[2] ?? 0, 2),
        ddrb: hex(ciaA[3] ?? 0, 2),
        ta: hex(ciaA[4] ?? 0, 4),
        taLatch: hex(ciaA[5] ?? 0, 4),
        tb: hex(ciaA[6] ?? 0, 4),
        tbLatch: hex(ciaA[7] ?? 0, 4),
        tod: hex(ciaA[8] ?? 0, 6),
        sdr: hex(ciaA[10] ?? 0, 2),
        icrData: hex(ciaA[11] ?? 0, 2),
        icrMask: hex(ciaA[12] ?? 0, 2),
        cra: hex(ciaA[13] ?? 0, 2),
        crb: hex(ciaA[14] ?? 0, 2),
        ovlActive: ((ciaA[0] ?? 0) & 0x01) !== 0,
        powerLedBright: ((ciaA[0] ?? 0) & 0x02) === 0,
      },
      ciaB: {
        pra: hex(ciaB[0] ?? 0, 2),
        prb: hex(ciaB[1] ?? 0, 2),
        ddra: hex(ciaB[2] ?? 0, 2),
        ddrb: hex(ciaB[3] ?? 0, 2),
        ta: hex(ciaB[4] ?? 0, 4),
        taLatch: hex(ciaB[5] ?? 0, 4),
        tb: hex(ciaB[6] ?? 0, 4),
        tbLatch: hex(ciaB[7] ?? 0, 4),
        tod: hex(ciaB[8] ?? 0, 6),
        sdr: hex(ciaB[10] ?? 0, 2),
        icrData: hex(ciaB[11] ?? 0, 2),
        icrMask: hex(ciaB[12] ?? 0, 2),
        cra: hex(ciaB[13] ?? 0, 2),
        crb: hex(ciaB[14] ?? 0, 2),
      },
    },
    storage: {
      df0: {
        inserted: df0Bytes !== null,
        name: data.df0Disk?.name ?? st.df0Name,
        sizeBytes: df0Bytes?.length ?? 0,
        cylinder: df0St?.cylinder ?? 0,
        side: df0St?.side ?? 0,
        motorOn: df0St?.motorOn ?? false,
        selected: df0St?.selected ?? false,
        writeProtected: df0St?.writeProtected ?? true,
        diskChanged: df0St?.diskChanged ?? false,
        trackBytePos: df0St?.trackBytePos ?? 0,
        ioSeq: 0,
        bootblockValid: df0Bytes ? verifyAmigaBootblockChecksum(df0Bytes) : false,
        bootblockHeaderHex: df0Bytes ? bytesToHexString(df0Bytes.subarray(0, 64)) : '',
      },
      df1: {
        inserted: df1Bytes !== null,
        name: data.df1Disk?.name ?? st.df1Name,
        sizeBytes: df1Bytes?.length ?? 0,
        cylinder: df1St?.cylinder ?? 0,
        side: df1St?.side ?? 0,
        motorOn: df1St?.motorOn ?? false,
        selected: df1St?.selected ?? false,
        writeProtected: df1St?.writeProtected ?? true,
        diskChanged: df1St?.diskChanged ?? false,
        trackBytePos: df1St?.trackBytePos ?? 0,
        bootblockValid: df1Bytes ? verifyAmigaBootblockChecksum(df1Bytes) : false,
        bootblockHeaderHex: df1Bytes ? bytesToHexString(df1Bytes.subarray(0, 64)) : '',
      },
      dh0: { mounted: false, name: '', sizeBytes: 0, isRdb: false, hasReadSinceReset: false, partitions: [] },
      dh1: { mounted: false, name: '', sizeBytes: 0, isRdb: false, hasReadSinceReset: false, partitions: [] },
    },
    savestate: {
      state: st,
      df0Disk: data.df0Disk
        ? { name: data.df0Disk.name, base64: uint8ToBase64(data.df0Disk.bytes) }
        : null,
      df1Disk: data.df1Disk
        ? { name: data.df1Disk.name, base64: uint8ToBase64(data.df1Disk.bytes) }
        : null,
      screenshotDataUrl: data.screenshotDataUrl,
    },
  };
}

function isValidSerializedState(val: unknown): val is SerializedAmigaState {
  if (!val || typeof val !== 'object') return false;
  const s = val as Partial<SerializedAmigaState>;
  return (
    s.version === 1 &&
    typeof s.pc === 'number' &&
    typeof s.sr === 'number' &&
    typeof s.chipRamBase64 === 'string' &&
    Array.isArray(s.cpuRegs) &&
    s.cpuRegs.length >= 16 &&
    Array.isArray(s.customRegs) &&
    Array.isArray(s.ciaA) &&
    Array.isArray(s.ciaB)
  );
}

export type ParsedSavestateResult =
  | {
      ok: true;
      state: SerializedAmigaState;
      df0Disk: SaveSlotDiskPayload | null;
      df1Disk: SaveSlotDiskPayload | null;
      screenshotDataUrl: string | null;
    }
  | { ok: false; error: string };

export function parseDiagnosticSavestateJson(jsonText: string): ParsedSavestateResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { ok: false, error: 'Файл не является корректным JSON.' };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'Неверная структура файла сейвстейта.' };
  }

  const obj = parsed as Record<string, unknown>;

  if (obj.format === 'amiga500-savestate-v1' && obj.savestate && typeof obj.savestate === 'object') {
    const inner = obj.savestate as Record<string, unknown>;
    if (!isValidSerializedState(inner.state)) {
      return { ok: false, error: 'Повреждены данные CPU/RAM внутри сейвстейта.' };
    }
    const decodeDisk = (blob: unknown): SaveSlotDiskPayload | null => {
      if (!blob || typeof blob !== 'object') return null;
      const b = blob as Record<string, unknown>;
      if (typeof b.name !== 'string' || typeof b.base64 !== 'string') return null;
      return { name: b.name, bytes: base64ToUint8(b.base64) };
    };
    return {
      ok: true,
      state: inner.state,
      df0Disk: decodeDisk(inner.df0Disk),
      df1Disk: decodeDisk(inner.df1Disk),
      screenshotDataUrl: typeof inner.screenshotDataUrl === 'string' ? inner.screenshotDataUrl : null,
    };
  }

  if (isValidSerializedState(parsed)) {
    return {
      ok: true,
      state: parsed,
      df0Disk: null,
      df1Disk: null,
      screenshotDataUrl: null,
    };
  }

  return { ok: false, error: 'Неизвестный формат файла сейвстейта.' };
}

export function formatSavestateFilename(
  labelName: string,
  source: 'live' | `slot-${SaveSlotIndex}`,
  now = new Date()
): string {
  const cleanLabel =
    (labelName || 'amiga500')
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32) || 'amiga500';
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `savestate-${cleanLabel}-${source}-${stamp}.json`;
}

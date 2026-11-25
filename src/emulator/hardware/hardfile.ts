/**
 * Amiga Hard Disk File (HDF) Controller + Zorro II Autoconfig Expansion Board ('amigahd.device').
 *
 * Architecture:
 * - Supports both Raw Partition HDFs (DOS\0..DOS\5, PFS\3, etc.) and RDB ('RDSK') Multi-Partition HDFs.
 * - Exposes a Zorro II Autoconfig Expansion ROM at $E80000 -> relocated by Kickstart to $E90000.
 * - Works natively with real Commodore Kickstart 1.3, 2.04, and 3.1 ROMs with near-zero host CPU overhead!
 * - Disk I/O executes synchronously in TypeScript via Line-A traps inside the Expansion ROM stubs.
 */

import { M68000, M68kBus } from '../cpu/m68k';
import { AmigaDosUsageInfo, inspectAmigaDosUsage, inspectAmigaDosVolume } from '../archives/amigaDosFs';
import { HardfileStatus } from '../types';

export const HDF_SECTOR_SIZE = 512;
const ROM_SIZE = 65536; // 64 KB Zorro II Expansion ROM

// Fixed ROM layout offsets within the 64KB board ($E90000)
const OFF_STRINGS = 0x0020;
const OFF_DIAG_AREA = 0x0100;
const OFF_DIAG_POINT = 0x0110;
const OFF_BOOT_POINT = 0x0180;
const OFF_BOARD_NAME = 0x01b0;
const OFF_DEV_VECTORS = 0x0200;
const OFF_DEV_OPEN = 0x0240;
const OFF_DEV_CLOSE = 0x0248;
const OFF_DEV_EXPUNGE = 0x0250;
const OFF_DEV_EXTFUNC = 0x0258;
const OFF_DEV_BEGINIO = 0x0260;
const OFF_DEV_ABORTIO = 0x0278;
const OFF_NSD_CMDS = 0x0290;

// Line-A opcodes reserved for amigahd.device Expansion ROM
const TRAP_DIAG_INIT = 0xa100;
const TRAP_DIAG_REG_DEV = 0xa101;
const TRAP_DIAG_PREP_EXP = 0xa102;
const TRAP_DIAG_LOOP_INIT = 0xa103;
const TRAP_DIAG_NEXT_PART = 0xa104;
const TRAP_DIAG_ADD_BOOT = 0xa105;
const TRAP_DIAG_CLOSE_EXP = 0xa106;
const TRAP_DIAG_FIX_BOOTNODE = 0xa107;
const TRAP_DEV_OPEN = 0xa110;
const TRAP_DEV_CLOSE = 0xa111;
const TRAP_DEV_EXPUNGE = 0xa112;
const TRAP_DEV_BEGINIO = 0xa113;

// Exec IO commands
const CMD_RESET = 1;
const CMD_READ = 2;
const CMD_WRITE = 3;
const CMD_UPDATE = 4;
const CMD_CLEAR = 5;
const CMD_STOP = 6;
const CMD_START = 7;
const CMD_FLUSH = 8;
const TD_MOTOR = 9;
const TD_SEEK = 10;
const TD_FORMAT = 11;
const TD_REMOVE = 12;
const TD_CHANGENUM = 13;
const TD_CHANGESTATE = 14;
const TD_PROTSTATUS = 15;
const TD_GETDRIVETYPE = 18;
const TD_GETNUMTRACKS = 19;
const TD_ADDCHANGEINT = 20;
const TD_REMCHANGEINT = 21;
const TD_GETGEOMETRY = 22;
const TD_READ64 = 24;
const TD_WRITE64 = 25;
const TD_FORMAT64 = 26;
const NSCMD_DEVICEQUERY = 0x4000;
const NSCMD_TD_READ64 = 0xc000;
const NSCMD_TD_WRITE64 = 0xc001;
const NSCMD_TD_FORMAT64 = 0xc002;

const IOF_QUICK = 1;
const IOERR_NOCMD = -3;
const TDERR_WRITEPROT = 28;
const TDERR_SEEKERROR = 27;

export interface HardfilePartition {
  unit: number;
  dosName: string; // e.g. 'DH0', 'DH1'
  byteOffset: number;
  byteLength: number;
  surfaces: number;
  blocksPerTrack: number;
  lowCyl: number;
  highCyl: number;
  reserved: number;
  bootPri: number;
  dosType: number;
  dosTypeStr: string;
  volumeName: string;
}

function readBE32(buf: Uint8Array, off: number): number {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}

function writeBE16(buf: Uint8Array, off: number, val: number): void {
  buf[off] = (val >>> 8) & 0xff;
  buf[off + 1] = val & 0xff;
}

function writeBE32(buf: Uint8Array, off: number, val: number): void {
  buf[off] = (val >>> 24) & 0xff;
  buf[off + 1] = (val >>> 16) & 0xff;
  buf[off + 2] = (val >>> 8) & 0xff;
  buf[off + 3] = val & 0xff;
}

function writeAsciiZ(buf: Uint8Array, off: number, text: string): number {
  for (let i = 0; i < text.length; i++) {
    buf[off + i] = text.charCodeAt(i) & 0xff;
  }
  buf[off + text.length] = 0;
  return off + text.length + 1;
}

function formatDosType(dosType: number): string {
  const b0 = (dosType >>> 24) & 0xff;
  const b1 = (dosType >>> 16) & 0xff;
  const b2 = (dosType >>> 8) & 0xff;
  const b3 = dosType & 0xff;
  if (b0 >= 32 && b0 < 127 && b1 >= 32 && b1 < 127 && b2 >= 32 && b2 < 127) {
    const c3 = b3 < 10 ? `\\${b3}` : String.fromCharCode(b3);
    return `${String.fromCharCode(b0, b1, b2)}${c3}`;
  }
  return `$${dosType.toString(16).padStart(8, '0')}`;
}

function computeCylGeometry(totalSectors: number): { surfaces: number; blocksPerTrack: number; cylinders: number } {
  const blocksPerTrack = 32;
  let surfaces = 1;
  while (surfaces < 16 && Math.ceil(totalSectors / (surfaces * blocksPerTrack)) > 32767) {
    surfaces *= 2;
  }
  const cylinders = Math.max(1, Math.floor(totalSectors / (surfaces * blocksPerTrack)));
  return { surfaces, blocksPerTrack, cylinders };
}

function parseHdfPartitions(
  bytes: Uint8Array,
  unitIndex: 0 | 1 = 0
): {
  isRdb: boolean;
  surfaces: number;
  blocksPerTrack: number;
  totalCylinders: number;
  partitions: HardfilePartition[];
} {
  // Check for RDB ('RDSK') in blocks 0..15
  let rdskBlock = -1;
  for (let b = 0; b < 16; b++) {
    const off = b * HDF_SECTOR_SIZE;
    if (off + HDF_SECTOR_SIZE > bytes.length) break;
    if (bytes[off] === 0x52 && bytes[off + 1] === 0x44 && bytes[off + 2] === 0x53 && bytes[off + 3] === 0x4b) {
      rdskBlock = b;
      break;
    }
  }

  if (rdskBlock >= 0) {
    const rOff = rdskBlock * HDF_SECTOR_SIZE;
    const cylinders = Math.max(1, readBE32(bytes, rOff + 64));
    const sectors = Math.max(1, readBE32(bytes, rOff + 68));
    const heads = Math.max(1, readBE32(bytes, rOff + 72));
    const partHead = readBE32(bytes, rOff + 28);
    const partitions: HardfilePartition[] = [];

    let pBlk = partHead;
    let guard = 0;
    while (pBlk !== 0xffffffff && pBlk * HDF_SECTOR_SIZE + HDF_SECTOR_SIZE <= bytes.length && guard++ < 16) {
      const pOff = pBlk * HDF_SECTOR_SIZE;
      if (bytes[pOff] !== 0x50 || bytes[pOff + 1] !== 0x41 || bytes[pOff + 2] !== 0x52 || bytes[pOff + 3] !== 0x54) {
        break;
      }
      const nextPart = readBE32(bytes, pOff + 16);
      const dLen = Math.min(30, bytes[pOff + 36]);
      let dosName = '';
      for (let i = 0; i < dLen; i++) {
        const c = bytes[pOff + 37 + i];
        if (c >= 32 && c <= 126) dosName += String.fromCharCode(c);
      }
      dosName = dosName.replace(/[:/]/g, '') || `DH${unitIndex + partitions.length}`;

      // Partition DosEnvec starts at offset 128 ($80) inside PART block
      const envOff = pOff + 128;
      const pSurfaces = Math.max(1, readBE32(bytes, envOff + 3 * 4));
      const pBlocksPerTrack = Math.max(1, readBE32(bytes, envOff + 5 * 4));
      const pReserved = readBE32(bytes, envOff + 6 * 4);
      const pLowCyl = readBE32(bytes, envOff + 9 * 4);
      const pHighCyl = readBE32(bytes, envOff + 10 * 4);
      const pBootPri = readBE32(bytes, envOff + 15 * 4) | 0;
      const pDosType = readBE32(bytes, envOff + 16 * 4) || 0x444f5300;

      const cylSectors = pSurfaces * pBlocksPerTrack;
      const byteOffset = pLowCyl * cylSectors * HDF_SECTOR_SIZE;
      const byteLength = Math.max(0, (pHighCyl - pLowCyl + 1) * cylSectors * HDF_SECTOR_SIZE);
      const info = inspectAmigaDosVolume(bytes, byteOffset);

      partitions.push({
        unit: unitIndex,
        dosName,
        byteOffset,
        byteLength,
        surfaces: pSurfaces,
        blocksPerTrack: pBlocksPerTrack,
        lowCyl: pLowCyl,
        highCyl: pHighCyl,
        reserved: pReserved,
        bootPri: pBootPri,
        dosType: pDosType,
        dosTypeStr: formatDosType(pDosType),
        volumeName: info.volumeName || dosName,
      });

      pBlk = nextPart;
    }

    if (partitions.length > 0) {
      return {
        isRdb: true,
        surfaces: heads,
        blocksPerTrack: sectors,
        totalCylinders: cylinders,
        partitions,
      };
    }
  }

  // Standard single-partition HDF (raw filesystem image starting at offset 0)
  const totalSectors = Math.floor(bytes.length / HDF_SECTOR_SIZE);
  const geom = computeCylGeometry(totalSectors);
  const dosType = bytes.length >= 4 ? readBE32(bytes, 0) : 0x444f5300;
  const validDos = (dosType & 0xffffff00) === 0x444f5300;
  const info = inspectAmigaDosVolume(bytes, 0);

  return {
    isRdb: false,
    surfaces: geom.surfaces,
    blocksPerTrack: geom.blocksPerTrack,
    totalCylinders: geom.cylinders,
    partitions: [
      {
        unit: unitIndex,
        dosName: unitIndex === 0 ? 'DH0' : 'DH1',
        byteOffset: 0,
        byteLength: geom.cylinders * geom.surfaces * geom.blocksPerTrack * HDF_SECTOR_SIZE,
        surfaces: geom.surfaces,
        blocksPerTrack: geom.blocksPerTrack,
        lowCyl: 0,
        highCyl: Math.max(0, geom.cylinders - 1),
        reserved: 2,
        bootPri: unitIndex === 0 ? 0 : -1, // DH0 boots over DH1; DF0 (5) boots over DH0 (0)
        dosType: validDos ? dosType : 0x444f5300,
        dosTypeStr: info.isDos ? info.dosType : 'RAW',
        volumeName: info.volumeName || (unitIndex === 0 ? 'HardDisk' : 'DataDisk'),
      },
    ],
  };
}

export interface HardfileSlot {
  data: Uint8Array | null;
  name: string;
  writeProtected: boolean;
  isRdb: boolean;
  partitions: HardfilePartition[];
  ioPulseFrames: number;
  hasReadSinceReset: boolean;
  writeSeq: number;
  usageDirty: boolean;
  cachedUsage: AmigaDosUsageInfo;
}

function createEmptySlot(): HardfileSlot {
  return {
    data: null,
    name: '',
    writeProtected: false,
    isRdb: false,
    partitions: [],
    ioPulseFrames: 0,
    hasReadSinceReset: false,
    writeSeq: 0,
    usageDirty: false,
    cachedUsage: {
      totalDataBytes: 0,
      usedBytes: 0,
      freeBytes: 0,
      minSizeMB: 1,
      canResize: false,
    },
  };
}

export class HardfileController {
  public readonly units: [HardfileSlot, HardfileSlot] = [createEmptySlot(), createEmptySlot()];
  private mergedPartitions: HardfilePartition[] = [];

  // Zorro II Autoconfig state
  public configuredBase = 0; // 0 = waiting at $E80000; 0xE90000 = active at $E90000; -1 = shut up
  private latchLowNibble = 0;

  // Expansion ROM image (64 KB)
  private readonly rom = new Uint8Array(ROM_SIZE);
  private strAmigaHdOff = 0;
  private strExpansionOff = 0;
  private strDosOff = 0;
  private strIdOff = 0;

  // Runtime state during Kickstart DiagPoint & Device lifecycle
  private diagCopyAddr = 0;
  private configDevAddr = 0;
  private execBase = 0;
  private expBase = 0;
  private devAddr = 0;
  private openCount = 0;
  private diagPartIdx = 0;
  private diagLoopTopPc = 0;
  private diagLoopEndPc = 0;
  private lastDosNodeAddr = 0;

  constructor() {
    this.buildExpansionRom();
  }

  // Backwards-compatible getters delegating to unit 0 (DH0:)
  public get data(): Uint8Array | null {
    return this.units[0].data;
  }
  public get name(): string {
    return this.units[0].name;
  }
  public get writeProtected(): boolean {
    return this.units[0].writeProtected;
  }
  public get isRdb(): boolean {
    return this.units[0].isRdb;
  }
  public get partitions(): HardfilePartition[] {
    return this.units[0].partitions;
  }
  public get ioPulseFrames(): number {
    return this.units[0].ioPulseFrames;
  }
  public set ioPulseFrames(v: number) {
    this.units[0].ioPulseFrames = v;
  }

  public isMounted(unit?: 0 | 1): boolean {
    if (unit !== undefined) return this.units[unit].data !== null;
    return this.units[0].data !== null || this.units[1].data !== null;
  }

  public hasAnyReadSinceReset(): boolean {
    return this.units[0].hasReadSinceReset || this.units[1].hasReadSinceReset;
  }

  private rebuildMergedPartitions(): void {
    const out: HardfilePartition[] = [];
    const usedNames = new Set<string>();

    for (const p of this.units[0].partitions) {
      out.push(p);
      usedNames.add(p.dosName.toUpperCase());
    }

    const hasSystemDh0 = this.units[0].data !== null;
    for (const p of this.units[1].partitions) {
      let dosName = p.dosName;
      if (usedNames.has(dosName.toUpperCase())) {
        let idx = 1;
        while (usedNames.has(`DH${idx}`)) idx++;
        dosName = `DH${idx}`;
      }
      usedNames.add(dosName.toUpperCase());
      out.push({
        ...p,
        dosName,
        // Keep system DH0: as primary HDD boot volume when both DH0: and DH1: are mounted
        bootPri: hasSystemDh0 ? Math.min(-1, p.bootPri) : p.bootPri,
      });
    }

    this.mergedPartitions = out;
  }

  public reset(): void {
    this.configuredBase = this.isMounted() ? 0 : -1;
    this.latchLowNibble = 0;
    this.diagCopyAddr = 0;
    this.configDevAddr = 0;
    this.execBase = 0;
    this.expBase = 0;
    this.devAddr = 0;
    this.openCount = 0;
    this.diagPartIdx = 0;
    this.units[0].ioPulseFrames = 0;
    this.units[1].ioPulseFrames = 0;
    this.units[0].hasReadSinceReset = false;
    this.units[1].hasReadSinceReset = false;
  }

  public mountUnit(
    unit: 0 | 1,
    bytes: Uint8Array,
    name: string,
    writeProtected = false,
    preserveAutoconfig = false
  ): void {
    const usableLen = Math.floor(bytes.length / HDF_SECTOR_SIZE) * HDF_SECTOR_SIZE;
    if (usableLen < 1024) {
      throw new Error(`Файл "${name}" слишком мал для образа HDF.`);
    }
    const prevConfiguredBase = this.configuredBase;
    const slot = this.units[unit];
    slot.data = bytes.length === usableLen ? new Uint8Array(bytes) : new Uint8Array(bytes.subarray(0, usableLen));
    slot.name = name;
    slot.writeProtected = writeProtected;
    const parsed = parseHdfPartitions(slot.data, unit);
    slot.isRdb = parsed.isRdb;
    slot.partitions = parsed.partitions;
    slot.usageDirty = true;
    slot.ioPulseFrames = 0;
    slot.hasReadSinceReset = false;
    this.rebuildMergedPartitions();
    if (preserveAutoconfig && prevConfiguredBase > 0) {
      this.configuredBase = prevConfiguredBase;
      return;
    }
    this.reset();
  }

  public mount(bytes: Uint8Array, name: string, writeProtected = false): void {
    this.mountUnit(0, bytes, name, writeProtected);
  }

  public ejectUnit(unit: 0 | 1): void {
    this.units[unit] = createEmptySlot();
    this.rebuildMergedPartitions();
    this.configuredBase = this.isMounted() ? 0 : -1;
  }

  public eject(): void {
    this.ejectUnit(0);
  }

  public exportUnitBytes(unit: 0 | 1): { name: string; bytes: Uint8Array } | null {
    const slot = this.units[unit];
    if (!slot.data) return null;
    return {
      name: slot.name || `HardDisk_DH${unit}.hdf`,
      bytes: new Uint8Array(slot.data),
    };
  }

  public exportBytes(): { name: string; bytes: Uint8Array } | null {
    return this.exportUnitBytes(0);
  }

  private refreshUsageIfDirty(slot: HardfileSlot): void {
    if (!slot.usageDirty || !slot.data) return;
    slot.usageDirty = false;
    if (!slot.isRdb) {
      slot.cachedUsage = inspectAmigaDosUsage(slot.data, 0, slot.data.length);
      return;
    }
    let totalDataBytes = 0;
    let usedBytes = 0;
    let freeBytes = 0;
    for (const part of slot.partitions) {
      const u = inspectAmigaDosUsage(slot.data, part.byteOffset, part.byteLength);
      totalDataBytes += u.totalDataBytes;
      usedBytes += u.usedBytes;
      freeBytes += u.freeBytes;
    }
    slot.cachedUsage = {
      totalDataBytes,
      usedBytes,
      freeBytes,
      minSizeMB: Math.max(1, Math.ceil((slot.data.length || 1024 * 1024) / (1024 * 1024))),
      canResize: false,
    };
  }

  public getUnitStatus(unit: 0 | 1): HardfileStatus {
    const slot = this.units[unit];
    const primary = slot.partitions[0];
    this.refreshUsageIfDirty(slot);
    return {
      mounted: slot.data !== null,
      name: slot.name,
      sizeBytes: slot.data ? slot.data.length : 0,
      usedBytes: slot.cachedUsage.usedBytes,
      freeBytes: slot.cachedUsage.freeBytes,
      minSizeMB: slot.cachedUsage.minSizeMB,
      canResize: slot.cachedUsage.canResize,
      dosType: primary?.dosTypeStr ?? '',
      volumeName: primary?.volumeName ?? '',
      partitionCount: slot.partitions.length,
      activeIo: slot.ioPulseFrames > 0,
      writeProtected: slot.writeProtected,
    };
  }

  public getStatus(): HardfileStatus {
    return this.getUnitStatus(0);
  }

  // ==================== Zorro II Autoconfig & ROM Memory Map ====================

  /**
   * Builds the 64 KB Zorro II Expansion ROM image mapped at $E90000 after Autoconfig.
   */
  private buildExpansionRom(): void {
    const r = this.rom;
    r.fill(0);

    // Null-terminated strings
    let sOff = OFF_STRINGS;
    this.strAmigaHdOff = sOff;
    sOff = writeAsciiZ(r, sOff, 'amigahd.device');
    this.strExpansionOff = sOff;
    sOff = writeAsciiZ(r, sOff, 'expansion.library');
    this.strDosOff = sOff;
    sOff = writeAsciiZ(r, sOff, 'dos.library');
    this.strIdOff = sOff;
    writeAsciiZ(r, sOff, 'amigahd 34.1 (Amiga500 Virtual HDF)');

    writeAsciiZ(r, OFF_BOARD_NAME, 'AmigaHD HDF Controller');

    // DiagArea at OFF_DIAG_AREA ($0100)
    r[OFF_DIAG_AREA + 0] = 0x90; // DAC_WORDWIDE | DAC_CONFIGTIME
    r[OFF_DIAG_AREA + 1] = 0x00;
    writeBE16(r, OFF_DIAG_AREA + 2, 0x1000); // da_Size = 4KB copied into RAM diagCopy
    writeBE16(r, OFF_DIAG_AREA + 4, OFF_DIAG_POINT - OFF_DIAG_AREA); // da_DiagPoint
    writeBE16(r, OFF_DIAG_AREA + 6, OFF_BOOT_POINT - OFF_DIAG_AREA); // da_BootPoint
    writeBE16(r, OFF_DIAG_AREA + 8, OFF_BOARD_NAME - OFF_DIAG_AREA); // da_Name

    // DiagPoint at OFF_DIAG_POINT ($0110) — runs from RAM diagCopy!
    let p = OFF_DIAG_POINT;
    const emitW = (w: number) => {
      writeBE16(r, p, w & 0xffff);
      p += 2;
    };
    const emitL = (l: number) => {
      writeBE32(r, p, l >>> 0);
      p += 4;
    };

    emitW(0x48e7); emitW(0x3f3e); // MOVEM.L D2-D7/A2-A6, -(SP)
    emitW(TRAP_DIAG_INIT);   // Save A0/A2/A3/A5, load A6=ExecBase, A0=ROM vectors, D0=48, D1=0, A1=0, A2=0
    emitW(0x4eae); emitW(0xffac); // JSR -84(A6) -> Exec MakeLibrary()
    emitW(TRAP_DIAG_REG_DEV); // Fill Device header fields, set A1=device
    emitW(0x4eae); emitW(0xfe50); // JSR -432(A6) -> Exec AddDevice(A1)
    emitW(TRAP_DIAG_LOOP_INIT); // Init diagPartIdx=0 (uses A5 ExpansionBase)

    const loopTopOff = p - OFF_DIAG_AREA; // Relative offset inside diagCopy
    emitW(TRAP_DIAG_NEXT_PART); // Sets A0=parmPkt, A6=expBase OR jumps past loop if done
    emitW(0x4eae); emitW(0xff70); // JSR -144(A6) -> Expansion MakeDosNode(A0)
    emitW(TRAP_DIAG_ADD_BOOT); // Sets D0=bootPri, D1=0, A0=devNode, A1=configDev; PC=loop13 if lib_Version < 36
    // Path KS 2.04+ (lib_Version >= 36): AddBootNode(D0,D1,A0,A1)
    emitW(0x4eae); emitW(0xffdc); // JSR -36(A6) -> Expansion AddBootNode
    const braAfter20Idx = p;
    emitW(0x6000); // BRA.S loopContinue (patched)

    // Path KS 1.3 (lib_Version < 36): AddDosNode(D0,D1,A0) + patch BootNode ln_Type/ln_Name
    const addDosPathOff = p - OFF_DIAG_AREA;
    emitW(0x4eae); emitW(0xff6a); // JSR -150(A6) -> Expansion AddDosNode
    emitW(TRAP_DIAG_FIX_BOOTNODE); // Sets ln_Type=NT_BOOTNODE(16) and ln_Name=ConfigDev

    const loopContinueOff = p - OFF_DIAG_AREA;
    writeBE16(r, braAfter20Idx, 0x6000 | ((loopContinueOff - (braAfter20Idx + 2 - OFF_DIAG_AREA)) & 0xff));

    // BRA.S loopTop
    const braDisp = (loopTopOff - (p + 2 - OFF_DIAG_AREA)) & 0xff;
    emitW(0x6000 | braDisp);

    const loopEndOff = p - OFF_DIAG_AREA;
    emitW(TRAP_DIAG_CLOSE_EXP); // Restore A6=ExecBase
    emitW(0x4cdf); emitW(0x7cfc); // MOVEM.L (SP)+, D2-D7/A2-A6
    emitW(0x7001); // MOVEQ #1, D0 (DiagPoint success)
    emitW(0x4e75); // RTS

    // Store loop offsets inside DiagArea reserved words (bytes 10..15) for runtime jump
    writeBE16(r, OFF_DIAG_AREA + 10, loopTopOff);
    writeBE16(r, OFF_DIAG_AREA + 12, loopEndOff);
    writeBE16(r, OFF_DIAG_AREA + 14, addDosPathOff);

    // BootPoint at OFF_BOOT_POINT ($0180) — runs when DH0: is selected as boot volume
    p = OFF_BOOT_POINT;
    emitW(0x2c78); emitW(0x0004); // MOVEA.L $4.W, A6 (ExecBase)
    const leaPcPos = p + 2;
    const dosStrTarget = OFF_DIAG_AREA + 0x0026; // Actually let's embed "dos.library\0" right after BootPoint!
    void dosStrTarget;
    emitW(0x43fa);
    const leaDispIdx = p;
    emitW(0x0000); // Patched below
    emitW(0x4eae); emitW(0xffa0); // JSR -96(A6) -> FindResident("dos.library")
    emitW(0x4a80); // TST.L D0
    emitW(0x6708); // BEQ.S fail (+8 bytes)
    emitW(0x2040); // MOVEA.L D0, A0
    emitW(0x2068); emitW(0x0016); // MOVEA.L 22(A0), A0 (rt_Init)
    emitW(0x4ed0); // JMP (A0)
    emitW(0x70ff); // fail: MOVEQ #-1, D0
    emitW(0x4e75); // RTS
    const dosNameAt = p;
    writeBE16(r, leaDispIdx, (dosNameAt - leaPcPos) & 0xffff);
    writeAsciiZ(r, dosNameAt, 'dos.library');

    // Device vectors table at OFF_DEV_VECTORS ($0200) using absolute $E9xxxx ROM addresses
    p = OFF_DEV_VECTORS;
    emitL(0x00e90000 + OFF_DEV_OPEN);
    emitL(0x00e90000 + OFF_DEV_CLOSE);
    emitL(0x00e90000 + OFF_DEV_EXPUNGE);
    emitL(0x00e90000 + OFF_DEV_EXTFUNC);
    emitL(0x00e90000 + OFF_DEV_BEGINIO);
    emitL(0x00e90000 + OFF_DEV_ABORTIO);
    emitL(0xffffffff);

    // Device vector stubs ($0240+)
    p = OFF_DEV_OPEN;
    emitW(TRAP_DEV_OPEN);
    emitW(0x4e75); // RTS

    p = OFF_DEV_CLOSE;
    emitW(TRAP_DEV_CLOSE);
    emitW(0x4e75); // RTS

    p = OFF_DEV_EXPUNGE;
    emitW(TRAP_DEV_EXPUNGE);
    emitW(0x4e75); // RTS

    p = OFF_DEV_EXTFUNC;
    emitW(0x7000); // MOVEQ #0, D0
    emitW(0x4e75); // RTS

    p = OFF_DEV_BEGINIO;
    emitW(TRAP_DEV_BEGINIO); // Returns D0=1 if ReplyMsg needed, D0=0 if IOF_QUICK
    emitW(0x4a80); // TST.L D0
    emitW(0x6708); // BEQ.S .quick (+8 bytes)
    emitW(0x2c78); emitW(0x0004); // MOVEA.L $4.W, A6
    emitW(0x4eee); emitW(0xfe86); // JMP -378(A6) (Exec ReplyMsg)
    emitW(0x4e75); // .quick: RTS

    p = OFF_DEV_ABORTIO;
    emitW(0x70fd); // MOVEQ #-3, D0 (IOERR_NOCMD)
    emitW(0x4e75); // RTS

    // Null-terminated uint16[] SupportedCommands table for NSCMD_DEVICEQUERY
    p = OFF_NSD_CMDS;
    for (const c of [
      CMD_RESET, CMD_READ, CMD_WRITE, CMD_UPDATE, CMD_CLEAR, CMD_STOP, CMD_START, CMD_FLUSH,
      TD_MOTOR, TD_SEEK, TD_FORMAT, TD_REMOVE, TD_CHANGENUM, TD_CHANGESTATE, TD_PROTSTATUS,
      TD_GETDRIVETYPE, TD_GETNUMTRACKS, TD_ADDCHANGEINT, TD_REMCHANGEINT, TD_GETGEOMETRY,
      TD_READ64, TD_WRITE64, TD_FORMAT64,
      NSCMD_DEVICEQUERY, NSCMD_TD_READ64, NSCMD_TD_WRITE64, NSCMD_TD_FORMAT64,
      0,
    ]) {
      emitW(c);
    }
  }

  private readAutoconfigByte(offset: number): number {
    // Only respond at $E80000 if mounted AND not yet configured/shut-up
    if (!this.isMounted() || this.configuredBase !== 0) return 0x00;

    // Zorro II Autoconfig ROM nibbles:
    // $00/$02 (er_Type) are NOT inverted; all subsequent registers ARE bitwise inverted (~val)!
    const reg = offset & 0xfe;
    let byteVal = 0;
    let invert = true;

    switch (reg) {
      case 0x00:
      case 0x02:
        // er_Type = 0xD1 (ERT_ZORROII | ERFB_DIAGVALID | 64KB size)
        byteVal = 0xd1;
        invert = false;
        break;
      case 0x04:
      case 0x06:
        byteVal = 0x01; // er_Product
        break;
      case 0x08:
      case 0x0a:
        byteVal = 0x00; // er_Flags (can shut up, no memory space)
        break;
      case 0x0c:
      case 0x0e:
        byteVal = 0x00; // er_Reserved03
        break;
      case 0x10:
      case 0x12:
        byteVal = 0x07; // er_Manufacturer high byte (2011 = $07DB)
        break;
      case 0x14:
      case 0x16:
        byteVal = 0xdb; // er_Manufacturer low byte
        break;
      case 0x18:
      case 0x1a:
      case 0x1c:
      case 0x1e:
      case 0x20:
      case 0x22:
        byteVal = 0x00; // er_SerialNumber bytes 0..2
        break;
      case 0x24:
      case 0x26:
        byteVal = 0x01; // er_SerialNumber byte 3
        break;
      case 0x28:
      case 0x2a:
        byteVal = (OFF_DIAG_AREA >>> 8) & 0xff; // er_InitDiagVec high ($01)
        break;
      case 0x2c:
      case 0x2e:
        byteVal = OFF_DIAG_AREA & 0xff; // er_InitDiagVec low ($00)
        break;
      default:
        byteVal = 0x00;
        break;
    }

    const nibble = (reg & 2) === 0 ? (byteVal >>> 4) & 0x0f : byteVal & 0x0f;
    const outNibble = invert ? (~nibble) & 0x0f : nibble;
    return (outNibble << 4) | 0x0f;
  }

  public read8(addr: number): number {
    if (addr >= 0xe80000 && addr < 0xe90000) {
      if ((addr & 1) === 0) {
        return this.readAutoconfigByte(addr - 0xe80000);
      }
      return 0xff;
    }
    if (this.isMounted() && this.configuredBase > 0 && addr >= this.configuredBase && addr < this.configuredBase + ROM_SIZE) {
      return this.rom[addr - this.configuredBase];
    }
    return 0x00;
  }

  public peekRomByte(addr: number): number {
    return this.read8(addr);
  }

  public read16(addr: number): number {
    if (addr >= 0xe80000 && addr < 0xe90000) {
      const hi = this.readAutoconfigByte(addr - 0xe80000);
      return (hi << 8) | 0xff;
    }
    if (this.isMounted() && this.configuredBase > 0 && addr >= this.configuredBase && addr < this.configuredBase + ROM_SIZE - 1) {
      const off = addr - this.configuredBase;
      return (this.rom[off] << 8) | this.rom[off + 1];
    }
    return 0x0000;
  }

  public write8(addr: number, val: number): void {
    if (!this.isMounted() || this.configuredBase !== 0) return;
    if (addr >= 0xe80000 && addr < 0xe90000) {
      const off = addr - 0xe80000;
      if (off === 0x4a) {
        this.latchLowNibble = (val >>> 4) & 0x0f;
      } else if (off === 0x48) {
        const hi = val & 0xf0;
        this.configuredBase = (hi | this.latchLowNibble) << 16;
        if (this.configuredBase > 0) {
          const b = this.configuredBase;
          writeBE32(this.rom, OFF_DEV_VECTORS + 0, b + OFF_DEV_OPEN);
          writeBE32(this.rom, OFF_DEV_VECTORS + 4, b + OFF_DEV_CLOSE);
          writeBE32(this.rom, OFF_DEV_VECTORS + 8, b + OFF_DEV_EXPUNGE);
          writeBE32(this.rom, OFF_DEV_VECTORS + 12, b + OFF_DEV_EXTFUNC);
          writeBE32(this.rom, OFF_DEV_VECTORS + 16, b + OFF_DEV_BEGINIO);
          writeBE32(this.rom, OFF_DEV_VECTORS + 20, b + OFF_DEV_ABORTIO);
        }
      } else if (off === 0x4c) {
        this.configuredBase = -1; // Shut up
      }
    }
  }

  public write16(addr: number, val: number): void {
    if (addr >= 0xe80000 && addr < 0xe90000) {
      this.write8(addr, (val >>> 8) & 0xff);
    }
  }

  // ==================== Line-A ROM & Device Handler ====================

  public handleLineA(opcode: number, cpu: M68000, bus: M68kBus): boolean {
    if (!this.isMounted() || (opcode & 0xff00) !== 0xa100) return false;
    const base = this.configuredBase > 0 ? this.configuredBase : 0x00e90000;

    switch (opcode) {
      case TRAP_DIAG_INIT: {
        // Save DiagPoint arguments: A0=boardBase, A2=diagCopy, A3=configDev, A5=ExpansionBase
        this.diagCopyAddr = cpu.a[2] & 0x00ffffff;
        this.configDevAddr = cpu.a[3] & 0x00ffffff;
        this.expBase = cpu.a[5] & 0x00ffffff;
        this.execBase = bus.read32(4) & 0x00ffffff;
        cpu.a[6] = this.execBase;
        cpu.a[0] = base + OFF_DEV_VECTORS;
        cpu.a[1] = 0;
        cpu.a[2] = 0;
        cpu.d[0] = 48; // Device struct size
        cpu.d[1] = 0;
        return true;
      }

      case TRAP_DIAG_REG_DEV: {
        this.devAddr = cpu.d[0] & 0x00ffffff;
        if (this.devAddr !== 0) {
          bus.write8(this.devAddr + 8, 3); // LN_TYPE = NT_DEVICE
          bus.write8(this.devAddr + 9, 0); // LN_PRI
          bus.write32(this.devAddr + 10, base + this.strAmigaHdOff); // LN_NAME
          bus.write8(this.devAddr + 14, 0); // LIB_FLAGS
          bus.write16(this.devAddr + 20, 34); // LIB_VERSION
          bus.write16(this.devAddr + 22, 1); // LIB_REVISION
          bus.write32(this.devAddr + 24, base + this.strIdOff); // LIB_IDSTRING
        }
        cpu.a[1] = this.devAddr;
        cpu.a[6] = this.execBase;
        return true;
      }

      case TRAP_DIAG_PREP_EXP: {
        cpu.a[1] = base + this.strExpansionOff;
        cpu.d[0] = 0;
        cpu.a[6] = this.execBase;
        return true;
      }

      case TRAP_DIAG_LOOP_INIT: {
        this.diagPartIdx = 0;
        const loopTopRel = bus.read16(base + OFF_DIAG_AREA + 10);
        const loopEndRel = bus.read16(base + OFF_DIAG_AREA + 12);
        this.diagLoopTopPc = (this.diagCopyAddr + loopTopRel) & 0x00ffffff;
        this.diagLoopEndPc = (this.diagCopyAddr + loopEndRel) & 0x00ffffff;
        void this.diagLoopTopPc;
        return true;
      }

      case TRAP_DIAG_NEXT_PART: {
        if (this.expBase === 0 || this.diagPartIdx >= this.mergedPartitions.length || this.diagPartIdx >= 24) {
          cpu.pc = this.diagLoopEndPc;
          return true;
        }
        const part = this.mergedPartitions[this.diagPartIdx];
        const scratch = this.diagCopyAddr + 0x400 + this.diagPartIdx * 0x80;
        const dosNameAddr = scratch;
        const dosNameLen = Math.min(part.dosName.length, 14);
        for (let i = 0; i < dosNameLen; i++) {
          bus.write8(dosNameAddr + i, part.dosName.charCodeAt(i));
        }
        bus.write8(dosNameAddr + dosNameLen, 0);

        const pktAddr = scratch + 0x10;
        bus.write32(pktAddr + 0, dosNameAddr); // DOS name (e.g. "DH0")
        bus.write32(pktAddr + 4, base + this.strAmigaHdOff); // Exec device name
        bus.write32(pktAddr + 8, part.unit); // Unit
        bus.write32(pktAddr + 12, 0); // Open flags

        // DosEnvec (17 longwords starting at pktAddr + 16)
        const env = pktAddr + 16;
        bus.write32(env + 0 * 4, 16); // de_TableSize
        bus.write32(env + 1 * 4, 128); // de_SizeBlock (512 bytes = 128 longs)
        bus.write32(env + 2 * 4, 0); // de_SecOrg
        bus.write32(env + 3 * 4, part.surfaces);
        bus.write32(env + 4 * 4, 1); // de_SectorPerBlock
        bus.write32(env + 5 * 4, part.blocksPerTrack);
        bus.write32(env + 6 * 4, part.reserved);
        bus.write32(env + 7 * 4, 0); // de_PreAlloc
        bus.write32(env + 8 * 4, 0); // de_Interleave
        bus.write32(env + 9 * 4, part.lowCyl);
        bus.write32(env + 10 * 4, part.highCyl);
        bus.write32(env + 11 * 4, 30); // de_NumBuffers
        bus.write32(env + 12 * 4, 0); // de_BufMemType (MEMF_ANY)
        bus.write32(env + 13 * 4, 0x00200000); // de_MaxTransfer
        bus.write32(env + 14 * 4, 0x7ffffffe); // de_Mask
        bus.write32(env + 15 * 4, part.bootPri | 0);
        bus.write32(env + 16 * 4, part.dosType >>> 0);

        cpu.a[0] = pktAddr;
        cpu.a[6] = this.expBase;
        return true;
      }

      case TRAP_DIAG_ADD_BOOT: {
        const part = this.mergedPartitions[this.diagPartIdx];
        this.lastDosNodeAddr = cpu.d[0] & 0x00ffffff;
        cpu.d[0] = part ? (part.bootPri | 0) : 0;
        cpu.d[1] = 0; // flags
        cpu.a[0] = this.lastDosNodeAddr;
        // Pass ConfigDev for bootable partitions (or primary partition)
        cpu.a[1] = this.configDevAddr;
        cpu.a[6] = this.expBase;

        const expVer = this.expBase ? bus.read16(this.expBase + 20) : 0;
        if (expVer < 36) {
          const addDosRel = bus.read16(base + OFF_DIAG_AREA + 14);
          cpu.pc = (this.diagCopyAddr + addDosRel) & 0x00ffffff;
        } else {
          this.diagPartIdx++;
        }
        return true;
      }

      case TRAP_DIAG_FIX_BOOTNODE: {
        // On Kickstart 1.3 (V34), AddDosNode leaves ln_Type=0 and ln_Name=dosName C-string.
        // Patch BootNode so romboot.library recognizes it as NT_BOOTNODE(16) with ConfigDev in ln_Name.
        if (this.expBase !== 0 && this.lastDosNodeAddr !== 0 && this.configDevAddr !== 0) {
          let node = bus.read32(this.expBase + 74) & 0x00ffffff; // eb_MountList.lh_Head
          let guard = 0;
          while (node !== 0 && guard++ < 64) {
            const succ = bus.read32(node) & 0x00ffffff;
            if (succ === 0) break; // Tail node
            if ((bus.read32(node + 16) & 0x00ffffff) === this.lastDosNodeAddr) {
              bus.write8(node + 8, 16); // NT_BOOTNODE
              bus.write32(node + 10, this.configDevAddr); // ln_Name = ConfigDev
              break;
            }
            node = succ;
          }
        }
        this.diagPartIdx++;
        return true;
      }

      case TRAP_DIAG_CLOSE_EXP: {
        cpu.a[1] = this.expBase;
        cpu.a[6] = this.execBase;
        return true;
      }

      case TRAP_DEV_OPEN: {
        const unitNum = cpu.d[0] >>> 0;
        const ioReq = cpu.a[1] & 0x00ffffff;
        if (unitNum > 1 || !this.units[unitNum].data) {
          bus.write8(ioReq + 31, 0xff); // IOERR_OPENFAIL (-1)
          cpu.d[0] = -1;
          return true;
        }
        this.openCount++;
        bus.write16(this.devAddr + 32, this.openCount); // LIB_OPENCNT
        bus.write32(ioReq + 20, this.devAddr); // io_Device
        bus.write32(ioReq + 24, unitNum + 1); // io_Unit token (1 = unit 0, 2 = unit 1)
        bus.write8(ioReq + 31, 0); // io_Error = 0
        cpu.d[0] = 0;
        return true;
      }

      case TRAP_DEV_CLOSE: {
        const ioReq = cpu.a[1] & 0x00ffffff;
        if (this.openCount > 0) this.openCount--;
        bus.write16(this.devAddr + 32, this.openCount);
        bus.write32(ioReq + 20, 0xffffffff);
        bus.write32(ioReq + 24, 0xffffffff);
        cpu.d[0] = 0;
        return true;
      }

      case TRAP_DEV_EXPUNGE: {
        cpu.d[0] = 0;
        return true;
      }

      case TRAP_DEV_BEGINIO: {
        const ioReq = cpu.a[1] & 0x00ffffff;
        const quick = this.executeIoRequest(ioReq, bus);
        cpu.a[1] = ioReq;
        // Return D0=0 if IOF_QUICK (skip ReplyMsg), D0=1 if ReplyMsg required
        cpu.d[0] = quick ? 0 : 1;
        return true;
      }

      default:
        return false;
    }
  }

  private executeIoRequest(ioReq: number, bus: M68kBus): boolean {
    const cmd = bus.read16(ioReq + 28);
    const flags = bus.read8(ioReq + 30);
    const ioUnitToken = bus.read32(ioReq + 24) >>> 0;
    const unitIdx: 0 | 1 = ioUnitToken === 2 ? 1 : 0;
    const slot = this.units[unitIdx];
    const length = bus.read32(ioReq + 36);
    const dataPtr = bus.read32(ioReq + 40) & 0x00ffffff;
    const offsetLow = bus.read32(ioReq + 44);
    const offsetHigh = bus.read32(ioReq + 32); // io_Actual holds high 32-bits for 64-bit cmds

    let err = 0;
    let actual = 0;

    if (!slot.data) {
      err = -1;
    } else {
      switch (cmd) {
        case CMD_RESET:
        case CMD_UPDATE:
        case CMD_CLEAR:
        case CMD_STOP:
        case CMD_START:
        case CMD_FLUSH:
        case TD_MOTOR:
        case TD_SEEK:
        case TD_REMOVE:
        case TD_ADDCHANGEINT:
          // Disk-change soft interrupt hook stays queued (NT_MESSAGE) until TD_REMCHANGEINT; never ReplyMsg immediately
          bus.write8(ioReq + 31, 0);
          bus.write32(ioReq + 32, 0);
          return true;

        case TD_REMCHANGEINT:
          err = 0;
          actual = 0;
          break;

        case TD_CHANGENUM:
          actual = 1;
          err = 0;
          break;

        case TD_CHANGESTATE:
          actual = 0; // 0 = disk present
          err = 0;
          break;

        case TD_PROTSTATUS:
          actual = slot.writeProtected ? 1 : 0;
          err = 0;
          break;

        case TD_GETDRIVETYPE:
          actual = 1; // DRIVE3_5
          err = 0;
          break;

        case TD_GETNUMTRACKS: {
          const p = slot.partitions[0];
          actual = p ? (p.highCyl - p.lowCyl + 1) * p.surfaces : 0;
          err = 0;
          break;
        }

        case TD_GETGEOMETRY: {
          if (dataPtr !== 0) {
            const totalSectors = Math.floor(slot.data.length / HDF_SECTOR_SIZE);
            const geom = computeCylGeometry(totalSectors);
            bus.write32(dataPtr + 0, HDF_SECTOR_SIZE); // dg_SectorSize
            bus.write32(dataPtr + 4, totalSectors); // dg_TotalSectors
            bus.write32(dataPtr + 8, geom.cylinders); // dg_Cylinders
            bus.write32(dataPtr + 12, geom.surfaces * geom.blocksPerTrack); // dg_CylSectors
            bus.write32(dataPtr + 16, geom.surfaces); // dg_Heads
            bus.write32(dataPtr + 20, geom.blocksPerTrack); // dg_TrackSectors
            bus.write32(dataPtr + 24, 0); // dg_BufMemType
            bus.write8(dataPtr + 28, 0); // dg_DeviceType (Direct-access)
            bus.write8(dataPtr + 29, 0); // dg_Flags
            bus.write16(dataPtr + 30, 0);
          }
          actual = 32;
          err = 0;
          break;
        }

        case CMD_READ:
        case TD_READ64:
        case NSCMD_TD_READ64: {
          const offset = cmd === CMD_READ ? offsetLow : offsetHigh * 4294967296 + offsetLow;
          if (offset + length > slot.data.length) {
            err = TDERR_SEEKERROR;
            actual = 0;
          } else {
            const dmaBus = bus as M68kBus & {
              dmaWriteBlock?: (destAddr: number, src: Uint8Array, srcOff: number, len: number) => void;
            };
            if (dmaBus.dmaWriteBlock) {
              dmaBus.dmaWriteBlock(dataPtr, slot.data, offset, length);
            } else {
              const src = slot.data;
              for (let i = 0; i < length; i++) {
                bus.write8(dataPtr + i, src[offset + i]);
              }
            }
            actual = length;
            err = 0;
            slot.ioPulseFrames = 5;
            slot.hasReadSinceReset = true;
          }
          break;
        }

        case CMD_WRITE:
        case TD_FORMAT:
        case TD_WRITE64:
        case TD_FORMAT64:
        case NSCMD_TD_WRITE64:
        case NSCMD_TD_FORMAT64: {
          if (slot.writeProtected) {
            err = TDERR_WRITEPROT;
            actual = 0;
          } else {
            const offset =
              cmd === CMD_WRITE || cmd === TD_FORMAT
                ? offsetLow
                : offsetHigh * 4294967296 + offsetLow;
            if (offset + length > slot.data.length) {
              err = TDERR_SEEKERROR;
              actual = 0;
            } else {
              const dmaBus = bus as M68kBus & {
                dmaReadBlock?: (srcAddr: number, dst: Uint8Array, dstOff: number, len: number) => void;
              };
              if (dmaBus.dmaReadBlock) {
                dmaBus.dmaReadBlock(dataPtr, slot.data, offset, length);
              } else {
                const dst = slot.data;
                for (let i = 0; i < length; i++) {
                  dst[offset + i] = bus.read8(dataPtr + i);
                }
              }
              actual = length;
              err = 0;
              slot.ioPulseFrames = 5;
              slot.usageDirty = true;
              slot.writeSeq++;
            }
          }
          break;
        }

        case NSCMD_DEVICEQUERY: {
          if (dataPtr !== 0 && length >= 16) {
            const romBase = this.configuredBase > 0 ? this.configuredBase : 0x00e90000;
            bus.write32(dataPtr + 0, 0); // DevQueryFormat
            bus.write32(dataPtr + 4, 16); // SizeAvailable
            bus.write16(dataPtr + 8, 5); // NSDEVTYPE_TRACKDISK
            bus.write16(dataPtr + 10, 0); // DeviceSubType
            bus.write32(dataPtr + 12, romBase + OFF_NSD_CMDS); // 0-terminated uint16[] SupportedCommands
            actual = 16;
            err = 0;
          } else {
            err = IOERR_NOCMD;
          }
          break;
        }

        default:
          err = IOERR_NOCMD;
          actual = 0;
          break;
      }
    }

    bus.write8(ioReq + 31, err & 0xff);
    bus.write32(ioReq + 32, actual >>> 0);

    // If IOF_QUICK is set, return true (no ReplyMsg needed). Otherwise set NT_REPLYMSG and let stub ReplyMsg.
    if ((flags & IOF_QUICK) !== 0) {
      return true;
    }
    bus.write8(ioReq + 8, 7); // NT_REPLYMSG = 7
    return false;
  }
}

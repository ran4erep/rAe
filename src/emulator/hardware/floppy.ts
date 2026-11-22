/**
 * Amiga Floppy Disk Controller (DF0: & DF1:) & Real Amiga MFM Track Encoder/Decoder.
 * Supports standard 880 KB Double-Density ADF images (80 cylinders x 2 heads x 11 sectors x 512 bytes).
 */

import { FloppyDriveStatus, SerializedFloppyDriveState } from '../types';

export const ADF_SECTOR_SIZE = 512;
export const ADF_SECTORS_PER_TRACK = 11;
export const ADF_SIDES = 2;
export const ADF_CYLINDERS = 80;
export const ADF_TRACK_BYTES = ADF_SECTORS_PER_TRACK * ADF_SECTOR_SIZE; // 5632
export const ADF_TOTAL_SIZE = ADF_CYLINDERS * ADF_SIDES * ADF_TRACK_BYTES; // 901120 (880 KB)

// Standard Amiga DD raw MFM track buffer length (11 * 1088 + gap ≈ 12668 bytes)
export const MFM_SECTOR_BYTES = 1088;
export const MFM_TRACK_BYTES = 12668;
export const MFM_SYNC_WORD = 0x4489;
// Frames (~0.9s PAL) to keep /CHNG low & media unseated when hot-swapping over an occupied drive
export const FLOPPY_HOTSWAP_EJECT_FRAMES = 45;

/**
 * Computes official AmigaDOS 1024-byte Bootblock Checksum (placed at bytes 4..7).
 */
export function computeAmigaBootblockChecksum(bootblock: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < 1024; i += 4) {
    if (i === 4) continue; // Skip checksum field itself
    const lw =
      ((bootblock[i] << 24) |
        (bootblock[i + 1] << 16) |
        (bootblock[i + 2] << 8) |
        bootblock[i + 3]) >>>
      0;
    const next = sum + lw;
    sum = next > 0xffffffff ? ((next + 1) >>> 0) : (next >>> 0);
  }
  return (~sum) >>> 0;
}

export function writeAmigaBootblockChecksum(adf: Uint8Array): void {
  const csum = computeAmigaBootblockChecksum(adf);
  adf[4] = (csum >>> 24) & 0xff;
  adf[5] = (csum >>> 16) & 0xff;
  adf[6] = (csum >>> 8) & 0xff;
  adf[7] = csum & 0xff;
}

export function verifyAmigaBootblockChecksum(adf: Uint8Array): boolean {
  if (adf.length < 1024) return false;
  let sum = 0;
  for (let i = 0; i < 1024; i += 4) {
    const lw =
      ((adf[i] << 24) | (adf[i + 1] << 16) | (adf[i + 2] << 8) | adf[i + 3]) >>> 0;
    const next = sum + lw;
    sum = next > 0xffffffff ? ((next + 1) >>> 0) : (next >>> 0);
  }
  return sum === 0xffffffff;
}

function writeAmigaDosBlockChecksum(buf: Uint8Array, blockByteOffset: number, checksumWordIndex: number): void {
  let sum = 0;
  for (let i = 0; i < 128; i++) {
    if (i === checksumWordIndex) continue;
    const off = blockByteOffset + i * 4;
    const lw = ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
    sum = (sum + lw) >>> 0;
  }
  const csum = (-sum) >>> 0;
  const cOff = blockByteOffset + checksumWordIndex * 4;
  buf[cOff] = (csum >>> 24) & 0xff;
  buf[cOff + 1] = (csum >>> 16) & 0xff;
  buf[cOff + 2] = (csum >>> 8) & 0xff;
  buf[cOff + 3] = csum & 0xff;
}

/**
 * Builds a standard 880 KB formatted empty AmigaDOS OFS (DOS\0) ADF image
 * with valid Bootblock, Root block (sector 880), and Bitmap block (sector 881).
 */
export function createBlankFormattedAdf(volumeName = 'SaveDisk'): Uint8Array {
  const adf = new Uint8Array(ADF_TOTAL_SIZE);

  // Bootblock (sectors 0..1): 'DOS\0', checksum, rootblock = 880
  adf[0] = 0x44; // 'D'
  adf[1] = 0x4f; // 'O'
  adf[2] = 0x53; // 'S'
  adf[3] = 0x00; // OFS
  writeBE32(adf, 8, 880);
  writeAmigaBootblockChecksum(adf);

  // AmigaDOS timestamp (days since 1978-01-01, minutes, ticks)
  const amigaEpochMs = Date.UTC(1978, 0, 1, 0, 0, 0);
  const nowMs = Math.max(amigaEpochMs, Date.now());
  const diffSec = Math.floor((nowMs - amigaEpochMs) / 1000);
  const days = Math.floor(diffSec / 86400);
  const remSec = diffSec % 86400;
  const mins = Math.floor(remSec / 60);
  const ticks = (remSec % 60) * 50;

  // Root Block (sector 880)
  const rootOff = 880 * ADF_SECTOR_SIZE;
  writeBE32(adf, rootOff + 0, 2);           // type = T_HEADER
  writeBE32(adf, rootOff + 12, 72);         // ht_size = 72
  writeBE32(adf, rootOff + 312, 0xffffffff); // bm_flag = -1 (valid)
  writeBE32(adf, rootOff + 316, 881);       // bm_pages[0] = sector 881
  writeBE32(adf, rootOff + 420, days);      // r_days
  writeBE32(adf, rootOff + 424, mins);      // r_mins
  writeBE32(adf, rootOff + 428, ticks);     // r_ticks

  const cleanName = volumeName.replace(/[:/]/g, '').slice(0, 30) || 'SaveDisk';
  adf[rootOff + 432] = cleanName.length;
  for (let i = 0; i < cleanName.length; i++) {
    adf[rootOff + 433 + i] = cleanName.charCodeAt(i) & 0x7f;
  }

  writeBE32(adf, rootOff + 472, days);      // v_days
  writeBE32(adf, rootOff + 476, mins);      // v_mins
  writeBE32(adf, rootOff + 480, ticks);     // v_ticks
  writeBE32(adf, rootOff + 484, days);      // c_days
  writeBE32(adf, rootOff + 488, mins);      // c_mins
  writeBE32(adf, rootOff + 492, ticks);     // c_ticks
  writeBE32(adf, rootOff + 508, 1);         // sec_type = ST_ROOT
  writeAmigaDosBlockChecksum(adf, rootOff, 5);

  // Bitmap Block (sector 881): 1758 data blocks (sectors 2..1759)
  const bmOff = 881 * ADF_SECTOR_SIZE;
  for (let w = 1; w <= 54; w++) {
    writeBE32(adf, bmOff + w * 4, 0xffffffff);
  }
  writeBE32(adf, bmOff + 55 * 4, 0x3fffffff); // 30 remaining blocks

  // Mark sectors 880 (root) and 881 (bitmap) as allocated (bit = 0)
  for (const usedSec of [880, 881]) {
    const bitIdx = usedSec - 2;
    const wordIdx = 1 + (bitIdx >>> 5);
    const bit = bitIdx & 31;
    const cur = readBE32(adf, bmOff + wordIdx * 4);
    writeBE32(adf, bmOff + wordIdx * 4, (cur & ~(1 << bit)) >>> 0);
  }
  writeAmigaDosBlockChecksum(adf, bmOff, 0);

  return adf;
}

function addMfmClockBits(dataBits: number, prevBit: number): number {
  let out = dataBits & 0x55555555;
  let prev = prevBit & 1;
  for (let bit = 30; bit >= 0; bit -= 2) {
    const cur = (out >>> bit) & 1;
    if (prev === 0 && cur === 0) {
      out |= 1 << (bit + 1);
    }
    prev = cur;
  }
  return out >>> 0;
}

function writeBE32(buf: Uint8Array, offset: number, val: number): void {
  buf[offset] = (val >>> 24) & 0xff;
  buf[offset + 1] = (val >>> 16) & 0xff;
  buf[offset + 2] = (val >>> 8) & 0xff;
  buf[offset + 3] = val & 0xff;
}

function readBE32(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset] << 24) |
      (buf[offset + 1] << 16) |
      (buf[offset + 2] << 8) |
      buf[offset + 3]) >>>
    0
  );
}

/**
 * Encodes one cylinder/side (11 sectors = 5632 bytes) from an ADF image into a real
 * Amiga MFM track stream with $4489 sync marks, odd/even MFM encoding, and valid checksums.
 */
export function encodeAdfTrackToMfm(
  adf: Uint8Array,
  cylinder: number,
  side: number,
  outBuf: Uint8Array
): void {
  outBuf.fill(0xaa); // Standard MFM gap (0-data bits with clock bits = 0xAA)
  const trackNum = (cylinder << 1) | (side & 1);
  const trackOffset = trackNum * ADF_TRACK_BYTES;
  let pos = 0;

  for (let sec = 0; sec < ADF_SECTORS_PER_TRACK; sec++) {
    const secOffset = trackOffset + sec * ADF_SECTOR_SIZE;

    // 2 null words ($AAAA $AAAA) + 2 sync words ($4489 $4489)
    outBuf[pos++] = 0xaa; outBuf[pos++] = 0xaa;
    outBuf[pos++] = 0xaa; outBuf[pos++] = 0xaa;
    outBuf[pos++] = 0x44; outBuf[pos++] = 0x89;
    outBuf[pos++] = 0x44; outBuf[pos++] = 0x89;

    // Format info longword: $FF, trackNum, sectorNum, sectorsUntilGap
    const info = (0xff000000 | (trackNum << 16) | (sec << 8) | (11 - sec)) >>> 0;
    const infoOdd = (info >>> 1) & 0x55555555;
    const infoEven = info & 0x55555555;

    let prev = 1; // Last bit of $4489 is 1
    const encInfoOdd = addMfmClockBits(infoOdd, prev);
    prev = encInfoOdd & 1;
    const encInfoEven = addMfmClockBits(infoEven, prev);
    prev = encInfoEven & 1;

    writeBE32(outBuf, pos, encInfoOdd); pos += 4;
    writeBE32(outBuf, pos, encInfoEven); pos += 4;

    // 16-byte OS sector label (zeros) -> 32 MFM bytes
    let hdrCsum = (infoOdd ^ infoEven) >>> 0;
    for (let i = 0; i < 8; i++) {
      const z = addMfmClockBits(0, prev);
      prev = z & 1;
      writeBE32(outBuf, pos, z);
      pos += 4;
    }

    // Header checksum (odd then even)
    const hcsOdd = addMfmClockBits((hdrCsum >>> 1) & 0x55555555, prev);
    prev = hcsOdd & 1;
    const hcsEven = addMfmClockBits(hdrCsum & 0x55555555, prev);
    prev = hcsEven & 1;
    writeBE32(outBuf, pos, hcsOdd); pos += 4;
    writeBE32(outBuf, pos, hcsEven); pos += 4;

    // Compute data checksum first
    let dataCsum = 0;
    for (let i = 0; i < 512; i += 4) {
      const lw = secOffset + i + 3 < adf.length ? readBE32(adf, secOffset + i) : 0;
      dataCsum ^= ((lw >>> 1) & 0x55555555) ^ (lw & 0x55555555);
    }
    dataCsum >>>= 0;

    const dcsOdd = addMfmClockBits((dataCsum >>> 1) & 0x55555555, prev);
    prev = dcsOdd & 1;
    const dcsEven = addMfmClockBits(dataCsum & 0x55555555, prev);
    prev = dcsEven & 1;
    writeBE32(outBuf, pos, dcsOdd); pos += 4;
    writeBE32(outBuf, pos, dcsEven); pos += 4;

    // Odd data bits (512 bytes)
    for (let i = 0; i < 512; i += 4) {
      const lw = secOffset + i + 3 < adf.length ? readBE32(adf, secOffset + i) : 0;
      const enc = addMfmClockBits((lw >>> 1) & 0x55555555, prev);
      prev = enc & 1;
      writeBE32(outBuf, pos, enc);
      pos += 4;
    }
    // Even data bits (512 bytes)
    for (let i = 0; i < 512; i += 4) {
      const lw = secOffset + i + 3 < adf.length ? readBE32(adf, secOffset + i) : 0;
      const enc = addMfmClockBits(lw & 0x55555555, prev);
      prev = enc & 1;
      writeBE32(outBuf, pos, enc);
      pos += 4;
    }
  }
}

/**
 * Decodes a single MFM-encoded sector starting right after the two $4489 sync words.
 * Used for verification and MFM trackloader tests.
 */
export function decodeMfmSector(
  mfmBuf: Uint8Array,
  afterSyncOffset: number
): { track: number; sector: number; data: Uint8Array; validChecksum: boolean; validHeaderChecksum: boolean } {
  const oddInfo = readBE32(mfmBuf, afterSyncOffset) & 0x55555555;
  const evenInfo = readBE32(mfmBuf, afterSyncOffset + 4) & 0x55555555;
  const info = ((oddInfo << 1) | evenInfo) >>> 0;
  const track = (info >>> 16) & 0xff;
  const sector = (info >>> 8) & 0xff;

  let calcHdrCsum = oddInfo ^ evenInfo;
  for (let i = 0; i < 8; i++) {
    calcHdrCsum ^= readBE32(mfmBuf, afterSyncOffset + 8 + i * 4) & 0x55555555;
  }
  const hcsOdd = readBE32(mfmBuf, afterSyncOffset + 40) & 0x55555555;
  const hcsEven = readBE32(mfmBuf, afterSyncOffset + 44) & 0x55555555;
  const expectedHdrCsum = ((hcsOdd << 1) | hcsEven) >>> 0;

  const dcsOdd = readBE32(mfmBuf, afterSyncOffset + 48) & 0x55555555;
  const dcsEven = readBE32(mfmBuf, afterSyncOffset + 52) & 0x55555555;
  const expectedCsum = ((dcsOdd << 1) | dcsEven) >>> 0;

  const data = new Uint8Array(512);
  let calcCsum = 0;
  const oddBase = afterSyncOffset + 56;
  const evenBase = oddBase + 512;

  for (let i = 0; i < 512; i += 4) {
    const o = readBE32(mfmBuf, oddBase + i) & 0x55555555;
    const e = readBE32(mfmBuf, evenBase + i) & 0x55555555;
    calcCsum ^= o ^ e;
    writeBE32(data, i, ((o << 1) | e) >>> 0);
  }
  return {
    track,
    sector,
    data,
    validChecksum: (calcCsum >>> 0) === expectedCsum,
    validHeaderChecksum: (calcHdrCsum >>> 0) === expectedHdrCsum,
  };
}

export class FloppyDrive {
  public data: Uint8Array | null = null;
  public name = '';
  public cylinder = 0;
  public side = 0;
  public motorOn = false;
  public selected = false;
  public writeProtected = false;
  public diskChanged = false;
  public mfmTrack = new Uint8Array(MFM_TRACK_BYTES);
  public mfmDirty = true;
  public trackBytePos = 0;
  public ioPulseFrames = 0;
  public stepPhase = false;
  public readyDelayLines = 0;
  public ejectHoldFrames = 0;
  private idShift = 0;

  public onInsertCb?: (inserted: boolean) => void;

  public insert(adfData: Uint8Array, name: string, hotSwap = false, writeProtected = false): void {
    const hadDisk = this.data !== null;
    // Normalize to 880KB ADF if slightly smaller
    if (adfData.length === ADF_TOTAL_SIZE) {
      this.data = new Uint8Array(adfData);
    } else {
      const buf = new Uint8Array(ADF_TOTAL_SIZE);
      buf.set(adfData.subarray(0, Math.min(adfData.length, ADF_TOTAL_SIZE)));
      this.data = buf;
    }
    this.name = name;
    this.writeProtected = writeProtected;
    // On hot-swap while Amiga is running, /CHNG stays asserted until the drive steps
    this.diskChanged = hotSwap;
    // Hold media unseated briefly when hot-swapping over a mounted disk (or immediately after eject)
    // so trackdisk.device sees /CHNG remain low across steps and fires IECLASS_DISKREMOVED.
    this.ejectHoldFrames =
      hotSwap && (hadDisk || this.ejectHoldFrames > 0)
        ? Math.max(this.ejectHoldFrames, FLOPPY_HOTSWAP_EJECT_FRAMES)
        : 0;
    this.mfmDirty = true;
    this.trackBytePos = 0;
    this.onInsertCb?.(true);
  }

  public insertBlankDisk(name = 'SaveDisk.adf', volumeName = 'SaveDisk', hotSwap = true): void {
    this.insert(createBlankFormattedAdf(volumeName), name, hotSwap, false);
  }

  public eject(): void {
    const hadDisk = this.data !== null;
    this.data = null;
    this.name = '';
    this.writeProtected = false;
    this.diskChanged = true;
    this.mfmDirty = true;
    this.readyDelayLines = 0;
    if (hadDisk) {
      this.ejectHoldFrames = FLOPPY_HOTSWAP_EJECT_FRAMES;
    }
    this.onInsertCb?.(false);
  }

  public step(outward: boolean): void {
    const prev = this.cylinder;
    if (outward) {
      if (this.cylinder > 0) this.cylinder--;
    } else {
      if (this.cylinder < ADF_CYLINDERS - 1) this.cylinder++;
    }
    if (this.data && this.ejectHoldFrames === 0) {
      this.diskChanged = false;
      this.ioPulseFrames = 6;
      if (this.cylinder !== prev) this.stepPhase = !this.stepPhase;
    } else if (this.motorOn) {
      this.ioPulseFrames = 6;
      if (this.cylinder !== prev) this.stepPhase = !this.stepPhase;
    }
    this.mfmDirty = true;
  }

  public setSide(side: number): void {
    const s = side & 1;
    if (this.side !== s) {
      this.side = s;
      this.mfmDirty = true;
    }
  }

  public resetIdShift(): void {
    this.idShift = 0;
  }

  public readNextIdBit(): boolean {
    // Standard 3.5" DD Amiga drive ID is $00000000 (all 0 bits -> RDY low)
    this.idShift = (this.idShift + 1) & 31;
    return false;
  }

  public ensureMfmTrack(): Uint8Array {
    if (this.mfmDirty) {
      if (this.data) {
        encodeAdfTrackToMfm(this.data, this.cylinder, this.side, this.mfmTrack);
      } else {
        this.mfmTrack.fill(0xaa);
      }
      this.mfmDirty = false;
    }
    return this.mfmTrack;
  }

  public readSectorDirect(linearSector: number, dest: Uint8Array, destOffset: number): boolean {
    if (!this.data) return false;
    const byteOff = linearSector * ADF_SECTOR_SIZE;
    if (byteOff + ADF_SECTOR_SIZE > this.data.length) return false;
    this.cylinder = Math.floor(linearSector / 22);
    this.side = Math.floor((linearSector % 22) / 11);
    this.ioPulseFrames = 6;
    dest.set(this.data.subarray(byteOff, byteOff + ADF_SECTOR_SIZE), destOffset);
    return true;
  }

  public getStatus(): FloppyDriveStatus {
    return {
      inserted: this.data !== null,
      name: this.name,
      track: this.cylinder,
      side: this.side,
      motorOn: this.motorOn,
      activeIo: this.ioPulseFrames > 0,
      stepPhase: this.stepPhase,
      writeProtected: this.writeProtected,
    };
  }

  public getDriveSnapshot(): SerializedFloppyDriveState {
    return {
      inserted: this.data !== null,
      name: this.name,
      cylinder: this.cylinder,
      side: this.side,
      motorOn: this.motorOn,
      selected: this.selected,
      writeProtected: this.writeProtected,
      diskChanged: this.diskChanged,
      trackBytePos: this.trackBytePos,
    };
  }

  public restoreSnapshot(
    meta: SerializedFloppyDriveState | undefined,
    diskBytes: Uint8Array | null,
    fallbackName = ''
  ): void {
    if (diskBytes && diskBytes.length > 0) {
      if (diskBytes.length === ADF_TOTAL_SIZE) {
        this.data = new Uint8Array(diskBytes);
      } else {
        const buf = new Uint8Array(ADF_TOTAL_SIZE);
        buf.set(diskBytes.subarray(0, Math.min(diskBytes.length, ADF_TOTAL_SIZE)));
        this.data = buf;
      }
      this.name = meta?.name || fallbackName || 'disk.adf';
      this.cylinder = meta ? Math.max(0, Math.min(ADF_CYLINDERS - 1, meta.cylinder)) : 0;
      this.side = meta ? meta.side & 1 : 0;
      this.motorOn = meta ? Boolean(meta.motorOn) : false;
      this.selected = meta ? Boolean(meta.selected) : false;
      this.writeProtected = meta ? Boolean(meta.writeProtected) : false;
      this.diskChanged = meta ? Boolean(meta.diskChanged) : false;
      this.trackBytePos = meta ? meta.trackBytePos % MFM_TRACK_BYTES : 0;
      this.ioPulseFrames = 0;
      this.readyDelayLines = 0;
      this.ejectHoldFrames = 0;
      this.mfmDirty = true;
    } else {
      this.data = null;
      this.name = '';
      this.cylinder = meta ? Math.max(0, Math.min(ADF_CYLINDERS - 1, meta.cylinder)) : 0;
      this.side = meta ? meta.side & 1 : 0;
      this.motorOn = false;
      this.selected = false;
      this.diskChanged = true;
      this.trackBytePos = 0;
      this.ioPulseFrames = 0;
      this.readyDelayLines = 0;
      this.ejectHoldFrames = 0;
      this.mfmDirty = true;
    }
  }
}

export interface FloppySoundCallbacks {
  onInsert?: (driveIdx: number, inserted: boolean) => void;
  onMotor?: (driveIdx: number, running: boolean) => void;
  onStep?: (driveIdx: number, cylinder: number) => void;
  onReset?: (drive0HasDisk: boolean, drive1HasDisk: boolean) => void;
}

export class FloppyController {
  public readonly drives: [FloppyDrive, FloppyDrive] = [new FloppyDrive(), new FloppyDrive()];
  private motorLatch = false;
  private activeDriveIndex = -1;
  private anyDriveSelected = false;
  private readonly writeDmaBuf = new Uint8Array(16384);
  private writeDmaBytes = 0;
  public turboFloppy = false;
  public ioSeq = 0;
  public soundCallbacks: FloppySoundCallbacks = {};

  constructor() {
    this.drives[0].onInsertCb = (inserted) => this.soundCallbacks.onInsert?.(0, inserted);
    this.drives[1].onInsertCb = (inserted) => this.soundCallbacks.onInsert?.(1, inserted);
  }

  public tickScanline(): void {
    const d0 = this.drives[0];
    if (d0.readyDelayLines > 0) d0.readyDelayLines--;
    const d1 = this.drives[1];
    if (d1.readyDelayLines > 0) d1.readyDelayLines--;
  }

  public reset(): void {
    for (const d of this.drives) {
      d.cylinder = 0;
      d.side = 0;
      d.motorOn = false;
      d.selected = false;
      d.diskChanged = d.data === null;
      d.trackBytePos = 0;
      d.ioPulseFrames = 0;
      d.readyDelayLines = 0;
      d.ejectHoldFrames = 0;
      d.mfmDirty = true;
    }
    this.motorLatch = false;
    this.activeDriveIndex = -1;
    this.anyDriveSelected = false;
    this.writeDmaBytes = 0;
    this.ioSeq = 0;
    this.soundCallbacks.onReset?.(this.drives[0].data !== null, this.drives[1].data !== null);
  }

  public handleCiaBPrb(prb: number, prevPrb: number): void {
    const mtr = (prb & 0x80) === 0; // Active low
    const side = (prb & 0x04) === 0 ? 1 : 0; // SIDE=0 means upper head (1)
    const dirOut = (prb & 0x02) !== 0; // DIR=1 outward toward track 0
    // Real Shugart/Amiga 3.5" drives latch head step on the trailing rising edge (0 -> 1) of /STEP.
    // Trackloaders like ATN1 (Alien Breed Tower Assault) write $7E/$76 (STEP=0) before BCLR #0 / BSET #0.
    const stepRising = (prevPrb & 0x01) === 0 && (prb & 0x01) !== 0;

    this.activeDriveIndex = -1;
    this.anyDriveSelected = (prb & 0x78) !== 0x78;
    for (let i = 0; i < 2; i++) {
      const selBit = 1 << (3 + i);
      const nowSel = (prb & selBit) === 0;
      const wasSel = (prevPrb & selBit) === 0;
      const drive = this.drives[i];
      drive.selected = nowSel;

      if (nowSel) {
        this.activeDriveIndex = i;
        if (!wasSel) {
          // Motor bit latches on falling edge of SEL
          const prevMotor = drive.motorOn;
          drive.motorOn = mtr;
          this.motorLatch = mtr;
          if (!drive.motorOn) {
            drive.resetIdShift();
            drive.readyDelayLines = 0;
          } else if (!prevMotor) {
            // Real 3.5" DD drive takes ~15ms+ to spin up before asserting /RDY
            drive.readyDelayLines = this.turboFloppy ? 0 : 250;
          }
          if (prevMotor !== drive.motorOn) {
            this.soundCallbacks.onMotor?.(i, drive.motorOn);
            if (drive.motorOn && drive.data !== null && drive.ejectHoldFrames === 0) {
              this.ioSeq = (this.ioSeq + 1) | 0;
            }
          }
        }
        drive.setSide(side);
        if (stepRising) {
          drive.step(dirOut);
          this.soundCallbacks.onStep?.(i, drive.cylinder);
          if (drive.data !== null && drive.ejectHoldFrames === 0 && drive.motorOn) {
            this.ioSeq = (this.ioSeq + 1) | 0;
          }
        }
      }
    }
    void this.motorLatch;
  }

  public getActiveDrive(): FloppyDrive | null {
    if (this.activeDriveIndex >= 0 && this.activeDriveIndex < 2) {
      return this.drives[this.activeDriveIndex];
    }
    return null;
  }

  /**
   * Returns CIA-A PRA bits 5..2 (all active-low):
   * Bit 5: /RDY (drive ready or drive ID bit when motor off)
   * Bit 4: /TK0 (head at cylinder 0)
   * Bit 3: /WPRO (disk write protected)
   * Bit 2: /CHNG (disk removed / changed)
   */
  public getCiaAStatusBits(): number {
    const d = this.getActiveDrive();
    // Unselected bus floats high via pull-ups (0x3c); non-existent DF2:/DF3: report /RDY=1 and /CHNG=0 (0x38)
    if (!d) return this.anyDriveSelected ? 0x38 : 0x3c;

    const mediaReady = d.data !== null && d.ejectHoldFrames === 0;
    let bits = 0x3c;
    if (d.motorOn) {
      if (mediaReady && d.readyDelayLines === 0) bits &= ~0x20; // /RDY active low once motor spun up & disk present
    } else {
      // Drive ID serial protocol (3.5" DD returns 0 -> /RDY low)
      if (!d.readNextIdBit()) bits &= ~0x20;
    }
    if (d.cylinder === 0) bits &= ~0x10; // /TK0 active low
    if (mediaReady && d.writeProtected) bits &= ~0x08; // /WPRO active low
    if (!mediaReady || d.diskChanged) bits &= ~0x04; // /CHNG active low when no disk or changed
    return bits;
  }

  /**
   * Aligns the active drive's track head right after the FIRST sync word of a sector header
   * (matching real Paula WORDSYNC hardware, which leaves the 2nd $4489 in the DMA stream).
   */
  public alignToWordSync(syncWord: number): boolean {
    const drive = this.getActiveDrive();
    if (!drive || !drive.data || drive.ejectHoldFrames > 0) return false;
    const mfm = drive.ensureMfmTrack();
    const len = mfm.length;
    const hi = (syncWord >>> 8) & 0xff;
    const lo = syncWord & 0xff;
    const start = drive.trackBytePos % len;
    for (let tries = 0; tries < len; tries++) {
      const p0 = (start + tries) % len;
      const p1 = (p0 + 1) % len;
      if (mfm[p0] === hi && mfm[p1] === lo) {
        // Avoid syncing on the 2nd word of a $4489 $4489 pair
        const prev0 = (p0 - 2 + len) % len;
        const prev1 = (p0 - 1 + len) % len;
        if (mfm[prev0] === hi && mfm[prev1] === lo) {
          continue;
        }
        drive.trackBytePos = (p0 + 2) % len;
        this.ioSeq = (this.ioSeq + 1) | 0;
        return true;
      }
    }
    return false;
  }

  /**
   * Streams up to `wordCount` MFM words from the active drive's current track position into Chip RAM.
   */
  public streamDiskDmaWords(
    destAddr: number,
    wordCount: number,
    writeChip16: (addr: number, val: number) => void,
    fallbackDrive0 = false
  ): number {
    const drive = this.getActiveDrive() ?? (fallbackDrive0 ? this.drives[0] : null);
    if (!drive || !drive.data || drive.ejectHoldFrames > 0 || wordCount <= 0) return 0;

    const mfm = drive.ensureMfmTrack();
    const len = mfm.length;
    let pos = drive.trackBytePos % len;
    let addr = destAddr & 0x001ffffe;

    for (let w = 0; w < wordCount; w++) {
      const nextPos = pos + 1 < len ? pos + 1 : 0;
      writeChip16(addr, (mfm[pos] << 8) | mfm[nextPos]);
      addr = (addr + 2) & 0x001ffffe;
      pos = nextPos + 1 < len ? nextPos + 1 : 0;
    }
    drive.trackBytePos = pos;
    drive.ioPulseFrames = 6;
    this.ioSeq = (this.ioSeq + 1) | 0;
    return wordCount;
  }

  public peekCurrentMfmByte(): number {
    const drive = this.getActiveDrive();
    if (!drive || !drive.data || drive.ejectHoldFrames > 0) return 0xaa;
    const mfm = drive.ensureMfmTrack();
    return mfm[drive.trackBytePos % mfm.length];
  }

  public beginDiskDmaWrite(): void {
    this.writeDmaBytes = 0;
  }

  public streamDiskDmaWriteWords(
    srcAddr: number,
    wordCount: number,
    readChip16: (addr: number) => number
  ): number {
    if (wordCount <= 0) return 0;
    let addr = srcAddr & 0x001ffffe;
    const buf = this.writeDmaBuf;
    const cap = buf.length;
    let pos = this.writeDmaBytes;
    for (let w = 0; w < wordCount; w++) {
      const word = readChip16(addr);
      addr = (addr + 2) & 0x001ffffe;
      if (pos + 2 <= cap) {
        buf[pos++] = (word >>> 8) & 0xff;
        buf[pos++] = word & 0xff;
      }
    }
    this.writeDmaBytes = pos;
    const drive = this.getActiveDrive();
    if (drive) {
      drive.ioPulseFrames = 6;
      if (drive.data !== null) this.ioSeq = (this.ioSeq + 1) | 0;
    }
    return wordCount;
  }

  /**
   * Decodes MFM sectors written by Paula Disk DMA back into the active drive's ADF buffer.
   */
  public finishDiskDmaWrite(): number {
    const total = this.writeDmaBytes;
    this.writeDmaBytes = 0;
    const drive = this.getActiveDrive();
    if (!drive || !drive.data || drive.ejectHoldFrames > 0 || drive.writeProtected || total < 1084) return 0;

    const buf = this.writeDmaBuf;
    let written = 0;
    let i = 0;
    const limit = total - 1080;

    while (i < limit) {
      if (buf[i] === 0x44 && buf[i + 1] === 0x89) {
        let afterSync = i + 2;
        let syncCount = 1;
        while (syncCount < 4 && afterSync + 1 < limit && buf[afterSync] === 0x44 && buf[afterSync + 1] === 0x89) {
          afterSync += 2;
          syncCount++;
        }
        if (afterSync + 1080 <= total) {
          const decoded = decodeMfmSector(buf, afterSync);
          if (
            decoded.validHeaderChecksum &&
            decoded.validChecksum &&
            decoded.sector < ADF_SECTORS_PER_TRACK &&
            decoded.track < ADF_CYLINDERS * ADF_SIDES
          ) {
            const byteOff = (decoded.track * ADF_SECTORS_PER_TRACK + decoded.sector) * ADF_SECTOR_SIZE;
            if (byteOff + ADF_SECTOR_SIZE <= drive.data.length) {
              drive.data.set(decoded.data, byteOff);
              written++;
            }
            i = afterSync + 1080;
            continue;
          }
        }
      }
      i++;
    }

    if (written > 0) {
      drive.mfmDirty = true;
      drive.ioPulseFrames = 6;
    }
    return written;
  }

  /**
   * Executes a full synchronous Paula Disk DMA read (retained for compatibility/tests).
   */
  public performDiskDmaRead(
    destAddr: number,
    wordCount: number,
    syncWord: number,
    useWordSync: boolean,
    writeChip16: (addr: number, val: number) => void
  ): boolean {
    const drive = this.getActiveDrive() ?? this.drives[0];
    if (!drive.data || drive.ejectHoldFrames > 0 || wordCount <= 0) return false;
    if (useWordSync) {
      const prevIdx = this.activeDriveIndex;
      if (this.activeDriveIndex < 0) this.activeDriveIndex = 0;
      this.alignToWordSync(syncWord);
      this.activeDriveIndex = prevIdx;
    }
    return this.streamDiskDmaWords(destAddr, wordCount, writeChip16, true) > 0;
  }
}

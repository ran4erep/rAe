/**
 * AmigaDOS OFS (DOS\0) Filesystem Builder & Volume Inspector.
 * Generates 100% authentic bootable 880KB ADF images and arbitrary-size HDF Hardfiles
 * compatible with Kickstart 1.2 / 1.3 / 2.04 / 3.1 dos.library.
 */

import {
  ADF_SECTOR_SIZE,
  ADF_TOTAL_SIZE,
  writeAmigaBootblockChecksum,
} from '../hardware/floppy';

export interface VirtualAmigaFile {
  path: string;
  bytes: Uint8Array;
  protection?: number;
  isDirectory?: boolean;
}

export interface AmigaVolumeInfo {
  dosType: string;
  isDos: boolean;
  isBootable: boolean;
  volumeName: string;
  rootEntries: string[];
}

export interface AmigaDosUsageInfo {
  totalDataBytes: number;
  usedBytes: number;
  freeBytes: number;
  minSizeMB: number;
  canResize: boolean;
}

const OFS_DATA_PAYLOAD = 488; // 512 - 24 byte OFS header
const T_HEADER = 2;
const T_DATA = 8;
const T_LIST = 16;
const ST_ROOT = 1;
const ST_USERDIR = 2;
const ST_FILE = 0xfffffffd; // -3

function writeBE32(buf: Uint8Array, off: number, val: number): void {
  buf[off] = (val >>> 24) & 0xff;
  buf[off + 1] = (val >>> 16) & 0xff;
  buf[off + 2] = (val >>> 8) & 0xff;
  buf[off + 3] = val & 0xff;
}

function readBE32(buf: Uint8Array, off: number): number {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}

function writeBlockChecksum(buf: Uint8Array, blockIdx: number, checksumWordIdx: number): void {
  const base = blockIdx * ADF_SECTOR_SIZE;
  let sum = 0;
  for (let i = 0; i < 128; i++) {
    if (i === checksumWordIdx) continue;
    sum = (sum + readBE32(buf, base + i * 4)) >>> 0;
  }
  writeBE32(buf, base + checksumWordIdx * 4, (-sum) >>> 0);
}

function getAmigaDateStamp(): { days: number; mins: number; ticks: number } {
  const amigaEpochMs = Date.UTC(1978, 0, 1, 0, 0, 0);
  const nowMs = Math.max(amigaEpochMs, Date.now());
  const diffSec = Math.floor((nowMs - amigaEpochMs) / 1000);
  const days = Math.floor(diffSec / 86400);
  const remSec = diffSec % 86400;
  return {
    days,
    mins: Math.floor(remSec / 60),
    ticks: (remSec % 60) * 50,
  };
}

function amigaHashName(name: string): number {
  let hash = name.length;
  for (let i = 0; i < name.length; i++) {
    let ch = name.charCodeAt(i) & 0xff;
    if (ch >= 97 && ch <= 122) ch -= 32;
    hash = (hash * 13 + ch) & 0x7ff;
  }
  return hash % 72;
}

function sanitizeAmigaName(raw: string): string {
  const nulIdx = raw.indexOf('\0');
  const beforeNul = nulIdx >= 0 ? raw.slice(0, nulIdx) : raw;
  let cleaned = '';
  for (let i = 0; i < beforeNul.length; i++) {
    const code = beforeNul.charCodeAt(i);
    if (code < 32 || code === 127) continue;
    const ch = beforeNul[i];
    cleaned += ch === ':' || ch === '/' || ch === '\\' ? '_' : ch;
  }
  const clean = cleaned.trim() || 'file';
  if (clean.length <= 30) return clean;
  const lower = clean.toLowerCase();
  for (const ext of ['.info', '.slave', '.rtb', '.pat']) {
    if (lower.endsWith(ext)) {
      return clean.slice(0, 30 - ext.length) + clean.slice(clean.length - ext.length);
    }
  }
  return clean.slice(0, 30);
}

function writeBstr(buf: Uint8Array, off: number, text: string, maxLen = 30): void {
  const s = text.slice(0, maxLen);
  buf[off] = s.length;
  for (let i = 0; i < s.length; i++) {
    buf[off + 1 + i] = s.charCodeAt(i) & 0xff;
  }
}

/**
 * Writes the official Commodore AmigaDOS bootblock loader into bytes 0..1023.
 * Calls Exec FindResident("dos.library") and returns rt_Init in A0, D0=0.
 */
function writeStandardBootblock(buf: Uint8Array, rootBlock: number): void {
  buf[0] = 0x44; // 'D'
  buf[1] = 0x4f; // 'O'
  buf[2] = 0x53; // 'S'
  buf[3] = 0x00; // OFS
  writeBE32(buf, 8, rootBlock);

  const code = [
    0x43, 0xfa, 0x00, 0x18, // lea dosname(pc),a1
    0x4e, 0xae, 0xff, 0xa0, // jsr -96(a6) FindResident
    0x4a, 0x80,             // tst.l d0
    0x67, 0x0a,             // beq.s fail
    0x20, 0x40,             // move.l d0,a0
    0x20, 0x68, 0x00, 0x16, // move.l 22(a0),a0 (rt_Init)
    0x70, 0x00,             // moveq #0,d0
    0x4e, 0x75,             // rts
    0x70, 0xff,             // fail: moveq #-1,d0
    0x4e, 0x75,             // rts
  ];
  buf.set(code, 12);
  const dosLib = 'dos.library\0';
  for (let i = 0; i < dosLib.length; i++) {
    buf[12 + code.length + i] = dosLib.charCodeAt(i);
  }
  writeAmigaBootblockChecksum(buf);
}

/**
 * Estimates total 512-byte sectors needed to store all files/dirs in OFS.
 */
export function estimateRequiredOfsBlocks(files: VirtualAmigaFile[]): number {
  let blocks = 16; // boot + root + bitmaps margin
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.path.split('/').filter(Boolean);
    if (f.isDirectory) {
      for (let i = 0; i < parts.length; i++) {
        dirs.add(parts.slice(0, i + 1).join('/'));
      }
      continue;
    }
    for (let i = 0; i < parts.length - 1; i++) {
      dirs.add(parts.slice(0, i + 1).join('/'));
    }
    const dataBlocks = Math.ceil(f.bytes.length / OFS_DATA_PAYLOAD);
    const extBlocks = dataBlocks > 72 ? Math.ceil((dataBlocks - 72) / 72) : 0;
    blocks += 1 + dataBlocks + extBlocks;
  }
  blocks += dirs.size;
  return blocks;
}

/**
 * Formats an AmigaDOS OFS (DOS\0) volume of `totalBlocks` sectors and populates it with `files`.
 * Used for both bootable 880KB ADFs and arbitrary-size HDF Hardfiles!
 */
export function buildAmigaOfsVolume(
  totalBlocks: number,
  volumeName: string,
  files: VirtualAmigaFile[] = []
): Uint8Array {
  const totalBytes = totalBlocks * ADF_SECTOR_SIZE;
  const img = new Uint8Array(totalBytes);
  const rootBlock = Math.floor(totalBlocks / 2);
  const stamp = getAmigaDateStamp();

  writeStandardBootblock(img, rootBlock);

  // Bitmap geometry: each bitmap block tracks 4064 blocks (blocks 2..totalBlocks-1)
  const dataAreaBlocks = totalBlocks - 2;
  const numBitmapBlocks = Math.max(1, Math.ceil(dataAreaBlocks / 4064));
  const numBmExtBlocks = numBitmapBlocks > 25 ? Math.ceil((numBitmapBlocks - 25) / 127) : 0;

  // Allocate bitmap blocks right after rootBlock (or before if needed)
  const bitmapBlocks: number[] = [];
  const bmExtBlocks: number[] = [];
  let cursor = rootBlock + 1;
  for (let i = 0; i < numBitmapBlocks; i++) {
    bitmapBlocks.push(cursor++);
  }
  for (let i = 0; i < numBmExtBlocks; i++) {
    bmExtBlocks.push(cursor++);
  }

  // Track allocated blocks in a fast bitset
  const allocated = new Uint8Array(totalBlocks);
  allocated[0] = 1;
  allocated[1] = 1;
  allocated[rootBlock] = 1;
  for (const b of bitmapBlocks) allocated[b] = 1;
  for (const b of bmExtBlocks) allocated[b] = 1;

  // Simple bump allocator skipping root/bitmap area
  let allocCursor = 2;
  const allocBlock = (): number => {
    while (allocCursor < totalBlocks && allocated[allocCursor] !== 0) {
      allocCursor++;
    }
    if (allocCursor >= totalBlocks) {
      throw new Error('Недостаточно места в образе AmigaDOS для размещения всех файлов.');
    }
    allocated[allocCursor] = 1;
    return allocCursor++;
  };

  // Initialize Root Block
  const rootOff = rootBlock * ADF_SECTOR_SIZE;
  writeBE32(img, rootOff + 0, T_HEADER);
  writeBE32(img, rootOff + 12, 72);
  writeBE32(img, rootOff + 312, 0xffffffff); // bm_flag = valid
  for (let i = 0; i < Math.min(25, bitmapBlocks.length); i++) {
    writeBE32(img, rootOff + 316 + i * 4, bitmapBlocks[i]);
  }
  if (bmExtBlocks.length > 0) {
    writeBE32(img, rootOff + 416, bmExtBlocks[0]);
    for (let e = 0; e < bmExtBlocks.length; e++) {
      const extOff = bmExtBlocks[e] * ADF_SECTOR_SIZE;
      const startIdx = 25 + e * 127;
      for (let k = 0; k < 127 && startIdx + k < bitmapBlocks.length; k++) {
        writeBE32(img, extOff + k * 4, bitmapBlocks[startIdx + k]);
      }
      if (e + 1 < bmExtBlocks.length) {
        writeBE32(img, extOff + 127 * 4, bmExtBlocks[e + 1]);
      }
    }
  }
  writeBE32(img, rootOff + 420, stamp.days);
  writeBE32(img, rootOff + 424, stamp.mins);
  writeBE32(img, rootOff + 428, stamp.ticks);
  writeBstr(img, rootOff + 432, sanitizeAmigaName(volumeName), 30);
  writeBE32(img, rootOff + 472, stamp.days);
  writeBE32(img, rootOff + 476, stamp.mins);
  writeBE32(img, rootOff + 480, stamp.ticks);
  writeBE32(img, rootOff + 484, stamp.days);
  writeBE32(img, rootOff + 488, stamp.mins);
  writeBE32(img, rootOff + 492, stamp.ticks);
  writeBE32(img, rootOff + 508, ST_ROOT);

  // Track created directories (lowercase full path -> block index) and all header blocks to checksum at the end
  const dirMap = new Map<string, number>();
  dirMap.set('', rootBlock);
  const headerBlocksToChecksum = new Set<number>([rootBlock]);
  const usedNamesInDir = new Map<number, Set<string>>();
  usedNamesInDir.set(rootBlock, new Set());

  const linkIntoParent = (parentBlock: number, entryBlock: number, name: string) => {
    const parentOff = parentBlock * ADF_SECTOR_SIZE;
    const hashIdx = amigaHashName(name);
    const prevHead = readBE32(img, parentOff + 24 + hashIdx * 4);
    writeBE32(img, entryBlock * ADF_SECTOR_SIZE + 496, prevHead);
    writeBE32(img, parentOff + 24 + hashIdx * 4, entryBlock);
    headerBlocksToChecksum.add(parentBlock);
  };

  const ensureDir = (segments: string[]): number => {
    let curPath = '';
    let parentBlock = rootBlock;
    for (const rawSeg of segments) {
      const seg = sanitizeAmigaName(rawSeg);
      const nextKey = curPath ? `${curPath}/${seg.toLowerCase()}` : seg.toLowerCase();
      const existing = dirMap.get(nextKey);
      if (existing !== undefined) {
        curPath = nextKey;
        parentBlock = existing;
        continue;
      }

      const dirBlock = allocBlock();
      const dOff = dirBlock * ADF_SECTOR_SIZE;
      writeBE32(img, dOff + 0, T_HEADER);
      writeBE32(img, dOff + 4, dirBlock);
      writeBE32(img, dOff + 420, stamp.days);
      writeBE32(img, dOff + 424, stamp.mins);
      writeBE32(img, dOff + 428, stamp.ticks);
      writeBstr(img, dOff + 432, seg, 30);
      writeBE32(img, dOff + 500, parentBlock);
      writeBE32(img, dOff + 508, ST_USERDIR);

      linkIntoParent(parentBlock, dirBlock, seg);
      headerBlocksToChecksum.add(dirBlock);
      dirMap.set(nextKey, dirBlock);
      usedNamesInDir.set(dirBlock, new Set());
      usedNamesInDir.get(parentBlock)?.add(seg.toLowerCase());

      curPath = nextKey;
      parentBlock = dirBlock;
    }
    return parentBlock;
  };

  for (const file of files) {
    const parts = file.path.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length === 0) continue;
    if (file.isDirectory) {
      ensureDir(parts);
      continue;
    }

    const rawFileName = parts[parts.length - 1];
    const dirSegments = parts.slice(0, -1);
    const parentBlock = ensureDir(dirSegments);

    let fileName = sanitizeAmigaName(rawFileName);
    const siblings = usedNamesInDir.get(parentBlock)!;
    if (siblings.has(fileName.toLowerCase())) {
      // Deduplicate rare collisions inside flattened names while keeping .info/.slave suffix
      const lower = fileName.toLowerCase();
      let extKeep = '';
      for (const ext of ['.info', '.slave', '.rtb', '.pat']) {
        if (lower.endsWith(ext)) {
          extKeep = fileName.slice(fileName.length - ext.length);
          break;
        }
      }
      const stem = extKeep ? fileName.slice(0, fileName.length - extKeep.length) : fileName;
      let suffix = 1;
      let candidate = '';
      do {
        const tag = `_${suffix}${extKeep}`;
        candidate = `${stem.slice(0, 30 - tag.length)}${tag}`;
        suffix++;
      } while (siblings.has(candidate.toLowerCase()));
      fileName = candidate;
    }
    siblings.add(fileName.toLowerCase());

    const fhBlock = allocBlock();
    const fhOff = fhBlock * ADF_SECTOR_SIZE;
    const byteSize = file.bytes.length;
    const totalDataBlocks = Math.ceil(byteSize / OFS_DATA_PAYLOAD);

    // Allocate data blocks upfront so next_data pointers are known immediately
    const dataBlockNums: number[] = [];
    for (let i = 0; i < totalDataBlocks; i++) {
      dataBlockNums.push(allocBlock());
    }

    for (let i = 0; i < totalDataBlocks; i++) {
      const db = dataBlockNums[i];
      const dbOff = db * ADF_SECTOR_SIZE;
      const srcStart = i * OFS_DATA_PAYLOAD;
      const chunkLen = Math.min(OFS_DATA_PAYLOAD, byteSize - srcStart);
      writeBE32(img, dbOff + 0, T_DATA);
      writeBE32(img, dbOff + 4, fhBlock);
      writeBE32(img, dbOff + 8, i + 1); // 1-based seq_num
      writeBE32(img, dbOff + 12, chunkLen);
      writeBE32(img, dbOff + 16, i + 1 < totalDataBlocks ? dataBlockNums[i + 1] : 0);
      img.set(file.bytes.subarray(srcStart, srcStart + chunkLen), dbOff + 24);
      writeBlockChecksum(img, db, 5);
    }

    // Write File Header
    writeBE32(img, fhOff + 0, T_HEADER);
    writeBE32(img, fhOff + 4, fhBlock);
    const firstChunkCount = Math.min(72, totalDataBlocks);
    writeBE32(img, fhOff + 8, firstChunkCount);
    writeBE32(img, fhOff + 16, totalDataBlocks > 0 ? dataBlockNums[0] : 0);
    for (let k = 0; k < firstChunkCount; k++) {
      writeBE32(img, fhOff + 24 + (71 - k) * 4, dataBlockNums[k]);
    }
    if (file.protection) {
      writeBE32(img, fhOff + 320, file.protection >>> 0);
    }
    writeBE32(img, fhOff + 324, byteSize);
    writeBE32(img, fhOff + 420, stamp.days);
    writeBE32(img, fhOff + 424, stamp.mins);
    writeBE32(img, fhOff + 428, stamp.ticks);
    writeBstr(img, fhOff + 432, fileName, 30);
    writeBE32(img, fhOff + 500, parentBlock);
    writeBE32(img, fhOff + 508, ST_FILE);

    // Extension blocks if file > 72 * 488 bytes (~35 KB)
    if (totalDataBlocks > 72) {
      let prevHeaderOff = fhOff;
      let idx = 72;
      while (idx < totalDataBlocks) {
        const extBlock = allocBlock();
        const extOff = extBlock * ADF_SECTOR_SIZE;
        writeBE32(img, prevHeaderOff + 504, extBlock);
        const count = Math.min(72, totalDataBlocks - idx);
        writeBE32(img, extOff + 0, T_LIST);
        writeBE32(img, extOff + 4, extBlock);
        writeBE32(img, extOff + 8, count);
        for (let k = 0; k < count; k++) {
          writeBE32(img, extOff + 24 + (71 - k) * 4, dataBlockNums[idx + k]);
        }
        writeBE32(img, extOff + 500, fhBlock);
        writeBE32(img, extOff + 508, ST_FILE);
        headerBlocksToChecksum.add(extBlock);
        prevHeaderOff = extOff;
        idx += count;
      }
    }

    linkIntoParent(parentBlock, fhBlock, fileName);
    headerBlocksToChecksum.add(fhBlock);
  }

  // Finalize checksums for all directory / root / file-header / extension blocks
  for (const blk of headerBlocksToChecksum) {
    writeBlockChecksum(img, blk, 5);
  }

  // Build Bitmap Blocks (1 = FREE, 0 = ALLOCATED)
  for (let page = 0; page < bitmapBlocks.length; page++) {
    const bmBlk = bitmapBlocks[page];
    const bmOff = bmBlk * ADF_SECTOR_SIZE;
    const baseBlock = 2 + page * 4064;
    for (let w = 0; w < 127; w++) {
      let word = 0;
      const wordBase = baseBlock + w * 32;
      for (let bit = 0; bit < 32; bit++) {
        const bIdx = wordBase + bit;
        if (bIdx < totalBlocks && allocated[bIdx] === 0) {
          word |= 1 << bit;
        }
      }
      writeBE32(img, bmOff + (1 + w) * 4, word >>> 0);
    }
    writeBlockChecksum(img, bmBlk, 0);
  }

  return img;
}

/**
 * Packs files into a bootable 880 KB AmigaDOS OFS ADF if they fit.
 */
export function createPopulatedBootableAdf(volumeName: string, files: VirtualAmigaFile[]): Uint8Array {
  return buildAmigaOfsVolume(ADF_TOTAL_SIZE / ADF_SECTOR_SIZE, volumeName, files);
}

/**
 * Creates a blank formatted AmigaDOS OFS HDF Hardfile of `sizeMB` megabytes.
 */
export function createBlankFormattedHdf(sizeMB = 2, volumeName = 'WorkHD'): Uint8Array {
  const clampedMB = Math.max(1, Math.min(64, Math.round(sizeMB)));
  const totalBlocks = clampedMB * 2048; // 2048 * 512 = 1 MB
  return buildAmigaOfsVolume(totalBlocks, volumeName, []);
}

/**
 * Packs Amiga files (e.g. from LHA/ZIP) into an AmigaDOS OFS HDF Hardfile.
 * If `targetSizeMB` is given (1..64), sizes the HDF to at least that capacity.
 */
export function createPopulatedHdf(
  volumeName: string,
  files: VirtualAmigaFile[],
  targetSizeMB?: number
): Uint8Array {
  const needed = estimateRequiredOfsBlocks(files);
  const minBlocks = Math.max(2048, Math.ceil((needed + 64) / 2048) * 2048);
  let totalBlocks: number;
  if (targetSizeMB !== undefined && Number.isFinite(targetSizeMB)) {
    const clampedMB = Math.max(1, Math.min(64, Math.round(targetSizeMB)));
    totalBlocks = Math.max(minBlocks, clampedMB * 2048);
  } else {
    totalBlocks = Math.max(2048, Math.ceil((needed + 512) / 1024) * 1024);
  }
  return buildAmigaOfsVolume(totalBlocks, volumeName, files);
}

function popcount32(v: number): number {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function readBstrName(bytes: Uint8Array, off: number): string {
  const len = Math.min(30, bytes[off]);
  let name = '';
  for (let i = 0; i < len; i++) {
    const c = bytes[off + 1 + i];
    if (c === 0) break;
    if (c >= 32 && c <= 126) name += String.fromCharCode(c);
  }
  return name;
}

/**
 * Computes exact used/free space from AmigaDOS Root Block + Bitmap Blocks (OFS/FFS).
 * Optimized with SWAR 32-bit popcount and zero allocations in the inner loop.
 */
export function inspectAmigaDosUsage(
  bytes: Uint8Array,
  partitionByteOffset = 0,
  partitionByteLength?: number
): AmigaDosUsageInfo {
  const availBytes = Math.min(
    bytes.length - partitionByteOffset,
    partitionByteLength ?? bytes.length - partitionByteOffset
  );
  if (availBytes < 1024) {
    return { totalDataBytes: 0, usedBytes: 0, freeBytes: 0, minSizeMB: 1, canResize: false };
  }

  const partBlocks = Math.floor(availBytes / ADF_SECTOR_SIZE);
  const totalDataBytes = partBlocks * ADF_SECTOR_SIZE;
  const d0 = bytes[partitionByteOffset];
  const d1 = bytes[partitionByteOffset + 1];
  const d2 = bytes[partitionByteOffset + 2];
  const d3 = bytes[partitionByteOffset + 3];
  const isStandardDos = d0 === 0x44 && d1 === 0x4f && d2 === 0x53 && d3 <= 5;
  if (!isStandardDos) {
    return {
      totalDataBytes,
      usedBytes: totalDataBytes,
      freeBytes: 0,
      minSizeMB: Math.max(1, Math.ceil(totalDataBytes / (1024 * 1024))),
      canResize: false,
    };
  }

  let rootBlk = readBE32(bytes, partitionByteOffset + 8);
  if (rootBlk < 2 || rootBlk >= partBlocks) {
    rootBlk = Math.floor(partBlocks / 2);
  }
  const rootOff = partitionByteOffset + rootBlk * ADF_SECTOR_SIZE;
  if (
    rootOff + ADF_SECTOR_SIZE > partitionByteOffset + availBytes ||
    readBE32(bytes, rootOff) !== T_HEADER ||
    readBE32(bytes, rootOff + 508) !== ST_ROOT
  ) {
    return {
      totalDataBytes,
      usedBytes: totalDataBytes,
      freeBytes: 0,
      minSizeMB: Math.max(1, Math.ceil(totalDataBytes / (1024 * 1024))),
      canResize: false,
    };
  }

  const bmValid = readBE32(bytes, rootOff + 312) === 0xffffffff;
  if (!bmValid) {
    return {
      totalDataBytes,
      usedBytes: 0,
      freeBytes: totalDataBytes,
      minSizeMB: 1,
      canResize: true,
    };
  }

  const totalTrackableBlocks = Math.max(0, partBlocks - 2);
  let remainingBits = totalTrackableBlocks;
  let freeBlocks = 0;

  const scanBitmapBlock = (bmBlk: number) => {
    if (remainingBits <= 0 || bmBlk < 2 || bmBlk >= partBlocks) return;
    const bmOff = partitionByteOffset + bmBlk * ADF_SECTOR_SIZE;
    if (bmOff + ADF_SECTOR_SIZE > partitionByteOffset + availBytes) return;
    for (let w = 0; w < 127 && remainingBits > 0; w++) {
      let word = readBE32(bytes, bmOff + (1 + w) * 4);
      if (remainingBits < 32) {
        word &= ((1 << remainingBits) - 1) >>> 0;
        freeBlocks += popcount32(word);
        remainingBits = 0;
      } else {
        freeBlocks += popcount32(word);
        remainingBits -= 32;
      }
    }
  };

  for (let i = 0; i < 25 && remainingBits > 0; i++) {
    const bmBlk = readBE32(bytes, rootOff + 316 + i * 4);
    if (bmBlk !== 0) scanBitmapBlock(bmBlk);
  }

  let extBlk = readBE32(bytes, rootOff + 416);
  let extGuard = 0;
  while (extBlk !== 0 && remainingBits > 0 && extGuard++ < 128) {
    if (extBlk < 2 || extBlk >= partBlocks) break;
    const extOff = partitionByteOffset + extBlk * ADF_SECTOR_SIZE;
    if (extOff + ADF_SECTOR_SIZE > partitionByteOffset + availBytes) break;
    for (let k = 0; k < 127 && remainingBits > 0; k++) {
      const bmBlk = readBE32(bytes, extOff + k * 4);
      if (bmBlk !== 0) scanBitmapBlock(bmBlk);
    }
    extBlk = readBE32(bytes, extOff + 127 * 4);
  }

  const freeBytes = Math.min(totalDataBytes, freeBlocks * ADF_SECTOR_SIZE);
  const usedBytes = Math.max(0, totalDataBytes - freeBytes);
  const usedBlocks = Math.max(0, partBlocks - freeBlocks);
  const minSizeMB = Math.max(1, Math.min(64, Math.ceil((usedBlocks + 48) / 2048)));

  return {
    totalDataBytes,
    usedBytes,
    freeBytes,
    minSizeMB,
    canResize: true,
  };
}

/**
 * Extracts all files from an AmigaDOS OFS/FFS partition image.
 */
export function extractAmigaDosFiles(
  bytes: Uint8Array,
  partitionByteOffset = 0,
  partitionByteLength?: number
): { volumeName: string; files: VirtualAmigaFile[] } | null {
  const availBytes = Math.min(
    bytes.length - partitionByteOffset,
    partitionByteLength ?? bytes.length - partitionByteOffset
  );
  if (availBytes < 1024) return null;

  const d0 = bytes[partitionByteOffset];
  const d1 = bytes[partitionByteOffset + 1];
  const d2 = bytes[partitionByteOffset + 2];
  const d3 = bytes[partitionByteOffset + 3];
  if (d0 !== 0x44 || d1 !== 0x4f || d2 !== 0x53 || d3 > 5) {
    return null;
  }
  const isFfs = (d3 & 1) === 1;
  const partBlocks = Math.floor(availBytes / ADF_SECTOR_SIZE);

  let rootBlk = readBE32(bytes, partitionByteOffset + 8);
  if (rootBlk < 2 || rootBlk >= partBlocks) {
    rootBlk = Math.floor(partBlocks / 2);
  }
  const rootOff = partitionByteOffset + rootBlk * ADF_SECTOR_SIZE;
  if (
    rootOff + ADF_SECTOR_SIZE > partitionByteOffset + availBytes ||
    readBE32(bytes, rootOff) !== T_HEADER ||
    readBE32(bytes, rootOff + 508) !== ST_ROOT
  ) {
    return null;
  }

  const volumeName = readBstrName(bytes, rootOff + 432) || 'WorkHD';
  const files: VirtualAmigaFile[] = [];
  const visitedHeaders = new Set<number>([rootBlk]);

  const readFileBytes = (fhBlk: number): Uint8Array => {
    const fhOff = partitionByteOffset + fhBlk * ADF_SECTOR_SIZE;
    const byteSize = readBE32(bytes, fhOff + 324);
    if (byteSize === 0) return new Uint8Array(0);

    const out = new Uint8Array(byteSize);
    let writePos = 0;
    let curBlk = fhBlk;
    let extGuard = 0;

    while (curBlk >= 2 && curBlk < partBlocks && writePos < byteSize && extGuard++ < 4096) {
      const curOff = partitionByteOffset + curBlk * ADF_SECTOR_SIZE;
      const count = Math.min(72, readBE32(bytes, curOff + 8));
      for (let k = 0; k < count && writePos < byteSize; k++) {
        const dataBlk = readBE32(bytes, curOff + 24 + (71 - k) * 4);
        if (dataBlk < 2 || dataBlk >= partBlocks) break;
        const dOff = partitionByteOffset + dataBlk * ADF_SECTOR_SIZE;
        const rem = byteSize - writePos;
        if (isFfs) {
          const chunkLen = Math.min(ADF_SECTOR_SIZE, rem);
          out.set(bytes.subarray(dOff, dOff + chunkLen), writePos);
          writePos += chunkLen;
        } else {
          const hdrDataSize = readBE32(bytes, dOff + 12);
          const chunkLen = Math.min(OFS_DATA_PAYLOAD, rem, hdrDataSize > 0 ? hdrDataSize : OFS_DATA_PAYLOAD);
          out.set(bytes.subarray(dOff + 24, dOff + 24 + chunkLen), writePos);
          writePos += chunkLen;
        }
      }
      curBlk = readBE32(bytes, curOff + 504); // extension block
    }

    return out;
  };

  const walkDir = (dirBlk: number, prefix: string): boolean => {
    const dirOff = partitionByteOffset + dirBlk * ADF_SECTOR_SIZE;
    let hasChildren = false;
    for (let h = 0; h < 72; h++) {
      let entryBlk = readBE32(bytes, dirOff + 24 + h * 4);
      let chainGuard = 0;
      while (entryBlk >= 2 && entryBlk < partBlocks && !visitedHeaders.has(entryBlk) && chainGuard++ < 4096) {
        visitedHeaders.add(entryBlk);
        const eOff = partitionByteOffset + entryBlk * ADF_SECTOR_SIZE;
        if (eOff + ADF_SECTOR_SIZE > partitionByteOffset + availBytes) break;

        const name = readBstrName(bytes, eOff + 432);
        const secType = readBE32(bytes, eOff + 508);
        const nextChain = readBE32(bytes, eOff + 496);

        if (name) {
          hasChildren = true;
          const fullPath = prefix ? `${prefix}/${name}` : name;
          if (secType === ST_USERDIR) {
            if (!walkDir(entryBlk, fullPath)) {
              files.push({ path: fullPath, bytes: new Uint8Array(0), isDirectory: true });
            }
          } else if (secType === ST_FILE) {
            const protection = readBE32(bytes, eOff + 320);
            files.push({
              path: fullPath,
              bytes: readFileBytes(entryBlk),
              ...(protection ? { protection } : {}),
            });
          }
        }

        entryBlk = nextChain;
      }
    }
    return hasChildren;
  };

  walkDir(rootBlk, '');
  return { volumeName, files };
}

/**
 * Safely resizes an AmigaDOS HDF image to `newSizeMB` megabytes while preserving all files.
 */
export function resizeAmigaDosHdf(
  bytes: Uint8Array,
  newSizeMB: number
): { ok: boolean; bytes?: Uint8Array; minSizeMB?: number; error?: string } {
  if (
    bytes.length >= 512 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x44 &&
    bytes[2] === 0x53 &&
    bytes[3] === 0x4b
  ) {
    return {
      ok: false,
      error: 'Изменение размера RDB-образа с разметкой разделов не поддерживается.',
    };
  }

  const extracted = extractAmigaDosFiles(bytes, 0);
  if (!extracted) {
    return {
      ok: false,
      error: 'Файловая система образа не поддерживает автоматическое изменение размера.',
    };
  }

  const neededBlocks = estimateRequiredOfsBlocks(extracted.files);
  const minSizeMB = Math.max(1, Math.min(64, Math.ceil((neededBlocks + 32) / 2048)));
  const clampedMB = Math.max(1, Math.min(64, Math.round(newSizeMB)));
  const targetBlocks = clampedMB * 2048;

  if (neededBlocks + 32 > targetBlocks) {
    return {
      ok: false,
      minSizeMB,
      error: `Для текущих файлов требуется минимум ${minSizeMB} МБ.`,
    };
  }

  const rebuilt = buildAmigaOfsVolume(targetBlocks, extracted.volumeName, extracted.files);
  return {
    ok: true,
    bytes: rebuilt,
    minSizeMB,
  };
}

/**
 * Fast zero-allocation check for NUL-corrupted filenames inside an AmigaDOS OFS/FFS HDF
 * (e.g. "Disk.1\0Dune" written before NUL-stripping). Only rebuilds if any header BSTR contains 0x00.
 */
export function repairAmigaDosNulFilenames(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 1024) return bytes;
  const d0 = bytes[0];
  const d1 = bytes[1];
  const d2 = bytes[2];
  const d3 = bytes[3];
  if (d0 !== 0x44 || d1 !== 0x4f || d2 !== 0x53 || d3 > 5) {
    return bytes;
  }

  const partBlocks = Math.floor(bytes.length / ADF_SECTOR_SIZE);
  let rootBlk = readBE32(bytes, 8);
  if (rootBlk < 2 || rootBlk >= partBlocks) {
    rootBlk = Math.floor(partBlocks / 2);
  }
  const rootOff = rootBlk * ADF_SECTOR_SIZE;
  if (
    rootOff + ADF_SECTOR_SIZE > bytes.length ||
    readBE32(bytes, rootOff) !== T_HEADER ||
    readBE32(bytes, rootOff + 508) !== ST_ROOT
  ) {
    return bytes;
  }

  let hasBrokenBstr = false;
  const visited = new Set<number>([rootBlk]);
  const scanDir = (dirBlk: number) => {
    if (hasBrokenBstr) return;
    const dirOff = dirBlk * ADF_SECTOR_SIZE;
    for (let h = 0; h < 72 && !hasBrokenBstr; h++) {
      let entryBlk = readBE32(bytes, dirOff + 24 + h * 4);
      let guard = 0;
      while (entryBlk >= 2 && entryBlk < partBlocks && !visited.has(entryBlk) && guard++ < 4096) {
        visited.add(entryBlk);
        const eOff = entryBlk * ADF_SECTOR_SIZE;
        if (eOff + ADF_SECTOR_SIZE > bytes.length) break;
        const nameLen = Math.min(30, bytes[eOff + 432]);
        for (let i = 0; i < nameLen; i++) {
          if (bytes[eOff + 433 + i] === 0) {
            hasBrokenBstr = true;
            return;
          }
        }
        const secType = readBE32(bytes, eOff + 508);
        if (secType === ST_USERDIR) {
          scanDir(entryBlk);
          if (hasBrokenBstr) return;
        }
        entryBlk = readBE32(bytes, eOff + 496);
      }
    }
  };
  scanDir(rootBlk);

  if (!hasBrokenBstr) return bytes;
  const extracted = extractAmigaDosFiles(bytes, 0);
  if (!extracted) return bytes;
  const targetMB = Math.max(1, Math.min(64, Math.round(bytes.length / (1024 * 1024))));
  return createPopulatedHdf(extracted.volumeName, extracted.files, targetMB);
}

/**
 * Reads AmigaDOS volume metadata & root directory entries from a partition image.
 */
export function inspectAmigaDosVolume(bytes: Uint8Array, partitionByteOffset = 0): AmigaVolumeInfo {
  if (bytes.length < partitionByteOffset + 1024) {
    return { dosType: 'RAW', isDos: false, isBootable: false, volumeName: '', rootEntries: [] };
  }
  const d0 = bytes[partitionByteOffset];
  const d1 = bytes[partitionByteOffset + 1];
  const d2 = bytes[partitionByteOffset + 2];
  const d3 = bytes[partitionByteOffset + 3];
  const isDos = d0 === 0x44 && d1 === 0x4f && d2 === 0x53 && d3 <= 7;
  const dosType = isDos ? `DOS\\${d3}` : 'CUSTOM';

  // Verify bootblock checksum
  let sum = 0;
  for (let i = 0; i < 1024; i += 4) {
    const next = sum + readBE32(bytes, partitionByteOffset + i);
    sum = next > 0xffffffff ? ((next + 1) >>> 0) : (next >>> 0);
  }
  const isBootable = isDos && sum === 0xffffffff;

  let volumeName = '';
  const rootEntries: string[] = [];
  if (isDos) {
    const partBlocks = Math.floor((bytes.length - partitionByteOffset) / ADF_SECTOR_SIZE);
    let rootBlk = readBE32(bytes, partitionByteOffset + 8);
    if (rootBlk === 0 || rootBlk >= partBlocks) {
      rootBlk = Math.floor(partBlocks / 2);
    }
    const rootOff = partitionByteOffset + rootBlk * ADF_SECTOR_SIZE;
    if (rootOff + ADF_SECTOR_SIZE <= bytes.length && readBE32(bytes, rootOff) === T_HEADER) {
      volumeName = readBstrName(bytes, rootOff + 432);

      // Walk hash table entries in root block
      const visited = new Set<number>();
      for (let h = 0; h < 72 && rootEntries.length < 32; h++) {
        let blk = readBE32(bytes, rootOff + 24 + h * 4);
        while (blk > 1 && blk < partBlocks && !visited.has(blk) && rootEntries.length < 32) {
          visited.add(blk);
          const eOff = partitionByteOffset + blk * ADF_SECTOR_SIZE;
          if (eOff + ADF_SECTOR_SIZE > bytes.length) break;
          const eName = readBstrName(bytes, eOff + 432);
          const secType = readBE32(bytes, eOff + 508);
          if (eName) {
            rootEntries.push(secType === ST_USERDIR ? `${eName}/` : eName);
          }
          blk = readBE32(bytes, eOff + 496);
        }
      }
    }
  }

  return { dosType, isDos, isBootable, volumeName, rootEntries };
}

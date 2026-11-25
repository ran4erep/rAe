/**
 * High-performance zero-dependency LHA / LZH (.lha / .lzh) archive parser & decompressor.
 * Supports Header Levels 0, 1, and 2 (including Amiga 0xFF directory separators)
 * and methods -lh0-, -lz4-, -lhd-, -lh1-, -lh4-, -lh5-, -lh6-, -lh7-.
 */

export interface LhaArchiveEntry {
  path: string;
  size: number;
  compressedSize: number;
  method: string;
  isDirectory: boolean;
  protection?: number;
  extract: () => Uint8Array;
}

// CRC-16 (IBM/ARC/LHA polynomial 0xA001)
const CRC16_TABLE = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let b = 0; b < 8; b++) {
    c = (c & 1) !== 0 ? (c >>> 1) ^ 0xa001 : c >>> 1;
  }
  CRC16_TABLE[i] = c & 0xffff;
}

export function crc16Lha(data: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    crc = CRC16_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return crc & 0xffff;
}

function readU16LE(b: Uint8Array, off: number): number {
  return b[off] | (b[off + 1] << 8);
}

function readU32LE(b: Uint8Array, off: number): number {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}

function decodeAscii(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i]);
  }
  return s;
}

function decodeAsciiCString(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s;
}

export function isLhaData(bytes: Uint8Array): boolean {
  if (bytes.length < 22) return false;
  // Method ID sits at bytes[2..6] like "-lh5-", "-lh0-", "-lh1-", "-lh4-", "-lh6-", "-lh7-", "-lhd-", "-lz4-"
  return (
    bytes[2] === 0x2d && // '-'
    bytes[3] === 0x6c && // 'l'
    (bytes[4] === 0x68 || bytes[4] === 0x7a) && // 'h' or 'z'
    bytes[6] === 0x2d // '-'
  );
}

function normalizeLhaPath(dir: string, file: string): string {
  // LHA extended headers use 0xFF as path separator on Amiga/DOS
  const cleanDir = dir.replace(/\xff/g, '/').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const cleanFile = file.replace(/\xff/g, '/').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!cleanDir) return cleanFile;
  if (!cleanFile) return cleanDir;
  return `${cleanDir}/${cleanFile}`;
}

const SUPPORTED_LHA_METHODS = new Set([
  '-lh0-',
  '-lz4-',
  '-lhd-',
  '-lh1-',
  '-lh4-',
  '-lh5-',
  '-lh6-',
  '-lh7-',
]);

export function parseLhaArchive(bytes: Uint8Array): LhaArchiveEntry[] {
  const entries: LhaArchiveEntry[] = [];
  let pos = 0;

  while (pos + 21 <= bytes.length) {
    // End of archive marker
    if (bytes[pos] === 0) {
      let onlyPadding = true;
      for (let i = pos; i < Math.min(bytes.length, pos + 64); i++) {
        if (bytes[i] !== 0) {
          onlyPadding = false;
          break;
        }
      }
      if (onlyPadding) break;
    }

    // Level 2 starts with 2-byte total header size; level 0/1 start with 1-byte base header size + checksum
    const method = decodeAscii(bytes.subarray(pos + 2, pos + 7));
    if (!method.startsWith('-l') || !method.endsWith('-') || !SUPPORTED_LHA_METHODS.has(method)) {
      throw new Error(`Неподдерживаемый метод LHA или смещение заголовка (${method}).`);
    }

    const level = bytes[pos + 20];
    let packedSize = 0;
    let origSize = 0;
    let expectedCrc = 0;
    let fileName = '';
    let dirName = '';
    let dataStart = 0;
    let skipSize = 0;
    let protection = 0;

    if (level === 0 || level === 1) {
      protection = bytes[pos + 19] & 0xff;
      const hdrSize = bytes[pos];
      if (hdrSize === 0 || pos + hdrSize + 2 > bytes.length) {
        throw new Error('Повреждённый заголовок LHA.');
      }

      const csum = bytes[pos + 1];
      let sum = 0;
      for (let i = pos + 2; i < pos + hdrSize + 2; i++) {
        sum = (sum + bytes[i]) & 0xff;
      }
      if (sum !== csum) {
        throw new Error('Неверная контрольная сумма заголовка LHA.');
      }

      const sizeField = readU32LE(bytes, pos + 7);
      origSize = readU32LE(bytes, pos + 11);
      const nameLen = bytes[pos + 21];
      const nameStart = pos + 22;
      if (nameStart + nameLen + 2 > bytes.length) {
        throw new Error('Обрезанный заголовок имени файла LHA.');
      }

      fileName = decodeAsciiCString(bytes.subarray(nameStart, nameStart + nameLen));
      expectedCrc = readU16LE(bytes, nameStart + nameLen);

      if (level === 0) {
        packedSize = sizeField;
        dataStart = pos + hdrSize + 2;
        skipSize = packedSize;
      } else {
        // Level 1: next extended header size is at the end of base header (hdrSize + 2 - 2)
        let extPos = pos + hdrSize + 2;
        let extSize = readU16LE(bytes, extPos - 2);
        let totalExtBytes = 0;
        while (extSize > 0 && extPos + extSize <= bytes.length) {
          const extType = bytes[extPos];
          const payload = bytes.subarray(extPos + 1, extPos + extSize - 2);
          if (extType === 0x01) {
            fileName = decodeAsciiCString(payload);
          } else if (extType === 0x02) {
            dirName = decodeAsciiCString(payload);
          }
          totalExtBytes += extSize;
          extPos += extSize;
          extSize = readU16LE(bytes, extPos - 2);
        }
        dataStart = extPos;
        // In Level 1, sizeField includes extended headers!
        packedSize = sizeField >= totalExtBytes ? sizeField - totalExtBytes : sizeField;
        skipSize = packedSize;
      }
    } else if (level === 2) {
      const totalHdrSize = readU16LE(bytes, pos);
      if (totalHdrSize < 26 || pos + totalHdrSize > bytes.length) {
        throw new Error('Повреждённый LHA Level 2 заголовок.');
      }

      protection = bytes[pos + 19] & 0xff;
      packedSize = readU32LE(bytes, pos + 7);
      origSize = readU32LE(bytes, pos + 11);
      expectedCrc = readU16LE(bytes, pos + 21);

      let extPos = pos + 26;
      let extSize = readU16LE(bytes, pos + 24);
      while (extSize > 0 && extPos + extSize - 2 <= pos + totalHdrSize) {
        const extType = bytes[extPos];
        const payload = bytes.subarray(extPos + 1, extPos + extSize - 2);
        if (extType === 0x01) {
          fileName = decodeAsciiCString(payload);
        } else if (extType === 0x02) {
          dirName = decodeAsciiCString(payload);
        } else if (extType === 0x51 && payload.length >= 4) {
          protection = readU32LE(payload, 0);
        }
        extPos += extSize;
        extSize = readU16LE(bytes, extPos - 2);
      }

      dataStart = pos + totalHdrSize;
      skipSize = packedSize;
    } else {
      throw new Error(`Неподдерживаемый уровень заголовка LHA (${level}).`);
    }

    const dataEnd = dataStart + packedSize;
    if (dataEnd > bytes.length) {
      throw new Error('Неожиданный конец LHA-архива.');
    }

    const fullPath = normalizeLhaPath(dirName, fileName);
    const isDirectory = method === '-lhd-' || fullPath.endsWith('/');
    const capStart = dataStart;
    const capEnd = dataEnd;
    const capOrigSize = origSize;
    const capCrc = expectedCrc;
    const capMethod = method;

    if (!isDirectory && fullPath.length > 0) {
      entries.push({
        path: fullPath,
        size: origSize,
        compressedSize: packedSize,
        method,
        isDirectory: false,
        protection,
        extract: () => {
          const out = decompressLhaPayload(bytes, capStart, capEnd, capOrigSize, capMethod);
          if (crc16Lha(out) !== capCrc) {
            throw new Error(`Ошибка CRC16 при распаковке LHA "${fullPath}".`);
          }
          return out;
        },
      });
    }

    pos = dataStart + skipSize;
  }

  return entries;
}

// ==================== LHA Bitstream & Huffman Decoders ====================

class LhaBitReader {
  private pos: number;
  private bitBuf = 0;
  private bitCnt = 0;

  constructor(private readonly src: Uint8Array, start: number, private readonly end: number) {
    this.pos = start;
  }

  private fill(needed: number): void {
    while (this.bitCnt < needed) {
      const b = this.pos < this.end ? this.src[this.pos++] : 0;
      this.bitBuf = ((this.bitBuf << 8) | b) >>> 0;
      this.bitCnt += 8;
    }
  }

  public peekBits(n: number): number {
    if (n === 0) return 0;
    if (this.bitCnt < n) this.fill(n);
    return (this.bitBuf >>> (this.bitCnt - n)) & ((1 << n) - 1);
  }

  public dropBits(n: number): void {
    this.bitCnt -= n;
  }

  public getBits(n: number): number {
    if (n === 0) return 0;
    const v = this.peekBits(n);
    this.bitCnt -= n;
    return v;
  }
}

function makeTable(
  nchar: number,
  bitlen: Uint8Array,
  tableBits: number,
  table: Uint16Array,
  left: Uint16Array,
  right: Uint16Array
): void {
  const count = new Uint16Array(17);
  const weight = new Uint16Array(17);
  const start = new Uint16Array(18);

  for (let i = 0; i < nchar; i++) {
    const l = bitlen[i];
    if (l <= 16) count[l]++;
  }

  start[1] = 0;
  for (let i = 1; i <= 16; i++) {
    start[i + 1] = (start[i] + (count[i] << (16 - i))) & 0xffff;
  }

  const jutbits = 16 - tableBits;
  for (let i = 1; i <= tableBits; i++) {
    start[i] >>>= jutbits;
    weight[i] = 1 << (tableBits - i);
  }
  for (let i = tableBits + 1; i <= 16; i++) {
    weight[i] = 1 << (16 - i);
  }

  let i = start[tableBits + 1] >>> jutbits;
  const tableSize = 1 << tableBits;
  if (i !== 0) {
    while (i < tableSize) {
      table[i++] = 0;
    }
  }

  let avail = nchar;
  const mask = 1 << (15 - tableBits);

  for (let ch = 0; ch < nchar; ch++) {
    const len = bitlen[ch];
    if (len === 0 || len > 16) continue;
    const nextCode = (start[len] + weight[len]) & 0xffff;

    if (len <= tableBits) {
      for (let k = start[len]; k < nextCode; k++) {
        table[k] = ch;
      }
    } else {
      let k = start[len];
      let pArr = table;
      let pIdx = k >>> jutbits;
      let m = mask;
      let rem = len - tableBits;
      while (rem > 0) {
        if (pArr[pIdx] === 0) {
          right[avail] = 0;
          left[avail] = 0;
          pArr[pIdx] = avail++;
        }
        const node = pArr[pIdx];
        if ((k & m) !== 0) {
          pArr = right;
        } else {
          pArr = left;
        }
        pIdx = node;
        k = (k << 1) & 0xffff;
        rem--;
      }
      pArr[pIdx] = ch;
    }
    start[len] = nextCode;
  }
}

const NC = 510;
const NT = 19;
const CBIT = 9;
const TBIT = 5;
const THRESHOLD = 3;

function decodeLhStatic(
  src: Uint8Array,
  start: number,
  end: number,
  origSize: number,
  dicBit: number,
  np: number,
  pbit: number
): Uint8Array {
  const reader = new LhaBitReader(src, start, end);
  const out = new Uint8Array(origSize);
  const dictSize = 1 << dicBit;
  const dictMask = dictSize - 1;
  const dict = new Uint8Array(dictSize);
  dict.fill(0x20); // LHA initializes ring buffer with spaces

  const ptLen = new Uint8Array(Math.max(NT, np) + 2);
  const cLen = new Uint8Array(NC);
  const ptTable = new Uint16Array(256);
  const cTable = new Uint16Array(4096);
  const left = new Uint16Array(2 * NC + 16);
  const right = new Uint16Array(2 * NC + 16);

  const readPtLen = (nn: number, nbit: number, iSpecial: number) => {
    const n = reader.getBits(nbit);
    if (n === 0) {
      const c = reader.getBits(nbit);
      ptLen.fill(0, 0, nn);
      ptTable.fill(c);
      return;
    }
    let i = 0;
    const limit = Math.min(n, nn);
    while (i < limit) {
      let c = reader.getBits(3);
      if (c === 7) {
        while (reader.getBits(1) === 1) c++;
      }
      ptLen[i++] = c;
      if (i === iSpecial) {
        let zeros = reader.getBits(2);
        while (--zeros >= 0 && i < nn) {
          ptLen[i++] = 0;
        }
      }
    }
    while (i < nn) ptLen[i++] = 0;
    makeTable(nn, ptLen, 8, ptTable, left, right);
  };

  const readCLen = () => {
    const n = reader.getBits(CBIT);
    if (n === 0) {
      const c = reader.getBits(CBIT);
      cLen.fill(0, 0, NC);
      cTable.fill(c);
      return;
    }
    let i = 0;
    const limit = Math.min(n, NC);
    while (i < limit) {
      let c = ptTable[reader.peekBits(8)];
      if (c >= NT) {
        const b16 = reader.peekBits(16);
        let mask = 1 << 7;
        do {
          c = (b16 & mask) !== 0 ? right[c] : left[c];
          mask >>>= 1;
        } while (c >= NT && mask !== 0);
      }
      reader.dropBits(ptLen[c]);

      if (c <= 2) {
        let z = 1;
        if (c === 1) z = reader.getBits(4) + 3;
        else if (c === 2) z = reader.getBits(CBIT) + 20;
        while (--z >= 0 && i < NC) {
          cLen[i++] = 0;
        }
      } else {
        cLen[i++] = c - 2;
      }
    }
    while (i < NC) cLen[i++] = 0;
    makeTable(NC, cLen, 12, cTable, left, right);
  };

  const decodeC = (): number => {
    let j = cTable[reader.peekBits(12)];
    if (j >= NC) {
      const b16 = reader.peekBits(16);
      let mask = 1 << 3;
      do {
        j = (b16 & mask) !== 0 ? right[j] : left[j];
        mask >>>= 1;
      } while (j >= NC && mask !== 0);
    }
    reader.dropBits(cLen[j]);
    return j;
  };

  const decodeP = (): number => {
    let j = ptTable[reader.peekBits(8)];
    if (j >= np) {
      const b16 = reader.peekBits(16);
      let mask = 1 << 7;
      do {
        j = (b16 & mask) !== 0 ? right[j] : left[j];
        mask >>>= 1;
      } while (j >= np && mask !== 0);
    }
    reader.dropBits(ptLen[j]);
    if (j !== 0) {
      j = (1 << (j - 1)) + reader.getBits(j - 1);
    }
    return j;
  };

  let outPos = 0;
  let dictPos = 0;
  let blockSize = 0;

  while (outPos < origSize) {
    if (blockSize === 0) {
      blockSize = reader.getBits(16);
      readPtLen(NT, TBIT, 3);
      readCLen();
      readPtLen(np, pbit, -1);
    }
    blockSize--;

    const c = decodeC();
    if (c < 256) {
      out[outPos++] = c;
      dict[dictPos] = c;
      dictPos = (dictPos + 1) & dictMask;
    } else {
      const len = c - 256 + THRESHOLD;
      const dist = decodeP();
      let srcIdx = (dictPos - dist - 1) & dictMask;
      for (let k = 0; k < len && outPos < origSize; k++) {
        const b = dict[srcIdx];
        srcIdx = (srcIdx + 1) & dictMask;
        out[outPos++] = b;
        dict[dictPos] = b;
        dictPos = (dictPos + 1) & dictMask;
      }
    }
  }

  return out;
}

// ==================== -lh1- Adaptive Huffman Decoder ====================

const LH1_N_CHAR = 256 + 60 - THRESHOLD + 1; // 314
const LH1_T = LH1_N_CHAR * 2 - 1; // 627
const LH1_R = LH1_T - 1; // 626
const LH1_MAX_FREQ = 0x8000;

const LH1_P_LEN = new Uint8Array([
  0x03, 0x04, 0x04, 0x04, 0x05, 0x05, 0x05, 0x05,
  0x05, 0x05, 0x05, 0x05, 0x06, 0x06, 0x06, 0x06,
  0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06,
  0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07,
  0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07,
  0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07,
  0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08,
  0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08,
]);

const LH1_P_CODE = new Uint8Array([
  0x00, 0x20, 0x30, 0x40, 0x50, 0x58, 0x60, 0x68,
  0x70, 0x78, 0x80, 0x88, 0x90, 0x94, 0x98, 0x9c,
  0xa0, 0xa4, 0xa8, 0xac, 0xb0, 0xb4, 0xb8, 0xbc,
  0xc0, 0xc2, 0xc4, 0xc6, 0xc8, 0xca, 0xcc, 0xce,
  0xd0, 0xd2, 0xd4, 0xd6, 0xd8, 0xda, 0xdc, 0xde,
  0xe0, 0xe2, 0xe4, 0xe6, 0xe8, 0xea, 0xec, 0xee,
  0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7,
  0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff,
]);

const LH1_D_CODE = new Uint8Array(256);
const LH1_D_LEN = new Uint8Array(256);
for (let code = 0, i = 0; code < 64; code++) {
  const span = 1 << (8 - LH1_P_LEN[code]);
  for (let k = 0; k < span; k++) {
    LH1_D_CODE[LH1_P_CODE[code] + k] = code;
    LH1_D_LEN[LH1_P_CODE[code] + k] = LH1_P_LEN[code];
  }
  i += span;
  void i;
}

function decodeLh1(src: Uint8Array, start: number, end: number, origSize: number): Uint8Array {
  const reader = new LhaBitReader(src, start, end);
  const out = new Uint8Array(origSize);
  const dict = new Uint8Array(4096);
  dict.fill(0x20);

  const freq = new Uint16Array(LH1_T + 1);
  const prnt = new Uint16Array(LH1_T + LH1_N_CHAR);
  const son = new Uint16Array(LH1_T);

  for (let i = 0; i < LH1_N_CHAR; i++) {
    freq[i] = 1;
    son[i] = i + LH1_T;
    prnt[i + LH1_T] = i;
  }
  let i = 0;
  let j = LH1_N_CHAR;
  while (j <= LH1_R) {
    freq[j] = freq[i] + freq[i + 1];
    son[j] = i;
    prnt[i] = j;
    prnt[i + 1] = j;
    i += 2;
    j++;
  }
  freq[LH1_T] = 0xffff;
  prnt[LH1_R] = 0;

  const reconst = () => {
    let k = 0;
    for (let idx = 0; idx < LH1_T; idx++) {
      if (son[idx] >= LH1_T) {
        freq[k] = (freq[idx] + 1) >>> 1;
        son[k] = son[idx];
        k++;
      }
    }
    for (let idx = 0, jj = LH1_N_CHAR; jj < LH1_T; idx += 2, jj++) {
      const f = (freq[jj] = freq[idx] + freq[idx + 1]);
      let kk = jj - 1;
      while (f < freq[kk]) kk--;
      kk++;
      const moveLen = jj - kk;
      for (let m = moveLen - 1; m >= 0; m--) {
        freq[kk + m + 1] = freq[kk + m];
        son[kk + m + 1] = son[kk + m];
      }
      freq[kk] = f;
      son[kk] = idx;
    }
    for (let idx = 0; idx < LH1_T; idx++) {
      const s = son[idx];
      if (s >= LH1_T) {
        prnt[s] = idx;
      } else {
        prnt[s] = idx;
        prnt[s + 1] = idx;
      }
    }
  };

  const update = (c: number) => {
    if (freq[LH1_R] === LH1_MAX_FREQ) reconst();
    let node = prnt[c + LH1_T];
    do {
      const k = ++freq[node];
      let l = node + 1;
      if (k > freq[l]) {
        while (k > freq[++l]);
        l--;
        freq[node] = freq[l];
        freq[l] = k;

        const u = son[node];
        prnt[u] = l;
        if (u < LH1_T) prnt[u + 1] = l;

        const v = son[l];
        son[l] = u;
        prnt[v] = node;
        if (v < LH1_T) prnt[v + 1] = node;
        son[node] = v;
        node = l;
      }
      node = prnt[node];
    } while (node !== 0);
  };

  let outPos = 0;
  let dictPos = 0;

  while (outPos < origSize) {
    let c = son[LH1_R];
    while (c < LH1_T) {
      c += reader.getBits(1);
      c = son[c];
    }
    c -= LH1_T;
    update(c);

    if (c < 256) {
      out[outPos++] = c;
      dict[dictPos] = c;
      dictPos = (dictPos + 1) & 4095;
    } else {
      const len = c - 256 + THRESHOLD;
      const idx = reader.peekBits(8);
      reader.dropBits(LH1_D_LEN[idx]);
      const distHi = LH1_D_CODE[idx] << 6;
      const distLo = reader.getBits(6);
      const dist = distHi | distLo;

      let srcIdx = (dictPos - dist - 1) & 4095;
      for (let k = 0; k < len && outPos < origSize; k++) {
        const b = dict[srcIdx];
        srcIdx = (srcIdx + 1) & 4095;
        out[outPos++] = b;
        dict[dictPos] = b;
        dictPos = (dictPos + 1) & 4095;
      }
    }
  }

  return out;
}

function decompressLhaPayload(
  src: Uint8Array,
  start: number,
  end: number,
  origSize: number,
  method: string
): Uint8Array {
  switch (method) {
    case '-lh0-':
    case '-lz4-': {
      const out = new Uint8Array(origSize);
      out.set(src.subarray(start, Math.min(end, start + origSize)));
      return out;
    }
    case '-lh1-':
      return decodeLh1(src, start, end, origSize);
    case '-lh4-':
      return decodeLhStatic(src, start, end, origSize, 12, 14, 4);
    case '-lh5-':
      return decodeLhStatic(src, start, end, origSize, 13, 14, 4);
    case '-lh6-':
      return decodeLhStatic(src, start, end, origSize, 15, 16, 5);
    case '-lh7-':
      return decodeLhStatic(src, start, end, origSize, 16, 17, 5);
    default:
      throw new Error(`Неподдерживаемый метод сжатия LHA: ${method}`);
  }
}

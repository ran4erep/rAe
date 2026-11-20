/**
 * High-performance zero-dependency RFC 1951 Inflate, GZIP (.adz / .adf.gz / .gz),
 * and ZIP (.zip) archive parser/decompressor.
 * Uses flat TypedArrays for Huffman tables to minimize CPU & GC overhead.
 */

// Precomputed CRC-32 table (IEEE 802.3)
const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE[i] = c >>> 0;
}

export function crc32(data: Uint8Array, start = 0, end = data.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) {
    c = CRC32_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// Inflate length & distance base/extra bit tables
const LEN_BASE = new Uint16Array([
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
]);
const LEN_EXTRA = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
]);
const DIST_BASE = new Uint16Array([
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
]);
const DIST_EXTRA = new Uint8Array([
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
]);
const CL_ORDER = new Uint8Array([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);

const MAX_BITS = 15;

interface HuffTree {
  counts: Int32Array;
  symbols: Uint16Array;
  maxBits: number;
}

function buildHuffTree(lengths: Uint8Array, offset: number, count: number): HuffTree {
  const counts = new Int32Array(MAX_BITS + 1);
  let maxBits = 0;
  for (let i = 0; i < count; i++) {
    const l = lengths[offset + i];
    if (l > 0) {
      counts[l]++;
      if (l > maxBits) maxBits = l;
    }
  }
  const offs = new Int32Array(MAX_BITS + 1);
  let sum = 0;
  for (let b = 1; b <= MAX_BITS; b++) {
    offs[b] = sum;
    sum += counts[b];
  }
  const symbols = new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    const l = lengths[offset + i];
    if (l > 0) {
      symbols[offs[l]++] = i;
    }
  }
  return { counts, symbols, maxBits };
}

// Precompute fixed Huffman trees once
const FIXED_LIT_LENGTHS = new Uint8Array(288);
FIXED_LIT_LENGTHS.fill(8, 0, 144);
FIXED_LIT_LENGTHS.fill(9, 144, 256);
FIXED_LIT_LENGTHS.fill(7, 256, 280);
FIXED_LIT_LENGTHS.fill(8, 280, 288);
const FIXED_LIT_TREE = buildHuffTree(FIXED_LIT_LENGTHS, 0, 288);

const FIXED_DIST_LENGTHS = new Uint8Array(32);
FIXED_DIST_LENGTHS.fill(5);
const FIXED_DIST_TREE = buildHuffTree(FIXED_DIST_LENGTHS, 0, 32);

class BitReader {
  private pos: number;
  private bitBuf = 0;
  private bitCnt = 0;

  constructor(private readonly src: Uint8Array, startOffset: number, private readonly endOffset: number) {
    this.pos = startOffset;
  }

  public readBits(n: number): number {
    while (this.bitCnt < n) {
      if (this.pos >= this.endOffset) {
        throw new Error('Unexpected end of deflate stream');
      }
      this.bitBuf |= this.src[this.pos++] << this.bitCnt;
      this.bitCnt += 8;
    }
    const val = this.bitBuf & ((1 << n) - 1);
    this.bitBuf >>>= n;
    this.bitCnt -= n;
    return val;
  }

  public alignToByte(): void {
    const skip = this.bitCnt & 7;
    if (skip > 0) {
      this.bitBuf >>>= skip;
      this.bitCnt -= skip;
    }
  }

  public readBytesUnaligned(count: number): Uint8Array {
    this.alignToByte();
    // Rewind any whole buffered bytes back into pos
    const wholeBytes = this.bitCnt >>> 3;
    this.pos -= wholeBytes;
    this.bitBuf = 0;
    this.bitCnt = 0;
    if (this.pos + count > this.endOffset) {
      throw new Error('Unexpected end of stored deflate block');
    }
    const slice = this.src.subarray(this.pos, this.pos + count);
    this.pos += count;
    return slice;
  }

  public readU16Aligned(): number {
    this.alignToByte();
    const wholeBytes = this.bitCnt >>> 3;
    this.pos -= wholeBytes;
    this.bitBuf = 0;
    this.bitCnt = 0;
    if (this.pos + 2 > this.endOffset) {
      throw new Error('Unexpected end of deflate stream');
    }
    const val = this.src[this.pos] | (this.src[this.pos + 1] << 8);
    this.pos += 2;
    return val;
  }

  public decodeSymbol(tree: HuffTree): number {
    let code = 0;
    let first = 0;
    let index = 0;
    const counts = tree.counts;
    for (let len = 1; len <= tree.maxBits; len++) {
      if (this.bitCnt === 0) {
        if (this.pos >= this.endOffset) {
          throw new Error('Unexpected end of Huffman stream');
        }
        this.bitBuf = this.src[this.pos++];
        this.bitCnt = 8;
      }
      code |= this.bitBuf & 1;
      this.bitBuf >>>= 1;
      this.bitCnt--;

      const c = counts[len];
      if (code - c < first) {
        return tree.symbols[index + (code - first)];
      }
      index += c;
      first = (first + c) << 1;
      code <<= 1;
    }
    throw new Error('Invalid Huffman symbol in deflate stream');
  }

  public getBytePosition(): number {
    return this.pos - (this.bitCnt >>> 3);
  }
}

export function inflateRaw(
  src: Uint8Array,
  startOffset = 0,
  endOffset = src.length,
  expectedSizeHint = 0
): Uint8Array {
  const reader = new BitReader(src, startOffset, endOffset);
  let out = new Uint8Array(expectedSizeHint > 0 ? expectedSizeHint : Math.max(4096, (endOffset - startOffset) * 3));
  let outPos = 0;

  const ensureCapacity = (needed: number) => {
    if (outPos + needed <= out.length) return;
    let nextLen = out.length * 2;
    while (nextLen < outPos + needed) nextLen *= 2;
    const next = new Uint8Array(nextLen);
    next.set(out.subarray(0, outPos));
    out = next;
  };

  let bfinal = 0;
  const codeLengths = new Uint8Array(320);

  do {
    bfinal = reader.readBits(1);
    const btype = reader.readBits(2);

    if (btype === 0) {
      const len = reader.readU16Aligned();
      const nlen = reader.readU16Aligned();
      if ((len ^ 0xffff) !== nlen) {
        throw new Error('Corrupt stored deflate block length');
      }
      const raw = reader.readBytesUnaligned(len);
      ensureCapacity(len);
      out.set(raw, outPos);
      outPos += len;
    } else if (btype === 1 || btype === 2) {
      let litTree: HuffTree;
      let distTree: HuffTree;

      if (btype === 1) {
        litTree = FIXED_LIT_TREE;
        distTree = FIXED_DIST_TREE;
      } else {
        const hlit = reader.readBits(5) + 257;
        const hdist = reader.readBits(5) + 1;
        const hclen = reader.readBits(4) + 4;
        const clLengths = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) {
          clLengths[CL_ORDER[i]] = reader.readBits(3);
        }
        const clTree = buildHuffTree(clLengths, 0, 19);

        const totalCodes = hlit + hdist;
        codeLengths.fill(0, 0, totalCodes);
        let idx = 0;
        while (idx < totalCodes) {
          const sym = reader.decodeSymbol(clTree);
          if (sym < 16) {
            codeLengths[idx++] = sym;
          } else {
            let repeat = 0;
            let val = 0;
            if (sym === 16) {
              if (idx === 0) throw new Error('Invalid deflate repeat code');
              val = codeLengths[idx - 1];
              repeat = 3 + reader.readBits(2);
            } else if (sym === 17) {
              repeat = 3 + reader.readBits(3);
            } else {
              repeat = 11 + reader.readBits(7);
            }
            while (repeat-- > 0 && idx < totalCodes) {
              codeLengths[idx++] = val;
            }
          }
        }
        litTree = buildHuffTree(codeLengths, 0, hlit);
        distTree = buildHuffTree(codeLengths, hlit, hdist);
      }

      while (true) {
        const sym = reader.decodeSymbol(litTree);
        if (sym < 256) {
          ensureCapacity(1);
          out[outPos++] = sym;
        } else if (sym === 256) {
          break;
        } else {
          const lenIdx = sym - 257;
          if (lenIdx >= LEN_BASE.length) {
            throw new Error('Invalid deflate length symbol');
          }
          const length = LEN_BASE[lenIdx] + (LEN_EXTRA[lenIdx] > 0 ? reader.readBits(LEN_EXTRA[lenIdx]) : 0);
          const distSym = reader.decodeSymbol(distTree);
          if (distSym >= DIST_BASE.length) {
            throw new Error('Invalid deflate distance symbol');
          }
          const dist = DIST_BASE[distSym] + (DIST_EXTRA[distSym] > 0 ? reader.readBits(DIST_EXTRA[distSym]) : 0);
          if (dist > outPos) {
            throw new Error('Invalid deflate back-reference distance');
          }
          ensureCapacity(length);
          if (dist === 1) {
            out.fill(out[outPos - 1], outPos, outPos + length);
            outPos += length;
          } else if (dist >= length) {
            out.copyWithin(outPos, outPos - dist, outPos - dist + length);
            outPos += length;
          } else {
            for (let k = 0; k < length; k++) {
              out[outPos] = out[outPos - dist];
              outPos++;
            }
          }
        }
      }
    } else {
      throw new Error('Unsupported deflate block type 3');
    }
  } while (bfinal === 0);

  return outPos === out.length ? out : out.subarray(0, outPos);
}

// ==================== GZIP / ADZ ====================

export function isGzipData(bytes: Uint8Array): boolean {
  return bytes.length >= 18 && bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 8;
}

export function decompressGzip(bytes: Uint8Array): { data: Uint8Array; originalName: string | null } {
  if (!isGzipData(bytes)) {
    throw new Error('Файл не является корректным GZIP / ADZ потоком.');
  }
  const flg = bytes[3];
  let pos = 10;

  if ((flg & 0x04) !== 0) {
    if (pos + 2 > bytes.length) throw new Error('Повреждённый GZIP заголовок (FEXTRA).');
    const xlen = bytes[pos] | (bytes[pos + 1] << 8);
    pos += 2 + xlen;
  }

  let originalName: string | null = null;
  if ((flg & 0x08) !== 0) {
    const start = pos;
    while (pos < bytes.length && bytes[pos] !== 0) pos++;
    if (pos >= bytes.length) throw new Error('Повреждённый GZIP заголовок (FNAME).');
    originalName = decodeLatin1(bytes.subarray(start, pos));
    pos++;
  }

  if ((flg & 0x10) !== 0) {
    while (pos < bytes.length && bytes[pos] !== 0) pos++;
    pos++;
  }

  if ((flg & 0x02) !== 0) {
    pos += 2; // FHCRC
  }

  if (pos + 8 > bytes.length) {
    throw new Error('Повреждённый GZIP файл.');
  }

  const trailerOff = bytes.length - 8;
  const expectedCrc =
    (bytes[trailerOff] |
      (bytes[trailerOff + 1] << 8) |
      (bytes[trailerOff + 2] << 16) |
      (bytes[trailerOff + 3] << 24)) >>>
    0;
  const expectedSize =
    (bytes[trailerOff + 4] |
      (bytes[trailerOff + 5] << 8) |
      (bytes[trailerOff + 6] << 16) |
      (bytes[trailerOff + 7] << 24)) >>>
    0;

  const data = inflateRaw(bytes, pos, trailerOff, expectedSize > 0 && expectedSize < 64 * 1024 * 1024 ? expectedSize : 901120);
  const actualCrc = crc32(data);
  if (actualCrc !== expectedCrc) {
    throw new Error('Ошибка контрольной суммы CRC32 при распаковке ADZ/GZIP.');
  }
  return { data, originalName };
}

// ==================== ZIP ====================

export interface ZipArchiveEntry {
  path: string;
  size: number;
  compressedSize: number;
  method: number;
  isDirectory: boolean;
  extract: () => Uint8Array;
}

export function isZipData(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 22 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05) &&
    (bytes[3] === 0x04 || bytes[3] === 0x06)
  );
}

function readU16LE(b: Uint8Array, off: number): number {
  return b[off] | (b[off + 1] << 8);
}

function readU32LE(b: Uint8Array, off: number): number {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}

function decodeLatin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

function decodeZipName(bytes: Uint8Array, utf8Flag: boolean): string {
  if (utf8Flag && typeof TextDecoder !== 'undefined') {
    try {
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch {
      // fallback below
    }
  }
  return decodeLatin1(bytes);
}

export function parseZipArchive(bytes: Uint8Array): ZipArchiveEntry[] {
  const entries: ZipArchiveEntry[] = [];
  // Locate End of Central Directory (PK\x05\x06) scanning backwards up to 64KB + 22
  const minOff = Math.max(0, bytes.length - 65558);
  let eocdOff = -1;
  for (let i = bytes.length - 22; i >= minOff; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      eocdOff = i;
      break;
    }
  }

  if (eocdOff >= 0) {
    const totalCdEntries = readU16LE(bytes, eocdOff + 10);
    const cdSize = readU32LE(bytes, eocdOff + 12);
    const cdOffset = readU32LE(bytes, eocdOff + 16);
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff || totalCdEntries === 0xffff) {
      throw new Error('ZIP64 архив требует распаковки через 7z-wasm.');
    }
    let pos = cdOffset;
    let seenCount = 0;
    const cdEnd = Math.min(bytes.length, cdOffset + cdSize);

    while (pos + 46 <= cdEnd) {
      if (readU32LE(bytes, pos) !== 0x02014b50) break;
      seenCount++;
      const flags = readU16LE(bytes, pos + 8);
      const method = readU16LE(bytes, pos + 10);
      if (method !== 0 && method !== 8) {
        throw new Error(`Неподдерживаемый метод сжатия ZIP (${method}).`);
      }
      if ((flags & 1) !== 0) {
        throw new Error('Зашифрованный ZIP-архив.');
      }
      const expectedCrc = readU32LE(bytes, pos + 16);
      const compSize = readU32LE(bytes, pos + 20);
      const uncompSize = readU32LE(bytes, pos + 24);
      const nameLen = readU16LE(bytes, pos + 28);
      const extraLen = readU16LE(bytes, pos + 30);
      const commentLen = readU16LE(bytes, pos + 32);
      const localHdrOff = readU32LE(bytes, pos + 42);

      const nameBytes = bytes.subarray(pos + 46, pos + 46 + nameLen);
      const rawPath = decodeZipName(nameBytes, (flags & 0x0800) !== 0).replace(/\\/g, '/');
      const isDirectory = rawPath.endsWith('/');

      pos += 46 + nameLen + extraLen + commentLen;

      if (isDirectory) continue;

      entries.push({
        path: rawPath,
        size: uncompSize,
        compressedSize: compSize,
        method,
        isDirectory: false,
        extract: () => {
          if (flags & 1) {
            throw new Error(`Файл "${rawPath}" зашифрован паролем.`);
          }
          if (localHdrOff + 30 > bytes.length || readU32LE(bytes, localHdrOff) !== 0x04034b50) {
            throw new Error(`Повреждённый локальный заголовок ZIP для "${rawPath}".`);
          }
          const lNameLen = readU16LE(bytes, localHdrOff + 26);
          const lExtraLen = readU16LE(bytes, localHdrOff + 28);
          const dataStart = localHdrOff + 30 + lNameLen + lExtraLen;
          const dataEnd = dataStart + compSize;
          if (dataEnd > bytes.length) {
            throw new Error(`Неожиданный конец ZIP-архива для "${rawPath}".`);
          }

          let out: Uint8Array;
          if (method === 0) {
            out = new Uint8Array(bytes.subarray(dataStart, dataEnd));
          } else if (method === 8) {
            out = inflateRaw(bytes, dataStart, dataEnd, uncompSize);
          } else {
            throw new Error(`Неподдерживаемый метод сжатия ZIP (${method}) для "${rawPath}".`);
          }
          if (crc32(out) !== expectedCrc) {
            throw new Error(`Ошибка CRC32 при распаковке "${rawPath}".`);
          }
          return out;
        },
      });
    }
    if (entries.length > 0 && seenCount >= totalCdEntries) return entries;
    if (seenCount < totalCdEntries) {
      throw new Error('Неполный Central Directory ZIP.');
    }
  }

  // Fallback: walk Local File Headers sequentially
  let pos = 0;
  while (pos + 30 <= bytes.length) {
    if (readU32LE(bytes, pos) !== 0x04034b50) break;
    const flags = readU16LE(bytes, pos + 6);
    const method = readU16LE(bytes, pos + 8);
    const expectedCrc = readU32LE(bytes, pos + 14);
    const compSize = readU32LE(bytes, pos + 18);
    const uncompSize = readU32LE(bytes, pos + 22);
    const nameLen = readU16LE(bytes, pos + 26);
    const extraLen = readU16LE(bytes, pos + 28);
    const rawPath = decodeZipName(bytes.subarray(pos + 30, pos + 30 + nameLen), (flags & 0x0800) !== 0).replace(/\\/g, '/');
    const dataStart = pos + 30 + nameLen + extraLen;
    const dataEnd = dataStart + compSize;
    pos = dataEnd;

    if (!rawPath.endsWith('/')) {
      entries.push({
        path: rawPath,
        size: uncompSize,
        compressedSize: compSize,
        method,
        isDirectory: false,
        extract: () => {
          if (flags & 1) throw new Error(`Файл "${rawPath}" зашифрован паролем.`);
          let out: Uint8Array;
          if (method === 0) out = new Uint8Array(bytes.subarray(dataStart, dataEnd));
          else if (method === 8) out = inflateRaw(bytes, dataStart, dataEnd, uncompSize);
          else throw new Error(`Неподдерживаемый метод ZIP (${method}).`);
          if (expectedCrc !== 0 && crc32(out) !== expectedCrc) {
            throw new Error(`Ошибка CRC32 для "${rawPath}".`);
          }
          return out;
        },
      });
    }
  }
  return entries;
}

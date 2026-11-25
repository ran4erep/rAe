/**
 * Unified Archive & Media Resolver for Amiga 500 Emulator.
 * Handles:
 * - Raw .ADF floppy images (880 KB DD / up to 1.76 MB)
 * - Compressed .ADZ / .ADF.GZ / .GZ images (GZIP)
 * - .LHA / .LZH archives (containing .adf/.adz/.hdf/.rom OR AmigaDOS files/folders)
 * - .ZIP archives (Store/Deflate fast path + 7z-wasm fallback for LZMA/BZip2/Deflate64)
 * - .7Z, .RAR (RAR4 & RAR5), .TAR, .TAR.GZ/.TGZ, .BZ2, .XZ, .CAB, .ARJ, .ISO via lazy 7z-wasm
 * - .HDF hard disk images (Partition HDF or RDB RDSK hardfile)
 * - .ROM / Kickstart binaries (256 KB / 512 KB)
 */

import { ADF_TOTAL_SIZE } from '../hardware/floppy';
import {
  createPopulatedBootableAdf,
  createPopulatedHdf,
  VirtualAmigaFile,
} from './amigaDosFs';
import { decompressGzip, isGzipData, isZipData, parseZipArchive, ZipArchiveEntry } from './deflate';
import { isLhaData, LhaArchiveEntry, parseLhaArchive } from './lha';
import {
  detectUniversalArchiveFormat,
  extractWithSevenZip,
  UniversalArchiveEntry,
} from './universalArchive';

export type ArchiveImageKind = 'adf' | 'hdf' | 'rom';

export interface ArchiveMediaCandidate {
  id: string;
  name: string;
  path: string;
  size: number;
  kind: ArchiveImageKind;
  diskNumber?: number | null;
  diskTotal?: number | null;
  isBadDump?: boolean;
  isVerified?: boolean;
  isClean?: boolean;
  crackTag?: string | null;
  prereleaseKind?: 'alpha' | 'beta' | 'proto' | 'demo' | null;
  variantTags?: string[];
  extractBytes: () => Uint8Array;
  extractBytesAsync?: () => Promise<Uint8Array>;
}

export interface ArchiveFileEntry {
  id: string;
  name: string;
  path: string;
  size: number;
  kind: ArchiveImageKind | 'file';
  diskNumber?: number | null;
  diskTotal?: number | null;
  isClean?: boolean;
  crackTag?: string | null;
  prereleaseKind?: 'alpha' | 'beta' | 'proto' | 'demo' | null;
  variantTags?: string[];
  protection?: number;
  extractBytes: () => Uint8Array;
}

export type ResolvedUploadResult =
  | { kind: 'adf'; name: string; bytes: Uint8Array }
  | { kind: 'hdf'; name: string; bytes: Uint8Array }
  | { kind: 'rom'; name: string; bytes: Uint8Array }
  | {
      kind: 'archive-choices';
      archiveName: string;
      archiveFormat: string;
      volumeName: string;
      totalBytes: number;
      mediaItems: ArchiveMediaCandidate[];
      allFiles: ArchiveFileEntry[];
      otherFileCount: number;
      fitsFloppy: boolean;
      extractAllAsFiles: () => VirtualAmigaFile[];
      buildAdf: () => Uint8Array;
      buildHdf: (targetSizeMB?: number) => Uint8Array;
    }
  | {
      kind: 'archive-files';
      archiveName: string;
      archiveFormat: string;
      volumeName: string;
      fileCount: number;
      totalBytes: number;
      allFiles: ArchiveFileEntry[];
      fitsFloppy: boolean;
      buildAdf: () => Uint8Array;
      buildHdf: (targetSizeMB?: number) => Uint8Array;
    };

function getExtLower(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.adf.gz')) return '.adf.gz';
  if (lower.endsWith('.tar.gz')) return '.tar.gz';
  if (lower.endsWith('.tar.bz2')) return '.tar.bz2';
  if (lower.endsWith('.tar.xz')) return '.tar.xz';
  const dot = lower.lastIndexOf('.');
  return dot >= 0 ? lower.slice(dot) : '';
}

function baseNameOf(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return slash >= 0 ? path.slice(slash + 1) : path;
}

function stripArchiveExtension(name: string): string {
  return (
    name.replace(/\.(7z|rar|tar\.gz|tar\.bz2|tar\.xz|tgz|tbz2|tbz|txz|tar|bz2|xz|cab|arj|iso|lha|lzh|zip|zipx|adz|adf\.gz|gz)$/i, '') ||
    'ArchiveHD'
  );
}

function looksLikeKickstartHeader(bytes?: Uint8Array): boolean {
  if (!bytes || bytes.length < 4) return false;
  // Standard Commodore Kickstart ROMs begin with $1111 (256KB) or $1114 / $1116 (512KB) JMP reset
  return bytes[0] === 0x11 && (bytes[1] === 0x11 || bytes[1] === 0x14 || bytes[1] === 0x16);
}

function classifyMediaByNameAndSize(name: string, size: number, bytes?: Uint8Array): ArchiveImageKind | null {
  const ext = getExtLower(name);
  if (ext === '.adf' || ext === '.adz' || ext === '.adf.gz') return 'adf';
  if (ext === '.hdf' || ext === '.vhd') return 'hdf';
  if (ext === '.rom' || ext === '.kick') return 'rom';
  if ((size === 262144 || size === 524288) && (ext === '.bin' || ext === '.a500' || ext === '.a1200' || looksLikeKickstartHeader(bytes) || /kick|rom/i.test(name))) {
    return 'rom';
  }
  return null;
}

function isMacOrJunkFile(path: string): boolean {
  const lower = path.toLowerCase();
  const base = baseNameOf(lower);
  return lower.startsWith('__macosx/') || base === '.ds_store' || base === 'thumbs.db';
}

function extractArchiveEntryBytes(
  name: string,
  rawExtract: () => Uint8Array
): { name: string; bytes: Uint8Array; kind: ArchiveImageKind } {
  const bytes = rawExtract();
  const ext = getExtLower(name);
  if (ext === '.adz' || ext === '.adf.gz' || (ext === '.gz' && isGzipData(bytes))) {
    const { data, originalName } = decompressGzip(bytes);
    const innerName = originalName || name.replace(/\.adz$/i, '.adf').replace(/\.gz$/i, '');
    const kind = classifyMediaByNameAndSize(innerName, data.length, data) ?? 'adf';
    return { name: baseNameOf(innerName), bytes: data, kind };
  }
  const kind = classifyMediaByNameAndSize(name, bytes.length, bytes) ?? 'adf';
  return { name: baseNameOf(name), bytes, kind };
}

type AnyArchiveEntry = ZipArchiveEntry | LhaArchiveEntry | UniversalArchiveEntry;

function estimateBlocksFromSizes(items: Array<{ path: string; size: number }>): number {
  let blocks = 16;
  const dirs = new Set<string>();
  for (const item of items) {
    const parts = item.path.replace(/\\/g, '/').split('/').filter(Boolean);
    for (let i = 0; i < parts.length - 1; i++) {
      dirs.add(parts.slice(0, i + 1).join('/').toLowerCase());
    }
    const dataBlocks = Math.ceil(item.size / 488);
    const extBlocks = dataBlocks > 72 ? Math.ceil((dataBlocks - 72) / 72) : 0;
    blocks += 1 + dataBlocks + extBlocks;
  }
  return blocks + dirs.size;
}

function resolveContainerEntries(
  archiveName: string,
  archiveFormat: string,
  rawEntries: AnyArchiveEntry[]
): ResolvedUploadResult {
  const rawFiltered = rawEntries.filter((e) => !e.isDirectory && !isMacOrJunkFile(e.path));
  if (rawFiltered.length === 0) {
    throw new Error(`Архив "${archiveName}" пуст.`);
  }
  // Deduplicate identical paths (preserving distinct case/paths cleanly)
  const dedupMap = new Map<string, AnyArchiveEntry>();
  for (const e of rawFiltered) {
    const key = e.path.replace(/\\/g, '/').replace(/^\/+/, '');
    dedupMap.set(key, e);
  }
  const entries = Array.from(dedupMap.values());

  const mediaItems: ArchiveMediaCandidate[] = [];
  const allFiles: ArchiveFileEntry[] = [];
  let otherFileCount = 0;
  let totalBytes = 0;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const normPath = e.path.replace(/\\/g, '/').replace(/^\/+/, '');
    const bName = baseNameOf(normPath);
    let kind = classifyMediaByNameAndSize(bName, e.size);
    // For exact Kickstart sizes (256KB/512KB) inside an archive (e.g. "kick34005.A500"),
    // peek header bytes if name alone didn't classify yet.
    let cachedBytes: Uint8Array | null = null;
    if (!kind && (e.size === 262144 || e.size === 524288)) {
      try {
        cachedBytes = e.extract();
        kind = classifyMediaByNameAndSize(bName, e.size, cachedBytes);
      } catch {
        // Ignore peek failure
      }
    }

    const extractRaw = () => cachedBytes ?? e.extract();
    totalBytes += e.size;

    const protection = 'protection' in e ? e.protection : undefined;

    if (kind) {
      const candidate: ArchiveMediaCandidate = {
        id: `${i}_${normPath}`,
        name: bName,
        path: normPath,
        size: e.size,
        kind,
        extractBytes: () => extractArchiveEntryBytes(bName, extractRaw).bytes,
      };
      mediaItems.push(candidate);
      allFiles.push({
        id: candidate.id,
        name: bName,
        path: normPath,
        size: e.size,
        kind,
        protection,
        extractBytes: candidate.extractBytes,
      });
    } else {
      otherFileCount++;
      allFiles.push({
        id: `${i}_${normPath}`,
        name: bName,
        path: normPath,
        size: e.size,
        kind: 'file',
        protection,
        extractBytes: extractRaw,
      });
    }
  }

  // Sort media items naturally so Disk 1 / Disk A comes before Disk 2 / Disk B
  mediaItems.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

  // Preserve explicit empty directories (e.g. WHDLoad Save/ or Data/ folders)
  const dirCandidates = new Set<string>();
  const nonEmptyPrefixes = new Set<string>();
  for (const e of entries) {
    const parts = e.path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    for (let k = 1; k < parts.length; k++) {
      nonEmptyPrefixes.add(parts.slice(0, k).join('/').toLowerCase());
    }
  }
  for (const e of rawEntries) {
    if (!e.isDirectory || isMacOrJunkFile(e.path)) continue;
    const norm = e.path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!norm) continue;
    if (!nonEmptyPrefixes.has(norm.toLowerCase())) {
      dirCandidates.add(norm);
    }
  }
  const emptyDirPaths = Array.from(dirCandidates);

  const extractAllAsFiles = (): VirtualAmigaFile[] =>
    allFiles.map((f) => ({
      path: f.path,
      bytes: f.kind === 'file' ? f.extractBytes() : (cachedExtractOrRaw(entries, f.path) ?? f.extractBytes()),
      protection: f.protection,
    }));

  const extractAllForVolume = (): VirtualAmigaFile[] => {
    const out = extractAllAsFiles();
    if (emptyDirPaths.length > 0) {
      const emptyBytes = new Uint8Array(0);
      for (const dirPath of emptyDirPaths) {
        out.push({ path: dirPath, bytes: emptyBytes, isDirectory: true });
      }
    }
    return out;
  };

  if (mediaItems.length === 1 && otherFileCount === 0) {
    const item = mediaItems[0];
    const extracted = extractArchiveEntryBytes(item.name, () => item.extractBytes());
    return { kind: extracted.kind, name: extracted.name, bytes: extracted.bytes };
  }

  const maxFloppyBlocks = ADF_TOTAL_SIZE / 512 - 4;
  const fitsFloppy = estimateBlocksFromSizes(allFiles) + emptyDirPaths.length <= maxFloppyBlocks;
  const volumeName = stripArchiveExtension(baseNameOf(archiveName));

  if (mediaItems.length >= 1) {
    return {
      kind: 'archive-choices',
      archiveName,
      archiveFormat,
      volumeName,
      totalBytes,
      mediaItems,
      allFiles,
      otherFileCount,
      fitsFloppy,
      extractAllAsFiles,
      buildAdf: () => createPopulatedBootableAdf(volumeName, extractAllForVolume()),
      buildHdf: (targetSizeMB?: number) => createPopulatedHdf(volumeName, extractAllForVolume(), targetSizeMB),
    };
  }

  return {
    kind: 'archive-files',
    archiveName,
    archiveFormat,
    volumeName,
    fileCount: allFiles.length,
    totalBytes,
    allFiles,
    fitsFloppy,
    buildAdf: () => createPopulatedBootableAdf(volumeName, extractAllForVolume()),
    buildHdf: (targetSizeMB?: number) => createPopulatedHdf(volumeName, extractAllForVolume(), targetSizeMB),
  };
}

function cachedExtractOrRaw(entries: AnyArchiveEntry[], normPath: string): Uint8Array | null {
  for (const e of entries) {
    if (e.path.replace(/\\/g, '/').replace(/^\/+/, '') === normPath) {
      return e.extract();
    }
  }
  return null;
}

/**
 * Synchronous fast-path resolver for ADF, ADZ/GZ, LHA/LZH, ZIP (Store/Deflate), HDF, ROM.
 */
export function resolveUploadedFile(fileName: string, bytes: Uint8Array): ResolvedUploadResult {
  const ext = getExtLower(fileName);

  // 1. GZIP / ADZ (.adz, .adf.gz, .gz)
  if (ext === '.adz' || ext === '.adf.gz' || ext === '.gz' || isGzipData(bytes)) {
    const { data, originalName } = decompressGzip(bytes);
    const derivedName =
      originalName && originalName.length > 0
        ? baseNameOf(originalName)
        : ext === '.adz'
          ? fileName.replace(/\.adz$/i, '.adf')
          : fileName.replace(/\.gz$/i, '');

    if (isLhaData(data)) {
      return resolveContainerEntries(derivedName, 'LHA', parseLhaArchive(data));
    }
    if (isZipData(data)) {
      return resolveContainerEntries(derivedName, 'ZIP', parseZipArchive(data));
    }

    const innerKind = classifyMediaByNameAndSize(derivedName, data.length, data);
    if (innerKind === 'hdf') {
      return { kind: 'hdf', name: derivedName.endsWith('.hdf') ? derivedName : `${derivedName}.hdf`, bytes: data };
    }
    if (innerKind === 'rom') {
      return { kind: 'rom', name: derivedName, bytes: data };
    }
    return {
      kind: 'adf',
      name: derivedName.toLowerCase().endsWith('.adf') ? derivedName : `${derivedName}.adf`,
      bytes: data,
    };
  }

  // 2. LHA / LZH (.lha, .lzh or magic signature)
  if (ext === '.lha' || ext === '.lzh' || isLhaData(bytes)) {
    if (!isLhaData(bytes)) {
      throw new Error(`Файл "${fileName}" не распознан как корректный архив LHA/LZH.`);
    }
    return resolveContainerEntries(fileName, 'LHA', parseLhaArchive(bytes));
  }

  // 3. ZIP (.zip or PK magic)
  if (ext === '.zip' || isZipData(bytes)) {
    if (!isZipData(bytes)) {
      throw new Error(`Файл "${fileName}" не распознан как корректный архив ZIP.`);
    }
    return resolveContainerEntries(fileName, 'ZIP', parseZipArchive(bytes));
  }

  // 4. HDF Hardfile (.hdf, .vhd, or RDSK magic)
  const isRdsk =
    bytes.length >= 512 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x44 &&
    bytes[2] === 0x53 &&
    bytes[3] === 0x4b; // 'RDSK'
  if (ext === '.hdf' || ext === '.vhd' || isRdsk || bytes.length > 1802240) {
    return { kind: 'hdf', name: fileName, bytes };
  }

  // 5. ROM (.rom / .kick / Kickstart binary)
  if (ext === '.rom' || ext === '.kick' || ((bytes.length === 262144 || bytes.length === 524288) && looksLikeKickstartHeader(bytes))) {
    return { kind: 'rom', name: fileName, bytes };
  }

  // 6. Standard ADF
  return { kind: 'adf', name: fileName, bytes };
}

function isAnyKnownArchive(fileName: string, bytes: Uint8Array): boolean {
  const ext = getExtLower(fileName);
  if (
    ext === '.7z' ||
    ext === '.rar' ||
    ext === '.tar' ||
    ext === '.tgz' ||
    ext === '.tar.gz' ||
    ext === '.tbz2' ||
    ext === '.tbz' ||
    ext === '.tar.bz2' ||
    ext === '.txz' ||
    ext === '.tar.xz' ||
    ext === '.bz2' ||
    ext === '.xz' ||
    ext === '.cab' ||
    ext === '.arj' ||
    ext === '.iso' ||
    ext === '.z' ||
    ext === '.lzma' ||
    ext === '.zipx' ||
    ext === '.zip' ||
    ext === '.lha' ||
    ext === '.lzh'
  ) {
    return true;
  }
  return detectUniversalArchiveFormat(fileName, bytes) !== null || isZipData(bytes) || isLhaData(bytes);
}

/**
 * Full async resolver supporting EVERY archive format:
 * .7z, .rar (RAR4 & RAR5), .zip, .lha/.lzh, .adz/.gz, .tar, .tar.gz/.tgz, .bz2, .xz, .cab, .arj, .iso
 * Uses pure-TS fast paths first and lazy-loads 7z-wasm only when needed.
 */
export async function resolveUploadedFileAsync(
  fileName: string,
  bytes: Uint8Array,
  depth = 0
): Promise<ResolvedUploadResult> {
  if (depth > 3) {
    throw new Error(`Слишком глубокая вложенность архива "${fileName}".`);
  }

  const ext = getExtLower(fileName);

  // 1. Check universal binary archive formats (.7z, .rar, .tar, .bz2, .xz, .cab, .arj, .tar.gz, .tgz, .iso, etc.)
  const uniFormat = detectUniversalArchiveFormat(fileName, bytes);
  if (uniFormat && ext !== '.adz' && ext !== '.adf.gz') {
    const entries = await extractWithSevenZip(fileName, bytes);
    if (entries.length === 1) {
      const only = entries[0];
      const innerBytes = only.extract();
      const innerName = baseNameOf(only.path);
      // Recursively unwrap nested archive (.tar inside .tar.gz/.bz2/.xz, or .zip/.adz/.7z inside .rar)
      if (isAnyKnownArchive(innerName, innerBytes) || isGzipData(innerBytes)) {
        return resolveUploadedFileAsync(innerName, innerBytes, depth + 1);
      }
      // Single ROM/HDF/ADF inside 7z/RAR
      const innerKind = classifyMediaByNameAndSize(innerName, innerBytes.length, innerBytes);
      if (innerKind === 'rom') return { kind: 'rom', name: innerName, bytes: innerBytes };
      if (innerKind === 'hdf') return { kind: 'hdf', name: innerName, bytes: innerBytes };
      if (innerKind === 'adf') return { kind: 'adf', name: innerName, bytes: innerBytes };
    }
    return resolveContainerEntries(fileName, uniFormat, entries);
  }

  // 2. GZIP / ADZ fast path, with nested .tar/.7z/.rar unwrap
  if (ext === '.adz' || ext === '.adf.gz' || ext === '.gz' || isGzipData(bytes)) {
    const { data, originalName } = decompressGzip(bytes);
    const derivedName =
      originalName && originalName.length > 0
        ? baseNameOf(originalName)
        : ext === '.adz'
          ? fileName.replace(/\.adz$/i, '.adf')
          : fileName.replace(/\.gz$/i, '');

    if (isAnyKnownArchive(derivedName, data)) {
      return resolveUploadedFileAsync(derivedName, data, depth + 1);
    }

    const innerKind = classifyMediaByNameAndSize(derivedName, data.length, data);
    if (innerKind === 'hdf') {
      return { kind: 'hdf', name: derivedName.endsWith('.hdf') ? derivedName : `${derivedName}.hdf`, bytes: data };
    }
    if (innerKind === 'rom') {
      return { kind: 'rom', name: derivedName, bytes: data };
    }
    return {
      kind: 'adf',
      name: derivedName.toLowerCase().endsWith('.adf') ? derivedName : `${derivedName}.adf`,
      bytes: data,
    };
  }

  // 3. ZIP / LHA fast path with automatic 7z-wasm fallback (e.g., ZIP with LZMA/BZip2/Deflate64 or LHA edge cases)
  if (ext === '.zip' || isZipData(bytes) || ext === '.lha' || ext === '.lzh' || isLhaData(bytes)) {
    try {
      const fastRes = resolveUploadedFile(fileName, bytes);
      if (fastRes.kind === 'archive-choices' && fastRes.mediaItems.length === 1 && fastRes.otherFileCount === 0) {
        const onlyItem = fastRes.mediaItems[0];
        const b = onlyItem.extractBytes();
        if (isAnyKnownArchive(onlyItem.name, b)) {
          return resolveUploadedFileAsync(onlyItem.name, b, depth + 1);
        }
      }
      return fastRes;
    } catch {
      const fallbackFmt = ext === '.lha' || ext === '.lzh' || isLhaData(bytes) ? 'LHA' : 'ZIP';
      const entries = await extractWithSevenZip(fileName, bytes);
      return resolveContainerEntries(fileName, fallbackFmt, entries);
    }
  }

  // 4. Plain HDF / ROM / ADF
  return resolveUploadedFile(fileName, bytes);
}

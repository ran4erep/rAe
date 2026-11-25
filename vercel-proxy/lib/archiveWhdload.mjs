import {
  normalizePlanetemuLetter,
  PLANETEMU_LETTERS,
} from './planetemu.mjs';
import { formatBytesLabel, getArchiveTosecLetterBucket } from './archiveTosec.mjs';

export const ARCHIVE_WHDLOAD_ITEM_ID = 'Amiga_WHD_Games';
export const ARCHIVE_WHDLOAD_SOURCE_URL = `https://archive.org/details/${ARCHIVE_WHDLOAD_ITEM_ID}`;
export const ARCHIVE_WHDLOAD_METADATA_URL =
  `https://archive.org/metadata/${ARCHIVE_WHDLOAD_ITEM_ID}/files`;

const INDEX_CACHE_TTL_MS = 60 * 60 * 1000; // Static archive.org collection; 1h in-memory TTL

let cachedIndex = null;
let inflightIndexPromise = null;

const KNOWN_LANG_MAP = new Map([
  ['de', 'De'],
  ['fr', 'Fr'],
  ['es', 'Es'],
  ['it', 'It'],
  ['pl', 'Pl'],
  ['cz', 'Cz'],
  ['dk', 'Dk'],
  ['se', 'Se'],
  ['fi', 'Fi'],
  ['nl', 'Nl'],
  ['pt', 'Pt'],
  ['ru', 'Ru'],
  ['en', 'En'],
  ['gr', 'Gr'],
  ['hu', 'Hu'],
  ['no', 'No'],
]);

function isUpperAscii(c) {
  return c >= 65 && c <= 90;
}

function isLowerAscii(c) {
  return c >= 97 && c <= 122;
}

function isDigitAscii(c) {
  return c >= 48 && c <= 57;
}

/**
 * Single-pass O(n) CamelCase splitter for WHDLoad package names
 * (e.g. "4DSportsBoxing" -> "4D Sports Boxing", "AlienBreed3D2" -> "Alien Breed 3D 2").
 */
export function formatWhdloadTitle(rawTitle) {
  if (typeof rawTitle !== 'string' || !rawTitle) return '';
  let out = '';
  const len = rawTitle.length;
  for (let i = 0; i < len; i++) {
    const ch = rawTitle[i];
    if (ch === '&') {
      if (out.length > 0 && out[out.length - 1] !== ' ') out += ' ';
      out += '& ';
      continue;
    }
    const c = rawTitle.charCodeAt(i);
    if (i > 0) {
      const prev = rawTitle.charCodeAt(i - 1);
      const next = i + 1 < len ? rawTitle.charCodeAt(i + 1) : 0;
      const prevWasSpace = out.length > 0 && out[out.length - 1] === ' ';
      if (!prevWasSpace) {
        if (isLowerAscii(prev) && (isUpperAscii(c) || isDigitAscii(c))) {
          out += ' ';
        } else if (isUpperAscii(prev) && isUpperAscii(c) && isLowerAscii(next)) {
          out += ' ';
        } else if (isDigitAscii(prev) && isUpperAscii(c)) {
          // Keep "2D" / "3D" / "4D" together when followed by end or uppercase
          if (!(c === 68 && (!isLowerAscii(next)))) {
            out += ' ';
          }
        } else if (isUpperAscii(prev) && isDigitAscii(c)) {
          // Keep e.g. "A10" or "F18" together when prev is a single capital at title start
          if (i !== 1) {
            out += ' ';
          }
        }
      }
    }
    out += ch;
  }
  return out.trim();
}

export function isValidWhdloadFilename(rawFile) {
  if (typeof rawFile !== 'string') return false;
  const trimmed = rawFile.trim();
  if (!trimmed || trimmed.length > 255) return false;
  if (
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('\0') ||
    trimmed.includes('..')
  ) {
    return false;
  }
  const low = trimmed.toLowerCase();
  return low.endsWith('.zip') || low.endsWith('.lha');
}

export function buildArchiveWhdloadDownloadUrl(rawFile) {
  const safeFile = rawFile.trim();
  if (!isValidWhdloadFilename(safeFile)) {
    throw new Error('Invalid Archive.org WHDLoad filename');
  }
  return `https://archive.org/download/${ARCHIVE_WHDLOAD_ITEM_ID}/${encodeURIComponent(safeFile)}`;
}

function parseVersionScore(versionStr) {
  if (!versionStr) return 0;
  const m = versionStr.match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?([a-z])?/i);
  if (!m) return 0;
  const major = Number.parseInt(m[1], 10) || 0;
  const minor = Number.parseInt(m[2] || '0', 10) || 0;
  const patch = Number.parseInt(m[3] || '0', 10) || 0;
  const suffix = m[4] ? m[4].toLowerCase().charCodeAt(0) - 96 : 0;
  return major * 1_000_000 + minor * 10_000 + patch * 100 + suffix;
}

/**
 * Parses an Archive.org `Amiga_WHD_Games` file entry `{ name, size }` into structured metadata.
 * Returns null for non-game metadata files (.xml, .sqlite, .torrent, .mp3, etc.).
 */
export function parseWhdloadFileEntry(entry) {
  if (!entry || typeof entry.name !== 'string') return null;
  const fileName = entry.name.trim();
  if (!isValidWhdloadFilename(fileName)) return null;

  const dotIdx = fileName.lastIndexOf('.');
  const ext = fileName.slice(dotIdx + 1).toUpperCase(); // ZIP | LHA
  const stem = fileName.slice(0, dotIdx);
  if (!stem) return null;

  const sizeBytes = Number.parseInt(String(entry.size ?? '0'), 10);
  const safeSize = Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : 0;

  const parts = stem.split('_');
  const rawTitle = parts[0] || stem;
  const title = formatWhdloadTitle(rawTitle) || stem;

  let version = null;
  let platform = 'OCS/ECS';
  let lang = null;
  let prereleaseKind = null;
  const extraTags = [];

  if (/Demo$/i.test(rawTitle) || /Demo/i.test(rawTitle) && /Demo(Playable|Rolling|Latest)/i.test(rawTitle)) {
    prereleaseKind = 'demo';
  }

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i].trim();
    if (!part) continue;
    const low = part.toLowerCase();

    if (!version && /^v\d/i.test(part)) {
      version = part;
      continue;
    }
    if (/^\d{4,}$/.test(part)) {
      // Skip SPS/WHDLoad numeric release IDs in UI tags
      continue;
    }
    if (low === 'cd32') {
      platform = 'CD32';
      continue;
    }
    if (low === 'cdtv') {
      platform = 'CDTV';
      continue;
    }
    if (low === 'aga') {
      if (platform !== 'CD32' && platform !== 'CDTV') platform = 'AGA';
      continue;
    }
    const mappedLang = KNOWN_LANG_MAP.get(low);
    if (mappedLang) {
      lang = mappedLang;
      extraTags.push(mappedLang);
      continue;
    }
    if (low.includes('demo') || low === 'preview') {
      prereleaseKind = 'demo';
    } else if (low === 'beta') {
      prereleaseKind = 'beta';
    } else if (low === 'alpha') {
      prereleaseKind = 'alpha';
    } else if (low === 'proto') {
      prereleaseKind = 'proto';
    }
    extraTags.push(part);
  }

  const versionScore = parseVersionScore(version);
  // Prefer English / non-localized releases, higher version, LHA (newer WHDLoad releases), and non-demo full versions
  let qualityPenalty = 0;
  if (prereleaseKind) qualityPenalty += 500;
  if (lang && lang !== 'En') qualityPenalty += 120;
  if (extraTags.some((t) => t.toLowerCase() === 'novoice' || t.toLowerCase() === 'nointro')) {
    qualityPenalty += 20;
  }

  const searchText = `${title} ${rawTitle} ${stem.replace(/_/g, ' ')} ${platform}`.toLowerCase();

  return {
    fileName,
    ext,
    rawTitle,
    title,
    sortKey: title.toLowerCase(),
    searchText,
    version,
    versionScore,
    platform,
    lang,
    prereleaseKind,
    extraTags,
    qualityPenalty,
    sizeBytes: safeSize,
    sizeLabel: formatBytesLabel(safeSize),
  };
}

export function buildWhdloadIndexFromFiles(files) {
  const byLetter = new Map();
  for (const letter of PLANETEMU_LETTERS) {
    byLetter.set(letter, []);
  }
  const allRows = [];

  if (Array.isArray(files)) {
    for (let i = 0; i < files.length; i++) {
      const row = parseWhdloadFileEntry(files[i]);
      if (!row) continue;
      allRows.push(row);
      byLetter.get(getArchiveTosecLetterBucket(row.title)).push(row);
    }
  }

  for (const rows of byLetter.values()) {
    rows.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
  }

  return {
    expiresAt: Date.now() + INDEX_CACHE_TTL_MS,
    byLetter,
    allRows,
    groupsByLetter: new Map(),
  };
}

export async function getOrFetchWhdloadIndex({ signal } = {}) {
  const now = Date.now();
  if (cachedIndex && cachedIndex.expiresAt > now) {
    return cachedIndex;
  }

  if (!inflightIndexPromise) {
    inflightIndexPromise = (async () => {
      const resp = await fetch(ARCHIVE_WHDLOAD_METADATA_URL, {
        headers: {
          'User-Agent': 'Amiga500WebEmulator-Proxy/1.0',
          Accept: 'application/json',
        },
        signal: signal ?? AbortSignal.timeout(15000),
      });

      if (!resp.ok) {
        throw new Error(`Archive.org WHDLoad metadata returned HTTP ${resp.status}`);
      }

      const json = await resp.json();
      const files = Array.isArray(json?.result)
        ? json.result
        : Array.isArray(json?.files)
          ? json.files
          : [];

      const built = buildWhdloadIndexFromFiles(files);
      cachedIndex = built;
      return built;
    })().finally(() => {
      inflightIndexPromise = null;
    });
  }

  return inflightIndexPromise;
}

export function buildWhdloadDownloadProxyUrl(fileName) {
  return `/api/download?source=whdload&file=${encodeURIComponent(fileName)}`;
}

function platformRank(platform) {
  switch (platform) {
    case 'OCS/ECS':
      return 0;
    case 'AGA':
      return 1;
    case 'CDTV':
      return 2;
    case 'CD32':
      return 3;
    default:
      return 4;
  }
}

export function groupWhdloadRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const buckets = new Map();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const key = `${row.rawTitle.toLowerCase()}|${row.platform}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        rawTitle: row.rawTitle,
        title: row.title,
        platform: row.platform,
        sortKey: row.sortKey,
        rows: [],
      };
      buckets.set(key, bucket);
    }
    bucket.rows.push(row);
  }

  const groups = [];
  for (const bucket of buckets.values()) {
    bucket.rows.sort((a, b) => {
      if (a.qualityPenalty !== b.qualityPenalty) return a.qualityPenalty - b.qualityPenalty;
      if (a.versionScore !== b.versionScore) return b.versionScore - a.versionScore;
      if (a.ext !== b.ext) return a.ext === 'LHA' ? -1 : 1;
      return a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0;
    });

    const primary = bucket.rows[0];
    const tags = [];
    const seenTags = new Set();
    if (primary.version) {
      tags.push(primary.version);
      seenTags.add(primary.version);
    }
    if (!seenTags.has(primary.ext)) {
      tags.push(primary.ext);
      seenTags.add(primary.ext);
    }
    for (const t of primary.extraTags) {
      if (!seenTags.has(t)) {
        tags.push(t);
        seenTags.add(t);
      }
    }

    const files = bucket.rows.map((r) => {
      const variantTags = [];
      if (r.version) variantTags.push(r.version);
      variantTags.push(r.ext);
      for (const t of r.extraTags) variantTags.push(t);
      return {
        id: `whd:${r.fileName}`,
        name: r.fileName,
        sizeLabel: r.sizeLabel,
        sizeBytes: r.sizeBytes,
        diskNumber: null,
        diskTotal: null,
        isClean: r.qualityPenalty === 0,
        prereleaseKind: r.prereleaseKind,
        variantTags,
        proxyDownloadUrl: buildWhdloadDownloadProxyUrl(r.fileName),
      };
    });

    groups.push({
      id: `whd:${primary.fileName}`,
      title: bucket.title,
      year: null,
      firms: [],
      tags,
      platform: bucket.platform,
      isPrereleaseOnly: bucket.rows.every((r) => r.prereleaseKind !== null),
      isWhdload: true,
      diskCount: 1,
      files,
      coverPath: null,
      coverUrl: null,
      proxyCoverUrl: null,
      proxyDownloadUrl: files[0].proxyDownloadUrl,
      _sortKey: bucket.sortKey,
      _platformRank: platformRank(bucket.platform),
      _penalty: primary.qualityPenalty,
    });
  }

  groups.sort((a, b) => {
    if (a._sortKey !== b._sortKey) return a._sortKey < b._sortKey ? -1 : 1;
    if (a.isPrereleaseOnly !== b.isPrereleaseOnly) return a.isPrereleaseOnly ? 1 : -1;
    return a._platformRank - b._platformRank;
  });

  for (let i = 0; i < groups.length; i++) {
    delete groups[i]._sortKey;
    delete groups[i]._platformRank;
    delete groups[i]._penalty;
  }

  return groups;
}

export async function fetchWhdloadLetterGroups(letter, opts = {}) {
  const safeLetter = normalizePlanetemuLetter(letter);
  const index = await getOrFetchWhdloadIndex(opts);

  let groups = index.groupsByLetter.get(safeLetter);
  if (!groups) {
    const rows = index.byLetter.get(safeLetter) ?? [];
    groups = groupWhdloadRows(rows);
    index.groupsByLetter.set(safeLetter, groups);
  }
  return groups;
}

export async function searchWhdloadRows(query, opts = {}) {
  const index = await getOrFetchWhdloadIndex(opts);
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return [];

  const matched = [];
  const rows = index.allRows;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const haystack = row.searchText;
    let ok = true;
    for (let j = 0; j < tokens.length; j++) {
      if (!haystack.includes(tokens[j])) {
        ok = false;
        break;
      }
    }
    if (ok) matched.push(row);
  }
  return matched;
}

export function clearWhdloadCache() {
  cachedIndex = null;
}

import {
  extractQueryLetter,
  filterPlanetemuRowsByQuery,
  groupPlanetemuRoms,
  normalizePlanetemuLetter,
  PLANETEMU_LETTERS,
} from './planetemu.mjs';

export const ARCHIVE_TOSEC_ITEM_ID = 'Commodore_Amiga_TOSEC_2012_04_10';
export const ARCHIVE_TOSEC_SOURCE_URL = `https://archive.org/details/${ARCHIVE_TOSEC_ITEM_ID}`;
export const ARCHIVE_TOSEC_INDEX_URL =
  `https://archive.org/download/${ARCHIVE_TOSEC_ITEM_ID}/${ARCHIVE_TOSEC_ITEM_ID}.txt`;
export const ARCHIVE_TOSEC_ZIP_ROOT = 'Commodore Amiga [TOSEC v2012-04-10]';
export const ARCHIVE_TOSEC_GAMES_SUBDIR =
  'Games/[ADF]/Commodore Amiga - Games - [ADF] (TOSEC 2012-02-27)';

const FULL_GAMES_PREFIX = `${ARCHIVE_TOSEC_ZIP_ROOT}/${ARCHIVE_TOSEC_GAMES_SUBDIR}/`;
const INDEX_CACHE_TTL_MS = 60 * 60 * 1000; // Static 2012 TOSEC archive; 1h in-memory TTL

let cachedIndex = null;
let inflightIndexPromise = null;

export function formatBytesLabel(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export function isValidArchiveTosecFilename(rawFile) {
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
  return trimmed.toLowerCase().endsWith('.zip');
}

export function buildArchiveTosecDownloadUrl(rawFile) {
  const safeFile = rawFile.trim();
  if (!isValidArchiveTosecFilename(safeFile)) {
    throw new Error('Invalid Archive.org TOSEC filename');
  }
  const encodedSubdir = `${ARCHIVE_TOSEC_ZIP_ROOT}/${ARCHIVE_TOSEC_GAMES_SUBDIR}`
    .split('/')
    .map(encodeURIComponent)
    .join('/');
  return (
    `https://archive.org/download/${ARCHIVE_TOSEC_ITEM_ID}/${ARCHIVE_TOSEC_ITEM_ID}.zip/` +
    `${encodedSubdir}/${encodeURIComponent(safeFile)}`
  );
}

export function toTosecSlugBase(name) {
  if (typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Parses a single line from Archive.org `unzip -l` text listing into a catalog row
 * without regex backtracking. Returns null for non-ADF-game lines.
 */
export function parseArchiveTosecIndexLine(line) {
  if (typeof line !== 'string' || !line.endsWith('.zip')) return null;

  const prefixIdx = line.indexOf(FULL_GAMES_PREFIX);
  if (prefixIdx === -1) return null;

  const fileName = line.slice(prefixIdx + FULL_GAMES_PREFIX.length);
  if (!isValidArchiveTosecFilename(fileName)) return null;

  // Parse leading integer byte size without regex
  let i = 0;
  const len = line.length;
  while (i < len && line.charCodeAt(i) === 32) i++;
  let sizeBytes = 0;
  let hasDigits = false;
  while (i < len) {
    const code = line.charCodeAt(i);
    if (code >= 48 && code <= 57) {
      hasDigits = true;
      sizeBytes = sizeBytes * 10 + (code - 48);
      i++;
    } else {
      break;
    }
  }
  if (!hasDigits || !Number.isFinite(sizeBytes)) sizeBytes = 0;

  const name = fileName.slice(0, -4);
  if (!name) return null;

  return {
    slug: `archive-tosec/${fileName}`,
    fileName,
    name,
    sortKey: name.toLowerCase(),
    sizeLabel: formatBytesLabel(sizeBytes),
    sizeBytes,
  };
}

export function getArchiveTosecLetterBucket(name) {
  if (typeof name !== 'string' || !name.length) return '0';
  const code = name.charCodeAt(0);
  if (code >= 65 && code <= 90) return String.fromCharCode(code);
  if (code >= 97 && code <= 122) return String.fromCharCode(code - 32);
  return '0';
}

export function buildArchiveTosecIndexFromLines(iter) {
  const byLetter = new Map();
  for (const letter of PLANETEMU_LETTERS) {
    byLetter.set(letter, []);
  }
  const allRows = [];

  for (const rawLine of iter) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const row = parseArchiveTosecIndexLine(line);
    if (!row) continue;

    allRows.push(row);
    byLetter.get(getArchiveTosecLetterBucket(row.name)).push(row);
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

/**
 * Streams and parses Archive.org's `Commodore_Amiga_TOSEC_2012_04_10.txt` line by line
 * so peak memory stays low even on serverless runtimes.
 */
export async function getOrFetchArchiveTosecIndex({ signal } = {}) {
  const now = Date.now();
  if (cachedIndex && cachedIndex.expiresAt > now) {
    return cachedIndex;
  }

  if (!inflightIndexPromise) {
    inflightIndexPromise = (async () => {
      const resp = await fetch(ARCHIVE_TOSEC_INDEX_URL, {
        headers: {
          'User-Agent': 'Amiga500WebEmulator-Proxy/1.0',
          Accept: 'text/plain,*/*;q=0.8',
        },
        signal: signal ?? AbortSignal.timeout(15000),
      });

      if (!resp.ok || !resp.body) {
        throw new Error(`Archive.org TOSEC index returned HTTP ${resp.status}`);
      }

      const byLetter = new Map();
      for (const letter of PLANETEMU_LETTERS) {
        byLetter.set(letter, []);
      }
      const allRows = [];

      const reader = resp.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let leftover = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = leftover + decoder.decode(value, { stream: true });
        let lineStart = 0;
        let nlIdx = chunk.indexOf('\n', lineStart);
        while (nlIdx !== -1) {
          let lineEnd = nlIdx;
          if (lineEnd > lineStart && chunk.charCodeAt(lineEnd - 1) === 13) {
            lineEnd--;
          }
          if (lineEnd > lineStart) {
            const line = chunk.slice(lineStart, lineEnd);
            const row = parseArchiveTosecIndexLine(line);
            if (row) {
              allRows.push(row);
              byLetter.get(getArchiveTosecLetterBucket(row.name)).push(row);
            }
          }
          lineStart = nlIdx + 1;
          nlIdx = chunk.indexOf('\n', lineStart);
        }
        leftover = chunk.slice(lineStart);
      }

      const tail = (leftover + decoder.decode()).trimEnd();
      if (tail) {
        const row = parseArchiveTosecIndexLine(tail);
        if (row) {
          allRows.push(row);
          byLetter.get(getArchiveTosecLetterBucket(row.name)).push(row);
        }
      }

      for (const rows of byLetter.values()) {
        rows.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
      }

      const built = {
        expiresAt: Date.now() + INDEX_CACHE_TTL_MS,
        byLetter,
        allRows,
        groupsByLetter: new Map(),
      };
      cachedIndex = built;
      return built;
    })().finally(() => {
      inflightIndexPromise = null;
    });
  }

  return inflightIndexPromise;
}

export function buildArchiveTosecDownloadProxyUrl(row) {
  return `/api/download?source=archive-tosec&file=${encodeURIComponent(row.fileName)}`;
}

export function groupArchiveTosecRows(rows) {
  return groupPlanetemuRoms(rows, buildArchiveTosecDownloadProxyUrl);
}

export async function fetchArchiveTosecLetterGroups(letter, opts = {}) {
  const safeLetter = normalizePlanetemuLetter(letter);
  const index = await getOrFetchArchiveTosecIndex(opts);

  let groups = index.groupsByLetter.get(safeLetter);
  if (!groups) {
    const rows = index.byLetter.get(safeLetter) ?? [];
    groups = groupArchiveTosecRows(rows);
    index.groupsByLetter.set(safeLetter, groups);
  }
  return groups;
}

export async function searchArchiveTosecRows(query, opts = {}) {
  const index = await getOrFetchArchiveTosecIndex(opts);
  const matched = filterPlanetemuRowsByQuery(index.allRows, query);
  if (matched.length <= 1) return matched;

  return [...matched].sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
}

export function findMatchingRowInIndexBySlug(index, rawSlug) {
  if (!index || typeof rawSlug !== 'string') return null;
  const tail = rawSlug.split('/').pop()?.trim().toLowerCase() ?? '';
  if (!tail) return null;

  const firstLetter = normalizePlanetemuLetter(extractQueryLetter(tail) ?? '0');
  const primaryBucket = index.byLetter.get(firstLetter) ?? [];

  for (let i = 0; i < primaryBucket.length; i++) {
    if (toTosecSlugBase(primaryBucket[i].name) === tail) {
      return primaryBucket[i];
    }
  }
  for (let i = 0; i < index.allRows.length; i++) {
    if (toTosecSlugBase(index.allRows[i].name) === tail) {
      return index.allRows[i];
    }
  }
  return null;
}

export async function findArchiveTosecFileByPlanetemuSlug(slug, opts = {}) {
  const index = await getOrFetchArchiveTosecIndex(opts);
  return findMatchingRowInIndexBySlug(index, slug);
}

export function clearArchiveTosecCache() {
  cachedIndex = null;
}

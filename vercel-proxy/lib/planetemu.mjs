import { decodeHtmlEntities } from './amiga500archive.mjs';

export const PLANETEMU_ORIGIN = 'https://www.planetemu.net';
export const PLANETEMU_ROMSET = 'commodore-amiga-games-adf';
export const PLANETEMU_LETTERS = [
  '0',
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
  'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
];

const PLANETEMU_LETTER_SET = new Set(PLANETEMU_LETTERS);
const SLUG_RE = /^commodore-amiga-[a-z0-9-]+\/[a-z0-9-]+$/i;
const DEFAULT_PAGE_SIZE = 36;
const MAX_PAGE_SIZE = 60;
const LETTER_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_LETTER_CACHE = 8;

export const PLANETEMU_BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,fr;q=0.8',
  'Cache-Control': 'no-cache',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
};

export function isPlanetemuBlockedResponse(resp, bodySnippet = '') {
  if (!resp) return false;
  if (resp.status === 403 || resp.status === 429 || resp.status === 503) return true;
  if (resp.headers?.get?.('cf-mitigated') === 'challenge') return true;
  if (typeof bodySnippet === 'string' && bodySnippet) {
    if (
      bodySnippet.includes('challenges.cloudflare.com') ||
      bodySnippet.includes('<title>Just a moment...</title>') ||
      bodySnippet.includes('cf-browser-verification')
    ) {
      return true;
    }
  }
  return false;
}

const letterCache = new Map();

export function normalizePlanetemuLetter(rawLetter) {
  if (typeof rawLetter !== 'string') return '0';
  const upper = rawLetter.trim().toUpperCase();
  if (upper === '0-9') return '0';
  return PLANETEMU_LETTER_SET.has(upper) ? upper : '0';
}

export function isValidPlanetemuSlug(slug) {
  return typeof slug === 'string' && slug.length <= 240 && SLUG_RE.test(slug.trim());
}

export function extractPlanetemuSlug(href) {
  if (typeof href !== 'string') return null;
  let cleaned = href.trim();
  if (cleaned.startsWith(PLANETEMU_ORIGIN)) {
    cleaned = cleaned.slice(PLANETEMU_ORIGIN.length);
  }
  const prefix = '/en/rom/';
  const frPrefix = '/rom/';
  if (cleaned.startsWith(prefix)) {
    cleaned = cleaned.slice(prefix.length);
  } else if (cleaned.startsWith(frPrefix)) {
    cleaned = cleaned.slice(frPrefix.length);
  } else {
    return null;
  }
  return isValidPlanetemuSlug(cleaned) ? cleaned : null;
}

export function parseSizeToBytes(sizeLabel) {
  if (typeof sizeLabel !== 'string') return 0;
  const match = sizeLabel.trim().match(/^([\d.,]+)\s*(B|KB|MB|GB|KO|MO|GO)$/i);
  if (!match) return 0;
  const value = Number.parseFloat(match[1].replace(',', '.'));
  if (!Number.isFinite(value) || value < 0) return 0;
  const unit = match[2].toUpperCase();
  if (unit === 'B') return Math.round(value);
  if (unit === 'KB' || unit === 'KO') return Math.round(value * 1024);
  if (unit === 'MB' || unit === 'MO') return Math.round(value * 1024 * 1024);
  if (unit === 'GB' || unit === 'GO') return Math.round(value * 1024 * 1024 * 1024);
  return 0;
}

/**
 * Fast, zero-regex-backtracking indexOf parser for Planetemu romset listing HTML.
 * Parses 4,400+ rows in ~4ms.
 */
export function parsePlanetemuListHtml(html) {
  if (typeof html !== 'string' || !html) return [];

  const rows = [];
  const startMarker = '<td class="rom-list-name">';
  const sizeMarker = '<td class="taillerom">';
  let pos = 0;

  while ((pos = html.indexOf(startMarker, pos)) !== -1) {
    const tdEnd = html.indexOf('</td>', pos);
    if (tdEnd === -1) break;

    const hrefStart = html.indexOf('href="', pos);
    if (hrefStart === -1 || hrefStart > tdEnd) {
      pos = tdEnd + 5;
      continue;
    }
    const hrefEnd = html.indexOf('"', hrefStart + 6);
    if (hrefEnd === -1 || hrefEnd > tdEnd) {
      pos = tdEnd + 5;
      continue;
    }
    const tagClose = html.indexOf('>', hrefEnd);
    const aEnd = tagClose !== -1 ? html.indexOf('</a>', tagClose) : -1;
    if (tagClose === -1 || aEnd === -1 || aEnd > tdEnd) {
      pos = tdEnd + 5;
      continue;
    }

    const href = html.slice(hrefStart + 6, hrefEnd);
    const slug = extractPlanetemuSlug(href);
    const rawName = decodeHtmlEntities(html.slice(tagClose + 1, aEnd).trim());

    let sizeLabel = '';
    const sizeStart = html.indexOf(sizeMarker, tdEnd);
    if (sizeStart !== -1 && sizeStart - tdEnd < 120) {
      const sizeEnd = html.indexOf('</td>', sizeStart + sizeMarker.length);
      if (sizeEnd !== -1) {
        sizeLabel = decodeHtmlEntities(html.slice(sizeStart + sizeMarker.length, sizeEnd).trim());
      }
    }

    if (slug && rawName) {
      rows.push({
        slug,
        name: rawName,
        sizeLabel,
        sizeBytes: parseSizeToBytes(sizeLabel),
      });
    }
    pos = tdEnd + 5;
  }

  return rows;
}

/**
 * Parses `/en/recherche/roms?q=...` search result HTML and extracts entries
 * belonging to the Amiga ADF games romset.
 */
export function parsePlanetemuSearchHtml(html, romset = PLANETEMU_ROMSET) {
  if (typeof html !== 'string' || !html) return [];

  const rows = [];
  const itemMarker = '<li class="search-result';
  const titleMarker = 'class="search-result__title"';
  const sizeMarker = 'class="search-result__size"';
  const romPrefix = `/en/rom/${romset}/`;
  let pos = 0;

  while ((pos = html.indexOf(itemMarker, pos)) !== -1) {
    const liEnd = html.indexOf('</li>', pos);
    if (liEnd === -1) break;

    const titleIdx = html.indexOf(titleMarker, pos);
    if (titleIdx === -1 || titleIdx > liEnd) {
      pos = liEnd + 5;
      continue;
    }
    const hrefStart = html.indexOf('href="', titleIdx);
    const hrefEnd = hrefStart !== -1 ? html.indexOf('"', hrefStart + 6) : -1;
    const tagClose = hrefEnd !== -1 ? html.indexOf('>', hrefEnd) : -1;
    const aEnd = tagClose !== -1 ? html.indexOf('</a>', tagClose) : -1;

    if (hrefStart !== -1 && hrefEnd !== -1 && tagClose !== -1 && aEnd !== -1 && aEnd < liEnd) {
      const href = html.slice(hrefStart + 6, hrefEnd);
      if (href.startsWith(romPrefix)) {
        const slug = extractPlanetemuSlug(href);
        const rawName = decodeHtmlEntities(html.slice(tagClose + 1, aEnd).trim());
        let sizeLabel = '';
        const sizeIdx = html.indexOf(sizeMarker, aEnd);
        if (sizeIdx !== -1 && sizeIdx < liEnd) {
          const sizeTagEnd = html.indexOf('>', sizeIdx);
          const spanEnd = sizeTagEnd !== -1 ? html.indexOf('</span>', sizeTagEnd) : -1;
          if (sizeTagEnd !== -1 && spanEnd !== -1 && spanEnd <= liEnd) {
            sizeLabel = decodeHtmlEntities(html.slice(sizeTagEnd + 1, spanEnd).trim());
          }
        }
        if (slug && rawName) {
          rows.push({
            slug,
            name: rawName,
            sizeLabel,
            sizeBytes: parseSizeToBytes(sizeLabel),
          });
        }
      }
    }

    pos = liEnd + 5;
  }

  return rows;
}

const YEAR_TAG_RE = /^(19\d\d|20\d\d|19xx|20xx)(?:-[\dx]{2}(?:-[\dx]{2})?)?$/i;
const DISK_OF_RE = /^(?:Disk|Disc|Side|Tape|Part)\s+(\d+|[A-Z])\s*(?:of|\/)\s*(\d+)$/i;
const DISK_SINGLE_RE = /^(?:Disk|Disc|Side|Tape|Part)\s+(\d+|[A-Z])$/i;
const DISK_PREFIX_RE = /^(?:Disk|Disc|Side|Tape|Part)\s+/i;

function letterOrDigitToNum(tok) {
  const n = Number.parseInt(tok, 10);
  if (Number.isFinite(n)) return n;
  const code = tok.toUpperCase().charCodeAt(0);
  if (code >= 65 && code <= 90) return code - 64;
  return null;
}

export function parseTosecReleaseInfo(rawName) {
  const bracketIdx = rawName.indexOf('[');
  const parensZone = bracketIdx === -1 ? rawName : rawName.slice(0, bracketIdx);
  const tailZone = bracketIdx === -1 ? '' : rawName.slice(bracketIdx);

  const isBadDump = /\[b(?:\s+[^\]]*)?\]/i.test(tailZone);
  const isVerified = /\[\!\]/.test(tailZone);

  let diskNumber = null;
  let diskTotal = null;
  let year = null;
  let publisher = null;
  const tags = [];
  let expectPublisher = false;

  const firstParen = parensZone.indexOf('(');
  const title = (firstParen > 0 ? parensZone.slice(0, firstParen) : parensZone).trim() || rawName;

  let groupBase = firstParen === -1 ? parensZone.trim() : parensZone.slice(0, firstParen).trim();
  let pPos = firstParen;
  const keptParens = [];

  while (pPos !== -1) {
    const pEnd = parensZone.indexOf(')', pPos + 1);
    if (pEnd === -1) break;
    const inner = parensZone.slice(pPos + 1, pEnd).trim();
    pPos = parensZone.indexOf('(', pEnd + 1);
    if (!inner) continue;

    const ofMatch = inner.match(DISK_OF_RE);
    if (ofMatch) {
      diskNumber = letterOrDigitToNum(ofMatch[1]);
      diskTotal = Number.parseInt(ofMatch[2], 10) || null;
      continue;
    }
    const singleMatch = inner.match(DISK_SINGLE_RE);
    if (singleMatch) {
      if (diskNumber === null) {
        diskNumber = letterOrDigitToNum(singleMatch[1]);
      }
      continue;
    }
    if (DISK_PREFIX_RE.test(inner)) {
      continue;
    }

    keptParens.push(inner);
  }

  // Strip trailing TOSEC (A)-(H)/(1)-(9) disk/side markers even after (Disk X of Y)
  while (keptParens.length > 0) {
    const last = keptParens[keptParens.length - 1];
    if (last.length === 1) {
      const code = last.toUpperCase().charCodeAt(0);
      if ((code >= 65 && code <= 72) || (code >= 49 && code <= 57)) {
        if (diskNumber === null) {
          diskNumber = letterOrDigitToNum(last);
        }
        keptParens.pop();
        continue;
      }
    }
    break;
  }

  for (let i = 0; i < keptParens.length; i++) {
    const inner = keptParens[i];
    if (!year && YEAR_TAG_RE.test(inner)) {
      year = inner.slice(0, 4);
      expectPublisher = true;
      continue;
    }
    if (expectPublisher) {
      expectPublisher = false;
      if (inner !== '-' && inner !== 'unknown') {
        publisher = inner;
      }
      continue;
    }
    tags.push(inner);
  }

  if (keptParens.length > 0) {
    groupBase = `${groupBase} (${keptParens.join(')(')})`;
  }
  const cleanGroupBase = groupBase.trim() || rawName;

  return {
    groupKey: cleanGroupBase.toLowerCase(),
    displayGroupName: cleanGroupBase,
    title,
    year,
    publisher,
    tags,
    diskNumber,
    diskTotal,
    isBadDump,
    isVerified,
  };
}

/**
 * Groups flat Planetemu ADF listing rows by TOSEC release (combining Disk 1..N and variants).
 */
export function groupPlanetemuRoms(
  rawRows,
  buildDownloadUrl = (row) => `/api/download?source=planetemu&slug=${encodeURIComponent(row.slug)}`
) {
  if (!Array.isArray(rawRows) || rawRows.length === 0) return [];

  const byGroup = new Map();

  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i];
    const meta = parseTosecReleaseInfo(row.name);
    const fileEntry = {
      id: row.slug,
      name: `${row.name}.zip`,
      sizeLabel: row.sizeLabel,
      sizeBytes: row.sizeBytes,
      diskNumber: meta.diskNumber,
      diskTotal: meta.diskTotal,
      isBadDump: meta.isBadDump,
      isVerified: meta.isVerified,
      proxyDownloadUrl: buildDownloadUrl(row),
    };

    let group = byGroup.get(meta.groupKey);
    if (!group) {
      group = {
        id: `pe:${row.slug}`,
        title: meta.title,
        year: meta.year,
        firms: meta.publisher ? [meta.publisher] : [],
        tags: meta.tags,
        diskCount: 1,
        files: [],
        coverPath: null,
        coverUrl: null,
        proxyCoverUrl: null,
        proxyDownloadUrl: fileEntry.proxyDownloadUrl,
      };
      byGroup.set(meta.groupKey, group);
    }
    group.files.push(fileEntry);
  }

  const groups = Array.from(byGroup.values());
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (g.files.length > 1) {
      g.files.sort((a, b) => {
        const da = a.diskNumber ?? 9999;
        const db = b.diskNumber ?? 9999;
        if (da !== db) return da - db;
        if (a.isBadDump !== b.isBadDump) return a.isBadDump ? 1 : -1;
        if (a.isVerified !== b.isVerified) return a.isVerified ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    }
    let maxDiskTotal = 0;
    const distinctDisks = new Set();
    for (let j = 0; j < g.files.length; j++) {
      const f = g.files[j];
      if (f.diskTotal && f.diskTotal > maxDiskTotal) maxDiskTotal = f.diskTotal;
      if (f.diskNumber !== null) distinctDisks.add(f.diskNumber);
    }
    g.diskCount = Math.max(1, maxDiskTotal, distinctDisks.size);
    g.id = `pe:${g.files[0].id}`;
    g.proxyDownloadUrl = g.files[0].proxyDownloadUrl;
  }

  return groups;
}

export function paginatePlanetemuGroups(groups, page = 1, pageSize = DEFAULT_PAGE_SIZE) {
  const safeSize = Number.isFinite(pageSize)
    ? Math.min(MAX_PAGE_SIZE, Math.max(12, Math.floor(pageSize)))
    : DEFAULT_PAGE_SIZE;
  const totalItems = groups.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / safeSize));
  const safePage = Math.min(totalPages, Math.max(1, Number.isFinite(page) ? Math.floor(page) : 1));
  const start = (safePage - 1) * safeSize;
  return {
    items: groups.slice(start, start + safeSize),
    page: safePage,
    totalPages,
    totalItems,
    hasPrev: safePage > 1,
    hasNext: safePage < totalPages,
  };
}

export function extractQueryLetter(query) {
  if (typeof query !== 'string') return null;
  const trimmed = query.trim().replace(/^['"]+/, '');
  if (!trimmed) return null;
  const first = trimmed[0];
  if (/[0-9]/.test(first)) return '0';
  const upper = first.toUpperCase();
  if (upper >= 'A' && upper <= 'Z') return upper;
  return null;
}

export function filterPlanetemuRowsByQuery(rows, query) {
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return rows;
  return rows.filter((row) => {
    const lower = row.name.toLowerCase();
    for (let i = 0; i < tokens.length; i++) {
      if (!lower.includes(tokens[i])) return false;
    }
    return true;
  });
}

export function extractPlanetemuDownloadInfo(html) {
  if (typeof html !== 'string' || !html) return null;
  const idMatch = html.match(/<input[^>]+name=["']id["'][^>]+value=["'](\d+)["']/i)
    || html.match(/<input[^>]+value=["'](\d+)["'][^>]+name=["']id["']/i);
  if (!idMatch?.[1]) return null;

  const fileMatch = html.match(/data-filename=["']([^"']+)["']/i);
  const filename = fileMatch?.[1] ? decodeHtmlEntities(fileMatch[1].trim()) : null;
  return { id: idMatch[1], filename };
}

async function getOrFetchLetterEntry(letter, { signal } = {}) {
  const safeLetter = normalizePlanetemuLetter(letter);
  const now = Date.now();
  const cached = letterCache.get(safeLetter);
  if (cached && cached.expiresAt > now) {
    return cached;
  }

  const upstreamUrl = `${PLANETEMU_ORIGIN}/en/roms/${PLANETEMU_ROMSET}?page=${encodeURIComponent(safeLetter)}`;
  const resp = await fetch(upstreamUrl, {
    headers: {
      ...PLANETEMU_BROWSER_HEADERS,
      Referer: `${PLANETEMU_ORIGIN}/en/roms/${PLANETEMU_ROMSET}`,
    },
    signal,
  });
  const html = await resp.text();
  if (!resp.ok || isPlanetemuBlockedResponse(resp, html)) {
    const err = new Error(`Planetemu returned HTTP ${resp.status}`);
    err.status = resp.status;
    err.blocked = isPlanetemuBlockedResponse(resp, html);
    throw err;
  }
  const rows = parsePlanetemuListHtml(html);

  if (letterCache.has(safeLetter)) {
    letterCache.delete(safeLetter);
  } else if (letterCache.size >= MAX_LETTER_CACHE) {
    const oldest = letterCache.keys().next().value;
    if (oldest !== undefined) letterCache.delete(oldest);
  }
  const entry = { expiresAt: now + LETTER_CACHE_TTL_MS, rows, groups: null };
  letterCache.set(safeLetter, entry);
  return entry;
}

export async function fetchPlanetemuLetterRows(letter, opts = {}) {
  const entry = await getOrFetchLetterEntry(letter, opts);
  return entry.rows;
}

export async function fetchPlanetemuLetterGroups(letter, opts = {}) {
  const entry = await getOrFetchLetterEntry(letter, opts);
  if (!entry.groups) {
    entry.groups = groupPlanetemuRoms(entry.rows);
  }
  return entry.groups;
}

export async function searchPlanetemuRows(query, { signal } = {}) {
  const firstLetter = extractQueryLetter(query);
  const searchUrl = `${PLANETEMU_ORIGIN}/en/recherche/roms?q=${encodeURIComponent(query)}&page=1`;

  const [letterResult, searchResult] = await Promise.allSettled([
    firstLetter ? fetchPlanetemuLetterRows(firstLetter, { signal }) : Promise.resolve(null),
    fetch(searchUrl, {
      headers: {
        ...PLANETEMU_BROWSER_HEADERS,
        Referer: `${PLANETEMU_ORIGIN}/en/roms/${PLANETEMU_ROMSET}`,
      },
      signal,
    }).then(async (resp) => {
      const html = await resp.text();
      if (!resp.ok || isPlanetemuBlockedResponse(resp, html)) {
        const err = new Error(`Planetemu search returned HTTP ${resp.status}`);
        err.status = resp.status;
        err.blocked = isPlanetemuBlockedResponse(resp, html);
        throw err;
      }
      return parsePlanetemuSearchHtml(html);
    }),
  ]);

  const letterSucceeded = letterResult.status === 'fulfilled' && Array.isArray(letterResult.value);
  const searchSucceeded = searchResult.status === 'fulfilled' && Array.isArray(searchResult.value);

  if (firstLetter && letterResult.status === 'rejected' && letterResult.reason?.blocked) {
    throw letterResult.reason;
  }

  if (!letterSucceeded && !searchSucceeded) {
    if (searchResult.status === 'rejected') throw searchResult.reason;
    if (letterResult.status === 'rejected') throw letterResult.reason;
  }

  const bySlug = new Map();
  if (letterSucceeded) {
    for (const row of filterPlanetemuRowsByQuery(letterResult.value, query)) {
      bySlug.set(row.slug, row);
    }
  }
  if (searchSucceeded) {
    for (const row of filterPlanetemuRowsByQuery(searchResult.value, query)) {
      if (!bySlug.has(row.slug)) {
        bySlug.set(row.slug, row);
      }
    }
  }

  if (bySlug.size === 0) {
    if (letterResult.status === 'rejected') throw letterResult.reason;
    if (searchResult.status === 'rejected') throw searchResult.reason;
  }

  return Array.from(bySlug.values());
}

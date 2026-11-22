export const UPSTREAM_ORIGIN = 'https://amiga500archive.com';

export const ALLOWED_CATEGORIES = new Set([
  'recent',
  'top',
  'games',
  'originals',
  'demos',
  'tools',
]);

const DOWNLOAD_ID_RE = /^[A-Za-z0-9_-]{4,32}$/;
const COVER_PATH_RE = /^files\/_images\/[A-Za-z0-9_./-]+\.(png|jpe?g|gif|webp)$/i;

const HTML_ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

export function decodeHtmlEntities(input) {
  if (!input) return '';
  return input
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => HTML_ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : '';
    });
}

export function isValidDownloadId(id) {
  return typeof id === 'string' && DOWNLOAD_ID_RE.test(id);
}

export function normalizeCoverPath(rawPath) {
  if (typeof rawPath !== 'string') return null;
  const cleaned = rawPath.trim().replace(/^\/+/, '');
  if (!cleaned || cleaned.includes('..') || cleaned.includes('\\') || cleaned.includes('://')) {
    return null;
  }
  return COVER_PATH_RE.test(cleaned) ? cleaned : null;
}

export function buildUpstreamCatalogUrl({ category = 'games', query = '', page = 1 } = {}) {
  const safeQuery = typeof query === 'string' ? query.trim().slice(0, 100) : '';
  const safePage = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;

  if (safeQuery) {
    const params = new URLSearchParams({ search: safeQuery });
    if (safePage > 1) params.set('page', String(safePage));
    return `${UPSTREAM_ORIGIN}/items.php?${params.toString()}`;
  }

  const safeCategory = ALLOWED_CATEGORIES.has(category) ? category : 'games';
  if (safeCategory === 'recent') {
    return `${UPSTREAM_ORIGIN}/`;
  }

  const params = new URLSearchParams({ category: safeCategory });
  if (safePage > 1) params.set('page', String(safePage));
  return `${UPSTREAM_ORIGIN}/items.php?${params.toString()}`;
}

/**
 * Lightweight, low-CPU parser for amiga500archive.com listing HTML.
 * Splits by `<div class="w-layout-hflex item-line">` instead of catastrophic regexes.
 */
export function parseCatalogHtml(html, currentPage = 1) {
  if (typeof html !== 'string' || !html) {
    return { items: [], totalPages: 1, page: 1, hasPrev: false, hasNext: false };
  }

  const chunks = html.split('<div class="w-layout-hflex item-line">');
  const items = [];

  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i];
    const dlMatch = chunk.match(/href="dl\.php\?id=([A-Za-z0-9_-]{4,32})"/i);
    if (!dlMatch) continue;

    const id = dlMatch[1];
    const titleMatch = chunk.match(/<div\s+class="title">([\s\S]*?)<\/div>/i);
    const title = decodeHtmlEntities((titleMatch?.[1] ?? '').replace(/<[^>]+>/g, '').trim());
    if (!title) continue;

    const imgMatch = chunk.match(/<img[^>]+src="([^"]+)"/i);
    const coverPath = normalizeCoverPath(imgMatch?.[1] ?? '');

    const firmsBlockMatch = chunk.match(/<div\s+class="item-firms">([\s\S]*?)<\/div>\s*<\/div>/i);
    const firms = [];
    if (firmsBlockMatch) {
      const linkRe = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
      let m;
      while ((m = linkRe.exec(firmsBlockMatch[1])) !== null) {
        const firm = decodeHtmlEntities(m[1].replace(/<[^>]+>/g, '').trim());
        if (firm) firms.push(firm);
      }
    }

    items.push({
      id,
      title,
      firms,
      coverPath,
      coverUrl: coverPath ? `${UPSTREAM_ORIGIN}/${coverPath}` : null,
      proxyCoverUrl: coverPath ? `/api/cover?path=${encodeURIComponent(coverPath)}` : null,
      proxyDownloadUrl: `/api/download?id=${encodeURIComponent(id)}`,
    });
  }

  // Parse pagination max page from `<div id="links">...</div>`
  let totalPages = Math.max(1, currentPage);
  const linksIdx = html.indexOf('<div id="links">');
  if (linksIdx !== -1) {
    const linksCloseIdx = html.indexOf('</div>', linksIdx);
    const linksHtml =
      linksCloseIdx !== -1 ? html.slice(linksIdx, linksCloseIdx) : html.slice(linksIdx, linksIdx + 8192);
    const pageRe = /[?&]page=(\d+)/gi;
    let pm;
    while ((pm = pageRe.exec(linksHtml)) !== null) {
      const p = Number.parseInt(pm[1], 10);
      if (Number.isFinite(p) && p > totalPages) totalPages = p;
    }
  }

  return {
    items,
    page: Math.max(1, currentPage),
    totalPages,
    hasPrev: currentPage > 1,
    hasNext: currentPage < totalPages,
  };
}

export function extractDownloadFilename(contentDisposition, fallbackId) {
  if (typeof contentDisposition === 'string' && contentDisposition) {
    const utf8Match = contentDisposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
    if (utf8Match?.[1]) {
      try {
        const decoded = decodeURIComponent(utf8Match[1].trim()).replace(/["\r\n]/g, '');
        if (decoded) return decoded;
      } catch {
        // Fall through to standard filename=
      }
    }
    const plainMatch = contentDisposition.match(/filename\s*=\s*"?([^";\r\n]+)"?/i);
    if (plainMatch?.[1]) {
      const clean = plainMatch[1].trim();
      if (clean) return clean;
    }
  }
  return `${fallbackId}.zip`;
}

export function setCorsHeaders(req, res) {
  const configuredOrigin = process.env.ALLOWED_ORIGIN?.trim();
  const reqOrigin = req.headers?.origin;

  if (configuredOrigin && configuredOrigin !== '*') {
    const allowedList = configuredOrigin.split(',').map((s) => s.trim()).filter(Boolean);
    if (reqOrigin && allowedList.includes(reqOrigin)) {
      res.setHeader('Access-Control-Allow-Origin', reqOrigin);
      res.setHeader('Vary', 'Origin');
    } else if (allowedList.length > 0) {
      res.setHeader('Access-Control-Allow-Origin', allowedList[0]);
    }
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader(
    'Access-Control-Expose-Headers',
    'Content-Disposition, Content-Length, Content-Type, X-Archive-Filename'
  );
}

export function sendJson(req, res, statusCode, payload, cacheControl = 'no-store') {
  setCorsHeaders(req, res);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cacheControl);
  res.end(JSON.stringify(payload));
}

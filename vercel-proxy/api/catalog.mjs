import {
  ALLOWED_CATEGORIES,
  buildUpstreamCatalogUrl,
  parseCatalogHtml,
  sendJson,
  setCorsHeaders,
  UPSTREAM_ORIGIN,
} from '../lib/amiga500archive.mjs';
import {
  fetchPlanetemuLetterGroups,
  groupPlanetemuRoms,
  normalizePlanetemuLetter,
  paginatePlanetemuGroups,
  PLANETEMU_ORIGIN,
  searchPlanetemuRows,
} from '../lib/planetemu.mjs';
import {
  ARCHIVE_TOSEC_SOURCE_URL,
  fetchArchiveTosecLetterGroups,
  groupArchiveTosecRows,
  searchArchiveTosecRows,
} from '../lib/archiveTosec.mjs';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    setCorsHeaders(req, res);
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    sendJson(req, res, 405, { ok: false, error: 'Method not allowed' });
    return;
  }

  const url = new URL(req.url || '/', 'http://localhost');
  const source = (url.searchParams.get('source') || 'amiga500archive').toLowerCase();
  const query = (url.searchParams.get('q') || url.searchParams.get('search') || '').trim();
  const rawPage = Number.parseInt(url.searchParams.get('page') || '1', 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;

  if (source === 'archive-tosec') {
    const letter = normalizePlanetemuLetter(url.searchParams.get('letter') || '0');
    const rawPageSize = Number.parseInt(url.searchParams.get('pageSize') || '36', 10);

    try {
      const groups = query
        ? groupArchiveTosecRows(await searchArchiveTosecRows(query, { signal: AbortSignal.timeout(15000) }))
        : await fetchArchiveTosecLetterGroups(letter, { signal: AbortSignal.timeout(15000) });

      const paginated = paginatePlanetemuGroups(groups, page, rawPageSize);

      sendJson(
        req,
        res,
        200,
        {
          ok: true,
          source: ARCHIVE_TOSEC_SOURCE_URL,
          category: query ? 'search' : letter,
          query,
          ...paginated,
        },
        'public, s-maxage=600, stale-while-revalidate=1800'
      );
    } catch (err) {
      sendJson(req, res, 502, {
        ok: false,
        error: err instanceof Error ? err.message : 'Archive.org TOSEC upstream fetch failed',
      });
    }
    return;
  }

  if (source === 'planetemu') {
    const letter = normalizePlanetemuLetter(url.searchParams.get('letter') || '0');
    const rawPageSize = Number.parseInt(url.searchParams.get('pageSize') || '36', 10);

    try {
      const groups = query
        ? groupPlanetemuRoms(await searchPlanetemuRows(query, { signal: AbortSignal.timeout(10000) }))
        : await fetchPlanetemuLetterGroups(letter, { signal: AbortSignal.timeout(10000) });

      const paginated = paginatePlanetemuGroups(groups, page, rawPageSize);

      sendJson(
        req,
        res,
        200,
        {
          ok: true,
          source: PLANETEMU_ORIGIN,
          category: query ? 'search' : letter,
          query,
          ...paginated,
        },
        'public, s-maxage=600, stale-while-revalidate=1800'
      );
    } catch (planetemuErr) {
      try {
        const groups = query
          ? groupArchiveTosecRows(await searchArchiveTosecRows(query, { signal: AbortSignal.timeout(15000) }))
          : await fetchArchiveTosecLetterGroups(letter, { signal: AbortSignal.timeout(15000) });

        const paginated = paginatePlanetemuGroups(groups, page, rawPageSize);

        sendJson(
          req,
          res,
          200,
          {
            ok: true,
            source: ARCHIVE_TOSEC_SOURCE_URL,
            fallbackFrom: 'planetemu',
            category: query ? 'search' : letter,
            query,
            ...paginated,
          },
          'public, s-maxage=300, stale-while-revalidate=900'
        );
      } catch (fallbackErr) {
        sendJson(req, res, 502, {
          ok: false,
          error:
            planetemuErr instanceof Error
              ? `${planetemuErr.message}; fallback failed: ${fallbackErr instanceof Error ? fallbackErr.message : 'unknown'}`
              : 'Planetemu upstream fetch failed',
        });
      }
    }
    return;
  }

  const rawCategory = (url.searchParams.get('category') || 'games').toLowerCase();
  const category = ALLOWED_CATEGORIES.has(rawCategory) ? rawCategory : 'games';

  const upstreamUrl = buildUpstreamCatalogUrl({ category, query, page });

  try {
    const upstream = await fetch(upstreamUrl, {
      headers: {
        'User-Agent': 'Amiga500WebEmulator-Proxy/1.0',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(12000),
    });

    if (!upstream.ok) {
      sendJson(req, res, 502, {
        ok: false,
        error: `Upstream returned HTTP ${upstream.status}`,
      });
      return;
    }

    const html = await upstream.text();
    const parsed = parseCatalogHtml(html, page);

    sendJson(
      req,
      res,
      200,
      {
        ok: true,
        source: UPSTREAM_ORIGIN,
        category: query ? 'search' : category,
        query,
        ...parsed,
      },
      'public, s-maxage=300, stale-while-revalidate=600'
    );
  } catch (err) {
    sendJson(req, res, 502, {
      ok: false,
      error: err instanceof Error ? err.message : 'Upstream fetch failed',
    });
  }
}

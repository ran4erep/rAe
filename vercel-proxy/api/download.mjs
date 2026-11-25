import { Readable } from 'node:stream';
import {
  extractDownloadFilename,
  isValidDownloadId,
  sendJson,
  setCorsHeaders,
  UPSTREAM_ORIGIN,
} from '../lib/amiga500archive.mjs';
import {
  extractPlanetemuDownloadInfo,
  isPlanetemuBlockedResponse,
  isValidPlanetemuSlug,
  PLANETEMU_BROWSER_HEADERS,
  PLANETEMU_ORIGIN,
} from '../lib/planetemu.mjs';
import {
  buildArchiveTosecDownloadUrl,
  findArchiveTosecFileByPlanetemuSlug,
  isValidArchiveTosecFilename,
} from '../lib/archiveTosec.mjs';
import {
  buildArchiveWhdloadDownloadUrl,
  isValidWhdloadFilename,
} from '../lib/archiveWhdload.mjs';

async function streamArchiveWhdloadFile(req, res, fileName) {
  if (!isValidWhdloadFilename(fileName)) {
    sendJson(req, res, 400, { ok: false, error: 'Invalid or missing Archive.org WHDLoad filename' });
    return;
  }

  const upstreamUrl = buildArchiveWhdloadDownloadUrl(fileName);
  const upstream = await fetch(upstreamUrl, {
    headers: {
      'User-Agent': 'Amiga500WebEmulator-Proxy/1.0',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
  });

  if (!upstream.ok || !upstream.body) {
    sendJson(req, res, 502, {
      ok: false,
      error: `Archive.org WHDLoad download failed with HTTP ${upstream.status}`,
    });
    return;
  }

  const cleanFilename = fileName.trim();
  const isLha = cleanFilename.toLowerCase().endsWith('.lha');
  const contentType = upstream.headers.get('content-type') || (isLha ? 'application/x-lha' : 'application/zip');
  const contentLength = upstream.headers.get('content-length');

  setCorsHeaders(req, res);
  res.statusCode = 200;
  res.setHeader('Content-Type', contentType);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${cleanFilename.replace(/["\r\n]/g, '')}"; filename*=UTF-8''${encodeURIComponent(cleanFilename)}`
  );
  res.setHeader('X-Archive-Filename', encodeURIComponent(cleanFilename));
  if (contentLength && Number(contentLength) > 0) {
    res.setHeader('Content-Length', contentLength);
  }
  res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');

  Readable.fromWeb(upstream.body).pipe(res);
}

async function streamArchiveTosecFile(req, res, fileName) {
  if (!isValidArchiveTosecFilename(fileName)) {
    sendJson(req, res, 400, { ok: false, error: 'Invalid or missing Archive.org TOSEC filename' });
    return;
  }

  const upstreamUrl = buildArchiveTosecDownloadUrl(fileName);
  const upstream = await fetch(upstreamUrl, {
    headers: {
      'User-Agent': 'Amiga500WebEmulator-Proxy/1.0',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
  });

  if (!upstream.ok || !upstream.body) {
    sendJson(req, res, 502, {
      ok: false,
      error: `Archive.org TOSEC download failed with HTTP ${upstream.status}`,
    });
    return;
  }

  const cleanFilename = fileName.trim();
  const contentType = upstream.headers.get('content-type') || 'application/zip';
  const contentLength = upstream.headers.get('content-length');

  setCorsHeaders(req, res);
  res.statusCode = 200;
  res.setHeader('Content-Type', contentType);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${cleanFilename.replace(/["\r\n]/g, '')}"; filename*=UTF-8''${encodeURIComponent(cleanFilename)}`
  );
  res.setHeader('X-Archive-Filename', encodeURIComponent(cleanFilename));
  if (contentLength && Number(contentLength) > 0) {
    res.setHeader('Content-Length', contentLength);
  }
  res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');

  Readable.fromWeb(upstream.body).pipe(res);
}

async function tryFallbackPlanetemuDownloadBySlug(req, res, slug) {
  try {
    const matched = await findArchiveTosecFileByPlanetemuSlug(slug, {
      signal: AbortSignal.timeout(12000),
    });
    if (!matched) return false;
    await streamArchiveTosecFile(req, res, matched.fileName);
    return true;
  } catch {
    return false;
  }
}

function collectCookieHeader(headers) {
  if (!headers) return '';
  const list = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : headers.get('set-cookie')
      ? [headers.get('set-cookie')]
      : [];
  return list
    .map((entry) => String(entry).split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

async function handlePlanetemuDownload(req, res, slug) {
  if (!isValidPlanetemuSlug(slug)) {
    sendJson(req, res, 400, { ok: false, error: 'Invalid or missing planetemu ROM slug' });
    return;
  }

  const romPageUrl = `${PLANETEMU_ORIGIN}/en/rom/${slug}`;
  let pageResp;
  try {
    pageResp = await fetch(romPageUrl, {
      headers: {
        ...PLANETEMU_BROWSER_HEADERS,
        Referer: `${PLANETEMU_ORIGIN}/en/roms/commodore-amiga-games-adf`,
      },
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    if (await tryFallbackPlanetemuDownloadBySlug(req, res, slug)) return;
    throw err;
  }

  const pageHtml = await pageResp.text();
  if (!pageResp.ok || isPlanetemuBlockedResponse(pageResp, pageHtml)) {
    if (await tryFallbackPlanetemuDownloadBySlug(req, res, slug)) return;
    sendJson(req, res, pageResp.status === 403 ? 403 : 502, {
      ok: false,
      error: `Planetemu ROM page returned HTTP ${pageResp.status}`,
    });
    return;
  }

  const cookies = collectCookieHeader(pageResp.headers);
  const dlInfo = extractPlanetemuDownloadInfo(pageHtml);
  if (!dlInfo) {
    if (await tryFallbackPlanetemuDownloadBySlug(req, res, slug)) return;
    sendJson(req, res, 502, {
      ok: false,
      error: 'Could not extract download ID from Planetemu ROM page',
    });
    return;
  }

  const postHeaders = {
    'User-Agent': PLANETEMU_BROWSER_HEADERS['User-Agent'],
    Accept: PLANETEMU_BROWSER_HEADERS.Accept,
    'Accept-Language': PLANETEMU_BROWSER_HEADERS['Accept-Language'],
    'Content-Type': 'application/x-www-form-urlencoded',
    Origin: PLANETEMU_ORIGIN,
    Referer: romPageUrl,
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
  };
  if (cookies) postHeaders.Cookie = cookies;

  let fileResp = await fetch(`${PLANETEMU_ORIGIN}/download/rom`, {
    method: 'POST',
    headers: postHeaders,
    body: `id=${encodeURIComponent(dlInfo.id)}&download=Download`,
    redirect: 'manual',
    signal: AbortSignal.timeout(20000),
  });

  if (fileResp.status >= 300 && fileResp.status < 400) {
    const loc = fileResp.headers.get('location');
    if (!loc) {
      if (await tryFallbackPlanetemuDownloadBySlug(req, res, slug)) return;
      sendJson(req, res, 502, { ok: false, error: 'Planetemu redirect missing location' });
      return;
    }
    const nextUrl = loc.startsWith('http') ? loc : `${PLANETEMU_ORIGIN}${loc.startsWith('/') ? '' : '/'}${loc}`;
    const nextCookies = collectCookieHeader(fileResp.headers) || cookies;
    const getHeaders = {
      'User-Agent': PLANETEMU_BROWSER_HEADERS['User-Agent'],
      Accept: '*/*',
      'Accept-Language': PLANETEMU_BROWSER_HEADERS['Accept-Language'],
      Referer: romPageUrl,
    };
    if (nextCookies) getHeaders.Cookie = nextCookies;
    fileResp = await fetch(nextUrl, {
      method: 'GET',
      headers: getHeaders,
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
  }

  const contentType = fileResp.headers.get('content-type') || 'application/octet-stream';
  if (!fileResp.ok || !fileResp.body || contentType.includes('text/html')) {
    if (await tryFallbackPlanetemuDownloadBySlug(req, res, slug)) return;
    if (fileResp.status === 429 || contentType.includes('text/html')) {
      sendJson(req, res, 429, {
        ok: false,
        error: 'Planetemu временно ограничил частоту скачивания. Подождите немного и попробуйте снова.',
      });
      return;
    }
    sendJson(req, res, 502, {
      ok: false,
      error: `Planetemu download failed with HTTP ${fileResp.status}`,
    });
    return;
  }

  const contentDisposition = fileResp.headers.get('content-disposition');
  const fallbackName = dlInfo.filename || `${slug.split('/').pop() || dlInfo.id}.zip`;
  const filename = contentDisposition
    ? extractDownloadFilename(contentDisposition, dlInfo.id)
    : fallbackName;
  const contentLength = fileResp.headers.get('content-length');

  setCorsHeaders(req, res);
  res.statusCode = 200;
  res.setHeader('Content-Type', contentType);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${filename.replace(/["\r\n]/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  res.setHeader('X-Archive-Filename', encodeURIComponent(filename));
  if (contentLength && Number(contentLength) > 0) {
    res.setHeader('Content-Length', contentLength);
  }
  res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');

  Readable.fromWeb(fileResp.body).pipe(res);
}

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

  if (source === 'whdload' || source === 'archive-whdload') {
    const fileName = (url.searchParams.get('file') || '').trim();
    try {
      await streamArchiveWhdloadFile(req, res, fileName);
    } catch (err) {
      sendJson(req, res, 502, {
        ok: false,
        error: err instanceof Error ? err.message : 'Archive.org WHDLoad download stream error',
      });
    }
    return;
  }

  if (source === 'archive-tosec') {
    const fileName = (url.searchParams.get('file') || '').trim();
    try {
      await streamArchiveTosecFile(req, res, fileName);
    } catch (err) {
      sendJson(req, res, 502, {
        ok: false,
        error: err instanceof Error ? err.message : 'Archive.org TOSEC download stream error',
      });
    }
    return;
  }

  if (source === 'planetemu') {
    const slug = (url.searchParams.get('slug') || '').trim();
    try {
      await handlePlanetemuDownload(req, res, slug);
    } catch (err) {
      sendJson(req, res, 502, {
        ok: false,
        error: err instanceof Error ? err.message : 'Planetemu download stream error',
      });
    }
    return;
  }

  const id = (url.searchParams.get('id') || '').trim();
  if (!isValidDownloadId(id)) {
    sendJson(req, res, 400, { ok: false, error: 'Invalid or missing archive id' });
    return;
  }

  const upstreamUrl = `${UPSTREAM_ORIGIN}/dl.php?id=${encodeURIComponent(id)}`;

  try {
    const upstream = await fetch(upstreamUrl, {
      headers: {
        'User-Agent': 'Amiga500WebEmulator-Proxy/1.0',
        Referer: `${UPSTREAM_ORIGIN}/`,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(25000),
    });

    if (!upstream.ok || !upstream.body) {
      sendJson(req, res, 502, {
        ok: false,
        error: `Upstream download failed with HTTP ${upstream.status}`,
      });
      return;
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const contentDisposition = upstream.headers.get('content-disposition');
    const filename = extractDownloadFilename(contentDisposition, id);
    const contentLength = upstream.headers.get('content-length');

    setCorsHeaders(req, res);
    res.statusCode = 200;
    res.setHeader('Content-Type', contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename.replace(/["\r\n]/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}`
    );
    res.setHeader('X-Archive-Filename', encodeURIComponent(filename));
    if (contentLength && Number(contentLength) > 0) {
      res.setHeader('Content-Length', contentLength);
    }
    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');

    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    sendJson(req, res, 502, {
      ok: false,
      error: err instanceof Error ? err.message : 'Download stream error',
    });
  }
}

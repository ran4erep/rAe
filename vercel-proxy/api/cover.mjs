import { Readable } from 'node:stream';
import {
  normalizeCoverPath,
  sendJson,
  setCorsHeaders,
  UPSTREAM_ORIGIN,
} from '../lib/amiga500archive.mjs';

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
  const safePath = normalizeCoverPath(url.searchParams.get('path') || '');
  if (!safePath) {
    sendJson(req, res, 400, { ok: false, error: 'Invalid cover path' });
    return;
  }

  const upstreamUrl = `${UPSTREAM_ORIGIN}/${safePath}`;

  try {
    const upstream = await fetch(upstreamUrl, {
      headers: {
        'User-Agent': 'Amiga500WebEmulator-Proxy/1.0',
        Referer: `${UPSTREAM_ORIGIN}/`,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!upstream.ok || !upstream.body) {
      sendJson(req, res, upstream.status === 404 ? 404 : 502, {
        ok: false,
        error: `Cover fetch failed with HTTP ${upstream.status}`,
      });
      return;
    }

    setCorsHeaders(req, res);
    res.statusCode = 200;
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/png');
    res.setHeader('Cache-Control', 'public, s-maxage=604800, max-age=86400');

    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    sendJson(req, res, 502, {
      ok: false,
      error: err instanceof Error ? err.message : 'Cover stream error',
    });
  }
}

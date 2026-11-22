import { sendJson, setCorsHeaders } from '../lib/amiga500archive.mjs';

export default function handler(req, res) {
  if (req.method === 'OPTIONS') {
    setCorsHeaders(req, res);
    res.statusCode = 204;
    res.end();
    return;
  }

  sendJson(req, res, 200, {
    ok: true,
    service: 'amiga500archive-proxy',
    endpoints: [
      '/api/catalog?category=games&page=1',
      '/api/catalog?q=turrican',
      '/api/catalog?source=planetemu&letter=0&page=1',
      '/api/catalog?source=planetemu&q=turrican&page=1',
      '/api/catalog?source=archive-tosec&letter=0&page=1',
      '/api/cover?path=files/_images/games/hyperion.png',
      '/api/download?id=KHJFEIKKME',
      '/api/download?source=planetemu&slug=commodore-amiga-games-adf/...',
      '/api/download?source=archive-tosec&file=...',
    ],
    timestamp: new Date().toISOString(),
  });
}

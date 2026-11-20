import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCatalogApiUrl,
  CatalogMemoryCache,
  CatalogPageResponse,
  decodeHeaderFilename,
  resolveCatalogCoverUrl,
  resolveCatalogDownloadUrl,
} from './amigaArchiveCatalog';

test('buildCatalogApiUrl constructs category and search URLs accurately', () => {
  assert.equal(
    buildCatalogApiUrl('https://amiga-proxy.vercel.app/', {
      category: 'games',
      query: '',
      page: 2,
    }),
    'https://amiga-proxy.vercel.app/api/catalog?category=games&page=2'
  );

  assert.equal(
    buildCatalogApiUrl('https://amiga-proxy.vercel.app', {
      category: 'games',
      query: '  turrican ',
      page: 1,
    }),
    'https://amiga-proxy.vercel.app/api/catalog?q=turrican&page=1'
  );
});

test('resolveCatalogCoverUrl and resolveCatalogDownloadUrl resolve proxy paths cleanly', () => {
  const item = {
    id: 'LKFEEKKLKF',
    title: '1000 Miglia',
    firms: ['Simulmondo'],
    coverPath: 'files/_images/games/1000_miglia.png',
    coverUrl: 'https://amiga500archive.com/files/_images/games/1000_miglia.png',
    proxyCoverUrl: '/api/cover?path=files%2F_images%2Fgames%2F1000_miglia.png',
    proxyDownloadUrl: '/api/download?id=LKFEEKKLKF',
  };

  assert.equal(
    resolveCatalogCoverUrl('https://amiga-proxy.vercel.app/', item),
    'https://amiga-proxy.vercel.app/api/cover?path=files%2F_images%2Fgames%2F1000_miglia.png'
  );
  assert.equal(
    resolveCatalogDownloadUrl('https://amiga-proxy.vercel.app/', item),
    'https://amiga-proxy.vercel.app/api/download?id=LKFEEKKLKF'
  );
});

test('decodeHeaderFilename prefers X-Archive-Filename and UTF-8 Content-Disposition', () => {
  assert.equal(
    decodeHeaderFilename('1000%20Miglia%20(Simulmondo).zip', null, '1000 Miglia'),
    '1000 Miglia (Simulmondo).zip'
  );
  assert.equal(
    decodeHeaderFilename(
      null,
      'attachment; filename="Hyperion.zip"; filename*=UTF-8\'\'Hyperion%20(Offence).zip',
      'Hyperion'
    ),
    'Hyperion (Offence).zip'
  );
  assert.equal(
    decodeHeaderFilename(null, null, 'Turrican II / ECS'),
    'Turrican II _ ECS.zip'
  );
});

test('CatalogMemoryCache caches hits within TTL and expires stale entries', () => {
  const cache = new CatalogMemoryCache();
  const payload: CatalogPageResponse = {
    ok: true,
    source: 'https://amiga500archive.com',
    category: 'games',
    query: '',
    page: 1,
    totalPages: 72,
    hasPrev: false,
    hasNext: true,
    items: [],
  };

  cache.set('k1', payload, 1000);
  assert.deepEqual(cache.get('k1', 2000), payload);
  assert.equal(cache.get('k1', 1000 + 3 * 60 * 1000 + 1), null);
});

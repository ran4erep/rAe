import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCatalogApiUrl,
  CATALOG_SOURCES,
  CatalogMemoryCache,
  CatalogPageResponse,
  decodeHeaderFilename,
  DEFAULT_CATALOG_PROXY_URL,
  getDefaultCatalogProxyBase,
  makeCatalogCacheKey,
  resolveCatalogCoverUrl,
  resolveCatalogDownloadUrl,
} from './amigaArchiveCatalog';

test('CATALOG_SOURCES uses clean Planetemu label without (ADF)', () => {
  const pe = CATALOG_SOURCES.find((s) => s.id === 'planetemu');
  assert.ok(pe);
  assert.equal(pe.label, 'Planetemu');
});

test('getDefaultCatalogProxyBase uses Vercel proxy even in DEV unless explicitly overridden', () => {
  assert.equal(getDefaultCatalogProxyBase({ DEV: true }), DEFAULT_CATALOG_PROXY_URL);
  assert.equal(getDefaultCatalogProxyBase({ DEV: false }), DEFAULT_CATALOG_PROXY_URL);
  assert.equal(getDefaultCatalogProxyBase({ DEV: true, VITE_CATALOG_PROXY_URL: 'local' }), '');
  assert.equal(getDefaultCatalogProxyBase({ DEV: true, VITE_CATALOG_PROXY_URL: '/' }), '');
  assert.equal(
    getDefaultCatalogProxyBase({ DEV: true, VITE_CATALOG_PROXY_URL: 'https://custom.example.com/' }),
    'https://custom.example.com'
  );
});

test('buildCatalogApiUrl constructs category, planetemu letter, and search URLs accurately', () => {
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

  assert.equal(
    buildCatalogApiUrl('https://amiga-proxy.vercel.app/', {
      source: 'planetemu',
      category: 'games',
      letter: 'T',
      query: '',
      page: 3,
    }),
    'https://amiga-proxy.vercel.app/api/catalog?source=planetemu&letter=T&page=3'
  );

  assert.equal(
    buildCatalogApiUrl('', {
      source: 'planetemu',
      category: 'games',
      letter: '0',
      query: 'aladdin',
      page: 1,
    }),
    '/api/catalog?source=planetemu&q=aladdin&page=1'
  );

  assert.notEqual(
    makeCatalogCacheKey('', 'amiga500archive', 'games', '', 1),
    makeCatalogCacheKey('', 'planetemu', '0', '', 1)
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

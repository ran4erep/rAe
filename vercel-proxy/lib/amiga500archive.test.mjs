import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildUpstreamCatalogUrl,
  extractDownloadFilename,
  isValidDownloadId,
  normalizeCoverPath,
  parseCatalogHtml,
} from './amiga500archive.mjs';

const SAMPLE_HTML = `
<section class="s">
  <div class="w-layout-blockcontainer c w-container">
    <div class="w-layout-hflex item-line">
      <div class="item-img">
        <a href="files/_images/games/hyperion.png" target="_blank" class="item-imglink w-inline-block"><img src="files/_images/games/hyperion.png" loading="lazy" alt="" class="item-imgimg"></a>
      </div>
      <div class="item-title">
        <a href="files/_images/games/hyperion.png" target="_blank" class="item-titlelink w-inline-block">
          <div class="title">Hyperion</div>
        </a>
      </div>
      <div class="item-firms">
        <div><a href="items.php?search=Offence">Offence</a> + <a href="items.php?search=Black Legend">Black Legend</a></div>
      </div>
      <div class="item-dl">
        <a href="dl.php?id=KHJFEIKKME" class="item-dllink">Download</a>
      </div>
    </div>
    <div class="w-layout-hflex item-line">
      <div class="item-img">
        <a href="files/_images/games/turrican.png"><img src="files/_images/games/turrican.png" class="item-imgimg"></a>
      </div>
      <div class="item-title">
        <div class="title">Turrican &amp; Co</div>
      </div>
      <div class="item-firms">
        <div><a href="items.php?search=Factor 5">Factor 5</a></div>
      </div>
      <div class="item-dl">
        <a href="dl.php?id=LDEHJGEJJ" class="item-dllink">Download</a>
      </div>
    </div>
    <div id="links">[&nbsp;1&nbsp;] <a href='items.php?category=games&page=2'>[&nbsp;2&nbsp;]</a> <a href='items.php?category=games&page=72'>[&nbsp;72&nbsp;]</a></div>
  </div>
</section>
`;

test('parseCatalogHtml extracts titles, firms, cover paths, download ids, and pagination', () => {
  const parsed = parseCatalogHtml(SAMPLE_HTML, 1);
  assert.equal(parsed.page, 1);
  assert.equal(parsed.totalPages, 72);
  assert.equal(parsed.hasPrev, false);
  assert.equal(parsed.hasNext, true);
  assert.equal(parsed.items.length, 2);

  assert.deepEqual(parsed.items[0], {
    id: 'KHJFEIKKME',
    title: 'Hyperion',
    firms: ['Offence', 'Black Legend'],
    coverPath: 'files/_images/games/hyperion.png',
    coverUrl: 'https://amiga500archive.com/files/_images/games/hyperion.png',
    proxyCoverUrl: '/api/cover?path=files%2F_images%2Fgames%2Fhyperion.png',
    proxyDownloadUrl: '/api/download?id=KHJFEIKKME',
  });

  assert.equal(parsed.items[1].title, 'Turrican & Co');
  assert.equal(parsed.items[1].id, 'LDEHJGEJJ');
});

test('security validators block traversal and arbitrary URLs while accepting valid tokens', () => {
  assert.equal(isValidDownloadId('KHJFEIKKME'), true);
  assert.equal(isValidDownloadId('../../etc/passwd'), false);
  assert.equal(isValidDownloadId('https://evil.com'), false);

  assert.equal(normalizeCoverPath('files/_images/demos/batmanrises.jpg'), 'files/_images/demos/batmanrises.jpg');
  assert.equal(normalizeCoverPath('files/_images/../secret.png'), null);
  assert.equal(normalizeCoverPath('https://evil.com/x.png'), null);

  assert.equal(
    buildUpstreamCatalogUrl({ category: 'games', page: 3 }),
    'https://amiga500archive.com/items.php?category=games&page=3'
  );
  assert.equal(
    buildUpstreamCatalogUrl({ query: 'turrican', page: 1 }),
    'https://amiga500archive.com/items.php?search=turrican'
  );
  assert.equal(
    extractDownloadFilename('attachment; filename=Hyperion (Offence + Kompart).zip', 'KHJFEIKKME'),
    'Hyperion (Offence + Kompart).zip'
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPlanetemuDownloadInfo,
  extractPlanetemuSlug,
  extractQueryLetter,
  filterPlanetemuRowsByQuery,
  groupPlanetemuRoms,
  isValidPlanetemuSlug,
  normalizePlanetemuLetter,
  paginatePlanetemuGroups,
  parsePlanetemuListHtml,
  parsePlanetemuSearchHtml,
  parseSizeToBytes,
} from './planetemu.mjs';

const SAMPLE_LIST_HTML = `
<table class="rom-list">
  <tbody>
    <tr class="" data-name="'allo 'allo! cartoon fun! (1993)(alternative)(disk 1 of 2)[cr csl]">
      <td class="rom-list-name">
        <a href="/en/rom/commodore-amiga-games-adf/allo-allo-cartoon-fun-1993-alternative-disk-1-of-2-cr-csl">&#039;Allo &#039;Allo! Cartoon Fun! (1993)(Alternative)(Disk 1 of 2)[cr CSL]</a>
      </td>
      <td class="taillerom">361 KB</td>
    </tr>
    <tr class="" data-name="'allo 'allo! cartoon fun! (1993)(alternative)(disk 1 of 2)[cr csl][b doscopy]">
      <td class="rom-list-name">
        <a href="/en/rom/commodore-amiga-games-adf/allo-allo-cartoon-fun-1993-alternative-disk-1-of-2-cr-csl-b-doscopy">&#039;Allo &#039;Allo! Cartoon Fun! (1993)(Alternative)(Disk 1 of 2)[cr CSL][b doscopy]</a>
      </td>
      <td class="taillerom">361 KB</td>
    </tr>
    <tr class="" data-name="'allo 'allo! cartoon fun! (1993)(alternative)(disk 2 of 2)[cr csl]">
      <td class="rom-list-name">
        <a href="/en/rom/commodore-amiga-games-adf/allo-allo-cartoon-fun-1993-alternative-disk-2-of-2-cr-csl">&#039;Allo &#039;Allo! Cartoon Fun! (1993)(Alternative)(Disk 2 of 2)[cr CSL]</a>
      </td>
      <td class="taillerom">370 KB</td>
    </tr>
    <tr class="" data-name="samba partie (1996)(sayonara)(aga)(de)(a)">
      <td class="rom-list-name">
        <a href="/en/rom/commodore-amiga-games-adf/samba-partie-1996-sayonara-aga-de-a">Samba Partie (1996)(Sayonara)(AGA)(DE)(A)</a>
      </td>
      <td class="taillerom">450 KB</td>
    </tr>
    <tr class="" data-name="samba partie (1996)(sayonara)(aga)(de)(b)">
      <td class="rom-list-name">
        <a href="/en/rom/commodore-amiga-games-adf/samba-partie-1996-sayonara-aga-de-b">Samba Partie (1996)(Sayonara)(AGA)(DE)(B)</a>
      </td>
      <td class="taillerom">460 KB</td>
    </tr>
  </tbody>
</table>
`;

const SAMPLE_SEARCH_HTML = `
<ul class="search-results">
  <li class="search-result">
    <a class="search-result__title" href="/en/rom/panasonic-3do/lemmings-usa">Lemmings (USA)</a>
    <span class="search-result__size">352.67 MB</span>
  </li>
  <li class="search-result">
    <a class="search-result__title" href="/en/rom/commodore-amiga-games-adf/all-new-world-of-lemmings-1995-psygnosis-aga-disk-1-of-4-cr-hlm">All New World of Lemmings (1995)(Psygnosis)(AGA)(Disk 1 of 4)[cr HLM]</a>
    <span class="search-result__size">512 KB</span>
  </li>
</ul>
`;

test('parsePlanetemuListHtml extracts rows and groupPlanetemuRoms merges multi-disk releases', () => {
  const rows = parsePlanetemuListHtml(SAMPLE_LIST_HTML);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].name, "'Allo 'Allo! Cartoon Fun! (1993)(Alternative)(Disk 1 of 2)[cr CSL]");
  assert.equal(rows[0].sizeBytes, 361 * 1024);

  const groups = groupPlanetemuRoms(rows);
  assert.equal(groups.length, 2);

  assert.equal(groups[0].title, "'Allo 'Allo! Cartoon Fun!");
  assert.equal(groups[0].year, '1993');
  assert.deepEqual(groups[0].firms, ['Alternative']);
  assert.equal(groups[0].diskCount, 2);
  assert.equal(groups[0].files.length, 3);
  assert.equal(groups[0].files[0].diskNumber, 1);
  assert.equal(groups[0].files[0].isBadDump, false);
  assert.equal(groups[0].files[1].diskNumber, 1);
  assert.equal(groups[0].files[1].isBadDump, true);
  assert.equal(groups[0].files[2].diskNumber, 2);

  assert.equal(groups[1].title, 'Samba Partie');
  assert.equal(groups[1].year, '1996');
  assert.deepEqual(groups[1].firms, ['Sayonara']);
  assert.deepEqual(groups[1].tags, ['AGA', 'DE']);
  assert.equal(groups[1].diskCount, 2);
  assert.equal(groups[1].files.length, 2);
});

test('parsePlanetemuSearchHtml filters only commodore-amiga-games-adf entries', () => {
  const rows = parsePlanetemuSearchHtml(SAMPLE_SEARCH_HTML);
  assert.equal(rows.length, 1);
  assert.equal(
    rows[0].slug,
    'commodore-amiga-games-adf/all-new-world-of-lemmings-1995-psygnosis-aga-disk-1-of-4-cr-hlm'
  );
  assert.equal(rows[0].sizeLabel, '512 KB');
});

test('extractPlanetemuDownloadInfo extracts numeric form id and filename', () => {
  const html = `
    <form class="downloadForm" action="/download/rom" method="post" data-size="370101" data-filename="&#039;Allo &#039;Allo!.zip">
      <input type="hidden" name="id" value="828683">
    </form>
  `;
  const info = extractPlanetemuDownloadInfo(html);
  assert.deepEqual(info, { id: '828683', filename: "'Allo 'Allo!.zip" });
});

test('security validators, pagination, and query helpers work cleanly', () => {
  assert.equal(normalizePlanetemuLetter('0-9'), '0');
  assert.equal(normalizePlanetemuLetter('t'), 'T');
  assert.equal(normalizePlanetemuLetter('../etc'), '0');

  assert.equal(isValidPlanetemuSlug('commodore-amiga-games-adf/turrican-1990'), true);
  assert.equal(isValidPlanetemuSlug('panasonic-3do/lemmings'), false);
  assert.equal(isValidPlanetemuSlug('../../secret'), false);
  assert.equal(extractPlanetemuSlug('/en/rom/commodore-amiga-games-adf/test-1'), 'commodore-amiga-games-adf/test-1');

  assert.equal(parseSizeToBytes('1.5 MB'), Math.round(1.5 * 1024 * 1024));
  assert.equal(extractQueryLetter("'turrican"), 'T');
  assert.equal(extractQueryLetter('1000 miglia'), '0');

  const filtered = filterPlanetemuRowsByQuery(
    [
      { slug: 'a', name: 'Turrican II (1991)(Rainbow Arts)' },
      { slug: 'b', name: 'Bubble Bobble (1989)' },
    ],
    'turrican rainbow'
  );
  assert.equal(filtered.length, 1);

  const page1 = paginatePlanetemuGroups(Array.from({ length: 50 }, (_, i) => ({ id: i })), 1, 36);
  assert.equal(page1.items.length, 36);
  assert.equal(page1.totalPages, 2);
  assert.equal(page1.hasNext, true);
});

test('groupPlanetemuRoms merges releases with both (Disk X of Y) and trailing (A)/(B)', () => {
  const groups = groupPlanetemuRoms([
    {
      slug: 'commodore-amiga-games-adf/1869-1993-flair-aga-disk-1-of-4-a',
      name: '1869 (1993)(Flair)(AGA)(Disk 1 of 4)(A)',
      sizeLabel: '410 KB',
      sizeBytes: 410 * 1024,
    },
    {
      slug: 'commodore-amiga-games-adf/1869-1993-flair-aga-disk-2-of-4-b',
      name: '1869 (1993)(Flair)(AGA)(Disk 2 of 4)(B)',
      sizeLabel: '420 KB',
      sizeBytes: 420 * 1024,
    },
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, '1869');
  assert.equal(groups[0].year, '1993');
  assert.deepEqual(groups[0].firms, ['Flair']);
  assert.deepEqual(groups[0].tags, ['AGA']);
  assert.equal(groups[0].diskCount, 4);
  assert.equal(groups[0].files.length, 2);
  assert.equal(groups[0].files[0].diskNumber, 1);
  assert.equal(groups[0].files[1].diskNumber, 2);
});

test('isPlanetemuBlockedResponse detects Cloudflare 403/503 challenges and interstitial HTML', async () => {
  const { isPlanetemuBlockedResponse } = await import('./planetemu.mjs');

  assert.equal(isPlanetemuBlockedResponse({ status: 403, headers: new Headers() }, ''), true);
  assert.equal(
    isPlanetemuBlockedResponse(
      { status: 200, headers: new Headers({ 'cf-mitigated': 'challenge' }) },
      ''
    ),
    true
  );
  assert.equal(
    isPlanetemuBlockedResponse(
      { status: 200, headers: new Headers() },
      '<html><head><title>Just a moment...</title></head></html>'
    ),
    true
  );
  assert.equal(
    isPlanetemuBlockedResponse({ status: 200, headers: new Headers() }, '<td class="rom-list-name">'),
    false
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import type { CatalogGameItem } from './amigaArchiveCatalog';
import {
  analyzeTosecFilename,
  detectItemPlatform,
  groupPlanetemuItemsByPlatform,
} from './planetemuGrouping';

function makeFile(
  id: string,
  name: string,
  diskNumber: number | null = null,
  diskTotal: number | null = null,
  isBadDump = false,
  isVerified = false
) {
  return {
    id,
    name,
    sizeLabel: '720 KB',
    sizeBytes: 720 * 1024,
    diskNumber,
    diskTotal,
    isBadDump,
    isVerified,
    proxyDownloadUrl: `/api/download?source=planetemu&slug=${encodeURIComponent(id)}`,
  };
}

function makeItem(partial: Partial<CatalogGameItem> & Pick<CatalogGameItem, 'id' | 'title'>): CatalogGameItem {
  return {
    firms: [],
    year: null,
    tags: [],
    diskCount: 1,
    files: [],
    coverPath: null,
    coverUrl: null,
    proxyCoverUrl: null,
    proxyDownloadUrl: `/api/download?source=planetemu&slug=${encodeURIComponent(partial.id)}`,
    ...partial,
  };
}

test('detectItemPlatform separates CD32, CDTV, AGA, OCS-AGA, and OCS/ECS without CD32-intro false positives', () => {
  const cd32 = makeItem({
    id: 'ufo-cd32',
    title: 'UFO - Enemy Unknown CD32',
    tags: ['AGA', 'M3'],
    files: [makeFile('1', 'UFO - Enemy Unknown CD32 (1994)(MicroProse)(AGA)(M3)(Disk 1 of 7)[h LSD][HD, CD32 rip].zip', 1, 7)],
  });
  assert.equal(detectItemPlatform(cd32), 'CD32');

  const cdtv = makeItem({
    id: 'turr-cdtv',
    title: 'Turrican CDTV',
    tags: [],
    files: [makeFile('2', 'Turrican CDTV (1990)(Rainbow Arts)[f AGA][HD, CDTV rip].zip')],
  });
  assert.equal(detectItemPlatform(cdtv), 'CDTV');

  // [inc. CD32 intro] on an AGA floppy release must stay AGA, NOT CD32
  const zool2Aga = makeItem({
    id: 'zool2-aga',
    title: 'Zool 2',
    tags: ['AGA'],
    files: [
      makeFile('3', 'Zool 2 (1993)(Gremlin)(AGA)(Disk 1 of 2)[cr CLS].zip', 1, 2),
      makeFile('4', 'Zool 2 (1993)(Gremlin)(AGA)(Disk 01 of 13)[cr HLM][HD, Quarterback archive][inc. CD32 intro].zip', 1, 13),
    ],
  });
  assert.equal(detectItemPlatform(zool2Aga), 'AGA');

  // [f AGA ...] fix on an OCS/ECS game must stay OCS/ECS
  const turricanOcs = makeItem({
    id: 'turrican-ocs',
    title: 'Turrican',
    tags: [],
    files: [
      makeFile('5', 'Turrican (1990)(Rainbow Arts)(Disk 1 of 2)[cr VF].zip', 1, 2),
      makeFile('6', 'Turrican (1990)(Rainbow Arts)(Disk 1 of 2)[cr VF][f AGA Carlos Ace].zip', 1, 2),
    ],
  });
  assert.equal(detectItemPlatform(turricanOcs), 'OCS/ECS');

  const ocsAga = makeItem({
    id: 'ab-ta',
    title: 'Alien Breed - Tower Assault',
    tags: ['OCS-AGA'],
    files: [makeFile('7', 'Alien Breed - Tower Assault (1994)(Team 17)(OCS-AGA)(Disk 1 of 4).zip', 1, 4)],
  });
  assert.equal(detectItemPlatform(ocsAga), 'OCS-AGA');
});

test('groupPlanetemuItemsByPlatform separates platforms, merges all publishers/cracks/betas on same platform, and sorts cleanest first', () => {
  const turricanBeta = makeItem({
    id: 't3-beta',
    title: 'Turrican 3',
    year: '1993',
    firms: ['Factor 5'],
    tags: ['beta'],
    diskCount: 2,
    files: [
      makeFile('t3-b-1', 'Turrican 3 (1993)(Factor 5)(beta)(Disk 1 of 2)[cr Heresy - ZNT][t +26 Heresy - ZNT].zip', 1, 2),
      makeFile('t3-b-2', 'Turrican 3 (1993)(Factor 5)(beta)(Disk 2 of 2)[cr Heresy - ZNT].zip', 2, 2),
    ],
  });

  const turricanExt = makeItem({
    id: 't3-ext',
    title: 'Turrican 3',
    year: '1993',
    firms: ['Renegade'],
    tags: [],
    diskCount: 1,
    files: [makeFile('t3-ext-1', 'Turrican 3 (1993)(Renegade)[extended adf].zip', null, null)],
  });

  const turricanFinal = makeItem({
    id: 't3-final',
    title: 'Turrican 3',
    year: '1993',
    firms: ['Softgold'],
    tags: ['DE', 'en'],
    diskCount: 2,
    files: [
      makeFile('t3-f-1-t', 'Turrican 3 (1993)(Softgold)(DE)(en)(Disk 1 of 2)[cr HLM][t +28 Toxic].zip', 1, 2),
      makeFile('t3-f-1-clean', 'Turrican 3 (1993)(Softgold)(DE)(en)(Disk 1 of 2)[cr HLM].zip', 1, 2),
      makeFile('t3-f-1-bad', 'Turrican 3 (1993)(Softgold)(DE)(en)(Disk 1 of 2)[cr HLM][b dump].zip', 1, 2, true),
      makeFile('t3-f-2-clean', 'Turrican 3 (1993)(Softgold)(DE)(en)(Disk 2 of 2).zip', 2, 2),
    ],
  });

  const turricanCdtv = makeItem({
    id: 't-cdtv',
    title: 'Turrican CDTV',
    year: '1990',
    firms: ['Rainbow Arts'],
    tags: [],
    diskCount: 1,
    files: [makeFile('t-cdtv-1', 'Turrican CDTV (1990)(Rainbow Arts)[f AGA][HD, CDTV rip].zip')],
  });

  const turricanDemo = makeItem({
    id: 't-demo',
    title: 'Turrican - Demo 1',
    year: '1990',
    firms: ['Rainbow Arts'],
    tags: ['demo-playable'],
    diskCount: 1,
    files: [makeFile('t-demo-1', 'Turrican - Demo 1 (demo-playable) (1990-03-08)(Rainbow Arts).zip')],
  });

  const grouped = groupPlanetemuItemsByPlatform(
    [turricanDemo, turricanBeta, turricanExt, turricanFinal, turricanCdtv],
    'turrican'
  );

  assert.equal(grouped.length, 3);
  assert.equal(grouped[0].title, 'Turrican CDTV');
  assert.equal(grouped[0].platform, 'CDTV');

  assert.equal(grouped[1].title, 'Turrican 3');
  assert.equal(grouped[1].platform, 'OCS/ECS');
  assert.deepEqual(grouped[1].firms, ['Softgold', 'Renegade', 'Factor 5']);
  assert.equal(grouped[1].diskCount, 2);

  // Inside Disk 1: cleanest [cr HLM] is at very top, then [t +28], then beta, then [b dump]; Disk 2 follows; [extended adf] last
  const files = grouped[1].files!;
  assert.equal(files[0].id, 't3-f-1-clean');
  assert.equal(files[0].isClean, true);
  assert.equal(files[1].id, 't3-f-1-t');
  assert.equal(files[1].isClean, false);
  assert.equal(files[2].id, 't3-b-1');
  assert.equal(files[2].prereleaseKind, 'beta');
  assert.equal(files[3].id, 't3-f-1-bad');
  assert.equal(files[3].isBadDump, true);
  assert.equal(files[4].id, 't3-f-2-clean');
  assert.equal(files[5].id, 't3-b-2');
  assert.equal(files[6].id, 't3-ext-1');

  // Demo-only card is demoted below full releases
  assert.equal(grouped[2].title, 'Turrican - Demo 1');
  assert.equal(grouped[2].isPrereleaseOnly, true);
});

test('groupPlanetemuItemsByPlatform merges UFO demo-rolling into AGA and keeps OCS/ECS, AGA, and CD32 distinct', () => {
  const ufoAga = makeItem({
    id: 'ufo-aga',
    title: 'UFO - Enemy Unknown',
    year: '1994',
    firms: ['MicroProse'],
    tags: ['AGA', 'M3'],
    diskCount: 4,
    files: [
      makeFile('u-a-1-h', 'UFO - Enemy Unknown (1994)(MicroProse)(AGA)(M3)(Disk 1 of 4)[cr PSG][h FutureSoft].zip', 1, 4),
      makeFile('u-a-1-clean', 'UFO - Enemy Unknown (1994)(MicroProse)(AGA)(M3)(Disk 1 of 4)[cr PSG].zip', 1, 4),
      makeFile('u-a-2', 'UFO - Enemy Unknown (1994)(MicroProse)(AGA)(M3)(Disk 2 of 4).zip', 2, 4),
    ],
  });

  const ufoDemoRolling = makeItem({
    id: 'ufo-demo',
    title: 'UFO - Enemy Unknown',
    year: '1994',
    firms: ['MicroProse'],
    tags: ['demo-rolling', 'AGA'],
    diskCount: 6,
    files: [
      makeFile('u-d-1', 'UFO - Enemy Unknown (demo-rolling) (1994)(MicroProse)(AGA)(Disk 1 of 6)[HD].zip', 1, 6),
    ],
  });

  const ufoOcs = makeItem({
    id: 'ufo-ocs',
    title: 'UFO - Enemy Unknown',
    year: '1995',
    firms: ['MicroProse'],
    tags: ['M3'],
    diskCount: 5,
    files: [
      makeFile('u-o-1-cp', 'UFO - Enemy Unknown (1995)(MicroProse)(M3)(Disk 1 of 5)[cp manual code].zip', 1, 5),
      makeFile('u-o-1-cr', 'UFO - Enemy Unknown (1995)(MicroProse)(M3)(Disk 1 of 5)[cr QTX].zip', 1, 5),
    ],
  });

  const ufoCd32 = makeItem({
    id: 'ufo-cd32',
    title: 'UFO - Enemy Unknown CD32',
    year: '1994',
    firms: ['MicroProse'],
    tags: ['AGA', 'M3'],
    diskCount: 7,
    files: [
      makeFile('u-c-1', 'UFO - Enemy Unknown CD32 (1994)(MicroProse)(AGA)(M3)(Disk 1 of 7)[h LSD][HD, CD32 rip].zip', 1, 7),
    ],
  });

  const grouped = groupPlanetemuItemsByPlatform([ufoCd32, ufoDemoRolling, ufoAga, ufoOcs], 'ufo');
  assert.equal(grouped.length, 3);
  assert.deepEqual(
    grouped.map((g) => g.platform),
    ['OCS/ECS', 'AGA', 'CD32']
  );

  // Clean [cr QTX] is above [cp manual code] in OCS/ECS
  assert.equal(grouped[0].files![0].id, 'u-o-1-cr');
  assert.equal(grouped[0].files![1].id, 'u-o-1-cp');

  // In AGA: clean [cr PSG] is #1, [h FutureSoft] #2, demo-rolling #3 on Disk 1
  const agaDisk1 = grouped[1].files!.filter((f) => f.diskNumber === 1);
  assert.deepEqual(
    agaDisk1.map((f) => f.id),
    ['u-a-1-clean', 'u-a-1-h', 'u-d-1']
  );
  // Card itself should not be tagged demo-rolling because full release exists
  assert.ok(!grouped[1].tags?.includes('demo-rolling'));
  assert.equal(grouped[2].platform, 'CD32');
});

test('analyzeTosecFilename prioritizes verified [!] over clean and clean over alpha/beta/trainer/bad', () => {
  const verified = analyzeTosecFilename('Game (1992)(Pub)(Disk 1 of 2)[!].zip');
  const clean = analyzeTosecFilename('Game (1992)(Pub)(Disk 1 of 2)[cr Fairlight].zip');
  const trainer = analyzeTosecFilename('Game (1992)(Pub)(Disk 1 of 2)[cr Fairlight][t +3].zip');
  const beta = analyzeTosecFilename('Game (1992)(Pub)(beta)(Disk 1 of 2)[cr Fairlight].zip');
  const bad = analyzeTosecFilename('Game (1992)(Pub)(Disk 1 of 2)[cr Fairlight][b dump].zip');

  assert.equal(verified.isVerified, true);
  assert.equal(clean.isClean, true);
  assert.equal(trainer.isClean, false);
  assert.equal(beta.prereleaseKind, 'beta');
  assert.ok(verified.qualityScore < clean.qualityScore);
  assert.ok(clean.qualityScore < trainer.qualityScore);
  assert.ok(trainer.qualityScore < beta.qualityScore);
  assert.ok(bad.qualityScore > trainer.qualityScore);
});

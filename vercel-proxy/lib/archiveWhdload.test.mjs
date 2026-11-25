import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildArchiveWhdloadDownloadUrl,
  buildWhdloadIndexFromFiles,
  formatWhdloadTitle,
  groupWhdloadRows,
  isValidWhdloadFilename,
  parseWhdloadFileEntry,
} from './archiveWhdload.mjs';

const SAMPLE_FILES = [
  { name: 'Aladdin_v1.5_AGA_0420.lha', size: '2295053' },
  { name: 'Aladdin_v1.6_AGA_0420.lha', size: '1982038' },
  { name: 'Aladdin_v1.4_AGA_0420.zip', size: '2273861' },
  { name: 'AlienBreed2_v1.3_0278.zip', size: '2788944' },
  { name: 'AlienBreed2_v1.4_AGA_0044.lha', size: '2826399' },
  { name: '1869_v1.2_AGA_De_1653.zip', size: '1833601' },
  { name: '1869_v1.2_AGA.zip', size: '1832430' },
  { name: '4DSportsBoxing_v1.2_0421.lha', size: '486738' },
  { name: 'Amiga_WHD_Games_meta.xml', size: '2048' },
  { name: 'track01.mp3', size: '123456' },
];

test('formatWhdloadTitle splits CamelCase and numeric prefixes cleanly', () => {
  assert.equal(formatWhdloadTitle('4DSportsBoxing'), '4D Sports Boxing');
  assert.equal(formatWhdloadTitle('AlienBreed3D2'), 'Alien Breed 3D 2');
  assert.equal(formatWhdloadTitle('BeneathASteelSky'), 'Beneath A Steel Sky');
  assert.equal(formatWhdloadTitle('1000Miglia'), '1000 Miglia');
  assert.equal(formatWhdloadTitle('ATrain'), 'A Train');
});

test('parseWhdloadFileEntry parses ZIP/LHA games and skips non-archive metadata files', () => {
  assert.equal(parseWhdloadFileEntry(SAMPLE_FILES[8]), null);
  assert.equal(parseWhdloadFileEntry(SAMPLE_FILES[9]), null);

  const row = parseWhdloadFileEntry(SAMPLE_FILES[1]);
  assert.ok(row);
  assert.equal(row.title, 'Aladdin');
  assert.equal(row.version, 'v1.6');
  assert.equal(row.platform, 'AGA');
  assert.equal(row.ext, 'LHA');
  assert.equal(row.sizeBytes, 1982038);
});

test('buildWhdloadIndexFromFiles buckets by letter and groupWhdloadRows separates platforms & prioritizes clean newest release', () => {
  const index = buildWhdloadIndexFromFiles(SAMPLE_FILES);
  assert.equal(index.allRows.length, 8);
  assert.equal(index.byLetter.get('A').length, 5);
  assert.equal(index.byLetter.get('0').length, 3);

  const aGroups = groupWhdloadRows(index.byLetter.get('A'));
  assert.equal(aGroups.length, 3); // Aladdin (AGA), Alien Breed 2 (OCS/ECS), Alien Breed 2 (AGA)

  const aladdin = aGroups.find((g) => g.title === 'Aladdin');
  assert.ok(aladdin);
  assert.equal(aladdin.platform, 'AGA');
  assert.equal(aladdin.isWhdload, true);
  assert.equal(aladdin.files.length, 3);
  assert.equal(aladdin.files[0].name, 'Aladdin_v1.6_AGA_0420.lha');

  const zeroGroups = groupWhdloadRows(index.byLetter.get('0'));
  const g1869 = zeroGroups.find((g) => g.title === '1869');
  assert.ok(g1869);
  assert.equal(g1869.files[0].name, '1869_v1.2_AGA.zip'); // Non-localized before De
});

test('WHDLoad validators block traversal and build valid Archive.org download URLs', () => {
  assert.equal(isValidWhdloadFilename('Aladdin_v1.6_AGA_0420.lha'), true);
  assert.equal(isValidWhdloadFilename('4DSportsDriving&MasterTracks_v1.0_1461.zip'), true);
  assert.equal(isValidWhdloadFilename('../evil.lha'), false);
  assert.equal(isValidWhdloadFilename('sub/file.zip'), false);
  assert.equal(isValidWhdloadFilename('readme.txt'), false);

  assert.equal(
    buildArchiveWhdloadDownloadUrl('4DSportsDriving&MasterTracks_v1.0_1461.zip'),
    'https://archive.org/download/Amiga_WHD_Games/4DSportsDriving%26MasterTracks_v1.0_1461.zip'
  );
});

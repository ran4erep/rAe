import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildArchiveTosecDownloadUrl,
  buildArchiveTosecIndexFromLines,
  findMatchingRowInIndexBySlug,
  formatBytesLabel,
  groupArchiveTosecRows,
  isValidArchiveTosecFilename,
  parseArchiveTosecIndexLine,
  toTosecSlugBase,
} from './archiveTosec.mjs';

const SAMPLE_LINES = [
  'Archive:  Commodore_Amiga_TOSEC_2012_04_10.zip',
  '  Length      Date    Time    Name',
  '---------  ---------- -----   ----',
  '        0  2013-03-06 21:30   Commodore Amiga [TOSEC v2012-04-10]/Games/[ADF]/Commodore Amiga - Games - [ADF] (TOSEC 2012-02-27)/',
  '   880799  2013-03-06 21:30   Commodore Amiga [TOSEC v2012-04-10]/Games/[ADF]/Commodore Amiga - Games - [ADF] (TOSEC 2012-02-27)/Turrican II - The Final Fight (1991)(Rainbow Arts)[cr VF].zip',
  '   512000  2013-03-06 21:30   Commodore Amiga [TOSEC v2012-04-10]/Games/[ADF]/Commodore Amiga - Games - [ADF] (TOSEC 2012-02-27)/Shadow of the Beast (1989)(Psygnosis)(Disk 1 of 2)[cr PNA].zip',
  '   614400  2013-03-06 21:30   Commodore Amiga [TOSEC v2012-04-10]/Games/[ADF]/Commodore Amiga - Games - [ADF] (TOSEC 2012-02-27)/Shadow of the Beast (1989)(Psygnosis)(Disk 2 of 2)[cr PNA].zip',
  "   369664  2013-03-06 21:30   Commodore Amiga [TOSEC v2012-04-10]/Games/[ADF]/Commodore Amiga - Games - [ADF] (TOSEC 2012-02-27)/'Allo 'Allo! Cartoon Fun! (1993)(Alternative)(Disk 1 of 2)[cr CSL].zip",
  '   441632  2013-03-07 00:00   Commodore Amiga [TOSEC v2012-04-10]/Coverdisks/[ADF]/Commodore Amiga - Coverdisks - [ADF] (TOSEC-v2012-04-10_CM)/One, The #38.zip',
];

test('parseArchiveTosecIndexLine extracts ADF game rows and skips non-game lines', () => {
  assert.equal(parseArchiveTosecIndexLine(SAMPLE_LINES[0]), null);
  assert.equal(parseArchiveTosecIndexLine(SAMPLE_LINES[3]), null);
  assert.equal(parseArchiveTosecIndexLine(SAMPLE_LINES[8]), null);

  const row = parseArchiveTosecIndexLine(SAMPLE_LINES[4]);
  assert.ok(row);
  assert.equal(row.name, 'Turrican II - The Final Fight (1991)(Rainbow Arts)[cr VF]');
  assert.equal(row.fileName, 'Turrican II - The Final Fight (1991)(Rainbow Arts)[cr VF].zip');
  assert.equal(row.sizeBytes, 880799);
  assert.equal(row.sizeLabel, '860 KB');
});

test('buildArchiveTosecIndexFromLines buckets rows by letter, groups multi-disk sets, and resolves slugs', () => {
  const index = buildArchiveTosecIndexFromLines(SAMPLE_LINES);

  assert.equal(index.allRows.length, 4);
  assert.equal(index.byLetter.get('T').length, 1);
  assert.equal(index.byLetter.get('S').length, 2);
  assert.equal(index.byLetter.get('0').length, 1);

  const sGroups = groupArchiveTosecRows(index.byLetter.get('S'));
  assert.equal(sGroups.length, 1);
  assert.equal(sGroups[0].title, 'Shadow of the Beast');
  assert.equal(sGroups[0].diskCount, 2);
  assert.equal(sGroups[0].files.length, 2);
  assert.ok(sGroups[0].files[0].proxyDownloadUrl.startsWith('/api/download?source=archive-tosec&file='));

  const matched = findMatchingRowInIndexBySlug(
    index,
    'commodore-amiga-games-adf/shadow-of-the-beast-1989-psygnosis-disk-1-of-2-cr-pna'
  );
  assert.ok(matched);
  assert.equal(
    matched.fileName,
    'Shadow of the Beast (1989)(Psygnosis)(Disk 1 of 2)[cr PNA].zip'
  );
});

test('security validators block traversal and build valid Archive.org download URLs', () => {
  assert.equal(isValidArchiveTosecFilename('Turrican.zip'), true);
  assert.equal(isValidArchiveTosecFilename('../secret.zip'), false);
  assert.equal(isValidArchiveTosecFilename('sub/dir.zip'), false);
  assert.equal(isValidArchiveTosecFilename('game.adf'), false);
  assert.equal(isValidArchiveTosecFilename(''), false);

  assert.equal(formatBytesLabel(1024 * 1024 * 1.5), '1.5 MB');
  assert.equal(
    toTosecSlugBase("'Allo 'Allo! Cartoon Fun! (1993)(Alternative)(Disk 1 of 2)[cr CSL]"),
    'allo-allo-cartoon-fun-1993-alternative-disk-1-of-2-cr-csl'
  );

  const dlUrl = buildArchiveTosecDownloadUrl('Turrican (1990).zip');
  assert.equal(
    dlUrl,
    'https://archive.org/download/Commodore_Amiga_TOSEC_2012_04_10/Commodore_Amiga_TOSEC_2012_04_10.zip/Commodore%20Amiga%20%5BTOSEC%20v2012-04-10%5D/Games/%5BADF%5D/Commodore%20Amiga%20-%20Games%20-%20%5BADF%5D%20(TOSEC%202012-02-27)/Turrican%20(1990).zip'
  );
});

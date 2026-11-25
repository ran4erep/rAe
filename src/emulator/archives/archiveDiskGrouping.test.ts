import test from 'node:test';
import assert from 'node:assert/strict';
import type { ArchiveFileEntry, ArchiveMediaCandidate } from './archiveManager';
import { groupArchiveFilesByDisk, pickDualAdfPair } from './archiveDiskGrouping';

function makeCandidate(
  id: string,
  diskNumber: number | null,
  diskTotal: number | null = null,
  crackTag: string | null = null
): ArchiveMediaCandidate {
  return {
    id,
    name: `${id}.zip`,
    path: `${id}.zip`,
    size: 720 * 1024,
    kind: 'adf',
    diskNumber,
    diskTotal,
    crackTag,
    extractBytes: () => new Uint8Array(0),
  };
}

function makeFile(
  id: string,
  diskNumber: number | null,
  diskTotal: number | null = null
): ArchiveFileEntry {
  return {
    id,
    name: `${id}.zip`,
    path: `${id}.zip`,
    size: 720 * 1024,
    kind: 'adf',
    diskNumber,
    diskTotal,
    extractBytes: () => new Uint8Array(0),
  };
}

test('pickDualAdfPair never pairs variants of the same disk and matches crackTag when available', () => {
  // Single-disk game with 3 variants (all diskNumber = 1): must return null
  const singleDiskVariants = [
    makeCandidate('v1', 1, 1, 'cr Genesis'),
    makeCandidate('v2', 1, 1, 'cr Genesis'),
    makeCandidate('v3', 1, 1, 'cr Genesis'),
  ];
  assert.equal(pickDualAdfPair(singleDiskVariants), null);

  // Multi-disk game with multiple Disk 1 variants and multiple Disk 2 variants
  const multiDisk = [
    makeCandidate('d1_psg', 1, 4, 'cr PSG'),
    makeCandidate('d1_bk', 1, 4, 'cr Bad Karma'),
    makeCandidate('d2_bk', 2, 4, 'cr Bad Karma'),
    makeCandidate('d2_psg', 2, 4, 'cr PSG'),
    makeCandidate('d3', 3, 4),
  ];
  const pair = pickDualAdfPair(multiDisk);
  assert.ok(pair !== null);
  assert.equal(pair[0].id, 'd1_psg');
  assert.equal(pair[1].id, 'd2_psg');

  // Merged 3-disk final + 2-disk beta: Disk 1 (of 3) pairs with Disk 2 (of 3), not Disk 2 (of 2)
  const mergedEditions = [
    makeCandidate('d1_final', 1, 3, 'cr PDY'),
    makeCandidate('d1_beta', 1, 2, 'cr DCS'),
    makeCandidate('d2_beta', 2, 2, null),
    makeCandidate('d2_final', 2, 3, null),
  ];
  const mergedPair = pickDualAdfPair(mergedEditions);
  assert.ok(mergedPair !== null);
  assert.equal(mergedPair[0].id, 'd1_final');
  assert.equal(mergedPair[1].id, 'd2_final');
});

test('groupArchiveFilesByDisk separates files into Disk 1..N sections in ascending order', () => {
  const files = [
    makeFile('d3_clean', 3, 4),
    makeFile('d1_clean', 1, 4),
    makeFile('d1_hack', 1, 4),
    makeFile('d2_clean', 2, 4),
    makeFile('d4_clean', 4, 4),
  ];

  const sections = groupArchiveFilesByDisk(files);
  assert.equal(sections.length, 4);
  assert.equal(sections[0].label, 'Диск 1 из 4');
  assert.deepEqual(
    sections[0].files.map((f) => f.id),
    ['d1_clean', 'd1_hack']
  );
  assert.equal(sections[1].label, 'Диск 2 из 4');
  assert.equal(sections[2].label, 'Диск 3 из 4');
  assert.equal(sections[3].label, 'Диск 4 из 4');

  // Unnumbered files stay flat with label = null
  const unnumbered = groupArchiveFilesByDisk([makeFile('a', null), makeFile('b', null)]);
  assert.equal(unnumbered.length, 1);
  assert.equal(unnumbered[0].label, null);
});

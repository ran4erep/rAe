import type { ArchiveFileEntry, ArchiveMediaCandidate } from './archiveManager';

export interface ArchiveDiskSection {
  diskNumber: number | null;
  diskTotal: number | null;
  label: string | null;
  files: ArchiveFileEntry[];
}

/**
 * Picks a Disk 1 + Disk 2 pair for dual-drive DF0:+DF1: mounting.
 * Never pairs two variants of the same disk number.
 */
export function pickDualAdfPair(
  adfCandidates: ArchiveMediaCandidate[]
): [ArchiveMediaCandidate, ArchiveMediaCandidate] | null {
  if (adfCandidates.length < 2) return null;

  const hasDiskNumbers = adfCandidates.some((c) => c.diskNumber != null);
  if (hasDiskNumbers) {
    const first =
      adfCandidates.find((c) => c.diskNumber === 1) ??
      adfCandidates.find((c) => c.diskNumber != null);
    if (!first || first.diskNumber == null) return null;

    const firstDisk = first.diskNumber;
    const preferredDisk = firstDisk === 1 ? 2 : null;
    const firstTotal = first.diskTotal ?? null;

    if (preferredDisk !== null) {
      // 1. Exact match on both diskTotal and crackTag
      if (firstTotal !== null && first.crackTag) {
        const exactBoth = adfCandidates.find(
          (c) =>
            c.diskNumber === preferredDisk &&
            c.diskTotal === firstTotal &&
            c.crackTag === first.crackTag
        );
        if (exactBoth) return [first, exactBoth];
      }

      // 2. Match same diskTotal (avoids pairing 4-disk Disk 1 with 2-disk beta Disk 2)
      if (firstTotal !== null) {
        const sameTotal = adfCandidates.find(
          (c) => c.diskNumber === preferredDisk && c.diskTotal === firstTotal
        );
        if (sameTotal) return [first, sameTotal];
      }

      // 3. Match same crack/edition tag
      if (first.crackTag) {
        const sameCrack = adfCandidates.find(
          (c) => c.diskNumber === preferredDisk && c.crackTag === first.crackTag
        );
        if (sameCrack) return [first, sameCrack];
      }

      // 4. Any Disk 2 (cleanest first)
      const disk2 = adfCandidates.find((c) => c.diskNumber === preferredDisk);
      if (disk2) return [first, disk2];
    }

    // 5. Any other distinct disk number
    const otherDistinct = adfCandidates.find(
      (c) => c.diskNumber != null && c.diskNumber !== firstDisk
    );
    return otherDistinct ? [first, otherDistinct] : null;
  }

  return [adfCandidates[0], adfCandidates[1]];
}

/**
 * Groups archive file entries into visual sections by disk number (Диск 1, Диск 2, ...).
 * Preserves cleanest-first order within each disk section.
 */
export function groupArchiveFilesByDisk(
  files: ArchiveFileEntry[],
  mediaById?: Map<string, ArchiveMediaCandidate>
): ArchiveDiskSection[] {
  if (files.length === 0) return [];

  let anyDiskNumber = false;
  let inferredDiskTotal: number | null = null;

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const media = mediaById?.get(f.id);
    const dn = f.diskNumber ?? media?.diskNumber ?? null;
    const dt = f.diskTotal ?? media?.diskTotal ?? null;
    if (dn != null) anyDiskNumber = true;
    if (dt != null && (inferredDiskTotal === null || dt > inferredDiskTotal)) {
      inferredDiskTotal = dt;
    }
  }

  if (!anyDiskNumber) {
    return [{ diskNumber: null, diskTotal: null, label: null, files }];
  }

  const byDisk = new Map<number, ArchiveFileEntry[]>();
  const unnumbered: ArchiveFileEntry[] = [];

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const media = mediaById?.get(f.id);
    const dn = f.diskNumber ?? media?.diskNumber ?? null;
    if (dn == null) {
      unnumbered.push(f);
    } else {
      let bucket = byDisk.get(dn);
      if (!bucket) {
        bucket = [];
        byDisk.set(dn, bucket);
      }
      bucket.push(f);
    }
  }

  const sortedDiskNums = Array.from(byDisk.keys()).sort((a, b) => a - b);
  const totalForLabel =
    inferredDiskTotal && inferredDiskTotal >= sortedDiskNums.length
      ? inferredDiskTotal
      : sortedDiskNums.length > 1
        ? sortedDiskNums[sortedDiskNums.length - 1]
        : null;

  const sections: ArchiveDiskSection[] = sortedDiskNums.map((dn) => ({
    diskNumber: dn,
    diskTotal: totalForLabel,
    label: totalForLabel && totalForLabel > 1 ? `Диск ${dn} из ${totalForLabel}` : `Диск ${dn}`,
    files: byDisk.get(dn)!,
  }));

  if (unnumbered.length > 0) {
    sections.push({
      diskNumber: null,
      diskTotal: totalForLabel,
      label: 'Другие файлы',
      files: unnumbered,
    });
  }

  return sections;
}

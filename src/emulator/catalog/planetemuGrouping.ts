import type { CatalogDiskFile, CatalogGameItem } from './amigaArchiveCatalog';

export type PlanetemuPlatform = 'CD32' | 'CDTV' | 'AGA' | 'OCS-AGA' | 'OCS/ECS';
export type PrereleaseKind = 'alpha' | 'beta' | 'proto' | 'demo';

export interface TosecFileAnalysis {
  diskNumber: number | null;
  diskTotal: number | null;
  isVerified: boolean;
  isBadDump: boolean;
  isCorruptDump: boolean;
  isAltDump: boolean;
  isModifiedDump: boolean;
  isVirus: boolean;
  isOverUnderDump: boolean;
  crackTag: string | null;
  copyProt: string | null;
  hasHack: boolean;
  hasTrainer: boolean;
  hasFix: boolean;
  hasHdOrSpecialFormat: boolean;
  prereleaseKind: PrereleaseKind | null;
  extraBracketCount: number;
  isClean: boolean;
  qualityScore: number;
  variantTags: string[];
}

export interface GroupedPlanetemuItem extends CatalogGameItem {
  platform: PlanetemuPlatform;
  isPrereleaseOnly: boolean;
}

const PRERELEASE_TEXT_RE = /\b(alpha|beta|proto|prototype|pre-?release|unfinished|wip|demo(?:-playable|-rolling|-slideshow)?|preview|sample|kiosk|teaser|promo|unreleased)\b/i;
const TITLE_TRAILING_PLATFORM_RE = /\s+(?:CD32|CDTV|AGA)$/i;
const TITLE_WORD_CD32_RE = /\bCD32\b/i;
const TITLE_WORD_CDTV_RE = /\bCDTV\b/i;
const TITLE_WORD_AGA_RE = /\bAGA\b/i;
const DISK_OF_RE = /^(?:Disk|Disc|Side|Tape|Part)\s+(\d+|[A-Z])\s*(?:of|\/)\s*(\d+)$/i;
const DISK_SINGLE_RE = /^(?:Disk|Disc|Side|Tape|Part)\s+(\d+|[A-Z])$/i;

function letterOrDigitToNum(tok: string): number | null {
  const n = Number.parseInt(tok, 10);
  if (Number.isFinite(n)) return n;
  const code = tok.toUpperCase().charCodeAt(0);
  if (code >= 65 && code <= 90) return code - 64;
  return null;
}

function isLetterPlusDigitOrSpace(low: string, ch: string): boolean {
  if (low === ch) return true;
  if (low.length < 2 || low[0] !== ch) return false;
  const c1 = low.charCodeAt(1);
  return c1 === 32 || (c1 >= 48 && c1 <= 57);
}

export function detectPrereleaseKind(low: string): PrereleaseKind | null {
  if (!low) return null;
  if (low === 'alpha' || low.startsWith('alpha ') || low.startsWith('alpha-')) return 'alpha';
  if (low === 'beta' || low.startsWith('beta ') || low.startsWith('beta-')) return 'beta';
  if (
    low === 'proto' ||
    low.startsWith('proto ') ||
    low.startsWith('proto-') ||
    low.includes('prototype') ||
    low.includes('pre-release') ||
    low.includes('prerelease') ||
    low === 'unfinished' ||
    low === 'wip' ||
    low === 'unreleased'
  ) {
    return 'proto';
  }
  if (
    low === 'demo' ||
    low.startsWith('demo-') ||
    low.startsWith('demo ') ||
    low.includes('playable demo') ||
    low.includes('rolling demo') ||
    low === 'preview' ||
    low.startsWith('preview ') ||
    low === 'sample' ||
    low === 'kiosk' ||
    low === 'teaser' ||
    low === 'promo'
  ) {
    return 'demo';
  }
  return null;
}

function prereleasePenaltyOf(kind: PrereleaseKind | null): number {
  if (kind === 'alpha') return 320;
  if (kind === 'beta') return 280;
  if (kind === 'proto') return 240;
  if (kind === 'demo') return 200;
  return 0;
}

/**
 * Fast, single-pass scanner of TOSEC filename metadata & cleanliness.
 * Avoids heavy regex backtracking so grouping 36+ items runs in <0.2ms.
 */
export function analyzeTosecFilename(
  rawName: string,
  hint?: Pick<CatalogDiskFile, 'diskNumber' | 'diskTotal' | 'isBadDump' | 'isVerified'>
): TosecFileAnalysis {
  const firstBracket = rawName.indexOf('[');
  const parensZone = firstBracket === -1 ? rawName : rawName.slice(0, firstBracket);

  let isVerified = hint?.isVerified === true;
  let isBadDump = hint?.isBadDump === true;
  let isCorruptDump = false;
  let isAltDump = false;
  let isModifiedDump = false;
  let isVirus = false;
  let isOverUnderDump = false;
  let crackTag: string | null = null;
  let copyProt: string | null = null;
  let hasHack = false;
  let hasTrainer = false;
  let hasFix = false;
  let hasHdOrSpecialFormat = false;
  let prereleaseKind: PrereleaseKind | null = null;
  let extraBracketCount = 0;
  const variantTags: string[] = [];

  let bPos = firstBracket;
  while (bPos !== -1) {
    const bEnd = rawName.indexOf(']', bPos + 1);
    if (bEnd === -1) break;
    const tag = rawName.slice(bPos + 1, bEnd).trim();
    bPos = rawName.indexOf('[', bEnd + 1);
    if (!tag) continue;

    const low = tag.toLowerCase();
    if (low === '!') {
      isVerified = true;
      continue;
    }
    if (isLetterPlusDigitOrSpace(low, 'a')) {
      isAltDump = true;
      continue;
    }
    if (isLetterPlusDigitOrSpace(low, 'o') || isLetterPlusDigitOrSpace(low, 'u')) {
      isAltDump = true;
      isOverUnderDump = true;
      continue;
    }
    if (isLetterPlusDigitOrSpace(low, 'b')) {
      isBadDump = true;
      if (low.includes('corrupt') || low.includes('checksum') || low.includes('errdms')) {
        isCorruptDump = true;
      }
      continue;
    }
    if (isLetterPlusDigitOrSpace(low, 'm') || low.startsWith('modified')) {
      isModifiedDump = true;
      continue;
    }
    if (isLetterPlusDigitOrSpace(low, 'v')) {
      isVirus = true;
      continue;
    }
    if (low === 'cr' || low.startsWith('cr ')) {
      crackTag = tag;
      variantTags.push(tag);
      continue;
    }
    if (low === 'cp' || low.startsWith('cp ')) {
      copyProt = tag;
      variantTags.push(tag);
      continue;
    }
    if (low === 'h' || low.startsWith('h ')) {
      hasHack = true;
      variantTags.push(tag);
      extraBracketCount++;
      continue;
    }
    if (low === 'tr' || low.startsWith('tr ')) {
      continue;
    }
    if (low === 't' || low.startsWith('t ') || low.startsWith('t+')) {
      hasTrainer = true;
      variantTags.push(tag);
      extraBracketCount++;
      continue;
    }
    if (low === 'f' || low.startsWith('f ') || low.includes('codes on disk')) {
      hasFix = true;
      variantTags.push(tag);
      extraBracketCount++;
      continue;
    }

    const bracketPre = detectPrereleaseKind(low);
    if (bracketPre) {
      if (!prereleaseKind || prereleasePenaltyOf(bracketPre) > prereleasePenaltyOf(prereleaseKind)) {
        prereleaseKind = bracketPre;
      }
      variantTags.push(tag);
      extraBracketCount++;
      continue;
    }

    if (
      low === 'hd' ||
      low.startsWith('hd,') ||
      low.startsWith('hd ') ||
      low.includes('quarterback') ||
      low.includes('lha archive') ||
      low === 'extended adf' ||
      low === 'cd32 rip' ||
      low === 'cdtv rip' ||
      low.includes('cd32 rip') ||
      low.includes('cdtv rip')
    ) {
      hasHdOrSpecialFormat = true;
      variantTags.push(tag);
      extraBracketCount++;
      continue;
    }

    extraBracketCount++;
  }

  let diskNumber: number | null = hint?.diskNumber ?? null;
  let diskTotal: number | null = hint?.diskTotal ?? null;

  const firstParen = parensZone.indexOf('(');
  const titlePart = firstParen > 0 ? parensZone.slice(0, firstParen) : parensZone;
  const titlePreMatch = titlePart.match(PRERELEASE_TEXT_RE);
  if (titlePreMatch) {
    const k = detectPrereleaseKind(titlePreMatch[1].toLowerCase()) ?? 'demo';
    if (!prereleaseKind || prereleasePenaltyOf(k) > prereleasePenaltyOf(prereleaseKind)) {
      prereleaseKind = k;
    }
  }

  let pPos = firstParen;
  while (pPos !== -1) {
    const pEnd = parensZone.indexOf(')', pPos + 1);
    if (pEnd === -1) break;
    const inner = parensZone.slice(pPos + 1, pEnd).trim();
    pPos = parensZone.indexOf('(', pEnd + 1);
    if (!inner) continue;

    if (diskNumber === null || diskTotal === null) {
      const ofMatch = inner.match(DISK_OF_RE);
      if (ofMatch) {
        if (diskNumber === null) diskNumber = letterOrDigitToNum(ofMatch[1]);
        if (diskTotal === null) diskTotal = Number.parseInt(ofMatch[2], 10) || null;
        continue;
      }
      const singleMatch = inner.match(DISK_SINGLE_RE);
      if (singleMatch && diskNumber === null) {
        diskNumber = letterOrDigitToNum(singleMatch[1]);
        continue;
      }
    }

    const pre = detectPrereleaseKind(inner.toLowerCase());
    if (pre && (!prereleaseKind || prereleasePenaltyOf(pre) > prereleasePenaltyOf(prereleaseKind))) {
      prereleaseKind = pre;
    }
  }

  const isClean =
    !isBadDump &&
    !isAltDump &&
    !isModifiedDump &&
    !isVirus &&
    !hasHack &&
    !hasTrainer &&
    !hasFix &&
    !copyProt &&
    !prereleaseKind &&
    !hasHdOrSpecialFormat;

  let qualityScore = 0;
  if (isVerified) qualityScore -= 30;
  qualityScore += prereleasePenaltyOf(prereleaseKind);
  if (isCorruptDump) qualityScore += 750;
  else if (isBadDump) qualityScore += 600;
  if (isVirus) qualityScore += 550;
  if (isModifiedDump) qualityScore += 60;
  if (isAltDump) qualityScore += 40;
  if (isOverUnderDump) qualityScore += 35;
  if (hasHdOrSpecialFormat) qualityScore += 25;
  if (hasHack) qualityScore += 18;
  if (hasTrainer) qualityScore += 16;
  if (copyProt && !crackTag) qualityScore += 12;
  if (hasFix) qualityScore += 8;
  qualityScore += extraBracketCount * 2;

  return {
    diskNumber,
    diskTotal,
    isVerified,
    isBadDump,
    isCorruptDump,
    isAltDump,
    isModifiedDump,
    isVirus,
    isOverUnderDump,
    crackTag,
    copyProt,
    hasHack,
    hasTrainer,
    hasFix,
    hasHdOrSpecialFormat,
    prereleaseKind,
    extraBracketCount,
    isClean,
    qualityScore,
    variantTags,
  };
}

function fileHasPlatformRip(name: string, kind: 'cd32' | 'cdtv'): boolean {
  const low = name.toLowerCase();
  if (!low.includes(kind)) return false;
  if (low.includes(`(${kind})`)) return true;
  if (low.includes(`${kind} rip`) || low.includes(`${kind}-rip`)) return true;
  // Ignore floppy releases that merely say [inc. CD32 intro]
  if (low.includes(`inc. ${kind}`) || low.includes(`${kind} intro`)) return false;
  return low.includes(`[${kind}]`);
}

export function detectItemPlatform(item: CatalogGameItem): PlanetemuPlatform {
  const tags = item.tags ?? [];
  let hasAgaTag = false;
  let hasOcsAgaTag = false;

  for (let i = 0; i < tags.length; i++) {
    const low = tags[i].toLowerCase();
    if (low === 'cd32' || low.includes('cd32')) return 'CD32';
    if (low === 'cdtv' || low.includes('cdtv')) return 'CDTV';
    if (low === 'ocs-aga' || low === 'ocs/aga') hasOcsAgaTag = true;
    else if (low === 'aga' || low === 'aga-hd' || low === 'a1200' || low === 'a4000') hasAgaTag = true;
  }

  if (TITLE_WORD_CD32_RE.test(item.title)) return 'CD32';
  if (TITLE_WORD_CDTV_RE.test(item.title)) return 'CDTV';

  const files = item.files ?? [];
  for (let i = 0; i < files.length; i++) {
    if (fileHasPlatformRip(files[i].name, 'cd32')) return 'CD32';
  }
  for (let i = 0; i < files.length; i++) {
    if (fileHasPlatformRip(files[i].name, 'cdtv')) return 'CDTV';
  }

  if (hasOcsAgaTag) return 'OCS-AGA';
  if (hasAgaTag || TITLE_WORD_AGA_RE.test(item.title)) return 'AGA';

  for (let i = 0; i < files.length; i++) {
    const low = files[i].name.toLowerCase();
    if (low.includes('(ocs-aga)')) return 'OCS-AGA';
    if (low.includes('(aga)')) return 'AGA';
  }

  return 'OCS/ECS';
}

export function normalizeTitleForPlatformGrouping(title: string): string {
  return title
    .trim()
    .replace(TITLE_TRAILING_PLATFORM_RE, '')
    .trim()
    .toLowerCase();
}

function platformRank(platform: PlanetemuPlatform): number {
  switch (platform) {
    case 'OCS/ECS':
      return 0;
    case 'OCS-AGA':
      return 1;
    case 'AGA':
      return 2;
    case 'CDTV':
      return 3;
    case 'CD32':
      return 4;
  }
}

function isPlatformTag(tag: string): boolean {
  const low = tag.toLowerCase();
  return (
    low === 'aga' ||
    low === 'aga-hd' ||
    low === 'ocs-aga' ||
    low === 'ocs/aga' ||
    low === 'cd32' ||
    low === 'cdtv' ||
    low === 'a1200' ||
    low === 'a4000'
  );
}

function isPrereleaseTag(tag: string): boolean {
  return detectPrereleaseKind(tag.toLowerCase()) !== null;
}

function queryMatchTier(titleLower: string, queryLower: string, tokens: string[]): number {
  if (!queryLower) return 0;
  if (titleLower === queryLower) return 0;
  if (titleLower.startsWith(queryLower)) return 1;
  for (let i = 0; i < tokens.length; i++) {
    if (!titleLower.includes(tokens[i])) return 3;
  }
  return 2;
}

interface AnalyzedFileEntry {
  file: CatalogDiskFile;
  analysis: TosecFileAnalysis;
}

/**
 * Client-side Planetemu catalog organizer:
 * 1. Separates releases strictly by platform (CD32, CDTV, AGA, OCS-AGA, OCS/ECS).
 * 2. Merges everything else on the same platform regardless of publisher, year, crack, or beta/demo.
 * 3. Sorts files inside each game by disk number ascending, with the cleanest dump at the top of each disk.
 * 4. Sorts game cards with cleanest full releases at the top.
 */
export function groupPlanetemuItemsByPlatform(
  items: CatalogGameItem[],
  query = ''
): GroupedPlanetemuItem[] {
  if (!Array.isArray(items) || items.length === 0) return [];

  const buckets = new Map<
    string,
    {
      platform: PlanetemuPlatform;
      sourceItems: CatalogGameItem[];
      analyzedFiles: AnalyzedFileEntry[];
    }
  >();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const platform = detectItemPlatform(item);
    const baseKey = normalizeTitleForPlatformGrouping(item.title);
    const groupKey = `${baseKey}|${platform}`;

    let bucket = buckets.get(groupKey);
    if (!bucket) {
      bucket = { platform, sourceItems: [], analyzedFiles: [] };
      buckets.set(groupKey, bucket);
    }
    bucket.sourceItems.push(item);

    const rawFiles: CatalogDiskFile[] =
      item.files && item.files.length > 0
        ? item.files
        : [
            {
              id: item.id,
              name: `${item.title}.zip`,
              sizeLabel: '',
              sizeBytes: 0,
              diskNumber: null,
              diskTotal: item.diskCount ?? 1,
              proxyDownloadUrl: item.proxyDownloadUrl,
            },
          ];

    for (let j = 0; j < rawFiles.length; j++) {
      const f = rawFiles[j];
      const analysis = analyzeTosecFilename(f.name, f);
      bucket.analyzedFiles.push({
        file: {
          ...f,
          diskNumber: f.diskNumber ?? analysis.diskNumber,
          diskTotal: f.diskTotal ?? analysis.diskTotal,
          isBadDump: analysis.isBadDump,
          isVerified: analysis.isVerified,
          isClean: analysis.isClean,
          crackTag: analysis.crackTag ?? analysis.copyProt,
          prereleaseKind: analysis.prereleaseKind,
          variantTags: analysis.variantTags,
        },
        analysis,
      });
    }
  }

  const groupedEntries: Array<{
    item: GroupedPlanetemuItem;
    bestQualityScore: number;
    baseTitleLower: string;
    hasFullRelease: boolean;
  }> = [];

  for (const bucket of buckets.values()) {
    const { platform, sourceItems, analyzedFiles } = bucket;

    // Deduplicate files by id in case proxy ever overlaps
    const seenIds = new Set<string>();
    const uniqueFiles: AnalyzedFileEntry[] = [];
    for (let i = 0; i < analyzedFiles.length; i++) {
      const entry = analyzedFiles[i];
      if (!seenIds.has(entry.file.id)) {
        seenIds.add(entry.file.id);
        uniqueFiles.push(entry);
      }
    }

    // Sort all files: diskNumber ascending, then cleanest/highest quality first
    uniqueFiles.sort((a, b) => {
      const da = a.file.diskNumber ?? 9999;
      const db = b.file.diskNumber ?? 9999;
      if (da !== db) return da - db;
      if (a.analysis.qualityScore !== b.analysis.qualityScore) {
        return a.analysis.qualityScore - b.analysis.qualityScore;
      }
      if (a.file.name.length !== b.file.name.length) {
        return a.file.name.length - b.file.name.length;
      }
      return a.file.name < b.file.name ? -1 : a.file.name > b.file.name ? 1 : 0;
    });

    let bestQualityScore = Number.POSITIVE_INFINITY;
    let hasFullRelease = false;
    let maxDiskTotal = 0;
    const distinctDisks = new Set<number>();

    for (let i = 0; i < uniqueFiles.length; i++) {
      const { file, analysis } = uniqueFiles[i];
      if (analysis.qualityScore < bestQualityScore) {
        bestQualityScore = analysis.qualityScore;
      }
      if (!analysis.prereleaseKind) {
        hasFullRelease = true;
      }
      if (file.diskTotal && file.diskTotal > maxDiskTotal) {
        maxDiskTotal = file.diskTotal;
      }
      if (file.diskNumber != null) {
        distinctDisks.add(file.diskNumber);
      }
    }

    // Also inspect source item diskCount when files lack (Disk X of Y)
    let fallbackDiskCount = 1;
    for (let i = 0; i < sourceItems.length; i++) {
      const dc = sourceItems[i].diskCount ?? 1;
      if (dc > fallbackDiskCount) fallbackDiskCount = dc;
    }
    const diskCount = Math.max(1, maxDiskTotal, distinctDisks.size, distinctDisks.size === 0 ? fallbackDiskCount : 1);

    // Order sourceItems so cleanest full release supplies primary title/year/firms
    const orderedSources = [...sourceItems].sort((a, b) => {
      const aPre = (a.tags ?? []).some(isPrereleaseTag) || PRERELEASE_TEXT_RE.test(a.title);
      const bPre = (b.tags ?? []).some(isPrereleaseTag) || PRERELEASE_TEXT_RE.test(b.title);
      if (aPre !== bPre) return aPre ? 1 : -1;
      const aFiles = a.files ?? [];
      const bFiles = b.files ?? [];
      const aMin = aFiles.length > 0 ? Math.min(...aFiles.map((f) => analyzeTosecFilename(f.name, f).qualityScore)) : 0;
      const bMin = bFiles.length > 0 ? Math.min(...bFiles.map((f) => analyzeTosecFilename(f.name, f).qualityScore)) : 0;
      return aMin - bMin;
    });

    const primarySource = orderedSources[0];
    const firms: string[] = [];
    const seenFirms = new Set<string>();
    const tags: string[] = [];
    const seenTags = new Set<string>();

    for (let i = 0; i < orderedSources.length; i++) {
      const src = orderedSources[i];
      for (let j = 0; j < src.firms.length; j++) {
        const firm = src.firms[j];
        if (firm && !seenFirms.has(firm)) {
          seenFirms.add(firm);
          firms.push(firm);
        }
      }
      const srcTags = src.tags ?? [];
      for (let j = 0; j < srcTags.length; j++) {
        const t = srcTags[j];
        if (!t || isPlatformTag(t)) continue;
        // Don't mark a full-game card as beta/demo just because a beta/demo was merged in
        if (hasFullRelease && isPrereleaseTag(t)) continue;
        if (!seenTags.has(t)) {
          seenTags.add(t);
          tags.push(t);
        }
      }
    }

    const publicFiles = uniqueFiles.map((u) => u.file);
    const primaryFile = publicFiles[0];

    groupedEntries.push({
      item: {
        id: `${primarySource.id}|${platform}`,
        title: primarySource.title,
        year: primarySource.year,
        firms,
        tags,
        diskCount,
        files: publicFiles,
        coverPath: null,
        coverUrl: null,
        proxyCoverUrl: null,
        proxyDownloadUrl: primaryFile.proxyDownloadUrl,
        platform,
        isPrereleaseOnly: !hasFullRelease,
      },
      bestQualityScore: Number.isFinite(bestQualityScore) ? bestQualityScore : 0,
      baseTitleLower: normalizeTitleForPlatformGrouping(primarySource.title),
      hasFullRelease,
    });
  }

  const rawQuery = query.trim().toLowerCase();
  const queryTokens = rawQuery ? rawQuery.split(/\s+/).filter(Boolean) : [];
  const queryAsksPrerelease = rawQuery ? PRERELEASE_TEXT_RE.test(rawQuery) : false;

  groupedEntries.sort((a, b) => {
    if (rawQuery) {
      if (!queryAsksPrerelease && a.hasFullRelease !== b.hasFullRelease) {
        return a.hasFullRelease ? -1 : 1;
      }
      const qa = queryMatchTier(a.item.title.toLowerCase(), rawQuery, queryTokens);
      const qb = queryMatchTier(b.item.title.toLowerCase(), rawQuery, queryTokens);
      if (qa !== qb) return qa - qb;
      if (a.baseTitleLower !== b.baseTitleLower) {
        return a.baseTitleLower < b.baseTitleLower ? -1 : 1;
      }
      if (a.bestQualityScore !== b.bestQualityScore) {
        return a.bestQualityScore - b.bestQualityScore;
      }
      return platformRank(a.item.platform) - platformRank(b.item.platform);
    }

    if (a.baseTitleLower !== b.baseTitleLower) {
      return a.baseTitleLower < b.baseTitleLower ? -1 : 1;
    }
    if (a.hasFullRelease !== b.hasFullRelease) {
      return a.hasFullRelease ? -1 : 1;
    }
    if (a.bestQualityScore !== b.bestQualityScore) {
      return a.bestQualityScore - b.bestQualityScore;
    }
    return platformRank(a.item.platform) - platformRank(b.item.platform);
  });

  return groupedEntries.map((e) => e.item);
}

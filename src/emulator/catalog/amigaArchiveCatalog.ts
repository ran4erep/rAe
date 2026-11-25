export type CatalogSource = 'amiga500archive' | 'planetemu' | 'whdload';

export interface CatalogSourceOption {
  id: CatalogSource;
  label: string;
}

export const CATALOG_SOURCES: readonly CatalogSourceOption[] = [
  { id: 'amiga500archive', label: 'Amiga 500 Archive' },
  { id: 'planetemu', label: 'Planetemu' },
  { id: 'whdload', label: 'WHDLoad' },
] as const;

export type CatalogCategory = 'games' | 'top' | 'demos' | 'originals' | 'tools' | 'recent';

export interface CatalogCategoryOption {
  id: CatalogCategory;
  label: string;
}

export const CATALOG_CATEGORIES: readonly CatalogCategoryOption[] = [
  { id: 'games', label: 'Игры' },
  { id: 'top', label: 'Топ' },
  { id: 'demos', label: 'Демо' },
  { id: 'originals', label: 'Оригиналы' },
  { id: 'tools', label: 'Утилиты' },
  { id: 'recent', label: 'Новые' },
] as const;

export const PLANETEMU_LETTERS = [
  '0',
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
  'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
] as const;

export type PlanetemuLetter = (typeof PLANETEMU_LETTERS)[number];

export interface CatalogDiskFile {
  id: string;
  name: string;
  sizeLabel: string;
  sizeBytes: number;
  diskNumber: number | null;
  diskTotal: number | null;
  isBadDump?: boolean;
  isVerified?: boolean;
  isClean?: boolean;
  crackTag?: string | null;
  prereleaseKind?: 'alpha' | 'beta' | 'proto' | 'demo' | null;
  variantTags?: string[];
  proxyDownloadUrl: string;
}

export interface CatalogGameItem {
  id: string;
  title: string;
  firms: string[];
  year?: string | null;
  tags?: string[];
  platform?: 'CD32' | 'CDTV' | 'AGA' | 'OCS-AGA' | 'OCS/ECS';
  isPrereleaseOnly?: boolean;
  isWhdload?: boolean;
  diskCount?: number;
  files?: CatalogDiskFile[];
  coverPath: string | null;
  coverUrl: string | null;
  proxyCoverUrl: string | null;
  proxyDownloadUrl: string;
}

export interface CatalogPageResponse {
  ok: boolean;
  source: string;
  fallbackFrom?: string;
  category: string;
  query: string;
  page: number;
  totalPages: number;
  totalItems?: number;
  hasPrev: boolean;
  hasNext: boolean;
  items: CatalogGameItem[];
  error?: string;
}

export const DEFAULT_CATALOG_PROXY_URL = 'https://amiga-proxy.vercel.app';

export function getDefaultCatalogProxyBase(
  env: Record<string, unknown> | undefined = (import.meta as ImportMeta & { env?: Record<string, unknown> }).env
): string {
  const configured = typeof env?.VITE_CATALOG_PROXY_URL === 'string' ? env.VITE_CATALOG_PROXY_URL.trim() : '';
  if (configured && /^https?:\/\//i.test(configured)) {
    return configured.replace(/\/+$/, '');
  }
  return DEFAULT_CATALOG_PROXY_URL;
}

const CACHE_TTL_MS = 3 * 60 * 1000;
const MAX_CACHE_ENTRIES = 30;

interface CacheEntry {
  expiresAt: number;
  data: CatalogPageResponse;
}

export class CatalogMemoryCache {
  private readonly store = new Map<string, CacheEntry>();

  public get(key: string, now = Date.now()): CatalogPageResponse | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now) {
      this.store.delete(key);
      return null;
    }
    return entry.data;
  }

  public set(key: string, data: CatalogPageResponse, now = Date.now()): void {
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }
    this.store.set(key, { expiresAt: now + CACHE_TTL_MS, data });
  }

  public clear(): void {
    this.store.clear();
  }
}

const catalogCache = new CatalogMemoryCache();

export function makeCatalogCacheKey(
  proxyBase: string,
  source: CatalogSource,
  categoryOrLetter: string,
  query: string,
  page: number
): string {
  return `${proxyBase}|${source}|${categoryOrLetter}|${query.trim().toLowerCase()}|${page}`;
}

export function buildCatalogApiUrl(
  proxyBase: string,
  opts: {
    source?: CatalogSource;
    category: CatalogCategory;
    letter?: PlanetemuLetter;
    query: string;
    page: number;
  }
): string {
  const base = proxyBase.replace(/\/+$/, '');
  const params = new URLSearchParams();
  const source: CatalogSource = opts.source ?? 'amiga500archive';
  const q = opts.query.trim();

  if (source === 'planetemu' || source === 'whdload') {
    params.set('source', source);
    if (q) {
      params.set('q', q);
    } else {
      params.set('letter', opts.letter ?? '0');
    }
  } else if (q) {
    params.set('q', q);
  } else {
    params.set('category', opts.category);
  }

  params.set('page', String(Math.max(1, Math.floor(opts.page))));
  return `${base}/api/catalog?${params.toString()}`;
}

export function resolveCatalogCoverUrl(proxyBase: string, item: CatalogGameItem): string | null {
  const base = proxyBase.replace(/\/+$/, '');
  if (item.proxyCoverUrl) {
    return item.proxyCoverUrl.startsWith('http')
      ? item.proxyCoverUrl
      : `${base}${item.proxyCoverUrl.startsWith('/') ? '' : '/'}${item.proxyCoverUrl}`;
  }
  if (item.coverPath) {
    return `${base}/api/cover?path=${encodeURIComponent(item.coverPath)}`;
  }
  return item.coverUrl;
}

export function resolveProxyUrl(proxyBase: string, relativeOrAbsolute: string): string {
  const base = proxyBase.replace(/\/+$/, '');
  return relativeOrAbsolute.startsWith('http')
    ? relativeOrAbsolute
    : `${base}${relativeOrAbsolute.startsWith('/') ? '' : '/'}${relativeOrAbsolute}`;
}

export function resolveCatalogDownloadUrl(proxyBase: string, item: CatalogGameItem): string {
  if (item.proxyDownloadUrl) {
    return resolveProxyUrl(proxyBase, item.proxyDownloadUrl);
  }
  const base = proxyBase.replace(/\/+$/, '');
  return `${base}/api/download?id=${encodeURIComponent(item.id)}`;
}

export function decodeHeaderFilename(
  xArchiveFilename: string | null,
  contentDisposition: string | null,
  fallbackTitle: string
): string {
  if (xArchiveFilename) {
    try {
      const decoded = decodeURIComponent(xArchiveFilename.trim());
      if (decoded) return decoded;
    } catch {
      const trimmed = xArchiveFilename.trim();
      if (trimmed) return trimmed;
    }
  }

  if (contentDisposition) {
    const utf8Match = contentDisposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
    if (utf8Match?.[1]) {
      try {
        const decoded = decodeURIComponent(utf8Match[1].trim()).replace(/["\r\n]/g, '');
        if (decoded) return decoded;
      } catch {
        // Fall through to plain filename=
      }
    }
    const plainMatch = contentDisposition.match(/filename\s*=\s*"?([^";\r\n]+)"?/i);
    if (plainMatch?.[1]?.trim()) {
      return plainMatch[1].trim();
    }
  }

  const safeBase = fallbackTitle.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'amiga_game';
  const lowBase = safeBase.toLowerCase();
  return lowBase.endsWith('.zip') || lowBase.endsWith('.lha') ? safeBase : `${safeBase}.zip`;
}

export async function fetchCatalogPage(opts: {
  proxyBase?: string;
  source?: CatalogSource;
  category: CatalogCategory;
  letter?: PlanetemuLetter;
  query: string;
  page: number;
  signal?: AbortSignal;
  bypassCache?: boolean;
}): Promise<CatalogPageResponse> {
  const proxyBase = (opts.proxyBase ?? getDefaultCatalogProxyBase()).replace(/\/+$/, '');
  const source: CatalogSource = opts.source ?? 'amiga500archive';
  const categoryOrLetter =
    source === 'planetemu' || source === 'whdload' ? (opts.letter ?? '0') : opts.category;
  const cacheKey = makeCatalogCacheKey(proxyBase, source, categoryOrLetter, opts.query, opts.page);

  if (!opts.bypassCache) {
    const cached = catalogCache.get(cacheKey);
    if (cached) return cached;
  }

  const url = buildCatalogApiUrl(proxyBase, {
    source,
    category: opts.category,
    letter: opts.letter,
    query: opts.query,
    page: opts.page,
  });

  const resp = await fetch(url, {
    signal: opts.signal,
    headers: { Accept: 'application/json' },
  });

  if (!resp.ok) {
    let serverErr = '';
    try {
      const errJson = (await resp.json()) as { error?: string };
      if (errJson?.error) serverErr = errJson.error;
    } catch {
      // Ignore non-JSON error body
    }
    throw new Error(serverErr || `Ошибка каталога (HTTP ${resp.status})`);
  }

  const data = (await resp.json()) as CatalogPageResponse;
  if (!data || !data.ok || !Array.isArray(data.items)) {
    throw new Error(data?.error || 'Некорректный ответ сервера каталога');
  }

  catalogCache.set(cacheKey, data);
  return data;
}

export async function downloadCatalogArchiveByUrl(opts: {
  proxyBase?: string;
  proxyDownloadUrl: string;
  fallbackTitle: string;
  signal?: AbortSignal;
}): Promise<{ filename: string; bytes: Uint8Array }> {
  const proxyBase = (opts.proxyBase ?? getDefaultCatalogProxyBase()).replace(/\/+$/, '');
  const url = resolveProxyUrl(proxyBase, opts.proxyDownloadUrl);

  const resp = await fetch(url, { signal: opts.signal });
  if (!resp.ok) {
    let serverErr = '';
    try {
      const errJson = (await resp.json()) as { error?: string };
      if (errJson?.error) serverErr = errJson.error;
    } catch {
      // Ignore non-JSON error body
    }
    throw new Error(serverErr || `Не удалось скачать «${opts.fallbackTitle}» (HTTP ${resp.status})`);
  }

  const filename = decodeHeaderFilename(
    resp.headers.get('X-Archive-Filename'),
    resp.headers.get('Content-Disposition'),
    opts.fallbackTitle
  );
  const bytes = new Uint8Array(await resp.arrayBuffer());
  if (bytes.length === 0) {
    throw new Error(`Архив «${opts.fallbackTitle}» пуст. Попробуйте обновить каталог.`);
  }

  return { filename, bytes };
}

export async function downloadCatalogArchive(opts: {
  proxyBase?: string;
  item: CatalogGameItem;
  signal?: AbortSignal;
}): Promise<{ filename: string; bytes: Uint8Array }> {
  const proxyBase = (opts.proxyBase ?? getDefaultCatalogProxyBase()).replace(/\/+$/, '');
  return downloadCatalogArchiveByUrl({
    proxyBase,
    proxyDownloadUrl: resolveCatalogDownloadUrl(proxyBase, opts.item),
    fallbackTitle: opts.item.title,
    signal: opts.signal,
  });
}

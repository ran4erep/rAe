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

export interface CatalogGameItem {
  id: string;
  title: string;
  firms: string[];
  coverPath: string | null;
  coverUrl: string | null;
  proxyCoverUrl: string | null;
  proxyDownloadUrl: string;
}

export interface CatalogPageResponse {
  ok: boolean;
  source: string;
  category: string;
  query: string;
  page: number;
  totalPages: number;
  hasPrev: boolean;
  hasNext: boolean;
  items: CatalogGameItem[];
  error?: string;
}

export const DEFAULT_CATALOG_PROXY_URL = 'https://amiga-proxy.vercel.app';

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
  category: CatalogCategory,
  query: string,
  page: number
): string {
  return `${proxyBase}|${category}|${query.trim().toLowerCase()}|${page}`;
}

export function buildCatalogApiUrl(
  proxyBase: string,
  opts: { category: CatalogCategory; query: string; page: number }
): string {
  const base = proxyBase.replace(/\/+$/, '');
  const params = new URLSearchParams();
  const q = opts.query.trim();
  if (q) {
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

export function resolveCatalogDownloadUrl(proxyBase: string, item: CatalogGameItem): string {
  const base = proxyBase.replace(/\/+$/, '');
  if (item.proxyDownloadUrl) {
    return item.proxyDownloadUrl.startsWith('http')
      ? item.proxyDownloadUrl
      : `${base}${item.proxyDownloadUrl.startsWith('/') ? '' : '/'}${item.proxyDownloadUrl}`;
  }
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
  return `${safeBase}.zip`;
}

export async function fetchCatalogPage(opts: {
  proxyBase?: string;
  category: CatalogCategory;
  query: string;
  page: number;
  signal?: AbortSignal;
  bypassCache?: boolean;
}): Promise<CatalogPageResponse> {
  const proxyBase = (opts.proxyBase || DEFAULT_CATALOG_PROXY_URL).replace(/\/+$/, '');
  const cacheKey = makeCatalogCacheKey(proxyBase, opts.category, opts.query, opts.page);

  if (!opts.bypassCache) {
    const cached = catalogCache.get(cacheKey);
    if (cached) return cached;
  }

  const url = buildCatalogApiUrl(proxyBase, {
    category: opts.category,
    query: opts.query,
    page: opts.page,
  });

  const resp = await fetch(url, {
    signal: opts.signal,
    headers: { Accept: 'application/json' },
  });

  if (!resp.ok) {
    throw new Error(`Ошибка каталога (HTTP ${resp.status})`);
  }

  const data = (await resp.json()) as CatalogPageResponse;
  if (!data || !data.ok || !Array.isArray(data.items)) {
    throw new Error(data?.error || 'Некорректный ответ сервера каталога');
  }

  catalogCache.set(cacheKey, data);
  return data;
}

export async function downloadCatalogArchive(opts: {
  proxyBase?: string;
  item: CatalogGameItem;
  signal?: AbortSignal;
}): Promise<{ filename: string; bytes: Uint8Array }> {
  const proxyBase = (opts.proxyBase || DEFAULT_CATALOG_PROXY_URL).replace(/\/+$/, '');
  const url = resolveCatalogDownloadUrl(proxyBase, opts.item);

  const resp = await fetch(url, { signal: opts.signal });
  if (!resp.ok) {
    throw new Error(`Не удалось скачать «${opts.item.title}» (HTTP ${resp.status})`);
  }

  const filename = decodeHeaderFilename(
    resp.headers.get('X-Archive-Filename'),
    resp.headers.get('Content-Disposition'),
    opts.item.title
  );
  const bytes = new Uint8Array(await resp.arrayBuffer());
  if (bytes.length === 0) {
    throw new Error(`Архив «${opts.item.title}» пуст. Попробуйте обновить каталог.`);
  }

  return { filename, bytes };
}

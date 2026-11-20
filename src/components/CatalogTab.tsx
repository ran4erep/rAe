import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2, RotateCw, Search, X } from 'lucide-react';
import {
  CATALOG_CATEGORIES,
  CatalogCategory,
  CatalogGameItem,
  CatalogPageResponse,
  DEFAULT_CATALOG_PROXY_URL,
  fetchCatalogPage,
  resolveCatalogCoverUrl,
} from '../emulator/catalog/amigaArchiveCatalog';
import { FloppyDiskIcon } from './FloppyDiskIcon';

export interface CatalogViewState {
  category: CatalogCategory;
  searchInput: string;
  activeQuery: string;
  page: number;
  data: CatalogPageResponse | null;
  loadedKey: string | null;
  scrollTop: number;
}

export function createInitialCatalogViewState(): CatalogViewState {
  return {
    category: 'games',
    searchInput: '',
    activeQuery: '',
    page: 1,
    data: null,
    loadedKey: null,
    scrollTop: 0,
  };
}

interface CatalogTabProps {
  proxyBase?: string;
  catalogState: CatalogViewState;
  onChangeCatalogState: React.Dispatch<React.SetStateAction<CatalogViewState>>;
  launchingItemId: string | null;
  onLaunchCatalogItem: (item: CatalogGameItem) => Promise<void>;
}

const CatalogCover: React.FC<{ src: string | null; title: string }> = React.memo(({ src, title }) => {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (!src || failed) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center gap-1.5 bg-gradient-to-br from-[#21242B] to-[#13151A] text-[#78746B] px-2 text-center">
        <FloppyDiskIcon className="w-6 h-6 text-[#E07A22]/75" />
        <span className="text-[10px] font-medium text-[#A7A39A] line-clamp-2">{title}</span>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={title}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
      draggable={false}
    />
  );
});
CatalogCover.displayName = 'CatalogCover';

export const CatalogTab: React.FC<CatalogTabProps> = ({
  proxyBase = DEFAULT_CATALOG_PROXY_URL,
  catalogState,
  onChangeCatalogState,
  launchingItemId,
  onLaunchCatalogItem,
}) => {
  const { category, searchInput, activeQuery, page, data, loadedKey } = catalogState;
  const [reloadNonce, setReloadNonce] = useState(0);
  const requestKey = `${proxyBase}|${category}|${activeQuery}|${page}`;
  const needsFetch = reloadNonce > 0 || loadedKey !== requestKey || data === null;

  const [loading, setLoading] = useState(needsFetch);
  const [error, setError] = useState<string | null>(null);
  const gridTopRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (reloadNonce === 0 && loadedKey === requestKey && data !== null) {
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fetchCatalogPage({
      proxyBase,
      category,
      query: activeQuery,
      page,
      signal: controller.signal,
      bypassCache: reloadNonce > 0,
    })
      .then((res) => {
        if (controller.signal.aborted) return;
        setReloadNonce(0);
        onChangeCatalogState((prev) => ({
          ...prev,
          data: res,
          loadedKey: requestKey,
        }));
        setLoading(false);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Не удалось загрузить каталог игр.');
        setLoading(false);
      });

    return () => controller.abort();
  }, [activeQuery, category, data, loadedKey, onChangeCatalogState, page, proxyBase, reloadNonce, requestKey]);

  const scrollListToTop = useCallback(() => {
    gridTopRef.current?.scrollIntoView({ block: 'start', behavior: 'auto' });
  }, []);

  const handleSelectCategory = useCallback(
    (nextCat: CatalogCategory) => {
      onChangeCatalogState((prev) => ({
        ...prev,
        category: nextCat,
        searchInput: '',
        activeQuery: '',
        page: 1,
        scrollTop: 0,
      }));
      scrollListToTop();
    },
    [onChangeCatalogState, scrollListToTop]
  );

  const handleSubmitSearch = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      onChangeCatalogState((prev) => ({
        ...prev,
        activeQuery: prev.searchInput.trim(),
        page: 1,
        scrollTop: 0,
      }));
      scrollListToTop();
    },
    [onChangeCatalogState, scrollListToTop]
  );

  const handleClearSearch = useCallback(() => {
    onChangeCatalogState((prev) => ({
      ...prev,
      searchInput: '',
      activeQuery: '',
      page: 1,
      scrollTop: 0,
    }));
  }, [onChangeCatalogState]);

  const items = data?.items ?? [];
  const totalPages = data?.totalPages ?? 1;

  return (
    <div ref={gridTopRef} className="space-y-3">
      {/* Search + Categories */}
      <div className="space-y-2">
        <form onSubmit={handleSubmitSearch} className="flex items-center gap-1.5">
          <div className="relative flex-1 min-w-0">
            <Search className="w-3.5 h-3.5 text-[#8D8980] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={searchInput}
              onChange={(e) => {
                const value = e.target.value;
                onChangeCatalogState((prev) => ({ ...prev, searchInput: value }));
              }}
              placeholder="Поиск игры или автора (Turrican, Lemmings...)"
              aria-label="Поиск игр в каталоге"
              className="w-full h-9 pl-8 pr-8 rounded-lg bg-[#14161A] border border-white/10 text-xs text-[#F2EFE9] placeholder:text-[#78746B] focus:outline-none focus:border-[#E07A22]/60"
            />
            {(searchInput || activeQuery) && (
              <button
                type="button"
                onClick={handleClearSearch}
                aria-label="Очистить поиск"
                className="w-7 h-7 rounded flex items-center justify-center text-[#8D8980] hover:text-[#F2EFE9] absolute right-1 top-1/2 -translate-y-1/2"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <button
            type="submit"
            className="h-9 px-3 rounded-lg bg-[#2A2D33] hover:bg-[#383C44] text-xs font-semibold text-[#F2EFE9] shrink-0 whitespace-nowrap"
          >
            Найти
          </button>
        </form>

        <div
          className="flex items-center gap-1 overflow-x-auto pb-0.5"
          role="group"
          aria-label="Категории каталога"
        >
          {CATALOG_CATEGORIES.map((cat) => {
            const isSelected = !activeQuery && category === cat.id;
            return (
              <button
                key={cat.id}
                type="button"
                onClick={() => handleSelectCategory(cat.id)}
                className={`h-8 px-2.5 rounded-md text-xs font-medium whitespace-nowrap shrink-0 transition-colors ${
                  isSelected
                    ? 'bg-[#E07A22] text-[#141518] font-semibold'
                    : 'bg-[#16181C] border border-white/8 text-[#BDB9B0] hover:text-[#F2EFE9] hover:bg-[#23262D]'
                }`}
              >
                {cat.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Status Header */}
      <div className="flex items-center justify-between gap-2 text-[11px] text-[#8D8980]">
        <span className="truncate">
          {activeQuery
            ? `Поиск: «${activeQuery}»`
            : `Amiga 500 Archive · ${CATALOG_CATEGORIES.find((c) => c.id === category)?.label ?? 'Игры'}`}
        </span>
        {data && !loading && (
          <span className="font-mono tabular-nums shrink-0">
            Стр. {data.page} / {data.totalPages}
          </span>
        )}
      </div>

      {/* Grid: Loading / Error / Empty / Cards */}
      {loading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5" aria-label="Загрузка каталога">
          {Array.from({ length: 6 }).map((_, idx) => (
            <div
              key={idx}
              className="bg-[#16181C] border border-white/8 rounded-lg overflow-hidden animate-pulse"
            >
              <div className="aspect-[5/4] bg-[#20232A]" />
              <div className="p-2.5 space-y-2">
                <div className="h-3.5 bg-[#262A33] rounded w-4/5" />
                <div className="h-2.5 bg-[#20232A] rounded w-1/2" />
                <div className="h-8 bg-[#262A33] rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="bg-[#16181C] border border-[#C8342A]/35 rounded-lg p-5 text-center space-y-3">
          <p className="text-xs text-[#FF9E98]">{error}</p>
          <button
            type="button"
            onClick={() => setReloadNonce((n) => n + 1)}
            className="h-8 px-3 rounded-md bg-[#2A2D33] hover:bg-[#383C44] text-xs font-medium text-[#F2EFE9] inline-flex items-center gap-1.5"
          >
            <RotateCw className="w-3.5 h-3.5" />
            Повторить
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className="bg-[#16181C] border border-white/8 rounded-lg p-6 text-center space-y-3">
          <p className="text-xs text-[#A7A39A]">
            {activeQuery ? `По запросу «${activeQuery}» ничего не найдено.` : 'Список пуст.'}
          </p>
          {activeQuery && (
            <button
              type="button"
              onClick={handleClearSearch}
              className="h-8 px-3 rounded-md bg-[#2A2D33] hover:bg-[#383C44] text-xs font-medium text-[#F2EFE9]"
            >
              Сбросить поиск
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
          {items.map((item) => {
            const coverSrc = resolveCatalogCoverUrl(proxyBase, item);
            const isDownloading = launchingItemId === item.id;
            const disableActions = launchingItemId !== null;
            const firmsLabel = item.firms.length > 0 ? item.firms.join(' · ') : 'Amiga 500';

            return (
              <article
                key={item.id}
                className="group bg-[#16181C] border border-white/8 hover:border-white/18 rounded-lg overflow-hidden flex flex-col transition-colors"
              >
                <div className="aspect-[5/4] bg-[#0D0F13] overflow-hidden border-b border-white/6 relative">
                  <CatalogCover src={coverSrc} title={item.title} />
                </div>

                <div className="p-2.5 flex-1 flex flex-col justify-between gap-2">
                  <div className="min-w-0">
                    <h4
                      className="text-xs font-semibold text-[#F2EFE9] truncate"
                      title={item.title}
                    >
                      {item.title}
                    </h4>
                    <p className="text-[10.5px] text-[#8D8980] truncate mt-0.5" title={firmsLabel}>
                      {firmsLabel}
                    </p>
                  </div>

                  <button
                    type="button"
                    disabled={disableActions}
                    onClick={() => void onLaunchCatalogItem(item)}
                    aria-label={`Выбрать ${item.title}`}
                    className="w-full h-8 px-2.5 rounded-md bg-[#C8342A] hover:bg-[#D94035] disabled:opacity-50 text-[11px] font-semibold text-white flex items-center justify-center gap-1.5 whitespace-nowrap transition-colors"
                  >
                    {isDownloading ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                        <span>Загрузка...</span>
                      </>
                    ) : (
                      <>
                        <FloppyDiskIcon className="w-3.5 h-3.5 shrink-0" />
                        <span>Выбрать</span>
                      </>
                    )}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* Pagination Footer */}
      {totalPages > 1 && (
        <div className="pt-1 flex items-center justify-between gap-2">
          <button
            type="button"
            disabled={loading || page <= 1}
            onClick={() => {
              onChangeCatalogState((prev) => ({
                ...prev,
                page: Math.max(1, prev.page - 1),
                scrollTop: 0,
              }));
              scrollListToTop();
            }}
            className="h-8 px-2.5 rounded-md bg-[#2A2D33] hover:bg-[#383C44] disabled:opacity-35 disabled:pointer-events-none text-xs font-medium text-[#F2EFE9] flex items-center gap-1"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
            Назад
          </button>

          <span className="text-xs font-mono tabular-nums text-[#A7A39A]">
            {page} / {totalPages}
          </span>

          <button
            type="button"
            disabled={loading || page >= totalPages || !data?.hasNext}
            onClick={() => {
              onChangeCatalogState((prev) => ({
                ...prev,
                page: prev.page + 1,
                scrollTop: 0,
              }));
              scrollListToTop();
            }}
            className="h-8 px-2.5 rounded-md bg-[#2A2D33] hover:bg-[#383C44] disabled:opacity-35 disabled:pointer-events-none text-xs font-medium text-[#F2EFE9] flex items-center gap-1"
          >
            Вперёд
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
};

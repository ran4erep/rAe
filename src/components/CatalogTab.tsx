import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ChevronLeft, ChevronRight, Loader2, RotateCw, Search, X } from 'lucide-react';
import {
  CATALOG_CATEGORIES,
  CATALOG_SOURCES,
  CatalogCategory,
  CatalogGameItem,
  CatalogPageResponse,
  CatalogSource,
  fetchCatalogPage,
  getDefaultCatalogProxyBase,
  PLANETEMU_LETTERS,
  PlanetemuLetter,
  resolveCatalogCoverUrl,
} from '../emulator/catalog/amigaArchiveCatalog';
import {
  groupPlanetemuItemsByPlatform,
  PlanetemuPlatform,
} from '../emulator/catalog/planetemuGrouping';
import { FloppyDiskIcon } from './FloppyDiskIcon';

export interface CatalogViewState {
  source: CatalogSource;
  category: CatalogCategory;
  letter: PlanetemuLetter;
  searchInput: string;
  activeQuery: string;
  page: number;
  data: CatalogPageResponse | null;
  loadedKey: string | null;
  scrollTop: number;
}

export function createInitialCatalogViewState(): CatalogViewState {
  return {
    source: 'amiga500archive',
    category: 'games',
    letter: '0',
    searchInput: '',
    activeQuery: '',
    page: 1,
    data: null,
    loadedKey: null,
    scrollTop: 0,
  };
}

function pluralRu(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs >= 11 && abs <= 19) return `${n} ${many}`;
  if (last === 1) return `${n} ${one}`;
  if (last >= 2 && last <= 4) return `${n} ${few}`;
  return `${n} ${many}`;
}

function platformBadgeClasses(platform: PlanetemuPlatform): string {
  switch (platform) {
    case 'CD32':
      return 'text-[#D8B4FE] bg-[#7C3AED]/22 border-[#8B5CF6]/50';
    case 'CDTV':
      return 'text-[#7DD3FC] bg-[#0284C7]/20 border-[#0EA5E9]/45';
    case 'AGA':
      return 'text-[#FDBA74] bg-[#E07A22]/18 border-[#E07A22]/45';
    case 'OCS-AGA':
      return 'text-[#7AD39B] bg-[#58B87C]/15 border-[#58B87C]/35';
    case 'OCS/ECS':
      return 'text-[#BDB9B0] bg-white/6 border-white/14';
  }
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
        <FloppyDiskIcon className="w-6 h-6 text-[#E07A22]/75 shrink-0" />
        <span className="text-[10px] font-medium text-[#A7A39A] break-words [overflow-wrap:anywhere] leading-snug line-clamp-3">
          {title}
        </span>
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
  proxyBase = getDefaultCatalogProxyBase(),
  catalogState,
  onChangeCatalogState,
  launchingItemId,
  onLaunchCatalogItem,
}) => {
  const { source, category, letter, searchInput, activeQuery, page, data, loadedKey } = catalogState;
  const [reloadNonce, setReloadNonce] = useState(0);
  const categoryOrLetter = source === 'planetemu' ? letter : category;
  const requestKey = `${proxyBase}|${source}|${categoryOrLetter}|${activeQuery}|${page}`;
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
      source,
      category,
      letter,
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
  }, [
    activeQuery,
    category,
    data,
    letter,
    loadedKey,
    onChangeCatalogState,
    page,
    proxyBase,
    reloadNonce,
    requestKey,
    source,
  ]);

  const scrollListToTop = useCallback(() => {
    gridTopRef.current?.scrollIntoView({ block: 'start', behavior: 'auto' });
  }, []);

  const handleSelectSource = useCallback(
    (nextSource: CatalogSource) => {
      if (nextSource === source) return;
      setReloadNonce(0);
      onChangeCatalogState((prev) => ({
        ...prev,
        source: nextSource,
        page: 1,
        data: null,
        loadedKey: null,
        scrollTop: 0,
      }));
      scrollListToTop();
    },
    [onChangeCatalogState, scrollListToTop, source]
  );

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

  const handleSelectLetter = useCallback(
    (nextLetter: PlanetemuLetter) => {
      onChangeCatalogState((prev) => ({
        ...prev,
        letter: nextLetter,
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
  const isPlanetemu = source === 'planetemu';

  const planetemuItems = useMemo(
    () => (isPlanetemu ? groupPlanetemuItemsByPlatform(items, activeQuery) : []),
    [activeQuery, isPlanetemu, items]
  );

  return (
    <div ref={gridTopRef} className="space-y-3">
      {/* Source Switcher */}
      <div
        className="flex items-center gap-1 p-1 bg-[#121317] rounded-lg border border-white/6"
        role="tablist"
        aria-label="Источник каталога игр"
      >
        {CATALOG_SOURCES.map((srcOpt) => {
          const active = source === srcOpt.id;
          return (
            <button
              key={srcOpt.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => handleSelectSource(srcOpt.id)}
              className={`flex-1 min-w-0 h-8 px-2.5 rounded-md text-xs font-semibold whitespace-nowrap truncate transition-colors ${
                active
                  ? 'bg-[#2A2D33] text-[#F2EFE9] border border-white/10'
                  : 'text-[#8D8980] hover:text-[#F2EFE9] hover:bg-white/5'
              }`}
            >
              {srcOpt.label}
            </button>
          );
        })}
      </div>

      {/* Search + Categories / Alphabet */}
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
              placeholder={
                isPlanetemu
                  ? 'Поиск в Planetemu (Turrican, Aladdin, Lemmings...)'
                  : 'Поиск игры или автора (Turrican, Lemmings...)'
              }
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

        {isPlanetemu ? (
          <div
            className="flex items-center flex-wrap gap-1"
            role="group"
            aria-label="Алфавитный указатель Planetemu"
          >
            {PLANETEMU_LETTERS.map((lt) => {
              const isSelected = !activeQuery && letter === lt;
              const label = lt === '0' ? '0-9' : lt;
              return (
                <button
                  key={lt}
                  type="button"
                  onClick={() => handleSelectLetter(lt)}
                  aria-label={`Игры на букву ${label}`}
                  className={`h-7 min-w-[28px] px-1.5 rounded text-[11px] font-mono tabular-nums font-medium whitespace-nowrap transition-colors ${
                    isSelected
                      ? 'bg-[#E07A22] text-[#141518] font-bold'
                      : 'bg-[#16181C] border border-white/8 text-[#BDB9B0] hover:text-[#F2EFE9] hover:bg-[#23262D]'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        ) : (
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
        )}
      </div>

      {/* Status Header */}
      <div className="flex items-start justify-between gap-2 text-[11px] text-[#8D8980]">
        <span className="min-w-0 break-words [overflow-wrap:anywhere]">
          {activeQuery
            ? `${isPlanetemu ? (data?.fallbackFrom ? 'Planetemu (зеркало TOSEC)' : 'Planetemu') : 'Amiga 500 Archive'} · Поиск: «${activeQuery}»`
            : isPlanetemu
              ? `${data?.fallbackFrom ? 'Planetemu (зеркало TOSEC)' : 'Planetemu'} · Раздел ${letter === '0' ? '0-9' : letter}${
                  data?.totalItems !== undefined ? ` · ${pluralRu(data.totalItems, 'игра', 'игры', 'игр')}` : ''
                }`
              : `Amiga 500 Archive · ${CATALOG_CATEGORIES.find((c) => c.id === category)?.label ?? 'Игры'}`}
        </span>
        {data && !loading && (
          <span className="font-mono tabular-nums shrink-0">
            Стр. {data.page} / {data.totalPages}
          </span>
        )}
      </div>

      {/* Listing: Loading / Error / Empty / Cards or List */}
      {loading ? (
        isPlanetemu ? (
          <div className="space-y-1.5" aria-label="Загрузка списка игр Planetemu">
            {Array.from({ length: 8 }).map((_, idx) => (
              <div
                key={idx}
                className="bg-[#16181C] border border-white/8 rounded-lg px-3 py-2.5 flex items-center justify-between gap-3 animate-pulse"
              >
                <div className="space-y-1.5 flex-1 min-w-0">
                  <div className="h-3.5 bg-[#262A33] rounded w-3/5" />
                  <div className="h-2.5 bg-[#20232A] rounded w-2/5" />
                </div>
                <div className="h-8 w-20 bg-[#262A33] rounded-md shrink-0" />
              </div>
            ))}
          </div>
        ) : (
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
        )
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
      ) : isPlanetemu ? (
        <div className="space-y-1.5" data-testid="planetemu-list">
          {planetemuItems.map((item) => {
            const isDownloading = launchingItemId === item.id;
            const disableActions = launchingItemId !== null;
            const fileCount = item.files?.length ?? 1;
            const diskCount = item.diskCount ?? 1;

            const metaParts: string[] = [];
            if (item.year) metaParts.push(item.year);
            if (item.firms.length > 0) metaParts.push(item.firms.join(' · '));
            if (item.tags && item.tags.length > 0) metaParts.push(item.tags.join(' · '));
            if (diskCount > 1) {
              metaParts.push(pluralRu(diskCount, 'дискета', 'дискеты', 'дискет'));
            }
            if (fileCount > 1) {
              metaParts.push(pluralRu(fileCount, 'вариант', 'варианта', 'вариантов'));
            } else if (item.files?.[0]?.sizeLabel) {
              metaParts.push(item.files[0].sizeLabel);
            }
            const metaLine = metaParts.join(' · ') || 'Amiga';

            return (
              <article
                key={item.id}
                className="bg-[#16181C] border border-white/8 hover:border-white/18 rounded-lg px-3 py-2.5 flex items-center justify-between gap-3 transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-start flex-wrap gap-1.5">
                    <h4 className="text-xs sm:text-[13px] font-semibold text-[#F2EFE9] leading-snug break-words [overflow-wrap:anywhere]">
                      {item.title}
                    </h4>
                    <span
                      className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded border leading-none shrink-0 mt-0.5 ${platformBadgeClasses(
                        item.platform
                      )}`}
                    >
                      {item.platform}
                    </span>
                  </div>
                  <p className="text-[11px] text-[#8D8980] leading-snug break-words [overflow-wrap:anywhere] mt-1 tabular-nums">
                    {metaLine}
                  </p>
                </div>

                <button
                  type="button"
                  disabled={disableActions}
                  onClick={() => void onLaunchCatalogItem(item)}
                  aria-label={`Открыть ${item.title}`}
                  className="h-8 px-3 rounded-md bg-[#C8342A] hover:bg-[#D94035] disabled:opacity-50 text-[11px] font-semibold text-white inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
                >
                  {isDownloading ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                      <span>Загрузка...</span>
                    </>
                  ) : diskCount > 1 ? (
                    <>
                      <Archive className="w-3.5 h-3.5 text-white/90 shrink-0" />
                      <span className="tabular-nums">Диски ({diskCount})</span>
                    </>
                  ) : fileCount > 1 ? (
                    <>
                      <Archive className="w-3.5 h-3.5 text-white/90 shrink-0" />
                      <span className="tabular-nums">Варианты ({fileCount})</span>
                    </>
                  ) : (
                    <>
                      <FloppyDiskIcon className="w-3.5 h-3.5 shrink-0" />
                      <span>Выбрать</span>
                    </>
                  )}
                </button>
              </article>
            );
          })}
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
                    <h4 className="text-xs font-semibold text-[#F2EFE9] leading-snug break-words [overflow-wrap:anywhere]">
                      {item.title}
                    </h4>
                    <p className="text-[10.5px] text-[#8D8980] leading-snug break-words [overflow-wrap:anywhere] mt-0.5">
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

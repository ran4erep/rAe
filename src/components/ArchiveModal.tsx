import React, { useEffect, useMemo, useState } from 'react';
import { Archive, ArrowLeft, FileText, HardDrive, Loader2, Search, X } from 'lucide-react';
import { FloppyDiskIcon } from './FloppyDiskIcon';
import {
  ArchiveFileEntry,
  ArchiveMediaCandidate,
  ResolvedUploadResult,
} from '../emulator/archives/archiveManager';
import {
  groupArchiveFilesByDisk,
  pickDualAdfPair,
} from '../emulator/archives/archiveDiskGrouping';
import { formatStorageBytes } from './HardfileSizePanel';

export interface PendingArchiveChoice {
  target: 0 | 1 | 'dh1';
  result: Extract<ResolvedUploadResult, { kind: 'archive-choices' | 'archive-files' }>;
}

interface ArchiveModalProps {
  pendingArchive: PendingArchiveChoice | null;
  insertedDf0Name?: string;
  insertedDf1Name?: string;
  mountedDh1Name?: string;
  backLabel?: string;
  onBack?: () => void;
  onClose: () => void;
  onSelectArchiveMedia: (item: ArchiveMediaCandidate, target: 0 | 1 | 'dh1' | 'rom') => Promise<void>;
  onMountArchiveDualAdf: (first: ArchiveMediaCandidate, second: ArchiveMediaCandidate) => Promise<void>;
  onPackArchiveAsAdf: (drive: 0 | 1) => Promise<void>;
  onPackArchiveAsHdf: () => Promise<void>;
}

const MAX_VISIBLE_DEFAULT = 250;

export { pickDualAdfPair };

export const ArchiveModal: React.FC<ArchiveModalProps> = ({
  pendingArchive,
  insertedDf0Name,
  insertedDf1Name,
  mountedDh1Name,
  backLabel = 'Назад',
  onBack,
  onClose,
  onSelectArchiveMedia,
  onMountArchiveDualAdf,
  onPackArchiveAsAdf,
  onPackArchiveAsHdf,
}) => {
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const result = pendingArchive?.result;

  useEffect(() => {
    setBusyKey(null);
    setQuery('');
    setShowAll(false);
  }, [result]);

  const mediaById = useMemo(() => {
    const map = new Map<string, ArchiveMediaCandidate>();
    if (result?.kind === 'archive-choices') {
      for (const item of result.mediaItems) {
        map.set(item.id, item);
      }
    }
    return map;
  }, [result]);

  const adfCandidates = useMemo(
    () =>
      result?.kind === 'archive-choices'
        ? result.mediaItems.filter((item) => item.kind === 'adf')
        : [],
    [result]
  );

  const dualPair = useMemo(() => pickDualAdfPair(adfCandidates), [adfCandidates]);

  const filteredFiles = useMemo(() => {
    if (!result) return [];
    const q = query.trim().toLowerCase();
    const baseList = q
      ? result.allFiles.filter((f) => f.path.toLowerCase().includes(q))
      : result.allFiles;
    return baseList;
  }, [query, result]);

  const visibleFiles: ArchiveFileEntry[] = useMemo(
    () =>
      showAll || filteredFiles.length <= MAX_VISIBLE_DEFAULT
        ? filteredFiles
        : filteredFiles.slice(0, MAX_VISIBLE_DEFAULT),
    [filteredFiles, showAll]
  );

  const diskSections = useMemo(
    () => groupArchiveFilesByDisk(visibleFiles, mediaById),
    [mediaById, visibleFiles]
  );

  if (!pendingArchive || !result) return null;

  const hiddenCount = filteredFiles.length - visibleFiles.length;
  const floppyDrive: 0 | 1 = pendingArchive.target === 1 ? 1 : 0;
  const isBusy = busyKey !== null;

  const runAction = async (key: string, fn: () => Promise<void>) => {
    if (isBusy) return;
    setBusyKey(key);
    try {
      await fn();
    } finally {
      setBusyKey((cur) => (cur === key ? null : cur));
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/75"
      role="dialog"
      aria-modal="true"
      aria-label={`Содержимое архива ${result.archiveName}`}
      onClick={(e) => {
        if (e.target === e.currentTarget && !isBusy) onClose();
      }}
    >
      <div className="w-full sm:max-w-xl max-h-[86dvh] bg-[#1B1E24] border-t sm:border border-[#E07A22]/35 rounded-t-2xl sm:rounded-xl flex flex-col overflow-hidden shadow-2xl">
        {/* Modal Header */}
        <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between gap-3 shrink-0 bg-[#14171D]">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-lg bg-[#E07A22]/15 border border-[#E07A22]/35 flex items-center justify-center shrink-0">
              <Archive className="w-4 h-4 text-[#E07A22]" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-bold text-[#F2EFE9] break-words [overflow-wrap:anywhere]">
                {result.archiveName}
              </h2>
              <p className="text-[11px] text-[#A7A39A] font-mono tabular-nums">
                {result.archiveFormat} · Файлов: {result.allFiles.length} ·{' '}
                {formatStorageBytes(result.totalBytes)}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {onBack && (
              <button
                type="button"
                disabled={isBusy}
                onClick={onBack}
                aria-label={`Вернуться назад (${backLabel})`}
                title={`Вернуться: ${backLabel}`}
                className="h-9 px-2.5 rounded-lg bg-[#2A2D33] hover:bg-[#353941] disabled:opacity-50 text-xs font-medium text-[#E6E2D9] inline-flex items-center gap-1 shrink-0"
              >
                <ArrowLeft className="w-3.5 h-3.5 shrink-0" />
                <span>{backLabel}</span>
              </button>
            )}
            <button
              type="button"
              disabled={isBusy}
              onClick={onClose}
              aria-label="Закрыть окно содержимого архива"
              className="w-9 h-9 rounded-lg bg-[#2A2D33] hover:bg-[#353941] disabled:opacity-50 flex items-center justify-center text-[#E6E2D9] shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Quick Actions Bar */}
        {(() => {
          const canPackFiles = result.kind === 'archive-files' || result.otherFileCount > 0;
          const hasQuickActions = dualPair !== null || canPackFiles;
          if (!hasQuickActions) {
            return result.kind === 'archive-choices' && adfCandidates.length === 1 ? (
              <div className="px-4 py-2 border-b border-white/8 bg-[#171A20] text-xs text-[#BDB9B0] shrink-0">
                Выберите дисковод (<span className="font-mono text-[#E07A22]">DF0:</span> или{' '}
                <span className="font-mono text-[#D8D4CC]">DF1:</span>), чтобы вставить дискету:
              </div>
            ) : null;
          }
          return (
            <div className="px-4 py-2.5 border-b border-white/8 bg-[#171A20] flex flex-wrap items-center gap-2 shrink-0">
              {dualPair && (
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => void runAction('dual', () => onMountArchiveDualAdf(dualPair[0], dualPair[1]))}
                  className="h-8 px-3 rounded-md bg-[#C8342A] hover:bg-[#D94035] disabled:opacity-60 text-xs font-semibold text-white flex items-center gap-1.5"
                >
                  {busyKey === 'dual' ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Загрузка дискет...
                    </>
                  ) : (
                    <>
                      <FloppyDiskIcon className="w-3.5 h-3.5" />
                      Вставить 2 дискеты: DF0: + DF1:
                    </>
                  )}
                </button>
              )}

              {canPackFiles && result.fitsFloppy && (
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => void runAction('packAdf', () => onPackArchiveAsAdf(floppyDrive))}
                  className="h-8 px-3 rounded-md bg-[#2A2D33] hover:bg-[#383C44] disabled:opacity-50 text-xs font-medium text-[#E07A22] flex items-center gap-1.5"
                >
                  <FloppyDiskIcon className="w-3.5 h-3.5" />
                  Собрать дискету DF{floppyDrive}: (.ADF)
                </button>
              )}

              {canPackFiles && (
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => void runAction('packHdf', () => onPackArchiveAsHdf())}
                  className="h-8 px-3 rounded-md bg-[#2B5B40] hover:bg-[#346E4E] disabled:opacity-50 text-xs font-semibold text-white flex items-center gap-1.5"
                >
                  <HardDrive className="w-3.5 h-3.5" />
                  Смонтировать в DH1: (.HDF)
                </button>
              )}
            </div>
          );
        })()}

        {/* Search filter for larger archives */}
        {result.allFiles.length > 10 && (
          <div className="px-4 pt-2.5 pb-1 shrink-0">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-[#8D8980] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="search"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setShowAll(false);
                }}
                placeholder="Поиск файла в архиве..."
                aria-label="Поиск файла в архиве"
                className="w-full h-8 pl-8 pr-3 rounded-md bg-[#121418] border border-white/10 text-xs text-[#F2EFE9] placeholder:text-[#78746B] focus:outline-none focus:border-[#E07A22]/60"
              />
            </div>
          </div>
        )}

        {/* Complete File List (separated by disk when multi-disk / multi-variant) */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {visibleFiles.length === 0 ? (
            <p className="text-xs text-[#8D8980] text-center py-6">
              Файлы по запросу «{query}» не найдены.
            </p>
          ) : (
            diskSections.map((section, sIdx) => (
              <div key={section.label ?? `flat-${sIdx}`} className="space-y-1.5">
                {section.label && (
                  <div className="flex items-center justify-between gap-2 px-1 pt-0.5">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-[#E07A22] font-mono">
                      {section.label}
                    </span>
                    {section.files.length > 1 && (
                      <span className="text-[10.5px] font-mono text-[#8D8980] tabular-nums">
                        Вариантов: {section.files.length}
                      </span>
                    )}
                  </div>
                )}

                <div className="space-y-1.5">
                  {section.files.map((entry) => {
                    const mediaItem = mediaById.get(entry.id);
                    const badgeLabel =
                      entry.kind === 'adf'
                        ? 'ADF'
                        : entry.kind === 'hdf'
                          ? 'HDF'
                          : entry.kind === 'rom'
                            ? 'ROM'
                            : 'Файл';
                    const badgeColor =
                      entry.kind === 'adf'
                        ? 'text-[#E07A22] bg-[#E07A22]/12 border-[#E07A22]/30'
                        : entry.kind === 'hdf'
                          ? 'text-[#7AD39B] bg-[#58B87C]/12 border-[#58B87C]/30'
                          : entry.kind === 'rom'
                            ? 'text-[#FF9E98] bg-[#C8342A]/18 border-[#C8342A]/35'
                            : 'text-[#A7A39A] bg-white/5 border-white/10';
                    const isVerified = mediaItem?.isVerified === true;
                    const isBadDump = mediaItem?.isBadDump === true;
                    const isClean = (entry.isClean ?? mediaItem?.isClean) === true;
                    const prereleaseKind = entry.prereleaseKind ?? mediaItem?.prereleaseKind ?? null;
                    const prereleaseLabel =
                      prereleaseKind === 'alpha'
                        ? 'Alpha'
                        : prereleaseKind === 'beta'
                          ? 'Beta'
                          : prereleaseKind === 'proto'
                            ? 'Proto'
                            : prereleaseKind === 'demo'
                              ? 'Demo'
                              : null;

                    return (
                      <div
                        key={entry.id}
                        className="bg-[#14171D] border border-white/8 rounded-lg px-3 py-2 flex items-center justify-between gap-2.5"
                      >
                        <div className="min-w-0 flex-1 flex items-start gap-2">
                          <FileText className="w-3.5 h-3.5 text-[#8D8980] shrink-0 mt-0.5" />
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-medium text-[#F2EFE9] break-words [overflow-wrap:anywhere] leading-snug">
                              {entry.path}
                            </p>
                            <div className="flex flex-wrap items-center gap-1.5 mt-1">
                              <span className={`text-[9.5px] font-mono px-1.5 py-0.5 rounded border ${badgeColor}`}>
                                {badgeLabel}
                              </span>
                              {isVerified && (
                                <span className="text-[9.5px] font-mono px-1.5 py-0.5 rounded border text-[#7AD39B] bg-[#58B87C]/15 border-[#58B87C]/35">
                                  Проверен [!]
                                </span>
                              )}
                              {!isVerified && isClean && (
                                <span className="text-[9.5px] font-mono px-1.5 py-0.5 rounded border text-[#7AD39B] bg-[#58B87C]/12 border-[#58B87C]/30">
                                  Чистый
                                </span>
                              )}
                              {prereleaseLabel && (
                                <span className="text-[9.5px] font-mono px-1.5 py-0.5 rounded border text-[#FDE047] bg-[#CA8A04]/15 border-[#CA8A04]/35">
                                  {prereleaseLabel}
                                </span>
                              )}
                              {isBadDump && (
                                <span className="text-[9.5px] font-mono px-1.5 py-0.5 rounded border text-[#FF9E98] bg-[#C8342A]/18 border-[#C8342A]/35">
                                  Bad dump
                                </span>
                              )}
                              <span className="text-[10px] font-mono text-[#8D8980] tabular-nums">
                                {formatStorageBytes(entry.size)}
                              </span>
                            </div>
                          </div>
                        </div>

                        {mediaItem && (
                          <div className="flex items-center gap-1 shrink-0">
                            {mediaItem.kind === 'adf' && (() => {
                              const inDf0 = insertedDf0Name === mediaItem.name;
                              const inDf1 = insertedDf1Name === mediaItem.name;
                              const keyDf0 = `${mediaItem.id}:0`;
                              const keyDf1 = `${mediaItem.id}:1`;
                              return (
                                <>
                                  <button
                                    type="button"
                                    disabled={isBusy}
                                    onClick={() => void runAction(keyDf0, () => onSelectArchiveMedia(mediaItem, 0))}
                                    aria-label={`Вставить ${mediaItem.name} в DF0`}
                                    className={`h-7 px-2 rounded text-[11px] font-mono inline-flex items-center gap-1 whitespace-nowrap transition-colors disabled:opacity-50 ${
                                      inDf0
                                        ? 'bg-[#E07A22] text-[#141518] font-bold'
                                        : 'bg-[#2A2D33] hover:bg-[#383C44] text-[#E07A22]'
                                    }`}
                                  >
                                    {busyKey === keyDf0 ? (
                                      <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                                    ) : (
                                      <FloppyDiskIcon className="w-3 h-3 shrink-0" />
                                    )}
                                    DF0:
                                  </button>
                                  <button
                                    type="button"
                                    disabled={isBusy}
                                    onClick={() => void runAction(keyDf1, () => onSelectArchiveMedia(mediaItem, 1))}
                                    aria-label={`Вставить ${mediaItem.name} в DF1`}
                                    className={`h-7 px-2 rounded text-[11px] font-mono inline-flex items-center gap-1 whitespace-nowrap transition-colors disabled:opacity-50 ${
                                      inDf1
                                        ? 'bg-[#3B8B59] text-white font-bold'
                                        : 'bg-[#2A2D33] hover:bg-[#383C44] text-[#D8D4CC]'
                                    }`}
                                  >
                                    {busyKey === keyDf1 ? (
                                      <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                                    ) : (
                                      <FloppyDiskIcon className="w-3 h-3 shrink-0" />
                                    )}
                                    DF1:
                                  </button>
                                </>
                              );
                            })()}
                            {mediaItem.kind === 'hdf' && (() => {
                              const keyDh1 = `${mediaItem.id}:dh1`;
                              return (
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => void runAction(keyDh1, () => onSelectArchiveMedia(mediaItem, 'dh1'))}
                                  aria-label={`Смонтировать ${mediaItem.name} в DH1`}
                                  className={`h-7 px-2.5 rounded text-[11px] font-mono inline-flex items-center gap-1 whitespace-nowrap transition-colors disabled:opacity-50 ${
                                    mountedDh1Name === mediaItem.name
                                      ? 'bg-[#3B8B59] text-white font-bold'
                                      : 'bg-[#2A2D33] hover:bg-[#383C44] text-[#7AD39B]'
                                  }`}
                                >
                                  {busyKey === keyDh1 ? (
                                    <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                                  ) : (
                                    <HardDrive className="w-3 h-3 shrink-0" />
                                  )}
                                  DH1:
                                </button>
                              );
                            })()}
                            {mediaItem.kind === 'rom' && (
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => void runAction(`${mediaItem.id}:rom`, () => onSelectArchiveMedia(mediaItem, 'rom'))}
                                className="h-7 px-2.5 rounded bg-[#C8342A] hover:bg-[#D94035] disabled:opacity-50 text-[11px] font-mono text-white"
                              >
                                ROM
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}

          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="w-full h-8 rounded-md bg-[#2A2D33] hover:bg-[#383C44] text-xs font-medium text-[#E6E2D9]"
            >
              Показать ещё {hiddenCount} файлов
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

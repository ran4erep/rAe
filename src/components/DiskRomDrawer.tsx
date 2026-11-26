import React, { useCallback, useLayoutEffect, useRef } from 'react';
import {
  Archive,
  Bookmark,
  Check,
  CircleSlash,
  Download,
  FilePlus2,
  FolderUp,
  Gamepad2,
  HardDrive,
  Lock,
  Play,
  RotateCcw,
  X,
} from 'lucide-react';
import { CatalogGameItem } from '../emulator/catalog/amigaArchiveCatalog';
import { AmigaStatusSnapshot, SAVE_SLOT_INDICES, SaveSlotIndex, SaveSlotSummary } from '../emulator/types';
import { CatalogTab, CatalogViewState } from './CatalogTab';
import { FloppyDiskIcon } from './FloppyDiskIcon';
import { formatStorageBytes, HardfileSizePanel } from './HardfileSizePanel';
import { SaveSlotsList } from './SaveSlotsList';

export type LaunchDrawerTab = 'launch' | 'saves' | 'catalog';

interface DiskRomDrawerProps {
  open: boolean;
  overlayOnly?: boolean;
  activeTab: LaunchDrawerTab;
  onChangeTab: (tab: LaunchDrawerTab) => void;
  catalogState: CatalogViewState;
  onChangeCatalogState: React.Dispatch<React.SetStateAction<CatalogViewState>>;
  lastArchiveName?: string | null;
  onReopenLastArchive?: () => void;
  status: AmigaStatusSnapshot;
  saveSlots: Record<SaveSlotIndex, SaveSlotSummary | null>;
  onClose: () => void;
  onUploadAdf: (drive: 0 | 1, file: File) => Promise<string | null>;
  onInsertBlankAdf: (drive: 0 | 1) => void;
  onDownloadAdf: (drive: 0 | 1) => void;
  onEjectDisk: (drive: 0 | 1) => void;
  turboFloppy: boolean;
  onToggleTurboFloppy: (enabled: boolean) => void;
  dh0SizeMB: number;
  onChangeDh0Size: (sizeMB: number) => void;
  onDownloadDh0: () => void;
  onEjectDh0: () => void;
  onMountDh0: () => Promise<void>;
  dh1SizeMB: number;
  onUploadDh1: (file: File) => Promise<string | null>;
  onCreateBlankDh1: (sizeMB: number) => void;
  onChangeDh1Size: (sizeMB: number) => void;
  onDownloadDh1: () => void;
  onEjectDh1: () => void;
  onUploadRom: (file: File) => Promise<string | null>;
  onRestoreOpenKick: () => void;
  onLoadDefaultBios: () => Promise<string | null>;
  onSaveSlot: (slot: SaveSlotIndex) => Promise<void>;
  onLoadSlot: (slot: SaveSlotIndex) => Promise<boolean>;
  onDeleteSlot: (slot: SaveSlotIndex) => Promise<void>;
  onDownloadSlot: (slot: SaveSlotIndex) => Promise<void>;
  onDownloadLiveSavestate: () => void;
  onImportSavestateFile: (file: File) => Promise<void>;
  launchingCatalogId: string | null;
  onLaunchCatalogItem: (item: CatalogGameItem) => Promise<void>;
}

export const DiskRomDrawer: React.FC<DiskRomDrawerProps> = ({
  open,
  overlayOnly = false,
  activeTab,
  onChangeTab,
  catalogState,
  onChangeCatalogState,
  lastArchiveName,
  onReopenLastArchive,
  status,
  saveSlots,
  onClose,
  onUploadAdf,
  onInsertBlankAdf,
  onDownloadAdf,
  onEjectDisk,
  turboFloppy,
  onToggleTurboFloppy,
  dh0SizeMB,
  onChangeDh0Size,
  onDownloadDh0,
  onEjectDh0,
  onMountDh0,
  dh1SizeMB,
  onUploadDh1,
  onCreateBlankDh1,
  onChangeDh1Size,
  onDownloadDh1,
  onEjectDh1,
  onUploadRom,
  onRestoreOpenKick,
  onLoadDefaultBios,
  onSaveSlot,
  onLoadSlot,
  onDeleteSlot,
  onDownloadSlot,
  onDownloadLiveSavestate,
  onImportSavestateFile,
  launchingCatalogId,
  onLaunchCatalogItem,
}) => {
  const df0InputRef = useRef<HTMLInputElement | null>(null);
  const df1InputRef = useRef<HTMLInputElement | null>(null);
  const dh1InputRef = useRef<HTMLInputElement | null>(null);
  const romInputRef = useRef<HTMLInputElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  const commitCatalogScroll = useCallback(() => {
    if (activeTab !== 'catalog' || !scrollContainerRef.current) return;
    const top = scrollContainerRef.current.scrollTop;
    onChangeCatalogState((prev) => (prev.scrollTop === top ? prev : { ...prev, scrollTop: top }));
  }, [activeTab, onChangeCatalogState]);

  useLayoutEffect(() => {
    if (!open || activeTab !== 'catalog' || !scrollContainerRef.current) return;
    scrollContainerRef.current.scrollTop = catalogState.scrollTop;
  }, [activeTab, catalogState.scrollTop, open]);

  const handleRequestClose = useCallback(() => {
    commitCatalogScroll();
    onClose();
  }, [commitCatalogScroll, onClose]);

  const handleSelectTab = useCallback(
    (nextTab: LaunchDrawerTab) => {
      if (nextTab === activeTab) return;
      commitCatalogScroll();
      onChangeTab(nextTab);
    },
    [activeTab, commitCatalogScroll, onChangeTab]
  );

  const handleLaunchItemFromCatalog = useCallback(
    async (item: CatalogGameItem) => {
      commitCatalogScroll();
      await onLaunchCatalogItem(item);
    },
    [commitCatalogScroll, onLaunchCatalogItem]
  );

  if (!open) return null;

  const usedSavesCount = SAVE_SLOT_INDICES.reduce(
    (acc, idx) => (saveSlots[idx] ? acc + 1 : acc),
    0
  );

  return (
    <div
      className={
        overlayOnly
          ? 'fixed inset-0 z-50 flex items-end sm:items-center justify-center lg:items-stretch lg:justify-end bg-black/70 lg:bg-black/45'
          : 'fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 lg:static lg:inset-auto lg:z-auto lg:block lg:bg-transparent lg:w-[400px] xl:w-[430px] lg:h-full lg:shrink-0'
      }
      role="dialog"
      aria-modal={overlayOnly ? 'true' : undefined}
      aria-label="Окно запуска: дисководы, жёсткие диски, Kickstart ROM, сейвстейты и каталог игр"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleRequestClose();
      }}
    >
      <div
        className={
          overlayOnly
            ? 'w-full sm:max-w-2xl max-h-[90dvh] lg:max-w-none lg:w-[460px] lg:max-h-none lg:h-full bg-[#1E2025] border-t sm:border lg:border-t-0 lg:border-r-0 lg:border-b-0 lg:border-l border-white/12 rounded-t-2xl sm:rounded-xl lg:rounded-none lg:rounded-l-xl flex flex-col overflow-hidden shadow-2xl'
            : 'w-full sm:max-w-2xl max-h-[90dvh] lg:max-w-none lg:w-full lg:max-h-none lg:h-full bg-[#1E2025] border-t sm:border lg:border-t-0 lg:border-r-0 lg:border-b-0 lg:border-l border-white/10 rounded-t-2xl sm:rounded-xl lg:rounded-none flex flex-col overflow-hidden shadow-2xl lg:shadow-none'
        }
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between gap-2 shrink-0">
          <h2 className="text-base font-bold text-[#F2EFE9] truncate">Запуск, сохранения и каталог</h2>
          <div className="flex items-center gap-1.5 shrink-0">
            {lastArchiveName && onReopenLastArchive && (
              <button
                type="button"
                onClick={onReopenLastArchive}
                aria-label={`Вернуться в архив: ${lastArchiveName}`}
                title={`Вернуться в архив: ${lastArchiveName}`}
                className="h-9 px-2.5 rounded-lg bg-[#E07A22]/15 hover:bg-[#E07A22]/25 border border-[#E07A22]/35 text-xs font-semibold text-[#E07A22] inline-flex items-center gap-1.5 shrink-0"
              >
                <Archive className="w-3.5 h-3.5 shrink-0" />
                <span>Архив</span>
              </button>
            )}
            <button
              type="button"
              onClick={handleRequestClose}
              aria-label="Закрыть окно запуска"
              className="w-10 h-10 rounded-lg bg-[#2A2D33] hover:bg-[#353941] flex items-center justify-center text-[#E6E2D9] shrink-0"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="px-3 sm:px-4 py-2 border-b border-white/8 bg-[#181A1F] shrink-0">
          <div
            className="flex items-center gap-1 p-1 bg-[#121317] rounded-lg border border-white/6"
            role="tablist"
            aria-label="Разделы окна запуска"
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'launch'}
              onClick={() => handleSelectTab('launch')}
              className={`flex-1 min-w-0 h-9 px-1.5 sm:px-3 rounded-md text-[11px] sm:text-xs font-semibold flex items-center justify-center gap-1 sm:gap-1.5 whitespace-nowrap overflow-hidden transition-colors ${
                activeTab === 'launch'
                  ? 'bg-[#C8342A] text-white'
                  : 'text-[#B2AEA5] hover:text-[#F2EFE9] hover:bg-white/5'
              }`}
            >
              <Play className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">Запуск</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'saves'}
              onClick={() => handleSelectTab('saves')}
              className={`flex-[1.45] min-w-0 h-9 px-1.5 sm:px-3 rounded-md text-[11px] sm:text-xs font-semibold flex items-center justify-center gap-1 sm:gap-1.5 whitespace-nowrap overflow-hidden transition-colors ${
                activeTab === 'saves'
                  ? 'bg-[#C8342A] text-white'
                  : 'text-[#B2AEA5] hover:text-[#F2EFE9] hover:bg-white/5'
              }`}
            >
              <Bookmark className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">Сейвстейты</span>
              <span className="text-[10px] sm:text-[11px] font-mono tabular-nums opacity-85 shrink-0">
                {usedSavesCount}/{SAVE_SLOT_INDICES.length}
              </span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'catalog'}
              onClick={() => handleSelectTab('catalog')}
              className={`flex-1 min-w-0 h-9 px-1.5 sm:px-3 rounded-md text-[11px] sm:text-xs font-semibold flex items-center justify-center gap-1 sm:gap-1.5 whitespace-nowrap overflow-hidden transition-colors ${
                activeTab === 'catalog'
                  ? 'bg-[#C8342A] text-white'
                  : 'text-[#B2AEA5] hover:text-[#F2EFE9] hover:bg-white/5'
              }`}
            >
              <Gamepad2 className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">Каталог</span>
            </button>
          </div>
        </div>

        {/* Scrollable Content */}
        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
          {activeTab === 'launch' ? (
            <>
              {/* Floppy Drives DF0: & DF1: */}
              <section className="space-y-2">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <h3 className="text-xs font-semibold text-[#A7A39A] tracking-wide">
                    Дисководы (ADF / ADZ / 7Z / RAR / ZIP / LHA)
                  </h3>
                  <label className="inline-flex items-center gap-2 cursor-pointer select-none min-h-[32px] px-2.5 py-1 rounded-md bg-[#16181C] border border-white/10 hover:border-white/20">
                    <span className="relative inline-flex items-center justify-center shrink-0">
                      <input
                        type="checkbox"
                        checked={turboFloppy}
                        onChange={(e) => onToggleTurboFloppy(e.target.checked)}
                        className="peer sr-only"
                      />
                      <span
                        aria-hidden="true"
                        className="w-4 h-4 rounded-[4px] border border-white/25 bg-[#121316] flex items-center justify-center transition-colors peer-checked:bg-[#C8342A] peer-checked:border-[#C8342A] peer-focus-visible:ring-2 peer-focus-visible:ring-[#E07A22]"
                      >
                        {turboFloppy && <Check className="w-3 h-3 text-white stroke-[3]" />}
                      </span>
                    </span>
                    <span className="text-xs font-medium text-[#F2EFE9] whitespace-nowrap">
                      Турбо загрузка
                    </span>
                  </label>
                </div>

                {/* DF0 */}
                <div className="bg-[#16181C] border border-white/8 rounded-lg p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                  <div className="min-w-0">
                    <span className="inline-flex items-center gap-1.5 text-xs font-mono text-[#E07A22] font-semibold">
                      <FloppyDiskIcon className="w-3.5 h-3.5 shrink-0" />
                      DF0:
                    </span>
                    <p className="text-sm font-medium text-[#F2EFE9] truncate mt-0.5">
                      {status.df0.inserted ? status.df0.name : 'Пусто'}
                    </p>
                  </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <input
                  ref={df0InputRef}
                  type="file"
                  aria-label="Загрузить ADF или архив (7z, rar, zip, lha, adz) в DF0"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (f) void onUploadAdf(0, f);
                  }}
                />
                <button
                  type="button"
                  onClick={() => df0InputRef.current?.click()}
                  className="h-9 px-3 rounded-md bg-[#2A2D33] hover:bg-[#383C44] text-xs font-medium text-[#F2EFE9] flex items-center gap-1.5 whitespace-nowrap"
                >
                  <FolderUp className="w-3.5 h-3.5" />
                  ADF / Архив
                </button>
                <button
                  type="button"
                  onClick={() => onInsertBlankAdf(0)}
                  aria-label="Вставить пустую дискету в DF0"
                  className="h-9 px-2.5 rounded-md bg-[#2A2D33] hover:bg-[#383C44] text-xs font-medium text-[#E6E2D9] flex items-center gap-1.5 whitespace-nowrap"
                >
                  <FilePlus2 className="w-3.5 h-3.5 text-[#E07A22]" />
                  Пустая
                </button>
                {status.df0.inserted && (
                  <>
                    <button
                      type="button"
                      onClick={() => onDownloadAdf(0)}
                      aria-label="Скачать ADF из DF0"
                      title="Скачать ADF"
                      className="h-9 w-9 rounded-md bg-[#2A2D33] hover:bg-[#383C44] text-[#8BC49A] flex items-center justify-center"
                    >
                      <Download className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onEjectDisk(0)}
                      aria-label="Извлечь дискету из DF0"
                      title="Извлечь диск"
                      className="h-9 w-9 rounded-md bg-[#2A2D33] hover:bg-[#462626] text-[#D8D4CC] hover:text-[#FF9E98] flex items-center justify-center"
                    >
                      <CircleSlash className="w-4 h-4" />
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* DF1 */}
            <div className="bg-[#16181C] border border-white/8 rounded-lg p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
              <div className="min-w-0">
                <span className="inline-flex items-center gap-1.5 text-xs font-mono text-[#A7A39A] font-semibold">
                  <FloppyDiskIcon className="w-3.5 h-3.5 shrink-0" />
                  DF1:
                </span>
                <p className="text-sm font-medium text-[#F2EFE9] truncate mt-0.5">
                  {status.df1.inserted ? status.df1.name : 'Пусто'}
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <input
                  ref={df1InputRef}
                  type="file"
                  aria-label="Загрузить ADF или архив (7z, rar, zip, lha, adz) в DF1"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (f) void onUploadAdf(1, f);
                  }}
                />
                <button
                  type="button"
                  onClick={() => df1InputRef.current?.click()}
                  className="h-9 px-3 rounded-md bg-[#2A2D33] hover:bg-[#383C44] text-xs font-medium text-[#F2EFE9] flex items-center gap-1.5 whitespace-nowrap"
                >
                  <FolderUp className="w-3.5 h-3.5" />
                  ADF / Архив
                </button>
                <button
                  type="button"
                  onClick={() => onInsertBlankAdf(1)}
                  aria-label="Вставить пустую дискету в DF1"
                  className="h-9 px-2.5 rounded-md bg-[#2A2D33] hover:bg-[#383C44] text-xs font-medium text-[#E6E2D9] flex items-center gap-1.5 whitespace-nowrap"
                >
                  <FilePlus2 className="w-3.5 h-3.5 text-[#E07A22]" />
                  Пустая
                </button>
                {status.df1.inserted && (
                  <>
                    <button
                      type="button"
                      onClick={() => onDownloadAdf(1)}
                      aria-label="Скачать ADF из DF1"
                      title="Скачать ADF"
                      className="h-9 w-9 rounded-md bg-[#2A2D33] hover:bg-[#383C44] text-[#8BC49A] flex items-center justify-center"
                    >
                      <Download className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onEjectDisk(1)}
                      aria-label="Извлечь дискету из DF1"
                      title="Извлечь диск"
                      className="h-9 w-9 rounded-md bg-[#2A2D33] hover:bg-[#462626] text-[#D8D4CC] hover:text-[#FF9E98] flex items-center justify-center"
                    >
                      <CircleSlash className="w-4 h-4" />
                    </button>
                  </>
                )}
              </div>
            </div>
          </section>

          {/* Hard Disks: DH0 (Locked System Workbench) & DH1 (User HDF / Archive) */}
          <section className="space-y-2.5">
            <h3 className="text-xs font-semibold text-[#A7A39A] tracking-wide">
              Жёсткие диски (DH0: Система · DH1: Игры и файлы)
            </h3>

            {/* DH0: System Workbench (Locked + Auto-cached in Browser) */}
            <div className="bg-[#16181C] border border-[#58B87C]/25 rounded-lg p-3 space-y-2.5">
              <div className="flex items-center justify-between gap-2.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="inline-flex items-center gap-1.5 text-xs font-mono text-[#7AD39B] font-semibold">
                      <HardDrive className="w-3.5 h-3.5 shrink-0" />
                      DH0:
                    </span>
                    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-[#8BC49A] bg-[#58B87C]/12 border border-[#58B87C]/25 rounded px-1.5 py-0.5">
                      <Lock className="w-2.5 h-2.5" />
                      Система (в кеше)
                    </span>
                    {status.dh0.mounted && (
                      <span className="text-[10px] font-mono text-[#8D8980]">
                        {status.dh0.dosType} · {formatStorageBytes(status.dh0.sizeBytes)}
                      </span>
                    )}
                  </div>
                  <p className="text-sm font-medium text-[#F2EFE9] truncate mt-1">
                    {status.dh0.mounted ? status.dh0.name : 'Извлечён (сохранён в кеше)'}
                  </p>
                </div>

                {status.dh0.mounted ? (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={onDownloadDh0}
                      aria-label="Скачать резервную копию системного диска DH0"
                      title="Скачать резервную копию DH0"
                      className="h-9 w-9 rounded-md bg-[#2A2D33] hover:bg-[#383C44] text-[#8BC49A] flex items-center justify-center"
                    >
                      <Download className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={onEjectDh0}
                      aria-label="Извлечь системный диск DH0"
                      title="Извлечь DH0"
                      className="h-9 w-9 rounded-md bg-[#2A2D33] hover:bg-[#462626] text-[#D8D4CC] hover:text-[#FF9E98] flex items-center justify-center"
                    >
                      <CircleSlash className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => void onMountDh0()}
                    aria-label="Подключить системный диск DH0 из кеша"
                    className="h-9 px-3 rounded-md bg-[#2B5B40] hover:bg-[#346E4E] text-xs font-semibold text-white flex items-center gap-1.5 shrink-0 whitespace-nowrap"
                  >
                    <HardDrive className="w-3.5 h-3.5" />
                    Подключить
                  </button>
                )}
              </div>

              <HardfileSizePanel
                dh0={status.dh0}
                targetSizeMB={dh0SizeMB}
                driveLabel="DH0:"
                sliderLabel="Память системы (DH0:)"
                onChangeSizeMB={onChangeDh0Size}
              />
            </div>

            {/* DH1: User Games & Data Hardfile */}
            <div className="bg-[#16181C] border border-white/8 rounded-lg p-3 space-y-2.5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="inline-flex items-center gap-1.5 text-xs font-mono text-[#7AD39B] font-semibold">
                      <HardDrive className="w-3.5 h-3.5 shrink-0" />
                      DH1:
                    </span>
                    {status.dh1.mounted && (
                      <span className="text-[10px] font-mono text-[#8D8980]">
                        {status.dh1.dosType} · {formatStorageBytes(status.dh1.sizeBytes)}
                        {status.dh1.partitionCount > 1 ? ` · ${status.dh1.partitionCount} разд.` : ''}
                      </span>
                    )}
                  </div>
                  <p className="text-sm font-medium text-[#F2EFE9] truncate mt-0.5">
                    {status.dh1.mounted ? status.dh1.name : 'Не подключён (Игры / Данные)'}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <input
                    ref={dh1InputRef}
                    type="file"
                    aria-label="Загрузить HDF или любой архив (7z, rar, zip, lha) в DH1"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = '';
                      if (f) void onUploadDh1(f);
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => dh1InputRef.current?.click()}
                    className="h-9 px-3 rounded-md bg-[#2A2D33] hover:bg-[#383C44] text-xs font-medium text-[#F2EFE9] flex items-center gap-1.5 whitespace-nowrap"
                  >
                    <HardDrive className="w-3.5 h-3.5 text-[#7AD39B]" />
                    HDF / Архив
                  </button>
                  <button
                    type="button"
                    onClick={() => onCreateBlankDh1(dh1SizeMB)}
                    aria-label={`Создать новый диск DH1 объёмом ${dh1SizeMB} МБ`}
                    title={`Создать новый диск DH1 (${dh1SizeMB} МБ)`}
                    className="h-9 px-2.5 rounded-md bg-[#2A2D33] hover:bg-[#383C44] text-xs font-medium text-[#E6E2D9] flex items-center gap-1.5 whitespace-nowrap"
                  >
                    <FilePlus2 className="w-3.5 h-3.5 text-[#7AD39B]" />
                    {dh1SizeMB} МБ
                  </button>
                  {status.dh1.mounted && (
                    <>
                      <button
                        type="button"
                        onClick={onDownloadDh1}
                        aria-label="Скачать образ HDF из DH1"
                        title="Скачать DH1 HDF"
                        className="h-9 w-9 rounded-md bg-[#2A2D33] hover:bg-[#383C44] text-[#8BC49A] flex items-center justify-center"
                      >
                        <Download className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={onEjectDh1}
                        aria-label="Отключить жёсткий диск DH1"
                        title="Отключить DH1"
                        className="h-9 w-9 rounded-md bg-[#2A2D33] hover:bg-[#462626] text-[#D8D4CC] hover:text-[#FF9E98] flex items-center justify-center"
                      >
                        <CircleSlash className="w-4 h-4" />
                      </button>
                    </>
                  )}
                </div>
              </div>

              <HardfileSizePanel
                dh0={status.dh1}
                targetSizeMB={dh1SizeMB}
                driveLabel="DH1:"
                onChangeSizeMB={onChangeDh1Size}
              />
            </div>
          </section>

          {/* Kickstart ROM Section */}
          <section className="space-y-2">
            <h3 className="text-xs font-semibold text-[#A7A39A] tracking-wide">
              Kickstart ROM (.ROM / 7Z / RAR / ZIP)
            </h3>
            <div className="bg-[#16181C] border border-white/8 rounded-lg p-3 flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-[#F2EFE9] truncate min-w-0">{status.romName}</p>
              <div className="flex items-center gap-1.5 shrink-0">
                <input
                  ref={romInputRef}
                  type="file"
                  aria-label="Загрузить файл Kickstart ROM или архив (7z, rar, zip)"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (f) void onUploadRom(f);
                  }}
                />
                <button
                  type="button"
                  onClick={() => romInputRef.current?.click()}
                  className="h-9 px-3 rounded-md bg-[#C8342A] hover:bg-[#D94035] text-xs font-semibold text-white whitespace-nowrap"
                >
                  .ROM / Архив
                </button>
                {status.isOpenKick ? (
                  <button
                    type="button"
                    onClick={() => void onLoadDefaultBios()}
                    aria-label={
                      status.chipset === 'AGA'
                        ? 'Загрузить Kickstart 3.1 из BIOS'
                        : 'Загрузить Kickstart 1.3 из BIOS'
                    }
                    className="h-9 px-2.5 rounded-md bg-[#2A2D33] hover:bg-[#383C44] text-xs font-medium text-[#E6E2D9] whitespace-nowrap"
                  >
                    {status.chipset === 'AGA' ? 'BIOS 3.1' : 'BIOS 1.3'}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={onRestoreOpenKick}
                    aria-label="Вернуть встроенную OpenKick ROM"
                    title="Вернуть OpenKick 1.3"
                    className="h-9 w-9 rounded-md bg-[#2A2D33] hover:bg-[#383C44] text-[#E6E2D9] flex items-center justify-center"
                  >
                    <RotateCcw className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
              </section>
            </>
          ) : activeTab === 'saves' ? (
            <section className="space-y-2 pb-2">
              <h3 className="text-xs font-semibold text-[#A7A39A] tracking-wide">
                Слоты сохранения состояния
              </h3>
              <SaveSlotsList
                slots={saveSlots}
                onSaveSlot={onSaveSlot}
                onLoadSlot={onLoadSlot}
                onDeleteSlot={onDeleteSlot}
                onDownloadSlot={onDownloadSlot}
                onDownloadLiveSavestate={onDownloadLiveSavestate}
                onImportSavestateFile={onImportSavestateFile}
              />
            </section>
          ) : (
            <CatalogTab
              catalogState={catalogState}
              onChangeCatalogState={onChangeCatalogState}
              launchingItemId={launchingCatalogId}
              onLaunchCatalogItem={handleLaunchItemFromCatalog}
            />
          )}
        </div>
      </div>
    </div>
  );
};

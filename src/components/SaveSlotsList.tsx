import React, { useRef } from 'react';
import { Download, FolderUp, HardDriveDownload, HardDriveUpload, Trash2 } from 'lucide-react';
import { SAVE_SLOT_INDICES, SaveSlotIndex, SaveSlotSummary } from '../emulator/types';

interface SaveSlotsListProps {
  slots: Record<SaveSlotIndex, SaveSlotSummary | null>;
  compact?: boolean;
  onSaveSlot: (slot: SaveSlotIndex) => Promise<void> | void;
  onLoadSlot: (slot: SaveSlotIndex) => Promise<boolean> | void;
  onDeleteSlot: (slot: SaveSlotIndex) => Promise<void> | void;
  onDownloadSlot?: (slot: SaveSlotIndex) => Promise<void> | void;
  onDownloadLiveSavestate?: () => void;
  onImportSavestateFile?: (file: File) => Promise<void> | void;
}

function formatSlotTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const mon = String(d.getMonth() + 1).padStart(2, '0');
  return `${day}.${mon} ${hh}:${mm}`;
}

export const SaveSlotsList: React.FC<SaveSlotsListProps> = React.memo(
  ({
    slots,
    compact = false,
    onSaveSlot,
    onLoadSlot,
    onDeleteSlot,
    onDownloadSlot,
    onDownloadLiveSavestate,
    onImportSavestateFile,
  }) => {
    const importInputRef = useRef<HTMLInputElement | null>(null);
    const showDiagnosticBar = Boolean(onDownloadLiveSavestate || onImportSavestateFile);

    return (
      <div className={compact ? 'space-y-1.5' : 'space-y-2'}>
        {showDiagnosticBar && (
          <div className="grid grid-cols-2 gap-1.5">
            {onDownloadLiveSavestate && (
              <button
                type="button"
                onClick={onDownloadLiveSavestate}
                aria-label="Скачать текущий сейвстейт для диагностики"
                title="Скачать текущий сейвстейт (.json) с дампом CPU и памяти"
                className="h-8 px-2 rounded-lg bg-[#23262D] hover:bg-[#2E323B] border border-white/10 text-[11px] font-semibold text-[#F2EFE9] flex items-center justify-center gap-1.5 whitespace-nowrap transition-colors"
              >
                <Download className="w-3.5 h-3.5 text-[#8BC49A] shrink-0" />
                <span className="truncate">Скачать текущий</span>
              </button>
            )}
            {onImportSavestateFile && (
              <>
                <input
                  ref={importInputRef}
                  type="file"
                  accept=".json,.amigastate,application/json"
                  aria-label="Выбрать файл сейвстейта .json"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (f) void onImportSavestateFile(f);
                  }}
                />
                <button
                  type="button"
                  onClick={() => importInputRef.current?.click()}
                  aria-label="Загрузить сейвстейт из файла .json"
                  title="Загрузить ранее скачанный сейвстейт (.json)"
                  className="h-8 px-2 rounded-lg bg-[#23262D] hover:bg-[#2E323B] border border-white/10 text-[11px] font-semibold text-[#E6E2D9] flex items-center justify-center gap-1.5 whitespace-nowrap transition-colors"
                >
                  <FolderUp className="w-3.5 h-3.5 text-[#E07A22] shrink-0" />
                  <span className="truncate">Загрузить файл</span>
                </button>
              </>
            )}
          </div>
        )}

        {SAVE_SLOT_INDICES.map((slot) => {
          const summary = slots[slot];
          const hasData = summary !== null;

          return (
            <div
              key={slot}
              data-save-slot={slot}
              className={`bg-[#16181C] border border-white/8 rounded-lg flex items-center gap-2.5 ${
                compact ? 'p-2' : 'p-2.5'
              }`}
            >
              {/* Screenshot Thumbnail */}
              <div
                className={`${
                  compact ? 'w-14' : 'w-20'
                } aspect-[4/3] shrink-0 rounded bg-[#0C0D10] border border-white/10 overflow-hidden flex items-center justify-center`}
              >
                {summary?.screenshotDataUrl ? (
                  <img
                    src={summary.screenshotDataUrl}
                    alt={`Слот ${slot}`}
                    className="w-full h-full object-cover"
                    draggable={false}
                  />
                ) : (
                  <span className="text-[11px] font-mono text-[#5B5852]">#{slot}</span>
                )}
              </div>

              {/* Slot Metadata & Inserted Disks */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-[#F2EFE9]">Слот {slot}</span>
                  <span className="text-[10px] font-mono text-[#8D8980] tabular-nums shrink-0">
                    {summary ? formatSlotTime(summary.timestamp) : 'Пусто'}
                  </span>
                </div>

                {summary && (
                  <div className="mt-0.5 space-y-0.5 text-[10px] font-mono text-[#A7A39A]">
                    <p className="truncate">
                      DF0: {summary.df0Name || '—'}
                    </p>
                    {summary.df1Name && (
                      <p className="truncate text-[#8D8980]">
                        DF1: {summary.df1Name}
                      </p>
                    )}
                  </div>
                )}

                <div className={`mt-1.5 flex items-center ${compact ? 'gap-1' : 'gap-1.5'}`}>
                  <button
                    type="button"
                    onClick={() => void onSaveSlot(slot)}
                    aria-label={`Сохранить в Слот ${slot}`}
                    className={`h-7 rounded bg-[#2A2D33] hover:bg-[#383C44] font-medium text-[#F2EFE9] flex items-center gap-1 whitespace-nowrap ${
                      compact ? 'px-1.5 text-[10.5px]' : 'px-2 text-[11px]'
                    }`}
                  >
                    <HardDriveDownload className="w-3 h-3 text-[#E07A22] shrink-0" />
                    Сохранить
                  </button>
                  <button
                    type="button"
                    disabled={!hasData}
                    onClick={() => void onLoadSlot(slot)}
                    aria-label={`Загрузить Слот ${slot}`}
                    className={`h-7 rounded bg-[#2A2D33] hover:bg-[#383C44] disabled:opacity-35 disabled:pointer-events-none font-medium text-[#F2EFE9] flex items-center gap-1 whitespace-nowrap ${
                      compact ? 'px-1.5 text-[10.5px]' : 'px-2 text-[11px]'
                    }`}
                  >
                    <HardDriveUpload className="w-3 h-3 text-[#8BC49A] shrink-0" />
                    Загрузить
                  </button>
                  {hasData && onDownloadSlot && (
                    <button
                      type="button"
                      onClick={() => void onDownloadSlot(slot)}
                      aria-label={`Скачать Слот ${slot}`}
                      title={`Скачать сейвстейт из Слота ${slot} (.json)`}
                      className="h-7 w-7 rounded bg-[#2A2D33] hover:bg-[#383C44] text-[#8BC49A] flex items-center justify-center shrink-0 ml-auto"
                    >
                      <Download className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {hasData && (
                    <button
                      type="button"
                      onClick={() => void onDeleteSlot(slot)}
                      aria-label={`Удалить Слот ${slot}`}
                      className={`h-7 w-7 rounded bg-[#2A2D33] hover:bg-[#462626] text-[#B8B4AB] hover:text-[#FF9E98] flex items-center justify-center shrink-0 ${
                        onDownloadSlot ? '' : 'ml-auto'
                      }`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  }
);
SaveSlotsList.displayName = 'SaveSlotsList';


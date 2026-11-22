import React, { useEffect, useId, useState } from 'react';
import { FilePlus2, X } from 'lucide-react';

interface BlankDiskModalProps {
  drive: 0 | 1 | null;
  onConfirm: (drive: 0 | 1, volumeLabel: string) => void;
  onClose: () => void;
}

export function sanitizeAmigaVolumeLabel(raw: string): string {
  return raw.replace(/[:/]/g, '').slice(0, 30);
}

export const BlankDiskModal: React.FC<BlankDiskModalProps> = ({
  drive,
  onConfirm,
  onClose,
}) => {
  const inputId = useId();
  const [label, setLabel] = useState('SaveDisk');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (drive === null) return;
    setLabel(drive === 0 ? 'SaveDisk' : 'SaveDisk_DF1');
    setError(null);
  }, [drive]);

  if (drive === null) return null;

  const trimmed = label.trim();
  const previewName = `${trimmed || 'SaveDisk'}.adf`;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!trimmed) {
      setError('Укажите метку диска (от 1 до 30 символов).');
      return;
    }
    onConfirm(drive, trimmed);
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-3"
      role="dialog"
      aria-modal="true"
      aria-label={`Создать пустую дискету для DF${drive}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm bg-[#1E2025] border border-white/15 rounded-xl shadow-2xl overflow-hidden flex flex-col"
      >
        <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between gap-2 bg-[#181A1F]">
          <div className="flex items-center gap-2 min-w-0">
            <FilePlus2 className="w-4 h-4 text-[#E07A22] shrink-0" />
            <h2 className="text-sm font-bold text-[#F2EFE9] truncate">
              Пустая дискета в DF{drive}:
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть окно создания дискеты"
            className="w-8 h-8 rounded-lg bg-[#2A2D33] hover:bg-[#353941] flex items-center justify-center text-[#E6E2D9] shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div className="space-y-1.5">
            <label
              htmlFor={inputId}
              className="block text-xs font-semibold text-[#D8D4CC]"
            >
              Метка диска (AmigaDOS, до 30 символов)
            </label>
            <input
              id={inputId}
              type="text"
              autoFocus
              maxLength={30}
              value={label}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => {
                setLabel(sanitizeAmigaVolumeLabel(e.target.value));
                if (error) setError(null);
              }}
              placeholder="SaveDisk"
              className="w-full h-10 px-3 rounded-lg bg-[#121317] border border-white/15 text-sm font-mono text-[#F2EFE9] focus:outline-none focus:border-[#E07A22]"
            />
            {error ? (
              <p className="text-xs text-[#FF8C85]" role="alert">
                {error}
              </p>
            ) : (
              <p className="text-[11px] text-[#9E9A90] flex items-center justify-between gap-2">
                <span>Файл: <span className="font-mono text-[#D8D4CC]">{previewName}</span></span>
                <span className="font-mono shrink-0">{label.length}/30</span>
              </p>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="h-9 px-3.5 rounded-lg bg-[#2A2D33] hover:bg-[#353941] text-xs font-semibold text-[#E6E2D9]"
            >
              Отмена
            </button>
            <button
              type="submit"
              className="h-9 px-4 rounded-lg bg-[#C8342A] hover:bg-[#D94035] text-xs font-semibold text-white"
            >
              Создать и вставить
            </button>
          </div>
        </div>
      </form>
    </div>
  );
};

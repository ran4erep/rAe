import React from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, CheckCircle2, X } from 'lucide-react';

export interface ToastMessage {
  id: number;
  type: 'ok' | 'err';
  text: string;
}

interface ToastContainerProps {
  toasts: ToastMessage[];
  belowTopBar?: boolean;
  onDismiss: (id: number) => void;
}

export const ToastContainer: React.FC<ToastContainerProps> = React.memo(
  ({ toasts, belowTopBar = true, onDismiss }) => {
    if (toasts.length === 0 || typeof document === 'undefined') return null;

    return createPortal(
      <div
        className={`fixed ${
          belowTopBar ? 'top-14' : 'top-3'
        } left-1/2 -translate-x-1/2 z-[95] flex flex-col items-center gap-1.5 w-full max-w-sm px-3 pointer-events-none`}
        aria-live="polite"
        aria-atomic="false"
      >
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={`pointer-events-auto w-full rounded-lg border px-3 py-2 shadow-xl flex items-center gap-2 text-xs font-medium ${
            t.type === 'err'
              ? 'bg-[#361B1B] border-[#C8342A] text-[#FFD5D2]'
              : 'bg-[#1B221E] border-[#3B8B59] text-[#E5F6EC]'
          }`}
        >
          {t.type === 'err' ? (
            <AlertCircle className="w-4 h-4 text-[#FF8A82] shrink-0" />
          ) : (
            <CheckCircle2 className="w-4 h-4 text-[#6ED494] shrink-0" />
          )}
          <span className="flex-1 min-w-0 truncate">{t.text}</span>
          <button
            type="button"
            onClick={() => onDismiss(t.id)}
            aria-label="Скрыть уведомление"
            className="w-5 h-5 rounded hover:bg-white/10 flex items-center justify-center shrink-0 opacity-75 hover:opacity-100"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>,
    document.body
  );
});
ToastContainer.displayName = 'ToastContainer';

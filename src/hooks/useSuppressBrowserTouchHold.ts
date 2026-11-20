import { RefObject, useEffect } from 'react';

/**
 * Attaches native non-passive touchstart / contextmenu / selectstart listeners
 * so Android Chrome & mobile Safari do NOT start their built-in long-press
 * haptic feedback, text selection, or context menu timers when holding a button,
 * while Pointer Events (pointerdown/move/up/cancel) continue firing normally.
 */
export function useSuppressBrowserTouchHold(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const prevent = (e: Event) => {
      e.preventDefault();
    };

    el.addEventListener('touchstart', prevent, { passive: false });
    el.addEventListener('contextmenu', prevent, { passive: false });
    el.addEventListener('selectstart', prevent, { passive: false });
    el.addEventListener('dragstart', prevent, { passive: false });

    return () => {
      el.removeEventListener('touchstart', prevent);
      el.removeEventListener('contextmenu', prevent);
      el.removeEventListener('selectstart', prevent);
      el.removeEventListener('dragstart', prevent);
    };
  }, [ref]);
}

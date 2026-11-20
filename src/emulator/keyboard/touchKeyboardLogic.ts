import { AMIGA_RAW } from './amigaKeyMap';

export const MODIFIER_CODES = new Set<number>([
  AMIGA_RAW.LSHIFT,
  AMIGA_RAW.RSHIFT,
  AMIGA_RAW.CTRL,
  AMIGA_RAW.LALT,
  AMIGA_RAW.RALT,
  AMIGA_RAW.LAMIGA,
  AMIGA_RAW.RAMIGA,
]);

export function isModifierKeyCode(rawCode: number): boolean {
  return MODIFIER_CODES.has(rawCode);
}

export interface KeyAction {
  type: 'key' | 'delayedCombo';
  code: number;
  down?: boolean;
  modifierCode?: number;
}

interface ActiveTouchPointer {
  startCode: number;
  isModifier: boolean;
  hoverCode: number | null;
}

/**
 * Pure multi-touch & slide-from-modifier keyboard state machine.
 * - Zero sticky/latching state: keys stay down only while physically held.
 * - Multi-touch: holding Shift/Ctrl/Alt with one finger while pressing keys with another works naturally.
 * - Slide-from-modifier: touching a modifier, dragging onto a target key, and releasing types the target
 *   key with the modifier held, then releases both.
 */
export class TouchKeyboardController {
  private readonly pointers = new Map<number, ActiveTouchPointer>();
  private readonly holdCounts = new Map<number, number>();

  public pointerDown(pointerId: number, rawCode: number): KeyAction[] {
    // Clean up if same pointerId somehow re-entered without up
    const actions: KeyAction[] = [];
    if (this.pointers.has(pointerId)) {
      actions.push(...this.pointerUp(pointerId));
    }

    const isModifier = isModifierKeyCode(rawCode);
    this.pointers.set(pointerId, {
      startCode: rawCode,
      isModifier,
      hoverCode: rawCode,
    });

    const prevCount = this.holdCounts.get(rawCode) ?? 0;
    this.holdCounts.set(rawCode, prevCount + 1);
    if (prevCount === 0) {
      actions.push({ type: 'key', code: rawCode, down: true });
    }
    return actions;
  }

  public pointerMove(pointerId: number, hoveredCode: number | null): boolean {
    const entry = this.pointers.get(pointerId);
    if (!entry || !entry.isModifier) return false;
    if (entry.hoverCode === hoveredCode) return false;
    entry.hoverCode = hoveredCode;
    return true;
  }

  public pointerUp(pointerId: number): KeyAction[] {
    const entry = this.pointers.get(pointerId);
    if (!entry) return [];
    this.pointers.delete(pointerId);

    // Slide-from-modifier combo: touched modifier, dragged onto a non-modifier key, and released
    if (
      entry.isModifier &&
      entry.hoverCode !== null &&
      entry.hoverCode !== entry.startCode &&
      !isModifierKeyCode(entry.hoverCode)
    ) {
      const targetCode = entry.hoverCode;
      return [
        { type: 'key', code: targetCode, down: true },
        { type: 'delayedCombo', code: targetCode, modifierCode: entry.startCode },
      ];
    }

    return this.releaseHold(entry.startCode);
  }

  /** Called after the brief combo hold timer completes to release target key & modifier */
  public completeDelayedCombo(modifierCode: number): KeyAction[] {
    return this.releaseHold(modifierCode);
  }

  private releaseHold(rawCode: number): KeyAction[] {
    const prevCount = this.holdCounts.get(rawCode) ?? 0;
    if (prevCount <= 1) {
      this.holdCounts.delete(rawCode);
      if (prevCount === 1) {
        return [{ type: 'key', code: rawCode, down: false }];
      }
      return [];
    }
    this.holdCounts.set(rawCode, prevCount - 1);
    return [];
  }

  public isKeyPressed(rawCode: number): boolean {
    if ((this.holdCounts.get(rawCode) ?? 0) > 0) return true;
    for (const p of this.pointers.values()) {
      if (p.isModifier && p.hoverCode === rawCode) return true;
    }
    return false;
  }

  public isShiftActive(): boolean {
    return (
      (this.holdCounts.get(AMIGA_RAW.LSHIFT) ?? 0) > 0 ||
      (this.holdCounts.get(AMIGA_RAW.RSHIFT) ?? 0) > 0
    );
  }

  public getPressedCodesSnapshot(): number[] {
    const out: number[] = [];
    for (const [code, count] of this.holdCounts.entries()) {
      if (count > 0) out.push(code);
    }
    for (const p of this.pointers.values()) {
      if (p.isModifier && p.hoverCode !== null && !out.includes(p.hoverCode)) {
        out.push(p.hoverCode);
      }
    }
    return out;
  }

  public resetAll(): KeyAction[] {
    const actions: KeyAction[] = [];
    for (const [code, count] of this.holdCounts.entries()) {
      if (count > 0) actions.push({ type: 'key', code, down: false });
    }
    this.holdCounts.clear();
    this.pointers.clear();
    return actions;
  }
}

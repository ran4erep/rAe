import {
  ControlTarget,
  normalizeComboTargets,
  SingleControlTarget,
  singleTargetsEqual,
} from './customProfiles';

export interface PickerGestureSnapshot {
  isCapturing: boolean;
  heldTargets: SingleControlTarget[];
  capturedTargets: SingleControlTarget[];
}

/**
 * Pure wait-for-release gesture state machine for AmigaKeyboardPicker.
 * - Tracks multi-touch pointers and physical keyboard keys simultaneously.
 * - Never commits on pointerDown; waits until ALL held fingers/keys are released.
 * - Releasing after pressing 1 target emits that single target.
 * - Releasing after pressing 2 distinct targets (e.g. holding L-SHIFT and tapping A)
 *   normalizes modifier ordering and emits `{ kind: 'combo', targets: [mod, key] }`.
 */
export class PickerGestureSession {
  private readonly activePointers = new Map<number, SingleControlTarget>();
  private readonly activePhysicalKeys = new Map<string, SingleControlTarget>();
  private captured: SingleControlTarget[] = [];

  public pointerDown(pointerId: number, target: SingleControlTarget): void {
    this.activePointers.set(pointerId, target);
    this.recordTarget(target);
  }

  public pointerUp(pointerId: number): ControlTarget | null {
    if (!this.activePointers.has(pointerId)) return null;
    this.activePointers.delete(pointerId);
    return this.tryFinalize();
  }

  public pointerCancel(pointerId: number): void {
    if (!this.activePointers.has(pointerId)) return;
    this.activePointers.delete(pointerId);
    if (!this.hasActiveInputs()) {
      this.captured = [];
    }
  }

  public physicalKeyDown(code: string, target: SingleControlTarget): void {
    if (this.activePhysicalKeys.has(code)) return;
    this.activePhysicalKeys.set(code, target);
    this.recordTarget(target);
  }

  public physicalKeyUp(code: string): ControlTarget | null {
    if (!this.activePhysicalKeys.has(code)) return null;
    this.activePhysicalKeys.delete(code);
    return this.tryFinalize();
  }

  public getSnapshot(): PickerGestureSnapshot {
    const heldTargets: SingleControlTarget[] = [];
    for (const t of this.activePointers.values()) {
      if (!heldTargets.some((x) => singleTargetsEqual(x, t))) heldTargets.push(t);
    }
    for (const t of this.activePhysicalKeys.values()) {
      if (!heldTargets.some((x) => singleTargetsEqual(x, t))) heldTargets.push(t);
    }

    return {
      isCapturing: this.hasActiveInputs() || this.captured.length > 0,
      heldTargets,
      capturedTargets: this.captured.slice(),
    };
  }

  private hasActiveInputs(): boolean {
    return this.activePointers.size > 0 || this.activePhysicalKeys.size > 0;
  }

  private isTargetCurrentlyHeld(target: SingleControlTarget): boolean {
    for (const t of this.activePointers.values()) {
      if (singleTargetsEqual(t, target)) return true;
    }
    for (const t of this.activePhysicalKeys.values()) {
      if (singleTargetsEqual(t, target)) return true;
    }
    return false;
  }

  private recordTarget(target: SingleControlTarget): void {
    if (this.captured.length === 0) {
      this.captured.push(target);
      return;
    }
    if (this.captured.length === 1) {
      if (!singleTargetsEqual(this.captured[0], target)) {
        this.captured.push(target);
      }
      return;
    }
    // Already have 2 captured targets: if user taps a 3rd distinct key while holding one,
    // replace the non-held slot (allowing correction without lifting the modifier finger).
    if (
      singleTargetsEqual(this.captured[0], target) ||
      singleTargetsEqual(this.captured[1], target)
    ) {
      return;
    }
    if (this.isTargetCurrentlyHeld(this.captured[0])) {
      this.captured[1] = target;
    } else if (this.isTargetCurrentlyHeld(this.captured[1])) {
      this.captured[0] = target;
    } else {
      this.captured[1] = target;
    }
  }

  private tryFinalize(): ControlTarget | null {
    if (this.hasActiveInputs()) return null;
    if (this.captured.length === 0) return null;

    if (this.captured.length >= 2) {
      const [a, b] = normalizeComboTargets(this.captured[0], this.captured[1]);
      this.captured = [];
      return { kind: 'combo', targets: [a, b] };
    }

    const single = this.captured[0];
    this.captured = [];
    return single;
  }
}

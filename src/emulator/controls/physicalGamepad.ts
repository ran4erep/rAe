import { AMIGA_RAW } from '../keyboard/amigaKeyMap';
import { JoystickState } from '../types';

export interface GamepadButtonLike {
  pressed: boolean;
  value?: number;
}

export interface GamepadLike {
  connected?: boolean;
  axes: readonly number[];
  buttons: readonly GamepadButtonLike[];
}

export interface PhysicalGamepadSink {
  setJoystick: (patch: Partial<JoystickState>) => void;
  setKey: (rawCode: number, isDown: boolean) => void;
  setMouseButtons: (left?: boolean, right?: boolean) => void;
  onAnyPress?: () => void;
}

export const GAMEPAD_AXIS_DEADZONE = 0.32;

const BIT_UP = 1 << 0;
const BIT_DOWN = 1 << 1;
const BIT_LEFT = 1 << 2;
const BIT_RIGHT = 1 << 3;
const BIT_FIRE1 = 1 << 4; // A (button 0)
const BIT_FIRE2 = 1 << 5; // B (button 1)
const BIT_SPACE = 1 << 6; // X (button 2) -> Space
const BIT_RETURN = 1 << 7; // Y (button 3) -> Enter / Return
const BIT_LMB = 1 << 8; // L1 (button 4) -> Left Mouse Button
const BIT_RMB = 1 << 9; // R1 (button 5) -> Right Mouse Button
const BIT_ESC = 1 << 10; // Start (button 9) -> Escape

const JOY_BITS_MASK = BIT_UP | BIT_DOWN | BIT_LEFT | BIT_RIGHT | BIT_FIRE1 | BIT_FIRE2;

function isBtnPressed(buttons: readonly GamepadButtonLike[], index: number): boolean {
  if (index >= buttons.length) return false;
  const btn = buttons[index];
  if (!btn) return false;
  return btn.pressed || (btn.value !== undefined && btn.value > 0.5);
}

/**
 * Reads all connected standard gamepads into a compact integer bitmask (zero heap allocations).
 * Standard W3C mapping:
 * - Left stick (axes 0/1) & D-Pad (12..15) -> Amiga Joystick directions
 * - A (0) -> Fire 1, B (1) -> Fire 2
 * - X (2) -> Space, Y (3) -> Enter (Return)
 * - L1 (4) -> Left Mouse Button, R1 (5) -> Right Mouse Button
 * - Start (9) -> Escape
 */
export function readPhysicalGamepadMask(pads: ArrayLike<GamepadLike | null | undefined>): number {
  let mask = 0;
  for (let i = 0; i < pads.length; i++) {
    const pad = pads[i];
    if (!pad || pad.connected === false) continue;

    const axes = pad.axes;
    const buttons = pad.buttons;

    const axX = axes && axes.length > 0 ? axes[0] : 0;
    const axY = axes && axes.length > 1 ? axes[1] : 0;

    if (axY < -GAMEPAD_AXIS_DEADZONE || (buttons && isBtnPressed(buttons, 12))) mask |= BIT_UP;
    if (axY > GAMEPAD_AXIS_DEADZONE || (buttons && isBtnPressed(buttons, 13))) mask |= BIT_DOWN;
    if (axX < -GAMEPAD_AXIS_DEADZONE || (buttons && isBtnPressed(buttons, 14))) mask |= BIT_LEFT;
    if (axX > GAMEPAD_AXIS_DEADZONE || (buttons && isBtnPressed(buttons, 15))) mask |= BIT_RIGHT;

    if (buttons) {
      if (isBtnPressed(buttons, 0)) mask |= BIT_FIRE1;
      if (isBtnPressed(buttons, 1)) mask |= BIT_FIRE2;
      if (isBtnPressed(buttons, 2)) mask |= BIT_SPACE;
      if (isBtnPressed(buttons, 3)) mask |= BIT_RETURN;
      if (isBtnPressed(buttons, 4)) mask |= BIT_LMB;
      if (isBtnPressed(buttons, 5)) mask |= BIT_RMB;
      if (isBtnPressed(buttons, 9)) mask |= BIT_ESC;
    }
  }
  return mask;
}

export function hasAnyConnectedGamepad(pads: ArrayLike<GamepadLike | null | undefined>): boolean {
  for (let i = 0; i < pads.length; i++) {
    const pad = pads[i];
    if (pad && pad.connected !== false) return true;
  }
  return false;
}

/**
 * Edge-triggered, zero-allocation physical gamepad tracker.
 * Emits events to the emulator ONLY when a mapped stick axis or button state changes.
 */
export class PhysicalGamepadTracker {
  private prevMask = 0;

  public get activeMask(): number {
    return this.prevMask;
  }

  public poll(pads: ArrayLike<GamepadLike | null | undefined>, sink: PhysicalGamepadSink): void {
    const nextMask = readPhysicalGamepadMask(pads);
    this.applyMask(nextMask, sink);
  }

  public releaseAll(sink: PhysicalGamepadSink): void {
    this.applyMask(0, sink);
  }

  private applyMask(nextMask: number, sink: PhysicalGamepadSink): void {
    const prevMask = this.prevMask;
    const diff = nextMask ^ prevMask;
    if (diff === 0) return;

    this.prevMask = nextMask;

    if ((nextMask & ~prevMask) !== 0) {
      sink.onAnyPress?.();
    }

    if ((diff & JOY_BITS_MASK) !== 0) {
      const patch: Partial<JoystickState> = {};
      if ((diff & BIT_UP) !== 0) patch.up = (nextMask & BIT_UP) !== 0;
      if ((diff & BIT_DOWN) !== 0) patch.down = (nextMask & BIT_DOWN) !== 0;
      if ((diff & BIT_LEFT) !== 0) patch.left = (nextMask & BIT_LEFT) !== 0;
      if ((diff & BIT_RIGHT) !== 0) patch.right = (nextMask & BIT_RIGHT) !== 0;
      if ((diff & BIT_FIRE1) !== 0) patch.fire1 = (nextMask & BIT_FIRE1) !== 0;
      if ((diff & BIT_FIRE2) !== 0) patch.fire2 = (nextMask & BIT_FIRE2) !== 0;
      sink.setJoystick(patch);
    }

    if ((diff & BIT_SPACE) !== 0) {
      sink.setKey(AMIGA_RAW.SPACE, (nextMask & BIT_SPACE) !== 0);
    }
    if ((diff & BIT_RETURN) !== 0) {
      sink.setKey(AMIGA_RAW.RETURN, (nextMask & BIT_RETURN) !== 0);
    }
    if ((diff & BIT_ESC) !== 0) {
      sink.setKey(AMIGA_RAW.ESC, (nextMask & BIT_ESC) !== 0);
    }

    if ((diff & (BIT_LMB | BIT_RMB)) !== 0) {
      sink.setMouseButtons(
        (diff & BIT_LMB) !== 0 ? (nextMask & BIT_LMB) !== 0 : undefined,
        (diff & BIT_RMB) !== 0 ? (nextMask & BIT_RMB) !== 0 : undefined
      );
    }
  }
}

/**
 * Authentic Commodore Amiga 500 / 1200 / 2000 Hardware Keyboard Matrix
 * Every physical key on a real Amiga mapped to its exact raw hardware scancode ($00-$67).
 * Reference: Amiga Hardware Reference Manual, Appendix B (Keyboard Matrix).
 */

export type KeyVariant = 'ivory' | 'grey' | 'accent';

export interface AmigaKeyDef {
  /** Authentic Commodore Amiga raw keycode ($00 - $67) */
  code: number;
  /** Primary cap legend */
  label: string;
  /** Secondary (shifted) legend */
  shiftLabel?: string;
  /** Accessible descriptive name for screen readers & Playwright */
  ariaLabel: string;
  /** Relative flex weight in row */
  flex?: number;
  /** Visual cap color matching physical A500 keyboard */
  variant: KeyVariant;
  /** Whether key acts as a latchable modifier on touchscreens */
  isModifier?: boolean;
  /** Whether key is Caps Lock (hardware latching toggle) */
  isCapsLock?: boolean;
  /** Special icon marker for authentic Amiga logo keys */
  amigaLogo?: 'hollow' | 'filled';
  /** Render authentic L-shaped Return/Enter arrow glyph */
  returnIcon?: boolean;
}

export const AMIGA_RAW = {
  TILDE: 0x00,
  KEY_1: 0x01,
  KEY_2: 0x02,
  KEY_3: 0x03,
  KEY_4: 0x04,
  KEY_5: 0x05,
  KEY_6: 0x06,
  KEY_7: 0x07,
  KEY_8: 0x08,
  KEY_9: 0x09,
  KEY_0: 0x0a,
  MINUS: 0x0b,
  EQUALS: 0x0c,
  BACKSLASH: 0x0d,
  NP_0: 0x0f,

  Q: 0x10,
  W: 0x11,
  E: 0x12,
  R: 0x13,
  T: 0x14,
  Y: 0x15,
  U: 0x16,
  I: 0x17,
  O: 0x18,
  P: 0x19,
  LBRACKET: 0x1a,
  RBRACKET: 0x1b,
  NP_1: 0x1d,
  NP_2: 0x1e,
  NP_3: 0x1f,

  A: 0x20,
  S: 0x21,
  D: 0x22,
  F: 0x23,
  G: 0x24,
  H: 0x25,
  J: 0x26,
  K: 0x27,
  L: 0x28,
  SEMICOLON: 0x29,
  APOSTROPHE: 0x2a,
  INTL_HASH: 0x2b, // European Amiga key next to Return
  NP_4: 0x2d,
  NP_5: 0x2e,
  NP_6: 0x2f,

  INTL_LT: 0x30, // European Amiga key next to Left Shift
  Z: 0x31,
  X: 0x32,
  C: 0x33,
  V: 0x34,
  B: 0x35,
  N: 0x36,
  M: 0x37,
  COMMA: 0x38,
  PERIOD: 0x39,
  SLASH: 0x3a,
  NP_DOT: 0x3c,
  NP_7: 0x3d,
  NP_8: 0x3e,
  NP_9: 0x3f,

  SPACE: 0x40,
  BACKSPACE: 0x41,
  TAB: 0x42,
  NP_ENTER: 0x43,
  RETURN: 0x44,
  ESC: 0x45,
  DEL: 0x46,
  NP_MINUS: 0x4a,
  UP: 0x4c,
  DOWN: 0x4d,
  RIGHT: 0x4e,
  LEFT: 0x4f,

  F1: 0x50,
  F2: 0x51,
  F3: 0x52,
  F4: 0x53,
  F5: 0x54,
  F6: 0x55,
  F7: 0x56,
  F8: 0x57,
  F9: 0x58,
  F10: 0x59,
  NP_LPAREN: 0x5a,
  NP_RPAREN: 0x5b,
  NP_SLASH: 0x5c,
  NP_STAR: 0x5d,
  NP_PLUS: 0x5e,
  HELP: 0x5f,

  LSHIFT: 0x60,
  RSHIFT: 0x61,
  CAPSLOCK: 0x62,
  CTRL: 0x63,
  LALT: 0x64,
  RALT: 0x65,
  LAMIGA: 0x66,
  RAMIGA: 0x67,
} as const;

/**
 * Encodes an Amiga raw keycode + release flag into the exact byte transmitted
 * over the Amiga keyboard serial line into CIA-A SDR ($BFEC01).
 * Hardware spec: bit 7..1 = rawkey bit 6..0, bit 0 = keyUp (0=down, 1=up), all bits inverted (~).
 */
export function encodeCiaKeyboardByte(rawCode: number, isRelease: boolean): number {
  const shifted = ((rawCode & 0x7f) << 1) | (isRelease ? 1 : 0);
  return (~shifted) & 0xff;
}

/**
 * Decodes a CIA-A SDR byte back to { rawCode, isRelease } (used by OpenKick and unit tests).
 */
export function decodeCiaKeyboardByte(sdrByte: number): { rawCode: number; isRelease: boolean } {
  const uninverted = (~sdrByte) & 0xff;
  return {
    rawCode: (uninverted >>> 1) & 0x7f,
    isRelease: (uninverted & 1) === 1,
  };
}

/**
 * Maps Amiga raw keycode + shift/caps state to printable ASCII (or control char).
 */
const UNSHIFTED_ASCII: Record<number, string> = {
  [AMIGA_RAW.TILDE]: '`',
  [AMIGA_RAW.KEY_1]: '1',
  [AMIGA_RAW.KEY_2]: '2',
  [AMIGA_RAW.KEY_3]: '3',
  [AMIGA_RAW.KEY_4]: '4',
  [AMIGA_RAW.KEY_5]: '5',
  [AMIGA_RAW.KEY_6]: '6',
  [AMIGA_RAW.KEY_7]: '7',
  [AMIGA_RAW.KEY_8]: '8',
  [AMIGA_RAW.KEY_9]: '9',
  [AMIGA_RAW.KEY_0]: '0',
  [AMIGA_RAW.MINUS]: '-',
  [AMIGA_RAW.EQUALS]: '=',
  [AMIGA_RAW.BACKSLASH]: '\\',
  [AMIGA_RAW.Q]: 'q',
  [AMIGA_RAW.W]: 'w',
  [AMIGA_RAW.E]: 'e',
  [AMIGA_RAW.R]: 'r',
  [AMIGA_RAW.T]: 't',
  [AMIGA_RAW.Y]: 'y',
  [AMIGA_RAW.U]: 'u',
  [AMIGA_RAW.I]: 'i',
  [AMIGA_RAW.O]: 'o',
  [AMIGA_RAW.P]: 'p',
  [AMIGA_RAW.LBRACKET]: '[',
  [AMIGA_RAW.RBRACKET]: ']',
  [AMIGA_RAW.A]: 'a',
  [AMIGA_RAW.S]: 's',
  [AMIGA_RAW.D]: 'd',
  [AMIGA_RAW.F]: 'f',
  [AMIGA_RAW.G]: 'g',
  [AMIGA_RAW.H]: 'h',
  [AMIGA_RAW.J]: 'j',
  [AMIGA_RAW.K]: 'k',
  [AMIGA_RAW.L]: 'l',
  [AMIGA_RAW.SEMICOLON]: ';',
  [AMIGA_RAW.APOSTROPHE]: "'",
  [AMIGA_RAW.INTL_HASH]: '#',
  [AMIGA_RAW.INTL_LT]: '<',
  [AMIGA_RAW.Z]: 'z',
  [AMIGA_RAW.X]: 'x',
  [AMIGA_RAW.C]: 'c',
  [AMIGA_RAW.V]: 'v',
  [AMIGA_RAW.B]: 'b',
  [AMIGA_RAW.N]: 'n',
  [AMIGA_RAW.M]: 'm',
  [AMIGA_RAW.COMMA]: ',',
  [AMIGA_RAW.PERIOD]: '.',
  [AMIGA_RAW.SLASH]: '/',
  [AMIGA_RAW.SPACE]: ' ',
  [AMIGA_RAW.NP_0]: '0',
  [AMIGA_RAW.NP_1]: '1',
  [AMIGA_RAW.NP_2]: '2',
  [AMIGA_RAW.NP_3]: '3',
  [AMIGA_RAW.NP_4]: '4',
  [AMIGA_RAW.NP_5]: '5',
  [AMIGA_RAW.NP_6]: '6',
  [AMIGA_RAW.NP_7]: '7',
  [AMIGA_RAW.NP_8]: '8',
  [AMIGA_RAW.NP_9]: '9',
  [AMIGA_RAW.NP_DOT]: '.',
  [AMIGA_RAW.NP_LPAREN]: '(',
  [AMIGA_RAW.NP_RPAREN]: ')',
  [AMIGA_RAW.NP_SLASH]: '/',
  [AMIGA_RAW.NP_STAR]: '*',
  [AMIGA_RAW.NP_MINUS]: '-',
  [AMIGA_RAW.NP_PLUS]: '+',
};

const SHIFTED_ASCII: Record<number, string> = {
  [AMIGA_RAW.TILDE]: '~',
  [AMIGA_RAW.KEY_1]: '!',
  [AMIGA_RAW.KEY_2]: '@',
  [AMIGA_RAW.KEY_3]: '#',
  [AMIGA_RAW.KEY_4]: '$',
  [AMIGA_RAW.KEY_5]: '%',
  [AMIGA_RAW.KEY_6]: '^',
  [AMIGA_RAW.KEY_7]: '&',
  [AMIGA_RAW.KEY_8]: '*',
  [AMIGA_RAW.KEY_9]: '(',
  [AMIGA_RAW.KEY_0]: ')',
  [AMIGA_RAW.MINUS]: '_',
  [AMIGA_RAW.EQUALS]: '+',
  [AMIGA_RAW.BACKSLASH]: '|',
  [AMIGA_RAW.LBRACKET]: '{',
  [AMIGA_RAW.RBRACKET]: '}',
  [AMIGA_RAW.SEMICOLON]: ':',
  [AMIGA_RAW.APOSTROPHE]: '"',
  [AMIGA_RAW.COMMA]: '<',
  [AMIGA_RAW.PERIOD]: '>',
  [AMIGA_RAW.SLASH]: '?',
  [AMIGA_RAW.INTL_LT]: '>',
};

export function amigaRawKeyToAscii(rawCode: number, shift: boolean, capsLock: boolean): string | null {
  const base = UNSHIFTED_ASCII[rawCode];
  if (!base) return null;
  if (base >= 'a' && base <= 'z') {
    const upper = shift !== capsLock;
    return upper ? base.toUpperCase() : base;
  }
  if (shift && SHIFTED_ASCII[rawCode]) {
    return SHIFTED_ASCII[rawCode];
  }
  return base;
}

/** Human-readable name for any Amiga raw scancode */
export const AMIGA_KEY_NAMES: Record<number, string> = {
  [AMIGA_RAW.TILDE]: '` ~',
  [AMIGA_RAW.KEY_1]: '1',
  [AMIGA_RAW.KEY_2]: '2',
  [AMIGA_RAW.KEY_3]: '3',
  [AMIGA_RAW.KEY_4]: '4',
  [AMIGA_RAW.KEY_5]: '5',
  [AMIGA_RAW.KEY_6]: '6',
  [AMIGA_RAW.KEY_7]: '7',
  [AMIGA_RAW.KEY_8]: '8',
  [AMIGA_RAW.KEY_9]: '9',
  [AMIGA_RAW.KEY_0]: '0',
  [AMIGA_RAW.MINUS]: '-',
  [AMIGA_RAW.EQUALS]: '=',
  [AMIGA_RAW.BACKSLASH]: '\\',
  [AMIGA_RAW.Q]: 'Q',
  [AMIGA_RAW.W]: 'W',
  [AMIGA_RAW.E]: 'E',
  [AMIGA_RAW.R]: 'R',
  [AMIGA_RAW.T]: 'T',
  [AMIGA_RAW.Y]: 'Y',
  [AMIGA_RAW.U]: 'U',
  [AMIGA_RAW.I]: 'I',
  [AMIGA_RAW.O]: 'O',
  [AMIGA_RAW.P]: 'P',
  [AMIGA_RAW.LBRACKET]: '[',
  [AMIGA_RAW.RBRACKET]: ']',
  [AMIGA_RAW.A]: 'A',
  [AMIGA_RAW.S]: 'S',
  [AMIGA_RAW.D]: 'D',
  [AMIGA_RAW.F]: 'F',
  [AMIGA_RAW.G]: 'G',
  [AMIGA_RAW.H]: 'H',
  [AMIGA_RAW.J]: 'J',
  [AMIGA_RAW.K]: 'K',
  [AMIGA_RAW.L]: 'L',
  [AMIGA_RAW.SEMICOLON]: ';',
  [AMIGA_RAW.APOSTROPHE]: "'",
  [AMIGA_RAW.Z]: 'Z',
  [AMIGA_RAW.X]: 'X',
  [AMIGA_RAW.C]: 'C',
  [AMIGA_RAW.V]: 'V',
  [AMIGA_RAW.B]: 'B',
  [AMIGA_RAW.N]: 'N',
  [AMIGA_RAW.M]: 'M',
  [AMIGA_RAW.COMMA]: ',',
  [AMIGA_RAW.PERIOD]: '.',
  [AMIGA_RAW.SLASH]: '/',
  [AMIGA_RAW.SPACE]: 'SPACE',
  [AMIGA_RAW.BACKSPACE]: 'BACKSPACE',
  [AMIGA_RAW.TAB]: 'TAB',
  [AMIGA_RAW.NP_ENTER]: 'NUM ENTER',
  [AMIGA_RAW.RETURN]: 'RETURN',
  [AMIGA_RAW.ESC]: 'ESC',
  [AMIGA_RAW.DEL]: 'DEL',
  [AMIGA_RAW.HELP]: 'HELP',
  [AMIGA_RAW.UP]: 'UP',
  [AMIGA_RAW.DOWN]: 'DOWN',
  [AMIGA_RAW.LEFT]: 'LEFT',
  [AMIGA_RAW.RIGHT]: 'RIGHT',
  [AMIGA_RAW.F1]: 'F1',
  [AMIGA_RAW.F2]: 'F2',
  [AMIGA_RAW.F3]: 'F3',
  [AMIGA_RAW.F4]: 'F4',
  [AMIGA_RAW.F5]: 'F5',
  [AMIGA_RAW.F6]: 'F6',
  [AMIGA_RAW.F7]: 'F7',
  [AMIGA_RAW.F8]: 'F8',
  [AMIGA_RAW.F9]: 'F9',
  [AMIGA_RAW.F10]: 'F10',
  [AMIGA_RAW.LSHIFT]: 'L-SHIFT',
  [AMIGA_RAW.RSHIFT]: 'R-SHIFT',
  [AMIGA_RAW.CAPSLOCK]: 'CAPS LOCK',
  [AMIGA_RAW.CTRL]: 'CTRL',
  [AMIGA_RAW.LALT]: 'L-ALT',
  [AMIGA_RAW.RALT]: 'R-ALT',
  [AMIGA_RAW.LAMIGA]: 'L-AMIGA',
  [AMIGA_RAW.RAMIGA]: 'R-AMIGA',
  [AMIGA_RAW.NP_0]: 'NUM 0',
  [AMIGA_RAW.NP_1]: 'NUM 1',
  [AMIGA_RAW.NP_2]: 'NUM 2',
  [AMIGA_RAW.NP_3]: 'NUM 3',
  [AMIGA_RAW.NP_4]: 'NUM 4',
  [AMIGA_RAW.NP_5]: 'NUM 5',
  [AMIGA_RAW.NP_6]: 'NUM 6',
  [AMIGA_RAW.NP_7]: 'NUM 7',
  [AMIGA_RAW.NP_8]: 'NUM 8',
  [AMIGA_RAW.NP_9]: 'NUM 9',
  [AMIGA_RAW.NP_DOT]: 'NUM .',
  [AMIGA_RAW.NP_LPAREN]: 'NUM (',
  [AMIGA_RAW.NP_RPAREN]: 'NUM )',
  [AMIGA_RAW.NP_SLASH]: 'NUM /',
  [AMIGA_RAW.NP_STAR]: 'NUM *',
  [AMIGA_RAW.NP_MINUS]: 'NUM -',
  [AMIGA_RAW.NP_PLUS]: 'NUM +',
};

/** Physical browser KeyboardEvent.code -> Amiga raw keycode */
export const BROWSER_CODE_TO_AMIGA: Record<string, number> = {
  Backquote: AMIGA_RAW.TILDE,
  Digit1: AMIGA_RAW.KEY_1,
  Digit2: AMIGA_RAW.KEY_2,
  Digit3: AMIGA_RAW.KEY_3,
  Digit4: AMIGA_RAW.KEY_4,
  Digit5: AMIGA_RAW.KEY_5,
  Digit6: AMIGA_RAW.KEY_6,
  Digit7: AMIGA_RAW.KEY_7,
  Digit8: AMIGA_RAW.KEY_8,
  Digit9: AMIGA_RAW.KEY_9,
  Digit0: AMIGA_RAW.KEY_0,
  Minus: AMIGA_RAW.MINUS,
  Equal: AMIGA_RAW.EQUALS,
  Backslash: AMIGA_RAW.BACKSLASH,
  Backspace: AMIGA_RAW.BACKSPACE,
  Tab: AMIGA_RAW.TAB,
  KeyQ: AMIGA_RAW.Q,
  KeyW: AMIGA_RAW.W,
  KeyE: AMIGA_RAW.E,
  KeyR: AMIGA_RAW.R,
  KeyT: AMIGA_RAW.T,
  KeyY: AMIGA_RAW.Y,
  KeyU: AMIGA_RAW.U,
  KeyI: AMIGA_RAW.I,
  KeyO: AMIGA_RAW.O,
  KeyP: AMIGA_RAW.P,
  BracketLeft: AMIGA_RAW.LBRACKET,
  BracketRight: AMIGA_RAW.RBRACKET,
  Enter: AMIGA_RAW.RETURN,
  ControlLeft: AMIGA_RAW.CTRL,
  ControlRight: AMIGA_RAW.CTRL,
  CapsLock: AMIGA_RAW.CAPSLOCK,
  KeyA: AMIGA_RAW.A,
  KeyS: AMIGA_RAW.S,
  KeyD: AMIGA_RAW.D,
  KeyF: AMIGA_RAW.F,
  KeyG: AMIGA_RAW.G,
  KeyH: AMIGA_RAW.H,
  KeyJ: AMIGA_RAW.J,
  KeyK: AMIGA_RAW.K,
  KeyL: AMIGA_RAW.L,
  Semicolon: AMIGA_RAW.SEMICOLON,
  Quote: AMIGA_RAW.APOSTROPHE,
  ShiftLeft: AMIGA_RAW.LSHIFT,
  ShiftRight: AMIGA_RAW.RSHIFT,
  IntlBackslash: AMIGA_RAW.INTL_LT,
  KeyZ: AMIGA_RAW.Z,
  KeyX: AMIGA_RAW.X,
  KeyC: AMIGA_RAW.C,
  KeyV: AMIGA_RAW.V,
  KeyB: AMIGA_RAW.B,
  KeyN: AMIGA_RAW.N,
  KeyM: AMIGA_RAW.M,
  Comma: AMIGA_RAW.COMMA,
  Period: AMIGA_RAW.PERIOD,
  Slash: AMIGA_RAW.SLASH,
  AltLeft: AMIGA_RAW.LALT,
  AltRight: AMIGA_RAW.RALT,
  MetaLeft: AMIGA_RAW.LAMIGA,
  MetaRight: AMIGA_RAW.RAMIGA,
  Space: AMIGA_RAW.SPACE,
  Escape: AMIGA_RAW.ESC,
  Delete: AMIGA_RAW.DEL,
  Insert: AMIGA_RAW.HELP,
  PageDown: AMIGA_RAW.HELP,
  Help: AMIGA_RAW.HELP,
  ArrowUp: AMIGA_RAW.UP,
  ArrowDown: AMIGA_RAW.DOWN,
  ArrowLeft: AMIGA_RAW.LEFT,
  ArrowRight: AMIGA_RAW.RIGHT,
  F1: AMIGA_RAW.F1,
  F2: AMIGA_RAW.F2,
  F3: AMIGA_RAW.F3,
  F4: AMIGA_RAW.F4,
  F5: AMIGA_RAW.F5,
  F6: AMIGA_RAW.F6,
  F7: AMIGA_RAW.F7,
  F8: AMIGA_RAW.F8,
  F9: AMIGA_RAW.F9,
  F10: AMIGA_RAW.F10,
  F11: AMIGA_RAW.NP_LPAREN,
  F12: AMIGA_RAW.NP_RPAREN,
  Numpad0: AMIGA_RAW.NP_0,
  Numpad1: AMIGA_RAW.NP_1,
  Numpad2: AMIGA_RAW.NP_2,
  Numpad3: AMIGA_RAW.NP_3,
  Numpad4: AMIGA_RAW.NP_4,
  Numpad5: AMIGA_RAW.NP_5,
  Numpad6: AMIGA_RAW.NP_6,
  Numpad7: AMIGA_RAW.NP_7,
  Numpad8: AMIGA_RAW.NP_8,
  Numpad9: AMIGA_RAW.NP_9,
  NumpadDecimal: AMIGA_RAW.NP_DOT,
  NumpadDivide: AMIGA_RAW.NP_SLASH,
  NumpadMultiply: AMIGA_RAW.NP_STAR,
  NumpadSubtract: AMIGA_RAW.NP_MINUS,
  NumpadAdd: AMIGA_RAW.NP_PLUS,
  NumpadEnter: AMIGA_RAW.NP_ENTER,
};

/**
 * Full Authentic Amiga 500 Main QWERTY Rows (every real Amiga main-deck key!)
 * Designed for crisp rendering on both 390px smartphones and 1440px desktops.
 */
export const AMIGA_FUNCTION_ROW: AmigaKeyDef[] = [
  { code: AMIGA_RAW.ESC, label: 'Esc', ariaLabel: 'Escape', variant: 'grey', flex: 1.15 },
  { code: AMIGA_RAW.F1, label: 'F1', ariaLabel: 'F1', variant: 'grey', flex: 1 },
  { code: AMIGA_RAW.F2, label: 'F2', ariaLabel: 'F2', variant: 'grey', flex: 1 },
  { code: AMIGA_RAW.F3, label: 'F3', ariaLabel: 'F3', variant: 'grey', flex: 1 },
  { code: AMIGA_RAW.F4, label: 'F4', ariaLabel: 'F4', variant: 'grey', flex: 1 },
  { code: AMIGA_RAW.F5, label: 'F5', ariaLabel: 'F5', variant: 'grey', flex: 1 },
  { code: AMIGA_RAW.F6, label: 'F6', ariaLabel: 'F6', variant: 'grey', flex: 1 },
  { code: AMIGA_RAW.F7, label: 'F7', ariaLabel: 'F7', variant: 'grey', flex: 1 },
  { code: AMIGA_RAW.F8, label: 'F8', ariaLabel: 'F8', variant: 'grey', flex: 1 },
  { code: AMIGA_RAW.F9, label: 'F9', ariaLabel: 'F9', variant: 'grey', flex: 1 },
  { code: AMIGA_RAW.F10, label: 'F10', ariaLabel: 'F10', variant: 'grey', flex: 1 },
  { code: AMIGA_RAW.DEL, label: 'Del', ariaLabel: 'Delete', variant: 'grey', flex: 1.15 },
  { code: AMIGA_RAW.HELP, label: 'Help', ariaLabel: 'Amiga Help', variant: 'accent', flex: 1.25 },
];

export const AMIGA_NUMBER_ROW: AmigaKeyDef[] = [
  { code: AMIGA_RAW.TILDE, label: '`', shiftLabel: '~', ariaLabel: 'Tilde', variant: 'ivory', flex: 0.92 },
  { code: AMIGA_RAW.KEY_1, label: '1', shiftLabel: '!', ariaLabel: '1', variant: 'ivory', flex: 1 },
  { code: AMIGA_RAW.KEY_2, label: '2', shiftLabel: '@', ariaLabel: '2', variant: 'ivory', flex: 1 },
  { code: AMIGA_RAW.KEY_3, label: '3', shiftLabel: '#', ariaLabel: '3', variant: 'ivory', flex: 1 },
  { code: AMIGA_RAW.KEY_4, label: '4', shiftLabel: '$', ariaLabel: '4', variant: 'ivory', flex: 1 },
  { code: AMIGA_RAW.KEY_5, label: '5', shiftLabel: '%', ariaLabel: '5', variant: 'ivory', flex: 1 },
  { code: AMIGA_RAW.KEY_6, label: '6', shiftLabel: '^', ariaLabel: '6', variant: 'ivory', flex: 1 },
  { code: AMIGA_RAW.KEY_7, label: '7', shiftLabel: '&', ariaLabel: '7', variant: 'ivory', flex: 1 },
  { code: AMIGA_RAW.KEY_8, label: '8', shiftLabel: '*', ariaLabel: '8', variant: 'ivory', flex: 1 },
  { code: AMIGA_RAW.KEY_9, label: '9', shiftLabel: '(', ariaLabel: '9', variant: 'ivory', flex: 1 },
  { code: AMIGA_RAW.KEY_0, label: '0', shiftLabel: ')', ariaLabel: '0', variant: 'ivory', flex: 1 },
  { code: AMIGA_RAW.MINUS, label: '-', shiftLabel: '_', ariaLabel: 'Minus', variant: 'ivory', flex: 0.95 },
  { code: AMIGA_RAW.EQUALS, label: '=', shiftLabel: '+', ariaLabel: 'Equals', variant: 'ivory', flex: 0.95 },
  { code: AMIGA_RAW.BACKSPACE, label: '⌫', ariaLabel: 'Backspace', variant: 'grey', flex: 1.35 },
];

export const AMIGA_QWERTY_ROW: AmigaKeyDef[] = [
  { code: AMIGA_RAW.TAB, label: 'Tab', ariaLabel: 'Tab', variant: 'grey', flex: 1.25 },
  { code: AMIGA_RAW.Q, label: 'Q', ariaLabel: 'Q', variant: 'ivory', flex: 1 },
  { code: AMIGA_RAW.W, label: 'W', ariaLabel: 'W', variant: 'ivory', flex: 1 },
  { code: AMIGA_RAW.E, label: 'E', ariaLabel: 'E', variant: 'ivory', flex: 1 },
  { code: AMIGA_RAW.R, label: 'R', ariaLabel: 'R', variant: 'ivory', flex: 1 },
  { code: AMIGA_RAW.T, label: 'T', ariaLabel: 'T', variant: 'ivory', flex: 1 },
  { code: AMIGA_RAW.Y, label: 'Y', ariaLabel: 'Y', variant: 'ivory', flex: 1 },
  { code: AMIGA_RAW.U, label: 'U', ariaLabel: 'U', variant: 'ivory', flex: 1 },
  { code: AMIGA_RAW.I, label: 'I', ariaLabel: 'I', variant: 'ivory', flex: 1 },
  { code: AMIGA_RAW.O, label: 'O', ariaLabel: 'O', variant: 'ivory', flex: 1 },
  { code: AMIGA_RAW.P, label: 'P', ariaLabel: 'P', variant: 'ivory', flex: 1 },
  { code: AMIGA_RAW.LBRACKET, label: '[', shiftLabel: '{', ariaLabel: 'Left Bracket', variant: 'ivory', flex: 0.95 },
  { code: AMIGA_RAW.RBRACKET, label: ']', shiftLabel: '}', ariaLabel: 'Right Bracket', variant: 'ivory', flex: 0.95 },
  { code: AMIGA_RAW.BACKSLASH, label: '\\', shiftLabel: '|', ariaLabel: 'Backslash', variant: 'ivory', flex: 0.95 },
];

export const AMIGA_CAPSLOCK_KEY: AmigaKeyDef = {
  code: AMIGA_RAW.CAPSLOCK,
  label: 'Caps',
  ariaLabel: 'Caps Lock',
  variant: 'grey',
  flex: 1.15,
  isCapsLock: true,
};

export const AMIGA_HOME_ROW: AmigaKeyDef[] = [
  { code: AMIGA_RAW.CTRL, label: 'Ctrl', ariaLabel: 'Control', variant: 'grey', flex: 1.6, isModifier: true },
  { code: AMIGA_RAW.A, label: 'A', ariaLabel: 'A', variant: 'ivory', flex: 1 },
  { code: AMIGA_RAW.S, label: 'S', ariaLabel: 'S', variant: 'ivory', flex: 1 },
  { code: AMIGA_RAW.D, label: 'D', ariaLabel: 'D', variant: 'ivory', flex: 1 },
  { code: AMIGA_RAW.F, label: 'F', ariaLabel: 'F', variant: 'ivory', flex: 1 },
  { code: AMIGA_RAW.G, label: 'G', ariaLabel: 'G', variant: 'ivory', flex: 1 },
  { code: AMIGA_RAW.H, label: 'H', ariaLabel: 'H', variant: 'ivory', flex: 1 },
  { code: AMIGA_RAW.J, label: 'J', ariaLabel: 'J', variant: 'ivory', flex: 1 },
  { code: AMIGA_RAW.K, label: 'K', ariaLabel: 'K', variant: 'ivory', flex: 1 },
  { code: AMIGA_RAW.L, label: 'L', ariaLabel: 'L', variant: 'ivory', flex: 1 },
  { code: AMIGA_RAW.SEMICOLON, label: ';', shiftLabel: ':', ariaLabel: 'Semicolon', variant: 'ivory', flex: 0.95 },
  { code: AMIGA_RAW.APOSTROPHE, label: "'", shiftLabel: '"', ariaLabel: 'Apostrophe', variant: 'ivory', flex: 0.95 },
  { code: AMIGA_RAW.RETURN, label: 'Ret', ariaLabel: 'Return', variant: 'grey', flex: 1.75, returnIcon: true },
];

export const AMIGA_BOTTOM_ROW: AmigaKeyDef[] = [
  { code: AMIGA_RAW.LSHIFT, label: '⇧', ariaLabel: 'Left Shift', variant: 'grey', flex: 1.5, isModifier: true },
  { code: AMIGA_RAW.Z, label: 'Z', ariaLabel: 'Z', variant: 'ivory', flex: 1 },
  { code: AMIGA_RAW.X, label: 'X', ariaLabel: 'X', variant: 'ivory', flex: 1 },
  { code: AMIGA_RAW.C, label: 'C', ariaLabel: 'C', variant: 'ivory', flex: 1 },
  { code: AMIGA_RAW.V, label: 'V', ariaLabel: 'V', variant: 'ivory', flex: 1 },
  { code: AMIGA_RAW.B, label: 'B', ariaLabel: 'B', variant: 'ivory', flex: 1 },
  { code: AMIGA_RAW.N, label: 'N', ariaLabel: 'N', variant: 'ivory', flex: 1 },
  { code: AMIGA_RAW.M, label: 'M', ariaLabel: 'M', variant: 'ivory', flex: 1 },
  { code: AMIGA_RAW.COMMA, label: ',', shiftLabel: '<', ariaLabel: 'Comma', variant: 'ivory', flex: 1 },
  { code: AMIGA_RAW.PERIOD, label: '.', shiftLabel: '>', ariaLabel: 'Period', variant: 'ivory', flex: 1 },
  { code: AMIGA_RAW.SLASH, label: '/', shiftLabel: '?', ariaLabel: 'Slash', variant: 'ivory', flex: 1 },
  { code: AMIGA_RAW.RSHIFT, label: '⇧', ariaLabel: 'Right Shift', variant: 'grey', flex: 1.5, isModifier: true },
];

export const AMIGA_SPACE_ROW: AmigaKeyDef[] = [
  { code: AMIGA_RAW.LALT, label: 'Alt', ariaLabel: 'Left Alt', variant: 'grey', flex: 1.15, isModifier: true },
  { code: AMIGA_RAW.LAMIGA, label: 'A', ariaLabel: 'Left Amiga', variant: 'grey', flex: 1.25, isModifier: true, amigaLogo: 'hollow' },
  { code: AMIGA_RAW.SPACE, label: 'SPACE', ariaLabel: 'Spacebar', variant: 'ivory', flex: 4.5 },
  { code: AMIGA_RAW.RAMIGA, label: 'A', ariaLabel: 'Right Amiga', variant: 'grey', flex: 1.25, isModifier: true, amigaLogo: 'filled' },
  { code: AMIGA_RAW.RALT, label: 'Alt', ariaLabel: 'Right Alt', variant: 'grey', flex: 1.15, isModifier: true },
];

/** Authentic 18-key Commodore Amiga Numeric Keypad (includes signature ( ) / * top row) */
export const AMIGA_NUMPAD_ROWS: AmigaKeyDef[][] = [
  [
    { code: AMIGA_RAW.NP_LPAREN, label: '(', ariaLabel: 'Numpad Left Paren', variant: 'grey', flex: 1 },
    { code: AMIGA_RAW.NP_RPAREN, label: ')', ariaLabel: 'Numpad Right Paren', variant: 'grey', flex: 1 },
    { code: AMIGA_RAW.NP_SLASH, label: '/', ariaLabel: 'Numpad Divide', variant: 'grey', flex: 1 },
    { code: AMIGA_RAW.NP_STAR, label: '*', ariaLabel: 'Numpad Multiply', variant: 'grey', flex: 1 },
  ],
  [
    { code: AMIGA_RAW.NP_7, label: '7', ariaLabel: 'Numpad 7', variant: 'ivory', flex: 1 },
    { code: AMIGA_RAW.NP_8, label: '8', ariaLabel: 'Numpad 8', variant: 'ivory', flex: 1 },
    { code: AMIGA_RAW.NP_9, label: '9', ariaLabel: 'Numpad 9', variant: 'ivory', flex: 1 },
    { code: AMIGA_RAW.NP_MINUS, label: '-', ariaLabel: 'Numpad Minus', variant: 'grey', flex: 1 },
  ],
  [
    { code: AMIGA_RAW.NP_4, label: '4', ariaLabel: 'Numpad 4', variant: 'ivory', flex: 1 },
    { code: AMIGA_RAW.NP_5, label: '5', ariaLabel: 'Numpad 5', variant: 'ivory', flex: 1 },
    { code: AMIGA_RAW.NP_6, label: '6', ariaLabel: 'Numpad 6', variant: 'ivory', flex: 1 },
    { code: AMIGA_RAW.NP_PLUS, label: '+', ariaLabel: 'Numpad Plus', variant: 'grey', flex: 1 },
  ],
  [
    { code: AMIGA_RAW.NP_1, label: '1', ariaLabel: 'Numpad 1', variant: 'ivory', flex: 1 },
    { code: AMIGA_RAW.NP_2, label: '2', ariaLabel: 'Numpad 2', variant: 'ivory', flex: 1 },
    { code: AMIGA_RAW.NP_3, label: '3', ariaLabel: 'Numpad 3', variant: 'ivory', flex: 1 },
    { code: AMIGA_RAW.NP_ENTER, label: 'Ent', ariaLabel: 'Numpad Enter', variant: 'grey', flex: 1 },
  ],
  [
    { code: AMIGA_RAW.NP_0, label: '0', ariaLabel: 'Numpad 0', variant: 'ivory', flex: 2 },
    { code: AMIGA_RAW.NP_DOT, label: '.', ariaLabel: 'Numpad Dot', variant: 'ivory', flex: 1 },
    { code: AMIGA_RAW.INTL_LT, label: '<>', ariaLabel: 'Amiga International Key', variant: 'grey', flex: 1 },
  ],
];

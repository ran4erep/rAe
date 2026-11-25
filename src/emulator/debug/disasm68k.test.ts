import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectWaitLoopHints,
  disassembleOne68k,
  disassembleWindowAroundPc,
} from './disasm68k';

function makeWordReader(baseAddr: number, words: number[]): (addr: number) => number {
  return (addr: number) => {
    const idx = ((addr & 0x00fffffe) - baseAddr) >>> 1;
    return idx >= 0 && idx < words.length ? words[idx] & 0xffff : 0;
  };
}

test('disassembleOne68k decodes core 68k instructions and annotates Amiga hardware registers and Exec LVOs', () => {
  // $010000:
  //   MOVE.W $DFF004,D0    -> 3039 00DF F004
  //   BTST #6,$BFE001      -> 0839 0006 00BF E001
  //   JSR -456(A6)         -> 4EAE FE38
  //   STOP #$2000          -> 4E72 2000
  //   BRA.S $010000        -> 60EC (from PC+2=$010016 -> $010016 - 20 = $010002; let's check exact)
  const words = [
    0x3039, 0x00df, 0xf004,
    0x0839, 0x0006, 0x00bf, 0xe001,
    0x4eae, 0xfe38,
    0x4e72, 0x2000,
    0x4e75,
  ];
  const peek16 = makeWordReader(0x010000, words);

  const i1 = disassembleOne68k(peek16, 0x010000);
  assert.equal(i1.byteLength, 6);
  assert.match(i1.mnemonic, /^MOVE\.W \(\$DFF004\)\.L,D0$/);
  assert.match(i1.comment, /VPOSR/);

  const i2 = disassembleOne68k(peek16, 0x010006);
  assert.equal(i2.byteLength, 8);
  assert.match(i2.mnemonic, /^BTST #6,\(\$BFE001\)\.L$/);
  assert.match(i2.comment, /CIAAPRA/);

  const i3 = disassembleOne68k(peek16, 0x01000e);
  assert.equal(i3.byteLength, 4);
  assert.equal(i3.mnemonic, 'JSR -$1C8(A6)');
  assert.match(i3.comment, /_LVODoIO/);

  const i4 = disassembleOne68k(peek16, 0x010012);
  assert.equal(i4.byteLength, 4);
  assert.equal(i4.mnemonic, 'STOP #$2000');

  const i5 = disassembleOne68k(peek16, 0x010016);
  assert.equal(i5.byteLength, 2);
  assert.equal(i5.mnemonic, 'RTS');
});

test('disassembleWindowAroundPc aligns on PC and detectWaitLoopHints identifies VPOSR & STOP waits', () => {
  const words = [
    0x7000,                 // MOVEQ #0,D0
    0x3039, 0x00df, 0xf004, // MOVE.W ($DFF004).L,D0
    0x60fe,                 // BRA.S $010008 (self-loop)
    0x4e72, 0x2700,         // STOP #$2700
  ];
  const peek16 = makeWordReader(0x010000, words);
  const { lines, pcIndex } = disassembleWindowAroundPc(peek16, 0x010008, 16, 4);

  assert.equal(lines[pcIndex].addr, 0x010008);
  assert.equal(lines[pcIndex].mnemonic, 'BRA.S $010008');

  const hints = detectWaitLoopHints(lines, pcIndex);
  assert.ok(hints.some((h) => h.includes('VPOSR')));
  assert.ok(hints.some((h) => h.includes('010008')));
  assert.ok(hints.some((h) => h.includes('STOP')));
});

import { disassembleSubroutine } from './disasm68k';

test('disassembleWindowAroundPc with beforeBytes=0 skips backward scan and disassembleSubroutine stops at RTS', () => {
  // Preceding bytes ($010000..$010004) contain $003F $0000 which used to confuse beforeBytes=0
  // Subroutine starts at $010006: BTST #5,($DFF01F).L ; BEQ.S $010006 ; RTS ; trailing $FFFF
  const words = [
    0x003f, 0x0000, 0x33fc,
    0x0839, 0x0005, 0x00df, 0xf01f, // $010006: BTST #5,($DFF01F).L
    0x67f6,                         // $01000E: BEQ.S $010006
    0x4e75,                         // $010010: RTS
    0xffff, 0xffff,
  ];
  const peek16 = makeWordReader(0x010000, words);

  const forward = disassembleWindowAroundPc(peek16, 0x010006, 0, 4);
  assert.equal(forward.pcIndex, 0);
  assert.equal(forward.lines[0].addr, 0x010006);
  assert.equal(forward.lines[0].mnemonic, 'BTST #5,($DFF01F).L');
  assert.match(forward.lines[0].comment, /INTREQR\+1/);

  const hints = detectWaitLoopHints(forward.lines, forward.pcIndex);
  assert.ok(hints.some((h) => h.includes('INTREQR')));

  const sub = disassembleSubroutine(peek16, 0x010006, 20);
  assert.equal(sub.length, 3);
  assert.equal(sub[2].mnemonic, 'RTS');
});


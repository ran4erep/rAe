import test from 'node:test';
import assert from 'node:assert/strict';
import { M68000, M68kBus, SR_C, SR_N, SR_S, SR_V, SR_Z } from './m68k';

class FlatBus implements M68kBus {
  public readonly mem = new Uint8Array(65536);

  read8(addr: number): number {
    return this.mem[addr & 0xffff];
  }
  read16(addr: number): number {
    const a = addr & 0xfffe;
    return (this.mem[a] << 8) | this.mem[a + 1];
  }
  read32(addr: number): number {
    const a = addr & 0xfffe;
    return (
      (this.mem[a] << 24) |
      (this.mem[a + 1] << 16) |
      (this.mem[a + 2] << 8) |
      this.mem[a + 3]
    );
  }
  write8(addr: number, val: number): void {
    this.mem[addr & 0xffff] = val & 0xff;
  }
  write16(addr: number, val: number): void {
    const a = addr & 0xfffe;
    this.mem[a] = (val >>> 8) & 0xff;
    this.mem[a + 1] = val & 0xff;
  }
  write32(addr: number, val: number): void {
    const a = addr & 0xfffe;
    this.mem[a] = (val >>> 24) & 0xff;
    this.mem[a + 1] = (val >>> 16) & 0xff;
    this.mem[a + 2] = (val >>> 8) & 0xff;
    this.mem[a + 3] = val & 0xff;
  }
}

function setupCpu(words: number[], startPc = 0x1000): { cpu: M68000; bus: FlatBus } {
  const bus = new FlatBus();
  bus.write32(0x0000, 0x00008000); // Initial SSP
  bus.write32(0x0004, startPc);    // Initial PC
  for (let i = 0; i < words.length; i++) {
    bus.write16(startPc + i * 2, words[i]);
  }
  const cpu = new M68000(bus);
  cpu.reset();
  return { cpu, bus };
}

test('M68000 reset fetches SSP and PC and sets Supervisor IPL 7', () => {
  const { cpu } = setupCpu([0x4e71]);
  assert.equal(cpu.a[7], 0x8000);
  assert.equal(cpu.pc, 0x1000);
  assert.equal(cpu.sr, 0x2700);
});

test('M68000 MOVEQ, ADD, SUB, MULU, DIVU arithmetic and CCR flags', () => {
  // MOVEQ #12, D0 | MOVEQ #5, D1 | MULU D1, D0 (60) | ADDQ.L #4, D0 (64) | DIVU #10, D0 (rem=4, quot=6)
  const { cpu } = setupCpu([
    0x700c, // MOVEQ #12, D0
    0x7205, // MOVEQ #5, D1
    0xc0c1, // MULU D1, D0 -> 60
    0x5880, // ADDQ.L #4, D0 -> 64
    0x80fc, 0x000a, // DIVU #10, D0 -> 0x00040006
  ]);

  cpu.step(); assert.equal(cpu.d[0], 12);
  cpu.step(); assert.equal(cpu.d[1], 5);
  cpu.step(); assert.equal(cpu.d[0], 60);
  cpu.step(); assert.equal(cpu.d[0], 64);
  cpu.step(); assert.equal(cpu.d[0], 0x00040006);
  assert.equal(cpu.sr & (SR_Z | SR_N | SR_V | SR_C), 0);
});

test('M68000 signed overflow and carry flags on ADD.B / SUB.B', () => {
  // MOVE.B #$7F, D0 | ADDQ.B #1, D0 -> $80 (N=1, V=1, C=0, Z=0)
  // SUBI.B #$80, D0 -> $00 (Z=1, N=0, V=0, C=0)
  const { cpu } = setupCpu([
    0x103c, 0x007f, // MOVE.B #$7F, D0
    0x5200,         // ADDQ.B #1, D0
    0x0400, 0x0080, // SUBI.B #$80, D0
  ]);

  cpu.step();
  cpu.step();
  assert.equal(cpu.d[0] & 0xff, 0x80);
  assert.ok((cpu.sr & SR_N) !== 0);
  assert.ok((cpu.sr & SR_V) !== 0);
  assert.equal(cpu.sr & SR_C, 0);

  cpu.step();
  assert.equal(cpu.d[0] & 0xff, 0x00);
  assert.ok((cpu.sr & SR_Z) !== 0);
  assert.equal(cpu.sr & SR_N, 0);
});

test('M68000 DBRA loop, BSR/RTS subroutine, and MOVEM push/pop', () => {
  // Sum 1..5 in D1 using DBRA, save/restore via MOVEM
  const { cpu } = setupCpu([
    0x7004,         // 1000: MOVEQ #4, D0 (5 iterations: 4,3,2,1,0)
    0x7200,         // 1002: MOVEQ #0, D1
    0x48e7, 0x8000, // 1004: MOVEM.L D0, -(A7)
    // loop at 1008:
    0xd240,         // 1008: ADD.W D0, D1 (0+4+3+2+1+0 = 10)
    0x51c8, 0xfffc, // 100A: DBRA D0, $1008
    0x4cdf, 0x0001, // 100E: MOVEM.L (A7)+, D0 (restores D0 = 4)
    0x6100, 0x0004, // 1012: BSR.W +4 -> $1018
    0x4e71,         // 1016: NOP
    0x5a41,         // 1018: ADDQ.W #5, D1 -> 15
    0x4e75,         // 101A: RTS
  ]);

  for (let i = 0; i < 20 && cpu.pc !== 0x1016; i++) {
    cpu.step();
  }
  assert.equal(cpu.d[0], 4);
  assert.equal(cpu.d[1], 15);
  assert.equal(cpu.a[7], 0x8000);
});

test('M68000 bit ops (BSET/BTST/BCLR) and shifts (LSL/ASR)', () => {
  const { cpu } = setupCpu([
    0x7000,         // MOVEQ #0, D0
    0x08c0, 0x0003, // BSET #3, D0 -> D0=8, Z=1 (was 0)
    0x0800, 0x0003, // BTST #3, D0 -> Z=0
    0x0880, 0x0003, // BCLR #3, D0 -> D0=0, Z=0 (was 1)
    0x72ff,         // MOVEQ #-1, D1 ($FFFFFFFF)
    0xe281,         // ASR.L #1, D1 -> still -1 (sign preserved)
    0xe389,         // LSL.L #1, D1 -> $FFFFFFFE
  ]);

  cpu.step();
  cpu.step();
  assert.equal(cpu.d[0], 8);
  assert.ok((cpu.sr & SR_Z) !== 0);

  cpu.step();
  assert.equal(cpu.sr & SR_Z, 0);

  cpu.step();
  assert.equal(cpu.d[0], 0);

  cpu.step();
  cpu.step();
  assert.equal(cpu.d[1], -1);

  cpu.step();
  assert.equal(cpu.d[1] >>> 0, 0xfffffffe);
});

test('M68000 STOP wakes cleanly on Level 3 interrupt and returns via RTE', () => {
  const { cpu, bus } = setupCpu([
    0x46fc, 0x2000, // 1000: MOVE #$2000, SR (IPL=0)
    0x4e72, 0x2000, // 1004: STOP #$2000
    0x702a,         // 1008: MOVEQ #42, D0
  ]);

  // Install Level 3 autovector ($6C) -> $2000: MOVEQ #99, D1 ; RTE
  bus.write32(0x006c, 0x00002000);
  bus.write16(0x2000, 0x7263); // MOVEQ #99, D1
  bus.write16(0x2002, 0x4e73); // RTE

  cpu.step(); // MOVE SR
  cpu.step(); // STOP
  assert.equal(cpu.stopped, true);
  assert.equal(cpu.pc, 0x1008);

  // Trigger IPL 3
  cpu.pendingIpl = 3;
  cpu.step(); // Takes vector 27 -> $2000
  assert.equal(cpu.stopped, false);
  assert.equal(cpu.pc, 0x2000);
  assert.ok((cpu.sr & SR_S) !== 0);

  cpu.pendingIpl = 0;
  cpu.step(); // MOVEQ #99, D1
  cpu.step(); // RTE -> returns to $1008
  cpu.step(); // MOVEQ #42, D0
  assert.equal(cpu.d[1], 99);
  assert.equal(cpu.d[0], 42);
});

test('M68000 Privilege Violation (ORI to SR in User mode) pushes faulting instruction PC (Exec Supervisor pattern)', () => {
  const { cpu, bus } = setupCpu([
    0x46fc, 0x0000, // 1000: MOVE #$0000, SR (switch to User mode)
    0x007c, 0x2000, // 1004: ORI.W #$2000, SR (must trap to vector 8 with stacked PC=$1004!)
  ]);
  bus.write32(0x0020, 0x00002000); // Vector 8 (Privilege Violation) -> $2000
  bus.write16(0x2000, 0x4e71);     // NOP at handler

  cpu.step(); // MOVE #$0000, SR -> User mode
  assert.equal(cpu.sr & SR_S, 0);

  cpu.step(); // ORI.W #$2000, SR -> Privilege Violation
  assert.equal(cpu.pc, 0x2000);
  assert.ok((cpu.sr & SR_S) !== 0);
  // Stacked frame on SSP: [SR.W at 0(A7)], [faulting PC.L at 2(A7)]
  const stackedPc = bus.read32((cpu.a[7] + 2) >>> 0);
  assert.equal(stackedPc, 0x1004);
});

test('M68000 MOVEM.L (A0)+, D0/A0 preserves loaded A0 without post-increment clobbering', () => {
  const { cpu, bus } = setupCpu([
    0x207c, 0x0000, 0x3000, // MOVEA.L #$3000, A0
    0x4cd8, 0x0101,         // MOVEM.L (A0)+, D0/A0 (bit 0 = D0, bit 8 = A0)
  ]);
  bus.write32(0x3000, 0x11223344); // Loaded into D0
  bus.write32(0x3004, 0x00004444); // Loaded into A0

  cpu.step();
  cpu.step();
  assert.equal(cpu.d[0] >>> 0, 0x11223344);
  assert.equal(cpu.a[0] >>> 0, 0x00004444);
});


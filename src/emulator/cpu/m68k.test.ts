import test from 'node:test';
import assert from 'node:assert/strict';
import { M68000, M68kBus, SR_C, SR_N, SR_S, SR_T, SR_V, SR_Z } from './m68k';

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

test('M68000 Trace mode (SR_T, Vector 9): ORI #SR_T traces following instructions and RTE resumes tracing', () => {
  const { cpu, bus } = setupCpu([
    0x007c, 0x8000, // 1000: ORI.W #$8000, SR (must NOT trace itself)
    0x5280,         // 1004: ADDQ.L #1, D0 (first traced instruction)
    0x5480,         // 1006: ADDQ.L #2, D0 (second traced instruction)
  ]);

  // Vector 9 ($0024) -> $2000: ADDQ.L #1, D1 ; RTE
  bus.write32(0x0024, 0x00002000);
  bus.write16(0x2000, 0x5281); // ADDQ.L #1, D1
  bus.write16(0x2002, 0x4e73); // RTE

  cpu.step(); // ORI.W #$8000, SR -> sets T=1, stays at $1004 without Vector 9
  assert.equal(cpu.pc, 0x1004);
  assert.ok((cpu.sr & SR_T) !== 0);
  assert.equal(cpu.d[1], 0);

  cpu.step(); // Executes ADDQ.L #1, D0 then immediately takes Vector 9 -> $2000
  assert.equal(cpu.d[0], 1);
  assert.equal(cpu.pc, 0x2000);
  assert.equal(cpu.sr & SR_T, 0); // T cleared while inside Trace handler
  assert.equal(bus.read32((cpu.a[7] + 2) >>> 0), 0x1006); // Pushed next PC
  assert.ok((bus.read16(cpu.a[7]) & SR_T) !== 0); // Pushed SR still has T=1

  cpu.step(); // ADDQ.L #1, D1
  cpu.step(); // RTE -> restores SR (T=1) and returns to $1006 without self-tracing RTE
  assert.equal(cpu.pc, 0x1006);
  assert.ok((cpu.sr & SR_T) !== 0);
  assert.equal(cpu.d[1], 1);

  cpu.step(); // Executes ADDQ.L #2, D0 then takes Vector 9 again
  assert.equal(cpu.d[0], 3);
  assert.equal(cpu.pc, 0x2000);
  assert.equal(cpu.getRecentFaults().length, 0); // Normal Trace does not pollute fault log
});

test('M68000 Trace mode suppresses Vector 9 on aborted ILLEGAL (Group 1) but traces TRAP (Group 2)', () => {
  const { cpu, bus } = setupCpu([
    0x007c, 0x8000, // 1000: ORI.W #$8000, SR
    0x4afc,         // 1004: ILLEGAL (must jump to Vector 4 only, NOT Vector 9)
  ]);
  bus.write32(0x0010, 0x00002000); // Vector 4 -> $2000
  bus.write32(0x0024, 0x00003000); // Vector 9 -> $3000
  bus.write16(0x2000, 0x4e40);     // TRAP #0 (at $2000)
  bus.write32(0x0080, 0x00002200); // Vector 32 (TRAP #0) -> $2200
  bus.write16(0x2200, 0x4e71);     // NOP

  cpu.step(); // ORI.W #$8000, SR
  cpu.step(); // ILLEGAL -> Vector 4 only (no Trace)
  assert.equal(cpu.pc, 0x2000);
  assert.equal(bus.read32((cpu.a[7] + 2) >>> 0), 0x1004);

  // Now test TRAP #0 while T=1
  cpu.setSR(0xa700);
  cpu.pc = 0x2000;
  cpu.step(); // TRAP #0 enters $2200 and then triggers Vector 9 -> $3000 before executing $2200
  assert.equal(cpu.pc, 0x3000);
  assert.equal(bus.read32((cpu.a[7] + 2) >>> 0), 0x2200);
});

test('M68000 Copylock-style Trace self-decrypting instruction stream and clean exit', () => {
  const key = 0x1234;
  const plainInstr1 = 0x702a; // MOVEQ #42, D0
  const plainInstr2 = 0x5280; // ADDQ.L #1, D0

  const { cpu, bus } = setupCpu([
    0x007c, 0x8000,      // 1000: ORI.W #$8000, SR
    0x4e71,              // 1004: NOP (first traced instr; triggers decryption of $1006)
    plainInstr1 ^ key,   // 1006: encrypted MOVEQ #42, D0
    plainInstr2 ^ key,   // 1008: encrypted ADDQ.L #1, D0
    0x4e71,              // 100A: sentinel NOP
  ]);

  // Vector 9 ($0024) -> $2000:
  // Decrypts word at stacked PC (2(A7)), and stops tracing once stacked PC >= $100A
  //   2000: MOVEA.L 2(A7), A0     (0x206f 0x0002)
  //   2004: CMPA.L  #$100a, A0    (0xb1fc 0x0000 0x100a)
  //   200A: BEQ.S   $2016         (0x670a)
  //   200C: EORI.W  #$1234, (A0)  (0x0a50 0x1234)
  //   2010: RTE                   (0x4e73)
  //   2012..2014: NOP             (0x4e71 0x4e71)
  //   2016: ANDI.W  #$7fff, (A7)  (0x0257 0x7fff)
  //   201A: RTE                   (0x4e73)
  const handler = [
    0x206f, 0x0002,
    0xb1fc, 0x0000, 0x100a,
    0x670a,
    0x0a50, key,
    0x4e73,
    0x4e71, 0x4e71,
    0x0257, 0x7fff,
    0x4e73,
  ];
  bus.write32(0x0024, 0x00002000);
  for (let i = 0; i < handler.length; i++) {
    bus.write16(0x2000 + i * 2, handler[i]);
  }

  for (let i = 0; i < 40 && cpu.pc !== 0x100c; i++) {
    cpu.step();
  }
  assert.equal(cpu.pc, 0x100c);
  assert.equal(cpu.d[0], 43);
  assert.equal(cpu.sr & SR_T, 0);
});

test('M68EC020 MOVEC (VBR, CACR), Vector Base offset, and 4-word Format $0 exception frame + RTE', () => {
  const { cpu, bus } = setupCpu([
    0x203c, 0x0000, 0x2000, // 1000: MOVE.L #$2000, D0
    0x4e7b, 0x0801,         // 1006: MOVEC D0, VBR ($801)
    0x70ff,                 // 100A: MOVEQ #-1, D0
    0x4e7b, 0x0002,         // 100C: MOVEC D0, CACR ($002 -> masked to 0x0003)
    0x4e7a, 0x1002,         // 1010: MOVEC CACR, D1
    0x4e40,                 // 1014: TRAP #0 (Vector 32 = VBR + $80 = $2080)
    0x742a,                 // 1016: MOVEQ #42, D2 (resumed after RTE)
  ]);
  cpu.is68020 = true;
  // Install TRAP #0 handler at VBR($2000) + $80 = $2080 -> $3000
  bus.write32(0x2080, 0x00003000);
  bus.write16(0x3000, 0x7655); // MOVEQ #$55, D3
  bus.write16(0x3002, 0x4e73); // RTE

  cpu.step(); // MOVE.L
  cpu.step(); // MOVEC D0, VBR
  assert.equal(cpu.vbr, 0x2000);
  cpu.step(); // MOVEQ #-1, D0
  cpu.step(); // MOVEC D0, CACR
  assert.equal(cpu.cacr, 0x0003);
  cpu.step(); // MOVEC CACR, D1
  assert.equal(cpu.d[1], 0x0003);

  const spBefore = cpu.a[7];
  cpu.step(); // TRAP #0 -> pushes 4-word Format $0 frame (8 bytes)
  assert.equal(cpu.pc, 0x3000);
  assert.equal(cpu.a[7], spBefore - 8);
  assert.equal(bus.read32(cpu.a[7] + 2), 0x1016);
  assert.equal(bus.read16(cpu.a[7] + 6), 0x0080); // Format $0 + vector offset $080

  cpu.step(); // MOVEQ #$55, D3
  cpu.step(); // RTE pops 8 bytes cleanly
  assert.equal(cpu.a[7], spBefore);
  assert.equal(cpu.pc, 0x1016);
  cpu.step(); // MOVEQ #42, D2
  assert.equal(cpu.d[2], 42);
  assert.equal(cpu.d[3], 0x55);
});

test('M68EC020 EXTB.L, Bcc.L, LINK.L, RTD, MOVE CCR,<ea>, CHK.L, and LEA non-collision', () => {
  const { cpu, bus } = setupCpu([
    0x70fe,                 // 1000: MOVEQ #-2, D0 -> test EXTB.L on $FE byte
    0x0280, 0x0000, 0x00fe, // 1002: ANDI.L #$000000FE, D0 -> D0=$000000FE
    0x49c0,                 // 1008: EXTB.L D0 -> D0=$FFFFFFFE (-2)
    0x4e7a, 0x1801,         // 100A: MOVEC VBR, D1
    0x41f9, 0x0000, 0x4000, // 100E: LEA $00004000, A0 (must NOT collide with EXTB.L!)
    0x42d0,                 // 1014: MOVE.W CCR, (A0)
    0x61ff, 0x0000, 0x0008, // 1016: BSR.L +8 from $1018 -> $1020
    0x7477,                 // 101C: MOVEQ #$77, D2
    0x4e71,                 // 101E: NOP (done)
    // $1020 subroutine: LINK.L A1,#-16; MOVE.L #10,D3; CHK.L #20,D3; UNLK A1; RTD #4
    0x4809, 0xffff, 0xfff0, // 1020: LINK.L A1, #-16
    0x760a,                 // 1026: MOVEQ #10, D3
    0x473c, 0x0000, 0x0014, // 1028: CHK.L #20, D3 (reg=3 -> 0x0600, size=100 -> 0x0100 => 0x473C)
    0x4e59,                 // 102E: UNLK A1
    0x4e74, 0x0004,         // 1030: RTD #4 (pops PC and adds +4 to SP)
  ]);
  cpu.is68020 = true;

  // Push dummy 4-byte arg before calling BSR.L to verify RTD #4 cleans it up
  cpu.a[7] -= 4;
  const spWithArg = cpu.a[7];

  for (let i = 0; i < 20 && cpu.pc !== 0x101e; i++) {
    cpu.step();
  }
  assert.equal(cpu.pc, 0x101e);
  assert.equal(cpu.d[0] | 0, -2);
  assert.equal(cpu.a[0], 0x4000);
  // N flag was set by EXTB.L D0 ($FFFFFFFE), VBR read leaves flags unchanged
  assert.ok((bus.read16(0x4000) & SR_N) !== 0);
  assert.equal(cpu.d[2], 0x77);
  assert.equal(cpu.d[3], 10);
  assert.equal(cpu.a[7], spWithArg + 4);
});

test('M68EC020 32/64-bit MULU.L, MULS.L, DIVU.L, DIVS.L arithmetic', () => {
  // 1) MULU.L #$00010000, D1:D0 where D0=$00020003 -> 64-bit product = 0x00000002_00030000 (D1=2, D0=$30000)
  // 2) MULS.L #-3, D2 -> where D2=100000 -> -300000
  // 3) DIVU.L #1000, D1:D0 -> dividend $00000001_00000005 / 1000 -> Q=4294967, R=296+5=301
  // 4) DIVS.L #-7, D3:D2 -> -50 / -7 -> Q=7, R=-1
  const { cpu } = setupCpu([
    0x203c, 0x0002, 0x0003,             // 1000: MOVE.L #$00020003, D0
    0x4c3c, 0x0401, 0x0001, 0x0000,     // 1006: MULU.L #$00010000, D1:D0 (Dh=D1, Dl=D0, SZ=1 unsigned 64-bit)
    0x243c, 0x0001, 0x86a0,             // 100E: MOVE.L #100000, D2
    0x4c3c, 0x2800, 0xffff, 0xfffd,     // 1014: MULS.L #-3, D2 (Dl=D2, signed 32-bit)
    0x7601,                             // 101C: MOVEQ #1, D3
    0x283c, 0x0000, 0x0005,             // 101E: MOVE.L #5, D4 -> D3:D4 = $00000001_00000005
    0x4c7c, 0x4403, 0x0000, 0x03e8,     // 1024: DIVU.L #1000, D3:D4 (Dq=D4, Dr=D3, SZ=1 64/32)
    0x7a9c,                             // 102C: MOVEQ #-100, D5 (then ASR #1 -> -50)
    0xe285,                             // 102E: ASR.L #1, D5 -> -50
    0x4c7c, 0x5806, 0xffff, 0xfff9,     // 1030: DIVS.L #-7, D6:D5 (Dq=D5, Dr=D6, signed 32/32 w/ rem)
  ]);
  cpu.is68020 = true;

  cpu.step(); // MOVE D0
  cpu.step(); // MULU.L
  assert.equal(cpu.d[1] >>> 0, 2);
  assert.equal(cpu.d[0] >>> 0, 0x00030000);

  cpu.step(); // MOVE D2
  cpu.step(); // MULS.L
  assert.equal(cpu.d[2] | 0, -300000);

  cpu.step(); // MOVEQ #1, D3
  cpu.step(); // MOVE.L #5, D4
  cpu.step(); // DIVU.L
  // 0x100000005 = 4294967301; / 1000 = 4294967 rem 301
  assert.equal(cpu.d[4] >>> 0, 4294967);
  assert.equal(cpu.d[3] >>> 0, 301);

  cpu.step(); // MOVEQ #-100, D5
  cpu.step(); // ASR.L #1, D5
  cpu.step(); // DIVS.L
  assert.equal(cpu.d[5] | 0, 7);
  assert.equal(cpu.d[6] | 0, -1);
});

test('M68EC020 bitfield ops (BFEXTU, BFEXTS, BFINS, BFFFO) and scaled index / full extension EA', () => {
  const { cpu, bus } = setupCpu([
    0x203c, 0xf234, 0x5678,             // MOVE.L #$F2345678, D0
    0xe9c0, 0x1108,                     // BFEXTU D0{4:8}, D1 -> bits 4..11 = $23
    0xebc0, 0x2004,                     // BFEXTS D0{0:4}, D2 -> $F sign-extended = -1
    0xedc0, 0x3304,                     // BFFFO D0{12:4}, D3 -> nibble $4 at bit 12 -> 1 zero -> offset = 13
    0x41f9, 0x0000, 0x3000,             // LEA $3000, A0
    0x7802,                             // MOVEQ #2, D4
    // Scaled index: MOVE.L $04(A0, D4.L*4), D5 -> mem[$3000 + 4 + 8 = $300C]
    0x2a30, 0x4c04,                     // ext word: A/D=0(D4), W/L=1($0800), SCALE=2(x4=$0400) -> $4C04, d8=$04
    // BFINS D1, (A0){24:8} -> ext word: reg=1(D1), Do=0, off=24, Dw=0, w=8 -> (1<<12)|(24<<6)|8 = $1608
    0xefd0, 0x1608,
  ]);
  bus.write32(0x300c, 0xdeadc0de);
  bus.write32(0x3000, 0x11000000);
  bus.write32(0x3004, 0x22334455);
  cpu.is68020 = true;

  for (let i = 0; i < 8; i++) cpu.step();
  assert.equal(cpu.d[1] >>> 0, 0x23);
  assert.equal(cpu.d[2] | 0, -1);
  assert.equal(cpu.d[3] >>> 0, 13);
  assert.equal(cpu.d[5] >>> 0, 0xdeadc0de);
  // BFINS D1($23) into (A0){24:8} writes byte 3 ($3003) = $23!
  assert.equal(bus.read8(0x3003), 0x23);
  assert.equal(bus.read8(0x3000), 0x11);
});

test('M68EC020 MOVE SR privilege, BKPT #n, PACK/UNPK, CMP2/CHK2, CAS/CAS2, MOVES, and BFFFO modulo-32 offset', () => {
  // 1) Privilege violation on MOVE SR,<ea> and MOVES in User mode (only on 68020), plus BKPT #n -> Illegal (vector 4)
  {
    const { cpu, bus } = setupCpu([
      0x484a,         // 1000: BKPT #2 -> Vector 4 (Illegal)
      0x40c0,         // 1002: MOVE SR, D0 (privileged on 68020)
      0x0e50, 0x0800, // 1004: MOVES.W D0, (A0) (privileged)
    ]);
    bus.write32(0x0010, 0x00002000); // Vector 4 handler
    bus.write32(0x0020, 0x00002100); // Vector 8 handler
    bus.write16(0x2000, 0x7044); // MOVEQ #$44, D0
    bus.write16(0x2002, 0x4e73); // RTE
    bus.write16(0x2100, 0x7288); // MOVEQ #-120, D1
    bus.write16(0x2102, 0x4e73); // RTE

    cpu.is68020 = true;
    cpu.step(); // BKPT #2 -> traps to $2000
    assert.equal(cpu.pc, 0x2000);
    cpu.step(); // MOVEQ #$44, D0
    cpu.step(); // RTE returns to faulting instruction PC $1000
    assert.equal(cpu.pc, 0x1000);
    assert.equal(cpu.d[0] & 0xff, 0x44);

    // Drop to User mode (clear SR_S) and test MOVE SR, D0 at $1002
    cpu.pc = 0x1002;
    cpu.sr &= ~0x2000;
    cpu.step(); // MOVE SR, D0 -> Privilege Violation to $2100
    assert.equal(cpu.pc, 0x2100);
    cpu.step(); // MOVEQ
    cpu.step(); // RTE back to $1002
    assert.equal(cpu.pc, 0x1002);

    // MOVES in User mode also traps to Vector 8
    cpu.pc = 0x1004;
    cpu.sr &= ~0x2000;
    cpu.step();
    assert.equal(cpu.pc, 0x2100);

    // On 68000 (is68020=false), MOVE SR, D0 succeeds in User mode
    cpu.is68020 = false;
    cpu.pc = 0x1002;
    cpu.sr &= ~0x2000;
    cpu.d[0] = 0;
    cpu.step();
    assert.equal(cpu.pc, 0x1004);
  }

  // 2) PACK, UNPK, BFFFO (register offset >= 32), CMP2, CHK2, CAS, CAS2, MOVES (supervisor)
  {
    const { cpu, bus } = setupCpu([
      0x203c, 0x0000, 0x0305, // 1000: MOVE.L #$00000305, D0
      0x8340, 0x3030,         // 1006: PACK D0, D1, #$3030 -> D1 = $35
      0x8581, 0x3030,         // 100A: UNPK D1, D2, #$3030 -> D2 = $3335
      0x203c, 0x0800, 0x0000, // 100E: MOVE.L #$08000000, D0 (bit 4 in MSB -> offset 4 from MSB)
      0x7823,                 // 1014: MOVEQ #35, D4 (35 & 31 = 3 for Dn target!)
      0xedc0, 0x1908,         // 1016: BFFFO D0{D4:8}, D1 -> offset 4
      0x41f9, 0x0000, 0x3000, // 101A: LEA $3000, A0
      0x700a,                 // 1020: MOVEQ #10, D0
      0x02d0, 0x0000,         // 1022: CMP2.W (A0), D0 (bounds [10, 20] -> Z=1, C=0)
      0x7019,                 // 1026: MOVEQ #25, D0
      0x02d0, 0x0800,         // 1028: CHK2.W (A0), D0 -> traps Vector 6
    ]);
    bus.write16(0x3000, 10); // lower bound
    bus.write16(0x3002, 20); // upper bound
    bus.write32(0x0018, 0x00002200); // Vector 6 (CHK/CHK2)
    bus.write16(0x2200, 0x767f);     // MOVEQ #$7F, D3
    bus.write16(0x2202, 0x4e73);     // RTE

    cpu.is68020 = true;
    cpu.step(); // MOVE.L
    cpu.step(); // PACK
    assert.equal(cpu.d[1] & 0xff, 0x35);
    cpu.step(); // UNPK
    assert.equal(cpu.d[2] & 0xffff, 0x3335);
    cpu.step(); // MOVE.L
    cpu.step(); // MOVEQ #35, D4
    cpu.step(); // BFFFO D0{35&31=3 : 8}
    assert.equal(cpu.d[1] >>> 0, 4);

    cpu.step(); // LEA $3000, A0
    cpu.step(); // MOVEQ #10, D0
    cpu.step(); // CMP2.W
    assert.ok((cpu.sr & 0x04) !== 0, 'CMP2 bound equality sets Z');
    assert.ok((cpu.sr & 0x01) === 0, 'CMP2 in-bounds clears C');

    cpu.step(); // MOVEQ #25, D0
    cpu.step(); // CHK2.W out of bounds -> Vector 6
    assert.equal(cpu.pc, 0x2200);
    cpu.step(); // MOVEQ #$7F, D3
    assert.equal(cpu.d[3], 0x7f);

    // CAS.W, CAS2.W, and MOVES.W
    bus.write16(0x1100, 0x0cd0); // CAS.W D0, D1, (A0)
    bus.write16(0x1102, 0x0040);
    bus.write16(0x1104, 0x0cfc); // CAS2.W D0:D1, D2:D3, (A0):(A1)
    bus.write16(0x1106, 0x8080);
    bus.write16(0x1108, 0x90c1);
    bus.write16(0x110a, 0x0e50); // MOVES.W D0, (A0)
    bus.write16(0x110c, 0x0800);
    bus.write16(0x110e, 0x0e50); // MOVES.W (A0), D1
    bus.write16(0x1110, 0x1000);

    cpu.sr |= 0x2000;
    cpu.a[0] = 0x3100;
    cpu.a[1] = 0x3104;
    bus.write16(0x3100, 0x1234);
    bus.write16(0x3104, 0x5678);

    // CAS mismatch first: D0=$9999 != $1234 -> D0 gets $1234, Z=0
    cpu.pc = 0x1100;
    cpu.d[0] = 0x9999;
    cpu.d[1] = 0xabcd;
    cpu.step();
    assert.equal(cpu.d[0] & 0xffff, 0x1234);
    assert.equal(bus.read16(0x3100), 0x1234);
    assert.equal(cpu.sr & 0x04, 0);

    // CAS match: D0=$1234 == $1234 -> mem gets $ABCD, Z=1
    cpu.pc = 0x1100;
    cpu.step();
    assert.equal(bus.read16(0x3100), 0xabcd);
    assert.ok((cpu.sr & 0x04) !== 0);

    // CAS2 match: D0=$ABCD, D1=$5678 -> writes D2=$2222, D3=$3333
    cpu.d[0] = 0xabcd;
    cpu.d[1] = 0x5678;
    cpu.d[2] = 0x2222;
    cpu.d[3] = 0x3333;
    cpu.step(); // $1104 CAS2
    assert.equal(bus.read16(0x3100), 0x2222);
    assert.equal(bus.read16(0x3104), 0x3333);
    assert.ok((cpu.sr & 0x04) !== 0);

    // MOVES write then read
    cpu.d[0] = 0x7788;
    cpu.d[1] = 0;
    cpu.step(); // $110A MOVES.W D0, (A0)
    assert.equal(bus.read16(0x3100), 0x7788);
    cpu.step(); // $110E MOVES.W (A0), D1
    assert.equal(cpu.d[1] & 0xffff, 0x7788);
  }
});

test('M68EC020 CLR <ea> skips pre-read cycle unlike 68000, and ROM Supervisor traps do not evict real faults', () => {
  // 1) CLR.B (A0) read-before-write on 68000 vs write-only on 68EC020
  let eaReadCount = 0;
  const baseBus = new FlatBus();
  const spyBus: M68kBus = {
    read8: (addr) => {
      if ((addr & 0xffff) === 0x3000) eaReadCount++;
      return baseBus.read8(addr);
    },
    read16: (addr) => baseBus.read16(addr),
    read32: (addr) => baseBus.read32(addr),
    write8: (addr, val) => baseBus.write8(addr, val),
    write16: (addr, val) => baseBus.write16(addr, val),
    write32: (addr, val) => baseBus.write32(addr, val),
  };
  baseBus.write32(0x0000, 0x00008000);
  baseBus.write32(0x0004, 0x00001000);
  baseBus.write16(0x1000, 0x4210); // CLR.B (A0)
  baseBus.write16(0x1002, 0x4210); // CLR.B (A0)
  baseBus.write8(0x3000, 0xa5);

  const cpu = new M68000(spyBus);
  cpu.reset();
  cpu.a[0] = 0x3000;
  cpu.is68020 = false;
  cpu.step();
  assert.equal(eaReadCount, 1, '68000 CLR.B (A0) must perform dummy read before clearing');
  assert.equal(baseBus.read8(0x3000), 0);

  baseBus.write8(0x3000, 0x5a);
  eaReadCount = 0;
  cpu.is68020 = true;
  cpu.step();
  assert.equal(eaReadCount, 0, '68EC020 CLR.B (A0) must NOT pre-read <ea> (preserves CIA ICR flags)');
  assert.equal(baseBus.read8(0x3000), 0);

  // 2) Routine Kickstart ROM Supervisor() ($F80000+ ORI.W #$2000,SR) increments supervisorTrapCount without evicting real faults
  const trapMem = new Map<number, number>();
  const romFaultBus: M68kBus = {
    read8: (a) => trapMem.get(a & 0xffffff) ?? 0,
    read16: (a) => {
      const x = a & 0xfffffe;
      return ((trapMem.get(x) ?? 0) << 8) | (trapMem.get(x + 1) ?? 0);
    },
    read32: (a) => {
      const x = a & 0xfffffe;
      return (
        ((trapMem.get(x) ?? 0) << 24) |
        ((trapMem.get(x + 1) ?? 0) << 16) |
        ((trapMem.get(x + 2) ?? 0) << 8) |
        (trapMem.get(x + 3) ?? 0)
      );
    },
    write8: (a, v) => { trapMem.set(a & 0xffffff, v & 0xff); },
    write16: (a, v) => {
      const x = a & 0xfffffe;
      trapMem.set(x, (v >>> 8) & 0xff);
      trapMem.set(x + 1, v & 0xff);
    },
    write32: (a, v) => {
      const x = a & 0xfffffe;
      trapMem.set(x, (v >>> 24) & 0xff);
      trapMem.set(x + 1, (v >>> 16) & 0xff);
      trapMem.set(x + 2, (v >>> 8) & 0xff);
      trapMem.set(x + 3, v & 0xff);
    },
  };
  romFaultBus.write32(0x0000, 0x00008000);
  romFaultBus.write32(0x0004, 0x00001000);
  romFaultBus.write32(0x0010, 0x00002000); // Vector 4 (Illegal) -> $2000
  romFaultBus.write32(0x0020, 0x00002100); // Vector 8 (Privilege) -> $2100
  romFaultBus.write16(0x1000, 0x4afc);     // ILLEGAL at $1000
  romFaultBus.write16(0x2000, 0x46fc);     // MOVE #$0000, SR (drop to User mode)
  romFaultBus.write16(0x2002, 0x0000);
  romFaultBus.write16(0x2004, 0x4ef9);     // JMP $F80BE0
  romFaultBus.write32(0x2006, 0x00f80be0);
  romFaultBus.write16(0xf80be0, 0x007c);   // KS 3.1 Supervisor(): ORI.W #$2000, SR
  romFaultBus.write16(0xf80be2, 0x2000);
  romFaultBus.write16(0x2100, 0x0257);   // ANDI.W #$DFFF, (A7) -> return in User mode
  romFaultBus.write16(0x2102, 0xdfff);
  romFaultBus.write16(0x2104, 0x2f7c);   // MOVE.L #$2004, 2(A7)
  romFaultBus.write32(0x2106, 0x00002004);
  romFaultBus.write16(0x210a, 0x0002);
  romFaultBus.write16(0x210c, 0x4e73);   // RTE -> jumps back to $2004 in User mode

  const cpu2 = new M68000(romFaultBus);
  cpu2.is68020 = true;
  cpu2.reset();
  cpu2.step(); // ILLEGAL -> Vector 4 -> $2000
  for (let i = 0; i < 120; i++) cpu2.step();

  assert.ok(cpu2.supervisorTrapCount >= 18, `Expected >=18 ROM supervisor traps, got ${cpu2.supervisorTrapCount}`);
  const faults = cpu2.getRecentFaults();
  assert.equal(faults.length, 1, 'Routine ROM Supervisor calls must not flood or evict real faults');
  assert.equal(faults[0].vector, 4);
  assert.equal(faults[0].pc, 0x1000);
});





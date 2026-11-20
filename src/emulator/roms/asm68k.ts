/**
 * Lightweight two-pass Motorola 68000 machine-code emitter.
 * Produces real big-endian 68000 opcodes for the built-in OpenKick Boot ROM
 * and authentic AmigaDOS ADF bootblocks.
 */

interface Patch {
  offset: number;
  label: string;
  size: 16 | 32;
  relative: boolean;
  basePc: number;
}

export class Asm68k {
  private readonly buf: number[] = [];
  private readonly baseAddr: number;
  private readonly labels = new Map<string, number>();
  private readonly patches: Patch[] = [];

  constructor(baseAddr: number) {
    this.baseAddr = baseAddr;
  }

  public get pc(): number {
    return this.baseAddr + this.buf.length;
  }

  public label(name: string): this {
    this.labels.set(name, this.pc);
    return this;
  }

  public word(w: number): this {
    this.buf.push((w >>> 8) & 0xff, w & 0xff);
    return this;
  }

  public long(l: number): this {
    this.buf.push(
      (l >>> 24) & 0xff,
      (l >>> 16) & 0xff,
      (l >>> 8) & 0xff,
      l & 0xff
    );
    return this;
  }

  public padTo(targetAddr: number): this {
    while (this.pc < targetAddr) {
      this.word(0x4e71); // NOP
    }
    return this;
  }

  public nop(): this {
    return this.word(0x4e71);
  }

  public rts(): this {
    return this.word(0x4e75);
  }

  public rte(): this {
    return this.word(0x4e73);
  }

  public stop(srImm: number): this {
    return this.word(0x4e72).word(srImm & 0xffff);
  }

  public lineA(code: number): this {
    return this.word(0xa000 | (code & 0x0fff));
  }

  public moveImmToSr(srImm: number): this {
    return this.word(0x46fc).word(srImm & 0xffff);
  }

  public moveImmBToAbsL(imm8: number, addr: number): this {
    return this.word(0x13fc).word(imm8 & 0xff).long(addr);
  }

  public moveImmWToAbsL(imm16: number, addr: number): this {
    return this.word(0x33fc).word(imm16 & 0xffff).long(addr);
  }

  public moveImmLToAbsL(imm32: number, addr: number): this {
    return this.word(0x23fc).long(imm32).long(addr);
  }

  public moveLabelToAbsL(label: string, addr: number): this {
    this.word(0x23fc);
    this.patches.push({
      offset: this.buf.length,
      label,
      size: 32,
      relative: false,
      basePc: this.pc,
    });
    this.long(0);
    return this.long(addr);
  }

  public moveAbsLBToD(addr: number, dReg: number): this {
    // MOVE.B (xxx).L, Dn -> 0001 ddd 000 111 001
    return this.word(0x1039 | ((dReg & 7) << 9)).long(addr);
  }

  public moveAbsLWToD(addr: number, dReg: number): this {
    // MOVE.W (xxx).L, Dn -> 0011 ddd 000 111 001
    return this.word(0x3039 | ((dReg & 7) << 9)).long(addr);
  }

  public bclrImmAbsL(bit: number, addr: number): this {
    // BCLR #bit, (xxx).L -> 0000 1000 10 111 001
    return this.word(0x08b9).word(bit & 7).long(addr);
  }

  public bsetImmAbsL(bit: number, addr: number): this {
    // BSET #bit, (xxx).L -> 0000 1000 11 111 001
    return this.word(0x08f9).word(bit & 7).long(addr);
  }

  public addqLAbsL(imm1to8: number, addr: number): this {
    // ADDQ.L #imm, (xxx).L -> 0101 iii 0 10 111 001
    return this.word(0x50b9 | ((imm1to8 & 7) << 9)).long(addr);
  }

  public btstImmD(bit: number, dReg: number): this {
    return this.word(0x0800 | (dReg & 7)).word(bit & 31);
  }

  public bra(label: string): this {
    this.word(0x6000);
    this.patches.push({
      offset: this.buf.length,
      label,
      size: 16,
      relative: true,
      basePc: this.pc,
    });
    return this.word(0);
  }

  public beq(label: string): this {
    this.word(0x6700);
    this.patches.push({
      offset: this.buf.length,
      label,
      size: 16,
      relative: true,
      basePc: this.pc,
    });
    return this.word(0);
  }

  public bne(label: string): this {
    this.word(0x6600);
    this.patches.push({
      offset: this.buf.length,
      label,
      size: 16,
      relative: true,
      basePc: this.pc,
    });
    return this.word(0);
  }

  public movemSaveAll(): this {
    // MOVEM.L D0-D7/A0-A6, -(A7)
    return this.word(0x48e7).word(0xfffe);
  }

  public movemRestoreAll(): this {
    // MOVEM.L (A7)+, D0-D7/A0-A6
    return this.word(0x4cdf).word(0x7fff);
  }

  public build(): Uint8Array {
    const out = new Uint8Array(this.buf);
    for (const p of this.patches) {
      const target = this.labels.get(p.label);
      if (target === undefined) {
        throw new Error(`Asm68k: unresolved label "${p.label}"`);
      }
      if (p.size === 32) {
        out[p.offset] = (target >>> 24) & 0xff;
        out[p.offset + 1] = (target >>> 16) & 0xff;
        out[p.offset + 2] = (target >>> 8) & 0xff;
        out[p.offset + 3] = target & 0xff;
      } else {
        const disp = p.relative ? target - p.basePc : target;
        out[p.offset] = (disp >>> 8) & 0xff;
        out[p.offset + 1] = disp & 0xff;
      }
    }
    return out;
  }
}

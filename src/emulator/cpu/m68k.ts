/**
 * High-performance Motorola 68000 CPU Core for Amiga OCS/ECS.
 * Designed for zero heap allocations in the hot loop and minimal host CPU usage.
 */

export interface M68kBus {
  read8(addr: number): number;
  read16(addr: number): number;
  read32(addr: number): number;
  write8(addr: number, val: number): void;
  write16(addr: number, val: number): void;
  write32(addr: number, val: number): void;
  onResetInstruction?: () => void;
  onLineA?: (opcode: number, cpu: M68000) => boolean;
}

// Status Register bitmasks
export const SR_C = 0x0001;
export const SR_V = 0x0002;
export const SR_Z = 0x0004;
export const SR_N = 0x0008;
export const SR_X = 0x0010;
export const SR_IPL_MASK = 0x0700;
export const SR_S = 0x2000;
export const SR_T = 0x8000;

export class M68000 {
  public readonly d = new Int32Array(8);
  public readonly a = new Int32Array(8);
  public usp = 0;
  public ssp = 0;
  public pc = 0;
  public sr = 0x2700;
  public stopped = false;
  public pendingIpl = 0;
  public cycles = 0;

  // Motorola 68EC020 (Amiga 1200) mode & control registers
  public is68020 = false;
  public vbr = 0;
  public cacr = 0;
  public caar = 0;
  public sfc = 0;
  public dfc = 0;
  public msp = 0;

  // Scratch fields for zero-allocation EA calculation
  private eaAddr = 0;
  private instrPc = 0;
  private exceptionTaken = false;
  private bus: M68kBus;

  // Zero-allocation fault ring buffer (only written when a CPU fault vector 2..15 fires)
  private readonly faultVector = new Uint8Array(16);
  private readonly faultPc = new Uint32Array(16);
  private readonly faultOpcode = new Uint16Array(16);
  private readonly faultSr = new Uint16Array(16);
  private readonly faultSp = new Uint32Array(16);
  private readonly faultCycles = new Uint32Array(16);
  private faultWriteIdx = 0;
  public supervisorTrapCount = 0;

  constructor(bus: M68kBus) {
    this.bus = bus;
  }

  public reset(): void {
    this.d.fill(0);
    this.a.fill(0);
    this.usp = 0;
    this.vbr = 0;
    this.cacr = 0;
    this.caar = 0;
    this.sfc = 0;
    this.dfc = 0;
    this.msp = 0;
    this.sr = 0x2700; // Supervisor mode, IPL 7
    this.stopped = false;
    this.pendingIpl = 0;
    this.cycles = 0;
    this.exceptionTaken = false;
    this.faultWriteIdx = 0;
    this.supervisorTrapCount = 0;
    this.ssp = this.bus.read32(0x000000) | 0;
    this.a[7] = this.ssp;
    this.pc = this.bus.read32(0x000004) & 0x00ffffff;
  }

  public setSR(newSr: number): void {
    const oldS = (this.sr & SR_S) !== 0;
    const masked = newSr & 0xa71f;
    const newS = (masked & SR_S) !== 0;
    if (oldS !== newS) {
      if (oldS) {
        this.ssp = this.a[7];
        this.a[7] = this.usp;
      } else {
        this.usp = this.a[7];
        this.a[7] = this.ssp;
      }
    }
    this.sr = masked;
  }

  public getCCR(): number {
    return this.sr & 0x1f;
  }

  public setCCR(val: number): void {
    this.sr = (this.sr & 0xffe0) | (val & 0x1f);
  }

  private push16(val: number): void {
    const sp = (this.a[7] - 2) | 0;
    this.a[7] = sp;
    this.bus.write16(sp & 0x00ffffff, val & 0xffff);
  }

  private push32(val: number): void {
    const sp = (this.a[7] - 4) | 0;
    this.a[7] = sp;
    this.bus.write32(sp & 0x00ffffff, val | 0);
  }

  private pop16(): number {
    const sp = this.a[7];
    this.a[7] = (sp + 2) | 0;
    return this.bus.read16(sp & 0x00ffffff);
  }

  private pop32(): number {
    const sp = this.a[7];
    this.a[7] = (sp + 4) | 0;
    return this.bus.read32(sp & 0x00ffffff) | 0;
  }

  private fetch16(): number {
    const v = this.bus.read16(this.pc);
    this.pc = (this.pc + 2) & 0x00ffffff;
    return v;
  }

  private fetch16s(): number {
    const v = this.fetch16();
    return (v << 16) >> 16;
  }

  private fetch32(): number {
    const v = this.bus.read32(this.pc);
    this.pc = (this.pc + 4) & 0x00ffffff;
    return v | 0;
  }

  public triggerException(vector: number, newIpl = -1): void {
    // Aborted instructions (Illegal, Privilege, Line-A, Line-F) do not generate a Trace exception.
    // Group 2 exceptions (TRAP, TRAPV, CHK, DIV0) still take Trace before the handler's first instruction.
    if (vector === 4 || vector === 8 || vector === 10 || vector === 11) {
      this.exceptionTaken = true;
    }
    const oldSr = this.sr;
    if (vector >= 2 && vector <= 15 && vector !== 9) {
      const opcode = this.bus.read16(this.instrPc) & 0xffff;
      if (vector === 8 && (this.instrPc >>> 0) >= 0xf80000 && opcode === 0x007c) {
        // Routine Kickstart Exec Supervisor() call (ORI.W #$2000,SR) — keep ring buffer clean for real faults
        this.supervisorTrapCount++;
      } else {
        const idx = this.faultWriteIdx & 15;
        this.faultVector[idx] = vector;
        this.faultPc[idx] = this.instrPc >>> 0;
        this.faultOpcode[idx] = opcode;
        this.faultSr[idx] = oldSr & 0xffff;
        this.faultSp[idx] = this.a[7] >>> 0;
        this.faultCycles[idx] = this.cycles >>> 0;
        this.faultWriteIdx++;
      }
    }
    if ((this.sr & SR_S) === 0) {
      this.usp = this.a[7];
      this.a[7] = this.ssp;
    }
    let nextSr = (this.sr | SR_S) & ~SR_T;
    if (newIpl >= 0) {
      nextSr = (nextSr & ~SR_IPL_MASK) | ((newIpl & 7) << 8);
    }
    this.sr = nextSr;
    this.stopped = false;
    // On Motorola 68000, Illegal Instruction (4), Privilege Violation (8),
    // Line-A (10), and Line-F (11) push the PC of the faulting instruction itself.
    const pushedPc =
      vector === 4 || vector === 8 || vector === 10 || vector === 11
        ? this.instrPc
        : this.pc;
    if (this.is68020) {
      // 68010/68EC020 Format $0 stack frame word (vector offset in bits 11..0)
      this.push16((vector << 2) & 0x0fff);
    }
    this.push32(pushedPc);
    this.push16(oldSr);
    const vecAddr = ((this.is68020 ? this.vbr : 0) + (vector << 2)) & 0x00ffffff;
    this.pc = this.bus.read32(vecAddr) & 0x00ffffff;
    this.cycles += 34;
  }

  public getRecentFaults(): Array<{
    vector: number;
    pc: number;
    opcode: number;
    sr: number;
    sp: number;
    cycles: number;
  }> {
    const total = Math.min(this.faultWriteIdx, 16);
    const out: Array<{
      vector: number;
      pc: number;
      opcode: number;
      sr: number;
      sp: number;
      cycles: number;
    }> = [];
    const start = this.faultWriteIdx - total;
    for (let i = 0; i < total; i++) {
      const idx = (start + i) & 15;
      out.push({
        vector: this.faultVector[idx],
        pc: this.faultPc[idx],
        opcode: this.faultOpcode[idx],
        sr: this.faultSr[idx],
        sp: this.faultSp[idx],
        cycles: this.faultCycles[idx],
      });
    }
    return out;
  }

  private checkInterrupts(): boolean {
    const ipl = this.pendingIpl;
    if (ipl === 0) return false;
    const mask = (this.sr >>> 8) & 7;
    if (ipl === 7 || ipl > mask) {
      this.triggerException(24 + ipl, ipl);
      return true;
    }
    return false;
  }

  public testCondition(cc: number): boolean {
    const sr = this.sr;
    switch (cc & 0xf) {
      case 0x0: return true; // T
      case 0x1: return false; // F
      case 0x2: return (sr & (SR_C | SR_Z)) === 0; // HI
      case 0x3: return (sr & (SR_C | SR_Z)) !== 0; // LS
      case 0x4: return (sr & SR_C) === 0; // CC
      case 0x5: return (sr & SR_C) !== 0; // CS
      case 0x6: return (sr & SR_Z) === 0; // NE
      case 0x7: return (sr & SR_Z) !== 0; // EQ
      case 0x8: return (sr & SR_V) === 0; // VC
      case 0x9: return (sr & SR_V) !== 0; // VS
      case 0xa: return (sr & SR_N) === 0; // PL
      case 0xb: return (sr & SR_N) !== 0; // MI
      case 0xc: return ((sr & SR_N) !== 0) === ((sr & SR_V) !== 0); // GE
      case 0xd: return ((sr & SR_N) !== 0) !== ((sr & SR_V) !== 0); // LT
      case 0xe: return (sr & SR_Z) === 0 && (((sr & SR_N) !== 0) === ((sr & SR_V) !== 0)); // GT
      case 0xf: return (sr & SR_Z) !== 0 || (((sr & SR_N) !== 0) !== ((sr & SR_V) !== 0)); // LE
      default: return false;
    }
  }

  private calcIndexExt(base: number): number {
    const ext = this.fetch16();
    if (this.is68020 && (ext & 0x0100) !== 0) {
      return this.calcFullIndexExt(base, ext);
    }
    const regIdx = (ext >>> 12) & 7;
    const isAddr = (ext & 0x8000) !== 0;
    const isLong = (ext & 0x0800) !== 0;
    const disp = (ext << 24) >> 24;
    let idxVal = isAddr ? this.a[regIdx] : this.d[regIdx];
    if (!isLong) {
      idxVal = (idxVal << 16) >> 16;
    }
    if (this.is68020) {
      const scale = (ext >>> 9) & 3;
      if (scale !== 0) idxVal = (idxVal << scale) | 0;
    }
    return (base + disp + idxVal) | 0;
  }

  private calcFullIndexExt(base: number, ext: number): number {
    const bs = (ext & 0x0080) !== 0;
    const is = (ext & 0x0040) !== 0;
    const bdSize = (ext >>> 4) & 3;
    const iis = ext & 7;

    let bd = 0;
    if (bdSize === 2) bd = this.fetch16s();
    else if (bdSize === 3) bd = this.fetch32();

    let ea = ((bs ? 0 : base) + bd) | 0;
    let idxVal = 0;
    if (!is) {
      const regIdx = (ext >>> 12) & 7;
      idxVal = (ext & 0x8000) !== 0 ? this.a[regIdx] : this.d[regIdx];
      if ((ext & 0x0800) === 0) {
        idxVal = (idxVal << 16) >> 16;
      }
      const scale = (ext >>> 9) & 3;
      if (scale !== 0) idxVal = (idxVal << scale) | 0;
    }

    if (iis === 0) {
      return (ea + idxVal) | 0;
    }

    const postIndexed = (iis & 4) !== 0;
    const ptrAddr = postIndexed ? ea : ((ea + idxVal) | 0);
    let indirect = this.bus.read32(ptrAddr) | 0;
    const odSize = iis & 3;
    let od = 0;
    if (odSize === 2) od = this.fetch16s();
    else if (odSize === 3) od = this.fetch32();
    if (postIndexed) {
      indirect = (indirect + idxVal) | 0;
    }
    return (indirect + od) | 0;
  }

  /**
   * Computes memory effective address into this.eaAddr (modes 2..7).
   * Preserves full 32-bit values for LEA/PEA arithmetic; bus accesses mask 24-bit in AmigaMemory.
   * Size is 1, 2, or 4 (used for postinc/predec).
   */
  private resolveEaAddr(mode: number, reg: number, size: number): number {
    switch (mode) {
      case 2: // (An)
        return this.a[reg] | 0;
      case 3: { // (An)+
        const addr = this.a[reg] | 0;
        const step = size === 1 && reg === 7 ? 2 : size;
        this.a[reg] = (this.a[reg] + step) | 0;
        return addr;
      }
      case 4: { // -(An)
        const step = size === 1 && reg === 7 ? 2 : size;
        const addr = (this.a[reg] - step) | 0;
        this.a[reg] = addr;
        return addr;
      }
      case 5: // d16(An)
        return (this.a[reg] + this.fetch16s()) | 0;
      case 6: // d8(An,Xn)
        return this.calcIndexExt(this.a[reg]);
      case 7:
        switch (reg) {
          case 0: // (xxx).W
            return this.fetch16s() | 0;
          case 1: // (xxx).L
            return this.fetch32() | 0;
          case 2: { // d16(PC)
            const base = this.pc;
            return (base + this.fetch16s()) | 0;
          }
          case 3: { // d8(PC,Xn)
            const base = this.pc;
            return this.calcIndexExt(base);
          }
          default:
            return 0;
        }
      default:
        return 0;
    }
  }

  private readEa(mode: number, reg: number, size: number, saveAddr: boolean): number {
    if (mode === 0) {
      const v = this.d[reg];
      return size === 1 ? v & 0xff : size === 2 ? v & 0xffff : v | 0;
    }
    if (mode === 1) {
      const v = this.a[reg];
      return size === 1 ? v & 0xff : size === 2 ? v & 0xffff : v | 0;
    }
    if (mode === 7 && reg === 4) {
      if (size === 1) return this.fetch16() & 0xff;
      if (size === 2) return this.fetch16() & 0xffff;
      return this.fetch32() | 0;
    }
    const addr = this.resolveEaAddr(mode, reg, size);
    if (saveAddr) this.eaAddr = addr;
    if (size === 1) return this.bus.read8(addr);
    if (size === 2) return this.bus.read16(addr);
    return this.bus.read32(addr) | 0;
  }

  private writeEa(mode: number, reg: number, size: number, val: number): void {
    if (mode === 0) {
      if (size === 1) this.d[reg] = (this.d[reg] & 0xffffff00) | (val & 0xff);
      else if (size === 2) this.d[reg] = (this.d[reg] & 0xffff0000) | (val & 0xffff);
      else this.d[reg] = val | 0;
      return;
    }
    if (mode === 1) {
      if (size === 2) this.a[reg] = (val << 16) >> 16;
      else this.a[reg] = val | 0;
      return;
    }
    const addr = this.resolveEaAddr(mode, reg, size);
    if (size === 1) this.bus.write8(addr, val & 0xff);
    else if (size === 2) this.bus.write16(addr, val & 0xffff);
    else this.bus.write32(addr, val | 0);
  }

  private writeSavedEa(mode: number, reg: number, size: number, val: number): void {
    if (mode === 0) {
      if (size === 1) this.d[reg] = (this.d[reg] & 0xffffff00) | (val & 0xff);
      else if (size === 2) this.d[reg] = (this.d[reg] & 0xffff0000) | (val & 0xffff);
      else this.d[reg] = val | 0;
      return;
    }
    if (mode === 1) {
      if (size === 2) this.a[reg] = (val << 16) >> 16;
      else this.a[reg] = val | 0;
      return;
    }
    if (size === 1) this.bus.write8(this.eaAddr, val & 0xff);
    else if (size === 2) this.bus.write16(this.eaAddr, val & 0xffff);
    else this.bus.write32(this.eaAddr, val | 0);
  }

  private setLogicFlags(val: number, size: number): void {
    let f = this.sr & ~0x0f; // Keep X, clear N Z V C
    if (size === 1) {
      const b = val & 0xff;
      if (b === 0) f |= SR_Z;
      if (b & 0x80) f |= SR_N;
    } else if (size === 2) {
      const w = val & 0xffff;
      if (w === 0) f |= SR_Z;
      if (w & 0x8000) f |= SR_N;
    } else {
      const l = val | 0;
      if (l === 0) f |= SR_Z;
      if (l < 0) f |= SR_N;
    }
    this.sr = f;
  }

  private addVal(src: number, dst: number, size: number, withX: boolean): number {
    const x = withX && (this.sr & SR_X) !== 0 ? 1 : 0;
    let res = 0;
    let c = false;
    let v = false;
    let n = false;
    let z = false;

    if (size === 1) {
      const s = src & 0xff;
      const d = dst & 0xff;
      const sum = s + d + x;
      res = sum & 0xff;
      c = sum > 0xff;
      v = (((s ^ res) & (d ^ res)) & 0x80) !== 0;
      n = (res & 0x80) !== 0;
      z = res === 0;
    } else if (size === 2) {
      const s = src & 0xffff;
      const d = dst & 0xffff;
      const sum = s + d + x;
      res = sum & 0xffff;
      c = sum > 0xffff;
      v = (((s ^ res) & (d ^ res)) & 0x8000) !== 0;
      n = (res & 0x8000) !== 0;
      z = res === 0;
    } else {
      const su = src >>> 0;
      const du = dst >>> 0;
      const sum = su + du + x;
      res = sum | 0;
      c = sum > 0xffffffff;
      v = (((src ^ res) & (dst ^ res)) & 0x80000000) !== 0;
      n = res < 0;
      z = res === 0;
    }

    let f = this.sr & ~0x1f;
    if (c) f |= SR_C | SR_X;
    if (v) f |= SR_V;
    if (n) f |= SR_N;
    if (withX) {
      if (z && (this.sr & SR_Z) !== 0) f |= SR_Z;
    } else if (z) {
      f |= SR_Z;
    }
    this.sr = f;
    return res;
  }

  private subVal(src: number, dst: number, size: number, withX: boolean, isCmp: boolean): number {
    const x = withX && (this.sr & SR_X) !== 0 ? 1 : 0;
    let res = 0;
    let c = false;
    let v = false;
    let n = false;
    let z = false;

    if (size === 1) {
      const s = src & 0xff;
      const d = dst & 0xff;
      const diff = d - s - x;
      res = diff & 0xff;
      c = diff < 0;
      v = (((d ^ s) & (d ^ res)) & 0x80) !== 0;
      n = (res & 0x80) !== 0;
      z = res === 0;
    } else if (size === 2) {
      const s = src & 0xffff;
      const d = dst & 0xffff;
      const diff = d - s - x;
      res = diff & 0xffff;
      c = diff < 0;
      v = (((d ^ s) & (d ^ res)) & 0x8000) !== 0;
      n = (res & 0x8000) !== 0;
      z = res === 0;
    } else {
      const su = src >>> 0;
      const du = dst >>> 0;
      const diff = du - su - x;
      res = diff | 0;
      c = diff < 0;
      v = (((dst ^ src) & (dst ^ res)) & 0x80000000) !== 0;
      n = res < 0;
      z = res === 0;
    }

    let f = isCmp ? (this.sr & ~0x0f) : (this.sr & ~0x1f);
    if (c) f |= isCmp ? SR_C : (SR_C | SR_X);
    if (v) f |= SR_V;
    if (n) f |= SR_N;
    if (withX) {
      if (z && (this.sr & SR_Z) !== 0) f |= SR_Z;
    } else if (z) {
      f |= SR_Z;
    }
    this.sr = f;
    return res;
  }

  private sizeFromBits(bits: number): number {
    return bits === 0 ? 1 : bits === 1 ? 2 : 4;
  }

  private signExtend(val: number, size: number): number {
    if (size === 1) return (val << 24) >> 24;
    if (size === 2) return (val << 16) >> 16;
    return val | 0;
  }

  /**
   * Executes CPU instructions until at least `targetCycles` have elapsed.
   * Returns actual cycles consumed.
   */
  public runCycles(targetCycles: number): number {
    const startCycles = this.cycles;
    const endCycles = startCycles + targetCycles;

    while (this.cycles < endCycles) {
      if (this.pendingIpl !== 0 && this.checkInterrupts()) {
        continue;
      }
      if (this.stopped) {
        this.cycles = endCycles;
        break;
      }
      this.step();
    }
    return this.cycles - startCycles;
  }

  public step(): number {
    const startC = this.cycles;
    if (this.pendingIpl !== 0 && this.checkInterrupts()) {
      return this.cycles - startC;
    }
    if (this.stopped) {
      this.cycles += 4;
      return 4;
    }

    const traceBefore = (this.sr & SR_T) !== 0;
    if (traceBefore) {
      this.exceptionTaken = false;
    }

    this.instrPc = this.pc;
    const op = this.fetch16();
    const group = op >>> 12;

    switch (group) {
      case 0x0:
        this.execLine0(op);
        break;
      case 0x1: // MOVE.B
        this.execMove(op, 1);
        break;
      case 0x2: // MOVE.L / MOVEA.L
        this.execMove(op, 4);
        break;
      case 0x3: // MOVE.W / MOVEA.W
        this.execMove(op, 2);
        break;
      case 0x4:
        this.execLine4(op);
        break;
      case 0x5:
        this.execLine5(op);
        break;
      case 0x6:
        this.execLine6(op);
        break;
      case 0x7: { // MOVEQ
        const reg = (op >>> 9) & 7;
        const imm = (op << 24) >> 24;
        this.d[reg] = imm;
        this.setLogicFlags(imm, 4);
        this.cycles += 4;
        break;
      }
      case 0x8:
        this.execLine8(op);
        break;
      case 0x9:
        this.execLine9(op);
        break;
      case 0xa:
        if (!this.bus.onLineA || !this.bus.onLineA(op, this)) {
          this.triggerException(10);
        } else {
          this.cycles += 8;
        }
        break;
      case 0xb:
        this.execLineB(op);
        break;
      case 0xc:
        this.execLineC(op);
        break;
      case 0xd:
        this.execLineD(op);
        break;
      case 0xe:
        this.execLineE(op);
        break;
      case 0xf:
        this.triggerException(11);
        break;
    }

    if (traceBefore && !this.exceptionTaken) {
      this.triggerException(9);
    }

    return this.cycles - startC;
  }

  private execMove(op: number, size: number): void {
    const srcMode = (op >>> 3) & 7;
    const srcReg = op & 7;
    const dstMode = (op >>> 6) & 7;
    const dstReg = (op >>> 9) & 7;

    const val = this.readEa(srcMode, srcReg, size, false);
    if (dstMode === 1) {
      // MOVEA: no flag updates, word sign-extended to 32-bit
      this.a[dstReg] = size === 2 ? ((val << 16) >> 16) : (val | 0);
    } else {
      this.writeEa(dstMode, dstReg, size, val);
      this.setLogicFlags(val, size);
    }
    this.cycles += (srcMode >= 2 ? 4 : 0) + (dstMode >= 2 ? 4 : 0) + 4;
  }

  private execLine0(op: number): void {
    const mode = (op >>> 3) & 7;
    const reg = op & 7;

    // MOVEP: bits 8=1 and mode=1
    if ((op & 0x0138) === 0x0108) {
      const dReg = (op >>> 9) & 7;
      const opmode = (op >>> 6) & 7;
      const addr = (this.a[reg] + this.fetch16s()) & 0x00ffffff;
      if (opmode === 4) { // MOVEP.W d(An), Dn
        const hi = this.bus.read8(addr);
        const lo = this.bus.read8((addr + 2) & 0x00ffffff);
        this.d[dReg] = (this.d[dReg] & 0xffff0000) | (hi << 8) | lo;
        this.cycles += 16;
      } else if (opmode === 5) { // MOVEP.L d(An), Dn
        const b3 = this.bus.read8(addr);
        const b2 = this.bus.read8((addr + 2) & 0x00ffffff);
        const b1 = this.bus.read8((addr + 4) & 0x00ffffff);
        const b0 = this.bus.read8((addr + 6) & 0x00ffffff);
        this.d[dReg] = (b3 << 24) | (b2 << 16) | (b1 << 8) | b0;
        this.cycles += 24;
      } else if (opmode === 6) { // MOVEP.W Dn, d(An)
        const v = this.d[dReg];
        this.bus.write8(addr, (v >>> 8) & 0xff);
        this.bus.write8((addr + 2) & 0x00ffffff, v & 0xff);
        this.cycles += 16;
      } else if (opmode === 7) { // MOVEP.L Dn, d(An)
        const v = this.d[dReg];
        this.bus.write8(addr, (v >>> 24) & 0xff);
        this.bus.write8((addr + 2) & 0x00ffffff, (v >>> 16) & 0xff);
        this.bus.write8((addr + 4) & 0x00ffffff, (v >>> 8) & 0xff);
        this.bus.write8((addr + 6) & 0x00ffffff, v & 0xff);
        this.cycles += 24;
      }
      return;
    }

    // Dynamic bit operations (BTST/BCHG/BCLR/BSET Dn, <ea>)
    if ((op & 0x0100) !== 0) {
      const bitNum = this.d[(op >>> 9) & 7];
      this.execBitOp((op >>> 6) & 3, bitNum, mode, reg);
      return;
    }

    // Static bit operations (#imm)
    if ((op & 0x0f00) === 0x0800) {
      const bitNum = this.fetch16() & 0xff;
      this.execBitOp((op >>> 6) & 3, bitNum, mode, reg);
      return;
    }

    // Immediate ALU / 68020 CMP2, CHK2, CAS, CAS2, MOVES
    const subOp = (op >>> 9) & 7;
    const sizeBits = (op >>> 6) & 3;
    if (sizeBits === 3) {
      if (this.is68020) {
        if (subOp <= 2) {
          this.execCmp2Chk2020(subOp, mode, reg);
          return;
        }
        if (subOp >= 5) {
          if (mode === 7 && reg === 4 && (subOp === 6 || subOp === 7)) {
            this.execCas2020(subOp === 7 ? 4 : 2);
            return;
          }
          if (mode >= 2 && !(mode === 7 && reg === 4)) {
            this.execCas020(subOp === 5 ? 1 : subOp === 6 ? 2 : 4, mode, reg);
            return;
          }
        }
      }
      this.triggerException(4);
      return;
    }
    if (subOp === 7) {
      if (this.is68020) {
        if ((this.sr & SR_S) === 0) {
          this.triggerException(8);
          return;
        }
        this.execMoves020(this.sizeFromBits(sizeBits), mode, reg);
        return;
      }
      this.triggerException(4);
      return;
    }
    if (subOp === 4) {
      this.triggerException(4);
      return;
    }
    const size = this.sizeFromBits(sizeBits);

    // Special CCR / SR targets (mode=7, reg=4)
    if (mode === 7 && reg === 4 && (subOp === 0 || subOp === 1 || subOp === 5)) {
      if (sizeBits === 1 && (this.sr & SR_S) === 0) {
        this.triggerException(8);
        return;
      }
      const imm = this.fetch16();
      if (sizeBits === 0) { // to CCR
        const ccr = this.getCCR();
        if (subOp === 0) this.setCCR(ccr | imm);
        else if (subOp === 1) this.setCCR(ccr & imm);
        else this.setCCR(ccr ^ imm);
        this.cycles += 20;
      } else if (sizeBits === 1) { // to SR (privileged)
        if (subOp === 0) this.setSR(this.sr | imm);
        else if (subOp === 1) this.setSR(this.sr & imm);
        else this.setSR(this.sr ^ imm);
        this.cycles += 20;
      }
      return;
    }

    const imm = size === 1 ? (this.fetch16() & 0xff) : size === 2 ? this.fetch16() : this.fetch32();
    const dst = this.readEa(mode, reg, size, true);
    let res = 0;

    switch (subOp) {
      case 0: // ORI
        res = dst | imm;
        this.writeSavedEa(mode, reg, size, res);
        this.setLogicFlags(res, size);
        break;
      case 1: // ANDI
        res = dst & imm;
        this.writeSavedEa(mode, reg, size, res);
        this.setLogicFlags(res, size);
        break;
      case 2: // SUBI
        res = this.subVal(imm, dst, size, false, false);
        this.writeSavedEa(mode, reg, size, res);
        break;
      case 3: // ADDI
        res = this.addVal(imm, dst, size, false);
        this.writeSavedEa(mode, reg, size, res);
        break;
      case 5: // EORI
        res = dst ^ imm;
        this.writeSavedEa(mode, reg, size, res);
        this.setLogicFlags(res, size);
        break;
      case 6: // CMPI
        this.subVal(imm, dst, size, false, true);
        break;
      default:
        this.triggerException(4);
        return;
    }
    this.cycles += size === 4 ? 16 : 8;
  }

  private execBitOp(kind: number, rawBit: number, mode: number, reg: number): void {
    const isDn = mode === 0;
    const size = isDn ? 4 : 1;
    const bit = isDn ? (rawBit & 31) : (rawBit & 7);
    const mask = 1 << bit;
    const val = this.readEa(mode, reg, size, true);

    if ((val & mask) === 0) {
      this.sr |= SR_Z;
    } else {
      this.sr &= ~SR_Z;
    }

    if (kind === 1) { // BCHG
      this.writeSavedEa(mode, reg, size, val ^ mask);
    } else if (kind === 2) { // BCLR
      this.writeSavedEa(mode, reg, size, val & ~mask);
    } else if (kind === 3) { // BSET
      this.writeSavedEa(mode, reg, size, val | mask);
    }
    this.cycles += isDn ? 8 : 12;
  }

  private execLine4(op: number): void {
    const mode = (op >>> 3) & 7;
    const reg = op & 7;

    // 68EC020: EXTB.L Dn ($49C0-$49C7) MUST be checked before LEA ($41C0.. mask & 0x01c0)
    if (this.is68020 && (op & 0xfff8) === 0x49c0) {
      const res = (this.d[reg] << 24) >> 24;
      this.d[reg] = res;
      this.setLogicFlags(res, 4);
      this.cycles += 4;
      return;
    }

    // LEA <ea>, An
    if ((op & 0x01c0) === 0x01c0) {
      const dstAn = (op >>> 9) & 7;
      this.a[dstAn] = this.resolveEaAddr(mode, reg, 4);
      this.cycles += 8;
      return;
    }

    // CHK.W <ea>, Dn (and 68020 CHK.L <ea>, Dn)
    if ((op & 0x01c0) === 0x0180 || (this.is68020 && (op & 0x01c0) === 0x0100)) {
      const isLong = (op & 0x01c0) === 0x0100;
      const dn = isLong ? (this.d[(op >>> 9) & 7] | 0) : ((this.d[(op >>> 9) & 7] << 16) >> 16);
      const bound = isLong
        ? (this.readEa(mode, reg, 4, false) | 0)
        : ((this.readEa(mode, reg, 2, false) << 16) >> 16);
      this.cycles += 10;
      if (dn < 0) {
        this.sr |= SR_N;
        this.triggerException(6);
      } else if (dn > bound) {
        this.sr &= ~SR_N;
        this.triggerException(6);
      }
      return;
    }

    // Single-operand / special control group
    switch (op & 0xff00) {
      case 0x4000: { // NEGX / MOVE from SR
        const szBits = (op >>> 6) & 3;
        if (szBits === 3) { // MOVE SR, <ea> (privileged on 68010/68EC020)
          if (this.is68020 && (this.sr & SR_S) === 0) {
            this.triggerException(8);
            return;
          }
          this.writeEa(mode, reg, 2, this.sr);
          this.cycles += 6;
        } else {
          const sz = this.sizeFromBits(szBits);
          const v = this.readEa(mode, reg, sz, true);
          const res = this.subVal(v, 0, sz, true, false);
          this.writeSavedEa(mode, reg, sz, res);
          this.cycles += 6;
        }
        return;
      }
      case 0x4200: { // CLR (szBits=3 is MOVE CCR,<ea> on 68010+, illegal on 68000)
        const szBits = (op >>> 6) & 3;
        if (szBits === 3) {
          if (this.is68020) {
            this.writeEa(mode, reg, 2, this.getCCR());
            this.cycles += 6;
          } else {
            this.triggerException(4);
          }
          return;
        }
        const sz = this.sizeFromBits(szBits);
        if (!this.is68020 && mode >= 2) {
          // 68000 reads before writing zero; 68010/68EC020 performs a single write-only cycle
          this.readEa(mode, reg, sz, true);
          this.writeSavedEa(mode, reg, sz, 0);
        } else {
          this.writeEa(mode, reg, sz, 0);
        }
        this.sr = (this.sr & ~0x0f) | SR_Z;
        this.cycles += 6;
        return;
      }
      case 0x4400: { // NEG / MOVE to CCR
        const szBits = (op >>> 6) & 3;
        if (szBits === 3) { // MOVE <ea>, CCR
          const v = this.readEa(mode, reg, 2, false);
          this.setCCR(v);
          this.cycles += 12;
        } else {
          const sz = this.sizeFromBits(szBits);
          const v = this.readEa(mode, reg, sz, true);
          const res = this.subVal(v, 0, sz, false, false);
          this.writeSavedEa(mode, reg, sz, res);
          this.cycles += 6;
        }
        return;
      }
      case 0x4600: { // NOT / MOVE to SR
        const szBits = (op >>> 6) & 3;
        if (szBits === 3) { // MOVE <ea>, SR (privileged)
          if ((this.sr & SR_S) === 0) {
            this.triggerException(8);
            return;
          }
          const v = this.readEa(mode, reg, 2, false);
          this.setSR(v);
          this.cycles += 12;
        } else {
          const sz = this.sizeFromBits(szBits);
          const v = this.readEa(mode, reg, sz, true);
          const res = ~v;
          this.writeSavedEa(mode, reg, sz, res);
          this.setLogicFlags(res, sz);
          this.cycles += 6;
        }
        return;
      }
      case 0x4800: { // NBCD / LINK.L / SWAP / PEA / EXT / MOVEM reg->mem
        const sub = (op >>> 6) & 3;
        if (sub === 0) {
          if (this.is68020 && mode === 1) { // LINK.L An, #d32
            const disp = this.fetch32();
            this.push32(this.a[reg]);
            this.a[reg] = this.a[7];
            this.a[7] = (this.a[7] + disp) | 0;
            this.cycles += 20;
            return;
          }
          // NBCD
          const v = this.readEa(mode, reg, 1, true);
          const x = (this.sr & SR_X) ? 1 : 0;
          let lo = -(v & 0x0f) - x;
          let borrow = 0;
          if (lo < 0) { lo += 10; borrow = 1; }
          let hi = -((v >>> 4) & 0x0f) - borrow;
          let c = false;
          if (hi < 0) { hi += 10; c = true; }
          const res = ((hi & 0x0f) << 4) | (lo & 0x0f);
          this.writeSavedEa(mode, reg, 1, res);
          let f = this.sr & ~(SR_C | SR_X);
          if (c) f |= SR_C | SR_X;
          if (res !== 0) f &= ~SR_Z;
          this.sr = f;
          this.cycles += 8;
        } else if (sub === 1) {
          if (mode === 0) { // SWAP Dn
            const v = this.d[reg];
            const res = ((v & 0xffff) << 16) | ((v >>> 16) & 0xffff);
            this.d[reg] = res;
            this.setLogicFlags(res, 4);
            this.cycles += 4;
          } else if (mode === 1) { // BKPT #n ($4848-$484F)
            this.triggerException(4);
            return;
          } else { // PEA <ea>
            const addr = this.resolveEaAddr(mode, reg, 4);
            this.push32(addr);
            this.cycles += 12;
          }
        } else if (mode === 0) { // EXT.W / EXT.L
          if (sub === 2) {
            const w = ((this.d[reg] << 24) >> 24) & 0xffff;
            this.d[reg] = (this.d[reg] & 0xffff0000) | w;
            this.setLogicFlags(w, 2);
          } else {
            const l = (this.d[reg] << 16) >> 16;
            this.d[reg] = l;
            this.setLogicFlags(l, 4);
          }
          this.cycles += 4;
        } else { // MOVEM reg -> mem
          this.execMovemToMem(mode, reg, sub === 3 ? 4 : 2);
        }
        return;
      }
      case 0x4a00: { // TST / TAS / ILLEGAL
        if (op === 0x4afc) {
          this.triggerException(4);
          return;
        }
        const szBits = (op >>> 6) & 3;
        if (szBits === 3) { // TAS
          const v = this.readEa(mode, reg, 1, true);
          this.setLogicFlags(v, 1);
          this.writeSavedEa(mode, reg, 1, v | 0x80);
          this.cycles += 14;
        } else {
          const sz = this.sizeFromBits(szBits);
          const v = this.readEa(mode, reg, sz, false);
          this.setLogicFlags(v, sz);
          this.cycles += 4;
        }
        return;
      }
      case 0x4c00: { // MULU.L / MULS.L / DIVU.L / DIVS.L (68020+) or MOVEM mem -> reg
        if ((op & 0x0080) === 0) {
          if (!this.is68020) {
            this.triggerException(4);
            return;
          }
          if ((op & 0x0040) === 0) {
            this.execMulLong020(mode, reg);
          } else {
            this.execDivLong020(mode, reg);
          }
          return;
        }
        const sz = ((op >>> 6) & 1) ? 4 : 2;
        this.execMovemFromMem(mode, reg, sz);
        return;
      }
      case 0x4e00: { // TRAP, LINK, UNLK, MOVE USP, RESET, NOP, STOP, RTE, RTD, RTS, TRAPV, RTR, MOVEC, JSR, JMP
        const sub = op & 0x00ff;
        if (sub >= 0x80 && sub <= 0xbf) { // JSR <ea>
          const target = this.resolveEaAddr(mode, reg, 4) & 0x00ffffff;
          this.push32(this.pc);
          this.pc = target;
          this.cycles += 16;
          return;
        }
        if (sub >= 0xc0) { // JMP <ea>
          this.pc = this.resolveEaAddr(mode, reg, 4) & 0x00ffffff;
          this.cycles += 8;
          return;
        }
        if ((sub & 0xf0) === 0x40) { // TRAP #n
          this.triggerException(32 + (sub & 0xf));
          return;
        }
        if ((sub & 0xf8) === 0x50) { // LINK An, #d16
          const disp = this.fetch16s();
          this.push32(this.a[reg]);
          this.a[reg] = this.a[7];
          this.a[7] = (this.a[7] + disp) | 0;
          this.cycles += 16;
          return;
        }
        if ((sub & 0xf8) === 0x58) { // UNLK An
          this.a[7] = this.a[reg];
          this.a[reg] = this.pop32();
          this.cycles += 12;
          return;
        }
        if ((sub & 0xf0) === 0x60) { // MOVE USP
          if ((this.sr & SR_S) === 0) {
            this.triggerException(8);
            return;
          }
          if (sub & 8) this.a[reg] = this.usp;
          else this.usp = this.a[reg];
          this.cycles += 4;
          return;
        }
        switch (sub) {
          case 0x70: // RESET
            if ((this.sr & SR_S) === 0) { this.triggerException(8); return; }
            if (this.bus.onResetInstruction) this.bus.onResetInstruction();
            this.cycles += 132;
            return;
          case 0x71: // NOP
            this.cycles += 4;
            return;
          case 0x72: { // STOP #imm
            if ((this.sr & SR_S) === 0) { this.triggerException(8); return; }
            const imm = this.fetch16();
            this.setSR(imm);
            this.stopped = true;
            this.cycles += 4;
            return;
          }
          case 0x73: { // RTE
            if ((this.sr & SR_S) === 0) { this.triggerException(8); return; }
            const newSr = this.pop16();
            const newPc = this.pop32() & 0x00ffffff;
            if (this.is68020) {
              const fmt = this.pop16();
              const fmtType = (fmt >>> 12) & 0xf;
              if (fmtType === 2) {
                this.a[7] = (this.a[7] + 4) | 0;
              } else if (fmtType === 0xa) {
                this.a[7] = (this.a[7] + 24) | 0;
              } else if (fmtType === 0xb) {
                this.a[7] = (this.a[7] + 84) | 0;
              }
            }
            this.setSR(newSr);
            this.pc = newPc;
            this.cycles += 20;
            return;
          }
          case 0x74: // RTD #d16 (68010+)
            if (!this.is68020) {
              this.triggerException(4);
              return;
            }
            {
              const disp = this.fetch16s();
              this.pc = this.pop32() & 0x00ffffff;
              this.a[7] = (this.a[7] + disp) | 0;
              this.cycles += 16;
            }
            return;
          case 0x75: // RTS
            this.pc = this.pop32() & 0x00ffffff;
            this.cycles += 16;
            return;
          case 0x76: // TRAPV
            if (this.sr & SR_V) this.triggerException(7);
            this.cycles += 4;
            return;
          case 0x77: { // RTR
            const ccr = this.pop16();
            this.pc = this.pop32() & 0x00ffffff;
            this.setCCR(ccr);
            this.cycles += 20;
            return;
          }
          case 0x7a: // MOVEC Rc, Rn
          case 0x7b: // MOVEC Rn, Rc
            if (!this.is68020) {
              this.triggerException(4);
              return;
            }
            if ((this.sr & SR_S) === 0) {
              this.triggerException(8);
              return;
            }
            this.execMovec020(sub === 0x7b);
            return;
          default:
            this.triggerException(4);
            return;
        }
      }
      default:
        this.triggerException(4);
    }
  }

  private execMovemToMem(mode: number, reg: number, size: number): void {
    const mask = this.fetch16();
    let count = 0;
    if (mode === 4) {
      // Pre-decrement: bit 0 = A7 .. bit 7 = A0, bit 8 = D7 .. bit 15 = D0
      let addr = this.a[reg];
      for (let i = 0; i < 16; i++) {
        if ((mask & (1 << i)) !== 0) {
          addr = (addr - size) | 0;
          const idx = 15 - i;
          const val = idx < 8 ? this.d[idx] : this.a[idx - 8];
          if (size === 2) this.bus.write16(addr & 0x00ffffff, val & 0xffff);
          else this.bus.write32(addr & 0x00ffffff, val);
          count++;
        }
      }
      this.a[reg] = addr;
    } else {
      let addr = this.resolveEaAddr(mode, reg, size);
      for (let i = 0; i < 16; i++) {
        if ((mask & (1 << i)) !== 0) {
          const val = i < 8 ? this.d[i] : this.a[i - 8];
          if (size === 2) this.bus.write16(addr & 0x00ffffff, val & 0xffff);
          else this.bus.write32(addr & 0x00ffffff, val);
          addr = (addr + size) | 0;
          count++;
        }
      }
    }
    this.cycles += 8 + count * (size === 4 ? 8 : 4);
  }

  private execMovemFromMem(mode: number, reg: number, size: number): void {
    const mask = this.fetch16();
    let count = 0;
    let addr = mode === 3 ? (this.a[reg] & 0x00ffffff) : this.resolveEaAddr(mode, reg, size);
    for (let i = 0; i < 16; i++) {
      if ((mask & (1 << i)) !== 0) {
        const raw = size === 2
          ? ((this.bus.read16(addr & 0x00ffffff) << 16) >> 16)
          : (this.bus.read32(addr & 0x00ffffff) | 0);
        if (i < 8) this.d[i] = raw;
        else this.a[i - 8] = raw;
        addr = (addr + size) | 0;
        count++;
      }
    }
    if (mode === 3 && (mask & (1 << (8 + reg))) === 0) {
      this.a[reg] = addr;
    }
    this.cycles += 12 + count * (size === 4 ? 8 : 4);
  }

  private execLine5(op: number): void {
    const mode = (op >>> 3) & 7;
    const reg = op & 7;
    const szBits = (op >>> 6) & 3;

    if (szBits === 3) {
      const cc = (op >>> 8) & 0xf;
      if (mode === 1) { // DBcc Dn, d16
        const disp = this.fetch16s();
        if (!this.testCondition(cc)) {
          const lo = ((this.d[reg] & 0xffff) - 1) & 0xffff;
          this.d[reg] = (this.d[reg] & 0xffff0000) | lo;
          if (lo !== 0xffff) {
            this.pc = (this.pc - 2 + disp) & 0x00ffffff;
            this.cycles += 10;
            return;
          }
          this.cycles += 14;
        } else {
          this.cycles += 12;
        }
      } else if (this.is68020 && mode === 7 && reg >= 2 && reg <= 4) { // TRAPcc (68020)
        if (reg === 2) this.fetch16();
        else if (reg === 3) this.fetch32();
        if (this.testCondition(cc)) {
          this.triggerException(7);
        }
        this.cycles += 6;
      } else { // Scc <ea>
        const cond = this.testCondition(cc);
        this.writeEa(mode, reg, 1, cond ? 0xff : 0x00);
        this.cycles += cond ? 6 : 4;
      }
      return;
    }

    // ADDQ / SUBQ
    let data = (op >>> 9) & 7;
    if (data === 0) data = 8;
    const isSub = (op & 0x0100) !== 0;

    if (mode === 1) {
      // Address register: always 32-bit, no flags affected
      this.a[reg] = isSub ? ((this.a[reg] - data) | 0) : ((this.a[reg] + data) | 0);
      this.cycles += 8;
      return;
    }

    const sz = this.sizeFromBits(szBits);
    const dst = this.readEa(mode, reg, sz, true);
    const res = isSub
      ? this.subVal(data, dst, sz, false, false)
      : this.addVal(data, dst, sz, false);
    this.writeSavedEa(mode, reg, sz, res);
    this.cycles += sz === 4 ? 8 : 4;
  }

  private execLine6(op: number): void {
    const cc = (op >>> 8) & 0xf;
    let disp = (op << 24) >> 24;
    const basePc = this.pc;
    if (disp === 0) {
      disp = this.fetch16s();
    } else if (disp === -1 && this.is68020) {
      disp = this.fetch32();
    }
    if (cc === 0) { // BRA
      this.pc = (basePc + disp) & 0x00ffffff;
      this.cycles += 10;
    } else if (cc === 1) { // BSR
      this.push32(this.pc);
      this.pc = (basePc + disp) & 0x00ffffff;
      this.cycles += 18;
    } else if (this.testCondition(cc)) {
      this.pc = (basePc + disp) & 0x00ffffff;
      this.cycles += 10;
    } else {
      this.cycles += 8;
    }
  }

  private execLine8(op: number): void {
    const dReg = (op >>> 9) & 7;
    const opmode = (op >>> 6) & 7;
    const mode = (op >>> 3) & 7;
    const reg = op & 7;

    if (opmode === 3) { // DIVU <ea>, Dn
      const divisor = this.readEa(mode, reg, 2, false) & 0xffff;
      if (divisor === 0) {
        this.triggerException(5);
        return;
      }
      const dividend = this.d[dReg] >>> 0;
      const quot = Math.floor(dividend / divisor);
      const rem = dividend % divisor;
      if (quot > 0xffff) {
        this.sr = (this.sr & ~SR_C) | SR_V;
      } else {
        this.d[dReg] = ((rem & 0xffff) << 16) | (quot & 0xffff);
        this.setLogicFlags(quot, 2);
      }
      this.cycles += 100;
      return;
    }

    if (opmode === 7) { // DIVS <ea>, Dn
      const divisor = (this.readEa(mode, reg, 2, false) << 16) >> 16;
      if (divisor === 0) {
        this.triggerException(5);
        return;
      }
      const dividend = this.d[dReg] | 0;
      const quot = Math.trunc(dividend / divisor);
      const rem = dividend % divisor;
      if (quot < -32768 || quot > 32767) {
        this.sr = (this.sr & ~SR_C) | SR_V;
      } else {
        this.d[dReg] = ((rem & 0xffff) << 16) | (quot & 0xffff);
        this.setLogicFlags(quot, 2);
      }
      this.cycles += 120;
      return;
    }

    if (opmode === 4 && (mode === 0 || mode === 1)) { // SBCD
      const isMem = mode === 1;
      let s: number;
      let d: number;
      if (isMem) {
        this.a[reg] = (this.a[reg] - (reg === 7 ? 2 : 1)) | 0;
        this.a[dReg] = (this.a[dReg] - (dReg === 7 ? 2 : 1)) | 0;
        s = this.bus.read8(this.a[reg] & 0x00ffffff);
        d = this.bus.read8(this.a[dReg] & 0x00ffffff);
      } else {
        s = this.d[reg] & 0xff;
        d = this.d[dReg] & 0xff;
      }
      const x = (this.sr & SR_X) ? 1 : 0;
      let lo = (d & 0x0f) - (s & 0x0f) - x;
      let borrow = 0;
      if (lo < 0) { lo += 10; borrow = 1; }
      let hi = ((d >>> 4) & 0x0f) - ((s >>> 4) & 0x0f) - borrow;
      let c = false;
      if (hi < 0) { hi += 10; c = true; }
      const res = ((hi & 0x0f) << 4) | (lo & 0x0f);
      if (isMem) this.bus.write8(this.a[dReg] & 0x00ffffff, res);
      else this.d[dReg] = (this.d[dReg] & 0xffffff00) | res;
      let f = this.sr & ~(SR_C | SR_X);
      if (c) f |= SR_C | SR_X;
      if (res !== 0) f &= ~SR_Z;
      this.sr = f;
      this.cycles += isMem ? 18 : 6;
      return;
    }

    // 68EC020: PACK ($8140-$81FF) and UNPK ($8180-$81FF)
    if (this.is68020 && (opmode === 5 || opmode === 6) && (mode === 0 || mode === 1)) {
      const adj = this.fetch16();
      if (opmode === 5) { // PACK
        let srcWord = 0;
        if (mode === 0) {
          srcWord = this.d[reg] & 0xffff;
        } else {
          const stepSrc = reg === 7 ? 2 : 1;
          this.a[reg] = (this.a[reg] - stepSrc) | 0;
          const lo = this.bus.read8(this.a[reg] & 0x00ffffff);
          this.a[reg] = (this.a[reg] - stepSrc) | 0;
          const hi = this.bus.read8(this.a[reg] & 0x00ffffff);
          srcWord = (hi << 8) | lo;
        }
        const adjusted = (srcWord + adj) & 0xffff;
        const packed = ((adjusted >>> 4) & 0xf0) | (adjusted & 0x0f);
        if (mode === 0) {
          this.d[dReg] = (this.d[dReg] & 0xffffff00) | packed;
        } else {
          const stepDst = dReg === 7 ? 2 : 1;
          this.a[dReg] = (this.a[dReg] - stepDst) | 0;
          this.bus.write8(this.a[dReg] & 0x00ffffff, packed);
        }
      } else { // UNPK
        let b = 0;
        if (mode === 0) {
          b = this.d[reg] & 0xff;
        } else {
          const stepSrc = reg === 7 ? 2 : 1;
          this.a[reg] = (this.a[reg] - stepSrc) | 0;
          b = this.bus.read8(this.a[reg] & 0x00ffffff);
        }
        const unpacked = ((((b & 0xf0) << 4) | (b & 0x0f)) + adj) & 0xffff;
        if (mode === 0) {
          this.d[dReg] = (this.d[dReg] & 0xffff0000) | unpacked;
        } else {
          const stepDst = dReg === 7 ? 2 : 1;
          this.a[dReg] = (this.a[dReg] - stepDst) | 0;
          this.bus.write8(this.a[dReg] & 0x00ffffff, unpacked & 0xff);
          this.a[dReg] = (this.a[dReg] - stepDst) | 0;
          this.bus.write8(this.a[dReg] & 0x00ffffff, (unpacked >>> 8) & 0xff);
        }
      }
      this.cycles += mode === 1 ? 16 : 8;
      return;
    }

    // OR
    const sz = this.sizeFromBits(opmode & 3);
    if (opmode < 4) { // <ea> | Dn -> Dn
      const src = this.readEa(mode, reg, sz, false);
      const res = this.readEa(0, dReg, sz, false) | src;
      this.writeEa(0, dReg, sz, res);
      this.setLogicFlags(res, sz);
    } else { // Dn | <ea> -> <ea>
      const dst = this.readEa(mode, reg, sz, true);
      const res = dst | this.readEa(0, dReg, sz, false);
      this.writeSavedEa(mode, reg, sz, res);
      this.setLogicFlags(res, sz);
    }
    this.cycles += 6;
  }

  private execLine9(op: number): void {
    const dReg = (op >>> 9) & 7;
    const opmode = (op >>> 6) & 7;
    const mode = (op >>> 3) & 7;
    const reg = op & 7;

    // SUBA
    if (opmode === 3 || opmode === 7) {
      const sz = opmode === 3 ? 2 : 4;
      const src = this.signExtend(this.readEa(mode, reg, sz, false), sz);
      this.a[dReg] = (this.a[dReg] - src) | 0;
      this.cycles += 8;
      return;
    }

    // SUBX
    if (opmode >= 4 && (mode === 0 || mode === 1)) {
      const sz = this.sizeFromBits(opmode & 3);
      if (mode === 0) {
        const res = this.subVal(this.readEa(0, reg, sz, false), this.readEa(0, dReg, sz, false), sz, true, false);
        this.writeEa(0, dReg, sz, res);
        this.cycles += 4;
      } else {
        const s = this.readEa(4, reg, sz, false);
        const d = this.readEa(4, dReg, sz, true);
        const res = this.subVal(s, d, sz, true, false);
        this.writeSavedEa(4, dReg, sz, res);
        this.cycles += 18;
      }
      return;
    }

    const sz = this.sizeFromBits(opmode & 3);
    if (opmode < 4) { // Dn - <ea> -> Dn
      const src = this.readEa(mode, reg, sz, false);
      const res = this.subVal(src, this.readEa(0, dReg, sz, false), sz, false, false);
      this.writeEa(0, dReg, sz, res);
    } else { // <ea> - Dn -> <ea>
      const dst = this.readEa(mode, reg, sz, true);
      const res = this.subVal(this.readEa(0, dReg, sz, false), dst, sz, false, false);
      this.writeSavedEa(mode, reg, sz, res);
    }
    this.cycles += 6;
  }

  private execLineB(op: number): void {
    const dReg = (op >>> 9) & 7;
    const opmode = (op >>> 6) & 7;
    const mode = (op >>> 3) & 7;
    const reg = op & 7;

    if (opmode === 3 || opmode === 7) { // CMPA
      const sz = opmode === 3 ? 2 : 4;
      const src = this.signExtend(this.readEa(mode, reg, sz, false), sz);
      this.subVal(src, this.a[dReg], 4, false, true);
      this.cycles += 6;
      return;
    }

    const sz = this.sizeFromBits(opmode & 3);
    if (opmode < 4) { // CMP <ea>, Dn
      const src = this.readEa(mode, reg, sz, false);
      this.subVal(src, this.readEa(0, dReg, sz, false), sz, false, true);
      this.cycles += 4;
    } else if (mode === 1) { // CMPM (Ay)+, (Ax)+
      const src = this.readEa(3, reg, sz, false);
      const dst = this.readEa(3, dReg, sz, false);
      this.subVal(src, dst, sz, false, true);
      this.cycles += 12;
    } else { // EOR Dn, <ea>
      const dst = this.readEa(mode, reg, sz, true);
      const res = dst ^ this.readEa(0, dReg, sz, false);
      this.writeSavedEa(mode, reg, sz, res);
      this.setLogicFlags(res, sz);
      this.cycles += 6;
    }
  }

  private execLineC(op: number): void {
    const dReg = (op >>> 9) & 7;
    const opmode = (op >>> 6) & 7;
    const mode = (op >>> 3) & 7;
    const reg = op & 7;

    if (opmode === 3) { // MULU
      const src = this.readEa(mode, reg, 2, false) & 0xffff;
      const dst = this.d[dReg] & 0xffff;
      const res = Math.imul(src, dst) | 0;
      this.d[dReg] = res;
      this.setLogicFlags(res, 4);
      this.cycles += 54;
      return;
    }

    if (opmode === 7) { // MULS
      const src = (this.readEa(mode, reg, 2, false) << 16) >> 16;
      const dst = (this.d[dReg] << 16) >> 16;
      const res = Math.imul(src, dst) | 0;
      this.d[dReg] = res;
      this.setLogicFlags(res, 4);
      this.cycles += 54;
      return;
    }

    if (opmode === 4 && (mode === 0 || mode === 1)) { // ABCD
      const isMem = mode === 1;
      let s: number;
      let d: number;
      if (isMem) {
        this.a[reg] = (this.a[reg] - (reg === 7 ? 2 : 1)) | 0;
        this.a[dReg] = (this.a[dReg] - (dReg === 7 ? 2 : 1)) | 0;
        s = this.bus.read8(this.a[reg] & 0x00ffffff);
        d = this.bus.read8(this.a[dReg] & 0x00ffffff);
      } else {
        s = this.d[reg] & 0xff;
        d = this.d[dReg] & 0xff;
      }
      const x = (this.sr & SR_X) ? 1 : 0;
      let lo = (s & 0x0f) + (d & 0x0f) + x;
      let carry = 0;
      if (lo > 9) { lo -= 10; carry = 1; }
      let hi = ((s >>> 4) & 0x0f) + ((d >>> 4) & 0x0f) + carry;
      let c = false;
      if (hi > 9) { hi -= 10; c = true; }
      const res = ((hi & 0x0f) << 4) | (lo & 0x0f);
      if (isMem) this.bus.write8(this.a[dReg] & 0x00ffffff, res);
      else this.d[dReg] = (this.d[dReg] & 0xffffff00) | res;
      let f = this.sr & ~(SR_C | SR_X);
      if (c) f |= SR_C | SR_X;
      if (res !== 0) f &= ~SR_Z;
      this.sr = f;
      this.cycles += isMem ? 18 : 6;
      return;
    }

    // EXG
    if (opmode === 5 && mode === 0) {
      const t = this.d[dReg]; this.d[dReg] = this.d[reg]; this.d[reg] = t;
      this.cycles += 6; return;
    }
    if (opmode === 5 && mode === 1) {
      const t = this.a[dReg]; this.a[dReg] = this.a[reg]; this.a[reg] = t;
      this.cycles += 6; return;
    }
    if (opmode === 6 && mode === 1) {
      const t = this.d[dReg]; this.d[dReg] = this.a[reg]; this.a[reg] = t;
      this.cycles += 6; return;
    }

    // AND
    const sz = this.sizeFromBits(opmode & 3);
    if (opmode < 4) {
      const src = this.readEa(mode, reg, sz, false);
      const res = this.readEa(0, dReg, sz, false) & src;
      this.writeEa(0, dReg, sz, res);
      this.setLogicFlags(res, sz);
    } else {
      const dst = this.readEa(mode, reg, sz, true);
      const res = dst & this.readEa(0, dReg, sz, false);
      this.writeSavedEa(mode, reg, sz, res);
      this.setLogicFlags(res, sz);
    }
    this.cycles += 6;
  }

  private execLineD(op: number): void {
    const dReg = (op >>> 9) & 7;
    const opmode = (op >>> 6) & 7;
    const mode = (op >>> 3) & 7;
    const reg = op & 7;

    // ADDA
    if (opmode === 3 || opmode === 7) {
      const sz = opmode === 3 ? 2 : 4;
      const src = this.signExtend(this.readEa(mode, reg, sz, false), sz);
      this.a[dReg] = (this.a[dReg] + src) | 0;
      this.cycles += 8;
      return;
    }

    // ADDX
    if (opmode >= 4 && (mode === 0 || mode === 1)) {
      const sz = this.sizeFromBits(opmode & 3);
      if (mode === 0) {
        const res = this.addVal(this.readEa(0, reg, sz, false), this.readEa(0, dReg, sz, false), sz, true);
        this.writeEa(0, dReg, sz, res);
        this.cycles += 4;
      } else {
        const s = this.readEa(4, reg, sz, false);
        const d = this.readEa(4, dReg, sz, true);
        const res = this.addVal(s, d, sz, true);
        this.writeSavedEa(4, dReg, sz, res);
        this.cycles += 18;
      }
      return;
    }

    const sz = this.sizeFromBits(opmode & 3);
    if (opmode < 4) {
      const src = this.readEa(mode, reg, sz, false);
      const res = this.addVal(src, this.readEa(0, dReg, sz, false), sz, false);
      this.writeEa(0, dReg, sz, res);
    } else {
      const dst = this.readEa(mode, reg, sz, true);
      const res = this.addVal(this.readEa(0, dReg, sz, false), dst, sz, false);
      this.writeSavedEa(mode, reg, sz, res);
    }
    this.cycles += 6;
  }

  private execLineE(op: number): void {
    const szBits = (op >>> 6) & 3;
    const dirLeft = (op & 0x0100) !== 0;

    if (szBits === 3) {
      if (this.is68020 && (op & 0x0800) !== 0) {
        this.execBitfield020(op);
        return;
      }
      // Memory shift/rotate by 1 bit (.W)
      const kind = (op >>> 9) & 3;
      const mode = (op >>> 3) & 7;
      const reg = op & 7;
      const val = this.readEa(mode, reg, 2, true);
      const res = this.shiftRotate(val, 2, 1, kind, dirLeft);
      this.writeSavedEa(mode, reg, 2, res);
      this.cycles += 8;
      return;
    }

    const sz = this.sizeFromBits(szBits);
    const isRegCount = (op & 0x0020) !== 0;
    const kind = (op >>> 3) & 3;
    const dReg = op & 7;
    let count: number;
    if (isRegCount) {
      count = this.d[(op >>> 9) & 7] & 63;
    } else {
      count = (op >>> 9) & 7;
      if (count === 0) count = 8;
    }

    const val = this.readEa(0, dReg, sz, false);
    const res = this.shiftRotate(val, sz, count, kind, dirLeft);
    this.writeEa(0, dReg, sz, res);
    this.cycles += 6 + (count << 1);
  }

  private shiftRotate(val: number, size: number, count: number, kind: number, left: boolean): number {
    const bits = size << 3;
    const mask = size === 1 ? 0xff : size === 2 ? 0xffff : 0xffffffff;
    const msb = size === 1 ? 0x80 : size === 2 ? 0x8000 : 0x80000000;
    let u = (val & mask) >>> 0;
    let c = false;
    let v = false;
    let x = (this.sr & SR_X) !== 0;

    if (count === 0) {
      if (kind === 2) { // ROXL/ROXR: C = X
        c = x;
      }
      let f = this.sr & ~0x0f;
      if (c) f |= SR_C;
      if (u === 0) f |= SR_Z;
      if ((u & msb) !== 0) f |= SR_N;
      this.sr = f;
      return u;
    }

    if (kind === 0) { // ASL / ASR
      if (left) {
        for (let i = 0; i < count; i++) {
          const oldMsb = (u & msb) !== 0;
          c = oldMsb;
          u = ((u << 1) & mask) >>> 0;
          if (((u & msb) !== 0) !== oldMsb) v = true;
        }
      } else {
        const sign = (u & msb) >>> 0;
        for (let i = 0; i < count; i++) {
          c = (u & 1) !== 0;
          u = ((u >>> 1) | sign) >>> 0;
        }
      }
      x = c;
    } else if (kind === 1) { // LSL / LSR
      if (left) {
        for (let i = 0; i < count; i++) {
          c = (u & msb) !== 0;
          u = ((u << 1) & mask) >>> 0;
        }
      } else {
        for (let i = 0; i < count; i++) {
          c = (u & 1) !== 0;
          u = u >>> 1;
        }
      }
      x = c;
    } else if (kind === 2) { // ROXL / ROXR
      for (let i = 0; i < count; i++) {
        if (left) {
          c = (u & msb) !== 0;
          u = (((u << 1) | (x ? 1 : 0)) & mask) >>> 0;
          x = c;
        } else {
          c = (u & 1) !== 0;
          u = ((u >>> 1) | (x ? msb : 0)) >>> 0;
          x = c;
        }
      }
    } else { // ROL / ROR
      const shift = count % bits;
      for (let i = 0; i < count; i++) {
        if (left) {
          c = (u & msb) !== 0;
          u = (((u << 1) | (c ? 1 : 0)) & mask) >>> 0;
        } else {
          c = (u & 1) !== 0;
          u = ((u >>> 1) | (c ? msb : 0)) >>> 0;
        }
      }
      void shift;
    }

    let f = this.sr & ~0x1f;
    if (x) f |= SR_X;
    if (c) f |= SR_C;
    if (v) f |= SR_V;
    if (u === 0) f |= SR_Z;
    if ((u & msb) !== 0) f |= SR_N;
    this.sr = f;
    return u;
  }

  private execMovec020(regToCtrl: boolean): void {
    const ext = this.fetch16();
    const isAddr = (ext & 0x8000) !== 0;
    const regIdx = (ext >>> 12) & 7;
    const ctrl = ext & 0x0fff;
    const targetArr = isAddr ? this.a : this.d;

    if (regToCtrl) {
      const val = targetArr[regIdx] | 0;
      switch (ctrl) {
        case 0x000: this.sfc = val & 7; break;
        case 0x001: this.dfc = val & 7; break;
        case 0x002: this.cacr = val & 0x0003; break; // 68EC020: Instruction Cache Enable/Freeze bits only
        case 0x800: this.usp = val; break;
        case 0x801: this.vbr = val; break;
        case 0x802: this.caar = val; break;
        case 0x803: this.msp = val; break;
        case 0x804: this.ssp = val; this.a[7] = val; break;
        default:
          this.triggerException(4);
          return;
      }
    } else {
      let val = 0;
      switch (ctrl) {
        case 0x000: val = this.sfc; break;
        case 0x001: val = this.dfc; break;
        case 0x002: val = this.cacr; break;
        case 0x800: val = this.usp; break;
        case 0x801: val = this.vbr; break;
        case 0x802: val = this.caar; break;
        case 0x803: val = this.msp; break;
        case 0x804: val = this.a[7]; break;
        default:
          this.triggerException(4);
          return;
      }
      targetArr[regIdx] = val;
    }
    this.cycles += 12;
  }

  private execMulLong020(mode: number, reg: number): void {
    const ext = this.fetch16();
    const dl = (ext >>> 12) & 7;
    const isSigned = (ext & 0x0800) !== 0;
    const is64 = (ext & 0x0400) !== 0;
    const dh = ext & 7;

    const src = this.readEa(mode, reg, 4, false) | 0;
    const dst = this.d[dl] | 0;

    // Exact 32x32 -> 64-bit unsigned product via 16-bit halves (zero heap allocations)
    const au = src >>> 0;
    const bu = dst >>> 0;
    const aLo = au & 0xffff;
    const aHi = au >>> 16;
    const bLo = bu & 0xffff;
    const bHi = bu >>> 16;
    const p0 = Math.imul(aLo, bLo) >>> 0;
    const p1 = Math.imul(aHi, bLo) >>> 0;
    const p2 = Math.imul(aLo, bHi) >>> 0;
    const p3 = Math.imul(aHi, bHi) >>> 0;
    const mid = (p0 >>> 16) + (p1 & 0xffff) + (p2 & 0xffff);
    const lo = ((p0 & 0xffff) | ((mid & 0xffff) << 16)) >>> 0;
    let hi = (p3 + (p1 >>> 16) + (p2 >>> 16) + (mid >>> 16)) >>> 0;

    if (isSigned) {
      if (src < 0) hi = (hi - bu) >>> 0;
      if (dst < 0) hi = (hi - au) >>> 0;
    }

    let nFlag = false;
    let zFlag = false;
    let vFlag = false;

    if (is64) {
      this.d[dh] = hi | 0;
      this.d[dl] = lo | 0;
      nFlag = (hi & 0x80000000) !== 0;
      zFlag = hi === 0 && lo === 0;
      vFlag = false;
    } else {
      const loSigned = lo | 0;
      this.d[dl] = loSigned;
      nFlag = loSigned < 0;
      zFlag = lo === 0;
      vFlag = isSigned
        ? (loSigned < 0 ? hi !== 0xffffffff : hi !== 0)
        : (hi !== 0);
    }

    let f = this.sr & ~0x0f;
    if (nFlag) f |= SR_N;
    if (zFlag) f |= SR_Z;
    if (vFlag) f |= SR_V;
    this.sr = f;
    this.cycles += 28;
  }

  private execDivLong020(mode: number, reg: number): void {
    const ext = this.fetch16();
    const dq = (ext >>> 12) & 7;
    const isSigned = (ext & 0x0800) !== 0;
    const is64 = (ext & 0x0400) !== 0;
    const dr = ext & 7;

    const divisor = this.readEa(mode, reg, 4, false) | 0;
    if (divisor === 0) {
      this.triggerException(5);
      return;
    }

    let q32 = 0;
    let r32 = 0;
    let overflow = false;

    if (!is64) {
      if (isSigned) {
        const dvd = this.d[dq] | 0;
        if (dvd === -2147483648 && divisor === -1) {
          overflow = true;
        } else {
          q32 = Math.trunc(dvd / divisor) | 0;
          r32 = (dvd - q32 * divisor) | 0;
        }
      } else {
        const dvd = this.d[dq] >>> 0;
        const dvs = divisor >>> 0;
        const q = Math.floor(dvd / dvs) >>> 0;
        q32 = q | 0;
        r32 = (dvd - q * dvs) | 0;
      }
    } else {
      const hi = BigInt(this.d[dr] >>> 0);
      const lo = BigInt(this.d[dq] >>> 0);
      let dvd64 = (hi << 32n) | lo;
      if (isSigned) {
        dvd64 = BigInt.asIntN(64, dvd64);
        const dvs64 = BigInt(divisor);
        const q64 = dvd64 / dvs64;
        const r64 = dvd64 % dvs64;
        if (q64 < -0x80000000n || q64 > 0x7fffffffn) {
          overflow = true;
        } else {
          q32 = Number(q64) | 0;
          r32 = Number(r64) | 0;
        }
      } else {
        const dvs64 = BigInt(divisor >>> 0);
        const q64 = dvd64 / dvs64;
        const r64 = dvd64 % dvs64;
        if (q64 > 0xffffffffn) {
          overflow = true;
        } else {
          q32 = Number(q64) | 0;
          r32 = Number(r64) | 0;
        }
      }
    }

    if (overflow) {
      this.sr = (this.sr & ~SR_C) | SR_V;
      this.cycles += 40;
      return;
    }

    if (is64 || dr !== dq) {
      this.d[dr] = r32;
    }
    this.d[dq] = q32;
    this.setLogicFlags(q32, 4);
    this.cycles += 40;
  }

  private execBitfield020(op: number): void {
    const type = (op >>> 8) & 7; // 0=BFTST,1=BFEXTU,2=BFCHG,3=BFEXTS,4=BFCLR,5=BFFFO,6=BFSET,7=BFINS
    const mode = (op >>> 3) & 7;
    const reg = op & 7;
    const ext = this.fetch16();

    const regDn = (ext >>> 12) & 7;
    const rawOffset = (ext & 0x0800) !== 0 ? (this.d[(ext >>> 6) & 7] | 0) : ((ext >>> 6) & 31);
    let width = (ext & 0x0020) !== 0 ? (this.d[ext & 7] & 31) : (ext & 31);
    if (width === 0) width = 32;

    const shiftW = 32 - width;
    const rotMask = width === 32 ? 0xffffffff : ((0xffffffff << shiftW) >>> 0);
    let fieldU = 0;

    if (mode === 0) {
      const offset = rawOffset & 31;
      const v = this.d[reg] >>> 0;
      const rot = offset === 0 ? v : (((v << offset) | (v >>> (32 - offset))) >>> 0);
      fieldU = rot >>> shiftW;

      const regMask = offset === 0 ? rotMask : (((rotMask >>> offset) | (rotMask << (32 - offset))) >>> 0);
      if (type === 2) { // BFCHG
        this.d[reg] = (v ^ regMask) | 0;
      } else if (type === 4) { // BFCLR
        this.d[reg] = (v & ~regMask) | 0;
      } else if (type === 6) { // BFSET
        this.d[reg] = (v | regMask) | 0;
      } else if (type === 7) { // BFINS
        const insShifted = (this.d[regDn] << shiftW) >>> 0;
        const placed = offset === 0 ? insShifted : (((insShifted >>> offset) | (insShifted << (32 - offset))) >>> 0);
        this.d[reg] = ((v & ~regMask) | placed) | 0;
        fieldU = insShifted >>> shiftW;
      }
    } else {
      const baseAddr = this.resolveEaAddr(mode, reg, 1);
      const byteOff = rawOffset >> 3;
      const bitInByte = rawOffset & 7;
      const spanBytes = (bitInByte + width + 7) >>> 3;
      const startAddr = (baseAddr + byteOff) | 0;

      const b0 = this.bus.read8(startAddr);
      const b1 = spanBytes > 1 ? this.bus.read8(startAddr + 1) : 0;
      const b2 = spanBytes > 2 ? this.bus.read8(startAddr + 2) : 0;
      const b3 = spanBytes > 3 ? this.bus.read8(startAddr + 3) : 0;
      const b4 = spanBytes > 4 ? this.bus.read8(startAddr + 4) : 0;

      const origW0 = ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
      let alignedW0 = origW0;
      if (bitInByte !== 0) {
        alignedW0 = ((origW0 << bitInByte) | (b4 >>> (8 - bitInByte))) >>> 0;
      }
      fieldU = alignedW0 >>> shiftW;

      if (type === 2 || type === 4 || type === 6 || type === 7) {
        let outAligned = 0;
        if (type === 2) { // BFCHG
          outAligned = (~alignedW0) >>> 0;
        } else if (type === 4) { // BFCLR
          outAligned = 0;
        } else if (type === 6) { // BFSET
          outAligned = 0xffffffff;
        } else { // BFINS
          outAligned = (this.d[regDn] << shiftW) >>> 0;
          fieldU = outAligned >>> shiftW;
        }

        const mask32 = (rotMask >>> bitInByte) >>> 0;
        const val32 = (outAligned >>> bitInByte) >>> 0;
        const finalW0 = ((origW0 & ~mask32) | (val32 & mask32)) >>> 0;

        this.bus.write8(startAddr, (finalW0 >>> 24) & 0xff);
        if (spanBytes > 1) this.bus.write8(startAddr + 1, (finalW0 >>> 16) & 0xff);
        if (spanBytes > 2) this.bus.write8(startAddr + 2, (finalW0 >>> 8) & 0xff);
        if (spanBytes > 3) this.bus.write8(startAddr + 3, finalW0 & 0xff);
        if (spanBytes > 4) {
          const maskB4 = (rotMask << (8 - bitInByte)) & 0xff;
          const valB4 = (outAligned << (8 - bitInByte)) & 0xff;
          this.bus.write8(startAddr + 4, (b4 & ~maskB4) | (valB4 & maskB4));
        }
      }
    }

    if (type === 1) { // BFEXTU
      this.d[regDn] = fieldU | 0;
    } else if (type === 3) { // BFEXTS
      this.d[regDn] = ((fieldU << shiftW) >> shiftW);
    } else if (type === 5) { // BFFFO
      const baseOffset = mode === 0 ? (rawOffset & 31) : rawOffset;
      const msbAligned = (fieldU << shiftW) >>> 0;
      this.d[regDn] = msbAligned === 0
        ? ((baseOffset + width) | 0)
        : ((baseOffset + Math.clz32(msbAligned)) | 0);
    }

    const msbVal = (fieldU << shiftW) >>> 0;
    let f = this.sr & ~0x0f;
    if ((msbVal & 0x80000000) !== 0) f |= SR_N;
    if (fieldU === 0) f |= SR_Z;
    this.sr = f;
    this.cycles += mode === 0 ? 8 : 14;
  }

  private execCmp2Chk2020(sizeBits: number, mode: number, reg: number): void {
    const ext = this.fetch16();
    const sz = sizeBits === 0 ? 1 : sizeBits === 1 ? 2 : 4;
    const addr = this.resolveEaAddr(mode, reg, sz);
    const lowerRaw = sz === 1 ? this.bus.read8(addr) : sz === 2 ? this.bus.read16(addr) : (this.bus.read32(addr) | 0);
    const upperAddr = (addr + sz) | 0;
    const upperRaw = sz === 1 ? this.bus.read8(upperAddr) : sz === 2 ? this.bus.read16(upperAddr) : (this.bus.read32(upperAddr) | 0);

    const isAddr = (ext & 0x8000) !== 0;
    const rn = (ext >>> 12) & 7;
    const isChk2 = (ext & 0x0800) !== 0;

    let val: number;
    let lower: number;
    let upper: number;
    let outOfBounds: boolean;
    if (isAddr) {
      val = this.a[rn] >>> 0;
      lower = this.signExtend(lowerRaw, sz) >>> 0;
      upper = this.signExtend(upperRaw, sz) >>> 0;
      outOfBounds = ((val - lower) >>> 0) > ((upper - lower) >>> 0);
    } else if (sz === 1) {
      val = this.d[rn] & 0xff;
      lower = lowerRaw & 0xff;
      upper = upperRaw & 0xff;
      outOfBounds = ((val - lower) & 0xff) > ((upper - lower) & 0xff);
    } else if (sz === 2) {
      val = this.d[rn] & 0xffff;
      lower = lowerRaw & 0xffff;
      upper = upperRaw & 0xffff;
      outOfBounds = ((val - lower) & 0xffff) > ((upper - lower) & 0xffff);
    } else {
      val = this.d[rn] >>> 0;
      lower = lowerRaw >>> 0;
      upper = upperRaw >>> 0;
      outOfBounds = ((val - lower) >>> 0) > ((upper - lower) >>> 0);
    }

    let f = this.sr & ~(SR_Z | SR_C);
    if (val === lower || val === upper) f |= SR_Z;
    if (outOfBounds) f |= SR_C;
    this.sr = f;
    this.cycles += 18;
    if (isChk2 && outOfBounds) {
      this.triggerException(6);
    }
  }

  private execCas020(size: number, mode: number, reg: number): void {
    const ext = this.fetch16();
    const dc = ext & 7;
    const du = (ext >>> 6) & 7;
    const dst = this.readEa(mode, reg, size, true);
    const cmp = this.readEa(0, dc, size, false);
    this.subVal(cmp, dst, size, false, true);
    if ((this.sr & SR_Z) !== 0) {
      this.writeSavedEa(mode, reg, size, this.d[du]);
    } else {
      this.writeEa(0, dc, size, dst);
    }
    this.cycles += 14;
  }

  private execCas2020(size: number): void {
    const ext1 = this.fetch16();
    const ext2 = this.fetch16();
    const rn1 = (ext1 >>> 12) & 7;
    const rn2 = (ext2 >>> 12) & 7;
    const addr1 = (ext1 & 0x8000) !== 0 ? (this.a[rn1] | 0) : (this.d[rn1] | 0);
    const addr2 = (ext2 & 0x8000) !== 0 ? (this.a[rn2] | 0) : (this.d[rn2] | 0);
    const dc1 = ext1 & 7;
    const dc2 = ext2 & 7;
    const du1 = (ext1 >>> 6) & 7;
    const du2 = (ext2 >>> 6) & 7;

    const op1 = size === 2 ? this.bus.read16(addr1) : (this.bus.read32(addr1) | 0);
    this.subVal(this.readEa(0, dc1, size, false), op1, size, false, true);
    if ((this.sr & SR_Z) !== 0) {
      const op2 = size === 2 ? this.bus.read16(addr2) : (this.bus.read32(addr2) | 0);
      this.subVal(this.readEa(0, dc2, size, false), op2, size, false, true);
      if ((this.sr & SR_Z) !== 0) {
        if (size === 2) {
          this.bus.write16(addr1, this.d[du1] & 0xffff);
          this.bus.write16(addr2, this.d[du2] & 0xffff);
        } else {
          this.bus.write32(addr1, this.d[du1]);
          this.bus.write32(addr2, this.d[du2]);
        }
        this.cycles += 24;
        return;
      }
      this.writeEa(0, dc1, size, op1);
      this.writeEa(0, dc2, size, op2);
    } else {
      this.writeEa(0, dc1, size, op1);
      const op2 = size === 2 ? this.bus.read16(addr2) : (this.bus.read32(addr2) | 0);
      this.writeEa(0, dc2, size, op2);
    }
    this.cycles += 24;
  }

  private execMoves020(size: number, mode: number, reg: number): void {
    const ext = this.fetch16();
    const isAddr = (ext & 0x8000) !== 0;
    const rn = (ext >>> 12) & 7;
    const toMem = (ext & 0x0800) !== 0;
    const addr = this.resolveEaAddr(mode, reg, size);
    if (toMem) {
      const val = isAddr ? this.a[rn] : this.d[rn];
      if (size === 1) this.bus.write8(addr, val & 0xff);
      else if (size === 2) this.bus.write16(addr, val & 0xffff);
      else this.bus.write32(addr, val | 0);
    } else {
      const raw = size === 1 ? this.bus.read8(addr) : size === 2 ? this.bus.read16(addr) : (this.bus.read32(addr) | 0);
      if (isAddr) {
        this.a[rn] = this.signExtend(raw, size);
      } else if (size === 1) {
        this.d[rn] = (this.d[rn] & 0xffffff00) | (raw & 0xff);
      } else if (size === 2) {
        this.d[rn] = (this.d[rn] & 0xffff0000) | (raw & 0xffff);
      } else {
        this.d[rn] = raw | 0;
      }
    }
    this.cycles += 14;
  }
}

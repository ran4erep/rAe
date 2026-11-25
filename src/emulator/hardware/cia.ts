/**
 * Commodore Amiga 8520 CIA-A ($BFE001 odd) & CIA-B ($BFD000 even).
 * Handles:
 * - Kickstart ROM overlay (OVL) & Power/Audio Filter LED (CIA-A PRA)
 * - Hardware Keyboard serial register SDR ($BFEC01) + IRQ2 handshake
 * - Floppy drive control (CIA-B PRB: MTR, SEL0-3, SIDE, DIR, STEP) & status (CIA-A PRA: RDY, TK0, WPRO, CHNG)
 * - Joystick / Mouse button 1 inputs (CIA-A PRA bits 6/7)
 * - Timers A & B + 24-bit TOD counters + ICR interrupt masks
 */

import { encodeCiaKeyboardByte } from '../keyboard/amigaKeyMap';

export interface CiaCallbacks {
  onOvlChange?: (ovl: boolean) => void;
  onPowerLedChange?: (ledOn: boolean) => void;
  onIrqA?: () => void;
  onIrqB?: () => void;
  onFloppyControl?: (prb: number, prevPrb: number) => void;
  getFloppyStatus?: () => number; // Returns bits 5..2 (RDY, TK0, WPRO, CHNG), active low
  getFireButtons?: () => number;  // Returns bit 6 (Mouse LMB active low) | bit 7 (Joy2 Fire active low)
}

export class AmigaCIA {
  // CIA-A registers
  public praA = 0x03; // OVL=1 on reset, LED=1
  public prbA = 0xff;
  public ddraA = 0x03;
  public ddrbA = 0x00;
  public taA = 0xffff;
  public taLatchA = 0xffff;
  public tbA = 0xffff;
  public tbLatchA = 0xffff;
  public todA = 0;
  public todAlarmA = 0;
  public todLatchA = 0;
  public todLatchedA = false;
  public todRunningA = true;
  public todAlarmSetA = false;
  public sdrA = 0xff;
  public icrDataA = 0;
  public icrMaskA = 0;
  public craA = 0;
  public crbA = 0;

  // CIA-B registers
  public praB = 0xff;
  public prbB = 0xff; // All drives deselected, motor off (active low)
  public ddraB = 0x00;
  public ddrbB = 0xff;
  public taB = 0xffff;
  public taLatchB = 0xffff;
  public tbB = 0xffff;
  public tbLatchB = 0xffff;
  public todB = 0;
  public todAlarmB = 0;
  public todLatchB = 0;
  public todLatchedB = false;
  public todRunningB = true;
  public todAlarmSetB = false;
  public sdrB = 0xff;
  public icrDataB = 0;
  public icrMaskB = 0;
  public craB = 0;
  public crbB = 0;

  // Keyboard hardware FIFO (holds encoded CIA SDR bytes)
  private readonly keyQueue = new Uint8Array(64);
  private keyHead = 0;
  private keyTail = 0;
  private keyHandshakePending = false;
  private keyCooldownTicks = 0;

  // Zero-alloc intra-scanline E-clock timer synchronization
  private cycleSource: { readonly cycles: number } | null = null;
  private scanlineStartCycle = 0;
  private scanlineCpuCycles = 0;
  private scanlineTotalEClocks = 0;
  private scanlineFlushedEClocks = 0;

  private cb: CiaCallbacks;

  constructor(callbacks: CiaCallbacks = {}) {
    this.cb = callbacks;
    this.reset();
  }

  public attachCycleSource(source: { readonly cycles: number }): void {
    this.cycleSource = source;
  }

  public beginScanline(startCycle: number, cpuCycles: number, totalEClocks: number): void {
    this.scanlineStartCycle = startCycle;
    this.scanlineCpuCycles = cpuCycles;
    this.scanlineTotalEClocks = totalEClocks;
    this.scanlineFlushedEClocks = 0;
  }

  private syncEClocks(): void {
    if (this.scanlineCpuCycles <= 0 || this.cycleSource === null) return;
    const remaining = this.scanlineTotalEClocks - this.scanlineFlushedEClocks;
    if (remaining <= 0) return;
    const elapsed = this.cycleSource.cycles - this.scanlineStartCycle;
    if (elapsed <= 0) return;
    let target = ((elapsed * this.scanlineTotalEClocks) / this.scanlineCpuCycles) | 0;
    if (target > this.scanlineTotalEClocks) target = this.scanlineTotalEClocks;
    const delta = target - this.scanlineFlushedEClocks;
    if (delta > 0) {
      this.scanlineFlushedEClocks = target;
      this.stepEClocks(delta);
    }
  }

  public endScanline(): void {
    const rem = this.scanlineTotalEClocks - this.scanlineFlushedEClocks;
    this.scanlineCpuCycles = 0;
    this.scanlineTotalEClocks = 0;
    this.scanlineFlushedEClocks = 0;
    if (rem > 0) {
      this.stepEClocks(rem);
    }
  }

  public reset(): void {
    this.praA = 0x01; // OVL=1 (ROM overlaid at $000000), LED dim
    this.prbA = 0xff;
    this.ddraA = 0x03;
    this.ddrbA = 0x00;
    this.taA = this.taLatchA = 0xffff;
    this.tbA = this.tbLatchA = 0xffff;
    this.todA = 0;
    this.todAlarmA = 0;
    this.todLatchedA = false;
    this.todRunningA = true;
    this.todAlarmSetA = false;
    this.sdrA = 0xff;
    this.icrDataA = 0;
    this.icrMaskA = 0;
    this.craA = 0;
    this.crbA = 0;

    this.praB = 0xff;
    this.prbB = 0xff;
    this.ddraB = 0x00;
    this.ddrbB = 0xff;
    this.taB = this.taLatchB = 0xffff;
    this.tbB = this.tbLatchB = 0xffff;
    this.todB = 0;
    this.todAlarmB = 0;
    this.todLatchedB = false;
    this.todRunningB = true;
    this.todAlarmSetB = false;
    this.sdrB = 0xff;
    this.icrDataB = 0;
    this.icrMaskB = 0;
    this.craB = 0;
    this.crbB = 0;

    this.keyHead = 0;
    this.keyTail = 0;
    this.keyHandshakePending = false;
    this.keyCooldownTicks = 0;
    this.scanlineStartCycle = 0;
    this.scanlineCpuCycles = 0;
    this.scanlineTotalEClocks = 0;
    this.scanlineFlushedEClocks = 0;

    this.cb.onOvlChange?.(true);
    this.cb.onPowerLedChange?.(true);
  }

  public isOvlActive(): boolean {
    return (this.praA & 0x01) !== 0;
  }

  public isPowerLedBright(): boolean {
    // On Amiga 500, PRA bit 1 = 0 means bright LED & audio filter ON
    return (this.praA & 0x02) === 0;
  }

  public enqueueKey(rawCode: number, isRelease: boolean): void {
    const nextTail = (this.keyTail + 1) & 63;
    if (nextTail === this.keyHead) return; // Queue full
    this.keyQueue[this.keyTail] = encodeCiaKeyboardByte(rawCode, isRelease);
    this.keyTail = nextTail;
    this.pumpKeyboardQueue();
  }

  private pumpKeyboardQueue(): void {
    if (this.keyHead === this.keyTail) return;
    if (this.keyHandshakePending || this.keyCooldownTicks > 0) return;
    this.sdrA = this.keyQueue[this.keyHead];
    this.keyHead = (this.keyHead + 1) & 63;
    this.keyHandshakePending = true;
    this.keyCooldownTicks = 8; // Small scanline pacing between events
    this.setIcrFlagA(0x08); // Serial Port (SP) interrupt -> CIA-A IRQ2
  }

  private setIcrFlagA(bit: number): void {
    this.icrDataA |= bit;
    if ((this.icrDataA & this.icrMaskA & 0x1f) !== 0) {
      this.icrDataA |= 0x80;
      this.cb.onIrqA?.();
    }
  }

  private setIcrFlagB(bit: number): void {
    this.icrDataB |= bit;
    if ((this.icrDataB & this.icrMaskB & 0x1f) !== 0) {
      this.icrDataB |= 0x80;
      this.cb.onIrqB?.();
    }
  }

  public hasIrqA(): boolean {
    return (this.icrDataA & 0x80) !== 0;
  }

  public hasIrqB(): boolean {
    return (this.icrDataB & 0x80) !== 0;
  }

  /** Step CIA timers by E-clock ticks (approx 45 ticks per PAL scanline) */
  public stepEClocks(ticks: number): void {
    if (ticks <= 0) return;

    // CIA-A Timer A
    if ((this.craA & 0x01) !== 0) {
      this.taA -= ticks;
      if (this.taA <= 0) {
        const latch = this.taLatchA > 0 ? this.taLatchA : 0xffff;
        if (this.craA & 0x08) {
          this.craA &= ~0x01; // One-shot
          this.taA = latch;
          this.setIcrFlagA(0x01);
          if ((this.crbA & 0x61) === 0x41) { // Timer B counts Timer A underflows
            this.tbA--;
            if (this.tbA <= 0) {
              this.tbA = this.tbLatchA > 0 ? this.tbLatchA : 0xffff;
              if (this.crbA & 0x08) this.crbA &= ~0x01;
              this.setIcrFlagA(0x02);
            }
          }
        } else {
          const underflows = ((-this.taA) / latch | 0) + 1;
          this.taA += underflows * latch;
          if (this.taA <= 0) this.taA = latch;
          this.setIcrFlagA(0x01);
          if ((this.crbA & 0x61) === 0x41) { // Timer B counts Timer A underflows
            this.tbA -= underflows;
            if (this.tbA <= 0) {
              const latchB = this.tbLatchA > 0 ? this.tbLatchA : 0xffff;
              if (this.crbA & 0x08) {
                this.crbA &= ~0x01;
                this.tbA = latchB;
              } else {
                this.tbA += (((-this.tbA) / latchB) | 0) * latchB + latchB;
                if (this.tbA <= 0) this.tbA = latchB;
              }
              this.setIcrFlagA(0x02);
            }
          }
        }
      }
    }
    // CIA-A Timer B (E-clock mode)
    if ((this.crbA & 0x61) === 0x01) {
      this.tbA -= ticks;
      if (this.tbA <= 0) {
        const latch = this.tbLatchA > 0 ? this.tbLatchA : 0xffff;
        if (this.crbA & 0x08) {
          this.crbA &= ~0x01;
          this.tbA = latch;
        } else {
          this.tbA += (((-this.tbA) / latch) | 0) * latch + latch;
          if (this.tbA <= 0) this.tbA = latch;
        }
        this.setIcrFlagA(0x02);
      }
    }

    // CIA-B Timer A
    if ((this.craB & 0x01) !== 0) {
      this.taB -= ticks;
      if (this.taB <= 0) {
        const latch = this.taLatchB > 0 ? this.taLatchB : 0xffff;
        if (this.craB & 0x08) {
          this.craB &= ~0x01;
          this.taB = latch;
          this.setIcrFlagB(0x01);
          if ((this.crbB & 0x61) === 0x41) {
            this.tbB--;
            if (this.tbB <= 0) {
              this.tbB = this.tbLatchB > 0 ? this.tbLatchB : 0xffff;
              if (this.crbB & 0x08) this.crbB &= ~0x01;
              this.setIcrFlagB(0x02);
            }
          }
        } else {
          const underflows = ((-this.taB) / latch | 0) + 1;
          this.taB += underflows * latch;
          if (this.taB <= 0) this.taB = latch;
          this.setIcrFlagB(0x01);
          if ((this.crbB & 0x61) === 0x41) {
            this.tbB -= underflows;
            if (this.tbB <= 0) {
              const latchB = this.tbLatchB > 0 ? this.tbLatchB : 0xffff;
              if (this.crbB & 0x08) {
                this.crbB &= ~0x01;
                this.tbB = latchB;
              } else {
                this.tbB += (((-this.tbB) / latchB) | 0) * latchB + latchB;
                if (this.tbB <= 0) this.tbB = latchB;
              }
              this.setIcrFlagB(0x02);
            }
          }
        }
      }
    }
    // CIA-B Timer B
    if ((this.crbB & 0x61) === 0x01) {
      this.tbB -= ticks;
      if (this.tbB <= 0) {
        const latch = this.tbLatchB > 0 ? this.tbLatchB : 0xffff;
        if (this.crbB & 0x08) {
          this.crbB &= ~0x01;
          this.tbB = latch;
        } else {
          this.tbB += (((-this.tbB) / latch) | 0) * latch + latch;
          if (this.tbB <= 0) this.tbB = latch;
        }
        this.setIcrFlagB(0x02);
      }
    }
  }

  public onHSync(): void {
    if (this.keyCooldownTicks > 0) {
      this.keyCooldownTicks--;
      if (this.keyCooldownTicks === 0 && !this.keyHandshakePending) {
        this.pumpKeyboardQueue();
      }
    }
    if (this.todRunningB) {
      this.todB = (this.todB + 1) & 0xffffff;
      if (this.todAlarmSetB && this.todB === this.todAlarmB) {
        this.setIcrFlagB(0x04);
      }
    }
  }

  public onVSync(): void {
    if (this.todRunningA) {
      this.todA = (this.todA + 1) & 0xffffff;
      if (this.todAlarmSetA && this.todA === this.todAlarmA) {
        this.setIcrFlagA(0x04);
      }
    }
    // Safety release if OS didn't toggle CRA SPMODE handshake (e.g. polled reader)
    if (this.keyHandshakePending && this.keyHead !== this.keyTail) {
      this.keyHandshakePending = false;
      this.pumpKeyboardQueue();
    }
  }

  public triggerDiskIndex(): void {
    this.setIcrFlagB(0x10); // FLAG pin on CIA-B = floppy index pulse
  }

  public readA(reg: number): number {
    const r = reg & 0xf;
    if ((r >= 0x4 && r <= 0x7) || r >= 0xd) {
      this.syncEClocks();
    }
    switch (r) {
      case 0x0: { // PRA
        const floppyBits = this.cb.getFloppyStatus ? (this.cb.getFloppyStatus() & 0x3c) : 0x3c;
        const fireBits = this.cb.getFireButtons ? (this.cb.getFireButtons() & 0xc0) : 0xc0;
        const inputVal = fireBits | floppyBits | (this.praA & 0x03);
        return (this.praA & this.ddraA) | (inputVal & ~this.ddraA);
      }
      case 0x1: return (this.prbA & this.ddrbA) | (~this.ddrbA & 0xff);
      case 0x2: return this.ddraA;
      case 0x3: return this.ddrbA;
      case 0x4: return this.taA & 0xff;
      case 0x5: return (this.taA >>> 8) & 0xff;
      case 0x6: return this.tbA & 0xff;
      case 0x7: return (this.tbA >>> 8) & 0xff;
      case 0x8: {
        const v = this.todLatchedA ? this.todLatchA : this.todA;
        this.todLatchedA = false;
        return v & 0xff;
      }
      case 0x9: return ((this.todLatchedA ? this.todLatchA : this.todA) >>> 8) & 0xff;
      case 0xa:
        this.todLatchA = this.todA;
        this.todLatchedA = true;
        return (this.todLatchA >>> 16) & 0xff;
      case 0xc: { // SDR (reading releases keyboard byte)
        const v = this.sdrA;
        return v;
      }
      case 0xd: { // ICR (read clears flags)
        const v = this.icrDataA;
        this.icrDataA = 0;
        return v;
      }
      case 0xe: return this.craA;
      case 0xf: return this.crbA;
      default: return 0xff;
    }
  }

  public writeA(reg: number, val: number): void {
    const r = reg & 0xf;
    if ((r >= 0x4 && r <= 0x7) || r >= 0xd) {
      this.syncEClocks();
    }
    const v = val & 0xff;
    switch (r) {
      case 0x0: {
        const prev = this.praA;
        this.praA = v;
        if ((prev & 0x01) !== (v & 0x01)) {
          this.cb.onOvlChange?.((v & 0x01) !== 0);
        }
        if ((prev & 0x02) !== (v & 0x02)) {
          this.cb.onPowerLedChange?.((v & 0x02) === 0);
        }
        break;
      }
      case 0x1: this.prbA = v; break;
      case 0x2: this.ddraA = v; break;
      case 0x3: this.ddrbA = v; break;
      case 0x4: this.taLatchA = (this.taLatchA & 0xff00) | v; break;
      case 0x5:
        this.taLatchA = (this.taLatchA & 0x00ff) | (v << 8);
        if ((this.craA & 0x08) !== 0) {
          // One-shot mode: writing TAHI loads counter and starts timer!
          this.taA = this.taLatchA;
          this.craA |= 0x01;
        } else if ((this.craA & 0x01) === 0) {
          this.taA = this.taLatchA;
        }
        break;
      case 0x6: this.tbLatchA = (this.tbLatchA & 0xff00) | v; break;
      case 0x7:
        this.tbLatchA = (this.tbLatchA & 0x00ff) | (v << 8);
        if ((this.crbA & 0x08) !== 0) {
          // One-shot mode: writing TBHI loads counter and starts timer!
          this.tbA = this.tbLatchA;
          this.crbA |= 0x01;
        } else if ((this.crbA & 0x01) === 0) {
          this.tbA = this.tbLatchA;
        }
        break;
      case 0x8:
        if (this.crbA & 0x80) {
          this.todAlarmA = (this.todAlarmA & 0xffff00) | v;
          this.todAlarmSetA = true;
        } else {
          this.todA = (this.todA & 0xffff00) | v;
          this.todRunningA = true;
          if (this.todAlarmSetA && this.todA === this.todAlarmA) {
            this.setIcrFlagA(0x04);
          }
        }
        break;
      case 0x9:
        if (this.crbA & 0x80) {
          this.todAlarmA = (this.todAlarmA & 0xff00ff) | (v << 8);
          this.todAlarmSetA = true;
        } else {
          this.todA = (this.todA & 0xff00ff) | (v << 8);
          this.todRunningA = false;
        }
        break;
      case 0xa:
        if (this.crbA & 0x80) {
          this.todAlarmA = (this.todAlarmA & 0x00ffff) | (v << 16);
          this.todAlarmSetA = true;
        } else {
          this.todA = (this.todA & 0x00ffff) | (v << 16);
          this.todRunningA = false;
        }
        break;
      case 0xc: this.sdrA = v; break;
      case 0xd:
        if (v & 0x80) this.icrMaskA |= v & 0x1f;
        else this.icrMaskA &= ~(v & 0x1f);
        if ((this.icrDataA & this.icrMaskA & 0x1f) !== 0) {
          this.icrDataA |= 0x80;
          this.cb.onIrqA?.();
        }
        break;
      case 0xe: {
        const prevSpMode = (this.craA & 0x40) !== 0;
        const newSpMode = (v & 0x40) !== 0;
        this.craA = v & ~0x10;
        if (v & 0x10) this.taA = this.taLatchA;
        // Amiga keyboard handshake: OS sets SPMODE=1 (output) then SPMODE=0 (input) to ACK
        if (prevSpMode && !newSpMode) {
          this.keyHandshakePending = false;
          this.pumpKeyboardQueue();
        }
        break;
      }
      case 0xf:
        this.crbA = v & ~0x10;
        if (v & 0x10) this.tbA = this.tbLatchA;
        break;
    }
  }

  public readB(reg: number): number {
    const r = reg & 0xf;
    if ((r >= 0x4 && r <= 0x7) || r >= 0xd) {
      this.syncEClocks();
    }
    switch (r) {
      case 0x0: return (this.praB & this.ddraB) | (~this.ddraB & 0xff);
      case 0x1: return (this.prbB & this.ddrbB) | (~this.ddrbB & 0xff);
      case 0x2: return this.ddraB;
      case 0x3: return this.ddrbB;
      case 0x4: return this.taB & 0xff;
      case 0x5: return (this.taB >>> 8) & 0xff;
      case 0x6: return this.tbB & 0xff;
      case 0x7: return (this.tbB >>> 8) & 0xff;
      case 0x8: {
        const v = this.todLatchedB ? this.todLatchB : this.todB;
        this.todLatchedB = false;
        return v & 0xff;
      }
      case 0x9: return ((this.todLatchedB ? this.todLatchB : this.todB) >>> 8) & 0xff;
      case 0xa:
        this.todLatchB = this.todB;
        this.todLatchedB = true;
        return (this.todLatchB >>> 16) & 0xff;
      case 0xc: return this.sdrB;
      case 0xd: {
        const v = this.icrDataB;
        this.icrDataB = 0;
        return v;
      }
      case 0xe: return this.craB;
      case 0xf: return this.crbB;
      default: return 0xff;
    }
  }

  public writeB(reg: number, val: number): void {
    const r = reg & 0xf;
    if ((r >= 0x4 && r <= 0x7) || r >= 0xd) {
      this.syncEClocks();
    }
    const v = val & 0xff;
    switch (r) {
      case 0x0: this.praB = v; break;
      case 0x1: {
        const prev = this.prbB;
        this.prbB = v;
        this.cb.onFloppyControl?.(v, prev);
        break;
      }
      case 0x2: this.ddraB = v; break;
      case 0x3: this.ddrbB = v; break;
      case 0x4: this.taLatchB = (this.taLatchB & 0xff00) | v; break;
      case 0x5:
        this.taLatchB = (this.taLatchB & 0x00ff) | (v << 8);
        if ((this.craB & 0x08) !== 0) {
          this.taB = this.taLatchB;
          this.craB |= 0x01;
        } else if ((this.craB & 0x01) === 0) {
          this.taB = this.taLatchB;
        }
        break;
      case 0x6: this.tbLatchB = (this.tbLatchB & 0xff00) | v; break;
      case 0x7:
        this.tbLatchB = (this.tbLatchB & 0x00ff) | (v << 8);
        if ((this.crbB & 0x08) !== 0) {
          this.tbB = this.tbLatchB;
          this.crbB |= 0x01;
        } else if ((this.crbB & 0x01) === 0) {
          this.tbB = this.tbLatchB;
        }
        break;
      case 0x8:
        if (this.crbB & 0x80) {
          this.todAlarmB = (this.todAlarmB & 0xffff00) | v;
          this.todAlarmSetB = true;
        } else {
          this.todB = (this.todB & 0xffff00) | v;
          this.todRunningB = true;
          if (this.todAlarmSetB && this.todB === this.todAlarmB) {
            this.setIcrFlagB(0x04);
          }
        }
        break;
      case 0x9:
        if (this.crbB & 0x80) {
          this.todAlarmB = (this.todAlarmB & 0xff00ff) | (v << 8);
          this.todAlarmSetB = true;
        } else {
          this.todB = (this.todB & 0xff00ff) | (v << 8);
          this.todRunningB = false;
        }
        break;
      case 0xa:
        if (this.crbB & 0x80) {
          this.todAlarmB = (this.todAlarmB & 0x00ffff) | (v << 16);
          this.todAlarmSetB = true;
        } else {
          this.todB = (this.todB & 0x00ffff) | (v << 16);
          this.todRunningB = false;
        }
        break;
      case 0xc: this.sdrB = v; break;
      case 0xd:
        if (v & 0x80) this.icrMaskB |= v & 0x1f;
        else this.icrMaskB &= ~(v & 0x1f);
        if ((this.icrDataB & this.icrMaskB & 0x1f) !== 0) {
          this.icrDataB |= 0x80;
          this.cb.onIrqB?.();
        }
        break;
      case 0xe:
        this.craB = v & ~0x10;
        if (v & 0x10) this.taB = this.taLatchB;
        break;
      case 0xf:
        this.crbB = v & ~0x10;
        if (v & 0x10) this.tbB = this.tbLatchB;
        break;
    }
  }

  public serializeA(): number[] {
    const flags =
      (this.todRunningA ? 1 : 0) |
      (this.todAlarmSetA ? 2 : 0) |
      (this.todLatchedA ? 4 : 0);
    return [
      this.praA, this.prbA, this.ddraA, this.ddrbA,
      this.taA, this.taLatchA, this.tbA, this.tbLatchA,
      this.todA, this.todAlarmA, this.sdrA, this.icrDataA,
      this.icrMaskA, this.craA, this.crbA,
      flags, this.todLatchA,
    ];
  }

  public deserializeA(s: number[]): void {
    if (s.length < 15) return;
    [
      this.praA, this.prbA, this.ddraA, this.ddrbA,
      this.taA, this.taLatchA, this.tbA, this.tbLatchA,
      this.todA, this.todAlarmA, this.sdrA, this.icrDataA,
      this.icrMaskA, this.craA, this.crbA,
    ] = s;
    if (s.length >= 16) {
      const flags = s[15] | 0;
      this.todRunningA = (flags & 1) !== 0;
      this.todAlarmSetA = (flags & 2) !== 0;
      this.todLatchedA = (flags & 4) !== 0;
      this.todLatchA = s.length >= 17 ? (s[16] >>> 0) : this.todA;
    } else {
      // Legacy 15-element savestate compatibility: infer active TOD & armed alarm
      this.todRunningA = true;
      this.todAlarmSetA = this.todAlarmA !== 0 || (this.icrMaskA & 0x04) !== 0;
      this.todLatchedA = false;
      this.todLatchA = this.todA;
    }
    this.cb.onOvlChange?.(this.isOvlActive());
    this.cb.onPowerLedChange?.(this.isPowerLedBright());
  }

  public serializeB(): number[] {
    const flags =
      (this.todRunningB ? 1 : 0) |
      (this.todAlarmSetB ? 2 : 0) |
      (this.todLatchedB ? 4 : 0);
    return [
      this.praB, this.prbB, this.ddraB, this.ddrbB,
      this.taB, this.taLatchB, this.tbB, this.tbLatchB,
      this.todB, this.todAlarmB, this.sdrB, this.icrDataB,
      this.icrMaskB, this.craB, this.crbB,
      flags, this.todLatchB,
    ];
  }

  public deserializeB(s: number[]): void {
    if (s.length < 15) return;
    [
      this.praB, this.prbB, this.ddraB, this.ddrbB,
      this.taB, this.taLatchB, this.tbB, this.tbLatchB,
      this.todB, this.todAlarmB, this.sdrB, this.icrDataB,
      this.icrMaskB, this.craB, this.crbB,
    ] = s;
    if (s.length >= 16) {
      const flags = s[15] | 0;
      this.todRunningB = (flags & 1) !== 0;
      this.todAlarmSetB = (flags & 2) !== 0;
      this.todLatchedB = (flags & 4) !== 0;
      this.todLatchB = s.length >= 17 ? (s[16] >>> 0) : this.todB;
    } else {
      // Legacy 15-element savestate compatibility: infer active TOD & armed alarm
      this.todRunningB = true;
      this.todAlarmSetB = this.todAlarmB !== 0 || (this.icrMaskB & 0x04) !== 0;
      this.todLatchedB = false;
      this.todLatchB = this.todB;
    }
  }
}

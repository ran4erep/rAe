/**
 * Commodore Amiga 24-bit Address Bus & Memory Controller.
 * Maps:
 * - $000000 - $1FFFFF : Chip RAM (512KB / 1MB / 2MB) — overlaid with Kickstart ROM when CIA-A OVL=1!
 * - $200000 - $3FFFFF : Fast RAM (optional 0 / 1MB / 2MB)
 * - $BFD000 - $BFDF00 : CIA-B (even byte addresses)
 * - $BFE001 - $BFEF01 : CIA-A (odd byte addresses)
 * - $C00000 - $C7FFFF : Slow / Ranger RAM (optional 512KB A500 trapdoor expansion)
 * - $DC0000 - $DCFFFF : Battery-backed RTC (MSM6242B stub for Kickstart/ECS)
 * - $DFF000 - $DFFFFF : Custom Chip Registers (Agnus, Denise, Paula)
 * - $F80000 - $FFFFFF : Kickstart ROM (512KB full or 256KB mirrored at $F80000 & $FC0000)
 */

import { M68000, M68kBus } from '../cpu/m68k';
import { AmigaCIA } from './cia';
import { AmigaChipset } from './chipset';
import type { HardfileController } from './hardfile';

export class AmigaMemory implements M68kBus {
  public chipRam: Uint8Array;
  public slowRam: Uint8Array;
  public fastRam: Uint8Array;
  public rom: Uint8Array; // Always normalized to 512KB ($80000 bytes)
  public ovl = true;

  public chipRamSize: number;
  public slowRamSize: number;
  public fastRamSize: number;

  private cia: AmigaCIA;
  private chipset: AmigaChipset;
  public hardfile: HardfileController | null = null;
  public onResetInstruction?: () => void;
  public onLineA?: (opcode: number, cpu: M68000) => boolean;
  // Oki MSM6242B battery-backed RTC state (evaluated on demand -> 0% CPU overhead)
  private rtcCtrl = new Uint8Array([0x00, 0x00, 0x04]); // Regs D, E, F (F bit2=1 -> 24h mode)
  private rtcWallEpochMs = Date.now();
  private rtcAmigaElapsedMs = 0;
  private rtcOffsetMs = 0;

  constructor(
    chipRamKB: number,
    slowRamKB: number,
    fastRamKB: number,
    cia: AmigaCIA,
    chipset: AmigaChipset
  ) {
    this.chipRamSize = chipRamKB * 1024;
    this.slowRamSize = slowRamKB * 1024;
    this.fastRamSize = fastRamKB * 1024;
    this.chipRam = new Uint8Array(this.chipRamSize);
    this.slowRam = new Uint8Array(this.slowRamSize);
    this.fastRam = new Uint8Array(this.fastRamSize);
    this.rom = new Uint8Array(512 * 1024);
    this.cia = cia;
    this.chipset = chipset;
  }

  public advanceRtcMs(deltaMs: number): void {
    this.rtcAmigaElapsedMs += deltaMs;
  }

  public reconfigureRam(chipRamKB: number, slowRamKB: number, fastRamKB: number): void {
    const newChip = chipRamKB * 1024;
    const newSlow = slowRamKB * 1024;
    const newFast = fastRamKB * 1024;
    if (this.chipRamSize !== newChip) {
      this.chipRamSize = newChip;
      this.chipRam = new Uint8Array(newChip);
      this.chipset.attachChipRam(this.chipRam);
    } else {
      this.chipRam.fill(0);
    }
    if (this.slowRamSize !== newSlow) {
      this.slowRamSize = newSlow;
      this.slowRam = new Uint8Array(newSlow);
    } else {
      this.slowRam.fill(0);
    }
    if (this.fastRamSize !== newFast) {
      this.fastRamSize = newFast;
      this.fastRam = new Uint8Array(newFast);
    } else {
      this.fastRam.fill(0);
    }
  }

  /**
   * Loads a 256 KB (Kickstart 1.2/1.3) or 512 KB (Kickstart 2.04/3.1/AROS) ROM image.
   * 256 KB ROMs are automatically mirrored across $F80000-$FBFFFF and $FC0000-$FFFFFF.
   */
  public loadRom(romBytes: Uint8Array): void {
    this.rom.fill(0);
    if (romBytes.length <= 256 * 1024) {
      // Mirror 256KB ROM into both halves so both $F80000 and $FC0000 map identically
      this.rom.set(romBytes, 0);
      this.rom.set(romBytes, 256 * 1024);
    } else {
      this.rom.set(romBytes.subarray(0, 512 * 1024), 0);
    }
  }

  public clearRam(): void {
    this.chipRam.fill(0);
    this.slowRam.fill(0);
    this.fastRam.fill(0);
  }

  public read8(addr: number): number {
    const a = addr & 0x00ffffff;

    // Fast path: Chip RAM or Boot ROM overlay ($000000 - $1FFFFF)
    if (a < 0x200000) {
      if (this.ovl && a < 0x080000) {
        return this.rom[a];
      }
      if (a < this.chipRamSize) {
        return this.chipRam[a];
      }
      // OCS 512KB mirrors within $000000-$0FFFFF on A500
      if (a < 0x100000) {
        return this.chipRam[a & (this.chipRamSize - 1)];
      }
      return 0xff;
    }

    // Kickstart ROM ($F80000 - $FFFFFF)
    if (a >= 0xf80000) {
      return this.rom[a - 0xf80000];
    }

    // Custom Chips ($DFF000 - $DFFFFF)
    if (a >= 0xdff000 && a < 0xe00000) {
      const w = this.chipset.readReg16(a & 0x1fe);
      return (a & 1) === 0 ? (w >>> 8) & 0xff : w & 0xff;
    }

    // CIA-A ($BFE001: A12=0, odd) & CIA-B ($BFD000: A13=0, even)
    if (a >= 0xbfd000 && a < 0xbff000) {
      const reg = (a >>> 8) & 0x0f;
      if ((a & 0x1000) === 0 && (a & 1) === 1) {
        return this.cia.readA(reg);
      }
      if ((a & 0x2000) === 0 && (a & 1) === 0) {
        return this.cia.readB(reg);
      }
      return 0xff;
    }

    // Slow / Ranger RAM ($C00000 - $C7FFFF)
    if (a >= 0xc00000 && a < 0xc00000 + this.slowRamSize) {
      return this.slowRam[a - 0xc00000];
    }

    // Fast RAM ($200000+)
    if (this.fastRamSize > 0 && a >= 0x200000 && a < 0x200000 + this.fastRamSize) {
      return this.fastRam[a - 0x200000];
    }

    // Real-time clock ($DC0000 - $DCFFFF: Oki MSM6242B on odd byte addresses)
    if (a >= 0xdc0000 && a < 0xdd0000) {
      return (a & 1) === 1 ? this.readRtcReg((a >>> 2) & 0x0f) : 0x00;
    }

    // Zorro II Autoconfig & Expansion ROM ($E80000 - $EFFFFF)
    if (a >= 0xe80000 && a < 0xf00000) {
      return this.hardfile ? this.hardfile.read8(a) : 0x00;
    }

    return 0xff;
  }

  private readRtcReg(reg: number): number {
    if (reg >= 13) {
      const idx = reg - 13;
      const val = this.rtcCtrl[idx] & 0x0f;
      // Reg D bit 1 is BUSY: always 0 (ready)
      return reg === 13 ? val & 0x0d : val;
    }
    const wallElapsed = Date.now() - this.rtcWallEpochMs;
    const elapsedMs = wallElapsed > this.rtcAmigaElapsedMs ? wallElapsed : this.rtcAmigaElapsedMs;
    const d = new Date(this.rtcWallEpochMs + elapsedMs + this.rtcOffsetMs);
    switch (reg) {
      case 0:
        return d.getSeconds() % 10;
      case 1:
        return Math.floor(d.getSeconds() / 10);
      case 2:
        return d.getMinutes() % 10;
      case 3:
        return Math.floor(d.getMinutes() / 10);
      case 4: {
        const h24 = d.getHours();
        if ((this.rtcCtrl[2] & 0x04) !== 0) return h24 % 10;
        const h12 = h24 % 12 || 12;
        return h12 % 10;
      }
      case 5: {
        const h24 = d.getHours();
        if ((this.rtcCtrl[2] & 0x04) !== 0) return Math.floor(h24 / 10);
        const h12 = h24 % 12 || 12;
        return (Math.floor(h12 / 10) & 0x01) | (h24 >= 12 ? 0x04 : 0);
      }
      case 6:
        return d.getDate() % 10;
      case 7:
        return Math.floor(d.getDate() / 10);
      case 8:
        return (d.getMonth() + 1) % 10;
      case 9:
        return Math.floor((d.getMonth() + 1) / 10);
      case 10:
        return (d.getFullYear() % 100) % 10;
      case 11:
        return Math.floor((d.getFullYear() % 100) / 10);
      case 12:
        return d.getDay();
      default:
        return 0;
    }
  }

  private writeRtcReg(reg: number, val: number): void {
    const v = val & 0x0f;
    if (reg >= 13) {
      this.rtcCtrl[reg - 13] = reg === 13 ? v & 0x0d : v;
    }
  }

  public read16(addr: number): number {
    const a = addr & 0x00fffffe;

    if (a < 0x200000) {
      if (this.ovl && a < 0x080000) {
        return (this.rom[a] << 8) | this.rom[a + 1];
      }
      if (a < this.chipRamSize) {
        return (this.chipRam[a] << 8) | this.chipRam[a + 1];
      }
      if (a < 0x100000) {
        const m = a & (this.chipRamSize - 1);
        return (this.chipRam[m] << 8) | this.chipRam[m + 1];
      }
      return 0xffff;
    }

    if (a >= 0xf80000) {
      const off = a - 0xf80000;
      return (this.rom[off] << 8) | this.rom[off + 1];
    }

    if (a >= 0xdff000 && a < 0xe00000) {
      return this.chipset.readReg16(a & 0x1fe);
    }

    if (a >= 0xc00000 && a < 0xc00000 + this.slowRamSize) {
      const off = a - 0xc00000;
      return (this.slowRam[off] << 8) | this.slowRam[off + 1];
    }

    if (this.fastRamSize > 0 && a >= 0x200000 && a < 0x200000 + this.fastRamSize) {
      const off = a - 0x200000;
      return (this.fastRam[off] << 8) | this.fastRam[off + 1];
    }

    if (a >= 0xe80000 && a < 0xf00000) {
      return this.hardfile ? this.hardfile.read16(a) : 0x0000;
    }

    return (this.read8(a) << 8) | this.read8(a + 1);
  }

  public read32(addr: number): number {
    const a = addr & 0x00fffffe;

    if (a < 0x200000) {
      if (this.ovl && a < 0x07fffd) {
        return (
          (this.rom[a] << 24) |
          (this.rom[a + 1] << 16) |
          (this.rom[a + 2] << 8) |
          this.rom[a + 3]
        );
      }
      if (a + 3 < this.chipRamSize) {
        return (
          (this.chipRam[a] << 24) |
          (this.chipRam[a + 1] << 16) |
          (this.chipRam[a + 2] << 8) |
          this.chipRam[a + 3]
        );
      }
    }

    if (a >= 0xf80000 && a <= 0xfffffc) {
      const off = a - 0xf80000;
      return (
        (this.rom[off] << 24) |
        (this.rom[off + 1] << 16) |
        (this.rom[off + 2] << 8) |
        this.rom[off + 3]
      );
    }

    return (this.read16(a) << 16) | this.read16((a + 2) & 0x00ffffff);
  }

  public write8(addr: number, val: number): void {
    const a = addr & 0x00ffffff;
    const v = val & 0xff;

    if (a < 0x200000) {
      if (this.ovl && a < 0x080000) return; // ROM is read-only during overlay
      if (a < this.chipRamSize) {
        this.chipRam[a] = v;
      } else if (a < 0x100000) {
        this.chipRam[a & (this.chipRamSize - 1)] = v;
      }
      return;
    }

    if (a >= 0xbfd000 && a < 0xbff000) {
      const reg = (a >>> 8) & 0x0f;
      if ((a & 0x1000) === 0 && (a & 1) === 1) {
        this.cia.writeA(reg, v);
      } else if ((a & 0x2000) === 0 && (a & 1) === 0) {
        this.cia.writeB(reg, v);
      }
      return;
    }

    if (a >= 0xdff000 && a < 0xe00000) {
      // Byte write to custom chip writes duplicated byte as word
      this.chipset.writeReg16(a & 0x1fe, (v << 8) | v);
      return;
    }

    if (a >= 0xc00000 && a < 0xc00000 + this.slowRamSize) {
      this.slowRam[a - 0xc00000] = v;
      return;
    }

    if (this.fastRamSize > 0 && a >= 0x200000 && a < 0x200000 + this.fastRamSize) {
      this.fastRam[a - 0x200000] = v;
      return;
    }

    if (a >= 0xdc0000 && a < 0xdd0000) {
      if ((a & 1) === 1) {
        this.writeRtcReg((a >>> 2) & 0x0f, v);
      }
      return;
    }

    if (a >= 0xe80000 && a < 0xe90000) {
      this.hardfile?.write8(a, v);
    }
  }

  public write16(addr: number, val: number): void {
    const a = addr & 0x00fffffe;
    const v = val & 0xffff;

    if (a < 0x200000) {
      if (this.ovl && a < 0x080000) return;
      if (a < this.chipRamSize) {
        this.chipRam[a] = (v >>> 8) & 0xff;
        this.chipRam[a + 1] = v & 0xff;
      } else if (a < 0x100000) {
        const m = a & (this.chipRamSize - 1);
        this.chipRam[m] = (v >>> 8) & 0xff;
        this.chipRam[m + 1] = v & 0xff;
      }
      return;
    }

    if (a >= 0xdff000 && a < 0xe00000) {
      this.chipset.writeReg16(a & 0x1fe, v);
      return;
    }

    if (a >= 0xc00000 && a < 0xc00000 + this.slowRamSize) {
      const off = a - 0xc00000;
      this.slowRam[off] = (v >>> 8) & 0xff;
      this.slowRam[off + 1] = v & 0xff;
      return;
    }

    if (this.fastRamSize > 0 && a >= 0x200000 && a < 0x200000 + this.fastRamSize) {
      const off = a - 0x200000;
      this.fastRam[off] = (v >>> 8) & 0xff;
      this.fastRam[off + 1] = v & 0xff;
      return;
    }

    if (a >= 0xe80000 && a < 0xe90000) {
      this.hardfile?.write16(a, v);
      return;
    }

    this.write8(a, (v >>> 8) & 0xff);
    this.write8(a + 1, v & 0xff);
  }

  public write32(addr: number, val: number): void {
    const a = addr & 0x00fffffe;

    if (a < 0x200000 && !(this.ovl && a < 0x080000) && a + 3 < this.chipRamSize) {
      this.chipRam[a] = (val >>> 24) & 0xff;
      this.chipRam[a + 1] = (val >>> 16) & 0xff;
      this.chipRam[a + 2] = (val >>> 8) & 0xff;
      this.chipRam[a + 3] = val & 0xff;
      return;
    }

    if (a >= 0xdff000 && a < 0xe00000) {
      this.chipset.writeReg16(a & 0x1fe, (val >>> 16) & 0xffff);
      this.chipset.writeReg16((a + 2) & 0x1fe, val & 0xffff);
      return;
    }

    this.write16(a, (val >>> 16) & 0xffff);
    this.write16((a + 2) & 0x00ffffff, val & 0xffff);
  }

  public dmaWriteBlock(destAddr: number, src: Uint8Array, srcOff: number, length: number): void {
    const a = destAddr & 0x00ffffff;
    if (!this.ovl && a + length <= this.chipRamSize) {
      this.chipRam.set(src.subarray(srcOff, srcOff + length), a);
      return;
    }
    if (this.slowRamSize > 0 && a >= 0xc00000 && a + length <= 0xc00000 + this.slowRamSize) {
      this.slowRam.set(src.subarray(srcOff, srcOff + length), a - 0xc00000);
      return;
    }
    if (this.fastRamSize > 0 && a >= 0x200000 && a + length <= 0x200000 + this.fastRamSize) {
      this.fastRam.set(src.subarray(srcOff, srcOff + length), a - 0x200000);
      return;
    }
    for (let i = 0; i < length; i++) {
      this.write8(a + i, src[srcOff + i]);
    }
  }

  public dmaReadBlock(srcAddr: number, dst: Uint8Array, dstOff: number, length: number): void {
    const a = srcAddr & 0x00ffffff;
    if (!this.ovl && a + length <= this.chipRamSize) {
      dst.set(this.chipRam.subarray(a, a + length), dstOff);
      return;
    }
    if (this.slowRamSize > 0 && a >= 0xc00000 && a + length <= 0xc00000 + this.slowRamSize) {
      dst.set(this.slowRam.subarray(a - 0xc00000, a - 0xc00000 + length), dstOff);
      return;
    }
    if (this.fastRamSize > 0 && a >= 0x200000 && a + length <= 0x200000 + this.fastRamSize) {
      dst.set(this.fastRam.subarray(a - 0x200000, a - 0x200000 + length), dstOff);
      return;
    }
    for (let i = 0; i < length; i++) {
      dst[dstOff + i] = this.read8(a + i);
    }
  }
}

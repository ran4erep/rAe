/**
 * Commodore Amiga 24-bit Address Bus & Memory Controller.
 * Maps:
 * - $000000 - $1FFFFF : Chip RAM (512KB / 1MB / 2MB) — overlaid with Kickstart ROM when CIA-A OVL=1!
 * - $200000 - $9FFFFF : Zorro II Fast RAM (optional 0 / 1MB / 2MB / 4MB / 8MB via Autoconfig)
 * - $BFD000 - $BFDF00 : CIA-B (even byte addresses)
 * - $BFE001 - $BFEF01 : CIA-A (odd byte addresses)
 * - $C00000 - $C7FFFF : Slow / Ranger RAM (optional 512KB A500 trapdoor expansion)
 * - $DA0000 - $DBFFFF : Gayle IDE stub on A1200/AGA (prevents Kickstart 3.x IDE hang)
 * - $DC0000 - $DCFFFF : Battery-backed RTC (MSM6242B stub for Kickstart/ECS)
 * - $DFF000 - $DFFFFF : Custom Chip Registers (Agnus/Alice, Denise/Lisa, Paula)
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

  // Zorro II Fast RAM Autoconfig state (0 = unconfigured, >0 = base address, done && 0 = shut up)
  public fastRamConfiguredBase = 0;
  private fastRamAutoconfigDone = false;
  private fastRamLatchLow = 0;

  // Motorola 68EC020 (Amiga 1200) bus & Gayle state
  public allowUnaligned = false;
  private gayleIdArmed = false;
  private gayleIdBit = 0;

  // Kickstart 1.3 (Exec V34) UserState() 68010/020 stack-frame compatibility patch state
  private rawRomLen = 0;
  private ks13UserStateOff = -1;
  private ks13Patched = false;
  private readonly ks13OrigUserState = new Uint8Array(26);
  private readonly ks13OrigChecksum = new Uint8Array(4);

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
    this.fastRamConfiguredBase = 0;
    this.fastRamAutoconfigDone = false;
    this.fastRamLatchLow = 0;
  }

  /**
   * Loads a 256 KB (Kickstart 1.2/1.3) or 512 KB (Kickstart 2.04/3.1/AROS) ROM image.
   * 256 KB ROMs are automatically mirrored across $F80000-$FBFFFF and $FC0000-$FFFFFF.
   */
  public loadRom(romBytes: Uint8Array): void {
    this.rom.fill(0);
    this.rawRomLen = romBytes.length <= 262144 ? 262144 : 524288;
    this.ks13UserStateOff = -1;
    this.ks13Patched = false;
    if (romBytes.length <= 256 * 1024) {
      // Mirror 256KB ROM into both halves so both $F80000 and $FC0000 map identically
      this.rom.set(romBytes, 0);
      this.rom.set(romBytes, 256 * 1024);
      this.detectKs13UserStateBug();
    } else {
      this.rom.set(romBytes.subarray(0, 512 * 1024), 0);
    }
  }

  private detectKs13UserStateBug(): void {
    // Exec V34 UserState(): calls Supervisor() while already in Supervisor mode,
    // popping only 2 bytes (SR) and jumping to the 68010/020 Format word ($0020) via RTS.
    const pat0 = 0x20, pat1 = 0x4d, pat2 = 0x4b, pat3 = 0xfa;
    const pat = [
      0x20, 0x4d, 0x4b, 0xfa, 0x00, 0x06, 0x4e, 0xee, 0xff, 0xe2,
      0x2a, 0x48, 0x32, 0x1f, 0x4e, 0x67, 0x2e, 0x40, 0x08, 0x81,
      0x00, 0x0d, 0x46, 0xc1, 0x4e, 0x75,
    ];
    const limit = 262144 - pat.length;
    for (let i = 0; i <= limit; i += 2) {
      if (this.rom[i] !== pat0 || this.rom[i + 1] !== pat1 || this.rom[i + 2] !== pat2 || this.rom[i + 3] !== pat3) {
        continue;
      }
      let match = true;
      for (let j = 4; j < pat.length; j++) {
        if (this.rom[i + j] !== pat[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        this.ks13UserStateOff = i;
        this.ks13OrigUserState.set(this.rom.subarray(i, i + 26));
        const cOff = 262144 - 0x18;
        this.ks13OrigChecksum.set(this.rom.subarray(cOff, cOff + 4));
        return;
      }
    }
  }

  public syncKickstart68020Compat(is68020: boolean): void {
    if (this.ks13UserStateOff < 0 || this.rawRomLen !== 262144) return;
    if (is68020 === this.ks13Patched) return;

    const off = this.ks13UserStateOff;
    const cOff = 262144 - 0x18;
    if (is68020) {
      // Safe 68010/020 UserState(): MOVE SR,D1; BCLR #13,D1; MOVE SP,USP; MOVE.L D0,SP; MOVE D1,SR; RTS; NOP x6
      const rep = [
        0x40, 0xc1, 0x08, 0x81, 0x00, 0x0d, 0x4e, 0x67, 0x2e, 0x40, 0x46, 0xc1, 0x4e, 0x75,
        0x4e, 0x71, 0x4e, 0x71, 0x4e, 0x71, 0x4e, 0x71, 0x4e, 0x71, 0x4e, 0x71,
      ];
      for (let j = 0; j < 26; j++) {
        this.rom[off + j] = rep[j];
      }
      // Preserve Kickstart 256KB end-around-carry checksum ($FFFFFFFF) at ROM_END - $18
      let sum = 0;
      for (let i = 0; i < 262144; i += 4) {
        if (i === cOff) continue;
        const w = ((this.rom[i] << 24) | (this.rom[i + 1] << 16) | (this.rom[i + 2] << 8) | this.rom[i + 3]) >>> 0;
        const next = sum + w;
        sum = (next >= 0x100000000 ? next - 0x100000000 + 1 : next) >>> 0;
      }
      const csum = (~sum) >>> 0;
      this.rom[cOff] = (csum >>> 24) & 0xff;
      this.rom[cOff + 1] = (csum >>> 16) & 0xff;
      this.rom[cOff + 2] = (csum >>> 8) & 0xff;
      this.rom[cOff + 3] = csum & 0xff;
      this.rom.set(this.rom.subarray(0, 262144), 262144);
      this.ks13Patched = true;
    } else {
      this.rom.set(this.ks13OrigUserState, off);
      this.rom.set(this.ks13OrigChecksum, cOff);
      this.rom.set(this.rom.subarray(0, 262144), 262144);
      this.ks13Patched = false;
    }
  }

  public clearRam(): void {
    this.chipRam.fill(0);
    this.slowRam.fill(0);
    this.fastRam.fill(0);
    this.fastRamConfiguredBase = 0;
    this.fastRamAutoconfigDone = false;
    this.fastRamLatchLow = 0;
    this.gayleIdArmed = false;
    this.gayleIdBit = 0;
  }

  private readFastRamAutoconfigByte(offset: number): number {
    if (this.fastRamSize <= 0 || this.fastRamAutoconfigDone) return 0x00;
    const reg = offset & 0xfe;
    let byteVal = 0;
    let invert = true;
    switch (reg) {
      case 0x00:
      case 0x02: {
        let sizeCode = 5; // 1MB
        if (this.fastRamSize >= 8 * 1024 * 1024) sizeCode = 0; // 8MB
        else if (this.fastRamSize >= 4 * 1024 * 1024) sizeCode = 7; // 4MB
        else if (this.fastRamSize >= 2 * 1024 * 1024) sizeCode = 6; // 2MB
        byteVal = 0xe0 | sizeCode; // ERT_ZORROII | ERTF_MEMLIST | sizeCode
        invert = false;
        break;
      }
      case 0x04:
      case 0x06:
        byteVal = 0x01; // er_Product
        break;
      case 0x08:
      case 0x0a:
        byteVal = 0x00; // er_Flags (RAM, can shut up)
        break;
      case 0x10:
      case 0x12:
        byteVal = 0x07; // er_Manufacturer hi ($07DB)
        break;
      case 0x14:
      case 0x16:
        byteVal = 0xdb; // er_Manufacturer lo
        break;
      case 0x24:
      case 0x26:
        byteVal = 0x02; // er_SerialNumber byte 3
        break;
      default:
        byteVal = 0x00;
        break;
    }
    const nibble = (reg & 2) === 0 ? (byteVal >>> 4) & 0x0f : byteVal & 0x0f;
    const outNibble = invert ? (~nibble) & 0x0f : nibble;
    return (outNibble << 4) | 0x0f;
  }

  private writeFastRamAutoconfigByte(offset: number, val: number): boolean {
    if (this.fastRamSize <= 0 || this.fastRamAutoconfigDone) return false;
    const reg = offset & 0xfe;
    if (reg === 0x4a) {
      this.fastRamLatchLow = (val >>> 4) & 0x0f;
    } else if (reg === 0x48) {
      const hi = val & 0xf0;
      const base = (hi | this.fastRamLatchLow) << 16;
      this.fastRamConfiguredBase = base > 0 ? base : 0x200000;
      this.fastRamAutoconfigDone = true;
    } else if (reg === 0x4c) {
      this.fastRamConfiguredBase = 0;
      this.fastRamAutoconfigDone = true;
    }
    return true;
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

    // Custom Chips ($DF0000 - $DFFFFF, 64KB bank mirrored every 512 bytes)
    if (a >= 0xdf0000 && a < 0xe00000) {
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

    // Fast RAM ($200000+ or Autoconfig base)
    if (this.fastRamSize > 0 && !(this.fastRamAutoconfigDone && this.fastRamConfiguredBase === 0)) {
      const fastBase = this.fastRamConfiguredBase > 0 ? this.fastRamConfiguredBase : 0x200000;
      if (a >= fastBase && a < fastBase + this.fastRamSize) {
        return this.fastRam[a - fastBase];
      }
    }

    // Real-time clock ($DC0000 - $DCFFFF: Oki MSM6242B on odd byte addresses)
    if (a >= 0xdc0000 && a < 0xdd0000) {
      return (a & 1) === 1 ? this.readRtcReg((a >>> 2) & 0x0f) : 0x00;
    }

    // Gayle IDE / ID on Amiga 1200 AGA ($DA0000-$DBFFFF & $DE0000-$DEFFFF)
    if (this.chipset.chipset === 'AGA') {
      if (a >= 0xde1000 && a < 0xde1002 && this.gayleIdArmed) {
        return this.gayleIdBit < 8 ? ((0xd0 << this.gayleIdBit++) & 0x80) : 0x00;
      }
      // IDE Status ($DA201C) / AltStatus ($DA3018): DRDY=1, BSY=0 (0x40) lets KS 3.1 scsi.device
      // immediately test Sector Count ($DA2010) and exit cleanly when no IDE drive is attached,
      // instead of sleeping 30 seconds waiting for drive spin-up on 0x00.
      if (a === 0xda201c || a === 0xda3018) {
        return 0x40;
      }
      if ((a >= 0xda0000 && a < 0xdc0000) || (a >= 0xde0000 && a < 0xdf0000)) {
        return 0x00;
      }
    }

    // Zorro II Autoconfig (Fast RAM first, then Hardfile) & Expansion ROM ($E80000 - $EFFFFF)
    if (a >= 0xe80000 && a < 0xf00000) {
      if (a < 0xe90000 && this.fastRamSize > 0 && !this.fastRamAutoconfigDone) {
        return (a & 1) === 0 ? this.readFastRamAutoconfigByte(a - 0xe80000) : 0xff;
      }
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
    if ((addr & 1) !== 0 && this.allowUnaligned) {
      return (this.read8(addr) << 8) | this.read8((addr + 1) & 0x00ffffff);
    }
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

    if (a >= 0xdf0000 && a < 0xe00000) {
      return this.chipset.readReg16(a & 0x1fe);
    }

    if (a >= 0xc00000 && a < 0xc00000 + this.slowRamSize) {
      const off = a - 0xc00000;
      return (this.slowRam[off] << 8) | this.slowRam[off + 1];
    }

    if (this.fastRamSize > 0 && !(this.fastRamAutoconfigDone && this.fastRamConfiguredBase === 0)) {
      const fastBase = this.fastRamConfiguredBase > 0 ? this.fastRamConfiguredBase : 0x200000;
      if (a >= fastBase && a < fastBase + this.fastRamSize) {
        const off = a - fastBase;
        return (this.fastRam[off] << 8) | this.fastRam[off + 1];
      }
    }

    if (this.chipset.chipset === 'AGA') {
      if (a === 0xde1000 && this.gayleIdArmed) {
        const b = this.gayleIdBit < 8 ? ((0xd0 << this.gayleIdBit++) & 0x80) : 0x00;
        return b << 8;
      }
      if (a === 0xda201c || a === 0xda3018) {
        return 0x4000;
      }
      if ((a >= 0xda0000 && a < 0xdc0000) || (a >= 0xde0000 && a < 0xdf0000)) {
        return 0x0000;
      }
    }

    if (a >= 0xe80000 && a < 0xf00000) {
      if (a < 0xe90000 && this.fastRamSize > 0 && !this.fastRamAutoconfigDone) {
        return (this.readFastRamAutoconfigByte(a - 0xe80000) << 8) | 0xff;
      }
      return this.hardfile ? this.hardfile.read16(a) : 0x0000;
    }

    return (this.read8(a) << 8) | this.read8(a + 1);
  }

  public read32(addr: number): number {
    if ((addr & 1) !== 0 && this.allowUnaligned) {
      return (
        (this.read8(addr) << 24) |
        (this.read8((addr + 1) & 0x00ffffff) << 16) |
        (this.read8((addr + 2) & 0x00ffffff) << 8) |
        this.read8((addr + 3) & 0x00ffffff)
      );
    }
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

    if (a >= 0xdf0000 && a < 0xe00000) {
      // Byte write to custom chip writes duplicated byte as word
      this.chipset.writeReg16(a & 0x1fe, (v << 8) | v);
      return;
    }

    if (a >= 0xc00000 && a < 0xc00000 + this.slowRamSize) {
      this.slowRam[a - 0xc00000] = v;
      return;
    }

    if (this.fastRamSize > 0 && !(this.fastRamAutoconfigDone && this.fastRamConfiguredBase === 0)) {
      const fastBase = this.fastRamConfiguredBase > 0 ? this.fastRamConfiguredBase : 0x200000;
      if (a >= fastBase && a < fastBase + this.fastRamSize) {
        this.fastRam[a - fastBase] = v;
        return;
      }
    }

    if (a >= 0xdc0000 && a < 0xdd0000) {
      if ((a & 1) === 1) {
        this.writeRtcReg((a >>> 2) & 0x0f, v);
      }
      return;
    }

    if (this.chipset.chipset === 'AGA' && a >= 0xde1000 && a < 0xde1002) {
      this.gayleIdArmed = true;
      this.gayleIdBit = 0;
      return;
    }

    if (a >= 0xe80000 && a < 0xe90000) {
      if (this.writeFastRamAutoconfigByte(a - 0xe80000, v)) {
        return;
      }
      this.hardfile?.write8(a, v);
    }
  }

  public write16(addr: number, val: number): void {
    const v = val & 0xffff;
    if ((addr & 1) !== 0 && this.allowUnaligned) {
      this.write8(addr, (v >>> 8) & 0xff);
      this.write8((addr + 1) & 0x00ffffff, v & 0xff);
      return;
    }
    const a = addr & 0x00fffffe;

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

    if (a >= 0xdf0000 && a < 0xe00000) {
      this.chipset.writeReg16(a & 0x1fe, v);
      return;
    }

    if (a >= 0xc00000 && a < 0xc00000 + this.slowRamSize) {
      const off = a - 0xc00000;
      this.slowRam[off] = (v >>> 8) & 0xff;
      this.slowRam[off + 1] = v & 0xff;
      return;
    }

    if (this.fastRamSize > 0 && !(this.fastRamAutoconfigDone && this.fastRamConfiguredBase === 0)) {
      const fastBase = this.fastRamConfiguredBase > 0 ? this.fastRamConfiguredBase : 0x200000;
      if (a >= fastBase && a < fastBase + this.fastRamSize) {
        const off = a - fastBase;
        this.fastRam[off] = (v >>> 8) & 0xff;
        this.fastRam[off + 1] = v & 0xff;
        return;
      }
    }

    if (a >= 0xe80000 && a < 0xe90000) {
      if (this.writeFastRamAutoconfigByte(a - 0xe80000, (v >>> 8) & 0xff)) {
        return;
      }
      this.hardfile?.write16(a, v);
      return;
    }

    if (this.chipset.chipset === 'AGA' && a === 0xde1000) {
      this.gayleIdArmed = true;
      this.gayleIdBit = 0;
      return;
    }

    this.write8(a, (v >>> 8) & 0xff);
    this.write8(a + 1, v & 0xff);
  }

  public write32(addr: number, val: number): void {
    if ((addr & 1) !== 0 && this.allowUnaligned) {
      this.write8(addr, (val >>> 24) & 0xff);
      this.write8((addr + 1) & 0x00ffffff, (val >>> 16) & 0xff);
      this.write8((addr + 2) & 0x00ffffff, (val >>> 8) & 0xff);
      this.write8((addr + 3) & 0x00ffffff, val & 0xff);
      return;
    }
    const a = addr & 0x00fffffe;

    if (a < 0x200000 && !(this.ovl && a < 0x080000) && a + 3 < this.chipRamSize) {
      this.chipRam[a] = (val >>> 24) & 0xff;
      this.chipRam[a + 1] = (val >>> 16) & 0xff;
      this.chipRam[a + 2] = (val >>> 8) & 0xff;
      this.chipRam[a + 3] = val & 0xff;
      return;
    }

    if (a >= 0xdf0000 && a < 0xe00000) {
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
    if (this.fastRamSize > 0 && !(this.fastRamAutoconfigDone && this.fastRamConfiguredBase === 0)) {
      const fastBase = this.fastRamConfiguredBase > 0 ? this.fastRamConfiguredBase : 0x200000;
      if (a >= fastBase && a + length <= fastBase + this.fastRamSize) {
        this.fastRam.set(src.subarray(srcOff, srcOff + length), a - fastBase);
        return;
      }
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
    if (this.fastRamSize > 0 && !(this.fastRamAutoconfigDone && this.fastRamConfiguredBase === 0)) {
      const fastBase = this.fastRamConfiguredBase > 0 ? this.fastRamConfiguredBase : 0x200000;
      if (a >= fastBase && a + length <= fastBase + this.fastRamSize) {
        dst.set(this.fastRam.subarray(a - fastBase, a - fastBase + length), dstOff);
        return;
      }
    }
    for (let i = 0; i < length; i++) {
      dst[dstOff + i] = this.read8(a + i);
    }
  }

  /**
   * Side-effect-free memory read for debug inspection (never alters CIA ICR, RTC, or chipset state).
   */
  public peek8(addr: number): number {
    const a = addr & 0x00ffffff;
    if (a < 0x200000) {
      if (this.ovl && a < 0x080000) return this.rom[a];
      if (a < this.chipRamSize) return this.chipRam[a];
      if (a < 0x100000) return this.chipRam[a & (this.chipRamSize - 1)];
      return 0xff;
    }
    if (a >= 0xf80000) {
      return this.rom[a - 0xf80000];
    }
    if (a >= 0xc00000 && a < 0xc00000 + this.slowRamSize) {
      return this.slowRam[a - 0xc00000];
    }
    if (this.fastRamSize > 0 && !(this.fastRamAutoconfigDone && this.fastRamConfiguredBase === 0)) {
      const fastBase = this.fastRamConfiguredBase > 0 ? this.fastRamConfiguredBase : 0x200000;
      if (a >= fastBase && a < fastBase + this.fastRamSize) {
        return this.fastRam[a - fastBase];
      }
    }
    if (a >= 0xdf0000 && a < 0xe00000) {
      const w = this.chipset.regs[(a & 0x1fe) >>> 1];
      return (a & 1) === 0 ? (w >>> 8) & 0xff : w & 0xff;
    }
    if (this.chipset.chipset === 'AGA' && ((a >= 0xda0000 && a < 0xdc0000) || (a >= 0xde0000 && a < 0xdf0000))) {
      return a === 0xda201c || a === 0xda3018 ? 0x40 : 0x00;
    }
    if (a >= 0xe80000 && a < 0xf00000 && this.hardfile) {
      return this.hardfile.peekRomByte(a);
    }
    return 0xff;
  }

  public peek16(addr: number): number {
    const a = addr & 0x00fffffe;
    return ((this.peek8(a) << 8) | this.peek8((a + 1) & 0x00ffffff)) & 0xffff;
  }

  public peek32(addr: number): number {
    const a = addr & 0x00fffffe;
    return (((this.peek16(a) << 16) | this.peek16((a + 2) & 0x00ffffff)) >>> 0);
  }
}

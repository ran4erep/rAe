/**
 * Top-Level Commodore Amiga OCS/ECS System Orchestrator.
 * Connects M68000 CPU, 24-bit Bus, CIA-A/CIA-B, OCS/ECS Agnus/Denise/Paula,
 * DF0:/DF1: MFM Floppy Drives, Paula Audio Engine, and OpenKick ROM.
 */

import {
  AmigaConfig,
  AmigaStatusSnapshot,
  DEFAULT_AMIGA_CONFIG,
  JoystickState,
  NTSC_FPS,
  NTSC_LINES,
  PAL_FPS,
  PAL_LINES,
  SaveSlotDiskPayload,
  SerializedAmigaState,
} from '../types';
import { M68000 } from '../cpu/m68k';
import { AMIGA_RAW } from '../keyboard/amigaKeyMap';
import { AmigaCIA } from './cia';
import { AmigaChipset, INT_EXTER, INT_PORTS, INT_VERTB } from './chipset';
import { FloppyController, verifyAmigaBootblockChecksum } from './floppy';
import { FloppyAudioEngine } from './floppyAudio';
import { HardfileController } from './hardfile';
import { AmigaMemory } from './memory';
import { PaulaAudioEngine } from './audio';
import { createBlankFormattedHdf, resizeAmigaDosHdf } from '../archives/amigaDosFs';
import { buildBuiltinAdf, buildOpenKickRom, BUILTIN_DISK_CATALOG, OpenKickRuntime } from '../roms/openKickKernel';

const PAL_CYCLES_PER_SCANLINE = 454;  // 227 CCK = 454 CPU cycles = 45.4 E-clocks
const NTSC_CYCLES_PER_SCANLINE = 455; // 227.5 CCK = 455 CPU cycles = 45.5 E-clocks

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64');
}

function base64ToUint8(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

export class AmigaMachine {
  public config: AmigaConfig;
  public readonly floppy: FloppyController;
  public readonly hardfile: HardfileController;
  public readonly cia: AmigaCIA;
  public readonly chipset: AmigaChipset;
  public readonly memory: AmigaMemory;
  public readonly cpu: M68000;
  public readonly audio: PaulaAudioEngine;
  public readonly floppyAudio: FloppyAudioEngine;
  public readonly openKick: OpenKickRuntime;

  public romName = 'OpenKick 1.3 OCS/ECS (Встроенный)';
  public isOpenKick = true;
  public paused = false;
  public frameCount = 0;
  public measuredFps = 50;
  public cpuUsageHint = 4;

  private powerLed = true;
  private mouseLeft = false;
  private lastKeyCode: number | null = null;
  private capsLock = false;
  private ctrlHeld = false;
  private lAmigaHeld = false;
  private rAmigaHeld = false;
  private lastReportedMotor: [boolean, boolean] = [false, false];
  private saveStateInsertedDrives: [boolean, boolean] = [false, false];
  private eClockAccum = 0;

  constructor(
    initialConfig: Partial<AmigaConfig> = {},
    options: { skipDefaultDisk?: boolean } = {}
  ) {
    this.config = { ...DEFAULT_AMIGA_CONFIG, ...initialConfig };
    this.floppy = new FloppyController();
    this.hardfile = new HardfileController();
    this.audio = new PaulaAudioEngine();
    this.audio.setEnabled(this.config.audioEnabled);
    this.audio.setVolume(this.config.audioVolume);
    this.audio.setLedFilter(this.config.audioLedFilter && this.powerLed);
    this.floppyAudio = new FloppyAudioEngine();
    this.floppyAudio.setEnabled(this.config.floppyAudioEnabled);
    this.floppyAudio.setGlobalAudioEnabled(this.config.audioEnabled);
    this.floppyAudio.setVolume(this.config.audioVolume);
    this.audio.setOnContextReady((ctx) => this.floppyAudio.attachContext(ctx));
    this.floppy.soundCallbacks = {
      onInsert: (d, ins) => this.floppyAudio.handleInsert(d, ins),
      onStep: (d, cyl) => this.floppyAudio.handleStep(d, cyl),
      onReset: (d0, d1) => {
        this.lastReportedMotor[0] = false;
        this.lastReportedMotor[1] = false;
        this.floppyAudio.handleReset(d0, d1);
      },
    };
    this.openKick = new OpenKickRuntime();

    // Allocate initial Chip RAM and construct connected chips
    const initialChipRam = new Uint8Array(this.config.chipRamKB * 1024);

    let cpuRef: M68000 | null = null;
    this.chipset = new AmigaChipset(initialChipRam, this.floppy, (ipl) => {
      if (cpuRef) cpuRef.pendingIpl = ipl;
    });
    this.chipset.chipset = this.config.chipset;
    this.chipset.turboFloppy = this.config.turboFloppy;
    this.floppy.turboFloppy = this.config.turboFloppy;
    this.chipset.setOverscanConfig(this.config.overscan, this.config.videoStandard, true);

    this.cia = new AmigaCIA({
      onOvlChange: (ovl) => {
        if (this.memory) this.memory.ovl = ovl;
      },
      onPowerLedChange: (on) => {
        this.powerLed = on;
        this.audio.setLedFilter(this.config.audioLedFilter && on);
      },
      onIrqA: () => {
        this.chipset.requestIrq(INT_PORTS);
      },
      onIrqB: () => {
        this.chipset.requestIrq(INT_EXTER);
      },
      onFloppyControl: (prb, prevPrb) => {
        this.floppy.handleCiaBPrb(prb, prevPrb);
      },
      getFloppyStatus: () => this.floppy.getCiaAStatusBits(),
      getFireButtons: () => {
        let bits = 0xc0; // Active low: bit 6 = Mouse LMB, bit 7 = Joy2 Fire1
        if (this.mouseLeft) bits &= ~0x40;
        if (this.config.joystickConnected && this.chipset.joy1.fire1) bits &= ~0x80;
        return bits;
      },
    });

    this.memory = new AmigaMemory(
      this.config.chipRamKB,
      this.config.slowRamKB,
      this.config.fastRamKB,
      this.cia,
      this.chipset
    );
    // Sync chipset & hardfile controller to memory
    this.chipset.attachChipRam(this.memory.chipRam);
    this.memory.hardfile = this.hardfile;

    this.cpu = new M68000(this.memory);
    cpuRef = this.cpu;

    // Hook 68000 RESET instruction & Expansion/OpenKick Line-A kernel calls
    this.memory.onResetInstruction = () => {
      this.cia.reset();
      this.chipset.reset();
      this.floppy.reset();
      this.hardfile.reset();
    };
    this.memory.onLineA = (opcode, cpu) => {
      if ((opcode & 0xff00) === 0xa100) {
        return this.hardfile.handleLineA(opcode, cpu, this.memory);
      }
      if (!this.isOpenKick) return false;
      const fn = opcode & 0x0fff;
      if (fn === 0x000) {
        this.openKick.boot(this.chipset, this.memory.chipRam, this.floppy);
        return true;
      }
      if (fn === 0x001) {
        this.openKick.stepFrame(
          this.chipset,
          this.memory.chipRam,
          this.config.joystickConnected && this.chipset.joy1.fire1,
          this.mouseLeft
        );
        return true;
      }
      if (fn === 0x002) {
        this.openKick.handleKeyByte(cpu.d[0] & 0xff, this.chipset, this.memory.chipRam);
        return true;
      }
      return false;
    };

    // Load OpenKick ROM (and optional default Boing demo disk for standalone tests)
    this.memory.loadRom(buildOpenKickRom());
    if (!options.skipDefaultDisk) {
      this.insertBuiltinDisk(0, 'boing_studio', false);
    }
    this.hardReset();
  }

  public getFramebuffer(): Uint32Array {
    return this.chipset.framebuffer;
  }

  public getFramebufferSize(): { width: number; height: number } {
    return { width: this.chipset.fbWidth, height: this.chipset.fbHeight };
  }

  private ejectSaveStateDisksOnReset(): void {
    for (let i = 0; i < 2; i++) {
      if (this.saveStateInsertedDrives[i]) {
        this.floppy.drives[i].eject();
        this.saveStateInsertedDrives[i] = false;
      }
    }
  }

  public hardReset(): void {
    this.ejectSaveStateDisksOnReset();
    this.memory.clearRam();
    this.memory.ovl = true;
    this.floppy.reset();
    this.hardfile.reset();
    this.cia.reset();
    this.chipset.reset();
    this.chipset.chipset = this.config.chipset;
    this.chipset.turboFloppy = this.config.turboFloppy;
    this.floppy.turboFloppy = this.config.turboFloppy;
    this.chipset.setOverscanConfig(this.config.overscan, this.config.videoStandard, true);
    this.chipset.joy1Connected = this.config.joystickConnected;
    this.openKick.reset();
    this.audio.resetSchedule();
    this.capsLock = false;
    this.eClockAccum = 0;
    this.cpu.reset();
    this.frameCount = 0;
  }

  public warmReset(): void {
    this.ejectSaveStateDisksOnReset();
    this.memory.ovl = true;
    this.hardfile.reset();
    this.cia.reset();
    this.chipset.reset();
    this.chipset.chipset = this.config.chipset;
    this.chipset.turboFloppy = this.config.turboFloppy;
    this.floppy.turboFloppy = this.config.turboFloppy;
    this.chipset.setOverscanConfig(this.config.overscan, this.config.videoStandard, true);
    this.chipset.joy1Connected = this.config.joystickConnected;
    this.audio.resetSchedule();
    this.eClockAccum = 0;
    this.cpu.reset();
  }

  public updateConfig(patch: Partial<AmigaConfig>, rebootIfHardwareChanged = true): void {
    const prev = this.config;
    const nextVolume =
      patch.audioVolume !== undefined
        ? Math.max(0, Math.min(1, patch.audioVolume))
        : (this.config.audioVolume ?? DEFAULT_AMIGA_CONFIG.audioVolume);
    this.config = { ...this.config, ...patch, audioVolume: nextVolume };
    this.chipset.chipset = this.config.chipset;
    this.chipset.turboFloppy = this.config.turboFloppy;
    this.floppy.turboFloppy = this.config.turboFloppy;
    this.chipset.setOverscanConfig(this.config.overscan, this.config.videoStandard);
    this.chipset.joy1Connected = this.config.joystickConnected;
    if (!this.config.joystickConnected) {
      this.chipset.joy1.up = false;
      this.chipset.joy1.down = false;
      this.chipset.joy1.left = false;
      this.chipset.joy1.right = false;
      this.chipset.joy1.fire1 = false;
      this.chipset.joy1.fire2 = false;
    }
    this.audio.setEnabled(this.config.audioEnabled);
    this.audio.setVolume(this.config.audioVolume);
    this.audio.setLedFilter(this.config.audioLedFilter && this.powerLed);
    this.floppyAudio.setGlobalAudioEnabled(this.config.audioEnabled);
    this.floppyAudio.setEnabled(this.config.floppyAudioEnabled);
    this.floppyAudio.setVolume(this.config.audioVolume);

    const ramChanged =
      prev.chipRamKB !== this.config.chipRamKB ||
      prev.slowRamKB !== this.config.slowRamKB ||
      prev.fastRamKB !== this.config.fastRamKB;
    const hwChanged = ramChanged || prev.chipset !== this.config.chipset;

    if (ramChanged) {
      this.memory.reconfigureRam(
        this.config.chipRamKB,
        this.config.slowRamKB,
        this.config.fastRamKB
      );
    }
    if (hwChanged && rebootIfHardwareChanged) {
      this.hardReset();
    }
  }

  /**
   * Loads a real user Kickstart ROM (256 KB Kickstart 1.2/1.3 or 512 KB Kickstart 2.04/3.1/AROS).
   */
  public loadCustomRom(bytes: Uint8Array, name: string): { ok: boolean; error?: string } {
    const validSizes = [262144, 524288];
    if (!validSizes.includes(bytes.length)) {
      return {
        ok: false,
        error: `Неверный размер ROM (${Math.round(bytes.length / 1024)} КБ). Нужен Kickstart 256 КБ или 512 КБ.`,
      };
    }
    this.memory.loadRom(bytes);
    this.romName = name;
    this.isOpenKick = false;
    // Automatically eject built-in OpenKick demo disks so real Kickstart boots cleanly
    // (real Kickstart 1.3 would crash trying to execute an OpenKick-specific demo disk).
    const builtinNames = new Set(BUILTIN_DISK_CATALOG.map((d) => `${d.id}.adf`));
    for (const drive of this.floppy.drives) {
      if (drive.data && builtinNames.has(drive.name)) {
        drive.eject();
      }
    }
    this.hardReset();
    return { ok: true };
  }

  public loadOpenKickRom(): void {
    this.memory.loadRom(buildOpenKickRom());
    this.romName = 'OpenKick 1.3 OCS/ECS (Встроенный)';
    this.isOpenKick = true;
    this.hardReset();
  }

  public insertBuiltinDisk(driveIdx: 0 | 1, diskId: string, resetAfter = true): void {
    const adf = buildBuiltinAdf(diskId);
    this.floppy.drives[driveIdx].insert(adf, `${diskId}.adf`, false);
    this.saveStateInsertedDrives[driveIdx] = false;
    if (!this.isOpenKick) {
      this.memory.loadRom(buildOpenKickRom());
      this.romName = 'OpenKick 1.3 OCS/ECS (Встроенный)';
      this.isOpenKick = true;
      if (resetAfter) this.hardReset();
      return;
    }
    if (driveIdx === 0 && resetAfter) {
      this.warmReset();
    }
  }

  public shouldHintResetForDf0Boot(bytes: Uint8Array): boolean {
    if (!verifyAmigaBootblockChecksum(bytes)) return false;
    if (this.hardfile.hasAnyReadSinceReset()) return true;
    return !this.isOpenKick && this.hardfile.isMounted() && !this.floppy.drives[0].data;
  }

  public insertAdf(driveIdx: 0 | 1, bytes: Uint8Array, name: string, resetIfDf0 = false): { ok: boolean; error?: string } {
    if (bytes.length < 1024 || bytes.length > 1802240) {
      return {
        ok: false,
        error: `Файл "${name}" не похож на образ ADF (ожидается ~880 КБ).`,
      };
    }
    const hotSwap = !resetIfDf0;
    this.floppy.drives[driveIdx].insert(bytes, name, hotSwap);
    this.saveStateInsertedDrives[driveIdx] = false;
    if (driveIdx === 0 && resetIfDf0) {
      this.warmReset();
    }
    return { ok: true };
  }

  public insertBlankAdf(driveIdx: 0 | 1, name?: string): string {
    const diskName = name ?? (driveIdx === 0 ? 'SaveDisk.adf' : 'SaveDisk_DF1.adf');
    this.floppy.drives[driveIdx].insertBlankDisk(diskName, 'SaveDisk', true);
    this.saveStateInsertedDrives[driveIdx] = false;
    return diskName;
  }

  public exportDriveAdf(driveIdx: 0 | 1): { name: string; bytes: Uint8Array } | null {
    const d = this.floppy.drives[driveIdx];
    if (!d.data) return null;
    return {
      name: d.name || `DF${driveIdx}.adf`,
      bytes: new Uint8Array(d.data),
    };
  }

  public ejectDisk(driveIdx: 0 | 1): void {
    this.floppy.drives[driveIdx].eject();
    this.saveStateInsertedDrives[driveIdx] = false;
    if (driveIdx === 0 && this.isOpenKick) {
      this.warmReset();
    }
  }

  public mountHdf(
    bytes: Uint8Array,
    name: string,
    resetAfter = true,
    unit: 0 | 1 = 0
  ): { ok: boolean; warning?: string; error?: string } {
    try {
      this.hardfile.mountUnit(unit, bytes, name, false);
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Ошибка монтирования HDF.',
      };
    }

    let warning: string | undefined;
    const slot = this.hardfile.units[unit];
    const primary = slot.partitions[0];
    if (!this.isOpenKick && primary && primary.dosType !== 0x444f5300 && !slot.isRdb) {
      // Check Kickstart version at ROM offset 12..13
      const ksVer = (this.memory.rom[12] << 8) | this.memory.rom[13];
      if (ksVer > 0 && ksVer < 36) {
        warning = `Раздел ${primary.dosTypeStr} может требовать Kickstart 2.04+/3.1 (активен KS ${ksVer}).`;
      }
    }

    if (resetAfter) {
      this.hardReset();
    }
    return { ok: true, warning };
  }

  public mountBlankHdf(
    sizeMB = 2,
    name?: string,
    resetAfter = true,
    unit: 0 | 1 = 0
  ): string {
    const volName = unit === 1 ? 'GamesHD' : 'WorkHD';
    const fileName = name ?? `${volName}.hdf`;
    const hdf = createBlankFormattedHdf(sizeMB, volName);
    this.hardfile.mountUnit(unit, hdf, fileName, false);
    if (resetAfter) {
      this.hardReset();
    }
    return fileName;
  }

  public resizeHdf(
    newSizeMB: number,
    resetAfter = true,
    unit: 0 | 1 = 0
  ): { ok: boolean; minSizeMB?: number; error?: string } {
    const slot = this.hardfile.units[unit];
    if (!slot.data) {
      return { ok: false, error: `Жёсткий диск DH${unit}: не подключён.` };
    }
    const currentName = slot.name || (unit === 1 ? 'GamesHD.hdf' : 'WorkHD.hdf');
    const writeProt = slot.writeProtected;
    const res = resizeAmigaDosHdf(slot.data, newSizeMB);
    if (!res.ok || !res.bytes) {
      return { ok: false, minSizeMB: res.minSizeMB, error: res.error };
    }
    this.hardfile.mountUnit(unit, res.bytes, currentName, writeProt);
    if (resetAfter) {
      this.hardReset();
    }
    return { ok: true, minSizeMB: res.minSizeMB };
  }

  public exportHdf(unit: 0 | 1 = 0): { name: string; bytes: Uint8Array } | null {
    return this.hardfile.exportUnitBytes(unit);
  }

  public ejectHdf(resetAfter = true, unit: 0 | 1 = 0): void {
    this.hardfile.ejectUnit(unit);
    if (resetAfter) {
      this.hardReset();
    }
  }

  /**
   * Sends a real Amiga raw key event ($00-$67) through CIA-A serial shift register & IRQ2.
   * Detects authentic Amiga three-key warm reset: Ctrl + Left Amiga + Right Amiga!
   */
  public setKey(rawCode: number, isDown: boolean): void {
    const code = rawCode & 0x7f;
    if (isDown) this.lastKeyCode = code;

    if (code === AMIGA_RAW.CAPSLOCK) {
      if (!isDown) return;
      this.capsLock = !this.capsLock;
      if (this.isOpenKick) {
        // OpenKick toggles internal Caps Lock on keydown
        this.cia.enqueueKey(code, false);
      } else {
        // Real Amiga A500 keyboard hardware latches Caps Lock: sends DOWN when turning ON, UP when turning OFF
        this.cia.enqueueKey(code, !this.capsLock);
      }
      return;
    }

    if (code === AMIGA_RAW.CTRL) this.ctrlHeld = isDown;
    if (code === AMIGA_RAW.LAMIGA) this.lAmigaHeld = isDown;
    if (code === AMIGA_RAW.RAMIGA) this.rAmigaHeld = isDown;

    if (this.ctrlHeld && this.lAmigaHeld && this.rAmigaHeld) {
      this.ctrlHeld = false;
      this.lAmigaHeld = false;
      this.rAmigaHeld = false;
      this.warmReset();
      return;
    }

    this.cia.enqueueKey(code, !isDown);
  }

  public setJoystick(patch: Partial<JoystickState>): void {
    if (!this.config.joystickConnected) return;
    Object.assign(this.chipset.joy1, patch);
  }

  public moveMouse(dx: number, dy: number): void {
    this.chipset.mouseX = (this.chipset.mouseX + Math.round(dx)) & 0xff;
    this.chipset.mouseY = (this.chipset.mouseY + Math.round(dy)) & 0xff;
  }

  public setMouseButtons(left?: boolean, right?: boolean, middle?: boolean): void {
    if (left !== undefined) this.mouseLeft = left;
    if (right !== undefined) this.chipset.mouseRight = right;
    if (middle !== undefined) this.chipset.mouseMiddle = middle;
  }

  /**
   * Executes one complete PAL (313/312 lines) or NTSC (263/262 lines) Amiga video frame.
   * When `renderVideo` is false (frameskip), Denise pixel rendering is skipped to save host CPU!
   */
  public stepFrame(renderVideo = true, pushAudio = true): void {
    const chipset = this.chipset;
    const cpu = this.cpu;
    const cia = this.cia;
    const floppy = this.floppy;

    chipset.startFrame();

    const isPal = chipset.isPalTiming();
    const totalLines = (isPal ? PAL_LINES : NTSC_LINES) + (chipset.lof & 1);
    const cpuCyclesPerLine = this.config.ecoCpuMode
      ? 240
      : (isPal ? PAL_CYCLES_PER_SCANLINE : NTSC_CYCLES_PER_SCANLINE);
    const eFrac = isPal ? 4 : 5;
    let eAccum = this.eClockAccum;
    const spriteHeaderLine = isPal ? 25 : 20;
    const diskDmaWords = this.config.turboFloppy ? 0x4000 : 4;

    // Line 0: trigger VBlank interrupt & CIA-A TOD VSync
    cia.onVSync();
    chipset.requestIrq(INT_VERTB);

    for (let line = 0; line < totalLines; line++) {
      chipset.vpos = line;
      chipset.hpos = 0;

      // Phase 1 Copper: execute visible-span Copper moves up to $DB before scanline display,
      // while deferring end-of-line modulo resets (e.g. $DC after DDFSTOP=$D8) and HBlank waits ($E0/$DF) to Phase 2
      chipset.runCopperLine(line, 0xdb);

      // Authentic Agnus sprite DMA header fetch after VBlank Copper loads SPRxPTH/L
      if (line === spriteHeaderLine) {
        chipset.fetchSpriteHeaders();
      }

      // Advance floppy /RDY spin-up timer & Paula Disk DMA
      floppy.tickScanline();
      chipset.stepDiskDma(diskDmaWords);

      // Run Motorola 68000 CPU slice for this scanline
      cpu.runCycles(cpuCyclesPerLine);

      // Step CIA-A & CIA-B fractional E-clock timers (45.4 PAL / 45.5 NTSC) and HSync TOD
      eAccum += eFrac;
      let eTicks = 45;
      if (eAccum >= 10) {
        eAccum -= 10;
        eTicks = 46;
      }
      cia.stepEClocks(eTicks);
      cia.onHSync();

      // Render visible scanline via Denise OCS/ECS (advances BPLxPT even when skipping pixels)
      chipset.renderScanline(line, renderVideo);

      // Phase 2 Copper: execute HBlank waits/moves (e.g. $E7DF HUD split, $FFE1 PAL wrap) after scanline display
      chipset.runCopperLine(line, 0xfe);
    }

    this.eClockAccum = eAccum;
    chipset.finishFrame();

    // Sync floppy motor audio & decay LED I/O pulse once per frame
    for (let i = 0; i < 2; i++) {
      const d = this.floppy.drives[i];
      if (d.ioPulseFrames > 0) d.ioPulseFrames--;
      const run = d.motorOn;
      if (run !== this.lastReportedMotor[i]) {
        this.lastReportedMotor[i] = run;
        this.floppyAudio.handleMotor(i, run);
      }
    }
    if (this.hardfile.units[0].ioPulseFrames > 0) {
      this.hardfile.units[0].ioPulseFrames--;
    }
    if (this.hardfile.units[1].ioPulseFrames > 0) {
      this.hardfile.units[1].ioPulseFrames--;
    }

    // Trigger floppy index pulse once per revolution (~5Hz, or every frame in Turbo mode) when any drive is spinning
    const indexEvery = this.config.turboFloppy ? 1 : 10;
    if ((this.frameCount % indexEvery) === 0 && (this.floppy.drives[0].motorOn || this.floppy.drives[1].motorOn)) {
      cia.triggerDiskIndex();
    }

    // Push 20ms Paula DMA audio frame (auto-skips if muted, idle, or turbo-warped -> 0% CPU)
    if (pushAudio && this.config.audioEnabled) {
      this.audio.pushFrame(chipset, this.memory.chipRam);
    }

    this.memory.advanceRtcMs(isPal ? 1000 / PAL_FPS : 1000 / NTSC_FPS);
    this.frameCount++;
  }

  public getStatusSnapshot(): AmigaStatusSnapshot {
    return {
      running: !this.paused,
      paused: this.paused,
      fps: this.measuredFps,
      cpuUsageHint: this.cpuUsageHint,
      chipset: this.config.chipset,
      videoStandard: this.config.videoStandard,
      romName: this.romName,
      isOpenKick: this.isOpenKick,
      powerLed: this.powerLed,
      capsLock: this.isOpenKick ? this.openKick.getCapsLock() : this.capsLock,
      df0: this.floppy.drives[0].getStatus(),
      df1: this.floppy.drives[1].getStatus(),
      dh0: this.hardfile.getUnitStatus(0),
      dh1: this.hardfile.getUnitStatus(1),
      pc: this.cpu.pc,
      frameCount: this.frameCount,
      lastKeyCode: this.openKick.getLastKeyCode() ?? this.lastKeyCode,
    };
  }

  public saveState(): SerializedAmigaState {
    const cpuRegs: number[] = [];
    for (let i = 0; i < 8; i++) cpuRegs.push(this.cpu.d[i]);
    for (let i = 0; i < 8; i++) cpuRegs.push(this.cpu.a[i]);

    return {
      version: 1,
      timestamp: Date.now(),
      config: { ...this.config },
      romName: this.romName,
      df0Name: this.floppy.drives[0].name,
      df1Name: this.floppy.drives[1].name,
      df0State: this.floppy.drives[0].getDriveSnapshot(),
      df1State: this.floppy.drives[1].getDriveSnapshot(),
      cpuRegs,
      usp: this.cpu.usp,
      ssp: this.cpu.ssp,
      pc: this.cpu.pc,
      sr: this.cpu.sr,
      stopped: this.cpu.stopped,
      chipRamBase64: uint8ToBase64(this.memory.chipRam),
      slowRamBase64: uint8ToBase64(this.memory.slowRam),
      customRegs: this.chipset.serializeRegs(),
      ciaA: this.cia.serializeA(),
      ciaB: this.cia.serializeB(),
    };
  }

  public loadState(state: SerializedAmigaState): boolean {
    if (!state || state.version !== 1) return false;
    this.updateConfig(
      {
        ...DEFAULT_AMIGA_CONFIG,
        ...state.config,
        overscan: state.config?.overscan ?? this.config.overscan,
        turboFloppy: state.config?.turboFloppy ?? this.config.turboFloppy,
      },
      false
    );
    const chipBytes = base64ToUint8(state.chipRamBase64);
    this.memory.chipRam.set(chipBytes.subarray(0, this.memory.chipRam.length));
    if (state.slowRamBase64 && this.memory.slowRam.length > 0) {
      const slowBytes = base64ToUint8(state.slowRamBase64);
      this.memory.slowRam.set(slowBytes.subarray(0, this.memory.slowRam.length));
    }
    for (let i = 0; i < 8; i++) {
      this.cpu.d[i] = state.cpuRegs[i] | 0;
      this.cpu.a[i] = state.cpuRegs[8 + i] | 0;
    }
    this.cpu.usp = state.usp | 0;
    this.cpu.ssp = state.ssp | 0;
    this.cpu.pc = state.pc & 0x00ffffff;
    this.cpu.sr = state.sr & 0xa71f;
    this.cpu.stopped = Boolean(state.stopped);
    this.chipset.deserializeRegs(state.customRegs);
    this.cia.deserializeA(state.ciaA);
    this.cia.deserializeB(state.ciaB);
    return true;
  }

  public exportSaveBundle(): {
    state: SerializedAmigaState;
    df0Disk: SaveSlotDiskPayload | null;
    df1Disk: SaveSlotDiskPayload | null;
  } {
    const state = this.saveState();
    const d0 = this.floppy.drives[0];
    const d1 = this.floppy.drives[1];
    return {
      state,
      df0Disk: d0.data ? { name: d0.name, bytes: new Uint8Array(d0.data) } : null,
      df1Disk: d1.data ? { name: d1.name, bytes: new Uint8Array(d1.data) } : null,
    };
  }

  public loadSaveBundle(
    state: SerializedAmigaState,
    df0Disk: SaveSlotDiskPayload | null,
    df1Disk: SaveSlotDiskPayload | null
  ): boolean {
    if (!this.loadState(state)) return false;
    this.floppy.drives[0].restoreSnapshot(
      state.df0State,
      df0Disk?.bytes ?? null,
      df0Disk?.name ?? state.df0Name
    );
    this.floppy.drives[1].restoreSnapshot(
      state.df1State,
      df1Disk?.bytes ?? null,
      df1Disk?.name ?? state.df1Name
    );
    this.saveStateInsertedDrives[0] = this.floppy.drives[0].data !== null;
    this.saveStateInsertedDrives[1] = this.floppy.drives[1].data !== null;
    return true;
  }

  public dispose(): void {
    this.audio.dispose();
  }
}

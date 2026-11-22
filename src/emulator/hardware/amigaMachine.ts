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
  ResolvedVideoStandard,
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
import { computeCpuCyclesPerScanline } from './cpuOverclock';
import { AmigaMemory } from './memory';
import { PaulaAudioEngine } from './audio';
import { createBlankFormattedHdf, resizeAmigaDosHdf } from '../archives/amigaDosFs';
import { buildBuiltinAdf, buildOpenKickRom, BUILTIN_DISK_CATALOG, OpenKickRuntime } from '../roms/openKickKernel';

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

export type AutoVideoStandardReason = 'deadlock' | 'diw' | 'copper' | 'beamcon0' | 'disk-tag';

const NTSC_TAG_RE = /(?:^|[\s([_.-])(ntsc|usa|us)(?:$|[\s)\]_.-])/i;
const PAL_TAG_RE = /(?:^|[\s([_.-])(pal|eur|europe|uk)(?:$|[\s)\]_.-])/i;

export function detectVideoStandardFromName(name: string): ResolvedVideoStandard | null {
  if (!name) return null;
  if (NTSC_TAG_RE.test(name)) return 'NTSC';
  if (PAL_TAG_RE.test(name)) return 'PAL';
  return null;
}

function extractAdfVolumeLabel(bytes: Uint8Array): string {
  if (bytes.length < 901120) return '';
  if (bytes[0] !== 0x44 || bytes[1] !== 0x4f || bytes[2] !== 0x53) return '';
  const rootOff = 880 * 512;
  const len = bytes[rootOff + 432];
  if (len < 1 || len > 30) return '';
  let out = '';
  for (let i = 0; i < len; i++) {
    const ch = bytes[rootOff + 433 + i];
    if (ch >= 0x20 && ch < 0x7f) out += String.fromCharCode(ch);
  }
  return out;
}

export const TRIAGE_EVT_HARD_RESET = 1;
export const TRIAGE_EVT_WARM_RESET = 2;
export const TRIAGE_EVT_CPU_RESET = 3;
export const TRIAGE_EVT_OVL = 4;
export const TRIAGE_EVT_FLOPPY_MOTOR = 5;
export const TRIAGE_EVT_FLOPPY_STEP = 6;
export const TRIAGE_EVT_DISK_DMA = 7;

export interface TriageEventEntry {
  frame: number;
  kind: number;
  arg1: number;
  arg2: number;
}

const TRIAGE_EVENT_CAP = 32;

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
  public activeVideoStandard: ResolvedVideoStandard = 'PAL';
  public onAutoVideoStandardChange:
    | ((videoStandard: ResolvedVideoStandard, reason: AutoVideoStandardReason) => void)
    | null = null;

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
  private readonly pcHistory = new Uint32Array(120);
  private pcHistoryIdx = 0;
  private pcHistoryCount = 0;
  private readonly evtFrame = new Uint32Array(TRIAGE_EVENT_CAP);
  private readonly evtKind = new Uint8Array(TRIAGE_EVENT_CAP);
  private readonly evtArg1 = new Int32Array(TRIAGE_EVENT_CAP);
  private readonly evtArg2 = new Int32Array(TRIAGE_EVENT_CAP);
  private evtWriteIdx = 0;
  private evtCount = 0;

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
      onStep: (d, cyl) => {
        this.recordTriageEvent(
          TRIAGE_EVT_FLOPPY_STEP,
          d,
          (cyl << 1) | (this.floppy.drives[d]?.side ?? 0)
        );
        this.floppyAudio.handleStep(d, cyl);
      },
      onMotor: (d, on) => {
        this.recordTriageEvent(TRIAGE_EVT_FLOPPY_MOTOR, d, on ? 1 : 0);
      },
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
    this.chipset.onDiskDmaStart = (wordCount, isWrite) => {
      const idx = this.floppy.drives[1].selected ? 1 : 0;
      const drv = this.floppy.drives[idx];
      this.recordTriageEvent(
        TRIAGE_EVT_DISK_DMA,
        ((idx & 1) << 16) | (isWrite ? 0x8000 : 0) | (wordCount & 0x7fff),
        drv ? ((drv.cylinder << 1) | drv.side) : 0
      );
    };
    this.chipset.chipset = this.config.chipset;
    this.chipset.turboFloppy = this.config.turboFloppy;
    this.floppy.turboFloppy = this.config.turboFloppy;
    this.activeVideoStandard =
      this.config.videoStandard === 'auto' ? 'PAL' : this.config.videoStandard;
    this.chipset.setOverscanConfig(this.config.overscan, this.activeVideoStandard, true);

    this.cia = new AmigaCIA({
      onOvlChange: (ovl) => {
        if (this.memory && this.memory.ovl !== ovl) {
          this.memory.ovl = ovl;
          this.recordTriageEvent(TRIAGE_EVT_OVL, ovl ? 1 : 0, 0);
        } else if (this.memory) {
          this.memory.ovl = ovl;
        }
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
        if (!this.chipset.isPalTiming()) {
          this.chipset.noteNtscInputPoll();
        }
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
    this.cpu.is68020 = this.config.chipset === 'AGA';
    this.memory.allowUnaligned = this.cpu.is68020;
    cpuRef = this.cpu;
    this.chipset.attachCycleSource(this.cpu);

    // Hook 68000 RESET instruction & Expansion/OpenKick Line-A kernel calls
    this.memory.onResetInstruction = () => {
      this.recordTriageEvent(TRIAGE_EVT_CPU_RESET, this.cpu.pc >>> 0, 0);
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

  public getActiveVideoStandard(): ResolvedVideoStandard {
    return this.activeVideoStandard;
  }

  private resolveAutoBootVideoStandard(): ResolvedVideoStandard {
    if (this.config.videoStandard !== 'auto') {
      return this.config.videoStandard;
    }
    const d0 = this.floppy.drives[0];
    if (d0.data) {
      const fromName = detectVideoStandardFromName(d0.name);
      if (fromName) return fromName;
      const fromLabel = detectVideoStandardFromName(extractAdfVolumeLabel(d0.data));
      if (fromLabel) return fromLabel;
    }
    const h1 = this.hardfile.units[1];
    if (h1.data) {
      const fromName = detectVideoStandardFromName(h1.name);
      if (fromName) return fromName;
      const fromVol = detectVideoStandardFromName(h1.partitions[0]?.volumeName ?? '');
      if (fromVol) return fromVol;
    }
    return 'PAL';
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
    this.activeVideoStandard = this.resolveAutoBootVideoStandard();
    this.chipset.setOverscanConfig(this.config.overscan, this.activeVideoStandard, true);
    this.chipset.joy1Connected = this.config.joystickConnected;
    this.openKick.reset();
    this.audio.resetSchedule();
    this.capsLock = false;
    this.eClockAccum = 0;
    this.pcHistoryIdx = 0;
    this.pcHistoryCount = 0;
    this.cpu.is68020 = this.config.chipset === 'AGA';
    this.memory.allowUnaligned = this.cpu.is68020;
    this.memory.syncKickstart68020Compat(this.cpu.is68020);
    this.cpu.reset();
    this.frameCount = 0;
    this.evtWriteIdx = 0;
    this.evtCount = 0;
    this.recordTriageEvent(TRIAGE_EVT_HARD_RESET, 0, 0);
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
    const prevStd = this.activeVideoStandard;
    this.activeVideoStandard = this.resolveAutoBootVideoStandard();
    this.chipset.setOverscanConfig(this.config.overscan, this.activeVideoStandard, true);
    this.chipset.joy1Connected = this.config.joystickConnected;
    this.audio.resetSchedule();
    this.eClockAccum = 0;
    this.pcHistoryIdx = 0;
    this.pcHistoryCount = 0;
    this.cpu.is68020 = this.config.chipset === 'AGA';
    this.memory.allowUnaligned = this.cpu.is68020;
    this.memory.syncKickstart68020Compat(this.cpu.is68020);
    this.cpu.reset();
    this.recordTriageEvent(TRIAGE_EVT_WARM_RESET, 0, 0);
    if (this.config.videoStandard === 'auto' && this.activeVideoStandard !== prevStd) {
      this.onAutoVideoStandardChange?.(this.activeVideoStandard, 'disk-tag');
    }
  }

  public updateConfig(patch: Partial<AmigaConfig>, rebootIfHardwareChanged = true): void {
    const prev = this.config;
    const nextVolume =
      patch.audioVolume !== undefined
        ? Math.max(0, Math.min(1, patch.audioVolume))
        : (this.config.audioVolume ?? DEFAULT_AMIGA_CONFIG.audioVolume);
    this.config = { ...this.config, ...patch, audioVolume: nextVolume };
    this.chipset.chipset = this.config.chipset;
    this.cpu.is68020 = this.config.chipset === 'AGA';
    this.memory.allowUnaligned = this.cpu.is68020;
    this.memory.syncKickstart68020Compat(this.cpu.is68020);
    this.chipset.turboFloppy = this.config.turboFloppy;
    this.floppy.turboFloppy = this.config.turboFloppy;
    if (patch.videoStandard !== undefined) {
      this.activeVideoStandard =
        this.config.videoStandard === 'auto'
          ? this.resolveAutoBootVideoStandard()
          : this.config.videoStandard;
    }
    this.chipset.setOverscanConfig(this.config.overscan, this.activeVideoStandard);
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

  public checkDf0KickstartCompat(bytes: Uint8Array, name: string): string | null {
    const isDosDisk =
      bytes.length >= 512 &&
      bytes[0] === 0x44 &&
      bytes[1] === 0x4f &&
      bytes[2] === 0x53;
    const fsVer = isDosDisk ? bytes[3] : -1;
    const isFfsOrIntl = fsVer >= 1 && fsVer <= 5;
    const ksVer = this.isOpenKick ? 34 : ((this.memory.rom[12] << 8) | this.memory.rom[13]);

    if (isFfsOrIntl && ksVer > 0 && ksVer < 36) {
      return `Дискета «${name}» использует DOS\\${fsVer} (FFS) и требует Kickstart 2.04+/3.1 (сейчас ${this.isOpenKick ? 'OpenKick 1.3' : `KS ${ksVer}`}).`;
    }

    if (/(?:^|[\s([_.-])AGA(?:$|[\s)\]_.-])/i.test(name)) {
      if (this.config.chipset !== 'AGA') {
        return `Образ «${name}» создан для Amiga 1200 (AGA). Включите Amiga 1200 в настройках.`;
      }
      if (this.isOpenKick || (ksVer > 0 && ksVer < 39)) {
        return `AGA-образ «${name}» обычно требует ROM Kickstart 3.0/3.1 (V39+, сейчас ${this.isOpenKick ? 'OpenKick 1.3' : `KS ${ksVer}`}).`;
      }
    }

    return null;
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
    const wasEmpty = this.floppy.drives[driveIdx].data === null;
    const hotSwap = !resetIfDf0;
    this.floppy.drives[driveIdx].insert(bytes, name, hotSwap);
    this.saveStateInsertedDrives[driveIdx] = false;
    if (driveIdx === 0 && resetIfDf0) {
      this.warmReset();
    } else if (driveIdx === 0 && this.config.videoStandard === 'auto' && wasEmpty) {
      const tagged =
        detectVideoStandardFromName(name) ??
        detectVideoStandardFromName(extractAdfVolumeLabel(bytes));
      if (tagged && tagged !== this.activeVideoStandard) {
        this.activeVideoStandard = tagged;
        this.chipset.setOverscanConfig(this.config.overscan, tagged);
        this.onAutoVideoStandardChange?.(tagged, 'disk-tag');
      }
    }
    return { ok: true };
  }

  public insertBlankAdf(driveIdx: 0 | 1, name?: string, volumeName?: string): string {
    const cleanVol = (volumeName ?? '').replace(/[:/]/g, '').trim().slice(0, 30) || 'SaveDisk';
    const hasCustomVol = Boolean(volumeName && volumeName.replace(/[:/]/g, '').trim());
    const diskName =
      name ??
      (hasCustomVol
        ? `${cleanVol}.adf`
        : driveIdx === 0
          ? 'SaveDisk.adf'
          : 'SaveDisk_DF1.adf');
    this.floppy.drives[driveIdx].insertBlankDisk(diskName, cleanVol, true);
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
    const isAga = chipset.chipset === 'AGA';
    const cpuCyclesPerLine = computeCpuCyclesPerScanline(
      isAga,
      isPal,
      this.config.ecoCpuMode,
      this.config.cpuOverclock
    );
    const eFrac = isPal ? 4 : 5;
    let eAccum = this.eClockAccum;
    const spriteHeaderLine = isPal ? 25 : 20;
    const diskDmaWords = this.config.turboFloppy ? 96 : 4;

    // Line 0: trigger VBlank interrupt & CIA-A TOD VSync
    cia.onVSync();
    chipset.requestIrq(INT_VERTB);

    for (let line = 0; line < totalLines; line++) {
      chipset.beginScanline(line, cpu.cycles, cpuCyclesPerLine);

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
    if (this.config.videoStandard === 'auto') {
      const palReason = chipset.checkNtscNeedsPal(!this.isOpenKick);
      if (palReason !== null) {
        this.activeVideoStandard = 'PAL';
        chipset.setOverscanConfig(this.config.overscan, 'PAL');
        this.onAutoVideoStandardChange?.('PAL', palReason);
      } else {
        const currentChipStd: ResolvedVideoStandard = chipset.isPalTiming() ? 'PAL' : 'NTSC';
        if (currentChipStd !== this.activeVideoStandard) {
          this.activeVideoStandard = currentChipStd;
          chipset.setOverscanConfig(this.config.overscan, currentChipStd);
          this.onAutoVideoStandardChange?.(currentChipStd, 'beamcon0');
        }
      }
    } else if (this.config.videoStandard === 'NTSC' && chipset.checkNtscPalRasterDeadlock()) {
      this.config = { ...this.config, videoStandard: 'PAL' };
      this.activeVideoStandard = 'PAL';
      chipset.setOverscanConfig(this.config.overscan, 'PAL');
      this.onAutoVideoStandardChange?.('PAL', 'deadlock');
    }

    // Sync floppy motor audio & decay LED I/O pulse and hot-swap eject hold once per frame
    for (let i = 0; i < 2; i++) {
      const d = this.floppy.drives[i];
      if (d.ioPulseFrames > 0) d.ioPulseFrames--;
      if (d.ejectHoldFrames > 0) d.ejectHoldFrames--;
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
    this.pcHistory[this.pcHistoryIdx] = cpu.pc >>> 0;
    this.pcHistoryIdx = this.pcHistoryIdx === 119 ? 0 : this.pcHistoryIdx + 1;
    if (this.pcHistoryCount < 120) this.pcHistoryCount++;
  }

  private recordTriageEvent(kind: number, arg1: number, arg2: number): void {
    if (this.evtCount > 0) {
      const prevIdx = (this.evtWriteIdx - 1 + TRIAGE_EVENT_CAP) & (TRIAGE_EVENT_CAP - 1);
      if (kind === TRIAGE_EVT_FLOPPY_STEP && this.evtKind[prevIdx] === kind && this.evtArg1[prevIdx] === arg1) {
        if ((this.frameCount - this.evtFrame[prevIdx]) <= 2) {
          this.evtFrame[prevIdx] = this.frameCount >>> 0;
          this.evtArg2[prevIdx] = arg2 | 0;
          return;
        }
      } else if (
        this.evtKind[prevIdx] === kind &&
        this.evtArg1[prevIdx] === (arg1 | 0) &&
        this.evtArg2[prevIdx] === (arg2 | 0) &&
        this.evtFrame[prevIdx] === (this.frameCount >>> 0)
      ) {
        return;
      }
    }
    const idx = this.evtWriteIdx;
    this.evtFrame[idx] = this.frameCount >>> 0;
    this.evtKind[idx] = kind & 0xff;
    this.evtArg1[idx] = arg1 | 0;
    this.evtArg2[idx] = arg2 | 0;
    this.evtWriteIdx = (idx + 1) & (TRIAGE_EVENT_CAP - 1);
    if (this.evtCount < TRIAGE_EVENT_CAP) this.evtCount++;
  }

  public getRecentTriageEvents(): TriageEventEntry[] {
    const count = this.evtCount;
    const out: TriageEventEntry[] = new Array(count);
    const start = count < TRIAGE_EVENT_CAP ? 0 : this.evtWriteIdx;
    for (let i = 0; i < count; i++) {
      const idx = (start + i) & (TRIAGE_EVENT_CAP - 1);
      out[i] = {
        frame: this.evtFrame[idx],
        kind: this.evtKind[idx],
        arg1: this.evtArg1[idx],
        arg2: this.evtArg2[idx],
      };
    }
    return out;
  }

  public getRecentPcHistory(): number[] {
    const count = this.pcHistoryCount;
    const out = new Array<number>(count);
    const start = count < 120 ? 0 : this.pcHistoryIdx;
    for (let i = 0; i < count; i++) {
      out[i] = this.pcHistory[(start + i) % 120];
    }
    return out;
  }

  public getStatusSnapshot(): AmigaStatusSnapshot {
    return {
      running: !this.paused,
      paused: this.paused,
      fps: this.measuredFps,
      cpuUsageHint: this.cpuUsageHint,
      chipset: this.config.chipset,
      videoStandard: this.activeVideoStandard,
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
      isOpenKick: this.isOpenKick,
      activeVideoStandard: this.activeVideoStandard,
      frameCount: this.frameCount,
      ovl: this.memory.ovl,
      eClockAccum: this.eClockAccum,
      cpuRegs,
      usp: this.cpu.usp,
      ssp: this.cpu.ssp,
      pc: this.cpu.pc,
      sr: this.cpu.sr,
      stopped: this.cpu.stopped,
      chipRamBase64: uint8ToBase64(this.memory.chipRam),
      slowRamBase64: uint8ToBase64(this.memory.slowRam),
      fastRamBase64: this.memory.fastRam.length > 0 ? uint8ToBase64(this.memory.fastRam) : '',
      customRegs: this.chipset.serializeRegs(),
      bplPt: Array.from(this.chipset.bplPt.subarray(0, this.config.chipset === 'AGA' ? 8 : 6)),
      sprPt: Array.from(this.chipset.sprPt),
      beamCon0: this.chipset.beamCon0,
      copPc: this.chipset.copPc,
      copWaiting: this.chipset.copWaiting,
      copWaitV: this.chipset.copWaitV,
      copWaitH: this.chipset.copWaitH,
      copMaskV: this.chipset.copMaskV,
      copMaskH: this.chipset.copMaskH,
      vbr: this.cpu.vbr,
      cacr: this.cpu.cacr,
      bplCon3: this.chipset.bplCon3,
      bplCon4: this.chipset.bplCon4,
      fmode: this.chipset.fmode,
      agaColors24: this.config.chipset === 'AGA' ? Array.from(this.chipset.colorReg24) : undefined,
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
    if (state.activeVideoStandard === 'PAL' || state.activeVideoStandard === 'NTSC') {
      this.activeVideoStandard = state.activeVideoStandard;
      this.chipset.setOverscanConfig(this.config.overscan, this.activeVideoStandard, false);
    }
    const chipBytes = base64ToUint8(state.chipRamBase64);
    this.memory.chipRam.set(chipBytes.subarray(0, this.memory.chipRam.length));
    if (state.slowRamBase64 && this.memory.slowRam.length > 0) {
      const slowBytes = base64ToUint8(state.slowRamBase64);
      this.memory.slowRam.set(slowBytes.subarray(0, this.memory.slowRam.length));
    }
    if (state.fastRamBase64 && this.memory.fastRam.length > 0) {
      const fastBytes = base64ToUint8(state.fastRamBase64);
      this.memory.fastRam.set(fastBytes.subarray(0, this.memory.fastRam.length));
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
    if (typeof state.vbr === 'number') this.cpu.vbr = state.vbr | 0;
    if (typeof state.cacr === 'number') this.cpu.cacr = state.cacr & 0x0003;
    this.chipset.deserializeRegs(state.customRegs);
    if (typeof state.bplCon3 === 'number') this.chipset.bplCon3 = state.bplCon3 & 0xffff;
    if (typeof state.bplCon4 === 'number') this.chipset.bplCon4 = state.bplCon4 & 0xffff;
    if (typeof state.fmode === 'number') this.chipset.fmode = state.fmode & 0xffff;
    if (Array.isArray(state.agaColors24)) {
      const count = Math.min(256, state.agaColors24.length);
      for (let i = 0; i < count; i++) {
        const c24 = state.agaColors24[i] >>> 0;
        this.chipset.colorReg24[i] = c24;
        const r8 = (c24 >>> 16) & 0xff;
        const g8 = (c24 >>> 8) & 0xff;
        const b8 = c24 & 0xff;
        this.chipset.colorAbgr[i] = (0xff000000 | (b8 << 16) | (g8 << 8) | r8) >>> 0;
        if (i < 32) {
          this.chipset.colorReg[i] = ((r8 >>> 4) << 8) | ((g8 >>> 4) << 4) | (b8 >>> 4);
          this.chipset.colorEhbAbgr[i] =
            (0xff000000 | ((b8 >>> 1) << 16) | ((g8 >>> 1) << 8) | (r8 >>> 1)) >>> 0;
        }
      }
    }
    if (Array.isArray(state.bplPt)) {
      for (let i = 0; i < Math.min(this.chipset.bplPt.length, state.bplPt.length); i++) {
        this.chipset.bplPt[i] = state.bplPt[i] & 0x00ffffff;
      }
    }
    if (Array.isArray(state.sprPt)) {
      for (let i = 0; i < Math.min(8, state.sprPt.length); i++) {
        this.chipset.sprPt[i] = state.sprPt[i] & 0x00ffffff;
      }
    }
    if (typeof state.beamCon0 === 'number') {
      this.chipset.beamCon0 = state.beamCon0 & 0xffff;
    }
    if (typeof state.copPc === 'number') {
      this.chipset.copPc = state.copPc & 0x00ffffff;
    }
    if (typeof state.copWaiting === 'boolean') {
      this.chipset.copWaiting = state.copWaiting;
    }
    if (typeof state.copWaitV === 'number') {
      this.chipset.copWaitV = state.copWaitV | 0;
    }
    if (typeof state.copWaitH === 'number') {
      this.chipset.copWaitH = state.copWaitH | 0;
    }
    if (typeof state.copMaskV === 'number') {
      this.chipset.copMaskV = state.copMaskV | 0;
    }
    if (typeof state.copMaskH === 'number') {
      this.chipset.copMaskH = state.copMaskH | 0;
    }
    this.cia.deserializeA(state.ciaA);
    this.cia.deserializeB(state.ciaB);
    if (typeof state.ovl === 'boolean') {
      this.memory.ovl = state.ovl;
    }
    if (typeof state.frameCount === 'number') {
      this.frameCount = state.frameCount | 0;
    }
    if (typeof state.eClockAccum === 'number') {
      this.eClockAccum = state.eClockAccum | 0;
    }
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

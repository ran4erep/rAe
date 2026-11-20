/**
 * Authentic UAE (driveclick.c) Floppy Drive Mechanical Sound Engine.
 *
 * Playback rules matching libretro-uae / WinUAE `driveclick.c`:
 * - 5 samples from A500:
 *   - `drive_click.ogg`: 80 cylinder stepper clicks packed at 3200-sample stride @ 48kHz (0.0666667s/slot)
 *   - `drive_snatch.ogg`: Disk latch & initial spin-up grab when spinning a newly inserted disk for the first time
 *   - `drive_startup.ogg`: Motor spin-up whir on subsequent motor starts (or empty drive spin-up)
 *   - `drive_spin.ogg`: Seamless loop while motor is spinning with disk inserted
 *   - `drive_spinnd.ogg`: Seamless loop while motor is spinning with NO disk inserted
 * - "noclick" check: repeated step at cylinder 0 -> 0 is silenced.
 * - Volume is attenuated when drive is empty (`!hasDisk`), matching UAE empty-drive mixing.
 *
 * Uses Web Audio API `AudioBufferSourceNode`s for 0% JS CPU overhead!
 */

import { getAppAssetUrl } from '../../utils/assetUrl';

export type FloppySoundCommand =
  | { type: 'stopMotor'; drive: number }
  | { type: 'startMotor'; drive: number; intro: 'snatch' | 'startup'; loop: 'spin' | 'spinnd'; volume: number }
  | { type: 'switchLoop'; drive: number; loop: 'spin' | 'spinnd'; volume: number }
  | { type: 'click'; drive: number; cylinder: number; volume: number };

interface DriveState {
  hasDisk: boolean;
  hasSpun: boolean;
  motorOn: boolean;
  prevCyl: number;
}

const VOLUME_DISK = 0.45;
const VOLUME_EMPTY = 0.14;
const CLICK_VOLUME_DISK = 0.6;
const CLICK_VOLUME_EMPTY = 0.24;

/**
 * Pure UAE driveclick state machine (decoupled for fast deterministic unit testing).
 */
export class FloppySoundStateMachine {
  private readonly drives: [DriveState, DriveState] = [
    { hasDisk: false, hasSpun: false, motorOn: false, prevCyl: 0 },
    { hasDisk: false, hasSpun: false, motorOn: false, prevCyl: 0 },
  ];

  public onInsert(driveIdx: number, inserted: boolean): FloppySoundCommand[] {
    const d = this.drives[driveIdx];
    if (!d) return [];
    const wasDisk = d.hasDisk;
    d.hasDisk = inserted;
    if (!inserted) {
      d.hasSpun = false;
    }
    if (d.motorOn && wasDisk !== inserted) {
      return [
        {
          type: 'switchLoop',
          drive: driveIdx,
          loop: inserted ? 'spin' : 'spinnd',
          volume: inserted ? VOLUME_DISK : VOLUME_EMPTY,
        },
      ];
    }
    return [];
  }

  public onMotor(driveIdx: number, running: boolean): FloppySoundCommand[] {
    const d = this.drives[driveIdx];
    if (!d) return [];
    if (!running) {
      if (!d.motorOn) return [];
      d.motorOn = false;
      return [{ type: 'stopMotor', drive: driveIdx }];
    }

    if (d.motorOn) return [];
    d.motorOn = true;

    const intro: 'snatch' | 'startup' = d.hasDisk && !d.hasSpun ? 'snatch' : 'startup';
    if (d.hasDisk && !d.hasSpun) {
      d.hasSpun = true;
    }
    return [
      {
        type: 'startMotor',
        drive: driveIdx,
        intro,
        loop: d.hasDisk ? 'spin' : 'spinnd',
        volume: d.hasDisk ? VOLUME_DISK : VOLUME_EMPTY,
      },
    ];
  }

  public onStep(driveIdx: number, cylinder: number): FloppySoundCommand[] {
    const d = this.drives[driveIdx];
    if (!d) return [];
    // Suppress constant idle Kickstart 1.3 polling clicks (0<->1) when drive is empty and motor/LED is off
    if (!d.hasDisk && !d.motorOn) {
      d.prevCyl = cylinder;
      return [];
    }
    // UAE `driveclick_click` noclick check
    if (d.prevCyl === 0 && cylinder === 0) {
      return [];
    }
    d.prevCyl = cylinder;
    return [
      {
        type: 'click',
        drive: driveIdx,
        cylinder: Math.max(0, Math.min(79, cylinder)),
        volume: d.hasDisk ? CLICK_VOLUME_DISK : CLICK_VOLUME_EMPTY,
      },
    ];
  }

  public reset(drive0HasDisk: boolean, drive1HasDisk: boolean): FloppySoundCommand[] {
    const cmds: FloppySoundCommand[] = [];
    const flags = [drive0HasDisk, drive1HasDisk];
    for (let i = 0; i < 2; i++) {
      if (this.drives[i].motorOn) {
        cmds.push({ type: 'stopMotor', drive: i });
      }
      this.drives[i].motorOn = false;
      this.drives[i].hasDisk = flags[i];
      this.drives[i].hasSpun = false;
      this.drives[i].prevCyl = 0;
    }
    return cmds;
  }
}

const CLICK_STRIDE_SEC = 3200 / 48000;
const CLICK_PLAY_SEC = 0.036;

interface DriveAudioNodes {
  motorGain: GainNode | null;
  introNode: AudioBufferSourceNode | null;
  loopNode: AudioBufferSourceNode | null;
  clickNode: AudioBufferSourceNode | null;
  lastClickTime: number;
}

export class FloppyAudioEngine {
  public readonly stateMachine = new FloppySoundStateMachine();
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private enabled = true;
  private globalAudioEnabled = true;
  private volume = 1.0;

  private buffers: Partial<Record<'click' | 'snatch' | 'startup' | 'spin' | 'spinnd', AudioBuffer>> = {};
  private loadingStarted = false;

  private readonly driveNodes: [DriveAudioNodes, DriveAudioNodes] = [
    { motorGain: null, introNode: null, loopNode: null, clickNode: null, lastClickTime: 0 },
    { motorGain: null, introNode: null, loopNode: null, clickNode: null, lastClickTime: 0 },
  ];

  public attachContext(ctx: AudioContext): void {
    if (this.ctx === ctx) return;
    const isReattach = this.ctx !== null;
    this.ctx = ctx;
    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = this.isActive() ? this.volume : 0;
    this.masterGain.connect(ctx.destination);

    for (let i = 0; i < 2; i++) {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(this.masterGain);
      this.driveNodes[i] = {
        motorGain: g,
        introNode: null,
        loopNode: null,
        clickNode: null,
        lastClickTime: 0,
      };
    }

    if (!this.loadingStarted || isReattach) {
      this.loadingStarted = true;
      void this.loadAllSamples(ctx);
    }
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.syncMasterGain();
  }

  public setGlobalAudioEnabled(enabled: boolean): void {
    this.globalAudioEnabled = enabled;
    this.syncMasterGain();
  }

  public setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, Number.isFinite(volume) ? volume : 1.0));
    this.syncMasterGain();
  }

  private isActive(): boolean {
    return this.enabled && this.globalAudioEnabled && this.volume > 0.001;
  }

  private syncMasterGain(): void {
    if (!this.ctx || !this.masterGain) return;
    const target = this.isActive() ? this.volume : 0;
    this.masterGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.015);
  }

  private async loadAllSamples(ctx: AudioContext): Promise<void> {
    const names = ['click', 'snatch', 'startup', 'spin', 'spinnd'] as const;
    await Promise.all(
      names.map(async (name) => {
        try {
          const resp = await fetch(getAppAssetUrl(`sounds/floppy/drive_${name}.ogg`));
          if (!resp.ok) return;
          const arr = await resp.arrayBuffer();
          const decoded = await ctx.decodeAudioData(arr);
          this.buffers[name] = decoded;
        } catch {
          // Non-fatal if offline or unsupported codec
        }
      })
    );
  }

  public handleInsert(driveIdx: number, inserted: boolean): void {
    this.dispatch(this.stateMachine.onInsert(driveIdx, inserted));
  }

  public handleMotor(driveIdx: number, running: boolean): void {
    this.dispatch(this.stateMachine.onMotor(driveIdx, running));
  }

  public handleStep(driveIdx: number, cylinder: number): void {
    this.dispatch(this.stateMachine.onStep(driveIdx, cylinder));
  }

  public handleReset(drive0HasDisk: boolean, drive1HasDisk: boolean): void {
    this.dispatch(this.stateMachine.reset(drive0HasDisk, drive1HasDisk));
  }

  private dispatch(commands: FloppySoundCommand[]): void {
    if (!this.ctx || !this.masterGain || this.ctx.state !== 'running' || !this.isActive()) {
      return;
    }
    for (const cmd of commands) {
      this.executeCommand(cmd);
    }
  }

  private stopMotorNodes(driveIdx: number, fadeSec = 0.012): void {
    const ctx = this.ctx;
    const dn = this.driveNodes[driveIdx];
    if (!ctx || !dn) return;

    const stopAt = ctx.currentTime + fadeSec;
    if (dn.motorGain) {
      dn.motorGain.gain.cancelScheduledValues(ctx.currentTime);
      dn.motorGain.gain.setTargetAtTime(0, ctx.currentTime, fadeSec * 0.4);
    }
    if (dn.introNode) {
      try {
        dn.introNode.stop(stopAt);
      } catch {
        // Ignore already stopped
      }
      dn.introNode = null;
    }
    if (dn.loopNode) {
      try {
        dn.loopNode.stop(stopAt);
      } catch {
        // Ignore already stopped
      }
      dn.loopNode = null;
    }
  }

  private executeCommand(cmd: FloppySoundCommand): void {
    const ctx = this.ctx;
    const master = this.masterGain;
    if (!ctx || !master) return;
    const dn = this.driveNodes[cmd.drive];
    if (!dn) return;

    if (cmd.type === 'stopMotor') {
      this.stopMotorNodes(cmd.drive);
      return;
    }

    if (cmd.type === 'startMotor') {
      this.stopMotorNodes(cmd.drive, 0.005);
      const now = ctx.currentTime;
      const motorGain = dn.motorGain;
      if (!motorGain) return;

      motorGain.gain.cancelScheduledValues(now);
      motorGain.gain.setValueAtTime(cmd.volume, now);

      const introBuf = this.buffers[cmd.intro];
      const loopBuf = this.buffers[cmd.loop];
      let loopStart = now;

      if (introBuf) {
        const introSrc = ctx.createBufferSource();
        introSrc.buffer = introBuf;
        introSrc.connect(motorGain);
        introSrc.start(now);
        dn.introNode = introSrc;
        loopStart = now + Math.max(0.05, introBuf.duration - 0.015);
      }

      if (loopBuf) {
        const loopSrc = ctx.createBufferSource();
        loopSrc.buffer = loopBuf;
        loopSrc.loop = true;
        loopSrc.connect(motorGain);
        loopSrc.start(loopStart);
        dn.loopNode = loopSrc;
      }
      return;
    }

    if (cmd.type === 'switchLoop') {
      const now = ctx.currentTime;
      const motorGain = dn.motorGain;
      if (!motorGain) return;
      if (dn.loopNode) {
        try {
          dn.loopNode.stop(now + 0.01);
        } catch {
          // Ignore
        }
        dn.loopNode = null;
      }
      motorGain.gain.setTargetAtTime(cmd.volume, now, 0.015);
      const loopBuf = this.buffers[cmd.loop];
      if (loopBuf) {
        const loopSrc = ctx.createBufferSource();
        loopSrc.buffer = loopBuf;
        loopSrc.loop = true;
        loopSrc.connect(motorGain);
        loopSrc.start(now + 0.005);
        dn.loopNode = loopSrc;
      }
      return;
    }

    if (cmd.type === 'click') {
      const clickBuf = this.buffers.click;
      if (!clickBuf) return;
      const now = ctx.currentTime;
      // Throttle extreme seek bursts (<12ms) and replace monophonic click voice like UAE `DS_CLICK`
      if (now - dn.lastClickTime < 0.012) return;
      dn.lastClickTime = now;

      if (dn.clickNode) {
        try {
          dn.clickNode.stop(now);
        } catch {
          // Ignore
        }
        dn.clickNode = null;
      }

      const clickGain = ctx.createGain();
      clickGain.gain.value = cmd.volume;
      clickGain.connect(master);

      const src = ctx.createBufferSource();
      src.buffer = clickBuf;
      src.connect(clickGain);
      const offset = Math.min(clickBuf.duration - CLICK_PLAY_SEC, cmd.cylinder * CLICK_STRIDE_SEC);
      src.start(now, Math.max(0, offset), CLICK_PLAY_SEC);
      dn.clickNode = src;
    }
  }
}

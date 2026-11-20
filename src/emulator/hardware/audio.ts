/**
 * Ultra-low-CPU Paula 4-Channel 8-bit DMA Stereo Audio Engine.
 * Uses Web Audio API with authentic Amiga L-R-R-L panning and optional 4.4 kHz LED low-pass filter.
 * Zero allocations in audio generation; stays idle (0% CPU) when muted or paused.
 */

import { AmigaChipset, INT_AUD0 } from './chipset';

const PAL_AUDIO_CLOCK = 3546895;
const MASTER_BOOST = 1.65;

export class PaulaAudioEngine {
  private ctx: AudioContext | null = null;
  private filterNode: BiquadFilterNode | null = null;
  private compressorNode: DynamicsCompressorNode | null = null;
  private gainNode: GainNode | null = null;
  private enabled = true;
  private volume = 1.0;
  private ledFilter = true;
  private nextScheduleTime = 0;

  // Reusable PCM chunk buffers (20ms PAL frame @ 22050Hz = 441 samples -> tiny CPU footprint!)
  private readonly sampleRate = 22050;
  private readonly chunkFrames = 441;
  private readonly leftBuf = new Float32Array(441);
  private readonly rightBuf = new Float32Array(441);

  private onContextReadyCb: ((ctx: AudioContext) => void) | null = null;
  private onNeedsUnlockCb: (() => void) | null = null;
  private silentUnlocked = false;
  private lastObservedCtxTime = -1;
  private stalledPushCount = 0;

  private readonly handleCtxStateChange = (): void => {
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state !== 'running') {
      this.nextScheduleTime = 0;
      this.silentUnlocked = false;
      this.stalledPushCount = 0;
      if (this.enabled) {
        this.onNeedsUnlockCb?.();
      }
    }
  };

  public setOnContextReady(cb: (ctx: AudioContext) => void): void {
    this.onContextReadyCb = cb;
    if (this.ctx && this.ctx.state !== 'closed') cb(this.ctx);
  }

  public setOnNeedsUnlock(cb: (() => void) | null): void {
    this.onNeedsUnlockCb = cb;
  }

  public isContextRunning(): boolean {
    return Boolean(this.ctx && this.ctx.state === 'running');
  }

  public resetSchedule(): void {
    this.nextScheduleTime = 0;
    this.stalledPushCount = 0;
  }

  private getFilterCutoff(): number {
    const nyquistSafe = this.ctx ? Math.min(18000, this.ctx.sampleRate * 0.45) : 18000;
    return this.ledFilter ? Math.min(4400, nyquistSafe) : nyquistSafe;
  }

  private getAudioContextConstructor(): typeof AudioContext | null {
    if (typeof window === 'undefined') return null;
    return (
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ||
      null
    );
  }

  private teardownContext(): void {
    const oldCtx = this.ctx;
    this.ctx = null;
    this.filterNode = null;
    this.compressorNode = null;
    this.gainNode = null;
    this.nextScheduleTime = 0;
    this.silentUnlocked = false;
    this.lastObservedCtxTime = -1;
    this.stalledPushCount = 0;
    if (oldCtx) {
      oldCtx.removeEventListener('statechange', this.handleCtxStateChange);
      if (oldCtx.state !== 'closed') {
        try {
          void oldCtx.close().catch(() => {});
        } catch {
          // Ignore close errors
        }
      }
    }
  }

  private createContext(): AudioContext | null {
    const AudioCtx = this.getAudioContextConstructor();
    if (!AudioCtx) return null;

    // Use device native sampleRate for best mobile/desktop compatibility; WebAudio resamples 22050Hz AudioBuffers natively in C++
    const ctx = new AudioCtx();
    this.ctx = ctx;
    ctx.addEventListener('statechange', this.handleCtxStateChange);

    this.filterNode = ctx.createBiquadFilter();
    this.filterNode.type = 'lowpass';
    this.filterNode.frequency.value = this.getFilterCutoff();
    this.filterNode.Q.value = 0.7;

    // Soft broadcast compressor prevents 4-channel clipping while keeping game music/SFX loud & punchy
    this.compressorNode = ctx.createDynamicsCompressor();
    this.compressorNode.threshold.value = -14;
    this.compressorNode.knee.value = 10;
    this.compressorNode.ratio.value = 10;
    this.compressorNode.attack.value = 0.002;
    this.compressorNode.release.value = 0.08;

    this.gainNode = ctx.createGain();
    this.gainNode.gain.value = this.enabled ? this.volume * MASTER_BOOST : 0;

    this.filterNode.connect(this.compressorNode);
    this.compressorNode.connect(this.gainNode);
    this.gainNode.connect(ctx.destination);
    this.nextScheduleTime = 0;
    this.silentUnlocked = false;
    this.lastObservedCtxTime = -1;
    this.stalledPushCount = 0;
    this.onContextReadyCb?.(ctx);
    return ctx;
  }

  private playSilentUnlockPulse(ctx: AudioContext): void {
    if (this.silentUnlocked || ctx.state === 'closed') return;
    try {
      const buf = ctx.createBuffer(1, 1, ctx.sampleRate);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
      if (ctx.state === 'running') {
        this.silentUnlocked = true;
      }
    } catch {
      // Ignore if context cannot schedule yet
    }
  }

  public initFromGesture(): void {
    if (typeof window === 'undefined' && !this.ctx) return;

    if (this.ctx && this.ctx.state === 'closed') {
      this.teardownContext();
    }

    const ctx = this.ctx ?? this.createContext();
    if (!ctx) return;

    if (this.enabled) {
      if (ctx.state !== 'running') {
        this.nextScheduleTime = 0;
        try {
          const res = ctx.resume();
          if (res && typeof res.then === 'function') {
            res
              .then(() => {
                if (this.ctx === ctx && ctx.state === 'running') {
                  this.playSilentUnlockPulse(ctx);
                } else if (this.enabled) {
                  this.onNeedsUnlockCb?.();
                }
              })
              .catch(() => {
                if (this.enabled) this.onNeedsUnlockCb?.();
              });
          }
        } catch {
          this.onNeedsUnlockCb?.();
        }
      }
      this.playSilentUnlockPulse(ctx);
    }
  }

  public tryResume(): void {
    if (!this.enabled || !this.ctx) return;
    if (this.ctx.state === 'closed') {
      this.teardownContext();
      this.onNeedsUnlockCb?.();
      return;
    }
    if (this.ctx.state !== 'running') {
      this.nextScheduleTime = 0;
      try {
        void this.ctx.resume().catch(() => {
          if (this.enabled) this.onNeedsUnlockCb?.();
        });
      } catch {
        if (this.enabled) this.onNeedsUnlockCb?.();
      }
    }
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.nextScheduleTime = 0;
      this.stalledPushCount = 0;
    }
    this.syncGain();
    if (enabled) {
      if (this.ctx && this.ctx.state === 'closed') {
        this.teardownContext();
        this.onNeedsUnlockCb?.();
      } else if (this.ctx && this.ctx.state !== 'running') {
        try {
          void this.ctx.resume().catch(() => {
            this.onNeedsUnlockCb?.();
          });
        } catch {
          this.onNeedsUnlockCb?.();
        }
      } else if (!this.ctx) {
        this.onNeedsUnlockCb?.();
      }
    }
  }

  public setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, Number.isFinite(volume) ? volume : 1.0));
    this.syncGain();
  }

  private syncGain(): void {
    if (this.gainNode && this.ctx && this.ctx.state !== 'closed') {
      this.gainNode.gain.setTargetAtTime(
        this.enabled ? this.volume * MASTER_BOOST : 0,
        this.ctx.currentTime,
        0.015
      );
    }
  }

  public setLedFilter(on: boolean): void {
    this.ledFilter = on;
    if (this.filterNode && this.ctx && this.ctx.state !== 'closed') {
      this.filterNode.frequency.setTargetAtTime(this.getFilterCutoff(), this.ctx.currentTime, 0.01);
    }
  }

  /**
   * Mixes one video frame (20ms) of Paula 4-channel DMA audio from Chip RAM.
   * Immediately returns if no channel is active or audio is muted (near-zero CPU).
   */
  public pushFrame(chipset: AmigaChipset, chipRam: Uint8Array): void {
    if (!this.enabled || this.volume <= 0.001 || !this.ctx || !this.filterNode || this.ctx.state !== 'running') {
      return;
    }

    const channels = chipset.audio;
    let anyActive = false;
    for (let i = 0; i < 4; i++) {
      if (channels[i].active && channels[i].vol > 0) {
        anyActive = true;
        break;
      }
    }
    if (!anyActive) {
      this.nextScheduleTime = 0;
      this.stalledPushCount = 0;
      return;
    }

    const now = this.ctx.currentTime;
    if (now !== this.lastObservedCtxTime) {
      this.lastObservedCtxTime = now;
      this.stalledPushCount = 0;
    } else {
      this.stalledPushCount++;
      // If AudioContext reports 'running' but currentTime stays completely frozen for ~2s, rebuild on next gesture
      if (this.stalledPushCount >= 100) {
        this.teardownContext();
        this.onNeedsUnlockCb?.();
        return;
      }
    }

    const mask = chipRam.length - 1;
    const frames = this.chunkFrames;
    const left = this.leftBuf;
    const right = this.rightBuf;
    left.fill(0);
    right.fill(0);

    const clocksPerSample = PAL_AUDIO_CLOCK / this.sampleRate;

    // Amiga hard-wired stereo panning: Ch0 & Ch3 = Left (with 30% crossfeed), Ch1 & Ch2 = Right
    for (let c = 0; c < 4; c++) {
      const ch = channels[c];
      if (!ch.active || ch.vol === 0) continue;

      const step = clocksPerSample / Math.max(124, ch.per);
      const gain = (ch.vol / 64) * 1.25;
      const lGain = c === 0 || c === 3 ? gain : gain * 0.3;
      const rGain = c === 1 || c === 2 ? gain : gain * 0.3;

      for (let i = 0; i < frames; i++) {
        ch.phase += step;
        while (ch.phase >= 1) {
          ch.phase -= 1;
          const raw = chipRam[ch.curAddr & mask];
          ch.lastSample = raw > 127 ? raw - 256 : raw;
          ch.curAddr = (ch.curAddr + 1) & mask;
          if ((ch.curAddr & 1) === 0) {
            ch.wordsLeft--;
            if (ch.wordsLeft <= 0) {
              ch.curAddr = ch.lc;
              ch.wordsLeft = ch.len;
              chipset.requestIrq(INT_AUD0 << c);
            }
          }
        }
        const s = ch.lastSample * (1 / 128);
        left[i] += s * lGain;
        right[i] += s * rGain;
      }
    }

    if (
      this.nextScheduleTime === 0 ||
      this.nextScheduleTime < now - 0.005 ||
      this.nextScheduleTime - now > 0.5
    ) {
      this.nextScheduleTime = now + 0.012;
    } else if (this.nextScheduleTime - now > 0.2) {
      // Avoid excessive audio latency buildup
      return;
    }

    const audioBuffer = this.ctx.createBuffer(2, frames, this.sampleRate);
    audioBuffer.copyToChannel(left, 0);
    audioBuffer.copyToChannel(right, 1);

    const src = this.ctx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(this.filterNode);
    src.start(this.nextScheduleTime);
    this.nextScheduleTime += frames / this.sampleRate;
  }

  public dispose(): void {
    this.onNeedsUnlockCb = null;
    this.onContextReadyCb = null;
    this.teardownContext();
  }
}

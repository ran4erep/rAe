/**
 * Ultra-low-CPU Paula 4-Channel 8-bit DMA Stereo Audio Engine.
 * Uses Web Audio API with authentic Amiga L-R-R-L panning, linear interpolation @ 44.1 kHz,
 * intra-frame scanline-synced event playback, and optional 4.4 kHz LED low-pass filter.
 * Zero heap allocations in the audio mixing hot path; stays idle (0% CPU) when muted or paused.
 */

import {
  AmigaChipset,
  AUD_EVT_LCLEN,
  AUD_EVT_PER,
  AUD_EVT_START,
  AUD_EVT_STOP,
  AUD_EVT_VOL,
  INT_AUD0,
} from './chipset';

const PAL_AUDIO_CLOCK = 3546895;
const NTSC_AUDIO_CLOCK = 3579545;
const MIX_SAMPLE_RATE = 44100;
const PAL_CHUNK_FRAMES = 882;  // 44100 / 50 Hz = 20.000 ms exact
const NTSC_CHUNK_FRAMES = 735; // 44100 / 60 Hz = 16.667 ms exact
const MASTER_BOOST = 1.25;
const SCHEDULE_LEAD_SEC = 0.045; // 45 ms lead prevents 60Hz rAF jitter gaps during 50Hz PAL playback

export class PaulaAudioEngine {
  private ctx: AudioContext | null = null;
  private filterNode: BiquadFilterNode | null = null;
  private compressorNode: DynamicsCompressorNode | null = null;
  private gainNode: GainNode | null = null;
  private enabled = true;
  private volume = 1.0;
  private ledFilter = true;
  private nextScheduleTime = 0;

  // Preallocated reusable PCM chunk buffers & views (zero allocations per frame)
  private readonly sampleRate = MIX_SAMPLE_RATE;
  private readonly leftPal = new Float32Array(PAL_CHUNK_FRAMES);
  private readonly rightPal = new Float32Array(PAL_CHUNK_FRAMES);
  private readonly leftNtsc = this.leftPal.subarray(0, NTSC_CHUNK_FRAMES);
  private readonly rightNtsc = this.rightPal.subarray(0, NTSC_CHUNK_FRAMES);

  // Per-channel linear-interpolation state across frames
  private readonly chPrevSample = new Int8Array(4);
  private readonly chCurSample = new Int8Array(4);
  private readonly chWasActive = new Uint8Array(4);

  // Scratch channel state for intra-frame event mixing (zero heap allocations)
  private readonly segActive = new Uint8Array(4);
  private readonly segCurAddr = new Uint32Array(4);
  private readonly segWordsLeft = new Int32Array(4);
  private readonly segLc = new Uint32Array(4);
  private readonly segLen = new Int32Array(4);
  private readonly segPer = new Uint16Array(4);
  private readonly segVol = new Uint8Array(4);
  private readonly segClockRem = new Float64Array(4);

  private onContextReadyCb: ((ctx: AudioContext) => void) | null = null;
  private onNeedsUnlockCb: (() => void) | null = null;
  private silentUnlocked = false;
  private lastObservedCtxTime = -1;
  private stalledPushCount = 0;

  private readonly handleCtxStateChange = (): void => {
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state !== 'running') {
      this.resetSchedule();
      this.silentUnlocked = false;
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
    this.chPrevSample.fill(0);
    this.chCurSample.fill(0);
    this.chWasActive.fill(0);
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
    this.resetSchedule();
    this.silentUnlocked = false;
    this.lastObservedCtxTime = -1;
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

    const ctx = new AudioCtx();
    this.ctx = ctx;
    ctx.addEventListener('statechange', this.handleCtxStateChange);

    this.filterNode = ctx.createBiquadFilter();
    this.filterNode.type = 'lowpass';
    this.filterNode.frequency.value = this.getFilterCutoff();
    this.filterNode.Q.value = 0.7;

    // Gentle safety limiter protects against 4-channel clipping without pumping speech dynamics
    this.compressorNode = ctx.createDynamicsCompressor();
    this.compressorNode.threshold.value = -6;
    this.compressorNode.knee.value = 12;
    this.compressorNode.ratio.value = 4;
    this.compressorNode.attack.value = 0.005;
    this.compressorNode.release.value = 0.12;

    this.gainNode = ctx.createGain();
    this.gainNode.gain.value = this.enabled ? this.volume * MASTER_BOOST : 0;

    this.filterNode.connect(this.compressorNode);
    this.compressorNode.connect(this.gainNode);
    this.gainNode.connect(ctx.destination);
    this.resetSchedule();
    this.silentUnlocked = false;
    this.lastObservedCtxTime = -1;
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
      this.resetSchedule();
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

  private mixSegmentChannel(
    c: number,
    startSample: number,
    endSample: number,
    clocksPerSample: number,
    chipRam: Uint8Array,
    mask: number,
    left: Float32Array,
    right: Float32Array
  ): void {
    const active = this.segActive[c] !== 0;
    if (!active) return;

    const per = this.segPer[c] < 124 ? 124 : this.segPer[c];
    const vol = this.segVol[c];
    let curAddr = this.segCurAddr[c];
    let wordsLeft = this.segWordsLeft[c];
    const lc = this.segLc[c];
    const len = this.segLen[c] > 0 ? this.segLen[c] : 1;
    let clockRem = this.segClockRem[c];

    if (vol === 0) {
      // Zero-volume active channel: advance pointers accurately in O(1) without PCM loop
      const total = clockRem + (endSample - startSample) * clocksPerSample;
      const samples = (total / per) | 0;
      this.segClockRem[c] = total - samples * per;
      if (samples > 0) {
        const wordsDone = ((curAddr & 1) + samples) >>> 1;
        const newOdd = (curAddr + samples) & 1;
        if (wordsDone < wordsLeft) {
          this.segWordsLeft[c] = wordsLeft - wordsDone;
          this.segCurAddr[c] = (curAddr + samples) & mask;
        } else {
          const afterFirst = wordsDone - wordsLeft;
          const intoLoop = afterFirst % len;
          this.segWordsLeft[c] = len - intoLoop;
          this.segCurAddr[c] = (lc + (intoLoop << 1) + newOdd) & mask;
        }
        const prevB = chipRam[(this.segCurAddr[c] - 1) & mask];
        const prevS = prevB > 127 ? prevB - 256 : prevB;
        this.chPrevSample[c] = prevS;
        this.chCurSample[c] = prevS;
      }
      return;
    }

    const invPer = 1 / per;
    const gain = (vol / 64) * 0.5;
    const lGain = (c === 0 || c === 3 ? gain : gain * 0.3) * (1 / 128);
    const rGain = (c === 1 || c === 2 ? gain : gain * 0.3) * (1 / 128);
    let prevS = this.chPrevSample[c];
    let curS = this.chCurSample[c];

    for (let i = startSample; i < endSample; i++) {
      clockRem += clocksPerSample;
      while (clockRem >= per) {
        clockRem -= per;
        prevS = curS;
        const raw = chipRam[curAddr & mask];
        curS = raw > 127 ? raw - 256 : raw;
        curAddr = (curAddr + 1) & mask;
        if ((curAddr & 1) === 0) {
          wordsLeft--;
          if (wordsLeft <= 0) {
            curAddr = lc;
            wordsLeft = len;
          }
        }
      }
      const s = prevS + (curS - prevS) * (clockRem * invPer);
      left[i] += s * lGain;
      right[i] += s * rGain;
    }

    this.segCurAddr[c] = curAddr;
    this.segWordsLeft[c] = wordsLeft;
    this.segClockRem[c] = clockRem;
    this.chPrevSample[c] = prevS;
    this.chCurSample[c] = curS;
  }

  private mixScanlinedFrame(
    chipset: AmigaChipset,
    chipRam: Uint8Array,
    frames: number,
    left: Float32Array,
    right: Float32Array
  ): void {
    const mask = chipRam.length - 1;
    const totalClocks = chipset.frameAudClocks > 0 ? chipset.frameAudClocks : 313 * 227;
    const clocksPerSample = totalClocks / frames;

    for (let c = 0; c < 4; c++) {
      const active = chipset.audSnapActive[c];
      this.segActive[c] = active;
      if (active) {
        const curAddr = chipset.audSnapCurAddr[c];
        this.segCurAddr[c] = curAddr;
        this.segWordsLeft[c] = chipset.audSnapWordsLeft[c];
        this.segLc[c] = chipset.audSnapLc[c];
        this.segLen[c] = chipset.audSnapLen[c];
        this.segPer[c] = chipset.audSnapPer[c];
        this.segVol[c] = chipset.audSnapVol[c];
        this.segClockRem[c] = chipset.audSnapClockRem[c];
        if (!this.chWasActive[c]) {
          const raw = chipRam[curAddr & mask];
          const s0 = raw > 127 ? raw - 256 : raw;
          this.chPrevSample[c] = s0;
          this.chCurSample[c] = s0;
          this.chWasActive[c] = 1;
        }
      } else {
        this.chWasActive[c] = 0;
      }
    }

    const evtCount = chipset.audEvtCount;
    if (evtCount === 0) {
      // Fast path (95%+ of frames): mix entire frame in one tight loop per active channel
      for (let c = 0; c < 4; c++) {
        if (this.segActive[c]) {
          this.mixSegmentChannel(c, 0, frames, clocksPerSample, chipRam, mask, left, right);
        }
      }
      return;
    }

    const evtClock = chipset.audEvtClock;
    const evtType = chipset.audEvtType;
    const evtCh = chipset.audEvtCh;
    const evtArg1 = chipset.audEvtArg1;
    const evtArg2 = chipset.audEvtArg2;
    const evtArg3 = chipset.audEvtArg3;
    const clockToSample = frames / totalClocks;

    let samplePos = 0;
    let e = 0;
    while (e < evtCount) {
      let nextSample = Math.round(evtClock[e] * clockToSample);
      if (nextSample < samplePos) nextSample = samplePos;
      if (nextSample > frames) nextSample = frames;

      if (nextSample > samplePos) {
        for (let c = 0; c < 4; c++) {
          if (this.segActive[c]) {
            this.mixSegmentChannel(c, samplePos, nextSample, clocksPerSample, chipRam, mask, left, right);
          }
        }
        samplePos = nextSample;
      }

      // Apply all events occurring at or before `samplePos`
      while (e < evtCount) {
        let es = Math.round(evtClock[e] * clockToSample);
        if (es < samplePos) es = samplePos;
        if (es > frames) es = frames;
        if (es > samplePos) break;

        const kind = evtType[e];
        const chIdx = evtCh[e];
        if (kind === AUD_EVT_START) {
          const addr = evtArg1[e] >>> 0;
          const meta = evtArg3[e];
          const per = (meta >>> 7) & 0xffff;
          const vol = meta & 0x7f;
          this.segActive[chIdx] = 1;
          this.segCurAddr[chIdx] = addr;
          this.segWordsLeft[chIdx] = evtArg2[e];
          this.segLc[chIdx] = addr;
          this.segLen[chIdx] = evtArg2[e] > 0 ? evtArg2[e] : 1;
          this.segPer[chIdx] = per < 124 ? 124 : per;
          this.segVol[chIdx] = vol;
          this.segClockRem[chIdx] = 0;
          const raw = chipRam[addr & mask];
          const s0 = raw > 127 ? raw - 256 : raw;
          this.chPrevSample[chIdx] = s0;
          this.chCurSample[chIdx] = s0;
          this.chWasActive[chIdx] = 1;
        } else if (kind === AUD_EVT_STOP) {
          this.segActive[chIdx] = 0;
          this.chWasActive[chIdx] = 0;
        } else if (kind === AUD_EVT_PER) {
          this.segPer[chIdx] = evtArg1[e];
        } else if (kind === AUD_EVT_VOL) {
          this.segVol[chIdx] = evtArg1[e];
        } else if (kind === AUD_EVT_LCLEN) {
          this.segLc[chIdx] = evtArg1[e] >>> 0;
          this.segLen[chIdx] = evtArg2[e] > 0 ? evtArg2[e] : 1;
        }
        e++;
      }
    }

    if (samplePos < frames) {
      for (let c = 0; c < 4; c++) {
        if (this.segActive[c]) {
          this.mixSegmentChannel(c, samplePos, frames, clocksPerSample, chipRam, mask, left, right);
        }
      }
    }

    for (let c = 0; c < 4; c++) {
      this.chWasActive[c] = this.segActive[c];
    }
  }

  /**
   * Direct fallback mixer used only when pushFrame() is invoked without scanline stepping
   * (e.g. isolated unit tests). Advances chipset DMA channels directly and fires INT_AUDx.
   */
  private mixDirectFallback(
    chipset: AmigaChipset,
    chipRam: Uint8Array,
    isPal: boolean,
    frames: number,
    left: Float32Array,
    right: Float32Array
  ): void {
    const mask = chipRam.length - 1;
    const clocksPerSample = (isPal ? PAL_AUDIO_CLOCK : NTSC_AUDIO_CLOCK) / this.sampleRate;
    const channels = chipset.audio;

    for (let c = 0; c < 4; c++) {
      const ch = channels[c];
      if (!ch.active) {
        this.chWasActive[c] = 0;
        continue;
      }
      if (ch.vol === 0) {
        chipset.advanceAudioChannelSilent(c, isPal);
        this.chWasActive[c] = 1;
        continue;
      }

      if (!this.chWasActive[c]) {
        const raw = chipRam[ch.curAddr & mask];
        const s0 = raw > 127 ? raw - 256 : raw;
        this.chPrevSample[c] = s0;
        this.chCurSample[c] = s0;
        this.chWasActive[c] = 1;
      }

      const effPer = ch.per < 124 ? 124 : ch.per;
      const step = clocksPerSample / effPer;
      const gain = (ch.vol / 64) * 0.5;
      const lGain = (c === 0 || c === 3 ? gain : gain * 0.3) * (1 / 128);
      const rGain = (c === 1 || c === 2 ? gain : gain * 0.3) * (1 / 128);
      let prevS = this.chPrevSample[c];
      let curS = this.chCurSample[c];

      for (let i = 0; i < frames; i++) {
        ch.phase += step;
        while (ch.phase >= 1) {
          ch.phase -= 1;
          prevS = curS;
          const raw = chipRam[ch.curAddr & mask];
          curS = raw > 127 ? raw - 256 : raw;
          ch.lastSample = curS;
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
        const s = prevS + (curS - prevS) * ch.phase;
        left[i] += s * lGain;
        right[i] += s * rGain;
      }
      this.chPrevSample[c] = prevS;
      this.chCurSample[c] = curS;
    }
  }

  /**
   * Mixes one video frame (20.0ms PAL / 16.67ms NTSC) of Paula 4-channel DMA audio from Chip RAM.
   * Returns true when active channels were processed; returns false when muted/suspended/silent
   * so caller can advance INT_AUDx interrupts in O(1) with zero AudioBuffer allocations.
   */
  public pushFrame(chipset: AmigaChipset, chipRam: Uint8Array, isPal = true): boolean {
    if (!this.enabled || this.volume <= 0.001 || !this.ctx || !this.filterNode || this.ctx.state !== 'running') {
      return false;
    }

    const scanlined = chipset.audioSteppedInFrame;
    let anyActive = scanlined && chipset.audSawActivityInFrame;
    if (!anyActive) {
      const channels = chipset.audio;
      for (let i = 0; i < 4; i++) {
        if (channels[i].active && channels[i].vol > 0) {
          anyActive = true;
          break;
        }
      }
    }
    if (!anyActive) {
      this.resetSchedule();
      return false;
    }

    const now = this.ctx.currentTime;
    if (now !== this.lastObservedCtxTime) {
      this.lastObservedCtxTime = now;
      this.stalledPushCount = 0;
    } else {
      this.stalledPushCount++;
      // If AudioContext reports 'running' while currentTime stays completely frozen for ~2s, rebuild on next gesture
      if (this.stalledPushCount >= 100) {
        this.teardownContext();
        this.onNeedsUnlockCb?.();
        return false;
      }
    }

    const frames = isPal ? PAL_CHUNK_FRAMES : NTSC_CHUNK_FRAMES;
    const left = isPal ? this.leftPal : this.leftNtsc;
    const right = isPal ? this.rightPal : this.rightNtsc;
    left.fill(0);
    right.fill(0);

    if (scanlined) {
      this.mixScanlinedFrame(chipset, chipRam, frames, left, right);
    } else {
      this.mixDirectFallback(chipset, chipRam, isPal, frames, left, right);
    }

    if (
      this.nextScheduleTime === 0 ||
      this.nextScheduleTime < now - 0.002 ||
      this.nextScheduleTime - now > 0.5
    ) {
      this.nextScheduleTime = now + SCHEDULE_LEAD_SEC;
    } else if (this.nextScheduleTime - now > 0.22) {
      // Queue already holds >220ms of audio: avoid overlapping backward reset or excessive latency
      return true;
    }

    const audioBuffer = this.ctx.createBuffer(2, frames, this.sampleRate);
    audioBuffer.copyToChannel(left, 0);
    audioBuffer.copyToChannel(right, 1);

    const src = this.ctx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(this.filterNode);
    src.start(this.nextScheduleTime);
    this.nextScheduleTime += frames / this.sampleRate;
    return true;
  }

  public dispose(): void {
    this.onNeedsUnlockCb = null;
    this.onContextReadyCb = null;
    this.teardownContext();
  }
}

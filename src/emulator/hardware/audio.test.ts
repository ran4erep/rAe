import test from 'node:test';
import assert from 'node:assert/strict';
import { PaulaAudioEngine } from './audio';
import { AmigaChipset } from './chipset';
import { FloppyController } from './floppy';
import { AmigaMachine } from './amigaMachine';

class FakeAudioContext {
  public static instances: FakeAudioContext[] = [];
  public state: AudioContextState = 'suspended';
  public sampleRate = 48000;
  public currentTime = 0;
  public destination = {};
  public resumeCalls = 0;
  public closeCalls = 0;
  public bufferSourcesStarted = 0;
  public startedEvents: Array<{ when: number; length: number; sampleRate: number; left: Float32Array; right: Float32Array }> = [];
  private listeners = new Map<string, Set<() => void>>();

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  public addEventListener(type: string, cb: () => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }

  public removeEventListener(type: string, cb: () => void): void {
    this.listeners.get(type)?.delete(cb);
  }

  public emitState(next: AudioContextState): void {
    this.state = next;
    for (const cb of this.listeners.get('statechange') ?? []) {
      cb();
    }
  }

  public resume(): Promise<void> {
    this.resumeCalls++;
    this.emitState('running');
    return Promise.resolve();
  }

  public close(): Promise<void> {
    this.closeCalls++;
    this.state = 'closed';
    return Promise.resolve();
  }

  public createBiquadFilter() {
    return {
      type: 'lowpass',
      frequency: { value: 0, setTargetAtTime: () => {} },
      Q: { value: 0 },
      connect: () => {},
    };
  }

  public createDynamicsCompressor() {
    return {
      threshold: { value: 0 },
      knee: { value: 0 },
      ratio: { value: 0 },
      attack: { value: 0 },
      release: { value: 0 },
      connect: () => {},
    };
  }

  public createGain() {
    return {
      gain: { value: 0, setTargetAtTime: () => {} },
      connect: () => {},
    };
  }

  public createBuffer(channels: number, length: number, sampleRate: number) {
    const chData = [new Float32Array(length), new Float32Array(length)];
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      chData,
      copyToChannel: (src: Float32Array, ch: number) => {
        if (ch < 2) chData[ch].set(src.subarray(0, length));
      },
    };
  }

  public createBufferSource() {
    const owner = this;
    const node = {
      buffer: null as null | { length: number; sampleRate: number; chData: Float32Array[] },
      connect: () => {},
      start: (when = 0) => {
        owner.bufferSourcesStarted++;
        if (node.buffer && node.buffer.length > 1) {
          owner.startedEvents.push({
            when,
            length: node.buffer.length,
            sampleRate: node.buffer.sampleRate,
            left: node.buffer.chData[0],
            right: node.buffer.chData[1],
          });
        }
      },
    };
    return node;
  }
}

function withFakeWindowAudio<T>(fn: () => T): T {
  const prevWindow = (globalThis as Record<string, unknown>).window;
  FakeAudioContext.instances = [];
  (globalThis as Record<string, unknown>).window = {
    AudioContext: FakeAudioContext,
  };
  try {
    return fn();
  } finally {
    if (prevWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window;
    } else {
      (globalThis as Record<string, unknown>).window = prevWindow;
    }
  }
}

test('PaulaAudioEngine recovers from browser suspend, closed AudioContext, and frozen currentTime without page reload', () => {
  withFakeWindowAudio(() => {
    const engine = new PaulaAudioEngine();
    const readyContexts: unknown[] = [];
    let needsUnlockCount = 0;

    engine.setOnContextReady((ctx) => readyContexts.push(ctx));
    engine.setOnNeedsUnlock(() => {
      needsUnlockCount++;
    });

    // 1. Initial user gesture creates AudioContext, resumes to running, and fires silent unlock pulse
    engine.initFromGesture();
    assert.equal(FakeAudioContext.instances.length, 1);
    const ctx1 = FakeAudioContext.instances[0];
    assert.equal(engine.isContextRunning(), true);
    assert.equal(readyContexts.length, 1);
    assert.equal(ctx1.bufferSourcesStarted, 1);

    // 2. Browser suspends AudioContext (e.g. tab backgrounded or native file picker opened) -> onNeedsUnlock triggers
    ctx1.emitState('suspended');
    assert.equal(engine.isContextRunning(), false);
    assert.equal(needsUnlockCount, 1);

    // Returning to tab calls tryResume() and recovers running state
    engine.tryResume();
    assert.equal(engine.isContextRunning(), true);
    assert.equal(ctx1.resumeCalls, 2);

    // 3. If AudioContext is closed by OS/browser, next gesture rebuilds a fresh AudioContext
    ctx1.emitState('closed');
    assert.equal(needsUnlockCount, 2);
    engine.initFromGesture();
    assert.equal(FakeAudioContext.instances.length, 2);
    const ctx2 = FakeAudioContext.instances[1];
    assert.equal(engine.isContextRunning(), true);
    assert.equal(readyContexts.length, 2);

    // 4. If AudioContext claims 'running' while currentTime is completely frozen for 100 active frames,
    // PaulaAudioEngine tears down the stalled context and requests re-unlock
    const chipRam = new Uint8Array(512 * 1024);
    const chipset = new AmigaChipset(chipRam, new FloppyController(), () => {});
    chipset.audio[0].active = true;
    chipset.audio[0].vol = 64;
    chipset.audio[0].per = 200;
    chipset.audio[0].len = 32;
    chipset.audio[0].wordsLeft = 32;

    const unlockBeforeStall = needsUnlockCount;
    for (let i = 0; i <= 100; i++) {
      engine.pushFrame(chipset, chipRam);
    }
    assert.equal(ctx2.closeCalls, 1);
    assert.equal(needsUnlockCount, unlockBeforeStall + 1);
    assert.equal(engine.isContextRunning(), false);

    // Next user gesture immediately recreates a working AudioContext
    engine.initFromGesture();
    assert.equal(FakeAudioContext.instances.length, 3);
    assert.equal(engine.isContextRunning(), true);

    engine.dispose();
  });
});

test('Paula AUDxDAT triggers INT_AUDx when DMA is disabled and advances DMA IRQs in silent O(1) mode', () => {
  const chipRam = new Uint8Array(512 * 1024);
  const floppy = new FloppyController();
  let lastIpl = 0;
  const chipset = new AmigaChipset(chipRam, floppy, (ipl) => {
    lastIpl = ipl;
  });

  // 1. Mimic Commodore audio.device channel start: AUD1PER = 1, AUD1DAT = $FFFF with DMA off
  chipset.writeReg16(0x09a, 0xc100); // INTEN | INT_AUD1
  chipset.writeReg16(0x0b6, 1);      // AUD1PER = 1
  chipset.writeReg16(0x0ba, 0xffff); // AUD1DAT = $FFFF
  assert.equal((chipset.intreq & 0x0100) === 0, true);
  assert.equal((chipset.audDatPendingMask & 0x02) !== 0, true);

  // Fires on the same scanline once period (2 color clocks) expires
  chipset.stepAudDatPending();
  assert.equal((chipset.intreq & 0x0100) !== 0, true);
  assert.equal(lastIpl, 4);

  // Clear IRQ and verify longer AUD0PER = 300 takes 3 scanlines (600 color clocks > 2*227)
  chipset.clearIrq(0x0100);
  chipset.writeReg16(0x09a, 0x8080); // INT_AUD0
  chipset.writeReg16(0x0a6, 300);    // AUD0PER = 300 -> 600 color clocks
  chipset.writeReg16(0x0aa, 0x1234); // AUD0DAT
  chipset.stepAudDatPending();
  assert.equal((chipset.intreq & 0x0080) !== 0, false);
  chipset.stepAudDatPending();
  assert.equal((chipset.intreq & 0x0080) !== 0, false);
  chipset.stepAudDatPending();
  assert.equal((chipset.intreq & 0x0080) !== 0, true);

  // 2. Active DMA channel with vol === 0 must still advance wordsLeft and fire reload INT_AUD0 in O(1)
  chipset.clearIrq(0x0080);
  chipset.writeReg16(0x0a0, 0x0001); // AUD0LCH = $010000
  chipset.writeReg16(0x0a2, 0x0000);
  chipset.writeReg16(0x0a4, 200);    // AUD0LEN = 200 words (400 bytes)
  chipset.writeReg16(0x0a6, 200);    // AUD0PER = 200 (~354 samples/frame -> ~177 words/frame)
  chipset.writeReg16(0x0a8, 0);      // AUD0VOL = 0 (silent!)
  chipset.writeReg16(0x096, 0x8201); // DMAEN | AUD0EN
  chipset.clearIrq(0x0080);          // clear startup reload IRQ

  // Frame 1: ~177 words consumed -> wordsLeft drops, no wrap yet
  chipset.advanceAudioDmaSilent(true);
  assert.equal((chipset.intreq & 0x0080) !== 0, false);
  assert.ok(chipset.audio[0].wordsLeft > 0 && chipset.audio[0].wordsLeft < 40);

  // Frame 2: wraps past 200 words -> reloads and fires INT_AUD0
  chipset.advanceAudioDmaSilent(true);
  assert.equal((chipset.intreq & 0x0080) !== 0, true);
  assert.ok(chipset.audio[0].wordsLeft > 40);
});

test('PaulaAudioEngine steps vol=0 active channels silently while mixing audible channels', () => {
  withFakeWindowAudio(() => {
    const engine = new PaulaAudioEngine();
    engine.initFromGesture();
    const ctx = FakeAudioContext.instances[0];
    ctx.currentTime = 0.1;

    const chipRam = new Uint8Array(512 * 1024);
    chipRam[0x2000] = 60;
    chipRam[0x2001] = 196; // -60 signed
    const chipset = new AmigaChipset(chipRam, new FloppyController(), () => {});

    // Channel 0 audible, Channel 1 active with vol=0 and small buffer (wraps inside 1 frame)
    chipset.writeReg16(0x0a0, 0x0000);
    chipset.writeReg16(0x0a2, 0x2000);
    chipset.writeReg16(0x0a4, 1);
    chipset.writeReg16(0x0a6, 200);
    chipset.writeReg16(0x0a8, 64);

    chipset.writeReg16(0x0b0, 0x0000);
    chipset.writeReg16(0x0b2, 0x3000);
    chipset.writeReg16(0x0b4, 50);
    chipset.writeReg16(0x0b6, 200);
    chipset.writeReg16(0x0b8, 0);

    chipset.writeReg16(0x096, 0x8203); // DMAEN | AUD0EN | AUD1EN
    chipset.clearIrq(0x0180);

    const stepped = engine.pushFrame(chipset, chipRam, true);
    assert.equal(stepped, true);
    assert.equal((chipset.intreq & 0x0100) !== 0, true, 'vol=0 active channel still fires INT_AUD1');
    assert.equal(ctx.bufferSourcesStarted, 2); // 1 silent unlock + 1 audio frame

    engine.dispose();
  });
});

test('Dune 2 audio.device activates Paula DMA and emits non-silent samples after AUDxDAT fix', async () => {
  const fs = await import('node:fs');
  const romPath = 'bios/Kickstart v3.1 rev 40.68 (1993)(Commodore)(A1200)[!].rom';
  const statePath = 'savestate-Dune2_v1_1_1548-live-20261123-225413.json';
  if (!fs.existsSync(romPath) || !fs.existsSync(statePath)) return;

  const { AmigaMachine } = await import('./amigaMachine');
  const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const rom = new Uint8Array(fs.readFileSync(romPath));

  const machine = new AmigaMachine();
  machine.loadCustomRom(rom, 'Kickstart v3.1 rev 40.68');
  assert.equal(machine.loadSaveBundle(raw.savestate.state, null, null), true);

  let audioActiveFrames = 0;
  let audibleChannelPeak = 0;
  for (let i = 0; i < 600; i++) {
    machine.stepFrame(false, false);
    for (let c = 0; c < 4; c++) {
      const ch = machine.chipset.audio[c];
      if (ch.active && ch.vol > 0) {
        audioActiveFrames++;
        const rawByte = machine.memory.chipRam[ch.curAddr & (machine.memory.chipRam.length - 1)];
        const signed = rawByte > 127 ? rawByte - 256 : rawByte;
        if (Math.abs(signed) > audibleChannelPeak) audibleChannelPeak = Math.abs(signed);
      }
    }
  }

  assert.ok(audioActiveFrames > 100, `expected >100 active audio frames, got ${audioActiveFrames}`);
  assert.ok(audibleChannelPeak > 10, `expected non-silent Chip RAM PCM peak, got ${audibleChannelPeak}`);
  machine.dispose();
});

test('DMACON startup INT_AUDx survives immediate INTREQ clear and cancels cleanly if DMA disabled early', () => {
  const chipRam = new Uint8Array(512 * 1024);
  let lastIpl = 0;
  const chipset = new AmigaChipset(chipRam, new FloppyController(), (ipl) => {
    lastIpl = ipl;
  });

  chipset.startFrame();
  chipset.beginScanline(3, 0, 908);

  // Typical game sequence (Mega Lo Mania / Gods): set pointers, enable DMA, clear stale INTREQ, enable INTENA
  chipset.writeReg16(0x0d0, 0x0002); // AUD3LCH = $020000
  chipset.writeReg16(0x0d2, 0x46f0); // AUD3LCL
  chipset.writeReg16(0x0d4, 14994);  // AUD3LEN
  chipset.writeReg16(0x0d6, 240);    // AUD3PER
  chipset.writeReg16(0x0d8, 40);     // AUD3VOL
  chipset.writeReg16(0x096, 0x8208); // DMACON = DMAEN | AUD3EN
  chipset.writeReg16(0x09c, 0x0400); // INTREQ = clear AUD3 (must NOT erase pending DMA startup IRQ!)
  chipset.writeReg16(0x09a, 0xc400); // INTENA = INTEN | AUD3

  assert.equal(chipset.intreq & 0x0400, 0, 'startup IRQ must not fire synchronously on DMACON write');
  assert.notEqual(chipset.audStartPendingMask & 0x08, 0);

  // Advance 2 scanlines -> startup IRQ fires cleanly
  chipset.stepAudioScanline(227);
  chipset.beginScanline(4, 908, 908);
  chipset.stepAudioScanline(227);
  assert.equal(chipset.intreq & 0x0400, 0x0400, 'startup INT_AUD3 must fire after DMA startup delay');
  assert.equal(lastIpl, 4);

  // Early disable before startup expires must cancel pending startup IRQ
  chipset.writeReg16(0x096, 0x0008); // ensure off first
  chipset.writeReg16(0x09c, 0x0400);
  chipset.writeReg16(0x096, 0x8208);
  assert.notEqual(chipset.audStartPendingMask & 0x08, 0);
  chipset.writeReg16(0x096, 0x0008); // disable AUD3 immediately
  assert.equal(chipset.audStartPendingMask & 0x08, 0);
  chipset.stepAudioScanline(227);
  chipset.stepAudioScanline(227);
  assert.equal(chipset.intreq & 0x0400, 0, 'disabling DMA early cancels startup IRQ');
});

test('Scanline audio captures intra-frame bursts and schedules zero gaps under 60Hz rAF jitter', () => {
  withFakeWindowAudio(() => {
    const engine = new PaulaAudioEngine();
    engine.initFromGesture();
    const ctx = FakeAudioContext.instances[0];
    ctx.currentTime = 1.0;

    const chipRam = new Uint8Array(512 * 1024);
    for (let i = 0; i < 64; i++) {
      chipRam[0x4000 + i] = (Math.round(Math.sin((i / 64) * Math.PI * 2) * 100) + 256) & 0xff;
    }
    const chipset = new AmigaChipset(chipRam, new FloppyController(), () => {});

    // Frame 1: channel 0 turns on mid-frame at line 40, plays until line 220, and turns off before frame end
    chipset.startFrame();
    for (let line = 0; line < 313; line++) {
      chipset.beginScanline(line, line * 454, 454);
      if (line === 40) {
        chipset.writeReg16(0x0a0, 0x0000);
        chipset.writeReg16(0x0a2, 0x4000);
        chipset.writeReg16(0x0a4, 32);
        chipset.writeReg16(0x0a6, 200);
        chipset.writeReg16(0x0a8, 64);
        chipset.writeReg16(0x096, 0x8201);
      } else if (line === 220) {
        chipset.writeReg16(0x096, 0x0001); // stop mid-frame!
      }
      chipset.stepAudioScanline(227);
    }
    assert.equal(chipset.audSawActivityInFrame, true);
    const pushed = engine.pushFrame(chipset, chipRam, true);
    assert.equal(pushed, true);
    assert.equal(ctx.startedEvents.length, 1);
    const ev0 = ctx.startedEvents[0];
    assert.equal(ev0.sampleRate, 44100);
    assert.equal(ev0.length, 882);
    let peak = 0;
    for (let i = 0; i < ev0.left.length; i++) {
      const a = Math.abs(ev0.left[i]);
      if (a > peak) peak = a;
    }
    assert.ok(peak > 0.05, `expected audible intra-frame burst PCM peak, got ${peak}`);

    // Now test 60Hz rAF jitter pattern (intervals between emulator frames alternate 16.67ms and 33.33ms)
    engine.resetSchedule();
    ctx.startedEvents.length = 0;
    let wall = 2.0;
    const rAFStep = 1 / 60;
    let accum = 0;
    for (let tick = 0; tick < 80; tick++) {
      wall += rAFStep;
      accum += rAFStep;
      while (accum >= 0.02) {
        accum -= 0.02;
        ctx.currentTime = wall;
        chipset.startFrame();
        chipset.writeReg16(0x0a0, 0x0000);
        chipset.writeReg16(0x0a2, 0x4000);
        chipset.writeReg16(0x0a4, 32);
        chipset.writeReg16(0x0a6, 200);
        chipset.writeReg16(0x0a8, 64);
        if ((chipset.dmacon & 0x0201) !== 0x0201) {
          chipset.writeReg16(0x096, 0x8201);
        }
        for (let line = 0; line < 313; line++) {
          chipset.beginScanline(line, line * 454, 454);
          chipset.stepAudioScanline(227);
        }
        engine.pushFrame(chipset, chipRam, true);
      }
    }

    assert.ok(ctx.startedEvents.length >= 60);
    for (let i = 1; i < ctx.startedEvents.length; i++) {
      const prev = ctx.startedEvents[i - 1];
      const cur = ctx.startedEvents[i];
      const expectedWhen = prev.when + prev.length / prev.sampleRate;
      assert.ok(
        Math.abs(cur.when - expectedWhen) < 1e-6,
        `expected contiguous WebAudio scheduling at chunk ${i}: got ${cur.when} vs ${expectedWhen}`
      );
    }

    // Verify NTSC chunk size (735 samples @ 44100 Hz = 16.667ms)
    chipset.startFrame();
    for (let line = 0; line < 263; line++) {
      chipset.beginScanline(line, line * 455, 455);
      chipset.stepAudioScanline((line & 1) === 0 ? 227 : 228);
    }
    engine.pushFrame(chipset, chipRam, false);
    const ntscEv = ctx.startedEvents[ctx.startedEvents.length - 1];
    assert.equal(ntscEv.length, 735);

    engine.dispose();
  });
});

test('Mega Lo Mania A1200 savestate plays speech cleanly once without looping/clipping cutoff', async () => {
  const fs = await import('node:fs');
  const romPath = 'bios/Kickstart v3.1 rev 40.68 (1993)(Commodore)(A1200)[!].rom';
  const statePath = 'savestate-MegaLoMania_v1_7_0272-live-20261124-004450.json';
  if (!fs.existsSync(romPath) || !fs.existsSync(statePath)) return;

  const { AmigaMachine } = await import('./amigaMachine');
  const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const rom = new Uint8Array(fs.readFileSync(romPath));

  await withFakeWindowAudio(async () => {
    const machine = new AmigaMachine();
    machine.loadCustomRom(rom, 'Kickstart v3.1 rev 40.68');
    assert.equal(machine.loadSaveBundle(raw.savestate.state, null, null), true);

    machine.audio.initFromGesture();
    const ctx = FakeAudioContext.instances[0];
    ctx.currentTime = 0.05;

    let sawSilenceSwap = false;
    const chunkPeaks: number[] = [];
    for (let f = 0; f < 220; f++) {
      ctx.currentTime += 0.02;
      machine.stepFrame(false, true);
      const ch3 = machine.chipset.audio[3];
      if (f >= 78 && f <= 90 && ch3.lc === 0x00ace2 && ch3.len === 1) {
        sawSilenceSwap = true;
      }
      if (ctx.startedEvents.length > chunkPeaks.length) {
        const ev = ctx.startedEvents[ctx.startedEvents.length - 1];
        let pk = 0;
        for (let i = 0; i < ev.left.length; i++) {
          const v = Math.abs(ev.left[i]);
          if (v > pk) pk = v;
        }
        chunkPeaks.push(pk);
      }
    }

    assert.equal(sawSilenceSwap, true, 'Level 4 ISR must swap AUD3LC to silence loop ($ACE2/1) right after startup IRQ');
    assert.ok(chunkPeaks.length >= 95 && chunkPeaks.length <= 105, `expected single ~2.0s playback (~101 frames), got ${chunkPeaks.length} frames`);
    assert.ok(chunkPeaks[5] > 0.15, `expected strong speech signal in main phrase, got ${chunkPeaks[5]}`);
    // Tail of sample decays smoothly without restarting a second speech burst at frames 98..102
    const tailPeak = Math.max(...chunkPeaks.slice(-3));
    assert.ok(tailPeak < 0.05, `expected speech tail to finish quietly instead of restarting, got tailPeak=${tailPeak}`);
    assert.equal(machine.chipset.audio[3].active, false, 'AUD3 DMA should be cleanly stopped after sample ends');

    machine.dispose();
  });
});

test('Disabling an active Paula audio DMA channel finishes the current word and asserts INT_AUDx', () => {
  const chipRam = new Uint8Array(512 * 1024);
  let lastIpl = 0;
  const chipset = new AmigaChipset(chipRam, new FloppyController(), (ipl) => {
    lastIpl = ipl;
  });

  chipset.startFrame();
  chipset.beginScanline(10, 0, 908);
  chipset.writeReg16(0x09a, 0xc080); // INTEN | INT_AUD0
  chipset.writeReg16(0x0a0, 0x0001);
  chipset.writeReg16(0x0a2, 0x0000);
  chipset.writeReg16(0x0a4, 100);
  chipset.writeReg16(0x0a6, 200);
  chipset.writeReg16(0x0a8, 64);
  chipset.writeReg16(0x096, 0x8201); // DMAEN | AUD0EN

  // Complete DMA startup (~2 scanlines) and clear startup INT_AUD0
  chipset.stepAudioScanline(227);
  chipset.beginScanline(11, 908, 908);
  chipset.stepAudioScanline(227);
  assert.equal(chipset.intreq & 0x0080, 0x0080);
  assert.equal(chipset.audStartPendingMask & 0x01, 0);

  // Typical ProTracker / Worms DC stop sequence: set AUD0PER=1, clear INTREQ, disable AUD0 DMA, poll INTREQR
  chipset.beginScanline(12, 1816, 908);
  chipset.writeReg16(0x0a6, 1);
  chipset.writeReg16(0x09c, 0x0080);
  chipset.writeReg16(0x096, 0x0001);
  assert.equal(chipset.audio[0].active, false);
  assert.equal(chipset.intreq & 0x0080, 0);
  assert.notEqual(chipset.audDatPendingMask & 0x01, 0);

  chipset.stepAudioScanline(227);
  assert.equal(chipset.intreq & 0x0080, 0x0080);
  assert.equal(lastIpl, 4);
});

test('Paula INTENA -> INTREQ clear sequence (Gloom Level-4 SFX) honors 1-instruction IPL holdoff without killing sample', () => {
  const amiga = new AmigaMachine(
    { chipset: 'AGA', videoStandard: 'PAL', chipRamKB: 2048, audioEnabled: false },
    { skipDefaultDisk: true }
  );
  amiga.memory.ovl = false;
  const c = amiga.chipset;
  const wr16 = (a: number, v: number) => amiga.memory.write16(a, v);
  const wr32 = (a: number, v: number) => amiga.memory.write32(a, v);

  // Sample buffer at $030000: 1000 words (~11 frames at per=350)
  for (let i = 0; i < 2000; i++) {
    amiga.memory.chipRam[0x030000 + i] = (i & 15) * 8;
  }

  // Level 4 ISR at $010100: mimics Gloom audio IRQ state machine (-2 -> -1 skip, -1 -> 0 stop DMA)
  //   010100: TST.W $012000; BGE.S stop; ADDQ.W #1,$012000; BLT.S ack
  //   stop:   MOVE.W #$0080,$DFF09A; MOVE.W #$0001,$DFF096
  //   ack:    MOVE.W #$0080,$DFF09C; RTE
  let isr = 0x010100;
  wr16(isr, 0x4a79); wr32(isr + 2, 0x00012000); isr += 6; // TST.W $12000 (010100..010105)
  wr16(isr, 0x6c08); isr += 2;                           // BGE.S +8 -> 010110 (stop)
  wr16(isr, 0x5279); wr32(isr + 2, 0x00012000); isr += 6; // ADDQ.W #1, $12000 (010108..01010d)
  wr16(isr, 0x6d10); isr += 2;                           // BLT.S +16 -> 010120 (ack)
  // stop (010110):
  wr16(isr, 0x33fc); wr16(isr + 2, 0x0080); wr32(isr + 4, 0x00dff09a); isr += 8; // INTENA=$0080
  wr16(isr, 0x33fc); wr16(isr + 2, 0x0001); wr32(isr + 4, 0x00dff096); isr += 8; // DMACON=$0001
  // ack (010120):
  wr16(isr, 0x33fc); wr16(isr + 2, 0x0080); wr32(isr + 4, 0x00dff09c); isr += 8; // INTREQ=$0080
  wr16(isr, 0x4e73);                                                             // RTE
  wr32(0x000070, 0x00010100); // Level 4 vector

  // Main code at $010000:
  //   MOVE.W #$FFFE, $12000   (state = -2)
  //   MOVE.W #$8201, $DFF096  (enable MASTER | AUD0 DMA)
  //   MOVE.W #$8080, $DFF09A  (enable INT_AUD0 BEFORE clearing stale INTREQ!)
  //   MOVE.W #$0080, $DFF09C  (clear stale INT_AUD0 — must execute BEFORE Level 4 fires!)
  //   BRA.S  self
  let pc = 0x010000;
  wr16(pc, 0x33fc); wr16(pc + 2, 0xfffe); wr32(pc + 4, 0x00012000); pc += 8;
  wr16(pc, 0x33fc); wr16(pc + 2, 0x8201); wr32(pc + 4, 0x00dff096); pc += 8;
  wr16(pc, 0x33fc); wr16(pc + 2, 0x8080); wr32(pc + 4, 0x00dff09a); pc += 8;
  wr16(pc, 0x33fc); wr16(pc + 2, 0x0080); wr32(pc + 4, 0x00dff09c); pc += 8;
  wr16(pc, 0x60fe);

  // Pre-seed stale pending INT_AUD0 in INTREQ (left over from previous channel stop) and configure AUD0
  c.writeReg16(0x09a, 0xc000); // INTEN=1, INT_AUD0=0
  c.writeReg16(0x09c, 0x8080); // Stale INT_AUD0 pending in INTREQ
  c.writeReg16(0x0a0, 0x0003);
  c.writeReg16(0x0a2, 0x0000);
  c.writeReg16(0x0a4, 1000);
  c.writeReg16(0x0a6, 350);
  c.writeReg16(0x0a8, 64);

  amiga.cpu.pc = 0x010000;
  amiga.cpu.sr = 0x2000;
  amiga.cpu.a[7] = 0x020000;

  amiga.stepFrame(false, true);
  // After startup scanline IRQ ONLY, state must be -1 (0xffff) and AUD0 DMA must STILL be active!
  assert.equal(amiga.memory.read16(0x012000), 0xffff, 'Phantom INT_AUD0 must not fire between INTENA and INTREQ clear');
  assert.equal(c.audio[0].active, true, 'AUD0 DMA must stay active while playing 1000-word SFX');

  // Advance frames until the 1000-word sample completes (~11 PAL frames), then Level 4 ISR stops it cleanly
  for (let f = 0; f < 15; f++) amiga.stepFrame(false, true);
  assert.equal(amiga.memory.read16(0x012000), 0x0000, 'Second INT_AUD0 at sample end must advance state to 0');
  assert.equal(c.audio[0].active, false, 'AUD0 DMA must stop cleanly after full sample completes');

  // Verify STOP immediately after INTENA still wakes once 1-instruction holdoff expires
  let pc2 = 0x010200;
  wr16(pc2, 0x33fc); wr16(pc2 + 2, 0xfffe); wr32(pc2 + 4, 0x00012000); pc2 += 8;
  wr16(pc2, 0x33fc); wr16(pc2 + 2, 0x8080); wr32(pc2 + 4, 0x00dff09a); pc2 += 8; // INTENA=$8080 with stale INTREQ
  wr16(pc2, 0x4e72); wr16(pc2 + 2, 0x2000); pc2 += 4;                           // STOP #$2000
  wr16(pc2, 0x60fe);
  c.writeReg16(0x09a, 0x0080); // Disable INT_AUD0
  c.writeReg16(0x09c, 0x8080); // Set INT_AUD0
  amiga.cpu.pc = 0x010200;
  amiga.cpu.sr = 0x2000;
  amiga.cpu.runCycles(200);
  assert.equal(amiga.cpu.stopped, false, 'STOP right after INTENA must still wake after 1-instruction IPL holdoff');
  assert.equal(amiga.memory.read16(0x012000), 0xffff, 'Level 4 ISR must execute after STOP wakes');
});



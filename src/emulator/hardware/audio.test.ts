import test from 'node:test';
import assert from 'node:assert/strict';
import { PaulaAudioEngine } from './audio';
import { AmigaChipset } from './chipset';
import { FloppyController } from './floppy';

class FakeAudioContext {
  public static instances: FakeAudioContext[] = [];
  public state: AudioContextState = 'suspended';
  public sampleRate = 48000;
  public currentTime = 0;
  public destination = {};
  public resumeCalls = 0;
  public closeCalls = 0;
  public bufferSourcesStarted = 0;
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
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      copyToChannel: () => {},
    };
  }

  public createBufferSource() {
    return {
      buffer: null,
      connect: () => {},
      start: () => {
        this.bufferSourcesStarted++;
      },
    };
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

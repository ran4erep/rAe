/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, CircleSlash, Download, FilePlus2, FolderUp, Gamepad2, HardDrive, Hash, Keyboard, LayoutGrid, Lock, MousePointer, Pencil } from 'lucide-react';
import { ArchiveMediaCandidate, resolveUploadedFileAsync } from './emulator/archives/archiveManager';
import { CatalogGameItem, downloadCatalogArchive } from './emulator/catalog/amigaArchiveCatalog';
import {
  clampPct,
  ControlButtonSize,
  ControlTarget,
  createDefaultStickConfig,
  createProfile,
  CustomButtonConfig,
  CustomProfilesState,
  deleteProfile,
  getActiveProfile,
  loadCustomProfiles,
  renameProfile,
  saveCustomProfiles,
  StickDirection,
  updateActiveProfile,
} from './emulator/controls/customProfiles';
import {
  hasAnyConnectedGamepad,
  PhysicalGamepadSink,
  PhysicalGamepadTracker,
} from './emulator/controls/physicalGamepad';
import { setHapticsEnabled } from './emulator/haptics';
import { AmigaMachine } from './emulator/hardware/amigaMachine';
import { AutoCropTracker, CropRect, cropPhysicalAspect, FULL_CROP } from './emulator/hardware/autoCrop';
import { AMIGA_RAW, BROWSER_CODE_TO_AMIGA } from './emulator/keyboard/amigaKeyMap';
import {
  hasConfigChanged,
  loadSavedAmigaConfig,
  saveAmigaConfig,
} from './emulator/settingsStorage';
import {
  createEmptySlotMap,
  deleteFromStorage,
  deleteSlotData,
  listSaveSlotSummaries,
  loadBinaryFromStorage,
  loadSlotData,
  saveBinaryToStorage,
  saveSlotData,
} from './emulator/storage';
import {
  AmigaConfig,
  AmigaStatusSnapshot,
  DEFAULT_AMIGA_CONFIG,
  JoystickState,
  NTSC_FPS,
  PAL_FPS,
  SaveSlotIndex,
  SaveSlotSummary,
} from './emulator/types';
import { FullscreenOverlayMode, HardwareTopBar } from './components/HardwareTopBar';
import { AmigaScreen } from './components/AmigaScreen';
import { FloppyDiskIcon } from './components/FloppyDiskIcon';
import { AmigaKeyboard } from './components/AmigaKeyboard';
import { AmigaKeyboardPicker } from './components/AmigaKeyboardPicker';
import { CustomControlsOverlay } from './components/CustomControlsOverlay';
import { CustomEditToolbar, CustomSelection } from './components/CustomEditToolbar';
import { TouchGamepad } from './components/TouchGamepad';
import { TouchpadDeck } from './components/TouchpadDeck';
import { ArchiveModal, PendingArchiveChoice } from './components/ArchiveModal';
import { CatalogViewState, createInitialCatalogViewState } from './components/CatalogTab';
import { DiskRomDrawer, LaunchDrawerTab } from './components/DiskRomDrawer';
import { HardfileSizePanel } from './components/HardfileSizePanel';
import { SettingsDrawer } from './components/SettingsDrawer';
import { SaveSlotsList } from './components/SaveSlotsList';
import { ToastContainer, ToastMessage } from './components/ToastContainer';
import { getAppAssetUrl } from './utils/assetUrl';

type MobileDeckMode = 'qwerty' | 'numpad' | 'mouse' | 'gamepad' | 'custom';

const DEFAULT_BIOS_ROM_NAME = 'Kickstart v1.3 r34.005 (1987-12)(Commodore)(A3000)[!].rom';
const DEFAULT_BIOS_ROM_URL = getAppAssetUrl(`bios/${encodeURIComponent(DEFAULT_BIOS_ROM_NAME)}`);
const DEFAULT_WORKBENCH_NAME = 'workbench.LHA';
const DEFAULT_WORKBENCH_URL = getAppAssetUrl(`bios/${encodeURIComponent(DEFAULT_WORKBENCH_NAME)}`);
const SYSTEM_DH0_STORAGE_KEY = 'system_dh0_hdf_v2';
const DH0_SIZE_STORAGE_KEY = 'amiga_dh0_size_mb';
const DH1_SIZE_STORAGE_KEY = 'amiga_dh1_size_mb';
const DEFAULT_HDF_SIZE_MB = 4;

function loadSavedHdfSizeMB(key: string, fallbackKey?: string): number {
  try {
    const raw =
      window.localStorage.getItem(key) ??
      (fallbackKey ? window.localStorage.getItem(fallbackKey) : null);
    if (raw) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 64) {
        return Math.round(parsed);
      }
    }
  } catch {
    // Ignore storage errors
  }
  return DEFAULT_HDF_SIZE_MB;
}

export default function App() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const wasNativeFsRef = useRef(false);
  const machineRef = useRef<AmigaMachine | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [config, setConfig] = useState<AmigaConfig>(() => loadSavedAmigaConfig());
  const configRef = useRef<AmigaConfig>(config);
  configRef.current = config;
  const [cropAspect, setCropAspect] = useState<number>(4 / 3);
  const autoCropRef = useRef<AutoCropTracker>(new AutoCropTracker());
  const cropRectRef = useRef<CropRect>({ ...FULL_CROP });
  const [mobileDeck, setMobileDeck] = useState<MobileDeckMode>('qwerty');
  const [customProfilesState, setCustomProfilesState] = useState<CustomProfilesState>(() => loadCustomProfiles());
  const [customEditMode, setCustomEditMode] = useState(false);
  const [customSelection, setCustomSelection] = useState<CustomSelection>(null);
  const [customPickerContext, setCustomPickerContext] = useState<
    | { kind: 'button'; buttonId: string }
    | { kind: 'stick-dir'; dir: StickDirection }
    | null
  >(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenOverlayHidden, setFullscreenOverlayHidden] = useState(false);
  const thumbCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const sidebarDf0InputRef = useRef<HTMLInputElement | null>(null);
  const sidebarDf1InputRef = useRef<HTMLInputElement | null>(null);
  const sidebarDh1InputRef = useRef<HTMLInputElement | null>(null);
  const [disksOpen, setDisksOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const modalOpenRef = useRef(false);
  const [dh0SizeMB, setDh0SizeMB] = useState<number>(() =>
    loadSavedHdfSizeMB(DH0_SIZE_STORAGE_KEY, 'amiga_hdf_size_mb')
  );
  const dh0SizeRef = useRef<number>(dh0SizeMB);
  dh0SizeRef.current = dh0SizeMB;
  const [dh1SizeMB, setDh1SizeMB] = useState<number>(() =>
    loadSavedHdfSizeMB(DH1_SIZE_STORAGE_KEY)
  );
  const dh1SizeRef = useRef<number>(dh1SizeMB);
  dh1SizeRef.current = dh1SizeMB;
  const dh0SavedSeqRef = useRef<number>(0);
  const [pendingArchive, setPendingArchive] = useState<PendingArchiveChoice | null>(null);
  const [lastArchive, setLastArchive] = useState<PendingArchiveChoice | null>(null);
  const lastLaunchViewRef = useRef<'drawer' | 'archive'>('drawer');
  const [drawerTab, setDrawerTab] = useState<LaunchDrawerTab>('launch');
  const [catalogState, setCatalogState] = useState<CatalogViewState>(() => createInitialCatalogViewState());
  const [launchingCatalogId, setLaunchingCatalogId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const toastSeqRef = useRef(0);
  const toastTimersRef = useRef<Map<number, number>>(new Map());
  const [saveSlots, setSaveSlots] = useState<Record<SaveSlotIndex, SaveSlotSummary | null>>(() =>
    createEmptySlotMap()
  );
  const [status, setStatus] = useState<AmigaStatusSnapshot>({
    running: true,
    paused: false,
    fps: 50,
    cpuUsageHint: 4,
    chipset: DEFAULT_AMIGA_CONFIG.chipset,
    videoStandard: DEFAULT_AMIGA_CONFIG.videoStandard,
    romName: DEFAULT_BIOS_ROM_NAME,
    isOpenKick: false,
    powerLed: true,
    capsLock: false,
    df0: { inserted: false, name: '', track: 0, side: 0, motorOn: false, activeIo: false, stepPhase: false, writeProtected: true },
    df1: { inserted: false, name: '', track: 0, side: 0, motorOn: false, activeIo: false, stepPhase: false, writeProtected: true },
    dh0: {
      mounted: false,
      name: '',
      sizeBytes: 0,
      usedBytes: 0,
      freeBytes: 0,
      minSizeMB: 1,
      canResize: false,
      dosType: '',
      volumeName: '',
      partitionCount: 0,
      activeIo: false,
      writeProtected: false,
    },
    dh1: {
      mounted: false,
      name: '',
      sizeBytes: 0,
      usedBytes: 0,
      freeBytes: 0,
      minSizeMB: 1,
      canResize: false,
      dosType: '',
      volumeName: '',
      partitionCount: 0,
      activeIo: false,
      writeProtected: false,
    },
    pc: 0,
    frameCount: 0,
    lastKeyCode: null,
  });

  // Mount emulator core ONCE & run optimized zero-GC rAF loop outside React
  useEffect(() => {
    setHapticsEnabled(configRef.current.hapticsEnabled);
    const machine = new AmigaMachine(configRef.current, { skipDefaultDisk: true });
    machineRef.current = machine;

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d', { alpha: false, desynchronized: true }) ?? null;
    const surface: {
      w: number;
      h: number;
      imageData: ImageData | null;
      imageU32: Uint32Array | null;
    } = { w: 0, h: 0, imageData: null, imageU32: null };
    let lastCanvasOverscan = '';
    let lastVideoStd = machine.config.videoStandard;

    const ensureSurface = (w: number, h: number): { imageData: ImageData; imageU32: Uint32Array } | null => {
      if (!ctx) return null;
      const std = machine.config.videoStandard;
      if (surface.imageData && surface.imageU32 && surface.w === w && surface.h === h) {
        if (std !== lastVideoStd) {
          lastVideoStd = std;
          setCropAspect(cropPhysicalAspect(cropRectRef.current, std));
        }
        return surface as { imageData: ImageData; imageU32: Uint32Array };
      }
      surface.w = w;
      surface.h = h;
      lastVideoStd = std;
      surface.imageData = ctx.createImageData(w, h);
      surface.imageU32 = new Uint32Array(surface.imageData.data.buffer);
      cropRectRef.current = autoCropRef.current.reset(w, h);
      setCropAspect(cropPhysicalAspect(cropRectRef.current, std));
      if (canvas) {
        canvas.dataset.fbSize = `${w}x${h}`;
      }
      return surface as { imageData: ImageData; imageU32: Uint32Array };
    };

    const initSize = machine.getFramebufferSize();
    ensureSurface(initSize.width, initSize.height);
    if (canvas) {
      lastCanvasOverscan = machine.config.overscan;
      canvas.dataset.overscan = lastCanvasOverscan;
    }

    let disposed = false;
    let bootReady = false;
    let rafId = 0;
    let lastTime = performance.now();
    let accumulator = 0;
    let skipCounter = 0;
    let cropCheckCounter = 0;
    let fpsFrames = 0;
    let fpsTimer = lastTime;
    let uiTimer = lastTime;
    let ledTimer = lastTime;
    let lastDf0LedKey = -1;
    let lastTurboIoSeq = machine.floppy.ioSeq;
    let turboBurstLeft = 0;
    let lastScheduledDh0Seq = machine.hardfile.units[0].writeSeq;
    let dh0SaveTimer: number | null = null;
    let tabHidden = document.hidden;

    const gamepadTracker = new PhysicalGamepadTracker();
    const gamepadSink: PhysicalGamepadSink = {
      setJoystick: (patch) => machine.setJoystick(patch),
      setKey: (code, isDown) => machine.setKey(code, isDown),
      setMouseButtons: (left, right) => machine.setMouseButtons(left, right),
      onAnyPress: () => {
        if (configRef.current.audioEnabled) {
          machine.audio.initFromGesture();
        }
      },
    };
    const canPollGamepads =
      typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function';
    let hasPhysicalGamepad = canPollGamepads && hasAnyConnectedGamepad(navigator.getGamepads());

    const handleGamepadConnected = () => {
      hasPhysicalGamepad = true;
    };
    const handleGamepadDisconnected = () => {
      hasPhysicalGamepad =
        canPollGamepads && hasAnyConnectedGamepad(navigator.getGamepads());
      if (!hasPhysicalGamepad) {
        gamepadTracker.releaseAll(gamepadSink);
      }
    };
    window.addEventListener('gamepadconnected', handleGamepadConnected);
    window.addEventListener('gamepaddisconnected', handleGamepadDisconnected);

    const UNLOCK_EVENTS = [
      'pointerdown',
      'pointerup',
      'touchstart',
      'touchend',
      'mousedown',
      'click',
      'keydown',
    ] as const;
    let unlockListenersArmed = false;

    const disarmAudioUnlock = () => {
      if (!unlockListenersArmed) return;
      unlockListenersArmed = false;
      for (const ev of UNLOCK_EVENTS) {
        window.removeEventListener(ev, unlockAudio, true);
      }
    };

    const unlockAudio = () => {
      if (disposed || machineRef.current !== machine) return;
      if (configRef.current.audioEnabled) {
        machine.audio.initFromGesture();
      }
      if (machine.audio.isContextRunning() || !configRef.current.audioEnabled) {
        disarmAudioUnlock();
      }
    };

    const armAudioUnlock = () => {
      if (disposed || unlockListenersArmed || !configRef.current.audioEnabled) return;
      unlockListenersArmed = true;
      for (const ev of UNLOCK_EVENTS) {
        window.addEventListener(ev, unlockAudio, { capture: true, passive: true });
      }
    };

    machine.audio.setOnNeedsUnlock(() => {
      armAudioUnlock();
    });
    armAudioUnlock();

    const persistDh0IfDirty = () => {
      if (dh0SaveTimer !== null) {
        window.clearTimeout(dh0SaveTimer);
        dh0SaveTimer = null;
      }
      const slot = machine.hardfile.units[0];
      if (!slot.data || slot.writeSeq === dh0SavedSeqRef.current) return;
      dh0SavedSeqRef.current = slot.writeSeq;
      lastScheduledDh0Seq = slot.writeSeq;
      void saveBinaryToStorage(
        SYSTEM_DH0_STORAGE_KEY,
        slot.name || 'workbench.hdf',
        new Uint8Array(slot.data)
      );
    };

    const handleAudioFocusResume = () => {
      if (disposed || document.hidden || machine.paused || !configRef.current.audioEnabled) return;
      machine.audio.tryResume();
    };

    const handleVisibility = () => {
      tabHidden = document.hidden;
      if (tabHidden) {
        gamepadTracker.releaseAll(gamepadSink);
        persistDh0IfDirty();
      } else {
        lastTime = performance.now();
        accumulator = 0;
        if (canPollGamepads) {
          hasPhysicalGamepad = hasAnyConnectedGamepad(navigator.getGamepads());
        }
        handleAudioFocusResume();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('focus', handleAudioFocusResume);
    window.addEventListener('pageshow', handleAudioFocusResume);
    window.addEventListener('pagehide', persistDh0IfDirty);

    // Load Kickstart ROM + cached/default DH0 Workbench in parallel BEFORE stepping any frame
    // so Kickstart boots cleanly on frame 1 with zero OpenKick/Boing flash
    void (async () => {
      const loadStartupRom = async (): Promise<{ bytes: Uint8Array; name: string } | null> => {
        const savedRom = await loadBinaryFromStorage('custom_kickstart_rom');
        if (savedRom) return savedRom;
        try {
          const resp = await fetch(DEFAULT_BIOS_ROM_URL);
          if (resp.ok) {
            return { bytes: new Uint8Array(await resp.arrayBuffer()), name: DEFAULT_BIOS_ROM_NAME };
          }
        } catch {
          // Keep OpenKick fallback if /bios ROM is unavailable
        }
        return null;
      };

      const loadStartupDh0 = async (): Promise<{ bytes: Uint8Array; name: string; fromCache: boolean } | null> => {
        const savedDh0 = await loadBinaryFromStorage(SYSTEM_DH0_STORAGE_KEY);
        if (savedDh0) {
          return { bytes: savedDh0.bytes, name: savedDh0.name || 'workbench.hdf', fromCache: true };
        }
        void deleteFromStorage('system_dh0_hdf');
        try {
          const resp = await fetch(DEFAULT_WORKBENCH_URL);
          if (resp.ok) {
            const workbenchBytes = new Uint8Array(await resp.arrayBuffer());
            const resolved = await resolveUploadedFileAsync(DEFAULT_WORKBENCH_NAME, workbenchBytes);
            let hdfBytes: Uint8Array | null = null;
            if (resolved.kind === 'archive-files') {
              hdfBytes = resolved.buildHdf(dh0SizeRef.current);
            } else if (resolved.kind === 'hdf') {
              hdfBytes = resolved.bytes;
            }
            if (hdfBytes) {
              return { bytes: hdfBytes, name: 'workbench.hdf', fromCache: false };
            }
          }
        } catch {
          // Ignore auto-mount failure if workbench archive is unavailable
        }
        return null;
      };

      const [romPayload, dh0Payload, slots] = await Promise.all([
        loadStartupRom(),
        loadStartupDh0(),
        listSaveSlotSummaries(),
      ]);

      if (disposed || machineRef.current !== machine) return;

      // Mount DH0 first (without extra reset) so Kickstart immediately sees DH0 on its single clean boot
      if (dh0Payload && !machine.hardfile.isMounted(0)) {
        const res = machine.mountHdf(dh0Payload.bytes, dh0Payload.name, false, 0);
        if (res.ok) {
          dh0SavedSeqRef.current = machine.hardfile.units[0].writeSeq;
          lastScheduledDh0Seq = machine.hardfile.units[0].writeSeq;
          const actualMB = Math.max(
            1,
            Math.min(64, Math.round(dh0Payload.bytes.length / (1024 * 1024)))
          );
          setDh0SizeMB(actualMB);
          if (!dh0Payload.fromCache) {
            void saveBinaryToStorage(
              SYSTEM_DH0_STORAGE_KEY,
              'workbench.hdf',
              new Uint8Array(dh0Payload.bytes)
            );
          }
        }
      }

      if (romPayload) {
        machine.loadCustomRom(romPayload.bytes, romPayload.name);
      } else {
        machine.loadOpenKickRom();
      }

      bootReady = true;
      lastTime = performance.now();
      accumulator = 0;

      // Paint first Kickstart frame immediately
      machine.stepFrame(true);
      const firstSize = machine.getFramebufferSize();
      const firstSurf = ensureSurface(firstSize.width, firstSize.height);
      if (canvas && ctx && firstSurf) {
        firstSurf.imageU32.set(machine.getFramebuffer());
        const crop = cropRectRef.current;
        if (canvas.width !== crop.w || canvas.height !== crop.h) {
          canvas.width = crop.w;
          canvas.height = crop.h;
        }
        ctx.putImageData(firstSurf.imageData, -crop.x, -crop.y, crop.x, crop.y, crop.w, crop.h);
      }
      setStatus(machine.getStatusSnapshot());
      setSaveSlots(slots);
    })();

    const tick = (now: number) => {
      rafId = requestAnimationFrame(tick);

      if (!bootReady || tabHidden || machine.paused) {
        if (gamepadTracker.activeMask !== 0) {
          gamepadTracker.releaseAll(gamepadSink);
        }
        lastTime = now;
        return;
      }

      if (hasPhysicalGamepad && !modalOpenRef.current) {
        gamepadTracker.poll(navigator.getGamepads(), gamepadSink);
      } else if (gamepadTracker.activeMask !== 0) {
        gamepadTracker.releaseAll(gamepadSink);
      }

      const targetFps = machine.config.videoStandard === 'PAL' ? PAL_FPS : NTSC_FPS;
      const frameMs = 1000 / targetFps;
      const delta = Math.min(now - lastTime, frameMs * 2);
      lastTime = now;
      accumulator += delta;

      let stepped = false;
      let rendered = false;
      const t0 = performance.now();

      // Cap to 1 frame per rAF when skipping/lagging to avoid CPU spiral on mobile
      while (accumulator >= frameMs) {
        accumulator -= frameMs;
        const skip = machine.config.frameSkip;
        const doRender = skip === 0 || (skipCounter % (skip + 1)) === 0;
        skipCounter++;
        machine.stepFrame(doRender);
        stepped = true;
        if (doRender) rendered = true;
        fpsFrames++;
        if (performance.now() - t0 > frameMs * 0.85) {
          accumulator = 0;
          break;
        }
      }

      // Turbo Floppy burst: fast-forward non-rendered frames ONLY during active disk I/O within a strict 8ms host CPU budget
      if (stepped && machine.config.turboFloppy) {
        if (machine.floppy.ioSeq !== lastTurboIoSeq) {
          lastTurboIoSeq = machine.floppy.ioSeq;
          turboBurstLeft = 10;
        }
        if (turboBurstLeft > 0) {
          let burstCount = 0;
          while (turboBurstLeft > 0 && burstCount < 20 && (performance.now() - t0) < 8) {
            machine.stepFrame(false, false);
            burstCount++;
            if (machine.floppy.ioSeq !== lastTurboIoSeq) {
              lastTurboIoSeq = machine.floppy.ioSeq;
              turboBurstLeft = 10;
            } else {
              turboBurstLeft--;
            }
          }
        }
      } else if (!machine.config.turboFloppy) {
        turboBurstLeft = 0;
        lastTurboIoSeq = machine.floppy.ioSeq;
      }

      if (rendered && ctx && canvas) {
        const fbW = machine.chipset.fbWidth;
        const fbH = machine.chipset.fbHeight;
        const surf = ensureSurface(fbW, fbH);
        if (surf) {
          const fb = machine.getFramebuffer();
          surf.imageU32.set(fb);

          if (lastCanvasOverscan !== machine.config.overscan) {
            lastCanvasOverscan = machine.config.overscan;
            canvas.dataset.overscan = lastCanvasOverscan;
          }

          if (machine.config.autoCrop) {
            if ((cropCheckCounter++ & 3) === 0) {
              const res = autoCropRef.current.update(fb, fbW, fbH);
              if (res.changed) {
                cropRectRef.current = res.rect;
                setCropAspect(cropPhysicalAspect(res.rect, machine.config.videoStandard));
              }
            }
          } else if (
            cropRectRef.current.x !== 0 ||
            cropRectRef.current.y !== 0 ||
            cropRectRef.current.w !== fbW ||
            cropRectRef.current.h !== fbH
          ) {
            cropRectRef.current = autoCropRef.current.reset(fbW, fbH);
            setCropAspect(cropPhysicalAspect(cropRectRef.current, machine.config.videoStandard));
          }

          const crop = cropRectRef.current;
          if (canvas.width !== crop.w || canvas.height !== crop.h) {
            canvas.width = crop.w;
            canvas.height = crop.h;
          }
          ctx.putImageData(surf.imageData, -crop.x, -crop.y, crop.x, crop.y, crop.w, crop.h);
        }
      }

      if (now - fpsTimer >= 1000) {
        machine.measuredFps = Math.round((fpsFrames * 1000) / (now - fpsTimer));
        fpsFrames = 0;
        fpsTimer = now;
      }

      // Fast LED/track sync for DF0/DF1/DH0/DH1 (~70ms on activity changes) + gentle 2.5Hz full status sync
      const d0 = machine.floppy.drives[0];
      const d1 = machine.floppy.drives[1];
      const h0 = machine.hardfile.units[0];
      const h1 = machine.hardfile.units[1];
      const dfLedKey =
        (d0.data ? 1 : 0) |
        (d0.motorOn ? 2 : 0) |
        (d0.ioPulseFrames > 0 ? 4 : 0) |
        (d0.stepPhase ? 8 : 0) |
        (d1.data ? 16 : 0) |
        (d1.motorOn ? 32 : 0) |
        (d1.ioPulseFrames > 0 ? 64 : 0) |
        (d1.stepPhase ? 128 : 0) |
        ((d0.cylinder & 0x7f) << 8) |
        ((d1.cylinder & 0x7f) << 15) |
        (h0.data ? 1 << 22 : 0) |
        (h0.ioPulseFrames > 0 ? 1 << 23 : 0) |
        (h1.data ? 1 << 24 : 0) |
        (h1.ioPulseFrames > 0 ? 1 << 25 : 0);

      if (stepped && ((dfLedKey !== lastDf0LedKey && now - ledTimer >= 70) || now - uiTimer >= 400)) {
        lastDf0LedKey = dfLedKey;
        ledTimer = now;
        uiTimer = now;
        setStatus(machine.getStatusSnapshot());

        // Debounced DH0: browser cache save (1.5s after last AmigaDOS write -> zero CPU spikes)
        const curDh0Seq = h0.writeSeq;
        if (curDh0Seq !== lastScheduledDh0Seq) {
          lastScheduledDh0Seq = curDh0Seq;
          if (dh0SaveTimer !== null) window.clearTimeout(dh0SaveTimer);
          dh0SaveTimer = window.setTimeout(persistDh0IfDirty, 1500);
        }
      }
    };

    rafId = requestAnimationFrame(tick);

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      gamepadTracker.releaseAll(gamepadSink);
      window.removeEventListener('gamepadconnected', handleGamepadConnected);
      window.removeEventListener('gamepaddisconnected', handleGamepadDisconnected);
      persistDh0IfDirty();
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('focus', handleAudioFocusResume);
      window.removeEventListener('pageshow', handleAudioFocusResume);
      window.removeEventListener('pagehide', persistDh0IfDirty);
      disarmAudioUnlock();
      toastTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
      toastTimersRef.current.clear();
      machine.dispose();
      machineRef.current = null;
    };
  }, []);

  // Physical PC / Bluetooth keyboard mapping 1:1 to real Amiga raw keycodes
  const archiveModalOpen = pendingArchive !== null;
  modalOpenRef.current = disksOpen || settingsOpen || archiveModalOpen;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (disksOpen || settingsOpen || archiveModalOpen) return;
      const raw = BROWSER_CODE_TO_AMIGA[e.code];
      if (raw === undefined) return;
      e.preventDefault();
      if (e.repeat) return;
      const m = machineRef.current;
      if (!m) return;
      if (configRef.current.audioEnabled) {
        m.audio.initFromGesture();
      }
      m.setKey(raw, true);
      if (raw === AMIGA_RAW.CAPSLOCK) {
        setStatus(m.getStatusSnapshot());
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const raw = BROWSER_CODE_TO_AMIGA[e.code];
      if (raw === undefined) return;
      e.preventDefault();
      machineRef.current?.setKey(raw, false);
    };

    window.addEventListener('keydown', onKeyDown, { passive: false });
    window.addEventListener('keyup', onKeyUp, { passive: false });
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [archiveModalOpen, disksOpen, settingsOpen]);

  const wakeAudio = useCallback(() => {
    if (configRef.current.audioEnabled) {
      machineRef.current?.audio.initFromGesture();
    }
  }, []);

  const handleKeyEvent = useCallback((rawCode: number, isDown: boolean) => {
    const m = machineRef.current;
    if (!m) return;
    m.setKey(rawCode, isDown);
    if (rawCode === AMIGA_RAW.CAPSLOCK && isDown) {
      setStatus(m.getStatusSnapshot());
    }
  }, []);

  const handleMouseMove = useCallback((dx: number, dy: number) => {
    machineRef.current?.moveMouse(dx, dy);
  }, []);

  const handleMouseButton = useCallback((left?: boolean, right?: boolean) => {
    machineRef.current?.setMouseButtons(left, right);
  }, []);

  const handleJoystickChange = useCallback((patch: Partial<JoystickState>) => {
    machineRef.current?.setJoystick(patch);
  }, []);

  const handleTogglePause = useCallback(() => {
    const m = machineRef.current;
    if (!m) return;
    m.paused = !m.paused;
    if (m.paused) {
      m.audio.resetSchedule();
    } else if (configRef.current.audioEnabled) {
      m.audio.initFromGesture();
    }
    setStatus(m.getStatusSnapshot());
  }, []);

  const handleToggleAudio = useCallback(() => {
    const nextEnabled = !configRef.current.audioEnabled;
    const nextCfg = { ...configRef.current, audioEnabled: nextEnabled };
    configRef.current = nextCfg;
    setConfig(nextCfg);
    saveAmigaConfig(nextCfg);
    const m = machineRef.current;
    if (m) {
      if (nextEnabled) m.audio.initFromGesture();
      m.updateConfig({ audioEnabled: nextEnabled }, false);
    }
  }, []);

  const handleWarmReset = useCallback(() => {
    const m = machineRef.current;
    if (!m) return;
    if (configRef.current.audioEnabled) {
      m.audio.initFromGesture();
    }
    m.warmReset();
    setStatus(m.getStatusSnapshot());
  }, []);

  const handleUpdateConfig = useCallback((patch: Partial<AmigaConfig>) => {
    if (!hasConfigChanged(configRef.current, patch)) return;
    const nextCfg = { ...configRef.current, ...patch };
    configRef.current = nextCfg;
    setConfig(nextCfg);
    saveAmigaConfig(nextCfg);
    if (patch.overscan !== undefined && canvasRef.current) {
      canvasRef.current.dataset.overscan = patch.overscan;
    }
    if (patch.hapticsEnabled !== undefined) {
      setHapticsEnabled(patch.hapticsEnabled);
    }
    if (patch.joystickConnected === false) {
      setMobileDeck((prev) => (prev === 'gamepad' ? 'qwerty' : prev));
    }
    const m = machineRef.current;
    if (m) {
      if (patch.audioVolume !== undefined && nextCfg.audioEnabled) {
        m.audio.initFromGesture();
      }
      m.updateConfig(patch, true);
      if (
        patch.autoCrop === false ||
        patch.overscan !== undefined ||
        patch.videoStandard !== undefined
      ) {
        const size = m.getFramebufferSize();
        cropRectRef.current = autoCropRef.current.reset(size.width, size.height);
        setCropAspect(cropPhysicalAspect(cropRectRef.current, nextCfg.videoStandard));
      }
      setStatus(m.getStatusSnapshot());
    }
  }, []);

  const captureScreenThumbnail = useCallback((): string | null => {
    const src = canvasRef.current;
    if (!src || src.width === 0 || src.height === 0) return null;
    try {
      let thumb = thumbCanvasRef.current;
      if (!thumb) {
        thumb = document.createElement('canvas');
        thumb.width = 160;
        thumb.height = 120;
        thumbCanvasRef.current = thumb;
      }
      const ctx = thumb.getContext('2d', { alpha: false });
      if (!ctx) return null;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(src, 0, 0, thumb.width, thumb.height);
      return thumb.toDataURL('image/jpeg', 0.78);
    } catch {
      return null;
    }
  }, []);

  const drawScreenshotToMainCanvas = useCallback((dataUrl: string | null) => {
    if (!dataUrl) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d', { alpha: false });
    if (!canvas || !ctx) return;
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    };
    img.src = dataUrl;
  }, []);

  const dismissToast = useCallback((id: number) => {
    const timer = toastTimersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      toastTimersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback(
    (type: 'ok' | 'err', text: string) => {
      const id = ++toastSeqRef.current;
      setToasts((prev) => {
        const next = [...prev, { id, type, text }];
        if (next.length > 3) {
          const dropped = next.shift();
          if (dropped) {
            const oldTimer = toastTimersRef.current.get(dropped.id);
            if (oldTimer !== undefined) {
              window.clearTimeout(oldTimer);
              toastTimersRef.current.delete(dropped.id);
            }
          }
        }
        return next;
      });
      const timer = window.setTimeout(() => {
        toastTimersRef.current.delete(id);
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 2600);
      toastTimersRef.current.set(id, timer);
    },
    []
  );

  const mountResolvedMedia = useCallback(
    async (
      kind: 'adf' | 'hdf' | 'rom',
      name: string,
      bytes: Uint8Array,
      targetDrive: 0 | 1 | 'dh1' | 'rom'
    ): Promise<string | null> => {
      const m = machineRef.current;
      if (!m) {
        const msg = 'Эмулятор не инициализирован.';
        showToast('err', msg);
        return msg;
      }
      if (kind === 'adf') {
        const drive: 0 | 1 = targetDrive === 1 ? 1 : 0;
        const hintReset = drive === 0 && m.shouldHintResetForDf0Boot(bytes);
        const res = m.insertAdf(drive, bytes, name, false);
        if (!res.ok) {
          const msg = res.error ?? 'Ошибка чтения ADF.';
          showToast('err', msg);
          return msg;
        }
        setStatus(m.getStatusSnapshot());
        showToast(
          'ok',
          hintReset ? `DF${drive}: ${name} · нажмите Сброс для запуска` : `DF${drive}: ${name}`
        );
        return null;
      }
      if (kind === 'hdf') {
        // User HDFs always mount onto DH1: so DH0: remains strictly the cached Workbench system drive
        const res = m.mountHdf(bytes, name, true, 1);
        if (!res.ok) {
          const msg = res.error ?? 'Ошибка монтирования HDF.';
          showToast('err', msg);
          return msg;
        }
        const actualMB = Math.max(1, Math.min(64, Math.round(bytes.length / (1024 * 1024))));
        setDh1SizeMB(actualMB);
        setStatus(m.getStatusSnapshot());
        if (res.warning) {
          showToast('err', res.warning);
        } else {
          showToast('ok', `DH1: ${name}`);
        }
        return null;
      }
      const res = m.loadCustomRom(bytes, name);
      if (!res.ok) {
        const msg = res.error ?? 'Неверный файл ROM.';
        showToast('err', msg);
        return msg;
      }
      await saveBinaryToStorage('custom_kickstart_rom', name, bytes);
      setStatus(m.getStatusSnapshot());
      showToast('ok', `ROM: ${name}`);
      return null;
    },
    [showToast]
  );

  const handleUploadMedia = useCallback(
    async (target: 0 | 1 | 'dh1', file: File): Promise<string | null> => {
      const m = machineRef.current;
      if (!m) {
        const msg = 'Эмулятор не инициализирован.';
        showToast('err', msg);
        return msg;
      }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const resolved = await resolveUploadedFileAsync(file.name, bytes);

        if (resolved.kind === 'adf' || resolved.kind === 'hdf' || resolved.kind === 'rom') {
          setPendingArchive(null);
          return await mountResolvedMedia(resolved.kind, resolved.name, resolved.bytes, target);
        }

        // Open dedicated standalone ArchiveModal showing ALL files inside the archive
        const nextArchive: PendingArchiveChoice = { target, result: resolved };
        lastLaunchViewRef.current = 'archive';
        setDisksOpen(false);
        setLastArchive(nextArchive);
        setPendingArchive(nextArchive);
        return null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Ошибка распаковки файла или архива.';
        showToast('err', msg);
        return msg;
      }
    },
    [mountResolvedMedia, showToast]
  );

  const handleUploadAdf = useCallback(
    (drive: 0 | 1, file: File) => handleUploadMedia(drive, file),
    [handleUploadMedia]
  );

  const handleUploadDh1 = useCallback(
    (file: File) => handleUploadMedia('dh1', file),
    [handleUploadMedia]
  );

  const handleLaunchCatalogItem = useCallback(
    async (item: CatalogGameItem) => {
      const m = machineRef.current;
      if (!m) {
        showToast('err', 'Эмулятор не инициализирован.');
        return;
      }
      setLaunchingCatalogId(item.id);
      try {
        const { filename, bytes } = await downloadCatalogArchive({ item });
        const resolved = await resolveUploadedFileAsync(filename, bytes);

        // Hard disk format mounts directly to DH1 without prompting
        if (resolved.kind === 'hdf') {
          await mountResolvedMedia('hdf', resolved.name, resolved.bytes, 'dh1');
          setDisksOpen(false);
          return;
        }

        if (resolved.kind === 'rom') {
          await mountResolvedMedia('rom', resolved.name, resolved.bytes, 'rom');
          setDisksOpen(false);
          return;
        }

        // Single floppy image: open ArchiveModal over DiskRomDrawer so user chooses DF0: or DF1: without resetting catalog
        if (resolved.kind === 'adf') {
          const extMatch = filename.match(/\.([A-Za-z0-9]+)$/);
          const archiveFmt = extMatch ? extMatch[1].toUpperCase() : 'ADF';
          const candidate: ArchiveMediaCandidate = {
            id: `0_${resolved.name}`,
            name: resolved.name,
            path: resolved.name,
            size: resolved.bytes.length,
            kind: 'adf',
            extractBytes: () => resolved.bytes,
          };
          const nextArchive: PendingArchiveChoice = {
            target: 0,
            result: {
              kind: 'archive-choices',
              archiveName: filename,
              archiveFormat: archiveFmt,
              volumeName: resolved.name.replace(/\.(adf|adz)$/i, '') || item.title,
              totalBytes: resolved.bytes.length,
              mediaItems: [candidate],
              allFiles: [candidate],
              otherFileCount: 0,
              fitsFloppy: false,
              extractAllAsFiles: () => [],
              buildAdf: () => resolved.bytes,
              buildHdf: () => new Uint8Array(0),
            },
          };
          lastLaunchViewRef.current = 'archive';
          setDisksOpen(false);
          setLastArchive(nextArchive);
          setPendingArchive(nextArchive);
          return;
        }

        const nextArchive: PendingArchiveChoice = { target: 0, result: resolved };
        lastLaunchViewRef.current = 'archive';
        setDisksOpen(false);
        setLastArchive(nextArchive);
        setPendingArchive(nextArchive);
      } catch (err) {
        showToast(
          'err',
          err instanceof Error ? err.message : `Ошибка загрузки «${item.title}».`
        );
      } finally {
        setLaunchingCatalogId(null);
      }
    },
    [mountResolvedMedia, showToast]
  );

  const handleSelectArchiveMedia = useCallback(
    async (item: ArchiveMediaCandidate, target: 0 | 1 | 'dh1' | 'rom') => {
      try {
        const bytes = item.extractBytes();
        setPendingArchive(null);
        await mountResolvedMedia(item.kind, item.name, bytes, target);
      } catch (err) {
        showToast('err', err instanceof Error ? err.message : 'Ошибка извлечения образа из архива.');
      }
    },
    [mountResolvedMedia, showToast]
  );

  const handleMountArchiveDualAdf = useCallback(
    async (first: ArchiveMediaCandidate, second: ArchiveMediaCandidate) => {
      const m = machineRef.current;
      if (!m) return;
      try {
        const b0 = first.extractBytes();
        const b1 = second.extractBytes();
        const hintReset = m.shouldHintResetForDf0Boot(b0);
        const r1 = m.insertAdf(1, b1, second.name, false);
        const r0 = m.insertAdf(0, b0, first.name, false);
        if (!r0.ok || !r1.ok) {
          showToast('err', r0.error || r1.error || 'Ошибка монтирования дискет.');
          return;
        }
        setPendingArchive(null);
        setDisksOpen(false);
        setStatus(m.getStatusSnapshot());
        showToast(
          'ok',
          hintReset
            ? `DF0: ${first.name} · DF1: ${second.name} · нажмите Сброс для запуска`
            : `DF0: ${first.name} · DF1: ${second.name}`
        );
      } catch (err) {
        showToast('err', err instanceof Error ? err.message : 'Ошибка распаковки архива.');
      }
    },
    [showToast]
  );

  const handlePackArchiveAsAdf = useCallback(
    async (drive: 0 | 1) => {
      if (!pendingArchive) return;
      try {
        const adf = pendingArchive.result.buildAdf();
        const name = `${pendingArchive.result.volumeName}.adf`;
        const errMsg = await mountResolvedMedia('adf', name, adf, drive);
        if (errMsg) return;
        setPendingArchive(null);
        setDisksOpen(false);
      } catch (err) {
        showToast('err', err instanceof Error ? err.message : 'Ошибка сборки ADF из архива.');
      }
    },
    [mountResolvedMedia, pendingArchive, showToast]
  );

  const handlePackArchiveAsHdf = useCallback(async () => {
    if (!pendingArchive) return;
    try {
      const hdf = pendingArchive.result.buildHdf(dh1SizeRef.current);
      const hdfName = `${pendingArchive.result.volumeName}.hdf`;
      const errMsg = await mountResolvedMedia('hdf', hdfName, hdf, 'dh1');
      if (errMsg) return;
      setPendingArchive(null);
      setDisksOpen(false);
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'Ошибка сборки HDF из архива.');
    }
  }, [mountResolvedMedia, pendingArchive, showToast]);

  const handleCreateBlankDh1 = useCallback(
    (sizeMB = dh1SizeRef.current) => {
      const m = machineRef.current;
      if (!m) return;
      const clamped = Math.max(1, Math.min(64, Math.round(sizeMB)));
      setDh1SizeMB(clamped);
      try {
        window.localStorage.setItem(DH1_SIZE_STORAGE_KEY, String(clamped));
      } catch {
        // Ignore storage error
      }
      const name = m.mountBlankHdf(clamped, `GamesHD_${clamped}MB.hdf`, true, 1);
      setStatus(m.getStatusSnapshot());
      showToast('ok', `DH1: ${name} (${clamped} МБ)`);
    },
    [showToast]
  );

  const handleChangeDh0Size = useCallback(
    (sizeMB: number) => {
      const clamped = Math.max(1, Math.min(64, Math.round(sizeMB)));
      const m = machineRef.current;
      if (!m || !m.hardfile.isMounted(0)) {
        setDh0SizeMB(clamped);
        try {
          window.localStorage.setItem(DH0_SIZE_STORAGE_KEY, String(clamped));
        } catch {
          // Ignore storage error
        }
        return;
      }

      const res = m.resizeHdf(clamped, true, 0);
      if (!res.ok) {
        if (res.minSizeMB) {
          setDh0SizeMB(res.minSizeMB);
        }
        showToast('err', res.error ?? 'Не удалось изменить размер системного диска DH0:.');
        return;
      }

      setDh0SizeMB(clamped);
      try {
        window.localStorage.setItem(DH0_SIZE_STORAGE_KEY, String(clamped));
      } catch {
        // Ignore storage error
      }
      const slot = m.hardfile.units[0];
      if (slot.data) {
        dh0SavedSeqRef.current = slot.writeSeq;
        void saveBinaryToStorage(
          SYSTEM_DH0_STORAGE_KEY,
          slot.name || 'workbench.hdf',
          new Uint8Array(slot.data)
        );
      }
      setStatus(m.getStatusSnapshot());
      showToast('ok', `DH0: размер системы ${clamped} МБ`);
    },
    [showToast]
  );

  const handleChangeDh1Size = useCallback(
    (sizeMB: number) => {
      const clamped = Math.max(1, Math.min(64, Math.round(sizeMB)));
      const m = machineRef.current;
      if (!m || !m.hardfile.isMounted(1)) {
        setDh1SizeMB(clamped);
        try {
          window.localStorage.setItem(DH1_SIZE_STORAGE_KEY, String(clamped));
        } catch {
          // Ignore storage error
        }
        return;
      }

      const res = m.resizeHdf(clamped, true, 1);
      if (!res.ok) {
        if (res.minSizeMB) {
          setDh1SizeMB(res.minSizeMB);
        }
        showToast('err', res.error ?? 'Не удалось изменить размер диска DH1:.');
        return;
      }

      setDh1SizeMB(clamped);
      try {
        window.localStorage.setItem(DH1_SIZE_STORAGE_KEY, String(clamped));
      } catch {
        // Ignore storage error
      }
      setStatus(m.getStatusSnapshot());
      showToast('ok', `DH1: размер диска ${clamped} МБ`);
    },
    [showToast]
  );

  const triggerDownloadBytes = useCallback(
    (fileName: string, bytes: Uint8Array) => {
      const copy = new Uint8Array(bytes);
      const blob = new Blob([copy], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
      showToast('ok', `Скачано: ${fileName}`);
    },
    [showToast]
  );

  const handleDownloadDh0 = useCallback(() => {
    const hdf = machineRef.current?.exportHdf(0);
    if (!hdf) return;
    const fileName = hdf.name.toLowerCase().endsWith('.hdf') ? hdf.name : `${hdf.name}.hdf`;
    triggerDownloadBytes(fileName, hdf.bytes);
  }, [triggerDownloadBytes]);

  const handleEjectDh0 = useCallback(() => {
    const m = machineRef.current;
    if (!m) return;
    const slot = m.hardfile.units[0];
    if (slot.data && slot.writeSeq !== dh0SavedSeqRef.current) {
      dh0SavedSeqRef.current = slot.writeSeq;
      void saveBinaryToStorage(
        SYSTEM_DH0_STORAGE_KEY,
        slot.name || 'workbench.hdf',
        new Uint8Array(slot.data)
      );
    }
    m.ejectHdf(true, 0);
    setStatus(m.getStatusSnapshot());
    showToast('ok', 'DH0: извлечён');
  }, [showToast]);

  const handleMountDh0 = useCallback(async () => {
    const m = machineRef.current;
    if (!m) return;
    try {
      const savedDh0 = await loadBinaryFromStorage(SYSTEM_DH0_STORAGE_KEY);
      if (machineRef.current !== m) return;
      if (savedDh0) {
        const res = m.mountHdf(savedDh0.bytes, savedDh0.name || 'workbench.hdf', true, 0);
        if (res.ok) {
          dh0SavedSeqRef.current = m.hardfile.units[0].writeSeq;
          const actualMB = Math.max(1, Math.min(64, Math.round(savedDh0.bytes.length / (1024 * 1024))));
          setDh0SizeMB(actualMB);
          setStatus(m.getStatusSnapshot());
          showToast('ok', 'DH0: подключён (Workbench)');
          return;
        }
      }
      const resp = await fetch(DEFAULT_WORKBENCH_URL);
      if (!resp.ok) {
        showToast('err', 'Не удалось загрузить Workbench из /bios.');
        return;
      }
      const workbenchBytes = new Uint8Array(await resp.arrayBuffer());
      const resolved = await resolveUploadedFileAsync(DEFAULT_WORKBENCH_NAME, workbenchBytes);
      let hdfBytes: Uint8Array | null = null;
      if (resolved.kind === 'archive-files') {
        hdfBytes = resolved.buildHdf(dh0SizeRef.current);
      } else if (resolved.kind === 'hdf') {
        hdfBytes = resolved.bytes;
      }
      if (!hdfBytes || machineRef.current !== m) {
        showToast('err', 'Не удалось собрать системный образ DH0:.');
        return;
      }
      m.mountHdf(hdfBytes, 'workbench.hdf', true, 0);
      dh0SavedSeqRef.current = m.hardfile.units[0].writeSeq;
      const actualMB = Math.max(1, Math.min(64, Math.round(hdfBytes.length / (1024 * 1024))));
      setDh0SizeMB(actualMB);
      void saveBinaryToStorage(SYSTEM_DH0_STORAGE_KEY, 'workbench.hdf', new Uint8Array(hdfBytes));
      setStatus(m.getStatusSnapshot());
      showToast('ok', 'DH0: подключён (Workbench)');
    } catch {
      showToast('err', 'Ошибка подключения системного диска DH0:.');
    }
  }, [showToast]);

  const handleDownloadDh1 = useCallback(() => {
    const hdf = machineRef.current?.exportHdf(1);
    if (!hdf) return;
    const fileName = hdf.name.toLowerCase().endsWith('.hdf') ? hdf.name : `${hdf.name}.hdf`;
    triggerDownloadBytes(fileName, hdf.bytes);
  }, [triggerDownloadBytes]);

  const handleEjectDh1 = useCallback(() => {
    const m = machineRef.current;
    if (!m) return;
    m.ejectHdf(true, 1);
    setStatus(m.getStatusSnapshot());
    showToast('ok', 'DH1: отключён');
  }, [showToast]);

  const handleEjectDisk = useCallback(
    (drive: 0 | 1) => {
      const m = machineRef.current;
      if (!m) return;
      m.ejectDisk(drive);
      setStatus(m.getStatusSnapshot());
      showToast('ok', `DF${drive}: пуст`);
    },
    [showToast]
  );

  const handleInsertBlankAdf = useCallback(
    (drive: 0 | 1) => {
      const m = machineRef.current;
      if (!m) return;
      const diskName = m.insertBlankAdf(drive);
      setStatus(m.getStatusSnapshot());
      showToast('ok', `DF${drive}: ${diskName}`);
    },
    [showToast]
  );

  const handleDownloadAdf = useCallback(
    (drive: 0 | 1) => {
      const disk = machineRef.current?.exportDriveAdf(drive);
      if (!disk) return;
      const fileName = disk.name.toLowerCase().endsWith('.adf') ? disk.name : `${disk.name}.adf`;
      triggerDownloadBytes(fileName, disk.bytes);
    },
    [triggerDownloadBytes]
  );

  const handleUploadRom = useCallback(
    async (file: File): Promise<string | null> => {
      const m = machineRef.current;
      if (!m) {
        const msg = 'Эмулятор не инициализирован.';
        showToast('err', msg);
        return msg;
      }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const resolved = await resolveUploadedFileAsync(file.name, bytes);
        if (resolved.kind === 'rom') {
          setPendingArchive(null);
          return await mountResolvedMedia('rom', resolved.name, resolved.bytes, 'rom');
        }
        if (resolved.kind === 'archive-choices') {
          const romItems = resolved.mediaItems.filter((i) => i.kind === 'rom');
          if (romItems.length === 1 && resolved.allFiles.length === 1) {
            setPendingArchive(null);
            return await mountResolvedMedia('rom', romItems[0].name, romItems[0].extractBytes(), 'rom');
          }
          if (romItems.length >= 1) {
            const nextArchive: PendingArchiveChoice = { target: 0, result: resolved };
            lastLaunchViewRef.current = 'archive';
            setDisksOpen(false);
            setLastArchive(nextArchive);
            setPendingArchive(nextArchive);
            return null;
          }
          const msg = `В архиве "${file.name}" не найден Kickstart ROM (256 или 512 КБ).`;
          showToast('err', msg);
          return msg;
        }
        if (resolved.kind === 'archive-files') {
          const msg = `В архиве "${file.name}" не найден файл Kickstart ROM (256 или 512 КБ).`;
          showToast('err', msg);
          return msg;
        }
        // Fallback: validate raw bytes directly as ROM (will show clear size error if not 256/512KB)
        return await mountResolvedMedia('rom', resolved.name, resolved.bytes, 'rom');
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Неверный файл ROM.';
        showToast('err', msg);
        return msg;
      }
    },
    [mountResolvedMedia, showToast]
  );

  const handleRestoreOpenKick = useCallback(() => {
    const m = machineRef.current;
    if (!m) return;
    m.loadOpenKickRom();
    void deleteFromStorage('custom_kickstart_rom');
    setStatus(m.getStatusSnapshot());
    showToast('ok', 'OpenKick 1.3');
  }, [showToast]);

  const handleLoadDefaultBios = useCallback(async (): Promise<string | null> => {
    const m = machineRef.current;
    if (!m) {
      const msg = 'Эмулятор не инициализирован.';
      showToast('err', msg);
      return msg;
    }
    try {
      const resp = await fetch(DEFAULT_BIOS_ROM_URL);
      if (!resp.ok) {
        const msg = 'Файл Kickstart ROM в /bios не найден.';
        showToast('err', msg);
        return msg;
      }
      const bytes = new Uint8Array(await resp.arrayBuffer());
      const res = m.loadCustomRom(bytes, DEFAULT_BIOS_ROM_NAME);
      if (!res.ok) {
        const msg = res.error ?? 'Ошибка загрузки BIOS ROM.';
        showToast('err', msg);
        return msg;
      }
      void deleteFromStorage('custom_kickstart_rom');
      setStatus(m.getStatusSnapshot());
      showToast('ok', 'Загружен Kickstart 1.3');
      return null;
    } catch {
      const msg = 'Не удалось загрузить Kickstart ROM из /bios.';
      showToast('err', msg);
      return msg;
    }
  }, [showToast]);

  const handleSaveSlot = useCallback(
    async (slot: SaveSlotIndex) => {
      const m = machineRef.current;
      if (!m) return;
      const bundle = m.exportSaveBundle();
      const screenshotDataUrl = captureScreenThumbnail();
      const summary = await saveSlotData(slot, {
        slot,
        timestamp: bundle.state.timestamp,
        state: bundle.state,
        df0Disk: bundle.df0Disk,
        df1Disk: bundle.df1Disk,
        screenshotDataUrl,
      });
      setSaveSlots((prev) => ({ ...prev, [slot]: summary }));
      showToast('ok', `Сохранено в Слот ${slot}`);
    },
    [captureScreenThumbnail, showToast]
  );

  const handleLoadSlot = useCallback(
    async (slot: SaveSlotIndex): Promise<boolean> => {
      const m = machineRef.current;
      if (!m) return false;
      const data = await loadSlotData(slot);
      if (!data) {
        showToast('err', `Слот ${slot} пуст`);
        return false;
      }
      const ok = m.loadSaveBundle(data.state, data.df0Disk, data.df1Disk);
      if (!ok) {
        showToast('err', `Ошибка загрузки Слота ${slot}`);
        return false;
      }

      configRef.current = m.config;
      setConfig(m.config);
      setHapticsEnabled(m.config.hapticsEnabled);
      if (canvasRef.current) {
        canvasRef.current.dataset.overscan = m.config.overscan;
      }
      const loadedSize = m.getFramebufferSize();
      cropRectRef.current = autoCropRef.current.reset(loadedSize.width, loadedSize.height);
      setCropAspect(cropPhysicalAspect(cropRectRef.current, m.config.videoStandard));
      setStatus(m.getStatusSnapshot());
      if (m.paused) {
        drawScreenshotToMainCanvas(data.screenshotDataUrl);
      }
      showToast('ok', `Загружен Слот ${slot}`);
      return true;
    },
    [drawScreenshotToMainCanvas, showToast]
  );

  const handleDeleteSlot = useCallback(
    async (slot: SaveSlotIndex) => {
      await deleteSlotData(slot);
      setSaveSlots((prev) => ({ ...prev, [slot]: null }));
      showToast('ok', `Слот ${slot} очищен`);
    },
    [showToast]
  );

  useEffect(() => {
    const onFsChange = () => {
      const active = Boolean(document.fullscreenElement);
      if (active) {
        wasNativeFsRef.current = true;
        setIsFullscreen(true);
      } else if (wasNativeFsRef.current) {
        wasNativeFsRef.current = false;
        setIsFullscreen(false);
      }
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const handleToggleFullscreen = useCallback(() => {
    setIsFullscreen((prev) => {
      const next = !prev;
      if (next) {
        const el = rootRef.current;
        if (el?.requestFullscreen) {
          try {
            const p = el.requestFullscreen();
            if (p && typeof p.catch === 'function') {
              p.catch(() => {
                // Native fullscreen may be blocked in iframes/iOS; layout fullscreen stays active
              });
            }
          } catch {
            // Ignore
          }
        }
      } else {
        wasNativeFsRef.current = false;
        if (document.fullscreenElement && document.exitFullscreen) {
          try {
            const p = document.exitFullscreen();
            if (p && typeof p.catch === 'function') {
              p.catch(() => {});
            }
          } catch {
            // Ignore
          }
        }
      }
      return next;
    });
  }, []);

  const commitCustomProfiles = useCallback(
    (updater: (prev: CustomProfilesState) => CustomProfilesState) => {
      setCustomProfilesState((prev) => {
        const next = updater(prev);
        saveCustomProfiles(next);
        return next;
      });
    },
    []
  );

  const activeCustomProfile = getActiveProfile(customProfilesState);

  const handleToggleCustomEdit = useCallback(() => {
    setCustomEditMode((prev) => {
      const next = !prev;
      if (!next) {
        setCustomSelection(null);
        setCustomPickerContext(null);
      }
      return next;
    });
  }, []);

  const handleAddCustomButton = useCallback(() => {
    const id = `btn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
    const count = activeCustomProfile.buttons.length;
    const newBtn: CustomButtonConfig = {
      id,
      xPct: clampPct(50 + ((count % 3) - 1) * 14, 10, 90),
      yPct: clampPct(50 + (Math.floor(count / 3) % 2) * 14, 14, 86),
      size: 'md',
      target: { kind: 'key', code: AMIGA_RAW.SPACE },
    };
    commitCustomProfiles((prev) =>
      updateActiveProfile(prev, (prof) => ({
        ...prof,
        buttons: [...prof.buttons, newBtn],
      }))
    );
    setCustomSelection({ kind: 'button', id });
    setCustomPickerContext({ kind: 'button', buttonId: id });
  }, [activeCustomProfile.buttons.length, commitCustomProfiles]);

  const handleAddCustomStick = useCallback(() => {
    commitCustomProfiles((prev) =>
      updateActiveProfile(prev, (prof) => ({
        ...prof,
        stick: prof.stick ?? createDefaultStickConfig(),
      }))
    );
    setCustomSelection({ kind: 'stick' });
  }, [commitCustomProfiles]);

  const handleDeleteSelectedCustom = useCallback(() => {
    if (!customSelection) return;
    if (customSelection.kind === 'stick') {
      commitCustomProfiles((prev) =>
        updateActiveProfile(prev, (prof) => ({ ...prof, stick: null }))
      );
      setCustomSelection(null);
      return;
    }
    const delId = customSelection.id;
    commitCustomProfiles((prev) =>
      updateActiveProfile(prev, (prof) => ({
        ...prof,
        buttons: prof.buttons.filter((b) => b.id !== delId),
      }))
    );
    setCustomSelection(null);
  }, [commitCustomProfiles, customSelection]);

  const handleChangeSelectedCustomSize = useCallback(
    (size: ControlButtonSize) => {
      if (!customSelection) return;
      if (customSelection.kind === 'stick') {
        commitCustomProfiles((prev) =>
          updateActiveProfile(prev, (prof) =>
            prof.stick ? { ...prof, stick: { ...prof.stick, size } } : prof
          )
        );
      } else {
        const btnId = customSelection.id;
        commitCustomProfiles((prev) =>
          updateActiveProfile(prev, (prof) => ({
            ...prof,
            buttons: prof.buttons.map((b) => (b.id === btnId ? { ...b, size } : b)),
          }))
        );
      }
    },
    [commitCustomProfiles, customSelection]
  );

  const handleChangeFullscreenOverlayMode = useCallback((mode: FullscreenOverlayMode) => {
    if (mode === 'hidden') {
      setFullscreenOverlayHidden(true);
      setCustomEditMode(false);
    } else {
      setFullscreenOverlayHidden(false);
      setMobileDeck(mode);
      if (mode !== 'custom') setCustomEditMode(false);
    }
  }, []);

  const fullscreenOverlayMode: FullscreenOverlayMode = fullscreenOverlayHidden ? 'hidden' : mobileDeck;
  const showCustomEditorToolbar =
    mobileDeck === 'custom' && customEditMode && (!isFullscreen || !fullscreenOverlayHidden);

  const customEditToolbarNode = showCustomEditorToolbar ? (
    <CustomEditToolbar
      profilesState={customProfilesState}
      activeProfile={activeCustomProfile}
      selection={customSelection}
      onSelectProfile={(profileId) => {
        setCustomSelection(null);
        commitCustomProfiles((prev) => ({ ...prev, activeProfileId: profileId }));
      }}
      onCreateProfile={(name) => {
        setCustomSelection(null);
        commitCustomProfiles((prev) => createProfile(prev, name));
      }}
      onRenameProfile={(name) =>
        commitCustomProfiles((prev) => renameProfile(prev, prev.activeProfileId, name))
      }
      onDeleteProfile={() => {
        setCustomSelection(null);
        commitCustomProfiles((prev) => deleteProfile(prev, prev.activeProfileId));
      }}
      onAddButton={handleAddCustomButton}
      onAddStick={handleAddCustomStick}
      onDeleteSelected={handleDeleteSelectedCustom}
      onOpenButtonPicker={(buttonId) => setCustomPickerContext({ kind: 'button', buttonId })}
      onOpenStickDirPicker={(dir) => setCustomPickerContext({ kind: 'stick-dir', dir })}
      onChangeSelectedSize={handleChangeSelectedCustomSize}
      onDone={handleToggleCustomEdit}
    />
  ) : null;

  const handleOpenDisks = useCallback(() => {
    if (lastLaunchViewRef.current === 'archive' && lastArchive) {
      setDisksOpen(false);
      setPendingArchive(lastArchive);
    } else {
      lastLaunchViewRef.current = 'drawer';
      setDisksOpen(true);
    }
  }, [lastArchive]);

  return (
    <div
      ref={rootRef}
      className={`h-[100dvh] w-full flex text-[#F1EFEA] overflow-hidden ${
        isFullscreen ? 'flex-row bg-black' : 'flex-col bg-[#16171A]'
      }`}
      data-emulator-state={status.paused ? 'paused' : 'running'}
      data-chipset={status.chipset}
      data-df0={status.df0.inserted ? status.df0.name : 'empty'}
      data-fullscreen={isFullscreen ? 'true' : 'false'}
    >
      {/* Hardware Bar: top horizontal in normal mode, vertical left in fullscreen */}
      <HardwareTopBar
        status={status}
        audioEnabled={config.audioEnabled}
        isFullscreen={isFullscreen}
        fullscreenOverlayMode={fullscreenOverlayMode}
        joystickConnected={config.joystickConnected}
        customEditMode={customEditMode}
        onToggleCustomEditMode={handleToggleCustomEdit}
        onChangeFullscreenOverlayMode={handleChangeFullscreenOverlayMode}
        onToggleFullscreen={handleToggleFullscreen}
        onTogglePause={handleTogglePause}
        onToggleAudio={handleToggleAudio}
        onWarmReset={handleWarmReset}
        onOpenDisks={handleOpenDisks}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {/* Main Responsive Workspace */}
      <main
        className={
          isFullscreen
            ? 'flex-1 min-w-0 h-full flex flex-col relative bg-black'
            : 'flex-1 min-h-0 flex flex-col max-w-[1440px] w-full mx-auto'
        }
      >
        {/* Fullscreen Custom Editor sits cleanly ABOVE the screen/control zone (never overlapping) */}
        {isFullscreen && customEditToolbarNode}

        {/* SCREEN (+ Side Hardware Bay on Desktop when not fullscreen, or Overlay Controls in fullscreen) */}
        <section
          style={{ ['--screen-aspect' as string]: String(cropAspect) }}
          className={
            isFullscreen
              ? 'relative w-full flex-1 min-h-0 bg-black overflow-hidden'
              : 'shrink-0 w-full aspect-[var(--screen-aspect)] max-h-[52dvh] lg:aspect-auto lg:flex-1 lg:min-h-0 lg:max-h-none grid grid-cols-1 lg:grid-cols-[1fr_340px] bg-[#0D0E11] border-b lg:border-b-0 border-white/10'
          }
        >
          <div className="min-w-0 min-h-0 w-full h-full">
            <AmigaScreen
              canvasRef={canvasRef}
              scanlines={config.crtScanlines}
              paused={status.paused}
              aspectRatio={cropAspect}
              fullscreen={isFullscreen}
              onMouseMove={handleMouseMove}
              onMouseButton={handleMouseButton}
              onUserInteract={wakeAudio}
            />
          </div>

          {isFullscreen && !fullscreenOverlayHidden && (
            <div className="absolute inset-0 z-20 pointer-events-none">
              {mobileDeck === 'gamepad' && config.joystickConnected ? (
                <TouchGamepad
                  fullscreenOverlay
                  onJoystickChange={handleJoystickChange}
                  onMouseButton={handleMouseButton}
                  onKeyPulse={handleKeyEvent}
                  onUserInteract={wakeAudio}
                />
              ) : mobileDeck === 'custom' ? (
                <CustomControlsOverlay
                  fullscreenOverlay
                  profile={activeCustomProfile}
                  editMode={customEditMode}
                  selection={customSelection}
                  onSelect={setCustomSelection}
                  onOpenButtonPicker={(buttonId) =>
                    setCustomPickerContext({ kind: 'button', buttonId })
                  }
                  onMoveButton={(buttonId, xPct, yPct) =>
                    commitCustomProfiles((prev) =>
                      updateActiveProfile(prev, (prof) => ({
                        ...prof,
                        buttons: prof.buttons.map((b) =>
                          b.id === buttonId ? { ...b, xPct, yPct } : b
                        ),
                      }))
                    )
                  }
                  onMoveStick={(xPct, yPct) =>
                    commitCustomProfiles((prev) =>
                      updateActiveProfile(prev, (prof) =>
                        prof.stick ? { ...prof, stick: { ...prof.stick, xPct, yPct } } : prof
                      )
                    )
                  }
                  onKeyEvent={handleKeyEvent}
                  onJoystickChange={handleJoystickChange}
                  onMouseMove={handleMouseMove}
                  onMouseButton={handleMouseButton}
                  onUserInteract={wakeAudio}
                />
              ) : mobileDeck === 'mouse' ? (
                <TouchpadDeck
                  fullscreenOverlay
                  onMouseMove={handleMouseMove}
                  onMouseButton={handleMouseButton}
                  onUserInteract={wakeAudio}
                />
              ) : (
                <AmigaKeyboard
                  fullscreenOverlay
                  mode={mobileDeck === 'numpad' ? 'numpad' : 'qwerty'}
                  capsLock={status.capsLock}
                  onKeyEvent={handleKeyEvent}
                  onMouseButton={handleMouseButton}
                  onWarmReset={handleWarmReset}
                  onUserInteract={wakeAudio}
                />
              )}
            </div>
          )}

          {/* Desktop Side Hardware Bay (hidden in fullscreen) */}
          {!isFullscreen && (
          <aside
            className="hidden lg:flex flex-col bg-[#1A1C20] border-l border-white/10 p-3 gap-2.5 min-h-0 overflow-y-auto"
            aria-label="Дисководы и сохранения"
          >
            {/* Active Drives DF0 / DF1 / DH0 / DH1 & ROM */}
            <div className="bg-[#131417] border border-white/8 rounded-lg px-2.5 py-2 space-y-2 shrink-0">
              {/* DF0 */}
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-1.5">
                  <span className="inline-flex items-center gap-1 text-[11px] font-mono text-[#E07A22] font-semibold">
                    <FloppyDiskIcon className="w-3.5 h-3.5 shrink-0" />
                    DF0:
                  </span>
                  <div className="flex items-center gap-1 shrink-0">
                    <input
                      ref={sidebarDf0InputRef}
                      type="file"
                      aria-label="Выбрать ADF или архив (7z, rar, zip, lha, adz) для DF0"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        e.target.value = '';
                        if (f) void handleUploadAdf(0, f);
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => sidebarDf0InputRef.current?.click()}
                      className="h-7 px-2 rounded bg-[#2A2D33] hover:bg-[#383C44] text-[11px] font-medium text-[#F2EFE9] flex items-center gap-1"
                    >
                      <FolderUp className="w-3 h-3" />
                      ADF/Архив
                    </button>
                    <button
                      type="button"
                      onClick={() => handleInsertBlankAdf(0)}
                      aria-label="Вставить пустую дискету в DF0"
                      className="h-7 px-2 rounded bg-[#2A2D33] hover:bg-[#383C44] text-[11px] font-medium text-[#E6E2D9] flex items-center gap-1"
                    >
                      <FilePlus2 className="w-3 h-3 text-[#E07A22]" />
                      Пустая
                    </button>
                    {status.df0.inserted && (
                      <>
                        <button
                          type="button"
                          onClick={() => handleDownloadAdf(0)}
                          aria-label="Скачать DF0"
                          title="Скачать ADF"
                          className="h-7 w-7 rounded bg-[#2A2D33] hover:bg-[#383C44] text-[#8BC49A] flex items-center justify-center"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleEjectDisk(0)}
                          aria-label="Извлечь DF0"
                          title="Извлечь диск"
                          className="h-7 w-7 rounded bg-[#2A2D33] hover:bg-[#3A2222] text-[#A7A39A] hover:text-[#FF9E98] flex items-center justify-center"
                        >
                          <CircleSlash className="w-3.5 h-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
                <p className="text-xs font-medium text-[#F2EFE9] truncate">
                  {status.df0.inserted ? status.df0.name : 'Пусто'}
                </p>
              </div>

              {/* DF1 */}
              <div className="space-y-1 pt-1.5 border-t border-white/6">
                <div className="flex items-center justify-between gap-1.5">
                  <span className="inline-flex items-center gap-1 text-[11px] font-mono text-[#A7A39A] font-semibold">
                    <FloppyDiskIcon className="w-3.5 h-3.5 shrink-0" />
                    DF1:
                  </span>
                  <div className="flex items-center gap-1 shrink-0">
                    <input
                      ref={sidebarDf1InputRef}
                      type="file"
                      aria-label="Выбрать ADF или архив (7z, rar, zip, lha, adz) для DF1"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        e.target.value = '';
                        if (f) void handleUploadAdf(1, f);
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => sidebarDf1InputRef.current?.click()}
                      className="h-7 px-2 rounded bg-[#2A2D33] hover:bg-[#383C44] text-[11px] font-medium text-[#F2EFE9] flex items-center gap-1"
                    >
                      <FolderUp className="w-3 h-3" />
                      ADF/Архив
                    </button>
                    <button
                      type="button"
                      onClick={() => handleInsertBlankAdf(1)}
                      aria-label="Вставить пустую дискету в DF1"
                      className="h-7 px-2 rounded bg-[#2A2D33] hover:bg-[#383C44] text-[11px] font-medium text-[#E6E2D9] flex items-center gap-1"
                    >
                      <FilePlus2 className="w-3 h-3 text-[#E07A22]" />
                      Пустая
                    </button>
                    {status.df1.inserted && (
                      <>
                        <button
                          type="button"
                          onClick={() => handleDownloadAdf(1)}
                          aria-label="Скачать DF1"
                          title="Скачать ADF"
                          className="h-7 w-7 rounded bg-[#2A2D33] hover:bg-[#383C44] text-[#8BC49A] flex items-center justify-center"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleEjectDisk(1)}
                          aria-label="Извлечь DF1"
                          title="Извлечь диск"
                          className="h-7 w-7 rounded bg-[#2A2D33] hover:bg-[#3A2222] text-[#A7A39A] hover:text-[#FF9E98] flex items-center justify-center"
                        >
                          <CircleSlash className="w-3.5 h-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
                <p className="text-xs font-medium text-[#F2EFE9] truncate">
                  {status.df1.inserted ? status.df1.name : 'Пусто'}
                </p>
              </div>

              {/* DH0: Locked System Workbench (Auto-saved in browser IndexedDB) */}
              <div className="space-y-1 pt-1.5 border-t border-white/6">
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="inline-flex items-center gap-1 text-[11px] font-mono text-[#7AD39B] font-semibold shrink-0">
                      <HardDrive className="w-3.5 h-3.5 shrink-0" />
                      DH0:
                    </span>
                    <span className="inline-flex items-center gap-0.5 text-[9.5px] font-medium text-[#8BC49A] bg-[#58B87C]/12 border border-[#58B87C]/25 rounded px-1 py-0.5 truncate">
                      <Lock className="w-2.5 h-2.5 shrink-0" />
                      Система (кеш)
                    </span>
                  </div>
                  {status.dh0.mounted ? (
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={handleDownloadDh0}
                        aria-label="Скачать DH0 Workbench HDF"
                        title="Скачать копию DH0"
                        className="h-7 w-7 rounded bg-[#2A2D33] hover:bg-[#383C44] text-[#8BC49A] flex items-center justify-center"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={handleEjectDh0}
                        aria-label="Извлечь DH0"
                        title="Извлечь DH0"
                        className="h-7 w-7 rounded bg-[#2A2D33] hover:bg-[#3A2222] text-[#A7A39A] hover:text-[#FF9E98] flex items-center justify-center"
                      >
                        <CircleSlash className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handleMountDh0()}
                      aria-label="Подключить системный диск DH0"
                      className="h-7 px-2 rounded bg-[#2B5B40] hover:bg-[#346E4E] text-[11px] font-medium text-white flex items-center gap-1 shrink-0"
                    >
                      <HardDrive className="w-3 h-3" />
                      Подключить
                    </button>
                  )}
                </div>
                <p className="text-xs font-medium text-[#F2EFE9] truncate">
                  {status.dh0.mounted
                    ? `${status.dh0.name} (${Math.max(1, Math.round(status.dh0.sizeBytes / (1024 * 1024)))} МБ)`
                    : 'Извлечён (в кеше)'}
                </p>
                <HardfileSizePanel
                  compact
                  dh0={status.dh0}
                  targetSizeMB={dh0SizeMB}
                  driveLabel="DH0:"
                  sliderLabel="Память системы (DH0:)"
                  onChangeSizeMB={handleChangeDh0Size}
                />
              </div>

              {/* DH1: User Games & Data HDF */}
              <div className="space-y-1 pt-1.5 border-t border-white/6">
                <div className="flex items-center justify-between gap-1.5">
                  <span className="inline-flex items-center gap-1 text-[11px] font-mono text-[#7AD39B] font-semibold">
                    <HardDrive className="w-3.5 h-3.5 shrink-0" />
                    DH1:
                  </span>
                  <div className="flex items-center gap-1 shrink-0">
                    <input
                      ref={sidebarDh1InputRef}
                      type="file"
                      aria-label="Выбрать HDF или любой архив (7z, rar, zip, lha) для DH1"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        e.target.value = '';
                        if (f) void handleUploadDh1(f);
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => sidebarDh1InputRef.current?.click()}
                      className="h-7 px-2 rounded bg-[#2A2D33] hover:bg-[#383C44] text-[11px] font-medium text-[#F2EFE9] flex items-center gap-1"
                    >
                      <HardDrive className="w-3 h-3 text-[#7AD39B]" />
                      HDF/Архив
                    </button>
                    <button
                      type="button"
                      onClick={() => handleCreateBlankDh1(dh1SizeMB)}
                      aria-label={`Создать новый DH1 HDF ${dh1SizeMB} МБ`}
                      title={`Создать новый DH1 HDF ${dh1SizeMB} МБ`}
                      className="h-7 px-2 rounded bg-[#2A2D33] hover:bg-[#383C44] text-[11px] font-medium text-[#E6E2D9] flex items-center gap-1"
                    >
                      <FilePlus2 className="w-3 h-3 text-[#7AD39B]" />
                      {dh1SizeMB}МБ
                    </button>
                    {status.dh1.mounted && (
                      <>
                        <button
                          type="button"
                          onClick={handleDownloadDh1}
                          aria-label="Скачать DH1 HDF"
                          title="Скачать DH1 HDF"
                          className="h-7 w-7 rounded bg-[#2A2D33] hover:bg-[#383C44] text-[#8BC49A] flex items-center justify-center"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={handleEjectDh1}
                          aria-label="Отключить DH1"
                          title="Отключить DH1"
                          className="h-7 w-7 rounded bg-[#2A2D33] hover:bg-[#3A2222] text-[#A7A39A] hover:text-[#FF9E98] flex items-center justify-center"
                        >
                          <CircleSlash className="w-3.5 h-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
                <p className="text-xs font-medium text-[#F2EFE9] truncate">
                  {status.dh1.mounted
                    ? `${status.dh1.name} (${Math.max(1, Math.round(status.dh1.sizeBytes / (1024 * 1024)))} МБ)`
                    : 'Не подключён (Игры / Файлы)'}
                </p>
                <HardfileSizePanel
                  compact
                  dh0={status.dh1}
                  targetSizeMB={dh1SizeMB}
                  driveLabel="DH1:"
                  onChangeSizeMB={handleChangeDh1Size}
                />
              </div>

              {/* ROM */}
              <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-white/6">
                <span className="text-[10px] text-[#8D8980] truncate">ROM: {status.romName}</span>
                <button
                  type="button"
                  onClick={() => setDisksOpen(true)}
                  className="text-[11px] font-medium text-[#E07A22] hover:underline shrink-0"
                >
                  Диски / HDF / ROM
                </button>
              </div>
            </div>

            {/* 5 Save State Slots */}
            <div className="flex-1 min-h-[160px] flex flex-col gap-1.5">
              <h2 className="text-xs font-semibold text-[#BDB9B0] shrink-0">Сохранения</h2>
              <div className="flex-1 min-h-0 overflow-y-auto pr-0.5">
                <SaveSlotsList
                  compact
                  slots={saveSlots}
                  onSaveSlot={handleSaveSlot}
                  onLoadSlot={handleLoadSlot}
                  onDeleteSlot={handleDeleteSlot}
                />
              </div>
            </div>
          </aside>
          )}
        </section>

        {/* MOBILE INPUT MODE SWITCHER & CONTROL DECK (hidden on desktop and in fullscreen) */}
        {!isFullscreen && (
        <>
        <div className="lg:hidden h-10 shrink-0 bg-[#1B1C1F] border-b border-white/10 px-1.5 flex items-center justify-center gap-1.5 select-none">
          <div
            className={`flex-1 max-w-[540px] grid ${
              config.joystickConnected
                ? 'grid-cols-[1.15fr_0.78fr_0.92fr_1.35fr_0.8fr]'
                : 'grid-cols-[1.2fr_0.85fr_1fr_0.95fr]'
            } gap-0.5 p-0.5 bg-[#121316] rounded-md`}
            role="tablist"
            aria-label="Режим управления"
          >
            <button
              type="button"
              role="tab"
              aria-selected={mobileDeck === 'qwerty'}
              onClick={() => {
                setMobileDeck('qwerty');
                setCustomEditMode(false);
              }}
              className={`h-7 px-1 rounded text-[10px] sm:text-[11px] font-semibold flex items-center justify-center gap-0.5 whitespace-nowrap transition-colors ${
                mobileDeck === 'qwerty'
                  ? 'bg-[#C8342A] text-white'
                  : 'text-[#B2AEA5] hover:text-white'
              }`}
            >
              <Keyboard className="w-3 h-3 shrink-0" />
              QWERTY
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mobileDeck === 'numpad'}
              onClick={() => {
                setMobileDeck('numpad');
                setCustomEditMode(false);
              }}
              className={`h-7 px-1 rounded text-[10px] sm:text-[11px] font-semibold flex items-center justify-center gap-0.5 whitespace-nowrap transition-colors ${
                mobileDeck === 'numpad'
                  ? 'bg-[#C8342A] text-white'
                  : 'text-[#B2AEA5] hover:text-white'
              }`}
            >
              <Hash className="w-3 h-3 shrink-0" />
              Num
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mobileDeck === 'mouse'}
              onClick={() => {
                setMobileDeck('mouse');
                setCustomEditMode(false);
              }}
              className={`h-7 px-1 rounded text-[10px] sm:text-[11px] font-semibold flex items-center justify-center gap-0.5 whitespace-nowrap transition-colors ${
                mobileDeck === 'mouse'
                  ? 'bg-[#C8342A] text-white'
                  : 'text-[#B2AEA5] hover:text-white'
              }`}
            >
              <MousePointer className="w-3 h-3 shrink-0" />
              Мышь
            </button>
            {config.joystickConnected && (
              <button
                type="button"
                role="tab"
                aria-selected={mobileDeck === 'gamepad'}
                onClick={() => {
                  setMobileDeck('gamepad');
                  setCustomEditMode(false);
                }}
                className={`h-7 px-1 rounded text-[10px] sm:text-[11px] font-semibold flex items-center justify-center gap-0.5 whitespace-nowrap transition-colors ${
                  mobileDeck === 'gamepad'
                    ? 'bg-[#C8342A] text-white'
                    : 'text-[#B2AEA5] hover:text-white'
                }`}
              >
                <Gamepad2 className="w-3 h-3 shrink-0" />
                Джойстик
              </button>
            )}
            <button
              type="button"
              role="tab"
              aria-selected={mobileDeck === 'custom'}
              onClick={() => setMobileDeck('custom')}
              className={`h-7 px-1 rounded text-[10px] sm:text-[11px] font-semibold flex items-center justify-center gap-0.5 whitespace-nowrap transition-colors ${
                mobileDeck === 'custom'
                  ? 'bg-[#C8342A] text-white'
                  : 'text-[#B2AEA5] hover:text-white'
              }`}
            >
              <LayoutGrid className="w-3 h-3 shrink-0" />
              Своё
            </button>
          </div>

          {mobileDeck === 'custom' && (
            <button
              type="button"
              onClick={handleToggleCustomEdit}
              aria-label={customEditMode ? 'Завершить настройку управления' : 'Настроить кастомное управление'}
              title={customEditMode ? 'Готово' : 'Настроить'}
              className={`h-8 w-8 shrink-0 rounded-md flex items-center justify-center transition-colors ${
                customEditMode
                  ? 'bg-[#E07A22] text-[#141518]'
                  : 'bg-[#2A2D33] text-[#E07A22] hover:bg-[#353941]'
              }`}
            >
              {customEditMode ? <Check className="w-4 h-4" /> : <Pencil className="w-4 h-4" />}
            </button>
          )}
        </div>

        {/* Non-fullscreen Custom Editor sits cleanly ABOVE the bottom control deck */}
        {customEditToolbarNode}

        {/* MOBILE BOTTOM CONTROL DECK (hidden on desktop where physical keyboard & mouse are used) */}
        <section className="lg:hidden flex-1 min-h-0 w-full">
          {mobileDeck === 'gamepad' && config.joystickConnected ? (
            <TouchGamepad
              onJoystickChange={handleJoystickChange}
              onMouseButton={handleMouseButton}
              onKeyPulse={handleKeyEvent}
              onUserInteract={wakeAudio}
            />
          ) : mobileDeck === 'custom' ? (
            <CustomControlsOverlay
              profile={activeCustomProfile}
              editMode={customEditMode}
              selection={customSelection}
              onSelect={setCustomSelection}
              onOpenButtonPicker={(buttonId) =>
                setCustomPickerContext({ kind: 'button', buttonId })
              }
              onMoveButton={(buttonId, xPct, yPct) =>
                commitCustomProfiles((prev) =>
                  updateActiveProfile(prev, (prof) => ({
                    ...prof,
                    buttons: prof.buttons.map((b) =>
                      b.id === buttonId ? { ...b, xPct, yPct } : b
                    ),
                  }))
                )
              }
              onMoveStick={(xPct, yPct) =>
                commitCustomProfiles((prev) =>
                  updateActiveProfile(prev, (prof) =>
                    prof.stick ? { ...prof, stick: { ...prof.stick, xPct, yPct } } : prof
                  )
                )
              }
              onKeyEvent={handleKeyEvent}
              onJoystickChange={handleJoystickChange}
              onMouseMove={handleMouseMove}
              onMouseButton={handleMouseButton}
              onUserInteract={wakeAudio}
            />
          ) : mobileDeck === 'mouse' ? (
            <TouchpadDeck
              onMouseMove={handleMouseMove}
              onMouseButton={handleMouseButton}
              onUserInteract={wakeAudio}
            />
          ) : (
            <AmigaKeyboard
              mode={mobileDeck === 'numpad' ? 'numpad' : 'qwerty'}
              capsLock={status.capsLock}
              onKeyEvent={handleKeyEvent}
              onMouseButton={handleMouseButton}
              onWarmReset={handleWarmReset}
              onUserInteract={wakeAudio}
            />
          )}
        </section>
        </>
        )}
      </main>

      {/* Authentic Amiga Keyboard Picker for Custom Controls */}
      {customPickerContext !== null && (() => {
        const dirLabels: Record<StickDirection, string> = {
          up: 'Стик Вверх (▲)',
          down: 'Стик Вниз (▼)',
          left: 'Стик Влево (◀)',
          right: 'Стик Вправо (▶)',
        };
        const btn =
          customPickerContext.kind === 'button'
            ? activeCustomProfile.buttons.find((b) => b.id === customPickerContext.buttonId)
            : undefined;
        const currentTarget: ControlTarget =
          customPickerContext.kind === 'button'
            ? btn?.target ?? { kind: 'key', code: AMIGA_RAW.SPACE }
            : activeCustomProfile.stick?.[customPickerContext.dir] ?? { kind: 'joy', dir: customPickerContext.dir };

        return (
          <AmigaKeyboardPicker
            title={
              customPickerContext.kind === 'stick-dir'
                ? `Назначение: ${dirLabels[customPickerContext.dir]}`
                : 'Нажмите клавишу на клавиатуре Amiga'
            }
            currentTarget={currentTarget}
            showSizeSelector={customPickerContext.kind === 'button'}
            currentSize={btn?.size ?? 'md'}
            onChangeSize={(size) => {
              if (customPickerContext.kind !== 'button') return;
              const bid = customPickerContext.buttonId;
              commitCustomProfiles((prev) =>
                updateActiveProfile(prev, (prof) => ({
                  ...prof,
                  buttons: prof.buttons.map((b) => (b.id === bid ? { ...b, size } : b)),
                }))
              );
            }}
            hideFireButtons={customPickerContext.kind === 'stick-dir'}
            joystickConnected={config.joystickConnected}
            onClose={() => setCustomPickerContext(null)}
            onSelectTarget={(target) => {
              if (customPickerContext.kind === 'button') {
                const bid = customPickerContext.buttonId;
                commitCustomProfiles((prev) =>
                  updateActiveProfile(prev, (prof) => ({
                    ...prof,
                    buttons: prof.buttons.map((b) => (b.id === bid ? { ...b, target } : b)),
                  }))
                );
              } else {
                const dir = customPickerContext.dir;
                commitCustomProfiles((prev) =>
                  updateActiveProfile(prev, (prof) =>
                    prof.stick ? { ...prof, stick: { ...prof.stick, [dir]: target } } : prof
                  )
                );
              }
              setCustomPickerContext(null);
            }}
          />
        );
      })()}

      {/* Modals / Bottom Sheets */}
      <DiskRomDrawer
        open={disksOpen}
        activeTab={drawerTab}
        onChangeTab={setDrawerTab}
        catalogState={catalogState}
        onChangeCatalogState={setCatalogState}
        lastArchiveName={lastArchive?.result.archiveName ?? null}
        onReopenLastArchive={() => {
          if (lastArchive) {
            lastLaunchViewRef.current = 'archive';
            setDisksOpen(false);
            setPendingArchive(lastArchive);
          }
        }}
        status={status}
        saveSlots={saveSlots}
        onClose={() => {
          lastLaunchViewRef.current = 'drawer';
          setDisksOpen(false);
        }}
        onUploadAdf={handleUploadAdf}
        onInsertBlankAdf={handleInsertBlankAdf}
        onDownloadAdf={handleDownloadAdf}
        onEjectDisk={handleEjectDisk}
        turboFloppy={config.turboFloppy}
        onToggleTurboFloppy={(enabled) => handleUpdateConfig({ turboFloppy: enabled })}
        dh0SizeMB={dh0SizeMB}
        onChangeDh0Size={handleChangeDh0Size}
        onDownloadDh0={handleDownloadDh0}
        onEjectDh0={handleEjectDh0}
        onMountDh0={handleMountDh0}
        dh1SizeMB={dh1SizeMB}
        onUploadDh1={handleUploadDh1}
        onCreateBlankDh1={handleCreateBlankDh1}
        onChangeDh1Size={handleChangeDh1Size}
        onDownloadDh1={handleDownloadDh1}
        onEjectDh1={handleEjectDh1}
        onUploadRom={handleUploadRom}
        onRestoreOpenKick={handleRestoreOpenKick}
        onLoadDefaultBios={handleLoadDefaultBios}
        onSaveSlot={handleSaveSlot}
        onLoadSlot={handleLoadSlot}
        onDeleteSlot={handleDeleteSlot}
        launchingCatalogId={launchingCatalogId}
        onLaunchCatalogItem={handleLaunchCatalogItem}
      />

      <ArchiveModal
        pendingArchive={pendingArchive}
        insertedDf0Name={status.df0.inserted ? status.df0.name : undefined}
        insertedDf1Name={status.df1.inserted ? status.df1.name : undefined}
        mountedDh1Name={status.dh1.mounted ? status.dh1.name : undefined}
        backLabel={drawerTab === 'catalog' ? 'Каталог' : 'Назад'}
        onBack={() => {
          lastLaunchViewRef.current = 'drawer';
          setPendingArchive(null);
          setDisksOpen(true);
        }}
        onClose={() => {
          lastLaunchViewRef.current = 'drawer';
          setPendingArchive(null);
        }}
        onSelectArchiveMedia={handleSelectArchiveMedia}
        onMountArchiveDualAdf={handleMountArchiveDualAdf}
        onPackArchiveAsAdf={handlePackArchiveAsAdf}
        onPackArchiveAsHdf={handlePackArchiveAsHdf}
      />

      <SettingsDrawer
        open={settingsOpen}
        config={config}
        onClose={() => setSettingsOpen(false)}
        onUpdateConfig={handleUpdateConfig}
      />

      <ToastContainer
        toasts={toasts}
        belowTopBar={!isFullscreen || showCustomEditorToolbar}
        onDismiss={dismissToast}
      />
    </div>
  );
}

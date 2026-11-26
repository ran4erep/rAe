/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Gamepad2, Hash, Keyboard, LayoutGrid, MousePointer, Pencil } from 'lucide-react';
import { ArchiveMediaCandidate, resolveUploadedFileAsync } from './emulator/archives/archiveManager';
import {
  CatalogDiskFile,
  CatalogGameItem,
  downloadCatalogArchive,
  downloadCatalogArchiveByUrl,
} from './emulator/catalog/amigaArchiveCatalog';
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
  clearGamepadCalibration,
  GamepadCalibrationProfile,
  loadGamepadCalibration,
  saveGamepadCalibration,
} from './emulator/controls/gamepadCalibration';
import {
  hasAnyConnectedGamepad,
  PhysicalGamepadSink,
  PhysicalGamepadTracker,
} from './emulator/controls/physicalGamepad';
import {
  createInitialSecretTapState,
  registerSecretTap,
  SecretTapState,
} from './emulator/controls/secretTapUnlock';
import { setHapticsEnabled } from './emulator/haptics';
import { buildAmigaDebugDump, formatDebugDumpFilename } from './emulator/debug/debugDump';
import { formatAmigaTriageText, formatTriageReportFilename } from './emulator/debug/triageReport';
import {
  buildDiagnosticSavestateFromMachine,
  buildDiagnosticSavestateFromSlot,
  formatSavestateFilename,
  parseDiagnosticSavestateJson,
} from './emulator/debug/savestateFile';
import { AmigaMachine } from './emulator/hardware/amigaMachine';
import { AutoCropTracker, CropRect, cropPhysicalAspect, FULL_CROP } from './emulator/hardware/autoCrop';
import { computeOverscanDisplayAspect } from './emulator/hardware/overscan';
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
  SerializedAmigaState,
} from './emulator/types';
import {
  createEmptyEmuPerf,
  EmuPerfSnapshot,
  evaluateEmuPerformance,
} from './emulator/performanceStats';
import { FullscreenOverlayMode, HardwareTopBar } from './components/HardwareTopBar';
import { AmigaScreen } from './components/AmigaScreen';
import { AmigaKeyboard } from './components/AmigaKeyboard';
import { AmigaKeyboardPicker } from './components/AmigaKeyboardPicker';
import { CustomControlsOverlay } from './components/CustomControlsOverlay';
import { CustomEditToolbar, CustomSelection } from './components/CustomEditToolbar';
import { TouchGamepad } from './components/TouchGamepad';
import { TouchpadDeck } from './components/TouchpadDeck';
import { ArchiveModal, PendingArchiveChoice } from './components/ArchiveModal';
import { BlankDiskModal } from './components/BlankDiskModal';
import { CatalogViewState, createInitialCatalogViewState } from './components/CatalogTab';
import { DiskRomDrawer, LaunchDrawerTab } from './components/DiskRomDrawer';
import { GamepadCalibrationModal } from './components/GamepadCalibrationModal';
import { OverscanAdjustPanel } from './components/OverscanAdjustPanel';
import { SettingsDrawer } from './components/SettingsDrawer';
import { ToastContainer, ToastMessage } from './components/ToastContainer';
import {
  AmigaModelKey,
  getModelKeyForChipset,
  getModelProfileByKey,
  getModelRomProfile,
  isModelRomSwitchNeeded,
  ModelRomProfile,
} from './emulator/roms/biosProfiles';

type MobileDeckMode = 'qwerty' | 'numpad' | 'mouse' | 'gamepad' | 'custom';

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

async function loadProfileWorkbenchHdf(
  profile: ModelRomProfile,
  targetSizeMB: number,
  assetCache: Map<string, Uint8Array>
): Promise<{ bytes: Uint8Array; name: string; fromCache: boolean } | null> {
  const savedDh0 = await loadBinaryFromStorage(profile.workbenchStorageKey);
  if (savedDh0) {
    return {
      bytes: savedDh0.bytes,
      name: savedDh0.name || profile.workbenchHdfName,
      fromCache: true,
    };
  }
  if (profile.modelKey === 'a500') {
    void deleteFromStorage('system_dh0_hdf');
  } else {
    void deleteFromStorage('system_dh0_hdf_a1200_v1');
  }
  let sourceBytes = assetCache.get(profile.workbenchSourceName);
  if (!sourceBytes) {
    try {
      const resp = await fetch(profile.workbenchUrl);
      if (!resp.ok) return null;
      sourceBytes = new Uint8Array(await resp.arrayBuffer());
      // Keep compact archive/ROM templates in memory cache; large raw .hdf images persist directly in IndexedDB
      if (!profile.workbenchSourceName.toLowerCase().endsWith('.hdf')) {
        assetCache.set(profile.workbenchSourceName, sourceBytes);
      }
    } catch {
      return null;
    }
  }

  if (profile.workbenchSourceName.toLowerCase().endsWith('.hdf')) {
    return {
      bytes: sourceBytes,
      name: profile.workbenchHdfName,
      fromCache: false,
    };
  }

  const resolved = await resolveUploadedFileAsync(profile.workbenchSourceName, sourceBytes);
  let hdfBytes: Uint8Array | null = null;
  if (resolved.kind === 'archive-files') {
    hdfBytes = resolved.buildHdf(targetSizeMB);
  } else if (resolved.kind === 'hdf') {
    hdfBytes = resolved.bytes;
  }
  if (!hdfBytes) return null;
  return {
    bytes: hdfBytes,
    name: profile.workbenchHdfName,
    fromCache: false,
  };
}

export default function App() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const wasNativeFsRef = useRef(false);
  const machineRef = useRef<AmigaMachine | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [config, setConfig] = useState<AmigaConfig>(() => loadSavedAmigaConfig());
  const configRef = useRef<AmigaConfig>(config);
  configRef.current = config;
  const biosCacheRef = useRef<Map<string, Uint8Array>>(new Map());
  const romSwitchSeqRef = useRef(0);
  const romSwitchPendingRef = useRef(false);
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
  const [disksOpen, setDisksOpen] = useState(false);
  const [blankDiskDrive, setBlankDiskDrive] = useState<0 | 1 | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [overscanAdjustOpen, setOverscanAdjustOpen] = useState(false);
  const [calibrationOpen, setCalibrationOpen] = useState(false);
  const [gamepadCalibration, setGamepadCalibration] = useState<GamepadCalibrationProfile | null>(() =>
    loadGamepadCalibration()
  );
  const gamepadCalibrationRef = useRef<GamepadCalibrationProfile | null>(gamepadCalibration);
  gamepadCalibrationRef.current = gamepadCalibration;
  const gamepadTrackerRef = useRef<PhysicalGamepadTracker | null>(null);
  const [debugUnlocked, setDebugUnlocked] = useState(false);
  const modelTapStateRef = useRef<SecretTapState>(createInitialSecretTapState());
  const modalOpenRef = useRef(false);
  const [dh0SizeMB, setDh0SizeMB] = useState<number>(() => {
    const initialProfile = getModelRomProfile(config.chipset);
    return loadSavedHdfSizeMB(
      initialProfile.workbenchSizeStorageKey,
      initialProfile.workbenchSizeFallbackKey
    );
  });
  const dh0SizeRef = useRef<number>(dh0SizeMB);
  dh0SizeRef.current = dh0SizeMB;
  const dh0ProfileKeyRef = useRef<AmigaModelKey>(getModelKeyForChipset(config.chipset));
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
  const showToastRef = useRef<(type: 'ok' | 'err', text: string) => void>(() => {});
  const [saveSlots, setSaveSlots] = useState<Record<SaveSlotIndex, SaveSlotSummary | null>>(() =>
    createEmptySlotMap()
  );
  const [emuPerf, setEmuPerf] = useState<EmuPerfSnapshot | null>(() =>
    config.showEmuPerf
      ? createEmptyEmuPerf(config.videoStandard === 'NTSC' ? 'NTSC' : 'PAL')
      : null
  );
  const [status, setStatus] = useState<AmigaStatusSnapshot>({
    running: true,
    paused: false,
    fps: 50,
    cpuUsageHint: 4,
    chipset: config.chipset,
    videoStandard: config.videoStandard === 'NTSC' ? 'NTSC' : 'PAL',
    romName: getModelRomProfile(config.chipset).romName,
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
    machine.onAutoVideoStandardChange = (nextStd, reason) => {
      if (disposed || machineRef.current !== machine) return;
      if (configRef.current.videoStandard !== 'auto') {
        const nextCfg = { ...configRef.current, videoStandard: nextStd };
        configRef.current = nextCfg;
        setConfig(nextCfg);
        saveAmigaConfig(nextCfg);
      }
      const sz = machine.getFramebufferSize();
      cropRectRef.current = autoCropRef.current.reset(sz.width, sz.height);
      setCropAspect(
        computeOverscanDisplayAspect(
          cropRectRef.current.w,
          cropRectRef.current.h,
          nextStd,
          configRef.current.autoCrop
        )
      );
      setStatus(machine.getStatusSnapshot());
      const msg =
        reason === 'deadlock'
          ? 'Игра ожидает PAL-строку (>262) — переключено на PAL 50 Гц'
          : reason === 'diw' || reason === 'copper'
            ? 'Обнаружен PAL-экран — Авто выбрало PAL 50 Гц'
            : reason === 'beamcon0'
              ? nextStd === 'PAL'
                ? 'Игра переключила ECS в PAL 50 Гц'
                : 'Игра переключила ECS в NTSC 60 Гц'
              : nextStd === 'NTSC'
                ? 'По метке образа выбрано NTSC 60 Гц'
                : 'По метке образа выбрано PAL 50 Гц';
      showToastRef.current('ok', msg);
    };

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d', { alpha: false, desynchronized: true }) ?? null;
    const surface: {
      w: number;
      h: number;
      imageData: ImageData | null;
      imageU32: Uint32Array | null;
    } = { w: 0, h: 0, imageData: null, imageU32: null };
    let lastCanvasOverscan = '';
    let lastVideoStd = machine.getActiveVideoStandard();

    const ensureSurface = (w: number, h: number): { imageData: ImageData; imageU32: Uint32Array } | null => {
      if (!ctx) return null;
      const std = machine.getActiveVideoStandard();
      if (surface.imageData && surface.imageU32 && surface.w === w && surface.h === h) {
        if (std !== lastVideoStd) {
          lastVideoStd = std;
          setCropAspect(
            computeOverscanDisplayAspect(
              cropRectRef.current.w,
              cropRectRef.current.h,
              std,
              configRef.current.autoCrop
            )
          );
        }
        return surface as { imageData: ImageData; imageU32: Uint32Array };
      }
      surface.w = w;
      surface.h = h;
      lastVideoStd = std;
      surface.imageData = ctx.createImageData(w, h);
      surface.imageU32 = new Uint32Array(surface.imageData.data.buffer);
      cropRectRef.current = autoCropRef.current.reset(w, h);
      setCropAspect(
        computeOverscanDisplayAspect(
          cropRectRef.current.w,
          cropRectRef.current.h,
          std,
          configRef.current.autoCrop
        )
      );
      if (canvas) {
        canvas.dataset.fbSize = `${w}x${h}`;
      }
      return surface as { imageData: ImageData; imageU32: Uint32Array };
    };

    const initSize = machine.getFramebufferSize();
    ensureSurface(initSize.width, initSize.height);
    if (canvas) {
      lastCanvasOverscan = String(machine.config.overscan);
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

    // Zero-overhead emulation performance telemetry (active ONLY when config.showEmuPerf is true)
    let perfPrevSteps = 0;
    let perfPrevRendered = 0;
    let perfPrevDrops = 0;
    let perfPrevElapsed = 0;
    let perfPrevCoreMs = 0;
    let perfPrevBlitMs = 0;
    let perfCurSteps = 0;
    let perfCurRendered = 0;
    let perfCurDrops = 0;
    let perfCurCoreMs = 0;
    let perfCurBlitMs = 0;
    let perfWindowStart = lastTime;
    let perfWasEnabled = configRef.current.showEmuPerf;
    let perfPausedReported = false;
    const resetPerfWindow = (nowMs: number) => {
      perfPrevSteps = 0;
      perfPrevRendered = 0;
      perfPrevDrops = 0;
      perfPrevElapsed = 0;
      perfPrevCoreMs = 0;
      perfPrevBlitMs = 0;
      perfCurSteps = 0;
      perfCurRendered = 0;
      perfCurDrops = 0;
      perfCurCoreMs = 0;
      perfCurBlitMs = 0;
      perfWindowStart = nowMs;
      perfPausedReported = false;
    };

    const gamepadTracker = new PhysicalGamepadTracker();
    gamepadTracker.setCalibration(gamepadCalibrationRef.current);
    gamepadTrackerRef.current = gamepadTracker;
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
      const activeDh0Profile = getModelProfileByKey(dh0ProfileKeyRef.current);
      dh0SavedSeqRef.current = slot.writeSeq;
      lastScheduledDh0Seq = slot.writeSeq;
      void saveBinaryToStorage(
        activeDh0Profile.workbenchStorageKey,
        slot.name || activeDh0Profile.workbenchHdfName,
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
        resetPerfWindow(lastTime);
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
      // Clear legacy single-slot ROM key so A500/A1200 cleanly default to KS 1.3 / KS 3.1
      void deleteFromStorage('custom_kickstart_rom');

      const startupProfile = getModelRomProfile(configRef.current.chipset);

      const loadStartupRom = async (): Promise<{ bytes: Uint8Array; name: string } | null> => {
        const savedRom = await loadBinaryFromStorage(startupProfile.customStorageKey);
        if (savedRom) return savedRom;
        const cached = biosCacheRef.current.get(startupProfile.romName);
        if (cached) return { bytes: cached, name: startupProfile.romName };
        try {
          const resp = await fetch(startupProfile.romUrl);
          if (resp.ok) {
            const bytes = new Uint8Array(await resp.arrayBuffer());
            biosCacheRef.current.set(startupProfile.romName, bytes);
            return { bytes, name: startupProfile.romName };
          }
        } catch {
          // Keep OpenKick fallback if /bios ROM is unavailable
        }
        return null;
      };

      const loadStartupDh0 = async () =>
        loadProfileWorkbenchHdf(startupProfile, dh0SizeRef.current, biosCacheRef.current);

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
          dh0ProfileKeyRef.current = startupProfile.modelKey;
          dh0SavedSeqRef.current = machine.hardfile.units[0].writeSeq;
          lastScheduledDh0Seq = machine.hardfile.units[0].writeSeq;
          const actualMB = Math.max(
            1,
            Math.min(64, Math.round(dh0Payload.bytes.length / (1024 * 1024)))
          );
          setDh0SizeMB(actualMB);
          if (!dh0Payload.fromCache) {
            void saveBinaryToStorage(
              startupProfile.workbenchStorageKey,
              dh0Payload.name,
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
      resetPerfWindow(lastTime);

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

      const trackPerf = configRef.current.showEmuPerf;
      if (trackPerf !== perfWasEnabled) {
        perfWasEnabled = trackPerf;
        resetPerfWindow(now);
      }

      if (!bootReady || tabHidden || machine.paused || romSwitchPendingRef.current) {
        if (gamepadTracker.activeMask !== 0) {
          gamepadTracker.releaseAll(gamepadSink);
        }
        if (trackPerf && bootReady && machine.paused && !perfPausedReported) {
          resetPerfWindow(now);
          perfPausedReported = true;
          setEmuPerf(
            evaluateEmuPerformance({
              paused: true,
              videoStandard: machine.getActiveVideoStandard(),
              steps: 0,
              renderedFrames: 0,
              droppedFrames: 0,
              elapsedMs: 0,
              coreMsSum: 0,
              blitMsSum: 0,
            })
          );
        }
        lastTime = now;
        return;
      }

      if (perfPausedReported) {
        resetPerfWindow(now);
      }

      if (hasPhysicalGamepad && !modalOpenRef.current) {
        gamepadTracker.poll(navigator.getGamepads(), gamepadSink);
      } else if (gamepadTracker.activeMask !== 0) {
        gamepadTracker.releaseAll(gamepadSink);
      }

      const targetFps = machine.chipset.isPalTiming() ? PAL_FPS : NTSC_FPS;
      const frameMs = 1000 / targetFps;
      const rawDelta = now - lastTime;
      const delta = rawDelta > frameMs * 2 ? frameMs * 2 : rawDelta;
      if (trackPerf && rawDelta > frameMs * 2.5) {
        perfCurDrops += Math.floor((rawDelta - frameMs * 2) / frameMs);
      }
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
        if (trackPerf) {
          const cs = performance.now();
          machine.stepFrame(doRender);
          perfCurCoreMs += performance.now() - cs;
          perfCurSteps++;
          if (doRender) perfCurRendered++;
        } else {
          machine.stepFrame(doRender);
        }
        stepped = true;
        if (doRender) rendered = true;
        fpsFrames++;
        if (performance.now() - t0 > frameMs * 0.85) {
          if (accumulator > frameMs) {
            if (trackPerf) {
              perfCurDrops += Math.floor((accumulator - frameMs) / frameMs);
            }
            accumulator = frameMs;
          }
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
        const bs = trackPerf ? performance.now() : 0;
        const fbW = machine.chipset.fbWidth;
        const fbH = machine.chipset.fbHeight;
        const surf = ensureSurface(fbW, fbH);
        if (surf) {
          const fb = machine.getFramebuffer();
          surf.imageU32.set(fb);

          const curOverscan = String(machine.config.overscan);
          if (lastCanvasOverscan !== curOverscan) {
            lastCanvasOverscan = curOverscan;
            canvas.dataset.overscan = curOverscan;
          }

          if (machine.config.autoCrop) {
            if ((cropCheckCounter++ & 3) === 0) {
              const res = autoCropRef.current.update(fb, fbW, fbH);
              if (res.changed) {
                cropRectRef.current = res.rect;
                setCropAspect(cropPhysicalAspect(res.rect, machine.getActiveVideoStandard()));
              }
            }
          } else if (
            cropRectRef.current.x !== 0 ||
            cropRectRef.current.y !== 0 ||
            cropRectRef.current.w !== fbW ||
            cropRectRef.current.h !== fbH
          ) {
            cropRectRef.current = autoCropRef.current.reset(fbW, fbH);
            setCropAspect(
              computeOverscanDisplayAspect(
                cropRectRef.current.w,
                cropRectRef.current.h,
                machine.getActiveVideoStandard(),
                false
              )
            );
          }

          const crop = cropRectRef.current;
          if (canvas.width !== crop.w || canvas.height !== crop.h) {
            canvas.width = crop.w;
            canvas.height = crop.h;
          }
          ctx.putImageData(surf.imageData, -crop.x, -crop.y, crop.x, crop.y, crop.w, crop.h);
        }
        if (trackPerf) {
          perfCurBlitMs += performance.now() - bs;
        }
      }

      if (now - fpsTimer >= 1000) {
        machine.measuredFps = Math.round((fpsFrames * 1000) / (now - fpsTimer));
        fpsFrames = 0;
        fpsTimer = now;
      }

      if (trackPerf) {
        const curElapsed = now - perfWindowStart;
        const thresholdMs = perfPrevElapsed === 0 ? 250 : 500;
        if (curElapsed >= thresholdMs) {
          setEmuPerf(
            evaluateEmuPerformance({
              paused: false,
              videoStandard: machine.getActiveVideoStandard(),
              steps: perfPrevSteps + perfCurSteps,
              renderedFrames: perfPrevRendered + perfCurRendered,
              droppedFrames: perfPrevDrops + perfCurDrops,
              elapsedMs: perfPrevElapsed + curElapsed,
              coreMsSum: perfPrevCoreMs + perfCurCoreMs,
              blitMsSum: perfPrevBlitMs + perfCurBlitMs,
            })
          );
          perfPrevSteps = perfCurSteps;
          perfPrevRendered = perfCurRendered;
          perfPrevDrops = perfCurDrops;
          perfPrevElapsed = curElapsed;
          perfPrevCoreMs = perfCurCoreMs;
          perfPrevBlitMs = perfCurBlitMs;
          perfCurSteps = 0;
          perfCurRendered = 0;
          perfCurDrops = 0;
          perfCurCoreMs = 0;
          perfCurBlitMs = 0;
          perfWindowStart = now;
        }
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
      gamepadTrackerRef.current = null;
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
  const blankDiskModalOpen = blankDiskDrive !== null;
  const customPickerOpen = customPickerContext !== null;
  const anyModalOpen =
    disksOpen ||
    settingsOpen ||
    archiveModalOpen ||
    blankDiskModalOpen ||
    customPickerOpen ||
    calibrationOpen;
  modalOpenRef.current = anyModalOpen;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (anyModalOpen) {
        if (e.code === 'Escape') {
          if (calibrationOpen) {
            setCalibrationOpen(false);
          } else if (customPickerOpen) {
            setCustomPickerContext(null);
          } else if (blankDiskModalOpen) {
            setBlankDiskDrive(null);
          } else if (archiveModalOpen) {
            setPendingArchive(null);
          } else if (settingsOpen) {
            setSettingsOpen(false);
          } else if (disksOpen) {
            setDisksOpen(false);
          }
        }
        return;
      }
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
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
      if (customPickerOpen || calibrationOpen) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
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
  }, [anyModalOpen, archiveModalOpen, blankDiskModalOpen, calibrationOpen, customPickerOpen, disksOpen, settingsOpen]);

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

  const handleMouseButton = useCallback((left?: boolean, right?: boolean, middle?: boolean) => {
    machineRef.current?.setMouseButtons(left, right, middle);
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
    const prevChipset = configRef.current.chipset;
    const nextCfg = { ...configRef.current, ...patch };
    configRef.current = nextCfg;
    setConfig(nextCfg);
    saveAmigaConfig(nextCfg);
    if (patch.overscan !== undefined && canvasRef.current) {
      canvasRef.current.dataset.overscan = String(patch.overscan);
    }
    if (patch.hapticsEnabled !== undefined) {
      setHapticsEnabled(patch.hapticsEnabled);
    }
    if (patch.joystickConnected === false) {
      setMobileDeck((prev) => (prev === 'gamepad' ? 'qwerty' : prev));
    }
    if (patch.showEmuPerf !== undefined) {
      setEmuPerf(
        patch.showEmuPerf
          ? createEmptyEmuPerf(machineRef.current?.getActiveVideoStandard() ?? 'PAL')
          : null
      );
    }
    const m = machineRef.current;
    if (m) {
      if (patch.audioVolume !== undefined && nextCfg.audioEnabled) {
        m.audio.initFromGesture();
      }
      const needsModelRomSwitch =
        patch.chipset !== undefined && isModelRomSwitchNeeded(prevChipset, nextCfg.chipset);
      m.updateConfig(patch, !needsModelRomSwitch);
      if (
        patch.autoCrop === false ||
        patch.overscan !== undefined ||
        patch.videoStandard !== undefined
      ) {
        const size = m.getFramebufferSize();
        cropRectRef.current = autoCropRef.current.reset(size.width, size.height);
        setCropAspect(
          computeOverscanDisplayAspect(
            cropRectRef.current.w,
            cropRectRef.current.h,
            m.getActiveVideoStandard(),
            nextCfg.autoCrop
          )
        );
      }
      setStatus(m.getStatusSnapshot());

      if (needsModelRomSwitch) {
        const switchSeq = ++romSwitchSeqRef.current;
        romSwitchPendingRef.current = true;
        const targetProfile = getModelRomProfile(nextCfg.chipset);
        const targetDh0SizeMB = loadSavedHdfSizeMB(
          targetProfile.workbenchSizeStorageKey,
          targetProfile.workbenchSizeFallbackKey
        );
        setDh0SizeMB(targetDh0SizeMB);

        const prevSlot = m.hardfile.units[0];
        const hadDh0Mounted = prevSlot.data !== null;
        if (prevSlot.data && prevSlot.writeSeq !== dh0SavedSeqRef.current) {
          const outgoingProfile = getModelProfileByKey(dh0ProfileKeyRef.current);
          dh0SavedSeqRef.current = prevSlot.writeSeq;
          void saveBinaryToStorage(
            outgoingProfile.workbenchStorageKey,
            prevSlot.name || outgoingProfile.workbenchHdfName,
            new Uint8Array(prevSlot.data)
          );
        }

        void (async () => {
          try {
            const loadTargetRom = async (): Promise<{ bytes: Uint8Array; name: string } | null> => {
              let romPayload: { bytes: Uint8Array; name: string } | null =
                await loadBinaryFromStorage(targetProfile.customStorageKey);
              if (!romPayload) {
                const cached = biosCacheRef.current.get(targetProfile.romName);
                if (cached) {
                  romPayload = { bytes: cached, name: targetProfile.romName };
                } else {
                  try {
                    const resp = await fetch(targetProfile.romUrl);
                    if (resp.ok) {
                      const bytes = new Uint8Array(await resp.arrayBuffer());
                      biosCacheRef.current.set(targetProfile.romName, bytes);
                      romPayload = { bytes, name: targetProfile.romName };
                    }
                  } catch {
                    // Fall back to hardReset with current ROM if BIOS fetch fails
                  }
                }
              }
              return romPayload;
            };

            const loadTargetDh0 = hadDh0Mounted
              ? loadProfileWorkbenchHdf(targetProfile, targetDh0SizeMB, biosCacheRef.current)
              : Promise.resolve(null);

            const [romPayload, dh0Payload] = await Promise.all([loadTargetRom(), loadTargetDh0]);

            if (
              romSwitchSeqRef.current !== switchSeq ||
              machineRef.current !== m ||
              configRef.current.chipset !== nextCfg.chipset
            ) {
              return;
            }

            if (dh0Payload) {
              const dh0Res = m.mountHdf(dh0Payload.bytes, dh0Payload.name, false, 0);
              if (dh0Res.ok) {
                dh0ProfileKeyRef.current = targetProfile.modelKey;
                dh0SavedSeqRef.current = m.hardfile.units[0].writeSeq;
                const actualMB = Math.max(
                  1,
                  Math.min(64, Math.round(dh0Payload.bytes.length / (1024 * 1024)))
                );
                setDh0SizeMB(actualMB);
                if (!dh0Payload.fromCache) {
                  void saveBinaryToStorage(
                    targetProfile.workbenchStorageKey,
                    dh0Payload.name,
                    new Uint8Array(dh0Payload.bytes)
                  );
                }
              }
            }

            if (romPayload) {
              m.loadCustomRom(romPayload.bytes, romPayload.name);
            } else {
              m.hardReset();
            }
            setStatus(m.getStatusSnapshot());
          } finally {
            if (romSwitchSeqRef.current === switchSeq) {
              romSwitchPendingRef.current = false;
            }
          }
        })();
      }
    }
    if (patch.chipset !== undefined && (prevChipset === 'AGA') !== (patch.chipset === 'AGA')) {
      showToastRef.current?.(
        'ok',
        patch.chipset === 'AGA'
          ? 'Режим Amiga 1200 (AGA · Kickstart 3.1)'
          : 'Режим Amiga 500 (OCS/ECS · Kickstart 1.3)'
      );
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
  showToastRef.current = showToast;

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
        const compatWarn = drive === 0 ? m.checkDf0KickstartCompat(bytes, name) : null;
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
        if (compatWarn) {
          showToast('err', compatWarn);
        }
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
      const profile = getModelRomProfile(m.config.chipset);
      await saveBinaryToStorage(profile.customStorageKey, name, bytes);
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

      const isWhdloadItem =
        item.isWhdload === true || item.proxyDownloadUrl.includes('source=whdload');

      // Grouped multi-disk / multi-variant virtual archive (Planetemu or multi-variant WHDLoad):
      // Open ArchiveModal immediately and download/pack chosen release on demand.
      if (item.files && item.files.length > 0 && !(isWhdloadItem && item.files.length === 1)) {
        const singleDiskMultiVariants =
          !isWhdloadItem && (item.diskCount ?? 1) === 1 && item.files.length > 1;
        const makeLazyCandidate = (file: CatalogDiskFile, idx: number): ArchiveMediaCandidate => {
          let cachedBytes: Uint8Array | null = null;
          let inflight: Promise<Uint8Array> | null = null;

          const candidate: ArchiveMediaCandidate = {
            id: `${idx}_${file.id}`,
            name: file.name,
            path: file.name,
            size: file.sizeBytes,
            kind: isWhdloadItem ? 'hdf' : 'adf',
            diskNumber: isWhdloadItem
              ? null
              : file.diskNumber ?? (singleDiskMultiVariants ? 1 : null),
            diskTotal: isWhdloadItem ? null : file.diskTotal ?? (item.diskCount ?? null),
            isBadDump: file.isBadDump,
            isVerified: file.isVerified,
            isClean: file.isClean,
            crackTag: file.crackTag ?? null,
            prereleaseKind: file.prereleaseKind ?? null,
            variantTags: file.variantTags,
            extractBytes: () => {
              if (!cachedBytes) {
                throw new Error(isWhdloadItem ? 'Архив ещё не скачан.' : 'Диск ещё не скачан.');
              }
              return cachedBytes;
            },
            extractBytesAsync: async () => {
              if (cachedBytes) return cachedBytes;
              if (!inflight) {
                inflight = (async () => {
                  const { filename, bytes } = await downloadCatalogArchiveByUrl({
                    proxyDownloadUrl: file.proxyDownloadUrl,
                    fallbackTitle: file.name,
                  });
                  const resolved = await resolveUploadedFileAsync(filename, bytes);
                  if (isWhdloadItem) {
                    if (resolved.kind === 'hdf') {
                      candidate.name = resolved.name;
                      candidate.path = resolved.name;
                      candidate.size = resolved.bytes.length;
                      cachedBytes = resolved.bytes;
                      return resolved.bytes;
                    }
                    if (resolved.kind === 'archive-files' || resolved.kind === 'archive-choices') {
                      const existingHdf =
                        resolved.kind === 'archive-choices'
                          ? resolved.mediaItems.find((c) => c.kind === 'hdf')
                          : undefined;
                      const hdfBytes = existingHdf
                        ? existingHdf.extractBytes()
                        : resolved.buildHdf(dh1SizeRef.current);
                      const hdfName = existingHdf
                        ? existingHdf.name
                        : `${resolved.volumeName || item.title}.hdf`;
                      candidate.name = hdfName;
                      candidate.path = hdfName;
                      candidate.size = hdfBytes.length;
                      cachedBytes = hdfBytes;
                      return hdfBytes;
                    }
                    throw new Error(`В архиве «${file.name}» не найдены файлы WHDLoad.`);
                  }

                  if (resolved.kind === 'adf') {
                    candidate.name = resolved.name;
                    candidate.path = resolved.name;
                    candidate.size = resolved.bytes.length;
                    cachedBytes = resolved.bytes;
                    return resolved.bytes;
                  }
                  if (resolved.kind === 'archive-choices') {
                    const firstAdf =
                      resolved.mediaItems.find((c) => c.kind === 'adf') ?? resolved.mediaItems[0];
                    if (firstAdf) {
                      const inner = firstAdf.extractBytes();
                      candidate.name = firstAdf.name;
                      candidate.path = firstAdf.name;
                      candidate.size = inner.length;
                      cachedBytes = inner;
                      return inner;
                    }
                  }
                  throw new Error(`В архиве «${file.name}» не найден образ ADF.`);
                })().finally(() => {
                  inflight = null;
                });
              }
              return inflight;
            },
          };
          return candidate;
        };

        const candidates = item.files.map(makeLazyCandidate);
        const totalBytes = candidates.reduce((acc, c) => acc + c.size, 0);
        const archivePrefix = isWhdloadItem ? 'WHDLOAD' : 'PLANETEMU';
        const nextArchive: PendingArchiveChoice = {
          target: isWhdloadItem ? 'dh1' : 0,
          result: {
            kind: 'archive-choices',
            archiveName: item.title,
            archiveFormat: item.platform ? `${archivePrefix} · ${item.platform}` : archivePrefix,
            volumeName: item.title,
            totalBytes,
            mediaItems: candidates,
            allFiles: candidates,
            otherFileCount: 0,
            fitsFloppy: false,
            extractAllAsFiles: () => [],
            buildAdf: () => new Uint8Array(0),
            buildHdf: () => new Uint8Array(0),
          },
        };
        lastLaunchViewRef.current = 'archive';
        setDisksOpen(false);
        setLastArchive(nextArchive);
        setPendingArchive(nextArchive);
        return;
      }

      setLaunchingCatalogId(item.id);
      try {
        const singleWhdFile = isWhdloadItem && item.files?.length === 1 ? item.files[0] : null;
        const { filename, bytes } = singleWhdFile
          ? await downloadCatalogArchiveByUrl({
              proxyDownloadUrl: singleWhdFile.proxyDownloadUrl,
              fallbackTitle: singleWhdFile.name,
            })
          : await downloadCatalogArchive({ item });
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
        const bytes = item.extractBytesAsync
          ? await item.extractBytesAsync()
          : item.extractBytes();
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
        const b0 = first.extractBytesAsync
          ? await first.extractBytesAsync()
          : first.extractBytes();
        const b1 = second.extractBytesAsync
          ? await second.extractBytesAsync()
          : second.extractBytes();
        const hintReset = m.shouldHintResetForDf0Boot(b0);
        const compatWarn = m.checkDf0KickstartCompat(b0, first.name);
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
        if (compatWarn) {
          showToast('err', compatWarn);
        }
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
      const activeProfile = getModelProfileByKey(dh0ProfileKeyRef.current);
      if (!m || !m.hardfile.isMounted(0)) {
        const cfgProfile = getModelRomProfile(configRef.current.chipset);
        setDh0SizeMB(clamped);
        try {
          window.localStorage.setItem(cfgProfile.workbenchSizeStorageKey, String(clamped));
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
        window.localStorage.setItem(activeProfile.workbenchSizeStorageKey, String(clamped));
      } catch {
        // Ignore storage error
      }
      const slot = m.hardfile.units[0];
      if (slot.data) {
        dh0SavedSeqRef.current = slot.writeSeq;
        void saveBinaryToStorage(
          activeProfile.workbenchStorageKey,
          slot.name || activeProfile.workbenchHdfName,
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

  const triggerDownloadJson = useCallback(
    (fileName: string, data: unknown, toastLabel: string) => {
      const jsonText = JSON.stringify(data, null, 2);
      const blob = new Blob([jsonText], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
      showToast('ok', `${toastLabel}: ${fileName}`);
    },
    [showToast]
  );

  const handleDownloadDebugDump = useCallback(() => {
    const m = machineRef.current;
    if (!m) {
      showToast('err', 'Эмулятор не инициализирован.');
      return;
    }
    try {
      const dump = buildAmigaDebugDump(m);
      const fileName = formatDebugDumpFilename(m);
      triggerDownloadJson(fileName, dump, 'Дамп отладки');
    } catch {
      showToast('err', 'Не удалось сформировать дамп отладки.');
    }
  }, [showToast, triggerDownloadJson]);

  const handleDownloadTriageReport = useCallback(() => {
    const m = machineRef.current;
    if (!m) {
      showToast('err', 'Эмулятор не инициализирован.');
      return;
    }
    try {
      const report = formatAmigaTriageText(m);
      const fileName = formatTriageReportFilename(m);
      const blob = new Blob([report], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
      const kb = (report.length / 1024).toFixed(1);
      showToast('ok', `Triage-лог (${kb} КБ): ${fileName}`);
    } catch {
      showToast('err', 'Не удалось сформировать triage-лог.');
    }
  }, [showToast]);

  const handleCopyTriageReport = useCallback(async () => {
    const m = machineRef.current;
    if (!m) {
      showToast('err', 'Эмулятор не инициализирован.');
      return;
    }
    try {
      const report = formatAmigaTriageText(m);
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(report);
        const kb = (report.length / 1024).toFixed(1);
        showToast('ok', `Triage-лог (${kb} КБ) скопирован в буфер`);
        return;
      }
      showToast('err', 'Буфер обмена недоступен — скачайте .txt файл.');
    } catch {
      showToast('err', 'Не удалось скопировать triage-лог.');
    }
  }, [showToast]);

  const handleDownloadLiveSavestate = useCallback(() => {
    const m = machineRef.current;
    if (!m) {
      showToast('err', 'Эмулятор не инициализирован.');
      return;
    }
    try {
      const thumb = captureScreenThumbnail();
      const payload = buildDiagnosticSavestateFromMachine(m, thumb);
      const label =
        m.floppy.drives[0].name ||
        m.hardfile.units[1].name ||
        m.hardfile.units[0].name ||
        'amiga500';
      const fileName = formatSavestateFilename(label, 'live');
      triggerDownloadJson(fileName, payload, 'Сейвстейт');
    } catch {
      showToast('err', 'Не удалось сохранить файл сейвстейта.');
    }
  }, [captureScreenThumbnail, showToast, triggerDownloadJson]);

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
      const activeProfile = getModelProfileByKey(dh0ProfileKeyRef.current);
      dh0SavedSeqRef.current = slot.writeSeq;
      void saveBinaryToStorage(
        activeProfile.workbenchStorageKey,
        slot.name || activeProfile.workbenchHdfName,
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
    const profile = getModelRomProfile(m.config.chipset);
    const targetSizeMB = loadSavedHdfSizeMB(
      profile.workbenchSizeStorageKey,
      profile.workbenchSizeFallbackKey
    );
    try {
      const dh0Payload = await loadProfileWorkbenchHdf(profile, targetSizeMB, biosCacheRef.current);
      if (machineRef.current !== m) return;
      if (!dh0Payload) {
        showToast('err', `Не удалось загрузить ${profile.workbenchSourceName} из /bios.`);
        return;
      }
      const res = m.mountHdf(dh0Payload.bytes, dh0Payload.name, true, 0);
      if (!res.ok) {
        showToast('err', res.error ?? 'Ошибка подключения системного диска DH0:.');
        return;
      }
      dh0ProfileKeyRef.current = profile.modelKey;
      dh0SavedSeqRef.current = m.hardfile.units[0].writeSeq;
      const actualMB = Math.max(
        1,
        Math.min(64, Math.round(dh0Payload.bytes.length / (1024 * 1024)))
      );
      setDh0SizeMB(actualMB);
      if (!dh0Payload.fromCache) {
        void saveBinaryToStorage(
          profile.workbenchStorageKey,
          dh0Payload.name,
          new Uint8Array(dh0Payload.bytes)
        );
      }
      setStatus(m.getStatusSnapshot());
      showToast('ok', `DH0: подключён (${dh0Payload.name})`);
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

  const handleInsertBlankAdf = useCallback((drive: 0 | 1) => {
    setBlankDiskDrive(drive);
  }, []);

  const handleConfirmBlankAdf = useCallback(
    (drive: 0 | 1, volumeLabel: string) => {
      const m = machineRef.current;
      if (!m) return;
      const diskName = m.insertBlankAdf(drive, undefined, volumeLabel);
      setStatus(m.getStatusSnapshot());
      setBlankDiskDrive(null);
      showToast('ok', `DF${drive}: ${diskName} (метка: ${volumeLabel})`);
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
    const profile = getModelRomProfile(m.config.chipset);
    m.loadOpenKickRom();
    void deleteFromStorage(profile.customStorageKey);
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
    const profile = getModelRomProfile(m.config.chipset);
    try {
      let bytes = biosCacheRef.current.get(profile.romName);
      if (!bytes) {
        const resp = await fetch(profile.romUrl);
        if (!resp.ok) {
          const msg = `Файл ${profile.shortLabel} в /bios не найден.`;
          showToast('err', msg);
          return msg;
        }
        bytes = new Uint8Array(await resp.arrayBuffer());
        biosCacheRef.current.set(profile.romName, bytes);
      }
      const res = m.loadCustomRom(bytes, profile.romName);
      if (!res.ok) {
        const msg = res.error ?? 'Ошибка загрузки BIOS ROM.';
        showToast('err', msg);
        return msg;
      }
      void deleteFromStorage(profile.customStorageKey);
      setStatus(m.getStatusSnapshot());
      showToast('ok', `Загружен ${profile.shortLabel}`);
      return null;
    } catch {
      const msg = `Не удалось загрузить ${profile.shortLabel} из /bios.`;
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

  const syncRomForSavestate = useCallback(
    async (m: AmigaMachine, state: SerializedAmigaState): Promise<boolean> => {
      const prevChipset = m.config.chipset;
      const targetChipset = state.config?.chipset ?? prevChipset;
      const modelChanged = isModelRomSwitchNeeded(prevChipset, targetChipset);
      const targetIsOpenKick = Boolean(state.isOpenKick);

      if (!modelChanged && m.isOpenKick === targetIsOpenKick) {
        return true;
      }

      const switchSeq = ++romSwitchSeqRef.current;
      romSwitchPendingRef.current = true;
      try {
        const targetProfile = getModelRomProfile(targetChipset);
        const prevSlot = m.hardfile.units[0];
        if (modelChanged && prevSlot.data && prevSlot.writeSeq !== dh0SavedSeqRef.current) {
          const outgoingProfile = getModelProfileByKey(dh0ProfileKeyRef.current);
          dh0SavedSeqRef.current = prevSlot.writeSeq;
          void saveBinaryToStorage(
            outgoingProfile.workbenchStorageKey,
            prevSlot.name || outgoingProfile.workbenchHdfName,
            new Uint8Array(prevSlot.data)
          );
        }

        const loadTargetRom = async (): Promise<{ bytes: Uint8Array; name: string } | null> => {
          if (targetIsOpenKick) return null;
          let romPayload: { bytes: Uint8Array; name: string } | null =
            await loadBinaryFromStorage(targetProfile.customStorageKey);
          if (!romPayload) {
            const cached = biosCacheRef.current.get(targetProfile.romName);
            if (cached) {
              romPayload = { bytes: cached, name: targetProfile.romName };
            } else {
              try {
                const resp = await fetch(targetProfile.romUrl);
                if (resp.ok) {
                  const bytes = new Uint8Array(await resp.arrayBuffer());
                  biosCacheRef.current.set(targetProfile.romName, bytes);
                  romPayload = { bytes, name: targetProfile.romName };
                }
              } catch {
                // Keep existing ROM if BIOS fetch fails
              }
            }
          }
          return romPayload;
        };

        const targetDh0SizeMB = loadSavedHdfSizeMB(
          targetProfile.workbenchSizeStorageKey,
          targetProfile.workbenchSizeFallbackKey
        );
        const loadTargetDh0 =
          modelChanged && prevSlot.data !== null
            ? loadProfileWorkbenchHdf(targetProfile, targetDh0SizeMB, biosCacheRef.current)
            : Promise.resolve(null);

        const [romPayload, dh0Payload] = await Promise.all([loadTargetRom(), loadTargetDh0]);
        if (machineRef.current !== m || romSwitchSeqRef.current !== switchSeq) {
          return false;
        }

        if (targetIsOpenKick) {
          if (!m.isOpenKick) {
            m.loadOpenKickRom();
          }
        } else if (romPayload && (romPayload.bytes.length === 262144 || romPayload.bytes.length === 524288)) {
          m.memory.loadRom(romPayload.bytes);
          m.romName = romPayload.name;
          m.isOpenKick = false;
        }

        if (dh0Payload) {
          const dh0Res = m.mountHdf(dh0Payload.bytes, dh0Payload.name, false, 0, true);
          if (dh0Res.ok) {
            dh0ProfileKeyRef.current = targetProfile.modelKey;
            dh0SavedSeqRef.current = m.hardfile.units[0].writeSeq;
            const actualMB = Math.max(
              1,
              Math.min(64, Math.round(dh0Payload.bytes.length / (1024 * 1024)))
            );
            setDh0SizeMB(actualMB);
            if (!dh0Payload.fromCache) {
              void saveBinaryToStorage(
                targetProfile.workbenchStorageKey,
                dh0Payload.name,
                new Uint8Array(dh0Payload.bytes)
              );
            }
          }
        }
        return true;
      } finally {
        if (romSwitchSeqRef.current === switchSeq) {
          romSwitchPendingRef.current = false;
        }
      }
    },
    []
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
      const synced = await syncRomForSavestate(m, data.state);
      if (!synced) return false;
      const ok = m.loadSaveBundle(data.state, data.df0Disk, data.df1Disk);
      if (!ok) {
        showToast('err', `Ошибка загрузки Слота ${slot}`);
        return false;
      }
      saveAmigaConfig(m.config);

      configRef.current = m.config;
      setConfig(m.config);
      setHapticsEnabled(m.config.hapticsEnabled);
      if (canvasRef.current) {
        canvasRef.current.dataset.overscan = String(m.config.overscan);
      }
      const loadedSize = m.getFramebufferSize();
      cropRectRef.current = autoCropRef.current.reset(loadedSize.width, loadedSize.height);
      setCropAspect(
        computeOverscanDisplayAspect(
          cropRectRef.current.w,
          cropRectRef.current.h,
          m.getActiveVideoStandard(),
          m.config.autoCrop
        )
      );
      setStatus(m.getStatusSnapshot());
      if (m.paused) {
        drawScreenshotToMainCanvas(data.screenshotDataUrl);
      }
      showToast('ok', `Загружен Слот ${slot}`);
      return true;
    },
    [drawScreenshotToMainCanvas, showToast, syncRomForSavestate]
  );

  const handleDeleteSlot = useCallback(
    async (slot: SaveSlotIndex) => {
      await deleteSlotData(slot);
      setSaveSlots((prev) => ({ ...prev, [slot]: null }));
      showToast('ok', `Слот ${slot} очищен`);
    },
    [showToast]
  );

  const handleDownloadSlot = useCallback(
    async (slot: SaveSlotIndex) => {
      const data = await loadSlotData(slot);
      if (!data) {
        showToast('err', `Слот ${slot} пуст`);
        return;
      }
      try {
        const payload = buildDiagnosticSavestateFromSlot(slot, data);
        const label = data.df0Disk?.name || data.state.df0Name || 'amiga500';
        const fileName = formatSavestateFilename(label, `slot-${slot}`);
        triggerDownloadJson(fileName, payload, `Слот ${slot}`);
      } catch {
        showToast('err', `Не удалось экспортировать Слот ${slot}.`);
      }
    },
    [showToast, triggerDownloadJson]
  );

  const handleImportSavestateFile = useCallback(
    async (file: File) => {
      const m = machineRef.current;
      if (!m) {
        showToast('err', 'Эмулятор не инициализирован.');
        return;
      }
      if (file.size > 32 * 1024 * 1024) {
        showToast('err', 'Файл сейвстейта слишком большой.');
        return;
      }
      try {
        const text = await file.text();
        const parsed = parseDiagnosticSavestateJson(text);
        if (!parsed.ok) {
          showToast('err', parsed.error);
          return;
        }
        const synced = await syncRomForSavestate(m, parsed.state);
        if (!synced) return;
        const ok = m.loadSaveBundle(parsed.state, parsed.df0Disk, parsed.df1Disk);
        if (!ok) {
          showToast('err', 'Не удалось применить состояние из файла.');
          return;
        }
        saveAmigaConfig(m.config);
        configRef.current = m.config;
        setConfig(m.config);
        setHapticsEnabled(m.config.hapticsEnabled);
        if (canvasRef.current) {
          canvasRef.current.dataset.overscan = String(m.config.overscan);
        }
        const loadedSize = m.getFramebufferSize();
        cropRectRef.current = autoCropRef.current.reset(loadedSize.width, loadedSize.height);
        setCropAspect(
          computeOverscanDisplayAspect(
            cropRectRef.current.w,
            cropRectRef.current.h,
            m.getActiveVideoStandard(),
            m.config.autoCrop
          )
        );
        setStatus(m.getStatusSnapshot());
        if (m.paused && parsed.screenshotDataUrl) {
          drawScreenshotToMainCanvas(parsed.screenshotDataUrl);
        }
        showToast('ok', `Загружен сейвстейт: ${file.name}`);
      } catch (err) {
        console.error('[savestate-import]', err);
        showToast('err', 'Ошибка чтения файла сейвстейта.');
      }
    },
    [drawScreenshotToMainCanvas, showToast, syncRomForSavestate]
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
      xPct: clampPct(50 + ((count % 3) - 1) * 24, 14, 86),
      yPct: clampPct(48 + (Math.floor(count / 3) % 2) * 18, 16, 84),
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

  const handleAddCustomMouseButton = useCallback(
    (button: 'left' | 'right') => {
      const id = `btn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
      const count = activeCustomProfile.buttons.length;
      const defaultX = button === 'left' ? 72 : 86;
      const defaultY = 74 - (count % 3) * 10;
      const newBtn: CustomButtonConfig = {
        id,
        xPct: clampPct(defaultX, 10, 90),
        yPct: clampPct(defaultY, 14, 86),
        size: 'md',
        target: { kind: 'mouse', button },
      };
      commitCustomProfiles((prev) =>
        updateActiveProfile(prev, (prof) => ({
          ...prof,
          buttons: [...prof.buttons, newBtn],
        }))
      );
      setCustomSelection({ kind: 'button', id });
    },
    [activeCustomProfile.buttons.length, commitCustomProfiles]
  );

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
      onAddMouseButton={handleAddCustomMouseButton}
      onAddStick={handleAddCustomStick}
      onDeleteSelected={handleDeleteSelectedCustom}
      onOpenButtonPicker={(buttonId) => setCustomPickerContext({ kind: 'button', buttonId })}
      onOpenStickDirPicker={(dir) => setCustomPickerContext({ kind: 'stick-dir', dir })}
      onChangeSelectedSize={handleChangeSelectedCustomSize}
      onDone={handleToggleCustomEdit}
      fullscreenOverlay={isFullscreen}
    />
  ) : null;

  const handleModelTitleTap = useCallback(() => {
    const res = registerSecretTap(modelTapStateRef.current, performance.now());
    modelTapStateRef.current = res.state;
    if (res.unlockedNow && !debugUnlocked) {
      setDebugUnlocked(true);
      showToast('ok', 'Вкладка «Отладка» доступна в настройках');
    }
  }, [debugUnlocked, showToast]);

  const handleOpenDisks = useCallback(() => {
    setSettingsOpen(false);
    setOverscanAdjustOpen(false);
    setCalibrationOpen(false);
    if (disksOpen || pendingArchive !== null) {
      setDisksOpen(false);
      setPendingArchive(null);
      return;
    }
    if (lastLaunchViewRef.current === 'archive' && lastArchive) {
      setDisksOpen(false);
      setPendingArchive(lastArchive);
    } else {
      lastLaunchViewRef.current = 'drawer';
      setDisksOpen(true);
    }
  }, [disksOpen, lastArchive, pendingArchive]);

  const handleOpenSettings = useCallback(() => {
    setDisksOpen(false);
    setPendingArchive(null);
    setOverscanAdjustOpen(false);
    setCalibrationOpen(false);
    setSettingsOpen((prev) => !prev);
  }, []);

  const handleSaveGamepadCalibration = useCallback(
    (profile: GamepadCalibrationProfile) => {
      setGamepadCalibration(profile);
      gamepadCalibrationRef.current = profile;
      saveGamepadCalibration(profile);
      gamepadTrackerRef.current?.setCalibration(profile);
      showToast('ok', `Калибровка геймпада сохранена (${profile.padId})`);
    },
    [showToast]
  );

  const handleResetGamepadCalibration = useCallback(() => {
    setGamepadCalibration(null);
    gamepadCalibrationRef.current = null;
    clearGamepadCalibration();
    gamepadTrackerRef.current?.setCalibration(null);
    showToast('ok', 'Восстановлена стандартная схема геймпада');
  }, [showToast]);

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
        onOpenSettings={handleOpenSettings}
        activePanel={
          disksOpen || pendingArchive !== null
            ? 'disks'
            : settingsOpen || calibrationOpen
              ? 'settings'
              : null
        }
        onModelTitleTap={handleModelTitleTap}
      />

      {/* Main Responsive Workspace */}
      <main
        className={
          isFullscreen
            ? 'flex-1 min-w-0 h-full flex flex-col relative bg-black'
            : 'flex-1 min-h-0 flex flex-col lg:flex-row max-w-[1440px] w-full mx-auto'
        }
      >
        <div
          className={
            isFullscreen
              ? 'flex-1 min-w-0 min-h-0 flex flex-col relative'
              : 'flex-1 min-w-0 min-h-0 flex flex-col'
          }
        >
        {/* Fullscreen Custom Editor floats above the screen so it never pushes or resizes the image */}
        {isFullscreen && customEditToolbarNode && (
          <div className="absolute top-0 inset-x-0 z-30 pointer-events-auto">
            {customEditToolbarNode}
          </div>
        )}

        {/* SCREEN (full-width centered CRT on desktop & mobile; shrinks horizontally when desktop side panel is open) */}
        <section
          style={{ ['--screen-aspect' as string]: String(cropAspect) }}
          className={
            isFullscreen
              ? 'relative w-full flex-1 min-h-0 bg-black overflow-hidden'
              : 'shrink-0 w-full aspect-[var(--screen-aspect)] max-h-[52dvh] lg:aspect-auto lg:flex-1 lg:min-h-0 lg:max-h-none bg-[#0D0E11] border-b lg:border-b-0 border-white/10'
          }
        >
          <div className="min-w-0 min-h-0 w-full h-full">
            <AmigaScreen
              canvasRef={canvasRef}
              scanlines={config.crtScanlines}
              paused={status.paused}
              pointerLockAllowed={!status.paused && !overscanAdjustOpen && !calibrationOpen && !(isFullscreen && anyModalOpen)}
              emuPerf={config.showEmuPerf ? emuPerf : null}
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

        </section>

        {/* Fullscreen Non-blocking Overscan Adjust Dock */}
        {isFullscreen && overscanAdjustOpen && (
          <div className="absolute bottom-2.5 left-1/2 -translate-x-1/2 z-30 w-[min(94vw,540px)]">
            <OverscanAdjustPanel
              fullscreen
              config={config}
              activeVideoStandard={status.videoStandard}
              onUpdateConfig={handleUpdateConfig}
              onDone={() => setOverscanAdjustOpen(false)}
            />
          </div>
        )}

        {/* Non-fullscreen Overscan Adjust Panel docked cleanly below the screen on mobile/tablet */}
        {!isFullscreen && overscanAdjustOpen && (
          <div className="flex-1 min-h-0 w-full shrink-0 lg:hidden">
            <OverscanAdjustPanel
              config={config}
              activeVideoStandard={status.videoStandard}
              onUpdateConfig={handleUpdateConfig}
              onDone={() => setOverscanAdjustOpen(false)}
            />
          </div>
        )}

        {/* MOBILE INPUT MODE SWITCHER & CONTROL DECK (hidden on desktop, in fullscreen, and while adjusting overscan) */}
        {!isFullscreen && !overscanAdjustOpen && (
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
        </div>

        {/* DESKTOP DOCKED RIGHT PANEL (opens on demand beside the screen, never covering it; on < lg uses modal bottom-sheet) */}
        {!isFullscreen && (
          <>
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
              onDownloadSlot={handleDownloadSlot}
              onDownloadLiveSavestate={handleDownloadLiveSavestate}
              onImportSavestateFile={handleImportSavestateFile}
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
              debugUnlocked={debugUnlocked}
              config={config}
              activeVideoStandard={status.videoStandard}
              gamepadCalibration={gamepadCalibration}
              onClose={() => setSettingsOpen(false)}
              onUpdateConfig={handleUpdateConfig}
              onOpenOverscanAdjust={() => {
                setSettingsOpen(false);
                setOverscanAdjustOpen(true);
              }}
              onOpenGamepadCalibration={() => {
                setSettingsOpen(false);
                setCalibrationOpen(true);
              }}
              onResetGamepadCalibration={handleResetGamepadCalibration}
              onDownloadTriageReport={handleDownloadTriageReport}
              onCopyTriageReport={handleCopyTriageReport}
              onDownloadDebugDump={handleDownloadDebugDump}
              onDownloadLiveSavestate={handleDownloadLiveSavestate}
            />

            <GamepadCalibrationModal
              open={calibrationOpen}
              existingCalibration={gamepadCalibration}
              onSave={handleSaveGamepadCalibration}
              onResetToDefault={handleResetGamepadCalibration}
              onClose={() => setCalibrationOpen(false)}
            />
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

      {/* Fullscreen Overlay Modals */}
      {isFullscreen && (
        <>
          <DiskRomDrawer
            open={disksOpen}
            overlayOnly
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
            onDownloadSlot={handleDownloadSlot}
            onDownloadLiveSavestate={handleDownloadLiveSavestate}
            onImportSavestateFile={handleImportSavestateFile}
            launchingCatalogId={launchingCatalogId}
            onLaunchCatalogItem={handleLaunchCatalogItem}
          />

          <ArchiveModal
            pendingArchive={pendingArchive}
            overlayOnly
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
            overlayOnly
            debugUnlocked={debugUnlocked}
            config={config}
            activeVideoStandard={status.videoStandard}
            gamepadCalibration={gamepadCalibration}
            onClose={() => setSettingsOpen(false)}
            onUpdateConfig={handleUpdateConfig}
            onOpenOverscanAdjust={() => {
              setSettingsOpen(false);
              setOverscanAdjustOpen(true);
            }}
            onOpenGamepadCalibration={() => {
              setSettingsOpen(false);
              setCalibrationOpen(true);
            }}
            onResetGamepadCalibration={handleResetGamepadCalibration}
            onDownloadTriageReport={handleDownloadTriageReport}
            onCopyTriageReport={handleCopyTriageReport}
            onDownloadDebugDump={handleDownloadDebugDump}
            onDownloadLiveSavestate={handleDownloadLiveSavestate}
          />

          <GamepadCalibrationModal
            open={calibrationOpen}
            overlayOnly
            existingCalibration={gamepadCalibration}
            onSave={handleSaveGamepadCalibration}
            onResetToDefault={handleResetGamepadCalibration}
            onClose={() => setCalibrationOpen(false)}
          />
        </>
      )}

      <BlankDiskModal
        drive={blankDiskDrive}
        onConfirm={handleConfirmBlankAdf}
        onClose={() => setBlankDiskDrive(null)}
      />

      <ToastContainer
        toasts={toasts}
        belowTopBar={!isFullscreen || showCustomEditorToolbar}
        onDismiss={dismissToast}
      />
    </div>
  );
}

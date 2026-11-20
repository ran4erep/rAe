export type ChipsetModel = 'OCS' | 'ECS';
export type VideoStandard = 'PAL' | 'NTSC';
export type ChipRamKB = 512 | 1024 | 2048;
export type SlowRamKB = 0 | 512;
export type FrameSkipMode = 0 | 1 | 2;
export type OverscanMode = 'auto' | 'none' | 'tv' | 'max';

export interface AmigaConfig {
  chipset: ChipsetModel;
  videoStandard: VideoStandard;
  chipRamKB: ChipRamKB;
  slowRamKB: SlowRamKB;
  fastRamKB: 0 | 1024 | 2048;
  audioEnabled: boolean;
  audioVolume: number;
  audioLedFilter: boolean;
  crtScanlines: boolean;
  overscan: OverscanMode;
  autoCrop: boolean;
  frameSkip: FrameSkipMode;
  ecoCpuMode: boolean;
  hapticsEnabled: boolean;
  floppyAudioEnabled: boolean;
  turboFloppy: boolean;
  joystickConnected: boolean;
}

export interface FloppyDriveStatus {
  inserted: boolean;
  name: string;
  track: number;
  side: number;
  motorOn: boolean;
  activeIo: boolean;
  stepPhase: boolean;
  writeProtected: boolean;
}

export interface HardfileStatus {
  mounted: boolean;
  name: string;
  sizeBytes: number;
  usedBytes: number;
  freeBytes: number;
  minSizeMB: number;
  canResize: boolean;
  dosType: string;
  volumeName: string;
  partitionCount: number;
  activeIo: boolean;
  writeProtected: boolean;
}

export interface AmigaStatusSnapshot {
  running: boolean;
  paused: boolean;
  fps: number;
  cpuUsageHint: number; // Estimated frame budget %
  chipset: ChipsetModel;
  videoStandard: VideoStandard;
  romName: string;
  isOpenKick: boolean;
  powerLed: boolean;
  capsLock: boolean;
  df0: FloppyDriveStatus;
  df1: FloppyDriveStatus;
  dh0: HardfileStatus;
  dh1: HardfileStatus;
  pc: number;
  frameCount: number;
  lastKeyCode: number | null;
}

export interface DiskCatalogItem {
  id: string;
  title: string;
  subtitle: string;
  chipset: 'OCS' | 'OCS/ECS';
  controlsHint: string;
  sizeBytes: number;
}

export interface JoystickState {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  fire1: boolean;
  fire2: boolean;
}

export interface MouseState {
  dx: number;
  dy: number;
  left: boolean;
  right: boolean;
  middle: boolean;
}

export type SaveSlotIndex = 1 | 2 | 3 | 4 | 5;
export const SAVE_SLOT_INDICES: readonly SaveSlotIndex[] = [1, 2, 3, 4, 5];

export interface SerializedFloppyDriveState {
  inserted: boolean;
  name: string;
  cylinder: number;
  side: number;
  motorOn: boolean;
  selected: boolean;
  writeProtected: boolean;
  diskChanged: boolean;
  trackBytePos: number;
}

export interface SerializedAmigaState {
  version: number;
  timestamp: number;
  config: AmigaConfig;
  romName: string;
  df0Name: string;
  df1Name: string;
  df0State?: SerializedFloppyDriveState;
  df1State?: SerializedFloppyDriveState;
  cpuRegs: number[];
  usp: number;
  ssp: number;
  pc: number;
  sr: number;
  stopped: boolean;
  chipRamBase64: string;
  slowRamBase64: string;
  customRegs: number[];
  ciaA: number[];
  ciaB: number[];
}

export interface SaveSlotDiskPayload {
  name: string;
  bytes: Uint8Array;
}

export interface SaveSlotSummary {
  slot: SaveSlotIndex;
  timestamp: number;
  df0Name: string;
  df1Name: string;
  screenshotDataUrl: string | null;
}

export interface SaveSlotData {
  slot: SaveSlotIndex;
  timestamp: number;
  state: SerializedAmigaState;
  df0Disk: SaveSlotDiskPayload | null;
  df1Disk: SaveSlotDiskPayload | null;
  screenshotDataUrl: string | null;
}

export const DEFAULT_AMIGA_CONFIG: AmigaConfig = {
  chipset: 'ECS',
  videoStandard: 'PAL',
  chipRamKB: 1024,
  slowRamKB: 512,
  fastRamKB: 0,
  audioEnabled: true,
  audioVolume: 1.0,
  audioLedFilter: true,
  crtScanlines: false,
  overscan: 'auto',
  autoCrop: false,
  frameSkip: 0,
  ecoCpuMode: false,
  hapticsEnabled: true,
  floppyAudioEnabled: true,
  turboFloppy: false,
  joystickConnected: true,
};

// PAL 50Hz / NTSC 60Hz native timings
export const PAL_LINES = 312;
export const NTSC_LINES = 262;
export const PAL_FPS = 50;
export const NTSC_FPS = 60;

// Native lo-res framebuffer dimensions (320x256 PAL visible window)
export const SCREEN_WIDTH = 320;
export const SCREEN_HEIGHT = 256;

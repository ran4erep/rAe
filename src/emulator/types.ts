export type ChipsetModel = 'OCS' | 'ECS' | 'AGA';
export type ResolvedVideoStandard = 'PAL' | 'NTSC';
export type VideoStandard = 'auto' | ResolvedVideoStandard;
export type ChipRamKB = 512 | 1024 | 2048;
export type SlowRamKB = 0 | 512;
export type FastRamKB = 0 | 1024 | 2048 | 4096 | 8192;
export type FrameSkipMode = 0 | 1 | 2;
export type CpuOverclockMultiplier = number;
export type OverscanCustomMode = `${number}x${number}`;
export type OverscanMode = OverscanCustomMode | number | 'auto' | 'none' | 'tv' | 'max';

export interface AmigaConfig {
  chipset: ChipsetModel;
  videoStandard: VideoStandard;
  chipRamKB: ChipRamKB;
  slowRamKB: SlowRamKB;
  fastRamKB: FastRamKB;
  audioEnabled: boolean;
  audioVolume: number;
  audioLedFilter: boolean;
  crtScanlines: boolean;
  overscan: OverscanMode;
  autoCrop: boolean;
  frameSkip: FrameSkipMode;
  ecoCpuMode: boolean;
  cpuOverclock: CpuOverclockMultiplier;
  hapticsEnabled: boolean;
  floppyAudioEnabled: boolean;
  turboFloppy: boolean;
  joystickConnected: boolean;
  showEmuPerf: boolean;
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
  videoStandard: ResolvedVideoStandard;
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
  isOpenKick?: boolean;
  activeVideoStandard?: ResolvedVideoStandard;
  frameCount?: number;
  ovl?: boolean;
  eClockAccum?: number;
  cpuRegs: number[];
  usp: number;
  ssp: number;
  pc: number;
  sr: number;
  stopped: boolean;
  chipRamBase64: string;
  slowRamBase64: string;
  fastRamBase64?: string;
  customRegs: number[];
  bplPt?: number[];
  sprPt?: number[];
  beamCon0?: number;
  copPc?: number;
  copWaiting?: boolean;
  copWaitV?: number;
  copWaitH?: number;
  copMaskV?: number;
  copMaskH?: number;
  vbr?: number;
  cacr?: number;
  bplCon3?: number;
  bplCon4?: number;
  fmode?: number;
  agaColors24?: number[];
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
  chipset: 'AGA',
  videoStandard: 'auto',
  chipRamKB: 2048,
  slowRamKB: 0,
  fastRamKB: 8192,
  audioEnabled: true,
  audioVolume: 1.0,
  audioLedFilter: true,
  crtScanlines: false,
  overscan: 'none',
  autoCrop: false,
  frameSkip: 0,
  ecoCpuMode: false,
  cpuOverclock: 1,
  hapticsEnabled: true,
  floppyAudioEnabled: true,
  turboFloppy: false,
  joystickConnected: true,
  showEmuPerf: false,
};

// PAL 50Hz / NTSC 60Hz native timings
export const PAL_LINES = 312;
export const NTSC_LINES = 262;
export const PAL_FPS = 50;
export const NTSC_FPS = 60;

// Native lo-res framebuffer dimensions (320x256 PAL visible window)
export const SCREEN_WIDTH = 320;
export const SCREEN_HEIGHT = 256;

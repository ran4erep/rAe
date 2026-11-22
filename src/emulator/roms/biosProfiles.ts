import { ChipsetModel } from '../types';
import { getAppAssetUrl } from '../../utils/assetUrl';

export const A500_BIOS_ROM_NAME = 'Kickstart v1.3 r34.005 (1987-12)(Commodore)(A3000)[!].rom';
export const A1200_BIOS_ROM_NAME = 'Kickstart v3.1 rev 40.68 (1993)(Commodore)(A1200)[!].rom';

export type AmigaModelKey = 'a500' | 'a1200';

export interface ModelRomProfile {
  modelKey: AmigaModelKey;
  romName: string;
  romUrl: string;
  shortLabel: string;
  biosButtonLabel: string;
  biosButtonAriaLabel: string;
  customStorageKey: string;
}

const A500_PROFILE: ModelRomProfile = {
  modelKey: 'a500',
  romName: A500_BIOS_ROM_NAME,
  romUrl: getAppAssetUrl(`bios/${encodeURIComponent(A500_BIOS_ROM_NAME)}`),
  shortLabel: 'Kickstart 1.3',
  biosButtonLabel: 'BIOS 1.3',
  biosButtonAriaLabel: 'Загрузить Kickstart 1.3 из BIOS',
  customStorageKey: 'custom_kickstart_rom_a500',
};

const A1200_PROFILE: ModelRomProfile = {
  modelKey: 'a1200',
  romName: A1200_BIOS_ROM_NAME,
  romUrl: getAppAssetUrl(`bios/${encodeURIComponent(A1200_BIOS_ROM_NAME)}`),
  shortLabel: 'Kickstart 3.1',
  biosButtonLabel: 'BIOS 3.1',
  biosButtonAriaLabel: 'Загрузить Kickstart 3.1 из BIOS',
  customStorageKey: 'custom_kickstart_rom_a1200',
};

export function getModelKeyForChipset(chipset: ChipsetModel): AmigaModelKey {
  return chipset === 'AGA' ? 'a1200' : 'a500';
}

export function getModelRomProfile(chipset: ChipsetModel): ModelRomProfile {
  return chipset === 'AGA' ? A1200_PROFILE : A500_PROFILE;
}

export function isModelRomSwitchNeeded(prevChipset: ChipsetModel, nextChipset: ChipsetModel): boolean {
  return getModelKeyForChipset(prevChipset) !== getModelKeyForChipset(nextChipset);
}

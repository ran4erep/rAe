import test from 'node:test';
import assert from 'node:assert/strict';
import {
  A1200_BIOS_ROM_NAME,
  A500_BIOS_ROM_NAME,
  getModelKeyForChipset,
  getModelRomProfile,
  isModelRomSwitchNeeded,
} from './biosProfiles';

test('getModelRomProfile maps OCS/ECS to Kickstart 1.3 and AGA to Kickstart 3.1', () => {
  const ocs = getModelRomProfile('OCS');
  const ecs = getModelRomProfile('ECS');
  const aga = getModelRomProfile('AGA');

  assert.equal(getModelKeyForChipset('OCS'), 'a500');
  assert.equal(getModelKeyForChipset('ECS'), 'a500');
  assert.equal(getModelKeyForChipset('AGA'), 'a1200');

  assert.equal(ocs.romName, A500_BIOS_ROM_NAME);
  assert.equal(ecs.romName, A500_BIOS_ROM_NAME);
  assert.equal(ocs.customStorageKey, 'custom_kickstart_rom_a500');
  assert.equal(ecs.biosButtonLabel, 'BIOS 1.3');
  assert.equal(ocs.shortLabel, 'Kickstart 1.3');

  assert.equal(aga.romName, A1200_BIOS_ROM_NAME);
  assert.equal(aga.customStorageKey, 'custom_kickstart_rom_a1200');
  assert.equal(aga.biosButtonLabel, 'BIOS 3.1');
  assert.equal(aga.shortLabel, 'Kickstart 3.1');
  assert.ok(aga.romUrl.includes(encodeURIComponent(A1200_BIOS_ROM_NAME)));
});

test('isModelRomSwitchNeeded triggers only when crossing A500 <-> A1200 boundary', () => {
  assert.equal(isModelRomSwitchNeeded('OCS', 'ECS'), false);
  assert.equal(isModelRomSwitchNeeded('ECS', 'OCS'), false);
  assert.equal(isModelRomSwitchNeeded('AGA', 'AGA'), false);
  assert.equal(isModelRomSwitchNeeded('ECS', 'AGA'), true);
  assert.equal(isModelRomSwitchNeeded('OCS', 'AGA'), true);
  assert.equal(isModelRomSwitchNeeded('AGA', 'ECS'), true);
  assert.equal(isModelRomSwitchNeeded('AGA', 'OCS'), true);
});

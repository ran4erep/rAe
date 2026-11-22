import test from 'node:test';
import assert from 'node:assert/strict';
import { AmigaMachine } from '../hardware/amigaMachine';
import { ADF_TOTAL_SIZE, writeAmigaBootblockChecksum } from '../hardware/floppy';
import { SaveSlotData } from '../types';
import {
  buildDiagnosticSavestateFromMachine,
  buildDiagnosticSavestateFromSlot,
  formatSavestateFilename,
  parseDiagnosticSavestateJson,
} from './savestateFile';

test('buildDiagnosticSavestateFromMachine exports readable diagnostics and full replayable bundle without mutating CIA', () => {
  const amiga = new AmigaMachine(
    {
      chipset: 'ECS',
      videoStandard: 'PAL',
      chipRamKB: 512,
      slowRamKB: 512,
      fastRamKB: 1024,
      audioEnabled: false,
    },
    { skipDefaultDisk: true }
  );

  const disk0 = new Uint8Array(ADF_TOTAL_SIZE);
  disk0[0] = 0x44; // 'D'
  disk0[1] = 0x4f; // 'O'
  disk0[2] = 0x53; // 'S'
  disk0[3] = 0x00;
  disk0[512] = 0xab;
  writeAmigaBootblockChecksum(disk0);
  amiga.insertAdf(0, disk0, 'ProblemGame.adf', false);

  for (let i = 0; i < 3; i++) {
    amiga.stepFrame(true);
  }

  amiga.floppy.drives[0].cylinder = 17;
  amiga.floppy.drives[0].side = 1;

  // Write Copper list and signature patterns into Chip/Slow/Fast RAM
  amiga.memory.ovl = false;
  amiga.memory.write16(0x014000, 0x0180);
  amiga.memory.write16(0x014002, 0x048c);
  amiga.memory.write16(0x014004, 0xffff);
  amiga.memory.write16(0x014006, 0xfffe);
  amiga.chipset.writeReg16(0x080, 0x0001);
  amiga.chipset.writeReg16(0x082, 0x4000);
  amiga.chipset.bplPt[0] = 0x012340;
  amiga.memory.write32(0x010500, 0xcafebabe);
  amiga.memory.write32(0xc00100, 0xdeadbeef);
  amiga.memory.write32(0x200200, 0x13579bdf);

  // Trigger a fault to verify recentFaults capture
  amiga.memory.write16(0x010000, 0xf234);
  amiga.cpu.stopped = false;
  amiga.cpu.pendingIpl = 0;
  amiga.cpu.pc = 0x010000;
  amiga.cpu.step();

  // Preserve CIA-A ICR state to verify export is side-effect-free
  amiga.cia.icrDataA = 0x05;

  const exported = buildDiagnosticSavestateFromMachine(amiga, 'data:image/jpeg;base64,AAAA');
  assert.equal(amiga.cia.icrDataA, 0x05);

  assert.equal(exported.format, 'amiga500-savestate-v1');
  assert.equal(exported.source, 'live');
  assert.equal(exported.machine.frameCount, 3);
  assert.equal(exported.machine.ovl, false);
  assert.ok(exported.cpu.recentFaults.length >= 1);
  assert.ok(exported.chipset.copper.cop1Decoded.some((l) => l.includes('COLOR00') && l.includes('0x048C')));
  assert.equal(exported.storage.df0.inserted, true);
  assert.equal(exported.storage.df0.bootblockValid, true);
  assert.equal(exported.storage.df0.cylinder, 17);
  assert.equal(exported.storage.df0.side, 1);

  // Verify JSON places diagnostics before large base64 savestate payload
  const jsonText = JSON.stringify(exported, null, 2);
  assert.ok(jsonText.indexOf('"diagnostics"') < jsonText.indexOf('"savestate"'));
  assert.ok(jsonText.indexOf('"copper"') < jsonText.indexOf('"chipRamBase64"'));

  // Parse and restore into a brand new AmigaMachine
  const parsed = parseDiagnosticSavestateJson(jsonText);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const restored = new AmigaMachine({ audioEnabled: false }, { skipDefaultDisk: true });
  const ok = restored.loadSaveBundle(parsed.state, parsed.df0Disk, parsed.df1Disk);
  assert.equal(ok, true);
  assert.equal(restored.memory.ovl, false);
  assert.equal(restored.frameCount, 3);
  assert.equal(restored.memory.read32(0x010500) >>> 0, 0xcafebabe);
  assert.equal(restored.memory.read32(0xc00100) >>> 0, 0xdeadbeef);
  assert.equal(restored.memory.read32(0x200200) >>> 0, 0x13579bdf);
  assert.equal(restored.chipset.bplPt[0], 0x012340);
  assert.equal(restored.floppy.drives[0].name, 'ProblemGame.adf');
  assert.equal(restored.floppy.drives[0].cylinder, 17);
  assert.equal(restored.floppy.drives[0].side, 1);
  assert.equal(restored.floppy.drives[0].data?.[512], 0xab);
});

test('buildDiagnosticSavestateFromSlot decodes saved IndexedDB slot into readable diagnostics and round-trips', () => {
  const amiga = new AmigaMachine(
    {
      chipset: 'OCS',
      videoStandard: 'PAL',
      chipRamKB: 512,
      slowRamKB: 0,
      audioEnabled: false,
    },
    { skipDefaultDisk: true }
  );
  amiga.memory.ovl = false;
  amiga.memory.write16(0x010200, 0x4e71); // NOP
  amiga.cpu.pc = 0x010200;
  amiga.memory.write16(0x015000, 0x0182);
  amiga.memory.write16(0x015002, 0x0fff);
  amiga.memory.write16(0x015004, 0xffff);
  amiga.memory.write16(0x015006, 0xfffe);
  amiga.chipset.writeReg16(0x080, 0x0001);
  amiga.chipset.writeReg16(0x082, 0x5000);

  const bundle = amiga.exportSaveBundle();
  const slotData: SaveSlotData = {
    slot: 2,
    timestamp: bundle.state.timestamp,
    state: bundle.state,
    df0Disk: bundle.df0Disk,
    df1Disk: bundle.df1Disk,
    screenshotDataUrl: null,
  };

  const exported = buildDiagnosticSavestateFromSlot(2, slotData);
  assert.equal(exported.source, 'slot-2');
  assert.equal(exported.diagnostics.pc, '0x010200');
  assert.equal(exported.diagnostics.pcRegion, 'chip_ram');
  assert.ok(exported.cpu.codeAroundPc.wordsHex.includes('0x4E71'));
  assert.ok(exported.chipset.copper.cop1Decoded.some((l) => l.includes('COLOR01') && l.includes('0x0FFF')));

  const parsed = parseDiagnosticSavestateJson(JSON.stringify(exported));
  assert.equal(parsed.ok, true);
});

test('parseDiagnosticSavestateJson rejects invalid JSON and malformed savestates cleanly', () => {
  const badJson = parseDiagnosticSavestateJson('{not valid json');
  assert.equal(badJson.ok, false);

  const wrongFormat = parseDiagnosticSavestateJson(JSON.stringify({ hello: 'world' }));
  assert.equal(wrongFormat.ok, false);

  const badInner = parseDiagnosticSavestateJson(
    JSON.stringify({ format: 'amiga500-savestate-v1', savestate: { state: { version: 99 } } })
  );
  assert.equal(badInner.ok, false);
});

test('formatSavestateFilename creates clean sanitized filename with source and timestamp', () => {
  const name = formatSavestateFilename(
    'Turrican II (Disk 1).adf',
    'slot-3',
    new Date(2026, 10, 21, 12, 45, 9)
  );
  assert.equal(name, 'savestate-Turrican_II_Disk_1-slot-3-20261121-124509.json');
});

test('AGA savestate round-trip preserves 68EC020 VBR/CACR, 8 bitplanes, FMODE/BPLCON3/4, and 256 24-bit colors', () => {
  const amiga = new AmigaMachine(
    {
      chipset: 'AGA',
      videoStandard: 'PAL',
      chipRamKB: 2048,
      slowRamKB: 0,
      fastRamKB: 4096,
      audioEnabled: false,
    },
    { skipDefaultDisk: true }
  );
  amiga.memory.ovl = false;
  amiga.cpu.vbr = 0x00040000;
  amiga.cpu.cacr = 0x00000003;
  amiga.chipset.writeReg16(0x106, 0x8000); // Bank 4 (128..159), LOCT=0
  amiga.chipset.writeReg16(0x184, 0x0abc); // Color 130 upper
  amiga.chipset.writeReg16(0x106, 0x8200); // Bank 4, LOCT=1
  amiga.chipset.writeReg16(0x184, 0x0123); // Color 130 lower -> $A1B2C3
  amiga.chipset.writeReg16(0x10c, 0x4235); // BPLCON4
  amiga.chipset.writeReg16(0x1fc, 0x000f); // FMODE
  amiga.chipset.bplPt[6] = 0x054320;
  amiga.chipset.bplPt[7] = 0x065430;

  const exported = buildDiagnosticSavestateFromMachine(amiga, null);
  assert.equal(exported.chipset.display.bplPtHex.length, 8);
  assert.equal(exported.chipset.display.bplPtHex[7], '0x065430');
  assert.equal(exported.chipset.display.paletteHex.length, 256);
  assert.equal(exported.chipset.display.paletteHex[130], '0xA1B2C3');

  const slotData: SaveSlotData = {
    slot: 1,
    timestamp: exported.savestate.state.timestamp,
    state: exported.savestate.state,
    df0Disk: null,
    df1Disk: null,
    screenshotDataUrl: null,
  };
  const fromSlot = buildDiagnosticSavestateFromSlot(1, slotData);
  assert.equal(fromSlot.chipset.display.bplPtHex.length, 8);
  assert.equal(fromSlot.chipset.display.paletteHex.length, 256);
  assert.equal(fromSlot.chipset.display.paletteHex[130], '0xA1B2C3');

  const parsed = parseDiagnosticSavestateJson(JSON.stringify(exported));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const restored = new AmigaMachine({ audioEnabled: false }, { skipDefaultDisk: true });
  assert.equal(restored.loadSaveBundle(parsed.state, null, null), true);
  assert.equal(restored.cpu.is68020, true);
  assert.equal(restored.cpu.vbr, 0x00040000);
  assert.equal(restored.cpu.cacr, 0x00000003);
  assert.equal(restored.chipset.bplCon4, 0x4235);
  assert.equal(restored.chipset.fmode, 0x000f);
  assert.equal(restored.chipset.bplPt[6], 0x054320);
  assert.equal(restored.chipset.bplPt[7], 0x065430);
  assert.equal(restored.chipset.colorReg24[130], 0xa1b2c3);
});


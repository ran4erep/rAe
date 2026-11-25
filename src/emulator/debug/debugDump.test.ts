import test from 'node:test';
import assert from 'node:assert/strict';
import { AmigaMachine } from '../hardware/amigaMachine';
import { buildAmigaDebugDump, formatDebugDumpFilename } from './debugDump';

test('buildAmigaDebugDump captures CPU, faults, frame PC history, Copper list, and full RAM without side effects', () => {
  const amiga = new AmigaMachine({
    chipset: 'ECS',
    videoStandard: 'PAL',
    chipRamKB: 512,
    slowRamKB: 512,
    audioEnabled: false,
  });

  for (let i = 0; i < 4; i++) {
    amiga.stepFrame(true);
  }

  // Trigger an unimplemented Line-F exception to verify fault ring buffer capture
  amiga.memory.write16(0x010000, 0xf123);
  amiga.cpu.stopped = false;
  amiga.cpu.pendingIpl = 0;
  amiga.cpu.pc = 0x010000;
  amiga.cpu.step();

  // Preserve CIA ICR state to verify peek reads do NOT mutate hardware registers
  amiga.cia.icrDataA = 0x05;

  const dump = buildAmigaDebugDump(amiga);

  assert.equal(dump.format, 'amiga500-debug-dump-v1');
  assert.equal(dump.machine.frameCount, 4);
  assert.equal(dump.machine.ovl, false);
  assert.equal(dump.cpu.d.length, 8);
  assert.equal(dump.cpu.a.length, 8);
  assert.equal(dump.cpu.recentFramePcs.length, 4);
  assert.equal(dump.cpu.codeAroundPc.wordsHex.length, 128);
  assert.equal(dump.cpu.stack.activeLongsHex.length, 32);
  assert.equal(dump.cpu.exceptionVectors.length, 48);

  // Verify fault ring buffer caught the Line-F ($F123) at $010000
  assert.ok(dump.cpu.recentFaults.length >= 1);
  const lastFault = dump.cpu.recentFaults[dump.cpu.recentFaults.length - 1];
  assert.equal(lastFault.vector, 11);
  assert.equal(lastFault.pc, '0x00010000');
  assert.equal(lastFault.opcode, '0xF123');

  // Verify Copper list decoded cleanly and screen summary detected OpenKick Boing pixels
  assert.ok(dump.chipset.copper.cop1Decoded.length > 0);
  assert.ok(dump.diagnostics.screenSummary.nonBlackPixels > 0);

  // Verify side-effect-free peek did not clear CIA-A ICR
  assert.equal(amiga.cia.icrDataA, 0x05);

  // Verify base64 Chip RAM & Slow RAM lengths match configured memory
  const chipDecoded = Buffer.from(dump.memory.chipRamBase64, 'base64');
  const slowDecoded = Buffer.from(dump.memory.slowRamBase64, 'base64');
  assert.equal(chipDecoded.length, 512 * 1024);
  assert.equal(slowDecoded.length, 512 * 1024);
  assert.equal((chipDecoded[0x010000] << 8) | chipDecoded[0x010001], 0xf123);
});

test('formatDebugDumpFilename builds sanitized .json filename from active media', () => {
  const amiga = new AmigaMachine({ audioEnabled: false }, { skipDefaultDisk: true });
  amiga.floppy.drives[0].insert(new Uint8Array(901120), 'Alien Breed (Disk 1).adf', false);

  const name = formatDebugDumpFilename(amiga, new Date(2026, 4, 9, 8, 5, 3));
  assert.equal(name, 'debug-Alien_Breed_Disk_1-20260509-080503.json');
});

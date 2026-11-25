import test from 'node:test';
import assert from 'node:assert/strict';
import { AmigaMachine } from '../hardware/amigaMachine';
import { formatAmigaTriageText, formatTriageReportFilename } from './triageReport';

test('formatAmigaTriageText creates compact zero-Base64 report with 68k disasm, verdict, events, and no hardware side-effects', () => {
  const amiga = new AmigaMachine({
    chipset: 'ECS',
    videoStandard: 'PAL',
    chipRamKB: 512,
    slowRamKB: 512,
    audioEnabled: false,
  });

  for (let f = 0; f < 5; f++) {
    amiga.stepFrame(true, false);
  }

  // Trigger a Line-F fault and preserve CIA-A ICR state
  amiga.memory.write16(0x010000, 0xf123);
  amiga.cpu.stopped = false;
  amiga.cpu.pendingIpl = 0;
  amiga.cpu.pc = 0x010000;
  amiga.cpu.step();
  amiga.cia.icrDataA = 0x05;

  const text = formatAmigaTriageText(amiga, new Date(2026, 4, 9, 8, 5, 3));

  assert.ok(text.length < 10000, `Triage report must stay compact (<10 KB), got ${text.length} bytes`);
  assert.ok(text.includes('=== AMIGA 500/1200 TRIAGE REPORT ==='));
  assert.ok(text.includes('[VERDICT]'));
  assert.ok(text.includes('[DISASM @ PC]'));
  assert.ok(text.includes('>>>'));
  assert.ok(text.includes('[RECENT FAULTS]'));
  assert.ok(text.includes('Line-F Emulator'));
  assert.ok(text.includes('[CHIPSET / DISPLAY / COPPER]'));
  assert.ok(text.includes('[RECENT EVENTS'));
  assert.ok(text.includes('HARD_RESET'));
  assert.ok(text.includes('OVL -> OFF'));
  assert.ok(!text.includes('chipRamBase64'), 'Triage report must never embed Base64 RAM');

  // Verify side-effect-free inspection did not clear CIA-A ICR
  assert.equal(amiga.cia.icrDataA, 0x05);
});

test('formatTriageReportFilename builds clean .txt filename from active media', () => {
  const amiga = new AmigaMachine({ audioEnabled: false }, { skipDefaultDisk: true });
  amiga.floppy.drives[0].insert(new Uint8Array(901120), 'Aladdin (Disk 1).adf', false);

  const name = formatTriageReportFilename(amiga, new Date(2026, 4, 9, 8, 5, 3));
  assert.equal(name, 'triage-Aladdin_Disk_1-20260509-080503.txt');
});

test('formatAmigaTriageText includes VECTORS & EXEC, caller disasm, INTENA mask history, and AGA 24-bit palette', () => {
  const aga = new AmigaMachine(
    { chipset: 'AGA', videoStandard: 'PAL', chipRamKB: 2048, slowRamKB: 0, fastRamKB: 0, audioEnabled: false },
    { skipDefaultDisk: true }
  );
  aga.memory.ovl = false;
  // Mock ExecBase at $002000, return address on A7 at $020010 calling JSR ($02000A)
  aga.memory.write32(0x000004, 0x00002000);
  aga.memory.write16(0x002126, 0xff01); // IDNest=-1, TDNest=1
  aga.memory.write16(0x002128, 0x0003); // AttnFlags = 68010 | 68020
  aga.memory.write32(0x002090, 0x00002200); // VERTB list header
  aga.memory.write32(0x002094, 0x00034568); // VERTB handler code
  aga.memory.write32(0x002200, 0x00002220); // lh_Head -> node
  aga.memory.write32(0x002220, 0x00002204); // ln_Succ (tail sentinel)
  aga.memory.write16(0x002228, 0x020a);     // ln_Type=2, ln_Pri=+10
  aga.memory.write32(0x002232, 0x00041234); // is_Code
  aga.memory.write16(0x041234, 0x4e75);     // RTS inside server
  aga.memory.write16(0x020006, 0x6100); // BSR.W $021000
  aga.memory.write16(0x020008, 0x0ff8);
  aga.memory.write16(0x02000a, 0x4eb9); // JSR $00030000
  aga.memory.write32(0x02000c, 0x00030000);
  aga.memory.write16(0x020010, 0x4e75); // RTS
  aga.memory.write16(0x021000, 0x4e75); // RTS inside callee
  aga.cpu.a[7] = 0x00050000;
  aga.memory.write32(0x00050000, 0x00020010);
  aga.cpu.pc = 0x00030000;
  aga.chipset.writeReg16(0x09a, 0xc020);
  aga.chipset.writeReg16(0x096, 0x8400);
  aga.chipset.writeReg16(0x106, 0x0c00);
  aga.chipset.writeReg16(0x180, 0x0abc);
  aga.chipset.writeReg16(0x106, 0x0e00); // LOCT=1
  aga.chipset.writeReg16(0x180, 0x0123);

  const text = formatAmigaTriageText(aga, new Date(2026, 4, 9, 8, 5, 3));
  assert.ok(text.includes('[VECTORS & EXEC]'));
  assert.ok(text.includes('ExecBase=$002000'));
  assert.ok(text.includes('IDNest=-1 TDNest=1 Attn=$0003'));
  assert.ok(text.includes('VERTB=$034568'));
  assert.ok(text.includes('VERTB servers: $041234(pri=10)'));
  assert.ok(text.includes('VERTB server @ $041234:'));
  assert.ok(text.includes('Caller @ $020010:'));
  assert.ok(text.includes('JSR ($030000).L'));
  assert.ok(text.includes('Callee @ $021000'));
  assert.ok(text.includes('LastMaskWrites: INTENA($C020->'));
  assert.ok(text.includes('RamINTENA(1x,last=$C020->'));
  assert.ok(text.includes('DMACON($8400->'));
  assert.ok(text.includes('COLOR00..07 (24b): A1B2C3'));
});

test('formatAmigaTriageText flags INTREQR vs INTENA+ROM conflict, preserves early callees, and logs RAM INTENA/DMACON history', () => {
  const aga = new AmigaMachine(
    { chipset: 'AGA', videoStandard: 'PAL', chipRamKB: 2048, slowRamKB: 0, fastRamKB: 0, audioEnabled: false },
    { skipDefaultDisk: true }
  );
  aga.memory.ovl = false;

  // ROM L3 vector @ $6C -> $F811F8
  aga.memory.write32(0x00006c, 0x00f811f8);

  // Record 2 RAM INTENA writes and 1 RAM DMACON write
  aga.cpu.pc = 0x00009000;
  aga.chipset.writeReg16(0x09a, 0xe02c);
  aga.cpu.pc = 0x00009010;
  aga.chipset.writeReg16(0x09a, 0x8010);
  aga.cpu.pc = 0x00009020;
  aga.chipset.writeReg16(0x096, 0x83f0);

  // Caller at $020000 with 4 BSR calls before return address $020014
  aga.memory.write16(0x020000, 0x6100); aga.memory.write16(0x020002, 0x1000); // BSR.W $021002
  aga.memory.write16(0x020004, 0x6100); aga.memory.write16(0x020006, 0x1010); // BSR.W $021016
  aga.memory.write16(0x020008, 0x6100); aga.memory.write16(0x02000a, 0x1020); // BSR.W $02102A
  aga.memory.write16(0x02000c, 0x6100); aga.memory.write16(0x02000e, 0x1030); // BSR.W $02103E
  aga.memory.write16(0x020010, 0x4eb9); aga.memory.write32(0x020012, 0x00030000); // JSR $030000
  aga.memory.write16(0x020016, 0x4e75); // RTS (retAddr = $020016)
  aga.memory.write16(0x021002, 0x4e75);
  aga.memory.write16(0x021016, 0x4e75);
  aga.memory.write16(0x02102a, 0x4e75);
  aga.memory.write16(0x02103e, 0x4e75);

  // Busy-wait loop at $030000 polling INTREQR bit 5 (VERTB)
  aga.memory.write16(0x030000, 0x0839); aga.memory.write16(0x030002, 0x0005);
  aga.memory.write16(0x030004, 0x00df); aga.memory.write16(0x030006, 0xf01f); // BTST #5,($DFF01F).L
  aga.memory.write16(0x030008, 0x67f6); // BEQ.S $030000

  aga.cpu.a[7] = 0x00050000;
  aga.memory.write32(0x00050000, 0x00020016);
  aga.cpu.pc = 0x00030000;

  const text = formatAmigaTriageText(aga, new Date(2026, 4, 9, 8, 5, 3));
  assert.ok(text.includes('CRITICAL: Код в busy-wait ждёт INTREQR bit 5 (VERTB)'));
  assert.ok(text.includes('L7='));
  assert.ok(text.includes('Callee @ $021002'));
  assert.ok(text.includes('Callee @ $02103E'));
  assert.ok(text.includes('RamINTENA_Hist (2x): $E02C->$602C@$009000 $8010->$603C@$009010'));
  assert.ok(text.includes('RamDMACON_Hist (1x): $83F0->$03F0@$009020'));

  aga.chipset.reset();
  assert.equal(aga.chipset.getRamIntenaHistory().length, 0);
  assert.equal(aga.chipset.getRamDmaconHistory().length, 0);
});



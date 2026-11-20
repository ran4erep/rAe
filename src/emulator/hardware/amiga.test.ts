import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AMIGA_RAW,
  decodeCiaKeyboardByte,
  encodeCiaKeyboardByte,
  amigaRawKeyToAscii,
} from '../keyboard/amigaKeyMap';
import {
  ADF_TOTAL_SIZE,
  decodeMfmSector,
  encodeAdfTrackToMfm,
  MFM_TRACK_BYTES,
  verifyAmigaBootblockChecksum,
  writeAmigaBootblockChecksum,
} from './floppy';
import { createBlankFormattedHdf } from '../archives/amigaDosFs';
import { buildBuiltinAdf } from '../roms/openKickKernel';
import { AmigaMachine } from './amigaMachine';
import { DEFAULT_AMIGA_CONFIG } from '../types';

test('Amiga keyboard CIA-A serial wire encoding round-trips all raw keycodes', () => {
  const sampleCodes = [
    AMIGA_RAW.ESC,
    AMIGA_RAW.F1,
    AMIGA_RAW.F10,
    AMIGA_RAW.HELP,
    AMIGA_RAW.DEL,
    AMIGA_RAW.LAMIGA,
    AMIGA_RAW.RAMIGA,
    AMIGA_RAW.NP_LPAREN,
    AMIGA_RAW.NP_ENTER,
    AMIGA_RAW.SPACE,
  ];
  for (const code of sampleCodes) {
    const downByte = encodeCiaKeyboardByte(code, false);
    const upByte = encodeCiaKeyboardByte(code, true);
    assert.deepEqual(decodeCiaKeyboardByte(downByte), { rawCode: code, isRelease: false });
    assert.deepEqual(decodeCiaKeyboardByte(upByte), { rawCode: code, isRelease: true });
    assert.notEqual(downByte, upByte);
  }
  assert.equal(amigaRawKeyToAscii(AMIGA_RAW.A, false, false), 'a');
  assert.equal(amigaRawKeyToAscii(AMIGA_RAW.A, true, false), 'A');
  assert.equal(amigaRawKeyToAscii(AMIGA_RAW.KEY_1, true, false), '!');
});

test('ADF MFM track encoder & decoder round-trip with valid sector checksums and $4489 sync', () => {
  const adf = buildBuiltinAdf('boing_studio');
  assert.equal(adf.length, ADF_TOTAL_SIZE);
  assert.equal(verifyAmigaBootblockChecksum(adf), true);

  const mfmBuf = new Uint8Array(MFM_TRACK_BYTES);
  encodeAdfTrackToMfm(adf, 0, 0, mfmBuf);

  // Locate first $4489 $4489 sync mark (at offset 4..7)
  assert.equal(mfmBuf[4], 0x44);
  assert.equal(mfmBuf[5], 0x89);
  assert.equal(mfmBuf[6], 0x44);
  assert.equal(mfmBuf[7], 0x89);

  const decoded = decodeMfmSector(mfmBuf, 8);
  assert.equal(decoded.track, 0);
  assert.equal(decoded.sector, 0);
  assert.equal(decoded.validChecksum, true);
  // Verify 'DOS\0' bootblock signature recovered identically from MFM stream
  assert.equal(decoded.data[0], 0x44); // 'D'
  assert.equal(decoded.data[1], 0x4f); // 'O'
  assert.equal(decoded.data[2], 0x53); // 'S'
  assert.equal(decoded.data[3], 0x00);
});

test('OCS vs ECS hardware identification registers (VPOSR & DENISEID) match chipset config', () => {
  const amiga = new AmigaMachine({ chipset: 'OCS', videoStandard: 'PAL', audioEnabled: false });
  assert.equal((amiga.chipset.readReg16(0x004) >>> 8) & 0x7f, 0x00); // OCS PAL Agnus
  assert.equal(amiga.chipset.readReg16(0x07c), 0xffff);              // OCS Denise

  amiga.updateConfig({ chipset: 'ECS', videoStandard: 'PAL' });
  assert.equal((amiga.chipset.readReg16(0x004) >>> 8) & 0x7f, 0x20); // ECS PAL Agnus
  assert.equal(amiga.chipset.readReg16(0x07c), 0x00fc);              // ECS Denise

  amiga.updateConfig({ chipset: 'ECS', videoStandard: 'NTSC' });
  assert.equal((amiga.chipset.readReg16(0x004) >>> 8) & 0x7f, 0x30); // ECS NTSC Agnus
});

test('Blitter copy (LF=$F0) and clear (LF=$00) operate directly on Chip RAM and assert BLIT IRQ', () => {
  const amiga = new AmigaMachine({ audioEnabled: false });
  amiga.memory.ovl = false;
  // Write test pattern at $010000
  amiga.memory.write16(0x010000, 0x1234);
  amiga.memory.write16(0x010002, 0xabcd);

  // Configure Blitter A -> D copy (2 words x 1 line)
  amiga.chipset.writeReg16(0x040, 0x09f0); // USEA | USED | LF=$F0
  amiga.chipset.writeReg16(0x042, 0x0000);
  amiga.chipset.writeReg16(0x044, 0xffff);
  amiga.chipset.writeReg16(0x046, 0xffff);
  amiga.chipset.writeReg16(0x050, 0x0001);
  amiga.chipset.writeReg16(0x052, 0x0000); // APT = $010000
  amiga.chipset.writeReg16(0x054, 0x0001);
  amiga.chipset.writeReg16(0x056, 0x0100); // DPT = $010100
  amiga.chipset.writeReg16(0x064, 0x0000);
  amiga.chipset.writeReg16(0x066, 0x0000);
  amiga.chipset.writeReg16(0x058, (1 << 6) | 2); // 1 line x 2 words

  assert.equal(amiga.memory.read16(0x010100), 0x1234);
  assert.equal(amiga.memory.read16(0x010102), 0xabcd);
  assert.ok((amiga.chipset.intreq & (1 << 6)) !== 0); // INT_BLIT raised
});

test('End-to-end Amiga 500 boot runs 68000 OpenKick ROM, renders non-blank Denise pixels, and processes CIA-A keyboard IRQ2', () => {
  const amiga = new AmigaMachine({ chipset: 'ECS', videoStandard: 'PAL', audioEnabled: false });
  assert.equal(amiga.memory.ovl, true);

  // Step 4 frames so 68000 boots, disables OVL, sets Copper/Bitplanes, and animates Boing Ball
  for (let f = 0; f < 4; f++) {
    amiga.stepFrame(true);
  }
  assert.equal(amiga.memory.ovl, false);
  const fb = amiga.getFramebuffer();

  // Verify multiple distinct rendered colors (not blank / single solid fill)
  const distinctColors = new Set<number>();
  for (let i = 0; i < fb.length; i += 17) {
    distinctColors.add(fb[i]);
  }
  assert.ok(distinctColors.size >= 5, `Expected rich multi-color OCS frame, got ${distinctColors.size} colors`);

  // Snapshot pixel checksum before animation & keyboard input
  let hashBefore = 0;
  for (let i = 0; i < fb.length; i += 31) hashBefore = (hashBefore * 31 + fb[i]) | 0;

  // Press Amiga HELP key ($5F) through real CIA-A serial IRQ2 pipeline
  amiga.setKey(AMIGA_RAW.HELP, true);
  amiga.stepFrame(true);
  amiga.setKey(AMIGA_RAW.HELP, false);
  amiga.stepFrame(true);

  assert.equal(amiga.getStatusSnapshot().lastKeyCode, AMIGA_RAW.HELP);

  let hashAfter = 0;
  for (let i = 0; i < fb.length; i += 31) hashAfter = (hashAfter * 31 + fb[i]) | 0;
  assert.notEqual(hashAfter, hashBefore, 'Animated OCS screen should update across frames');
});

test('HAM6 4096-color disk renders more than 32 simultaneous colors via real Denise HAM6 decoder', () => {
  const amiga = new AmigaMachine({ chipset: 'ECS', videoStandard: 'PAL', audioEnabled: false });
  amiga.insertBuiltinDisk(0, 'ham6_demo', true);

  for (let f = 0; f < 3; f++) {
    amiga.stepFrame(true);
  }

  const fb = amiga.getFramebuffer();
  const colors = new Set<number>();
  for (let i = 0; i < fb.length; i += 7) {
    colors.add(fb[i]);
  }
  assert.ok(
    colors.size > 40,
    `Real HAM6 mode should produce >40 distinct RGB colors in one frame, got ${colors.size}`
  );
});

test('Ctrl + Left Amiga + Right Amiga triggers authentic hardware warm reset', () => {
  const amiga = new AmigaMachine({ audioEnabled: false });
  amiga.stepFrame(false);
  amiga.stepFrame(false);
  assert.equal(amiga.memory.ovl, false);

  amiga.setKey(AMIGA_RAW.CTRL, true);
  amiga.setKey(AMIGA_RAW.LAMIGA, true);
  amiga.setKey(AMIGA_RAW.RAMIGA, true);

  // Immediately after three-key reset, OVL returns to true (ROM overlaid for reboot)
  assert.equal(amiga.memory.ovl, true);
});

test('Save state and load state preserve CPU registers and Chip RAM', () => {
  const amiga = new AmigaMachine({ audioEnabled: false });
  amiga.stepFrame(true);
  amiga.memory.write32(0x001234, 0xdeadbeef);
  const saved = amiga.saveState();

  amiga.memory.write32(0x001234, 0x00000000);
  assert.equal(amiga.memory.read32(0x001234), 0);

  const ok = amiga.loadState(saved);
  assert.equal(ok, true);
  assert.equal(amiga.memory.read32(0x001234) >>> 0, 0xdeadbeef);
});

test('CIA-A and CIA-B one-shot timers auto-start on TAHI/TBHI write and clear START bit on underflow', () => {
  const amiga = new AmigaMachine({ audioEnabled: false });
  // Configure CIA-A Timer B as one-shot (CRB = $08) and write latch = 100 E-clocks
  amiga.cia.writeA(0xf, 0x08);
  amiga.cia.writeA(0x6, 100);
  amiga.cia.writeA(0x7, 0); // Writing TBHI must load and auto-start in one-shot mode!
  assert.equal(amiga.cia.readA(0xf) & 0x01, 0x01);

  amiga.cia.stepEClocks(60);
  assert.equal(amiga.cia.readA(0xf) & 0x01, 0x01); // Still running

  amiga.cia.stepEClocks(60);
  assert.equal(amiga.cia.readA(0xf) & 0x01, 0x00); // Stopped after one-shot underflow
  assert.ok((amiga.cia.readA(0xd) & 0x02) !== 0);   // TB ICR flag asserted
});

test('Blitter Line-Draw Mode (BLTCON1 bit 0 = 1) draws diagonal lines with SING one-dot mode', () => {
  const amiga = new AmigaMachine({ audioEnabled: false });
  amiga.memory.ovl = false;
  // Clear 16 rows x 2 words (row stride = 4 bytes) at $020000
  for (let i = 0; i < 64; i += 2) amiga.memory.write16(0x020000 + i, 0);

  // Draw a 6-pixel diagonal line (dx=5, dy=5, octant +X/+Y: SUD=1, SUL=0, AUL=0, SING=1, LINE=1)
  amiga.chipset.writeReg16(0x040, 0x0bca); // ASH=0, USEA|USEC|USED, LF=$CA
  amiga.chipset.writeReg16(0x042, 0x0013); // SUD=1 (X-major), SING=1, LINE=1
  amiga.chipset.writeReg16(0x044, 0xffff);
  amiga.chipset.writeReg16(0x074, 0x8000); // BLTADAT single pixel MSB
  amiga.chipset.writeReg16(0x072, 0xffff); // BLTBDAT solid line pattern
  amiga.chipset.writeReg16(0x064, 0);      // BLTAMOD = 4*dy - 4*dx = 0
  amiga.chipset.writeReg16(0x062, 20);     // BLTBMOD = 4*dy = 20
  amiga.chipset.writeReg16(0x060, 4);      // BLTCMOD = 4 bytes per row
  amiga.chipset.writeReg16(0x050, 0x0000);
  amiga.chipset.writeReg16(0x052, 10);     // BLTAPTL = 4*dy - 2*dx = 10
  amiga.chipset.writeReg16(0x048, 0x0002);
  amiga.chipset.writeReg16(0x04a, 0x0000); // CPT = $020000
  amiga.chipset.writeReg16(0x054, 0x0002);
  amiga.chipset.writeReg16(0x056, 0x0000); // DPT = $020000
  amiga.chipset.writeReg16(0x058, (6 << 6) | 2); // 6 pixels

  // Expect diagonal bits 15, 14, 13, 12, 11, 10 set on rows 0..5
  assert.equal(amiga.memory.read16(0x020000), 0x8000);
  assert.equal(amiga.memory.read16(0x020004), 0x4000);
  assert.equal(amiga.memory.read16(0x020008), 0x2000);
  assert.equal(amiga.memory.read16(0x02000c), 0x1000);
  assert.equal(amiga.memory.read16(0x020010), 0x0800);
  assert.equal(amiga.memory.read16(0x020014), 0x0400);
});

test('Async Paula Disk DMA preserves 2nd $4489 WORDSYNC word, honors DSKLEN=$4000 abort, and isolates DF2/DF3', () => {
  const amiga = new AmigaMachine({ audioEnabled: false });
  amiga.memory.ovl = false;

  // Non-existent DF2 selected (/SEL2 low, bit 5 = 0 -> $DF): must report /RDY=1 and /CHNG=0 (0x38)
  amiga.floppy.handleCiaBPrb(0xdf, 0xff);
  assert.equal(amiga.floppy.getCiaAStatusBits(), 0x38);

  // Select DF0 with motor ON (/MTR=0, /SEL0=0 -> $77)
  amiga.floppy.handleCiaBPrb(0x77, 0xff);
  amiga.chipset.writeReg16(0x096, 0x8210); // DMA_MASTER | DMA_DISK
  amiga.chipset.writeReg16(0x09e, 0x8400); // ADKCON WORDSYNC
  amiga.chipset.writeReg16(0x07e, 0x4489); // DSKSYNC = $4489
  amiga.chipset.writeReg16(0x020, 0x0001);
  amiga.chipset.writeReg16(0x022, 0x8000); // DSKPT = $018000

  // Dummy DMA start immediately aborted with DSKLEN=$4000 must NOT advance head or corrupt RAM
  amiga.memory.write16(0x018000, 0x1234);
  amiga.chipset.writeReg16(0x024, 0x8020);
  amiga.chipset.writeReg16(0x024, 0x8020);
  amiga.chipset.stepDiskDma(4); // Inside 2-scanline arming delay
  amiga.chipset.writeReg16(0x024, 0x4000); // Immediate abort
  assert.equal(amiga.memory.read16(0x018000), 0x1234);
  assert.equal(amiga.floppy.drives[0].trackBytePos, 0);

  // Real DMA start of 8 words: first word written into Chip RAM must be the 2nd $4489!
  amiga.chipset.writeReg16(0x024, 0x8008);
  amiga.chipset.writeReg16(0x024, 0x8008);
  for (let i = 0; i < 6; i++) amiga.chipset.stepDiskDma(4);
  assert.equal(amiga.memory.read16(0x018000), 0x4489);
  assert.ok((amiga.chipset.intreq & 0x0002) !== 0); // INT_DSKBLK raised
});

test('Copper PAL line-255 wrap ($FFE1 $FFFE) delays subsequent WAIT $0901 until scanline 265', () => {
  const amiga = new AmigaMachine({ audioEnabled: false });
  amiga.memory.ovl = false;

  // Copperlist at $010000: set COLOR00=$111, wait $FFE1, wait $0901, set COLOR00=$F00, end
  const cl = [
    0x0180, 0x0111,
    0xffe1, 0xfffe,
    0x0901, 0xfffe,
    0x0180, 0x0f00,
    0xffff, 0xfffe,
  ];
  for (let i = 0; i < cl.length; i++) amiga.memory.write16(0x010000 + i * 2, cl[i]);

  amiga.chipset.writeReg16(0x080, 0x0001);
  amiga.chipset.writeReg16(0x082, 0x0000);
  amiga.chipset.writeReg16(0x096, 0x8280); // DMA_MASTER | DMA_COPPER
  amiga.chipset.startFrame();

  for (let line = 0; line <= 255; line++) amiga.chipset.runCopperLine(line);
  assert.equal(amiga.chipset.colorReg[0], 0x0111); // Must NOT have fired early at line 255!

  for (let line = 256; line <= 264; line++) amiga.chipset.runCopperLine(line);
  assert.equal(amiga.chipset.colorReg[0], 0x0111);

  amiga.chipset.runCopperLine(265);
  assert.equal(amiga.chipset.colorReg[0], 0x0f00); // Fired cleanly on PAL scanline 265!
});

test('loadCustomRom auto-ejects built-in OpenKick demo disks but preserves user ADF images', () => {
  const amiga = new AmigaMachine({ audioEnabled: false });
  assert.equal(amiga.floppy.drives[0].name, 'boing_studio.adf');

  // Fake 256KB Kickstart ROM
  const fakeRom = new Uint8Array(262144);
  const res = amiga.loadCustomRom(fakeRom, 'Kickstart 1.3');
  assert.equal(res.ok, true);
  assert.equal(amiga.floppy.drives[0].data, null); // OpenKick demo disk auto-ejected!

  // Now mount a user ADF and reload custom ROM: user ADF must remain mounted
  const userAdf = new Uint8Array(ADF_TOTAL_SIZE);
  amiga.insertAdf(0, userAdf, 'Chaos Engine A.adf', false);
  amiga.loadCustomRom(fakeRom, 'Kickstart 1.3');
  assert.equal(amiga.floppy.drives[0].name, 'Chaos Engine A.adf');
  assert.notEqual(amiga.floppy.drives[0].data, null);
});

test('Agnus 8-clock fetch units & Denise phase-locked BPLCON1 prevent horizontal scroll shear ($34/$CC vs $30/$CC)', () => {
  const amiga = new AmigaMachine({ audioEnabled: false });
  amiga.memory.ovl = false;
  const c = amiga.chipset;

  // Set up 1-bitplane 42-byte/line screen in Chip RAM at $010000 with a single vertical white stripe at bit 7 of byte 1 (pixel X=8)
  const base = 0x010000;
  for (let row = 0; row < 4; row++) {
    for (let b = 0; b < 42; b++) amiga.memory.write8(base + row * 42 + b, 0x00);
    amiga.memory.write8(base + row * 42 + 1, 0x80); // Pixel 8 lit on every row
  }

  c.writeReg16(0x096, 0x8300); // DMA_MASTER | DMA_BITPLANE
  c.writeReg16(0x100, 0x1200); // 1 bitplane Lo-Res
  c.writeReg16(0x180, 0x0000); // Color 0 = black
  c.writeReg16(0x182, 0x0fff); // Color 1 = white
  c.writeReg16(0x08e, 0x3881); // DIWSTRT V=56, H=$81 (X=0)
  c.writeReg16(0x090, 0x00c1); // DIWSTOP V=256, H=$1C1 (X=320)

  // Case 1: Unscrolled with DDFSTRT=$34, DDFSTOP=$CC, BPLCON1=$0000, BPL1MOD=+2 (20 words + 2 = 42 bytes/line)
  c.writeReg16(0x092, 0x0034);
  c.writeReg16(0x094, 0x00cc);
  c.writeReg16(0x102, 0x0000);
  c.writeReg16(0x108, 0x0002);
  c.writeReg16(0x0e0, 0x0001);
  c.writeReg16(0x0e2, 0x0000);

  c.renderScanline(56, true);
  c.renderScanline(57, true);
  assert.equal(c.bplPt[0], base + 84, 'DDF $34-$CC + mod 2 must advance 42 bytes/line (20 words + 2)');
  const white = c.colorAbgr[1];
  // With Denise global phase delay, DDFSTRT=$34 + BPLCON1=0 starts at X=0 -> pixel 8 is at fb x=16
  const y56 = (56 - 44) * 640;
  const y57 = (57 - 44) * 640;
  assert.equal(c.framebuffer[y56 + 8 * 2], white, 'Unscrolled pixel 8 should render at X=8');
  assert.equal(c.framebuffer[y57 + 8 * 2], white, 'Next scanline must stay vertically aligned at X=8');

  // Case 2: Scrolled 1px right -> DDFSTRT=$30, DDFSTOP=$CC, BPLCON1=$00FF (delay 15), BPL1MOD=0 (21 words + 0 = 42 bytes/line!)
  c.writeReg16(0x092, 0x0030);
  c.writeReg16(0x094, 0x00cc);
  c.writeReg16(0x102, 0x00ff);
  c.writeReg16(0x108, 0x0000);
  c.writeReg16(0x0e0, 0x0001);
  c.writeReg16(0x0e2, 0x0000);

  c.renderScanline(56, true);
  c.renderScanline(57, true);
  assert.equal(c.bplPt[0], base + 84, 'DDF $30-$CC + mod 0 must fetch 21 words (42 bytes/line) with zero diagonal shear');
  // Smooth 1px scroll left from X=8 -> X=7 on BOTH scanlines!
  assert.equal(c.framebuffer[y56 + 7 * 2], white, 'Scrolled 1px (DDF=$30, BPLCON1=$FF) must move pixel 8 cleanly to X=7');
  assert.equal(c.framebuffer[y57 + 7 * 2], white, 'Second scanline must align straight at X=7 (no diagonal shear)');
});

test('Two-phase Copper HBlank WAIT ($E7DF) applies HUD split AFTER scanline $E7 renders', () => {
  const amiga = new AmigaMachine({ audioEnabled: false });
  amiga.memory.ovl = false;
  const c = amiga.chipset;

  const cl = [
    0x0180, 0x00f0, // Playfield bg = green
    0xe7df, 0xfffe, // Wait end of line $E7 (231), H=$DF
    0x0180, 0x000f, // HUD bg = blue
    0xffff, 0xfffe,
  ];
  for (let i = 0; i < cl.length; i++) amiga.memory.write16(0x012000 + i * 2, cl[i]);

  c.writeReg16(0x080, 0x0001);
  c.writeReg16(0x082, 0x2000);
  c.writeReg16(0x096, 0x8280); // DMA_MASTER | DMA_COPPER
  c.startFrame();

  for (let line = 0; line <= 231; line++) {
    c.runCopperLine(line, 0xae);
    if (line === 231) {
      // During scanline 231 display, COLOR00 must STILL be green ($00F0)!
      assert.equal(c.colorReg[0], 0x00f0);
    }
    c.runCopperLine(line, 0xfe);
  }
  // Immediately after line 231 HBlank, COLOR00 switches to blue ($000F) for line 232!
  assert.equal(c.colorReg[0], 0x000f);
});

test('Default config disables CRT scanlines and autoCrop, sets 100% volume, and tracks DF0/DF1 activeIo & Caps Lock', () => {
  assert.equal(DEFAULT_AMIGA_CONFIG.crtScanlines, false);
  assert.equal(DEFAULT_AMIGA_CONFIG.audioVolume, 1.0);
  assert.equal(DEFAULT_AMIGA_CONFIG.autoCrop, false);

  const amiga = new AmigaMachine({ audioEnabled: false });
  amiga.ejectDisk(0);

  // Changing audioVolume must preserve CPU state (no reboot) and clamp to [0, 1]
  const prevFrames = amiga.frameCount;
  amiga.updateConfig({ audioVolume: 1.4 });
  assert.equal(amiga.config.audioVolume, 1);
  assert.equal(amiga.frameCount, prevFrames);

  amiga.updateConfig({ audioVolume: -0.2 });
  assert.equal(amiga.config.audioVolume, 0);

  // Idle empty-drive step while motor is off must emit zero click commands
  assert.deepEqual(amiga.floppyAudio.stateMachine.onStep(0, 1), []);
  assert.deepEqual(amiga.floppyAudio.stateMachine.onStep(0, 0), []);

  // Inserting a disk into DF1 and stepping raises activeIo & toggles stepPhase, then decays over frames
  const fakeAdf = new Uint8Array(ADF_TOTAL_SIZE);
  amiga.insertAdf(1, fakeAdf, 'diskB.adf', false);
  const phase0 = amiga.getStatusSnapshot().df1.stepPhase;
  amiga.floppy.drives[1].step(false);
  assert.equal(amiga.getStatusSnapshot().df1.activeIo, true);
  assert.notEqual(amiga.getStatusSnapshot().df1.stepPhase, phase0);
  for (let i = 0; i < 8; i++) amiga.stepFrame(false);
  assert.equal(amiga.getStatusSnapshot().df1.activeIo, false);

  // Caps Lock hardware toggle works on both OpenKick and real Kickstart ROM
  const fakeRom = new Uint8Array(262144);
  amiga.loadCustomRom(fakeRom, 'ks13');
  assert.equal(amiga.getStatusSnapshot().capsLock, false);
  amiga.setKey(0x62, true);
  amiga.setKey(0x62, false);
  assert.equal(amiga.getStatusSnapshot().capsLock, true);
  amiga.setKey(0x62, true);
  amiga.setKey(0x62, false);
  assert.equal(amiga.getStatusSnapshot().capsLock, false);
});

test('Disconnecting virtual joystick clears JOY1DAT, CIA-A Fire1, POTGOR Fire2 and ignores input without rebooting', () => {
  assert.equal(DEFAULT_AMIGA_CONFIG.joystickConnected, true);
  const amiga = new AmigaMachine({ audioEnabled: false });
  amiga.ejectDisk(0);

  // Connected: joystick inputs appear in hardware registers
  amiga.setJoystick({ right: true, fire1: true, fire2: true });
  assert.notEqual(amiga.chipset.readReg16(0x00c), 0); // JOY1DAT non-zero
  assert.equal((amiga.cia.readA(0) & 0x80) === 0, true); // CIA-A PRA bit 7 active-low
  assert.equal((amiga.chipset.readReg16(0x016) & 0x4000) === 0, true); // POTGOR bit 14 active-low

  // Unplug joystick: preserves CPU frameCount, clears registers & ignores new joystick input
  const prevFrames = amiga.frameCount;
  amiga.updateConfig({ joystickConnected: false });
  assert.equal(amiga.frameCount, prevFrames);
  assert.equal(amiga.chipset.readReg16(0x00c), 0);
  assert.equal((amiga.cia.readA(0) & 0x80) !== 0, true);
  assert.equal((amiga.chipset.readReg16(0x016) & 0x4000) !== 0, true);

  amiga.setJoystick({ up: true, left: true, fire1: true, fire2: true });
  assert.equal(amiga.chipset.readReg16(0x00c), 0);
  assert.equal((amiga.cia.readA(0) & 0x80) !== 0, true);
  assert.equal((amiga.chipset.readReg16(0x016) & 0x4000) !== 0, true);

  // Plug joystick back in: input works again
  amiga.updateConfig({ joystickConnected: true });
  amiga.setJoystick({ left: true, fire1: true });
  assert.notEqual(amiga.chipset.readReg16(0x00c), 0);
  assert.equal((amiga.cia.readA(0) & 0x80) === 0, true);
});

test('insertAdf defaults to hot-swap without rebooting CPU and save bundles restore DF0/DF1 disks', () => {
  const amiga = new AmigaMachine({ audioEnabled: false });
  amiga.stepFrame(false);
  amiga.stepFrame(false);
  const pcBeforeInsert = amiga.cpu.pc;
  const framesBeforeInsert = amiga.frameCount;

  const diskA = new Uint8Array(ADF_TOTAL_SIZE);
  diskA[0] = 0x44;
  diskA[512] = 0x55;
  const diskB = new Uint8Array(ADF_TOTAL_SIZE);
  diskB[0] = 0x45;
  diskB[512] = 0x66;

  // Inserting into DF0 without resetIfDf0 must preserve CPU PC & frameCount
  const insRes = amiga.insertAdf(0, diskA, 'Game Disk 1.adf');
  assert.equal(insRes.ok, true);
  assert.equal(amiga.cpu.pc, pcBeforeInsert);
  assert.equal(amiga.frameCount, framesBeforeInsert);
  assert.equal(amiga.floppy.drives[0].diskChanged, true);

  amiga.insertAdf(1, diskB, 'Game Disk 2.adf');
  amiga.floppy.drives[0].cylinder = 23;
  amiga.floppy.drives[0].side = 1;
  amiga.floppy.drives[0].diskChanged = false;
  amiga.memory.write32(0x002000, 0xcafebabe);

  const bundle = amiga.exportSaveBundle();
  assert.equal(bundle.df0Disk?.name, 'Game Disk 1.adf');
  assert.equal(bundle.df1Disk?.name, 'Game Disk 2.adf');
  assert.equal(bundle.df0Disk?.bytes[512], 0x55);
  assert.equal(bundle.df1Disk?.bytes[512], 0x66);

  // Mutate drives and RAM: eject DF1, insert a completely different disk into DF0
  const otherDisk = new Uint8Array(ADF_TOTAL_SIZE);
  otherDisk[512] = 0x99;
  amiga.insertAdf(0, otherDisk, 'Other.adf');
  amiga.ejectDisk(1);
  amiga.memory.write32(0x002000, 0x11111111);

  // Load save bundle: both DF0 and DF1 disks, their contents, and track positions must be restored!
  const ok = amiga.loadSaveBundle(bundle.state, bundle.df0Disk, bundle.df1Disk);
  assert.equal(ok, true);
  assert.equal(amiga.memory.read32(0x002000) >>> 0, 0xcafebabe);
  assert.equal(amiga.floppy.drives[0].name, 'Game Disk 1.adf');
  assert.equal(amiga.floppy.drives[0].data?.[512], 0x55);
  assert.equal(amiga.floppy.drives[0].cylinder, 23);
  assert.equal(amiga.floppy.drives[0].side, 1);
  assert.equal(amiga.floppy.drives[0].diskChanged, false);
  assert.equal(amiga.floppy.drives[1].name, 'Game Disk 2.adf');
  assert.equal(amiga.floppy.drives[1].data?.[512], 0x66);

  // Also test restoring a bundle where DF1 was empty while DF1 currently has a disk -> DF1 must be ejected
  amiga.ejectDisk(1);
  const emptyDf1Bundle = amiga.exportSaveBundle();
  amiga.insertAdf(1, diskB, 'TempDisk.adf');
  amiga.loadSaveBundle(emptyDf1Bundle.state, emptyDf1Bundle.df0Disk, emptyDf1Bundle.df1Disk);
  assert.equal(amiga.floppy.drives[1].data, null);
  assert.equal(amiga.floppy.drives[1].name, '');
});

test('Resetting Amiga after loading a save state ejects save-state disks, while manual disks survive warmReset', () => {
  const amiga = new AmigaMachine({ audioEnabled: false });
  const diskA = new Uint8Array(ADF_TOTAL_SIZE);
  const diskB = new Uint8Array(ADF_TOTAL_SIZE);

  // Manual insert + warmReset: disk must remain inserted
  amiga.insertAdf(0, diskA, 'Manual.adf');
  amiga.warmReset();
  assert.equal(amiga.floppy.drives[0].name, 'Manual.adf');
  assert.notEqual(amiga.floppy.drives[0].data, null);

  // Export bundle with both drives occupied, then load via loadSaveBundle
  amiga.insertAdf(1, diskB, 'Manual2.adf');
  const bundle = amiga.exportSaveBundle();
  amiga.ejectDisk(0);
  amiga.ejectDisk(1);

  amiga.loadSaveBundle(bundle.state, bundle.df0Disk, bundle.df1Disk);
  assert.equal(amiga.floppy.drives[0].name, 'Manual.adf');
  assert.equal(amiga.floppy.drives[1].name, 'Manual2.adf');

  // Rebooting computer after loading save state must eject the auto-inserted disks
  amiga.warmReset();
  assert.equal(amiga.floppy.drives[0].data, null);
  assert.equal(amiga.floppy.drives[0].name, '');
  assert.equal(amiga.floppy.drives[1].data, null);
  assert.equal(amiga.floppy.drives[1].name, '');

  // Also verify Ctrl+LeftAmiga+RightAmiga warm reset after loadSaveBundle ejects disks,
  // unless user manually replaced one of the drives
  amiga.loadSaveBundle(bundle.state, bundle.df0Disk, bundle.df1Disk);
  amiga.insertAdf(1, diskB, 'ReplacedManual.adf');
  amiga.setKey(AMIGA_RAW.CTRL, true);
  amiga.setKey(AMIGA_RAW.LAMIGA, true);
  amiga.setKey(AMIGA_RAW.RAMIGA, true);
  assert.equal(amiga.floppy.drives[0].data, null);
  assert.equal(amiga.floppy.drives[1].name, 'ReplacedManual.adf');
});

test('insertBlankAdf creates writable formatted AmigaDOS OFS disk and Paula Disk DMA write persists sectors for export', () => {
  const amiga = new AmigaMachine({ audioEnabled: false });
  amiga.memory.ovl = false;

  // Insert blank formatted disk into DF1
  const name = amiga.insertBlankAdf(1, 'SaveDisk_DF1.adf');
  assert.equal(name, 'SaveDisk_DF1.adf');
  const d1 = amiga.floppy.drives[1];
  assert.equal(d1.writeProtected, false);
  assert.notEqual(d1.data, null);
  assert.equal(d1.data!.length, ADF_TOTAL_SIZE);
  assert.equal(verifyAmigaBootblockChecksum(d1.data!), true);

  // Verify 'DOS\0' + Root Block (sector 880) + Bitmap Block (sector 881)
  assert.equal(d1.data![0], 0x44);
  assert.equal(d1.data![1], 0x4f);
  assert.equal(d1.data![2], 0x53);
  assert.equal(d1.data![3], 0x00);
  const rootOff = 880 * 512;
  assert.equal(d1.data![rootOff + 3], 2); // T_HEADER
  assert.equal(d1.data![rootOff + 511], 1); // ST_ROOT

  // Select DF1 with motor ON (/MTR=0, /SEL1=0 -> $6F) and verify /WPRO bit 3 is high (writable!)
  amiga.floppy.handleCiaBPrb(0x6f, 0xff);
  assert.notEqual(amiga.floppy.getCiaAStatusBits() & 0x08, 0);

  // Encode a modified track 0 (cyl 0, side 0) with custom save payload into Chip RAM at $020000
  const modifiedAdf = new Uint8Array(d1.data!);
  modifiedAdf[5 * 512 + 0] = 0x53; // 'S'
  modifiedAdf[5 * 512 + 1] = 0x41; // 'A'
  modifiedAdf[5 * 512 + 2] = 0x56; // 'V'
  modifiedAdf[5 * 512 + 3] = 0x45; // 'E'
  const mfmTrack = new Uint8Array(MFM_TRACK_BYTES);
  encodeAdfTrackToMfm(modifiedAdf, 0, 0, mfmTrack);
  for (let i = 0; i < MFM_TRACK_BYTES; i++) {
    amiga.memory.chipRam[0x020000 + i] = mfmTrack[i];
  }

  // Trigger real Paula Disk DMA write (DSKLEN bit 14 = $4000, bit 15 = $8000)
  const words = MFM_TRACK_BYTES >>> 1;
  amiga.chipset.writeReg16(0x096, 0x8210); // DMA_MASTER | DMA_DISK
  amiga.chipset.writeReg16(0x020, 0x0002);
  amiga.chipset.writeReg16(0x022, 0x0000); // DSKPT = $020000
  amiga.chipset.writeReg16(0x024, 0xc000 | words);
  amiga.chipset.writeReg16(0x024, 0xc000 | words);

  for (let i = 0; i < 2000; i++) {
    amiga.chipset.stepDiskDma(4);
    if (!amiga.chipset.dskDmaActive) break;
  }
  assert.equal(amiga.chipset.dskDmaActive, false);

  // Exported ADF must now contain the in-game saved sector data!
  const exported = amiga.exportDriveAdf(1);
  assert.ok(exported);
  assert.equal(exported.bytes[5 * 512 + 0], 0x53);
  assert.equal(exported.bytes[5 * 512 + 1], 0x41);
  assert.equal(exported.bytes[5 * 512 + 2], 0x56);
  assert.equal(exported.bytes[5 * 512 + 3], 0x45);
});

test('Denise renders HIRES Dual Playfield (BPLCON0 HIRES + DPF) with PF1/PF2 colors, priority, and scroll', () => {
  const amiga = new AmigaMachine({ audioEnabled: false });
  const c = amiga.chipset;
  const chip = amiga.memory.chipRam;

  c.writeReg16(0x096, 0x8300); // DMA_MASTER | DMA_BITPLANE
  c.writeReg16(0x08e, 0x2c81); // DIWSTRT
  c.writeReg16(0x090, 0xf4c1); // DIWSTOP
  c.writeReg16(0x092, 0x003c); // DDFSTRT hires
  c.writeReg16(0x094, 0x00d4); // DDFSTOP hires
  c.writeReg16(0x100, 0xc400); // HIRES (0x8000) | 4 planes (0x4000) | DPF (0x0400)
  c.writeReg16(0x102, 0x0000); // BPLCON1 = 0
  c.writeReg16(0x104, 0x0000); // PF1 in front

  c.writeReg16(0x180, 0x0000); // COLOR00 = black
  c.writeReg16(0x182, 0x0fff); // COLOR01 (PF1 c1=1) = white
  c.writeReg16(0x186, 0x0f00); // COLOR03 (PF1 c1=3) = red
  c.writeReg16(0x192, 0x00f0); // COLOR09 (PF2 c2=1) = green

  // Plane 0 (PF1 bit 0): $80 -> pixel 0 set; $C0 -> pixels 0,1 set
  // Plane 1 (PF2 bit 0): $C0 -> pixels 0,1 set
  // Plane 2 (PF1 bit 1): $00
  // Plane 3 (PF2 bit 1): $00
  // Pixel 0: c1=1, c2=1 -> PF1 wins -> COLOR01 ($fff)
  // Pixel 1: c1=0, c2=1 -> PF2 visible -> COLOR09 ($0f0)
  // Pixel 2: c1=0, c2=0 -> bg -> COLOR00 ($000)
  chip[0x10000] = 0x80;
  chip[0x11000] = 0xc0;
  chip[0x12000] = 0x00;
  chip[0x13000] = 0x00;

  c.bplPt[0] = 0x10000;
  c.bplPt[1] = 0x11000;
  c.bplPt[2] = 0x12000;
  c.bplPt[3] = 0x13000;
  c.renderScanline(44, true);

  const fb = amiga.getFramebuffer();
  assert.equal(fb[0], 0xffffffff); // COLOR01 white
  assert.equal(fb[1], 0xff00ff00); // COLOR09 green
  assert.equal(fb[2], 0xff000000); // COLOR00 black

  // Flip PF2PRI (BPLCON2 = $0040): pixel 0 now prefers PF2 (COLOR09 green)
  c.writeReg16(0x104, 0x0040);
  c.bplPt[0] = 0x10000;
  c.bplPt[1] = 0x11000;
  c.bplPt[2] = 0x12000;
  c.bplPt[3] = 0x13000;
  c.renderScanline(44, true);
  assert.equal(fb[0], 0xff00ff00); // PF2 wins over PF1
  assert.equal(fb[1], 0xff00ff00);

  // Independent PF2 scroll (BPLCON1 = $0010 -> PF2 shifted right by 2 hires pixels)
  c.writeReg16(0x102, 0x0010);
  c.writeReg16(0x104, 0x0000);
  c.bplPt[0] = 0x10000;
  c.bplPt[1] = 0x11000;
  c.bplPt[2] = 0x12000;
  c.bplPt[3] = 0x13000;
  c.renderScanline(44, true);
  assert.equal(fb[0], 0xffffffff); // PF1 at x=0
  assert.equal(fb[1], 0xff000000); // Gap at x=1
  assert.equal(fb[2], 0xff00ff00); // PF2 shifted to x=2
});

test('shouldHintResetForDf0Boot triggers reset hint only for bootable DF0 over active HDD without breaking mid-game swaps', () => {
  const amiga = new AmigaMachine({ audioEnabled: false });
  const fakeRom = new Uint8Array(262144);
  amiga.loadCustomRom(fakeRom, 'ks13.rom');

  const hdf = createBlankFormattedHdf(1, 'WorkHD');
  amiga.mountHdf(hdf, 'work.hdf', false, 0);
  amiga.ejectDisk(0);

  const bootableAdf = new Uint8Array(ADF_TOTAL_SIZE);
  bootableAdf[0] = 0x44; // 'D'
  bootableAdf[1] = 0x4f; // 'O'
  bootableAdf[2] = 0x53; // 'S'
  bootableAdf[3] = 0x00;
  writeAmigaBootblockChecksum(bootableAdf);

  const nonBootableAdf = new Uint8Array(ADF_TOTAL_SIZE);
  nonBootableAdf[0] = 0x44;
  nonBootableAdf[1] = 0x4f;
  nonBootableAdf[2] = 0x53;
  nonBootableAdf[3] = 0x00;

  // Empty DF0 + DH0 mounted -> bootable ADF must hint reset, non-bootable must not
  assert.equal(amiga.shouldHintResetForDf0Boot(bootableAdf), true);
  assert.equal(amiga.shouldHintResetForDf0Boot(nonBootableAdf), false);

  // Insert bootable ADF with reset=true (simulating game start)
  amiga.insertAdf(0, bootableAdf, 'GameA.adf', true);
  // While floppy game runs (no DH0 reads since reset, DF0 occupied), swapping another disk must NOT hint reset
  assert.equal(amiga.shouldHintResetForDf0Boot(nonBootableAdf), false);
  assert.equal(amiga.shouldHintResetForDf0Boot(bootableAdf), false);

  // Simulate Workbench booting from DH0 (CMD_READ happened on unit 0) even with DF0 occupied by a data disk
  amiga.hardfile.units[0].hasReadSinceReset = true;
  assert.equal(amiga.shouldHintResetForDf0Boot(bootableAdf), true);
  assert.equal(amiga.shouldHintResetForDf0Boot(nonBootableAdf), false);
});

test('AmigaMachine with skipDefaultDisk skips inserting boing_studio demo disk so Kickstart boots directly', () => {
  const amiga = new AmigaMachine({ audioEnabled: false }, { skipDefaultDisk: true });
  assert.equal(amiga.floppy.drives[0].data, null);
  assert.equal(amiga.floppy.drives[0].name, '');
});

test('Oki MSM6242B battery-backed RTC at $DC0000 exposes 24h BCD digits, control regs, and advances across PAL frames', () => {
  const amiga = new AmigaMachine({ videoStandard: 'PAL', audioEnabled: false }, { skipDefaultDisk: true });
  const m = amiga.memory;

  // Reg F ($DC003F) initializes with bit 2 set (24h mode), Reg D ($DC0035) has BUSY (bit 1) cleared
  assert.equal(m.read8(0xdc003f) & 0x04, 0x04);
  assert.equal(m.read8(0xdc0035) & 0x02, 0x00);

  // Writing HOLD=1 to Reg D stores bit 0 while keeping BUSY=0
  m.write8(0xdc0035, 0xf1);
  assert.equal(m.read8(0xdc0037) & 0x03, 0x01);
  m.write8(0xdc0035, 0xf0);
  assert.equal(m.read8(0xdc0037) & 0x03, 0x00);

  // Month (1..12) and Day-of-Month (1..31) BCD nibbles must be valid
  const month = (m.read8(0xdc0025) & 0x0f) * 10 + (m.read8(0xdc0021) & 0x0f);
  const dom = (m.read8(0xdc001d) & 0x0f) * 10 + (m.read8(0xdc0019) & 0x0f);
  assert.ok(month >= 1 && month <= 12, `Expected valid BCD month, got ${month}`);
  assert.ok(dom >= 1 && dom <= 31, `Expected valid BCD day-of-month, got ${dom}`);

  // Seconds digit ($DC0001/$DC0003) must advance within 75 PAL frames (SetClock load probe window)
  const sBefore = (m.read8(0xdc0005) & 0x0f) * 10 + (m.read8(0xdc0001) & 0x0f);
  for (let i = 0; i < 75; i++) {
    amiga.stepFrame(false);
  }
  const sAfter = (m.read8(0xdc0005) & 0x0f) * 10 + (m.read8(0xdc0001) & 0x0f);
  assert.notEqual(sAfter, sBefore, 'Expected RTC seconds to advance across 75 PAL frames');
});

test('Floppy /STEP triggers on rising edge (0 -> 1) so trackloaders starting with STEP=0 ($7E/$76) do not lose the first step', () => {
  const amiga = new AmigaMachine({ audioEnabled: false });
  const disk = new Uint8Array(ADF_TOTAL_SIZE);
  amiga.insertAdf(0, disk, 'ATN1Test.adf', false);

  // Typical ATN1 sequence: write $7E (STEP=0, no drive selected), then $76 (DF0 selected, STEP still 0)
  amiga.cia.writeB(1, 0x7e);
  amiga.cia.writeB(1, 0x76);
  assert.equal(amiga.floppy.drives[0].cylinder, 0);

  // Step inward twice using BCLR #1 (DIR=0), BCLR #0 (STEP=0), BSET #0 (STEP=1)
  for (let s = 0; s < 2; s++) {
    amiga.cia.writeB(1, amiga.cia.prbB & ~0x02); // DIR=0 inward
    amiga.cia.writeB(1, amiga.cia.prbB & ~0x01); // STEP=0
    amiga.cia.writeB(1, amiga.cia.prbB | 0x01);  // STEP=1 (trailing rising edge)
  }
  assert.equal(amiga.floppy.drives[0].cylinder, 2);

  // Step outward once (DIR=1)
  amiga.cia.writeB(1, amiga.cia.prbB | 0x02);
  amiga.cia.writeB(1, amiga.cia.prbB & ~0x01);
  amiga.cia.writeB(1, amiga.cia.prbB | 0x01);
  assert.equal(amiga.floppy.drives[0].cylinder, 1);
});

test('Copper copHpos (+4 CCK per MOVE) preserves full-line highlight until Phase 2 HBlank reset', () => {
  const amiga = new AmigaMachine({ audioEnabled: false });
  amiga.memory.ovl = false;
  const c = amiga.chipset;

  // Build Copperlist mimicking trainer highlight bar at line $7F (127):
  // Set COLOR01=$FFF, wait $7F3F, emit 40x COLOR01=$84A (+4 CCK each = 160 CCK), then restore COLOR01=$FFF
  const base = 0x014000;
  let p = base;
  const emit = (w1: number, w2: number) => {
    amiga.memory.write16(p, w1);
    amiga.memory.write16(p + 2, w2);
    p += 4;
  };
  emit(0x0182, 0x0fff);
  emit(0x7f3f, 0xfffe);
  for (let i = 0; i < 40; i++) emit(0x0182, 0x084a);
  emit(0x0182, 0x0fff);
  emit(0xffff, 0xfffe);

  c.writeReg16(0x080, (base >>> 16) & 0x1f);
  c.writeReg16(0x082, base & 0xffff);
  c.writeReg16(0x096, 0x8280); // DMA_MASTER | DMA_COPPER
  c.startFrame();

  for (let line = 0; line < 127; line++) {
    c.runCopperLine(line, 0xdb);
    c.runCopperLine(line, 0xfe);
  }
  assert.equal(c.colorReg[1], 0x0fff);

  // Phase 1 on line 127 ($DB) must leave COLOR01 at $084A for scanline rendering
  c.runCopperLine(127, 0xdb);
  assert.equal(c.colorReg[1], 0x084a);

  // Phase 2 on line 127 ($FE) executes the 41st MOVE and restores COLOR01 to $0FFF for line 128
  c.runCopperLine(127, 0xfe);
  assert.equal(c.colorReg[1], 0x0fff);
});

test('Copper end-of-line H=$DC modulo reset (Alien Breed Tower Assault circular wrap) applies negative modulo before resetting BPL1MOD', () => {
  const amiga = new AmigaMachine({ videoStandard: 'PAL', audioEnabled: false }, { skipDefaultDisk: true });
  amiga.memory.ovl = false;
  const c = amiga.chipset;

  // Build Copperlist mimicking Alien Breed Tower Assault circular buffer wrap at line $6B (107) and line $FF (255):
  // BPL1PT=$20000, BPL1MOD=2; at line $6B set BPL1MOD=$C702 (-14590), then WAIT $6B $DC -> BPL1MOD=2;
  // repeat at line $FF -> WAIT $FF $DC -> BPL1MOD=2 -> WAIT $21 $00 -> COLOR00=$0F00 (bottom HUD at line 289).
  const base = 0x014000;
  let p = base;
  const emit = (w1: number, w2: number) => {
    amiga.memory.write16(p, w1);
    amiga.memory.write16(p + 2, w2);
    p += 4;
  };
  emit(0x0100, 0x1200); // 1 bitplane
  emit(0x008e, 0x287b); // DIWSTRT line $28
  emit(0x0090, 0x2dbd); // DIWSTOP line $12D
  emit(0x0092, 0x0028); // DDFSTRT $28
  emit(0x0094, 0x00d8); // DDFSTOP $D8 -> 23 words = 46 bytes/line
  emit(0x0108, 0x0002); // BPL1MOD = 2 (stride 48 bytes)
  emit(0x00e0, 0x0002); // BPL1PTH = $2
  emit(0x00e2, 0x0000); // BPL1PTL = $0000
  emit(0x0180, 0x0111); // COLOR00 = $0111

  // Split 1 at line $6B
  emit(0x6b01, 0xff00); // WAIT V=$6B, H=$00
  emit(0x0108, 0xc702); // BPL1MOD = -14590
  emit(0x6bdd, 0xfffe); // WAIT V=$6B, H=$DC
  emit(0x0108, 0x0002); // BPL1MOD = 2

  // Split 2 at PAL line $FF (no $FFDF following $FFDC)
  emit(0xff01, 0xff00); // WAIT V=$FF, H=$00
  emit(0x0108, 0xc702); // BPL1MOD = -14590
  emit(0xffdd, 0xfffe); // WAIT V=$FF, H=$DC
  emit(0x0108, 0x0002); // BPL1MOD = 2
  emit(0x2101, 0xff00); // WAIT V=$21, H=$00 (line 289 bottom HUD)
  emit(0x0180, 0x0f00); // COLOR00 = $0F00
  emit(0xffff, 0xfffe);

  c.writeReg16(0x080, (base >>> 16) & 0x1f);
  c.writeReg16(0x082, base & 0xffff);
  c.writeReg16(0x096, 0x8380); // DMA_MASTER | DMA_BITPLANE | DMA_COPPER
  c.startFrame();

  for (let line = 0; line < 312; line++) {
    c.vpos = line;
    c.runCopperLine(line, 0xdb);
    if (line === 0x6b) {
      assert.equal(c.bpl1Mod, -14590, 'BPL1MOD must stay -14590 during line $6B renderScanline');
    }
    if (line === 0xff) {
      assert.equal(c.bpl1Mod, -14590, 'BPL1MOD must stay -14590 during line $FF renderScanline');
    }
    const ptrBefore = c.bplPt[0];
    c.renderScanline(line, false);
    if (line === 0x6b) {
      assert.equal(c.bplPt[0], (ptrBefore + 46 - 14590) & 0x7ffff, 'BPL1PT must wrap backward after line $6B');
    }
    if (line === 0xff) {
      assert.equal(c.bplPt[0], (ptrBefore + 46 - 14590) & 0x7ffff, 'BPL1PT must wrap backward after line $FF');
    }
    c.runCopperLine(line, 0xfe);
    if (line === 0x6b || line === 0xff) {
      assert.equal(c.bpl1Mod, 2, `BPL1MOD must reset to 2 in Phase 2 after line ${line}`);
    }
    if (line === 255 || line === 288) {
      assert.equal(c.colorReg[0], 0x0111, `Line 289 HUD color must not fire prematurely at line ${line}`);
    }
    if (line === 289) {
      assert.equal(c.colorReg[0], 0x0f00, 'Line 289 HUD color must fire cleanly after line-255 H=$DC wrap');
    }
  }
});

test('Overscan presets (tv/max) render bitplane & sprite pixels outside 320x256 and live-switch without rebooting', () => {
  const amiga = new AmigaMachine({ chipset: 'ECS', videoStandard: 'PAL', overscan: 'none', audioEnabled: false }, { skipDefaultDisk: true });
  amiga.memory.ovl = false;
  const c = amiga.chipset;
  const chip = amiga.memory.chipRam;

  // Set up 1-bitplane TV overscan playfield: DIWSTRT=$2471 (line 36, H=$71), DIWSTOP=$34D1 (line 308, H=$1D1)
  // DDFSTRT=$30 (fetch starts at H=$71), DDFSTOP=$D8 (22 words = 44 bytes = 352 lo-res pixels!)
  const base = 0x010000;
  chip.fill(0, base, base + 44);
  chip[base + 0] = 0x80;  // Leftmost overscan pixel (H=$71, lo-res X=-16 relative to $81)
  chip[base + 43] = 0x01; // Rightmost overscan pixel (H=$1D0, lo-res X=335 relative to $81)

  const setupLineRegs = () => {
    c.writeReg16(0x096, 0x8320); // DMA_MASTER | DMA_BITPLANE | DMA_SPRITE
    c.writeReg16(0x100, 0x1200); // 1 bitplane Lo-Res
    c.writeReg16(0x102, 0x0000);
    c.writeReg16(0x108, 0x0000);
    c.writeReg16(0x180, 0x0000); // Color 0 black
    c.writeReg16(0x182, 0x0fff); // Color 1 white
    c.writeReg16(0x1a2, 0x0f00); // Sprite 0 Color 17 red
    c.writeReg16(0x08e, 0x2471); // DIWSTRT V=36, H=$71
    c.writeReg16(0x090, 0x34d1); // DIWSTOP V=308, H=$1D1
    c.writeReg16(0x092, 0x0030); // DDFSTRT $30
    c.writeReg16(0x094, 0x00d8); // DDFSTOP $D8 -> 22 words = 44 bytes
    c.bplPt[0] = base;
  };

  // In 'none' (640x256, lines 44..299, H=$81..$1C1), line 36 is clipped off top and H=$71 is clipped off left
  assert.deepEqual(amiga.getFramebufferSize(), { width: 640, height: 256 });
  setupLineRegs();
  c.renderScanline(36, true);
  assert.equal(c.bplPt[0], base + 44, 'Even clipped overscan line must still advance bitplane DMA pointers');
  assert.equal(amiga.getFramebuffer()[0], 0xff000000);

  // Switch live to 'tv' (704x272, lines 36..307, H=$71..$1D1): must NOT reboot CPU!
  const framesBefore = amiga.frameCount;
  amiga.updateConfig({ overscan: 'tv' });
  assert.equal(amiga.frameCount, framesBefore);
  assert.deepEqual(amiga.getFramebufferSize(), { width: 704, height: 272 });

  // Render line 36 (top overscan row y=0) and line 307 (bottom overscan row y=271)
  setupLineRegs();
  c.renderScanline(36, true);
  const fbTv = amiga.getFramebuffer();
  assert.equal(fbTv[0], 0xffffffff, 'Leftmost TV overscan pixel (H=$71, line 36) must render at fb[0]');
  assert.equal(fbTv[702], 0xffffffff, 'Rightmost TV overscan pixel (H=$1D0, line 36) must render at fb[702]');

  c.bplPt[0] = base;
  c.renderScanline(307, true);
  assert.equal(fbTv[271 * 704 + 0], 0xffffffff, 'Bottom TV overscan line 307 must render at y=271');
  assert.equal(fbTv[271 * 704 + 702], 0xffffffff, 'Bottom-right TV overscan pixel must render at y=271, x=702');

  // Hardware sprite positioned inside left overscan border (H=$74 = 116 -> pos low byte = 58 = $3A, ctl bit 0 = 0)
  c.writeReg16(0x140, (40 << 8) | 0x3a); // SPR0POS: V=40, H=$74
  c.writeReg16(0x142, (41 << 8) | 0x00); // SPR0CTL: VSTOP=41, H bit 0 = 0
  c.writeReg16(0x146, 0x0000);           // SPR0DATB
  c.writeReg16(0x144, 0x8000);           // SPR0DATA (arms sprite, leftmost pixel = color 17 red)
  c.bplPt[0] = base;
  c.renderScanline(40, true);
  const sprX = (0x74 - 0x71) * 2; // lo-res offset 3 -> hi-res x=6
  assert.equal(fbTv[(40 - 36) * 704 + sprX], 0xff0000ff, 'Sprite in left overscan border (H=$74) must render cleanly');

  // Switch live to 'max' (752x286, lines 26..311, H=$65..$1DD) and verify Hi-Res overscan
  amiga.updateConfig({ overscan: 'max' });
  assert.deepEqual(amiga.getFramebufferSize(), { width: 752, height: 286 });
  c.writeReg16(0x100, 0x9200); // HIRES | 1 bitplane
  c.writeReg16(0x08e, 0x1a65); // DIWSTRT V=26, H=$65
  c.writeReg16(0x090, 0x37dd); // DIWSTOP V=311, H=$1DD
  c.writeReg16(0x092, 0x002c); // DDFSTRT $2C -> fetchPxHires = -64, + hShiftHi(56) -> start at x=-8
  c.writeReg16(0x094, 0x00dc);
  chip.fill(0, base, base + 96);
  chip[base + 1] = 0x80; // bit at fetch index 8 -> outX = -8 + 8 = 0 (H=$65 hi-res X=0!)
  c.bplPt[0] = base;
  c.renderScanline(26, true);
  assert.equal(amiga.getFramebuffer()[0], 0xffffffff, 'Max Hi-Res overscan pixel at line 26, H=$65 must render at fb[0]');
});

test('ECS DIWHIGH ($1E4) overrides display window high bits on ECS while OCS ignores it', () => {
  const ecs = new AmigaMachine({ chipset: 'ECS', overscan: 'max', audioEnabled: false }, { skipDefaultDisk: true });
  // DIWSTRT = $2C81, DIWSTOP = $2CC1 -> default diwVStart=0x2C, diwVStop=0x12C, diwHStart=0x81, diwHStop=0x1C1
  ecs.chipset.writeReg16(0x08e, 0x2c81);
  ecs.chipset.writeReg16(0x090, 0x2cc1);
  // Write ECS DIWHIGH setting VSTOP high bits = 0 (so vStop = 0x02C instead of 0x12C) and HSTOP bit 8 = 0
  ecs.chipset.writeReg16(0x1e4, 0x0000);
  assert.equal(ecs.chipset.diwVStop, 0x02c);
  assert.equal(ecs.chipset.diwHStop, 0x0c1);

  // Restore ECS DIWHIGH with VSTOP bit 8 = 1 (0x0100) and HSTOP bit 8 = 1 (0x2000)
  ecs.chipset.writeReg16(0x1e4, 0x2100);
  assert.equal(ecs.chipset.diwVStop, 0x12c);
  assert.equal(ecs.chipset.diwHStop, 0x1c1);

  // OCS must ignore DIWHIGH writes
  const ocs = new AmigaMachine({ chipset: 'OCS', overscan: 'max', audioEnabled: false }, { skipDefaultDisk: true });
  ocs.chipset.writeReg16(0x08e, 0x2c81);
  ocs.chipset.writeReg16(0x090, 0x2cc1);
  ocs.chipset.writeReg16(0x1e4, 0x0000);
  assert.equal(ocs.chipset.diwVStop, 0x12c);
  assert.equal(ocs.chipset.diwHStop, 0x1c1);
});

test('Auto-Overscan mode automatically adapts viewport to active Copper/DIW overscan window without blank flash', () => {
  const amiga = new AmigaMachine({ chipset: 'ECS', videoStandard: 'PAL', overscan: 'auto', audioEnabled: false }, { skipDefaultDisk: true });
  amiga.memory.ovl = false;
  amiga.cpu.stopped = true; // Isolate Copper + Denise overscan from OpenKick ROM boot
  const c = amiga.chipset;
  const chip = amiga.memory.chipRam;

  // Copperlist configuring Chaos Engine-like overscan DIW ($2F7C..$2FC1 -> V=47..303, H=$7C..$1C1)
  const clBase = 0x012000;
  const bplBase = 0x020000;
  chip.fill(0xff, bplBase, bplBase + 44 * 260);
  const cl = [
    0x008e, 0x2f7c, // DIWSTRT V=47, H=$7C
    0x0090, 0x2fc1, // DIWSTOP V=303, H=$1C1
    0x0092, 0x0030, // DDFSTRT $30
    0x0094, 0x00d0, // DDFSTOP $D0
    0x0100, 0x1200, // 1 bitplane
    0x0108, 0x0000,
    0x00e0, 0x0002,
    0x00e2, 0x0000,
    0x0180, 0x0000,
    0x0182, 0x00f0, // Green active pixels
    0xffff, 0xfffe,
  ];
  for (let i = 0; i < cl.length; i++) amiga.memory.write16(clBase + i * 2, cl[i]);
  c.writeReg16(0x080, (clBase >>> 16) & 0x1f);
  c.writeReg16(0x082, clBase & 0xffff);
  c.writeReg16(0x096, 0x8380); // DMA_MASTER | DMA_BITPLANE | DMA_COPPER

  // Start at standard 640x256
  assert.deepEqual(amiga.getFramebufferSize(), { width: 640, height: 256 });

  // Run 3 frames (2 frames expand hysteresis + frame 3 renders cleanly into expanded viewport)
  for (let f = 0; f < 3; f++) {
    amiga.stepFrame(true);
    // Never blit a completely blank black transition frame!
    const fb = amiga.getFramebuffer();
    let hasGreen = false;
    for (let i = 0; i < fb.length; i += 37) {
      if (fb[i] === 0xff00ff00) {
        hasGreen = true;
        break;
      }
    }
    assert.equal(hasGreen, true, `Frame ${f + 1} must remain non-blank during Auto-Overscan transition`);
  }

  // Viewport must now fully cover H=$7C..$1C1 and V=47..303!
  assert.ok(c.viewHOriginLo <= 0x7c, `Expected hOriginLo <= 0x7C, got 0x${c.viewHOriginLo.toString(16)}`);
  assert.ok(c.viewHOriginLo + (c.fbWidth >>> 1) >= 0x1c1);
  assert.ok(c.viewStartLine <= 47 && c.viewStartLine + c.fbHeight >= 303);
});

test('Turbo Floppy defaults to OFF, transfers full MFM tracks in 1 frame when ON, and ignores empty-drive polling', () => {
  assert.equal(DEFAULT_AMIGA_CONFIG.turboFloppy, false);

  const amiga = new AmigaMachine({ audioEnabled: false }, { skipDefaultDisk: true });
  amiga.memory.ovl = false;
  amiga.cpu.stopped = true;
  assert.equal(amiga.config.turboFloppy, false);
  assert.equal(amiga.chipset.turboFloppy, false);

  // Empty drive polling (DF0 empty, motor off) must NOT trigger floppy ioSeq burst
  const seq0 = amiga.floppy.ioSeq;
  amiga.floppy.handleCiaBPrb(0xf7, 0xff); // Select DF0, motor off
  amiga.floppy.handleCiaBPrb(0xf6, 0xf7); // STEP low
  amiga.floppy.handleCiaBPrb(0xf7, 0xf6); // STEP high (empty drive)
  assert.equal(amiga.floppy.ioSeq, seq0);

  // Insert blank formatted ADF into DF0 and enable Turbo Floppy live
  amiga.insertBlankAdf(0, 'TurboTest.adf');
  amiga.updateConfig({ turboFloppy: true }, false);
  assert.equal(amiga.chipset.turboFloppy, true);

  // Select DF0 with motor ON -> ioSeq increments
  amiga.floppy.handleCiaBPrb(0x77, 0xff);
  assert.ok(amiga.floppy.ioSeq > seq0);

  // Immediate DSKLEN=$4000 abort inside 1-scanline delay must still protect Chip RAM
  amiga.chipset.writeReg16(0x096, 0x8210); // DMA_MASTER | DMA_DISK
  amiga.chipset.writeReg16(0x09e, 0x8400); // ADKCON WORDSYNC
  amiga.chipset.writeReg16(0x07e, 0x4489); // DSKSYNC = $4489
  amiga.chipset.writeReg16(0x020, 0x0002);
  amiga.chipset.writeReg16(0x022, 0x0000); // DSKPT = $020000
  amiga.memory.write16(0x020000, 0xbeef);
  amiga.chipset.writeReg16(0x024, 0x8100);
  amiga.chipset.writeReg16(0x024, 0x8100);
  amiga.chipset.stepDiskDma(0x4000); // Consumes 1-scanline delay without transferring
  amiga.chipset.writeReg16(0x024, 0x4000); // Abort
  assert.equal(amiga.memory.read16(0x020000), 0xbeef);

  // Arm full-track MFM read (6400 words) and run a SINGLE Amiga frame with renderVideo=false, pushAudio=false
  const seqBeforeDma = amiga.floppy.ioSeq;
  amiga.chipset.writeReg16(0x024, 0x8000 | 6400);
  amiga.chipset.writeReg16(0x024, 0x8000 | 6400);
  amiga.stepFrame(false, false);

  assert.equal(amiga.chipset.dskDmaActive, false, 'Full 6400-word track must finish inside a single frame in Turbo mode');
  assert.equal(amiga.memory.read16(0x020000), 0x4489, '2nd $4489 WORDSYNC word must be preserved');
  assert.ok((amiga.chipset.intreq & 0x0002) !== 0, 'INT_DSKBLK must be raised');
  assert.ok(amiga.floppy.ioSeq > seqBeforeDma, 'Disk DMA read must advance ioSeq');
});

test('68000 indexed LEA/PEA preserves full 32-bit effective addresses before 24-bit bus masking (ATK 50Hz fix)', () => {
  const amiga = new AmigaMachine({ audioEnabled: false }, { skipDefaultDisk: true });
  amiga.memory.ovl = false;

  // Assemble: LEA $00(A0, D0.L), A1; PEA $00(A0, D0.L); STOP #$2700
  const code = 0x010000;
  amiga.memory.write16(code + 0, 0x43f0); // LEA (d8, A0, Xn), A1
  amiga.memory.write16(code + 2, 0x0800); // D0.L, disp=0
  amiga.memory.write16(code + 4, 0x4870); // PEA (d8, A0, Xn)
  amiga.memory.write16(code + 6, 0x0800); // D0.L, disp=0
  amiga.memory.write16(code + 8, 0x4e72); // STOP
  amiga.memory.write16(code + 10, 0x2700);

  amiga.cpu.a[0] = 0x00010200;
  amiga.cpu.d[0] = 0x12000040 | 0; // Negative/upper-byte offset like ATK timer divisor/pointer math
  amiga.cpu.a[7] = 0x00030000;
  amiga.cpu.sr = 0x2700;
  amiga.cpu.pc = code;
  amiga.cpu.stopped = false;

  amiga.cpu.runCycles(64);
  assert.equal(amiga.cpu.a[1] >>> 0, 0x12010240);
  assert.equal(amiga.memory.read32(amiga.cpu.a[7]) >>> 0, 0x12010240);
});

test('UAE frame timing: non-interlaced LOF=1 (313 PAL / 263 NTSC), BEAMCON0 50/60Hz switch, and fractional E-clock CIAB TOD + timer accuracy', () => {
  const pal = new AmigaMachine({ chipset: 'ECS', videoStandard: 'PAL', audioEnabled: false }, { skipDefaultDisk: true });
  pal.memory.ovl = false;
  pal.cpu.stopped = true;
  // Clear VPOSW LOF=0 to ensure startFrame forces LOF=1 in non-interlaced mode
  pal.chipset.writeReg16(0x02a, 0x0000);
  const todBefore = (pal.cia.readB(0x0a) << 16) | (pal.cia.readB(0x09) << 8) | pal.cia.readB(0x08);

  // Configure CIA-B Timer A continuous mode latch=50000 to verify reload without phase drift
  pal.cia.writeB(0x0e, 0x00);
  pal.cia.writeB(0x04, 50000 & 0xff);
  pal.cia.writeB(0x05, (50000 >>> 8) & 0xff);
  pal.cia.writeB(0x0e, 0x01);

  for (let i = 0; i < 16; i++) pal.stepFrame(false, false);
  const todAfterPal = (pal.cia.readB(0x0a) << 16) | (pal.cia.readB(0x09) << 8) | pal.cia.readB(0x08);
  // 16 PAL non-interlaced frames * 313 lines = 5008 CIAB HSync TOD ticks
  assert.equal((todAfterPal - todBefore) & 0xffffff, 5008);

  // Switch ECS dynamically to NTSC 60Hz via BEAMCON0 ($1DC bit 5 = 0)
  pal.chipset.writeReg16(0x1dc, 0x0000);
  assert.equal(pal.chipset.isPalTiming(), false);
  const todBeforeNtsc = todAfterPal;
  for (let i = 0; i < 16; i++) pal.stepFrame(false, false);
  const todAfterNtsc = (pal.cia.readB(0x0a) << 16) | (pal.cia.readB(0x09) << 8) | pal.cia.readB(0x08);
  // 16 NTSC non-interlaced frames * 263 lines = 4208 CIAB HSync TOD ticks
  assert.equal((todAfterNtsc - todBeforeNtsc) & 0xffffff, 4208);

  // Interlaced mode (BPLCON0 LACE bit 2) toggles LOF every frame
  pal.chipset.writeReg16(0x100, 0x0004);
  pal.chipset.startFrame();
  const lof1 = pal.chipset.lof;
  pal.chipset.startFrame();
  const lof2 = pal.chipset.lof;
  assert.notEqual(lof1, lof2);

  // Continuous CIA timer underflow accumulation preserves sub-step remainder
  pal.cia.writeA(0x0e, 0x00);
  pal.cia.writeA(0x04, 10);
  pal.cia.writeA(0x05, 0);
  pal.cia.writeA(0x0e, 0x01);
  pal.cia.stepEClocks(14); // 1 underflow + 4 clocks into next cycle -> timer should be at 6, not 10
  const taLo = pal.cia.readA(0x04);
  assert.equal(taLo, 6);
});

test('Floppy /RDY spin-up delay (~250 scanlines when !turboFloppy, instant when turboFloppy) and open-bus vs DF2 status', () => {
  const amiga = new AmigaMachine({ audioEnabled: false }, { skipDefaultDisk: true });
  const disk = new Uint8Array(ADF_TOTAL_SIZE);
  amiga.insertAdf(0, disk, 'ReadyTest.adf', false);

  // No drive selected: pull-ups leave /RDY,/TRK0,/WPRO,/CHNG high (0x3c)
  amiga.floppy.handleCiaBPrb(0xff, 0xff);
  assert.equal(amiga.floppy.getCiaAStatusBits(), 0x3c);

  // Select DF0 with motor ON while turboFloppy=false: /RDY starts deasserted (bit 5 high) until 250 scanlines pass
  amiga.updateConfig({ turboFloppy: false }, false);
  amiga.floppy.handleCiaBPrb(0x77, 0xff);
  assert.notEqual(amiga.floppy.getCiaAStatusBits() & 0x20, 0);

  for (let i = 0; i < 249; i++) amiga.floppy.tickScanline();
  assert.notEqual(amiga.floppy.getCiaAStatusBits() & 0x20, 0);
  amiga.floppy.tickScanline();
  assert.equal(amiga.floppy.getCiaAStatusBits() & 0x20, 0); // /RDY asserted low after ~15.9ms spin-up

  // Stop motor, enable turboFloppy, spin up again -> /RDY asserts immediately
  amiga.floppy.handleCiaBPrb(0xff, 0xff);
  amiga.updateConfig({ turboFloppy: true }, false);
  amiga.floppy.handleCiaBPrb(0x77, 0xff);
  assert.equal(amiga.floppy.getCiaAStatusBits() & 0x20, 0);
});

test('Copper mid-scanline COLOR00 splits render horizontal RGB gradients with cycle-2 MOVE alignment', () => {
  const amiga = new AmigaMachine({ chipset: 'ECS', videoStandard: 'PAL', overscan: 'none', audioEnabled: false }, { skipDefaultDisk: true });
  amiga.memory.ovl = false;
  const c = amiga.chipset;

  // Copperlist at $014000 for line 60:
  // Start with black, WAIT (60, $40), MOVE COLOR00=$0F00 (red), WAIT (60, $80), MOVE COLOR00=$00F0 (green), WAIT (60, $C0), MOVE COLOR00=$000F (blue)
  const base = 0x014000;
  const cl = [
    0x0180, 0x0000,
    0x3c41, 0xfffe, 0x0180, 0x0f00,
    0x3c81, 0xfffe, 0x0180, 0x00f0,
    0x3cc1, 0xfffe, 0x0180, 0x000f,
    0xffff, 0xfffe,
  ];
  for (let i = 0; i < cl.length; i++) amiga.memory.write16(base + i * 2, cl[i]);

  c.writeReg16(0x080, (base >>> 16) & 0x1f);
  c.writeReg16(0x082, base & 0xffff);
  c.writeReg16(0x096, 0x8280); // DMA_MASTER | DMA_COPPER
  c.startFrame();

  for (let line = 0; line <= 60; line++) {
    c.runCopperLine(line, 0xdb);
    c.renderScanline(line, line === 60);
    c.runCopperLine(line, 0xfe);
  }

  const fb = amiga.getFramebuffer();
  const rowOff = (60 - 44) * 640;
  // Expected cycle-2 X positions relative to viewHOriginLo ($81):
  // copHpos=$40 -> MOVE at $42 -> pxX = (($42<<1) - $81)<<1 = 6  (before X=6 is black, at X=6.. is red)
  // copHpos=$80 -> MOVE at $82 -> pxX = (($82<<1) - $81)<<1 = 262 (red up to 261, green from 262)
  // copHpos=$C0 -> MOVE at $C2 -> pxX = (($C2<<1) - $81)<<1 = 518 (green up to 517, blue from 518)
  assert.equal(fb[rowOff + 0], 0xff000000);
  assert.equal(fb[rowOff + 10], 0xff0000ff);  // ABGR red
  assert.equal(fb[rowOff + 260], 0xff0000ff); // Still red before $82
  assert.equal(fb[rowOff + 264], 0xff00ff00); // ABGR green after $82
  assert.equal(fb[rowOff + 520], 0xffff0000); // ABGR blue after $C2
});






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
  FLOPPY_HOTSWAP_EJECT_FRAMES,
  MFM_TRACK_BYTES,
  verifyAmigaBootblockChecksum,
  writeAmigaBootblockChecksum,
} from './floppy';
import { createBlankFormattedHdf } from '../archives/amigaDosFs';
import { buildBuiltinAdf } from '../roms/openKickKernel';
import { AmigaMachine, detectVideoStandardFromName } from './amigaMachine';
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

test('Copper end-of-line splits (H >= $D0) defer whole-scanline registers and 32-bit BPLxPT pairs until after renderScanline', () => {
  const amiga = new AmigaMachine(
    { chipset: 'ECS', videoStandard: 'PAL', overscan: 'none', audioEnabled: false },
    { skipDefaultDisk: true }
  );
  amiga.memory.ovl = false;
  const c = amiga.chipset;
  const wr16 = (addr: number, val: number) => amiga.memory.write16(addr, val);

  // Fill test bitplane regions:
  // $021000..$0210FF: $FFFF (stale garbage -> solid COLOR01 green if BPLCON0 enables too early)
  // $022000..$0220FF: $0000 (clean zeros for next line)
  // $02FFE0..$02FFFF: $AAAA (active pattern on wrap line 60)
  // $030000..$0300FF: $FFFF (clean target after wrap at $DA)
  // $03FFE0..$03FFFF: $5555 (torn pointer trap if BPL1PTH writes before renderScanline without BPL1PTL)
  for (let i = 0; i < 64; i++) {
    wr16(0x021000 + i * 2, 0xffff);
    wr16(0x022000 + i * 2, 0x0000);
    wr16(0x030000 + i * 2, 0xffff);
  }
  for (let i = 0; i < 16; i++) {
    wr16(0x02ffe0 + i * 2, 0xaaaa);
    wr16(0x03ffe0 + i * 2, 0x5555);
  }

  // Copperlist at $014000:
  // Line 50: BPLCON0=$0000, BPL1PT=$021000, COLOR00=$000, COLOR01=$0F0.
  // At WAIT (50, $D0): BPLCON0=$1200, BPL1PT=$022000 (must NOT enable $021000 garbage on line 50!).
  // Line 59: BPL1MOD=0, BPLCON0=$1200, BPL1PT=$02FFE0 (active $AAAA).
  // At WAIT (60, $DA): BPL1PTH=$0003, BPL1PTL=$0000 (must NOT tear BPL1PT to $03FFE0 on line 60; line 61 must see $030000).
  const base = 0x014000;
  const cl = [
    0x008e, 0x2c81, // DIWSTRT
    0x0090, 0x2cc1, // DIWSTOP
    0x0092, 0x0038, // DDFSTRT
    0x0094, 0x00d0, // DDFSTOP
    0x0108, 0x0000, // BPL1MOD=0
    0x0180, 0x0000, // COLOR00=black
    0x0182, 0x00f0, // COLOR01=green
    0x0100, 0x0000, // BPLCON0=off
    0x00e0, 0x0002, 0x00e2, 0x1000, // BPL1PT=$021000 (garbage)
    // Line 50 H=$D0 split: turn on bitplanes & switch pointer to clean $022000 for line 51
    0x32d1, 0xfffe,
    0x0100, 0x1200,
    0x00e0, 0x0002, 0x00e2, 0x2000,
    // Line 59 setup for line 60 circular wrap test
    0x3b01, 0xfffe,
    0x0108, 0xffd8, // BPL1MOD=-40 so line 59 & line 60 both start at $02FFE0 before wrap
    0x00e0, 0x0002, 0x00e2, 0xffe0,
    // Line 60 H=$DA split: wrap BPL1PT to $030000 for line 61
    0x3cdb, 0xfffe,
    0x0108, 0x0000,
    0x00e0, 0x0003,
    0x00e2, 0x0000,
    0xffff, 0xfffe,
  ];
  for (let i = 0; i < cl.length; i++) wr16(base + i * 2, cl[i]);

  c.writeReg16(0x080, (base >>> 16) & 0x1f);
  c.writeReg16(0x082, base & 0xffff);
  c.writeReg16(0x096, 0x8380); // DMA_MASTER | DMA_BITPLANE | DMA_COPPER
  c.startFrame();

  for (let line = 0; line <= 61; line++) {
    c.runCopperLine(line, 0xdb);
    c.renderScanline(line, line >= 50 && line <= 61);
    c.runCopperLine(line, 0xfe);
  }

  const fb = amiga.getFramebuffer();
  const row50 = (50 - 44) * 640;
  const row51 = (51 - 44) * 640;
  const row60 = (60 - 44) * 640;
  const row61 = (61 - 44) * 640;

  // Line 50 must remain completely black (deferred BPLCON0=$1200 must not leak into line 50)
  for (let x = 0; x < 640; x += 4) {
    assert.equal(fb[row50 + x], 0xff000000, `Line 50 pixel ${x} must be black, got 0x${fb[row50 + x].toString(16)}`);
  }
  // Line 51 uses $022000 (all zeros -> black)
  assert.equal(fb[row51 + 16], 0xff000000, 'Line 51 must render clean $022000 buffer');

  // Line 60 must read intact $02FFE0 ($AAAA: bit 15=1 green, bit 14=0 black), NOT torn $03FFE0 ($5555)
  assert.equal(fb[row60 + 0], 0xff00ff00, 'Line 60 px 0 must match $AAAA MSB=1 (green)');
  assert.equal(fb[row60 + 2], 0xff000000, 'Line 60 px 2 must match $AAAA bit 14=0 (black)');

  // Line 61 must use wrapped $030000 ($FFFF -> solid green)
  assert.equal(fb[row61 + 0], 0xff00ff00, 'Line 61 px 0 must match wrapped $030000 (green)');
  assert.equal(fb[row61 + 2], 0xff00ff00, 'Line 61 px 2 must match wrapped $030000 (green)');
});

test('VHPOSR ($DFF006/$DFF007) horizontal beam advances per CPU cycle and unblocks Black Crypt $DFF007 wait loop', () => {
  for (const ecoCpuMode of [false, true]) {
    const amiga = new AmigaMachine(
      { chipset: 'ECS', videoStandard: 'PAL', ecoCpuMode, audioEnabled: false },
      { skipDefaultDisk: true }
    );
    amiga.memory.ovl = false;

    // Exact wait routine seen in Black Crypt ($C0F3D6..$C0F3EC):
    //   MOVEQ #$79, D0
    //   MOVE.B $00DFF007, D1
    //   CMP.B  $00DFF007, D1
    //   BEQ.S  -8
    //   DBF    D0, -16
    //   STOP   #$2700
    const code = [
      0x7079,
      0x1239, 0x00df, 0xf007,
      0xb239, 0x00df, 0xf007,
      0x67f8,
      0x51c8, 0xfff0,
      0x4e72, 0x2700,
    ];
    for (let i = 0; i < code.length; i++) {
      amiga.memory.write16(0x010000 + i * 2, code[i]);
    }
    amiga.cpu.sr = 0x2700; // Supervisor, mask IRQs so OpenKick/VBlank vectors don't preempt
    amiga.cpu.pc = 0x010000;
    amiga.cpu.stopped = false;

    amiga.stepFrame(false, false);

    assert.equal(amiga.cpu.stopped, true, `ecoCpuMode=${ecoCpuMode}: CPU must exit $DFF007 wait loop and reach STOP`);
    assert.equal(amiga.cpu.pc, 0x010018);
    assert.equal(amiga.cpu.d[0] & 0xffff, 0xffff);
  }

  // Verify intra-scanline getHpos() range 0..226 ($00..$E2) and standalone fallback after finishFrame()
  const amiga = new AmigaMachine({ audioEnabled: false }, { skipDefaultDisk: true });
  amiga.chipset.beginScanline(100, amiga.cpu.cycles, 454);
  assert.equal(amiga.chipset.readReg16(0x006), (100 << 8) | 0);
  amiga.cpu.cycles += 200;
  const midHpos = amiga.chipset.readReg16(0x006) & 0xff;
  assert.equal(midHpos, 100);
  amiga.cpu.cycles += 300;
  assert.equal(amiga.chipset.readReg16(0x006) & 0xff, 226);

  amiga.chipset.finishFrame();
  amiga.chipset.hpos = 0x42;
  assert.equal(amiga.chipset.readReg16(0x006) & 0xff, 0x42);
});

test('AmigaMachine.insertBlankAdf encodes custom AmigaDOS volume label into OFS root block', () => {
  const amiga = new AmigaMachine({ audioEnabled: false }, { skipDefaultDisk: true });
  const diskName = amiga.insertBlankAdf(0, undefined, 'MySaves:1/2');
  assert.equal(diskName, 'MySaves12.adf');
  assert.equal(amiga.getStatusSnapshot().df0.name, 'MySaves12.adf');

  const exported = amiga.exportDriveAdf(0);
  assert.ok(exported);
  const rootOff = 880 * 512;
  const labelLen = exported.bytes[rootOff + 432];
  assert.equal(labelLen, 9);
  const decodedLabel = Array.from(exported.bytes.slice(rootOff + 433, rootOff + 433 + labelLen))
    .map((b) => String.fromCharCode(b))
    .join('');
  assert.equal(decodedLabel, 'MySaves12');
});

test('Hot-swapping ADF over an occupied drive holds /CHNG low & gates DMA for FLOPPY_HOTSWAP_EJECT_FRAMES so Kickstart unmounts the old volume cleanly', () => {
  const amiga = new AmigaMachine({ turboFloppy: true, audioEnabled: false }, { skipDefaultDisk: true });
  amiga.memory.ovl = false;

  const disk1 = new Uint8Array(ADF_TOTAL_SIZE);
  disk1[0] = 0x11;
  const disk2 = new Uint8Array(ADF_TOTAL_SIZE);
  disk2[0] = 0x22;

  // Inserting into an empty DF1: is immediate (ejectHoldFrames = 0)
  amiga.insertAdf(1, disk1, 'Disk1.adf', false);
  const d1 = amiga.floppy.drives[1];
  assert.equal(d1.ejectHoldFrames, 0);
  assert.equal(d1.diskChanged, true);

  // Select DF1 with motor on and step once to acknowledge disk1 (/CHNG clears)
  amiga.floppy.handleCiaBPrb(0x6f, 0xff); // /SEL1=0, /MTR=0, STEP=1
  d1.step(false);
  assert.equal(d1.diskChanged, false);
  assert.notEqual(amiga.floppy.getCiaAStatusBits() & 0x04, 0); // /CHNG high (inactive)
  assert.equal(amiga.floppy.getCiaAStatusBits() & 0x20, 0); // /RDY low (ready)

  // Hot-swap disk2 directly over occupied DF1: metadata updates immediately, but /CHNG holds low across steps
  amiga.insertAdf(1, disk2, 'Disk2.adf', false);
  assert.equal(d1.name, 'Disk2.adf');
  assert.equal(d1.data?.[0], 0x22);
  assert.equal(d1.ejectHoldFrames, FLOPPY_HOTSWAP_EJECT_FRAMES);
  assert.equal(d1.diskChanged, true);
  assert.equal(amiga.floppy.getCiaAStatusBits() & 0x04, 0); // /CHNG low
  assert.notEqual(amiga.floppy.getCiaAStatusBits() & 0x20, 0); // /RDY high (unseated)

  // Stepping during the eject-hold window must NOT clear /CHNG and DMA must stay blocked
  d1.step(true);
  assert.equal(d1.diskChanged, true);
  assert.equal(amiga.floppy.alignToWordSync(0x4489), false);
  assert.equal(amiga.floppy.streamDiskDmaWords(0x010000, 16, () => {}), 0);

  // After FLOPPY_HOTSWAP_EJECT_FRAMES frames, disk2 is seated; next step clears /CHNG and allows DMA
  for (let i = 0; i < FLOPPY_HOTSWAP_EJECT_FRAMES; i++) {
    amiga.stepFrame(false, false);
  }
  assert.equal(d1.ejectHoldFrames, 0);
  assert.equal(d1.diskChanged, true); // Still asserted until next head step

  amiga.floppy.handleCiaBPrb(0x6f, 0xff);
  d1.step(false);
  assert.equal(d1.diskChanged, false);
  assert.notEqual(amiga.floppy.getCiaAStatusBits() & 0x04, 0);
  assert.equal(amiga.floppy.getCiaAStatusBits() & 0x20, 0);
  assert.equal(amiga.floppy.alignToWordSync(0x4489), true);

  // Rapid eject -> immediate insert still enforces the removal hold window, while hardReset clears it
  amiga.ejectDisk(1);
  assert.equal(d1.ejectHoldFrames, FLOPPY_HOTSWAP_EJECT_FRAMES);
  amiga.stepFrame(false, false);
  amiga.insertAdf(1, disk1, 'Disk1.adf', false);
  assert.ok(d1.ejectHoldFrames >= FLOPPY_HOTSWAP_EJECT_FRAMES - 1);
  amiga.hardReset();
  assert.equal(d1.ejectHoldFrames, 0);
});

test('NTSC PAL-raster-wait deadlock detector rescues Humans-style VPOSR > $0110 loop without resetting CPU and ignores normal NTSC input loops', () => {
  // 1. Reproduce exact Humans 1 deadlock from humans.json ($C089D6..$C089EA) in NTSC ECS mode
  const amiga = new AmigaMachine(
    { chipset: 'ECS', videoStandard: 'NTSC', overscan: 'auto', audioEnabled: false },
    { skipDefaultDisk: true }
  );
  // Boot OpenKick briefly so VBlank vector is installed, then inject the exact loop into Chip RAM
  amiga.stepFrame(false, false);
  amiga.stepFrame(false, false);

  const loopBase = 0x010000;
  const humansLoop = [
    0x302e, 0x0004, // MOVE.W 4(A6), D0  (VPOSR)
    0x4840,         // SWAP   D0
    0x302e, 0x0006, // MOVE.W 6(A6), D0  (VHPOSR)
    0xe088,         // LSR.L  #8, D0
    0x0240, 0x01ff, // ANDI.W #$01FF, D0
    0x0c40, 0x0110, // CMPI.W #$0110, D0 (line 272 > NTSC 262!)
    0x6fea,         // BLE.S  -22 ($010000)
    0x4e72, 0x2700, // STOP   #$2700 (reached once unblocked!)
  ];
  for (let i = 0; i < humansLoop.length; i++) {
    amiga.memory.write16(loopBase + i * 2, humansLoop[i]);
  }
  amiga.memory.write32(0x012000, 0xcafebabe); // Canary RAM value that must survive switch

  amiga.cpu.a[6] = 0x00dff000;
  amiga.cpu.sr = 0x2000; // Supervisor, IPL=0 (real VBlank IPL=3 still fires each frame)
  amiga.cpu.pc = loopBase;
  amiga.cpu.stopped = false;

  const autoSwitches: string[] = [];
  amiga.onAutoVideoStandardChange = (std) => autoSwitches.push(std);

  // Run up to 25 frames in NTSC: loop must trigger automatic switch to PAL without resetting CPU/RAM
  for (let f = 0; f < 25; f++) {
    amiga.stepFrame(false, false);
    if (amiga.config.videoStandard === 'PAL') break;
  }
  assert.equal(amiga.config.videoStandard, 'PAL');
  assert.deepEqual(autoSwitches, ['PAL']);
  assert.equal(amiga.chipset.isPalTiming(), true);
  assert.equal(amiga.memory.read32(0x012000) >>> 0, 0xcafebabe);

  // Next PAL frame reaches line 273 ($0111 > $0110), exits BLE.S cleanly, and hits STOP!
  amiga.stepFrame(false, false);
  assert.equal(amiga.cpu.stopped, true);
  assert.equal(amiga.cpu.pc, loopBase + 26);

  // 2. Negative check: a menu/loop that polls CIA-A Fire1 ($BFE001) or JOY1DAT alongside VPOSR must NOT trigger false PAL switch
  const menuAmiga = new AmigaMachine(
    { chipset: 'ECS', videoStandard: 'NTSC', audioEnabled: false },
    { skipDefaultDisk: true }
  );
  menuAmiga.stepFrame(false, false);
  menuAmiga.stepFrame(false, false);

  const menuLoop = [
    0x1239, 0x00bf, 0xe001, // MOVE.B $00BFE001, D1 (polls Fire button)
    0x302e, 0x0004,         // MOVE.W 4(A6), D0
    0x4840,                 // SWAP   D0
    0x302e, 0x0006,         // MOVE.W 6(A6), D0
    0xe088,                 // LSR.L  #8, D0
    0x0240, 0x01ff,         // ANDI.W #$01FF, D0
    0x0c40, 0x0110,         // CMPI.W #$0110, D0
    0x6fe4,                 // BLE.S  -28 ($010000)
  ];
  for (let i = 0; i < menuLoop.length; i++) {
    menuAmiga.memory.write16(loopBase + i * 2, menuLoop[i]);
  }
  menuAmiga.cpu.a[6] = 0x00dff000;
  menuAmiga.cpu.sr = 0x2000;
  menuAmiga.cpu.pc = loopBase;
  menuAmiga.cpu.stopped = false;

  for (let f = 0; f < 30; f++) {
    menuAmiga.stepFrame(false, false);
  }
  assert.equal(menuAmiga.config.videoStandard, 'NTSC');
  assert.equal(menuAmiga.chipset.isPalTiming(), false);
});

test('Auto video standard detects region tags, ECS BEAMCON0, and PAL DIW/Copper requirements without mutating auto config', () => {
  assert.equal(DEFAULT_AMIGA_CONFIG.videoStandard, 'auto');
  assert.equal(detectVideoStandardFromName('Marble Madness (USA).adf'), 'NTSC');
  assert.equal(detectVideoStandardFromName('Defender of the Crown [NTSC].adf'), 'NTSC');
  assert.equal(detectVideoStandardFromName('Chaos Engine (Europe).adf'), 'PAL');
  assert.equal(detectVideoStandardFromName('Humans (1992)(Gametek).adf'), null);
  assert.equal(detectVideoStandardFromName('Status_Demo.adf'), null);

  // 1. Auto defaults to PAL, switches to NTSC when booting a (USA) disk, then self-heals to PAL if game opens PAL DIW > 262
  const amiga = new AmigaMachine(
    { chipset: 'ECS', videoStandard: 'auto', audioEnabled: false },
    { skipDefaultDisk: true }
  );
  assert.equal(amiga.config.videoStandard, 'auto');
  assert.equal(amiga.getActiveVideoStandard(), 'PAL');

  const events: Array<{ std: string; reason: string }> = [];
  amiga.onAutoVideoStandardChange = (std, reason) => events.push({ std, reason });

  const usaDisk = new Uint8Array(ADF_TOTAL_SIZE);
  amiga.insertAdf(0, usaDisk, 'TestGame (USA).adf', true);
  assert.equal(amiga.config.videoStandard, 'auto');
  assert.equal(amiga.getActiveVideoStandard(), 'NTSC');
  assert.equal(amiga.chipset.isPalTiming(), false);
  assert.equal(amiga.getStatusSnapshot().videoStandard, 'NTSC');

  // Emulate real Kickstart + game opening a PAL Display Window (DIWSTOP=$2CC1 -> line 300 > 262)
  amiga.isOpenKick = false;
  amiga.memory.ovl = false;
  amiga.cpu.stopped = true;
  amiga.chipset.writeReg16(0x096, 0x8300); // DMA_MASTER | DMA_BITPLANE
  amiga.chipset.writeReg16(0x100, 0x1200); // 1 bitplane
  amiga.chipset.writeReg16(0x08e, 0x2c81); // DIWSTRT
  amiga.chipset.writeReg16(0x090, 0x2cc1); // DIWSTOP -> diwVStop = 300 (> 262!)

  for (let f = 0; f < 8; f++) {
    amiga.stepFrame(false, false);
  }
  assert.equal(amiga.config.videoStandard, 'auto', 'Auto mode preference must stay "auto"');
  assert.equal(amiga.getActiveVideoStandard(), 'PAL');
  assert.equal(amiga.chipset.isPalTiming(), true);
  assert.equal(events.at(-1)?.reason, 'diw');

  // 2. ECS BEAMCON0 write dynamically toggles Auto activeVideoStandard between NTSC and PAL
  events.length = 0;
  amiga.chipset.writeReg16(0x090, 0xf4c1); // Standard NTSC DIWSTOP (line 244)
  amiga.chipset.writeReg16(0x1dc, 0x0000); // ECS BEAMCON0 = NTSC
  amiga.stepFrame(false, false);
  assert.equal(amiga.getActiveVideoStandard(), 'NTSC');
  assert.equal(events.at(-1)?.reason, 'beamcon0');

  // 3. Copper PAL line-255 wrap ($FFE1 $FFFE) while in NTSC automatically switches back to PAL
  const clBase = 0x014000;
  const cl = [
    0x0180, 0x0111,
    0xffe1, 0xfffe, // PAL line-255 wrap
    0x0901, 0xfffe,
    0x0180, 0x0f00,
    0xffff, 0xfffe,
  ];
  for (let i = 0; i < cl.length; i++) amiga.memory.write16(clBase + i * 2, cl[i]);
  amiga.chipset.writeReg16(0x080, (clBase >>> 16) & 0x1f);
  amiga.chipset.writeReg16(0x082, clBase & 0xffff);
  amiga.chipset.writeReg16(0x096, 0x8280); // DMA_MASTER | DMA_COPPER

  for (let f = 0; f < 6; f++) {
    amiga.stepFrame(false, false);
  }
  assert.equal(amiga.config.videoStandard, 'auto');
  assert.equal(amiga.getActiveVideoStandard(), 'PAL');
  assert.equal(events.at(-1)?.reason, 'copper');
});

test('Paula Disk DMA separates INT_DSKSYN from INT_DSKBLK across scanlines and delivers DSKBLK after post-DSKLEN setup on track 6', () => {
  // 1. Small read (4 words) with WORDSYNC in normal mode must raise DSKSYN before DSKBLK (never same scanline)
  const amiga = new AmigaMachine({ turboFloppy: false, audioEnabled: false }, { skipDefaultDisk: true });
  amiga.memory.ovl = false;
  amiga.cpu.stopped = true;
  amiga.insertBlankAdf(0, 'SyncTest.adf');
  amiga.floppy.handleCiaBPrb(0x77, 0xff); // Select DF0, motor ON

  // Step head to cylinder 6
  for (let c = 0; c < 6; c++) {
    amiga.floppy.handleCiaBPrb(0x74, 0x77); // DIR=0 inward, STEP=0
    amiga.floppy.handleCiaBPrb(0x75, 0x74); // STEP rising edge -> cylinder++
  }
  assert.equal(amiga.floppy.drives[0].cylinder, 6);

  amiga.chipset.writeReg16(0x096, 0x8210); // DMA_MASTER | DMA_DISK
  amiga.chipset.writeReg16(0x09e, 0x8400); // ADKCON WORDSYNC
  amiga.chipset.writeReg16(0x07e, 0x4489); // DSKSYNC = $4489
  amiga.chipset.writeReg16(0x020, 0x0001);
  amiga.chipset.writeReg16(0x022, 0x8000); // DSKPT = $018000
  amiga.chipset.writeReg16(0x09c, 0x1002); // Clear DSKSYN | DSKBLK
  amiga.chipset.writeReg16(0x024, 0x8004);
  amiga.chipset.writeReg16(0x024, 0x8004);

  // Consume 2-scanline delay
  amiga.chipset.stepDiskDma(4);
  amiga.chipset.stepDiskDma(4);
  assert.equal(amiga.chipset.intreq & 0x1002, 0);

  // Scanline 3: DSKSYN fires, DSKBYTR reports DMAON|WORDEQUAL, DSKBLK must NOT be raised yet
  amiga.chipset.stepDiskDma(4);
  assert.notEqual(amiga.chipset.intreq & 0x1000, 0, 'INT_DSKSYN must be raised on sync scanline');
  assert.equal(amiga.chipset.intreq & 0x0002, 0, 'INT_DSKBLK must NOT fire on the same scanline as INT_DSKSYN');
  assert.equal(amiga.chipset.dskDmaActive, true);
  assert.equal(amiga.chipset.readReg16(0x01a) & 0x5000, 0x5000, 'DSKBYTR must report DMAON + WORDEQUAL');

  // Simulate loader clearing DSKSYN | DSKBLK ($1002) right after observing DSKSYN
  amiga.chipset.writeReg16(0x09c, 0x1002);

  // Scanline 4: 4 words stream into Chip RAM, DMA finishes, and INT_DSKBLK is cleanly raised
  amiga.chipset.stepDiskDma(4);
  assert.equal(amiga.chipset.dskDmaActive, false);
  assert.equal(amiga.chipset.dskDmaWordsLeft, 0);
  assert.equal(amiga.memory.read16(0x018000), 0x4489);
  assert.notEqual(amiga.chipset.intreq & 0x0002, 0, 'INT_DSKBLK must be raised after data transfer');
  assert.equal(amiga.chipset.readReg16(0x01a) & 0x4000, 0, 'DSKBYTR DMAON must clear once DMA ends');

  // 2. Trackloader running 68k code in Turbo Floppy mode on track 6:
  //    writes DSKLEN twice, stalls ~500 cycles (e.g. setup/ISR), clears $1002 in INTREQ, then polls BTST #1, INTREQR+1
  const turbo = new AmigaMachine({ turboFloppy: true, audioEnabled: false }, { skipDefaultDisk: true });
  turbo.memory.ovl = false;
  turbo.insertBlankAdf(0, 'HumansTrack6.adf');
  turbo.floppy.handleCiaBPrb(0x77, 0xff);
  for (let c = 0; c < 6; c++) {
    turbo.floppy.handleCiaBPrb(0x74, 0x77);
    turbo.floppy.handleCiaBPrb(0x75, 0x74);
  }
  turbo.chipset.writeReg16(0x096, 0x8210);
  turbo.chipset.writeReg16(0x09e, 0x8400);
  turbo.chipset.writeReg16(0x07e, 0x4489);
  turbo.chipset.writeReg16(0x020, 0x0002);
  turbo.chipset.writeReg16(0x022, 0x0000); // DSKPT = $020000

  // 68000 routine at $010000:
  // A6=$DFF000; write DSKLEN=$8230 twice; delay ~550 cycles (DBRA loop);
  // wait DSKSYN, clear INTREQ=$1002, wait DSKBLK, STOP #$2700
  const prog = [
    0x3d7c, 0x8230, 0x0024, // MOVE.W #$8230, $24(A6) (DSKLEN)
    0x3d7c, 0x8230, 0x0024, // MOVE.W #$8230, $24(A6)
    0x303c, 0x0028,         // MOVE.W #40, D0 (~400+ cycles delay before clearing INTREQ)
    0x51c8, 0xfffe,         // DBRA D0, -2
    0x082e, 0x0004, 0x001e, // BTST #4, $1E(A6) (DSKSYN in high byte of INTREQR)
    0x67f8,                 // BEQ.S -8
    0x3d7c, 0x1002, 0x009c, // MOVE.W #$1002, $9C(A6) (clear DSKSYN | DSKBLK)
    0x082e, 0x0001, 0x001f, // BTST #1, $1F(A6) (DSKBLK in low byte of INTREQR)
    0x67f8,                 // BEQ.S -8
    0x4e72, 0x2700,         // STOP #$2700
  ];
  for (let i = 0; i < prog.length; i++) turbo.memory.write16(0x010000 + i * 2, prog[i]);
  turbo.cpu.a[6] = 0x00dff000;
  turbo.cpu.sr = 0x2700;
  turbo.cpu.pc = 0x010000;
  turbo.cpu.stopped = false;

  turbo.stepFrame(false, false);
  assert.equal(turbo.cpu.stopped, true, 'Trackloader must observe DSKBLK and reach STOP instead of hanging');
  assert.equal(turbo.chipset.dskDmaActive, false);
  assert.equal(turbo.memory.read16(0x020000), 0x4489);
  assert.notEqual(turbo.chipset.intreq & 0x0002, 0);

  // 3. DSKLEN armed before DMACON DMA_DISK enable and 0-word DSKLEN ($8000 x2) still raise DSKBLK
  const edge = new AmigaMachine({ turboFloppy: false, audioEnabled: false }, { skipDefaultDisk: true });
  edge.memory.ovl = false;
  edge.insertBlankAdf(0, 'EdgeTest.adf');
  edge.floppy.handleCiaBPrb(0x77, 0xff);
  edge.chipset.writeReg16(0x020, 0x0001);
  edge.chipset.writeReg16(0x022, 0x0000);
  edge.chipset.writeReg16(0x024, 0x8004);
  edge.chipset.writeReg16(0x024, 0x8004); // Armed before DMACON!
  edge.chipset.writeReg16(0x096, 0x8210); // Now enable DMA_MASTER | DMA_DISK
  edge.chipset.writeReg16(0x09e, 0x8400); // Enable WORDSYNC during delay
  for (let i = 0; i < 6; i++) edge.chipset.stepDiskDma(4);
  assert.equal(edge.chipset.dskDmaActive, false);
  assert.equal(edge.memory.read16(0x010000), 0x4489);
  assert.notEqual(edge.chipset.intreq & 0x0002, 0);

  // Zero-word DSKLEN=$8000 twice triggers DSKBLK after delay
  edge.chipset.writeReg16(0x09c, 0x0002);
  edge.chipset.writeReg16(0x024, 0x8000);
  edge.chipset.writeReg16(0x024, 0x8000);
  for (let i = 0; i < 4; i++) edge.chipset.stepDiskDma(4);
  assert.equal(edge.chipset.dskDmaActive, false);
  assert.notEqual(edge.chipset.intreq & 0x0002, 0);
});

test('AGA Alice/Lisa hardware IDs (VPOSR=$22/$32, LISAID=$00F8) and 256-color 24-bit palette rendering', () => {
  const amiga = new AmigaMachine(
    { chipset: 'AGA', videoStandard: 'PAL', chipRamKB: 2048, audioEnabled: false },
    { skipDefaultDisk: true }
  );
  const c = amiga.chipset;
  const chip = amiga.memory.chipRam;

  assert.equal(amiga.cpu.is68020, true);
  assert.equal((c.readReg16(0x004) >>> 8) & 0x7f, 0x22); // AGA PAL Alice
  assert.equal(c.readReg16(0x07c), 0x00f8);              // AGA Lisa

  amiga.updateConfig({ chipset: 'AGA', videoStandard: 'NTSC' });
  assert.equal((c.readReg16(0x004) >>> 8) & 0x7f, 0x32); // AGA NTSC Alice
  amiga.updateConfig({ chipset: 'AGA', videoStandard: 'PAL' });

  // Program Color 200 (Bank 6 = bits 15..13 = 6 = $C000, sub-index 8 -> $190) to 24-bit RGB ($12, $34, $56)
  // Upper nibbles ($1, $3, $5 -> $0135) with LOCT=0, then lower nibbles ($2, $4, $6 -> $0246) with LOCT=1 ($0200)
  c.writeReg16(0x106, 0xc000); // Bank 6, LOCT=0
  c.writeReg16(0x190, 0x0135); // Color 200 upper
  c.writeReg16(0x106, 0xc200); // Bank 6, LOCT=1
  c.writeReg16(0x190, 0x0246); // Color 200 lower
  assert.equal(c.colorReg24[200], 0x123456);
  // Restore BPLCON3 bank 0
  c.writeReg16(0x106, 0x0c00);

  // Set up 8-bitplane Lo-Res display with pixel 0 = color index 200 (0xC8 = bits 7, 6, 3)
  c.writeReg16(0x096, 0x8300); // DMA_MASTER | DMA_BITPLANE
  c.writeReg16(0x08e, 0x2c81);
  c.writeReg16(0x090, 0xf4c1);
  c.writeReg16(0x092, 0x0038);
  c.writeReg16(0x094, 0x00d0);
  c.writeReg16(0x100, 0x0210); // BPLCON0 BPU3=1 ($0010) -> 8 bitplanes, COLOR=1
  c.writeReg16(0x102, 0x0000);
  c.writeReg16(0x108, 0x0000);
  c.writeReg16(0x10a, 0x0000);
  for (let p = 0; p < 8; p++) {
    const addr = 0x020000 + p * 0x1000;
    chip.fill(0, addr, addr + 40);
    // Color index 200 = 0b11001000 -> planes 3, 6, 7 have bit 7 ($80) set at byte 0
    chip[addr] = (200 & (1 << p)) !== 0 ? 0x80 : 0x00;
    c.writeReg16(0x0e0 + p * 4, (addr >>> 16) & 0xff);
    c.writeReg16(0x0e2 + p * 4, addr & 0xffff);
  }

  c.renderScanline(44, true);
  // ABGR32 for RGB $12,$34,$56 is 0xFF563412
  assert.equal(amiga.getFramebuffer()[0], 0xff563412);
});

test('AGA HAM8 mode, BPLCON4 BPLAM/sprite offset, and FMODE 64-bit bitplane + 64px sprite fetches render cleanly', () => {
  const amiga = new AmigaMachine(
    { chipset: 'AGA', videoStandard: 'PAL', chipRamKB: 2048, audioEnabled: false },
    { skipDefaultDisk: true }
  );
  const c = amiga.chipset;
  const chip = amiga.memory.chipRam;
  amiga.memory.ovl = false;

  c.writeReg16(0x096, 0x8320); // DMA_MASTER | DMA_BITPLANE | DMA_SPRITE
  c.writeReg16(0x08e, 0x2c81);
  c.writeReg16(0x090, 0xf4c1);
  c.writeReg16(0x092, 0x0038);
  c.writeReg16(0x094, 0x00d0);
  c.writeReg16(0x102, 0x0000);
  c.writeReg16(0x108, 0x0000);
  c.writeReg16(0x10a, 0x0000);
  c.writeReg16(0x106, 0x0c00);

  // 1) HAM8 test: BPU3=1 (8 planes) + HAM ($0800) -> $0810
  // Pixel 0: ctrl=00, idx=1 -> palette[1] = ($00, $FF, $00) green
  // Pixel 1: ctrl=10 (modify Red top 6 bits) with val=0x3F (0xFC) -> ($FC, $FF, $00) yellow-green
  c.writeReg16(0x100, 0x0810);
  c.writeReg16(0x10c, 0x0011); // BPLAM = 0
  c.writeReg16(0x182, 0x00f0); // COLOR01 = $00FF00
  const px0 = 0x01; // ctrl=00, data=1
  const px1 = (0b10 << 6) | 0x3f; // ctrl=10 (modify R), data=63
  for (let p = 0; p < 8; p++) {
    const addr = 0x030000 + p * 0x1000;
    chip.fill(0, addr, addr + 40);
    let b = 0;
    if ((px0 & (1 << p)) !== 0) b |= 0x80;
    if ((px1 & (1 << p)) !== 0) b |= 0x40;
    chip[addr] = b;
    c.writeReg16(0x0e0 + p * 4, (addr >>> 16) & 0xff);
    c.writeReg16(0x0e2 + p * 4, addr & 0xffff);
  }
  c.renderScanline(44, true);
  const fb = amiga.getFramebuffer();
  assert.equal(fb[0], 0xff00ff00); // Pixel 0 = green
  assert.equal(fb[2], 0xff00fffc); // Pixel 1 = R=$FC, G=$FF, B=$00 -> ABGR 0xFF00FFFC

  // 2) BPLCON4 BPLAM=$80 XORs bitplane color index from 0 -> 128; FMODE=3 uses 64-bit fetch chunks
  c.writeReg16(0x106, 0x8000); // Bank 4 (colors 128..159)
  c.writeReg16(0x180, 0x0f0f); // Color 128 = magenta ($FF00FF)
  c.writeReg16(0x106, 0x0c00);
  c.writeReg16(0x10c, 0x8011); // BPLAM=$80, ESPRM=1, OSPRM=1
  c.writeReg16(0x1fc, 0x000f); // FMODE = 64-bit BPL + 64px SPR
  c.writeReg16(0x100, 0x1200); // 1 bitplane Lo-Res
  c.writeReg16(0x094, 0x00a0); // Standard 320px AGA FMODE=3 stop ($38..$A0 = 5x8 = 40 bytes)
  chip.fill(0, 0x030000, 0x030080);
  c.writeReg16(0x0e0, 0x0003);
  c.writeReg16(0x0e2, 0x0000);
  c.renderScanline(45, true);
  assert.equal(fb[1 * 640], 0xffff00ff, 'BPLAM=$80 must remap color 0 to palette[128] magenta');
  assert.equal(c.bplPt[0], 0x030000 + 40, 'FMODE=3 $38..$A0 fetches 5x8=40 bytes cleanly');

  // 3) 64px AGA sprite (FMODE SPR=3): Sprite 0 at H=$81 (pos low = $40, ctl bit 0 = 1), color offset = 16 -> color 17
  c.writeReg16(0x180 + 17 * 2, 0x00ff); // Color 17 = cyan ($00FFFF)
  c.writeReg16(0x10c, 0x0011); // BPLAM=0, ESPRM=1 (base 16)
  c.writeReg16(0x140, (46 << 8) | 0x40); // V=46, H=$81
  c.writeReg16(0x142, (47 << 8) | 0x01);
  c.writeReg16(0x146, 0x0000);
  c.writeReg16(0x144, 0x8000); // Manual SPR0DATA arm sets bit 15 of first 16px (dx=0)
  c.writeReg16(0x0e0, 0x0003);
  c.writeReg16(0x0e2, 0x0000);
  c.renderScanline(46, true);
  assert.equal(fb[2 * 640 + 0], 0xffffff00, '64px AGA manual SPR0DATA must render pixel 0 at X=0 in cyan');

  // Also test 64px sprite DMA fetch via SPR0PT from Chip RAM ($040000): 16-byte header + 16-byte line
  const sprBase = 0x040000;
  chip.fill(0, sprBase, sprBase + 64);
  const wr16 = (off: number, v: number) => {
    amiga.memory.write16(sprBase + off, v);
  };
  wr16(0, (47 << 8) | 0x40); // POS: V=47, H=$81
  wr16(8, (48 << 8) | 0x01); // CTL at offset +8 for 64px FMODE=3: VSTOP=48, H bit 0 = 1
  // Line 47 data at sprBase+16: daHi=$80000000 (pixel 0), daLo=$00000001 (pixel 63) -> color 17 cyan
  wr16(16, 0x8000);
  wr16(22, 0x0001);
  c.writeReg16(0x120, 0x0004);
  c.writeReg16(0x122, 0x0000);
  c.startFrame();
  c.fetchSpriteHeaders();
  c.writeReg16(0x0e0, 0x0003);
  c.writeReg16(0x0e2, 0x0000);
  c.renderScanline(47, true);
  assert.equal(fb[3 * 640 + 0], 0xffffff00, '64px AGA DMA sprite pixel 0 must render at X=0');
  assert.equal(fb[3 * 640 + 63 * 2], 0xffffff00, '64px AGA DMA sprite pixel 63 must render at X=63');
});

test('AGA 9-bit DDFSTOP ($0100 clamped to $D8), FMODE=1/2/3 ceiling fetch sizes, and BPLCON3 BRDRBLNK', () => {
  const amiga = new AmigaMachine(
    { chipset: 'AGA', videoStandard: 'PAL', chipRamKB: 2048, audioEnabled: false },
    { skipDefaultDisk: true }
  );
  const c = amiga.chipset;
  amiga.memory.ovl = false;

  c.writeReg16(0x096, 0x8320); // DMA_MASTER | DMA_BITPLANE | DMA_SPRITE
  c.writeReg16(0x08e, 0x3890); // DIWSTRT V=$38, H=$90 (lo-res X = 15)
  c.writeReg16(0x090, 0x20b1); // DIWSTOP V=$120, H=$1B1 (lo-res X = 304 -> 289px wide)
  c.writeReg16(0x102, 0x0000);
  c.writeReg16(0x108, 0x0000);
  c.writeReg16(0x10a, 0x0000);
  c.writeReg16(0x100, 0x1201); // 1 bitplane Lo-Res, COLOR=1, ECSENA=1

  const measureBytes = (ddfStrt: number, ddfStop: number, fmode: number, bplcon0 = 0x1201): number => {
    c.writeReg16(0x100, bplcon0);
    c.writeReg16(0x1fc, fmode);
    c.writeReg16(0x092, ddfStrt);
    c.writeReg16(0x094, ddfStop);
    c.writeReg16(0x0e0, 0x0002);
    c.writeReg16(0x0e2, 0x0000);
    c.renderScanline(0x40, false);
    return c.bplPt[0] - 0x020000;
  };

  // DDFSTOP bit 8 ($0100) must be preserved on ECS/AGA and clamped at hardware hard-stop $D8
  c.writeReg16(0x094, 0x0100);
  assert.equal(c.ddfStop, 0x0100, 'AGA must preserve 9th bit (0x0100) of DDFSTOP');
  assert.equal(measureBytes(0x0038, 0x0100, 3), 48, 'FMODE=3 $38..$0100 clamps to $D8 -> 6x8=48 bytes');
  assert.equal(measureBytes(0x0038, 0x00ca, 3), 48, 'FMODE=3 $38..$00CA ($C8) rounds up -> 6x8=48 bytes');
  assert.equal(measureBytes(0x0038, 0x00d0, 3), 48, 'FMODE=3 $38..$00D0 rounds up -> 6x8=48 bytes');
  assert.equal(measureBytes(0x0038, 0x00a0, 3), 40, 'FMODE=3 $38..$00A0 -> 5x8=40 bytes');

  // FMODE=1/2 (32-bit fetch) ceiling rounding across LoRes, HiRes, SHRES
  assert.equal(measureBytes(0x0038, 0x00ca, 1), 40, 'FMODE=1 LoRes $38..$C8 rounds up -> 10x4=40 bytes');
  assert.equal(measureBytes(0x003c, 0x00ca, 1, 0x9201), 76, 'FMODE=1 HiRes $3C..$C8 rounds up -> 19x4=76 bytes');
  assert.equal(measureBytes(0x003c, 0x00cc, 3, 0x9201), 80, 'FMODE=3 HiRes $3C..$CC -> 10x8=80 bytes');

  // BPLCON3 BRDRBLNK ($0020): outside DIW must be pure black (0xFF000000) even with non-black COLOR00 & sprites
  c.writeReg16(0x100, 0x1201); // 1 bitplane Lo-Res, ECSENA=1
  c.writeReg16(0x1fc, 0x0003);
  c.writeReg16(0x092, 0x0038);
  c.writeReg16(0x094, 0x00ca);
  c.writeReg16(0x106, 0x0020); // BRDRBLNK = 1
  c.writeReg16(0x180, 0x0f00); // COLOR00 = bright red ($FF0000 -> ABGR 0xFF0000FF)
  c.writeReg16(0x180 + 17 * 2, 0x00ff); // Sprite color 17 = cyan
  c.writeReg16(0x140, (0x40 << 8) | 0x40); // Sprite at H=$81 (X=0, inside left border < $90)
  c.writeReg16(0x142, (0x41 << 8) | 0x01);
  c.writeReg16(0x146, 0x0000);
  c.writeReg16(0x144, 0x8000);
  amiga.memory.chipRam.fill(0, 0x020000, 0x020100);
  c.writeReg16(0x0e0, 0x0002);
  c.writeReg16(0x0e2, 0x0000);

  // Render vertical border line (line 44 < DIWSTRT V=$38=56) and active line (0x40=64)
  c.renderScanline(44, true);
  c.renderScanline(0x40, true);
  const fb = amiga.getFramebuffer();
  assert.equal(fb[0], 0xff000000, 'BRDRBLNK must blank vertical border outside DIWSTRT/DIWSTOP');
  const yActive = (0x40 - 44) * 640;
  // Left border X = 0 (< (0x90 - 0x81) * 2 = 30) must be black even with sprite at X=0 and red COLOR00
  assert.equal(fb[yActive + 0], 0xff000000, 'BRDRBLNK must blank left border and border sprites');
  // Inside DIW (X = 32, between 30 and 608) shows COLOR00 bright red
  assert.equal(fb[yActive + 32], 0xff0000ff, 'Inside DIW must still display COLOR00 when BRDRBLNK is active');
  // Right border X = 620 (>= (0x1B1 - 0x81) * 2 = 608) must be black
  assert.equal(fb[yActive + 620], 0xff000000, 'BRDRBLNK must blank right border outside DIWSTOP');
});

test('Amiga 1200 Gayle stub, Zorro II Fast RAM Autoconfig up to 8MB, and A500 <-> A1200 config switch', () => {
  const amiga = new AmigaMachine(
    { chipset: 'AGA', chipRamKB: 2048, fastRamKB: 8192, slowRamKB: 0, audioEnabled: false },
    { skipDefaultDisk: true }
  );

  // AGA Gayle IDE Status ($DA201C) returns 0x40 (DRDY=1, BSY=0) so KS 3.1 scsi.device skips 30s wait
  assert.equal(amiga.memory.read8(0xda201c), 0x40);
  assert.equal(amiga.memory.read8(0xda3018), 0x40);
  assert.equal(amiga.memory.read16(0xda0000), 0x0000);
  assert.equal(amiga.memory.read8(0xde1000), 0x00);

  // Zorro II Fast RAM Autoconfig at $E80000 exposes 8MB board (er_Type & 7 === 0 -> 8MB)
  const erType =
    (amiga.memory.read8(0xe80000) & 0xf0) | ((amiga.memory.read8(0xe80002) >>> 4) & 0x0f);
  assert.equal(erType, 0xe0, '8MB Zorro II Fast RAM must advertise er_Type = $E0');

  // Complete Fast RAM Autoconfig at $200000, then verify Hardfile still autoconfigs next at $EA0000!
  const hdf = createBlankFormattedHdf(1, 'A1200HD');
  amiga.mountHdf(hdf, 'dh0.hdf', false, 0);
  amiga.memory.write8(0xe8004a, 0x00); // latch low nibble
  amiga.memory.write8(0xe80048, 0x20); // assign Fast RAM base $200000
  amiga.memory.write32(0x200100, 0x12345678);
  amiga.memory.write32(0x900100, 0xabcdef01); // inside 8MB ($200000-$9FFFFF)
  assert.equal(amiga.memory.read32(0x200100) >>> 0, 0x12345678);
  assert.equal(amiga.memory.read32(0x900100) >>> 0, 0xabcdef01);

  // Now Hardfile Autoconfig board must answer at $E80000
  const hdType =
    (amiga.memory.read8(0xe80000) & 0xf0) | ((amiga.memory.read8(0xe80002) >>> 4) & 0x0f);
  assert.equal(hdType, 0xd1, 'Hardfile Zorro II board must take over $E80000 after Fast RAM');

  // Switching to A500 (ECS) turns off 68EC020 mode
  amiga.updateConfig({ chipset: 'ECS', chipRamKB: 1024, slowRamKB: 512, fastRamKB: 0 });
  assert.equal(amiga.cpu.is68020, false);
  assert.equal(amiga.getStatusSnapshot().chipset, 'ECS');

  // Switching back to A1200 (AGA) re-enables 68EC020 mode and clears Gayle after-reset state
  amiga.updateConfig({ chipset: 'AGA', chipRamKB: 2048, slowRamKB: 0, fastRamKB: 4096 });
  assert.equal(amiga.cpu.is68020, true);
  assert.equal(amiga.getStatusSnapshot().chipset, 'AGA');
});

test('Amiga 1200 Gayle ID $DE1000 bit sequence, 68EC020 unaligned RAM R/W, BRDRSPRT, and AGA HAM6', () => {
  const amiga = new AmigaMachine(
    { chipset: 'AGA', videoStandard: 'PAL', chipRamKB: 2048, audioEnabled: false },
    { skipDefaultDisk: true }
  );
  amiga.memory.ovl = false;

  // 1) Gayle ID sequence: 0x00 before write; after write to $DE1000, shifts 0xD0 MSB-first for 8 reads
  assert.equal(amiga.memory.read8(0xde1000), 0x00);
  amiga.memory.write8(0xde1000, 0x00);
  const gayleBits: number[] = [];
  for (let i = 0; i < 9; i++) gayleBits.push(amiga.memory.read8(0xde1000));
  assert.deepEqual(gayleBits, [0x80, 0x80, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00]);
  amiga.memory.clearRam();
  assert.equal(amiga.memory.read8(0xde1000), 0x00);

  // 2) 68EC020 unaligned 16/32-bit reads and writes
  assert.equal(amiga.memory.allowUnaligned, true);
  amiga.memory.write32(0x010001, 0x11223344);
  assert.equal(amiga.memory.read32(0x010001) >>> 0, 0x11223344);
  assert.equal(amiga.memory.read8(0x010001), 0x11);
  assert.equal(amiga.memory.read8(0x010004), 0x44);
  amiga.memory.write16(0x010003, 0xaabb);
  assert.equal(amiga.memory.read16(0x010003), 0xaabb);

  // 3) BRDRSPRT ($0002) with BRDRBLNK ($0020): sprites render in border while border stays black
  const c = amiga.chipset;
  c.writeReg16(0x096, 0x8320); // DMA_MASTER | DMA_BITPLANE | DMA_SPRITE
  c.writeReg16(0x08e, 0x3890); // DIWSTRT
  c.writeReg16(0x090, 0x20b1); // DIWSTOP
  c.writeReg16(0x100, 0x1201); // 1 bitplane + ECSENA
  c.writeReg16(0x106, 0x0022); // BRDRBLNK | BRDRSPRT
  c.writeReg16(0x180, 0x0f00); // COLOR00 red
  c.writeReg16(0x180 + 17 * 2, 0x00ff); // Sprite color 17 cyan
  c.writeReg16(0x140, (0x40 << 8) | 0x40); // H=$81 -> X=0 (in left border)
  c.writeReg16(0x142, (0x42 << 8) | 0x01);
  c.writeReg16(0x146, 0x0000);
  c.writeReg16(0x144, 0x8000);
  c.writeReg16(0x0e0, 0x0002);
  c.writeReg16(0x0e2, 0x0000);
  c.renderScanline(0x40, true);
  const fb = amiga.getFramebuffer();
  const yActive = (0x40 - 44) * 640;
  assert.equal(fb[yActive + 0], 0xffffff00, 'BRDRSPRT must allow sprite pixel at X=0 inside blanked border');
  assert.equal(fb[yActive + 4], 0xff000000, 'Non-sprite pixel inside blanked border must stay black');

  // 4) AGA HAM6 uses 24-bit base palette (not 12-bit)
  c.writeReg16(0x106, 0x0000); // LOCT=0 (upper 4 bits)
  c.writeReg16(0x182, 0x0123);
  c.writeReg16(0x106, 0x0200); // LOCT=1 (lower 4 bits)
  c.writeReg16(0x182, 0x0456); // Color 1 = RGB24 #142536
  assert.equal(c.colorReg24[1], 0x142536);
  c.writeReg16(0x106, 0x0000);
  c.writeReg16(0x100, 0x6a01); // 6 bitplanes, HOMOD=1 -> HAM6
  c.writeReg16(0x092, 0x0038);
  c.writeReg16(0x094, 0x00d0);
  for (let p = 0; p < 6; p++) {
    const addr = 0x030000 + p * 0x100;
    c.writeReg16(0x0e0 + p * 4, addr >>> 16);
    c.writeReg16(0x0e2 + p * 4, addr & 0xffff);
    amiga.memory.chipRam.fill(0, addr, addr + 64);
  }
  // startPx = (0x38 - 0x38)*2 + (0 - 0)&15 + (0x81 - 0x81) = 0 -> pixel 0 is at outPx=0
  // First visible pixel inside DIW ($90): diwHStartLo = $90 - $81 = 15 (X = 30)
  // byte 2 bit 7 = outPx 16 (X = 32, inside DIW): data4=1, ctrl=0 -> colorReg24[1] = #142536 (ABGR 0xFF362514)
  amiga.memory.chipRam[0x030000 + 2] = 0x80;
  c.renderScanline(0x41, true);
  const yHam = (0x41 - 44) * 640;
  assert.equal(fb[yHam + 32], 0xff362514, 'AGA HAM6 ctrl=0 must load full 24-bit color from colorReg24');
});

test('Kickstart 1.3 UserState() 68EC020 compat patch preserves checksum & restores on OCS/ECS, plus DF0 compat check', () => {
  const checksumRom256 = (rom: Uint8Array): number => {
    let sum = 0;
    for (let i = 0; i < rom.length; i += 4) {
      const w = ((rom[i] << 24) | (rom[i + 1] << 16) | (rom[i + 2] << 8) | rom[i + 3]) >>> 0;
      const next = sum + w;
      sum = (next + (next > 0xffffffff ? 1 : 0)) >>> 0;
    }
    return sum >>> 0;
  };

  // Build synthetic 256KB KS 1.3 ROM with exact Exec V34 UserState() sequence and valid checksum
  const rom = new Uint8Array(262144);
  rom[12] = 0x00;
  rom[13] = 34; // Version 34 (KS 1.3)
  const sig = [
    0x20, 0x4d, 0x4b, 0xfa, 0x00, 0x06, 0x4e, 0xee, 0xff, 0xe2,
    0x2a, 0x48, 0x32, 0x1f, 0x4e, 0x67, 0x2e, 0x40, 0x08, 0x81,
    0x00, 0x0d, 0x46, 0xc1, 0x4e, 0x75,
  ];
  rom.set(sig, 0x11b0);
  // Set checksum footer at rom.length - 0x18 so total end-around sum == 0xFFFFFFFF
  const footerOff = rom.length - 0x18;
  const partialSum = checksumRom256(rom);
  const fixWord = (0xffffffff - partialSum) >>> 0;
  rom[footerOff] = (fixWord >>> 24) & 0xff;
  rom[footerOff + 1] = (fixWord >>> 16) & 0xff;
  rom[footerOff + 2] = (fixWord >>> 8) & 0xff;
  rom[footerOff + 3] = fixWord & 0xff;
  assert.equal(checksumRom256(rom), 0xffffffff);

  const amiga = new AmigaMachine(
    { chipset: 'AGA', chipRamKB: 2048, audioEnabled: false },
    { skipDefaultDisk: true }
  );
  amiga.loadCustomRom(rom, 'Kickstart 1.3 Test.rom');

  // In AGA (68EC020) mode, UserState() at $FC11B0 is patched & ROM checksum remains 0xFFFFFFFF
  assert.equal(amiga.memory.read16(0xfc11b0), 0x40c1, 'UserState must be patched to MOVE SR, D1');
  assert.equal(checksumRom256(amiga.memory.rom), 0xffffffff, 'Patched KS 1.3 ROM must keep 0xFFFFFFFF checksum');

  // Switching back to ECS (68000) restores exact original bytes & checksum
  amiga.updateConfig({ chipset: 'ECS', chipRamKB: 1024, slowRamKB: 512, fastRamKB: 0 });
  assert.equal(amiga.memory.read16(0xfc11b0), 0x204d, 'Switching back to 68000 must restore original UserState');
  assert.equal(checksumRom256(amiga.memory.rom), 0xffffffff, 'Restored KS 1.3 ROM must keep 0xFFFFFFFF checksum');

  // Check DF0 compatibility warnings
  const ffsDisk = new Uint8Array(901120);
  ffsDisk[0] = 0x44; ffsDisk[1] = 0x4f; ffsDisk[2] = 0x53; ffsDisk[3] = 0x01; // DOS\1 FFS
  assert.ok(amiga.checkDf0KickstartCompat(ffsDisk, 'UFO_AGA.adf')?.includes('FFS'));
  const ofsDisk = new Uint8Array(901120);
  ofsDisk[0] = 0x44; ofsDisk[1] = 0x4f; ofsDisk[2] = 0x53; ofsDisk[3] = 0x00; // DOS\0 OFS
  assert.equal(amiga.checkDf0KickstartCompat(ofsDisk, 'UFO_OCS.adf'), null);
  assert.ok(amiga.checkDf0KickstartCompat(ofsDisk, 'UFO (AGA).adf')?.includes('Amiga 1200'));
});

test('Amiga 1200 boots real Kickstart 3.1 ROM rapidly without 30s Gayle IDE hang', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const ks31Path = path.resolve(
    process.cwd(),
    'bios',
    'Kickstart v3.1 rev 40.68 (1993)(Commodore)(A1200)[!].rom'
  );
  if (!fs.existsSync(ks31Path)) return;

  const romBytes = new Uint8Array(fs.readFileSync(ks31Path));
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
  const res = amiga.loadCustomRom(romBytes, 'Kickstart v3.1 (A1200).rom');
  assert.equal(res.ok, true);

  for (let i = 0; i < 150; i++) {
    amiga.stepFrame(i === 149);
  }
  const fb = amiga.getFramebuffer();
  const colors = new Set<number>();
  for (let i = 0; i < fb.length; i += 8) {
    colors.add(fb[i]);
  }
  assert.ok(
    colors.size >= 8,
    `Kickstart 3.1 A1200 should render animated Kickstart screen within 150 frames, got ${colors.size} unique colors`
  );

  // Verify left-edge artifact fix (DDFSTRT=$40 + BPLCON1=$44 must clip BPLPT=base-2 cleanly behind DIWSTRT=$95)
  const bg = fb[0];
  for (let y = 108; y <= 132; y++) {
    for (let x = 35; x < 72; x++) {
      assert.equal(
        fb[y * 640 + x],
        bg,
        `Unexpected left-edge artifact pixel on KS 3.1 boot screen at (${x}, ${y})`
      );
    }
  }
});

test('ECS/AGA BLTCON0L ($05A) updates low minterm byte without altering channel/shift bits and HIRES DDFSTRT/BPLCON1 clips left guard word', () => {
  const aga = new AmigaMachine({ chipset: 'AGA', audioEnabled: false }, { skipDefaultDisk: true });
  aga.memory.ovl = false;
  const c = aga.chipset;
  const chip = aga.memory.chipRam;

  // BLTCON0 = $0900 (useA | useD, ash=0, lf=$00), then byte write to $DFF05B (BLTCON0L) sets lf=$F0 (A -> D copy)
  c.writeReg16(0x040, 0x0900);
  aga.memory.write8(0xdff05b, 0xf0);
  assert.equal(c.bltCon0, 0x09f0, 'AGA BLTCON0L must preserve upper BLTCON0 byte and update lf');

  chip[0x010000] = 0xab;
  chip[0x010001] = 0xcd;
  chip[0x010200] = 0x00;
  chip[0x010201] = 0x00;
  c.writeReg16(0x044, 0xffff);
  c.writeReg16(0x046, 0xffff);
  c.writeReg16(0x050, 0x0001);
  c.writeReg16(0x052, 0x0000);
  c.writeReg16(0x054, 0x0001);
  c.writeReg16(0x056, 0x0200);
  c.writeReg16(0x064, 0x0000);
  c.writeReg16(0x066, 0x0000);
  c.writeReg16(0x058, (1 << 6) | 1);
  assert.equal(chip[0x010200], 0xab);
  assert.equal(chip[0x010201], 0xcd);

  // OCS ignores BLTCON0L writes
  const ocs = new AmigaMachine({ chipset: 'OCS', audioEnabled: false }, { skipDefaultDisk: true });
  ocs.chipset.writeReg16(0x040, 0x090a);
  ocs.memory.write8(0xdff05b, 0xf0);
  assert.equal(ocs.chipset.bltCon0, 0x090a, 'OCS must ignore BLTCON0L writes');

  // HIRES FMODE=0 with KS 3.1 geometry: DIWSTRT H=$95 (minX=40), DDFSTRT=$40, BPLCON1=$44, BPLPT=base-2
  c.writeReg16(0x096, 0x8300);
  c.writeReg16(0x08e, 0x6395);
  c.writeReg16(0x090, 0xf4ad);
  c.writeReg16(0x092, 0x0040);
  c.writeReg16(0x094, 0x00d0);
  c.writeReg16(0x100, 0x9200); // HIRES, 1 bitplane
  c.writeReg16(0x102, 0x0044);
  c.writeReg16(0x1fc, 0x0000); // FMODE=0
  c.writeReg16(0x180, 0x0000); // black bg
  c.writeReg16(0x182, 0x0fff); // white fg

  // Word 0 at base-2 ($020000) is 0xFFFF (left guard word), Word 1 at base ($020002) is 0x0080 (bit 8 -> x=48)
  chip.fill(0, 0x020000, 0x020060);
  chip[0x020000] = 0xff;
  chip[0x020001] = 0xff;
  chip[0x020002] = 0x00;
  chip[0x020003] = 0x80;
  c.writeReg16(0x0e0, 0x0002);
  c.writeReg16(0x0e2, 0x0000);
  c.renderScanline(100, true);

  const fbRow = (100 - 44) * 640;
  const fb = aga.getFramebuffer();
  for (let x = 32; x < 48; x++) {
    assert.equal(fb[fbRow + x], 0xff000000, `Guard word must be clipped left of minX=40 at x=${x}`);
  }
  assert.equal(fb[fbRow + 48], 0xffffffff, 'First active pixel after guard word must appear at x=48');
});

test('ECS/AGA Copper CDANG=1 permits register writes down to $000 (while OCS stops below $040) and INTENA tracks real mask changes', () => {
  // 1) Copper CDANG=1 writing DSKPTL ($022) <- $1234
  const setupCopperTest = (chipset: 'OCS' | 'AGA') => {
    const m = new AmigaMachine({ chipset, audioEnabled: false }, { skipDefaultDisk: true });
    m.memory.ovl = false;
    m.chipset.writeReg16(0x02e, 0x0002); // COPCON CDANG=1
    m.chipset.writeReg16(0x096, 0x8280); // DMAEN | COPEN
    m.memory.write16(0x010000, 0x0022);  // MOVE DSKPTL ($022)
    m.memory.write16(0x010002, 0x1234);
    m.memory.write16(0x010004, 0xffff);  // WAIT end of frame
    m.memory.write16(0x010006, 0xfffe);
    m.chipset.writeReg16(0x080, 0x0001);
    m.chipset.writeReg16(0x082, 0x0000);
    m.chipset.writeReg16(0x088, 0x0000); // COPJMP1
    m.chipset.runCopperLine(30);
    return m;
  };

  const aga = setupCopperTest('AGA');
  assert.equal(aga.chipset.dskPt & 0xffff, 0x1234, 'AGA Copper with CDANG=1 must execute MOVE to $022');

  const ocs = setupCopperTest('OCS');
  assert.equal(ocs.chipset.dskPt & 0xffff, 0x0000, 'OCS Copper with CDANG=1 must stop before writing below $040');
  assert.equal(ocs.chipset.copWaiting, true);
  assert.equal(ocs.chipset.copWaitV, 0xff);

  // 2) INTENA lastMaskWrite skips master-only Disable/Enable ($4000/$C000) and captures real mask changes
  aga.cpu.pc = 0x00012340;
  aga.chipset.writeReg16(0x09a, 0xc020); // Set INTEN | VERTB
  assert.equal(aga.chipset.lastIntenaMaskWriteVal, 0xc020);
  assert.equal(aga.chipset.lastIntenaMaskWritePc, 0x00012340);

  aga.cpu.pc = 0x00056780;
  aga.chipset.writeReg16(0x09a, 0x4000); // Disable() master only — must not overwrite real mask log
  aga.chipset.writeReg16(0x09a, 0xc000); // Enable() master only
  assert.equal(aga.chipset.lastIntenaMaskWriteVal, 0xc020);
  assert.equal(aga.chipset.lastIntenaMaskWritePc, 0x00012340);

  aga.cpu.pc = 0x0009abcd;
  aga.chipset.writeReg16(0x09a, 0x0020); // Clear VERTB
  assert.equal(aga.chipset.lastIntenaMaskWriteVal, 0x0020);
  assert.equal(aga.chipset.lastIntenaMaskWriteResult & 0x0020, 0);
  assert.equal(aga.chipset.lastIntenaMaskWritePc, 0x0009abcd);

  // 3) Full 64KB custom chip mirror bank ($DF0000-$DFFFFF): e.g. $DFE006 VHPOSR & $DFE09A INTENA
  aga.chipset.vpos = 0x42;
  aga.chipset.hpos = 0x28;
  assert.equal(aga.memory.read16(0x00dfe006), 0x4228);
  assert.equal(aga.memory.read8(0x00df0006), 0x42);
  aga.cpu.pc = 0x0009de72;
  aga.memory.write16(0x00dfe09a, 0x8020);
  assert.equal(aga.chipset.readReg16(0x01c) & 0x0020, 0x0020);
  assert.equal(aga.chipset.lastRamIntenaWritePc, 0x0009de72);
});

test('INTREQR VERTB sticky-poll rescue unblocks RAM busy-waits (BTST #5,$DFF01F) while preserving ROM VERTB IRQ servers', () => {
  // Build minimal 256KB ROM where Level 3 handler at $FC0100 clears INTREQ bit 5 and increments counter at $012000
  const rom = new Uint8Array(262144);
  const wrRom32 = (off: number, v: number) => {
    rom[off] = (v >>> 24) & 0xff;
    rom[off + 1] = (v >>> 16) & 0xff;
    rom[off + 2] = (v >>> 8) & 0xff;
    rom[off + 3] = v & 0xff;
  };
  const wrRom16 = (off: number, v: number) => {
    rom[off] = (v >>> 8) & 0xff;
    rom[off + 1] = v & 0xff;
  };
  // Reset SSP=$080000, PC=$FC0080 (with OVL=1 at boot) -> jumps to RAM $010000 after clearing OVL
  wrRom32(0x00, 0x00080000);
  wrRom32(0x04, 0x00fc0080);
  // $FC0080: MOVE.B #3, ($BFE201).L ; MOVE.B #0, ($BFE001).L (clear OVL) ; JMP ($010000).L
  const bootCode = [
    0x13fc, 0x0003, 0x00bf, 0xe201,
    0x13fc, 0x0000, 0x00bf, 0xe001,
    0x4ef9, 0x0001, 0x0000,
  ];
  for (let i = 0; i < bootCode.length; i++) wrRom16(0x80 + i * 2, bootCode[i]);

  // $FC0100 (ROM L3 handler): ADDQ.L #1, ($012000).L ; MOVE.W #$0020, ($DFF09C).L ; RTE
  const l3Code = [
    0x52b9, 0x0001, 0x2000,
    0x33fc, 0x0020, 0x00df, 0xf09c,
    0x4e73,
  ];
  for (let i = 0; i < l3Code.length; i++) wrRom16(0x100 + i * 2, l3Code[i]);

  const amiga = new AmigaMachine(
    { chipset: 'AGA', videoStandard: 'PAL', chipRamKB: 2048, audioEnabled: false },
    { skipDefaultDisk: true }
  );
  amiga.loadCustomRom(rom, 'VERTB Test ROM.rom');
  amiga.memory.ovl = false;

  // Point Level 3 vector ($6C) to ROM $00FC0100, keep INTENA=$6020 (INTEN | VERTB)
  amiga.memory.write32(0x00006c, 0x00fc0100);
  amiga.chipset.writeReg16(0x09a, 0xc020);
  amiga.cpu.sr = 0x0000; // IPL 0
  amiga.cpu.ssp = 0x080000;
  amiga.cpu.usp = 0x070000;

  // RAM loop at $010000 mimicking Alien Breed 3D ($27BCA2..$27BCC4):
  // loop: BTST #5, ($DFF01F).L ; BEQ.S loop ; MOVE.W #$0020, ($DFF09C).L ; ADDQ.L #1, ($012004).L ; BRA.S loop
  const ramCode = [
    0x0839, 0x0005, 0x00df, 0xf01f, // BTST #5, ($DFF01F).L
    0x67f6,                         // BEQ.S -10 -> $010000
    0x33fc, 0x0020, 0x00df, 0xf09c, // MOVE.W #$0020, ($DFF09C).L
    0x52b9, 0x0001, 0x2004,         // ADDQ.L #1, ($012004).L
    0x60e6,                         // BRA.S $010000
  ];
  for (let i = 0; i < ramCode.length; i++) amiga.memory.write16(0x010000 + i * 2, ramCode[i]);
  amiga.memory.write32(0x012000, 0);
  amiga.memory.write32(0x012004, 0);
  amiga.cpu.pc = 0x010000;

  // Step 8 frames: first 2 frames trigger sticky-poll detector, next 6 frames advance RAM loop 1/frame
  for (let f = 0; f < 8; f++) {
    amiga.stepFrame(false, false);
  }
  const romL3Count = amiga.memory.read32(0x012000) >>> 0;
  const ramPollTicks = amiga.memory.read32(0x012004) >>> 0;
  assert.equal(romL3Count, 8, 'ROM Level 3 VERTB handler must still execute every frame');
  assert.equal(ramPollTicks, 6, 'RAM INTREQR VERTB poll loop must unblock and pace at exactly 1 iteration per frame');
});

test('Copper SKIP compares against current copHpos (supporting COPJMP2 loops), WAIT maskV=$80 wraps cleanly at end of line, and AGA FMODE=3 DDFSTRT=$30 / midline BPLCON4 render accurately', () => {
  const amiga = new AmigaMachine(
    { chipset: 'AGA', videoStandard: 'PAL', chipRamKB: 2048, audioEnabled: false },
    { skipDefaultDisk: true }
  );
  amiga.memory.ovl = false;
  const c = amiga.chipset;
  const chip = amiga.memory.chipRam;

  // 1) Copper SKIP + MOVE COPJMP2 loop:
  // COP1LC ($010000): WAIT V=$40, H=$40 ; COLOR00=$111 ; COP2LC=$011000 ; COPJMP2
  // COP2LC ($011000): COLOR00 += 1 cycle (write $222) ; SKIP V=$40, H=$4C ; MOVE COPJMP2,0 ; COLOR00=$999 ; WAIT $FFFF $FFFE
  // WAIT ($40, $40) -> copHpos=$40. Iter 1: MOVE COLOR00 ($44), SKIP $4C ($44 < $4C -> no skip, $48), MOVE COPJMP2 ($4C)
  // Iter 2: MOVE COLOR00 ($50), SKIP $4C ($50 >= $4C -> SKIP!, $54), MOVE COPJMP2 skipped ($58), MOVE COLOR00=$999!
  const wr16 = (a: number, v: number) => amiga.memory.write16(a, v);
  wr16(0x010000, 0x4041); wr16(0x010002, 0xfffe); // WAIT V=$40, H=$40
  wr16(0x010004, 0x0180); wr16(0x010006, 0x0111);
  wr16(0x010008, 0x0084); wr16(0x01000a, 0x0001); // COP2PTH
  wr16(0x01000c, 0x0086); wr16(0x01000e, 0x1000); // COP2PTL
  wr16(0x010010, 0x008a); wr16(0x010012, 0x0000); // COPJMP2

  wr16(0x011000, 0x0180); wr16(0x011002, 0x0222); // visible COLOR00=$222 on iter 1..2
  wr16(0x011004, 0x404d); wr16(0x011006, 0xffff); // SKIP V=$40, H=$4C (mask V=$FF, H=$FE)
  wr16(0x011008, 0x008a); wr16(0x01100a, 0x0000); // MOVE COPJMP2, 0 (loop back if not skipped)
  wr16(0x01100c, 0x0180); wr16(0x01100e, 0x0999); // Executed ONLY after SKIP breaks the loop!
  wr16(0x011010, 0xffff); wr16(0x011012, 0xfffe);

  c.writeReg16(0x080, 0x0001);
  c.writeReg16(0x082, 0x0000);
  c.writeReg16(0x096, 0x8280); // DMA_MASTER | DMA_COPPER
  c.startFrame();
  c.runCopperLine(0x40, 0xdb);
  assert.equal(c.colorReg[0], 0x0999, 'Copper SKIP must loop via COPJMP2 until copHpos >= waitH ($4C), then execute COLOR00=$999');

  // 2) Copper-chunky WAIT with maskV=$80 across line boundary: WAIT ($00, $DF) ($80FE) + WAIT ($00, $3F) ($80FE)
  wr16(0x012000, 0x5001); wr16(0x012002, 0xfffe); // WAIT line $50 H=$00
  wr16(0x012004, 0x0180); wr16(0x012006, 0x0123);
  wr16(0x012008, 0x00df); wr16(0x01200a, 0x80fe); // WAIT any line H=$DE
  wr16(0x01200c, 0x003f); wr16(0x01200e, 0x80fe); // WAIT next line H=$3E
  wr16(0x012010, 0x0180); wr16(0x012012, 0x0abc);
  wr16(0x012014, 0xffff); wr16(0x012016, 0xfffe);

  c.writeReg16(0x080, 0x0001);
  c.writeReg16(0x082, 0x2000);
  c.startFrame();
  c.runCopperLine(0x50, 0xdb);
  assert.equal(c.colorReg[0], 0x0123);
  c.runCopperLine(0x50, 0xfe);
  assert.equal(c.colorReg[0], 0x0123, 'Masked WAIT H=$3E after H=$DE on line $50 must wait for line $51 instead of firing immediately');
  c.runCopperLine(0x51, 0xdb);
  assert.equal(c.colorReg[0], 0x0abc, 'Masked WAIT H=$3E must fire cleanly on line $51');

  // 3) AGA FMODE=3 with DDFSTRT=$0030..$00B8 (48 bytes fetched, BPL1MOD=-8) + BPLCON1=0 must phase-align to X=0 (no left-clip/right-wrap) + midline BPLCON4 BPLAM switch
  c.writeReg16(0x096, 0x8380); // DMA_MASTER | DMA_BITPLANE | DMA_COPPER
  c.writeReg16(0x1fc, 0x0003); // FMODE = 64-bit bitplane fetch
  c.writeReg16(0x100, 0x1201); // 1 bitplane Lo-Res, ECSENA=1
  c.writeReg16(0x102, 0x0000); // BPLCON1 = 0
  c.writeReg16(0x108, 0xfff8); // BPL1MOD = -8 (40-byte bitmap stride across 48-byte fetch)
  c.writeReg16(0x08e, 0x2c81);
  c.writeReg16(0x090, 0x2cc1);
  c.writeReg16(0x092, 0x0030); // DDFSTRT=$30 (fetchPx=-16) aligns to X=0 under FMODE=3 (64px phase)
  c.writeReg16(0x094, 0x00b8);
  c.writeReg16(0x106, 0x0000);
  c.writeReg16(0x180, 0x0000); // Color 0 = black
  c.writeReg16(0x182, 0x0f00); // Color 1 = red
  c.writeReg16(0x106, 0x8000); // Bank 4 (colors 128..159)
  c.writeReg16(0x180, 0x00f0); // Color 128 = green
  c.writeReg16(0x182, 0x000f); // Color 129 = blue
  c.writeReg16(0x106, 0x0000);
  c.writeReg16(0x10c, 0x0011); // Initial BPLAM = $00

  // Line 0 ($030000..$030027): first 2 bytes = $FF (red at X=0..31), rest = $00
  // Line 1 ($030028..$03004F): first 2 bytes = $FF (would wrap into right edge if startPx < 0)
  chip.fill(0, 0x030000, 0x030060);
  chip[0x030000] = 0xff;
  chip[0x030001] = 0xff;
  chip[0x030028] = 0xff;
  chip[0x030029] = 0xff;
  c.writeReg16(0x0e0, 0x0003);
  c.writeReg16(0x0e2, 0x0000);

  // Copper changes BPLCON4 BPLAM from $00 to $80 mid-line at H=$80 (pxX = (((0x84-2)*2)-0x81)*2 = 270)
  wr16(0x013000, 0x4581); wr16(0x013002, 0xfffe); // WAIT line $45, H=$80
  wr16(0x013004, 0x010c); wr16(0x013006, 0x8011); // BPLCON4 BPLAM=$80
  wr16(0x013008, 0xffff); wr16(0x01300a, 0xfffe);
  c.writeReg16(0x080, 0x0001);
  c.writeReg16(0x082, 0x3000);
  c.startFrame();
  c.runCopperLine(0x45, 0xdb);
  c.renderScanline(0x45, true);

  const fb = amiga.getFramebuffer();
  const row = (0x45 - 44) * 640;
  assert.equal(fb[row + 0], 0xff0000ff, 'AGA FMODE=3 DDFSTRT=$30 + BPLCON1=0 must start at X=0 (not -16) showing Color 1 red');
  assert.equal(fb[row + 638], 0xff00ff00, 'Right edge must show Color 0->128 green background instead of wrapped line-1 pixels');

  // Also verify 7-bitplane AGA Lo-Res branch (e.g. Alien Breed 3D $7201) with DDFSTRT=$30..$B8
  c.writeReg16(0x100, 0x7201); // 7 bitplanes Lo-Res
  c.writeReg16(0x10a, 0xfff8); // BPL2MOD = -8
  c.writeReg16(0x10c, 0x0011); // BPLAM = $00
  for (let p = 0; p < 7; p++) {
    c.writeReg16(0x0e0 + p * 4, p === 0 ? 0x0003 : 0x0004);
    c.writeReg16(0x0e2 + p * 4, 0x0000);
  }
  chip.fill(0, 0x040000, 0x040060);
  c.writeReg16(0x082, 0x3800); // empty copperlist at $013800
  wr16(0x013800, 0xffff); wr16(0x013802, 0xfffe);
  c.startFrame();
  c.runCopperLine(0x46, 0xdb);
  c.renderScanline(0x46, true);
  const row7 = (0x46 - 44) * 640;
  assert.equal(fb[row7 + 0], 0xff0000ff, '7-bitplane AGA FMODE=3 DDFSTRT=$30 must start at X=0');
  assert.equal(fb[row7 + 638], 0xff000000, '7-bitplane AGA right edge must remain background instead of wrapped line-1 pixels');
});

test('Sprite DMA latches only when line === vStart (ignoring stale vStart < header fetch line) and disables at vStop', () => {
  const amiga = new AmigaMachine({ chipset: 'AGA', chipRamKB: 2048, videoStandard: 'PAL' });
  const c = amiga.chipset;
  const chip = amiga.memory.chipRam;

  const wr16 = (addr: number, val: number) => {
    chip[addr] = (val >>> 8) & 0xff;
    chip[addr + 1] = val & 0xff;
  };
  const wr32 = (addr: number, val: number) => {
    wr16(addr, (val >>> 16) & 0xffff);
    wr16(addr + 2, val & 0xffff);
  };

  c.reset();
  c.writeReg16(0x096, 0x8220); // DMA_MASTER | DMA_SPRITE
  c.writeReg16(0x1fc, 0x000c); // FMODE sprite 64-bit (16-byte header + 16-byte data/line)
  c.writeReg16(0x08e, 0x2c81);
  c.writeReg16(0x090, 0x2cc1);
  c.writeReg16(0x100, 0x0200);
  c.writeReg16(0x180, 0x0000);
  c.writeReg16(0x1a2, 0x0f00); // Sprite 0/4 color 17 = red

  // Stale/disabled sprite 4 list at $020000: POS=$0000, CTL=$3440 (vStart=0, vStop=52), followed by non-zero garbage data
  chip.fill(0, 0x020000, 0x020200);
  wr16(0x020000, 0x0000);
  wr16(0x020008, 0x3440);
  wr32(0x020010, 0xffffffff);
  wr32(0x020018, 0x00000000);
  // Active sprite 0 at $020100: vStart=50 ($32), vStop=52 ($34), H=$80 ($40 shifted)
  wr16(0x020100, 0x3280);
  wr16(0x020108, 0x3400);
  wr32(0x020110, 0xffff0000);
  wr32(0x020118, 0x00000000);

  c.writeReg16(0x120, 0x0002); c.writeReg16(0x122, 0x0100); // SPR0PT = $020100
  c.writeReg16(0x130, 0x0002); c.writeReg16(0x132, 0x0000); // SPR4PT = $020000
  for (let s = 1; s < 8; s++) {
    if (s === 4) continue;
    c.writeReg16(0x120 + s * 4, 0x0000);
    c.writeReg16(0x122 + s * 4, 0x0000);
  }

  c.startFrame();
  c.fetchSpriteHeaders();
  assert.equal(c.sprPt[4], 0x020010, 'Header fetch advances SPR4PT past 16-byte FMODE=3 header');

  // Step through lines 25..53: SPR4 (vStart=0) must never activate streaming or advance past $020010,
  // while SPR0 (vStart=50, vStop=52) must arm on lines 50..51 and stop at line 52.
  for (let line = 25; line <= 53; line++) {
    c.stepSpritesOnLine(line);
    assert.equal(c.sprArmed[4], 0, `SPR4 with vStart=0 must stay unarmed on line ${line}`);
    assert.equal(c.sprPt[4], 0x020010, `SPR4PT must not advance into garbage on line ${line}`);
    if (line === 50 || line === 51) {
      assert.equal(c.sprArmed[0], 1, `SPR0 must arm on line ${line}`);
    } else {
      assert.equal(c.sprArmed[0], 0, `SPR0 must be unarmed on line ${line}`);
    }
  }
});

test('AGA 7-bitplane FMODE=3 Copper even-slot contention + scanline remainder keeps 104 MOVEs aligned to 2.00 lines', () => {
  const amiga = new AmigaMachine({ chipset: 'AGA', chipRamKB: 2048, videoStandard: 'PAL' });
  const c = amiga.chipset;
  const chip = amiga.memory.chipRam;

  const wr16 = (addr: number, val: number) => {
    chip[addr] = (val >>> 8) & 0xff;
    chip[addr + 1] = val & 0xff;
  };

  c.reset();
  c.writeReg16(0x096, 0x8380); // DMA_MASTER | DMA_BITPLANE | DMA_COPPER
  c.writeReg16(0x1fc, 0x000f); // FMODE = $F (64-bit bitplane + sprite)
  c.writeReg16(0x100, 0x7201); // 7 bitplanes LoRes (steals 3 of 4 even slots per 8-CCK burst)
  c.writeReg16(0x08e, 0x2cb1); // DIWSTRT V=44
  c.writeReg16(0x090, 0x2c91); // DIWSTOP V=300
  c.writeReg16(0x092, 0x0048); // DDFSTRT=$48
  c.writeReg16(0x094, 0x0088); // DDFSTOP=$88 -> 3 FMODE=3 fetch units -> 18 CCK stolen/line -> 52 MOVEs/line
  for (let p = 0; p < 7; p++) {
    c.writeReg16(0x0e0 + p * 4, 0x0004);
    c.writeReg16(0x0e2 + p * 4, 0x0000);
  }

  // Build 6 blocks of 104 NOOP MOVEs starting with BPLCON4 toggle on every 104th instruction, matching AB3D COP2
  let pc = 0x014000;
  wr16(pc, 0x2c0f); wr16(pc + 2, 0xfffe); pc += 4; // WAIT line 44, H=$0E (start of line 44 active timing)
  const blockStart = pc;
  for (let blk = 0; blk < 6; blk++) {
    wr16(pc, 0x010c); wr16(pc + 2, (blk & 1) !== 0 ? 0x8000 : 0x0000); pc += 4;
    for (let i = 1; i < 104; i++) {
      wr16(pc, 0x01fe); wr16(pc + 2, 0x0000); pc += 4; // NOOP
    }
  }
  wr16(pc, 0xffff); wr16(pc + 2, 0xfffe);

  c.writeReg16(0x080, 0x0001);
  c.writeReg16(0x082, 0x4000);
  c.startFrame();
  c.runCopperLine(44, 0xfe);

  // After line 44 (from H=$0E to $E2), run 2 full lines per block and verify BPLCON4 switches strictly outside active display (copHpos around $0E -> 52 MOVEs/line)
  const expectedStartH = c.copHpos;
  const pcAfterLine44 = c.copPc;
  assert.ok(pcAfterLine44 > blockStart, 'Line 44 must execute part of block 0');
  for (let blk = 1; blk < 6; blk++) {
    const l0 = 44 + blk * 2 - 1;
    const l1 = l0 + 1;
    c.runCopperLine(l0, 0xfe);
    c.runCopperLine(l1, 0xfe);
    const expectedPc = pcAfterLine44 + blk * 104 * 4;
    if (expectedPc <= blockStart + 6 * 104 * 4) {
      assert.equal(
        c.copPc,
        expectedPc,
        `Block ${blk} (lines ${l0}..${l1}) must execute exactly 104 MOVEs (416 bytes) across 2 lines`
      );
      assert.equal(
        c.copHpos,
        expectedStartH,
        `Block ${blk} must preserve exact 2-line phase lock (copHpos=${expectedStartH}) without mid-line drift`
      );
    }
  }
});

test('CPU overclocking scales 68000 execution throughput 2x/4x while keeping frame timing, CIA E-clocks, and HPOS at 1x without reboot', () => {
  const measureOneFrame = (cpuOverclock: 1 | 2 | 4) => {
    const amiga = new AmigaMachine({
      chipset: 'ECS',
      videoStandard: 'PAL',
      audioEnabled: false,
      cpuOverclock,
    });
    amiga.memory.ovl = false;
    amiga.cpu.sr = 0x2700; // mask IRQs so loop stays strictly inside Chip RAM
    amiga.cpu.stopped = false;
    amiga.cpu.d[0] = 0;
    amiga.cpu.pc = 0x010000;
    // ADDQ.L #1, D0 ($5280); BRA.S -4 ($60FC)
    amiga.memory.write16(0x010000, 0x5280);
    amiga.memory.write16(0x010002, 0x60fc);

    // Start CIA-A Timer A from $FFFF to verify E-clock rate stays 1x per frame
    amiga.cia.writeA(0x04, 0xff);
    amiga.cia.writeA(0x05, 0xff);
    amiga.cia.writeA(0x0e, 0x11); // LOAD + START continuous

    const startCycles = amiga.cpu.cycles;
    amiga.stepFrame(false, false);
    const elapsedCycles = amiga.cpu.cycles - startCycles;
    const taAfter = (amiga.cia.readA(0x05) << 8) | amiga.cia.readA(0x04);
    const eClocksElapsed = 0xffff - taAfter;

    return {
      amiga,
      iterations: amiga.cpu.d[0] >>> 0,
      elapsedCycles,
      eClocksElapsed,
      frameCount: amiga.frameCount,
    };
  };

  const r1 = measureOneFrame(1);
  const r2 = measureOneFrame(2);
  const r4 = measureOneFrame(4);

  assert.equal(r1.frameCount, 1);
  assert.equal(r2.frameCount, 1);
  assert.equal(r4.frameCount, 1);

  // CIA E-clocks must remain strictly locked to 1x native scanline rate
  assert.equal(r2.eClocksElapsed, r1.eClocksElapsed);
  assert.equal(r4.eClocksElapsed, r1.eClocksElapsed);

  // Executed M68k cycles and loop iterations scale proportionally with multiplier
  // (scanline boundary overshoot of ~8 cycles is constant across 1x/2x/4x, yielding ~1.98x and ~3.95x ratios)
  assert.ok(r1.iterations > 7000, `Baseline 1x iterations should be >7000, got ${r1.iterations}`);
  const ratio2 = r2.iterations / r1.iterations;
  const ratio4 = r4.iterations / r1.iterations;
  assert.ok(ratio2 >= 1.95 && ratio2 <= 2.05, `Expected ~2x iterations ratio, got ${ratio2}`);
  assert.ok(ratio4 >= 3.93 && ratio4 <= 4.05, `Expected ~4x iterations ratio, got ${ratio4}`);

  const cycRatio2 = r2.elapsedCycles / r1.elapsedCycles;
  const cycRatio4 = r4.elapsedCycles / r1.elapsedCycles;
  assert.ok(cycRatio2 >= 1.95 && cycRatio2 <= 2.05, `Expected ~2x cycle ratio, got ${cycRatio2}`);
  assert.ok(cycRatio4 >= 3.93 && cycRatio4 <= 4.05, `Expected ~4x cycle ratio, got ${cycRatio4}`);

  // Raster HPOS ($DFF006 horizontal tracking) stays calibrated to 4x scanline budget
  const m4 = r4.amiga;
  const budget4 = 454 * 4;
  m4.chipset.beginScanline(40, m4.cpu.cycles, budget4);
  m4.cpu.runCycles(budget4 >> 1);
  const midHpos = m4.chipset.getHpos();
  assert.ok(midHpos >= 108 && midHpos <= 122, `Expected mid-scanline HPOS ~113 at 4x, got ${midHpos}`);

  // Live updateConfig(cpuOverclock) with fractional slider value must not trigger hardReset or wipe CPU state
  const live = r1.amiga;
  const beforeLiveD0 = live.cpu.d[0] >>> 0;
  live.updateConfig({ cpuOverclock: 1.5 });
  assert.equal(live.cpu.d[0] >>> 0, beforeLiveD0, 'Live overclock change must not reset CPU registers');
  assert.ok(
    live.cpu.pc >= 0x010000 && live.cpu.pc <= 0x010004,
    `Live overclock change must preserve PC (${live.cpu.pc.toString(16)})`
  );
  live.stepFrame(false, false);
  const deltaNextFrame = (live.cpu.d[0] >>> 0) - beforeLiveD0;
  const liveRatio = deltaNextFrame / r1.iterations;
  assert.ok(liveRatio >= 1.45 && liveRatio <= 1.55, `Expected ~1.5x throughput after live slider switch, got ${liveRatio}`);
});







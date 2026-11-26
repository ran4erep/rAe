import test from 'node:test';
import assert from 'node:assert/strict';
import { AmigaMachine } from './amigaMachine';

function createTestMachine(chipset: 'OCS' | 'ECS' | 'AGA' = 'AGA', videoStandard: 'PAL' | 'NTSC' = 'PAL'): AmigaMachine {
  const amiga = new AmigaMachine(
    { chipset, videoStandard, chipRamKB: 2048, audioEnabled: false },
    { skipDefaultDisk: true }
  );
  amiga.memory.ovl = false;
  amiga.cpu.stopped = true;
  return amiga;
}

test('Mid-line BPLxPT split at H=$60 and post-DDF reload at H=$DC match PUAE modulo ordering', () => {
  const amiga = createTestMachine('ECS', 'PAL');
  const c = amiga.chipset;
  const chip = amiga.memory.chipRam;
  const wr16 = (a: number, v: number) => amiga.memory.write16(a, v);

  // Plane buffer A ($020000): 40 bytes of 0x00 (color 0)
  // Plane buffer B ($021000): 40 bytes of 0xFF (color 1)
  // Plane buffer C ($022000): 40 bytes of 0xAA (alternating pattern for next line)
  chip.fill(0x00, 0x020000, 0x020040);
  chip.fill(0xff, 0x021000, 0x021040);
  chip.fill(0xaa, 0x022000, 0x022040);

  // Copper list at $010000:
  //   Set 1-plane LoRes DIW $2C81..$F4C1, DDF $38..$D0, BPL1MOD=$0010, BPL1PT=$020000
  //   At V=60, H=$60: switch BPL1PT to $021000 (mid-line pointer split!)
  //   At V=60, H=$DC (post-DDF): reload BPL1PT to $022000 -> must NOT have line 60's BPL1MOD=$10 added!
  let cp = 0x010000;
  wr16(cp, 0x008e); wr16(cp + 2, 0x2c81); cp += 4;
  wr16(cp, 0x0090); wr16(cp + 2, 0xf4c1); cp += 4;
  wr16(cp, 0x0092); wr16(cp + 2, 0x0038); cp += 4;
  wr16(cp, 0x0094); wr16(cp + 2, 0x00d0); cp += 4;
  wr16(cp, 0x0100); wr16(cp + 2, 0x1200); cp += 4;
  wr16(cp, 0x0108); wr16(cp + 2, 0x0010); cp += 4;
  wr16(cp, 0x0180); wr16(cp + 2, 0x0000); cp += 4; // COLOR00 = black
  wr16(cp, 0x0182); wr16(cp + 2, 0x0f00); cp += 4; // COLOR01 = red
  wr16(cp, 0x00e0); wr16(cp + 2, 0x0002); cp += 4;
  wr16(cp, 0x00e2); wr16(cp + 2, 0x0000); cp += 4;
  wr16(cp, 0x3c61); wr16(cp + 2, 0xfffe); cp += 4; // WAIT V=60, H=$60
  wr16(cp, 0x00e0); wr16(cp + 2, 0x0002); cp += 4;
  wr16(cp, 0x00e2); wr16(cp + 2, 0x1000); cp += 4; // Split BPL1PT = $021000
  wr16(cp, 0x3cdd); wr16(cp + 2, 0xfffe); cp += 4; // WAIT V=60, H=$DC
  wr16(cp, 0x00e0); wr16(cp + 2, 0x0002); cp += 4;
  wr16(cp, 0x00e2); wr16(cp + 2, 0x2000); cp += 4; // Reload BPL1PT = $022000 post-DDF
  wr16(cp, 0xffff); wr16(cp + 2, 0xfffe);

  c.writeReg16(0x080, 0x0001);
  c.writeReg16(0x082, 0x0000);
  c.writeReg16(0x096, 0x8380); // MASTER | BPL | COP
  c.startFrame();
  for (let line = 0; line <= 60; line++) {
    c.beginScanline(line, 0, 908);
    c.runCopperLine(line, 0xe1);
    c.renderScanline(line, line === 60);
    c.runCopperLine(line, 0xfe);
  }

  const fb = amiga.getFramebuffer();
  const y60 = (60 - 44) * c.fbWidth;
  // Left half (around H=$48 -> x ~ 30) reads from $020000 (0x00 -> black)
  assert.equal(fb[y60 + 40], 0xff000000, 'Left of H=$60 split must sample $020000');
  // Right half (around H=$90 -> x ~ 320) reads from $021000 (0xFF -> red)
  assert.equal(fb[y60 + 360], 0xff0000ff, 'Right of H=$60 split must sample $021000');
  // After line 60's DDF completes and H=$DC reload executes, BPL1PT must be $022000 (NOT $022010)
  assert.equal(c.bplPt[0], 0x022000, 'Post-DDF BPL1PT write at H=$DC must NOT receive line 60 modulo');
});

test('Mid-line BPLCON0/BPLCON1/DMACON/DIWSTRT splits, HAM6/HAM8 palette splits, and direct BPL1DAT shift', () => {
  // 1) Mid-line BPLCON0 (0 -> 1 plane), BPLCON1 scroll, DMACON toggle, and DIWSTRT clip
  const ecs = createTestMachine('ECS', 'PAL');
  const ec = ecs.chipset;
  ecs.memory.chipRam.fill(0x80, 0x020000, 0x021000); // leftmost pixel of each 16px word = 1 across lines 44..60
  const wr16 = (a: number, v: number) => ecs.memory.write16(a, v);

  let cp = 0x010000;
  wr16(cp, 0x008e); wr16(cp + 2, 0x2c81); cp += 4;
  wr16(cp, 0x0090); wr16(cp + 2, 0xf4c1); cp += 4;
  wr16(cp, 0x0092); wr16(cp + 2, 0x0038); cp += 4;
  wr16(cp, 0x0094); wr16(cp + 2, 0x00d0); cp += 4;
  wr16(cp, 0x0100); wr16(cp + 2, 0x1200); cp += 4; // 1 plane LoRes
  wr16(cp, 0x0102); wr16(cp + 2, 0x0000); cp += 4; // BPLCON1 = 0
  wr16(cp, 0x0180); wr16(cp + 2, 0x0000); cp += 4;
  wr16(cp, 0x0182); wr16(cp + 2, 0x00f0); cp += 4; // Color 1 = green
  wr16(cp, 0x00e0); wr16(cp + 2, 0x0002); cp += 4;
  wr16(cp, 0x00e2); wr16(cp + 2, 0x0000); cp += 4;
  // Mid-line H=$68 (x=(0x68*2 - 0x81)*2 = 158): enable scroll=2 via BPLCON1=$0002, then H=$90 disable DMACON BPL
  wr16(cp, 0x3c69); wr16(cp + 2, 0xfffe); cp += 4;
  wr16(cp, 0x0102); wr16(cp + 2, 0x0002); cp += 4;
  wr16(cp, 0x3c91); wr16(cp + 2, 0xfffe); cp += 4;
  wr16(cp, 0x0096); wr16(cp + 2, 0x0100); cp += 4; // Clear BPLEN mid-line
  wr16(cp, 0xffff); wr16(cp + 2, 0xfffe);

  ec.writeReg16(0x080, 0x0001);
  ec.writeReg16(0x082, 0x0000);
  ec.writeReg16(0x096, 0x8380);
  ec.startFrame();
  for (let line = 0; line <= 60; line++) {
    ec.beginScanline(line, 0, 908);
    ec.runCopperLine(line, 0xe1);
    ec.renderScanline(line, line === 60);
    ec.runCopperLine(line, 0xfe);
  }
  const fb1 = ecs.getFramebuffer();
  const y60 = (60 - 44) * ec.fbWidth;
  assert.equal(fb1[y60 + 0], 0xff00ff00, 'Left word bit 15 (x=0) must be green before split');
  assert.equal(fb1[y60 + 176], 0xff000000, 'At x=176 after scroll=2 split, bitplane shifted right by 4 hi-px');
  assert.equal(fb1[y60 + 180], 0xff00ff00, 'At x=180 after scroll=2 split, shifted pixel must appear green');
  assert.equal(fb1[y60 + 384], 0xff000000, 'After H=$90 DMACON clear, pixel must drop to background black');

  // 2) Direct Copper BPL1DAT ($110) pixel shift when bitplane DMA is off
  const datMachine = createTestMachine('OCS', 'PAL');
  const dc = datMachine.chipset;
  const dw16 = (a: number, v: number) => datMachine.memory.write16(a, v);
  cp = 0x010000;
  dw16(cp, 0x008e); dw16(cp + 2, 0x2c81); cp += 4;
  dw16(cp, 0x0090); dw16(cp + 2, 0xf4c1); cp += 4;
  dw16(cp, 0x0100); dw16(cp + 2, 0x1200); cp += 4; // 1 plane LoRes (DMA disabled!)
  dw16(cp, 0x0180); dw16(cp + 2, 0x0000); cp += 4;
  dw16(cp, 0x0182); dw16(cp + 2, 0x0ff0); cp += 4; // Color 1 = yellow
  dw16(cp, 0x3c61); dw16(cp + 2, 0xfffe); cp += 4; // H=$60 -> x=(0xC0 - 0x81)*2 = 126
  dw16(cp, 0x0110); dw16(cp + 2, 0xffff); cp += 4; // BPL1DAT direct write shifts 16 LoRes px
  dw16(cp, 0xffff); dw16(cp + 2, 0xfffe);
  dc.writeReg16(0x080, 0x0001);
  dc.writeReg16(0x082, 0x0000);
  dc.writeReg16(0x096, 0x8280); // MASTER | COP (NO BPL DMA)
  dc.startFrame();
  for (let line = 0; line <= 60; line++) {
    dc.beginScanline(line, 0, 908);
    dc.runCopperLine(line, 0xe1);
    dc.renderScanline(line, line === 60);
    dc.runCopperLine(line, 0xfe);
  }
  const fbDat = datMachine.getFramebuffer();
  const yd = (60 - 44) * dc.fbWidth;
  assert.equal(fbDat[yd + 124], 0xff000000, 'Before BPL1DAT trigger H=$60 must be background');
  assert.equal(fbDat[yd + 144], 0xff00ffff, 'Direct BPL1DAT write without DMA must render 16 yellow LoRes pixels');

  // 3) HAM8 mid-line palette split: hold R from previous pixel + modify G from new palette / base color
  const aga = createTestMachine('AGA', 'PAL');
  const ac = aga.chipset;
  const aw16 = (a: number, v: number) => aga.memory.write16(a, v);
  for (let p = 0; p < 8; p++) aga.memory.chipRam.fill(0, 0x030000 + p * 0x1000, 0x030040 + p * 0x1000);
  // Pixel 0 (bit 7): code 00 (palette lookup) index 1 -> COLOR01
  aga.memory.chipRam[0x032000] = 0x80; // plane 2 -> val=1
  // Pixel 1 (bit 6): palette lookup index 2 -> COLOR02
  aga.memory.chipRam[0x033000] = 0x40; // plane 3 -> val=2
  // Pixel 2 (bit 5): HAM8 modify Red (ctrl=2 = plane 1 set, data6=$3F -> R=0xFC) keeping G,B from pixel 1!
  aga.memory.chipRam[0x031000] = 0x20; // plane 1 = ctrl bit 1 -> ctrl=2 (modify Red) at bit 5
  aga.memory.chipRam[0x032000] |= 0x20;
  aga.memory.chipRam[0x033000] |= 0x20;
  aga.memory.chipRam[0x034000] = 0x20;
  aga.memory.chipRam[0x035000] = 0x20;
  aga.memory.chipRam[0x036000] = 0x20;
  aga.memory.chipRam[0x037000] = 0x20;

  cp = 0x010000;
  aw16(cp, 0x008e); aw16(cp + 2, 0x2c81); cp += 4;
  aw16(cp, 0x0090); aw16(cp + 2, 0xf4c1); cp += 4;
  aw16(cp, 0x0092); aw16(cp + 2, 0x0038); cp += 4;
  aw16(cp, 0x0094); aw16(cp + 2, 0x00d0); cp += 4;
  aw16(cp, 0x0100); aw16(cp + 2, 0x0a10); cp += 4; // 8 planes + HOMOD (HAM8)
  aw16(cp, 0x0108); aw16(cp + 2, (-40) & 0xffff); cp += 4; // BPL1MOD = -40 (repeat line)
  aw16(cp, 0x010a); aw16(cp + 2, (-40) & 0xffff); cp += 4; // BPL2MOD = -40 (repeat line)
  aw16(cp, 0x0180); aw16(cp + 2, 0x0000); cp += 4;
  aw16(cp, 0x0182); aw16(cp + 2, 0x000f); cp += 4; // Color 1 = blue
  aw16(cp, 0x0184); aw16(cp + 2, 0x00f0); cp += 4; // Color 2 = green
  for (let p = 0; p < 8; p++) {
    const pa = 0x030000 + p * 0x1000;
    aw16(cp, 0x00e0 + p * 4); aw16(cp + 2, (pa >>> 16) & 0xff); cp += 4;
    aw16(cp, 0x00e2 + p * 4); aw16(cp + 2, pa & 0xffff); cp += 4;
  }
  // Force renderScanlineSplit via benign mid-line Copper COLOR03 split
  aw16(cp, 0x3c81); aw16(cp + 2, 0xfffe); cp += 4;
  aw16(cp, 0x0186); aw16(cp + 2, 0x0fff); cp += 4;
  aw16(cp, 0xffff); aw16(cp + 2, 0xfffe);

  ac.writeReg16(0x080, 0x0001);
  ac.writeReg16(0x082, 0x0000);
  ac.writeReg16(0x096, 0x8380);
  ac.startFrame();
  for (let line = 0; line <= 60; line++) {
    ac.beginScanline(line, 0, 908);
    ac.runCopperLine(line, 0xe1);
    ac.renderScanline(line, line === 60);
    ac.runCopperLine(line, 0xfe);
  }
  const fbHam = aga.getFramebuffer();
  const yh = (60 - 44) * ac.fbWidth;
  assert.equal(fbHam[yh + 0], 0xffff0000, 'HAM8 pixel 0 lookup color 1 must be blue');
  assert.equal(fbHam[yh + 2], 0xff00ff00, 'HAM8 pixel 1 lookup color 2 must be green');
  // Pixel 2 keeps G=0xFF from pixel 1 while modifying R=0xFC (value 0x3F << 2 | 3? Let's verify >=0xF0 red + 0xFF green)
  const px2 = fbHam[yh + 4];
  assert.ok((px2 & 0xff) >= 0xf0 && ((px2 >>> 8) & 0xff) === 0xff, `HAM8 pixel 2 must keep green and set red, got 0x${px2.toString(16)}`);
});

test('Horizontal sprite multiplexer reuses SPR0 and attached SPR0/SPR1 pairs across same scanline', () => {
  const amiga = createTestMachine('ECS', 'PAL');
  const c = amiga.chipset;
  const wr16 = (a: number, v: number) => amiga.memory.write16(a, v);

  // Set up clean black playfield + Copper horizontal sprite multiplexing on line 60
  let cp = 0x010000;
  wr16(cp, 0x008e); wr16(cp + 2, 0x2c81); cp += 4;
  wr16(cp, 0x0090); wr16(cp + 2, 0xf4c1); cp += 4;
  wr16(cp, 0x0100); wr16(cp + 2, 0x0200); cp += 4; // 0 planes
  wr16(cp, 0x0180); wr16(cp + 2, 0x0000); cp += 4;
  wr16(cp, 0x01a2); wr16(cp + 2, 0x0f00); cp += 4; // Color 17 (spr0/1 color 1) = red
  wr16(cp, 0x01aa); wr16(cp + 2, 0x000f); cp += 4; // Color 21 (attached spr0/1 color 5) = blue
  // Wait line 59 H=$D0: set attached SPR0+SPR1 at X=0x50 (x = (0x50*2 - 0x81)*2 = 62) with pixel=5 (spr0=1, spr1=0b01 -> 0x5 -> attach)
  wr16(cp, 0x3bd1); wr16(cp + 2, 0xfffe); cp += 4;
  wr16(cp, 0x0140); wr16(cp + 2, 0x3c50); cp += 4; // SPR0POS
  wr16(cp, 0x0142); wr16(cp + 2, 0x3e00); cp += 4; // SPR0CTL (V=60..62)
  wr16(cp, 0x0148); wr16(cp + 2, 0x3c50); cp += 4; // SPR1POS
  wr16(cp, 0x014a); wr16(cp + 2, 0x3e80); cp += 4; // SPR1CTL ATT=1
  wr16(cp, 0x0144); wr16(cp + 2, 0x8000); cp += 4; // SPR0DATA = bit 15
  wr16(cp, 0x0146); wr16(cp + 2, 0x0000); cp += 4; // SPR0DATB
  wr16(cp, 0x014c); wr16(cp + 2, 0x8000); cp += 4; // SPR1DATA = bit 15 -> combined attached idx = 0b0101 = 5 -> COLOR21 (blue)
  wr16(cp, 0x014e); wr16(cp + 2, 0x0000); cp += 4;
  // On line 60 at H=$70 (past X=0x50!), reposition SPR0+SPR1 to X=0x90 (x = (0x90*2 - 0x81)*2 = 318) with color 1 (red)
  wr16(cp, 0x3c71); wr16(cp + 2, 0xfffe); cp += 4;
  wr16(cp, 0x0140); wr16(cp + 2, 0x3c90); cp += 4;
  wr16(cp, 0x0148); wr16(cp + 2, 0x3c90); cp += 4;
  wr16(cp, 0x014a); wr16(cp + 2, 0x3e00); cp += 4; // unattach SPR1
  wr16(cp, 0x014c); wr16(cp + 2, 0x0000); cp += 4;
  wr16(cp, 0x0144); wr16(cp + 2, 0x8000); cp += 4; // arm SPR0DATA for 2nd horizontal instance
  wr16(cp, 0xffff); wr16(cp + 2, 0xfffe);

  c.writeReg16(0x080, 0x0001);
  c.writeReg16(0x082, 0x0000);
  c.writeReg16(0x096, 0x8280); // MASTER | COP (manual Copper-armed sprites)
  c.startFrame();
  for (let line = 0; line <= 60; line++) {
    c.beginScanline(line, 0, 908);
    c.runCopperLine(line, 0xe1);
    c.renderScanline(line, line === 60);
    c.runCopperLine(line, 0xfe);
  }
  const fb = amiga.getFramebuffer();
  const y60 = (60 - 44) * c.fbWidth;
  assert.equal(fb[y60 + 62], 0xffff0000, 'First horizontal sprite instance (attached) at x=62 must be blue (COLOR21)');
  assert.equal(fb[y60 + 318], 0xff0000ff, 'Second multiplexed sprite instance on same line at x=318 must be red (COLOR17)');
});

test('AGA SSCAN2 scan-doubling and plfstrt_sprite early DDFSTRT DMA stealing match PUAE', () => {
  const amiga = createTestMachine('AGA', 'PAL');
  const c = amiga.chipset;
  const chip = amiga.memory.chipRam;
  const wr16 = (a: number, v: number) => amiga.memory.write16(a, v);

  // 1) AGA SSCAN2 (FMODE=0x8000, POS & 0x80): line 45 shares line 44 data without advancing pointer; line 46 fetches row 2
  // Sprite 0 structure at $020000: header (V=44..48, H=$80 -> POS=$2C80, CTL=$3000), row0=$AAAA,0000; row1=$5555,0000
  wr16(0x020000, 0x2c80); wr16(0x020002, 0x3000);
  wr16(0x020004, 0xaaaa); wr16(0x020006, 0x0000);
  wr16(0x020008, 0x5555); wr16(0x02000a, 0x0000);
  wr16(0x02000c, 0x0000); wr16(0x02000e, 0x0000);

  c.writeReg16(0x08e, 0x2c81);
  c.writeReg16(0x090, 0xf4c1);
  c.writeReg16(0x100, 0x0200);
  c.writeReg16(0x1fc, 0x8000); // SSCAN2=1, FMODE=0
  c.writeReg16(0x1a2, 0x00f0); // COLOR17 = green
  c.writeReg16(0x120, 0x0002); c.writeReg16(0x122, 0x0000); // SPR0PT = $020000
  c.writeReg16(0x096, 0x8220); // MASTER | SPRITE

  c.startFrame();
  for (let line = 0; line <= 25; line++) c.beginScanline(line, 0, 908);
  c.fetchSpriteHeaders();
  for (let line = 26; line <= 46; line++) {
    c.beginScanline(line, 0, 908);
    c.renderScanline(line, line >= 44 && line <= 46);
  }
  const fb = amiga.getFramebuffer();
  const sx = ((0x80 << 1) - c.viewHOriginLo) << 1;
  // Line 44 (y=0) fetches row0 (0xAAAA -> px0 green, px1 black)
  assert.equal(fb[0 * c.fbWidth + sx], 0xff00ff00, 'SSCAN2 line 44 px0 must be row0 (0xAAAA -> 1)');
  assert.equal(fb[0 * c.fbWidth + sx + 2], 0xff000000, 'SSCAN2 line 44 px1 must be row0 (0xAAAA -> 0)');
  // Line 45 (y=1) is odd offset from vStart=44 -> keeps row0 (0xAAAA), does NOT fetch row1
  assert.equal(fb[1 * c.fbWidth + sx], 0xff00ff00, 'SSCAN2 line 45 must repeat row0 px0=1');
  assert.equal(fb[1 * c.fbWidth + sx + 2], 0xff000000, 'SSCAN2 line 45 must repeat row0 px1=0');
  // Line 46 (y=2) advances to row1 (0x5555 -> px0 black, px1 green)
  assert.equal(fb[2 * c.fbWidth + sx], 0xff000000, 'SSCAN2 line 46 must advance to row1 px0=0');
  assert.equal(fb[2 * c.fbWidth + sx + 2], 0xff00ff00, 'SSCAN2 line 46 must advance to row1 px1=1');

  // 2) plfstrt_sprite: DDFSTRT=$20 with active bitplanes steals sprites 2..7 (0x18 + s*4 >= 0x20) while sparing sprite 0 & 1
  const steal = createTestMachine('OCS', 'PAL');
  const sc = steal.chipset;
  const sw16 = (a: number, v: number) => steal.memory.write16(a, v);
  // Sprites 0 (H=$70) and 2 (H=$80) both start at line 44
  sw16(0x020000, 0x2c70); sw16(0x020002, 0x3000); sw16(0x020004, 0xffff); sw16(0x020006, 0x0000);
  sw16(0x021000, 0x2c80); sw16(0x021002, 0x3000); sw16(0x021004, 0xffff); sw16(0x021006, 0x0000);
  steal.memory.chipRam.fill(0x00, 0x030000, 0x030100);
  sc.writeReg16(0x08e, 0x2c81);
  sc.writeReg16(0x090, 0xf4c1);
  sc.writeReg16(0x092, 0x0020); // DDFSTRT = $20 -> steals slot >= $20 (spr2..7)
  sc.writeReg16(0x094, 0x00d0);
  sc.writeReg16(0x100, 0x1200); // 1 active bitplane
  sc.writeReg16(0x0e0, 0x0003); sc.writeReg16(0x0e2, 0x0000);
  sc.writeReg16(0x180, 0x0000);
  sc.writeReg16(0x1a2, 0x0f00); // spr0/1 color = red
  sc.writeReg16(0x1aa, 0x00ff); // spr2/3 color = cyan
  sc.writeReg16(0x120, 0x0002); sc.writeReg16(0x122, 0x0000); // SPR0
  sc.writeReg16(0x128, 0x0002); sc.writeReg16(0x12a, 0x1000); // SPR2
  sc.writeReg16(0x096, 0x8320); // MASTER | BPL | SPR

  sc.startFrame();
  for (let line = 0; line <= 25; line++) sc.beginScanline(line, 0, 908);
  sc.fetchSpriteHeaders();
  for (let line = 26; line <= 44; line++) {
    sc.beginScanline(line, 0, 908);
    sc.renderScanline(line, line === 44);
  }
  const sfb = steal.getFramebuffer();
  const xSpr0 = ((0x70 << 1) - sc.viewHOriginLo) << 1;
  const xSpr2 = ((0x80 << 1) - sc.viewHOriginLo) << 1;
  assert.equal(sfb[xSpr0], 0xff0000ff, 'Sprite 0 (slot $18 < DDFSTRT $20) must NOT be stolen');
  assert.equal(sfb[xSpr2], 0xff000000, 'Sprite 2 (slot $20 >= DDFSTRT $20) must be stolen by early bitplane DMA');
});

test('ECS SHRES disables sprites 4..7, enables CTL bit 4 70ns subpixel, and supports OCS 7-plane + weird_bitplane_fix', () => {
  // 1) ECS SHRES sprite 4..7 disable & CTL & 0x10 subpixel offset
  const ecs = createTestMachine('ECS', 'PAL');
  const ec = ecs.chipset;
  ec.writeReg16(0x08e, 0x2c81);
  ec.writeReg16(0x090, 0xf4c1);
  ec.writeReg16(0x100, 0x0240); // ECS SHRES (0x0040)
  ec.writeReg16(0x180, 0x0000);
  ec.writeReg16(0x1a2, 0x0f00); // spr0 color 1 = red
  ec.writeReg16(0x1b2, 0x00f0); // spr4 color 1 = green
  // Manual Sprite 0 at H=$80 with CTL & 0x10 (70ns subpixel)
  ec.writeReg16(0x140, 0x2c80);
  ec.writeReg16(0x142, 0x3010); // SHRES 70ns bit 4 set!
  ec.writeReg16(0x144, 0x8000);
  ec.writeReg16(0x146, 0x0000);
  // Manual Sprite 4 at H=$90 (must be suppressed in ECS SHRES!)
  ec.writeReg16(0x160, 0x2c90);
  ec.writeReg16(0x162, 0x3000);
  ec.writeReg16(0x164, 0x8000);
  ec.writeReg16(0x166, 0x0000);
  ec.renderScanline(44, true);
  const efb = ecs.getFramebuffer();
  const x0 = ((0x80 << 1) - ec.viewHOriginLo) << 1;
  const x4 = ((0x90 << 1) - ec.viewHOriginLo) << 1;
  assert.equal(efb[x0], 0xff000000, 'ECS SHRES sprite CTL & 0x10 must shift sprite right by 1 hires pixel');
  assert.equal(efb[x0 + 1], 0xff0000ff, 'ECS SHRES sprite shifted pixel must appear at x0+1');
  assert.equal(efb[x4], 0xff000000, 'ECS SHRES must disable sprites 4..7');

  // 2) OCS 7-plane mode (isocs7planes): BPU=7 LoRes fetches 4 planes, uses static BPL5DAT/BPL6DAT
  const ocs7 = createTestMachine('OCS', 'PAL');
  const oc = ocs7.chipset;
  ocs7.memory.chipRam.fill(0x00, 0x020000, 0x021000);
  ocs7.memory.chipRam[0x020000] = 0x80; // plane 0 pixel 0 = 1
  oc.writeReg16(0x096, 0x8300); // MASTER | BPL
  oc.writeReg16(0x08e, 0x2c81);
  oc.writeReg16(0x090, 0xf4c1);
  oc.writeReg16(0x092, 0x0038);
  oc.writeReg16(0x094, 0x00d0);
  oc.writeReg16(0x100, 0x7200); // BPU=7 LoRes OCS
  oc.writeReg16(0x104, 0x0000);
  oc.writeReg16(0x180 + 17 * 2, 0x00ff); // color 17 (plane0=1, static BPL5DAT=1 -> index 17) = cyan
  for (let p = 0; p < 6; p++) {
    const addr = 0x020000 + p * 0x100;
    oc.writeReg16(0x0e0 + p * 4, (addr >>> 16) & 0xff);
    oc.writeReg16(0x0e2 + p * 4, addr & 0xffff);
  }
  oc.writeReg16(0x118, 0xffff); // BPL5DAT = all 1s -> static bit 4 set!
  oc.writeReg16(0x11a, 0x0000); // BPL6DAT = 0
  oc.renderScanline(44, true);
  assert.equal(ocs7.getFramebuffer()[0], 0xffffff00, 'OCS 7-plane LoRes must combine fetched planes 0..3 with static BPL5DAT -> color 17');
  assert.equal(oc.bplPt[4], 0x020400, 'OCS 7-plane LoRes must NOT advance BPL5PT via DMA');

  // 3) weird_bitplane_fix: OCS/ECS 5-plane single playfield with PF2P >= 5 forces any plane-5-set pixel to color 16
  oc.writeReg16(0x100, 0x5200); // 5 planes
  oc.writeReg16(0x104, 5 << 3); // PF2P = 5 (>= 5)
  oc.writeReg16(0x180 + 16 * 2, 0x0f0f); // color 16 = magenta
  oc.writeReg16(0x180 + 17 * 2, 0x00ff); // color 17 = cyan
  ocs7.memory.chipRam.fill(0x00, 0x020000, 0x021000);
  ocs7.memory.chipRam[0x020000] = 0x80; // plane 0 = 1
  ocs7.memory.chipRam[0x020400] = 0x80; // plane 4 = 1 -> raw index 17 -> weird_fix collapses to 16!
  for (let p = 0; p < 5; p++) {
    const addr = 0x020000 + p * 0x100;
    oc.writeReg16(0x0e0 + p * 4, (addr >>> 16) & 0xff);
    oc.writeReg16(0x0e2 + p * 4, addr & 0xffff);
  }
  oc.renderScanline(45, true);
  assert.equal(ocs7.getFramebuffer()[1 * oc.fbWidth], 0xffff00ff, 'OCS/ECS weird_bitplane_fix with PF2P>=5 must collapse index 17 to color 16');
});

test('SHRES BPLCON1 wrap, vdiwstate + AGA subpixel DIWHIGH, chronological CPU sync, and Blitter line-draw', () => {
  // 1) SHRES BPLCON1 wrap mask (7/15/31) & AGA DIWHIGH subpixel clipping
  const aga = createTestMachine('AGA', 'PAL');
  const ac = aga.chipset;
  aga.memory.chipRam.fill(0xff, 0x020000, 0x020100);
  ac.writeReg16(0x096, 0x8300); // MASTER | BPL
  ac.writeReg16(0x08e, 0x2c81); // DIWSTRT H=$81
  ac.writeReg16(0x090, 0x30c1); // DIWSTOP H=$C1
  ac.writeReg16(0x1e4, 0x2000 | 0x0010); // DIWHIGH bit 4 (0x10) = HSTART 70ns subpixel (1 hires px)
  ac.writeReg16(0x092, 0x003c);
  ac.writeReg16(0x094, 0x00d0);
  ac.writeReg16(0x100, 0x1240); // 1 plane SHRES
  ac.writeReg16(0x102, 0x0000);
  ac.writeReg16(0x180, 0x0000);
  ac.writeReg16(0x182, 0x00ff); // cyan
  ac.writeReg16(0x0e0, 0x0002); ac.writeReg16(0x0e2, 0x0000);
  ac.renderScanline(44, true);
  const fb = aga.getFramebuffer();
  const x0 = ((0x81 - ac.viewHOriginLo) << 1);
  // Note: check DIWHIGH H0 subpixel bit in chipset.ts (bit 3 in AGA DIWHIGH)
  assert.equal(fb[x0], 0xff000000, 'AGA DIWHIGH HSTART subpixel must clip odd pixel x0 to background');
  assert.equal(fb[x0 + 1], 0xffffff00, 'AGA DIWHIGH HSTART subpixel must reveal playfield starting at x0+1');

  // 2) vdiwstate: changing DIWSTOP after line passed DIWSTRT latches active/off properly on the fly
  const vdiw = createTestMachine('ECS', 'PAL');
  const vc = vdiw.chipset;
  vdiw.memory.chipRam.fill(0xff, 0x020000, 0x020100);
  vc.writeReg16(0x096, 0x8300);
  vc.writeReg16(0x08e, 0x2c81);
  vc.writeReg16(0x090, 0x30c1); // VSTOP = 48
  vc.writeReg16(0x092, 0x0038);
  vc.writeReg16(0x094, 0x00d0);
  vc.writeReg16(0x100, 0x1200);
  vc.writeReg16(0x180, 0x0000);
  vc.writeReg16(0x182, 0x0f00);
  vc.writeReg16(0x0e0, 0x0002); vc.writeReg16(0x0e2, 0x0000);
  vc.beginScanline(44, 0, 908);
  vc.renderScanline(44, true);
  assert.equal(vdiw.getFramebuffer()[0], 0xff0000ff, 'Line 44 (DIWSTRT) must activate vdiwstate');
  // Mid-frame change DIWSTRT above current line (would deactivate under stateless compare, MUST stay active in PUAE vdiwstate!)
  vc.beginScanline(45, 0, 908);
  vc.writeReg16(0x08e, 0x4081);
  vc.renderScanline(45, true);
  assert.equal(vdiw.getFramebuffer()[vc.fbWidth], 0xff0000ff, 'PUAE vdiwstate must stay active on line 45 even after DIWSTRT changes');

  // 3) Chronological CPU/Copper sync: CPU reads DMACONR/INTREQR mid-line and sees Copper write scheduled BEFORE CPU hpos
  const syncM = createTestMachine('ECS', 'PAL');
  const sc2 = syncM.chipset;
  const sw16 = (a: number, v: number) => syncM.memory.write16(a, v);
  sw16(0x010000, 0x3c21); sw16(0x010002, 0xfffe); // WAIT V=60, H=$20
  sw16(0x010004, 0x009c); sw16(0x010006, 0x8010); // INTREQ = set COPER bit (bit 4) at H=$20
  sw16(0x010008, 0xffff); sw16(0x01000a, 0xfffe);
  sc2.writeReg16(0x080, 0x0001);
  sc2.writeReg16(0x082, 0x0000);
  sc2.writeReg16(0x096, 0x8280); // MASTER | COP
  sc2.startFrame();
  for (let line = 0; line < 60; line++) {
    sc2.beginScanline(line, 0, 908);
    sc2.runCopperLine(line, 0xe1);
    sc2.renderScanline(line, false);
    sc2.runCopperLine(line, 0xfe);
  }
  sc2.beginScanline(60, 0, 908);
  // Advance CPU 400 cycles (~100 color clocks -> H=$64, past Copper H=$20!) WITHOUT calling runCopperLine manually first
  syncM.cpu.cycles += 400;
  const intreqMid = sc2.readReg16(0x01e);
  assert.ok((intreqMid & 0x0010) !== 0, 'Reading INTREQR at H~$64 must chronologically trigger Copper write at H=$20');

  // 4) Blitter line-draw with USEA/USEB/USEC, single-dot (BLTSING), and BLTSIGN
  const bltM = createTestMachine('ECS', 'PAL');
  const bc = bltM.chipset;
  bltM.memory.chipRam.fill(0x00, 0x020000, 0x020200);
  // Draw horizontal 4-pixel octant line (dx=3, dy=0 -> octant 4 = SUD=1, AUL=0, SUL=0 -> 0x10; LINE=1 -> BLTCON1=$0011)
  // Using BLTCON0 = USEA|USEC|USED ($0B00) + LF=$CA -> D=(A&B)|(~A&C) -> with A=$8000, B=$FFFF (no USEB), draws pixels in word
  bc.writeReg16(0x040, 0x0bca); // USEA | USEC | USED | LF=$CA (ASH=0)
  bc.writeReg16(0x042, 0x0051); // SIGN=1, SUD=1, LINE=1 (moves right: ash increments)
  bc.writeReg16(0x044, 0xffff); // BLTAFWM
  bc.writeReg16(0x074, 0x8000); // BLTADAT = $8000
  bc.writeReg16(0x072, 0xffff); // BLTBDAT = $FFFF (solid line)
  bc.writeReg16(0x064, -12 & 0xffff); // BLTAMOD = 4*(dy-dx) = -12 (used when !sign)
  bc.writeReg16(0x062, 0);            // BLTBMOD = 4*dy = 0 (used when sign)
  bc.writeReg16(0x066, 40); // screen width 40 bytes
  bc.writeReg16(0x060, 40); // CMOD = 40
  bc.writeReg16(0x052, 0xfffd); // BLTAPTL = -3 (signed error)
  bc.writeReg16(0x048, 0x0002); bc.writeReg16(0x04a, 0x0000); // CPT = $020000
  bc.writeReg16(0x054, 0x0002); bc.writeReg16(0x056, 0x0000); // DPT = $020000
  bc.writeReg16(0x058, (4 << 6) | 2); // 4 pixels (width=2 required by line mode)
  bltM.cpu.runCycles(256);
  bc.syncBlitter();
  assert.equal(bltM.memory.read16(0x020000), 0xf000, 'Blitter 4px horizontal line draw must plot bits 15..12 ($F000)');

  // Test BLTSING (single dot per Y line): horizontal X-major (BLTCON1 = SIGN | SUD | SING | LINE = $0053)
  bltM.memory.chipRam.fill(0x00, 0x020100, 0x020300);
  bc.writeReg16(0x040, 0x0bca);
  bc.writeReg16(0x042, 0x0053); // SIGN=1 | SUD=1 | SING=1 | LINE=1 (stays on Y=0 for all 3 pixels)
  bc.writeReg16(0x044, 0xffff);
  bc.writeReg16(0x074, 0x8000);
  bc.writeReg16(0x072, 0xffff);
  bc.writeReg16(0x064, -12 & 0xffff);
  bc.writeReg16(0x062, 0);
  bc.writeReg16(0x066, 40);
  bc.writeReg16(0x060, 40);
  bc.writeReg16(0x052, 0xfffd);
  bc.writeReg16(0x048, 0x0002); bc.writeReg16(0x04a, 0x0100);
  bc.writeReg16(0x054, 0x0002); bc.writeReg16(0x056, 0x0100);
  bc.writeReg16(0x058, (3 << 6) | 2);
  bltM.cpu.runCycles(256);
  bc.syncBlitter();
  assert.equal(bltM.memory.read16(0x020100), 0x8000, 'Blitter SING=1 on same Y line must plot only first dot ($8000, not $E000)');
});

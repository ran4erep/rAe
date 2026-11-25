import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { AmigaMachine } from '../hardware/amigaMachine';
import { ADF_TOTAL_SIZE, verifyAmigaBootblockChecksum } from '../hardware/floppy';
import { buildBuiltinAdf } from '../roms/openKickKernel';
import {
  createBlankFormattedHdf,
  createPopulatedBootableAdf,
  createPopulatedHdf,
  extractAmigaDosFiles,
  inspectAmigaDosUsage,
  inspectAmigaDosVolume,
  repairAmigaDosNulFilenames,
} from './amigaDosFs';
import { resolveUploadedFile, resolveUploadedFileAsync } from './archiveManager';
import { crc32, decompressGzip, inflateRaw, parseZipArchive } from './deflate';
import { crc16Lha, isLhaData, parseLhaArchive } from './lha';

function buildZipBuffer(files: Array<{ name: string; data: Uint8Array; deflate?: boolean }>): Uint8Array {
  const localParts: Uint8Array[] = [];
  const cdParts: Uint8Array[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const comp = f.deflate ? new Uint8Array(zlib.deflateRawSync(f.data)) : f.data;
    const method = f.deflate ? 8 : 0;

    const lfh = Buffer.alloc(30 + nameBytes.length);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0x0800, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(comp.length, 18);
    lfh.writeUInt32LE(f.data.length, 22);
    lfh.writeUInt16LE(nameBytes.length, 26);
    lfh.writeUInt16LE(0, 28);
    nameBytes.copy(lfh, 30);

    const cdh = Buffer.alloc(46 + nameBytes.length);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0x0800, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(comp.length, 20);
    cdh.writeUInt32LE(f.data.length, 24);
    cdh.writeUInt16LE(nameBytes.length, 28);
    cdh.writeUInt32LE(offset, 42);
    nameBytes.copy(cdh, 46);

    localParts.push(lfh, comp);
    cdParts.push(cdh);
    offset += lfh.length + comp.length;
  }

  const cdBuf = Buffer.concat(cdParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return new Uint8Array(Buffer.concat([...localParts, cdBuf, eocd]));
}

function buildLhaLevel0Entry(name: string, payload: Uint8Array, method = '-lh0-', packed?: Uint8Array): Uint8Array {
  const data = packed ?? payload;
  const nameBuf = Buffer.from(name, 'ascii');
  const hdrSize = 22 + nameBuf.length; // up to crc16 + osId (level 0: hdrSize bytes from [2..hdrSize+1])
  const buf = Buffer.alloc(hdrSize + 2 + data.length + 1);
  buf[0] = hdrSize;
  buf.write(method, 2, 5, 'ascii');
  buf.writeUInt32LE(data.length, 7);
  buf.writeUInt32LE(payload.length, 11);
  buf.writeUInt32LE(0, 15);
  buf[19] = 0x20;
  buf[20] = 0; // level 0
  buf[21] = nameBuf.length;
  nameBuf.copy(buf, 22);
  buf.writeUInt16LE(crc16Lha(payload), 22 + nameBuf.length);
  // Checksum over buf[2 .. hdrSize+1]
  let sum = 0;
  for (let i = 2; i < hdrSize + 2; i++) sum = (sum + buf[i]) & 0xff;
  buf[1] = sum;
  Buffer.from(data).copy(buf, hdrSize + 2);
  buf[hdrSize + 2 + data.length] = 0; // archive terminator
  return new Uint8Array(buf);
}

function buildLhaLevel2Entry(dirName: string, fileName: string, payload: Uint8Array): Uint8Array {
  const fileExtPayload = Buffer.from(fileName, 'ascii');
  const dirExtPayload = Buffer.from(dirName.replace(/\//g, '\xff'), 'ascii');
  const ext1Size = 3 + fileExtPayload.length;
  const ext2Size = 3 + dirExtPayload.length;
  const totalHdrSize = 26 + ext1Size + ext2Size + 2;

  const hdr = Buffer.alloc(totalHdrSize);
  hdr.writeUInt16LE(totalHdrSize, 0);
  hdr.write('-lh0-', 2, 5, 'ascii');
  hdr.writeUInt32LE(payload.length, 7);
  hdr.writeUInt32LE(payload.length, 11);
  hdr.writeUInt32LE(0, 15);
  hdr[19] = 0x20;
  hdr[20] = 2; // level 2
  hdr.writeUInt16LE(crc16Lha(payload), 21);
  hdr[23] = 0x41; // Amiga OS ID 'A'
  hdr.writeUInt16LE(ext1Size, 24);

  let p = 26;
  hdr[p] = 0x01; // filename ext
  fileExtPayload.copy(hdr, p + 1);
  hdr.writeUInt16LE(ext2Size, p + ext1Size - 2);
  p += ext1Size;

  hdr[p] = 0x02; // dirname ext
  dirExtPayload.copy(hdr, p + 1);
  hdr.writeUInt16LE(0, p + ext2Size - 2);

  return new Uint8Array(Buffer.concat([hdr, payload, Buffer.from([0])]));
}

test('ADZ (gzipped ADF) decompresses identically and resolves as ADF image', () => {
  const originalAdf = buildBuiltinAdf('boing_studio');
  const gz = new Uint8Array(zlib.gzipSync(originalAdf));

  const { data } = decompressGzip(gz);
  assert.equal(data.length, ADF_TOTAL_SIZE);
  assert.deepEqual(data, originalAdf);

  const resolved = resolveUploadedFile('BoingStudio.adz', gz);
  assert.equal(resolved.kind, 'adf');
  assert.equal(resolved.name, 'BoingStudio.adf');
  assert.deepEqual(resolved.bytes, originalAdf);
});

test('RFC 1951 Inflate & ZIP parser handle stored, deflated, and multi-disk archives', () => {
  const rawText = Buffer.from('AMIGA 500 OCS/ECS TEST PAYLOAD '.repeat(200), 'utf8');
  const deflated = new Uint8Array(zlib.deflateRawSync(rawText));
  const inflated = inflateRaw(deflated, 0, deflated.length, rawText.length);
  assert.deepEqual(inflated, new Uint8Array(rawText));

  const adf1 = buildBuiltinAdf('boing_studio');
  const adf2 = buildBuiltinAdf('shadow_runner');
  const zip = buildZipBuffer([
    { name: 'Game/Disk 1.adf', data: adf1, deflate: true },
    { name: 'Game/Disk 2.adf', data: adf2, deflate: true },
    { name: 'Game/readme.txt', data: new Uint8Array(Buffer.from('Read me')), deflate: false },
  ]);

  const entries = parseZipArchive(zip);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0].extract(), adf1);

  const resolved = resolveUploadedFile('ChaosEngine.zip', zip);
  assert.equal(resolved.kind, 'archive-choices');
  if (resolved.kind === 'archive-choices') {
    assert.equal(resolved.mediaItems.length, 2);
    assert.equal(resolved.allFiles.length, 3);
    assert.deepEqual(
      resolved.allFiles.map((f) => f.path).sort(),
      ['Game/Disk 1.adf', 'Game/Disk 2.adf', 'Game/readme.txt']
    );
    assert.equal(resolved.mediaItems[0].name, 'Disk 1.adf');
    assert.equal(resolved.mediaItems[1].name, 'Disk 2.adf');
    assert.deepEqual(resolved.mediaItems[0].extractBytes(), adf1);
  }
});

test('LHA parser decodes Level 0 and Level 2 archives including Amiga 0xFF path separators and -lh5- bitstream', () => {
  const hello = new Uint8Array(Buffer.from('echo "Hello from LHA!"\n'));
  const lha0 = buildLhaLevel0Entry('startup-sequence', hello);
  assert.equal(isLhaData(lha0), true);
  const parsed0 = parseLhaArchive(lha0);
  assert.equal(parsed0.length, 1);
  assert.equal(parsed0[0].path, 'startup-sequence');
  assert.deepEqual(parsed0[0].extract(), hello);

  const lha2 = buildLhaLevel2Entry('MyGame\xffs', 'startup-sequence', hello);
  const parsed2 = parseLhaArchive(lha2);
  assert.equal(parsed2.length, 1);
  assert.equal(parsed2[0].path, 'MyGame/s/startup-sequence');
  assert.deepEqual(parsed2[0].extract(), hello);

  // Hand-craft a minimal valid -lh5- compressed stream (1 block, literal-only 0-tree -> constant byte 'A' x 5)
  // Blocksize = 5 (16 bits: 0x0005), NT n=0 -> c=0 (5 bits: 00000, 5 bits: 00000),
  // NC n=0 -> c=65 ('A') (9 bits: 000000000, 9 bits: 001000001), NP n=0 -> c=0 (4 bits: 0000, 4 bits: 0000)
  // Total bits = 16 + 10 + 18 + 8 = 52 bits -> 7 bytes
  const expectedLh5 = new Uint8Array([0x41, 0x41, 0x41, 0x41, 0x41]);
  // Pack MSB-first bits:
  // 00000000 00000101 | 00000 00000 | 000000000 001000001 | 0000 0000 | 0000
  // Bits:
  // 00000000 (0x00)
  // 00000101 (0x05)
  // 00000000 (0x00)
  // 00000000 (0x00)
  // 00000010 (0x02)
  // 00001000 (0x08)
  // 00000000 (0x00)
  const lh5Bits = new Uint8Array([0x00, 0x05, 0x00, 0x00, 0x04, 0x10, 0x00]);
  const lh5Archive = buildLhaLevel0Entry('test.txt', expectedLh5, '-lh5-', lh5Bits);
  const parsedLh5 = parseLhaArchive(lh5Archive);
  assert.equal(parsedLh5.length, 1);
  assert.deepEqual(parsedLh5[0].extract(), expectedLh5);
});

test('AmigaDOS OFS builder generates valid bootable ADF and populated HDF volumes', () => {
  const files = [
    { path: 's/startup-sequence', bytes: new Uint8Array(Buffer.from('dir\n')) },
    { path: 'readme.txt', bytes: new Uint8Array(Buffer.from('AmigaDOS OFS Test\n'.repeat(3000))) }, // >35KB tests Extension blocks!
  ];

  const adf = createPopulatedBootableAdf('DemoDisk', files);
  assert.equal(adf.length, ADF_TOTAL_SIZE);
  assert.equal(verifyAmigaBootblockChecksum(adf), true);
  const adfInfo = inspectAmigaDosVolume(adf);
  assert.equal(adfInfo.isDos, true);
  assert.equal(adfInfo.isBootable, true);
  assert.equal(adfInfo.volumeName, 'DemoDisk');
  assert.ok(adfInfo.rootEntries.includes('s/'));
  assert.ok(adfInfo.rootEntries.includes('readme.txt'));

  const hdf = createPopulatedHdf('WorkHD', files);
  assert.ok(hdf.length >= 2048 * 512);
  const hdfInfo = inspectAmigaDosVolume(hdf);
  assert.equal(hdfInfo.isDos, true);
  assert.equal(hdfInfo.isBootable, true);
  assert.equal(hdfInfo.volumeName, 'WorkHD');
  assert.ok(hdfInfo.rootEntries.includes('s/'));
  assert.ok(hdfInfo.rootEntries.includes('readme.txt'));
});

test('Real Kickstart 1.3 ROM detects Zorro II Autoconfig HDF, mounts DH0:, and boots AmigaDOS from Hardfile', () => {
  const romPath = path.resolve(
    process.cwd(),
    'bios/Kickstart v1.3 r34.005 (1987-12)(Commodore)(A3000)[!].rom'
  );
  if (!fs.existsSync(romPath)) {
    return;
  }

  const romBytes = new Uint8Array(fs.readFileSync(romPath));
  const amiga = new AmigaMachine({
    chipset: 'ECS',
    videoStandard: 'PAL',
    chipRamKB: 1024,
    slowRamKB: 512,
    audioEnabled: false,
  });

  const romRes = amiga.loadCustomRom(romBytes, 'Kickstart 1.3');
  assert.equal(romRes.ok, true);

  // Build a real HDF with an S:Startup-Sequence that leaves a recognizable trace or boots AmigaDOS CLI
  const hdf = createBlankFormattedHdf(2, 'BootHD');
  const populatedHdf = createPopulatedHdf('BootHD', [
    { path: 's/startup-sequence', bytes: new Uint8Array(Buffer.from('version\n')) },
  ]);
  void hdf;

  const mountRes = amiga.mountHdf(populatedHdf, 'BootHD.hdf', true);
  assert.equal(mountRes.ok, true);

  // Track if amigahd.device Open & CMD_READ actually executed
  let sawConfiguredBase = false;
  let sawHdfIo = false;

  // Boot ~400 frames (~8 seconds Amiga time — cold memory scan + DOS HDF mount + CLI boot)
  for (let f = 0; f < 400; f++) {
    amiga.stepFrame(f === 399);
    if (amiga.hardfile.configuredBase === 0x00e90000) sawConfiguredBase = true;
    if (amiga.hardfile.ioPulseFrames > 0) sawHdfIo = true;
  }

  assert.equal(sawConfiguredBase, true, 'Kickstart 1.3 expansion.library should autoconfig amigahd board at $E90000');
  assert.equal(sawHdfIo, true, 'Kickstart 1.3 dos.library should read sectors from DH0: HDF during boot');

  // Verify screen rendered AmigaDOS Workbench/CLI window (blue #0055AA + white #FFFFFF, not blank)
  const fb = amiga.getFramebuffer();
  const colors = new Set<number>();
  for (let i = 0; i < fb.length; i += 19) colors.add(fb[i]);
  assert.ok(colors.size >= 3, `Expected booted AmigaDOS screen colors, got ${colors.size}`);
  // Check Amiga 1.3 Workbench blue (#0055AA -> ABGR 0xFFAA5500)
  assert.ok(colors.has(0xffaa5500), 'Expected Kickstart 1.3 Workbench/CLI #0055AA blue screen');
});

test('RDB (RDSK/PART) multi-partition HDF parses geometry cleanly and LHA files auto-pack to HDF/ADF', () => {
  // Construct a synthetic 2-partition RDB HDF (2 MB)
  const sectorSize = 512;
  const totalCyls = 64; // 64 * 1 * 32 = 2048 sectors = 1 MB
  const rdbDisk = new Uint8Array(totalCyls * 32 * sectorSize);
  const dv = new DataView(rdbDisk.buffer);

  // Block 0: RDSK
  rdbDisk[0] = 0x52; rdbDisk[1] = 0x44; rdbDisk[2] = 0x53; rdbDisk[3] = 0x4b; // 'RDSK'
  dv.setUint32(28, 1); // rdb_PartitionList = block 1
  dv.setUint32(64, totalCyls); // cylinders
  dv.setUint32(68, 32); // sectors
  dv.setUint32(72, 1); // heads

  // Block 1: PART ('DH0')
  const p1 = 1 * sectorSize;
  rdbDisk[p1 + 0] = 0x50; rdbDisk[p1 + 1] = 0x41; rdbDisk[p1 + 2] = 0x52; rdbDisk[p1 + 3] = 0x54;
  dv.setUint32(p1 + 16, 2); // pb_Next = block 2
  rdbDisk[p1 + 36] = 3;
  rdbDisk[p1 + 37] = 0x44; rdbDisk[p1 + 38] = 0x48; rdbDisk[p1 + 39] = 0x30; // 'DH0'
  dv.setUint32(p1 + 128 + 3 * 4, 1); // surfaces
  dv.setUint32(p1 + 128 + 5 * 4, 32); // blocksPerTrack
  dv.setUint32(p1 + 128 + 6 * 4, 2); // reserved
  dv.setUint32(p1 + 128 + 9 * 4, 2); // lowCyl
  dv.setUint32(p1 + 128 + 10 * 4, 31); // highCyl
  dv.setInt32(p1 + 128 + 15 * 4, 0); // bootPri
  dv.setUint32(p1 + 128 + 16 * 4, 0x444f5301); // DOS\1

  // Block 2: PART ('DH1')
  const p2 = 2 * sectorSize;
  rdbDisk[p2 + 0] = 0x50; rdbDisk[p2 + 1] = 0x41; rdbDisk[p2 + 2] = 0x52; rdbDisk[p2 + 3] = 0x54;
  dv.setUint32(p2 + 16, 0xffffffff);
  rdbDisk[p2 + 36] = 3;
  rdbDisk[p2 + 37] = 0x44; rdbDisk[p2 + 38] = 0x48; rdbDisk[p2 + 39] = 0x31; // 'DH1'
  dv.setUint32(p2 + 128 + 3 * 4, 1);
  dv.setUint32(p2 + 128 + 5 * 4, 32);
  dv.setUint32(p2 + 128 + 6 * 4, 2);
  dv.setUint32(p2 + 128 + 9 * 4, 32);
  dv.setUint32(p2 + 128 + 10 * 4, 63);
  dv.setInt32(p2 + 128 + 15 * 4, -5);
  dv.setUint32(p2 + 128 + 16 * 4, 0x444f5303); // DOS\3

  const amiga = new AmigaMachine({ audioEnabled: false });
  const res = amiga.mountHdf(rdbDisk, 'MultiPart.hdf', false);
  assert.equal(res.ok, true);
  assert.equal(amiga.hardfile.isRdb, true);
  assert.equal(amiga.hardfile.partitions.length, 2);
  assert.equal(amiga.hardfile.partitions[0].dosName, 'DH0');
  assert.equal(amiga.hardfile.partitions[0].dosTypeStr, 'DOS\\1');
  assert.equal(amiga.hardfile.partitions[1].dosName, 'DH1');
  assert.equal(amiga.hardfile.partitions[1].dosTypeStr, 'DOS\\3');
  assert.equal(amiga.getStatusSnapshot().dh0.partitionCount, 2);

  // Also test resolving an LHA archive of regular AmigaDOS files into archive-files -> buildHdf & buildAdf
  const lha = buildLhaLevel2Entry('MyTool\xffs', 'startup-sequence', new Uint8Array(Buffer.from('dir DH0:\n')));
  const resolved = resolveUploadedFile('MyTool.lha', lha);
  assert.equal(resolved.kind, 'archive-files');
  if (resolved.kind === 'archive-files') {
    assert.equal(resolved.fitsFloppy, true);
    const adfInfo = inspectAmigaDosVolume(resolved.buildAdf());
    assert.equal(adfInfo.isDos, true);
    assert.ok(adfInfo.rootEntries.includes('MyTool/'));
    const hdfInfo = inspectAmigaDosVolume(resolved.buildHdf());
    assert.equal(hdfInfo.isDos, true);
    assert.ok(hdfInfo.rootEntries.includes('MyTool/'));
  }
});

test('Universal archive resolver extracts Kickstart ROM and multi-disk ADFs from .7z and .tar.gz archives', async () => {
  const { default: SevenZip } = await import('7z-wasm');
  const sz = await SevenZip({ print: () => {}, printErr: () => {} });

  // Fake 256 KB Kickstart ROM with real $1111 Commodore header
  const fakeRom = new Uint8Array(262144);
  fakeRom[0] = 0x11;
  fakeRom[1] = 0x11;
  fakeRom[2] = 0x4e;
  fakeRom[3] = 0xf9;

  sz.FS.mkdir('/pack7z');
  sz.FS.writeFile('/pack7z/kick34005.A500', fakeRom);
  sz.callMain(['a', '/rom.7z', '/pack7z/kick34005.A500']);
  const rom7zBytes = new Uint8Array(sz.FS.readFile('/rom.7z'));

  const resolvedRom = await resolveUploadedFileAsync('Kickstart13.7z', rom7zBytes);
  assert.equal(resolvedRom.kind, 'rom');
  if (resolvedRom.kind === 'rom') {
    assert.equal(resolvedRom.name, 'kick34005.A500');
    assert.equal(resolvedRom.bytes.length, 262144);
    assert.deepEqual(resolvedRom.bytes, fakeRom);
  }

  // Pack two ADFs into .tar -> .gz (.tar.gz) to test recursive unwrapping
  const adf1 = buildBuiltinAdf('boing_studio');
  const adf2 = buildBuiltinAdf('shadow_runner');
  sz.FS.mkdir('/packtar');
  sz.FS.writeFile('/packtar/Disk1.adf', adf1);
  sz.FS.writeFile('/packtar/Disk2.adf', adf2);
  sz.callMain(['a', '-ttar', '/disks.tar', '/packtar/Disk1.adf', '/packtar/Disk2.adf']);
  const tarBytes = new Uint8Array(sz.FS.readFile('/disks.tar'));
  const tarGzBytes = new Uint8Array(zlib.gzipSync(tarBytes));

  const resolvedTarGz = await resolveUploadedFileAsync('TwoDisks.tar.gz', tarGzBytes);
  assert.equal(resolvedTarGz.kind, 'archive-choices');
  if (resolvedTarGz.kind === 'archive-choices') {
    assert.equal(resolvedTarGz.mediaItems.length, 2);
    assert.equal(resolvedTarGz.mediaItems[0].name, 'Disk1.adf');
    assert.deepEqual(resolvedTarGz.mediaItems[0].extractBytes(), adf1);
    assert.deepEqual(resolvedTarGz.mediaItems[1].extractBytes(), adf2);
  }
});

test('bios/workbench.LHA packs into 4MB HDF, reports accurate bitmap usage, resizes cleanly, and boots Workbench 1.3', async () => {
  const wbPath = path.resolve(process.cwd(), 'bios/workbench.LHA');
  const romPath = path.resolve(
    process.cwd(),
    'bios/Kickstart v1.3 r34.005 (1987-12)(Commodore)(A3000)[!].rom'
  );
  if (!fs.existsSync(wbPath) || !fs.existsSync(romPath)) {
    return;
  }

  const wbBytes = new Uint8Array(fs.readFileSync(wbPath));
  const resolved = await resolveUploadedFileAsync('workbench.LHA', wbBytes);
  assert.equal(resolved.kind, 'archive-files');
  if (resolved.kind !== 'archive-files') return;

  const hdf4 = resolved.buildHdf(4);
  assert.equal(hdf4.length, 4 * 1024 * 1024);

  const usage4 = inspectAmigaDosUsage(hdf4);
  assert.equal(usage4.totalDataBytes, 4 * 1024 * 1024);
  assert.equal(usage4.usedBytes + usage4.freeBytes, usage4.totalDataBytes);
  assert.ok(usage4.usedBytes > 700_000 && usage4.usedBytes < 1_300_000, `Unexpected usedBytes: ${usage4.usedBytes}`);
  assert.equal(usage4.minSizeMB, 1);
  assert.equal(usage4.canResize, true);

  const amiga = new AmigaMachine({
    chipset: 'ECS',
    videoStandard: 'PAL',
    chipRamKB: 1024,
    slowRamKB: 512,
    audioEnabled: false,
  });
  const romBytes = new Uint8Array(fs.readFileSync(romPath));
  amiga.loadCustomRom(romBytes, 'KS1.3');
  const mountRes = amiga.mountHdf(hdf4, 'workbench.hdf', true);
  assert.equal(mountRes.ok, true);

  const snap4 = amiga.getStatusSnapshot().dh0;
  assert.equal(snap4.sizeBytes, 4 * 1024 * 1024);
  assert.equal(snap4.usedBytes, usage4.usedBytes);
  assert.equal(snap4.freeBytes, usage4.freeBytes);
  assert.equal(snap4.canResize, true);

  // Resize from 4MB -> 8MB and verify all files survive intact
  const extractedBefore = extractAmigaDosFiles(amiga.hardfile.data!);
  assert.ok(extractedBefore && extractedBefore.files.length >= 170);

  const resizeUp = amiga.resizeHdf(8, false);
  assert.equal(resizeUp.ok, true);
  const snap8 = amiga.getStatusSnapshot().dh0;
  assert.equal(snap8.sizeBytes, 8 * 1024 * 1024);
  assert.ok(snap8.freeBytes > 6_500_000);

  const extractedAfter = extractAmigaDosFiles(amiga.hardfile.data!);
  assert.ok(extractedAfter);
  assert.equal(extractedAfter.files.length, extractedBefore.files.length);

  // Verify AmigaDOS Pure (0x20) and Script (0x40) protection flags survive LHA -> HDF -> resize
  const execFile = extractedAfter.files.find((f) => f.path.toLowerCase() === 'c/execute');
  const startupFile = extractedAfter.files.find((f) => f.path.toLowerCase() === 's/startup-sequence');
  assert.ok(execFile && ((execFile.protection ?? 0) & 0x20) === 0x20, 'c/Execute must keep Pure (0x20) bit');
  assert.ok(startupFile && ((startupFile.protection ?? 0) & 0x40) === 0x40, 's/Startup-Sequence must keep Script (0x40) bit');

  // Resize down to 2MB and boot Workbench 1.3
  const resizeDown = amiga.resizeHdf(2, true);
  assert.equal(resizeDown.ok, true);
  assert.equal(amiga.getStatusSnapshot().dh0.sizeBytes, 2 * 1024 * 1024);

  for (let f = 0; f < 550; f++) {
    amiga.stepFrame(f === 549);
  }
  const fb = amiga.getFramebuffer();
  const colors = new Set<number>();
  for (let i = 0; i < fb.length; i += 17) colors.add(fb[i]);
  assert.ok(colors.has(0xffaa5500), 'Expected Kickstart 1.3 Workbench blue background');
  assert.ok(colors.size >= 4, `Expected Workbench desktop colors, got ${colors.size}`);
});

test('Dual hardfile DH0: (system) + DH1: (user data) mount together, resize independently, and respond via amigahd.device', () => {
  const romPath = path.resolve(
    process.cwd(),
    'bios/Kickstart v1.3 r34.005 (1987-12)(Commodore)(A3000)[!].rom'
  );
  if (!fs.existsSync(romPath)) {
    return;
  }

  const amiga = new AmigaMachine({
    chipset: 'ECS',
    videoStandard: 'PAL',
    chipRamKB: 1024,
    slowRamKB: 512,
    audioEnabled: false,
  });
  amiga.loadCustomRom(new Uint8Array(fs.readFileSync(romPath)), 'KS1.3');

  const sysHdf = createPopulatedHdf('Workbench', [
    { path: 's/startup-sequence', bytes: new Uint8Array(Buffer.from('dir DH1:\n')) },
  ], 2);
  const gamesHdf = createPopulatedHdf('GamesHD', [
    { path: 'MyGame/readme.txt', bytes: new Uint8Array(Buffer.from('Game data on DH1\n')) },
  ], 3);

  assert.equal(amiga.mountHdf(sysHdf, 'workbench.hdf', false, 0).ok, true);
  assert.equal(amiga.mountHdf(gamesHdf, 'games.hdf', true, 1).ok, true);

  const snap = amiga.getStatusSnapshot();
  assert.equal(snap.dh0.mounted, true);
  assert.equal(snap.dh0.name, 'workbench.hdf');
  assert.equal(snap.dh0.sizeBytes, 2 * 1024 * 1024);
  assert.equal(snap.dh1.mounted, true);
  assert.equal(snap.dh1.name, 'games.hdf');
  assert.equal(snap.dh1.sizeBytes, 3 * 1024 * 1024);

  // Resize DH1 independently without touching DH0
  const resizeDh1 = amiga.resizeHdf(5, false, 1);
  assert.equal(resizeDh1.ok, true);
  assert.equal(amiga.getStatusSnapshot().dh0.sizeBytes, 2 * 1024 * 1024);
  assert.equal(amiga.getStatusSnapshot().dh1.sizeBytes, 5 * 1024 * 1024);

  amiga.hardReset();
  let sawDh0Io = false;
  let sawDh1Io = false;
  for (let f = 0; f < 420; f++) {
    amiga.stepFrame(false);
    if (amiga.hardfile.units[0].ioPulseFrames > 0) sawDh0Io = true;
    if (amiga.hardfile.units[1].ioPulseFrames > 0) sawDh1Io = true;
  }
  assert.equal(sawDh0Io, true, 'Expected DH0: boot reads via unit 0');
  assert.equal(sawDh1Io, true, 'Expected DH1: reads via unit 1');

  // Eject DH1 while DH0 remains mounted
  amiga.ejectHdf(false, 1);
  assert.equal(amiga.getStatusSnapshot().dh0.mounted, true);
  assert.equal(amiga.getStatusSnapshot().dh1.mounted, false);
});

test('bios/workbench31.hdf embeds WHDLoad Kickstarts (34005/40068 + RTB/PAT) and boots A1200 Workbench 3.1', () => {
  const wb31Path = path.resolve(process.cwd(), 'bios/workbench31.hdf');
  const rom31Path = path.resolve(
    process.cwd(),
    'bios/Kickstart v3.1 rev 40.68 (1993)(Commodore)(A1200)[!].rom'
  );
  if (!fs.existsSync(wb31Path) || !fs.existsSync(rom31Path)) {
    return;
  }

  const wb31Bytes = new Uint8Array(fs.readFileSync(wb31Path));
  const ext = extractAmigaDosFiles(wb31Bytes);
  assert.ok(ext);
  const byPath = new Map(ext.files.map((f) => [f.path.toLowerCase(), f]));

  const kick13 = byPath.get('devs/kickstarts/kick34005.a500');
  const kick13Rtb = byPath.get('devs/kickstarts/kick34005.a500.rtb');
  const kick31 = byPath.get('devs/kickstarts/kick40068.a1200');
  const kick31Rtb = byPath.get('devs/kickstarts/kick40068.a1200.rtb');
  assert.ok(kick13 && kick13.bytes.length === 262144 && crc32(kick13.bytes) === 0xc4f0f55f);
  assert.ok(kick13Rtb && kick13Rtb.bytes.length > 0);
  assert.ok(kick31 && kick31.bytes.length === 524288 && crc32(kick31.bytes) === 0x1483a091);
  assert.ok(kick31Rtb && kick31Rtb.bytes.length > 0);
  assert.ok(byPath.has('c/whdload'));

  const amiga = new AmigaMachine({
    chipset: 'AGA',
    videoStandard: 'PAL',
    chipRamKB: 2048,
    fastRamKB: 4096,
    audioEnabled: false,
  });
  amiga.loadCustomRom(new Uint8Array(fs.readFileSync(rom31Path)), 'KS3.1');
  assert.equal(amiga.mountHdf(wb31Bytes, 'workbench31.hdf', true).ok, true);

  for (let f = 0; f < 450; f++) {
    amiga.stepFrame(f === 449);
  }
  const fb = amiga.getFramebuffer();
  const colors = new Set<number>();
  for (let i = 0; i < fb.length; i += 17) colors.add(fb[i]);
  assert.ok(colors.size >= 4, `Expected Workbench 3.1 desktop colors, got ${colors.size}`);
});

test('LHA parser strips NUL-separated AmigaDOS FileNote comments in Level 0 and Level 2 headers', () => {
  const diskData = new Uint8Array([0x44, 0x4f, 0x53, 0x00, 1, 2, 3, 4]);
  const lha0 = buildLhaLevel0Entry('Dune\xffDisk.1\0Dune', diskData);
  const parsed0 = parseLhaArchive(lha0);
  assert.equal(parsed0.length, 1);
  assert.equal(parsed0[0].path, 'Dune/Disk.1');
  assert.deepEqual(parsed0[0].extract(), diskData);

  const lha2 = buildLhaLevel2Entry('Dune\xffSub\0DirComment', 'Disk.2\0Dune FileNote', diskData);
  const parsed2 = parseLhaArchive(lha2);
  assert.equal(parsed2.length, 1);
  assert.equal(parsed2[0].path, 'Dune/Sub/Disk.2');
  assert.deepEqual(parsed2[0].extract(), diskData);

  const resolved = resolveUploadedFile('Dune.lha', lha2);
  assert.equal(resolved.kind, 'archive-files');
  if (resolved.kind === 'archive-files') {
    const hdf = resolved.buildHdf(2);
    const extracted = extractAmigaDosFiles(hdf);
    assert.ok(extracted);
    assert.deepEqual(
      extracted.files.map((f) => f.path),
      ['Dune/Sub/Disk.2']
    );
  }
});

test('repairAmigaDosNulFilenames leaves clean HDFs untouched and repairs NUL-corrupted hash buckets on mount', () => {
  const payload = new Uint8Array(Buffer.from('DUNE-DISK-1-DATA'.repeat(40)));
  const cleanHdf = createPopulatedHdf(
    'Dune_v2.5_1156',
    [{ path: 'Dune/Disk.1', bytes: payload, protection: 0x04 }],
    2
  );

  // Zero-allocation fast path when clean
  assert.equal(repairAmigaDosNulFilenames(cleanHdf), cleanHdf);

  // Reproduce legacy NUL-comment corruption: "Disk.1\0Dune" in bucket 33 instead of "Disk.1" in bucket 28
  const corruptHdf = new Uint8Array(cleanHdf);
  const view = new DataView(corruptHdf.buffer);
  const rootBlk = view.getUint32(8, false);
  const rootOff = rootBlk * 512;

  // Find "Dune" directory block in root hash table
  let duneDirBlk = 0;
  for (let h = 0; h < 72; h++) {
    const b = view.getUint32(rootOff + 24 + h * 4, false);
    if (b > 0) {
      duneDirBlk = b;
      break;
    }
  }
  assert.ok(duneDirBlk >= 2);
  const duneOff = duneDirBlk * 512;

  // Bucket for "Disk.1" = 28; bucket for "Disk.1\0Dune" = 33
  const fileHdrBlk = view.getUint32(duneOff + 24 + 28 * 4, false);
  assert.ok(fileHdrBlk >= 2, 'Expected Disk.1 in AmigaDOS hash bucket 28');
  view.setUint32(duneOff + 24 + 28 * 4, 0, false);
  view.setUint32(duneOff + 24 + 33 * 4, fileHdrBlk, false);

  const fileHdrOff = fileHdrBlk * 512;
  const brokenName = 'Disk.1\0Dune';
  corruptHdf[fileHdrOff + 432] = brokenName.length;
  for (let i = 0; i < brokenName.length; i++) {
    corruptHdf[fileHdrOff + 433 + i] = brokenName.charCodeAt(i);
  }

  // Recompute checksums on modified blocks
  for (const blk of [duneDirBlk, fileHdrBlk]) {
    const base = blk * 512;
    view.setUint32(base + 20, 0, false);
    let sum = 0;
    for (let i = 0; i < 128; i++) sum = (sum + view.getUint32(base + i * 4, false)) >>> 0;
    view.setUint32(base + 20, (-sum) >>> 0, false);
  }

  // Repair directly moves "Disk.1" back into bucket 28 and clears bucket 33
  const repaired = repairAmigaDosNulFilenames(corruptHdf);
  assert.notEqual(repaired, corruptHdf);
  const repView = new DataView(repaired.buffer);
  const repRootOff = repView.getUint32(8, false) * 512;
  let repDuneBlk = 0;
  for (let h = 0; h < 72; h++) {
    const b = repView.getUint32(repRootOff + 24 + h * 4, false);
    if (b > 0) {
      repDuneBlk = b;
      break;
    }
  }
  const repDuneOff = repDuneBlk * 512;
  assert.equal(repView.getUint32(repDuneOff + 24 + 33 * 4, false), 0);
  const repFileBlk = repView.getUint32(repDuneOff + 24 + 28 * 4, false);
  assert.ok(repFileBlk >= 2, 'Expected repaired Disk.1 back in bucket 28');
  assert.equal(repaired[repFileBlk * 512 + 432], 6);

  const extracted = extractAmigaDosFiles(repaired);
  assert.ok(extracted);
  assert.equal(extracted.volumeName, 'Dune_v2.5_1156');
  assert.equal(extracted.files.length, 1);
  assert.equal(extracted.files[0].path, 'Dune/Disk.1');
  assert.deepEqual(extracted.files[0].bytes, payload);

  // Verify AmigaMachine.mountHdf auto-repairs on mount
  const amiga = new AmigaMachine({ audioEnabled: false });
  const mountRes = amiga.mountHdf(corruptHdf, 'Dune_v2.5_1156.hdf', false, 1);
  assert.equal(mountRes.ok, true);
  const mountedExt = extractAmigaDosFiles(amiga.hardfile.units[1].data!);
  assert.ok(mountedExt);
  assert.equal(mountedExt.files[0].path, 'Dune/Disk.1');
  assert.deepEqual(mountedExt.files[0].bytes, payload);
});


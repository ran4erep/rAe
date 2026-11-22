/**
 * Fast Headless Amiga Boot & Crash Triage Runner (Node.js / tsx, no browser).
 *
 * Usage examples:
 *   npx --yes tsx scripts/headless-triage.ts Aladdin.zip --frames 300 --rom 1.3
 *   npx --yes tsx scripts/headless-triage.ts savestate-xxx.json --frames 60 --rom 3.1
 *   npx --yes tsx scripts/headless-triage.ts --rom 3.1 --chipset AGA --dh0 auto --frames 180
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveUploadedFileAsync } from '../src/emulator/archives/archiveManager';
import { formatAmigaTriageText } from '../src/emulator/debug/triageReport';
import { parseDiagnosticSavestateJson } from '../src/emulator/debug/savestateFile';
import { AmigaMachine } from '../src/emulator/hardware/amigaMachine';
import { A1200_BIOS_ROM_NAME, A500_BIOS_ROM_NAME } from '../src/emulator/roms/biosProfiles';
import { ChipRamKB, ChipsetModel, FastRamKB, SlowRamKB, VideoStandard } from '../src/emulator/types';

interface CliOpts {
  inputPath: string | null;
  rom: string;
  chipset: ChipsetModel;
  chipKB: ChipRamKB;
  slowKB: SlowRamKB;
  fastKB: FastRamKB;
  video: VideoStandard;
  frames: number;
  traceEvery: number;
  dh0: string | null;
  turbo: boolean;
  packMode: 'auto' | 'adf' | 'hdf';
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    inputPath: null,
    rom: '1.3',
    chipset: 'ECS',
    chipKB: 1024,
    slowKB: 512,
    fastKB: 0,
    video: 'auto',
    frames: 300,
    traceEvery: 0,
    dh0: null,
    turbo: true,
    packMode: 'auto',
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      console.log(
        [
          'Headless Amiga Triage Runner',
          'Usage: npx --yes tsx scripts/headless-triage.ts [file.(adf|zip|lha|hdf|json)] [options]',
          'Options:',
          '  --rom <1.3|3.1|openkick|path>   ROM to boot (default: 1.3)',
          '  --chipset <OCS|ECS|AGA>         Chipset model (default: ECS, or AGA if --rom 3.1)',
          '  --chip <512|1024|2048>          Chip RAM KB',
          '  --slow <0|512>                  Slow RAM KB',
          '  --fast <0|1024|2048|4096|8192>  Fast RAM KB',
          '  --video <auto|PAL|NTSC>         Video standard',
          '  --frames <N>                    Frames to execute (default: 300)',
          '  --trace-every <N>               Print compact PC/DF0 line every N frames',
          '  --dh0 <auto|path>               Mount Workbench DH0 (from bios/workbench.LHA or .hdf)',
          '  --pack <auto|adf|hdf>           How to pack file-only archives',
          '  --no-turbo                      Disable turbo floppy',
        ].join('\n')
      );
      process.exit(0);
    } else if (a === '--rom' && i + 1 < argv.length) {
      opts.rom = argv[++i];
    } else if (a === '--chipset' && i + 1 < argv.length) {
      const c = argv[++i].toUpperCase();
      if (c === 'OCS' || c === 'ECS' || c === 'AGA') opts.chipset = c;
    } else if (a === '--chip' && i + 1 < argv.length) {
      const v = Number(argv[++i]);
      if (v === 512 || v === 1024 || v === 2048) opts.chipKB = v;
    } else if (a === '--slow' && i + 1 < argv.length) {
      const v = Number(argv[++i]);
      if (v === 0 || v === 512) opts.slowKB = v;
    } else if (a === '--fast' && i + 1 < argv.length) {
      const v = Number(argv[++i]);
      if (v === 0 || v === 1024 || v === 2048 || v === 4096 || v === 8192) opts.fastKB = v;
    } else if (a === '--video' && i + 1 < argv.length) {
      const v = argv[++i];
      if (v === 'auto' || v === 'PAL' || v === 'NTSC') opts.video = v;
    } else if (a === '--frames' && i + 1 < argv.length) {
      opts.frames = Math.max(0, Number(argv[++i]) || 0);
    } else if (a === '--trace-every' && i + 1 < argv.length) {
      opts.traceEvery = Math.max(0, Number(argv[++i]) || 0);
    } else if (a === '--dh0' && i + 1 < argv.length) {
      opts.dh0 = argv[++i];
    } else if (a === '--pack' && i + 1 < argv.length) {
      const p = argv[++i];
      if (p === 'auto' || p === 'adf' || p === 'hdf') opts.packMode = p;
    } else if (a === '--no-turbo') {
      opts.turbo = false;
    } else if (a === '--turbo') {
      opts.turbo = true;
    } else if (!a.startsWith('--') && !opts.inputPath) {
      opts.inputPath = a;
    }
  }

  return opts;
}

function resolveRomPath(romArg: string): { path: string; name: string } | null {
  if (romArg === 'openkick') return null;
  const biosDir = path.resolve(process.cwd(), 'bios');
  if (romArg === '1.3') {
    const p = path.join(biosDir, A500_BIOS_ROM_NAME);
    return fs.existsSync(p) ? { path: p, name: A500_BIOS_ROM_NAME } : null;
  }
  if (romArg === '3.1') {
    const p = path.join(biosDir, A1200_BIOS_ROM_NAME);
    return fs.existsSync(p) ? { path: p, name: A1200_BIOS_ROM_NAME } : null;
  }
  const abs = path.resolve(process.cwd(), romArg);
  if (fs.existsSync(abs)) {
    return { path: abs, name: path.basename(abs) };
  }
  return null;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const machine = new AmigaMachine(
    {
      chipset: opts.chipset,
      chipRamKB: opts.chipKB,
      slowRamKB: opts.slowKB,
      fastRamKB: opts.fastKB,
      videoStandard: opts.video,
      turboFloppy: opts.turbo,
      audioEnabled: false,
      floppyAudioEnabled: false,
    },
    { skipDefaultDisk: true }
  );

  const romInfo = resolveRomPath(opts.rom);
  if (romInfo) {
    const romBytes = new Uint8Array(fs.readFileSync(romInfo.path));
    const res = machine.loadCustomRom(romBytes, romInfo.name);
    if (!res.ok) {
      console.error(`ROM error: ${res.error}`);
      process.exit(1);
    }
  }

  if (opts.dh0) {
    const wbPath =
      opts.dh0 === 'auto'
        ? path.resolve(process.cwd(), 'bios', 'workbench.LHA')
        : path.resolve(process.cwd(), opts.dh0);
    if (fs.existsSync(wbPath)) {
      const wbBytes = new Uint8Array(fs.readFileSync(wbPath));
      const resolved = await resolveUploadedFileAsync(path.basename(wbPath), wbBytes);
      if (resolved.kind === 'hdf') {
        machine.mountHdf(resolved.bytes, resolved.name, true, 0);
      } else if (resolved.kind === 'archive-files' || resolved.kind === 'archive-choices') {
        machine.mountHdf(resolved.buildHdf(4), 'workbench.hdf', true, 0);
      }
    }
  }

  if (opts.inputPath) {
    const absInput = path.resolve(process.cwd(), opts.inputPath);
    if (!fs.existsSync(absInput)) {
      console.error(`Input file not found: ${absInput}`);
      process.exit(1);
    }
    const baseName = path.basename(absInput);

    if (baseName.toLowerCase().endsWith('.json')) {
      const jsonText = fs.readFileSync(absInput, 'utf8');
      const parsed = parseDiagnosticSavestateJson(jsonText);
      if (!parsed.ok) {
        console.error(`Savestate error: ${parsed.error}`);
        process.exit(1);
      }
      const ok = machine.loadSaveBundle(parsed.state, parsed.df0Disk, parsed.df1Disk);
      if (!ok) {
        console.error('Failed to restore savestate bundle.');
        process.exit(1);
      }
      console.error(`[headless] Restored savestate "${baseName}" at frame ${machine.frameCount}`);
    } else {
      const fileBytes = new Uint8Array(fs.readFileSync(absInput));
      const resolved = await resolveUploadedFileAsync(baseName, fileBytes);
      if (resolved.kind === 'adf') {
        machine.insertAdf(0, resolved.bytes, resolved.name, true);
      } else if (resolved.kind === 'hdf') {
        machine.mountHdf(resolved.bytes, resolved.name, true, 1);
      } else if (resolved.kind === 'rom') {
        machine.loadCustomRom(resolved.bytes, resolved.name);
      } else if (resolved.kind === 'archive-choices') {
        const adfs = resolved.mediaItems.filter((m) => m.kind === 'adf');
        const hdfs = resolved.mediaItems.filter((m) => m.kind === 'hdf');
        if (adfs.length > 0) {
          const d0Bytes = adfs[0].extractBytesAsync
            ? await adfs[0].extractBytesAsync()
            : adfs[0].extractBytes();
          machine.insertAdf(0, d0Bytes, adfs[0].name, true);
          if (adfs.length > 1) {
            const d1Bytes = adfs[1].extractBytesAsync
              ? await adfs[1].extractBytesAsync()
              : adfs[1].extractBytes();
            machine.insertAdf(1, d1Bytes, adfs[1].name, false);
          }
        } else if (hdfs.length > 0) {
          const hBytes = hdfs[0].extractBytesAsync
            ? await hdfs[0].extractBytesAsync()
            : hdfs[0].extractBytes();
          machine.mountHdf(hBytes, hdfs[0].name, true, 1);
        }
      } else if (resolved.kind === 'archive-files') {
        const useAdf =
          opts.packMode === 'adf' || (opts.packMode === 'auto' && resolved.fitsFloppy);
        if (useAdf) {
          machine.insertAdf(0, resolved.buildAdf(), `${resolved.volumeName}.adf`, true);
        } else {
          machine.mountHdf(resolved.buildHdf(), `${resolved.volumeName}.hdf`, true, 1);
        }
      }
    }
  }

  const t0 = performance.now();
  for (let f = 0; f < opts.frames; f++) {
    machine.stepFrame(false, false);
    if (opts.traceEvery > 0 && ((f + 1) % opts.traceEvery === 0)) {
      const pc = (machine.cpu.pc & 0x00ffffff).toString(16).toUpperCase().padStart(6, '0');
      const d0 = machine.floppy.drives[0];
      console.log(
        `[F${String(machine.frameCount).padStart(4, '0')}] PC=$${pc} OVL=${machine.memory.ovl ? 1 : 0} cyl=${d0.cylinder}:${d0.side} io=${machine.floppy.ioSeq} faults=${machine.cpu.getRecentFaults().length}`
      );
    }
  }
  // Render final 1 frame so screenSummary reflects actual visible pixels
  machine.stepFrame(true, false);
  const elapsedMs = Math.round(performance.now() - t0);
  console.error(`[headless] Executed ${opts.frames + 1} frames in ${elapsedMs} ms`);
  console.log(formatAmigaTriageText(machine));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

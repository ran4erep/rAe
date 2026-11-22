/**
 * Compact On-Demand Amiga Triage Report Generator (`triage-*.txt`).
 * Runs ONLY when explicitly requested (0% runtime CPU overhead, 0 Base64 RAM blobs).
 * Produces ~2-5 KB of structured plain text with 68k disassembly, loop diagnosis,
 * chipset/Copper/CIA/storage state, and discrete boot/IO milestone events.
 */

import {
  AmigaMachine,
  TRIAGE_EVT_CPU_RESET,
  TRIAGE_EVT_DISK_DMA,
  TRIAGE_EVT_FLOPPY_MOTOR,
  TRIAGE_EVT_FLOPPY_STEP,
  TRIAGE_EVT_HARD_RESET,
  TRIAGE_EVT_OVL,
  TRIAGE_EVT_WARM_RESET,
  TriageEventEntry,
} from '../hardware/amigaMachine';
import {
  DMA_BITPLANE,
  DMA_COPPER,
  DMA_MASTER,
  INT_INTEN,
} from '../hardware/chipset';
import { verifyAmigaBootblockChecksum } from '../hardware/floppy';
import {
  bytesToHexString,
  classifyAddressRegion,
  decodeCopperListFromPeek,
  decodeDmaconFlags,
  decodeIntFlags,
  hex,
  summarizeFramebuffer,
  VECTOR_NAMES,
} from './debugDump';
import {
  detectWaitLoopHints,
  DisasmLine,
  disassembleOne68k,
  disassembleSubroutine,
  disassembleWindowAroundPc,
} from './disasm68k';

function fmtHex6(v: number): string {
  return '$' + (v & 0x00ffffff).toString(16).toUpperCase().padStart(6, '0');
}

function fmtHex8(v: number): string {
  return '$' + (v >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

function fmtHex4(v: number): string {
  return '$' + (v & 0xffff).toString(16).toUpperCase().padStart(4, '0');
}

function fmtHex2(v: number): string {
  return '$' + (v & 0xff).toString(16).toUpperCase().padStart(2, '0');
}

export function formatTriageEvent(ev: TriageEventEntry): string {
  const f = `F${String(ev.frame).padStart(4, ' ')}`;
  switch (ev.kind) {
    case TRIAGE_EVT_HARD_RESET:
      return `${f} HARD_RESET`;
    case TRIAGE_EVT_WARM_RESET:
      return `${f} WARM_RESET`;
    case TRIAGE_EVT_CPU_RESET:
      return `${f} CPU_RESET_INSN @ ${fmtHex6(ev.arg1)}`;
    case TRIAGE_EVT_OVL:
      return `${f} OVL -> ${ev.arg1 ? 'ON (ROM @ $000000)' : 'OFF (ChipRAM @ $000000)'}`;
    case TRIAGE_EVT_FLOPPY_MOTOR:
      return `${f} DF${ev.arg1}: MOTOR ${ev.arg2 ? 'ON' : 'OFF'}`;
    case TRIAGE_EVT_FLOPPY_STEP: {
      const cyl = ev.arg2 >> 1;
      const side = ev.arg2 & 1;
      return `${f} DF${ev.arg1}: STEP cyl=${cyl} side=${side}`;
    }
    case TRIAGE_EVT_DISK_DMA: {
      const drv = (ev.arg1 >>> 16) & 1;
      const isWr = (ev.arg1 & 0x8000) !== 0;
      const words = ev.arg1 & 0x7fff;
      const cyl = ev.arg2 >> 1;
      const side = ev.arg2 & 1;
      return `${f} DF${drv}: DISK_DMA ${isWr ? 'WRITE' : 'READ'} ${words}w (cyl=${cyl} side=${side})`;
    }
    default:
      return `${f} EVT_${ev.kind} (${ev.arg1}, ${ev.arg2})`;
  }
}

const IRQ_BIT_INFO: Array<{ name: string; ipl: number }> = [
  { name: 'TBE', ipl: 1 },
  { name: 'DSKBLK', ipl: 1 },
  { name: 'SOFT', ipl: 1 },
  { name: 'PORTS', ipl: 2 },
  { name: 'COPER', ipl: 3 },
  { name: 'VERTB', ipl: 3 },
  { name: 'BLIT', ipl: 3 },
  { name: 'AUD0', ipl: 4 },
  { name: 'AUD1', ipl: 4 },
  { name: 'AUD2', ipl: 4 },
  { name: 'AUD3', ipl: 4 },
  { name: 'RBF', ipl: 5 },
  { name: 'DSKSYN', ipl: 5 },
  { name: 'EXTER', ipl: 6 },
];

function detectIntreqWaitContradiction(
  lines: DisasmLine[],
  pcIndex: number,
  intena: number,
  intreq: number,
  vbrBase: number,
  ovl: boolean,
  peek32: (addr: number) => number
): string | null {
  const start = Math.max(0, pcIndex - 6);
  const end = Math.min(lines.length, pcIndex + 6);
  let polledBit: number | null = null;
  let sawIntreqrWordLoad = false;

  for (let i = start; i < end; i++) {
    const line = lines[i];
    const mn = line.mnemonic;
    const mLow = mn.match(/^BTST #(\d+),\(\$DFF01F\)\.L$/);
    if (mLow) {
      polledBit = Number(mLow[1]) & 7;
      break;
    }
    const mHigh = mn.match(/^BTST #(\d+),\(\$DFF01E\)\.L$/);
    if (mHigh) {
      polledBit = (Number(mHigh[1]) & 7) + 8;
      break;
    }
    if (mn.includes('$DFF01E') || line.comment.includes('INTREQR')) {
      sawIntreqrWordLoad = true;
      continue;
    }
    if (sawIntreqrWordLoad) {
      const mBtstReg = mn.match(/^BTST #(\d+),D\d+$/);
      if (mBtstReg) {
        polledBit = Number(mBtstReg[1]) & 15;
        break;
      }
      const mAndi = mn.match(/^ANDI\.[WL] #\$([0-9A-F]+),D\d+$/);
      if (mAndi) {
        const mask = parseInt(mAndi[1], 16) & 0x3fff;
        if (mask !== 0 && (mask & (mask - 1)) === 0) {
          polledBit = Math.clz32(mask) ^ 31;
          break;
        }
      }
    }
  }

  if (polledBit === null || polledBit < 0 || polledBit >= IRQ_BIT_INFO.length) {
    return null;
  }

  const info = IRQ_BIT_INFO[polledBit];
  const bitMask = 1 << polledBit;
  const intMaster = (intena & INT_INTEN) !== 0;
  const bitEnabled = (intena & bitMask) !== 0;
  const vecAddr = peek32((vbrBase + (24 + info.ipl) * 4) & 0x00fffffe);
  const inRom = ovl || (vecAddr >= 0xf80000 && vecAddr < 0x1000000);

  if (intMaster && bitEnabled) {
    if (inRom) {
      return `CRITICAL: Код в busy-wait ждёт INTREQR bit ${polledBit} (${info.name}), но он ВКЛЮЧЁН в INTENA=${fmtHex4(intena)} (INTEN=1) и ROM L${info.ipl}=${fmtHex6(vecAddr)} очищает INTREQ до RTE — цикл никогда не дождётся флага!`;
    }
    return `Конфликт IRQ: код опрашивает INTREQR bit ${polledBit} (${info.name}), но он включён в INTENA=${fmtHex4(intena)} (вектор L${info.ipl}=${fmtHex6(vecAddr)}) — обработчик прерывания может сбрасывать флаг (INTREQ=${fmtHex4(intreq)}).`;
  }
  return null;
}

export function formatAmigaTriageText(machine: AmigaMachine, now = new Date()): string {
  const { cpu, chipset, cia, memory, floppy, hardfile } = machine;
  const peek16 = (addr: number) => memory.peek16(addr);
  const peek32 = (addr: number) => memory.peek32(addr);

  const pc = cpu.pc & 0x00ffffff;
  const pcRegion = classifyAddressRegion(
    pc,
    memory.ovl,
    memory.chipRamSize,
    memory.slowRamSize,
    memory.fastRamSize,
    hardfile.configuredBase
  );
  const faults = cpu.getRecentFaults();
  const framePcs = machine.getRecentPcHistory();
  const screen = summarizeFramebuffer(machine);

  const tailPcs = framePcs.slice(-20);
  const uniqueTailPcs = new Set(tailPcs);
  const pcStuckLikely = tailPcs.length >= 20 && uniqueTailPcs.size <= 3;

  const disasm = disassembleWindowAroundPc(peek16, pc, 20, 12);
  const waitHints = detectWaitLoopHints(disasm.lines, disasm.pcIndex);

  const sr = cpu.sr & 0xffff;
  const srIpl = (sr >>> 8) & 7;
  const srFlags = [
    sr & 0x8000 ? 'T' : '-',
    sr & 0x2000 ? 'S' : 'U',
    `IPL${srIpl}`,
    sr & 0x0010 ? 'X' : '-',
    sr & 0x0008 ? 'N' : '-',
    sr & 0x0004 ? 'Z' : '-',
    sr & 0x0002 ? 'V' : '-',
    sr & 0x0001 ? 'C' : '-',
  ].join(' ');

  // Build automatic diagnosis hints
  const verdict: string[] = [];
  if (memory.ovl) {
    verdict.push('OVL=1: Kickstart всё ещё перекрывает $000000 (ранняя инициализация ROM не завершена)');
  }
  if (pcRegion === 'unmapped') {
    verdict.push(`CRITICAL: PC=${fmtHex6(pc)} указывает в немаппированную память (unmapped)!`);
  }
  if (cpu.stopped) {
    const intMaster = (chipset.intena & INT_INTEN) !== 0;
    verdict.push(
      `CPU в состоянии STOP (SR.IPL=${srIpl}, INTENA=${fmtHex4(chipset.intena)}, master=${intMaster ? 'ON' : 'OFF'}, pendingIpl=${cpu.pendingIpl})`
    );
  }
  const realFaults = faults.filter(
    (f) => !(f.vector === 11 && f.pc === 0xf80ca0 && f.opcode === 0xf201)
  );
  if (realFaults.length > 0) {
    const last = realFaults[realFaults.length - 1];
    const vName = VECTOR_NAMES[last.vector] ?? `Vector ${last.vector}`;
    verdict.push(
      `Зафиксированы исключения CPU (${realFaults.length}x): последнее ${vName} @ ${fmtHex6(last.pc)} opcode=${fmtHex4(last.opcode)}`
    );
  }
  if (pcStuckLikely) {
    verdict.push(
      `PC почти не меняется последние ${tailPcs.length} кадров (уникальных PC: ${uniqueTailPcs.size}) — вероятное зависание/ожидание`
    );
  }
  for (const h of waitHints) {
    verdict.push(h);
  }
  const vbrBase = cpu.is68020 ? cpu.vbr & 0x00fffffe : 0;
  const intreqConflict = detectIntreqWaitContradiction(
    disasm.lines,
    disasm.pcIndex,
    chipset.intena,
    chipset.intreq,
    vbrBase,
    memory.ovl,
    peek32
  );
  if (intreqConflict) {
    verdict.push(intreqConflict);
  }
  const bplCount = (chipset.bplCon0 >>> 12) & 7;
  if (screen.nonBlackPixels === 0) {
    const missing: string[] = [];
    if ((chipset.dmacon & DMA_MASTER) === 0) missing.push('DMAEN=0');
    if ((chipset.dmacon & DMA_BITPLANE) === 0) missing.push('BPLEN=0');
    if ((chipset.dmacon & DMA_COPPER) === 0) missing.push('COPEN=0');
    if (bplCount === 0) missing.push('BPLCON0.BPU=0');
    if (chipset.cop1lc === 0) missing.push('COP1LC=0');
    verdict.push(
      `Экран полностью чёрный (nonBlack=0${missing.length ? `, ${missing.join(', ')}` : ''})`
    );
  }
  if (
    chipset.copWaiting &&
    machine.getActiveVideoStandard() === 'NTSC' &&
    chipset.copWaitV >= 262
  ) {
    verdict.push(
      `Copper ждёт строку V>=${chipset.copWaitV} в режиме NTSC (макс ~262 строки) — возможен PAL/NTSC deadlock!`
    );
  }
  const d0 = floppy.drives[0];
  const d1 = floppy.drives[1];
  const h0 = hardfile.units[0];
  const h1 = hardfile.units[1];
  if (d0.data && floppy.ioSeq === 0 && !h0.hasReadSinceReset && !h1.hasReadSinceReset) {
    verdict.push('DF0: вставлен, но ioSeq=0 (ни одного обращения к дисководу или HDD после сброса)');
  }
  if (verdict.length === 0) {
    verdict.push('Явных аварийных признаков не обнаружено (CPU активен, экран не пуст).');
  }

  const out: string[] = [];
  out.push('=== AMIGA 500/1200 TRIAGE REPORT ===');
  out.push(
    `Time: ${now.toISOString()} | Frame: ${machine.frameCount} | FPS: ${machine.measuredFps.toFixed(1)} | Paused: ${machine.paused}`
  );
  out.push(
    `Model: ${machine.config.chipset} (${cpu.is68020 ? '68EC020' : '68000'}) | Video: ${machine.getActiveVideoStandard()} (cfg=${machine.config.videoStandard}) | OVL: ${memory.ovl ? 1 : 0}`
  );
  out.push(
    `ROM: ${machine.romName} (${machine.isOpenKick ? 'OpenKick' : 'Custom'}) | RAM: Chip=${machine.config.chipRamKB}KB Slow=${machine.config.slowRamKB}KB Fast=${machine.config.fastRamKB}KB`
  );
  out.push(
    `Screen: ${screen.width}x${screen.height} nonBlack=${screen.nonBlackPixels} colors=${screen.uniqueSampledColors} dominant=${screen.dominantColorAbgrHex}`
  );

  out.push('');
  out.push('[VERDICT]');
  for (const v of verdict) {
    out.push(`- ${v}`);
  }

  out.push('');
  out.push('[CPU]');
  out.push(
    `PC=${fmtHex6(pc)} (${pcRegion}) | SR=${fmtHex4(sr)} [${srFlags}] | stopped=${cpu.stopped} | pendingIpl=${cpu.pendingIpl} | cycles=${cpu.cycles}`
  );
  out.push(
    `USP=${fmtHex8(cpu.usp)} SSP=${fmtHex8(cpu.ssp)}${cpu.is68020 ? ` VBR=${fmtHex8(cpu.vbr)} CACR=${fmtHex4(cpu.cacr)}` : ''}${cpu.supervisorTrapCount > 0 ? ` | ROM_SupervisorCalls=${cpu.supervisorTrapCount}` : ''}`
  );
  out.push(
    `D0..D3: ${Array.from({ length: 4 }, (_, i) => fmtHex8(cpu.d[i])).join(' ')} | D4..D7: ${Array.from({ length: 4 }, (_, i) => fmtHex8(cpu.d[i + 4])).join(' ')}`
  );
  out.push(
    `A0..A3: ${Array.from({ length: 4 }, (_, i) => fmtHex8(cpu.a[i])).join(' ')} | A4..A7: ${Array.from({ length: 4 }, (_, i) => fmtHex8(cpu.a[i + 4])).join(' ')}`
  );
  if (framePcs.length > 0) {
    out.push(`RecentFramePCs(last ${Math.min(16, framePcs.length)}): ${framePcs.slice(-16).map(fmtHex6).join(' ')}`);
  }

  out.push('');
  out.push('[VECTORS & EXEC]');
  const vecEntries: string[] = [];
  for (let lvl = 1; lvl <= 7; lvl++) {
    const vAddr = peek32((vbrBase + (24 + lvl) * 4) & 0x00fffffe);
    const vReg =
      (vAddr >>> 24) === 0
        ? classifyAddressRegion(
            vAddr,
            memory.ovl,
            memory.chipRamSize,
            memory.slowRamSize,
            memory.fastRamSize,
            hardfile.configuredBase
          )
        : 'const';
    const shortTag = vReg.replace('_ram', '').replace('kickstart_', '');
    vecEntries.push(`L${lvl}=${fmtHex6(vAddr)}(${shortTag})`);
  }
  out.push(vecEntries.join(' '));

  // Flag any exception / TRAP vectors redirected into RAM (common in games/WHDLoad/demos)
  const ramHooks: string[] = [];
  const trapVectors: Array<[number, string]> = [
    [2, 'BusErr'], [3, 'AddrErr'], [4, 'Illegal'], [5, 'Div0'],
    [8, 'PrivV'], [10, 'LineA'], [11, 'LineF'],
  ];
  for (let t = 0; t < 16; t++) trapVectors.push([32 + t, `TRAP#${t}`]);
  for (const [vecIdx, label] of trapVectors) {
    const vAddr = peek32((vbrBase + vecIdx * 4) & 0x00fffffe);
    if (vAddr >= 0x400 && vAddr < 0xf80000) {
      const reg = classifyAddressRegion(
        vAddr,
        memory.ovl,
        memory.chipRamSize,
        memory.slowRamSize,
        memory.fastRamSize,
        hardfile.configuredBase
      );
      if (reg === 'chip_ram' || reg === 'slow_ram' || reg === 'fast_ram') {
        ramHooks.push(`${label}=${fmtHex6(vAddr)}`);
      }
    }
  }
  if (ramHooks.length > 0) {
    out.push(`RAM_Traps: ${ramHooks.slice(0, 8).join(' ')}`);
  }

  const execBase = !memory.ovl ? peek32(4) : 0;
  const execReg =
    execBase !== 0 && (execBase >>> 24) === 0
      ? classifyAddressRegion(
          execBase,
          memory.ovl,
          memory.chipRamSize,
          memory.slowRamSize,
          memory.fastRamSize,
          hardfile.configuredBase
        )
      : 'unmapped';
  if (execReg === 'chip_ram' || execReg === 'slow_ram' || execReg === 'fast_ram') {
    const nestWord = peek16((execBase + 0x126) & 0x00fffffe);
    const idNest = ((nestWord >>> 8) << 24) >> 24;
    const tdNest = ((nestWord & 0xff) << 24) >> 24;
    const attnFlags = peek16((execBase + 0x128) & 0x00fffffe);
    const thisTask = peek32((execBase + 0x114) & 0x00fffffe);
    const copData = peek32((execBase + 0x84) & 0x00fffffe);
    const copCode = peek32((execBase + 0x88) & 0x00fffffe);
    const vblData = peek32((execBase + 0x90) & 0x00fffffe);
    const vblCode = peek32((execBase + 0x94) & 0x00fffffe);
    const bltCode = peek32((execBase + 0xa0) & 0x00fffffe);
    out.push(
      `ExecBase=${fmtHex6(execBase)} | ThisTask=${fmtHex6(thisTask)} IDNest=${idNest} TDNest=${tdNest} Attn=${fmtHex4(attnFlags)}`
    );
    out.push(
      `ExecIntVec Code: COPER=${fmtHex6(copCode)} VERTB=${fmtHex6(vblCode)} BLIT=${fmtHex6(bltCode)}`
    );
    const ramIntServers: Array<{ label: string; addr: number }> = [];
    const summarizeIntServer = (label: string, listPtr: number) => {
      if (listPtr === 0 || (listPtr >>> 24) !== 0) return;
      const nodes: string[] = [];
      let cur = peek32(listPtr & 0x00fffffe);
      for (let n = 0; n < 4 && cur !== 0 && (cur >>> 24) === 0; n++) {
        const succ = peek32(cur & 0x00fffffe);
        if (succ === 0) break;
        const pri = ((peek16((cur + 8) & 0x00fffffe) & 0xff) << 24) >> 24;
        const isCode = peek32((cur + 18) & 0x00fffffe);
        nodes.push(`${fmtHex6(isCode)}(pri=${pri})`);
        if (ramIntServers.length < 3 && isCode >= 0x400 && isCode < 0xf80000 && (isCode & 1) === 0) {
          ramIntServers.push({ label, addr: isCode & 0x00fffffe });
        }
        cur = succ;
      }
      if (nodes.length > 0) {
        out.push(`  ${label} servers: ${nodes.join(' -> ')}`);
      }
    };
    summarizeIntServer('COPER', copData);
    summarizeIntServer('VERTB', vblData);
    for (const srv of ramIntServers) {
      const srvLines = disassembleSubroutine(peek16, srv.addr, 32);
      if (srvLines.length > 0) {
        out.push(`  ${srv.label} server @ ${fmtHex6(srv.addr)}:`);
        let nestedTarget: number | null = null;
        for (const sl of srvLines) {
          const cmt = sl.comment ? ` ; ${sl.comment}` : '';
          out.push(`    ${fmtHex6(sl.addr)}: ${sl.mnemonic}${cmt}`);
          if (
            nestedTarget === null &&
            (sl.mnemonic.startsWith('JSR') || sl.mnemonic.startsWith('BSR')) &&
            sl.branchTarget !== null &&
            sl.branchTarget >= 0x400 &&
            sl.branchTarget < 0xf80000
          ) {
            nestedTarget = sl.branchTarget & 0x00fffffe;
          }
        }
        if (nestedTarget !== null) {
          const innerLines = disassembleSubroutine(peek16, nestedTarget, 24);
          if (innerLines.length > 0) {
            out.push(`  ${srv.label} inner @ ${fmtHex6(nestedTarget)}:`);
            for (const il of innerLines) {
              const cmt = il.comment ? ` ; ${il.comment}` : '';
              out.push(`    ${fmtHex6(il.addr)}: ${il.mnemonic}${cmt}`);
            }
          }
        }
      }
    }
  } else {
    out.push(`ExecBase=${fmtHex8(execBase)} (${execReg})`);
  }

  out.push('');
  out.push('[DISASM @ PC]');
  for (let i = 0; i < disasm.lines.length; i++) {
    const l = disasm.lines[i];
    const mark = i === disasm.pcIndex ? '>>>' : '   ';
    const wordsStr = l.words
      .slice(0, 3)
      .map((w) => w.toString(16).toUpperCase().padStart(4, '0'))
      .join(' ')
      .padEnd(14, ' ');
    const cmt = l.comment ? ` ; ${l.comment}` : '';
    out.push(`${mark} ${fmtHex6(l.addr)}: ${wordsStr} ${l.mnemonic}${cmt}`);
  }

  if (faults.length > 0) {
    out.push('');
    out.push('[RECENT FAULTS]');
    const shown = faults.slice(-8);
    for (const f of shown) {
      const fDis = disassembleOne68k(peek16, f.pc);
      const vName = VECTOR_NAMES[f.vector] ?? `Vec${f.vector}`;
      out.push(
        `- ${vName} (#${f.vector}) @ ${fmtHex6(f.pc)} op=${fmtHex4(f.opcode)} (${fDis.mnemonic}) SR=${fmtHex4(f.sr)} SP=${fmtHex8(f.sp)} cyc=${f.cycles}`
      );
    }
  }

  out.push('');
  out.push('[STACK @ A7]');
  const sp = cpu.a[7] >>> 0;
  const stackItems: string[] = [];
  const ramReturnTargets: number[] = [];
  for (let i = 0; i < 12; i++) {
    const val = peek32((sp + i * 4) & 0x00fffffe);
    const reg =
      (val >>> 24) === 0
        ? classifyAddressRegion(
            val,
            memory.ovl,
            memory.chipRamSize,
            memory.slowRamSize,
            memory.fastRamSize,
            hardfile.configuredBase
          )
        : 'const';
    const tag =
      reg === 'chip_ram' || reg === 'fast_ram' || reg === 'kickstart_rom'
        ? `(${reg.replace('_ram', '').replace('kickstart_', '')})`
        : '';
    stackItems.push(`${fmtHex8(val)}${tag}`);
    if (
      ramReturnTargets.length < 3 &&
      (reg === 'chip_ram' || reg === 'fast_ram') &&
      val >= 0x400 &&
      (val & 1) === 0 &&
      !ramReturnTargets.includes(val)
    ) {
      ramReturnTargets.push(val);
    }
  }
  out.push(`A7=${fmtHex8(sp)}: ${stackItems.slice(0, 6).join(' ')}`);
  out.push(`+${' '.repeat(11)}: ${stackItems.slice(6, 12).join(' ')}`);
  for (let idx = 0; idx < ramReturnTargets.length; idx++) {
    const retAddr = ramReturnTargets[idx];
    const before = idx === 0 ? 320 : idx === 1 ? 180 : 32;
    const callerWin = disassembleWindowAroundPc(peek16, retAddr, before, 2);
    let startIdx = Math.max(0, callerWin.pcIndex - (idx === 0 ? 80 : idx === 1 ? 48 : 10));
    if (idx === 0 && callerWin.pcIndex > 0) {
      // Snap startIdx to nearest function prologue (MOVEM.L ...,-(A7) or LINK) when present in window
      for (let p = callerWin.pcIndex - 1; p >= startIdx; p--) {
        const mn = callerWin.lines[p].mnemonic;
        if ((mn.startsWith('MOVEM.L ') && mn.endsWith(',-(A7)')) || mn.startsWith('LINK ')) {
          startIdx = p;
          break;
        }
        if (mn === 'RTS' || mn === 'RTE') {
          startIdx = Math.min(callerWin.pcIndex, p + 1);
          break;
        }
      }
    }
    const callerLines = callerWin.lines.slice(startIdx, callerWin.pcIndex + 1);
    if (callerLines.length > 0) {
      out.push(`Caller @ ${fmtHex6(retAddr)}:`);
      for (const cl of callerLines) {
        const mark = cl.addr === retAddr ? 'ret>' : '    ';
        const cmt = cl.comment ? ` ; ${cl.comment}` : '';
        out.push(`  ${mark} ${fmtHex6(cl.addr)}: ${cl.mnemonic}${cmt}`);
      }
      if (idx === 0) {
        // Disassemble all distinct RAM BSR/JSR subroutines in call order inside Caller #0 (up to 8)
        const pcBase = pc & 0x00fffffe;
        const seenCallees = new Set<number>();
        for (let k = 0; k < callerLines.length && seenCallees.size < 8; k++) {
          const cand = callerLines[k];
          if (
            (cand.mnemonic.startsWith('BSR') || cand.mnemonic.startsWith('JSR')) &&
            cand.branchTarget !== null &&
            cand.branchTarget >= 0x400 &&
            cand.branchTarget < 0xf80000 &&
            Math.abs(cand.branchTarget - pcBase) > 0x20 &&
            !seenCallees.has(cand.branchTarget)
          ) {
            seenCallees.add(cand.branchTarget);
            const subLines = disassembleSubroutine(peek16, cand.branchTarget, 28);
            if (subLines.length > 0) {
              out.push(`Callee @ ${fmtHex6(cand.branchTarget)} (called from ${fmtHex6(cand.addr)}):`);
              for (const sl of subLines) {
                const cmt = sl.comment ? ` ; ${sl.comment}` : '';
                out.push(`       ${fmtHex6(sl.addr)}: ${sl.mnemonic}${cmt}`);
              }
            }
          }
        }
      }
    }
  }

  out.push('');
  out.push('[CHIPSET / DISPLAY / COPPER]');
  out.push(
    `DMACON=${fmtHex4(chipset.dmacon)} [${decodeDmaconFlags(chipset.dmacon).join(',') || 'none'}] | INTENA=${fmtHex4(chipset.intena)} [${decodeIntFlags(chipset.intena).join(',') || 'none'}]`
  );
  if (
    chipset.lastIntenaMaskWriteVal !== 0 ||
    chipset.ramIntenaWriteCount > 0 ||
    chipset.lastDmaconWriteVal !== 0 ||
    chipset.lastCop1lcWritePc !== 0
  ) {
    const parts: string[] = [];
    if (chipset.lastIntenaMaskWriteVal !== 0) {
      parts.push(
        `INTENA(${fmtHex4(chipset.lastIntenaMaskWriteVal)}->${fmtHex4(chipset.lastIntenaMaskWriteResult)}@${fmtHex6(chipset.lastIntenaMaskWritePc)})`
      );
    }
    parts.push(
      chipset.ramIntenaWriteCount > 0
        ? `RamINTENA(${chipset.ramIntenaWriteCount}x,last=${fmtHex4(chipset.lastRamIntenaWriteVal)}->${fmtHex4(chipset.lastRamIntenaWriteResult)}@${fmtHex6(chipset.lastRamIntenaWritePc)})`
        : 'RamINTENA(0x)'
    );
    if (chipset.lastDmaconWriteVal !== 0) {
      parts.push(
        `DMACON(${fmtHex4(chipset.lastDmaconWriteVal)}->${fmtHex4(chipset.lastDmaconWriteResult)}@${fmtHex6(chipset.lastDmaconWritePc)})`
      );
    }
    if (chipset.lastCop1lcWritePc !== 0) {
      parts.push(`COP1LC@${fmtHex6(chipset.lastCop1lcWritePc)}`);
    }
    out.push(`LastMaskWrites: ${parts.join(' | ')}`);
  }
  const intenaHist = chipset.getRamIntenaHistory();
  if (intenaHist.length > 0) {
    out.push(
      `RamINTENA_Hist (${chipset.ramIntenaWriteCount}x): ${intenaHist
        .slice(-10)
        .map((e) => `${fmtHex4(e.val)}->${fmtHex4(e.result)}@${fmtHex6(e.pc)}`)
        .join(' ')}`
    );
  }
  const dmaconHist = chipset.getRamDmaconHistory();
  if (dmaconHist.length > 0) {
    out.push(
      `RamDMACON_Hist (${chipset.ramDmaconWriteCount}x): ${dmaconHist
        .slice(-8)
        .map((e) => `${fmtHex4(e.val)}->${fmtHex4(e.result)}@${fmtHex6(e.pc)}`)
        .join(' ')}`
    );
  }
  out.push(
    `INTREQ=${fmtHex4(chipset.intreq)} [${decodeIntFlags(chipset.intreq).join(',') || 'none'}] | ADKCON=${fmtHex4(chipset.adkcon)} | BEAMCON0=${fmtHex4(chipset.beamCon0)} | VPOS=${chipset.vpos} HPOS=${chipset.getHpos()}`
  );
  out.push(
    `BPLCON0=${fmtHex4(chipset.bplCon0)} (BPU=${bplCount}) BPLCON1=${fmtHex4(chipset.bplCon1)} BPLCON2=${fmtHex4(chipset.bplCon2)} MOD=${chipset.bpl1Mod}/${chipset.bpl2Mod}`
  );
  out.push(
    `DIW=${fmtHex4(chipset.diwStrt)}..${fmtHex4(chipset.diwStop)} DDF=${fmtHex4(chipset.ddfStrt)}..${fmtHex4(chipset.ddfStop)} BPLPT=${Array.from(chipset.bplPt.subarray(0, Math.max(1, bplCount)), fmtHex6).join(',')}`
  );
  out.push(
    `COLOR00..07: ${Array.from({ length: 8 }, (_, i) => (chipset.colorReg[i] & 0xfff).toString(16).toUpperCase().padStart(3, '0')).join(' ')}`
  );
  if (machine.config.chipset === 'AGA') {
    out.push(
      `COLOR00..07 (24b): ${Array.from({ length: 8 }, (_, i) => (chipset.colorReg24[i] & 0xffffff).toString(16).toUpperCase().padStart(6, '0')).join(' ')}`
    );
  }
  out.push(
    `COP1LC=${fmtHex6(chipset.cop1lc)} COP2LC=${fmtHex6(chipset.cop2lc)} COPPC=${fmtHex6(chipset.copPc)} COPCON=${fmtHex4(chipset.copCon)} wait=${chipset.copWaiting ? `V>=${chipset.copWaitV},H>=${chipset.copWaitH}` : 'no'}`
  );
  const cop1 = decodeCopperListFromPeek(peek16, chipset.cop1lc, 20);
  if (cop1.length > 0) {
    out.push(`COP1 (first ${cop1.length}):`);
    for (const c of cop1) {
      out.push(`  ${c}`);
    }
  }

  out.push('');
  out.push('[BLITTER & DISK DMA]');
  out.push(
    `BLTCON0=${fmtHex4(chipset.bltCon0)} BLTCON1=${fmtHex4(chipset.bltCon1)} BLTSIZV=${chipset.bltSizV} BLTZERO=${chipset.bltZero} APT=${fmtHex6(chipset.bltApt)} DPT=${fmtHex6(chipset.bltDpt)}`
  );
  out.push(
    `DSKPT=${fmtHex6(chipset.dskPt)} DSKLEN=${fmtHex4(chipset.dskLen)} DSKSYNC=${fmtHex4(chipset.dskSync)} active=${chipset.dskDmaActive} wordsLeft=${chipset.dskDmaWordsLeft}`
  );

  out.push('');
  out.push('[CIA]');
  out.push(
    `CIA-A: PRA=${fmtHex2(cia.praA)} PRB=${fmtHex2(cia.prbA)} ICR=${fmtHex2(cia.icrDataA)}/${fmtHex2(cia.icrMaskA)} TA=${fmtHex4(cia.taA)} TB=${fmtHex4(cia.tbA)} CRA=${fmtHex2(cia.craA)} CRB=${fmtHex2(cia.crbA)}`
  );
  out.push(
    `CIA-B: PRA=${fmtHex2(cia.praB)} PRB=${fmtHex2(cia.prbB)} ICR=${fmtHex2(cia.icrDataB)}/${fmtHex2(cia.icrMaskB)} TA=${fmtHex4(cia.taB)} TB=${fmtHex4(cia.tbB)} CRA=${fmtHex2(cia.craB)} CRB=${fmtHex2(cia.crbB)}`
  );

  out.push('');
  out.push('[STORAGE]');
  const fmtDrive = (idx: 0 | 1, d: typeof d0) => {
    if (!d.data) return `DF${idx}: empty`;
    const bbOk = verifyAmigaBootblockChecksum(d.data);
    const hdr = bytesToHexString(d.data.subarray(0, 16));
    return `DF${idx}: "${d.name}" (${d.data.length}B) cyl=${d.cylinder} side=${d.side} motor=${d.motorOn ? 1 : 0} sel=${d.selected ? 1 : 0} wp=${d.writeProtected ? 1 : 0} chg=${d.diskChanged ? 1 : 0} pos=${d.trackBytePos} bbOk=${bbOk} hdr=[${hdr}]`;
  };
  out.push(`${fmtDrive(0, d0)} | ioSeq=${floppy.ioSeq}`);
  out.push(fmtDrive(1, d1));
  const fmtHdf = (idx: 0 | 1, h: typeof h0) => {
    if (!h.data) return `DH${idx}: unmounted`;
    const parts = h.partitions.map((p) => `${p.dosName}:${p.volumeName}(${p.dosTypeStr},pri=${p.bootPri})`).join(', ');
    return `DH${idx}: "${h.name}" (${Math.round(h.data.length / 1024)}KB) rdb=${h.isRdb} readSinceReset=${h.hasReadSinceReset} [${parts}]`;
  };
  out.push(fmtHdf(0, h0));
  out.push(fmtHdf(1, h1));

  const events = machine.getRecentTriageEvents();
  if (events.length > 0) {
    out.push('');
    out.push(`[RECENT EVENTS (${events.length})]`);
    for (const ev of events.slice(-24)) {
      out.push(`  ${formatTriageEvent(ev)}`);
    }
  }

  return out.join('\n') + '\n';
}

export function formatTriageReportFilename(machine: AmigaMachine, now = new Date()): string {
  const rawLabel =
    machine.floppy.drives[0].name ||
    machine.hardfile.units[1].name ||
    machine.hardfile.units[0].name ||
    'amiga500';
  const cleanLabel =
    rawLabel
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32) || 'amiga500';
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `triage-${cleanLabel}-${stamp}.txt`;
}

export { hex };

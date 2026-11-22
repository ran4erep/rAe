/**
 * Compact On-Demand Motorola 68000 / 68EC020 Disassembler & Loop Analyzer.
 * Runs ONLY when generating a Triage Report (0% runtime CPU overhead).
 */

const HARDWARE_REG_NAMES: Record<number, string> = {
  0xdff000: 'BLTDDAT',
  0xdff002: 'DMACONR',
  0xdff003: 'DMACONR+1',
  0xdff004: 'VPOSR',
  0xdff005: 'VPOSR+1',
  0xdff006: 'VHPOSR',
  0xdff007: 'VHPOSR+1',
  0xdff00a: 'JOY0DAT',
  0xdff00c: 'JOY1DAT',
  0xdff00e: 'CLXDAT',
  0xdff010: 'ADKCONR',
  0xdff012: 'POT0DAT',
  0xdff014: 'POT1DAT',
  0xdff016: 'POTGOR',
  0xdff018: 'SERDATR',
  0xdff01a: 'DSKBYTR',
  0xdff01c: 'INTENAR',
  0xdff01d: 'INTENAR+1',
  0xdff01e: 'INTREQR',
  0xdff01f: 'INTREQR+1',
  0xdff020: 'DSKPTH',
  0xdff022: 'DSKPTL',
  0xdff024: 'DSKLEN',
  0xdff026: 'DSKDAT',
  0xdff02e: 'COPCON',
  0xdff034: 'POTGO',
  0xdff040: 'BLTCON0',
  0xdff042: 'BLTCON1',
  0xdff044: 'BLTAFWM',
  0xdff046: 'BLTALWM',
  0xdff048: 'BLTCPTH',
  0xdff04c: 'BLTBPTH',
  0xdff050: 'BLTAPTH',
  0xdff054: 'BLTDPTH',
  0xdff058: 'BLTSIZE',
  0xdff07e: 'DSKSYNC',
  0xdff080: 'COP1LCH',
  0xdff082: 'COP1LCL',
  0xdff084: 'COP2LCH',
  0xdff086: 'COP2LCL',
  0xdff088: 'COPJMP1',
  0xdff08a: 'COPJMP2',
  0xdff08e: 'DIWSTRT',
  0xdff090: 'DIWSTOP',
  0xdff092: 'DDFSTRT',
  0xdff094: 'DDFSTOP',
  0xdff096: 'DMACON',
  0xdff098: 'CLXCON',
  0xdff09a: 'INTENA',
  0xdff09c: 'INTREQ',
  0xdff09e: 'ADKCON',
  0xdff0e0: 'BPL1PTH',
  0xdff100: 'BPLCON0',
  0xdff102: 'BPLCON1',
  0xdff104: 'BPLCON2',
  0xdff106: 'BPLCON3',
  0xdff108: 'BPL1MOD',
  0xdff10a: 'BPL2MOD',
  0xdff10c: 'BPLCON4',
  0xdff180: 'COLOR00',
  0xdff1dc: 'BEAMCON0',
  0xdff1fc: 'FMODE',
  0xbfe001: 'CIAAPRA',
  0xbfe101: 'CIAAPRB',
  0xbfe201: 'CIAADDRA',
  0xbfe301: 'CIAADDRB',
  0xbfe401: 'CIAATALO',
  0xbfe501: 'CIAATAHI',
  0xbfe601: 'CIAATBLO',
  0xbfe701: 'CIAATBHI',
  0xbfe801: 'CIAATODLO',
  0xbfe901: 'CIAATODMID',
  0xbfea01: 'CIAATODHI',
  0xbfec01: 'CIAASDR',
  0xbfed01: 'CIAAICR',
  0xbfee01: 'CIAACRA',
  0xbfef01: 'CIAACRB',
  0xbfd000: 'CIABPRA',
  0xbfd100: 'CIABPRB',
  0xbfd200: 'CIABDDRA',
  0xbfd300: 'CIABDDRB',
  0xbfd400: 'CIABTALO',
  0xbfd500: 'CIABTAHI',
  0xbfd600: 'CIABTBLO',
  0xbfd700: 'CIABTBHI',
  0xbfdd00: 'CIABICR',
  0xbfde00: 'CIABCRA',
  0xbfdf00: 'CIABCRB',
};

const EXEC_LVOS: Record<number, string> = {
  [-30]: 'Supervisor',
  [-120]: 'Disable',
  [-126]: 'Enable',
  [-132]: 'Forbid',
  [-138]: 'Permit',
  [-198]: 'AllocMem',
  [-210]: 'FreeMem',
  [-294]: 'FindTask',
  [-306]: 'SetTaskPri',
  [-318]: 'Wait',
  [-324]: 'Signal',
  [-330]: 'AllocSignal',
  [-366]: 'PutMsg',
  [-372]: 'GetMsg',
  [-378]: 'ReplyMsg',
  [-384]: 'WaitPort',
  [-408]: 'OldOpenLibrary',
  [-414]: 'CloseLibrary',
  [-444]: 'OpenDevice',
  [-450]: 'CloseDevice',
  [-456]: 'DoIO',
  [-462]: 'SendIO',
  [-468]: 'CheckIO',
  [-474]: 'WaitIO',
  [-552]: 'OpenLibrary',
  [-624]: 'CopyMem',
  [-630]: 'CopyMemQuick',
  [-708]: 'OpenResource',
};

const CC_NAMES = [
  'T', 'F', 'HI', 'LS', 'CC', 'CS', 'NE', 'EQ',
  'VC', 'VS', 'PL', 'MI', 'GE', 'LT', 'GT', 'LE',
];

const SIZE_NAMES = ['.B', '.W', '.L', '?'];

export interface DisasmLine {
  addr: number;
  byteLength: number;
  words: number[];
  mnemonic: string;
  comment: string;
  branchTarget: number | null;
}

function hexNum(v: number, minDigits = 0): string {
  const s = (v >>> 0).toString(16).toUpperCase();
  return '$' + (minDigits > 0 ? s.padStart(minDigits, '0') : s);
}

function signedHex(v: number): string {
  if (v < 0) return '-' + hexNum(-v);
  return hexNum(v);
}

function signExt8(v: number): number {
  return (v << 24) >> 24;
}

function signExt16(v: number): number {
  return (v << 16) >> 16;
}

function regListStr(mask: number, predec: boolean): string {
  const parts: string[] = [];
  for (let i = 0; i < 16; i++) {
    const bit = predec ? 15 - i : i;
    if ((mask & (1 << bit)) !== 0) {
      parts.push(i < 8 ? `D${i}` : `A${i - 8}`);
    }
  }
  return parts.join('/') || '#0';
}

export function lookupHardwareRegName(addr: number): string | null {
  const raw = addr & 0x00ffffff;
  const a = raw >= 0xdf0000 && raw < 0xe00000 ? 0xdff000 | (raw & 0x1ff) : raw;
  if (HARDWARE_REG_NAMES[a]) return HARDWARE_REG_NAMES[a];
  const even = a & ~1;
  if (even >= 0xdff000 && even <= 0xdff1fe) {
    if (even >= 0xdff180 && even < 0xdff1c0) {
      return `COLOR${String((even - 0xdff180) >>> 1).padStart(2, '0')}`;
    }
    if (even >= 0xdff0e0 && even < 0xdff100) {
      const plane = ((even - 0xdff0e0) >>> 2) + 1;
      return `BPL${plane}PT${(even & 2) ? 'L' : 'H'}`;
    }
    if (even >= 0xdff120 && even < 0xdff140) {
      const spr = (even - 0xdff120) >>> 2;
      return `SPR${spr}PT${(even & 2) ? 'L' : 'H'}`;
    }
    if (even >= 0xdff0a0 && even < 0xdff0e0) {
      const ch = (even - 0xdff0a0) >>> 4;
      const off = even & 0x0e;
      const sub = off === 0 ? 'LCH' : off === 2 ? 'LCL' : off === 4 ? 'LEN' : off === 6 ? 'PER' : off === 8 ? 'VOL' : off === 10 ? 'DAT' : `REG${off.toString(16)}`;
      return `AUD${ch}${sub}`;
    }
  }
  return null;
}

export function disassembleOne68k(
  peek16: (addr: number) => number,
  startAddr: number,
  options?: { execBaseApprox?: number }
): DisasmLine {
  const addr = startAddr & 0x00ffffff;
  let cur = addr;
  const words: number[] = [];
  const notes: string[] = [];

  const readW = (): number => {
    const w = peek16(cur) & 0xffff;
    words.push(w);
    cur = (cur + 2) & 0x00ffffff;
    return w;
  };

  const readL = (): number => {
    const hi = readW();
    const lo = readW();
    return ((hi << 16) | lo) >>> 0;
  };

  let lastResolvedAddr: number | null = null;
  const noteAddr = (target: number) => {
    lastResolvedAddr = target & 0x00ffffff;
    const hw = lookupHardwareRegName(target);
    if (hw && !notes.includes(hw)) notes.push(hw);
  };

  const fmtBriefIdx = (baseReg: string, ext: number): string => {
    const xn = (ext >>> 12) & 15;
    const xStr = (xn < 8 ? `D${xn}` : `A${xn - 8}`) + ((ext & 0x0800) ? '.L' : '.W');
    const scale = (ext >>> 9) & 3;
    const scaleStr = scale > 0 ? `*${1 << scale}` : '';
    const disp = signExt8(ext & 0xff);
    return `${disp === 0 ? '' : signedHex(disp)}(${baseReg},${xStr}${scaleStr})`;
  };

  const fmtEa = (mode: number, reg: number, sizeBytes: number): string => {
    switch (mode) {
      case 0:
        return `D${reg}`;
      case 1:
        return `A${reg}`;
      case 2:
        return `(A${reg})`;
      case 3:
        return `(A${reg})+`;
      case 4:
        return `-(A${reg})`;
      case 5: {
        const disp = signExt16(readW());
        if (reg === 6 && disp < 0 && EXEC_LVOS[disp]) {
          notes.push(`_LVO${EXEC_LVOS[disp]}`);
        }
        return `${signedHex(disp)}(A${reg})`;
      }
      case 6: {
        const ext = readW();
        return fmtBriefIdx(`A${reg}`, ext);
      }
      case 7:
        switch (reg) {
          case 0: {
            const abs16 = signExt16(readW()) >>> 0;
            noteAddr(abs16);
            return `(${hexNum(abs16 & 0xffffff, 4)}).W`;
          }
          case 1: {
            const abs32 = readL();
            noteAddr(abs32);
            return `(${hexNum(abs32, 6)}).L`;
          }
          case 2: {
            const pcBase = cur;
            const disp = signExt16(readW());
            const target = (pcBase + disp) & 0x00ffffff;
            noteAddr(target);
            return `${hexNum(target, 6)}(PC)`;
          }
          case 3: {
            const pcBase = cur;
            const ext = readW();
            const disp = signExt8(ext & 0xff);
            const target = (pcBase + disp) & 0x00ffffff;
            const xn = (ext >>> 12) & 15;
            const xStr = (xn < 8 ? `D${xn}` : `A${xn - 8}`) + ((ext & 0x0800) ? '.L' : '.W');
            return `${hexNum(target, 6)}(PC,${xStr})`;
          }
          case 4: {
            if (sizeBytes === 4) {
              return `#${hexNum(readL())}`;
            }
            const w = readW();
            return `#${hexNum(sizeBytes === 1 ? w & 0xff : w)}`;
          }
          default:
            return `?<7:${reg}>`;
        }
      default:
        return `?`;
    }
  };

  const op = readW();
  const top4 = (op >>> 12) & 0xf;
  const x = (op >>> 9) & 7;
  const opmode = (op >>> 6) & 7;
  const mode = (op >>> 3) & 7;
  const reg = op & 7;
  let mnemonic = '';
  let branchTarget: number | null = null;

  if (top4 === 0x0) {
    if ((op & 0xf138) === 0x0108) {
      // MOVEP
      const sz = (op & 0x0040) ? '.L' : '.W';
      const disp = signExt16(readW());
      if (op & 0x0080) mnemonic = `MOVEP${sz} D${x},${signedHex(disp)}(A${reg})`;
      else mnemonic = `MOVEP${sz} ${signedHex(disp)}(A${reg}),D${x}`;
    } else if (op & 0x0100) {
      // Dynamic bit op: BTST/BCHG/BCLR/BSET Dn,<ea>
      const bitNames = ['BTST', 'BCHG', 'BCLR', 'BSET'];
      const bName = bitNames[(op >>> 6) & 3];
      mnemonic = `${bName} D${x},${fmtEa(mode, reg, 1)}`;
    } else if (x === 4) {
      // Static bit op: BTST/BCHG/BCLR/BSET #imm,<ea>
      const bitNames = ['BTST', 'BCHG', 'BCLR', 'BSET'];
      const bName = bitNames[(op >>> 6) & 3];
      const bitNum = readW() & 0xff;
      mnemonic = `${bName} #${bitNum},${fmtEa(mode, reg, 1)}`;
    } else {
      const immNames = ['ORI', 'ANDI', 'SUBI', 'ADDI', '?', 'EORI', 'CMPI', '?'];
      const iName = immNames[x];
      const szIdx = (op >>> 6) & 3;
      if (iName !== '?' && szIdx < 3) {
        const szBytes = szIdx === 0 ? 1 : szIdx === 1 ? 2 : 4;
        const imm = szBytes === 4 ? readL() : (readW() & (szBytes === 1 ? 0xff : 0xffff));
        if (mode === 7 && reg === 4 && szIdx <= 1 && (x === 0 || x === 1 || x === 5)) {
          mnemonic = `${iName}${SIZE_NAMES[szIdx]} #${hexNum(imm)},${szIdx === 0 ? 'CCR' : 'SR'}`;
        } else {
          mnemonic = `${iName}${SIZE_NAMES[szIdx]} #${hexNum(imm)},${fmtEa(mode, reg, szBytes)}`;
        }
      }
    }
  } else if (top4 === 0x1 || top4 === 0x2 || top4 === 0x3) {
    // MOVE / MOVEA
    const szIdx = top4 === 0x1 ? 0 : top4 === 0x3 ? 1 : 2;
    const szBytes = szIdx === 0 ? 1 : szIdx === 1 ? 2 : 4;
    const dstReg = (op >>> 9) & 7;
    const dstMode = (op >>> 6) & 7;
    const srcStr = fmtEa(mode, reg, szBytes);
    const dstStr = fmtEa(dstMode, dstReg, szBytes);
    if (dstMode === 1) {
      mnemonic = `MOVEA${SIZE_NAMES[szIdx]} ${srcStr},${dstStr}`;
    } else {
      mnemonic = `MOVE${SIZE_NAMES[szIdx]} ${srcStr},${dstStr}`;
    }
  } else if (top4 === 0x4) {
    if (op === 0x4e70) mnemonic = 'RESET';
    else if (op === 0x4e71) mnemonic = 'NOP';
    else if (op === 0x4e72) mnemonic = `STOP #${hexNum(readW(), 4)}`;
    else if (op === 0x4e73) mnemonic = 'RTE';
    else if (op === 0x4e74) mnemonic = `RTD #${signedHex(signExt16(readW()))}`;
    else if (op === 0x4e75) mnemonic = 'RTS';
    else if (op === 0x4e76) mnemonic = 'TRAPV';
    else if (op === 0x4e77) mnemonic = 'RTR';
    else if ((op & 0xfffe) === 0x4e7a) {
      const ext = readW();
      const rn = (ext >>> 12) & 15;
      const rStr = rn < 8 ? `D${rn}` : `A${rn - 8}`;
      const cr = ext & 0xfff;
      const crName = cr === 0x000 ? 'SFC' : cr === 0x001 ? 'DFC' : cr === 0x002 ? 'CACR' : cr === 0x800 ? 'USP' : cr === 0x801 ? 'VBR' : hexNum(cr);
      mnemonic = (op & 1) ? `MOVEC ${rStr},${crName}` : `MOVEC ${crName},${rStr}`;
    } else if ((op & 0xfff0) === 0x4e40) {
      mnemonic = `TRAP #${op & 0xf}`;
    } else if ((op & 0xfff8) === 0x4e50) {
      mnemonic = `LINK A${reg},#${signedHex(signExt16(readW()))}`;
    } else if ((op & 0xfff8) === 0x4e58) {
      mnemonic = `UNLK A${reg}`;
    } else if ((op & 0xfff8) === 0x4e60) {
      mnemonic = `MOVE.L A${reg},USP`;
    } else if ((op & 0xfff8) === 0x4e68) {
      mnemonic = `MOVE.L USP,A${reg}`;
    } else if ((op & 0xffc0) === 0x4e80) {
      const targetStr = fmtEa(mode, reg, 4);
      mnemonic = `JSR ${targetStr}`;
      if (mode === 7 && (reg === 0 || reg === 1 || reg === 2)) {
        branchTarget = lastResolvedAddr;
      }
    } else if ((op & 0xffc0) === 0x4ec0) {
      mnemonic = `JMP ${fmtEa(mode, reg, 4)}`;
      if (mode === 7 && (reg === 0 || reg === 1 || reg === 2)) {
        branchTarget = lastResolvedAddr;
      }
    } else if ((op & 0xf1c0) === 0x41c0) {
      mnemonic = `LEA ${fmtEa(mode, reg, 4)},A${x}`;
    } else if ((op & 0xffc0) === 0x4840 && mode === 0) {
      mnemonic = `SWAP D${reg}`;
    } else if ((op & 0xffc0) === 0x4840) {
      mnemonic = `PEA ${fmtEa(mode, reg, 4)}`;
    } else if ((op & 0xffb8) === 0x4880 && mode === 0) {
      mnemonic = `EXT${(op & 0x0040) ? '.L' : '.W'} D${reg}`;
    } else if ((op & 0xfb80) === 0x4880 && mode >= 2) {
      const sz = (op & 0x0040) ? '.L' : '.W';
      const mask = readW();
      const dir = (op & 0x0400) !== 0; // 1 = mem -> regs
      const eaStr = fmtEa(mode, reg, 4);
      if (dir) mnemonic = `MOVEM${sz} ${eaStr},${regListStr(mask, false)}`;
      else mnemonic = `MOVEM${sz} ${regListStr(mask, mode === 4)},${eaStr}`;
    } else if ((op & 0xffc0) === 0x40c0) {
      mnemonic = `MOVE.W SR,${fmtEa(mode, reg, 2)}`;
    } else if ((op & 0xffc0) === 0x44c0) {
      mnemonic = `MOVE.W ${fmtEa(mode, reg, 2)},CCR`;
    } else if ((op & 0xffc0) === 0x46c0) {
      mnemonic = `MOVE.W ${fmtEa(mode, reg, 2)},SR`;
    } else if ((op & 0xff00) === 0x4a00) {
      const szIdx = (op >>> 6) & 3;
      if (szIdx === 3) mnemonic = `TAS ${fmtEa(mode, reg, 1)}`;
      else mnemonic = `TST${SIZE_NAMES[szIdx]} ${fmtEa(mode, reg, szIdx === 0 ? 1 : szIdx === 1 ? 2 : 4)}`;
    } else if (x <= 3) {
      const uNames = ['NEGX', 'CLR', 'NEG', 'NOT'];
      const szIdx = (op >>> 6) & 3;
      if (szIdx < 3) {
        mnemonic = `${uNames[x]}${SIZE_NAMES[szIdx]} ${fmtEa(mode, reg, szIdx === 0 ? 1 : szIdx === 1 ? 2 : 4)}`;
      }
    }
  } else if (top4 === 0x5) {
    const cond = (op >>> 8) & 0xf;
    if ((op & 0x00f8) === 0x00c8) {
      const basePc = cur;
      const disp = signExt16(readW());
      const target = (basePc + disp) & 0x00ffffff;
      branchTarget = target;
      mnemonic = `DB${cond === 1 ? 'RA' : CC_NAMES[cond]} D${reg},${hexNum(target, 6)}`;
    } else if ((op & 0x00c0) === 0x00c0) {
      mnemonic = `S${CC_NAMES[cond]} ${fmtEa(mode, reg, 1)}`;
    } else {
      const szIdx = (op >>> 6) & 3;
      const q = x === 0 ? 8 : x;
      const isSub = (op & 0x0100) !== 0;
      mnemonic = `${isSub ? 'SUBQ' : 'ADDQ'}${SIZE_NAMES[szIdx]} #${q},${fmtEa(mode, reg, szIdx === 0 ? 1 : szIdx === 1 ? 2 : 4)}`;
    }
  } else if (top4 === 0x6) {
    const cond = (op >>> 8) & 0xf;
    const name = cond === 0 ? 'BRA' : cond === 1 ? 'BSR' : `B${CC_NAMES[cond]}`;
    const disp8 = op & 0xff;
    const basePc = cur;
    let disp = 0;
    let suffix = '.S';
    if (disp8 === 0) {
      disp = signExt16(readW());
      suffix = '.W';
    } else if (disp8 === 0xff) {
      disp = readL() | 0;
      suffix = '.L';
    } else {
      disp = signExt8(disp8);
    }
    const target = (basePc + disp) & 0x00ffffff;
    branchTarget = target;
    mnemonic = `${name}${suffix} ${hexNum(target, 6)}`;
  } else if (top4 === 0x7) {
    if ((op & 0x0100) === 0) {
      mnemonic = `MOVEQ #${signedHex(signExt8(op & 0xff))},D${x}`;
    }
  } else if (top4 === 0x8 || top4 === 0xc) {
    const isAnd = top4 === 0xc;
    if (isAnd && (op & 0xf1f0) === 0xc140) {
      mnemonic = `EXG D${x},D${reg}`;
    } else if (isAnd && (op & 0xf1f0) === 0xc148) {
      mnemonic = `EXG A${x},A${reg}`;
    } else if (isAnd && (op & 0xf1f0) === 0xc188) {
      mnemonic = `EXG D${x},A${reg}`;
    } else if (opmode === 3 || opmode === 7) {
      const opN = isAnd ? (opmode === 3 ? 'MULU' : 'MULS') : (opmode === 3 ? 'DIVU' : 'DIVS');
      mnemonic = `${opN}.W ${fmtEa(mode, reg, 2)},D${x}`;
    } else if ((op & 0x01f0) === 0x0100) {
      const opN = isAnd ? 'ABCD' : 'SBCD';
      mnemonic = (op & 8) ? `${opN} -(A${reg}),-(A${x})` : `${opN} D${reg},D${x}`;
    } else {
      const szIdx = opmode & 3;
      const szBytes = szIdx === 0 ? 1 : szIdx === 1 ? 2 : 4;
      const opN = isAnd ? 'AND' : 'OR';
      const eaStr = fmtEa(mode, reg, szBytes);
      mnemonic = (opmode & 4) ? `${opN}${SIZE_NAMES[szIdx]} D${x},${eaStr}` : `${opN}${SIZE_NAMES[szIdx]} ${eaStr},D${x}`;
    }
  } else if (top4 === 0x9 || top4 === 0xd) {
    const isAdd = top4 === 0xd;
    const base = isAdd ? 'ADD' : 'SUB';
    if (opmode === 3 || opmode === 7) {
      const sz = opmode === 3 ? '.W' : '.L';
      mnemonic = `${base}A${sz} ${fmtEa(mode, reg, opmode === 3 ? 2 : 4)},A${x}`;
    } else if ((op & 0x0130) === 0x0100 && mode <= 1) {
      const szIdx = (op >>> 6) & 3;
      mnemonic = mode === 1 ? `${base}X${SIZE_NAMES[szIdx]} -(A${reg}),-(A${x})` : `${base}X${SIZE_NAMES[szIdx]} D${reg},D${x}`;
    } else {
      const szIdx = opmode & 3;
      const szBytes = szIdx === 0 ? 1 : szIdx === 1 ? 2 : 4;
      const eaStr = fmtEa(mode, reg, szBytes);
      mnemonic = (opmode & 4) ? `${base}${SIZE_NAMES[szIdx]} D${x},${eaStr}` : `${base}${SIZE_NAMES[szIdx]} ${eaStr},D${x}`;
    }
  } else if (top4 === 0xa) {
    mnemonic = `LINE-A ${hexNum(op, 4)}`;
  } else if (top4 === 0xb) {
    if (opmode === 3 || opmode === 7) {
      const sz = opmode === 3 ? '.W' : '.L';
      mnemonic = `CMPA${sz} ${fmtEa(mode, reg, opmode === 3 ? 2 : 4)},A${x}`;
    } else if ((opmode & 4) !== 0) {
      if (mode === 1) {
        const szIdx = opmode & 3;
        mnemonic = `CMPM${SIZE_NAMES[szIdx]} (A${reg})+,(A${x})+`;
      } else {
        const szIdx = opmode & 3;
        mnemonic = `EOR${SIZE_NAMES[szIdx]} D${x},${fmtEa(mode, reg, szIdx === 0 ? 1 : szIdx === 1 ? 2 : 4)}`;
      }
    } else {
      const szIdx = opmode & 3;
      mnemonic = `CMP${SIZE_NAMES[szIdx]} ${fmtEa(mode, reg, szIdx === 0 ? 1 : szIdx === 1 ? 2 : 4)},D${x}`;
    }
  } else if (top4 === 0xe) {
    const shNames = ['AS', 'LS', 'ROX', 'RO'];
    const szIdx = (op >>> 6) & 3;
    if (szIdx === 3) {
      const shType = (op >>> 9) & 3;
      const dir = (op & 0x0100) ? 'L' : 'R';
      mnemonic = `${shNames[shType]}${dir}.W ${fmtEa(mode, reg, 2)}`;
    } else {
      const shType = (op >>> 3) & 3;
      const dir = (op & 0x0100) ? 'L' : 'R';
      const cnt = (op & 0x0020) ? `D${x}` : `#${x === 0 ? 8 : x}`;
      mnemonic = `${shNames[shType]}${dir}${SIZE_NAMES[szIdx]} ${cnt},D${reg}`;
    }
  } else if (top4 === 0xf) {
    mnemonic = `LINE-F ${hexNum(op, 4)}`;
  }

  if (!mnemonic) {
    mnemonic = `DC.W ${hexNum(op, 4)}`;
  }

  void options;
  return {
    addr,
    byteLength: (cur - addr) & 0xffffff || 2,
    words,
    mnemonic,
    comment: notes.join(', '),
    branchTarget,
  };
}

/**
 * Disassembles a window ending after `pc` so `pc` itself aligns cleanly on instruction boundaries.
 */
export function disassembleWindowAroundPc(
  peek16: (addr: number) => number,
  pc: number,
  beforeBytes = 24,
  afterCount = 14
): { lines: DisasmLine[]; pcIndex: number } {
  const pcAligned = pc & 0x00fffffe;
  const linesBefore: DisasmLine[] = [];

  // Try syncing candidate pre-PC starts (2-byte aligned); skip completely when beforeBytes <= 0
  if (beforeBytes > 0) {
    const maxBack = Math.min(384, Math.max(32, (beforeBytes + 16) & ~1));
    let bestScore = Number.POSITIVE_INFINITY;
    for (let back = maxBack; back >= 2; back -= 2) {
      let cur = Math.max(0, pcAligned - back) & 0x00fffffe;
      const trial: DisasmLine[] = [];
      let guard = 0;
      let badCount = 0;
      while (cur < pcAligned && guard++ < 220) {
        const ins = disassembleOne68k(peek16, cur);
        if (ins.words[0] === 0 || ins.mnemonic.startsWith('DC.W')) {
          badCount++;
        }
        trial.push(ins);
        cur = (cur + ins.byteLength) & 0x00ffffff;
      }
      if (cur === pcAligned) {
        // Lower score is better: minimize suspicious $0000/DC.W hits, tie-break toward fuller window
        const score = badCount * 100 - trial.length;
        if (score < bestScore) {
          bestScore = score;
          linesBefore.length = 0;
          linesBefore.push(...trial);
        }
      }
    }
  }

  const lines: DisasmLine[] = [...linesBefore];
  const pcIndex = lines.length;
  let cur = pcAligned;
  for (let i = 0; i < afterCount; i++) {
    const ins = disassembleOne68k(peek16, cur);
    lines.push(ins);
    cur = (cur + ins.byteLength) & 0x00ffffff;
  }

  return { lines, pcIndex };
}

/**
 * Disassembles forward strictly from a subroutine or interrupt entry point,
 * stopping cleanly at RTS/RTE/RTR/RTD or trailing unconditional JMP/BRA.
 */
export function disassembleSubroutine(
  peek16: (addr: number) => number,
  startAddr: number,
  maxLines = 32
): DisasmLine[] {
  const lines: DisasmLine[] = [];
  let cur = startAddr & 0x00fffffe;
  let followedTrampoline = false;
  for (let i = 0; i < maxLines; i++) {
    const ins = disassembleOne68k(peek16, cur);
    lines.push(ins);
    const mn = ins.mnemonic;
    if (mn === 'RTS' || mn === 'RTE' || mn === 'RTR' || mn.startsWith('RTD ')) {
      break;
    }
    if ((mn.startsWith('BRA') || mn.startsWith('JMP ')) && ins.branchTarget !== null) {
      if (!followedTrampoline && i <= 1 && ins.branchTarget >= 0x400 && ins.branchTarget < 0xf80000) {
        followedTrampoline = true;
        cur = ins.branchTarget & 0x00fffffe;
        continue;
      }
      if (i > 0) break;
    }
    cur = (cur + ins.byteLength) & 0x00ffffff;
  }
  return lines;
}

/**
 * Inspects disassembled lines around `pc` to summarize what hardware register / condition a stuck loop is polling.
 */
export function detectWaitLoopHints(lines: DisasmLine[], pcIndex: number): string[] {
  const hints: string[] = [];
  const windowLines = lines.slice(Math.max(0, pcIndex - 6), Math.min(lines.length, pcIndex + 8));
  const joined = windowLines.map((l) => `${l.mnemonic} ${l.comment}`).join(' | ');

  if (joined.includes('STOP ')) {
    hints.push('CPU в инструкции STOP (ожидает прерывание выше текущего IPL)');
  }
  if (joined.includes('VPOSR') || joined.includes('VHPOSR') || joined.includes('$DFF004') || joined.includes('$DFF006')) {
    hints.push('Опрос луча развёртки VPOSR/VHPOSR ($DFF004/$DFF006) — ждёт нужную строку экрана');
  }
  if (joined.includes('DMACONR') || joined.includes('$DFF002')) {
    hints.push('Опрос DMACONR ($DFF002) — вероятно ждёт завершения Blitter (BBUSY)');
  }
  if (joined.includes('INTREQR') || joined.includes('$DFF01E')) {
    hints.push('Опрос INTREQR ($DFF01E) — ждёт флаг прерывания (VERTB / DSKBLK / BLIT / COPER)');
  }
  if (joined.includes('CIAAPRA') || joined.includes('$BFE001')) {
    hints.push('Опрос CIA-A PRA ($BFE001) — ждёт /RDY, /CHNG, /TK0, LMB или Joy2 Fire');
  }
  if (joined.includes('CIABPRA') || joined.includes('$BFD000')) {
    hints.push('Опрос CIA-B ($BFDxxx) — управление дисководом или таймер');
  }

  const curLine = lines[pcIndex];
  if (curLine && curLine.branchTarget === curLine.addr && !curLine.mnemonic.startsWith('DB')) {
    hints.push(`Вечный цикл BRA/Bcc на самом себе (${hexNum(curLine.addr, 6)})`);
  }
  return hints;
}

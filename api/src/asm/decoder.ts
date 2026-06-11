// Linear-sweep x86-64 disassembler.
// Decodes one instruction at a time using the opcode index built from the DB.
// VEX/EVEX instructions are not decoded — yielded as db bytes instead.

import type { DisassembleResult, ListingLine, OperandSize } from './types';
import type { OpcodeIndex, IndexedRow } from './table';
import { regName } from './regs';
import { parseInstructionForm } from './operands';

export interface DisassembleOptions {
  baseAddr: number;
  startOffset: number;
  syntax: 'intel' | 'attasm';
  dataRegions: Array<{ start: number; end: number }>;
}

export function disassemble(
  bytes: Uint8Array | number[],
  index: OpcodeIndex,
  opts: DisassembleOptions,
): DisassembleResult {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const listing: ListingLine[] = [];
  const { baseAddr, startOffset, syntax, dataRegions } = opts;

  // Collect branch targets to generate labels
  const branchTargets = new Set<number>();

  // First pass: find branch targets
  let pos = startOffset;
  while (pos < buf.length) {
    if (isDataRegion(pos, dataRegions)) { pos++; continue; }
    const result = decodeOne(buf, pos, index, baseAddr);
    if (!result) { pos++; continue; }
    if (result.branchTarget !== undefined) branchTargets.add(result.branchTarget);
    pos += result.length;
  }

  // Second pass: emit listing
  pos = startOffset;
  const pendingDb: number[] = [];
  let pendingDbStart = 0;

  function flushDb() {
    if (pendingDb.length === 0) return;
    const dbBytes = [...pendingDb];
    const hex = dbBytes.map(b => b.toString(16).padStart(2, '0')).join(' ');
    const addr = baseAddr + pendingDbStart;
    listing.push({
      address: addr,
      bytes: dbBytes,
      source: syntax === 'intel'
        ? `db ${dbBytes.map(b => '0x' + b.toString(16).padStart(2,'0')).join(', ')}`
        : `.byte ${dbBytes.map(b => '0x' + b.toString(16).padStart(2,'0')).join(', ')}`,
    });
    pendingDb.length = 0;
  }

  while (pos < buf.length) {
    const addr = baseAddr + pos;

    // Emit label if this is a branch target
    if (branchTargets.has(addr)) {
      flushDb();
      listing.push({ address: addr, bytes: [], source: `loc_${addr.toString(16).padStart(8,'0')}:` });
    }

    // Data region?
    if (isDataRegion(pos, dataRegions)) {
      if (pendingDb.length === 0) pendingDbStart = pos;
      pendingDb.push(buf[pos]);
      pos++;
      continue;
    }

    const result = decodeOne(buf, pos, index, baseAddr);
    if (!result) {
      // Undecodable byte — accumulate as db
      if (pendingDb.length === 0) pendingDbStart = pos;
      pendingDb.push(buf[pos]);
      pos++;
      continue;
    }

    flushDb();
    const instrBytes = Array.from(buf.slice(pos, pos + result.length));
    listing.push({
      address: addr,
      bytes: instrBytes,
      source: formatInstr(result, syntax, branchTargets),
    });
    pos += result.length;
  }
  flushDb();

  const text = listing.map(l =>
    l.source.endsWith(':')
      ? l.source
      : `${l.address.toString(16).padStart(8,'0')}:  ${l.bytes.map(b => b.toString(16).padStart(2,'0')).join(' ').padEnd(24,' ')}  ${l.source}`
  ).join('\n');

  return { ok: true, listing, text };
}

interface DecodedInstr {
  length: number;
  mnemonic: string;
  operands: DecodedOperand[];
  prefixes: string[];
  branchTarget?: number;
  operandSize: OperandSize;
}

type DecodedOperand =
  | { kind: 'reg'; name: string }
  | { kind: 'mem'; base?: string; index?: string; scale?: number; disp?: number; size: OperandSize }
  | { kind: 'imm'; value: number }
  | { kind: 'rel'; target: number }
  | { kind: 'label'; addr: number };

function decodeOne(
  buf: Uint8Array,
  pos: number,
  index: OpcodeIndex,
  baseAddr: number,
): DecodedInstr | null {
  if (pos >= buf.length) return null;

  let i = pos;
  const prefixes: string[] = [];
  let mandatoryPrefix: number | null = null;
  let rex = 0;
  let rexW = false;
  let rexR = false;
  let rexX = false;
  let rexB = false;

  // Collect prefix bytes
  while (i < buf.length) {
    const b = buf[i];
    if (b === 0xF0) { prefixes.push('LOCK'); i++; continue; }
    if (b === 0xF3) { prefixes.push('REP'); mandatoryPrefix = 0xF3; i++; continue; }
    if (b === 0xF2) { prefixes.push('REPNE'); mandatoryPrefix = 0xF2; i++; continue; }
    if (b === 0x66) { mandatoryPrefix = 0x66; i++; continue; }
    if (b === 0x67) { i++; continue; } // address size prefix
    if ((b & 0xF0) === 0x40) { // REX prefix
      rex = b;
      rexW = (b & 0x08) !== 0;
      rexR = (b & 0x04) !== 0;
      rexX = (b & 0x02) !== 0;
      rexB = (b & 0x01) !== 0;
      i++;
      continue;
    }
    // FS/GS segment overrides
    if (b === 0x64 || b === 0x65) { i++; continue; }
    break;
  }

  if (i >= buf.length) return null;

  // VEX/EVEX prefix → skip as db
  if (buf[i] === 0xC5 || buf[i] === 0xC4 || buf[i] === 0x62) return null;

  // Read opcode byte(s)
  let op1 = buf[i++];
  let op2: number | null = null;
  if (op1 === 0x0F) {
    if (i >= buf.length) return null;
    op2 = buf[i++];
    // 0F 38 or 0F 3A → 3-byte opcode, skip for MVP
    if (op2 === 0x38 || op2 === 0x3A) return null;
  }

  // Check if this is a register-in-opcode instruction (50-57 PUSH, 58-5F POP, 90-97, B0-BF)
  const byteReg = decodeByteReg(op1, op2, rexB, rexW, mandatoryPrefix, index, i, buf, baseAddr, pos, prefixes, rexR, rexX);
  if (byteReg) return byteReg;

  // Peek at ModRM byte to get the /digit, if present
  const modrm = i < buf.length ? buf[i] : 0;
  const modrmDigit = (modrm >> 3) & 7;

  const candidates = index.byBytes(mandatoryPrefix, rexW, op1, op2, modrmDigit);
  if (candidates.length === 0) {
    // Try without digit
    const cands2 = index.byBytes(mandatoryPrefix, rexW, op1, op2, -1);
    if (cands2.length === 0) return null;
    return decodeWithRow(cands2[0], buf, i, pos, prefixes, rexW, rexR, rexX, rexB, rex !== 0, mandatoryPrefix, baseAddr, op1, op2);
  }

  return decodeWithRow(candidates[0], buf, i, pos, prefixes, rexW, rexR, rexX, rexB, rex !== 0, mandatoryPrefix, baseAddr, op1, op2);
}

function decodeByteReg(
  op1: number, op2: number | null,
  rexB: boolean, rexW: boolean, mandatoryPrefix: number | null,
  index: OpcodeIndex,
  i: number, buf: Uint8Array, baseAddr: number, startPos: number,
  prefixes: string[], rexR: boolean, rexX: boolean,
): DecodedInstr | null {
  if (op2 !== null) return null;

  // PUSH r64 (50-57)
  if (op1 >= 0x50 && op1 <= 0x57) {
    const code = (op1 - 0x50) | (rexB ? 8 : 0);
    return { length: i - startPos, mnemonic: 'PUSH', prefixes, operands: [{ kind: 'reg', name: regName(code, 64, true) }], operandSize: 64 };
  }
  // POP r64 (58-5F)
  if (op1 >= 0x58 && op1 <= 0x5F) {
    const code = (op1 - 0x58) | (rexB ? 8 : 0);
    return { length: i - startPos, mnemonic: 'POP', prefixes, operands: [{ kind: 'reg', name: regName(code, 64, true) }], operandSize: 64 };
  }
  // MOV r64/r32, imm64/imm32 (B8-BF / B0-B7)
  if (op1 >= 0xB8 && op1 <= 0xBF) {
    const code = (op1 - 0xB8) | (rexB ? 8 : 0);
    const size: OperandSize = rexW ? 64 : 32;
    const immBytes = size >> 3;
    if (i + immBytes > buf.length) return null;
    const imm = readImm(buf, i, immBytes);
    return {
      length: i + immBytes - startPos,
      mnemonic: 'MOV', prefixes,
      operands: [{ kind: 'reg', name: regName(code, size, true) }, { kind: 'imm', value: imm }],
      operandSize: size,
    };
  }
  if (op1 >= 0xB0 && op1 <= 0xB7) {
    const code = (op1 - 0xB0) | (rexB ? 8 : 0);
    if (i >= buf.length) return null;
    const imm = buf[i];
    return {
      length: i + 1 - startPos,
      mnemonic: 'MOV', prefixes,
      operands: [{ kind: 'reg', name: regName(code, 8, rexB) }, { kind: 'imm', value: imm }],
      operandSize: 8,
    };
  }
  // NOP (90)
  if (op1 === 0x90 && !rexW) {
    return { length: i - startPos, mnemonic: 'NOP', prefixes, operands: [], operandSize: 32 };
  }
  return null;
}

function decodeWithRow(
  row: IndexedRow,
  buf: Uint8Array,
  i: number,
  startPos: number,
  prefixes: string[],
  rexW: boolean, rexR: boolean, rexX: boolean, rexB: boolean, hasRex: boolean,
  mandatoryPrefix: number | null,
  baseAddr: number,
  op1: number, op2: number | null,
): DecodedInstr | null {
  const tokens = row.tokens;
  const operandSize: OperandSize = rexW ? 64 : (mandatoryPrefix === 0x66 ? 16 : 32);
  const operands: DecodedOperand[] = [];
  let instrEnd = i;

  // Find modrm and immediate tokens in the opcode pattern
  const hasModrm = tokens.some(t => t.kind === 'modrm_r' || t.kind === 'modrm_digit');
  const immToken = tokens.find(t => t.kind === 'imm') as Extract<typeof tokens[0], { kind: 'imm' }> | undefined;
  const relToken = tokens.find(t => t.kind === 'rel') as Extract<typeof tokens[0], { kind: 'rel' }> | undefined;

  let modrmByte = 0;
  let mod = 0, reg = 0, rm = 0;
  let sibByte = 0;
  let memBase: number | undefined, memIndex: number | undefined, memScale = 1;
  let memDisp = 0;

  if (hasModrm) {
    if (instrEnd >= buf.length) return null;
    modrmByte = buf[instrEnd++];
    mod = (modrmByte >> 6) & 3;
    reg = ((modrmByte >> 3) & 7) | (rexR ? 8 : 0);
    rm  = (modrmByte & 7) | (rexB ? 8 : 0);

    if (mod !== 3 && (rm & 7) === 4) {
      // SIB byte
      if (instrEnd >= buf.length) return null;
      sibByte = buf[instrEnd++];
      const sibScale = (sibByte >> 6) & 3;
      memIndex = ((sibByte >> 3) & 7) | (rexX ? 8 : 0);
      memBase  = (sibByte & 7) | (rexB ? 8 : 0);
      memScale = [1,2,4,8][sibScale];
      if (memIndex === 4) memIndex = undefined; // no index
    } else if (mod !== 3) {
      memBase = rm;
    }

    // Displacement
    if (mod === 1) {
      if (instrEnd >= buf.length) return null;
      memDisp = signExtend8(buf[instrEnd++]);
    } else if (mod === 2 || (mod === 0 && (rm & 7) === 5)) {
      if (instrEnd + 4 > buf.length) return null;
      memDisp = readImm32Signed(buf, instrEnd);
      instrEnd += 4;
    }
  }

  // Now build operands from op_en
  const opEn = row.opEn.toUpperCase();
  const { opTypes } = parseInstructionForm(row.instruction);

  for (let oi = 0; oi < opTypes.length; oi++) {
    const ot = opTypes[oi].toLowerCase().trim().replace(/\{[^}]*\}/g, '').trim();

    if (isRmType(ot)) {
      if (mod === 3) {
        const sz = rmSize(ot, operandSize, rexW);
        operands.push({ kind: 'reg', name: regName(rm, sz, hasRex) });
      } else if (mod === 0 && (rm & 7) === 5) {
        // RIP-relative (64-bit mode): mod=00, rm=101 — no base reg, 4-byte disp relative to RIP
        const sz = rmSize(ot, operandSize, rexW);
        operands.push({ kind: 'mem', base: 'rip', disp: memDisp || undefined, size: sz });
      } else {
        const sz = rmSize(ot, operandSize, rexW);
        const base = memBase !== undefined ? regName(memBase, 64, hasRex) : undefined;
        const idx = memIndex !== undefined ? regName(memIndex, 64, hasRex) : undefined;
        operands.push({ kind: 'mem', base, index: idx, scale: memScale !== 1 ? memScale : undefined, disp: memDisp || undefined, size: sz });
      }
      continue;
    }
    if (isRegType(ot)) {
      const sz = regTypeSize(ot, operandSize, rexW);
      operands.push({ kind: 'reg', name: regName(reg, sz, hasRex) });
      continue;
    }
    if (ot === 'al')  { operands.push({ kind: 'reg', name: 'al' }); continue; }
    if (ot === 'ax')  { operands.push({ kind: 'reg', name: 'ax' }); continue; }
    if (ot === 'eax') { operands.push({ kind: 'reg', name: 'eax' }); continue; }
    if (ot === 'rax') { operands.push({ kind: 'reg', name: 'rax' }); continue; }
    if (ot === 'cl')  { operands.push({ kind: 'reg', name: 'cl' }); continue; }
    if (ot === '1')   { operands.push({ kind: 'imm', value: 1 }); continue; }
    if (ot.startsWith('imm')) {
      const immSize = parseInt(ot.replace('imm', '')) as 8 | 16 | 32 | 64;
      const immBytes = immSize >> 3;
      if (instrEnd + immBytes > buf.length) return null;
      const immVal = readImm(buf, instrEnd, immBytes);
      instrEnd += immBytes;
      operands.push({ kind: 'imm', value: immVal });
      continue;
    }
    if (ot === 'rel8' || ot === 'rel32') {
      const relSize = ot === 'rel8' ? 1 : 4;
      if (instrEnd + relSize > buf.length) return null;
      const rawOffset = relSize === 1 ? signExtend8(buf[instrEnd]) : readImm32Signed(buf, instrEnd);
      instrEnd += relSize;
      const target = baseAddr + (instrEnd - startPos) + rawOffset;  // RIP is at end of instruction
      // Wait — we need to properly compute RIP.
      // Actually, RIP = baseAddr + instrEnd (bytes from start)
      // But we stored startPos as the offset from buf[0]. Let me fix:
      // target = baseAddr + instrEnd_from_startPos_perspective... actually instrEnd is already absolute index into buf
      const rip = instrEnd; // position in buf where next instruction starts
      const target2 = baseAddr + rip + rawOffset - (instrEnd - startPos) + (instrEnd - startPos);
      // Simpler: target = baseAddr + instrEnd + rawOffset
      const absTarget = baseAddr + instrEnd + rawOffset;
      operands.push({ kind: 'rel', target: absTarget });
      continue;
    }
  }

  // Swap operands for MR encoding in Intel/AT&T output
  // MR: r/m is first in listing (dest), reg is second (src)
  // Already in correct order from the SDM form

  // For group-mnemonic rows (Jcc, SETcc, etc.), extract the real mnemonic from the instruction form
  const GROUP_MNEMONICS = new Set(['Jcc', 'SETcc', 'CMOVcc', 'FCMOVcc', 'LOOPcc']);
  const realMnemonic = GROUP_MNEMONICS.has(row.mnemonic) && row.instruction
    ? row.instruction.split(/\s/)[0]
    : row.mnemonic;

  return {
    length: instrEnd - startPos,
    mnemonic: realMnemonic,
    prefixes,
    operands,
    operandSize,
  };
}

function formatInstr(instr: DecodedInstr, syntax: 'intel' | 'attasm', branchTargets: Set<number>): string {
  const { mnemonic, operands, prefixes, operandSize } = instr;
  let mnem = mnemonic;

  if (syntax === 'attasm') {
    // Add size suffix
    const suffix = operandSize === 8 ? 'b' : operandSize === 16 ? 'w' : operandSize === 32 ? 'l' : 'q';
    const noSuffix = new Set(['NOP', 'RET', 'SYSCALL', 'INT3', 'LEAVE', 'IRET', 'HLT',
      'PUSH', 'POP', 'CALL', 'JMP',
      'JA','JAE','JB','JBE','JE','JNE','JG','JGE','JL','JLE',
      'JO','JNO','JS','JNS','JP','JNP','JRCXZ','LOOP','LOOPE','LOOPNE']);
    if (!noSuffix.has(mnem.toUpperCase())) mnem = mnem + suffix;
  }

  const prefixStr = prefixes.map(p => p.toLowerCase() + ' ').join('');

  if (operands.length === 0) return prefixStr + mnem.toLowerCase();

  const ops = operands.map(op => formatOp(op, syntax, branchTargets));

  if (syntax === 'attasm') {
    // Reverse operand order for 2-operand instructions: Intel (dst, src) → AT&T (src, dst)
    if (ops.length === 2) {
      return prefixStr + mnem.toLowerCase() + ' ' + [ops[1], ops[0]].join(', ');
    }
  }

  return prefixStr + mnem.toLowerCase() + ' ' + ops.join(', ');
}

function formatOp(op: DecodedOperand, syntax: 'intel' | 'attasm', branchTargets: Set<number>): string {
  if (op.kind === 'reg') return syntax === 'attasm' ? `%${op.name}` : op.name;
  if (op.kind === 'imm') return syntax === 'attasm' ? `$0x${op.value.toString(16)}` : `0x${op.value.toString(16)}`;
  if (op.kind === 'rel' || op.kind === 'label') {
    const addr = op.kind === 'rel' ? op.target : op.addr;
    if (branchTargets.has(addr)) return `loc_${addr.toString(16).padStart(8,'0')}`;
    return `0x${addr.toString(16)}`;
  }
  if (op.kind === 'mem') {
    if (syntax === 'attasm') {
      const disp = op.disp ? op.disp.toString() : '';
      const base = op.base ? `%${op.base}` : '';
      const idx = op.index ? `,%${op.index}` : '';
      const sc = op.scale && op.scale !== 1 ? `,${op.scale}` : '';
      if (!op.index && !op.scale) return `${disp}(${base})`;
      return `${disp}(${base}${idx}${sc})`;
    }
    const sizeStr = op.size === 8 ? 'byte ptr ' : op.size === 16 ? 'word ptr ' : op.size === 32 ? 'dword ptr ' : op.size === 64 ? 'qword ptr ' : '';
    const base = op.base ?? '';
    const idx = op.index ? `+${op.index}${op.scale && op.scale !== 1 ? '*' + op.scale : ''}` : '';
    const disp = op.disp ? (op.disp >= 0 ? `+0x${op.disp.toString(16)}` : `-0x${(-op.disp).toString(16)}`) : '';
    return `${sizeStr}[${base}${idx}${disp}]`;
  }
  return '?';
}

// ---- Helpers ----

function isDataRegion(pos: number, regions: Array<{ start: number; end: number }>): boolean {
  return regions.some(r => pos >= r.start && pos < r.end);
}

function readImm(buf: Uint8Array, pos: number, size: number): number {
  let v = 0;
  for (let i = 0; i < size; i++) v |= buf[pos + i] << (i * 8);
  return v >>> 0;
}

function readImm32Signed(buf: Uint8Array, pos: number): number {
  const v = (buf[pos] | (buf[pos+1] << 8) | (buf[pos+2] << 16) | (buf[pos+3] << 24));
  return v; // already signed in JS
}

function signExtend8(b: number): number {
  return b & 0x80 ? b - 256 : b;
}

function isRmType(t: string): boolean {
  return t === 'm' || t.includes('r/m') || t.startsWith('rm') || t === 'm8' || t === 'm16' || t === 'm32' || t === 'm64' || t === 'm128';
}

function isRegType(t: string): boolean {
  return (t.startsWith('r') && !t.includes('/') && !t.startsWith('rax') && !t.startsWith('rbp') && (t.endsWith('8') || t.endsWith('16') || t.endsWith('32') || t.endsWith('64')));
}

function rmSize(ot: string, defSize: OperandSize, rexW: boolean): OperandSize {
  if (ot.includes('8'))  return 8;
  if (ot.includes('16')) return 16;
  if (ot.includes('32')) return 32;
  if (ot.includes('64')) return 64;
  return defSize;
}

function regTypeSize(ot: string, defSize: OperandSize, rexW: boolean): OperandSize {
  return rmSize(ot, defSize, rexW);
}

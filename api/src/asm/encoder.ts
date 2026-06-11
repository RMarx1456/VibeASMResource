// 2-pass x86-64 assembler.
// Pass 1: layout — assign tentative sizes to all statements and collect label addresses.
// Pass 2: encode  — emit bytes with resolved label addresses.
// GNU `as` (gas) is the reference oracle for encoding choices.

import type {
  ProgramAST, StatementNode, OperandNode, AssembleResult, AsmError, Diagnostic, ListingLine, OperandSize
} from './types';
import type { OpcodeIndex, IndexedRow } from './table';
import { matchEncoding, parseSDMOpType, parseInstructionForm } from './operands';
import { lookupReg } from './regs';
import { encodeModRMMem, encodeModRMReg, encodeImm, encodeRel, mergeRex, fitsImm8, fitsImm32 } from './modrm';
import type { OpcodeToken } from './opcode_tokens';

export interface AssembleOptions {
  baseAddr: number;
}

export function assemble(
  ast: ProgramAST,
  index: OpcodeIndex,
  opts: AssembleOptions = { baseAddr: 0 },
): AssembleResult | AsmError {
  const errors: Diagnostic[] = [];
  const labels = new Map<string, number>(); // name → byte offset from start
  let origin = opts.baseAddr;

  function addError(d: Diagnostic) { errors.push(d); }

  // ---- Pass 1: layout ----
  // We size each statement conservatively (rel32 for all jumps) to get stable label addresses.

  interface SizedStmt {
    stmt: StatementNode;
    size: number;
    offset: number; // byte offset from start
  }

  const sized: SizedStmt[] = [];
  let offset = 0;

  for (const stmt of ast.statements) {
    if (stmt.kind === 'org') {
      origin = Number(stmt.addr);
      offset = 0;
      continue;
    }
    if (stmt.kind === 'label') {
      labels.set(stmt.name, offset);
      sized.push({ stmt, size: 0, offset });
      continue;
    }
    if (stmt.kind === 'define') {
      // Defines are handled during preprocessing; skip here
      continue;
    }
    if (stmt.kind === 'data') {
      const sz = dataSize(stmt);
      sized.push({ stmt, size: sz, offset });
      offset += sz;
      continue;
    }
    if (stmt.kind === 'times') {
      const inner = sizeStmt(stmt.body, index, labels, origin, offset, errors);
      const total = inner * Number(stmt.count);
      sized.push({ stmt, size: total, offset });
      offset += total;
      continue;
    }
    if (stmt.kind === 'instr') {
      const sz = sizeStmt(stmt, index, labels, origin, offset, errors);
      sized.push({ stmt, size: sz, offset });
      offset += sz;
      continue;
    }
    sized.push({ stmt, size: 0, offset });
  }

  if (errors.length > 0) return { ok: false, errors };

  // ---- Pass 2: encode ----
  const allBytes: number[] = [];
  const listing: ListingLine[] = [];

  for (const { stmt, size, offset: stmtOffset } of sized) {
    if (stmt.kind === 'label') continue;
    if (stmt.kind === 'data') {
      const bytes = encodeData(stmt);
      allBytes.push(...bytes);
      listing.push({ address: origin + stmtOffset, bytes, source: dataSource(stmt) });
      continue;
    }
    if (stmt.kind === 'instr') {
      const result = encodeInstr(stmt, index, labels, origin, stmtOffset, errors);
      if (result === null) continue;
      allBytes.push(...result);
      listing.push({ address: origin + stmtOffset, bytes: result, source: instrSource(stmt, ast.syntax) });
      continue;
    }
    if (stmt.kind === 'times') {
      const inner = stmt.body;
      if (inner.kind === 'instr') {
        const innerSize = size / Number(stmt.count);
        for (let i = 0; i < Number(stmt.count); i++) {
          const result = encodeInstr(inner, index, labels, origin, stmtOffset + i * innerSize, errors);
          if (result) allBytes.push(...result);
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, bytes: allBytes, listing };
}

// ---- Sizing ----

function sizeStmt(
  stmt: StatementNode,
  index: OpcodeIndex,
  labels: Map<string, number>,
  origin: number,
  offset: number,
  errors: Diagnostic[],
): number {
  if (stmt.kind !== 'instr') return 0;

  const match = matchEncoding(stmt.mnemonic, stmt.operands, stmt.sizeHint, index);
  if ('severity' in match) {
    // Don't report here; will be caught in pass 2 properly
    return 15; // conservative max instruction size
  }

  return computeSize(match.row, stmt.operands);
}

function computeSize(row: IndexedRow, operands: OperandNode[]): number {
  const tokens = row.tokens;
  let size = 0;
  for (const t of tokens) {
    if (t.kind === 'prefix_REXW' || t.kind === 'prefix_66' || t.kind === 'prefix_F2' || t.kind === 'prefix_F3' || t.kind === 'prefix_REX') size += 1;
    if (t.kind === 'byte') size += 1;
    if (t.kind === 'byte_plus_reg') size += 1;
    if (t.kind === 'modrm_r' || t.kind === 'modrm_digit') size += modrmSize(operands);
    if (t.kind === 'imm') size += t.size >> 3;
    if (t.kind === 'rel') size += t.size >> 3;
  }
  return size || 1;
}

function modrmSize(operands: OperandNode[]): number {
  // ModRM + maybe SIB + maybe displacement
  // Worst case: ModRM(1) + SIB(1) + disp32(4) = 6
  for (const op of operands) {
    if (op.kind === 'mem') {
      // RIP-relative: always ModRM(1) + disp32(4) — no SIB
      if (op.base === 'rip' || op.dispLabel) return 5;
      let sz = 1; // ModRM
      if (op.index || (op.base && lookupReg(op.base)?.code === 4)) sz += 1; // SIB
      if (op.disp !== undefined && op.disp !== 0n) {
        sz += (op.disp >= -128n && op.disp <= 127n) ? 1 : 4;
      }
      return sz;
    }
  }
  return 1; // register-direct: just ModRM
}

function dataSize(stmt: Extract<StatementNode, { kind: 'data' }>): number {
  const unitSize = stmt.directive === 'db' ? 1 : stmt.directive === 'dw' ? 2 : stmt.directive === 'dd' ? 4 : 8;
  let total = 0;
  for (const v of stmt.values) {
    if (Array.isArray(v)) total += v.length * unitSize;
    else total += unitSize;
  }
  return total;
}

// ---- Encoding ----

function encodeInstr(
  stmt: Extract<StatementNode, { kind: 'instr' }>,
  index: OpcodeIndex,
  labels: Map<string, number>,
  origin: number,
  offset: number,
  errors: Diagnostic[],
): number[] | null {
  // Resolve label operands to immediates
  const resolvedOps = stmt.operands.map(op => resolveLabel(op, labels, origin, offset));

  const match = matchEncoding(stmt.mnemonic, resolvedOps, stmt.sizeHint, index);
  if ('severity' in match) {
    errors.push({ ...match, line: stmt.line });
    return null;
  }

  try {
    return emitInstruction(match.row, resolvedOps, stmt.prefixes, errors, stmt.line, origin + offset);
  } catch (e: unknown) {
    errors.push({ line: stmt.line, message: e instanceof Error ? e.message : 'Encoding error', severity: 'error' });
    return null;
  }
}

function resolveLabel(op: OperandNode, labels: Map<string, number>, origin: number, curOffset: number): OperandNode {
  if (op.kind === 'label') {
    const addr = labels.get(op.name);
    if (addr === undefined) return op; // unresolved — will cause error in matchEncoding
    return { kind: 'imm', value: BigInt(origin + addr) };
  }
  // RIP-relative memory: msg(%rip) — resolve the symbol to absolute address, keep base='rip'
  if (op.kind === 'mem' && op.dispLabel) {
    const addr = labels.get(op.dispLabel);
    if (addr !== undefined) {
      return { ...op, dispLabel: undefined, base: 'rip', disp: BigInt(origin + addr) };
    }
  }
  return op;
}

function emitInstruction(
  row: IndexedRow,
  operands: OperandNode[],
  prefixes: string[],
  errors: Diagnostic[],
  line: number,
  instrPC = 0,
): number[] {
  const tokens = row.tokens;
  const { opTypes } = parseInstructionForm(row.instruction);
  const bytes: number[] = [];

  // Determine which operand is the r/m operand and which is the reg operand
  // based on the op_en field
  const opEn = row.opEn.toUpperCase();
  const rmIdx = getRmOperandIndex(opEn);     // index in `operands` array that is r/m
  const regIdx = getRegOperandIndex(opEn);    // index that is the register (reg field)
  const immIdx = getImmOperandIndex(opEn);    // index that is the immediate
  const relIdx = getRelOperandIndex(opEn);    // index that is the relative offset

  let rexByte = 0;
  let modrmBytes: number[] = [];
  let immBytes: number[] = [];

  // User-specified prefixes (lock, rep, etc.)
  for (const p of prefixes) {
    if (p === 'LOCK')           bytes.push(0xF0);
    else if (p === 'REP' || p === 'REPE' || p === 'REPZ') bytes.push(0xF3);
    else if (p === 'REPNE' || p === 'REPNZ') bytes.push(0xF2);
  }

  for (const tok of tokens) {
    switch (tok.kind) {
      case 'prefix_NP': break;
      case 'prefix_66': bytes.push(0x66); break;
      case 'prefix_F2': bytes.push(0xF2); break;
      case 'prefix_F3': bytes.push(0xF3); break;
      case 'prefix_REXW': rexByte = mergeRex(rexByte, 0x48); break;
      case 'prefix_REXR': rexByte = mergeRex(rexByte, 0x44); break;
      case 'prefix_REXB': rexByte = mergeRex(rexByte, 0x41); break;
      case 'prefix_REX':  rexByte = mergeRex(rexByte, 0x40); break;

      case 'byte':
        // Flush REX before first opcode byte
        if (rexByte) { bytes.push(rexByte); rexByte = 0; }
        bytes.push(tok.value);
        break;

      case 'byte_plus_reg': {
        // e.g. 50+rd for PUSH, B8+rd for MOV
        const regOpIdx = regIdx >= 0 ? regIdx : rmIdx;
        const regOp = regOpIdx >= 0 ? operands[regOpIdx] : null;
        let code = 0;
        if (regOp?.kind === 'reg') {
          const info = lookupReg(regOp.reg);
          if (info) {
            code = info.code & 7;
            if (info.code >= 8) rexByte = mergeRex(rexByte, 0x41); // REX.B
          }
        }
        if (rexByte) { bytes.push(rexByte); rexByte = 0; }
        bytes.push(tok.base | code);
        break;
      }

      case 'modrm_r': {
        const rmOp = rmIdx >= 0 ? operands[rmIdx] : null;
        const regOp = regIdx >= 0 ? operands[regIdx] : null;
        const rexW = (rexByte & 0x08) !== 0;
        let regCode = 0;
        if (regOp?.kind === 'reg') {
          const info = lookupReg(regOp.reg);
          if (info) regCode = info.code;
        }
        if (rmOp?.kind === 'reg') {
          const info = lookupReg(rmOp.reg);
          if (info) {
            const r = encodeModRMReg(info.code, regCode, rexW);
            rexByte = mergeRex(rexByte, r.rex);
            if (rexByte) { bytes.push(rexByte); rexByte = 0; }
            modrmBytes = r.bytes;
          }
        } else if (rmOp?.kind === 'mem') {
          const r = encodeModRMMem(rmOp, regCode, rexW, instrPC + bytes.length);
          rexByte = mergeRex(rexByte, r.rex);
          if (rexByte) { bytes.push(rexByte); rexByte = 0; }
          modrmBytes = r.bytes;
        } else {
          if (rexByte) { bytes.push(rexByte); rexByte = 0; }
        }
        bytes.push(...modrmBytes);
        modrmBytes = [];
        break;
      }

      case 'modrm_digit': {
        const rmOp = rmIdx >= 0 ? operands[rmIdx] : null;
        const rexW = (rexByte & 0x08) !== 0;
        const digit = tok.digit;
        if (rmOp?.kind === 'reg') {
          const info = lookupReg(rmOp.reg);
          if (info) {
            const r = encodeModRMReg(info.code, digit, rexW);
            rexByte = mergeRex(rexByte, r.rex);
            if (rexByte) { bytes.push(rexByte); rexByte = 0; }
            bytes.push(...r.bytes);
          }
        } else if (rmOp?.kind === 'mem') {
          const r = encodeModRMMem(rmOp, digit, rexW, instrPC + bytes.length);
          rexByte = mergeRex(rexByte, r.rex);
          if (rexByte) { bytes.push(rexByte); rexByte = 0; }
          bytes.push(...r.bytes);
        } else {
          if (rexByte) { bytes.push(rexByte); rexByte = 0; }
        }
        break;
      }

      case 'imm': {
        const immOp = immIdx >= 0 ? operands[immIdx] : null;
        let value = 0n;
        if (immOp?.kind === 'imm') value = immOp.value;
        immBytes = encodeImm(value, tok.size);
        bytes.push(...immBytes);
        break;
      }

      case 'rel': {
        const relOp = relIdx >= 0 ? operands[relIdx] : null;
        let target = 0n;
        if (relOp?.kind === 'imm') target = relOp.value;
        // rel = target_abs - (instrStart_abs + bytes_so_far + field_size)
        const fieldSize = tok.size >> 3;
        const instrEnd = instrPC + bytes.length + fieldSize;
        const rel = Number(target) - instrEnd;
        bytes.push(...encodeRel(rel, tok.size));
        break;
      }
    }
  }

  // Flush any remaining REX
  // (shouldn't happen, but just in case)

  return bytes;
}

// ---- Op/En index helpers ----

// For each opEn, which operand index (0-based, in Intel order) is the r/m field?
function getRmOperandIndex(opEn: string): number {
  switch (opEn) {
    case 'MR':   return 0; // dest in r/m, src in reg
    case 'MI':   return 0; // dest in r/m, src is imm
    case 'M':    return 0; // single r/m operand
    case 'RM':   return 1; // dest in reg, src in r/m
    case 'I':    return -1; // AL/AX/EAX/RAX implicit
    case 'O':    return 0; // register in opcode
    case 'OI':   return 0; // register in opcode + imm
    case 'D':    return -1; // direct offset (moffs)
    case 'ZO':   return -1; // no operands
    case 'NP':   return -1;
    default:
      // Generic: first operand
      return 0;
  }
}

function getRegOperandIndex(opEn: string): number {
  switch (opEn) {
    case 'MR':  return 1; // src in reg
    case 'RM':  return 0; // dest in reg
    case 'O':   return 0;
    case 'OI':  return 0;
    default:    return -1;
  }
}

function getImmOperandIndex(opEn: string): number {
  switch (opEn) {
    case 'I':   return 1; // AL+imm: imm is operand[1]
    case 'MI':  return 1;
    case 'OI':  return 1;
    case 'IA':  return 0; // imm alone?
    default:    return -1;
  }
}

function getRelOperandIndex(opEn: string): number {
  switch (opEn) {
    case 'D': return 0;
    default:  return 0; // jumps always have operand[0] as target
  }
}

// ---- Data encoding ----

function encodeData(stmt: Extract<StatementNode, { kind: 'data' }>): number[] {
  const unitSize = stmt.directive === 'db' ? 1 : stmt.directive === 'dw' ? 2 : stmt.directive === 'dd' ? 4 : 8;
  const bytes: number[] = [];
  for (const v of stmt.values) {
    if (Array.isArray(v)) {
      for (const b of v) {
        for (let i = 0; i < unitSize; i++) bytes.push((b >> (i * 8)) & 0xFF);
      }
    } else {
      const bytes2 = encodeImm(v, (unitSize * 8) as 8 | 16 | 32 | 64);
      bytes.push(...bytes2);
    }
  }
  return bytes;
}

function dataSource(stmt: Extract<StatementNode, { kind: 'data' }>): string {
  return `${stmt.directive} ...`;
}

function instrSource(stmt: Extract<StatementNode, { kind: 'instr' }>, syntax: string): string {
  const parts = [stmt.mnemonic, ...stmt.operands.map(op => opStr(op, syntax))];
  return parts.join(' ');
}

function opStr(op: OperandNode, syntax: string): string {
  if (op.kind === 'reg') return syntax === 'attasm' ? `%${op.reg}` : op.reg;
  if (op.kind === 'imm') return syntax === 'attasm' ? `$${op.value}` : op.value.toString();
  if (op.kind === 'label') return op.name;
  if (op.kind === 'mem') {
    if (syntax === 'attasm') {
      const disp = op.disp ? op.disp.toString() : '';
      const base = op.base ? `%${op.base}` : '';
      const idx = op.index ? `,%${op.index}` : '';
      const sc = op.scale && op.scale !== 1 ? `,${op.scale}` : '';
      return `${disp}(${base}${idx}${sc})`;
    }
    const disp = op.disp ? `+${op.disp}` : '';
    const base = op.base ?? '';
    const idx = op.index ? `+${op.index}` : '';
    const sc = op.scale && op.scale !== 1 ? `*${op.scale}` : '';
    return `[${base}${idx}${sc}${disp}]`;
  }
  return '?';
}

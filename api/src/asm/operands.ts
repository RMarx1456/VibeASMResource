// Operand type classification and encoding-row matching.
// The goal: given parsed operands (in Intel order), find the best OpcodeRow.

import type { OperandNode, OperandSize, Diagnostic } from './types';
import { lookupReg } from './regs';
import { fitsImm8, fitsImm32 } from './modrm';
import type { IndexedRow } from './table';

// The canonical operand types used in SDM instruction forms, normalized.
export type OpType =
  | 'r8' | 'r16' | 'r32' | 'r64'
  | 'm8' | 'm16' | 'm32' | 'm64' | 'm128' | 'm256'
  | 'rm8' | 'rm16' | 'rm32' | 'rm64'
  | 'imm8' | 'imm16' | 'imm32' | 'imm64'
  | 'rel8' | 'rel32'
  | 'xmm' | 'ymm'
  | 'al' | 'ax' | 'eax' | 'rax'  // implicit fixed-reg operands
  | 'cl'
  | 'one'                          // implicit literal 1 (shifts)
  | 'unknown';

/** Parse an SDM operand type string from the instruction form, e.g. "r/m64" → 'rm64'.
 *  Handles SDM footnote superscripts (e.g. "r/m81" for "r/m8¹") by matching the
 *  longest valid size prefix. Checks from largest to smallest to avoid "8" matching "128".
 */
export function parseSDMOpType(s: string): OpType {
  const t = s.trim().toLowerCase()
    .replace(/\s*ptr\s*/g, '')
    .replace(/1to\d+/g, '')
    .replace(/\{[^}]*\}/g, '')
    .trim();

  if (t === 'al')  return 'al';
  if (t === 'ax')  return 'ax';
  if (t === 'eax') return 'eax';
  if (t === 'rax') return 'rax';
  if (t === 'cl')  return 'cl';
  if (t === '1')   return 'one';

  // r/m types — extract numeric size, checking largest first to avoid 8 matching 128
  const rmMatch = t.match(/r\/m(\d+)/);
  if (rmMatch) {
    const d = rmMatch[1];
    if (d.startsWith('512')) return 'rm64'; // treat as rm64 for now
    if (d.startsWith('256')) return 'rm64';
    if (d.startsWith('128')) return 'rm64';
    if (d.startsWith('64'))  return 'rm64';
    if (d.startsWith('32'))  return 'rm32';
    if (d.startsWith('16'))  return 'rm16';
    if (d.startsWith('8'))   return 'rm8';
  }

  // rm without slash (alternate form)
  const rm2 = t.match(/^rm(\d+)/);
  if (rm2) {
    const d = rm2[1];
    if (d.startsWith('64'))  return 'rm64';
    if (d.startsWith('32'))  return 'rm32';
    if (d.startsWith('16'))  return 'rm16';
    if (d.startsWith('8'))   return 'rm8';
  }

  // Plain register types — check r<size> pattern (not prefixed by /)
  const rMatch = t.match(/^r(\d+)/);
  if (rMatch && !t.includes('/')) {
    const d = rMatch[1];
    if (d.startsWith('64'))  return 'r64';
    if (d.startsWith('32'))  return 'r32';
    if (d.startsWith('16'))  return 'r16';
    if (d.startsWith('8'))   return 'r8';
  }

  // Memory-only types
  const mMatch = t.match(/^m(\d+)/);
  if (mMatch) {
    const d = mMatch[1];
    if (d.startsWith('512')) return 'm64';
    if (d.startsWith('256')) return 'm256';
    if (d.startsWith('128')) return 'm128';
    if (d.startsWith('64'))  return 'm64';
    if (d.startsWith('32'))  return 'm32';
    if (d.startsWith('16'))  return 'm16';
    if (d.startsWith('8'))   return 'm8';
  }

  // Immediate types
  const immMatch = t.match(/imm(\d+)/);
  if (immMatch) {
    const d = immMatch[1];
    if (d.startsWith('64'))  return 'imm64';
    if (d.startsWith('32'))  return 'imm32';
    if (d.startsWith('16'))  return 'imm16';
    if (d.startsWith('8'))   return 'imm8';
  }

  if (t.includes('rel8'))  return 'rel8';
  if (t.includes('rel32')) return 'rel32';

  if (t.startsWith('xmm')) return 'xmm';
  if (t.startsWith('ymm')) return 'ymm';

  return 'unknown';
}

/** Extract operand type strings from the instruction field, e.g. "ADD r/m64, imm32" */
export function parseInstructionForm(form: string): { mnemonic: string; opTypes: string[] } {
  // Footnote superscripts (e.g. "r/m81" for "r/m8¹") are handled by parseSDMOpType,
  // so we do NOT normalize here — any regex here would corrupt valid sizes like "r/m64".
  const norm = form;
  const idx = norm.search(/[ \t]/);
  if (idx < 0) return { mnemonic: norm.trim().toUpperCase(), opTypes: [] };
  const mnemonic = norm.slice(0, idx).toUpperCase();
  const rest = norm.slice(idx).trim();
  if (!rest) return { mnemonic, opTypes: [] };

  // Split on comma, strip decorators like {k1}{z}, {er}, {sae}, {1to16}
  const opTypes = rest
    .split(',')
    .map(s => s.replace(/\{[^}]*\}/g, '').trim())
    .filter(Boolean);

  return { mnemonic, opTypes };
}

/** Classify a parsed OperandNode into an OpType given the instruction's size hint. */
export function classifyOperand(
  node: OperandNode,
  sizeHint: OperandSize | undefined,
): OpType | null {
  if (node.kind === 'reg') {
    const info = lookupReg(node.reg);
    if (!info) return null;
    switch (info.size) {
      case 8:   return 'r8';
      case 16:  return 'r16';
      case 32:  return 'r32';
      case 64:  return 'r64';
      case 128: return 'xmm';
      case 256: return 'ymm';
    }
  }
  if (node.kind === 'imm') {
    const v = node.value;
    // Classify as smallest type that can represent this value (signed or unsigned)
    if (v >= -128n && v <= 255n)       return 'imm8';
    if (v >= -32768n && v <= 65535n)   return 'imm16';
    if (v >= -2147483648n && v <= 4294967295n) return 'imm32';
    return 'imm64';
  }
  if (node.kind === 'mem') {
    const sz = node.size ?? sizeHint;
    if (sz === 8)   return 'm8';
    if (sz === 16)  return 'm16';
    if (sz === 32)  return 'm32';
    if (sz === 64)  return 'm64';
    if (sz === 128) return 'm128';
    if (sz === 256) return 'm256';
    return 'unknown';
  }
  if (node.kind === 'label') return 'rel32'; // assume rel32 for labels
  return null;
}

/** Check if an actual OpType is compatible with a required SDM operand type. */
function compatible(actual: OpType, required: OpType): boolean {
  if (actual === required) return true;

  // r/m types accept both reg and mem variants
  if (required === 'rm8'  && (actual === 'r8'  || actual === 'm8'))  return true;
  if (required === 'rm16' && (actual === 'r16' || actual === 'm16')) return true;
  if (required === 'rm32' && (actual === 'r32' || actual === 'm32')) return true;
  if (required === 'rm64' && (actual === 'r64' || actual === 'm64')) return true;

  // Immediates: smaller fits into larger slots (with sign extension)
  if (required === 'imm16' && actual === 'imm8')  return true;
  if (required === 'imm32' && (actual === 'imm8' || actual === 'imm16')) return true;
  if (required === 'imm64' && (actual === 'imm8' || actual === 'imm16' || actual === 'imm32')) return true;

  // Fixed-register slots accept the matching register
  if (required === 'al'  && actual === 'r8')  return true;
  if (required === 'ax'  && actual === 'r16') return true;
  if (required === 'eax' && actual === 'r32') return true;
  if (required === 'rax' && actual === 'r64') return true;
  if (required === 'cl'  && actual === 'r8')  return true;
  if (required === 'one' && actual === 'imm8') return true;

  // rel8/rel32 accept labels and immediates
  if (required === 'rel8'  && (actual === 'rel8' || actual === 'imm8')) return true;
  if (required === 'rel32' && (actual === 'imm8' || actual === 'imm16' || actual === 'imm32' || actual === 'rel32')) return true;

  // Memory operands accept unknown-size memory (will be resolved by context)
  if (actual === 'unknown' && (required === 'm8' || required === 'm16' || required === 'm32' || required === 'm64')) return true;
  if (actual === 'unknown' && (required === 'rm8' || required === 'rm16' || required === 'rm32' || required === 'rm64')) return true;

  // SDM uses bare 'm' (no size) for some instructions like LEA — parses as 'unknown'
  // Accept any memory-class actual type for an unsized memory required type
  if (required === 'unknown' && (
    actual === 'm8' || actual === 'm16' || actual === 'm32' || actual === 'm64' ||
    actual === 'm128' || actual === 'm256' ||
    actual === 'rm8' || actual === 'rm16' || actual === 'rm32' || actual === 'rm64' ||
    actual === 'unknown'
  )) return true;

  return false;
}

export interface MatchResult {
  row: IndexedRow;
  sdmTypes: OpType[];
  score: number; // lower is better
}

/**
 * Find the best matching opcode row for a parsed instruction.
 * Returns the best match or a diagnostic on failure.
 */
export function matchEncoding(
  mnemonic: string,
  operands: OperandNode[],
  sizeHint: OperandSize | undefined,
  index: { byMnemonic: (m: string) => IndexedRow[] },
): MatchResult | Diagnostic {
  const candidates = index.byMnemonic(mnemonic);
  if (candidates.length === 0) {
    return { message: `Unknown mnemonic: ${mnemonic}`, severity: 'error' };
  }

  const actualTypes = operands.map(op => classifyOperand(op, sizeHint));

  const matches: MatchResult[] = [];

  for (const row of candidates) {
    if (row.isVex) continue; // VEX not supported in MVP

    const { opTypes } = parseInstructionForm(row.instruction);

    // Filter out implicit/hidden operands that don't appear in parsed source
    // (e.g. "ADD r/m64, imm32" has 2 operands, both visible)
    // The SDM form lists all operands; we match them in order.
    const visibleTypes = opTypes.filter(t => {
      const norm = t.toLowerCase();
      // Skip segment registers, control regs, debug regs from matching
      return !norm.startsWith('sreg') && !norm.startsWith('cr') && !norm.startsWith('dr');
    });

    if (visibleTypes.length !== operands.length) continue;

    const sdmTypes = visibleTypes.map(t => parseSDMOpType(t));
    let allMatch = true;

    for (let i = 0; i < operands.length; i++) {
      const actual = actualTypes[i];
      if (actual === null) { allMatch = false; break; }

      // Extra check: fixed-register slots require the exact register
      const req = sdmTypes[i];
      if (req === 'al'  && !(operands[i].kind === 'reg' && operands[i].kind === 'reg' && (operands[i] as { kind: 'reg'; reg: string }).reg.toLowerCase() === 'al'))  {/* ok to be flexible */}
      if (req === 'eax' && operands[i].kind === 'reg' && (operands[i] as { kind: 'reg'; reg: string }).reg.toLowerCase() !== 'eax') { allMatch = false; break; }
      if (req === 'rax' && operands[i].kind === 'reg' && (operands[i] as { kind: 'reg'; reg: string }).reg.toLowerCase() !== 'rax') { allMatch = false; break; }

      if (!compatible(actual, req)) { allMatch = false; break; }
    }

    if (!allMatch) continue;

    matches.push({ row, sdmTypes, score: scoreRow(row, operands, sdmTypes) });
  }

  if (matches.length === 0) {
    const actualStr = actualTypes.map(t => t ?? '?').join(', ');
    return {
      message: `No matching encoding for ${mnemonic} with operand types (${actualStr})`,
      severity: 'error',
    };
  }

  matches.sort((a, b) => a.score - b.score);
  return matches[0];
}

/** Score a candidate row — lower is preferred (shorter, more specific encoding). */
function scoreRow(row: IndexedRow, operands: OperandNode[], sdmTypes: OpType[]): number {
  let score = 0;

  // Prefer imm8-sign-extended forms over imm32 (shorter)
  for (let i = 0; i < operands.length; i++) {
    const op = operands[i];
    const req = sdmTypes[i];
    if (op.kind === 'imm' && req === 'imm8')  score -= 3; // strongly prefer short imm
    if (op.kind === 'imm' && req === 'imm16') score -= 1;
    if (op.kind === 'imm' && req === 'imm32') score += 0;
    if (op.kind === 'imm' && req === 'imm64') score += 5; // avoid imm64 when imm32 works
  }

  // Prefer MR form over RM form for reg-reg (gas behavior)
  if (row.opEn === 'MR') score -= 1;
  if (row.opEn === 'RM') score += 1;

  // Prefer O (register-in-opcode) for 32-bit mov-immediate (shorter)
  if (row.opEn === 'O' || row.opEn === 'OI') score -= 2;

  // Penalty for 16-bit forms (avoid unless that's what's asked)
  if (row.hasRexW === false && sdmTypes.some(t => t === 'r16' || t === 'rm16' || t === 'imm16')) score += 1;

  // Prefer rel32 over rel8 — relaxation not implemented, both passes must agree
  if (sdmTypes.some(t => t === 'rel32')) score -= 3;
  if (sdmTypes.some(t => t === 'rel8'))  score += 3;

  // Penalty for 64-bit immediate when 32-bit suffices (sign extension)
  if (sdmTypes.some(t => t === 'imm64')) {
    const immOp = operands.find(o => o.kind === 'imm');
    if (immOp && immOp.kind === 'imm' && fitsImm32(immOp.value)) score += 4;
  }

  return score;
}

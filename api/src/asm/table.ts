// Builds an in-memory opcode index from DB rows.
// The index supports two directions: assembler (by mnemonic) and disassembler (by bytes).

import type { OpcodeRow, OperandEncodingRow } from './types';
import { parseOpcodeString, isVexOrEvex, mandatoryPrefix, opcodeBytes, modrDigit } from './opcode_tokens';

export interface OpcodeIndex {
  byMnemonic(mnemonic: string): IndexedRow[];
  byBytes(prefix: number | null, rexW: boolean, op1: number, op2: number | null, digit: number): IndexedRow[];
  allRows(): IndexedRow[];
}

export interface IndexedRow extends OpcodeRow {
  tokens: ReturnType<typeof parseOpcodeString>;
  mandatoryPrefix: number | null;
  opcodeBytes: number[];
  modrDigit: number; // -1 = /r, 0-7 = fixed digit
  hasRexW: boolean;
  isVex: boolean;
  encodingSlots: string[]; // from operand_encodings row
}

export function buildIndex(rows: OpcodeRow[], encRows: OperandEncodingRow[]): OpcodeIndex {
  // Build operand encoding lookup: { instructionId:opEn → operands[] }
  const encMap = new Map<string, string[]>();
  for (const e of encRows) {
    encMap.set(`${e.instructionId}:${e.opEn}`, e.operands);
  }

  const indexed: IndexedRow[] = [];

  for (const row of rows) {
    if (isVexOrEvex(row.opcode)) {
      // VEX/EVEX: index for reference but skip in assembler/disassembler for now
    }
    const tokens = parseOpcodeString(row.opcode);
    const mp = mandatoryPrefix(tokens);
    const ob = opcodeBytes(tokens);
    const md = modrDigit(tokens);
    const hasRexW = tokens.some(t => t.kind === 'prefix_REXW');
    const isVex = isVexOrEvex(row.opcode);
    const slots = encMap.get(`${row.instructionId}:${row.opEn}`) ?? [];

    indexed.push({
      ...row,
      tokens,
      mandatoryPrefix: mp,
      opcodeBytes: ob,
      modrDigit: md,
      hasRexW,
      isVex,
      encodingSlots: slots,
    });
  }

  // Assembler index: by uppercase mnemonic.
  // For group-mnemonic rows (Jcc, SETcc, CMOVcc, FCMOVcc), the real mnemonic lives
  // in the instruction field (e.g. "JE rel8" → key "JE"), not in instructions.mnemonic.
  const GROUP_MNEMONICS = new Set(['Jcc', 'SETcc', 'CMOVcc', 'FCMOVcc', 'LOOPcc']);
  const mnemonicMap = new Map<string, IndexedRow[]>();
  for (const row of indexed) {
    let key: string;
    if (GROUP_MNEMONICS.has(row.mnemonic) && row.instruction) {
      // Extract the first word from the instruction text as the real mnemonic
      key = row.instruction.split(/\s/)[0].toUpperCase();
    } else {
      key = row.mnemonic.toUpperCase();
    }
    let list = mnemonicMap.get(key);
    if (!list) { list = []; mnemonicMap.set(key, list); }
    list.push(row);
  }

  // Disassembler index: by (prefix, op1, op2, digit)
  // key: "PREFIX:OP1[:OP2][:DIGIT]"
  const decodeMap = new Map<string, IndexedRow[]>();
  for (const row of indexed) {
    if (row.isVex || row.opcodeBytes.length === 0) continue;
    const keys = buildDecodeKeys(row);
    for (const k of keys) {
      let list = decodeMap.get(k);
      if (!list) { list = []; decodeMap.set(k, list); }
      list.push(row);
    }
  }

  return {
    byMnemonic(mnemonic: string) {
      return mnemonicMap.get(mnemonic.toUpperCase()) ?? [];
    },
    byBytes(prefix: number | null, rexW: boolean, op1: number, op2: number | null, digit: number) {
      const keys = buildLookupKeys(prefix, op1, op2, digit);
      const seenRowId = new Set<number>(); // deduplicate individual opcode rows
      const result: IndexedRow[] = [];
      for (const k of keys) {
        const rows = decodeMap.get(k) ?? [];
        for (const r of rows) {
          if (seenRowId.has(r.id)) continue;
          if (r.hasRexW && !rexW) continue;
          if (!r.hasRexW && rexW && needsRexWFilter(r)) continue;
          seenRowId.add(r.id);
          result.push(r);
        }
      }
      // When REX.W is set, strongly prefer rows that explicitly require REX.W —
      // they are the exact encoding (64-bit forms) vs. the 16/32-bit fallbacks.
      if (rexW) {
        const rexWRows = result.filter(r => r.hasRexW);
        if (rexWRows.length > 0) return rexWRows;
      }
      return result;
    },
    allRows() { return indexed; },
  };
}

function buildDecodeKeys(row: IndexedRow): string[] {
  const p = row.mandatoryPrefix !== null ? row.mandatoryPrefix.toString(16).toUpperCase() : 'NP';
  const ob = row.opcodeBytes;
  if (ob.length === 0) return [];

  const op1 = ob[0].toString(16).toUpperCase().padStart(2, '0');
  const op2 = ob.length > 1 ? ob[1].toString(16).toUpperCase().padStart(2, '0') : null;
  const digitStr = row.modrDigit >= 0 ? `/${row.modrDigit}` : '';
  const digitWild = ''; // also index without digit for /r rows

  const keys: string[] = [];
  if (op2 !== null) {
    keys.push(`${p}:${op1}:${op2}${digitStr}`);
    if (digitStr) keys.push(`${p}:${op1}:${op2}`);
  } else {
    keys.push(`${p}:${op1}${digitStr}`);
    if (digitStr) keys.push(`${p}:${op1}`);
  }
  return keys;
}

function buildLookupKeys(prefix: number | null, op1: number, op2: number | null, digit: number): string[] {
  const p = prefix !== null ? prefix.toString(16).toUpperCase() : 'NP';
  const o1 = op1.toString(16).toUpperCase().padStart(2, '0');
  const o2 = op2 !== null ? op2.toString(16).toUpperCase().padStart(2, '0') : null;
  const d = digit >= 0 ? `/${digit}` : '';

  const keys: string[] = [];
  if (o2 !== null) {
    if (d) keys.push(`${p}:${o1}:${o2}${d}`);
    keys.push(`${p}:${o1}:${o2}`);
  } else {
    if (d) keys.push(`${p}:${o1}${d}`);
    keys.push(`${p}:${o1}`);
  }
  // Also try without mandatory prefix (some rows have NP explicitly)
  if (prefix !== null) {
    if (o2 !== null) {
      if (d) keys.push(`NP:${o1}:${o2}${d}`);
      keys.push(`NP:${o1}:${o2}`);
    } else {
      if (d) keys.push(`NP:${o1}${d}`);
      keys.push(`NP:${o1}`);
    }
  }
  return keys;
}

/** When REX.W is present but the row doesn't require REX.W, filter out rows
 *  that have a 32-bit-only counterpart — keep 64-bit-or-size-neutral rows. */
function needsRexWFilter(row: IndexedRow): boolean {
  // A row without REX.W that represents a 32-bit form when there's also a
  // REX.W + variant should be skipped when REX.W is present.
  // Simple heuristic: if mode64 is "N.E." it's not valid in 64-bit mode at all.
  if (row.mode64 === 'N.E.' || row.mode64 === 'Invalid') return true;
  return false;
}

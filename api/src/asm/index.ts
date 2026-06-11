// Public API for the assembler/disassembler engine.
// All functions are pure — they take the pre-built OpcodeIndex as a parameter.

import type { AssembleOutput, DisassembleOutput, Syntax } from './types';
import type { OpcodeIndex } from './table';
import { preprocess } from './preprocess';
import { tokenize } from './lexer';
import { parseAttasm } from './parser/attasm';
import { parseIntel } from './parser/intel';
import { assemble as assembleAST } from './encoder';
import { disassemble as disassembleBytes } from './decoder';

export type { OpcodeIndex, AssembleOutput, DisassembleOutput, Syntax };
export { buildIndex } from './table';
export type { OpcodeRow, OperandEncodingRow } from './types';

export interface AssembleOptions {
  syntax?: Syntax;
  baseAddr?: number;
}

export interface DisassembleOptions {
  syntax?: Syntax;
  baseAddr?: number;
  startOffset?: number;
  dataRegions?: Array<{ start: number; end: number }>;
}

export function assemble(
  source: string,
  index: OpcodeIndex,
  opts: AssembleOptions = {},
): AssembleOutput {
  const syntax = opts.syntax ?? 'attasm';
  const baseAddr = opts.baseAddr ?? 0;

  // Preprocess
  const ppResult = preprocess(source);
  if (ppResult.errors.length > 0) {
    return {
      ok: false,
      errors: ppResult.errors.map(e => ({ line: e.line, message: e.message, severity: 'error' as const })),
    };
  }

  // Lex
  const tokens = tokenize(ppResult.source);

  // Parse
  const parseResult = syntax === 'attasm' ? parseAttasm(tokens) : parseIntel(tokens);
  if (parseResult.errors.length > 0) {
    return { ok: false, errors: parseResult.errors };
  }

  // Encode
  const result = assembleAST(parseResult.ast, index, { baseAddr });
  return result;
}

export function disassemble(
  bytes: number[] | Uint8Array,
  index: OpcodeIndex,
  opts: DisassembleOptions = {},
): DisassembleOutput {
  const syntax = opts.syntax ?? 'attasm';
  const baseAddr = opts.baseAddr ?? 0;
  const startOffset = opts.startOffset ?? 0;
  const dataRegions = opts.dataRegions ?? [];

  return disassembleBytes(bytes, index, { syntax, baseAddr, startOffset, dataRegions });
}

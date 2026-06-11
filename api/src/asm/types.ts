export type Syntax = 'intel' | 'attasm';
export type OperandSize = 8 | 16 | 32 | 64 | 128 | 256 | 512;

export type TokenKind =
  | 'MNEMONIC' | 'REGISTER' | 'NUMBER' | 'STRING'
  | 'IDENT' | 'LABEL_DEF' | 'COMMA' | 'LBRACKET' | 'RBRACKET'
  | 'LPAREN' | 'RPAREN' | 'PLUS' | 'MINUS' | 'STAR' | 'COLON'
  | 'PERCENT' | 'DOLLAR' | 'DIRECTIVE' | 'NEWLINE' | 'EOF';

export interface Token {
  kind: TokenKind;
  text: string;
  line: number;
  col: number;
}

export type OperandNode =
  | { kind: 'reg'; reg: string }
  | { kind: 'imm'; value: bigint }
  | { kind: 'mem'; base?: string; index?: string; scale?: number; disp?: bigint; dispLabel?: string; size?: OperandSize; segment?: string }
  | { kind: 'label'; name: string }
  | { kind: 'string'; bytes: number[] };

export type StatementNode =
  | { kind: 'instr'; mnemonic: string; operands: OperandNode[]; prefixes: string[]; line: number; sizeHint?: OperandSize }
  | { kind: 'label'; name: string; line: number }
  | { kind: 'data'; directive: 'db' | 'dw' | 'dd' | 'dq'; values: Array<bigint | number[]>; line: number }
  | { kind: 'define'; name: string; value: bigint; line: number }
  | { kind: 'org'; addr: bigint; line: number }
  | { kind: 'times'; count: bigint; body: StatementNode; line: number };

export interface ProgramAST {
  syntax: Syntax;
  statements: StatementNode[];
}

export interface OpcodeRow {
  id: number;
  instructionId: number;
  mnemonic: string;
  opcode: string;
  instruction: string;
  opEn: string;
  mode64: string;
  compatLeg: string;
}

export interface OperandEncodingRow {
  instructionId: number;
  opEn: string;
  operands: string[];
}

export interface ListingLine {
  address: number;
  bytes: number[];
  source: string;
}

export interface Diagnostic {
  line?: number;
  col?: number;
  message: string;
  severity: 'error' | 'warning';
}

export interface AssembleResult {
  ok: true;
  bytes: number[];
  listing: ListingLine[];
}

export interface DisassembleResult {
  ok: true;
  listing: ListingLine[];
  text: string;
}

export interface AsmError {
  ok: false;
  errors: Diagnostic[];
}

export type AssembleOutput = AssembleResult | AsmError;
export type DisassembleOutput = DisassembleResult | AsmError;

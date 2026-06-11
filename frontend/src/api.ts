// Thin typed client over the REST API. All requests are relative to /api,
// which nginx (prod) or the Vite dev proxy forwards to the API container.

export interface InstructionSummary {
  id: number;
  mnemonic: string;
  title: string;
  volume: string | null;
  page: string | null;
  summary: string;
}

export interface OpcodeRow {
  opcode: string;
  instruction: string;
  op_en: string;
  mode_64bit: string;
  compat_leg: string;
  description: string;
}

export interface OperandEncodingRow {
  op_en: string;
  operands: string[];
}

export interface InstructionDetail {
  id: number;
  mnemonic: string;
  mnemonics: string[];
  title: string;
  volume: string | null;
  page: string | null;
  description: string | null;
  operation: string | null;
  flags_affected: string | null;
  intrinsics: string | null;
  exceptions: Record<string, string>;
  opcode_table_raw: string | null;
  operand_encoding_raw: string | null;
  opcodes: OpcodeRow[];
  operandEncodings: OperandEncodingRow[];
}

export interface SearchResponse {
  total: number;
  limit: number;
  offset: number;
  results: InstructionSummary[];
}

export interface Stats {
  totals: { instructions: string; mnemonics: string; opcode_forms: string };
  byVolume: { volume: string; count: number }[];
  byLetter: { letter: string; count: number }[];
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function searchInstructions(params: {
  q?: string;
  volume?: string;
  letter?: string;
  limit?: number;
  offset?: number;
}): Promise<SearchResponse> {
  const qs = new URLSearchParams();
  if (params.q) qs.set("q", params.q);
  if (params.volume) qs.set("volume", params.volume);
  if (params.letter) qs.set("letter", params.letter);
  if (params.limit != null) qs.set("limit", String(params.limit));
  if (params.offset != null) qs.set("offset", String(params.offset));
  return get<SearchResponse>(`/instructions?${qs.toString()}`);
}

export function getInstruction(mnemonic: string): Promise<InstructionDetail> {
  return get<InstructionDetail>(`/instructions/${encodeURIComponent(mnemonic)}`);
}

export function getStats(): Promise<Stats> {
  return get<Stats>("/stats");
}

// ---- Assembler / Disassembler ----

export interface ListingLine {
  address: number;
  bytes: string;
  source: string;
}

export interface AsmDiagnostic {
  line?: number;
  col?: number;
  message: string;
  severity: 'error' | 'warning';
}

export interface AssembleSuccess {
  ok: true;
  hex: string;
  bytes: number[];
  listing: ListingLine[];
}

export interface AsmFailure {
  ok: false;
  errors: AsmDiagnostic[];
}

export type AssembleOutput = AssembleSuccess | AsmFailure;

export interface DisassembleSuccess {
  ok: true;
  text: string;
  listing: ListingLine[];
}

export type DisassembleOutput = DisassembleSuccess | AsmFailure;

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<T>;
}

export function apiAssemble(
  source: string,
  syntax: 'attasm' | 'intel',
  baseAddr: number,
): Promise<AssembleOutput> {
  return post<AssembleOutput>('/assemble', { source, syntax, baseAddr });
}

export function apiDisassemble(
  bytes: number[],
  syntax: 'attasm' | 'intel',
  baseAddr: number,
  startOffset: number,
  dataRegions: Array<{ start: number; end: number }>,
): Promise<DisassembleOutput> {
  return post<DisassembleOutput>('/disassemble', { bytes, syntax, baseAddr, startOffset, dataRegions });
}

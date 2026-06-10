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

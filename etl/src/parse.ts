/*
 * Intel SDM Instruction Set Reference parser.
 *
 * Reads the layout-preserving text dump of the Intel 64 / IA-32 Software
 * Developer's Manual (produced with `pdftotext -layout`) and extracts the
 * per-instruction reference entries from Volume 2 (chapters "Instruction Set
 * Reference A-L / M-U / V / W-Z") into a structured JSON document that the API
 * container loads into PostgreSQL.
 *
 * The PDF layout is highly regular: every instruction entry starts at the top
 * of a page with a "MNEMONIC — Full Name" title immediately followed by an
 * "Opcode" table header. We use that signature to segment the text into
 * entries, strip the running page footers, then split each entry into its
 * named sections (Description, Operation, Flags Affected, Exceptions, ...).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = process.argv[2] ?? resolve(__dirname, "../../IntelSDM/sdm.txt");
const OUT = process.argv[3] ?? resolve(__dirname, "../data/instructions.json");

// Em-dash / en-dash used between mnemonic and name.
const DASH = "[\\u2013\\u2014]";
// Mnemonic char class allows lowercase suffixes (Jcc, SETcc, CMOVcc, LOOPcc).
const TITLE_RE = new RegExp(`^([A-Z][A-Za-z0-9 /._+-]*?)\\s*${DASH}\\s*(.+)$`);
const FOOTER_RE = /(Vol\.\s*2[A-D]\s+\d+-\d+)|(\d+-\d+\s+Vol\.\s*2[A-D])/;
const VOL_PAGE_RE = /Vol\.\s*(2[A-D])\s+(\d+-\d+)/;

// Section headings that appear on their own line inside an entry.
const EXCEPTION_HEADINGS = [
  "Protected Mode Exceptions",
  "Real-Address Mode Exceptions",
  "Virtual-8086 Mode Exceptions",
  "Compatibility Mode Exceptions",
  "64-Bit Mode Exceptions",
  "SIMD Floating-Point Exceptions",
  "Numeric Exceptions",
  "Other Exceptions",
];
const SECTION_HEADINGS = new Set<string>([
  "Description",
  "Operation",
  "Flags Affected",
  "FPU Flags Affected",
  "Intel C/C++ Compiler Intrinsic Equivalent",
  "Intel C/C++ Compiler Intrinsic Equivalents",
  ...EXCEPTION_HEADINGS,
]);

interface OpcodeRow {
  opcode: string;
  instruction: string;
  opEn: string;
  mode64: string;
  compatLeg: string;
  description: string;
}
interface OperandEncodingRow {
  opEn: string;
  operands: string[];
}
interface Instruction {
  mnemonic: string; // primary mnemonic, e.g. "ADD"
  mnemonics: string[]; // all mnemonics covered by the entry
  title: string; // full descriptive name
  volume: string; // 2A / 2B / 2C / 2D
  page: string; // e.g. "3-14"
  description: string;
  operation: string;
  flagsAffected: string;
  intrinsics: string;
  exceptions: Record<string, string>;
  opcodes: OpcodeRow[];
  operandEncodings: OperandEncodingRow[];
  opcodeTableRaw: string;
  operandEncodingRaw: string;
}

function isFooter(line: string): boolean {
  return FOOTER_RE.test(line);
}

/** First non-empty line index, scanning forward from `from`. */
function firstContent(lines: string[], from = 0): number {
  for (let i = from; i < lines.length; i++) {
    if (lines[i].trim() !== "") return i;
  }
  return -1;
}

/** A page begins an instruction entry if its first content line is a title and
 *  an "Opcode" table header appears within the next few content lines. */
function pageStartsEntry(pageLines: string[]): boolean {
  const i = firstContent(pageLines);
  if (i < 0) return false;
  const title = pageLines[i].trim();
  if (!TITLE_RE.test(title)) return false;
  if (isFooter(title)) return false;
  // Look for an "Opcode" header within the next 4 content lines.
  let seen = 0;
  for (let j = i + 1; j < pageLines.length && seen < 4; j++) {
    const t = pageLines[j].trim();
    if (t === "") continue;
    seen++;
    if (/^Opcode\b/.test(t)) return true;
  }
  return false;
}

/** Split mnemonic field like "INT n/INTO/INT3/INT1" into individual mnemonics. */
function splitMnemonics(field: string): string[] {
  return field
    .split("/")
    .map((m) => m.trim().split(/\s+/)[0]) // drop operand hints like "n"
    // Allow conditional forms such as Jcc, SETcc, CMOVcc, LOOPcc, FCMOVcc.
    .filter((m) => /^[A-Z][A-Za-z0-9]*$/.test(m));
}

// A token that begins an opcode encoding (vs. an asm form or wrapped text).
const OPCODE_START =
  /^(NP|NFx|REX|VEX|EVEX|MVEX|XOP|0F|66|F2|F3|9B|REP|MOD|[0-9A-F]{2}\b)/;

/**
 * Parse the opcode table using column positions taken from the header row.
 * Handles both the legacy layout (Opcode | Instruction | Op/En | 64-bit Mode |
 * Compat/Leg Mode | Description) and the modern stacked layout (Opcode/
 * Instruction cell | Op/En | 64/32 bit Mode | CPUID Feature Flag | Description).
 */
function parseOpcodeRows(block: string[]): OpcodeRow[] {
  const h = block.findIndex((l) => /Description/.test(l) && /\bOpcode\b/.test(l));
  if (h < 0) return [];
  const header = block[h];
  const descStart = header.indexOf("Description");
  // The middle region begins at the Op/En column if present, else at the
  // 64-bit/64-32 mode column (x87 and prefix instructions omit Op/En).
  const opMatch = /\bOp\b/.exec(header); // not "Opcode" (no \b after "Op" there)
  const modeMatch = /(64-?\s*[Bb]it|64\/32)/.exec(header);
  const hasOpEn = !!opMatch && opMatch.index < descStart;
  const midStart = hasOpEn ? opMatch!.index : modeMatch ? modeMatch.index : -1;
  if (midStart < 0 || descStart < 0 || midStart >= descStart) return [];
  const isNew = block.slice(0, h + 3).some((l) => /CPUID/.test(l));

  const rows: OpcodeRow[] = [];
  for (let i = h + 1; i < block.length; i++) {
    const line = block[i];
    if (line.trim() === "") continue;
    const leftT = line.slice(0, midStart).trim();
    const midT = line.slice(midStart, descStart).trim();
    const descT = line.slice(descStart).trim();

    if (OPCODE_START.test(leftT)) {
      // Start of a new opcode row.
      const midCols = midT.split(/\s{2,}/).filter(Boolean);
      let opcode = leftT;
      let instruction = "";
      if (!isNew) {
        const parts = leftT.split(/\s{2,}/);
        opcode = parts[0] ?? "";
        instruction = parts.slice(1).join(" ");
      }
      rows.push({
        opcode,
        instruction,
        opEn: hasOpEn ? midCols[0] ?? "" : "",
        mode64: hasOpEn ? midCols[1] ?? "" : midCols[0] ?? "",
        compatLeg: (hasOpEn ? midCols.slice(2) : midCols.slice(1)).join(" "),
        description: descT,
      });
    } else if (rows.length > 0) {
      // Continuation line: asm form (new layout), wrapped CPUID flag, or
      // wrapped description text.
      const r = rows[rows.length - 1];
      if (isNew && leftT) r.instruction = `${r.instruction} ${leftT}`.trim();
      else if (!isNew && leftT) r.opcode = `${r.opcode} ${leftT}`.trim();
      if (midT) r.compatLeg = `${r.compatLeg} ${midT}`.trim();
      if (descT) r.description = `${r.description} ${descT}`.trim();
    }
  }
  return rows;
}

function parseOperandEncodingRows(raw: string[]): OperandEncodingRow[] {
  const rows: OperandEncodingRow[] = [];
  for (const line of raw) {
    const t = line.trim();
    if (t === "" || /^Op\/En\b/.test(t) || /^Operand\s*1/i.test(t)) continue;
    const cols = t.split(/\s{2,}/);
    if (cols.length >= 2 && /^[A-Z0-9-]+$/.test(cols[0])) {
      rows.push({ opEn: cols[0], operands: cols.slice(1) });
    }
  }
  return rows;
}

function buildEntry(rawLines: string[]): Instruction | null {
  // Strip footers, form feeds, and blank-only noise; keep section structure.
  const lines = rawLines
    .map((l) => l.replace(/\f/g, ""))
    .filter((l) => !isFooter(l));

  const titleIdx = firstContent(lines);
  if (titleIdx < 0) return null;
  const titleLine = lines[titleIdx].trim();
  const tm = TITLE_RE.exec(titleLine);
  if (!tm) return null;
  const mnemonicField = tm[1].trim();
  const title = tm[2].trim();
  const mnemonics = splitMnemonics(mnemonicField);
  if (mnemonics.length === 0) return null;

  // Discover volume + page from the first footer we can find in the raw text.
  let volume = "";
  let page = "";
  for (const l of rawLines) {
    const m = VOL_PAGE_RE.exec(l);
    if (m) {
      volume = m[1];
      page = m[2];
      break;
    }
  }

  // Locate key structural headings.
  const idxOf = (pred: (s: string) => boolean, from = titleIdx + 1) => {
    for (let i = from; i < lines.length; i++) if (pred(lines[i].trim())) return i;
    return -1;
  };
  const operandEncIdx = idxOf((s) => s === "Instruction Operand Encoding");
  const descIdx = idxOf((s) => s === "Description");

  const opcodeEnd = operandEncIdx >= 0 ? operandEncIdx : descIdx >= 0 ? descIdx : lines.length;
  const opcodeBlock = lines.slice(titleIdx + 1, opcodeEnd);
  const operandBlock =
    operandEncIdx >= 0 ? lines.slice(operandEncIdx + 1, descIdx >= 0 ? descIdx : lines.length) : [];

  // Split everything from Description onward into named sections.
  const sections: Record<string, string[]> = {};
  let current = "_preamble";
  const bodyStart = descIdx >= 0 ? descIdx : opcodeEnd;
  for (let i = bodyStart; i < lines.length; i++) {
    const t = lines[i].trim();
    if (SECTION_HEADINGS.has(t)) {
      current = t;
      sections[current] = [];
      continue;
    }
    (sections[current] ??= []).push(lines[i]);
  }
  const clean = (arr?: string[]) =>
    (arr ?? [])
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

  const exceptions: Record<string, string> = {};
  for (const h of EXCEPTION_HEADINGS) {
    if (sections[h]) exceptions[h] = clean(sections[h]);
  }

  const opcodes = parseOpcodeRows(opcodeBlock);

  // Many entries fold several assembly mnemonics into one page (e.g. the VEX/
  // EVEX "VADDPS" forms live under "ADDPS"). Harvest the leading mnemonic of
  // every opcode row so those forms are independently searchable/resolvable.
  const allMnemonics = new Set(mnemonics);
  for (const o of opcodes) {
    const tok = o.instruction.trim().split(/[\s,]+/)[0];
    if (/^[A-Z][A-Za-z0-9]*$/.test(tok)) allMnemonics.add(tok);
  }

  return {
    mnemonic: mnemonics[0],
    mnemonics: [...allMnemonics],
    title,
    volume,
    page,
    description: clean(sections["Description"]),
    operation: clean(sections["Operation"]),
    flagsAffected: clean(sections["Flags Affected"]) || clean(sections["FPU Flags Affected"]),
    intrinsics:
      clean(sections["Intel C/C++ Compiler Intrinsic Equivalent"]) ||
      clean(sections["Intel C/C++ Compiler Intrinsic Equivalents"]),
    exceptions,
    opcodes,
    operandEncodings: parseOperandEncodingRows(operandBlock),
    opcodeTableRaw: opcodeBlock.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    operandEncodingRaw: operandBlock.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
  };
}

function main() {
  const text = readFileSync(SRC, "utf8");
  const allLines = text.split("\n");

  // Restrict to the Volume 2 instruction-reference chapters (body, not TOC).
  const chapterStart = allLines.findIndex((l) => /^3\.3\s+INSTRUCTIONS \(A-L\)\s*$/.test(l));
  // End: just before Volume 3 begins (its appendices/contents after W-Z).
  let chapterEnd = allLines.length;
  for (let i = chapterStart + 1; i < allLines.length; i++) {
    if (/Volume 3 \(3A, 3B, 3C, & 3D\)/.test(allLines[i])) {
      chapterEnd = i;
      break;
    }
  }
  if (chapterStart < 0) throw new Error("Could not locate instruction reference chapter start.");
  const region = allLines.slice(chapterStart, chapterEnd);

  // Split into pages on the form-feed character.
  const pages = region.join("\n").split("\f");

  // Group consecutive pages into instruction entries.
  const entries: string[][] = [];
  let current: string[] | null = null;
  for (const page of pages) {
    const pageLines = page.split("\n");
    if (pageStartsEntry(pageLines)) {
      if (current) entries.push(current);
      current = [...pageLines];
    } else if (current) {
      current.push("\f", ...pageLines);
    }
  }
  if (current) entries.push(current);

  const instructions: Instruction[] = [];
  for (const raw of entries) {
    const entry = buildEntry(raw);
    if (entry) instructions.push(entry);
  }

  // Deduplicate by mnemonic+page (some entries split across volume seams).
  writeFileSync(OUT, JSON.stringify(instructions, null, 2), "utf8");
  console.log(`Parsed ${instructions.length} instruction entries -> ${OUT}`);
  const withOps = instructions.filter((i) => i.operation).length;
  const withDesc = instructions.filter((i) => i.description).length;
  const withOpcodes = instructions.filter((i) => i.opcodes.length > 0).length;
  console.log(
    `  description: ${withDesc}  operation: ${withOps}  opcode-rows: ${withOpcodes}  ` +
      `total-mnemonics: ${new Set(instructions.flatMap((i) => i.mnemonics)).size}`,
  );
}

main();

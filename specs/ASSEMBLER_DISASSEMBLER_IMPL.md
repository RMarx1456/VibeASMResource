# Implementation Spec — Web Assembler / Disassembler

> Companion to [`ASSEMBLER_DISASSEMBLER.md`](./ASSEMBLER_DISASSEMBLER.md) and
> [`TESTING.md`](./TESTING.md).
> That document is the **what and why**; this document is the **how** —
> file layout, TypeScript types, API contracts, UI component breakdown, and
> per-milestone task lists a developer can check off.
>
> ⚠️ When something looks wrong or isn't covered here, follow the escalation
> protocol in `ASSEMBLER_DISASSEMBLER.md §11` before inventing an answer.

---

## 1. Repository layout

Add the following alongside the existing `api/`, `frontend/`, `etl/`, and `db/`
packages. Nothing existing is deleted or moved.

```
asm/                          ← new pure-TS engine package (no DOM, no Express)
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              ← public re-exports (assemble, disassemble, AsmError)
│   ├── types.ts              ← shared AST + token types (see §3)
│   ├── lexer.ts              ← tokeniser (Intel + AT&T share one lexer)
│   ├── parser/
│   │   ├── intel.ts          ← Intel-syntax parser → AST
│   │   └── attasm.ts         ← AT&T-syntax parser → AST
│   ├── preprocess.ts         ← macro / %define / org / %if expansion
│   ├── operands.ts           ← operand-type model + matching helpers
│   ├── encoder.ts            ← AST → bytes (2-pass, label resolution)
│   ├── decoder.ts            ← bytes → AST (linear sweep)
│   ├── printer/
│   │   ├── intel.ts          ← AST → Intel text
│   │   └── attasm.ts         ← AST → AT&T text
│   └── table.ts              ← loads + indexes opcode rows from the dataset
└── tests/                    ← unit tests for the engine in isolation
    ├── lexer.test.ts
    ├── encoder.test.ts
    ├── decoder.test.ts
    └── roundtrip.test.ts

api/src/routes/
└── asm.ts                    ← new: POST /api/assemble + POST /api/disassemble

frontend/src/
├── pages/
│   └── AsmPage.tsx           ← new: assembler/disassembler page
└── components/asm/
    ├── AssembleTab.tsx
    ├── DisassembleTab.tsx
    ├── ListingPanel.tsx
    ├── ErrorList.tsx
    └── SyntaxToggle.tsx

tests/                        ← existing test root (per TESTING.md)
├── unit/
│   ├── asm-structural.test.ts   ← new: encoding token grammar invariants
│   ├── asm-encoding.test.ts     ← new: assemble() vs gas golden corpus
│   ├── asm-decoding.test.ts     ← new: disassemble() vs objdump golden corpus
│   └── asm-roundtrip.test.ts    ← new: A∘D / D∘A properties
└── fixtures/
    ├── asm-golden.json          ← new: ~75-instruction golden corpus
    └── asm-roundtrip-blobs/     ← new: hand-assembled binaries for D∘A tests
```

---

## 2. Engine package — `asm/package.json`

```jsonc
{
  "name": "@asmresource/asm",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test":  "vitest run",
    "dev":   "vitest"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vitest":     "^1.6.0"
  }
}
```

The API imports the engine as a local workspace package:

```jsonc
// api/package.json — add to dependencies
"@asmresource/asm": "file:../asm"
```

---

## 3. TypeScript types (`asm/src/types.ts`)

These are the canonical shapes the entire engine is typed against. Expand as
needed; do not remove fields once published.

### 3.1 Token

```ts
export type TokenKind =
  | "MNEMONIC" | "REGISTER" | "NUMBER" | "STRING"
  | "IDENT"    | "LABEL"    | "COMMA"  | "LBRACKET" | "RBRACKET"
  | "PLUS"     | "MINUS"    | "STAR"   | "COLON"
  | "DIRECTIVE" | "NEWLINE" | "EOF";

export interface Token {
  kind:   TokenKind;
  text:   string;
  line:   number;   // 1-based
  col:    number;   // 1-based
}
```

### 3.2 AST nodes

```ts
export type Syntax = "intel" | "attasm";

export type OperandNode =
  | { kind: "reg";    reg: string }
  | { kind: "imm";    value: bigint }
  | { kind: "mem";    base?: string; index?: string; scale?: number;
                      disp?: bigint; size?: OperandSize; segment?: string }
  | { kind: "label";  name: string }
  | { kind: "string"; bytes: Uint8Array };

export type OperandSize = 8 | 16 | 32 | 64 | 128 | 256 | 512;

export type StatementNode =
  | { kind: "instr";   mnemonic: string; operands: OperandNode[];
      prefixes: string[]; line: number }
  | { kind: "label";   name: string; line: number }
  | { kind: "data";    directive: "db"|"dw"|"dd"|"dq";
      values: (bigint | Uint8Array)[]; line: number }
  | { kind: "define";  name: string; value: bigint; line: number }
  | { kind: "org";     addr: bigint; line: number }
  | { kind: "times";   count: bigint; body: StatementNode; line: number }
  | { kind: "macro_expand"; name: string; args: StatementNode[][]; line: number };

export interface ProgramAST {
  syntax:     Syntax;
  statements: StatementNode[];
}
```

### 3.3 Opcode table row (mirrors the DB `opcodes` columns)

```ts
export interface OpcodeRow {
  instructionId: number;
  mnemonic:      string;
  opcode:        string;   // e.g. "REX.W + 81 /4 id"
  instruction:   string;   // e.g. "ADD r/m64, imm32"
  opEn:          string;   // e.g. "MI"
  mode64:        string;
  compatLeg:     string;
}

export interface OperandEncodingRow {
  instructionId: number;
  opEn:          string;
  operands:      string[]; // up to 4 slots, "N/A" for unused
}
```

### 3.4 Engine results

```ts
export interface ListingLine {
  address: number;
  bytes:   Uint8Array;
  source:  string;   // original or reconstructed source text
}

export interface AssembleResult {
  ok:       true;
  bytes:    Uint8Array;
  listing:  ListingLine[];
}

export interface DisassembleResult {
  ok:       true;
  listing:  ListingLine[];
  text:     string;   // full printable listing
}

export interface AsmError {
  ok:      false;
  errors:  Diagnostic[];
}

export interface Diagnostic {
  line?:    number;
  col?:     number;
  message:  string;
  severity: "error" | "warning";
}

export type AssembleOutput    = AssembleResult | AsmError;
export type DisassembleOutput = DisassembleResult | AsmError;
```

---

## 4. Engine public API (`asm/src/index.ts`)

```ts
import type { AssembleOutput, DisassembleOutput, Syntax } from "./types.js";

export interface AssembleOptions {
  syntax:   Syntax;     // "attasm" | "intel"
  baseAddr: number;     // default 0
}

export interface DisassembleOptions {
  syntax:      Syntax;
  baseAddr:    number;  // default 0
  startOffset: number;  // default 0
  dataRegions: Array<{ start: number; end: number }>; // user-marked data
}

/** Assemble source text → bytes + listing. */
export function assemble(
  source: string,
  opts?: Partial<AssembleOptions>,
): AssembleOutput;

/** Disassemble raw bytes → listing text. */
export function disassemble(
  bytes: Uint8Array,
  opts?: Partial<DisassembleOptions>,
): DisassembleOutput;
```

---

## 5. API endpoints

Both endpoints live in `api/src/routes/asm.ts` and are mounted at `/api` in
`api/src/index.ts`.

### `POST /api/assemble`

**Request body** (`Content-Type: application/json`):

```jsonc
{
  "source":   "movq $1, %rax\nret\n",   // required; max 64 KiB
  "syntax":   "attasm",                  // "attasm" | "intel"; default "attasm"
  "baseAddr": 0                          // optional; default 0
}
```

**Success response** (`200`):

```jsonc
{
  "ok":      true,
  "hex":     "48c7c001000000c3",          // hex string of output bytes
  "bytes":   [72, 199, 192, 1, 0, 0, 0, 195],  // number[]
  "listing": [
    { "address": 0, "bytes": "48c7c001000000", "source": "movq $1, %rax" },
    { "address": 7, "bytes": "c3",             "source": "ret" }
  ]
}
```

**Error response** (`422`):

```jsonc
{
  "ok":     false,
  "errors": [
    { "line": 1, "col": 6, "message": "unknown register '%rxa'", "severity": "error" }
  ]
}
```

**Validation** (`400`): missing `source`, source > 64 KiB, unknown `syntax`
value.

---

### `POST /api/disassemble`

**Request body**:

```jsonc
{
  "hex":         "48c7c001000000c3",  // hex string OR
  "bytes":       [72, 199, 192, 1, 0, 0, 0, 195],  // raw byte array
  // exactly one of hex/bytes required; max 4 MiB decoded
  "syntax":      "attasm",
  "baseAddr":    0,
  "startOffset": 0,
  "dataRegions": []   // [{ "start": N, "end": M }, ...]
}
```

**Success response** (`200`):

```jsonc
{
  "ok":   true,
  "text": "0000000000000000 <.text>:\n   0:\t48 c7 c0 01 00 00 00 \tmovq   $0x1,%rax\n   7:\tc3                  \tret\n",
  "listing": [
    { "address": 0, "bytes": "48c7c001000000", "source": "movq   $0x1,%rax" },
    { "address": 7, "bytes": "c3",             "source": "ret" }
  ]
}
```

**Error response** (`422`): same `{ ok, errors }` shape as assemble.

---

## 6. Encoder pipeline — module contracts

Each module exports a single pure function (no side-effects, no global state).

| Module | Signature | Notes |
|---|---|---|
| `lexer.ts` | `tokenize(src: string): Token[]` | One pass; yields `NEWLINE` + `EOF`. Line/col tracked. |
| `preprocess.ts` | `preprocess(tokens: Token[], syntax: Syntax): Token[]` | Expands `%define`/`equ`, `times`, `%macro`, `%if`/`%ifdef`. Returns flat token list with line info preserved. |
| `parser/intel.ts` | `parseIntel(tokens: Token[]): ProgramAST` | Throws `AsmError` on parse failure. |
| `parser/attasm.ts` | `parseAttasm(tokens: Token[]): ProgramAST` | Same contract. |
| `encoder.ts` | `encode(ast: ProgramAST, table: OpcodeIndex, opts: AssembleOptions): AssembleResult` | 2-pass: Pass 1 sizes, Pass 2 encodes. Throws `AsmError`. |
| `decoder.ts` | `decode(bytes: Uint8Array, table: OpcodeIndex, opts: DisassembleOptions): DisassembleResult` | Linear sweep. Never throws; undecodable bytes emit `db` lines. |
| `printer/intel.ts` | `printIntel(listing: ListingLine[]): string` | |
| `printer/attasm.ts` | `printAttasm(listing: ListingLine[]): string` | |
| `table.ts` | `buildIndex(rows: OpcodeRow[], encRows: OperandEncodingRow[]): OpcodeIndex` | Called once at API startup. `OpcodeIndex` is an opaque type. |

---

## 7. Opcode index — `table.ts`

`OpcodeIndex` must support two lookup directions:

```ts
export interface OpcodeIndex {
  // Assembler: find candidate rows for a mnemonic
  byMnemonic(mnemonic: string): OpcodeRow[];

  // Disassembler: find row by leading opcode bytes
  // Returns the longest-prefix match (greedy), or undefined
  byBytes(buf: Uint8Array, offset: number): { row: OpcodeRow; length: number } | undefined;
}
```

The index is built from the `opcodes` + `operand_encodings` DB tables on API
startup and held in memory. The engine itself is DB-free (pure functions over
the index).

---

## 8. Operand matching — `operands.ts`

The encoder calls `matchEncoding` to pick the best `OpcodeRow` for a parsed
instruction:

```ts
export type OperandType =
  | "r8" | "r16" | "r32" | "r64"
  | "m8" | "m16" | "m32" | "m64" | "m128" | "m256" | "m512"
  | "imm8" | "imm16" | "imm32" | "imm64"
  | "rel8" | "rel32"
  | "xmm" | "ymm" | "zmm"
  | "moffs64"
  | "implicit";   // e.g. AL, AX, EAX in fixed-operand forms

/** Classify a parsed OperandNode given context (syntax, surrounding operands). */
export function classifyOperand(
  node:    OperandNode,
  syntax:  Syntax,
  context: OperandNode[],
): OperandType | Diagnostic;   // Diagnostic when ambiguous and no size keyword

/** Find the unique best-matching OpcodeRow, or a Diagnostic if ambiguous / not found. */
export function matchEncoding(
  mnemonic: string,
  operands: OperandNode[],
  syntax:   Syntax,
  index:    OpcodeIndex,
): OpcodeRow | Diagnostic;
```

Ambiguity rules per `ASSEMBLER_DISASSEMBLER.md §9`:
- **Intel**: require explicit `byte/word/dword/qword ptr` for memory operands
  whose size isn't fixed by a register partner → error if absent.
- **AT&T**: infer from register partner when present; require `b/w/l/q` suffix
  only when all operands are size-ambiguous → error if absent.

---

## 9. Encoding token interpreter — `encoder.ts`

The encoder must parse the `OpcodeRow.opcode` string into byte-emission steps.
Supported grammar tokens (see `ASSEMBLER_DISASSEMBLER.md §3`):

| Token pattern | Meaning |
|---|---|
| `NP` | No mandatory prefix |
| `66` | Operand-size prefix byte `0x66` |
| `F2` / `F3` | SIMD prefix bytes |
| `REX` / `REX.W` / `REX.R` / `REX.B` | REX prefix (W=bit 3, R=bit 2, B=bit 0) |
| `VEX.128` / `VEX.256` / `VEX.LIG` etc. | VEX prefix family |
| `EVEX.128` / `EVEX.512` etc. | EVEX prefix family |
| `/r` | ModRM byte; both `reg` and `r/m` from operands |
| `/0` .. `/7` | ModRM with fixed `reg` field (opcode extension) |
| `+rb` / `+rw` / `+rd` / `+ro` | Register encoded in low 3 bits of last opcode byte |
| `ib` / `iw` / `id` / `io` | Immediate: 1/2/4/8 bytes |
| `cb` / `cd` | Relative offset: 1/4 bytes |
| Two hex digits `[0-9A-F]{2}` | Literal opcode byte |

> ⚠️ Tokens with footnote superscripts (e.g., `r/m81` for `r/m8`¹) must be
> normalized before matching — see `TESTING.md §4` and `ASSEMBLER_DISASSEMBLER.md §3`.

---

## 10. Frontend — `AsmPage.tsx`

### Routes

Add to the React Router config:

```
/asm    →   AsmPage
```

Add a nav link "Assembler / Disassembler" alongside the existing instruction
search link.

### Component tree

```
AsmPage
├── SyntaxToggle          (Intel | AT&T, default AT&T, shared state)
├── Tab bar               ("Assemble" | "Disassemble")
├── AssembleTab  [active when tab = "Assemble"]
│   ├── <textarea> / CodeMirror editor (monospace, line numbers)
│   ├── BaseAddrInput     (hex, default "0x0000000000000000")
│   ├── Button "Assemble"
│   ├── ListingPanel      (address · hex bytes · source — only on success)
│   ├── HexDump           (raw hex string — only on success)
│   ├── Button "Download .bin"  (only on success)
│   └── ErrorList         (line/col, message — only on error)
└── DisassembleTab  [active when tab = "Disassemble"]
    ├── FileUpload        (accept "*", max 4 MiB)
    ├── <textarea> hex/paste input (alternative to upload)
    ├── BaseAddrInput
    ├── StartOffsetInput  (hex, default "0x0")
    ├── DataRegionEditor  (add/remove [start, end] ranges)
    ├── Button "Disassemble"
    ├── ListingPanel      (only on success)
    ├── Button "Copy text"
    ├── Button "Download listing.txt"
    └── ErrorList         (only on error)
```

### State shape (per page, React `useState` / `useReducer`)

```ts
interface AsmPageState {
  syntax:   "attasm" | "intel";
  activeTab: "assemble" | "disassemble";
}

interface AssembleTabState {
  source:    string;
  baseAddr:  string;
  result:    AssembleResult | AsmError | null;
  loading:   boolean;
}

interface DisassembleTabState {
  hexInput:    string;
  fileBytes:   Uint8Array | null;
  baseAddr:    string;
  startOffset: string;
  dataRegions: Array<{ start: string; end: string }>;
  result:      DisassembleResult | AsmError | null;
  loading:     boolean;
}
```

### API calls (`frontend/src/api.ts` — add alongside existing helpers)

```ts
export async function apiAssemble(
  source: string, syntax: string, baseAddr: number
): Promise<AssembleOutput>;

export async function apiDisassemble(
  bytes: number[], syntax: string, baseAddr: number,
  startOffset: number, dataRegions: Array<{start:number;end:number}>
): Promise<DisassembleOutput>;
```

---

## 11. `docker-compose.yml` — no changes required

The `asm/` engine is consumed by the `api` container via the local workspace
dependency. No new service is needed. The `api` container's `Dockerfile` must
run `npm install` from the workspace root so `@asmresource/asm` is resolved.

If the current `api/Dockerfile` only installs `api/package.json`, update it to:

```dockerfile
WORKDIR /app
COPY asm/    ./asm/
COPY api/    ./api/
WORKDIR /app/api
RUN npm install
```

---

## 12. Database — no schema changes

The assembler/disassembler reads the existing `opcodes` and `operand_encodings`
tables at runtime. No migrations are needed. The `table.ts` module queries:

```sql
SELECT o.instruction_id,
       i.mnemonic,
       o.opcode, o.instruction, o.op_en, o.mode_64bit, o.compat_leg
  FROM opcodes o
  JOIN instructions i ON i.id = o.instruction_id;

SELECT instruction_id, op_en, operands
  FROM operand_encodings;
```

Both queries run once at startup; results are held in the `OpcodeIndex` instance
passed to every engine call.

---

## 13. Testing — implementation checklist (mirrors `TESTING.md §3` + §8 of the spec)

### Golden corpus format (`tests/fixtures/asm-golden.json`)

```jsonc
[
  {
    "id":       "ADD_r64_imm32",
    "mnemonic": "ADD",
    "intel":    "add qword ptr [rax], 1",
    "attasm":   "addq $1, (%rax)",
    "bytes":    "4883000001",
    "flags":    ["OF","SF","ZF","AF","CF","PF"],
    "mode64":   "Valid"
  },
  ...
]
```

Each entry must have at least `bytes` + one of `intel`/`attasm`. Both syntax
variants are required for the cross-syntax equivalence test (§8 of spec).

### Test matrix

| File | Covers | Oracle |
|---|---|---|
| `asm/tests/lexer.test.ts` | Token output for representative fragments | None |
| `asm/tests/encoder.test.ts` | `assemble(src)` → `bytes` for golden corpus | `asm-golden.json` |
| `asm/tests/decoder.test.ts` | `disassemble(bytes)` → normalized text | `asm-golden.json` |
| `asm/tests/roundtrip.test.ts` | `D(A(src))` ≈ `src`; `A(D(bytes)) == bytes` | Golden blobs |
| `tests/unit/asm-structural.test.ts` | Opcode token grammar for all dataset rows | None |
| `tests/unit/asm-encoding.test.ts` | Subset assemble vs gas differential | Gas fixtures |
| `tests/unit/asm-decoding.test.ts` | Subset disassemble vs objdump differential | objdump fixtures |
| `tests/unit/asm-roundtrip.test.ts` | Full round-trip over golden corpus | Both |

### Negative / error-path cases (required, not optional)

- Unknown mnemonic → `error` with line/col
- Unresolved label → `error`
- Intel memory operand with no size keyword → `error`
- AT&T ambiguous suffix (no register, no suffix) → `error`
- Immediate out of range for target operand size → `error`
- Malformed hex input to disassemble → `error` (not crash)
- Empty source → empty listing (not error)

---

## 14. Milestone task list

### Milestone 1 — Engine skeleton + AT&T assembler
- [ ] `asm/` package scaffold (`package.json`, `tsconfig.json`)
- [ ] `types.ts` — all types from §3
- [ ] `lexer.ts` — tokenize (Intel/AT&T share one lexer)
- [ ] `preprocess.ts` — `%define`, `equ`, `times`, `org`; skip macros and `%if`
- [ ] `parser/attasm.ts` — AT&T parser → `ProgramAST`
- [ ] `table.ts` — `buildIndex`, `byMnemonic`, `byBytes`
- [ ] `operands.ts` — `classifyOperand`, `matchEncoding` for AT&T
- [ ] `encoder.ts` — 2-pass encode for MVP integer subset (§6 of spec)
- [ ] `asm/tests/encoder.test.ts` — golden corpus AT&T direction
- [ ] `api/src/routes/asm.ts` — `POST /api/assemble` wired up
- [ ] `docker-compose` / Dockerfile updated for workspace dep (§11)

### Milestone 2 — Disassembler
- [ ] `decoder.ts` — linear sweep + label synthesis + `db` fallback
- [ ] `printer/attasm.ts`
- [ ] `asm/tests/decoder.test.ts` — golden corpus disassemble direction
- [ ] `asm/tests/roundtrip.test.ts` — `A∘D` / `D∘A` properties
- [ ] `api/src/routes/asm.ts` — `POST /api/disassemble` wired up
- [ ] `tests/unit/asm-roundtrip.test.ts` — full round-trip suite

### Milestone 3 — Intel syntax + cross-syntax tests
- [ ] `parser/intel.ts` — Intel parser → `ProgramAST`
- [ ] `printer/intel.ts`
- [ ] `operands.ts` — explicit-size enforcement for Intel (§9.2 of spec)
- [ ] `asm/tests/encoder.test.ts` — Intel direction in golden corpus
- [ ] Cross-syntax equivalence: `assemble(intel)` bytes == `assemble(attasm)` bytes
- [ ] `tests/unit/asm-structural.test.ts` — opcode token grammar over full dataset

### Milestone 4 — Preprocessor + diagnostics
- [ ] `preprocess.ts` — `%macro`/`.macro`, `%if`/`%ifdef`/`%else`/`%endif`
- [ ] Constant-expression evaluator (`+ - * / << >> & | ^`, parens)
- [ ] Full negative / error-path test coverage (§13 of this doc)
- [ ] `tests/unit/asm-encoding.test.ts` — gas differential fixtures

### Milestone 5 — Web UI
- [ ] `frontend/src/pages/AsmPage.tsx` + router registration
- [ ] `AssembleTab.tsx` — editor, base addr, assemble button, listing, download
- [ ] `DisassembleTab.tsx` — upload/paste, base addr, offset, data regions
- [ ] `ListingPanel.tsx` — address · bytes · source
- [ ] `ErrorList.tsx` — line/col + message
- [ ] `SyntaxToggle.tsx` — Intel ⇄ AT&T, default AT&T
- [ ] `frontend/src/api.ts` — `apiAssemble`, `apiDisassemble`
- [ ] Manual smoke test: assemble `movq $1, %rax\nret`, download binary

### Milestone 6 — Differential CI
- [ ] `tests/unit/asm-decoding.test.ts` — objdump differential fixtures
- [ ] CI job (GitHub Actions step): install `binutils`, run differential tests
- [ ] Document how to regenerate gas/objdump fixtures locally

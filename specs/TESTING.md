# Testing Plan

> Status: **plan / design** — describes the intended test strategy before
> implementation. Companion to [`SPECIFICATION.md`](./SPECIFICATION.md).

## 1. Philosophy

The application is topologically simple (DB → API → SPA), so **end-to-end
testing is intentionally minimal**. The real risk is not in the plumbing but in
the data: our PostgreSQL contents are *parsed* out of a 5,342-page PDF, so the
thing that can silently be wrong is **informational correctness** — did we
extract the right opcode, the right operand encoding, the right faults?

Therefore the test suite is centered on validating the extracted dataset
(`etl/data/instructions.json`, and by extension the seeded DB) as if it were
the **specification table that an assembler / disassembler is built from**.

### The isomorphism we are testing

A correct assembler is a function

```
A : (mnemonic, operands)  →  (encoding bytes, constraints)
```

and a correct disassembler `D` is its inverse over the set of valid encodings.
Both are implemented on top of an instruction table. **Our dataset is that
table.** A test is "correct" when, interpreting our rows as that table, the
`mnemonic ↔ opcode ↔ operands ↔ faults ↔ flags` relationships match those a
reference assembler/disassembler exhibits.

We deliberately go **beyond the usual assembler-test scope** (which checks only
mnemonic → bytes). Because the SDM gives us far richer semantics, we also
assert on:

- **operand count** and operand roles (read/write, reg/mem/imm),
- **mode validity** (64-bit / compat / legacy: Valid / Invalid / N.E.),
- **faults / exceptions** per processor mode (#UD, #GP, #PF, …),
- **flags affected** (OF/SF/ZF/AF/CF/PF, and FPU/SIMD status),
- **CPUID feature flags** for VEX/EVEX forms.

## 2. Reference oracles

External, machine-readable references to diff against.

> **Decision — separate the *method* from the *tool*.** We **adopt NASM's
> Travis-CI testing *style*** (a checked-in golden corpus diffed by an assembler
> acting as the differential oracle), but we **do not use NASM's assembler as an
> encoding authority** — its encoder is shoddy and outdated (the project owner
> has hit and fixed its encoding bugs first-hand). **GNU `as` (gas) sits in the
> oracle seat instead.**

| Oracle | Role | What we use it for | Form |
| --- | --- | --- | --- |
| **GNU `as` / binutils** | **Primary** | Authoritative encoding & disassembly. | `as` assembles fixtures → compare bytes; `objdump -d` for the decode direction. |
| **LLVM X86** | Secondary sanity check | Cross-check encodings and mnemonic ↔ operand-type mappings (`X86Instr*.td`); live `llvm-mc -show-encoding` / `llvm-objdump`. | Shell out and compare where it adds coverage (esp. VEX/EVEX). |
| **NASM** | *Excluded as authority* | At most: borrow the *structure* of its `x86/insns.dat` table as a starting cross-reference, but mismatches are **advisory, never gating**. | Optional, non-blocking. |

We still adopt NASM's *CI shape* (a curated golden corpus + an assembler acting
as the differential oracle) — just with `as` in the oracle seat.

**Coverage model.** We do not hand-verify all ~1,500 mnemonics. Instead:

1. **Property/invariant tests** run over the **entire** dataset (cheap, total).
2. **Oracle cross-checks** run over the **intersection** of our dataset with the
   reference (gas/LLVM) coverage (large, automated coverage of encodings/operands).
3. **Golden fixtures** pin a curated **representative ~75-instruction** set
   (hand-verified against the SDM) to catch regressions on the cases we care
   most about.

## 3. Test categories

### 3.1 Structural / invariant tests (whole dataset, no oracle)
Pure properties every row must satisfy. Examples:

- Every `opcodes.op_en` value resolves to a row in `operand_encodings` for the
  same instruction (referential integrity of the Op/En key).
- Every `mode_64bit` / `compat_leg` value is in the allowed vocabulary
  (`Valid`, `Invalid`, `N.E.`, `N/A`, `V`, `I`, `V/V`, `V/I`, …).
- Opcode strings are well-formed: tokens match a grammar of hex bytes,
  prefixes (`NP`,`66`,`F2`,`F3`,`REX*`), VEX/EVEX specifiers, and `/r`,`/digit`,
  `ib/iw/id/io`, `+r` suffixes.
- `mnemonic` is non-empty and upper-case-initial; `title` non-empty.
- Description / Operation present for the overwhelming majority (allow a small
  documented allow-list of genuinely table-only entries).
- No duplicate primary `(mnemonic, page)`.

### 3.2 Operand semantics (assembler-isomorphic, structural)
The number and kind of operands implied by the assembly form must agree with
the operand-encoding table:

- `operandCount(instruction_form)` (count comma-separated operands, ignoring
  `{k}{z}`, `{er}`, `{sae}` decorations) **==** number of non-`N/A` operand
  slots in the matching `operand_encodings` row.
- Operand role consistency: an operand encoded as `ModRM:reg (w)` is a write
  destination, etc. (spot-checked against a golden set).

Example — `ADDPS xmm1, xmm2/m128` ⇒ 2 operands ⇒ Op/En `A` has exactly two
non-N/A operand slots.

### 3.3 Encoding correctness — assembler direction (oracle)
For the NASM-intersection set: given `(mnemonic, operand form)`, our recorded
opcode must match NASM's encoding for the same form.

Example expectations:
- `ADD AL, imm8` → `04 ib`
- `MOV r/m64, r64` → `REX.W + 89 /r`
- `VADDPS ymm, ymm, ymm/m256` → `VEX.256.0F.WIG 58 /r`

(Normalization layer maps between SDM and NASM notation — see §4.)

### 3.4 Decoding correctness — disassembler direction (oracle)
The inverse: a byte/opcode pattern decodes to the expected mnemonic+operands.
Validated either by parsing NASM/LLVM tables, or live via `ndisasm` /
`llvm-objdump` on hand-assembled bytes for the golden set.

### 3.5 Faults / exceptions
- Instructions invalid in 64-bit mode (`AAA`, `AAD`, `BOUND`, …) have
  `mode_64bit = Invalid` **and** a "64-Bit Mode Exceptions" entry mentioning
  `#UD`.
- Instructions documenting a LOCK-prefix `#UD` are flagged consistently.
- Every entry exposes the exception-mode keys appropriate to its modes
  (Protected / Real-Address / Virtual-8086 / Compatibility / 64-Bit), and SIMD
  instructions carry "SIMD Floating-Point Exceptions" where the SDM does.
- Golden set asserts specific fault vectors for representative instructions.

### 3.6 Flags affected (golden)
Curated expectations, e.g.:
- `ADD` → OF, SF, ZF, AF, CF, PF all modified.
- `MOV` → no flags affected.
- `CMP`/`TEST` → arithmetic/logical flag sets.
- `BT`/`BTS` → CF set, others undefined.

### 3.7 API contract tests (thin)
Using `supertest` against the Express app with a seeded test DB:
- `GET /api/instructions?q=vaddps` resolves to the `ADDPS` entry.
- `GET /api/instructions/:mnemonic` resolves by any documented mnemonic,
  case-insensitively; returns 404 for unknown.
- `GET /api/stats` totals equal the dataset counts.

### 3.8 End-to-end (minimal, low priority)
One or two Playwright happy-path flows only:
- Load home → search "ADD" → open detail → encoding table + operation render.

## 4. Notation normalization

SDM, NASM, and LLVM spell things differently; correctness comparisons run
through a small normalization layer so they are compared as **equivalence
classes**, not raw strings:

- Operand sizes: SDM `r/m32` ≈ NASM `rm32`; `imm8` ≈ `ib` operand.
- Encoding suffixes: SDM `/r`, `/0`, `ib` ↔ NASM byte-code tokens.
- Strip EVEX decorations (`{k1}{z}`, `{er}`, `{sae}`, `{1to16}`) when comparing
  operand counts; test them separately.
- Known PDF extraction artifacts (e.g. footnote superscripts producing `r/m81`
  for `r/m8`¹) are normalized/stripped before comparison, and a dedicated test
  asserts the *raw* table text is preserved verbatim.

## 5. Tooling & layout

- **Runner:** Vitest (TypeScript-native, fast watch mode). *(open choice —
  could use the built-in `node:test`.)*
- Tests validate `etl/data/instructions.json` directly for the data-correctness
  suites (no DB needed → fast, deterministic); API suite spins up Postgres
  (Testcontainers or the compose `db`) and seeds it.
- Oracle fixtures (`insns.dat` excerpt, golden JSON) are checked into the repo
  so CI is hermetic; live `nasm`/`llvm-mc` cross-checks run as an *optional*,
  separately-gated job when those binaries are present.

```
tests/
├── fixtures/
│   ├── golden-instructions.json   # ~75 hand-verified entries (flags, faults, operands)
│   ├── nasm-insns.subset.dat      # vendored NASM table excerpt (oracle)
│   └── normalization.ts           # SDM↔NASM↔LLVM equivalence helpers
├── unit/
│   ├── structural.test.ts         # §3.1 invariants over the whole dataset
│   ├── operands.test.ts           # §3.2 operand-count / role isomorphism
│   ├── encoding.test.ts           # §3.3 assembler-direction vs NASM
│   ├── decoding.test.ts           # §3.4 disassembler-direction vs NASM/LLVM
│   ├── faults.test.ts             # §3.5 exceptions / mode validity
│   └── flags.test.ts              # §3.6 flags affected (golden)
├── api/
│   └── instructions.test.ts       # §3.7 supertest contract tests
└── e2e/
    └── happy-path.spec.ts         # §3.8 single Playwright flow
```

## 6. CI

Modeled on NASM's golden-diff CI:
1. `lint + typecheck`
2. `parse` the dataset (or use the committed JSON) → run **unit** suites
   (structural, operand, encoding, decoding, faults, flags) — these are the
   gate.
3. `api` suite against an ephemeral Postgres.
4. `e2e` smoke (non-blocking / nightly).
5. *Optional* differential job: install `nasm` + `llvm`, regenerate the oracle
   maps live, and diff against the vendored fixtures to detect drift when the
   SDM or NASM updates.

## 7. Phasing

1. **Phase 1 — invariants** (§3.1, §3.2): highest value, no external oracle,
   catches the bulk of parser mistakes immediately.
2. **Phase 2 — golden fixtures** (§3.5, §3.6, parts of §3.3): hand-verified
   representative set; locks in correctness on the cases we care about.
3. **Phase 3 — NASM oracle cross-check** (§3.3, §3.4): broad automated
   encoding/operand coverage via the normalization layer.
4. **Phase 4 — API + minimal E2E** (§3.7, §3.8).
5. **Phase 5 — optional live LLVM/NASM differential** (§6.5).

## 8. Open questions

- Test runner: **Vitest** (proposed) vs `node:test`.
- How much of NASM's `insns.dat` to vendor vs. fetch in CI.
- Whether to add a third oracle (Intel XED / iced-x86) for EVEX-heavy coverage.
- Size of the golden set (proposed ~75) and its instruction-family breakdown.

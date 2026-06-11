# Feature Spec — Web Assembler / Disassembler (Proof of Concept)

> Status: **proposal for a partner to implement.** Companion to
> [`SPECIFICATION.md`](./SPECIFICATION.md) and [`TESTING.md`](./TESTING.md).
> Scope is deliberately small — this is a PoC, not a production toolchain.

> 🛑 **Implementing this with Claude (or any agent)? Read [§11 — When to stop
> and consult Raymond](#11-when-to-stop-and-consult-raymond) FIRST.** This spec
> touches bit-level encodings where a confident-but-wrong guess is worse than a
> question. When something is **confusing, doesn't look right, or is downright
> broken**, stop and ask the owner (Raymond) instead of inventing an answer.
> Inline ⚠️ markers flag the highest-risk spots.

## 1. Idea

Now that the x86-64 instruction reference is in a **structured, queryable
form** (opcodes, operand encodings, operand roles, modes), we can reuse that
table as the backing table for an actual **assembler** and **disassembler**,
exposed as a simple webpage. A user can:

- write x86-64 assembly (Intel *or* AT&T syntax), get it **assembled** to raw
  machine code, with **syntax checking**, and **download the binary**;
- **upload a binary** (or paste hex) and get it **disassembled** back to
  assembly in their chosen syntax.

This closes the loop with the testing philosophy: the assembler is literally the
function `A:(mnemonic, operands) → bytes` and the disassembler is `D = A⁻¹`, so
the dataset's correctness and the tool's correctness are tested by the same
round-trip/differential machinery (see §8).

## 2. Hard scope limits (non-goals)

This is a **single-translation-unit, flat-binary** tool. Explicitly **out of
scope**:

- ❌ Linking of any kind — no symbol resolution across files, no externs.
- ❌ Object/executable formats — no ELF, PE/COFF, Mach-O; no sections beyond a
  single implicit `.text` + optional inline data.
- ❌ Dynamic libraries — no DLLs, `.so`s, imports/exports, PLT/GOT, relocations.
- ❌ Debug info, optimization, instruction scheduling.
- ❌ Full ISA coverage — we ship a **curated subset** (see §6) chosen so a small
  program can be written; the engine is **data-driven** so growth = more table
  rows, not more code.
- ❌ 16/32-bit modes as a first goal — target **64-bit (long mode)** first;
  others optional later.

Only **intra-unit** label references are resolved (relative jumps/calls,
RIP-relative `lea`/`mov`), entirely within the assembled blob. An optional
`org`/base-address sets where the blob is assumed to load.

## 3. How it builds on the existing dataset

The `opcodes` + `operand_encodings` rows are the source of truth:

- **Assembler match table:** group rows by mnemonic; each row's `instruction`
  form (`ADD r/m64, imm32`) + `opcode` pattern (`REX.W + 81 /4 id`) + `op_en`
  drive operand-type matching and byte emission.
- **Disassembler decode table:** the same `opcode` patterns, indexed by opcode
  bytes/prefixes, map back to mnemonic + operand layout.

What the partner must **add on top** of the dataset (the dataset gives patterns,
not a bit-level engine):

1. An **encoding-token interpreter** for the opcode grammar: legacy prefixes
   (`NP`,`66`,`F2`,`F3`,`REX*`), `VEX`/`EVEX` specifiers, `ModRM` (`/r`,
   `/0../7`), `SIB`, displacement sizes, immediates (`ib/iw/id/io`),
   register-in-opcode (`+rb/+rw/+rd/+ro`).
2. A small **operand-type model** (`r8/r16/r32/r64`, `m`, `imm8/16/32/64`,
   `rel8/32`, `xmm/ymm/zmm`, `moffs`, implicit operands) used to match parsed
   operands against table rows.
3. A note that extracted artifacts (e.g. footnote superscripts, see
   `TESTING.md` §4) must be normalized before the patterns are machine-usable;
   a small curated/overridable encoding table for the MVP subset is acceptable
   if the parsed rows are insufficient — but prefer driving from the dataset.

> ⚠️ **Consult Raymond** before introducing a *parallel* hand-written encoding
> table as a workaround. If the parsed dataset looks insufficient or wrong for
> an instruction, that may be a **dataset/parser bug worth fixing at the source**
> (`etl/src/parse.ts`) rather than papering over in the engine — and that's the
> owner's call. Don't silently diverge the two sources of truth.

## 4. Architecture

```
            ┌──────────────────────── Web UI (React) ───────────────────────┐
            │  Assemble tab            │            Disassemble tab          │
            │  ┌────────────┐ assemble │  upload/paste bytes  ┌────────────┐ │
            │  │  editor    │ ───────▶ │  ───────────────────▶│  listing   │ │
            │  │ Intel/AT&T │ ◀─ errs  │  base addr + syntax   │ Intel/AT&T │ │
            │  └────────────┘ download │                       └────────────┘ │
            └───────────────┬──────────────────────────┬────────────────────┘
                            │  POST /api/assemble        │  POST /api/disassemble
                            ▼                            ▼
                    ┌──────────────────── asm engine (TypeScript) ───────────┐
                    │  lexer → preprocessor → parser(Intel|AT&T) → AST        │
                    │  → semantic/syntax check → encoder ──▶ bytes + listing  │
                    │  decoder ◀── bytes (linear sweep) ──▶ AST → printer     │
                    │           (driven by the instruction dataset/table)     │
                    └─────────────────────────────────────────────────────────┘
```

- **Recommended placement:** a self-contained `asm/` TypeScript package (pure
  functions, no DOM) consumed by **either** new API endpoints
  (`POST /api/assemble`, `POST /api/disassemble`) **or** directly in the
  browser. Proposed default: **API endpoints** (reuse the DB-backed table; keep
  the bundle small). Engine stays framework-agnostic and unit-testable in
  isolation.
- **Syntax-neutral AST:** front-end parsers (Intel, AT&T) produce the same AST;
  the encoder and the disassembler's printer are the only syntax-aware backends.

### Pipeline detail (assembler)
1. **Lex** → tokens (with line/col for diagnostics).
2. **Preprocess** (§5).
3. **Parse** per selected syntax → instruction/label/directive AST.
4. **Pass 1**: lay out, assign label addresses, size instructions.
5. **Pass 2**: resolve label references (rel8/rel32, RIP-relative), encode.
6. **Emit**: flat byte buffer + a **listing** (address · bytes · source) +
   diagnostics.

### Pipeline detail (disassembler)
- **Linear sweep** from a start offset/base address (PoC; document the
  data-vs-code ambiguity, §9). Decode one instruction at a time via the table,
  format operands in the chosen syntax, print address + bytes + text.

## 5. Preprocessing / metaprogramming (basic)

Keep minimal and clearly bounded. MVP set:

- **Symbol constants:** `%define NAME value` (NASM) / `NAME equ value` /
  `.set` (GAS).
- **Labels:** `name:` and use as operands; local labels optional.
- **Data directives:** `db/dw/dd/dq` (Intel/NASM) and `.byte/.word/.long/.quad`
  (GAS), plus string literals.
- **Repetition:** `times N <line>` (NASM) / `.rept`/`.endr` (GAS).
- **Text macros:** simple parameterless / fixed-arg `%macro…%endmacro`
  (NASM) or `.macro….endm` (GAS). No recursion guarantees.
- **Conditional assembly** *(in MVP — decided)*: `%if`/`%ifdef`/`%else`/`%endif`
  (NASM) and `.if`/`.else`/`.endif` (GAS), evaluated over the constant-expression
  evaluator below.
- **Constant-expression evaluation:** integer arithmetic for immediates/offsets
  (`+ - * / << >> & | ^`, parens).
- **Origin:** `org <addr>` / base-address field (affects absolute & RIP-rel).

Stretch (not MVP): include of pasted snippets, multi-arg hygienic macros,
macro recursion.

## 6. MVP instruction subset

Enough to write a small routine. Data-driven, so this is a starting allow-list,
not a code limit:

- **Data movement:** `MOV`, `LEA`, `PUSH`, `POP`, `MOVZX`, `MOVSX`, `XCHG`.
- **Arithmetic/logic:** `ADD`, `SUB`, `ADC`, `SBB`, `INC`, `DEC`, `NEG`,
  `IMUL`, `MUL`, `AND`, `OR`, `XOR`, `NOT`, `CMP`, `TEST`, `SHL`, `SHR`, `SAR`.
- **Control flow:** `JMP`, `Jcc` (all conditions), `CALL`, `RET`, `LOOP`,
  `NOP`, `INT`, `INT3`, `SYSCALL`, `LEAVE`.
- (Stretch) a handful of SSE moves (`MOVAPS`,`MOVDQA`,`ADDPS`) to prove the
  VEX/legacy path generalizes.

## 7. Web UI

- **Two tabs / split view.** Syntax toggle (Intel ⇄ AT&T) shared; **defaults to
  AT&T** (decided).
- **Disassemble:** also exposes **user-marked data regions** — the user can mark
  byte ranges to render as `db/dw/dd/dq` rather than decode as code (decided).
- **Assemble:** code editor (monospace, line numbers; CodeMirror/Monaco
  optional), "Assemble" button, output panel with **hex + listing**, inline
  **error list** (line/col, message), **Download .bin**.
- **Disassemble:** **file upload** *or* hex/textarea paste, base-address +
  start-offset inputs, syntax toggle, output **listing**; "Copy" / download text.
- Errors are first-class: nothing crashes the page; every failure is a
  diagnostic with a location.

## 8. Testing (mirrors `TESTING.md`)

**Primary oracle: GNU `as` (gas)** — decided. NASM is *not* trusted as a
canonical encoder (known encoding bugs) and is excluded as an authority; LLVM
`llvm-mc`/`llvm-objdump` may be used as a secondary sanity check. The same
notation-normalization layer (`TESTING.md` §4) applies. Categories:

- **Assembler unit tests:** `assemble(source) == expectedBytes` for a golden
  corpus (per the §6 subset), both syntaxes.
- **Disassembler unit tests:** `disassemble(bytes) == expectedText` (normalized).
- **Round-trip / isomorphism:**
  - `disassemble(assemble(src))` is semantically equal to `src` (normalized);
  - `assemble(disassemble(bytes)) == bytes` (byte-exact) holds **for our own
    canonically-encoded output**. For arbitrary uploaded blobs the disassembler
    canonicalizes redundant encodings (decided, §9.8), so re-assembly equals the
    *canonical* byte form, not necessarily the original bytes — these are tested
    separately.
- **Cross-syntax equivalence:** Intel and AT&T spellings of the same
  instruction assemble to **identical bytes**.
- **Differential vs reference:** assemble the same source with GNU `as` and
  diff bytes; disassemble with `objdump`/`llvm-objdump` and diff text. (Gated
  job — same pattern as `TESTING.md` §6.5.)
- **Negative/syntax-check tests:** malformed input yields a diagnostic at the
  right location, not a crash (unknown mnemonic, no matching encoding,
  out-of-range immediate → **error**, undefined label, missing Intel size
  keyword, ambiguous AT&T suffix).

This suite is also a **strong validator of the dataset**: an encoding that
round-trips against `as`/LLVM confirms the extracted opcode/operand rows.

## 9. Ambiguity — resolved decisions

These were worked through with the project owner. Implement to these; revisit
only with a documented reason.

> ⚠️ **These decisions are the boundary of what's settled.** If you hit a case
> these *don't* cover, or following one of them produces output that disagrees
> with GNU `as`/LLVM or just looks wrong, **do not invent a new policy** —
> surface it to Raymond (see §11). New ambiguity classes are expected; guessing
> at them is the failure mode to avoid.

1. **Encoding selection (assembler).** Do **not** model output on NASM (treated
   as buggy/untrustworthy). Follow **GNU `as` (gas)** behavior as the reference
   for which encoding to emit when several are valid (short-form vs ModRM,
   imm8-sign-extended vs imm32, REX usage). The gas differential job (§8) is the
   acceptance check.
2. **Operand-size ambiguity (Intel).** **Require an explicit size** keyword
   (`byte/word/dword/qword ptr`) whenever the size is not fixed by another
   operand; otherwise emit a diagnostic. No silent default.
3. **AT&T suffix inference.** **Match gas:** infer size from register operands
   when present; the `b/w/l/q` suffix is **required only when all operands are
   size-ambiguous** (e.g. memory + immediate). Missing-and-ambiguous → error.
4. **Default operand/address size & REX.W (64-bit).** Internal correctness,
   handled per the ISA rules (default operand size 32, REX.W for 64-bit
   operands, etc.). Not user-configurable; covered by encoding tests.
5. **Immediate overflow.** **Error** on any immediate that does not fit the
   target operand size (with location). No silent truncation/wrap.
6. **Jump/call targets without a linker.** No modular/multi-file linking;
   instead the blob is treated **as if loaded at a base/`org` address, the way
   an ELF image would be**. Supported: (a) **intra-blob labels** (rel8/rel32,
   RIP-relative), and (b) **absolute numeric targets** resolved against the base
   address. **External symbols are resolved manually by the user** (e.g. define
   the symbol's absolute address via `equ`/`%define`). Unresolved → diagnostic.
7. **Disassembly: data vs code.** Linear sweep, but output is **reassemblable**:
   synthesize **labels** at branch/call targets and emit **`db/dw/dd/dq`** for
   bytes that don't decode (NASM-`ndisasm`-style), **plus user-marked data
   regions** (§7) so the user can declare byte ranges as data up front.
   (Acknowledged: true automatic code/data separation needs format/section
   metadata, which is out of PoC scope.)
8. **Redundant / non-canonical decode.** **Canonicalize and note:** print the
   standard/simplest form, and annotate when the source bytes used a redundant
   encoding (extra prefixes, redundant REX). Round-trip expectations adjust
   accordingly (§8).
9. **Prefixes & segment overrides.** Support **`lock`** and **`rep`/`repe`/
   `repne`**. Segment overrides: **`FS`/`GS` only** — `CS/DS/ES/SS` overrides
   are *not* supported, consistent with the 64-bit-only scope and modern usage.

### UI / tooling decisions (from the same discussion)
- **Default syntax: AT&T** (toggle to Intel available).
- **Preprocessor includes conditional assembly** (§5).
- **Primary differential oracle: GNU `as`** (NASM excluded as authority) (§8).

## 10. Suggested milestones (partner)

1. Engine skeleton + encoding-token interpreter + AT&T parser (default syntax);
   MVP integer subset; assembler unit + gas-differential tests.
2. Disassembler (linear sweep, label/`db` synthesis) for the same subset;
   `A∘D` / `D∘A` tests.
3. Intel parser + printer; cross-syntax equivalence tests; Intel explicit-size
   enforcement (§9.2).
4. Preprocessing/macros incl. conditional assembly (§5) + syntax-check
   diagnostics (immediate-overflow errors, etc.).
5. Web UI (assemble/download, upload/disassemble, user-marked data regions)
   wired to API endpoints.
6. Differential CI job vs GNU `as` / LLVM `objdump`.

## 11. When to stop and consult Raymond

This is a bit-level, correctness-critical PoC. A wrong-but-confident encoding is
far more costly than a question — it can silently corrupt output and poison the
golden fixtures. **If you're working with Claude (or any agent), the rule is:
prefer escalating to guessing.** Stop and ask Raymond whenever any of these three
triggers fires.

> **Raymond is intended as the *last* resort — but he's available at *any* time.**
> The expectation is that you exhaust the cheaper avenues first (the spec, the
> Intel SDM, GNU `as`, and your LLM, per below). That said, reaching out is an
> open option whenever you want it — you do **not** have to wait until something
> is broken or the situation is bad. A quick gut-check, a "does this look right
> to you?", or sanity-checking a direction *before* you build on it are all
> perfectly welcome, even when nothing is wrong.

### 🟥 It's downright broken / can't be right
- The dataset has **no encoding** (or an obviously malformed one) for an
  instruction you need, or the parsed row contradicts the Intel SDM.
- Your output **disagrees with GNU `as`** (the oracle) for a supported case and
  you can't explain why — this may be an engine bug *or* a dataset/parser bug;
  which to fix is Raymond's call (don't just patch around it).
- A round-trip property (`A∘D` / `D∘A`, §8) fails and the cause is unclear.
- You'd have to **modify `etl/src/parse.ts` or the dataset** to make encoding
  work — touching the source of truth is an owner decision.

### 🟨 It doesn't look right / smells wrong
- Following a §9 decision produces output that looks incorrect or
  self-contradictory in a real case.
- GNU `as`, LLVM, and the Intel SDM **disagree** with each other — pick nothing;
  bring the three readings to Raymond.
- You're tempted to introduce a **second, hand-written encoding table** parallel
  to the dataset (see §3 ⚠️).
- A test only passes after you **loosen an assertion or normalize away a real
  difference** — that masking is itself the thing to flag.

### 🟦 It's too confusing / ambiguous / unspecified
- You hit an **ambiguity class not covered by §9** (new encoding-selection case,
  prefix interaction, operand-size edge, syntax quirk). New classes are
  *expected*; inventing a policy for them is the failure mode.
- The spec is **silent or seems contradictory** on something you must decide.
- A change would **expand scope** toward the §2 non-goals (linking, object
  formats, relocations, broader ISA) — confirm before crossing that line.

**Lean on your LLM first — for ideas and judgement, not for ground truth.**
Before (and while) escalating, use Claude/your LLM as a sounding board: have it
explain the encoding, enumerate the candidate options, weigh trade-offs against
the §9 decisions, cross-read the Intel SDM, and draft a recommendation. That's
exactly the analysis that makes a good escalation. Just remember the LLM is *not*
the oracle here — GNU `as` is — and it should **not** be trusted to settle the
🟥 "broken / disagrees with `as`", dataset/`parse.ts`, or scope decisions on its
own. Use it to *form* the question and the options; bring the call to Raymond.

**How to escalate:** don't silently choose. Leave the work in a clearly-marked
`TODO(raymond):` state with (a) what you observed, (b) the candidate options and
their trade-offs (LLM-assisted is fine), and (c) your recommendation — then ask.
Capturing the question that way makes the decision fast.

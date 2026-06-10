# Database Schema

The database is **PostgreSQL 16**. The schema lives in
[`db/init/01-schema.sql`](../db/init/01-schema.sql) and is applied two ways:

1. The `db` container auto-runs every file in `/docker-entrypoint-initdb.d` the
   first time its data directory is initialized.
2. The `api` container also executes the same file on startup (every statement
   is `IF NOT EXISTS`, so it is safe to re-run) and then seeds the data.

All instruction data is parsed from **Volume 2 (Instruction Set Reference,
A‑Z)** of the Intel® 64 and IA‑32 Architectures Software Developer's Manual by
the ETL step ([`etl/src/parse.ts`](../etl/src/parse.ts)).

## Entity overview

```
                       ┌─────────────────────────┐
                       │      instructions       │  one row per SDM entry
                       │  id (PK)                 │
                       │  mnemonic, title         │
                       │  volume, page            │
                       │  description, operation  │
                       │  flags_affected          │
                       │  intrinsics              │
                       │  exceptions  (jsonb)     │
                       │  aliases                 │
                       │  opcode_table_raw        │
                       │  operand_encoding_raw    │
                       │  search  (tsvector, gen) │
                       └────────────┬─────────────┘
                                    │ 1
              ┌─────────────────────┼───────────────────────┐
              │ N                   │ N                     │ N
   ┌──────────▼─────────┐ ┌─────────▼──────────┐ ┌──────────▼────────────┐
   │instruction_mnemonics│ │      opcodes       │ │  operand_encodings    │
   │ id (PK)             │ │ id (PK)            │ │ id (PK)               │
   │ instruction_id (FK) │ │ instruction_id(FK) │ │ instruction_id (FK)   │
   │ mnemonic            │ │ ordinal            │ │ ordinal               │
   └─────────────────────┘ │ opcode             │ │ op_en                 │
                           │ instruction        │ │ operands  (text[])    │
                           │ op_en              │ └───────────────────────┘
                           │ mode_64bit         │
                           │ compat_leg         │
                           │ description        │
                           └────────────────────┘
```

## Tables

### `instructions`
One row per instruction-reference entry (768 rows).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `serial` PK | |
| `mnemonic` | `text` | Primary mnemonic, e.g. `ADD`. |
| `title` | `text` | Full descriptive name, e.g. *Add*. |
| `volume` | `text` | Source SDM volume: `2A`/`2B`/`2C`/`2D`. |
| `page` | `text` | SDM page label, e.g. `3-14`. |
| `description` | `text` | Prose "Description" section. |
| `operation` | `text` | "Operation" pseudocode block (verbatim). |
| `flags_affected` | `text` | "Flags Affected" section. |
| `intrinsics` | `text` | Intel C/C++ compiler intrinsic equivalents. |
| `exceptions` | `jsonb` | Map of *mode name → exception text*, e.g. `{"Protected Mode Exceptions": "…"}`. |
| `aliases` | `text` | Space-joined list of every mnemonic the entry covers, including VEX/EVEX forms (e.g. `ADDPS VADDPS`). Feeds search. |
| `opcode_table_raw` | `text` | Verbatim, monospace-aligned opcode table (rendering fallback / source of truth). |
| `operand_encoding_raw` | `text` | Verbatim operand-encoding table. |
| `search` | `tsvector` | **Generated, stored.** Weighted: mnemonic + aliases (A) > title (B) > description (C). |

Indexes: GIN on `search`; GIN `gin_trgm_ops` on `mnemonic`; unique
`(mnemonic, coalesce(page,''))` to make seeding idempotent.

### `instruction_mnemonics`
Every individual mnemonic an entry documents — an entry may cover several
(e.g. `INT n/INTO/INT3/INT1`, or `ADDPS` + its `VADDPS` forms). Enables direct
lookup of any form. (`instruction_id` FK → `instructions.id`, `ON DELETE CASCADE`.)

Indexes: btree on `instruction_id`, on `lower(mnemonic)`, and a trigram GIN for
fuzzy lookup.

### `opcodes`
Structured rows of the opcode/encoding table, one row per encoded form (≈3,900
rows). Columns: `ordinal`, `opcode` (e.g. `NP 0F 58 /r`), `instruction`
(assembly form, e.g. `ADDPS xmm1, xmm2/m128`), `op_en`, `mode_64bit`,
`compat_leg` (compat/legacy support, or CPUID feature flag for newer entries),
`description`.

### `operand_encodings`
Rows of the "Instruction Operand Encoding" table. `op_en` keys join back to
`opcodes.op_en`; `operands` is a `text[]` of operand 1..4 (plus tuple type for
EVEX entries).

## Search model

`GET /api/instructions?q=…` matches in three complementary ways:

- `search @@ websearch_to_tsquery('english', q)` — ranked full-text over
  mnemonic, title and description (handles prose like *"jump if"*).
- `mnemonic ILIKE '%q%'` and `aliases ILIKE '%q%'` — case-insensitive substring,
  so partial and VEX/EVEX mnemonics (`addp`, `vaddps`) resolve.

Results are ordered by `ts_rank(search, …)` then mnemonic.

## Regenerating the dataset

```bash
# 1. Extract the SDM PDF to layout-preserving text (poppler's pdftotext):
pdftotext -layout IntelSDM/325462-091-sdm-*.pdf IntelSDM/sdm.txt

# 2. Parse it into the seed JSON consumed by the API container:
cd etl && npm install && npm run parse        # -> etl/data/instructions.json
```

On its next first-boot the `api` container reloads `instructions.json`. To
force a re-seed, drop the `db-data` volume: `docker compose down -v`.

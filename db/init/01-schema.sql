-- ===========================================================================
-- ASMResource — Intel SDM Instruction Reference schema (PostgreSQL)
--
-- Auto-executed by the postgres container on first initialization (files in
-- /docker-entrypoint-initdb.d are run once when the data directory is empty).
-- The API container also executes this file on startup, so every statement is
-- written to be idempotent (IF NOT EXISTS) and safe to re-run.
--
-- See docs/SCHEMA.md for the full data-model documentation.
-- ===========================================================================

-- pg_trgm powers fast case-insensitive substring / fuzzy mnemonic lookups.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- instructions: one row per instruction-reference entry in the SDM.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS instructions (
    id                   SERIAL PRIMARY KEY,
    mnemonic             TEXT  NOT NULL,            -- primary mnemonic, e.g. "ADD"
    title                TEXT  NOT NULL,            -- full name, e.g. "Add"
    volume               TEXT,                      -- source volume: 2A/2B/2C/2D
    page                 TEXT,                      -- SDM page label, e.g. "3-14"
    description          TEXT,                      -- prose description
    operation           TEXT,                      -- pseudocode "Operation" block
    flags_affected       TEXT,                      -- "Flags Affected" block
    intrinsics           TEXT,                      -- C/C++ intrinsic equivalents
    exceptions           JSONB NOT NULL DEFAULT '{}'::jsonb,  -- mode -> text
    aliases              TEXT,                      -- all mnemonics (incl. VEX/EVEX forms), space-joined
    opcode_table_raw     TEXT,                      -- verbatim opcode table (monospace)
    operand_encoding_raw TEXT,                      -- verbatim operand-encoding table
    -- Weighted full-text search vector: mnemonics (A) > title (B) > description (C).
    search tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(mnemonic, '')),    'A') ||
        setweight(to_tsvector('simple',  coalesce(aliases, '')),     'A') ||
        setweight(to_tsvector('english', coalesce(title, '')),       'B') ||
        setweight(to_tsvector('english', coalesce(description, '')),  'C')
    ) STORED
);

CREATE INDEX IF NOT EXISTS idx_instructions_search   ON instructions USING GIN (search);
CREATE INDEX IF NOT EXISTS idx_instructions_mnem_trgm ON instructions USING GIN (mnemonic gin_trgm_ops);
CREATE UNIQUE INDEX IF NOT EXISTS idx_instructions_mnem_page
    ON instructions (mnemonic, COALESCE(page, ''));

-- ---------------------------------------------------------------------------
-- instruction_mnemonics: every mnemonic an entry documents (1 entry may cover
-- several, e.g. "INT n/INTO/INT3/INT1"). Enables direct lookup by any form.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS instruction_mnemonics (
    id             SERIAL PRIMARY KEY,
    instruction_id INTEGER NOT NULL REFERENCES instructions(id) ON DELETE CASCADE,
    mnemonic       TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mnem_instruction ON instruction_mnemonics (instruction_id);
CREATE INDEX IF NOT EXISTS idx_mnem_lower       ON instruction_mnemonics (lower(mnemonic));
CREATE INDEX IF NOT EXISTS idx_mnem_trgm        ON instruction_mnemonics USING GIN (mnemonic gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- opcodes: structured rows of the opcode/encoding table (1 entry : N rows).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS opcodes (
    id             SERIAL PRIMARY KEY,
    instruction_id INTEGER NOT NULL REFERENCES instructions(id) ON DELETE CASCADE,
    ordinal        INTEGER NOT NULL,                -- row order within the table
    opcode         TEXT,                            -- encoding bytes, e.g. "NP 0F 58 /r"
    instruction    TEXT,                            -- assembly form, e.g. "ADDPS xmm1, xmm2/m128"
    op_en          TEXT,                            -- operand-encoding key, e.g. "RM"
    mode_64bit     TEXT,                            -- 64-bit (or 64/32) mode support
    compat_leg     TEXT,                            -- compat/legacy support or CPUID flag
    description    TEXT
);

CREATE INDEX IF NOT EXISTS idx_opcodes_instruction ON opcodes (instruction_id);

-- ---------------------------------------------------------------------------
-- operand_encodings: the "Instruction Operand Encoding" table (1 entry : N rows).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operand_encodings (
    id             SERIAL PRIMARY KEY,
    instruction_id INTEGER NOT NULL REFERENCES instructions(id) ON DELETE CASCADE,
    ordinal        INTEGER NOT NULL,
    op_en          TEXT,                            -- key matching opcodes.op_en
    operands       TEXT[]                           -- operand 1..4 (and tuple type)
);

CREATE INDEX IF NOT EXISTS idx_operand_enc_instruction ON operand_encodings (instruction_id);

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PoolClient } from "pg";
import { pool } from "./db";

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
  mnemonic: string;
  mnemonics: string[];
  title: string;
  volume: string;
  page: string;
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

const SCHEMA_FILE = process.env.SCHEMA_FILE ?? resolve(__dirname, "../db/01-schema.sql");
const SEED_FILE = process.env.SEED_FILE ?? resolve(__dirname, "../data/instructions.json");

/** Ensure the schema exists (idempotent). */
export async function ensureSchema(): Promise<void> {
  const sql = readFileSync(SCHEMA_FILE, "utf8");
  await pool.query(sql);
  console.log("[seed] schema ensured");
}

/** Load the parsed SDM JSON into the database if it has not been seeded yet. */
export async function seedIfEmpty(): Promise<void> {
  const { rows } = await pool.query<{ count: string }>("SELECT count(*) FROM instructions");
  if (Number(rows[0].count) > 0) {
    console.log(`[seed] already populated (${rows[0].count} instructions), skipping`);
    return;
  }

  const data: Instruction[] = JSON.parse(readFileSync(SEED_FILE, "utf8"));
  console.log(`[seed] loading ${data.length} instructions from ${SEED_FILE} ...`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const ins of data) {
      await insertInstruction(client, ins);
    }
    await client.query("COMMIT");
    console.log(`[seed] done: inserted ${data.length} instructions`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function insertInstruction(client: PoolClient, ins: Instruction): Promise<void> {
  const { rows } = await client.query<{ id: number }>(
    `INSERT INTO instructions
       (mnemonic, title, volume, page, description, operation, flags_affected,
        intrinsics, exceptions, aliases, opcode_table_raw, operand_encoding_raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (mnemonic, COALESCE(page, '')) DO NOTHING
     RETURNING id`,
    [
      ins.mnemonic,
      ins.title,
      ins.volume || null,
      ins.page || null,
      ins.description || null,
      ins.operation || null,
      ins.flagsAffected || null,
      ins.intrinsics || null,
      JSON.stringify(ins.exceptions ?? {}),
      Array.from(new Set(ins.mnemonics.length ? ins.mnemonics : [ins.mnemonic])).join(" "),
      ins.opcodeTableRaw || null,
      ins.operandEncodingRaw || null,
    ],
  );
  if (rows.length === 0) return; // duplicate (mnemonic, page) — skip dependents
  const id = rows[0].id;

  const mnemonics = Array.from(new Set(ins.mnemonics.length ? ins.mnemonics : [ins.mnemonic]));
  for (const m of mnemonics) {
    await client.query(
      "INSERT INTO instruction_mnemonics (instruction_id, mnemonic) VALUES ($1, $2)",
      [id, m],
    );
  }

  for (let i = 0; i < ins.opcodes.length; i++) {
    const o = ins.opcodes[i];
    await client.query(
      `INSERT INTO opcodes
         (instruction_id, ordinal, opcode, instruction, op_en, mode_64bit, compat_leg, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, i, o.opcode, o.instruction, o.opEn, o.mode64, o.compatLeg, o.description],
    );
  }

  for (let i = 0; i < ins.operandEncodings.length; i++) {
    const e = ins.operandEncodings[i];
    await client.query(
      `INSERT INTO operand_encodings (instruction_id, ordinal, op_en, operands)
       VALUES ($1,$2,$3,$4)`,
      [id, i, e.opEn, e.operands],
    );
  }
}

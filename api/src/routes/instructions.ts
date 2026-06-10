import { Router } from "express";
import { pool } from "../db";

export const router = Router();

/**
 * GET /api/instructions
 * List / search instructions.
 *   ?q=      free-text search (mnemonic, title, description) + mnemonic prefix
 *   ?volume= filter by source volume (2A/2B/2C/2D)
 *   ?letter= filter by first letter of the mnemonic
 *   ?limit=  page size (default 50, max 200)
 *   ?offset= pagination offset
 * Returns { total, limit, offset, results: [...] } with lightweight summaries.
 */
router.get("/instructions", async (req, res, next) => {
  try {
    const q = String(req.query.q ?? "").trim();
    const volume = String(req.query.volume ?? "").trim();
    const letter = String(req.query.letter ?? "").trim().toUpperCase();
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const where: string[] = [];
    const params: unknown[] = [];
    let rank = "0";

    if (q) {
      params.push(q);
      const qi = `$${params.length}`;
      // Combine full-text matching with case-insensitive substring search over
      // the mnemonic and the alias list (which includes VEX/EVEX forms such as
      // VADDPS), so partial mnemonics ("addp", "vaddps") and prose both work.
      where.push(
        `(search @@ websearch_to_tsquery('english', ${qi})
          OR mnemonic ILIKE '%' || ${qi} || '%'
          OR aliases ILIKE '%' || ${qi} || '%')`,
      );
      rank = `ts_rank(search, websearch_to_tsquery('english', ${qi}))`;
    }
    if (volume) {
      params.push(volume);
      where.push(`volume = $${params.length}`);
    }
    if (letter) {
      params.push(letter);
      where.push(`upper(left(mnemonic, 1)) = $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const totalRes = await pool.query<{ count: string }>(
      `SELECT count(*) FROM instructions ${whereSql}`,
      params,
    );
    const total = Number(totalRes.rows[0].count);

    params.push(limit, offset);
    const listRes = await pool.query(
      `SELECT id, mnemonic, title, volume, page,
              left(coalesce(description, ''), 240) AS summary,
              ${rank} AS rank
         FROM instructions
         ${whereSql}
         ORDER BY ${q ? "rank DESC, " : ""} mnemonic ASC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    res.json({ total, limit, offset, results: listRes.rows });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/instructions/:mnemonic
 * Full detail for one instruction, resolved by any documented mnemonic
 * (case-insensitive). Includes opcode rows and operand-encoding rows.
 */
router.get("/instructions/:mnemonic", async (req, res, next) => {
  try {
    const mnemonic = req.params.mnemonic;

    const insRes = await pool.query(
      `SELECT i.*
         FROM instructions i
         WHERE lower(i.mnemonic) = lower($1)
            OR EXISTS (
                 SELECT 1 FROM instruction_mnemonics m
                  WHERE m.instruction_id = i.id AND lower(m.mnemonic) = lower($1)
               )
         ORDER BY (lower(i.mnemonic) = lower($1)) DESC
         LIMIT 1`,
      [mnemonic],
    );
    if (insRes.rows.length === 0) {
      return res.status(404).json({ error: `Instruction '${mnemonic}' not found` });
    }
    const instruction = insRes.rows[0];

    const [opcodes, encodings, mnemonics] = await Promise.all([
      pool.query(
        `SELECT opcode, instruction, op_en, mode_64bit, compat_leg, description
           FROM opcodes WHERE instruction_id = $1 ORDER BY ordinal`,
        [instruction.id],
      ),
      pool.query(
        `SELECT op_en, operands FROM operand_encodings
           WHERE instruction_id = $1 ORDER BY ordinal`,
        [instruction.id],
      ),
      pool.query(
        `SELECT mnemonic FROM instruction_mnemonics
           WHERE instruction_id = $1 ORDER BY mnemonic`,
        [instruction.id],
      ),
    ]);

    res.json({
      ...instruction,
      search: undefined,
      mnemonics: mnemonics.rows.map((r) => r.mnemonic),
      opcodes: opcodes.rows,
      operandEncodings: encodings.rows,
    });
  } catch (err) {
    next(err);
  }
});

/** GET /api/stats — summary counts for the landing page. */
router.get("/stats", async (_req, res, next) => {
  try {
    const [counts, byVolume, byLetter] = await Promise.all([
      pool.query(
        `SELECT (SELECT count(*) FROM instructions) AS instructions,
                (SELECT count(*) FROM instruction_mnemonics) AS mnemonics,
                (SELECT count(*) FROM opcodes) AS opcode_forms`,
      ),
      pool.query(`SELECT volume, count(*)::int AS count FROM instructions
                  GROUP BY volume ORDER BY volume`),
      pool.query(`SELECT upper(left(mnemonic,1)) AS letter, count(*)::int AS count
                  FROM instructions GROUP BY 1 ORDER BY 1`),
    ]);
    res.json({
      totals: counts.rows[0],
      byVolume: byVolume.rows,
      byLetter: byLetter.rows,
    });
  } catch (err) {
    next(err);
  }
});

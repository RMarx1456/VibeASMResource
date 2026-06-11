import express from "express";
import cors from "cors";
import { waitForDb } from "./db";
import { ensureSchema, seedIfEmpty } from "./seed";
import { router as instructionsRouter } from "./routes/instructions";
import { makeAsmRouter } from "./routes/asm";
import { buildIndex } from "./asm/index";
import { pool } from "./db";

const PORT = Number(process.env.PORT ?? 4000);

async function main() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "8mb" }));

  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  app.use("/api", instructionsRouter);

  // Centralized error handler.
  app.use(
    (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      console.error("[api] error:", err);
      res.status(500).json({ error: "Internal server error" });
    },
  );

  console.log("[api] waiting for database ...");
  await waitForDb();
  await ensureSchema();
  await seedIfEmpty();

  // Build opcode index for assembler/disassembler
  const [opcodeRows, encRows] = await Promise.all([
    pool.query<{
      id: number; instruction_id: number; mnemonic: string; opcode: string;
      instruction: string; op_en: string; mode_64bit: string; compat_leg: string;
    }>(`SELECT o.id, o.instruction_id, i.mnemonic,
               o.opcode, o.instruction, o.op_en, o.mode_64bit, o.compat_leg
          FROM opcodes o
          JOIN instructions i ON i.id = o.instruction_id`),
    pool.query<{ instruction_id: number; op_en: string; operands: string[] }>(
      `SELECT instruction_id, op_en, operands FROM operand_encodings`,
    ),
  ]);
  const asmIndex = buildIndex(
    opcodeRows.rows.map(r => ({
      id: r.id,
      instructionId: r.instruction_id,
      mnemonic: r.mnemonic,
      opcode: r.opcode,
      instruction: r.instruction,
      opEn: r.op_en,
      mode64: r.mode_64bit,
      compatLeg: r.compat_leg,
    })),
    encRows.rows.map(r => ({
      instructionId: r.instruction_id,
      opEn: r.op_en,
      operands: r.operands,
    })),
  );
  console.log("[api] opcode index built");

  app.use("/api", makeAsmRouter(asmIndex));

  app.listen(PORT, () => console.log(`[api] listening on :${PORT}`));
}

main().catch((err) => {
  console.error("[api] fatal:", err);
  process.exit(1);
});

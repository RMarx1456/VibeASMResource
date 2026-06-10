import express from "express";
import cors from "cors";
import { waitForDb } from "./db";
import { ensureSchema, seedIfEmpty } from "./seed";
import { router as instructionsRouter } from "./routes/instructions";

const PORT = Number(process.env.PORT ?? 4000);

async function main() {
  const app = express();
  app.use(cors());
  app.use(express.json());

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

  app.listen(PORT, () => console.log(`[api] listening on :${PORT}`));
}

main().catch((err) => {
  console.error("[api] fatal:", err);
  process.exit(1);
});

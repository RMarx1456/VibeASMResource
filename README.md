# ASMResource

A full-stack, searchable reference for **x86 / x64 (Intel 64 & IA‑32) assembly
instructions**, built from the official Intel® Software Developer's Manual
(SDM). Browse and search ~770 instruction entries (1,500+ mnemonics including
VEX/EVEX forms, ~3,900 encoded forms) with their encodings, operand encodings,
descriptions, operation pseudocode, affected flags, intrinsics, and exceptions.

```
┌────────────┐      /api/*       ┌────────────┐     SQL      ┌────────────┐
│  frontend  │  ───────────────▶ │    api     │ ───────────▶ │     db     │
│ React+nginx│   (nginx proxy)   │ Express/TS │   (node-pg)  │ PostgreSQL │
│   :8080    │ ◀─────────────── │   :4000    │ ◀─────────── │   :5432    │
└────────────┘                   └────────────┘              └────────────┘
        ▲                                                  ▲
        │ static SPA                          seeded on first boot from
        │                                     etl/data/instructions.json
        └─ http://localhost:8080              (parsed from the Intel SDM PDF)
```

## Tech stack

| Layer | Technology |
| --- | --- |
| Database | PostgreSQL 16 (full-text `tsvector` + `pg_trgm`) |
| API | Node.js 20 · TypeScript · Express · `pg` |
| Frontend | React 18 · TypeScript · Vite · React Router; served by nginx |
| ETL | TypeScript (`tsx`) parser over `pdftotext -layout` output |
| Orchestration | Docker · Docker Compose (3 containers) |

## Quick start

```bash
docker compose up --build
```

Then open **http://localhost:8080**.

- The `db` container creates the schema from `db/init/01-schema.sql`.
- The `api` container waits for the DB, ensures the schema, and seeds it from
  the bundled `etl/data/instructions.json` (only if empty). Seeding ~770
  instructions takes a few seconds; watch `docker compose logs -f api`.
- The `frontend` container serves the built React app and reverse-proxies
  `/api/*` to the API, so the browser only talks to one origin.

The API is also published directly on **http://localhost:4000** for debugging.

To wipe and re-seed: `docker compose down -v && docker compose up --build`.

## REST API

Base path `/api`.

| Method · Path | Description |
| --- | --- |
| `GET /api/health` | Liveness probe → `{ "status": "ok" }`. |
| `GET /api/stats` | Totals + counts by volume and by first letter (for the landing page). |
| `GET /api/instructions` | Search / list. Query params below. |
| `GET /api/instructions/:mnemonic` | Full detail for one instruction, resolved by **any** documented mnemonic (case-insensitive), incl. VEX/EVEX forms. |

`GET /api/instructions` query parameters:

| Param | Meaning |
| --- | --- |
| `q` | Free-text search across mnemonics, aliases, title and description. |
| `volume` | Filter by SDM volume (`2A`/`2B`/`2C`/`2D`). |
| `letter` | Filter by first letter of the mnemonic. |
| `limit` | Page size (default 50, max 200). |
| `offset` | Pagination offset. |

Examples:

```bash
curl 'http://localhost:4000/api/instructions?q=vaddps&limit=5'
curl 'http://localhost:4000/api/instructions?letter=J'
curl  http://localhost:4000/api/instructions/ADD
```

## Project layout

```
.
├── docker-compose.yml          # 3-container orchestration (db, api, frontend)
├── db/init/01-schema.sql       # PostgreSQL schema (auto-loaded by the db container)
├── etl/                        # PDF → structured JSON parser (TypeScript)
│   ├── src/parse.ts            # segments Vol.2 entries; parses all 4 table layouts
│   └── data/instructions.json  # generated seed dataset (the API loads this)
├── api/                        # Express + TypeScript REST API
│   ├── src/{index,db,seed}.ts
│   └── src/routes/instructions.ts
├── frontend/                   # React + TypeScript + Vite SPA (+ nginx config)
│   └── src/{App.tsx,api.ts,pages/*}
├── docs/SCHEMA.md              # data-model documentation
└── IntelSDM/                   # source PDF (not shipped into images)
```

## Regenerating the data

The seed dataset is checked in, so you don't need the PDF to run the app. To
rebuild it from the manual (e.g. after a new SDM release):

```bash
sudo apt-get install -y poppler-utils          # provides pdftotext
pdftotext -layout IntelSDM/325462-*-sdm-*.pdf IntelSDM/sdm.txt
cd etl && npm install && npm run parse          # -> etl/data/instructions.json
```

See [docs/SCHEMA.md](docs/SCHEMA.md) for the data model and the parsing/search
design.

## Data source & disclaimer

All instruction content is extracted from the *Intel® 64 and IA‑32
Architectures Software Developer's Manual, Volume 2 (Instruction Set
Reference)*. Intel® is a trademark of Intel Corporation. This project is an
independent, unofficial reference tool provided for convenience; always consult
the official manual as the authoritative source.

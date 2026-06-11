# Project Specification

## Original request (verbatim)

> Can you read over the pdf in the intel SDM and create a full-stack
> application holding the user-facing assembly programming information
> (especially instruction searching, info, and whatnot), documentation of the
> schema you use (DB container docker, frontend container docker, API container
> docker). Typescript, node.js, express, react, etc. Full-stack application
> that makes this easy to read and has a DB with the info

## Interpreted requirements

1. **Source** — read the Intel SDM PDF (`IntelSDM/`) and extract the
   user-facing assembly programming information from it.
2. **Core feature** — instruction searching and instruction info ("and
   whatnot"): make the x86/x64 instruction reference easy to read and search.
3. **Persistence** — store the extracted information in a database.
4. **Schema documentation** — document the database schema that is used.
5. **Containerization (Docker)** — three containers:
   - Database container
   - API container
   - Frontend container
6. **Stack** — TypeScript, Node.js, Express, React (and related tooling).
7. **Goal** — a full-stack application that makes the information easy to read.

## How the delivered project maps to the spec

| Requirement | Delivered |
| --- | --- |
| Read the Intel SDM PDF | `etl/src/parse.ts` parses Volume 2 (Instruction Set Reference) from the SDM PDF text dump. |
| User-facing assembly info / instruction search & info | React SPA with search, volume/A‑Z filters, and full per-instruction detail (encoding, operands, description, operation, flags, intrinsics, exceptions). |
| Database with the info | PostgreSQL 16; seeded with 768 entries / 1,567 mnemonics / 3,927 encoded forms. |
| Schema documentation | `docs/SCHEMA.md` + `db/init/01-schema.sql`. |
| DB container (Docker) | `db` service — `postgres:16-alpine`. |
| API container (Docker) | `api` service — Node.js + Express + TypeScript (`api/Dockerfile`). |
| Frontend container (Docker) | `frontend` service — React + Vite served by nginx (`frontend/Dockerfile`). |
| TypeScript / Node / Express / React | Used across ETL, API, and frontend. |
| Easy to read, full-stack | Orchestrated via `docker-compose.yml`; see `README.md`. |

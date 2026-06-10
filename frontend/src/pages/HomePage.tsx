import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  getStats,
  searchInstructions,
  type InstructionSummary,
  type SearchResponse,
  type Stats,
} from "../api";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const PAGE_SIZE = 50;

export function HomePage() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const volume = params.get("volume") ?? "";
  const letter = params.get("letter") ?? "";

  const [data, setData] = useState<SearchResponse | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    getStats().then(setStats).catch(() => undefined);
  }, []);

  // Reset pagination whenever the filter changes.
  useEffect(() => setOffset(0), [q, volume, letter]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    searchInstructions({ q, volume, letter, limit: PAGE_SIZE, offset })
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [q, volume, letter, offset]);

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    // Letter and free-text search are mutually exclusive for clarity.
    if (key === "letter") next.delete("q");
    if (key === "q") next.delete("letter");
    setParams(next);
  }

  const isBrowsing = !q && !volume && !letter;

  return (
    <div className="home">
      {stats && (
        <section className="hero">
          <h1>x86 / x64 Assembly Instruction Reference</h1>
          <p className="lead">
            {Number(stats.totals.instructions).toLocaleString()} instruction entries ·{" "}
            {Number(stats.totals.mnemonics).toLocaleString()} mnemonics ·{" "}
            {Number(stats.totals.opcode_forms).toLocaleString()} encoded forms, parsed from the
            Intel® SDM.
          </p>
        </section>
      )}

      <section className="filters">
        <div className="filter-group">
          <span className="filter-label">Volume</span>
          <div className="chips">
            <button className={!volume ? "chip active" : "chip"} onClick={() => setFilter("volume", "")}>
              All
            </button>
            {stats?.byVolume.map((v) => (
              <button
                key={v.volume}
                className={volume === v.volume ? "chip active" : "chip"}
                onClick={() => setFilter("volume", v.volume)}
              >
                {v.volume} ({v.count})
              </button>
            ))}
          </div>
        </div>
        <div className="filter-group">
          <span className="filter-label">Index</span>
          <div className="chips az">
            {LETTERS.map((l) => (
              <button
                key={l}
                className={letter === l ? "chip active" : "chip"}
                onClick={() => setFilter("letter", letter === l ? "" : l)}
              >
                {l}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="results">
        <div className="results-head">
          <h2>
            {q && `Results for “${q}”`}
            {letter && `Instructions starting with “${letter}”`}
            {isBrowsing && "All instructions"}
            {!q && !letter && volume && `Volume ${volume}`}
          </h2>
          {data && <span className="count">{data.total.toLocaleString()} found</span>}
        </div>

        {loading && <p className="muted">Loading…</p>}
        {error && <p className="error">Error: {error}</p>}

        {data && !loading && (
          <>
            <ul className="result-list">
              {data.results.map((r) => (
                <ResultRow key={r.id} item={r} />
              ))}
              {data.results.length === 0 && <li className="muted">No instructions matched.</li>}
            </ul>

            {data.total > PAGE_SIZE && (
              <div className="pager">
                <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
                  ‹ Prev
                </button>
                <span>
                  {offset + 1}–{Math.min(offset + PAGE_SIZE, data.total)} of {data.total}
                </span>
                <button
                  disabled={offset + PAGE_SIZE >= data.total}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  Next ›
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function ResultRow({ item }: { item: InstructionSummary }) {
  return (
    <li className="result-row">
      <Link to={`/instruction/${encodeURIComponent(item.mnemonic)}`}>
        <div className="result-main">
          <code className="mnem">{item.mnemonic}</code>
          <span className="result-title">{item.title}</span>
          {item.volume && <span className="badge">{item.volume}</span>}
        </div>
        {item.summary && <p className="result-summary">{item.summary}…</p>}
      </Link>
    </li>
  );
}

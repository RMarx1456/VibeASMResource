import { Link, Route, Routes, useNavigate } from "react-router-dom";
import { useState } from "react";
import { HomePage } from "./pages/HomePage";
import { DetailPage } from "./pages/DetailPage";
import { AsmPage } from "./pages/AsmPage";

export function App() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    navigate(q ? `/?q=${encodeURIComponent(q)}` : "/");
  }

  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand" onClick={() => setQuery("")}>
          <span className="brand-mark">ASM</span>Resource
        </Link>
        <form className="topsearch" onSubmit={onSubmit}>
          <input
            type="search"
            placeholder="Search instructions (e.g. ADD, vfmadd, jump if...)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search instructions"
          />
          <button type="submit">Search</button>
        </form>
        <Link to="/asm" className="src">
          Assembler / Disassembler
        </Link>
        <a
          className="src"
          href="https://www.intel.com/sdm"
          target="_blank"
          rel="noreferrer"
          title="Source: Intel 64 and IA-32 Architectures Software Developer's Manual"
        >
          Intel® SDM
        </a>
      </header>

      <main className="content">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/instruction/:mnemonic" element={<DetailPage />} />
          <Route path="/asm" element={<AsmPage />} />
        </Routes>
      </main>

      <footer className="footer">
        Data extracted from the Intel® 64 and IA-32 Architectures Software Developer's Manual,
        Volume 2 (Instruction Set Reference). For reference only.
      </footer>
    </div>
  );
}

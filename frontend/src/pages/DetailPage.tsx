import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getInstruction, type InstructionDetail } from "../api";

export function DetailPage() {
  const { mnemonic } = useParams();
  const [data, setData] = useState<InstructionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!mnemonic) return;
    setLoading(true);
    setError(null);
    setData(null);
    getInstruction(mnemonic)
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [mnemonic]);

  if (loading) return <p className="muted">Loading {mnemonic}…</p>;
  if (error) return <p className="error">Error: {error}</p>;
  if (!data) return null;

  const exceptionEntries = Object.entries(data.exceptions ?? {}).filter(([, v]) => v?.trim());

  return (
    <article className="detail">
      <Link to="/" className="back">
        ‹ Back to search
      </Link>

      <header className="detail-head">
        <h1>
          <code>{data.mnemonic}</code> — {data.title}
        </h1>
        <div className="detail-meta">
          {data.volume && <span className="badge">Vol. {data.volume}</span>}
          {data.page && <span className="badge ghost">p. {data.page}</span>}
          {data.mnemonics.length > 1 && (
            <span className="mnem-list">
              Covers: {data.mnemonics.map((m) => <code key={m}>{m}</code>)}
            </span>
          )}
        </div>
      </header>

      {data.opcodes.length > 0 && (
        <Section title="Encoding">
          <div className="table-scroll">
            <table className="opcode-table">
              <thead>
                <tr>
                  <th>Opcode</th>
                  <th>Instruction</th>
                  <th>Op/En</th>
                  <th>64-bit</th>
                  <th>Compat/Leg · CPUID</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {data.opcodes.map((o, i) => (
                  <tr key={i}>
                    <td><code>{o.opcode}</code></td>
                    <td><code>{o.instruction}</code></td>
                    <td>{o.op_en}</td>
                    <td>{o.mode_64bit}</td>
                    <td>{o.compat_leg}</td>
                    <td className="desc-cell">{o.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {data.operandEncodings.length > 0 && (
        <Section title="Operand Encoding">
          <div className="table-scroll">
            <table className="operand-table">
              <thead>
                <tr>
                  <th>Op/En</th>
                  <th>Operands</th>
                </tr>
              </thead>
              <tbody>
                {data.operandEncodings.map((e, i) => (
                  <tr key={i}>
                    <td><code>{e.op_en}</code></td>
                    <td>{e.operands.filter(Boolean).join("  ·  ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {data.description && (
        <Section title="Description">
          <p className="prose">{data.description}</p>
        </Section>
      )}

      {data.operation && (
        <Section title="Operation">
          <pre className="code">{data.operation}</pre>
        </Section>
      )}

      {data.flags_affected && (
        <Section title="Flags Affected">
          <p className="prose">{data.flags_affected}</p>
        </Section>
      )}

      {data.intrinsics && (
        <Section title="Intel C/C++ Compiler Intrinsic Equivalent">
          <pre className="code">{data.intrinsics}</pre>
        </Section>
      )}

      {exceptionEntries.length > 0 && (
        <Section title="Exceptions">
          {exceptionEntries.map(([mode, text]) => (
            <details key={mode} className="exception">
              <summary>{mode}</summary>
              <pre className="code small">{text}</pre>
            </details>
          ))}
        </Section>
      )}
    </article>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

import { useState } from 'react';
import { apiAssemble, type AssembleOutput } from '../../api';
import { ListingPanel } from './ListingPanel';
import { ErrorList } from './ErrorList';

interface Props {
  syntax: 'attasm' | 'intel';
}

const EXAMPLE_ATTASM = `# Simple AT&T example
movq $60, %rax     # syscall: exit
xorq %rdi, %rdi    # exit code 0
syscall
`;

const EXAMPLE_INTEL = `; Simple Intel example
mov rax, 60        ; syscall: exit
xor rdi, rdi       ; exit code 0
syscall
`;

export function AssembleTab({ syntax }: Props) {
  const [source, setSource] = useState('');
  const [baseAddr, setBaseAddr] = useState('0x0000000000000000');
  const [result, setResult] = useState<AssembleOutput | null>(null);
  const [loading, setLoading] = useState(false);

  async function onAssemble() {
    if (!source.trim()) return;
    setLoading(true);
    try {
      const addr = parseInt(baseAddr, 16) || 0;
      const r = await apiAssemble(source, syntax, addr);
      setResult(r);
    } finally {
      setLoading(false);
    }
  }

  function onDownload() {
    if (!result?.ok) return;
    const blob = new Blob([new Uint8Array(result.bytes)], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'output.bin';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function loadExample() {
    setSource(syntax === 'attasm' ? EXAMPLE_ATTASM : EXAMPLE_INTEL);
    setResult(null);
  }

  return (
    <div className="asm-tab">
      <div className="asm-editor-row">
        <div className="asm-editor-header">
          <span className="filter-label">Source</span>
          <button className="chip" onClick={loadExample}>Load example</button>
        </div>
        <textarea
          className="asm-editor"
          value={source}
          onChange={e => setSource(e.target.value)}
          placeholder={syntax === 'attasm'
            ? 'AT&T syntax — e.g.  movq $1, %rax'
            : 'Intel syntax — e.g.  mov rax, 1'}
          rows={14}
          spellCheck={false}
        />
      </div>

      <div className="asm-controls">
        <div className="asm-addr-row">
          <label className="filter-label" htmlFor="base-addr-asm">Base address</label>
          <input
            id="base-addr-asm"
            className="asm-addr-input"
            value={baseAddr}
            onChange={e => setBaseAddr(e.target.value)}
          />
        </div>
        <button
          className="asm-btn-primary"
          onClick={onAssemble}
          disabled={loading || !source.trim()}
        >
          {loading ? 'Assembling…' : 'Assemble'}
        </button>
      </div>

      {result && !result.ok && <ErrorList errors={result.errors} />}

      {result?.ok && (
        <>
          <div className="asm-success-bar">
            <span className="asm-success-msg">
              {result.bytes.length} bytes assembled
            </span>
            <button className="chip" onClick={onDownload}>Download .bin</button>
          </div>
          <ListingPanel listing={result.listing} hex={result.hex} title="Assembly listing" />
        </>
      )}
    </div>
  );
}

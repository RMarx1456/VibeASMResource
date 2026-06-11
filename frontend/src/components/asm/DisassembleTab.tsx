import { useState, useRef } from 'react';
import { apiDisassemble, type DisassembleOutput } from '../../api';
import { ListingPanel } from './ListingPanel';
import { ErrorList } from './ErrorList';

interface Props {
  syntax: 'attasm' | 'intel';
}

export function DisassembleTab({ syntax }: Props) {
  const [hexInput, setHexInput] = useState('');
  const [fileBytes, setFileBytes] = useState<number[] | null>(null);
  const [fileName, setFileName] = useState('');
  const [baseAddr, setBaseAddr] = useState('0x0000000000000000');
  const [startOffset, setStartOffset] = useState('0x0');
  const [result, setResult] = useState<DisassembleOutput | null>(null);
  const [loading, setLoading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const buf = ev.target?.result as ArrayBuffer;
      setFileBytes([...new Uint8Array(buf)]);
      setFileName(f.name);
      setHexInput('');
    };
    reader.readAsArrayBuffer(f);
  }

  async function onDisassemble() {
    let bytes: number[];
    if (fileBytes) {
      bytes = fileBytes;
    } else {
      const h = hexInput.replace(/\s+/g, '');
      if (!/^[0-9a-fA-F]*$/.test(h) || h.length === 0) return;
      bytes = [];
      for (let i = 0; i < h.length; i += 2) bytes.push(parseInt(h.slice(i, i + 2), 16));
    }
    setLoading(true);
    try {
      const r = await apiDisassemble(
        bytes,
        syntax,
        parseInt(baseAddr, 16) || 0,
        parseInt(startOffset, 16) || 0,
        [],
      );
      setResult(r);
    } finally {
      setLoading(false);
    }
  }

  function onCopy() {
    if (result?.ok) navigator.clipboard.writeText(result.text).catch(() => {});
  }

  function onDownload() {
    if (!result?.ok) return;
    const blob = new Blob([result.text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'listing.txt';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const hasInput = fileBytes !== null || hexInput.trim().length > 0;

  return (
    <div className="asm-tab">
      <div className="asm-upload-row">
        <div className="asm-upload-area">
          <input
            ref={fileRef}
            type="file"
            style={{ display: 'none' }}
            onChange={onFile}
          />
          <button className="chip" onClick={() => fileRef.current?.click()}>
            Upload binary
          </button>
          {fileName && <span className="asm-filename">{fileName} ({fileBytes?.length} bytes)</span>}
          {fileBytes && (
            <button className="chip" onClick={() => { setFileBytes(null); setFileName(''); }}>
              Clear
            </button>
          )}
        </div>

        {!fileBytes && (
          <>
            <span className="asm-or">or paste hex</span>
            <textarea
              className="asm-editor asm-hex-input"
              value={hexInput}
              onChange={e => setHexInput(e.target.value)}
              placeholder="48 c7 c0 3c 00 00 00  48 31 ff  0f 05"
              rows={5}
              spellCheck={false}
            />
          </>
        )}
      </div>

      <div className="asm-controls">
        <div className="asm-addr-row">
          <label className="filter-label" htmlFor="base-addr-dis">Base address</label>
          <input id="base-addr-dis" className="asm-addr-input" value={baseAddr} onChange={e => setBaseAddr(e.target.value)} />
        </div>
        <div className="asm-addr-row">
          <label className="filter-label" htmlFor="start-offset">Start offset</label>
          <input id="start-offset" className="asm-addr-input" value={startOffset} onChange={e => setStartOffset(e.target.value)} />
        </div>
        <button
          className="asm-btn-primary"
          onClick={onDisassemble}
          disabled={loading || !hasInput}
        >
          {loading ? 'Disassembling…' : 'Disassemble'}
        </button>
      </div>

      {result && !result.ok && <ErrorList errors={result.errors} />}

      {result?.ok && (
        <>
          <div className="asm-success-bar">
            <span className="asm-success-msg">{result.listing.length} instructions decoded</span>
            <button className="chip" onClick={onCopy}>Copy text</button>
            <button className="chip" onClick={onDownload}>Download listing.txt</button>
          </div>
          <ListingPanel listing={result.listing} title="Disassembly" />
        </>
      )}
    </div>
  );
}

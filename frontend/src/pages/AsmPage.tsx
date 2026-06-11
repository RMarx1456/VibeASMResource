import { useState } from 'react';
import { SyntaxToggle } from '../components/asm/SyntaxToggle';
import { AssembleTab } from '../components/asm/AssembleTab';
import { DisassembleTab } from '../components/asm/DisassembleTab';

type Tab = 'assemble' | 'disassemble';

export function AsmPage() {
  const [syntax, setSyntax] = useState<'attasm' | 'intel'>('attasm');
  const [tab, setTab] = useState<Tab>('assemble');

  return (
    <div className="asm-page">
      <div className="detail-head">
        <h1>Assembler / Disassembler</h1>
        <p className="lead">
          x86-64, 64-bit mode only. Data-driven from the Intel SDM instruction table.
          GNU <code>as</code> is the reference oracle for encoding choices.
        </p>
      </div>

      <div className="asm-toolbar">
        <div className="chips">
          <button
            className={tab === 'assemble' ? 'chip active' : 'chip'}
            onClick={() => setTab('assemble')}
          >
            Assemble
          </button>
          <button
            className={tab === 'disassemble' ? 'chip active' : 'chip'}
            onClick={() => setTab('disassemble')}
          >
            Disassemble
          </button>
        </div>
        <SyntaxToggle value={syntax} onChange={setSyntax} />
      </div>

      <div className="asm-content">
        {tab === 'assemble' && <AssembleTab syntax={syntax} />}
        {tab === 'disassemble' && <DisassembleTab syntax={syntax} />}
      </div>
    </div>
  );
}

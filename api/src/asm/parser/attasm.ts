// AT&T syntax parser.
// Operand order is (src, dst) — we normalize to Intel order (dst, src) in the AST.
// Mnemonic size suffixes: b=8, w=16, l=32, q=64.

import type { Token, StatementNode, OperandNode, ProgramAST, OperandSize, Diagnostic } from '../types';
import { isRegName } from '../regs';

export interface ParseResult {
  ast: ProgramAST;
  errors: Diagnostic[];
}

export function parseAttasm(tokens: Token[]): ParseResult {
  const errors: Diagnostic[] = [];
  const statements: StatementNode[] = [];
  let pos = 0;

  function cur(): Token { return tokens[pos] ?? { kind: 'EOF', text: '', line: 0, col: 0 }; }
  function peek(n = 1): Token { return tokens[pos + n] ?? { kind: 'EOF', text: '', line: 0, col: 0 }; }
  function consume(): Token { return tokens[pos++]; }
  function skip() { pos++; }

  function skipNewlines() { while (cur().kind === 'NEWLINE') skip(); }

  function err(msg: string, tok?: Token): Diagnostic {
    const t = tok ?? cur();
    const d: Diagnostic = { line: t.line, col: t.col, message: msg, severity: 'error' };
    errors.push(d);
    return d;
  }

  function parseNumber(text: string): bigint {
    const t = text.trim();
    if (t.startsWith('0x') || t.startsWith('0X')) return BigInt(t);
    if (t.startsWith('0b') || t.startsWith('0B')) return BigInt(t);
    return BigInt(t);
  }

  function parseImmediate(): OperandNode | null {
    // '$' consumed already; read expression (number, ident, or expr)
    if (cur().kind === 'MINUS') {
      skip();
      if (cur().kind !== 'NUMBER') { err('Expected number after -'); return null; }
      const n = consume();
      return { kind: 'imm', value: -parseNumber(n.text) };
    }
    if (cur().kind === 'NUMBER') {
      const n = consume();
      return { kind: 'imm', value: parseNumber(n.text) };
    }
    if (cur().kind === 'IDENT' || cur().kind === 'DIRECTIVE') {
      const name = consume();
      return { kind: 'label', name: name.text };
    }
    err('Expected immediate value after $');
    return null;
  }

  function parseRegister(): OperandNode | null {
    // '%' consumed already
    if (cur().kind !== 'IDENT') { err('Expected register name after %'); return null; }
    const regTok = consume();
    const name = regTok.text.toLowerCase();
    if (!isRegName(name)) { err(`Unknown register: ${name}`, regTok); return null; }
    return { kind: 'reg', reg: name };
  }

  // AT&T memory: disp(base, index, scale) or disp(%base) or (%base) or disp
  function parseMemory(sizeHint: OperandSize | undefined): OperandNode | null {
    let disp: bigint | undefined;
    let segment: string | undefined;

    // Optional displacement before '('
    if (cur().kind === 'NUMBER') {
      disp = parseNumber(consume().text);
    } else if (cur().kind === 'MINUS') {
      skip();
      if (cur().kind !== 'NUMBER') { err('Expected number'); return null; }
      disp = -parseNumber(consume().text);
    } else if (cur().kind === 'IDENT' || cur().kind === 'DIRECTIVE') {
      // Symbol/local-label used as displacement or standalone reference
      // e.g. "msg(%rip)" or standalone "msg" or ".done"
      if (peek().kind !== 'LPAREN') {
        // Standalone symbol without parentheses — treat as label reference
        const name = consume().text;
        return { kind: 'label', name };
      }
      // Symbol followed by '(' — it's a disp_label + base/index/scale memory ref
      const dispLabelName = consume().text; // consume the symbol
      skip(); // consume '('
      let base: string | undefined;
      let index: string | undefined;
      let scale = 1;
      if (cur().kind === 'PERCENT') {
        skip();
        if (cur().kind === 'IDENT') {
          const r = consume().text.toLowerCase();
          if (isRegName(r)) base = r;
        }
      }
      if (cur().kind === 'COMMA') {
        skip();
        if (cur().kind === 'PERCENT') {
          skip();
          if (cur().kind === 'IDENT') {
            const r = consume().text.toLowerCase();
            if (isRegName(r)) index = r;
          }
        }
        if (cur().kind === 'COMMA') {
          skip();
          if (cur().kind === 'NUMBER') scale = Number(consume().text);
        }
      }
      if (cur().kind !== 'RPAREN') err('Expected )');
      else skip();
      return { kind: 'mem', base, index, scale: scale !== 1 ? scale : undefined, dispLabel: dispLabelName, size: sizeHint, segment };
    }

    if (cur().kind !== 'LPAREN') {
      // No parentheses — this is just a displacement / absolute address
      return { kind: 'mem', disp, size: sizeHint, segment };
    }
    skip(); // consume '('

    let base: string | undefined;
    let index: string | undefined;
    let scale = 1;

    // base register
    if (cur().kind === 'PERCENT') {
      skip(); // '%'
      if (cur().kind === 'IDENT') {
        const r = consume().text.toLowerCase();
        if (isRegName(r)) base = r;
      }
    }

    if (cur().kind === 'COMMA') {
      skip(); // ','
      // index register
      if (cur().kind === 'PERCENT') {
        skip(); // '%'
        if (cur().kind === 'IDENT') {
          const r = consume().text.toLowerCase();
          if (isRegName(r)) index = r;
        }
      }
      if (cur().kind === 'COMMA') {
        skip(); // ','
        if (cur().kind === 'NUMBER') scale = Number(consume().text);
      }
    }

    if (cur().kind !== 'RPAREN') err('Expected )');
    else skip();

    return { kind: 'mem', base, index, scale: scale !== 1 ? scale : undefined, disp, size: sizeHint, segment };
  }

  function parseOperand(sizeHint: OperandSize | undefined): OperandNode | null {
    if (cur().kind === 'DOLLAR') {
      skip();
      return parseImmediate();
    }
    if (cur().kind === 'PERCENT') {
      skip();
      return parseRegister();
    }
    if (cur().kind === 'STAR') {
      // Indirect: *%reg or *mem
      skip();
      if (cur().kind === 'PERCENT') {
        skip();
        if (cur().kind !== 'IDENT') { err('Expected register after *%'); return null; }
        const r = consume().text.toLowerCase();
        return { kind: 'mem', base: r, size: 64 }; // indirect via register = mem[reg]
      }
      return parseMemory(sizeHint);
    }
    // Bare number/ident → could be displacement-only memory or label
    return parseMemory(sizeHint);
  }

  /** Determine the size suffix from an AT&T mnemonic (last char b/w/l/q). */
  function atSizeHint(suffix: string): OperandSize | undefined {
    if (suffix === 'b') return 8;
    if (suffix === 'w') return 16;
    if (suffix === 'l') return 32;
    if (suffix === 'q') return 64;
    return undefined;
  }

  /** Strip the size suffix from an AT&T mnemonic, return [base, sizeHint]. */
  function splitMnemonic(m: string): [string, OperandSize | undefined] {
    // Known mnemonics that end in b/w/l/q but are NOT suffixed (e.g. sub, mul, neg, div, etc.)
    const noSuffix = new Set(['push', 'pop', 'ret', 'nop', 'hlt', 'int', 'syscall', 'leave', 'iret',
      'jmp', 'call', 'loop', 'loope', 'loopne',
      // Jcc
      'ja', 'jae', 'jb', 'jbe', 'je', 'jne', 'jg', 'jge', 'jl', 'jle',
      'jo', 'jno', 'js', 'jns', 'jp', 'jnp', 'jecxz', 'jrcxz',
      // String ops that already have size encoded
      'insb', 'insw', 'insl', 'outsb', 'outsw', 'outsl',
      'stosb', 'stosw', 'stosd', 'stosq',
      'lodsb', 'lodsw', 'lodsd', 'lodsq',
      'movsb', 'movsw', 'movsd', 'movsq',
      'scasb', 'scasw', 'scasd', 'scasq',
      'cmpsb', 'cmpsw', 'cmpsd', 'cmpsq',
    ]);
    const lower = m.toLowerCase();
    if (noSuffix.has(lower)) return [lower.toUpperCase(), undefined];

    // Two-char suffixes like movzbl, movzwl, cbtw, cwtl — skip for now
    if (lower === 'cbtw') return ['CBW', 16];
    if (lower === 'cwtl') return ['CWDE', 32];
    if (lower === 'cltq') return ['CDQE', 64];

    const last = lower[lower.length - 1];
    const hint = atSizeHint(last);
    if (hint !== undefined && lower.length > 1) {
      // Check the base mnemonic without suffix is valid (not a register or keyword)
      return [lower.slice(0, -1).toUpperCase(), hint];
    }
    return [lower.toUpperCase(), undefined];
  }

  function parseLine() {
    skipNewlines();
    const t = cur();

    // Label definition
    if (t.kind === 'LABEL_DEF') {
      skip();
      statements.push({ kind: 'label', name: t.text, line: t.line });
      return;
    }

    // Directives
    if (t.kind === 'DIRECTIVE') {
      skip();
      parseDirective(t);
      return;
    }

    // Instruction
    if (t.kind === 'IDENT') {
      skip();
      const [mnemonic, sizeHint] = splitMnemonic(t.text);
      const prefixes: string[] = [];

      // Handle prefix mnemonics (lock, rep, repne, repnz, repe, repz)
      let actualMnemonic = mnemonic;
      let extraMnemonic: string | null = null;
      const prefixNames = new Set(['LOCK', 'REP', 'REPNE', 'REPNZ', 'REPE', 'REPZ', 'XACQUIRE', 'XRELEASE']);
      if (prefixNames.has(mnemonic) && cur().kind === 'IDENT') {
        prefixes.push(mnemonic);
        const next = consume();
        const [m2] = splitMnemonic(next.text);
        actualMnemonic = m2;
      }

      const operands: OperandNode[] = [];
      // Parse comma-separated operands
      while (cur().kind !== 'NEWLINE' && cur().kind !== 'EOF' && cur().kind !== 'COLON') {
        const op = parseOperand(sizeHint);
        if (op) operands.push(op);
        if (cur().kind === 'COMMA') skip();
        else break;
      }

      // AT&T: operands are (src, dst) for 2-operand instructions → swap to Intel order (dst, src)
      let normalizedOps = operands;
      if (operands.length === 2) {
        normalizedOps = [operands[1], operands[0]];
      }
      // 3-operand: (imm, src, dst) → Intel: (dst, src, imm) — TODO(raymond): verify this for IMUL etc.
      if (operands.length === 3) {
        normalizedOps = [operands[2], operands[1], operands[0]];
      }

      statements.push({ kind: 'instr', mnemonic: actualMnemonic, operands: normalizedOps, prefixes, line: t.line, sizeHint });
      return;
    }

    // Skip unknown line content
    while (cur().kind !== 'NEWLINE' && cur().kind !== 'EOF') skip();
  }

  function parseDirective(dirTok: Token) {
    const dir = dirTok.text.toLowerCase();

    if (dir === 'org' || dir === '.org') {
      if (cur().kind === 'NUMBER') {
        const n = consume();
        statements.push({ kind: 'org', addr: parseNumber(n.text), line: dirTok.line });
      }
      return;
    }

    if (dir === '.byte' || dir === 'db') {
      const values: Array<bigint | number[]> = [];
      while (cur().kind !== 'NEWLINE' && cur().kind !== 'EOF') {
        if (cur().kind === 'NUMBER') values.push(parseNumber(consume().text));
        else if (cur().kind === 'STRING') { values.push([...consume().text].map(c => c.charCodeAt(0))); }
        else if (cur().kind === 'COMMA') skip();
        else break;
      }
      statements.push({ kind: 'data', directive: 'db', values, line: dirTok.line });
      return;
    }
    if (dir === '.word' || dir === 'dw') {
      const values: bigint[] = [];
      while (cur().kind !== 'NEWLINE' && cur().kind !== 'EOF') {
        if (cur().kind === 'NUMBER') values.push(parseNumber(consume().text));
        else if (cur().kind === 'COMMA') skip();
        else break;
      }
      statements.push({ kind: 'data', directive: 'dw', values, line: dirTok.line });
      return;
    }
    if (dir === '.long' || dir === 'dd') {
      const values: bigint[] = [];
      while (cur().kind !== 'NEWLINE' && cur().kind !== 'EOF') {
        if (cur().kind === 'NUMBER') values.push(parseNumber(consume().text));
        else if (cur().kind === 'COMMA') skip();
        else break;
      }
      statements.push({ kind: 'data', directive: 'dd', values, line: dirTok.line });
      return;
    }
    if (dir === '.quad' || dir === 'dq') {
      const values: bigint[] = [];
      while (cur().kind !== 'NEWLINE' && cur().kind !== 'EOF') {
        if (cur().kind === 'NUMBER') values.push(parseNumber(consume().text));
        else if (cur().kind === 'COMMA') skip();
        else break;
      }
      statements.push({ kind: 'data', directive: 'dq', values, line: dirTok.line });
      return;
    }

    // Skip unrecognized directives
    while (cur().kind !== 'NEWLINE' && cur().kind !== 'EOF') skip();
  }

  while (cur().kind !== 'EOF') {
    try { parseLine(); }
    catch (e: unknown) {
      err(e instanceof Error ? e.message : 'Parse error');
      while (cur().kind !== 'NEWLINE' && cur().kind !== 'EOF') skip();
    }
    if (cur().kind === 'NEWLINE') skip();
  }

  return { ast: { syntax: 'attasm', statements }, errors };
}

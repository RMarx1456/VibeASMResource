// Intel syntax parser.
// Operand order is (dst, src) — already in Intel/AST order.
// Memory operands use brackets: [base + index*scale + disp]
// Size qualifiers: byte ptr, word ptr, dword ptr, qword ptr

import type { Token, StatementNode, OperandNode, ProgramAST, OperandSize, Diagnostic } from '../types';
import { isRegName } from '../regs';

export interface ParseResult {
  ast: ProgramAST;
  errors: Diagnostic[];
}

export function parseIntel(tokens: Token[]): ParseResult {
  const errors: Diagnostic[] = [];
  const statements: StatementNode[] = [];
  let pos = 0;

  function cur(): Token { return tokens[pos] ?? { kind: 'EOF', text: '', line: 0, col: 0 }; }
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
    // Handle NASM hex suffix: 0x... or ...h
    if (t.startsWith('0x') || t.startsWith('0X')) return BigInt(t);
    if (t.startsWith('0b') || t.startsWith('0B')) return BigInt(t);
    if (/^[0-9a-fA-F]+h$/i.test(t)) return BigInt('0x' + t.slice(0, -1));
    return BigInt(t);
  }

  // Parse a size qualifier keyword (byte/word/dword/qword [ptr])
  function parseSizeQual(): OperandSize | undefined {
    const t = cur();
    if (t.kind !== 'IDENT') return undefined;
    const lower = t.text.toLowerCase();
    let size: OperandSize | undefined;
    if (lower === 'byte')   size = 8;
    if (lower === 'word')   size = 16;
    if (lower === 'dword')  size = 32;
    if (lower === 'qword')  size = 64;
    if (lower === 'xmmword') size = 128;
    if (lower === 'ymmword') size = 256;
    if (size !== undefined) {
      skip(); // consume 'byte'/'word'/etc.
      if (cur().kind === 'IDENT' && cur().text.toLowerCase() === 'ptr') skip(); // consume 'ptr'
    }
    return size;
  }

  // Parse a memory operand expression after '['.
  function parseMemExpr(explicitSize: OperandSize | undefined): OperandNode {
    let base: string | undefined;
    let index: string | undefined;
    let scale: number | undefined;
    let disp = 0n;
    let segment: string | undefined;

    // Segment override: "fs:" or "gs:"
    if (cur().kind === 'IDENT' && (cur().text.toLowerCase() === 'fs' || cur().text.toLowerCase() === 'gs')) {
      const seg = consume().text.toLowerCase();
      if (cur().kind === 'COLON') skip();
      segment = seg;
    }

    // Parse terms: reg, reg + reg * scale, disp, etc.
    let sign = 1n;
    while (cur().kind !== 'RBRACKET' && cur().kind !== 'EOF') {
      if (cur().kind === 'PLUS')  { skip(); sign = 1n;  continue; }
      if (cur().kind === 'MINUS') { skip(); sign = -1n; continue; }

      if (cur().kind === 'NUMBER') {
        disp += sign * parseNumber(consume().text);
        sign = 1n;
        continue;
      }

      if (cur().kind === 'IDENT') {
        const name = cur().text.toLowerCase();
        if (isRegName(name)) {
          consume();
          // Check for * scale
          if (cur().kind === 'STAR') {
            skip(); // '*'
            let sc = 1;
            if (cur().kind === 'NUMBER') sc = Number(consume().text);
            if (!base) {
              // index * scale without base
              index = name;
              scale = sc;
            } else {
              index = name;
              scale = sc;
            }
          } else {
            if (!base) base = name;
            else { index = name; scale = 1; }
          }
        } else {
          // Symbol displacement
          const sym = consume().text;
          // TODO(raymond): symbol resolution — store as label for now
          disp = sign * 0n; // placeholder
        }
        sign = 1n;
        continue;
      }

      // RIP-relative: [rip + offset]
      if (cur().kind === 'IDENT' && cur().text.toLowerCase() === 'rip') {
        consume();
        base = 'rip';
        sign = 1n;
        continue;
      }

      skip(); // skip unknown tokens inside []
    }

    if (cur().kind === 'RBRACKET') skip();

    return {
      kind: 'mem',
      base: base !== 'rip' ? base : undefined,
      index,
      scale,
      disp: disp !== 0n ? disp : undefined,
      size: explicitSize,
      segment,
    };
  }

  function parseOperand(): OperandNode | null {
    // Size qualifier?
    const sz = parseSizeQual();

    // Memory operand in brackets
    if (cur().kind === 'LBRACKET') {
      skip();
      return parseMemExpr(sz);
    }

    // Register
    if (cur().kind === 'IDENT') {
      const name = cur().text.toLowerCase();
      if (isRegName(name)) {
        consume();
        return { kind: 'reg', reg: name };
      }
      // Immediate label reference
      const sym = consume().text;
      return { kind: 'label', name: sym };
    }

    // Negative immediate
    if (cur().kind === 'MINUS') {
      skip();
      if (cur().kind === 'NUMBER') {
        return { kind: 'imm', value: -parseNumber(consume().text) };
      }
      err('Expected number after -');
      return null;
    }

    // Immediate
    if (cur().kind === 'NUMBER') {
      return { kind: 'imm', value: parseNumber(consume().text) };
    }

    return null;
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

    // Directive
    if (t.kind === 'DIRECTIVE') {
      skip();
      parseDirective(t);
      return;
    }

    // Instruction (mnemonic is an IDENT)
    if (t.kind === 'IDENT') {
      const mnemTok = consume();
      const mnemonic = mnemTok.text.toUpperCase();
      const prefixes: string[] = [];
      let actualMnemonic = mnemonic;

      const prefixNames = new Set(['LOCK', 'REP', 'REPNE', 'REPNZ', 'REPE', 'REPZ', 'XACQUIRE', 'XRELEASE']);
      if (prefixNames.has(mnemonic) && cur().kind === 'IDENT') {
        prefixes.push(mnemonic);
        actualMnemonic = consume().text.toUpperCase();
      }

      const operands: OperandNode[] = [];
      while (cur().kind !== 'NEWLINE' && cur().kind !== 'EOF') {
        const op = parseOperand();
        if (op) operands.push(op);
        else break;
        if (cur().kind === 'COMMA') skip();
        else break;
      }

      statements.push({ kind: 'instr', mnemonic: actualMnemonic, operands, prefixes, line: mnemTok.line });
      return;
    }

    while (cur().kind !== 'NEWLINE' && cur().kind !== 'EOF') skip();
  }

  function parseDirective(dirTok: Token) {
    const dir = dirTok.text.toLowerCase();

    if (dir === 'org') {
      if (cur().kind === 'NUMBER') {
        statements.push({ kind: 'org', addr: parseNumber(consume().text), line: dirTok.line });
      }
      return;
    }

    const dataDir = { db: 'db', dw: 'dw', dd: 'dd', dq: 'dq' } as const;
    const dd = dataDir[dir as keyof typeof dataDir];
    if (dd) {
      const values: Array<bigint | number[]> = [];
      while (cur().kind !== 'NEWLINE' && cur().kind !== 'EOF') {
        if (cur().kind === 'NUMBER') values.push(parseNumber(consume().text));
        else if (cur().kind === 'MINUS') { skip(); values.push(-parseNumber(consume().text)); }
        else if (cur().kind === 'STRING') { values.push([...consume().text].map(c => c.charCodeAt(0))); }
        else if (cur().kind === 'COMMA') skip();
        else break;
      }
      statements.push({ kind: 'data', directive: dd, values, line: dirTok.line });
      return;
    }

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

  return { ast: { syntax: 'intel', statements }, errors };
}

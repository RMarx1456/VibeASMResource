// Tokenizer for both Intel and AT&T syntax.
// The syntax is passed as a hint; the lexer is mostly syntax-agnostic.

import type { Token, TokenKind } from './types';

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0, line = 1, col = 1;

  function ch(): string { return src[pos] ?? ''; }
  function peek(offset = 1): string { return src[pos + offset] ?? ''; }
  function advance(): string {
    const c = src[pos++];
    if (c === '\n') { line++; col = 1; } else col++;
    return c;
  }
  function tok(kind: TokenKind, text: string, l: number, c: number): Token {
    return { kind, text, line: l, col: c };
  }

  while (pos < src.length) {
    const startLine = line, startCol = col;

    // Skip whitespace (not newlines — newlines are significant)
    if (ch() === ' ' || ch() === '\t' || ch() === '\r') { advance(); continue; }

    // Newline
    if (ch() === '\n') { advance(); tokens.push(tok('NEWLINE', '\n', startLine, startCol)); continue; }

    // Comments: ';' (Intel) or '#' (AT&T)
    if (ch() === ';' || ch() === '#') {
      while (pos < src.length && ch() !== '\n') advance();
      continue;
    }

    // String literal
    if (ch() === '"' || ch() === "'") {
      const q = advance();
      let s = '';
      while (pos < src.length && ch() !== q) {
        if (ch() === '\\') { advance(); s += advance(); }
        else s += advance();
      }
      if (ch() === q) advance();
      tokens.push(tok('STRING', s, startLine, startCol));
      continue;
    }

    // Special single characters
    if (ch() === ',') { advance(); tokens.push(tok('COMMA', ',', startLine, startCol)); continue; }
    if (ch() === '[') { advance(); tokens.push(tok('LBRACKET', '[', startLine, startCol)); continue; }
    if (ch() === ']') { advance(); tokens.push(tok('RBRACKET', ']', startLine, startCol)); continue; }
    if (ch() === '(') { advance(); tokens.push(tok('LPAREN', '(', startLine, startCol)); continue; }
    if (ch() === ')') { advance(); tokens.push(tok('RPAREN', ')', startLine, startCol)); continue; }
    if (ch() === '+') { advance(); tokens.push(tok('PLUS', '+', startLine, startCol)); continue; }
    if (ch() === '-') { advance(); tokens.push(tok('MINUS', '-', startLine, startCol)); continue; }
    if (ch() === '*') { advance(); tokens.push(tok('STAR', '*', startLine, startCol)); continue; }
    if (ch() === ':') { advance(); tokens.push(tok('COLON', ':', startLine, startCol)); continue; }
    if (ch() === '%') { advance(); tokens.push(tok('PERCENT', '%', startLine, startCol)); continue; }
    if (ch() === '$') { advance(); tokens.push(tok('DOLLAR', '$', startLine, startCol)); continue; }

    // Numbers: 0x..., 0b..., decimal
    if (ch() >= '0' && ch() <= '9') {
      let num = '';
      if (ch() === '0' && (peek() === 'x' || peek() === 'X')) {
        num += advance() + advance();
        while (pos < src.length && /[0-9a-fA-F]/.test(ch())) num += advance();
      } else if (ch() === '0' && (peek() === 'b' || peek() === 'B')) {
        num += advance() + advance();
        while (pos < src.length && (ch() === '0' || ch() === '1')) num += advance();
      } else {
        while (pos < src.length && ch() >= '0' && ch() <= '9') num += advance();
      }
      tokens.push(tok('NUMBER', num, startLine, startCol));
      continue;
    }

    // Identifiers / keywords / mnemonics
    if (/[a-zA-Z_.]/.test(ch())) {
      let word = '';
      while (pos < src.length && /[a-zA-Z0-9_.]/.test(ch())) word += advance();

      // Check if followed by ':' — then it's a label definition
      if (ch() === ':') {
        advance(); // consume ':'
        tokens.push(tok('LABEL_DEF', word, startLine, startCol));
        continue;
      }

      // Directives start with '.' or are known AT&T directives
      if (word.startsWith('.') || isDirective(word)) {
        tokens.push(tok('DIRECTIVE', word, startLine, startCol));
        continue;
      }

      // Everything else is an IDENT (mnemonics, register names, label refs are all IDENT initially)
      tokens.push(tok('IDENT', word, startLine, startCol));
      continue;
    }

    // Unknown character — skip
    advance();
  }

  tokens.push(tok('EOF', '', line, col));
  return tokens;
}

function isDirective(w: string): boolean {
  const lower = w.toLowerCase();
  return lower === 'db' || lower === 'dw' || lower === 'dd' || lower === 'dq'
      || lower === 'resb' || lower === 'resw' || lower === 'resd' || lower === 'resq'
      || lower === 'times' || lower === 'equ' || lower === 'org'
      || lower === 'section' || lower === 'global' || lower === 'extern';
}

// Basic preprocessor: handles %define/%equ symbol constants and %if/%ifdef.
// Operates on raw source text before lexing, doing simple textual substitution.

export interface PreprocessResult {
  source: string;
  errors: Array<{ line: number; message: string }>;
}

export function preprocess(src: string): PreprocessResult {
  const defines = new Map<string, string>();
  const errors: Array<{ line: number; message: string }> = [];
  const lines = src.split('\n');
  const out: string[] = [];

  // Simple stack-based conditional assembly
  type CondState = 'active' | 'skipping' | 'done';
  const condStack: CondState[] = [];
  function isActive() { return condStack.every(s => s === 'active'); }

  let lineNo = 0;
  for (const rawLine of lines) {
    lineNo++;
    const trimmed = rawLine.trim();

    // %define NAME value
    const defMatch = trimmed.match(/^%define\s+(\w+)\s+(.*)/);
    if (defMatch) {
      if (isActive()) defines.set(defMatch[1], defMatch[2].trim());
      out.push('');
      continue;
    }

    // NAME equ value  (NASM/Intel style)
    const equMatch = trimmed.match(/^(\w+)\s+equ\s+(.*)/i);
    if (equMatch) {
      if (isActive()) defines.set(equMatch[1], equMatch[2].trim());
      out.push('');
      continue;
    }

    // .set NAME, value  (GAS style)
    const setMatch = trimmed.match(/^\.set\s+(\w+)\s*,\s*(.*)/);
    if (setMatch) {
      if (isActive()) defines.set(setMatch[1], setMatch[2].trim());
      out.push('');
      continue;
    }

    // org / .org
    // (passed through; handled in parser)

    // %ifdef NAME
    const ifdefMatch = trimmed.match(/^%ifdef\s+(\w+)/);
    if (ifdefMatch) {
      const name = ifdefMatch[1];
      if (!isActive()) { condStack.push('skipping'); }
      else condStack.push(defines.has(name) ? 'active' : 'skipping');
      out.push('');
      continue;
    }

    // %ifndef NAME
    const ifndefMatch = trimmed.match(/^%ifndef\s+(\w+)/);
    if (ifndefMatch) {
      const name = ifndefMatch[1];
      if (!isActive()) { condStack.push('skipping'); }
      else condStack.push(defines.has(name) ? 'skipping' : 'active');
      out.push('');
      continue;
    }

    // %if <expr>  (basic integer expression)
    const ifMatch = trimmed.match(/^%if\s+(.*)/);
    if (ifMatch) {
      let active = false;
      if (isActive()) {
        try { active = evalExpr(ifMatch[1], defines) !== 0n; }
        catch { errors.push({ line: lineNo, message: `%if expression error: ${ifMatch[1]}` }); }
      }
      condStack.push(isActive() ? (active ? 'active' : 'skipping') : 'skipping');
      out.push('');
      continue;
    }

    // %else
    if (trimmed === '%else') {
      if (condStack.length === 0) { errors.push({ line: lineNo, message: 'Unexpected %else' }); }
      else {
        const top = condStack[condStack.length - 1];
        condStack[condStack.length - 1] = top === 'active' ? 'done' : top === 'skipping' ? 'active' : 'done';
      }
      out.push('');
      continue;
    }

    // %endif
    if (trimmed === '%endif') {
      if (condStack.length === 0) errors.push({ line: lineNo, message: 'Unexpected %endif' });
      else condStack.pop();
      out.push('');
      continue;
    }

    if (!isActive()) { out.push(''); continue; }

    // Substitute defines in the line (whole-word replacement)
    let processed = rawLine;
    for (const [name, value] of defines) {
      processed = processed.replace(new RegExp(`\\b${name}\\b`, 'g'), value);
    }
    out.push(processed);
  }

  if (condStack.length > 0) {
    errors.push({ line: lineNo, message: 'Unterminated conditional block' });
  }

  return { source: out.join('\n'), errors };
}

/** Evaluate a simple constant expression (integers, +, -, *, /, <<, >>). */
function evalExpr(expr: string, defines: Map<string, string>): bigint {
  // Substitute defines
  let e = expr.trim();
  for (const [name, value] of defines) {
    e = e.replace(new RegExp(`\\b${name}\\b`, 'g'), value);
  }
  // Only allow safe arithmetic tokens
  if (!/^[\d\s+\-*/&|^()<>x0-9a-fA-F]+$/.test(e)) throw new Error('Unsafe expression');
  // eslint-disable-next-line no-new-func
  return BigInt(Function(`"use strict"; return (${e})`)());
}

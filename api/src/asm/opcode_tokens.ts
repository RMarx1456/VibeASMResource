// Parses SDM opcode pattern strings into structured tokens.
// e.g. "REX.W + 81 /0 id" → [rexW, byte(0x81), modrm_digit(0), imm(32)]

export type OpcodeToken =
  | { kind: 'prefix_NP' }
  | { kind: 'prefix_66' }
  | { kind: 'prefix_F2' }
  | { kind: 'prefix_F3' }
  | { kind: 'prefix_REXW' }
  | { kind: 'prefix_REXR' }
  | { kind: 'prefix_REXB' }
  | { kind: 'prefix_REX' }
  | { kind: 'byte'; value: number }
  | { kind: 'byte_plus_reg'; base: number; regSize: 8 | 16 | 32 | 64 }
  | { kind: 'modrm_r' }
  | { kind: 'modrm_digit'; digit: number }
  | { kind: 'imm'; size: 8 | 16 | 32 | 64 }
  | { kind: 'rel'; size: 8 | 32 }
  | { kind: 'moffs'; size: 16 | 32 | 64 }
  | { kind: 'vex'; raw: string }
  | { kind: 'evex'; raw: string };

export function parseOpcodeString(raw: string): OpcodeToken[] {
  // Normalize: collapse whitespace, remove trailing footnote digits like ¹²
  const s = raw.replace(/[¹²³⁴]+$/, '').replace(/¹|²|³/g, '').trim();
  const parts = s.split(/\s+/);
  const result: OpcodeToken[] = [];
  let i = 0;

  while (i < parts.length) {
    const part = parts[i];

    if (part === 'NP')    { result.push({ kind: 'prefix_NP' }); i++; continue; }
    if (part === '66')    { result.push({ kind: 'prefix_66' }); i++; continue; }
    if (part === 'F2')    { result.push({ kind: 'prefix_F2' }); i++; continue; }
    if (part === 'F3')    { result.push({ kind: 'prefix_F3' }); i++; continue; }
    if (part === 'REX.W') { result.push({ kind: 'prefix_REXW' }); i++; if (parts[i] === '+') i++; continue; }
    if (part === 'REX.R') { result.push({ kind: 'prefix_REXR' }); i++; if (parts[i] === '+') i++; continue; }
    if (part === 'REX.B') { result.push({ kind: 'prefix_REXB' }); i++; if (parts[i] === '+') i++; continue; }
    if (part === 'REX')   { result.push({ kind: 'prefix_REX'  }); i++; if (parts[i] === '+') i++; continue; }

    if (/^VEX\./.test(part))  { result.push({ kind: 'vex',  raw: part }); i++; continue; }
    if (/^EVEX\./.test(part)) { result.push({ kind: 'evex', raw: part }); i++; continue; }

    if (part === '/r')            { result.push({ kind: 'modrm_r' }); i++; continue; }
    if (/^\/[0-7]$/.test(part))  { result.push({ kind: 'modrm_digit', digit: parseInt(part[1]) }); i++; continue; }

    if (part === 'ib') { result.push({ kind: 'imm', size: 8  }); i++; continue; }
    if (part === 'iw') { result.push({ kind: 'imm', size: 16 }); i++; continue; }
    if (part === 'id') { result.push({ kind: 'imm', size: 32 }); i++; continue; }
    if (part === 'io') { result.push({ kind: 'imm', size: 64 }); i++; continue; }
    if (part === 'cb') { result.push({ kind: 'rel', size: 8  }); i++; continue; }
    if (part === 'cd') { result.push({ kind: 'rel', size: 32 }); i++; continue; }
    if (part === 'mo') { result.push({ kind: 'moffs', size: 16 }); i++; continue; } // moffs16
    if (part === 'mw') { result.push({ kind: 'moffs', size: 32 }); i++; continue; } // moffs32
    if (part === 'md') { result.push({ kind: 'moffs', size: 64 }); i++; continue; } // moffs64

    // Byte+reg in opcode byte: "50+rd", "B8+rd", "B0+rb"
    const byteRegJoined = part.match(/^([0-9A-Fa-f]{2})\+r([bwdo])$/);
    if (byteRegJoined) {
      const base = parseInt(byteRegJoined[1], 16);
      const sz: 8|16|32|64 = byteRegJoined[2] === 'b' ? 8 : byteRegJoined[2] === 'w' ? 16 : byteRegJoined[2] === 'd' ? 32 : 64;
      result.push({ kind: 'byte_plus_reg', base, regSize: sz });
      i++; continue;
    }

    // "B8+" followed by separate "rd" token (space between)
    if (/^[0-9A-Fa-f]{2}\+$/.test(part) && i + 1 < parts.length && /^r[bwdo]$/.test(parts[i + 1])) {
      const base = parseInt(part.slice(0, 2), 16);
      const sz: 8|16|32|64 = parts[i+1][1] === 'b' ? 8 : parts[i+1][1] === 'w' ? 16 : parts[i+1][1] === 'd' ? 32 : 64;
      result.push({ kind: 'byte_plus_reg', base, regSize: sz });
      i += 2; continue;
    }

    // Plain hex byte: "00", "0F", "C7"
    if (/^[0-9A-Fa-f]{2}$/.test(part)) {
      result.push({ kind: 'byte', value: parseInt(part, 16) });
      i++; continue;
    }

    // Skip unknown / separator tokens (e.g. standalone '+')
    i++;
  }

  return result;
}

/** True if this opcode string uses VEX or EVEX encoding (out of MVP scope). */
export function isVexOrEvex(raw: string): boolean {
  return /^\s*(VEX|EVEX)\./.test(raw);
}

/** Extract mandatory prefix byte (66/F2/F3) from parsed tokens, if any. */
export function mandatoryPrefix(tokens: OpcodeToken[]): number | null {
  for (const t of tokens) {
    if (t.kind === 'prefix_66') return 0x66;
    if (t.kind === 'prefix_F2') return 0xF2;
    if (t.kind === 'prefix_F3') return 0xF3;
    if (t.kind === 'prefix_NP') return null;
    // REX.W, REXR, REXB are not mandatory prefixes in this sense
  }
  return null;
}

/** Collect the opcode bytes (non-prefix, non-suffix tokens) in order. */
export function opcodeBytes(tokens: OpcodeToken[]): number[] {
  const bytes: number[] = [];
  for (const t of tokens) {
    if (t.kind === 'byte') bytes.push(t.value);
    if (t.kind === 'byte_plus_reg') bytes.push(t.base); // base byte for indexing
  }
  return bytes;
}

/** The /digit for ModRM extension, or -1 if /r or absent. */
export function modrDigit(tokens: OpcodeToken[]): number {
  for (const t of tokens) {
    if (t.kind === 'modrm_digit') return t.digit;
  }
  return -1;
}

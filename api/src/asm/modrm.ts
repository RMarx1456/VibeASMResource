// ModRM / SIB / REX byte emission helpers.
// All functions return byte arrays to be concatenated into the output stream.

import type { OperandNode, OperandSize } from './types';
import { lookupReg } from './regs';

export interface ModRMResult {
  rex: number;     // REX byte (0 = not needed)
  bytes: number[]; // ModRM [+ SIB] [+ displacement]
}

/**
 * Emit ModRM + optional SIB + displacement for a memory operand.
 * `regField` is the reg field value (0-15, can be an opcode extension digit or a source register code).
 * `ripPC` must be set when mem.base === 'rip': it is (instrStartPC + bytesSoFarBeforeModRM),
 * used to compute the 4-byte PC-relative displacement.
 */
export function encodeModRMMem(
  mem: Extract<OperandNode, { kind: 'mem' }>,
  regField: number,
  rexW: boolean,
  ripPC = 0,
): ModRMResult {
  let rex = rexW ? 0x48 : 0;

  // RIP-relative addressing: MOD=00, RM=101, no SIB, 4-byte relative displacement.
  if (mem.base === 'rip') {
    if (regField >= 8) rex |= 0x44; // REX.R
    const modrm = (0 << 6) | ((regField & 7) << 3) | 5;
    // ripPC = PC of the ModRM byte; instrEnd = ripPC + 1 (ModRM) + 4 (disp32)
    const instrEnd = ripPC + 5;
    const d = Number(mem.disp ?? 0n) - instrEnd;
    return {
      rex: rex === 0x40 ? 0 : rex,
      bytes: [modrm, d & 0xFF, (d >> 8) & 0xFF, (d >> 16) & 0xFF, (d >> 24) & 0xFF],
    };
  }

  const dispBytes: number[] = [];
  let mod: number;
  let rm: number;
  let sibBytes: number[] | null = null;

  const baseReg = mem.base ? lookupReg(mem.base) : undefined;
  const indexReg = mem.index ? lookupReg(mem.index) : undefined;
  const baseCode = baseReg ? baseReg.code : 5; // disp32 if no base
  const indexCode = indexReg ? indexReg.code : 4; // 4 = no index in SIB

  // REX.B extends ModRM.rm (base reg)
  if (baseReg && baseReg.code >= 8)  rex |= 0x41; // REX.B
  // REX.X extends SIB.index
  if (indexReg && indexReg.code >= 8) rex |= 0x42; // REX.X
  // REX.R extends reg field
  if (regField >= 8) rex |= 0x44; // REX.R

  const disp = mem.disp ?? 0n;

  // Determine mod and displacement size
  if (!mem.base) {
    // Disp32 only (no base). Use SIB with base=5, index=4 convention.
    mod = 0;
    rm = 4; // forces SIB
    sibBytes = [sib(0, 4, 5)]; // scale=0, index=none(4), base=disp32-only(5)
    dispBytes.push(...encodeDisp32(disp));
  } else if (disp === 0n && (baseCode & 7) !== 5) {
    // mod=0, no displacement. rbp/r13 (code&7==5) always need at least disp8.
    mod = 0;
    rm = baseCode & 7;
    if (rm === 4) sibBytes = [sib(scaleEnc(mem.scale ?? 1), indexCode & 7, baseCode & 7)];
  } else if (disp >= -128n && disp <= 127n) {
    mod = 1;
    rm = baseCode & 7;
    if (rm === 4) sibBytes = [sib(scaleEnc(mem.scale ?? 1), indexCode & 7, baseCode & 7)];
    dispBytes.push(Number(disp & 0xFFn));
  } else {
    mod = 2;
    rm = baseCode & 7;
    if (rm === 4) sibBytes = [sib(scaleEnc(mem.scale ?? 1), indexCode & 7, baseCode & 7)];
    dispBytes.push(...encodeDisp32(disp));
  }

  // If we have an index register, we need SIB regardless
  if (mem.index && rm !== 4) {
    rm = 4; // SIB follows
    sibBytes = [sib(scaleEnc(mem.scale ?? 1), indexCode & 7, baseCode & 7)];
  }

  const modrm = ((mod & 3) << 6) | ((regField & 7) << 3) | (rm & 7);
  const bytes: number[] = [modrm, ...(sibBytes ?? []), ...dispBytes];

  return { rex: rex === 0x40 ? 0 : rex, bytes };
}

/** Emit ModRM for register-direct operand (mod=3). */
export function encodeModRMReg(
  rmRegCode: number,
  regField: number,
  rexW: boolean,
): ModRMResult {
  let rex = rexW ? 0x48 : 0;
  if (rmRegCode >= 8) rex |= 0x41; // REX.B
  if (regField >= 8)  rex |= 0x44; // REX.R

  const modrm = 0b11000000 | ((regField & 7) << 3) | (rmRegCode & 7);
  return { rex: rex === 0x40 ? 0 : rex, bytes: [modrm] };
}

function sib(scale: number, index: number, base: number): number {
  return ((scale & 3) << 6) | ((index & 7) << 3) | (base & 7);
}

function scaleEnc(scale: number): number {
  if (scale <= 1) return 0;
  if (scale === 2) return 1;
  if (scale === 4) return 2;
  return 3; // 8
}

function encodeDisp32(disp: bigint): number[] {
  const d = Number(BigInt.asIntN(32, disp));
  return [(d) & 0xFF, (d >> 8) & 0xFF, (d >> 16) & 0xFF, (d >> 24) & 0xFF];
}

export function encodeImm(value: bigint, size: 8 | 16 | 32 | 64): number[] {
  const out: number[] = [];
  let v = value;
  const bytes = size >> 3;
  for (let b = 0; b < bytes; b++) {
    out.push(Number(v & 0xFFn));
    v >>= 8n;
  }
  return out;
}

export function encodeRel(offset: number, size: 8 | 32): number[] {
  if (size === 8) return [offset & 0xFF];
  return [(offset) & 0xFF, (offset >> 8) & 0xFF, (offset >> 16) & 0xFF, (offset >> 24) & 0xFF];
}

/** Merge two REX bytes (bitwise OR of the non-40h bits). */
export function mergeRex(a: number, b: number): number {
  if (a === 0 && b === 0) return 0;
  const base = 0x40;
  return base | (a & 0x0F) | (b & 0x0F);
}

/** Return true if the immediate fits as a sign-extended 8-bit value. */
export function fitsImm8(value: bigint): boolean {
  return value >= -128n && value <= 127n;
}

/** Return true if the immediate fits as a sign-extended 32-bit value. */
export function fitsImm32(value: bigint): boolean {
  return value >= -2147483648n && value <= 2147483647n;
}

/** Compute operand size from register name (for size disambiguation). */
export function regSize(name: string): OperandSize | undefined {
  return lookupReg(name)?.size as OperandSize | undefined;
}

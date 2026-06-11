import type { OperandSize } from './types';

export interface RegInfo {
  code: number;
  size: OperandSize;
  highByte: boolean; // ah/bh/ch/dh — incompatible with REX prefix
}

const REGS: Record<string, RegInfo> = {
  // 64-bit
  rax: { code: 0,  size: 64, highByte: false },
  rcx: { code: 1,  size: 64, highByte: false },
  rdx: { code: 2,  size: 64, highByte: false },
  rbx: { code: 3,  size: 64, highByte: false },
  rsp: { code: 4,  size: 64, highByte: false },
  rbp: { code: 5,  size: 64, highByte: false },
  rsi: { code: 6,  size: 64, highByte: false },
  rdi: { code: 7,  size: 64, highByte: false },
  r8:  { code: 8,  size: 64, highByte: false },
  r9:  { code: 9,  size: 64, highByte: false },
  r10: { code: 10, size: 64, highByte: false },
  r11: { code: 11, size: 64, highByte: false },
  r12: { code: 12, size: 64, highByte: false },
  r13: { code: 13, size: 64, highByte: false },
  r14: { code: 14, size: 64, highByte: false },
  r15: { code: 15, size: 64, highByte: false },
  // 32-bit
  eax:  { code: 0,  size: 32, highByte: false },
  ecx:  { code: 1,  size: 32, highByte: false },
  edx:  { code: 2,  size: 32, highByte: false },
  ebx:  { code: 3,  size: 32, highByte: false },
  esp:  { code: 4,  size: 32, highByte: false },
  ebp:  { code: 5,  size: 32, highByte: false },
  esi:  { code: 6,  size: 32, highByte: false },
  edi:  { code: 7,  size: 32, highByte: false },
  r8d:  { code: 8,  size: 32, highByte: false },
  r9d:  { code: 9,  size: 32, highByte: false },
  r10d: { code: 10, size: 32, highByte: false },
  r11d: { code: 11, size: 32, highByte: false },
  r12d: { code: 12, size: 32, highByte: false },
  r13d: { code: 13, size: 32, highByte: false },
  r14d: { code: 14, size: 32, highByte: false },
  r15d: { code: 15, size: 32, highByte: false },
  // 16-bit
  ax:   { code: 0,  size: 16, highByte: false },
  cx:   { code: 1,  size: 16, highByte: false },
  dx:   { code: 2,  size: 16, highByte: false },
  bx:   { code: 3,  size: 16, highByte: false },
  sp:   { code: 4,  size: 16, highByte: false },
  bp:   { code: 5,  size: 16, highByte: false },
  si:   { code: 6,  size: 16, highByte: false },
  di:   { code: 7,  size: 16, highByte: false },
  r8w:  { code: 8,  size: 16, highByte: false },
  r9w:  { code: 9,  size: 16, highByte: false },
  r10w: { code: 10, size: 16, highByte: false },
  r11w: { code: 11, size: 16, highByte: false },
  r12w: { code: 12, size: 16, highByte: false },
  r13w: { code: 13, size: 16, highByte: false },
  r14w: { code: 14, size: 16, highByte: false },
  r15w: { code: 15, size: 16, highByte: false },
  // 8-bit
  al:   { code: 0,  size: 8, highByte: false },
  cl:   { code: 1,  size: 8, highByte: false },
  dl:   { code: 2,  size: 8, highByte: false },
  bl:   { code: 3,  size: 8, highByte: false },
  spl:  { code: 4,  size: 8, highByte: false },
  bpl:  { code: 5,  size: 8, highByte: false },
  sil:  { code: 6,  size: 8, highByte: false },
  dil:  { code: 7,  size: 8, highByte: false },
  r8b:  { code: 8,  size: 8, highByte: false },
  r9b:  { code: 9,  size: 8, highByte: false },
  r10b: { code: 10, size: 8, highByte: false },
  r11b: { code: 11, size: 8, highByte: false },
  r12b: { code: 12, size: 8, highByte: false },
  r13b: { code: 13, size: 8, highByte: false },
  r14b: { code: 14, size: 8, highByte: false },
  r15b: { code: 15, size: 8, highByte: false },
  // 8-bit high (incompatible with any REX prefix)
  ah:   { code: 4,  size: 8, highByte: true },
  ch:   { code: 5,  size: 8, highByte: true },
  dh:   { code: 6,  size: 8, highByte: true },
  bh:   { code: 7,  size: 8, highByte: true },
  // XMM
  xmm0:  { code: 0,  size: 128, highByte: false },
  xmm1:  { code: 1,  size: 128, highByte: false },
  xmm2:  { code: 2,  size: 128, highByte: false },
  xmm3:  { code: 3,  size: 128, highByte: false },
  xmm4:  { code: 4,  size: 128, highByte: false },
  xmm5:  { code: 5,  size: 128, highByte: false },
  xmm6:  { code: 6,  size: 128, highByte: false },
  xmm7:  { code: 7,  size: 128, highByte: false },
  xmm8:  { code: 8,  size: 128, highByte: false },
  xmm9:  { code: 9,  size: 128, highByte: false },
  xmm10: { code: 10, size: 128, highByte: false },
  xmm11: { code: 11, size: 128, highByte: false },
  xmm12: { code: 12, size: 128, highByte: false },
  xmm13: { code: 13, size: 128, highByte: false },
  xmm14: { code: 14, size: 128, highByte: false },
  xmm15: { code: 15, size: 128, highByte: false },
  // RIP pseudo-register (only valid as base for RIP-relative memory: mod=00, rm=101)
  rip:   { code: 255, size: 64, highByte: false },
  // YMM
  ymm0:  { code: 0,  size: 256, highByte: false },
  ymm1:  { code: 1,  size: 256, highByte: false },
  ymm2:  { code: 2,  size: 256, highByte: false },
  ymm3:  { code: 3,  size: 256, highByte: false },
  ymm4:  { code: 4,  size: 256, highByte: false },
  ymm5:  { code: 5,  size: 256, highByte: false },
  ymm6:  { code: 6,  size: 256, highByte: false },
  ymm7:  { code: 7,  size: 256, highByte: false },
  ymm8:  { code: 8,  size: 256, highByte: false },
  ymm9:  { code: 9,  size: 256, highByte: false },
  ymm10: { code: 10, size: 256, highByte: false },
  ymm11: { code: 11, size: 256, highByte: false },
  ymm12: { code: 12, size: 256, highByte: false },
  ymm13: { code: 13, size: 256, highByte: false },
  ymm14: { code: 14, size: 256, highByte: false },
  ymm15: { code: 15, size: 256, highByte: false },
};

export function lookupReg(name: string): RegInfo | undefined {
  return REGS[name.toLowerCase()];
}

export function isRegName(name: string): boolean {
  return name.toLowerCase() in REGS;
}

// Canonical 64-bit name for a register code (for disassembler output)
const REG64 = ['rax','rcx','rdx','rbx','rsp','rbp','rsi','rdi',
                'r8','r9','r10','r11','r12','r13','r14','r15'];
const REG32 = ['eax','ecx','edx','ebx','esp','ebp','esi','edi',
                'r8d','r9d','r10d','r11d','r12d','r13d','r14d','r15d'];
const REG16 = ['ax','cx','dx','bx','sp','bp','si','di',
                'r8w','r9w','r10w','r11w','r12w','r13w','r14w','r15w'];
const REG8L = ['al','cl','dl','bl','spl','bpl','sil','dil',
                'r8b','r9b','r10b','r11b','r12b','r13b','r14b','r15b'];
const REG8H = ['','','','','ah','ch','dh','bh'];

export function regName(code: number, size: OperandSize, rex: boolean): string {
  const c = code & 0xF;
  if (size === 64) return REG64[c] ?? `r${c}`;
  if (size === 32) return REG32[c] ?? `r${c}d`;
  if (size === 16) return REG16[c] ?? `r${c}w`;
  if (size === 8) {
    if (!rex && c >= 4 && c <= 7) return REG8H[c];
    return REG8L[c] ?? `r${c}b`;
  }
  if (size === 128) return `xmm${c}`;
  if (size === 256) return `ymm${c}`;
  return `reg${c}`;
}

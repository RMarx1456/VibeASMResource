import { Router } from 'express';
import type { OpcodeIndex } from '../asm/index';
import { assemble, disassemble } from '../asm/index';

export function makeAsmRouter(index: OpcodeIndex): Router {
  const router = Router();

  /** POST /api/assemble */
  router.post('/assemble', (req, res) => {
    const { source, syntax, baseAddr } = req.body as Record<string, unknown>;

    if (typeof source !== 'string' || !source.trim()) {
      return res.status(400).json({ ok: false, errors: [{ message: 'source is required', severity: 'error' }] });
    }
    if (source.length > 65536) {
      return res.status(400).json({ ok: false, errors: [{ message: 'source exceeds 64 KiB', severity: 'error' }] });
    }
    if (syntax !== undefined && syntax !== 'attasm' && syntax !== 'intel') {
      return res.status(400).json({ ok: false, errors: [{ message: 'syntax must be "attasm" or "intel"', severity: 'error' }] });
    }

    const result = assemble(source, index, {
      syntax: (syntax as 'attasm' | 'intel' | undefined) ?? 'attasm',
      baseAddr: typeof baseAddr === 'number' ? baseAddr : 0,
    });

    if (!result.ok) {
      return res.status(422).json(result);
    }

    const hex = result.bytes.map(b => b.toString(16).padStart(2, '0')).join('');
    return res.json({
      ok: true,
      hex,
      bytes: result.bytes,
      listing: result.listing.map(l => ({
        address: l.address,
        bytes: l.bytes.map(b => b.toString(16).padStart(2, '0')).join(' '),
        source: l.source,
      })),
    });
  });

  /** POST /api/disassemble */
  router.post('/disassemble', (req, res) => {
    const { hex, bytes, syntax, baseAddr, startOffset, dataRegions } = req.body as Record<string, unknown>;

    let inputBytes: number[];

    if (typeof hex === 'string') {
      const h = hex.replace(/\s+/g, '');
      if (!/^[0-9a-fA-F]*$/.test(h)) {
        return res.status(400).json({ ok: false, errors: [{ message: 'hex contains invalid characters', severity: 'error' }] });
      }
      if (h.length > 8 * 1024 * 1024) {
        return res.status(400).json({ ok: false, errors: [{ message: 'input exceeds 4 MiB', severity: 'error' }] });
      }
      inputBytes = [];
      for (let i = 0; i < h.length; i += 2) inputBytes.push(parseInt(h.slice(i, i + 2), 16));
    } else if (Array.isArray(bytes)) {
      inputBytes = bytes.map(Number);
    } else {
      return res.status(400).json({ ok: false, errors: [{ message: 'hex or bytes is required', severity: 'error' }] });
    }

    if (syntax !== undefined && syntax !== 'attasm' && syntax !== 'intel') {
      return res.status(400).json({ ok: false, errors: [{ message: 'syntax must be "attasm" or "intel"', severity: 'error' }] });
    }

    const result = disassemble(inputBytes, index, {
      syntax: (syntax as 'attasm' | 'intel' | undefined) ?? 'attasm',
      baseAddr: typeof baseAddr === 'number' ? baseAddr : 0,
      startOffset: typeof startOffset === 'number' ? startOffset : 0,
      dataRegions: Array.isArray(dataRegions)
        ? (dataRegions as Array<{ start: number; end: number }>)
        : [],
    });

    if (!result.ok) {
      return res.status(422).json(result);
    }

    return res.json({
      ok: true,
      text: result.text,
      listing: result.listing.map(l => ({
        address: l.address,
        bytes: l.bytes.map(b => b.toString(16).padStart(2, '0')).join(' '),
        source: l.source,
      })),
    });
  });

  return router;
}

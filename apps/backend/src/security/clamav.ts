import { connect } from 'node:net';
import type { Config } from '../lib/config.js';
import { AppError } from '../lib/errors.js';

export interface ScanResult { status: 'clean' | 'infected' | 'error' | 'skipped'; detail?: string }

/** Scans bytes with a ClamAV daemon (clamd INSTREAM). Without CLAMAV_HOST configured, returns "skipped". */
export function scanBytes(cfg: Config, data: Buffer, timeoutMs = 30_000): Promise<ScanResult> {
  const c = cfg.clamav;
  if (!c) return Promise.resolve({ status: 'skipped' });
  return new Promise((resolve) => {
    const sock = connect({ host: c.host, port: c.port });
    let reply = '';
    let done = false;
    const finish = (r: ScanResult) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(timeoutMs, () => finish({ status: 'error', detail: 'scanner timed out' }));
    sock.on('error', (e) => finish({ status: 'error', detail: `scanner unreachable: ${e.message}`.slice(0, 200) }));
    sock.on('data', (d) => { reply += d.toString('utf8'); });
    sock.on('end', () => {
      const text = reply.replace(/\0/g, '').trim();
      const found = /^stream: (.+) FOUND$/m.exec(text);
      if (found) finish({ status: 'infected', detail: found[1]!.slice(0, 200) });
      else if (/^stream: OK$/m.test(text)) finish({ status: 'clean' });
      else finish({ status: 'error', detail: (text || 'no answer from scanner').slice(0, 200) });
    });
    sock.on('connect', () => {
      sock.write('zINSTREAM\0');
      const CHUNK = 64 * 1024;
      for (let i = 0; i < data.length; i += CHUNK) {
        const part = data.subarray(i, i + CHUNK);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(part.length);
        sock.write(len);
        sock.write(part);
      }
      sock.write(Buffer.alloc(4)); // zero length: end of stream
    });
  });
}

/** Throws when malware is found, or when the scanner is required but unavailable. */
export function enforceScan(cfg: Config, r: ScanResult, what: string) {
  if (r.status === 'infected') {
    throw new AppError(422, 'malware_detected', `The virus scanner found malware in ${what} (${r.detail}). It was blocked.`, { signature: r.detail });
  }
  if (r.status === 'error' && cfg.clamav?.required) {
    throw new AppError(503, 'scanner_unavailable', 'The virus scanner is not available right now. Try again in a few minutes.');
  }
}

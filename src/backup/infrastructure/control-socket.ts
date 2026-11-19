import { chmodSync, rmSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import type { Logger } from '../../shared/logger.js';

/**
 * A local Unix socket (mode 0600, in the 0700 backup directory) through which
 * the CLI asks the running gateway to back up, list or restore. Restore has
 * to run inside the gateway: only its brain registry can stop a brain's child
 * and hold requests while the file is swapped. One JSON request per
 * connection, one JSON response.
 */
export type ControlRequest =
  | { op: 'backup' }
  | { op: 'list' }
  | { op: 'restore'; brain: string; snapshot: string };

export interface ControlHandlers {
  runAll(): Promise<unknown>;
  listAll(): unknown;
  restoreBrain(slug: string, id: string): Promise<void>;
}

const MAX_REQUEST_BYTES = 4096;

async function handle(request: unknown, handlers: ControlHandlers): Promise<unknown> {
  const req = (request ?? {}) as Partial<ControlRequest> & { brain?: unknown; snapshot?: unknown };
  switch (req.op) {
    case 'backup':
      return handlers.runAll();
    case 'list':
      return handlers.listAll();
    case 'restore':
      if (typeof req.brain !== 'string' || typeof req.snapshot !== 'string') throw new Error('restore needs a brain and a snapshot');
      await handlers.restoreBrain(req.brain, req.snapshot);
      return { restored: req.brain, snapshot: req.snapshot };
    default:
      throw new Error(`unknown operation: ${JSON.stringify(req.op)}`);
  }
}

export async function serveBackupControl(path: string, handlers: ControlHandlers, logger: Logger): Promise<{ close(): Promise<void> }> {
  // A socket file left by a gateway that did not shut down cleanly.
  rmSync(path, { force: true });
  const server = createServer(socket => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', () => undefined);
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > MAX_REQUEST_BYTES) socket.destroy();
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      socket.removeAllListeners('data');
      void (async () => {
        let response: unknown;
        try {
          response = { ok: true, result: await handle(JSON.parse(line), handlers) };
        } catch (error) {
          response = { ok: false, error: (error as Error).message };
        }
        socket.end(`${JSON.stringify(response)}\n`);
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => resolve());
  });
  chmodSync(path, 0o600);
  logger.info('Backup control socket listening', { path });
  return {
    close: () => new Promise<void>(resolve => server.close(() => { rmSync(path, { force: true }); resolve(); }))
  };
}

/** Sends one request to the gateway. Rejects with `code` ENOENT/ECONNREFUSED when no gateway is listening. */
export function callBackupControl(path: string, request: ControlRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.on('data', chunk => { buffer += chunk; });
    socket.on('end', () => {
      try {
        const response = JSON.parse(buffer) as { ok: boolean; result?: unknown; error?: string };
        if (response.ok) resolve(response.result);
        else reject(new Error(response.error ?? 'request failed'));
      } catch {
        reject(new Error('the gateway closed the control connection without an answer'));
      }
    });
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
  });
}

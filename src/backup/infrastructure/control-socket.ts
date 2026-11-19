import { randomBytes } from 'node:crypto';
import { chmodSync, renameSync, rmSync, statSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import type { Logger } from '../../shared/logger.js';

/**
 * A local Unix socket (mode 0600, in the 0700 backup directory) through which
 * the CLI asks the running gateway to back up, list or restore. It relies on
 * filesystem permissions: anyone running as the gateway's UID (e.g. `docker
 * exec` into the container) is trusted, as they can read the data anyway. Restore has
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
const DEFAULT_IDLE_TIMEOUT_MS = 10_000;
/** `sun_path` holds 108 bytes on Linux (104 on macOS), terminating NUL included. */
const MAX_SOCKET_PATH_BYTES = 103;

function checkPathLength(path: string): void {
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES) {
    const error = new Error(`control socket path is too long for a Unix socket (${Buffer.byteLength(path)} > ${MAX_SOCKET_PATH_BYTES} bytes): ${path}; use a shorter BACKUP_DIR`) as NodeJS.ErrnoException;
    error.code = 'ENAMETOOLONG';
    throw error;
  }
}

function inode(path: string): number | undefined {
  try {
    return statSync(path).ino;
  } catch {
    return undefined;
  }
}

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

/**
 * Listens on `path`. The socket is bound under a temporary name (with a
 * 0177 umask, so it is never reachable by others) and renamed over `path`:
 * a newer gateway takes over from an older one (rolling deploy) without
 * deleting anything, and `close()` removes `path` only while it is still this
 * gateway's socket (same inode).
 */
export async function serveBackupControl(
  path: string,
  handlers: ControlHandlers,
  logger: Logger,
  options: { idleTimeoutMs?: number } = {}
): Promise<{ close(): Promise<void> }> {
  checkPathLength(path);
  const temporary = `${path}.${randomBytes(4).toString('hex')}`;
  checkPathLength(temporary);
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const server = createServer(socket => {
    let buffer = '';
    socket.setEncoding('utf8');
    // Only until the request has arrived: a restore may take longer.
    socket.setTimeout(idleTimeoutMs, () => socket.destroy());
    socket.on('error', () => undefined);
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > MAX_REQUEST_BYTES) {
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      socket.removeAllListeners('data');
      socket.setTimeout(0);
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
  const previousUmask = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(temporary, () => resolve());
    });
  } finally {
    process.umask(previousUmask);
  }
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  const own = inode(path);
  logger.info('Backup control socket listening', { path });
  return {
    close: () => new Promise<void>(resolve => server.close(() => {
      if (own !== undefined && inode(path) === own) rmSync(path, { force: true });
      resolve();
    }))
  };
}

/** Sends one request to the gateway. Rejects with `code` ENOENT/ECONNREFUSED when no gateway is listening. */
export function callBackupControl(path: string, request: ControlRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    checkPathLength(path);
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

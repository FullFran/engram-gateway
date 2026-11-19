/** Backup and restore commands of the operator CLI (`src/cli.ts`). */
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  BackupService, CONTROL_SOCKET_NAME, GATEWAY_UNIT, brainUnit, callBackupControl, createBackupCipher, resolveBackupConfig, sqliteSnapshotter
} from '../backup/index.js';
import type { ControlRequest } from '../backup/index.js';
import { DEFAULT_BRAIN, SqliteBrainRepository, resolveBrainsConfig } from '../brains/index.js';
import type { Brain } from '../brains/index.js';
import { resolveGatewayDbPath } from '../config.js';
import { createLogger } from '../shared/logger.js';

export const USAGE = `usage:
  node dist/cli.js backup now
  node dist/cli.js backup list
  node dist/cli.js backup decrypt <file.enc> <output>
  node dist/cli.js restore <brain> <snapshot>`;

type Env = Readonly<Record<string, string | undefined>>;

/** The brains the gateway knows, read without changing the gateway database. */
function offlineBrains(env: Env, dbPath: string): Brain[] {
  if (dbPath !== ':memory:' && existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return new SqliteBrainRepository(db).list();
    } finally {
      db.close();
    }
  }
  return [{ slug: DEFAULT_BRAIN, dataDir: resolveBrainsConfig(env).defaultDataDir, cloudSync: false }];
}

/** `<dir>/brains/<slug>/<id>/<name>.enc` or `<dir>/gateway/<id>/<name>.enc` → the authenticated context. */
function contextOf(file: string): string {
  const name = basename(file).replace(/\.enc$/, '');
  const unitDir = dirname(dirname(file));
  const unit = basename(dirname(unitDir)) === 'brains' ? brainUnit(basename(unitDir)) : basename(unitDir);
  if (unit !== GATEWAY_UNIT && !unit.startsWith('brains/')) throw new Error(`${file} is not inside a backup directory (expected …/brains/<brain>/<snapshot>/ or …/gateway/<snapshot>/)`);
  return `${unit}/${name}`;
}

export async function runCli(argv: readonly string[], env: Env, print: (text: string) => void): Promise<number> {
  const [group, ...rest] = argv;
  const command = group === 'backup' ? rest[0] : group;
  const args = group === 'backup' ? rest.slice(1) : rest;
  const known = group === 'backup' ? ['now', 'list', 'decrypt'] : ['restore'];
  if (!command || !known.includes(command)) {
    print(USAGE);
    return 2;
  }
  const config = resolveBackupConfig(env);
  if (!config.enabled) throw new Error('backups are off: set BACKUP_DIR and BACKUP_KEY_FILE (see README, "Backups")');
  const cipher = createBackupCipher(config);

  if (command === 'decrypt') {
    const [file, output] = args;
    if (!file || !output || existsSync(output)) throw new Error(`backup decrypt needs a snapshot file and an output path that does not exist yet\n${USAGE}`);
    await cipher.decryptFile(file, output, contextOf(file));
    print(`decrypted ${file} -> ${output}`);
    return 0;
  }

  let request: ControlRequest;
  if (command === 'now') request = { op: 'backup' };
  else if (command === 'list') request = { op: 'list' };
  else {
    const [brain, snapshot] = args;
    if (!brain || !snapshot) {
      print(USAGE);
      return 2;
    }
    request = { op: 'restore', brain, snapshot };
  }

  let result: unknown;
  try {
    result = await callBackupControl(join(config.dir, CONTROL_SOCKET_NAME), request);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ECONNREFUSED') throw error;
    // No running gateway: nothing can hold a brain open, so run here.
    const logger = createLogger(env.LOG_LEVEL);
    logger.info('No running gateway on the control socket; running offline');
    const dbPath = resolveGatewayDbPath(env);
    const brains = offlineBrains(env, dbPath);
    const service = new BackupService({
      backupDir: config.dir,
      retention: config.retention,
      cipher,
      brains: () => brains,
      ...(dbPath === ':memory:' ? {} : { gatewayDbPath: dbPath }),
      quiesce: (_slug, work) => work(),
      clock: { now: () => Date.now() },
      logger,
      snapshotter: sqliteSnapshotter
    });
    if (request.op === 'backup') result = await service.runAll();
    else if (request.op === 'list') result = service.listAll();
    else {
      await service.restoreBrain(request.brain, request.snapshot);
      result = { restored: request.brain, snapshot: request.snapshot };
    }
  }
  print(JSON.stringify(result, null, 2));
  const failed = (result as { failed?: unknown[] } | undefined)?.failed;
  return Array.isArray(failed) && failed.length > 0 ? 1 : 0;
}

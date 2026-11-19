/** Admin commands of the operator CLI (`src/cli.ts`): the same use cases as the admin HTTP API. */
import { createWriteStream, openSync } from 'node:fs';
import { once } from 'node:events';
import { AdminError, AdminService, CLI_ACTOR, SqliteAdminStore, fsBrainDirectories } from '../admin/index.js';
import type { AuditFilter } from '../audit/index.js';
import { resolveBrainsConfig } from '../brains/index.js';
import { resolveGatewayDbPath } from '../config.js';
import { openGatewayDatabase } from '../shared/gateway-database.js';

export const ADMIN_USAGE = `usage:
  node dist/cli.js admin brains list
  node dist/cli.js admin brains create <slug>
  node dist/cli.js admin brains archive <slug>
  node dist/cli.js admin users list
  node dist/cli.js admin users invite <github-login>
  node dist/cli.js admin users disable <github-login>
  node dist/cli.js admin users enable <github-login>
  node dist/cli.js admin grants list [--brain <slug>] [--login <github-login>]
  node dist/cli.js admin grants set <github-login> <brain> <reader|writer|owner>
  node dist/cli.js admin grants revoke <github-login> <brain>
  node dist/cli.js admin audit export [--brain <slug>] [--from <date>] [--to <date>] [--out <file>]`;

type Env = Readonly<Record<string, string | undefined>>;

export interface CliIo {
  /** One line of normal output. */
  print(text: string): void;
  /** Raw output (the CSV export without `--out`). */
  write(chunk: string): void;
  /** One line of error output. */
  error(text: string): void;
}

/** The gateway's own database file; an in-memory one would be thrown away. */
function gatewayDbPath(env: Env): string {
  const path = resolveGatewayDbPath(env);
  if (path === ':memory:') throw new AdminError('invalid', 'the admin CLI needs the gateway database: set GATEWAY_DB_PATH or GATEWAY_DATA_DIR as the gateway has them');
  return path;
}

/** Positional arguments and `--name value` options. */
function parseArgs(args: readonly string[]): { positional: string[]; options: Map<string, string> } {
  const positional: string[] = [];
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      const value = args[i + 1];
      if (value === undefined) throw new AdminError('invalid', `${arg} needs a value`);
      options.set(arg.slice(2), value);
      i += 1;
    } else {
      positional.push(arg);
    }
  }
  return { positional, options };
}

function date(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(ms)) throw new AdminError('invalid', `--${name} must be epoch milliseconds or an ISO 8601 date`);
  return ms;
}

const COMMANDS: Record<string, Record<string, number>> = {
  brains: { list: 0, create: 1, archive: 1 },
  users: { list: 0, invite: 1, disable: 1, enable: 1 },
  grants: { list: 0, set: 3, revoke: 2 },
  audit: { export: 0 }
};

/**
 * Runs `admin <group> <command> ...` against the gateway database, as the
 * system actor `cli` (every mutation is audited). Returns the exit code:
 * 0 done, 1 refused (the reason on `io.error`), 2 usage.
 */
export async function runAdminCli(argv: readonly string[], env: Env, io: CliIo): Promise<number> {
  const [group, command, ...rest] = argv;
  const arity = group && command ? COMMANDS[group]?.[command] : undefined;
  if (arity === undefined) {
    io.error(ADMIN_USAGE);
    return 2;
  }
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(rest);
  } catch (error) {
    io.error(`error: ${(error as Error).message}`);
    return 2;
  }
  const { positional: args, options } = parsed;
  if (args.length !== arity) {
    io.error(ADMIN_USAGE);
    return 2;
  }

  let db: ReturnType<typeof openGatewayDatabase> | undefined;
  try {
    db = openGatewayDatabase(gatewayDbPath(env));
    const service = new AdminService({
      store: new SqliteAdminStore(db),
      dirs: fsBrainDirectories(resolveBrainsConfig(env).brainsRoot),
      clock: { nowMs: () => Date.now() }
    });
    const actor = CLI_ACTOR;
    switch (`${group} ${command}`) {
      case 'brains list':
        for (const brain of service.listBrains(actor)) io.print(`${brain.slug}\t${brain.status}\t${brain.cloudSync ? 'cloud-sync' : '-'}\t${brain.dataDir}`);
        break;
      case 'brains create': {
        const brain = service.createBrain(actor, args[0]!);
        io.print(`created brain ${brain.slug} at ${brain.dataDir} (served at /mcp/${brain.slug} now; with OAuth on, restart the gateway so clients can get tokens for it)`);
        break;
      }
      case 'brains archive':
        await service.archiveBrain(actor, args[0]!);
        io.print(`archived brain ${args[0]} (no new sessions; a running child stops when idle; data stays on disk)`);
        break;
      case 'users list':
        for (const user of service.listUsers(actor)) io.print(`${user.login}\t${user.status}${user.isAdmin ? '\tadmin' : ''}`);
        break;
      case 'users invite':
        io.print(`invited ${service.inviteUser(actor, args[0]!).login} (activated by their first sign-in; grant them a role on a brain)`);
        break;
      case 'users disable':
        io.print(`disabled ${service.disableUser(actor, args[0]!).login}`);
        break;
      case 'users enable':
        io.print(`enabled ${service.enableUser(actor, args[0]!).login}`);
        break;
      case 'grants list': {
        const filter = { ...(options.has('brain') ? { brain: options.get('brain')! } : {}), ...(options.has('login') ? { login: options.get('login')! } : {}) };
        for (const grant of service.listGrants(actor, filter)) io.print(`${grant.brain}\t${grant.login}\t${grant.role}\t${grant.source}`);
        break;
      }
      case 'grants set': {
        const grant = service.setGrant(actor, args[0]!, args[1]!, args[2]!);
        io.print(`${grant.login} is ${grant.role} on ${grant.brain}`);
        break;
      }
      case 'grants revoke':
        service.revokeGrant(actor, args[0]!, args[1]!);
        io.print(`revoked the grant of ${args[0]} on ${args[1]}`);
        break;
      case 'audit export': {
        const fromMs = date(options.get('from'), 'from');
        const toMs = date(options.get('to'), 'to');
        const filter: AuditFilter = {
          ...(options.has('brain') ? { brain: options.get('brain')! } : {}), ...(fromMs !== undefined ? { fromMs } : {}), ...(toMs !== undefined ? { toMs } : {})
        };
        const out = options.get('out');
        if (!out) {
          for (const line of service.exportAudit(actor, filter)) io.write(line);
          break;
        }
        // Opened before the export is recorded; never over an existing file.
        let fd: number;
        try {
          fd = openSync(out, 'wx', 0o600);
        } catch (error) {
          throw new AdminError('conflict', `cannot create ${out}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
        }
        const lines = service.exportAudit(actor, filter);
        const file = createWriteStream(out, { fd });
        for (const line of lines) if (!file.write(line)) await once(file, 'drain');
        file.end();
        await once(file, 'finish');
        break;
      }
    }
    return 0;
  } catch (error) {
    if (!(error instanceof AdminError)) throw error;
    io.error(`error: ${error.message}`);
    return 1;
  } finally {
    db?.close();
  }
}

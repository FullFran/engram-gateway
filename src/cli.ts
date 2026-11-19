/**
 * Operator CLI: `node dist/cli.js <command>` (inside the container:
 * `docker exec <container> node dist/cli.js <command>`). Reads the same
 * environment as the gateway.
 *
 *   backup now                     take a snapshot of every brain and the gateway database
 *   backup list                    list snapshots, by unit
 *   backup decrypt <file> <out>    decrypt one snapshot file (manual recovery, e.g. the gateway database)
 *   restore <brain> <snapshot>     replace a brain's databases with a snapshot
 *   admin brains|users|grants|audit ...   manage brains, users and grants, export the audit log (#10);
 *                                  admin tokens ...: personal access tokens of any user (#7);
 *                                  run `node dist/cli.js admin` for the full list
 *
 * When a gateway with backups enabled is running, `backup now|list` and
 * `restore` go through its control socket, so restore stops the brain's
 * child through the brain registry first. With no gateway running they run
 * in this process. Admin commands write the gateway database directly.
 */
import { runAdminCli } from './cli/admin-commands.js';
import { runCli } from './cli/backup-commands.js';

const [group, ...rest] = process.argv.slice(2);
const io = {
  print: (text: string) => process.stdout.write(`${text}\n`),
  write: (chunk: string) => process.stdout.write(chunk),
  error: (text: string) => process.stderr.write(`${text}\n`)
};

(group === 'admin'
  // exitCode, not exit(): a large CSV on a pipe must be flushed first.
  ? runAdminCli(rest, process.env, io).then(code => { process.exitCode = code; })
  : runCli(process.argv.slice(2), process.env, io.print).then(code => process.exit(code)))
  .catch(error => {
    process.stderr.write(`error: ${(error as Error).message}\n`);
    process.exit(1);
  });

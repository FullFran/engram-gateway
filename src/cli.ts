/**
 * Operator CLI: `node dist/cli.js <command>` (inside the container:
 * `docker exec <container> node dist/cli.js <command>`). Reads the same
 * environment as the gateway.
 *
 *   backup now                     take a snapshot of every brain and the gateway database
 *   backup list                    list snapshots, by unit
 *   backup decrypt <file> <out>    decrypt one snapshot file (manual recovery, e.g. the gateway database)
 *   restore <brain> <snapshot>     replace a brain's databases with a snapshot
 *
 * When a gateway with backups enabled is running, `backup now|list` and
 * `restore` go through its control socket, so restore stops the brain's
 * child through the brain registry first. With no gateway running they run
 * in this process.
 */
import { runCli } from './cli/backup-commands.js';

runCli(process.argv.slice(2), process.env, text => process.stdout.write(`${text}\n`))
  .then(code => process.exit(code))
  .catch(error => {
    process.stderr.write(`error: ${(error as Error).message}\n`);
    process.exit(1);
  });

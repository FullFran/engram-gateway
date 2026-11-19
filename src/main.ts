/**
 * Composition root: reads configuration, opens the gateway database, makes
 * the `brains` table match the startup settings, wires the auth module and
 * one Engram bridge per brain into the HTTP app and listens. With auth on,
 * users and grants are synced from ALLOWED_GITHUB_LOGINS and BRAIN_GRANTS
 * (src/authz) and checked on every request and tool call. Shutdown stops
 * accepting connections, stops every `engram mcp` child, then closes the
 * database.
 *
 * Backups (`BACKUP_*`, see `resolveBackupConfig`): a daily in-process
 * timer and a local control socket for the CLI (`node dist/cli.js`).
 *
 * The admin API (#10, `/admin/api`, auth on only) and the operator CLI
 * (`node dist/cli.js admin ...`) manage brains, users and grants in the same database.
 *
 * Bridge settings: ENGRAM_BIN (default `engram`), ENGRAM_ARGS (default
 * `mcp`, split on whitespace). Brain settings: see `resolveBrainsConfig`.
 */
import { chmodSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { AdminService, SqliteAdminStore, createAdminRouter, fsBrainDirectories } from './admin/index.js';
import { SqliteAuthorshipRepository, createAttributor } from './attribution/index.js';
import { ANONYMOUS_ACTOR, SqliteAuditLog, toolCallRecorder } from './audit/index.js';
import { buildAuth, resolveAuthConfig } from './auth/index.js';
import { CONNECTION_TOOL_KINDS, GATEWAY_TOOL_ROLES, GrantAccessPolicy, SqliteGrantRepository, bootstrapAccess, createToolAccess, parseAdminLogins, parseBrainGrants, TOOL_ROLES } from './authz/index.js';
import {
  BackupService, CONTROL_SOCKET_NAME, createBackupCipher, openBrainLock, resolveBackupConfig, serveBackupControl, sqliteSnapshotter, startBackupSchedule
} from './backup/index.js';
import { BrainRegistry, DEFAULT_BRAIN, SqliteBrainRepository, bootstrapBrains, buildChildEnv, cloudSyncWarning, resolveBrainsConfig } from './brains/index.js';
import { createConnectionServer, createEngramBridge } from './bridge/index.js';
import { ConnectionAdmin, ConnectionConsentService, SqliteConnectionStore } from './connections/index.js';
import { resolveGatewayConfig, resolveGatewayDbPath } from './config.js';
import { BRAIN_RESOLVE_TOOL, createBrainHealthTool, createBrainResolveTool, createConnectionTools, createGatewayToolSet } from './gateway-tools/index.js';
import { createEngramBrainHealthService } from './health/index.js';
import { MCP_HTTP_PATH } from './http/mcp-route.js';
import { createGatewayApp } from './http/app.js';
import { createAttributionStage, createAuditStage, createToolCallPipeline } from './pipeline/index.js';
import { openGatewayDatabase } from './shared/gateway-database.js';
import { createLogger } from './shared/logger.js';

const logger = createLogger();

function formatHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function onStopSignals(stop: (signal: string) => void): void {
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

async function main(): Promise<void> {
  const config = resolveGatewayConfig(process.env);
  const brainsConfig = resolveBrainsConfig(process.env);
  // Backups on without a usable key must fail here, before anything starts.
  const backupConfig = resolveBackupConfig(process.env);
  const brainGrants = parseBrainGrants(process.env.BRAIN_GRANTS);
  const cloudWarning = cloudSyncWarning(process.env, brainsConfig);
  if (cloudWarning) logger.warn(cloudWarning);

  const dataDir = process.env.GATEWAY_DATA_DIR?.trim();
  if (dataDir) mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const dbPath = resolveGatewayDbPath(process.env);
  const db = openGatewayDatabase(dbPath);
  if (dbPath === ':memory:') logger.info('No GATEWAY_DATA_DIR: gateway state (brains table) is kept in memory');
  const brainRepo = new SqliteBrainRepository(db);
  const brains = bootstrapBrains(brainRepo, brainsConfig, logger);

  // Every brain is its own protected resource: `/mcp/<slug>`; `/mcp` stays the default brain's.
  const resourcePaths = [MCP_HTTP_PATH, ...brains.map(brain => `${MCP_HTTP_PATH}/${brain.slug}`)];
  const authConfig = resolveAuthConfig(config.host, process.env, { resourcePaths });
  if (authConfig.mode === 'oauth') {
    for (const warning of authConfig.warnings) logger.warn(warning);
  } else if (authConfig.insecure) {
    logger.warn(`Authentication is OFF on non-loopback HOST=${config.host} (ALLOW_INSECURE_NO_AUTH=true): anyone who can reach this address can read and change the Engram memory.`);
  }
  // Access (#6): with auth on, ALLOWED_GITHUB_LOGINS are the instance admins
  // (owners of every brain) and BRAIN_GRANTS everyone else's roles; both are
  // written to the gateway database at start and read on every request.
  const grants = new SqliteGrantRepository(db);
  if (authConfig.mode === 'oauth') {
    bootstrapAccess(grants, { admins: parseAdminLogins(process.env.ALLOWED_GITHUB_LOGINS), grants: brainGrants, brains: brains.map(brain => brain.slug) });
  } else if (brainGrants.length > 0) {
    logger.warn('BRAIN_GRANTS is ignored: authentication is off, so every caller may use every tool on every brain');
  }
  // Connections (#27): a grant on the bare `/mcp` resource makes a connection
  // with its own brains and roles, capped by the owner's grants.
  const connections = new SqliteConnectionStore(db);
  const auth = authConfig.mode === 'oauth'
    ? buildAuth(authConfig, {
      logger, db,
      policy: new GrantAccessPolicy(grants, authConfig.settings.resources),
      connections: new ConnectionConsentService(grants, connections, authConfig.settings.resources[0]!, DEFAULT_BRAIN)
    })
    : undefined;
  await auth?.warmUp();

  // Audit log (#8): every tool call gets one row in the gateway database,
  // with the brain it was routed to; without auth the actor is `anonymous`.
  const auditLog = new SqliteAuditLog(db);
  const pipeline = createToolCallPipeline({
    ...(auth ? { access: createToolAccess(grants, connections) } : {}),
    // Attribution (#21): who wrote each observation, in the gateway database;
    // shown next to mem_search / mem_get_observation results. Needs a signed-in caller.
    attribute: createAttributionStage({
      attribute: createAttributor({ authors: new SqliteAuthorshipRepository(db), clock: { nowMs: () => Date.now() } }),
      onError: (error, tool) => logger.error('Attribution write failed; the tool call went through unattributed', { tool, reason: (error as Error).message })
    }),
    audit: createAuditStage({
      record: toolCallRecorder(auditLog, { nowMs: () => Date.now() }),
      onError: (error, tool) => logger.error('Audit log write failed; the tool call went through unrecorded', { tool, reason: (error as Error).message })
    })
  });

  // Gateway tools (served by the gateway, same pipeline): brain_health (#18),
  // read-only from each brain's engram.db, never through its child.
  const dataDirs = new Map(brains.map(brain => [brain.slug, brain.dataDir]));
  const health = createEngramBrainHealthService({ dataDirOf: slug => dataDirs.get(slug) });
  // Connection tools (#27): checked against engram's and the gateway's names, served only on the bare /mcp.
  // brain_resolve (#12) is both: a brain tool on /mcp/<brain>, a connection tool on /mcp (no `brain` argument).
  const connectionAdmin = new ConnectionAdmin(grants, connections);
  const brainResolve = createBrainResolveTool({ rules: config.brainRemotes, connections: connectionAdmin });
  const { [BRAIN_RESOLVE_TOOL]: _shared, ...brainOnlyGatewayRoles } = GATEWAY_TOOL_ROLES;
  const connectionTools = createGatewayToolSet([...createConnectionTools(connectionAdmin), brainResolve], { engram: { ...TOOL_ROLES, ...brainOnlyGatewayRoles }, gateway: CONNECTION_TOOL_KINDS });
  const gatewayTools = createGatewayToolSet([createBrainHealthTool(health), brainResolve], { engram: TOOL_ROLES, gateway: GATEWAY_TOOL_ROLES });

  const command = process.env.ENGRAM_BIN?.trim() || 'engram';
  const args = (process.env.ENGRAM_ARGS?.trim() || 'mcp').split(/\s+/);
  const registry = new BrainRegistry({
    // Read on every request: brains created or archived by the admin API or
    // CLI are served or refused without a restart.
    brains: { get: slug => brainRepo.findActive(slug) },
    createProcess: brain => {
      mkdirSync(brain.dataDir, { recursive: true, mode: 0o700 });
      return createEngramBridge({ command, args, pipeline, gatewayTools, env: buildChildEnv(brain, process.env), logger, brain: brain.slug });
    },
    clock: { now: () => Date.now() },
    idleTimeoutMs: brainsConfig.idleTimeoutMs,
    maxLiveBrains: brainsConfig.maxLiveBrains,
    logger
  });
  // Held while this gateway runs: an offline restore (CLI --offline) refuses
  // a brain that a gateway serves. Taken before any child starts.
  const brainLocks = new Map(brains.map(brain => [brain.slug, openBrainLock(brain.dataDir)]));
  // Fail at startup, as before, when engram cannot run; the default brain is
  // then reaped like any other once idle.
  const warm = await registry.acquire(DEFAULT_BRAIN);
  try {
    await warm.process.start();
  } finally {
    warm.release();
  }
  registry.startReaper();

  let backups: { stop(): Promise<void> } | undefined;
  if (backupConfig.enabled) {
    mkdirSync(backupConfig.dir, { recursive: true, mode: 0o700 });
    // mkdirSync's mode does not apply to an existing directory.
    chmodSync(backupConfig.dir, 0o700);
    const service = new BackupService({
      backupDir: backupConfig.dir,
      retention: backupConfig.retention,
      cipher: createBackupCipher(backupConfig),
      brains: () => brains,
      ...(dbPath === ':memory:' ? {} : { gatewayDbPath: dbPath }),
      // Stop the child and hold requests, then take the brain's exclusive lock
      // (refused while another gateway, e.g. mid-deploy, serves it).
      // An archived brain (#10) is not served, so no request can start its
      // child: stop the one still running (archived from the CLI) and take
      // the lock; its data keeps being backed up.
      quiesce: (slug, work) => {
        const exclusive = () => {
          const lock = brainLocks.get(slug);
          if (!lock) throw new Error(`unknown brain: ${slug}`);
          return lock.withExclusive(work);
        };
        return registry.has(slug) ? registry.quiesce(slug, exclusive) : registry.stop(slug).then(exclusive);
      },
      clock: { now: () => Date.now() },
      logger,
      snapshotter: sqliteSnapshotter
    });
    await service.removeStalePartials();
    // Without the socket the gateway still serves and backs up on schedule;
    // only the CLI's online commands are unavailable.
    const control = await serveBackupControl(join(backupConfig.dir, CONTROL_SOCKET_NAME), service, logger).catch(error => {
      logger.error('Backup control socket unavailable; `backup now` and `restore` from the CLI will not reach this gateway', { error: (error as Error).message });
      return undefined;
    });
    const schedule = backupConfig.schedule === 'off' ? undefined : startBackupSchedule(() => service.runAll(), backupConfig.schedule, backupConfig.jitterMs, logger);
    backups = { stop: async () => { schedule?.stop(); await control?.close(); } };
  }

  const app = createGatewayApp({
    bindHost: config.host,
    ...(config.publicBaseUrl ? { publicBaseUrl: config.publicBaseUrl } : {}),
    trustProxy: config.trustProxy,
    ...(auth ? {
      auth: { router: auth.router, authenticator: auth.authenticator, resource: auth.settings.resources[0]! },
      brainAccess: { mayOpen: (login: string, brain: string) => grants.roleOf(login, brain) !== undefined },
      // Connection tokens on /mcp (#27): the brain is chosen per call.
      connectionServer: createConnectionServer({
        brains: registry, connections, pipeline, gatewayTools, logger,
        connectionTools: { tools: connectionTools, access: connectionAdmin }
      })
    } : {}),
    brains: registry,
    admin: {
      isAdmin: login => grants.isAdmin(login),
      brainHealth: (slug, rawOptions) => health.report(slug, rawOptions),
      // Admin reads are audited like tool calls: who, which brain, outcome.
      recordAccess: access => {
        auditLog.append({
          atMs: Date.now(),
          actor: access.login ? { kind: 'user', login: access.login } : ANONYMOUS_ACTOR,
          brain: access.brain,
          action: 'admin.brain_health',
          target: null,
          outcome: access.outcome,
          durationMs: null,
          meta: {}
        });
      }
    },
    adminApi: identify => createAdminRouter({
      service: new AdminService({
        store: new SqliteAdminStore(db),
        dirs: fsBrainDirectories(brainsConfig.brainsRoot),
        clock: { nowMs: () => Date.now() },
        runtime: registry
      }),
      identify,
      logger
    }),
    logger
  });
  const server = createServer(app);

  let shuttingDown = false;
  const stop = async () => {
    await backups?.stop();
    await registry.stopAll();
    for (const lock of brainLocks.values()) lock.close();
    db.close();
  };
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down`);
    server.close();
    server.closeAllConnections?.();
    void stop()
      .catch(error => logger.warn('Shutdown was not clean', { error: (error as Error).message }))
      .finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  onStopSignals(shutdown);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => resolve());
  });
  const local = `http://${formatHost(config.host)}:${config.port}`;
  logger.info('engram-gateway listening', {
    url: local,
    mcp: `${config.publicBaseUrl ?? local}${MCP_HTTP_PATH}`,
    brains: brains.length,
    auth: auth ? `${auth.providers.join(', ')} (issuer ${auth.settings.issuer}, ${auth.settings.allowedLogins.size} allowed login(s))` : 'off'
  });
}

main().catch(error => {
  logger.error(`Startup failed: ${(error as Error).message}`);
  process.exit(1);
});

/**
 * Composition root: reads configuration, opens the gateway database, makes
 * the `brains` table match the startup settings, wires the auth module and
 * one Engram bridge per brain into the HTTP app and listens. Shutdown stops
 * accepting connections, stops every `engram mcp` child, then closes the
 * database.
 *
 * Bridge settings: ENGRAM_BIN (default `engram`), ENGRAM_ARGS (default
 * `mcp`, split on whitespace). Brain settings: see `resolveBrainsConfig`.
 */
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { buildAuth, resolveAuthConfig } from './auth/index.js';
import { BrainRegistry, DEFAULT_BRAIN, SqliteBrainRepository, bootstrapBrains, buildChildEnv, resolveBrainsConfig } from './brains/index.js';
import { createEngramBridge } from './bridge/index.js';
import { resolveGatewayConfig } from './config.js';
import { MCP_HTTP_PATH } from './http/mcp-route.js';
import { createGatewayApp } from './http/app.js';
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

/** Same location rule as the auth config: `GATEWAY_DB_PATH`, else `$GATEWAY_DATA_DIR/gateway.db`, else in memory. */
function gatewayDbPath(env: NodeJS.ProcessEnv): string {
  const explicit = env.GATEWAY_DB_PATH?.trim();
  if (explicit) return resolve(explicit);
  const dataDir = env.GATEWAY_DATA_DIR?.trim();
  return dataDir ? join(resolve(dataDir), 'gateway.db') : ':memory:';
}

async function main(): Promise<void> {
  const config = resolveGatewayConfig(process.env);
  const brainsConfig = resolveBrainsConfig(process.env);

  const dataDir = process.env.GATEWAY_DATA_DIR?.trim();
  if (dataDir) mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const dbPath = gatewayDbPath(process.env);
  const db = openGatewayDatabase(dbPath);
  if (dbPath === ':memory:') logger.info('No GATEWAY_DATA_DIR: gateway state (brains table) is kept in memory');
  const brains = bootstrapBrains(new SqliteBrainRepository(db), brainsConfig, logger);

  // Every brain is its own protected resource: `/mcp/<slug>`; `/mcp` stays the default brain's.
  const resourcePaths = [MCP_HTTP_PATH, ...brains.map(brain => `${MCP_HTTP_PATH}/${brain.slug}`)];
  const authConfig = resolveAuthConfig(config.host, process.env, { resourcePaths });
  if (authConfig.mode === 'oauth') {
    for (const warning of authConfig.warnings) logger.warn(warning);
  } else if (authConfig.insecure) {
    logger.warn(`Authentication is OFF on non-loopback HOST=${config.host} (ALLOW_INSECURE_NO_AUTH=true): anyone who can reach this address can read and change the Engram memory.`);
  }
  const auth = authConfig.mode === 'oauth' ? buildAuth(authConfig, { logger, db }) : undefined;
  await auth?.warmUp();

  const command = process.env.ENGRAM_BIN?.trim() || 'engram';
  const args = (process.env.ENGRAM_ARGS?.trim() || 'mcp').split(/\s+/);
  const registry = new BrainRegistry({
    brains: new Map(brains.map(brain => [brain.slug, brain])),
    createProcess: brain => {
      mkdirSync(brain.dataDir, { recursive: true, mode: 0o700 });
      return createEngramBridge({ command, args, env: buildChildEnv(brain, process.env), logger });
    },
    clock: { now: () => Date.now() },
    idleTimeoutMs: brainsConfig.idleTimeoutMs,
    maxLiveBrains: brainsConfig.maxLiveBrains,
    logger
  });
  // Fail at startup, as before, when engram cannot run; the default brain is
  // then reaped like any other once idle.
  const warm = registry.acquire(DEFAULT_BRAIN);
  try {
    await warm.process.start();
  } finally {
    warm.release();
  }
  registry.startReaper();

  const app = createGatewayApp({
    bindHost: config.host,
    ...(config.publicBaseUrl ? { publicBaseUrl: config.publicBaseUrl } : {}),
    trustProxy: config.trustProxy,
    ...(auth ? { auth: { router: auth.router, authenticator: auth.authenticator, resource: auth.settings.resources[0]! } } : {}),
    brains: registry,
    logger
  });
  const server = createServer(app);

  let shuttingDown = false;
  const stop = async () => {
    await registry.stopAll();
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

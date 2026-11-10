/**
 * Composition root: reads configuration, wires the auth module and the
 * Engram bridge into the HTTP app and listens. Shutdown stops accepting
 * connections, then stops the `engram mcp` child.
 *
 * Bridge settings: ENGRAM_BIN (default `engram`), ENGRAM_ARGS (default
 * `mcp`, split on whitespace) and ENGRAM_DATA_DIR (passed to the child).
 */
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { buildAuth, resolveAuthConfig } from './auth/index.js';
import { createEngramBridge } from './bridge/index.js';
import { resolveGatewayConfig } from './config.js';
import { MCP_HTTP_PATH } from './http/mcp-route.js';
import { createGatewayApp } from './http/app.js';
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
  const authConfig = resolveAuthConfig(config.host, process.env, { resourcePaths: [MCP_HTTP_PATH] });
  if (authConfig.mode === 'oauth') {
    for (const warning of authConfig.warnings) logger.warn(warning);
  } else if (authConfig.insecure) {
    logger.warn(`Authentication is OFF on non-loopback HOST=${config.host} (ALLOW_INSECURE_NO_AUTH=true): anyone who can reach this address can read and change the Engram memory.`);
  }

  const dataDir = process.env.GATEWAY_DATA_DIR?.trim();
  if (dataDir) mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const auth = authConfig.mode === 'oauth' ? buildAuth(authConfig, { logger }) : undefined;
  await auth?.warmUp();

  const engramDataDir = process.env.ENGRAM_DATA_DIR?.trim();
  const bridge = createEngramBridge({
    command: process.env.ENGRAM_BIN?.trim() || 'engram',
    args: (process.env.ENGRAM_ARGS?.trim() || 'mcp').split(/\s+/),
    ...(engramDataDir ? { env: { ENGRAM_DATA_DIR: engramDataDir } } : {}),
    logger
  });
  await bridge.start();

  const app = createGatewayApp({
    bindHost: config.host,
    ...(config.publicBaseUrl ? { publicBaseUrl: config.publicBaseUrl } : {}),
    trustProxy: config.trustProxy,
    ...(auth ? { auth: { router: auth.router, authenticator: auth.authenticator, resource: auth.settings.resources[0]! } } : {}),
    mcpFactory: bridge.factory,
    logger
  });
  const server = createServer(app);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down`);
    server.close();
    server.closeAllConnections?.();
    void bridge.close().finally(() => process.exit(0));
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
    auth: auth ? `${auth.providers.join(', ')} (issuer ${auth.settings.issuer}, ${auth.settings.allowedLogins.size} allowed login(s))` : 'off'
  });
}

main().catch(error => {
  logger.error(`Startup failed: ${(error as Error).message}`);
  process.exit(1);
});

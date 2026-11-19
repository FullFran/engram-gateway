import { join, resolve } from 'node:path';
import { parsePublicBaseUrl, parseTrustProxy } from './shared/network.js';

export interface GatewayConfig {
  host: string;
  port: number;
  publicBaseUrl?: string;
  trustProxy: boolean | number | string;
}

function readPort(name: string, raw: string | undefined, fallback: number): number {
  const value = raw?.trim();
  if (!value) return fallback;
  if (!/^\d+$/.test(value) || Number(value) > 65535) throw new Error(`${name} must be a port number, got ${JSON.stringify(value)}`);
  return Number(value);
}

/** Gateway settings from the environment (auth has its own, in `auth/`; the bridge's, in `main.ts`). */
export function resolveGatewayConfig(env: Record<string, string | undefined>): GatewayConfig {
  const publicBaseUrl = parsePublicBaseUrl(env.PUBLIC_BASE_URL);
  return {
    host: env.HOST?.trim() || '127.0.0.1',
    port: readPort('PORT', env.PORT, 3000),
    ...(publicBaseUrl ? { publicBaseUrl } : {}),
    trustProxy: parseTrustProxy(env.TRUST_PROXY)
  };
}

/** The gateway database file: `GATEWAY_DB_PATH`, else `$GATEWAY_DATA_DIR/gateway.db`, else `':memory:'` (same rule as the auth config). */
export function resolveGatewayDbPath(env: Readonly<Record<string, string | undefined>>): string {
  const explicit = env.GATEWAY_DB_PATH?.trim();
  if (explicit) return resolve(explicit);
  const dataDir = env.GATEWAY_DATA_DIR?.trim();
  return dataDir ? join(resolve(dataDir), 'gateway.db') : ':memory:';
}

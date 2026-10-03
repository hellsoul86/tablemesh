import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AppConfig {
  databasePath: string;
  host: string;
  port: number;
  allowedOrigins: string[];
  sessionTtlMs: number;
  gameTokenTtlMs: number;
  starterPoints: number;
  adminToken: string | null;
  inventoryKey: Buffer | null;
  realRewardsEnabled: boolean;
  secureCookies: boolean;
  schedulerIntervalMs: number;
  now: () => number;
}

function integer(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid numeric server configuration');
  return value;
}

export function readConfig(): AppConfig {
  const rawKey = process.env.TABLEMESH_INVENTORY_KEY;
  const inventoryKey = rawKey ? Buffer.from(rawKey, 'base64') : null;
  if (inventoryKey && (inventoryKey.length !== 32 || inventoryKey.toString('base64') !== rawKey)) {
    throw new Error('TABLEMESH_INVENTORY_KEY must contain a canonical base64 32-byte key');
  }
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  return {
    databasePath: resolve(root, process.env.TABLEMESH_DB || 'data/tablemesh.sqlite'),
    host: process.env.TABLEMESH_HOST || '127.0.0.1',
    port: integer(process.env.TABLEMESH_PORT, 4100),
    allowedOrigins: (process.env.TABLEMESH_ALLOWED_ORIGINS || 'http://127.0.0.1:5173,http://127.0.0.1:5174,http://localhost:5173,http://localhost:5174').split(',').map(s => s.trim()),
    sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
    gameTokenTtlMs: 24 * 60 * 60 * 1000,
    starterPoints: integer(process.env.TABLEMESH_STARTER_POINTS, 1000),
    adminToken: process.env.TABLEMESH_ADMIN_TOKEN || null,
    inventoryKey,
    realRewardsEnabled: process.env.TABLEMESH_REAL_REWARDS === 'true',
    secureCookies: process.env.TABLEMESH_SECURE_COOKIES === 'true',
    schedulerIntervalMs: 100,
    now: Date.now
  };
}

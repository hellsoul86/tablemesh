import { createHash, timingSafeEqual, randomBytes, scrypt } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { ErrorCode } from '@tablemesh/core/contracts';

export class AppError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly status = 400, readonly currentStateVersion?: number) { super(message); }
}
export function fail(code: ErrorCode, message: string, status = 400, version?: number): never { throw new AppError(code, message, status, version); }
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT', 'Expected a JSON object');
  return value as Record<string, unknown>;
}
export function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('INVALID_INPUT', 'Unexpected request field');
}
export function text(value: unknown, label: string, max = 100): string {
  if (typeof value !== 'string') fail('INVALID_INPUT', `Invalid ${label}`);
  const result = value.normalize('NFKC').trim();
  if (!result || [...result].length > max || /[\u0000-\u001f\u007f]/u.test(result)) fail('INVALID_INPUT', `Invalid ${label}`);
  return result;
}
export function integer(value: unknown, label: string, min = 0, max = 1_000_000_000): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_INPUT', `Invalid ${label}`);
  return value;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => JSON.stringify(key) + ':' + canonical(val)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function sameSecret(a: string, b: string): boolean { return timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b))); }
export function newToken(): string { return randomBytes(32).toString('base64url'); }
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, result) => error ? reject(error) : resolve(result)));
}
export function password(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) fail('INVALID_INPUT', 'Password length must be 8–128 characters');
  return value;
}
export async function passwordHash(value: string): Promise<string> {
  const salt = randomBytes(16);
  return salt.toString('hex') + ':' + (await derive(value, salt)).toString('hex');
}
export async function passwordMatches(value: string, stored: string): Promise<boolean> {
  const [saltHex, derivedHex] = stored.split(':');
  const expected = Buffer.from(derivedHex ?? '', 'hex');
  const actual = await derive(value, Buffer.from(saltHex ?? '', 'hex'));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) fail('INVALID_INPUT', 'Content-Type must be application/json', 415);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 128 * 1024) fail('INVALID_INPUT', 'Request body too large', 413);
    chunks.push(buffer);
  }
  try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
  catch (error) { if (error instanceof AppError) throw error; fail('INVALID_INPUT', 'Malformed JSON'); }
}

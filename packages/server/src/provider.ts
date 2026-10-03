import { randomBytes, createCipheriv, createDecipheriv, createHmac } from 'node:crypto';
import { openSync, writeFileSync, fsyncSync, closeSync, readFileSync, lstatSync, linkSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LlmConfigInput, LlmConfigView, LlmLimits, HoldemAction, LegalAction } from '@tablemesh/core/contracts';
import type { ProviderInvocation, ProviderDecision } from './autoplay.js';
import { Store } from './db.js';
import { object, exactKeys, integer, text, fail, canonical } from './util.js';

export const DEFAULT_LIMITS: LlmLimits = { timeoutMs: 5000, maxOutputTokens: 256, maxRequestsPerHand: 20, maxRequestsPerRun: 100 };
export class ProviderError extends Error {
  constructor(readonly reason: 'MODEL_ERROR' | 'INVALID_RESPONSE' | 'REQUEST_TIMEOUT') { super(reason); }
}
interface ConfigRow { account_id: string; config_json: string; key_ciphertext: string | null; updated_at: number }
export function isLoopback(address: string): boolean {
  return isIP(address) === 4 ? Number(address.split('.')[0]) === 127 : address === '::1';
}
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number) as [number, number, number];
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2))))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6) return false;
  const first = Number.parseInt(address.split(':')[0]!, 16);
  // Only native global unicast. Exclude transition/documentation ranges.
  return first >= 0x2000 && first <= 0x3fff && !/^2001:(?:0:|db8:|10:|20:|2:)/i.test(address) && !/^2002:/i.test(address);
}
export function endpoint(raw: unknown): URL {
  const value = text(raw, 'baseUrl', 2048);
  let url: URL;
  try { url = new URL(value); } catch { fail('INVALID_INPUT', 'Invalid model address'); }
  if (url.username || url.password || value.includes('?') || value.includes('#') || !['http:', 'https:'].includes(url.protocol)) fail('INVALID_INPUT', 'Model address must have no credentials, query or fragment');
  const host = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  const local = host === 'localhost' || isLoopback(host);
  if ((url.protocol === 'http:' && !local) || (isIP(host) && !local && !isPublicAddress(host))) fail('INVALID_INPUT', 'Use public HTTPS or an explicit loopback model address');
  url.pathname = url.pathname.replace(/\/+$/u, '');
  return url;
}
export function validateConfig(value: unknown): LlmConfigInput {
  const v = object(value);
  exactKeys(v, ['protocol', 'baseUrl', 'model', 'limits', 'apiKey', 'tokenLimitField']);
  if (v.protocol !== 'openai-compatible' && v.protocol !== 'anthropic') fail('INVALID_INPUT', 'Unsupported model protocol');
  if (v.protocol === 'anthropic' && v.tokenLimitField !== undefined) fail('INVALID_INPUT', 'Anthropic uses max_tokens');
  if (v.tokenLimitField !== undefined && !['max_tokens', 'max_completion_tokens'].includes(String(v.tokenLimitField))) fail('INVALID_INPUT', 'Invalid token limit field');
  const limits = object(v.limits);
  exactKeys(limits, ['timeoutMs', 'maxOutputTokens', 'maxRequestsPerHand', 'maxRequestsPerRun']);
  const result: LlmConfigInput = { protocol: v.protocol, baseUrl: endpoint(v.baseUrl).toString().replace(/\/$/u, ''), model: text(v.model, 'model', 200), limits: {
    timeoutMs: integer(limits.timeoutMs, 'timeoutMs', 1000, 30_000), maxOutputTokens: integer(limits.maxOutputTokens, 'maxOutputTokens', 64, 1024),
    maxRequestsPerHand: integer(limits.maxRequestsPerHand, 'maxRequestsPerHand', 1, 60), maxRequestsPerRun: integer(limits.maxRequestsPerRun, 'maxRequestsPerRun', 1, 500)
  } };
  if (v.apiKey !== undefined) {
    if (typeof v.apiKey !== 'string' || v.apiKey.length > 8192 || /[\u0000-\u001f\u007f]/u.test(v.apiKey)) fail('INVALID_INPUT', 'Invalid API key');
    result.apiKey = v.apiKey;
  }
  if (v.protocol === 'openai-compatible') result.tokenLimitField = v.tokenLimitField === 'max_completion_tokens' ? 'max_completion_tokens' : 'max_tokens';
  return result;
}
function loadKey(databasePath: string, override: Buffer | null): Buffer {
  if (override) return override;
  if (databasePath === ':memory:') return randomBytes(32);
  const path = join(dirname(databasePath), 'tablemesh.provider-key');
  const read = () => {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('Model key file must be a private regular file');
    const key = readFileSync(path);
    if (key.length !== 32) throw new Error('Model key file is invalid');
    return key;
  };
  try { return read(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  const key = randomBytes(32);
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, key); fsyncSync(fd); } finally { closeSync(fd); }
  try { linkSync(temporary, path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  finally { unlinkSync(temporary); }
  return read();
}

export class ModelProvider {
  private readonly key: Buffer;
  constructor(private readonly store: Store, databasePath: string, key: Buffer | null, private readonly now = Date.now) { this.key = loadKey(databasePath, key); }
  fingerprint(value: unknown): string { return createHmac('sha256', this.key).update(canonical(value)).digest('hex'); }
  private row(accountId: string): ConfigRow | undefined { return this.store.one<ConfigRow>('SELECT * FROM llm_configs WHERE account_id=?', accountId); }
  view(accountId: string): LlmConfigView {
    const row = this.row(accountId);
    if (!row) return { configured: false, ready: false, protocol: null, baseUrl: null, model: null, hasApiKey: false, limits: { ...DEFAULT_LIMITS }, updatedAt: null };
    const config = JSON.parse(row.config_json) as LlmConfigInput;
    return { configured: true, ready: Boolean(row.key_ciphertext) || this.keyless(config), protocol: config.protocol,
      baseUrl: config.baseUrl, model: config.model, hasApiKey: Boolean(row.key_ciphertext), limits: config.limits, updatedAt: row.updated_at,
      ...(config.tokenLimitField ? { tokenLimitField: config.tokenLimitField } : {}) };
  }
  private keyless(config: LlmConfigInput): boolean {
    const host = endpoint(config.baseUrl).hostname.replace(/^\[|\]$/gu, '').toLowerCase();
    return config.protocol === 'openai-compatible' && (host === 'localhost' || isLoopback(host));
  }
  save(accountId: string, config: LlmConfigInput): void {
    const prior = this.row(accountId);
    const { apiKey, ...publicConfig } = config;
    const ciphertext = apiKey === undefined ? prior?.key_ciphertext ?? null : apiKey === '' ? null : this.encrypt(accountId, apiKey);
    if (!ciphertext && !this.keyless(config)) fail('INVALID_INPUT', 'A key is required for this model endpoint');
    this.store.run('INSERT INTO llm_configs VALUES(?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET config_json=excluded.config_json,key_ciphertext=excluded.key_ciphertext,updated_at=excluded.updated_at', accountId, JSON.stringify(publicConfig), ciphertext, this.now());
  }
  delete(accountId: string): void { this.store.run('DELETE FROM llm_configs WHERE account_id=?', accountId); }
  private encrypt(accountId: string, key: string): string {
    const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.key, nonce); cipher.setAAD(Buffer.from(accountId));
    const data = Buffer.concat([cipher.update(key), cipher.final()]);
    return JSON.stringify({ nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
  }
  private decrypt(accountId: string, ciphertext: string | null): string | null {
    if (!ciphertext) return null;
    const v = JSON.parse(ciphertext) as { nonce: string; tag: string; data: string };
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(v.nonce, 'base64')); decipher.setAAD(Buffer.from(accountId)); decipher.setAuthTag(Buffer.from(v.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(v.data, 'base64')), decipher.final()]).toString();
  }
  async decide(input: ProviderInvocation): Promise<ProviderDecision> {
    return this.invoke(input.accountId, input.observation, input.observation.legalActions, input.signal, input.timeoutMs);
  }
  async test(accountId: string, signal: AbortSignal): Promise<void> {
    const view = this.view(accountId);
    await this.invoke(accountId, { decisionNonce: randomBytes(16).toString('hex'), legalActions: [{ type: 'check' }] }, [{ type: 'check' }], signal, view.limits.timeoutMs, 64);
  }
  private async invoke(accountId: string, observation: { decisionNonce: string; legalActions: LegalAction[] }, legal: LegalAction[], signal: AbortSignal, timeoutMs: number, outputLimit?: number): Promise<ProviderDecision> {
    try {
      const row = this.row(accountId); if (!row) throw new ProviderError('MODEL_ERROR');
      const config = JSON.parse(row.config_json) as LlmConfigInput;
      const key = this.decrypt(accountId, row.key_ciphertext);
      const url = endpoint(config.baseUrl); url.pathname += config.protocol === 'anthropic' ? '/messages' : '/chat/completions';
      const instruction = 'Choose exactly one legal action. Return only JSON {"decisionNonce": the given nonce, "action": {"type":"fold|check|call"} or {"type":"raise","amount":integer}}. Echo decisionNonce. No other fields, markdown, explanation or tools.';
      const content = JSON.stringify(observation);
      const budget = outputLimit ?? config.limits.maxOutputTokens;
      const body = config.protocol === 'anthropic' ? { model: config.model, system: instruction, messages: [{ role: 'user', content }], max_tokens: budget, stream: false } :
        { model: config.model, messages: [{ role: 'system', content: instruction }, { role: 'user', content }], [config.tokenLimitField ?? 'max_tokens']: budget, stream: false };
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (config.protocol === 'anthropic') { headers['anthropic-version'] = '2023-06-01'; headers['x-api-key'] = key!; }
      else if (key) headers.authorization = `Bearer ${key}`;
      const response = await boundedRequest(url, body, headers, signal, timeoutMs);
      let value: Record<string, unknown>;
      try { value = object(JSON.parse(response)); } catch { throw new ProviderError('INVALID_RESPONSE'); }
      let raw: unknown;
      if (config.protocol === 'anthropic') {
        if (value.stop_reason !== 'end_turn' || !Array.isArray(value.content) || value.content.length !== 1 || value.content[0]?.type !== 'text') throw new ProviderError('INVALID_RESPONSE');
        raw = value.content[0].text;
      } else {
        const choices = value.choices;
        if (!Array.isArray(choices) || choices.length !== 1 || choices[0]?.finish_reason !== 'stop' || choices[0]?.message?.tool_calls?.length || choices[0]?.message?.function_call || choices[0]?.message?.refusal) throw new ProviderError('INVALID_RESPONSE');
        raw = choices[0].message?.content;
      }
      return parseDecision(raw, observation.decisionNonce, legal);
    } catch (error) { if (error instanceof ProviderError) throw error; throw new ProviderError('MODEL_ERROR'); }
  }
}
export function parseDecision(raw: unknown, nonce: string, legal: LegalAction[]): ProviderDecision {
  try {
    if (typeof raw !== 'string' || raw.length > 4096) throw new Error();
    const parsed = object(JSON.parse(raw)); exactKeys(parsed, ['decisionNonce', 'action']);
    if (Object.keys(parsed).length !== 2 || parsed.decisionNonce !== nonce) throw new Error();
    const action = object(parsed.action); exactKeys(action, action.type === 'raise' ? ['type', 'amount'] : ['type']);
    if (Object.keys(action).length !== (action.type === 'raise' ? 2 : 1)) throw new Error();
    const permitted = legal.find(item => item.type === action.type); if (!permitted) throw new Error();
    if (action.type === 'raise') {
      const amount = integer(action.amount, 'raise amount');
      if (permitted.type !== 'raise' || amount < permitted.minAmount || amount > permitted.maxAmount || (permitted.allInOnly && amount !== permitted.maxAmount)) throw new Error();
      return { decisionNonce: nonce, action: { type: 'raise', amount } };
    }
    if (!['fold', 'check', 'call'].includes(String(action.type))) throw new Error();
    return { decisionNonce: nonce, action: { type: action.type } as HoldemAction };
  } catch { throw new ProviderError('INVALID_RESPONSE'); }
}

export async function boundedRequest(url: URL, body: unknown, headers: Record<string, string>, signal: AbortSignal, timeoutMs: number,
  resolveHost = (host: string): Promise<{ address: string; family: number }[]> => lookup(host, { all: true, verbatim: true })): Promise<string> {
  return new Promise((resolve, reject) => {
    let done = false; let req: ReturnType<typeof httpRequest> | undefined;
    const finish = (error: ProviderError | null, result?: string) => {
      if (done) return; done = true; clearTimeout(timer); signal.removeEventListener('abort', cancel);
      if (error) { req?.destroy(); reject(error); } else resolve(result!);
    };
    const cancel = () => finish(new ProviderError('MODEL_ERROR'));
    const timer = setTimeout(() => finish(new ProviderError('REQUEST_TIMEOUT')), timeoutMs);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) { cancel(); return; }
    void (async () => {
      const host = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
      const local = host === 'localhost' || isLoopback(host);
      const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolveHost(host);
      if (!addresses.length || addresses.some(item => local ? !isLoopback(item.address) : !isPublicAddress(item.address))) throw new ProviderError('MODEL_ERROR');
      if (done) return;
      const selected = addresses[0]!;
      const serialized = JSON.stringify(body);
      req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method: 'POST', headers: { ...headers, 'content-length': String(Buffer.byteLength(serialized)) }, agent: false,
        lookup: ((_host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
          if (options.all) callback(null, [selected]); else callback(null, selected.address, selected.family);
        }) as never
      }, response => {
        if (response.statusCode !== 200) { response.destroy(); finish(new ProviderError('MODEL_ERROR')); return; }
        const chunks: Buffer[] = []; let size = 0;
        response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 32 * 1024) { finish(new ProviderError('INVALID_RESPONSE')); response.destroy(); } else chunks.push(chunk); });
        response.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
        response.on('error', () => finish(new ProviderError('MODEL_ERROR')));
        response.on('aborted', () => finish(new ProviderError('MODEL_ERROR')));
      });
      req.on('error', () => finish(new ProviderError('MODEL_ERROR'))); req.end(serialized);
    })().catch(() => finish(new ProviderError('MODEL_ERROR')));
  });
}

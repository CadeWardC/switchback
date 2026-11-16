// The Switchback server (self-hosted): collections of JSON documents addressed by id, over HTTPS.
//   GET /health · GET /v1/{c}[?since=ms] · GET|PUT|DELETE /v1/{c}/{id}, with Authorization: Bearer <key>.
// Signing in is optional: without an address and key the app keeps everything on the phone. The address is
// kept with the settings; the key in the phone's secure store (Keychain / Android Keystore). Nothing about
// the server is built into the app.
import * as SecureStore from 'expo-secure-store';
import { signal } from '@preact/signals-core';
import { load, save } from '@web/lib/storage';

const URL_KEY = 'server-url';
const KEY_NAME = 'switchback-server-api-key';

/** The address (normalised) and whether a key is stored; null until signed in. */
export const serverUrl = signal<string | null>(load<string | null>(URL_KEY, null));
export const hasKey = signal(false);
let apiKey: string | null = null;

/** Reads the key from the secure store once at launch. */
export async function loadServerKey(): Promise<void> {
  try { apiKey = await SecureStore.getItemAsync(KEY_NAME); } catch { apiKey = null; }
  hasKey.value = !!apiKey;
}

/** Accepts "host", "host/" or "https://host"; the server is HTTPS only. */
export function normaliseUrl(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
  s = s.replace(/\/+$/, '');
  return /^https:\/\/[^/\s]+(\/[^\s]*)?$/i.test(s) ? s : null;
}

export async function signIn(url: string, key: string): Promise<void> {
  const u = normaliseUrl(url);
  if (!u) throw new Error('Enter the server address (https only).');
  if (key.trim()) {
    await SecureStore.setItemAsync(KEY_NAME, key.trim());
    apiKey = key.trim();
  }
  if (!apiKey) throw new Error('Enter the API key.');
  save(URL_KEY, u);
  hasKey.value = true;
  serverUrl.value = u;
}

export async function signOut(): Promise<void> {
  try { await SecureStore.deleteItemAsync(KEY_NAME); } catch { /* already gone */ }
  apiKey = null;
  hasKey.value = false;
  save(URL_KEY, null);
  serverUrl.value = null;
}

export const isSignedIn = () => !!serverUrl.peek() && !!apiKey;

/** Which server and key are in use, so signing in somewhere else starts a fresh first sync. */
export const fingerprint = () => `${serverUrl.peek() ?? ''}#${(apiKey ?? '').slice(-8)}`;

// ── Errors, in words for the person using the app ─────────────────────────────────────────────────────
export class ServerError extends Error {
  constructor(message: string, readonly status: number | null, readonly offline = false) { super(message); }
}

const MAX_BODY = 2_000_000;

function explain(status: number, serverMessage?: string): string {
  if (status === 401) return "The server didn't accept the API key. Check it in Settings › Account & sync.";
  if (status === 403) return 'The request was blocked before it reached the server (403). Check the tunnel\'s security settings for this host.';
  if (status === 413) return 'An item is too big for the server (the limit is about 2 MB).';
  return `The server answered ${status}${serverMessage ? `: ${serverMessage}` : ''}.`;
}

export { validName } from './syncFormat';

async function request(method: string, path: string, body?: unknown, base = serverUrl.peek(), auth = true): Promise<unknown> {
  if (!base || (auth && !apiKey)) throw new ServerError('Sign in under Settings › Account & sync to use the server.', null);
  let text: string | undefined;
  if (body !== undefined) {
    text = JSON.stringify(body);
    if (text.length > MAX_BODY) throw new ServerError(`An item is too big to upload (${(text.length / 1e6).toFixed(1)} MB; the limit is about 2 MB).`, 413);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let res: Response;
  try {
    res = await fetch(base + path, {
      method,
      headers: {
        ...(auth ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...(text !== undefined ? { 'Content-Type': 'application/json' } : {}),
        Accept: 'application/json',
      },
      body: text,
      signal: controller.signal,
    });
  } catch {
    throw new ServerError('No connection to the server. Changes are kept on the phone and sync when it\'s back.', null, true);
  } finally {
    clearTimeout(timer);
  }
  const raw = await res.text();
  let data: unknown = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  if (!res.ok) {
    const msg = data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : undefined;
    throw new ServerError(explain(res.status, msg), res.status);
  }
  return data;
}

export interface ServerDoc<T> { id: string; updated_at: number; deleted: boolean; data: T | null }
export interface ServerList<T> { items: ServerDoc<T>[]; server_time: number }

export const api = {
  /** GET /health (no key). Returns a sentence for Settings. */
  async health(base = serverUrl.peek()): Promise<string> {
    try {
      const r = await request('GET', '/health', undefined, base, false);
      return String(r).trim() === 'ok' ? 'Connected: the server is up.' : 'The server answered, but not with "ok".';
    } catch (e) {
      return (e as Error).message;
    }
  },
  list: <T>(c: string, since?: number) => request('GET', `/v1/${c}${since != null ? `?since=${since}` : ''}`) as Promise<ServerList<T>>,
  async get<T>(c: string, id: string): Promise<ServerDoc<T> | null> {
    try { return (await request('GET', `/v1/${c}/${encodeURIComponent(id)}`)) as ServerDoc<T>; } catch (e) {
      if (e instanceof ServerError && e.status === 404) return null;
      throw e;
    }
  },
  put: (c: string, id: string, body: unknown) => request('PUT', `/v1/${c}/${encodeURIComponent(id)}`, body) as Promise<{ id: string; updated_at: number }>,
  async remove(c: string, id: string): Promise<void> {
    try { await request('DELETE', `/v1/${c}/${encodeURIComponent(id)}`); } catch (e) {
      if (!(e instanceof ServerError && e.status === 404)) throw e;
    }
  },
};

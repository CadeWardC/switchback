// The Switchback server (server/ in this repository): accounts with an email and password, your hikes and saved
// trails, photos and trail submissions, over HTTPS.
//
// An account is optional: without one the app keeps everything on the phone. Logging in returns a short-lived
// access token and a long-lived refresh token; the refresh token (and the user) are kept in the phone's secure
// store (Keychain / Android Keystore), the access token only in memory. A request that finds its access token
// expired gets a new one with the refresh token and is tried once more.
//
// The server's address is built in (app.config.js extra.serverUrl: the Orange Pi, unless SWITCHBACK_SERVER_URL
// says otherwise); people never type it. Nothing secret is built into the app.
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import { signal } from '@preact/signals-core';
import { platform } from '../platform';

const SESSION_KEY = 'switchback-session';

export interface Account { id: string; display_name: string }
interface Session { refresh: string; user: Account }

const built = String((Constants.expoConfig?.extra as { serverUrl?: string } | undefined)?.serverUrl ?? '').trim();

/** The server's address in use (normalised), or null when none is known yet. */
export const serverUrl = signal<string | null>(normaliseUrl(built));
/** Who is logged in; null when nobody is. */
export const account = signal<Account | null>(null);

let session: Session | null = null;
let access: { token: string; until: number } | null = null;

/** Reads the session from the secure store once at launch. */
export async function loadSession(): Promise<void> {
  try {
    const raw = await SecureStore.getItemAsync(SESSION_KEY);
    session = raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    session = null;
  }
  account.value = session?.user ?? null;
}

async function keep(s: Session | null): Promise<void> {
  session = s;
  account.value = s?.user ?? null;
  try {
    if (s) await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(s));
    else await SecureStore.deleteItemAsync(SESSION_KEY);
  } catch { /* the secure store is unavailable: the session lasts until the app closes */ }
}

/** Accepts "host", "host/" or "https://host"; the server is HTTPS only. */
export function normaliseUrl(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
  s = s.replace(/\/+$/, '');
  return /^https:\/\/[^/\s]+(\/[^\s]*)?$/i.test(s) ? s : null;
}

export const isSignedIn = () => !!serverUrl.peek() && !!session;

/** Which server and account are in use, so logging in as someone else starts a fresh first sync. */
export const fingerprint = () => `${serverUrl.peek() ?? ''}#${session?.user.id ?? ''}`;

// ── Errors, in words for the person using the app ─────────────────────────────────────────────────────
export class ServerError extends Error {
  constructor(message: string, readonly status: number | null, readonly offline = false, readonly code = '') { super(message); }
}

const MAX_BODY = 2_000_000;

function explain(status: number, code: string, message?: string): string {
  if (message) return message;
  if (status === 401) return 'Log in again (Settings › Account).';
  if (status === 403) return 'Switchback can\'t be reached right now. Try again later.';
  if (status === 413) return 'That is too big to upload.';
  return `Something went wrong (${status}${code ? `, ${code}` : ''}). Try again later.`;
}

interface RequestOptions { auth?: boolean; base?: string | null; retried?: boolean }

async function call(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<unknown> {
  const base = opts.base ?? serverUrl.peek();
  const auth = opts.auth ?? true;
  if (!base) throw new ServerError('Accounts aren\'t available in this version of the app.', null);
  if (auth && !session) throw new ServerError('Log in under Settings › Account to use your account.', null);
  let text: string | undefined;
  if (body !== undefined) {
    text = JSON.stringify(body);
    if (text.length > MAX_BODY) throw new ServerError(`That is too big to upload (${(text.length / 1e6).toFixed(1)} MB; the limit is about 2 MB).`, 413);
  }
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (text !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) headers.Authorization = `Bearer ${await accessToken(base)}`;
  const res = await send(base + path, { method, headers, body: text });
  if (res.status === 401 && auth && !opts.retried) {
    // the access token ran out early (or the server restarted): a fresh one, once
    access = null;
    return call(method, path, body, { ...opts, retried: true });
  }
  return parse(res);
}

async function send(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    throw new ServerError('No connection. Everything is kept on the phone and syncs when it\'s back.', null, true);
  } finally {
    clearTimeout(timer);
  }
}

async function parse(res: Response): Promise<unknown> {
  const raw = await res.text();
  let data: unknown = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  if (!res.ok) {
    const e = data && typeof data === 'object' ? (data as { error?: { code?: string; message?: string } | string }).error : undefined;
    const code = typeof e === 'object' && e ? e.code ?? '' : '';
    const msg = typeof e === 'object' && e ? e.message : typeof e === 'string' ? e : undefined;
    throw new ServerError(explain(res.status, code, msg), res.status, false, code);
  }
  return data;
}

interface Tokens { access_token: string; expires_in: number; refresh_token: string; user: Account; new_user?: boolean }

async function accessToken(base: string): Promise<string> {
  if (access && access.until > Date.now() + 30_000) return access.token;
  if (!session) throw new ServerError('Log in under Settings › Account.', 401);
  const res = await send(`${base}/v1/auth/refresh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ refresh_token: session.refresh }),
  });
  if (res.status === 401) {
    // the session was ended (logged out elsewhere, or the account deleted)
    await keep(null);
    access = null;
    throw new ServerError("You've been logged out. Log in again under Settings › Account.", 401, false, 'signed_out');
  }
  const t = (await parse(res)) as Tokens;
  await startSession(t);
  return t.access_token;
}

async function startSession(t: Tokens): Promise<void> {
  access = { token: t.access_token, until: Date.now() + t.expires_in * 1000 };
  await keep({ refresh: t.refresh_token, user: t.user });
}

const device = () => `${platform.name} app`;

// ── Accounts ──────────────────────────────────────────────────────────────────────────────────────────
export async function register(email: string, password: string, displayName: string): Promise<Account> {
  const t = (await call('POST', '/v1/auth/register', { email: email.trim(), password, display_name: displayName.trim() || undefined, device: device() }, { auth: false })) as Tokens;
  await startSession(t);
  return t.user;
}

export async function logIn(email: string, password: string): Promise<Account> {
  const t = (await call('POST', '/v1/auth/login', { email: email.trim(), password, device: device() }, { auth: false })) as Tokens;
  await startSession(t);
  return t.user;
}

export async function logOut(): Promise<void> {
  const s = session;
  await keep(null);
  access = null;
  if (s) await call('POST', '/v1/auth/logout', { refresh_token: s.refresh }, { auth: false }).catch(() => {});
}

export async function rename(displayName: string): Promise<void> {
  const u = (await call('PATCH', '/v1/me', { display_name: displayName.trim() })) as Account;
  if (session) await keep({ ...session, user: { id: u.id ?? session.user.id, display_name: u.display_name ?? displayName.trim() } });
}

// ── The API ───────────────────────────────────────────────────────────────────────────────────────────
export interface ServerDoc<T> { id: string; updated_at: number; deleted: boolean; data: T | null }
export interface ServerList<T> { items: ServerDoc<T>[]; server_time: number }

export const api = {
  /** GET /healthz (no account). Returns a sentence for the account screen. */
  async health(base = serverUrl.peek()): Promise<string> {
    if (!base) return 'Accounts aren\'t available in this version of the app.';
    try {
      const res = await send(`${base}/healthz`, { method: 'GET' });
      const text = (await res.text()).trim();
      return res.ok && text === 'ok' ? 'Connected.' : `Switchback can't be reached right now (${res.status}).`;
    } catch (e) {
      return (e as Error).message;
    }
  },
  call,
  /** Your own documents (hikes, saved trails): the same list-since-put-delete as a document store. */
  docs: {
    list: <T>(c: string, since?: number) => call('GET', `/v1/me/docs/${c}${since != null ? `?since=${since}` : ''}`) as Promise<ServerList<T>>,
    put: (c: string, id: string, body: unknown) => call('PUT', `/v1/me/docs/${c}/${encodeURIComponent(id)}`, body) as Promise<{ id: string; updated_at: number }>,
    async remove(c: string, id: string): Promise<void> {
      try { await call('DELETE', `/v1/me/docs/${c}/${encodeURIComponent(id)}`); } catch (e) {
        if (!(e instanceof ServerError && e.status === 404)) throw e;
      }
    },
  },
  /** An access token for an upload done outside fetch (photos). */
  token: async () => {
    const base = serverUrl.peek();
    if (!base || !session) throw new ServerError('Log in under Settings › Account.', 401);
    return { base, token: await accessToken(base) };
  },
  forgetAccessToken: () => { access = null; },
};

export { validName } from './syncFormat';

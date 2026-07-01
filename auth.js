/**
 * Backchannel extension auth client.
 *
 * Talks to the Better Auth endpoints on the backend. Runs in the SERVICE
 * WORKER (background.js) because it needs chrome.identity + chrome.storage,
 * which content scripts don't have. Content scripts request account actions
 * via chrome.runtime.sendMessage({ t: 'account', ... }).
 *
 * Token model: the backend enables Better Auth's bearer plugin, so every
 * authenticated response carries a `set-auth-token` header. We stash that token
 * in chrome.storage.local and present it as `Authorization: Bearer <token>` on
 * HTTP calls and as `?token=<token>` on the WebSocket. First run silently
 * provisions an ANONYMOUS session (pseudonymous handle, zero friction); the
 * user can later upgrade it in place by linking Google/GitHub.
 */

import { API_URL } from './config.js';

export async function getStoredToken() {
  const { token } = await chrome.storage.local.get('token');
  return token ?? null;
}

async function storeToken(token) {
  if (token) await chrome.storage.local.set({ token });
}

function captureRotatedToken(res) {
  const t = res.headers.get('set-auth-token');
  if (t) void storeToken(t);
}

/** Return a valid token, provisioning an anonymous session if none exists. */
export async function ensureToken() {
  let token = await getStoredToken();
  if (token) return token;

  const res = await fetch(`${API_URL}/api/auth/sign-in/anonymous`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) throw new Error(`anonymous sign-in failed: ${res.status}`);
  captureRotatedToken(res);

  const data = await res.json().catch(() => ({}));
  if (data?.token) await storeToken(data.token);
  return getStoredToken();
}

/** fetch() wrapper that attaches the bearer token and captures rotations. */
export async function authFetch(path, opts = {}) {
  const token = await ensureToken();
  const headers = new Headers(opts.headers || {});
  headers.set('authorization', `Bearer ${token}`);
  const res = await fetch(`${API_URL}${path}`, { ...opts, headers });
  captureRotatedToken(res);
  return res;
}

export async function getProfile() {
  const res = await authFetch('/me');
  return res.ok ? res.json() : null;
}

export async function setHandle(handle) {
  const res = await authFetch('/me/handle', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'handle_failed');
  return res.json();
}

export async function signOut() {
  await authFetch('/api/auth/sign-out', { method: 'POST' }).catch(() => {});
  await chrome.storage.local.remove('token');
}

/**
 * Link a social account (Google/GitHub) to the current (anonymous) session.
 * Uses chrome.identity.launchWebAuthFlow. The backend redirects OAuth back to
 * a tiny helper page (/ext/callback) that reads the fresh bearer token and
 * bounces to the extension's chromiumapp.org redirect with #token=... .
 */
export async function signInWithProvider(provider) {
  const redirect = chrome.identity.getRedirectURL();
  const token = await ensureToken();
  const res = await fetch(`${API_URL}/api/auth/sign-in/social`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      provider,
      callbackURL: `${API_URL}/ext/callback?redirect=${encodeURIComponent(redirect)}`,
    }),
  });
  if (!res.ok) throw new Error(`social sign-in init failed: ${res.status}`);
  const { url } = await res.json();

  const finalUrl = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
  const params = new URLSearchParams(new URL(finalUrl).hash.slice(1));
  const newToken = params.get('token');
  if (newToken) {
    await storeToken(newToken);
    return true;
  }
  return false;
}

/**
 * Backchannel service worker (MV3)
 *
 * OWNS THE ONE WEBSOCKET for the whole browser. Content scripts talk to it
 * over chrome.runtime Ports. This dedupes connections (10 tabs = 1 socket)
 * and survives tab navigation.
 *
 * MV3 lifetime gotcha: service workers are killed after ~30s idle. Since
 * Chrome 116, an OPEN WebSocket with traffic at least every 30s keeps the
 * worker alive — so the server must send a ping every ~20s. We also set a
 * chrome.alarms fallback to reconnect if the worker was killed anyway.
 *
 * Message protocol over the Port (all JSON):
 *   content → sw:  {t:'join',  roomKey, title}          subscribe this tab
 *                  {t:'send',  roomKey, body, parentId?} post a message
 *                  {t:'typing',roomKey}                  typing signal
 *                  {t:'react', roomKey, messageId, emoji, op}
 *                  {t:'leave', roomKey}
 *   sw → content:  {t:'msg',   roomKey, msg}             one chat message
 *                  {t:'history', roomKey, msgs}          backfill on join/reconnect
 *                  {t:'presence', roomKey, count}
 *                  {t:'typing', roomKey, handle, color}
 *                  {t:'react', roomKey, messageId, emoji, count}
 *                  {t:'achievement', a}                  (no roomKey → all ports)
 *                  {t:'status', state}                   'connecting'|'open'|'down'
 */

import {
  ensureToken,
  clearToken,
  authFetch,
  getProfile,
  setHandle,
  setColor,
  setBadge,
  getAchievements,
  sendReport,
  signOut,
  signInWithProvider,
  getAuthConfig,
  sendEmailOTP,
  verifyEmailOTP,
} from './auth.js';
import { WS_URL } from './config.js';

let ws = null;
let wsState = 'down';
let backoff = 1000;                 // reconnect backoff, capped below
let everConnected = false;          // distinguishes first connect from reconnects

// roomKey → Set<Port>  (which tabs care about which rooms)
const roomPorts = new Map();
// Port → Set<roomKey>  (cleanup on tab close)
const portRooms = new Map();

// ---------------------------------------------------------------------------
// Socket lifecycle
// ---------------------------------------------------------------------------
async function ensureSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  // Provision an anonymous session on first use so the socket always carries a
  // valid identity (the server closes unauthenticated sockets with 4401).
  let token;
  try {
    token = await ensureToken();
  } catch {
    setState('down');
    setTimeout(ensureSocket, backoff);
    backoff = Math.min(backoff * 2, 30_000);
    return;
  }
  setState('connecting');
  ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token ?? '')}`);

  ws.onopen = () => {
    backoff = 1000;
    const isReconnect = everConnected;
    everConnected = true;
    setState('open');
    // Re-subscribe every room any tab is in (reconnect case)
    for (const roomKey of roomPorts.keys()) {
      ws.send(JSON.stringify({ t: 'sub', roomKey }));
    }
    // After a reconnect, messages sent while we were down never reached us —
    // refetch history for every open room. Sidebars dedupe by message id.
    if (isReconnect) {
      for (const roomKey of roomPorts.keys()) void deliverHistory(roomKey);
    }
  };

  ws.onmessage = (ev) => {
    const frame = JSON.parse(ev.data);
    if (frame.t === 'ping') { ws.send('{"t":"pong"}'); return; }  // keepalive
    if (!frame.roomKey) { broadcastAll(frame); return; }          // e.g. achievements
    const ports = roomPorts.get(frame.roomKey);
    if (!ports) return;
    for (const port of ports) {
      try { port.postMessage(frame); } catch { /* port died; cleaned up below */ }
    }
  };

  ws.onclose = (ev) => {
    setState('down');
    ws = null;
    // 4401 = the server rejected our token (expired/revoked session). Retrying
    // with the same credential would loop forever — drop it so the next
    // attempt provisions a fresh anonymous identity.
    if (ev?.code === 4401) void clearToken();
    if (roomPorts.size > 0) {
      setTimeout(ensureSocket, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  };
  ws.onerror = () => ws?.close();
}

function setState(state) {
  wsState = state;
  broadcastAll({ t: 'status', state });
}

function broadcastAll(frame) {
  for (const port of portRooms.keys()) {
    try { port.postMessage(frame); } catch {}
  }
}

// History backfill over plain HTTPS — pub/sub is fire-and-forget, so recent
// messages always come from the API. Sent with the bearer token so the server
// can mark which reactions are ours. Failure is non-fatal (cold start, etc.);
// the sidebar just shows live traffic until the next join.
async function deliverHistory(roomKey, port = null) {
  try {
    const res = await authFetch(`/rooms/${encodeURIComponent(roomKey)}/messages?limit=50`);
    if (!res.ok) return;
    const frame = { t: 'history', roomKey, msgs: await res.json() };
    const targets = port ? [port] : [...(roomPorts.get(roomKey) ?? [])];
    for (const p of targets) {
      try { p.postMessage(frame); } catch {}
    }
  } catch { /* offline or cold-starting; live frames will still arrive */ }
}

// Fallback: if Chrome killed the worker while tabs still wanted rooms,
// this alarm re-runs the worker and reconnects. Fires at most once/minute.
chrome.alarms.create('bc-reconnect', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => { if (roomPorts.size) ensureSocket(); });

// ---------------------------------------------------------------------------
// Ports from content scripts
// ---------------------------------------------------------------------------
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'backchannel') return;
  portRooms.set(port, new Set());
  port.postMessage({ t: 'status', state: wsState });

  port.onMessage.addListener(async (m) => {
    if (m.t === 'join') {
      addToRoom(port, m.roomKey);
      await ensureSocket();
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: 'sub', roomKey: m.roomKey, title: m.title }));
      }
      await deliverHistory(m.roomKey, port);
    }

    if (m.t === 'send' && ws?.readyState === WebSocket.OPEN) {
      const frame = { t: 'msg', roomKey: m.roomKey, body: m.body };
      if (m.parentId) frame.parentId = m.parentId;
      ws.send(JSON.stringify(frame));
    }

    if (m.t === 'typing' && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: 'typing', roomKey: m.roomKey }));
    }

    if (m.t === 'react' && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        t: 'react', roomKey: m.roomKey, messageId: m.messageId, emoji: m.emoji, op: m.op,
      }));
    }

    if (m.t === 'leave') removeFromRoom(port, m.roomKey);
  });

  port.onDisconnect.addListener(() => {
    for (const roomKey of portRooms.get(port) ?? []) removeFromRoom(port, roomKey);
    portRooms.delete(port);
    if (roomPorts.size === 0) { ws?.close(); ws = null; }   // last tab gone
  });
});

function addToRoom(port, roomKey) {
  if (!roomPorts.has(roomKey)) roomPorts.set(roomKey, new Set());
  roomPorts.get(roomKey).add(port);
  portRooms.get(port).add(roomKey);
}

function removeFromRoom(port, roomKey) {
  const ports = roomPorts.get(roomKey);
  if (!ports) return;
  ports.delete(port);
  portRooms.get(port)?.delete(roomKey);
  if (ports.size === 0) {
    roomPorts.delete(roomKey);
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: 'unsub', roomKey }));      // server drops us
    }
  }
}

// Toolbar button toggles the sidebar in the active tab
chrome.action.onClicked.addListener((tab) => {
  if (tab.id) chrome.tabs.sendMessage(tab.id, { t: 'toggle' }).catch(() => {});
});

// Pop the sidebar out into a standalone chrome.windows popup. The popup page
// is a static HTML shell in the extension bundle; it opens its own Port to us
// (so it participates in the same fanout as any tab).
async function popOut({ pageKey, domainKey, roomKey, title }) {
  const params = new URLSearchParams();
  if (pageKey) params.set('page', pageKey);
  if (domainKey) params.set('domain', domainKey);
  if (roomKey) params.set('room', roomKey);
  if (title) params.set('title', title);
  const url = chrome.runtime.getURL('popup.html') + '?' + params.toString();
  await chrome.windows.create({ url, type: 'popup', width: 400, height: 720 });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Account actions from content scripts. chrome.identity + chrome.storage live
// here in the worker, so the sidebar UI proxies through us.
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((m, _sender, sendResponse) => {
  if (m?.t !== 'account') return;
  (async () => {
    try {
      switch (m.action) {
        case 'profile':
          sendResponse(await getProfile());
          break;
        case 'setHandle':
          sendResponse(await setHandle(m.handle));
          break;
        case 'setColor':
          sendResponse(await setColor(m.color));
          break;
        case 'setBadge':
          sendResponse(await setBadge(m.badge));
          break;
        case 'achievements':
          sendResponse(await getAchievements());
          break;
        case 'report':
          sendResponse(await sendReport(m.report));
          break;
        case 'signIn':
          sendResponse({ ok: await signInWithProvider(m.provider) });
          break;
        case 'authConfig':
          sendResponse(await getAuthConfig());
          break;
        case 'sendEmailOTP':
          sendResponse(await sendEmailOTP(m.email));
          break;
        case 'verifyEmailOTP':
          sendResponse({ ok: await verifyEmailOTP(m.email, m.otp) });
          break;
        case 'signOut':
          await signOut();
          sendResponse({ ok: true });
          break;
        case 'popOut':
          sendResponse(await popOut(m));
          break;
        default:
          sendResponse({ error: 'unknown_action' });
      }
    } catch (e) {
      sendResponse({ error: String(e?.message ?? e) });
    }
  })();
  return true; // keep the message channel open for the async response
});

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
 *   content → sw:  {t:'join',  roomKey, title}      subscribe this tab
 *                  {t:'send',  roomKey, body}        post a message
 *                  {t:'leave', roomKey}
 *   sw → content:  {t:'msg',   roomKey, msg}         one chat message
 *                  {t:'history', roomKey, msgs}      backfill on join
 *                  {t:'presence', roomKey, count}
 *                  {t:'status', state}               'connecting'|'open'|'down'
 */

import {
  ensureToken,
  getProfile,
  setHandle,
  signOut,
  signInWithProvider,
} from './auth.js';
import { API_URL, WS_URL } from './config.js';

let ws = null;
let wsState = 'down';
let backoff = 1000;                 // reconnect backoff, capped below

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
    setState('open');
    // Re-subscribe every room any tab is in (reconnect case)
    for (const roomKey of roomPorts.keys()) {
      ws.send(JSON.stringify({ t: 'sub', roomKey }));
    }
  };

  ws.onmessage = (ev) => {
    const frame = JSON.parse(ev.data);
    if (frame.t === 'ping') { ws.send('{"t":"pong"}'); return; }  // keepalive
    const ports = roomPorts.get(frame.roomKey);
    if (!ports) return;
    for (const port of ports) {
      try { port.postMessage(frame); } catch { /* port died; cleaned up below */ }
    }
  };

  ws.onclose = () => {
    setState('down');
    ws = null;
    if (roomPorts.size > 0) {
      setTimeout(ensureSocket, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  };
  ws.onerror = () => ws?.close();
}

function setState(state) {
  wsState = state;
  for (const port of portRooms.keys()) {
    try { port.postMessage({ t: 'status', state }); } catch {}
  }
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
      // History backfill over plain HTTPS — pub/sub is fire-and-forget,
      // so recent messages always come from the API, not the socket.
      const res = await fetch(`${API_URL}/rooms/${encodeURIComponent(m.roomKey)}/messages?limit=50`);
      if (res.ok) port.postMessage({ t: 'history', roomKey: m.roomKey, msgs: await res.json() });
    }

    if (m.t === 'send' && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: 'msg', roomKey: m.roomKey, body: m.body }));
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
        case 'signIn':
          sendResponse({ ok: await signInWithProvider(m.provider) });
          break;
        case 'signOut':
          await signOut();
          sendResponse({ ok: true });
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

/**
 * Backchannel content script
 *
 * Responsibilities:
 *   1. Compute the room key for the current URL (client-side preview;
 *      the server recomputes authoritatively).
 *   2. Inject the sidebar inside a closed Shadow DOM so host-page CSS
 *      can't touch us and we can't leak styles onto the page.
 *   3. Track SPA navigations (History API + popstate) and re-join rooms.
 *   4. Relay between the sidebar UI and the service worker Port.
 *
 * Deliberately zero frameworks: content scripts should be tiny. If the UI
 * grows, move it to an <iframe src=chrome-extension://...> instead —
 * that gets you a real document, framework freedom, and stronger isolation.
 */

import { normalize } from './normalize.js';   // bundle with esbuild/vite

let port = null;
let currentRoom = null;      // pageKey if it exists, else domainKey
let shadowHost = null;
let ui = {};                 // refs into the shadow DOM
let visible = false;
let profile = null;          // { id, handle, color } for the local user

// 12-color handle palette, indexed by the server-assigned displayColor.
// Tuned to stay legible on both dark and light backgrounds without shouting.
const PALETTE = [
  '#f87171', '#fb923c', '#fbbf24', '#a3e635',
  '#4ade80', '#2dd4bf', '#22d3ee', '#60a5fa',
  '#a78bfa', '#e879f9', '#f472b6', '#94a3b8',
];

// Tracks the last rendered author so consecutive messages can be grouped.
let lastMsgHandle = null;

// Proxy account actions to the service worker (which owns chrome.identity).
function account(action, extra = {}) {
  return chrome.runtime.sendMessage({ t: 'account', action, ...extra });
}

// ---------------------------------------------------------------------------
// Room resolution + lifecycle
// ---------------------------------------------------------------------------
function resolveRoom() {
  const keys = normalize(location.href);
  if (!keys) return null;
  // MVP policy: prefer the page room when it exists, else domain room.
  // Later: check occupancy first and fall back to the domain room if empty.
  return keys.pageKey ?? keys.domainKey;
}

function joinCurrentRoom() {
  const room = resolveRoom();
  if (room === currentRoom) return;
  if (currentRoom) port?.postMessage({ t: 'leave', roomKey: currentRoom });
  currentRoom = room;
  clearMessages();
  if (room) {
    setHeader(room);
    port?.postMessage({ t: 'join', roomKey: room, title: document.title });
  }
}

function connectPort() {
  port = chrome.runtime.connect({ name: 'backchannel' });
  port.onMessage.addListener(onServerFrame);
  port.onDisconnect.addListener(() => {        // SW was killed; reconnect lazily
    port = null;
    setTimeout(() => { connectPort(); if (currentRoom) {
      port.postMessage({ t: 'join', roomKey: currentRoom, title: document.title });
    }}, 500);
  });
}

function onServerFrame(f) {
  if (f.roomKey && f.roomKey !== currentRoom) return;   // stale room, ignore
  if (f.t === 'history') f.msgs.reverse().forEach(renderMessage);
  if (f.t === 'msg')      renderMessage(f.msg);
  if (f.t === 'presence') ui.presence.textContent = `${f.count} here`;
  if (f.t === 'status')   ui.status.dataset.state = f.state;
}

// ---------------------------------------------------------------------------
// SPA navigation detection: History API patch + popstate + <title> fallback
// ---------------------------------------------------------------------------
function watchNavigation() {
  const fire = () => queueMicrotask(joinCurrentRoom);
  for (const fn of ['pushState', 'replaceState']) {
    const orig = history[fn];
    history[fn] = function (...args) { const r = orig.apply(this, args); fire(); return r; };
  }
  addEventListener('popstate', fire);
  // Some SPAs mutate the URL via <a> + preventDefault without History calls;
  // a cheap poll catches stragglers without a MutationObserver on <head>.
  let lastHref = location.href;
  setInterval(() => { if (location.href !== lastHref) { lastHref = location.href; fire(); } }, 1500);
}

// ---------------------------------------------------------------------------
// Sidebar UI (closed shadow root; minimal inline styles)
// ---------------------------------------------------------------------------
function buildSidebar() {
  shadowHost = document.createElement('div');
  shadowHost.style.cssText = 'all:initial; position:fixed; top:0; right:0; height:100vh; z-index:2147483646;';
  const root = shadowHost.attachShadow({ mode: 'closed' });

  root.innerHTML = `
    <style>
      :host, .panel * { box-sizing: border-box; }

      .panel {
        width: 340px; height: 100vh;
        display: flex; flex-direction: column;
        background: #17171a; color: #ececef;
        border-left: 1px solid #2a2a2f;
        font: 13.5px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI",
              Roboto, "Helvetica Neue", Arial, sans-serif;
        letter-spacing: -0.005em;
        transform: translateX(100%);
        transition: transform .22s cubic-bezier(.4,0,.2,1);
      }
      .panel.open { transform: none; }

      /* ---- Header ---------------------------------------------------- */
      header {
        padding: 11px 14px;
        display: flex; align-items: center; gap: 10px;
        background: #1d1d21;
        border-bottom: 1px solid #2a2a2f;
      }
      header h1 {
        font-size: 13px; font-weight: 600; margin: 0; flex: 1;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      #presence {
        font-size: 12px; color: #9a9aa1;
        display: inline-flex; align-items: center; gap: 6px;
      }
      #presence::before {
        content: ''; width: 6px; height: 6px; border-radius: 50%;
        background: #34d399;
        box-shadow: 0 0 0 3px rgba(52,211,153,.15);
      }
      #status[data-state="down"]::after {
        content: 'reconnecting…'; color: #f87171;
        font-size: 11px; margin-left: 6px;
      }
      #gear {
        border: 0; background: transparent; color: #9a9aa1;
        width: 28px; height: 28px; border-radius: 7px;
        cursor: pointer; padding: 0; font-size: 15px;
        display: inline-flex; align-items: center; justify-content: center;
        transition: background .12s ease, color .12s ease;
      }
      #gear:hover { background: #2a2a2f; color: #ececef; }

      /* ---- Settings drawer ------------------------------------------- */
      #settings {
        display: none;
        padding: 12px 14px 14px;
        border-bottom: 1px solid #2a2a2f;
        flex-direction: column; gap: 8px;
        background: #1d1d21;
      }
      #settings.show { display: flex; }
      #whoami { font-size: 11.5px; color: #9a9aa1; margin-bottom: 2px; }
      #settings .row { display: flex; gap: 6px; }
      #settings input,
      #settings .btn {
        border: 1px solid #313138;
        background: #26262b;
        color: #ececef;
        border-radius: 8px;
        padding: 7px 11px;
        font: inherit;
        outline: none;
        transition: background .12s ease, border-color .12s ease;
      }
      #settings input { flex: 1; }
      #settings input:focus {
        border-color: #4a90e2;
        background: #2a2a30;
      }
      #settings input::placeholder { color: #6c6c74; }
      #settings .btn { cursor: pointer; white-space: nowrap; }
      #settings .btn:hover { background: #30303a; border-color: #3e3e48; }
      #settings .btn:active { background: #26262b; }
      #settings small {
        color: #9a9aa1; font-size: 11.5px; min-height: 14px;
      }

      /* ---- Log ------------------------------------------------------- */
      #log {
        flex: 1; overflow-y: auto;
        padding: 12px 14px 14px;
        scrollbar-width: thin;
        scrollbar-color: #3a3a42 transparent;
      }
      #log::-webkit-scrollbar { width: 8px; }
      #log::-webkit-scrollbar-track { background: transparent; }
      #log::-webkit-scrollbar-thumb {
        background: #3a3a42;
        border-radius: 4px;
        border: 2px solid transparent;
        background-clip: content-box;
      }
      #log::-webkit-scrollbar-thumb:hover {
        background: #4a4a54; background-clip: content-box;
      }

      .m {
        margin: 8px 0 0;
        word-wrap: break-word; overflow-wrap: anywhere;
      }
      .m:first-child { margin-top: 0; }
      .m.grouped { margin-top: 2px; }
      .m .name {
        font-weight: 600; font-size: 12.5px; margin-right: 6px;
      }
      .m.grouped .name { display: none; }
      .m .body { color: #ececef; }

      /* ---- Composer -------------------------------------------------- */
      form {
        display: flex; align-items: center; gap: 8px;
        padding: 10px 12px;
        border-top: 1px solid #2a2a2f;
        background: #1d1d21;
      }
      input#box {
        flex: 1;
        border: 1px solid #313138;
        background: #26262b;
        color: #ececef;
        border-radius: 999px;
        padding: 8px 14px;
        font: inherit;
        outline: none;
        transition: background .12s ease, border-color .12s ease;
      }
      input#box:focus { border-color: #4a90e2; background: #2a2a30; }
      input#box::placeholder { color: #6c6c74; }
      form button {
        border: 0;
        background: #313138;
        color: #ececef;
        width: 30px; height: 30px;
        border-radius: 50%;
        cursor: pointer; padding: 0;
        display: inline-flex; align-items: center; justify-content: center;
        font-size: 15px; line-height: 1;
        transition: background .12s ease, transform .08s ease;
      }
      form button:hover { background: #3e3e48; }
      form button:active { transform: scale(.94); }

      /* ---- Light theme ---------------------------------------------- */
      @media (prefers-color-scheme: light) {
        .panel { background: #fff; color: #1a1a1a; border-color: #e5e5ea; }
        header { background: #f6f6f7; border-color: #e5e5ea; }
        #presence { color: #6d6d72; }
        #gear { color: #6d6d72; }
        #gear:hover { background: #ececef; color: #1a1a1a; }
        #settings { background: #f6f6f7; border-color: #e5e5ea; }
        #whoami { color: #6d6d72; }
        #settings input, #settings .btn {
          background: #fff; border-color: #d9d9de; color: #1a1a1a;
        }
        #settings input:focus { border-color: #4a90e2; background: #fff; }
        #settings input::placeholder { color: #a1a1a6; }
        #settings .btn:hover { background: #f0f0f3; border-color: #cbcbcf; }
        #settings small { color: #6d6d72; }
        form { background: #f6f6f7; border-color: #e5e5ea; }
        input#box { background: #fff; border-color: #d9d9de; color: #1a1a1a; }
        input#box::placeholder { color: #a1a1a6; }
        form button { background: #e5e5ea; color: #1a1a1a; }
        form button:hover { background: #d9d9de; }
        .m .body { color: #1a1a1a; }
      }
    </style>
    <div class="panel">
      <header>
        <h1 id="room"></h1>
        <span id="presence"></span>
        <span id="status"></span>
        <button id="gear" class="icon" aria-label="Account settings">⚙</button>
      </header>
      <div id="settings">
        <div id="whoami">Signed in as …</div>
        <div class="row">
          <input id="handleInput" maxlength="24" placeholder="Pick a handle" aria-label="Handle">
          <button id="saveHandle" class="btn">Save</button>
        </div>
        <div class="row">
          <button id="google" class="btn">Link Google</button>
          <button id="github" class="btn">Link GitHub</button>
        </div>
        <div class="row">
          <button id="signout" class="btn">Sign out</button>
        </div>
        <small id="settingsMsg"></small>
      </div>
      <div id="log" role="log" aria-live="polite"></div>
      <form><input id="box" maxlength="500" placeholder="Say something…" aria-label="Chat message">
      <button aria-label="Send">→</button></form>
    </div>`;

  ui = Object.fromEntries(
    ['room','presence','status','log','box','gear','settings','whoami',
     'handleInput','saveHandle','google','github','signout','settingsMsg']
      .map(id => [id, root.getElementById(id)]));
  ui.panel = root.querySelector('.panel');

  root.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const body = ui.box.value.trim();
    if (!body || !currentRoom) return;
    port?.postMessage({ t: 'send', roomKey: currentRoom, body });
    ui.box.value = '';
  });

  wireSettings();
  document.documentElement.appendChild(shadowHost);
}

// ---------------------------------------------------------------------------
// Account / settings drawer
// ---------------------------------------------------------------------------
function wireSettings() {
  ui.gear.addEventListener('click', () => {
    ui.settings.classList.toggle('show');
    if (ui.settings.classList.contains('show')) loadProfile();
  });
  ui.saveHandle.addEventListener('click', async () => {
    const handle = ui.handleInput.value.trim();
    if (handle.length < 3) return setMsg('Handle must be at least 3 characters.');
    const r = await account('setHandle', { handle });
    if (r?.error) return setMsg(`Couldn’t save: ${r.error}`);
    profile = { ...(profile || {}), handle: r.handle };
    setMsg('Saved.');
    updateWhoami();
  });
  ui.google.addEventListener('click', () => linkProvider('google'));
  ui.github.addEventListener('click', () => linkProvider('github'));
  ui.signout.addEventListener('click', async () => {
    await account('signOut');
    profile = null;
    setMsg('Signed out. A new anonymous handle will be created on your next message.');
    updateWhoami();
  });
}

async function linkProvider(provider) {
  setMsg(`Opening ${provider}…`);
  const r = await account('signIn', { provider });
  if (r?.error) return setMsg(`Sign-in failed: ${r.error}`);
  setMsg(r?.ok ? 'Account linked.' : 'Sign-in cancelled.');
  loadProfile();
}

async function loadProfile() {
  profile = await account('profile').catch(() => null);
  updateWhoami();
}

function updateWhoami() {
  if (!ui.whoami) return;
  if (profile?.handle) {
    ui.whoami.textContent = `Signed in as ${profile.handle}`;
    if (ui.handleInput && !ui.handleInput.value) ui.handleInput.value = profile.handle;
  } else {
    ui.whoami.textContent = 'Not signed in';
  }
}

function setMsg(text) { if (ui.settingsMsg) ui.settingsMsg.textContent = text; }

function renderMessage(msg) {
  const el = document.createElement('div');
  el.className = 'm';
  if (msg.handle === lastMsgHandle) el.classList.add('grouped');
  lastMsgHandle = msg.handle;

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = msg.handle;              // textContent everywhere: no XSS
  if (typeof msg.color === 'number') name.style.color = PALETTE[msg.color % PALETTE.length];
  const body = document.createElement('span');
  body.className = 'body';
  body.textContent = msg.body;
  el.append(name, body);

  const atBottom = ui.log.scrollTop + ui.log.clientHeight >= ui.log.scrollHeight - 40;
  ui.log.appendChild(el);
  if (atBottom) ui.log.scrollTop = ui.log.scrollHeight;   // don't yank scroll
  while (ui.log.children.length > 300) ui.log.firstChild.remove();
  ui.log.firstElementChild?.classList.remove('grouped');
}

function clearMessages() {
  lastMsgHandle = null;
  if (ui.log) ui.log.replaceChildren();
}
function setHeader(room) { if (ui.room) ui.room.textContent = room; }

function toggle() {
  visible = !visible;
  ui.panel.classList.toggle('open', visible);
  if (visible) {
    if (!currentRoom) joinCurrentRoom();
    if (!profile) loadProfile();
  }
}

chrome.runtime.onMessage.addListener((m) => { if (m.t === 'toggle') toggle(); });

// ---------------------------------------------------------------------------
// Boot — lazy: build UI immediately (cheap), but only join a room once the
// user opens the panel, so we don't hit the backend for every pageview.
// ---------------------------------------------------------------------------
buildSidebar();
connectPort();
watchNavigation();

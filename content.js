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
const PALETTE = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#46f0f0',
  '#f032e6', '#bcf60c', '#fabebe', '#008080', '#9a6324', '#800000',
];

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
      .panel { width: 320px; height: 100vh; display: flex; flex-direction: column;
               background: #fff; color: #1a1a1a; border-left: 1px solid #ddd;
               font: 14px/1.45 system-ui, sans-serif;
               transform: translateX(100%); transition: transform .18s ease; }
      .panel.open { transform: none; }
      header { padding: 10px 12px; border-bottom: 1px solid #eee;
               display: flex; align-items: baseline; gap: 8px; }
      header h1 { font-size: 13px; font-weight: 600; margin: 0; overflow: hidden;
                  text-overflow: ellipsis; white-space: nowrap; flex: 1; }
      #presence { font-size: 12px; color: #777; }
      #status[data-state="down"]::after { content: "reconnecting…"; color: #b00; font-size: 11px; }
      #log { flex: 1; overflow-y: auto; padding: 8px 12px; }
      .m { margin: 2px 0; word-wrap: break-word; }
      .m b { font-weight: 600; }
      form { display: flex; border-top: 1px solid #eee; }
      input { flex: 1; border: 0; padding: 10px 12px; font: inherit; outline: none; }
      button { border: 0; background: none; padding: 0 12px; cursor: pointer; color: #555; }
      .icon { font-size: 14px; }
      #settings { display: none; padding: 12px; border-bottom: 1px solid #eee;
                  flex-direction: column; gap: 8px; background: #fafafa; }
      #settings.show { display: flex; }
      #settings .row { display: flex; gap: 6px; }
      #settings input { border: 1px solid #ccc; border-radius: 6px; }
      #settings .btn { border: 1px solid #ccc; border-radius: 6px; padding: 6px 10px;
                       background: #fff; color: #333; white-space: nowrap; }
      #settings small { color: #888; }
      #whoami { font-size: 12px; color: #777; }
      @media (prefers-color-scheme: dark) {
        .panel { background: #1c1c1e; color: #eee; border-color: #333; }
        header, form { border-color: #333; }
        input { background: none; color: #eee; }
        #settings { background: #242426; border-color: #333; }
        #settings input, #settings .btn { background: #2c2c2e; color: #eee; border-color: #444; }
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
  const name = document.createElement('b');
  name.textContent = msg.handle + ' ';        // textContent everywhere: no XSS
  if (typeof msg.color === 'number') name.style.color = PALETTE[msg.color % PALETTE.length];
  const body = document.createElement('span');
  body.textContent = msg.body;
  el.append(name, body);
  const atBottom = ui.log.scrollTop + ui.log.clientHeight >= ui.log.scrollHeight - 40;
  ui.log.appendChild(el);
  if (atBottom) ui.log.scrollTop = ui.log.scrollHeight;   // don't yank scroll
  while (ui.log.children.length > 300) ui.log.firstChild.remove();
}

function clearMessages() { if (ui.log) ui.log.replaceChildren(); }
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

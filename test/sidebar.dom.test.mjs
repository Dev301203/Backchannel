/**
 * DOM smoke test for the sidebar UI, run in jsdom with a stubbed chrome/port.
 * Not a pixel test — it drives the real createSidebar() through every frame
 * type and interaction path and fails on thrown errors or missing DOM state.
 *
 * Run:  node test/sidebar.dom.test.mjs
 */
import { JSDOM } from 'jsdom';
import { strict as assert } from 'node:assert';

const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
  url: 'https://example.com/article?id=1',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;

// --- chrome stub -------------------------------------------------------------
const storage = new Map();
globalThis.chrome = {
  storage: {
    local: {
      get: async (k) => ({ [k]: storage.get(k) }),
      set: async (obj) => { for (const [k, v] of Object.entries(obj)) storage.set(k, v); },
    },
  },
};

// --- port stub ---------------------------------------------------------------
function makePort() {
  const listeners = [];
  const sent = [];
  return {
    sent,
    onMessage: { addListener: (fn) => listeners.push(fn) },
    onDisconnect: { addListener: () => {} },
    postMessage: (m) => sent.push(m),
    emit: (frame) => { for (const fn of listeners) fn(frame); },
    disconnect: () => {},
  };
}
const port = makePort();

const CATALOG = [
  { id: 'first-words', emoji: '👋', title: 'First words', desc: 'Send your first message', stat: 'messages_sent', target: 1 },
  { id: 'pioneer', emoji: '🚩', title: 'Pioneer', desc: 'Be first in a room', stat: 'rooms_pioneered', target: 1 },
  { id: 'chatterbox', emoji: '💬', title: 'Chatterbox', desc: 'Send 100 messages', stat: 'messages_sent', target: 100 },
];

const PROFILE = {
  id: 'u1', handle: 'tester', color: 3, badge: 'pioneer', isAnonymous: false, isBanned: false,
  stats: { messagesSent: 5, roomsPosted: 2, roomsPioneered: 1, repliesReceived: 0, reactionsReceived: 0, reactionsGiven: 0, nightMessages: 0, streakDays: 2, bestStreak: 2 },
  achievements: [{ id: 'first-words', earnedAt: 1 }, { id: 'pioneer', earnedAt: 2 }],
};

const accountCalls = [];
async function account(action, extra) {
  accountCalls.push([action, extra]);
  if (action === 'profile') return structuredClone(PROFILE);
  if (action === 'achievements') return CATALOG;
  if (action === 'authConfig') return { social: ['google'], emailOTP: true };
  if (action === 'report') return { ok: true };
  if (action === 'setBadge') return { badge: extra.badge };
  if (action === 'setColor') return { color: extra.color };
  if (action === 'setHandle') return { handle: extra.handle };
  return { ok: true };
}

const { createSidebar } = await import('../sidebar.js');

let toggleFn = null;
const host = document.getElementById('host');
const api = createSidebar({
  root: host,
  connect: () => port,
  account,
  resolveRoom: () => ({ pageKey: 'example.com/article|id=1', domainKey: 'example.com' }),
  onNavigation: () => {},
  onToggle: (cb) => { toggleFn = cb; },
  onWidthChange: () => {},
  isPopout: false,
});

const $ = (sel) => host.querySelector(sel);
const tick = () => new Promise((r) => setTimeout(r, 30));

// --- open the panel, join the room -------------------------------------------
toggleFn('open');
await tick();
assert.ok($('.panel').classList.contains('open'), 'panel opens');
assert.equal($('#room').textContent, 'example.com/article|id=1', 'page room joined by default');
assert.ok(port.sent.some((m) => m.t === 'join' && m.roomKey === 'example.com/article|id=1'), 'join frame sent');
assert.ok($('#scopebar').classList.contains('show'), 'scope switcher visible when page+domain differ');

// --- status + presence ---------------------------------------------------------
port.emit({ t: 'status', state: 'open' });
port.emit({ t: 'presence', roomKey: 'example.com/article|id=1', count: 4 });
assert.equal($('#presence').textContent, '4 here', 'presence renders');

// --- history with threads, badges, reactions -----------------------------------
port.emit({
  t: 'history',
  roomKey: 'example.com/article|id=1',
  msgs: [
    { id: 'm3', handle: 'carol', color: 5, badge: null, body: 'reply here', ts: Date.now(), parentId: 'm1', reactions: [] },
    { id: 'm2', handle: 'bob', color: 2, badge: 'first-words', body: 'see https://example.org and hi @tester', ts: Date.now() - 1000, parentId: null, reactions: [{ emoji: '🔥', count: 2, mine: true }] },
    { id: 'm1', handle: 'alice', color: 1, badge: null, body: 'first!', ts: Date.now() - 2000, parentId: null, reactions: [] },
  ],
});
await tick();
assert.equal(host.querySelectorAll('.m').length, 3, 'three messages rendered');
assert.ok($('.day-divider'), 'date divider rendered');
assert.ok($('[data-id="m1"] .replies [data-id="m3"]'), 'reply nested under its parent');
assert.ok($('[data-id="m2"] .badge')?.textContent === '👋', 'author badge emoji rendered from catalog');
assert.ok($('[data-id="m2"] .body a')?.href.startsWith('https://example.org'), 'links are clickable');
assert.ok($('[data-id="m2"]').classList.contains('mention-self'), 'self-mention highlighted');
const chipFor = (msgId, emoji) =>
  [...(host.querySelector(`[data-id="${msgId}"] .rx`)?.children ?? [])].find((c) => c.dataset.emoji === emoji);
const fireChip = chipFor('m2', '🔥');
assert.ok(fireChip?.classList.contains('mine'), 'own reaction chip marked mine');
assert.equal(fireChip.querySelector('.n').textContent, '2', 'reaction count rendered');

// --- live message + dedupe ------------------------------------------------------
port.emit({ t: 'msg', roomKey: 'example.com/article|id=1', msg: { id: 'm4', handle: 'alice', color: 1, body: 'again', ts: Date.now(), parentId: null, reactions: [] } });
port.emit({ t: 'msg', roomKey: 'example.com/article|id=1', msg: { id: 'm4', handle: 'alice', color: 1, body: 'again', ts: Date.now(), parentId: null, reactions: [] } });
assert.equal(host.querySelectorAll('[data-id="m4"]').length, 1, 'duplicate message id deduped');

// --- reactions: toggle + server frame -------------------------------------------
fireChip.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
await tick();
const reactMsg = port.sent.find((m) => m.t === 'react');
assert.ok(reactMsg && reactMsg.op === 'remove' && reactMsg.emoji === '🔥', 'clicking own chip sends remove');
port.emit({ t: 'react', roomKey: 'example.com/article|id=1', messageId: 'm2', emoji: '🔥', count: 1 });
assert.equal(chipFor('m2', '🔥').querySelector('.n').textContent, '1', 'server count settles chip');

// --- typing indicator -------------------------------------------------------------
port.emit({ t: 'typing', roomKey: 'example.com/article|id=1', handle: 'bob' });
assert.ok($('#typing').classList.contains('show'), 'typing indicator shows');
assert.ok($('#typing').textContent.includes('bob is typing'), 'typing text names the typer');

// --- error toast ----------------------------------------------------------------------
port.emit({ t: 'error', roomKey: 'example.com/article|id=1', code: 'rate_limited', retryAfter: 5 });
assert.ok([...host.querySelectorAll('#toasts .toast')].some((t) => t.textContent.includes('Slow down')), 'rate-limit toast appears');

// --- composer: send with reply -------------------------------------------------------
await tick(); // profile promise resolves (loaded on open)
assert.equal($('form').hidden, false, 'composer visible for signed-in user');
const replyBtn = $('[data-id="m2"] .acts button[aria-label^="Reply"]');
assert.ok(replyBtn, 'reply affordance exists');
replyBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
assert.equal($('#replyPreview').hidden, false, 'reply preview opens');
$('#box').value = 'my reply';
$('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
const sendFrame = port.sent.find((m) => m.t === 'send');
assert.ok(sendFrame && sendFrame.parentId === 'm2' && sendFrame.body === 'my reply', 'send frame carries parentId');
assert.equal($('#replyPreview').hidden, true, 'reply preview closes after send');

// --- settings drawer: stats, badges, achievements -------------------------------------
$('#gear').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
await tick();
assert.ok($('#settings').classList.contains('show'), 'settings drawer opens');
assert.ok($('#statsRow').textContent.includes('5'), 'stats chips render');
assert.equal(host.querySelectorAll('#achv .ach').length, 3, 'achievement grid renders full catalog');
assert.equal(host.querySelectorAll('#achv .ach.earned').length, 2, 'earned achievements marked');
assert.ok($('#achv .ach.locked .a-sub').textContent.includes('/100'), 'locked achievement shows progress');
const badgeBtns = host.querySelectorAll('#badges .badge-pick');
assert.equal(badgeBtns.length, 3, 'badge picker: none + 2 earned');
assert.ok([...badgeBtns].some((b) => b.classList.contains('selected') && b.textContent === '🚩'), 'current badge selected');

// --- achievement unlock: toast + live drawer update --------------------------------------
port.emit({ t: 'achievement', a: { id: 'chatterbox', emoji: '💬', title: 'Chatterbox', desc: 'Send 100 messages' } });
assert.ok($('#toasts .toast.ach'), 'achievement toast appears');
assert.ok($('#toasts .toast.ach').textContent.includes('Chatterbox'), 'toast names the achievement');
assert.equal(host.querySelectorAll('#achv .ach.earned').length, 3, 'unlock updates the achievement grid live');
assert.equal(host.querySelectorAll('#badges .badge-pick').length, 4, 'unlock adds the badge to the picker');

// --- scope switch ------------------------------------------------------------------------
$('#scopeSite').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
await tick();
assert.equal($('#room').textContent, 'example.com', 'scope switch joins the domain room');
assert.ok(port.sent.some((m) => m.t === 'leave' && m.roomKey === 'example.com/article|id=1'), 'left the page room');
assert.ok(port.sent.some((m) => m.t === 'join' && m.roomKey === 'example.com'), 'joined the site room');
assert.equal(storage.get('roomScope'), 'site', 'scope preference persisted');

api.destroy();
console.log('\nALL SIDEBAR DOM TESTS PASSED');
process.exit(0);

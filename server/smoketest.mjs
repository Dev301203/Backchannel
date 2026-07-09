// End-to-end smoke test: anonymous auth -> promotion -> WS connect -> sub ->
// send -> fanout -> reactions -> typing -> achievements -> badges -> live
// identity patch -> history -> moderation -> rate limiting -> presence.
// Run while the server is up:  node smoketest.mjs
import WebSocket from 'ws';
import pg from 'pg';

const API = 'http://localhost:8080';
const WS = 'ws://localhost:8080/socket';
const DB = process.env.DATABASE_URL ?? 'postgres://backchannel:backchannel@localhost:5432/backchannel';
const ROOM = 'example.com/smoke-' + Date.now(); // unique room per run

const log = (...a) => console.log(...a);
const assert = (c, m) => {
  if (!c) { console.error('FAIL:', m); process.exit(1); }
  log('ok:', m);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function anon() {
  const r = await fetch(`${API}/api/auth/sign-in/anonymous`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert(r.ok, `anonymous sign-in ${r.status}`);
  const token = r.headers.get('set-auth-token') || (await r.clone().json()).token;
  assert(token, 'received bearer token');
  return token;
}

async function me(token) {
  const r = await fetch(`${API}/me`, { headers: { authorization: `Bearer ${token}` } });
  assert(r.ok, `/me ${r.status}`);
  return r.json();
}

async function post(token, path, body) {
  return fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

// A recorder around a socket: keeps every frame + lets us await a predicate
// against past-or-future frames.
function recorder(token) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const waiters = [];
    const ws = new WebSocket(`${WS}?token=${encodeURIComponent(token)}`);
    ws.on('open', () =>
      resolve({
        ws,
        frames,
        send: (o) => ws.send(JSON.stringify(o)),
        until: (pred, ms = 5000) =>
          new Promise((res, rej) => {
            const hit = frames.find(pred);
            if (hit) return res(hit);
            const t = setTimeout(() => rej(new Error('timeout')), ms);
            waiters.push((f) => { if (pred(f)) { clearTimeout(t); res(f); } });
          }),
        close: () => ws.close(),
      }),
    );
    ws.on('error', reject);
    ws.on('unexpected-response', (_q, r) => reject(new Error('ws http ' + r.statusCode)));
    ws.on('message', (d) => {
      const f = JSON.parse(d.toString());
      frames.push(f);
      for (const w of waiters) w(f);
    });
  });
}

async function main() {
  const db = new pg.Client({ connectionString: DB });
  await db.connect();
  // Simulate "linked a real account" without an OAuth dance: flip the flag the
  // anonymous plugin sets. Identity is re-resolved on the next connect.
  const promote = (id) => db.query('UPDATE "user" SET "isAnonymous" = false WHERE id = $1', [id]);

  // --- catalog ---------------------------------------------------------------
  const catalog = await (await fetch(`${API}/achievements`)).json();
  assert(Array.isArray(catalog) && catalog.length >= 10, `achievement catalog served (${catalog.length})`);
  assert(catalog.every((a) => a.id && a.emoji && a.title && a.stat && a.target > 0), 'catalog entries well-formed');

  // --- identities ------------------------------------------------------------
  const tokenA = await anon();
  const tokenB = await anon();
  const tokenC = await anon(); // stays anonymous: read-only
  const profA0 = await me(tokenA);
  const profB0 = await me(tokenB);
  assert(profA0.handle?.length > 0, `generated pseudonymous handle (${profA0.handle})`);
  assert(profA0.isAnonymous === true, 'fresh user is anonymous');
  assert(profA0.stats && profA0.stats.messagesSent === 0, '/me carries zeroed stats');
  await promote(profA0.id);
  await promote(profB0.id);
  const profA = await me(tokenA);
  assert(profA.isAnonymous === false, 'A promoted to full account');

  // --- sockets + presence ----------------------------------------------------
  const A = await recorder(tokenA);
  const B = await recorder(tokenB);
  const C = await recorder(tokenC);
  log('ok: sockets connected');

  A.send({ t: 'sub', roomKey: ROOM, title: 'Smoke' });
  await sleep(250);
  B.send({ t: 'sub', roomKey: ROOM });
  C.send({ t: 'sub', roomKey: ROOM });
  await B.until((f) => f.t === 'presence' && f.count >= 3, 5000);
  log('ok: presence reached 3');

  // --- anonymous users cannot post -------------------------------------------
  C.send({ t: 'msg', roomKey: ROOM, body: 'anon should fail' });
  await C.until((f) => f.t === 'error' && f.code === 'sign_in_required', 4000);
  log('ok: anonymous send rejected with sign_in_required');

  // --- fanout + achievements on first message --------------------------------
  A.send({ t: 'msg', roomKey: ROOM, body: 'hello backchannel' });
  const msg = await B.until((f) => f.t === 'msg' && f.msg?.body === 'hello backchannel', 5000);
  assert(msg.msg.handle === profA.handle, 'fanout delivered A→B with A’s handle');
  assert(typeof msg.msg.ts === 'number', 'message carries server timestamp');
  assert(typeof msg.msg.color === 'number', 'message carries handle color');
  assert(Array.isArray(msg.msg.reactions), 'message carries reactions array');
  await A.until((f) => f.t === 'achievement' && f.a?.id === 'first-words', 5000);
  log('ok: first-words achievement unlocked');
  await A.until((f) => f.t === 'achievement' && f.a?.id === 'pioneer', 5000);
  log('ok: pioneer achievement unlocked (first message in a fresh room)');

  const profA2 = await me(tokenA);
  assert(profA2.stats.messagesSent === 1, 'stats.messagesSent incremented');
  assert(profA2.achievements.some((a) => a.id === 'first-words'), '/me lists earned achievements');

  // --- badge -----------------------------------------------------------------
  const badgeRes = await post(tokenA, '/me/badge', { badge: 'pioneer' });
  assert(badgeRes.ok, 'set display badge to earned achievement');
  const badBadge = await post(tokenA, '/me/badge', { badge: 'beloved' });
  assert(badBadge.status === 400, 'unearned badge rejected');

  // Badge + live identity patch: the OPEN socket must pick both up.
  const newHandle = 'smoke-' + Date.now().toString(36);
  const handleRes = await post(tokenA, '/me/handle', { handle: newHandle });
  assert(handleRes.ok, 'handle change accepted');
  await sleep(300); // let the ctl frame propagate
  A.send({ t: 'msg', roomKey: ROOM, body: 'renamed and badged' });
  const msg2 = await B.until((f) => f.t === 'msg' && f.msg?.body === 'renamed and badged', 5000);
  assert(msg2.msg.handle === newHandle, 'live socket picked up handle change without reconnect');
  assert(msg2.msg.badge === 'pioneer', 'message carries display badge');

  // --- threads ---------------------------------------------------------------
  B.send({ t: 'msg', roomKey: ROOM, body: 'a reply', parentId: msg2.msg.id });
  const reply = await A.until((f) => f.t === 'msg' && f.msg?.body === 'a reply', 5000);
  assert(reply.msg.parentId === msg2.msg.id, 'reply carries parentId');
  await A.until((f) => f.t === 'achievement' && f.a?.id === 'first-words' || true, 100).catch(() => {});

  // --- reactions ---------------------------------------------------------------
  B.send({ t: 'react', roomKey: ROOM, messageId: msg2.msg.id, emoji: '🔥', op: 'add' });
  const rx = await A.until((f) => f.t === 'react' && f.messageId === msg2.msg.id, 5000);
  assert(rx.emoji === '🔥' && rx.count === 1, 'reaction fanned out with count 1');
  B.send({ t: 'react', roomKey: ROOM, messageId: msg2.msg.id, emoji: '🔥', op: 'add' }); // dup: no frame
  B.send({ t: 'react', roomKey: ROOM, messageId: msg2.msg.id, emoji: '🔥', op: 'remove' });
  await A.until((f) => f.t === 'react' && f.messageId === msg2.msg.id && f.count === 0, 5000);
  log('ok: reaction remove fanned out with count 0');
  B.send({ t: 'react', roomKey: ROOM, messageId: msg2.msg.id, emoji: '💀', op: 'add' });
  await B.until((f) => f.t === 'error' && f.code === 'bad_react', 4000);
  log('ok: unknown emoji rejected');
  B.send({ t: 'react', roomKey: ROOM, messageId: msg2.msg.id, emoji: '👍', op: 'add' });
  await A.until((f) => f.t === 'react' && f.emoji === '👍' && f.count === 1, 5000);

  // --- typing ------------------------------------------------------------------
  B.send({ t: 'typing', roomKey: ROOM });
  const typ = await A.until((f) => f.t === 'typing', 5000);
  assert(typ.handle === profB0.handle, 'typing indicator carries handle');

  // --- history (with reactions + viewer flags) ---------------------------------
  const hist = await (await fetch(`${API}/rooms/${encodeURIComponent(ROOM)}/messages?limit=10`, {
    headers: { authorization: `Bearer ${tokenB}` },
  })).json();
  assert(hist.some((m) => m.body === 'hello backchannel'), 'history backfill contains the message');
  const h2 = hist.find((m) => m.id === msg2.msg.id);
  assert(h2 && h2.badge === 'pioneer', 'history carries badges');
  assert(h2.reactions.some((r) => r.emoji === '👍' && r.count === 1 && r.mine === true),
    'history marks the viewer’s own reactions');

  // --- moderation ---------------------------------------------------------------
  A.send({ t: 'msg', roomKey: ROOM, body: 'kill yourself' });
  await A.until((f) => f.t === 'error' && f.code?.startsWith('mod_'), 4000);
  log('ok: moderation blocked disallowed content');

  // --- rate limiting --------------------------------------------------------------
  for (let i = 0; i < 12; i++) A.send({ t: 'msg', roomKey: ROOM, body: `burst ${i}` });
  await A.until((f) => f.t === 'error' && f.code === 'rate_limited', 5000);
  log('ok: rate limiter engaged');

  // --- presence decrement ----------------------------------------------------------
  B.close();
  C.close();
  await A.until((f) => f.t === 'presence' && f.count <= 1, 5000);
  log('ok: presence decremented on leave');

  A.close();
  await db.end();
  log('\nALL SMOKE TESTS PASSED');
  process.exit(0);
}

main().catch((e) => { console.error('ERROR', e); process.exit(1); });

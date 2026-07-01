// End-to-end smoke test: anonymous auth -> WS connect -> sub -> send -> receive
// via Redis fanout -> presence -> history backfill -> rate limiting.
// Run while the server is up:  node smoketest.mjs
import WebSocket from 'ws';

const API = 'http://localhost:8080';
const WS = 'ws://localhost:8080/socket';
const ORIGIN = 'chrome-extension://smoketestid';
const ROOM = 'example.com/smoke-' + Date.now(); // unique room per run

const log = (...a) => console.log(...a);
const assert = (c, m) => {
  if (!c) { console.error('FAIL:', m); process.exit(1); }
  log('ok:', m);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function anon() {
  const r = await fetch(`${API}/api/auth/sign-in/anonymous`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: '{}',
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
  const tokenA = await anon();
  const tokenB = await anon();
  const profA = await me(tokenA);
  log('user A handle:', profA.handle, 'color:', profA.color);
  assert(profA.handle?.length > 0, 'generated pseudonymous handle');

  const A = await recorder(tokenA);
  const B = await recorder(tokenB);
  log('ok: both sockets connected');

  A.send({ t: 'sub', roomKey: ROOM, title: 'Smoke' });
  await sleep(250);
  B.send({ t: 'sub', roomKey: ROOM });

  // Presence should reach 2 once both are in.
  await B.until((f) => f.t === 'presence' && f.count >= 2, 5000);
  log('ok: presence reached 2');

  // A message from A must reach B (cross-connection fanout via Redis).
  A.send({ t: 'msg', roomKey: ROOM, body: 'hello backchannel' });
  const msg = await B.until((f) => f.t === 'msg' && f.msg?.body === 'hello backchannel', 5000);
  assert(msg.msg.handle === profA.handle, 'fanout delivered A→B with A’s handle');
  assert(typeof msg.msg.ts === 'number', 'message carries server timestamp');
  assert(typeof msg.msg.color === 'number', 'message carries handle color');

  // History backfill over HTTP includes it.
  const hist = await (await fetch(`${API}/rooms/${encodeURIComponent(ROOM)}/messages?limit=10`)).json();
  assert(hist.some((m) => m.body === 'hello backchannel'), 'history backfill contains the message');

  // Moderation: blocked content is rejected.
  A.send({ t: 'msg', roomKey: ROOM, body: 'kill yourself' });
  await A.until((f) => f.t === 'error' && f.code?.startsWith('mod_'), 4000);
  log('ok: moderation blocked disallowed content');

  // Rate limiting: a burst trips the limiter.
  for (let i = 0; i < 12; i++) A.send({ t: 'msg', roomKey: ROOM, body: `burst ${i}` });
  await A.until((f) => f.t === 'error' && f.code === 'rate_limited', 5000);
  log('ok: rate limiter engaged');

  // Presence drops when B leaves.
  B.close();
  await A.until((f) => f.t === 'presence' && f.count <= 1, 5000);
  log('ok: presence decremented on leave');

  A.close();
  log('\nALL SMOKE TESTS PASSED');
  process.exit(0);
}

main().catch((e) => { console.error('ERROR', e); process.exit(1); });

/**
 * Shared sidebar UI. Used by:
 *   - content.js  — mounts inside a closed shadow root on any web page
 *   - popup.js    — mounts inside a standalone chrome.windows popup
 *
 * The two call sites differ only in how they discover the current room, how
 * they wire the port, and whether they own a "visible" toggle. Everything
 * else — layout, styling, threads, mentions, color picker, resize — lives
 * here so behavior stays identical in both contexts.
 *
 * Call:  createSidebar({ root, connect, account, resolveRoom, onNavigation?,
 *                        onToggle?, isPopout, initialTitle })
 * Returns: { destroy() }
 */

// 12-color handle palette indexed by server-assigned displayColor (0..11).
export const PALETTE = [
  '#f87171', '#fb923c', '#fbbf24', '#a3e635',
  '#4ade80', '#2dd4bf', '#22d3ee', '#60a5fa',
  '#a78bfa', '#e879f9', '#f472b6', '#94a3b8',
];

const MIN_WIDTH = 300;
const MAX_WIDTH = 560;
const WIDTH_KEY = 'sidebarWidth';

const MARKUP = `
  <style>
    :host, .panel * { box-sizing: border-box; }

    .panel {
      width: 100%; height: 100vh;
      display: flex; flex-direction: column;
      position: relative;
      background: #17171a; color: #ececef;
      border-left: 1px solid #2a2a2f;
      font: 13.5px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI",
            Roboto, "Helvetica Neue", Arial, sans-serif;
      letter-spacing: -0.005em;
    }
    .panel.docked {
      transform: translateX(100%);
      transition: transform .22s cubic-bezier(.4,0,.2,1);
    }
    .panel.docked.open { transform: none; }

    /* ---- Drag resize handle (docked only) ---------------------------- */
    .resizer {
      position: absolute; top: 0; left: 0;
      width: 5px; height: 100%;
      cursor: ew-resize;
      background: transparent;
      transition: background .12s ease;
      z-index: 10;
    }
    .resizer:hover, .resizer.active { background: rgba(74,144,226,.4); }

    /* ---- Header ------------------------------------------------------ */
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
    .icon-btn {
      border: 0; background: transparent; color: #9a9aa1;
      width: 28px; height: 28px; border-radius: 7px;
      cursor: pointer; padding: 0; font-size: 15px; line-height: 1;
      display: inline-flex; align-items: center; justify-content: center;
      transition: background .12s ease, color .12s ease;
    }
    .icon-btn:hover { background: #2a2a2f; color: #ececef; }
    .icon-btn svg { width: 15px; height: 15px; }

    /* ---- Settings drawer -------------------------------------------- */
    #settings {
      display: none;
      padding: 12px 14px 14px;
      border-bottom: 1px solid #2a2a2f;
      flex-direction: column; gap: 10px;
      background: #1d1d21;
    }
    #settings.show { display: flex; }
    #whoami { font-size: 11.5px; color: #9a9aa1; margin-bottom: 2px; }
    #settings .row { display: flex; gap: 6px; flex-wrap: wrap; }
    .social-row .btn, #loginPrompt .lp-btn { flex: 1 1 calc(50% - 3px); min-width: 0; }
    #settings input, #settings .btn {
      border: 1px solid #313138; background: #26262b; color: #ececef;
      border-radius: 8px; padding: 7px 11px; font: inherit; outline: none;
      transition: background .12s ease, border-color .12s ease;
    }
    #settings input { flex: 1; }
    #settings input:focus { border-color: #4a90e2; background: #2a2a30; }
    #settings input::placeholder { color: #6c6c74; }
    #settings .btn { cursor: pointer; white-space: nowrap; }
    #settings .btn:hover { background: #30303a; border-color: #3e3e48; }
    #settings small { color: #9a9aa1; font-size: 11.5px; min-height: 14px; }

    .settings-label {
      font-size: 11px; color: #6c6c74;
      text-transform: uppercase; letter-spacing: 0.06em; margin-top: 4px;
    }
    .swatches {
      display: grid; grid-template-columns: repeat(12, 1fr); gap: 6px;
    }
    .swatch {
      width: 100%; aspect-ratio: 1; border-radius: 6px;
      border: 2px solid transparent; padding: 0; cursor: pointer;
      transition: transform .1s ease, border-color .12s ease;
    }
    .swatch:hover { transform: scale(1.08); }
    .swatch.selected { border-color: #ececef; }

    /* ---- Log --------------------------------------------------------- */
    #log {
      flex: 1; overflow-y: auto;
      padding: 12px 14px 14px;
      scrollbar-width: thin;
      scrollbar-color: #3a3a42 transparent;
    }
    #log::-webkit-scrollbar { width: 8px; }
    #log::-webkit-scrollbar-track { background: transparent; }
    #log::-webkit-scrollbar-thumb {
      background: #3a3a42; border-radius: 4px;
      border: 2px solid transparent; background-clip: content-box;
    }
    #log::-webkit-scrollbar-thumb:hover { background: #4a4a54; background-clip: content-box; }

    .m {
      display: grid;
      grid-template-columns: 42px auto 1fr auto;
      grid-template-areas: "ts name body actions";
      column-gap: 6px; row-gap: 0;
      align-items: baseline;
      padding: 3px 4px 3px 6px;
      margin: 0 -4px;
      border-radius: 6px;
      word-wrap: break-word; overflow-wrap: anywhere;
      position: relative;
    }
    .m:hover { background: rgba(255,255,255,.025); }
    .m:hover .reply-btn { opacity: 1; }

    .m .ts {
      grid-area: ts;
      font-size: 11px; color: #6c6c74;
      font-variant-numeric: tabular-nums;
      user-select: none;
    }
    .m .name {
      grid-area: name;
      font-weight: 700; font-size: 12.5px;
    }
    .m .name::after { content: ':'; color: #6c6c74; font-weight: 400; margin-left: 1px; }
    .m .body { grid-area: body; color: #ececef; }
    .m.grouped .ts, .m.grouped .name { visibility: hidden; }
    .m.grouped .name::after { visibility: hidden; }

    /* Mentions */
    .mention {
      background: rgba(96,165,250,.15);
      color: #93c5fd;
      padding: 0 4px; border-radius: 4px;
      font-weight: 600;
    }
    .m.mention-self {
      background: linear-gradient(90deg, rgba(251,191,36,.14), rgba(251,191,36,.03));
      box-shadow: inset 3px 0 0 #fbbf24;
    }
    .m.mention-self .mention.mention-me {
      background: rgba(251,191,36,.28); color: #fef3c7;
    }

    /* Reply button */
    .reply-btn {
      grid-area: actions;
      opacity: 0;
      border: 0; background: transparent; color: #9a9aa1;
      cursor: pointer; padding: 2px 6px; border-radius: 5px;
      font-size: 12px; line-height: 1;
      transition: opacity .12s ease, background .12s ease, color .12s ease;
    }
    .reply-btn:hover { background: #2a2a2f; color: #ececef; }

    /* Nested replies */
    .replies {
      margin-left: 22px;
      border-left: 2px solid #2a2a2f;
      padding-left: 6px;
      margin-top: 2px;
    }
    .replies .m { grid-template-columns: 42px auto 1fr auto; }

    /* ---- Reply preview above composer ------------------------------- */
    #replyPreview {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 14px;
      background: #1d1d21;
      border-top: 1px solid #2a2a2f;
      font-size: 12px;
      color: #9a9aa1;
    }
    #replyPreview .rp-label { color: #6c6c74; }
    #replyPreview .rp-target { font-weight: 600; color: #ececef; }
    #replyPreview .rp-body {
      flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      color: #ececef;
    }
    #replyPreview .rp-cancel {
      border: 0; background: transparent; color: #9a9aa1;
      cursor: pointer; font-size: 14px; padding: 0 4px; line-height: 1;
    }
    #replyPreview .rp-cancel:hover { color: #ececef; }

    /* ---- Login prompt (for anonymous users) ------------------------- */
    #loginPrompt {
      display: flex; flex-direction: column; gap: 8px;
      padding: 12px 14px;
      background: #1d1d21;
      border-top: 1px solid #2a2a2f;
      font-size: 12.5px;
    }
    #loginPrompt .lp-text {
      color: #9a9aa1; line-height: 1.4;
    }
    #loginPrompt .lp-actions { display: flex; gap: 6px; }
    #loginPrompt .lp-btn {
      flex: 1;
      border: 1px solid #313138; background: #26262b; color: #ececef;
      border-radius: 8px; padding: 7px 11px; font: inherit; cursor: pointer;
      transition: background .12s ease;
    }
    #loginPrompt .lp-btn:hover { background: #30303a; }

    /* ---- Composer --------------------------------------------------- */
    form {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 12px;
      border-top: 1px solid #2a2a2f;
      background: #1d1d21;
    }
    form[hidden] { display: none; }
    input#box {
      flex: 1;
      border: 1px solid #313138; background: #26262b; color: #ececef;
      border-radius: 999px; padding: 8px 14px;
      font: inherit; outline: none;
      transition: background .12s ease, border-color .12s ease;
    }
    input#box:focus { border-color: #4a90e2; background: #2a2a30; }
    input#box::placeholder { color: #6c6c74; }
    form button {
      border: 0; background: #4a90e2; color: #fff;
      width: 30px; height: 30px; border-radius: 50%;
      cursor: pointer; padding: 0;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 15px; line-height: 1;
      transition: background .12s ease, transform .08s ease;
    }
    form button:hover { background: #5a9ce8; }
    form button:active { transform: scale(.94); }
    form button:disabled { background: #313138; color: #6c6c74; cursor: not-allowed; }

    /* ---- Light theme ------------------------------------------------ */
    @media (prefers-color-scheme: light) {
      .panel { background: #fff; color: #1a1a1a; border-color: #e5e5ea; }
      header, #settings, #replyPreview, #loginPrompt, form {
        background: #f6f6f7; border-color: #e5e5ea;
      }
      #presence, #settings small, #loginPrompt .lp-text, #whoami { color: #6d6d72; }
      .icon-btn { color: #6d6d72; }
      .icon-btn:hover { background: #ececef; color: #1a1a1a; }
      #settings input, #settings .btn, #loginPrompt .lp-btn, input#box {
        background: #fff; border-color: #d9d9de; color: #1a1a1a;
      }
      #settings input:focus, input#box:focus { border-color: #4a90e2; background: #fff; }
      #settings input::placeholder, input#box::placeholder { color: #a1a1a6; }
      #settings .btn:hover, #loginPrompt .lp-btn:hover { background: #ececef; border-color: #cbcbcf; }
      .m:hover { background: rgba(0,0,0,.03); }
      .m .body, #replyPreview .rp-body, #replyPreview .rp-target { color: #1a1a1a; }
      .replies { border-color: #e5e5ea; }
      .m .ts, .m .name::after, .settings-label, #replyPreview .rp-label { color: #a1a1a6; }
      .mention { background: rgba(59,130,246,.12); color: #1e40af; }
      .m.mention-self {
        background: linear-gradient(90deg, rgba(251,191,36,.2), rgba(251,191,36,.04));
      }
      .swatch.selected { border-color: #1a1a1a; }
      .reply-btn:hover { background: #ececef; color: #1a1a1a; }
    }
  </style>

  <div class="panel">
    <div class="resizer" aria-label="Resize sidebar" role="separator" aria-orientation="vertical"></div>
    <header>
      <h1 id="room"></h1>
      <span id="presence"></span>
      <span id="status"></span>
      <button id="popout" class="icon-btn" aria-label="Pop out window" title="Pop out">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M9 3h4v4M13 3l-6 6M11 9v3H4V5h3"/>
        </svg>
      </button>
      <button id="gear" class="icon-btn" aria-label="Account settings" title="Settings">⚙</button>
    </header>
    <div id="settings">
      <div id="whoami">Signed in as …</div>
      <div class="settings-label">Handle</div>
      <div class="row">
        <input id="handleInput" maxlength="24" placeholder="Pick a handle" aria-label="Handle">
        <button id="saveHandle" class="btn">Save</button>
      </div>
      <div class="settings-label">Color</div>
      <div class="swatches" id="swatches" role="radiogroup" aria-label="Handle color"></div>
      <div class="settings-label">Account</div>
      <div class="row social-row">
        <button id="google" class="btn social-btn" data-provider="google">Google</button>
        <button id="github" class="btn social-btn" data-provider="github">GitHub</button>
        <button id="discord" class="btn social-btn" data-provider="discord">Discord</button>
        <button id="apple" class="btn social-btn" data-provider="apple">Apple</button>
      </div>
      <div id="emailBlock">
        <div class="settings-label">Email sign-in</div>
        <div class="row">
          <input id="emailInput" type="email" placeholder="you@example.com" aria-label="Email" autocomplete="email">
          <button id="sendOtp" class="btn">Send code</button>
        </div>
        <div class="row" id="otpRow" hidden>
          <input id="otpInput" maxlength="6" inputmode="numeric" pattern="[0-9]*" placeholder="6-digit code" aria-label="Verification code" autocomplete="one-time-code">
          <button id="verifyOtp" class="btn">Verify</button>
        </div>
      </div>
      <div class="row">
        <button id="signout" class="btn">Sign out</button>
      </div>
      <small id="settingsMsg"></small>
    </div>
    <div id="log" role="log" aria-live="polite"></div>
    <div id="replyPreview" hidden>
      <span class="rp-label">Replying to</span>
      <span class="rp-target"></span>
      <span class="rp-body"></span>
      <button class="rp-cancel" aria-label="Cancel reply" title="Cancel">×</button>
    </div>
    <div id="loginPrompt" hidden>
      <div class="lp-text">Sign in to send messages. Anyone can read; only signed-in accounts can post.</div>
      <div class="lp-actions social-row" id="lpSocial"></div>
      <div class="settings-label" id="lpEmailLabel" hidden>Or use email</div>
      <div class="row" id="lpEmailRow" hidden>
        <input id="lpEmailInput" type="email" placeholder="you@example.com" aria-label="Email">
        <button id="lpSendOtp" class="btn">Send code</button>
      </div>
      <div class="row" id="lpOtpRow" hidden>
        <input id="lpOtpInput" maxlength="6" inputmode="numeric" placeholder="6-digit code" aria-label="Code">
        <button id="lpVerifyOtp" class="btn">Verify</button>
      </div>
    </div>
    <form>
      <input id="box" maxlength="500" placeholder="Say something…" aria-label="Chat message">
      <button aria-label="Send" title="Send">→</button>
    </form>
  </div>`;

function formatTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function tokenizeBody(text, selfHandle) {
  // Split on @mentions. Match handles by the same charset the server validates
  // (letters/digits/_.-, must start with alphanumeric, 3–24 chars).
  const re = /@([A-Za-z0-9][A-Za-z0-9_.-]{2,23})/g;
  const parts = [];
  let last = 0;
  let mentionsSelf = false;
  const selfLower = selfHandle ? selfHandle.toLowerCase() : null;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push({ kind: 'text', value: text.slice(last, m.index) });
    const isSelf = selfLower && m[1].toLowerCase() === selfLower;
    parts.push({ kind: 'mention', value: m[0], isSelf });
    if (isSelf) mentionsSelf = true;
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ kind: 'text', value: text.slice(last) });
  return { parts, mentionsSelf };
}

export function createSidebar(opts) {
  const {
    root,
    connect,
    account,
    resolveRoom,
    onNavigation,
    onToggle,
    isPopout,
    initialTitle,
  } = opts;

  root.innerHTML = MARKUP;

  // Works for both ShadowRoot and a plain container div (which lacks getElementById).
  const $ = (id) => root.querySelector('#' + id);
  const ui = {
    panel: root.querySelector('.panel'),
    resizer: root.querySelector('.resizer'),
    room: $('room'),
    presence: $('presence'),
    status: $('status'),
    log: $('log'),
    box: $('box'),
    form: root.querySelector('form'),
    sendBtn: root.querySelector('form button'),
    gear: $('gear'),
    popout: $('popout'),
    settings: $('settings'),
    whoami: $('whoami'),
    handleInput: $('handleInput'),
    saveHandle: $('saveHandle'),
    google: $('google'),
    github: $('github'),
    discord: $('discord'),
    apple: $('apple'),
    emailInput: $('emailInput'),
    emailBlock: $('emailBlock'),
    sendOtp: $('sendOtp'),
    otpRow: $('otpRow'),
    otpInput: $('otpInput'),
    verifyOtp: $('verifyOtp'),
    signout: $('signout'),
    settingsMsg: $('settingsMsg'),
    swatches: $('swatches'),
    replyPreview: $('replyPreview'),
    replyTarget: root.querySelector('#replyPreview .rp-target'),
    replyBody: root.querySelector('#replyPreview .rp-body'),
    replyCancel: root.querySelector('#replyPreview .rp-cancel'),
    loginPrompt: $('loginPrompt'),
    lpSocial: $('lpSocial'),
    lpEmailLabel: $('lpEmailLabel'),
    lpEmailRow: $('lpEmailRow'),
    lpEmailInput: $('lpEmailInput'),
    lpSendOtp: $('lpSendOtp'),
    lpOtpRow: $('lpOtpRow'),
    lpOtpInput: $('lpOtpInput'),
    lpVerifyOtp: $('lpVerifyOtp'),
  };

  const SOCIAL_LABELS = {
    google: 'Google',
    github: 'GitHub',
    discord: 'Discord',
    apple: 'Apple',
  };

  let authConfig = { social: [], emailOTP: false };
  let pendingEmail = '';

  // Docked panel starts hidden. Popout is always visible.
  ui.panel.classList.add(isPopout ? 'popout' : 'docked');
  let visible = isPopout;

  const state = {
    port: null,
    currentRoom: null,
    profile: null,
    lastMsgHandle: null,
    /** msgId -> { el, handle } for placing threaded replies + trimming. */
    messageIndex: new Map(),
    replyTo: null, // { id, handle, body } | null
  };

  // ---------------------------------------------------------------------------
  // Message rendering
  // ---------------------------------------------------------------------------
  function renderMessage(msg) {
    const isReply = !!msg.parentId && state.messageIndex.has(msg.parentId);
    const container = isReply
      ? getOrCreateReplies(state.messageIndex.get(msg.parentId).el)
      : ui.log;

    const row = document.createElement('div');
    row.className = 'm';
    row.dataset.id = msg.id;
    row.dataset.handle = msg.handle;

    // Group with the previous message when same author writes twice in a row
    // AT THE SAME LEVEL (top-level or same replies subtree).
    const prev = container.lastElementChild;
    if (prev && prev.classList.contains('m') && prev.dataset.handle === msg.handle) {
      row.classList.add('grouped');
    }

    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = formatTime(msg.ts ?? Date.now());

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = msg.handle;
    if (typeof msg.color === 'number') name.style.color = PALETTE[msg.color % PALETTE.length];

    const body = document.createElement('span');
    body.className = 'body';
    const { parts, mentionsSelf } = tokenizeBody(msg.body, state.profile?.handle);
    for (const p of parts) {
      if (p.kind === 'text') {
        body.appendChild(document.createTextNode(p.value));
      } else {
        const s = document.createElement('span');
        s.className = 'mention' + (p.isSelf ? ' mention-me' : '');
        s.textContent = p.value;
        body.appendChild(s);
      }
    }
    if (mentionsSelf) row.classList.add('mention-self');

    row.append(ts, name, body);

    // Reply affordance: only for top-level messages, only when signed in.
    if (!isReply && !state.profile?.isAnonymous) {
      const btn = document.createElement('button');
      btn.className = 'reply-btn';
      btn.type = 'button';
      btn.textContent = '↩';
      btn.title = 'Reply';
      btn.setAttribute('aria-label', `Reply to ${msg.handle}`);
      btn.addEventListener('click', () => beginReply(msg));
      row.append(btn);
    }

    const atBottom = ui.log.scrollTop + ui.log.clientHeight >= ui.log.scrollHeight - 40;
    container.appendChild(row);
    if (atBottom) ui.log.scrollTop = ui.log.scrollHeight;

    state.messageIndex.set(msg.id, { el: row, handle: msg.handle });
    trimLog();
  }

  function getOrCreateReplies(parentRow) {
    let replies = parentRow.querySelector(':scope > .replies');
    if (!replies) {
      replies = document.createElement('div');
      replies.className = 'replies';
      parentRow.appendChild(replies);
    }
    return replies;
  }

  function trimLog() {
    // Cap total rendered rows so a busy room doesn't balloon memory.
    while (ui.log.querySelectorAll('.m').length > 400) {
      const first = ui.log.firstElementChild;
      if (!first) break;
      // Forget every message id inside the removed subtree so future replies
      // pointing at those parents fall back to top-level rendering.
      for (const m of first.querySelectorAll('[data-id]')) {
        state.messageIndex.delete(m.dataset.id);
      }
      if (first.dataset.id) state.messageIndex.delete(first.dataset.id);
      first.remove();
    }
  }

  function clearMessages() {
    state.lastMsgHandle = null;
    state.messageIndex.clear();
    if (state.replyTo) cancelReply();
    ui.log.replaceChildren();
  }

  // ---------------------------------------------------------------------------
  // Reply flow
  // ---------------------------------------------------------------------------
  function beginReply(msg) {
    state.replyTo = { id: msg.id, handle: msg.handle, body: msg.body };
    ui.replyTarget.textContent = '@' + msg.handle;
    ui.replyBody.textContent = msg.body;
    ui.replyPreview.hidden = false;
    ui.box.focus();
  }
  function cancelReply() {
    state.replyTo = null;
    ui.replyPreview.hidden = true;
  }
  ui.replyCancel.addEventListener('click', cancelReply);

  // ---------------------------------------------------------------------------
  // Composer
  // ---------------------------------------------------------------------------
  ui.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const body = ui.box.value.trim();
    if (!body || !state.currentRoom) return;
    if (state.profile?.isAnonymous) return; // UI already hides the composer
    const frame = { t: 'send', roomKey: state.currentRoom, body };
    if (state.replyTo) frame.parentId = state.replyTo.id;
    state.port?.postMessage(frame);
    ui.box.value = '';
    cancelReply();
  });

  function updateComposerAccess() {
    const anon = state.profile?.isAnonymous ?? true; // unknown = treat as anon
    ui.form.hidden = anon;
    ui.loginPrompt.hidden = !anon;
    // A reply target only makes sense while sending is enabled.
    if (anon && state.replyTo) cancelReply();
  }

  // ---------------------------------------------------------------------------
  // Settings drawer
  // ---------------------------------------------------------------------------
  ui.gear.addEventListener('click', () => {
    ui.settings.classList.toggle('show');
    if (ui.settings.classList.contains('show')) loadProfile();
  });
  ui.saveHandle.addEventListener('click', async () => {
    const handle = ui.handleInput.value.trim();
    if (handle.length < 3) return setMsg('Handle must be at least 3 characters.');
    const r = await account('setHandle', { handle });
    if (r?.error) return setMsg(`Couldn’t save: ${r.error}`);
    state.profile = { ...(state.profile || {}), handle: r.handle };
    setMsg('Saved.');
    updateWhoami();
  });
  ui.google.addEventListener('click', () => linkProvider('google'));
  ui.github.addEventListener('click', () => linkProvider('github'));
  ui.discord.addEventListener('click', () => linkProvider('discord'));
  ui.apple.addEventListener('click', () => linkProvider('apple'));
  ui.sendOtp.addEventListener('click', () => startEmailOTP(ui.emailInput, ui.otpRow));
  ui.verifyOtp.addEventListener('click', () => finishEmailOTP(ui.emailInput, ui.otpInput, ui.otpRow));
  ui.lpSendOtp.addEventListener('click', () => startEmailOTP(ui.lpEmailInput, ui.lpOtpRow));
  ui.lpVerifyOtp.addEventListener('click', () => finishEmailOTP(ui.lpEmailInput, ui.lpOtpInput, ui.lpOtpRow));
  ui.signout.addEventListener('click', async () => {
    await account('signOut');
    state.profile = null;
    setMsg('Signed out. A new anonymous handle will be created on your next visit.');
    updateWhoami();
    updateComposerAccess();
  });

  async function linkProvider(provider) {
    setMsg(`Opening ${provider}…`);
    const r = await account('signIn', { provider });
    if (r?.error) return setMsg(`Sign-in failed: ${r.error}`);
    setMsg(r?.ok ? 'Account linked.' : 'Sign-in cancelled.');
    await loadProfile();
    updateComposerAccess();
  }

  async function startEmailOTP(emailEl, otpRowEl) {
    const email = emailEl.value.trim();
    if (!email || !email.includes('@')) return setMsg('Enter a valid email.');
    setMsg('Sending code…');
    const r = await account('sendEmailOTP', { email });
    if (r?.error) return setMsg(`Couldn’t send code: ${r.error}`);
    pendingEmail = email;
    otpRowEl.hidden = false;
    setMsg('Code sent — check your email (or the server log in dev).');
  }

  async function finishEmailOTP(emailEl, otpEl, otpRowEl) {
    const email = pendingEmail || emailEl.value.trim();
    const otp = otpEl.value.trim();
    if (!email || otp.length < 4) return setMsg('Enter the code from your email.');
    setMsg('Verifying…');
    const r = await account('verifyEmailOTP', { email, otp });
    if (r?.error) return setMsg(`Sign-in failed: ${r.error}`);
    pendingEmail = '';
    otpEl.value = '';
    otpRowEl.hidden = true;
    setMsg('Signed in with email.');
    await loadProfile();
    updateComposerAccess();
  }

  function applyAuthConfig() {
    const enabled = new Set(authConfig.social ?? []);
    for (const id of ['google', 'github', 'discord', 'apple']) {
      const btn = ui[id];
      if (btn) btn.hidden = !enabled.has(id);
    }
    const showEmail = Boolean(authConfig.emailOTP);
    if (ui.emailBlock) ui.emailBlock.hidden = !showEmail;

    ui.lpSocial.replaceChildren();
    for (const p of authConfig.social ?? []) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'lp-btn btn';
      b.textContent = SOCIAL_LABELS[p] ?? p;
      b.addEventListener('click', () => linkProvider(p));
      ui.lpSocial.appendChild(b);
    }
    ui.lpEmailLabel.hidden = !showEmail;
    ui.lpEmailRow.hidden = !showEmail;
    if (!showEmail) ui.lpOtpRow.hidden = true;
  }

  async function loadAuthConfig() {
    authConfig = await account('authConfig').catch(() => ({ social: [], emailOTP: false }));
    applyAuthConfig();
  }

  async function loadProfile() {
    state.profile = await account('profile').catch(() => null);
    updateWhoami();
    renderSwatches();
    updateComposerAccess();
  }

  function updateWhoami() {
    if (state.profile?.handle) {
      ui.whoami.textContent = `Signed in as ${state.profile.handle}${state.profile.isAnonymous ? ' (anonymous)' : ''}`;
      if (ui.handleInput && !ui.handleInput.value) ui.handleInput.value = state.profile.handle;
    } else {
      ui.whoami.textContent = 'Not signed in';
    }
  }

  function setMsg(text) { ui.settingsMsg.textContent = text; }

  // ---------------------------------------------------------------------------
  // Color picker
  // ---------------------------------------------------------------------------
  function renderSwatches() {
    ui.swatches.replaceChildren();
    const current = state.profile?.color;
    for (let i = 0; i < PALETTE.length; i++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch' + (i === current ? ' selected' : '');
      b.style.background = PALETTE[i];
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', i === current ? 'true' : 'false');
      b.setAttribute('aria-label', `Color ${i + 1}`);
      b.addEventListener('click', () => pickColor(i));
      ui.swatches.appendChild(b);
    }
  }

  async function pickColor(i) {
    const r = await account('setColor', { color: i });
    if (r?.error) return setMsg(`Couldn’t save: ${r.error}`);
    state.profile = { ...(state.profile || {}), color: i };
    setMsg('Color updated. New messages will use it.');
    renderSwatches();
  }

  // ---------------------------------------------------------------------------
  // Port + frame routing
  // ---------------------------------------------------------------------------
  function connectPort() {
    state.port = connect();
    state.port.onMessage.addListener(onServerFrame);
    state.port.onDisconnect.addListener(() => {
      state.port = null;
      setTimeout(() => {
        connectPort();
        if (state.currentRoom) {
          state.port.postMessage({ t: 'join', roomKey: state.currentRoom, title: document.title });
        }
      }, 500);
    });
  }

  function onServerFrame(f) {
    if (f.roomKey && f.roomKey !== state.currentRoom) return;
    if (f.t === 'history') {
      // History is newest-first; render oldest-first so scroll order is chronological.
      const msgs = [...f.msgs].reverse();
      // Render parents before their replies (parents have parentId=null).
      const orphans = [];
      for (const m of msgs) {
        if (m.parentId) orphans.push(m);
        else renderMessage(m);
      }
      for (const m of orphans) renderMessage(m);
    }
    if (f.t === 'msg') renderMessage(f.msg);
    if (f.t === 'presence') ui.presence.textContent = `${f.count} here`;
    if (f.t === 'status') ui.status.dataset.state = f.state;
    if (f.t === 'error' && f.code === 'sign_in_required') {
      setMsg('Sign in to send messages.');
      updateComposerAccess();
    }
  }

  // ---------------------------------------------------------------------------
  // Room lifecycle
  // ---------------------------------------------------------------------------
  function joinCurrentRoom() {
    const room = resolveRoom();
    if (room === state.currentRoom) return;
    if (state.currentRoom) state.port?.postMessage({ t: 'leave', roomKey: state.currentRoom });
    state.currentRoom = room;
    clearMessages();
    if (room) {
      ui.room.textContent = room;
      state.port?.postMessage({ t: 'join', roomKey: room, title: initialTitle ?? document.title });
    }
  }

  // ---------------------------------------------------------------------------
  // Pop-out
  // ---------------------------------------------------------------------------
  ui.popout.addEventListener('click', () => {
    account('popOut', {
      roomKey: state.currentRoom,
      title: initialTitle ?? document.title,
    });
    if (!isPopout) toggle(false); // close the docked panel; user is moving to the popout
  });
  if (isPopout) ui.popout.hidden = true;

  // ---------------------------------------------------------------------------
  // Resize (docked only)
  // ---------------------------------------------------------------------------
  async function initWidth() {
    if (isPopout) { ui.resizer.hidden = true; return; }
    const stored = await chrome.storage?.local?.get(WIDTH_KEY).catch(() => ({}));
    const w = stored?.[WIDTH_KEY];
    if (typeof w === 'number' && w >= MIN_WIDTH && w <= MAX_WIDTH) applyWidth(w);
  }
  function applyWidth(w) {
    // The host element is styled by the caller (content.js) — pass width up.
    opts.onWidthChange?.(w);
  }
  function attachResize() {
    if (isPopout) return;
    let dragging = false;
    let startX = 0;
    let startW = 0;
    ui.resizer.addEventListener('mousedown', (e) => {
      dragging = true;
      startX = e.clientX;
      startW = ui.panel.getBoundingClientRect().width;
      ui.resizer.classList.add('active');
      e.preventDefault();
    });
    const move = (e) => {
      if (!dragging) return;
      const w = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startW + (startX - e.clientX)));
      applyWidth(w);
    };
    const up = async () => {
      if (!dragging) return;
      dragging = false;
      ui.resizer.classList.remove('active');
      const w = ui.panel.getBoundingClientRect().width;
      await chrome.storage?.local?.set({ [WIDTH_KEY]: w }).catch(() => {});
    };
    // Listen on window so the drag survives cursor leaving the resizer.
    (root.host?.ownerDocument ?? document).addEventListener('mousemove', move);
    (root.host?.ownerDocument ?? document).addEventListener('mouseup', up);
  }

  // ---------------------------------------------------------------------------
  // External toggle
  // ---------------------------------------------------------------------------
  function toggle(force) {
    if (isPopout) return;
    visible = force === undefined ? !visible : force;
    ui.panel.classList.toggle('open', visible);
    if (visible) {
      if (!state.currentRoom) joinCurrentRoom();
      if (!state.profile) loadProfile();
    }
  }
  onToggle?.((cmd) => toggle(cmd === 'open' ? true : cmd === 'close' ? false : undefined));

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  connectPort();
  attachResize();
  void initWidth();
  void loadAuthConfig();
  onNavigation?.(joinCurrentRoom);

  if (isPopout) {
    // Popout is always visible; connect + load immediately.
    joinCurrentRoom();
    loadProfile();
  }

  return {
    destroy() {
      try { state.port?.disconnect(); } catch { /* noop */ }
    },
  };
}

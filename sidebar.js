/**
 * Shared sidebar UI. Used by:
 *   - content.js  — mounts inside a closed shadow root on any web page
 *   - popup.js    — mounts inside a standalone chrome.windows popup
 *
 * The two call sites differ only in how they discover the current room, how
 * they wire the port, and whether they own a "visible" toggle. Everything
 * else — layout, styling, threads, reactions, mentions, achievements, color
 * picker, resize — lives here so behavior stays identical in both contexts.
 *
 * Call:  createSidebar({ root, connect, account, resolveRoom, onNavigation?,
 *                        onToggle?, onWidthChange?, isPopout, initialTitle })
 * Returns: { destroy() }
 *
 * resolveRoom() must return { pageKey, domainKey } (either may be null) or
 * null when the page can't have a room at all.
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
const SCOPE_KEY = 'roomScope';           // 'page' | 'site'

// Quick-react palette. Must stay in sync with REACTION_EMOJI on the server.
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];

const REPORT_REASONS = [
  ['spam', 'Spam'],
  ['harassment', 'Harassment'],
  ['hate', 'Hate'],
  ['illegal', 'Illegal'],
  ['other', 'Other'],
];

const MARKUP = `
  <style>
    :host, .panel * { box-sizing: border-box; }

    .panel {
      /* ---- design tokens (dark default) ---- */
      --bg: #101014;
      --bg-raised: #17181d;
      --bg-hover: #1e1f26;
      --bg-input: #1b1c22;
      --border: #26272e;
      --border-strong: #34353e;
      --text: #e8e8ec;
      --text-dim: #9b9ca6;
      --text-faint: #64656e;
      --accent: #7c7ff2;
      --accent-soft: rgba(124, 127, 242, .16);
      --accent-grad: linear-gradient(135deg, #7c7ff2, #a56ef0);
      --gold: #fbbf24;
      --danger: #f87171;
      --ok: #34d399;
      --shadow: 0 8px 28px rgba(0,0,0,.45);

      width: 100%; height: 100vh;
      display: flex; flex-direction: column;
      position: relative;
      background: var(--bg); color: var(--text);
      border-left: 1px solid var(--border);
      font: 13.5px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI",
            Roboto, "Helvetica Neue", Arial, sans-serif;
      letter-spacing: -0.005em;
      overflow: hidden;
    }
    .panel.docked {
      transform: translateX(100%);
      transition: transform .24s cubic-bezier(.4,0,.2,1);
      box-shadow: -12px 0 40px rgba(0,0,0,.25);
    }
    .panel.docked.open { transform: none; }

    button { font: inherit; }

    /* ---- Drag resize handle (docked only) ---------------------------- */
    .resizer {
      position: absolute; top: 0; left: 0;
      width: 5px; height: 100%;
      cursor: ew-resize;
      background: transparent;
      transition: background .12s ease;
      z-index: 30;
    }
    .resizer:hover, .resizer.active { background: var(--accent-soft); }

    /* ---- Header ------------------------------------------------------ */
    header {
      padding: 10px 12px 10px 14px;
      display: flex; align-items: center; gap: 8px;
      background: var(--bg-raised);
      border-bottom: 1px solid var(--border);
      flex: none;
    }
    .brand {
      width: 22px; height: 22px; border-radius: 7px; flex: none;
      background: var(--accent-grad);
      display: inline-flex; align-items: center; justify-content: center;
      color: #fff; font-size: 12px; font-weight: 800;
      user-select: none;
    }
    header h1 {
      font-size: 12.5px; font-weight: 600; margin: 0; flex: 1; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      color: var(--text);
    }
    #presence {
      font-size: 11.5px; color: var(--text-dim); flex: none;
      display: none; align-items: center; gap: 5px;
    }
    #presence.show { display: inline-flex; }
    #presence::before {
      content: ''; width: 6px; height: 6px; border-radius: 50%;
      background: var(--ok);
      box-shadow: 0 0 0 3px rgba(52,211,153,.15);
    }
    .icon-btn {
      border: 0; background: transparent; color: var(--text-dim);
      width: 27px; height: 27px; border-radius: 7px; flex: none;
      cursor: pointer; padding: 0; font-size: 14px; line-height: 1;
      display: inline-flex; align-items: center; justify-content: center;
      transition: background .12s ease, color .12s ease;
    }
    .icon-btn:hover { background: var(--bg-hover); color: var(--text); }
    .icon-btn svg { width: 15px; height: 15px; }

    /* ---- Scope switcher (this page / whole site) --------------------- */
    #scopebar {
      display: none;
      padding: 8px 12px;
      background: var(--bg-raised);
      border-bottom: 1px solid var(--border);
      flex: none;
    }
    #scopebar.show { display: flex; }
    .seg {
      flex: 1; display: flex;
      background: var(--bg-input);
      border: 1px solid var(--border);
      border-radius: 9px; padding: 2px; gap: 2px;
    }
    .seg button {
      flex: 1; min-width: 0;
      border: 0; border-radius: 7px;
      background: transparent; color: var(--text-dim);
      padding: 4px 8px; cursor: pointer;
      font-size: 11.5px; font-weight: 600;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      transition: background .12s ease, color .12s ease;
    }
    .seg button:hover { color: var(--text); }
    .seg button.active {
      background: var(--bg-hover); color: var(--text);
      box-shadow: inset 0 0 0 1px var(--border-strong);
    }

    /* ---- Cold-start / reconnect notice -------------------------------- */
    #connbar {
      display: none;
      align-items: center; gap: 8px;
      padding: 7px 14px;
      font-size: 11.5px; color: var(--text-dim);
      background: var(--bg-raised);
      border-bottom: 1px solid var(--border);
      flex: none;
    }
    #connbar.show { display: flex; }
    #connbar .spinner {
      width: 10px; height: 10px; flex: none;
      border: 2px solid var(--border-strong); border-top-color: var(--accent);
      border-radius: 50%;
      animation: bc-spin .8s linear infinite;
    }
    @keyframes bc-spin { to { transform: rotate(360deg); } }

    /* ---- Settings drawer -------------------------------------------- */
    #settings {
      display: none;
      padding: 12px 14px 14px;
      border-bottom: 1px solid var(--border);
      flex-direction: column; gap: 10px;
      background: var(--bg-raised);
      overflow-y: auto;
      max-height: 62vh;
      flex: none;
      scrollbar-width: thin;
      scrollbar-color: var(--border-strong) transparent;
    }
    #settings.show { display: flex; }
    #whoami { font-size: 11.5px; color: var(--text-dim); }
    #whoami b { color: var(--text); font-weight: 650; }
    #statsRow {
      display: none; gap: 6px; flex-wrap: wrap;
    }
    #statsRow.show { display: flex; }
    .stat-chip {
      font-size: 11px; color: var(--text-dim);
      background: var(--bg-input); border: 1px solid var(--border);
      border-radius: 999px; padding: 3px 9px;
      white-space: nowrap;
    }
    .stat-chip b { color: var(--text); font-weight: 650; }
    #settings .row { display: flex; gap: 6px; flex-wrap: wrap; }
    .social-row .btn, #loginPrompt .lp-btn { flex: 1 1 calc(50% - 3px); min-width: 0; }
    #settings input, #settings .btn {
      border: 1px solid var(--border-strong); background: var(--bg-input); color: var(--text);
      border-radius: 8px; padding: 7px 11px; font: inherit; outline: none;
      transition: background .12s ease, border-color .12s ease;
    }
    #settings input { flex: 1; min-width: 0; }
    #settings input:focus { border-color: var(--accent); }
    #settings input::placeholder { color: var(--text-faint); }
    #settings .btn { cursor: pointer; white-space: nowrap; }
    #settings .btn:hover { background: var(--bg-hover); }
    #settings small { color: var(--text-dim); font-size: 11.5px; min-height: 14px; }

    .settings-label {
      font-size: 10.5px; color: var(--text-faint);
      text-transform: uppercase; letter-spacing: 0.07em; margin-top: 4px;
      font-weight: 650;
    }
    .swatches {
      display: grid; grid-template-columns: repeat(12, 1fr); gap: 6px;
    }
    .swatch {
      width: 100%; aspect-ratio: 1; border-radius: 6px;
      border: 2px solid transparent; padding: 0; cursor: pointer;
      transition: transform .1s ease, border-color .12s ease;
    }
    .swatch:hover { transform: scale(1.12); }
    .swatch.selected { border-color: var(--text); }

    /* ---- Badge picker + achievements --------------------------------- */
    #badges { display: flex; gap: 6px; flex-wrap: wrap; }
    .badge-pick {
      border: 1px solid var(--border-strong); background: var(--bg-input);
      border-radius: 8px; cursor: pointer;
      width: 34px; height: 34px; padding: 0;
      font-size: 16px; line-height: 1;
      display: inline-flex; align-items: center; justify-content: center;
      transition: border-color .12s ease, background .12s ease, transform .1s ease;
    }
    .badge-pick:hover { transform: translateY(-1px); }
    .badge-pick.selected {
      border-color: var(--accent);
      background: var(--accent-soft);
      box-shadow: 0 0 0 1px var(--accent);
    }
    .badge-pick.none { font-size: 11px; color: var(--text-dim); width: auto; padding: 0 10px; }
    #achv {
      display: grid; grid-template-columns: 1fr 1fr; gap: 6px;
    }
    .ach {
      display: flex; align-items: center; gap: 8px;
      border: 1px solid var(--border); border-radius: 9px;
      background: var(--bg-input);
      padding: 7px 9px; min-width: 0;
    }
    .ach .a-emoji { font-size: 17px; flex: none; }
    .ach .a-meta { min-width: 0; flex: 1; }
    .ach .a-title {
      font-size: 11.5px; font-weight: 650; color: var(--text);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .ach .a-sub { font-size: 10px; color: var(--text-faint); white-space: nowrap; }
    .ach .a-bar {
      height: 3px; border-radius: 2px; background: var(--border);
      margin-top: 3px; overflow: hidden;
    }
    .ach .a-bar i {
      display: block; height: 100%;
      background: var(--accent-grad);
      border-radius: 2px;
    }
    .ach.locked { opacity: .55; }
    .ach.locked .a-emoji { filter: grayscale(1); }
    .ach.earned { border-color: var(--border-strong); }

    /* ---- Log --------------------------------------------------------- */
    #logwrap { flex: 1; position: relative; min-height: 0; display: flex; }
    #log {
      flex: 1; overflow-y: auto; overflow-x: hidden;
      padding: 12px 14px 14px;
      scrollbar-width: thin;
      scrollbar-color: var(--border-strong) transparent;
      overscroll-behavior: contain;
    }
    #log::-webkit-scrollbar { width: 8px; }
    #log::-webkit-scrollbar-track { background: transparent; }
    #log::-webkit-scrollbar-thumb {
      background: var(--border-strong); border-radius: 4px;
      border: 2px solid transparent; background-clip: content-box;
    }

    #empty {
      position: absolute; inset: 0;
      display: none; flex-direction: column; align-items: center; justify-content: center;
      gap: 8px; text-align: center; padding: 24px;
      color: var(--text-faint); font-size: 12.5px;
      pointer-events: none;
    }
    #empty.show { display: flex; }
    #empty .e-emoji { font-size: 30px; }
    #empty .e-head { color: var(--text-dim); font-weight: 650; font-size: 13px; }

    .day-divider {
      display: flex; align-items: center; gap: 10px;
      margin: 12px 0 8px;
      font-size: 10.5px; color: var(--text-faint);
      text-transform: uppercase; letter-spacing: .07em; font-weight: 650;
      user-select: none;
    }
    .day-divider::before, .day-divider::after {
      content: ''; flex: 1; height: 1px; background: var(--border);
    }

    .m {
      display: grid;
      grid-template-columns: 40px auto 1fr;
      column-gap: 7px; row-gap: 2px;
      align-items: baseline;
      padding: 3px 6px;
      margin: 0 -6px;
      border-radius: 7px;
      word-wrap: break-word; overflow-wrap: anywhere;
      position: relative;
      animation: bc-in .18s ease;
    }
    @keyframes bc-in {
      from { opacity: 0; transform: translateY(3px); }
      to   { opacity: 1; transform: none; }
    }
    .m:hover { background: rgba(255,255,255,.03); }
    .m:hover > .acts { display: inline-flex; }

    .m .ts {
      font-size: 10.5px; color: var(--text-faint);
      font-variant-numeric: tabular-nums;
      user-select: none;
    }
    .m .name {
      font-weight: 700; font-size: 12.5px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      max-width: 12em;
    }
    .m .name .badge { font-size: 11px; margin-left: 3px; cursor: default; }
    .m .name::after { content: ''; }
    .m .body { color: var(--text); min-width: 0; }
    .m .body a { color: var(--accent); text-decoration: none; }
    .m .body a:hover { text-decoration: underline; }
    .m.grouped .ts, .m.grouped .name { visibility: hidden; }

    /* Mentions */
    .mention {
      background: var(--accent-soft);
      color: #aab0ff;
      padding: 0 4px; border-radius: 4px;
      font-weight: 600;
    }
    .m.mention-self {
      background: linear-gradient(90deg, rgba(251,191,36,.13), rgba(251,191,36,.02));
      box-shadow: inset 3px 0 0 var(--gold);
    }
    .m.mention-self .mention.mention-me {
      background: rgba(251,191,36,.26); color: #fef3c7;
    }

    /* Hover action bar */
    .acts {
      display: none;
      position: absolute; top: -12px; right: 6px;
      background: var(--bg-raised);
      border: 1px solid var(--border-strong);
      border-radius: 8px;
      box-shadow: var(--shadow);
      padding: 2px;
      gap: 1px;
      z-index: 5;
    }
    .acts button {
      border: 0; background: transparent; color: var(--text-dim);
      cursor: pointer; padding: 3px 6px; border-radius: 6px;
      font-size: 12.5px; line-height: 1;
      transition: background .1s ease, color .1s ease;
    }
    .acts button:hover { background: var(--bg-hover); color: var(--text); }

    /* Popovers (emoji picker / report menu) */
    .popover {
      position: absolute; top: 14px; right: 6px;
      background: var(--bg-raised);
      border: 1px solid var(--border-strong);
      border-radius: 10px;
      box-shadow: var(--shadow);
      padding: 4px;
      display: flex; gap: 2px;
      z-index: 20;
      animation: bc-in .12s ease;
    }
    .popover.vertical { flex-direction: column; min-width: 130px; }
    .popover button {
      border: 0; background: transparent; color: var(--text);
      cursor: pointer; border-radius: 7px;
      padding: 4px 7px; font-size: 15px; line-height: 1.2;
      text-align: left;
      transition: background .1s ease;
    }
    .popover.vertical button { font-size: 12px; padding: 6px 9px; color: var(--text-dim); }
    .popover.vertical button:hover { color: var(--text); }
    .popover button:hover { background: var(--bg-hover); }

    /* Reactions */
    .rx {
      grid-column: 3;
      display: flex; gap: 4px; flex-wrap: wrap;
      padding-top: 1px;
    }
    .rx:empty { display: none; }
    .rx button {
      border: 1px solid var(--border);
      background: var(--bg-input); color: var(--text-dim);
      border-radius: 999px; cursor: pointer;
      padding: 1px 8px 1px 6px;
      font-size: 11.5px; line-height: 1.6;
      display: inline-flex; align-items: center; gap: 4px;
      transition: border-color .12s ease, background .12s ease, transform .08s ease;
    }
    .rx button:hover { border-color: var(--border-strong); transform: translateY(-1px); }
    .rx button.mine {
      border-color: var(--accent);
      background: var(--accent-soft);
      color: var(--text);
    }
    .rx .n { font-variant-numeric: tabular-nums; font-weight: 650; }

    /* Nested replies */
    .replies {
      grid-column: 1 / -1;
      margin-left: 20px;
      border-left: 2px solid var(--border);
      padding-left: 8px;
      margin-top: 2px;
    }

    /* ---- Toasts ------------------------------------------------------ */
    #toasts {
      position: absolute; top: 10px; left: 12px; right: 12px;
      display: flex; flex-direction: column; gap: 8px;
      z-index: 40; pointer-events: none;
    }
    .toast {
      background: var(--bg-raised);
      border: 1px solid var(--border-strong);
      border-radius: 11px;
      box-shadow: var(--shadow);
      padding: 9px 12px;
      font-size: 12px; color: var(--text);
      display: flex; align-items: center; gap: 9px;
      animation: bc-toast .22s cubic-bezier(.34,1.3,.64,1);
      pointer-events: auto;
    }
    @keyframes bc-toast {
      from { opacity: 0; transform: translateY(-8px) scale(.97); }
      to   { opacity: 1; transform: none; }
    }
    .toast.err { border-color: rgba(248,113,113,.4); }
    .toast.err .t-emoji { color: var(--danger); }
    .toast.ach {
      border: 1px solid transparent;
      background:
        linear-gradient(var(--bg-raised), var(--bg-raised)) padding-box,
        var(--accent-grad) border-box;
    }
    .toast .t-emoji { font-size: 18px; flex: none; }
    .toast .t-body { min-width: 0; }
    .toast .t-title { font-weight: 700; font-size: 12px; }
    .toast .t-sub { color: var(--text-dim); font-size: 11px; }

    /* ---- New-messages pill ------------------------------------------- */
    #newpill {
      position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%);
      display: none;
      border: 1px solid var(--border-strong);
      background: var(--bg-raised); color: var(--text);
      border-radius: 999px; padding: 5px 13px;
      font-size: 11.5px; font-weight: 650; cursor: pointer;
      box-shadow: var(--shadow);
      z-index: 15;
      align-items: center; gap: 6px;
    }
    #newpill.show { display: inline-flex; }
    #newpill:hover { background: var(--bg-hover); }
    #newpill .arrow { color: var(--accent); }

    /* ---- Typing indicator -------------------------------------------- */
    #typing {
      min-height: 0; padding: 0 14px;
      font-size: 11px; color: var(--text-dim);
      background: var(--bg);
      flex: none;
      overflow: hidden;
      transition: min-height .15s ease;
    }
    #typing.show { min-height: 20px; padding-bottom: 2px; }
    #typing .dots { display: inline-block; }
    #typing .dots i {
      display: inline-block; width: 3px; height: 3px; border-radius: 50%;
      background: var(--text-dim); margin-right: 2px;
      animation: bc-dot 1.2s infinite;
    }
    #typing .dots i:nth-child(2) { animation-delay: .2s; }
    #typing .dots i:nth-child(3) { animation-delay: .4s; }
    @keyframes bc-dot { 0%, 60%, 100% { opacity: .3; } 30% { opacity: 1; } }

    /* ---- Reply preview above composer ------------------------------- */
    #replyPreview {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 14px;
      background: var(--bg-raised);
      border-top: 1px solid var(--border);
      font-size: 12px;
      color: var(--text-dim);
      flex: none;
    }
    #replyPreview .rp-label { color: var(--text-faint); flex: none; }
    #replyPreview .rp-target { font-weight: 600; color: var(--text); flex: none; }
    #replyPreview .rp-body {
      flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      color: var(--text);
    }
    #replyPreview .rp-cancel {
      border: 0; background: transparent; color: var(--text-dim);
      cursor: pointer; font-size: 14px; padding: 0 4px; line-height: 1;
    }
    #replyPreview .rp-cancel:hover { color: var(--text); }

    /* ---- Login prompt (for anonymous users) ------------------------- */
    #loginPrompt {
      display: flex; flex-direction: column; gap: 8px;
      padding: 12px 14px;
      background: var(--bg-raised);
      border-top: 1px solid var(--border);
      font-size: 12.5px;
      flex: none;
    }
    #loginPrompt .lp-text { color: var(--text-dim); line-height: 1.45; }
    #loginPrompt .lp-actions { display: flex; gap: 6px; flex-wrap: wrap; }
    #loginPrompt .lp-btn, #loginPrompt input {
      border: 1px solid var(--border-strong); background: var(--bg-input); color: var(--text);
      border-radius: 8px; padding: 7px 11px; font: inherit; outline: none;
    }
    #loginPrompt input { flex: 1; min-width: 0; }
    #loginPrompt input:focus { border-color: var(--accent); }
    #loginPrompt input::placeholder { color: var(--text-faint); }
    #loginPrompt .lp-btn { cursor: pointer; transition: background .12s ease; }
    #loginPrompt .lp-btn:hover { background: var(--bg-hover); }
    #loginPrompt .row { display: flex; gap: 6px; }

    /* ---- Composer --------------------------------------------------- */
    form {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 12px;
      border-top: 1px solid var(--border);
      background: var(--bg-raised);
      flex: none;
      position: relative;
    }
    form[hidden] { display: none; }
    input#box {
      flex: 1; min-width: 0;
      border: 1px solid var(--border-strong); background: var(--bg-input); color: var(--text);
      border-radius: 999px; padding: 8px 14px;
      font: inherit; outline: none;
      transition: border-color .12s ease, box-shadow .12s ease;
    }
    input#box:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    input#box::placeholder { color: var(--text-faint); }
    #charCount {
      position: absolute; top: -18px; right: 14px;
      font-size: 10.5px; color: var(--text-faint);
      font-variant-numeric: tabular-nums;
      display: none;
      background: var(--bg); border-radius: 6px; padding: 1px 6px;
    }
    #charCount.show { display: block; }
    #charCount.hot { color: var(--danger); }
    form button.send {
      border: 0; background: var(--accent-grad); color: #fff;
      width: 31px; height: 31px; border-radius: 50%; flex: none;
      cursor: pointer; padding: 0;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 14px; line-height: 1;
      transition: filter .12s ease, transform .08s ease;
    }
    form button.send:hover { filter: brightness(1.12); }
    form button.send:active { transform: scale(.93); }

    /* ---- Light theme ------------------------------------------------ */
    @media (prefers-color-scheme: light) {
      .panel {
        --bg: #ffffff;
        --bg-raised: #f6f6f8;
        --bg-hover: #ebebef;
        --bg-input: #ffffff;
        --border: #e6e6eb;
        --border-strong: #d5d5dc;
        --text: #191a1f;
        --text-dim: #6b6c76;
        --text-faint: #9b9ca6;
        --accent: #6366f1;
        --accent-soft: rgba(99, 102, 241, .12);
        --accent-grad: linear-gradient(135deg, #6366f1, #8b5cf6);
        --shadow: 0 8px 28px rgba(20, 20, 40, .14);
      }
      .m:hover { background: rgba(0,0,0,.035); }
      .mention { color: #4338ca; }
      .m.mention-self {
        background: linear-gradient(90deg, rgba(251,191,36,.18), rgba(251,191,36,.03));
      }
      .m.mention-self .mention.mention-me { background: rgba(251,191,36,.3); color: #78350f; }
      .swatch.selected { border-color: #191a1f; }
    }
  </style>

  <div class="panel">
    <div class="resizer" aria-label="Resize sidebar" role="separator" aria-orientation="vertical"></div>
    <header>
      <span class="brand" aria-hidden="true">b</span>
      <h1 id="room" title=""></h1>
      <span id="presence"></span>
      <button id="popout" class="icon-btn" aria-label="Pop out window" title="Pop out">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M9 3h4v4M13 3l-6 6M11 9v3H4V5h3"/>
        </svg>
      </button>
      <button id="gear" class="icon-btn" aria-label="Account settings" title="Settings">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
          <circle cx="8" cy="8" r="2.2"/>
          <path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2"/>
        </svg>
      </button>
    </header>

    <div id="scopebar">
      <div class="seg" role="tablist" aria-label="Room scope">
        <button id="scopePage" role="tab">This page</button>
        <button id="scopeSite" role="tab">Whole site</button>
      </div>
    </div>

    <div id="connbar"><span class="spinner"></span><span id="connmsg"></span></div>

    <div id="settings">
      <div id="whoami">Signed in as …</div>
      <div id="statsRow"></div>
      <div class="settings-label">Handle</div>
      <div class="row">
        <input id="handleInput" maxlength="24" placeholder="Pick a handle" aria-label="Handle">
        <button id="saveHandle" class="btn">Save</button>
      </div>
      <div class="settings-label">Color</div>
      <div class="swatches" id="swatches" role="radiogroup" aria-label="Handle color"></div>
      <div class="settings-label" id="badgeLabel" hidden>Badge shown by your name</div>
      <div id="badges" hidden></div>
      <div class="settings-label">Achievements</div>
      <div id="achv"></div>
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

    <div id="logwrap">
      <div id="log" role="log" aria-live="polite"></div>
      <div id="empty">
        <div class="e-emoji">💬</div>
        <div class="e-head">It's quiet in here</div>
        <div id="emptySub">Nobody has said anything yet. Say hi — you'll be the pioneer. 🚩</div>
      </div>
      <div id="toasts"></div>
      <button id="newpill" type="button"><span class="arrow">↓</span><span id="newpillText"></span></button>
    </div>

    <div id="typing"></div>

    <div id="replyPreview" hidden>
      <span class="rp-label">Replying to</span>
      <span class="rp-target"></span>
      <span class="rp-body"></span>
      <button class="rp-cancel" aria-label="Cancel reply" title="Cancel">×</button>
    </div>

    <div id="loginPrompt" hidden>
      <div class="lp-text">Sign in to join the conversation. Anyone can read; only signed-in accounts can post.</div>
      <div class="lp-actions social-row" id="lpSocial"></div>
      <div class="settings-label" id="lpEmailLabel" hidden>Or use email</div>
      <div class="row" id="lpEmailRow" hidden>
        <input id="lpEmailInput" type="email" placeholder="you@example.com" aria-label="Email">
        <button id="lpSendOtp" class="lp-btn">Send code</button>
      </div>
      <div class="row" id="lpOtpRow" hidden>
        <input id="lpOtpInput" maxlength="6" inputmode="numeric" placeholder="6-digit code" aria-label="Code">
        <button id="lpVerifyOtp" class="lp-btn">Verify</button>
      </div>
    </div>

    <form>
      <span id="charCount"></span>
      <input id="box" maxlength="500" placeholder="Say something…" aria-label="Chat message">
      <button class="send" aria-label="Send" title="Send">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" width="14" height="14">
          <path d="M2.5 8h10M9 4.5L13 8l-4 3.5"/>
        </svg>
      </button>
    </form>
  </div>`;

function formatTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, today)) return 'Today';
  if (sameDay(d, yest)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

const URL_RE = /https?:\/\/[^\s<>"']+/g;
const MENTION_RE = /@([A-Za-z0-9][A-Za-z0-9_.-]{2,23})/g;

/**
 * Split a message body into text / mention / link tokens. Mentions match the
 * same charset the server validates for handles.
 */
function tokenizeBody(text, selfHandle) {
  const parts = [];
  let mentionsSelf = false;
  const selfLower = selfHandle ? selfHandle.toLowerCase() : null;

  // First pass: split out links, then mentions inside the text chunks.
  let last = 0;
  const withLinks = [];
  for (const m of text.matchAll(URL_RE)) {
    if (m.index > last) withLinks.push({ kind: 'text', value: text.slice(last, m.index) });
    withLinks.push({ kind: 'link', value: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) withLinks.push({ kind: 'text', value: text.slice(last) });

  for (const chunk of withLinks) {
    if (chunk.kind !== 'text') { parts.push(chunk); continue; }
    let tLast = 0;
    for (const m of chunk.value.matchAll(MENTION_RE)) {
      if (m.index > tLast) parts.push({ kind: 'text', value: chunk.value.slice(tLast, m.index) });
      const isSelf = selfLower && m[1].toLowerCase() === selfLower;
      parts.push({ kind: 'mention', value: m[0], isSelf });
      if (isSelf) mentionsSelf = true;
      tLast = m.index + m[0].length;
    }
    if (tLast < chunk.value.length) parts.push({ kind: 'text', value: chunk.value.slice(tLast) });
  }
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

  const $ = (id) => root.querySelector('#' + id);
  const ui = {
    panel: root.querySelector('.panel'),
    resizer: root.querySelector('.resizer'),
    room: $('room'),
    presence: $('presence'),
    scopebar: $('scopebar'),
    scopePage: $('scopePage'),
    scopeSite: $('scopeSite'),
    connbar: $('connbar'),
    connmsg: $('connmsg'),
    log: $('log'),
    empty: $('empty'),
    emptySub: $('emptySub'),
    toasts: $('toasts'),
    newpill: $('newpill'),
    newpillText: $('newpillText'),
    typing: $('typing'),
    box: $('box'),
    charCount: $('charCount'),
    form: root.querySelector('form'),
    gear: $('gear'),
    popout: $('popout'),
    settings: $('settings'),
    whoami: $('whoami'),
    statsRow: $('statsRow'),
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
    badgeLabel: $('badgeLabel'),
    badges: $('badges'),
    achv: $('achv'),
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

  const SOCIAL_LABELS = { google: 'Google', github: 'GitHub', discord: 'Discord', apple: 'Apple' };

  let authConfig = { social: [], emailOTP: false };
  let pendingEmail = '';

  // Docked panel starts hidden. Popout is always visible.
  ui.panel.classList.add(isPopout ? 'popout' : 'docked');
  let visible = isPopout;

  const state = {
    port: null,
    currentRoom: null,          // the joined room key
    keys: null,                 // { pageKey, domainKey } for the current URL
    scope: 'page',              // 'page' | 'site'
    profile: null,
    catalog: [],                // achievement defs from the server
    /** msgId -> { el, handle, body, ts } for threading, reactions, trimming. */
    messageIndex: new Map(),
    replyTo: null,              // { id, handle, body } | null
    lastDay: null,              // last rendered date divider key
    unread: 0,
    typers: new Map(),          // handle -> { color, exp }
    lastTypingSent: 0,
    connSince: 0,               // when we entered 'connecting'
    openPopover: null,
  };

  const catalogById = new Map();

  // ---------------------------------------------------------------------------
  // Toasts
  // ---------------------------------------------------------------------------
  function toast({ emoji, title, sub, kind = '', ttl = 4000 }) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    const e = document.createElement('span');
    e.className = 't-emoji';
    e.textContent = emoji;
    const body = document.createElement('div');
    body.className = 't-body';
    const t = document.createElement('div');
    t.className = 't-title';
    t.textContent = title;
    body.appendChild(t);
    if (sub) {
      const s = document.createElement('div');
      s.className = 't-sub';
      s.textContent = sub;
      body.appendChild(s);
    }
    el.append(e, body);
    ui.toasts.appendChild(el);
    while (ui.toasts.children.length > 3) ui.toasts.firstElementChild.remove();
    setTimeout(() => el.remove(), ttl);
  }

  const ERROR_TOASTS = {
    rate_limited: (f) => ({ emoji: '🐢', title: 'Slow down', sub: `Try again in ${f.retryAfter ?? 5}s.` }),
    mod_blocked: () => ({ emoji: '🚫', title: 'Message blocked', sub: 'That message isn’t allowed here.' }),
    mod_flood: () => ({ emoji: '🌊', title: 'Not sent', sub: 'Looks like keyboard-mashing.' }),
    mod_link_spam: () => ({ emoji: '🔗', title: 'Not sent', sub: 'Link-only messages are filtered.' }),
    mod_too_long: () => ({ emoji: '📏', title: 'Too long', sub: 'Messages max out at 500 characters.' }),
    locked: () => ({ emoji: '🔒', title: 'Room locked', sub: 'A moderator has locked this room.' }),
    banned: () => ({ emoji: '⛔', title: 'Posting disabled', sub: 'Your account is banned from posting.' }),
  };

  // ---------------------------------------------------------------------------
  // Message rendering
  // ---------------------------------------------------------------------------
  function badgeInfo(id) {
    return id ? catalogById.get(id) ?? null : null;
  }

  function refreshBadgeGlyphs() {
    for (const el of ui.log.querySelectorAll('.badge[data-badge]')) {
      const info = badgeInfo(el.dataset.badge);
      if (info) { el.textContent = info.emoji; el.title = info.title; }
    }
  }

  function isAtBottom() {
    return ui.log.scrollTop + ui.log.clientHeight >= ui.log.scrollHeight - 40;
  }
  function scrollToBottom() {
    ui.log.scrollTop = ui.log.scrollHeight;
    state.unread = 0;
    ui.newpill.classList.remove('show');
  }

  function renderMessage(msg, { live = true } = {}) {
    if (state.messageIndex.has(msg.id)) return;   // dedupe (reconnect backfill)

    const isReply = !!msg.parentId && state.messageIndex.has(msg.parentId);
    const container = isReply
      ? getOrCreateReplies(state.messageIndex.get(msg.parentId).el)
      : ui.log;

    // Date divider between calendar days (top-level only).
    if (!isReply) {
      const dk = dayKey(msg.ts ?? Date.now());
      if (dk !== state.lastDay) {
        state.lastDay = dk;
        const div = document.createElement('div');
        div.className = 'day-divider';
        div.textContent = dayLabel(msg.ts ?? Date.now());
        ui.log.appendChild(div);
      }
    }

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
    if (msg.badge) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.dataset.badge = msg.badge;
      const info = badgeInfo(msg.badge);
      b.textContent = info ? info.emoji : '';
      if (info) b.title = info.title;
      name.appendChild(b);
    }

    const body = document.createElement('span');
    body.className = 'body';
    const { parts, mentionsSelf } = tokenizeBody(msg.body, state.profile?.handle);
    for (const p of parts) {
      if (p.kind === 'text') {
        body.appendChild(document.createTextNode(p.value));
      } else if (p.kind === 'link') {
        const a = document.createElement('a');
        a.href = p.value;
        a.textContent = p.value;
        a.target = '_blank';
        a.rel = 'noopener noreferrer nofollow';
        body.appendChild(a);
      } else {
        const s = document.createElement('span');
        s.className = 'mention' + (p.isSelf ? ' mention-me' : '');
        s.textContent = p.value;
        body.appendChild(s);
      }
    }
    if (mentionsSelf) row.classList.add('mention-self');

    row.append(ts, name, body);

    // Reactions row (chips live under the body).
    const rx = document.createElement('div');
    rx.className = 'rx';
    row.appendChild(rx);
    for (const r of msg.reactions ?? []) setReaction(row, r.emoji, r.count, r.mine);

    // Hover action bar: react / reply / report. Sending requires sign-in, so
    // the affordances only appear for non-anonymous users.
    if (!state.profile?.isAnonymous) {
      const acts = document.createElement('div');
      acts.className = 'acts';
      const mkBtn = (label, title, fn) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.title = title;
        b.setAttribute('aria-label', title);
        b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
        acts.appendChild(b);
      };
      mkBtn('😊', 'Add reaction', () => openReactPicker(row, msg));
      if (!isReply) mkBtn('↩', `Reply to ${msg.handle}`, () => beginReply(msg));
      if (msg.handle !== state.profile?.handle) {
        mkBtn('⚑', 'Report message', () => openReportMenu(row, msg));
      }
      row.appendChild(acts);
    }

    const atBottom = isAtBottom();
    container.appendChild(row);
    state.messageIndex.set(msg.id, { el: row, handle: msg.handle, body: msg.body, ts: msg.ts });
    updateEmpty();

    if (atBottom || !live) {
      ui.log.scrollTop = ui.log.scrollHeight;
    } else if (live) {
      state.unread += 1;
      ui.newpillText.textContent = state.unread === 1 ? '1 new message' : `${state.unread} new messages`;
      ui.newpill.classList.add('show');
    }
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
      if (first.classList.contains('day-divider')) { first.remove(); continue; }
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
    state.messageIndex.clear();
    state.lastDay = null;
    state.unread = 0;
    state.typers.clear();
    renderTypers();
    ui.newpill.classList.remove('show');
    if (state.replyTo) cancelReply();
    closePopover();
    ui.log.replaceChildren();
    updateEmpty();
  }

  function updateEmpty() {
    const hasMsgs = !!ui.log.querySelector('.m');
    if (!state.currentRoom) {
      ui.emptySub.textContent = 'This page can’t have a room (private or unsupported URL).';
      ui.empty.classList.add('show');
    } else if (!hasMsgs) {
      ui.emptySub.textContent = 'Nobody has said anything yet. Say hi — you’ll be the pioneer. 🚩';
      ui.empty.classList.toggle('show', true);
    } else {
      ui.empty.classList.remove('show');
    }
  }

  ui.newpill.addEventListener('click', scrollToBottom);
  ui.log.addEventListener('scroll', () => { if (isAtBottom()) { state.unread = 0; ui.newpill.classList.remove('show'); } });

  // ---------------------------------------------------------------------------
  // Reactions
  // ---------------------------------------------------------------------------
  /** Find a reaction chip by scanning children — attribute selectors with
   *  emoji values are unreliable across selector engines. */
  function findChip(row, emoji) {
    const rx = row.querySelector(':scope > .rx');
    if (!rx) return null;
    return [...rx.children].find((c) => c.dataset.emoji === emoji) ?? null;
  }

  /** Create/update/remove one reaction chip on a message row. */
  function setReaction(row, emoji, count, mine) {
    const rx = row.querySelector(':scope > .rx');
    if (!rx) return;
    let chip = findChip(row, emoji);
    if (count <= 0) { chip?.remove(); return; }
    if (!chip) {
      chip = document.createElement('button');
      chip.type = 'button';
      chip.dataset.emoji = emoji;
      const e = document.createElement('span');
      e.textContent = emoji;
      const n = document.createElement('span');
      n.className = 'n';
      chip.append(e, n);
      chip.addEventListener('click', () => toggleReaction(row.dataset.id, emoji));
      rx.appendChild(chip);
    }
    chip.querySelector('.n').textContent = String(count);
    if (mine !== undefined) chip.classList.toggle('mine', mine);
    chip.title = `React ${emoji}`;
  }

  function toggleReaction(messageId, emoji) {
    if (state.profile?.isAnonymous ?? true) { toast({ emoji: '🔑', title: 'Sign in to react', kind: 'err' }); return; }
    const row = state.messageIndex.get(messageId)?.el;
    if (!row || !state.currentRoom) return;
    const chip = findChip(row, emoji);
    const isMine = chip?.classList.contains('mine') ?? false;
    // Optimistic flip; the server's react frame will settle the real count.
    if (chip) {
      chip.classList.toggle('mine', !isMine);
      const n = chip.querySelector('.n');
      n.textContent = String(Math.max(0, Number(n.textContent) + (isMine ? -1 : 1)));
      if (Number(n.textContent) === 0) chip.remove();
    } else {
      setReaction(row, emoji, 1, true);
    }
    state.port?.postMessage({
      t: 'react', roomKey: state.currentRoom, messageId, emoji, op: isMine ? 'remove' : 'add',
    });
  }

  function onReactFrame(f) {
    const row = state.messageIndex.get(f.messageId)?.el;
    if (!row) return;
    const chip = findChip(row, f.emoji);
    setReaction(row, f.emoji, f.count, chip?.classList.contains('mine'));
  }

  // ---------------------------------------------------------------------------
  // Popovers (single one open at a time)
  // ---------------------------------------------------------------------------
  function closePopover() {
    state.openPopover?.remove();
    state.openPopover = null;
  }

  function openPopover(row, build) {
    closePopover();
    const pop = document.createElement('div');
    pop.className = 'popover';
    build(pop);
    row.appendChild(pop);
    state.openPopover = pop;
    // Dismiss on any outside click.
    setTimeout(() => {
      const dismiss = (e) => {
        if (!pop.contains(e.target)) { closePopover(); root.removeEventListener('click', dismiss, true); }
      };
      root.addEventListener('click', dismiss, true);
    }, 0);
  }

  function openReactPicker(row, msg) {
    openPopover(row, (pop) => {
      for (const emoji of REACTIONS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = emoji;
        b.addEventListener('click', () => { closePopover(); toggleReaction(msg.id, emoji); });
        pop.appendChild(b);
      }
    });
  }

  function openReportMenu(row, msg) {
    openPopover(row, (pop) => {
      pop.classList.add('vertical');
      const head = document.createElement('button');
      head.type = 'button';
      head.textContent = 'Report as…';
      head.disabled = true;
      head.style.opacity = '.6';
      pop.appendChild(head);
      for (const [reason, label] of REPORT_REASONS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.addEventListener('click', async () => {
          closePopover();
          const r = await account('report', {
            report: {
              messageId: msg.id,
              messageCreatedAt: msg.ts ?? Date.now(),
              roomKey: state.currentRoom,
              reason,
            },
          });
          if (r?.error) toast({ emoji: '⚠️', title: 'Report failed', sub: r.error, kind: 'err' });
          else toast({ emoji: '✅', title: 'Reported', sub: 'Thanks — a moderator will take a look.' });
        });
        pop.appendChild(b);
      }
    });
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
    updateCharCount();
    cancelReply();
  });

  function updateCharCount() {
    const len = ui.box.value.length;
    ui.charCount.classList.toggle('show', len >= 400);
    ui.charCount.classList.toggle('hot', len >= 480);
    if (len >= 400) ui.charCount.textContent = `${len}/500`;
  }

  ui.box.addEventListener('input', () => {
    updateCharCount();
    // Typing signal, throttled to one every 2.5s. Server rate-limits again.
    const now = Date.now();
    if (
      state.currentRoom &&
      !state.profile?.isAnonymous &&
      ui.box.value &&
      now - state.lastTypingSent > 2500
    ) {
      state.lastTypingSent = now;
      state.port?.postMessage({ t: 'typing', roomKey: state.currentRoom });
    }
  });

  function updateComposerAccess() {
    const anon = state.profile?.isAnonymous ?? true; // unknown = treat as anon
    ui.form.hidden = anon;
    ui.loginPrompt.hidden = !anon;
    // A reply target only makes sense while sending is enabled.
    if (anon && state.replyTo) cancelReply();
  }

  // ---------------------------------------------------------------------------
  // Typing indicator
  // ---------------------------------------------------------------------------
  function onTypingFrame(f) {
    if (f.handle === state.profile?.handle) return;
    state.typers.set(f.handle, { exp: Date.now() + 4000 });
    renderTypers();
  }

  let typersTimer = null;
  function renderTypers() {
    const now = Date.now();
    for (const [h, v] of state.typers) if (v.exp <= now) state.typers.delete(h);
    const names = [...state.typers.keys()];
    if (names.length === 0) {
      ui.typing.classList.remove('show');
      ui.typing.replaceChildren();
      if (typersTimer) { clearInterval(typersTimer); typersTimer = null; }
      return;
    }
    const label =
      names.length === 1 ? `${names[0]} is typing` :
      names.length === 2 ? `${names[0]} and ${names[1]} are typing` :
      `${names.length} people are typing`;
    ui.typing.replaceChildren();
    const span = document.createElement('span');
    span.textContent = label + ' ';
    const dots = document.createElement('span');
    dots.className = 'dots';
    for (let i = 0; i < 3; i++) dots.appendChild(document.createElement('i'));
    ui.typing.append(span, dots);
    ui.typing.classList.add('show');
    if (!typersTimer) typersTimer = setInterval(renderTypers, 800);
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
    if (r?.error === 'handle_taken') return setMsg('That handle is taken — try another.');
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
    setMsg('Code sent — check your email.');
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
      b.className = 'lp-btn';
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

  async function loadCatalog() {
    const cat = await account('achievements').catch(() => []);
    state.catalog = Array.isArray(cat) ? cat : [];
    catalogById.clear();
    for (const a of state.catalog) catalogById.set(a.id, a);
    refreshBadgeGlyphs();
    renderAchievements();
  }

  async function loadProfile() {
    state.profile = await account('profile').catch(() => null);
    updateWhoami();
    renderSwatches();
    renderStats();
    renderBadgePicker();
    renderAchievements();
    updateComposerAccess();
  }

  function updateWhoami() {
    if (state.profile?.handle) {
      ui.whoami.replaceChildren();
      const prefix = document.createTextNode('Signed in as ');
      const b = document.createElement('b');
      b.textContent = state.profile.handle;
      if (typeof state.profile.color === 'number') {
        b.style.color = PALETTE[state.profile.color % PALETTE.length];
      }
      ui.whoami.append(prefix, b);
      if (state.profile.isAnonymous) ui.whoami.append(document.createTextNode(' (anonymous)'));
      if (ui.handleInput && !ui.handleInput.value) ui.handleInput.value = state.profile.handle;
    } else {
      ui.whoami.textContent = 'Not signed in';
    }
  }

  function setMsg(text) { ui.settingsMsg.textContent = text; }

  // ---------------------------------------------------------------------------
  // Stats + badges + achievements (settings drawer)
  // ---------------------------------------------------------------------------
  function renderStats() {
    const s = state.profile?.stats;
    ui.statsRow.replaceChildren();
    if (!s || state.profile?.isAnonymous) { ui.statsRow.classList.remove('show'); return; }
    const chips = [
      ['💬', s.messagesSent, 'messages'],
      ['🗺️', s.roomsPosted, 'rooms'],
      ['🔥', s.streakDays, s.streakDays === 1 ? 'day streak' : 'day streak'],
    ];
    for (const [emoji, n, label] of chips) {
      const el = document.createElement('span');
      el.className = 'stat-chip';
      const b = document.createElement('b');
      b.textContent = String(n ?? 0);
      el.append(`${emoji} `, b, ` ${label}`);
      ui.statsRow.appendChild(el);
    }
    ui.statsRow.classList.add('show');
  }

  function renderBadgePicker() {
    const earned = new Set((state.profile?.achievements ?? []).map((a) => a.id));
    const show = earned.size > 0 && !state.profile?.isAnonymous;
    ui.badgeLabel.hidden = !show;
    ui.badges.hidden = !show;
    ui.badges.replaceChildren();
    if (!show) return;

    const current = state.profile?.badge ?? null;
    const none = document.createElement('button');
    none.type = 'button';
    none.className = 'badge-pick none' + (current === null ? ' selected' : '');
    none.textContent = 'None';
    none.addEventListener('click', () => pickBadge(null));
    ui.badges.appendChild(none);

    for (const a of state.catalog) {
      if (!earned.has(a.id)) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'badge-pick' + (current === a.id ? ' selected' : '');
      b.textContent = a.emoji;
      b.title = `${a.title} — ${a.desc}`;
      b.addEventListener('click', () => pickBadge(a.id));
      ui.badges.appendChild(b);
    }
  }

  async function pickBadge(id) {
    const r = await account('setBadge', { badge: id });
    if (r?.error) return setMsg(`Couldn’t set badge: ${r.error}`);
    state.profile = { ...(state.profile || {}), badge: id };
    setMsg(id ? 'Badge updated — it shows on your new messages.' : 'Badge removed.');
    renderBadgePicker();
  }

  function renderAchievements() {
    ui.achv.replaceChildren();
    if (state.catalog.length === 0) return;
    const earned = new Map((state.profile?.achievements ?? []).map((a) => [a.id, a.earnedAt]));
    const s = state.profile?.stats ?? {};
    const statMap = {
      messages_sent: s.messagesSent,
      rooms_posted: s.roomsPosted,
      rooms_pioneered: s.roomsPioneered,
      replies_received: s.repliesReceived,
      reactions_received: s.reactionsReceived,
      reactions_given: s.reactionsGiven,
      night_messages: s.nightMessages,
      best_streak: s.bestStreak,
    };
    for (const a of state.catalog) {
      const has = earned.has(a.id);
      const el = document.createElement('div');
      el.className = 'ach ' + (has ? 'earned' : 'locked');
      el.title = a.desc;
      const e = document.createElement('span');
      e.className = 'a-emoji';
      e.textContent = a.emoji;
      const meta = document.createElement('div');
      meta.className = 'a-meta';
      const t = document.createElement('div');
      t.className = 'a-title';
      t.textContent = a.title;
      meta.appendChild(t);
      if (has) {
        const sub = document.createElement('div');
        sub.className = 'a-sub';
        sub.textContent = 'Earned';
        meta.appendChild(sub);
      } else {
        const cur = Math.min(statMap[a.stat] ?? 0, a.target);
        const sub = document.createElement('div');
        sub.className = 'a-sub';
        sub.textContent = `${cur}/${a.target}`;
        meta.appendChild(sub);
        const bar = document.createElement('div');
        bar.className = 'a-bar';
        const fill = document.createElement('i');
        fill.style.width = `${Math.round((cur / a.target) * 100)}%`;
        bar.appendChild(fill);
        meta.appendChild(bar);
      }
      el.append(e, meta);
      ui.achv.appendChild(el);
    }
  }

  function onAchievementFrame(f) {
    const a = f.a;
    if (!a) return;
    toast({ emoji: a.emoji, title: `Achievement unlocked: ${a.title}`, sub: a.desc, kind: 'ach', ttl: 6000 });
    if (state.profile) {
      const list = state.profile.achievements ?? [];
      if (!list.some((x) => x.id === a.id)) {
        state.profile.achievements = [...list, { id: a.id, earnedAt: Date.now() }];
      }
      renderBadgePicker();
      renderAchievements();
    }
  }

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
    setMsg('Color updated.');
    renderSwatches();
    updateWhoami();
  }

  // ---------------------------------------------------------------------------
  // Connection status (incl. free-tier cold start messaging)
  // ---------------------------------------------------------------------------
  let connTimer = null;
  function onStatus(stateName) {
    if (stateName === 'open') {
      ui.connbar.classList.remove('show');
      if (connTimer) { clearTimeout(connTimer); connTimer = null; }
      return;
    }
    // Show nothing for quick blips; after 4s assume a cold start / real outage.
    if (!connTimer) {
      state.connSince = Date.now();
      connTimer = setTimeout(() => {
        connTimer = null;
        ui.connmsg.textContent = 'Waking the server… free hosting naps when idle (can take ~30s).';
        ui.connbar.classList.add('show');
      }, 4000);
    }
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
          state.port.postMessage({ t: 'join', roomKey: state.currentRoom, title: initialTitle ?? document.title });
        }
      }, 500);
    });
  }

  function onServerFrame(f) {
    if (f.t === 'status') { onStatus(f.state); return; }
    if (f.t === 'achievement') { onAchievementFrame(f); return; }
    if (f.roomKey && f.roomKey !== state.currentRoom) return;
    if (f.t === 'history') {
      // History is newest-first; render oldest-first so scroll order is
      // chronological. Parents render before their replies. Already-rendered
      // ids are skipped (renderMessage dedupes), so reconnect backfill only
      // appends what we missed.
      const msgs = [...f.msgs].reverse();
      const orphans = [];
      for (const m of msgs) {
        if (m.parentId) orphans.push(m);
        else renderMessage(m, { live: false });
      }
      for (const m of orphans) renderMessage(m, { live: false });
      updateEmpty();
    }
    if (f.t === 'msg') renderMessage(f.msg);
    if (f.t === 'react') onReactFrame(f);
    if (f.t === 'typing') onTypingFrame(f);
    if (f.t === 'presence') {
      ui.presence.textContent = `${f.count} here`;
      ui.presence.classList.add('show');
    }
    if (f.t === 'error') {
      if (f.code === 'sign_in_required') {
        toast({ emoji: '🔑', title: 'Sign in to send messages', kind: 'err' });
        updateComposerAccess();
        return;
      }
      const make = ERROR_TOASTS[f.code];
      if (make) toast({ ...make(f), kind: 'err' });
    }
  }

  // ---------------------------------------------------------------------------
  // Room lifecycle + scope switcher
  // ---------------------------------------------------------------------------
  const scopeLoaded = Promise.resolve(chrome.storage?.local?.get(SCOPE_KEY))
    .then((v) => { if (v?.[SCOPE_KEY] === 'site') state.scope = 'site'; })
    .catch(() => {});

  function activeKeyFor(keys) {
    if (!keys) return null;
    if (state.scope === 'site' && keys.domainKey) return keys.domainKey;
    return keys.pageKey ?? keys.domainKey;
  }

  function updateScopeUI() {
    const k = state.keys;
    const both = !!(k?.pageKey && k?.domainKey && k.pageKey !== k.domainKey);
    ui.scopebar.classList.toggle('show', both);
    if (both) {
      const onPage = activeKeyFor(k) === k.pageKey;
      ui.scopePage.classList.toggle('active', onPage);
      ui.scopeSite.classList.toggle('active', !onPage);
      ui.scopeSite.textContent = k.domainKey;
      ui.scopeSite.title = `Everyone on ${k.domainKey}`;
    }
  }

  async function setScope(scope) {
    if (state.scope === scope) return;
    state.scope = scope;
    await chrome.storage?.local?.set({ [SCOPE_KEY]: scope }).catch(() => {});
    joinCurrentRoom({ force: true });
  }
  ui.scopePage.addEventListener('click', () => setScope('page'));
  ui.scopeSite.addEventListener('click', () => setScope('site'));

  function joinCurrentRoom({ force = false } = {}) {
    state.keys = resolveRoom();
    const room = activeKeyFor(state.keys);
    updateScopeUI();
    if (room === state.currentRoom && !force) return;
    if (state.currentRoom) state.port?.postMessage({ t: 'leave', roomKey: state.currentRoom });
    state.currentRoom = room;
    clearMessages();
    ui.presence.classList.remove('show');
    if (room) {
      ui.room.textContent = room;
      ui.room.title = room;
      state.port?.postMessage({ t: 'join', roomKey: room, title: initialTitle ?? document.title });
    } else {
      ui.room.textContent = 'Backchannel';
      updateEmpty();
    }
  }

  // ---------------------------------------------------------------------------
  // Pop-out
  // ---------------------------------------------------------------------------
  ui.popout.addEventListener('click', () => {
    account('popOut', {
      pageKey: state.keys?.pageKey ?? null,
      domainKey: state.keys?.domainKey ?? null,
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
      Promise.resolve(scopeLoaded).then(() => {
        if (!state.currentRoom) joinCurrentRoom();
      });
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
  void loadCatalog();
  onNavigation?.(() => joinCurrentRoom());

  if (isPopout) {
    // Popout is always visible; connect + load immediately.
    Promise.resolve(scopeLoaded).then(() => joinCurrentRoom());
    loadProfile();
  }

  return {
    destroy() {
      try { state.port?.disconnect(); } catch { /* noop */ }
    },
  };
}

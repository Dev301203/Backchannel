/**
 * Backchannel content script.
 *
 * Responsibilities:
 *   1. Compute the room key for the current URL (client-side preview;
 *      the server recomputes authoritatively).
 *   2. Host the shared sidebar UI (sidebar.js) inside a closed Shadow DOM so
 *      host-page CSS can't touch us and we can't leak styles onto the page.
 *   3. Track SPA navigations and forward toggle commands from the toolbar.
 *
 * The pop-out window runs the same sidebar UI from popup.js.
 */

import { normalize } from './normalize.js';
import { createSidebar } from './sidebar.js';

const shadowHost = document.createElement('div');
shadowHost.style.cssText =
  'all:initial; position:fixed; top:0; right:0; height:100vh; width:340px; z-index:2147483646;';
const shadowRoot = shadowHost.attachShadow({ mode: 'closed' });
document.documentElement.appendChild(shadowHost);

let externalToggle = null;

// Both keys go to the sidebar so it can offer a "this page / whole site"
// scope switcher; it picks which one to join.
function resolveRoom() {
  const keys = normalize(location.href);
  if (!keys) return null;
  return { pageKey: keys.pageKey, domainKey: keys.domainKey };
}

// Restore persisted width immediately so there's no flash of the default.
chrome.storage?.local?.get('sidebarWidth').then(({ sidebarWidth }) => {
  if (typeof sidebarWidth === 'number' && sidebarWidth >= 300 && sidebarWidth <= 560) {
    shadowHost.style.width = sidebarWidth + 'px';
  }
});

createSidebar({
  root: shadowRoot,
  connect: () => chrome.runtime.connect({ name: 'backchannel' }),
  account: (action, extra) => chrome.runtime.sendMessage({ t: 'account', action, ...extra }),
  resolveRoom,
  onNavigation(cb) {
    const fire = () => queueMicrotask(cb);
    for (const fn of ['pushState', 'replaceState']) {
      const orig = history[fn];
      history[fn] = function (...args) {
        const r = orig.apply(this, args);
        fire();
        return r;
      };
    }
    addEventListener('popstate', fire);
    // Cheap poll for SPAs that mutate the URL without History calls.
    let lastHref = location.href;
    setInterval(() => {
      if (location.href !== lastHref) { lastHref = location.href; fire(); }
    }, 1500);
  },
  onToggle(cb) { externalToggle = cb; },
  onWidthChange(w) { shadowHost.style.width = w + 'px'; },
  isPopout: false,
});

chrome.runtime.onMessage.addListener((m) => {
  if (m.t === 'toggle') externalToggle?.();
});

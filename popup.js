/**
 * Backchannel pop-out window entrypoint. Renders the same sidebar UI as the
 * docked content script but inside a chrome.windows popup — no shadow root,
 * no toggle, no resize handle.
 *
 * The room to join is passed as URL query params (?page=...&domain=...&title=...)
 * because we can't read the parent tab's URL from here. The legacy ?room=
 * param is still honored as the page key.
 */

import { createSidebar } from './sidebar.js';

const params = new URLSearchParams(location.search);
const pageKey = params.get('page') ?? params.get('room');
const domainKey = params.get('domain');
const title = params.get('title');
if (title) document.title = `Backchannel · ${title}`;

const host = document.getElementById('host');

createSidebar({
  root: host,
  connect: () => chrome.runtime.connect({ name: 'backchannel' }),
  account: (action, extra) => chrome.runtime.sendMessage({ t: 'account', action, ...extra }),
  resolveRoom: () => (pageKey || domainKey ? { pageKey, domainKey } : null),
  isPopout: true,
  initialTitle: title ?? '',
});

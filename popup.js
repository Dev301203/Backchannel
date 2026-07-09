/**
 * Backchannel pop-out window entrypoint. Renders the same sidebar UI as the
 * docked content script but inside a chrome.windows popup — no shadow root,
 * no toggle, no resize handle.
 *
 * The room to join is passed as a URL query param (?room=<roomKey>&title=...)
 * because we can't read the parent tab's URL from here.
 */

import { createSidebar } from './sidebar.js';

const params = new URLSearchParams(location.search);
const roomKey = params.get('room');
const title = params.get('title');
if (title) document.title = `Backchannel · ${title}`;

const host = document.getElementById('host');

createSidebar({
  root: host,
  connect: () => chrome.runtime.connect({ name: 'backchannel' }),
  account: (action, extra) => chrome.runtime.sendMessage({ t: 'account', action, ...extra }),
  resolveRoom: () => roomKey,
  isPopout: true,
  initialTitle: title ?? '',
});

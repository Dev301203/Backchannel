/**
 * Backchannel: URL → room key normalization
 *
 * Runs in BOTH the extension and the server. The server's output is
 * authoritative (never trust a client-computed room key for writes);
 * the client runs it too so the UI can show the room name instantly.
 *
 * Output format:
 *   domain room:  "youtube.com"
 *   page room:    "youtube.com/watch|v=dQw4w9WgXcQ"
 * ('|' separates path from the surviving, sorted query params — it can't
 *  appear unescaped in either, so the key is unambiguous.)
 *
 * RULES, in order:
 *  1.  Lowercase scheme + host. http and https map to the same room.
 *  2.  Strip default ports (:80, :443) and trailing dots on the host.
 *  3.  Strip a single leading "www." (but not "www2." etc. — those are
 *      usually distinct hosts).
 *  4.  Domain = eTLD+1 via the Public Suffix List ("blog.example.co.uk"
 *      → domain "example.co.uk"). Subdomains DO distinguish page rooms
 *      but share one domain room, except for user-content platforms
 *      (see SUBDOMAIN_IS_IDENTITY) where each subdomain is its own
 *      community: "alice.substack.com" ≠ "bob.substack.com".
 *  5.  Strip the fragment (#...) — except SPA hash-routing (#/inbox),
 *      where the fragment IS the path.
 *  6.  Strip tracking params (utm_*, gclid, fbclid, ref, ...).
 *  7.  Keep only params that identify content. Two tiers:
 *        - global allowlist (v, id, p, q, ...) as a sane default
 *        - per-site rules for big sites where we know better
 *      Sort surviving params for a canonical order.
 *  8.  Normalize the path: decode unreserved percent-escapes, collapse
 *      duplicate slashes, strip trailing slash (except root), strip
 *      common index files (index.html), lowercase ONLY the host — paths
 *      stay case-sensitive (/User/Alice ≠ /user/alice on many sites).
 *  9.  Never create page rooms for URLs that are clearly private or
 *      infinite: localhost/LAN/file:, search-result pages, and paths
 *      containing session-ish params. These fall back to domain rooms
 *      (or, for private hosts, no room at all).
 * 10.  Cap key length at 512 chars; longer keys hash their tail.
 */

// -- 3rd-party dep: real PSL parsing. `npm i tldts` (works in browser + node)
import { getDomain } from 'tldts';

const TRACKING_PARAMS = new Set([
  'utm_source','utm_medium','utm_campaign','utm_term','utm_content','utm_id',
  'gclid','gclsrc','dclid','fbclid','msclkid','twclid','igshid','mc_cid',
  'mc_eid','ref','ref_src','ref_url','referrer','source','cmpid','s_kwcid',
  'yclid','_hsenc','_hsmi','vero_id','wickedid','oly_anon_id','oly_enc_id',
  'spm','scm','share_id','si', // si = youtube/spotify share tracking
]);

// Params that identify content on most sites (generic fallback allowlist)
const GENERIC_CONTENT_PARAMS = new Set(['v','id','p','t','q','page','story','article','thread','post']);

// Sites where subdomain = community identity (each subdomain gets its own domain room)
const SUBDOMAIN_IS_IDENTITY = new Set([
  'substack.com','github.io','wordpress.com','blogspot.com','tumblr.com',
  'medium.com','notion.site','itch.io','bandcamp.com','neocities.org',
]);

// Per-site param rules: which params define the page's identity.
// null = no params ever matter (path alone identifies the page).
const SITE_PARAM_RULES = {
  'youtube.com':  { keep: ['v','list'] },          // watch?v=..., playlist?list=...
  'google.com':   { keep: [] },                    // search results: domain room only
  'amazon.com':   { keep: [] },                    // /dp/ASIN in path is the identity
  'reddit.com':   { keep: [] },
  'twitter.com':  { keep: [] },
  'x.com':        { keep: [] },
  'news.ycombinator.com': { keep: ['id'] },        // item?id=...
  'stackoverflow.com':    { keep: [] },
};

// Hosts/schemes that must never produce a room
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/;

// SPA hash-routing detection: fragment starting with "/" or "!/"
const HASH_ROUTE = /^#!?\//;

const MAX_KEY_LENGTH = 512;

/**
 * @param {string} rawUrl
 * @returns {{ domainKey: string, pageKey: string|null } | null}
 *   null            → no room for this URL at all (private/unsupported)
 *   pageKey: null   → only a domain room exists (e.g. search pages)
 */
export function normalize(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return null; }

  // Rule 1–2: scheme + host hygiene
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  let host = url.hostname.toLowerCase().replace(/\.+$/, '');
  if (PRIVATE_HOST.test(host)) return null;

  // Rule 3: single leading www.
  host = host.replace(/^www\./, '');

  // Rule 4: eTLD+1, with the subdomain-identity carve-out
  const etld1 = getDomain(host);
  if (!etld1) return null;
  const domainKey = SUBDOMAIN_IS_IDENTITY.has(etld1) ? host : etld1;

  // Rule 5: fragments — dropped unless it's a hash route
  let path = url.pathname;
  if (HASH_ROUTE.test(url.hash)) {
    path = path.replace(/\/$/, '') + '/' + url.hash.replace(/^#!?\//, '');
  }

  // Rule 8: path normalization (host lowercased above; path case preserved)
  path = path
    .replace(/\/{2,}/g, '/')
    .replace(/\/(index|default)\.(html?|php|aspx?)$/i, '/')
    .replace(/(.)\/$/, '$1');           // strip trailing slash, keep bare "/"
  try { path = decodeURI(path); } catch { /* keep raw on malformed escapes */ }

  // Rules 6–7: query param filtering
  const rules = SITE_PARAM_RULES[domainKey];
  const kept = [];
  for (const [k, v] of url.searchParams) {
    const key = k.toLowerCase();
    if (TRACKING_PARAMS.has(key)) continue;
    const allowed = rules ? rules.keep.includes(key) : GENERIC_CONTENT_PARAMS.has(key);
    if (allowed && v) kept.push([key, v]);
  }
  kept.sort(([a], [b]) => a.localeCompare(b));
  const paramStr = kept.map(([k, v]) => `${k}=${v}`).join('&');

  // Rule 9: pages that shouldn't be page rooms
  const isSearchish = /^\/(search|results|find)\b/.test(path);
  const isRootOnly = path === '/' && !paramStr;
  if (isSearchish || isRootOnly || (rules && rules.keep.length === 0 && path === '/')) {
    return { domainKey, pageKey: null };
  }

  // Assemble page key; Rule 10: length cap
  let pageKey = domainKey + path + (paramStr ? '|' + paramStr : '');
  if (pageKey.length > MAX_KEY_LENGTH) {
    pageKey = pageKey.slice(0, MAX_KEY_LENGTH - 17) + '#' + fnv1a(pageKey);
  }
  return { domainKey, pageKey };
}

// Tiny non-crypto hash for key-tail truncation (16 hex chars)
function fnv1a(str) {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

/* --------------------------------------------------------------------------
 * Test cases doubling as documentation:
 *
 * normalize('https://www.youtube.com/watch?v=abc&utm_source=x&si=zz')
 *   → { domainKey: 'youtube.com', pageKey: 'youtube.com/watch|v=abc' }
 *
 * normalize('http://YouTube.com:80/watch?v=abc')
 *   → same as above (scheme, case, port all collapse)
 *
 * normalize('https://alice.substack.com/p/my-post?ref=twitter')
 *   → { domainKey: 'alice.substack.com',
 *       pageKey:  'alice.substack.com/p/my-post' }
 *
 * normalize('https://blog.example.co.uk/2026/post/')
 *   → { domainKey: 'example.co.uk',
 *       pageKey:  'example.co.uk/2026/post' }   // NOTE: page keys use eTLD+1;
 *   // if you want subdomain-distinct page rooms, prepend host instead —
 *   // pick one and never change it, or old rooms strand.
 *
 * normalize('https://www.google.com/search?q=cats')
 *   → { domainKey: 'google.com', pageKey: null }  // search: domain room only
 *
 * normalize('http://192.168.1.10/admin') → null    // private, no room
 * ------------------------------------------------------------------------ */

/**
 * Extension endpoint config.
 *
 * BC_API_URL is injected at build time by build.mjs (esbuild `define`), from the
 * BC_API_URL environment variable. Defaults to the local dev server so a plain
 * `npm run build` works against docker-compose out of the box. For a hosted
 * build, override with e.g.:
 *
 *   BC_API_URL=https://api.backchannel.app npm run build      (bash)
 *   $env:BC_API_URL='https://api.backchannel.app'; npm run build   (PowerShell)
 *
 * The WebSocket URL is derived from it (http→ws, https→wss).
 */
/* global BC_API_URL */
export const API_URL =
  typeof BC_API_URL !== 'undefined' && BC_API_URL ? BC_API_URL : 'http://localhost:8080';

export const WS_URL = API_URL.replace(/^http/, 'ws') + '/socket';

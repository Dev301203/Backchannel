/**
 * Extension endpoint config.
 *
 * BC_API_URL is injected at build time by build.mjs (esbuild `define`), from the
 * BC_API_URL environment variable. Defaults to production. For a local or
 * self-hosted backend, build with e.g.:
 *
 *   BC_API_URL=http://localhost:8080 npm run build      (bash)
 *   $env:BC_API_URL='http://localhost:8080'; npm run build   (PowerShell)
 *
 * The WebSocket URL is derived from it (http→ws, https→wss).
 */
/* global BC_API_URL */
export const API_URL =
  typeof BC_API_URL !== 'undefined' && BC_API_URL ? BC_API_URL : 'https://api.backchannel.app';

export const WS_URL = API_URL.replace(/^http/, 'ws') + '/socket';

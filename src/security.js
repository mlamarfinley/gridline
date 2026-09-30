// Local-only request guard. The server binds 127.0.0.1 and has unauthenticated mutation
// endpoints, so we also reject unexpected Host headers (DNS rebinding) and cross-origin POSTs.
// Same-origin browser requests and non-browser clients without an Origin header are allowed.
export function allowedHosts(port) {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

export function requestAllowed(method, headers, port) {
  const hosts = allowedHosts(port);
  if (!hosts.has(String(headers.host || ''))) return false;
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = headers.origin;
    if (origin && !(/^http:\/\//.test(origin) && hosts.has(origin.replace(/^http:\/\//, '')))) return false;
    const site = headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return false;
  }
  return true;
}

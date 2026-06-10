// Centralized authenticated fetch for the tboard HTTP API.
//
// The server gates every /api/* route on a token (see server/index.ts auth
// middleware). Browser clients fetch it once from GET /api/token at startup and
// must attach it to every subsequent request. Header-less requests (<img src>,
// <a href>, drag DownloadURL) cannot set a header, so they carry it as ?token=.

let token: string | null = null;

export function setApiToken(t: string): void {
  token = t;
}

// Drop-in replacement for fetch() against /api/*: injects the x-tboard-token
// header when a token is available.
export function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) headers.set('x-tboard-token', token);
  return fetch(input, { ...init, headers });
}

// Append the token as a ?token= query param for header-less URLs (raw images,
// downloads). Preserves any existing query string.
export function withToken(url: string): string {
  if (!token) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

// Returns the parsed JSON object (any-typed; callers know the endpoint shape) or
// the raw text for non-JSON responses.
export async function readApiPayload(res: Response): Promise<any> {
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return await res.json();
  }
  return await res.text();
}

export function getApiError(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string') {
    return payload.error;
  }
  if (typeof payload === 'string' && payload.trim()) {
    return payload.slice(0, 200);
  }
  return fallback;
}

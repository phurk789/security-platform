// Thin client for the platform API.
import type { ApiError as ApiErrorBody } from '@13store/shared';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: ApiErrorBody['code'] | 'error' | 'network',
    message: string,
  ) {
    super(message);
  }
}

const TOKEN_KEY = 'ps.token';

export function loadToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveToken(t: string) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: session-only */
  }
}

export class Api {
  token = '';
  /** In replay the server refuses every change (F12). */
  replay = false;

  async raw(method: string, path: string, body?: unknown): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`/api/v1${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...(this.replay ? { 'x-console-mode': 'replay' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(0, 'network', 'Cannot reach the server. Check the connection.');
    }
    if (!res.ok) {
      let msg = `Request failed (${res.status}).`;
      let code: ApiError['code'] = 'error';
      try {
        const b = (await res.json()) as ApiErrorBody;
        msg = b.error ?? msg;
        code = b.code ?? code;
      } catch {
        /* not JSON */
      }
      throw new ApiError(res.status, code, msg);
    }
    return res;
  }

  /** PUT a file as the raw request body (edge app APKs). Errors as for every other call. */
  async upload<T>(path: string, file: Blob, contentType: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`/api/v1${path}`, {
        method: 'PUT',
        headers: { 'content-type': contentType, ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...(this.replay ? { 'x-console-mode': 'replay' } : {}) },
        body: file,
      });
    } catch {
      throw new ApiError(0, 'network', 'Cannot reach the server. Check the connection.');
    }
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as ApiErrorBody;
      throw new ApiError(res.status, b.code ?? 'error', b.error ?? `Upload failed (${res.status}).`);
    }
    return res.json() as Promise<T>;
  }

  async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await this.raw(method, path, body)).json() as Promise<T>;
  }

  get = <T,>(p: string) => this.json<T>('GET', p);
  post = <T,>(p: string, b: unknown = {}) => this.json<T>('POST', p, b);
  patch = <T,>(p: string, b: unknown) => this.json<T>('PATCH', p, b);
  put = <T,>(p: string, b: unknown) => this.json<T>('PUT', p, b);
  del = <T,>(p: string) => this.json<T>('DELETE', p);

  async blob(path: string) {
    return (await this.raw('GET', path)).blob();
  }
}

/** Save a blob as a file (works when the app is served by the platform). */
export function saveBlob(blob: Blob, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

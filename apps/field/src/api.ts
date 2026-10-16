// Thin client for /api/v1.
export class ApiFailure extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    /** True when the request never reached the server (offline, DNS, reset). */
    public network = false,
  ) {
    super(message);
  }
}

export async function api<T>(token: string | null, method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiFailure(0, 'network', 'No connection', true);
  }
  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* plain text */
  }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; code?: string };
    throw new ApiFailure(res.status, d.code ?? 'error', d.error ?? `HTTP ${res.status}`);
  }
  return data as T;
}

export function newKey(prefix: string) {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `field-${prefix}-${rnd}`;
}

export const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): boolean {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  },
  del(key: string) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

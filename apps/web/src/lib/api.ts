import type { Session } from "@apisfactory/shared";

const BASE = import.meta.env.VITE_API_URL ?? "";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

type Stored = { session: Session | null; companyId: string | null };
const KEY = "apisfactory.session";

function load(): Stored {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? "") as Stored;
  } catch {
    return { session: null, companyId: null };
  }
}

let state: Stored = load();
const listeners = new Set<() => void>();

export const auth = {
  get: () => state,
  set(next: Partial<Stored>) {
    state = { ...state, ...next };
    try {
      sessionStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* oturum yalnızca bellekte kalır */
    }
    listeners.forEach((l) => l());
  },
  clear() {
    state = { session: null, companyId: null };
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      /* yoksay */
    }
    listeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export async function api<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const { session, companyId } = auth.get();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(session ? { authorization: `Bearer ${session.token}` } : {}),
      ...(companyId ? { "x-company-id": companyId } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).catch(() => {
    throw new ApiError(0, "offline", "Sunucuya ulaşılamıyor. Bağlantınızı kontrol edin.");
  });
  if (res.status === 401 && session) auth.clear();
  const text = await res.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!res.ok) {
    const e = (data as any)?.error;
    throw new ApiError(res.status, e?.code ?? "error", e?.message ?? `HTTP ${res.status}`, e?.details);
  }
  return data as T;
}

export const get = <T = any>(p: string) => api<T>("GET", p);
export const post = <T = any>(p: string, b?: unknown, h?: Record<string, string>) => api<T>("POST", p, b ?? {}, h);

export function newKey(): string {
  return crypto.randomUUID();
}

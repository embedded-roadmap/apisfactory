import * as SecureStore from "expo-secure-store";
import Constants from "expo-constants";
import type { Session } from "@apisfactory/shared";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

type State = { apiUrl: string; session: Session | null; companyId: string | null };

const KEY = "apisfactory.mobile";
const defaultUrl =
  process.env.EXPO_PUBLIC_API_URL ?? ((Constants.expoConfig?.extra as { defaultApiUrl?: string } | undefined)?.defaultApiUrl ?? "http://localhost:4000");

let state: State = { apiUrl: defaultUrl, session: null, companyId: null };
const listeners = new Set<() => void>();

/** Oturum belirteci cihazda güvenli depoda saklanır (şifreli anahtar zinciri / keystore). */
export const store = {
  get: () => state,
  async load() {
    try {
      const raw = await SecureStore.getItemAsync(KEY);
      if (raw) state = { ...state, ...(JSON.parse(raw) as Partial<State>) };
    } catch {
      /* ilk açılış */
    }
    listeners.forEach((l) => l());
  },
  async set(next: Partial<State>) {
    state = { ...state, ...next };
    await SecureStore.setItemAsync(KEY, JSON.stringify(state)).catch(() => {});
    listeners.forEach((l) => l());
  },
  async logout() {
    state = { ...state, session: null, companyId: null };
    await SecureStore.setItemAsync(KEY, JSON.stringify(state)).catch(() => {});
    listeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};

export async function api<T = any>(method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const { apiUrl, session, companyId } = state;
  let res: Response;
  try {
    res = await fetch(`${apiUrl}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(session ? { authorization: `Bearer ${session.token}` } : {}),
        ...(companyId ? { "x-company-id": companyId } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    // Çevrimdışı iken işlem kuyruğa alınmaz; kullanıcıya açıkça söylenir (çevrimdışı kuyruk sonraki faz).
    throw new ApiError(0, "offline", "Sunucuya ulaşılamıyor. Bağlantı gelince tekrar deneyin; işlem kaydedilmedi.");
  }
  if (res.status === 401 && session) await store.logout();
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? "error", res.status === 403 ? "Bu işlem için yetkiniz yok." : data?.error?.message ?? `HTTP ${res.status}`);
  return data as T;
}

export function newKey(): string {
  // Idempotency-Key: aynı formun tekrar gönderimi çift kayıt oluşturmaz.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

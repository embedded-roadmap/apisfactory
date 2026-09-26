import type { Session } from "@apisfactory/shared";

export const BASE = import.meta.env.VITE_API_URL ?? "";

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

/**
 * Yetki başlıkları gerektiren bir indirme ucundan (ör. ek/dosya) içerik açar. Düz `<a href>` bu
 * uçlara Authorization başlığı taşımadığı için çalışmaz — blob olarak indirip yeni sekmede açar
 * (görsel/PDF/video) ya da indirir (diğer türler).
 */
export async function openDownload(path: string, fileName: string, contentType: string) {
  const { session, companyId } = auth.get();
  const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${session?.token}`, "x-company-id": companyId ?? "" } });
  if (!res.ok) return;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  if (contentType.startsWith("image/") || contentType === "application/pdf" || contentType.startsWith("video/")) window.open(url, "_blank");
  else {
    const a = document.createElement("a");
    a.href = url; a.download = fileName; a.click();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export type StagedVideo = { stagedUploadId: string; fileName: string; contentType: string; sizeBytes: number; durationSeconds: number; codec: string | null };

/**
 * Video, JSON gövdeye base64 olarak sığmaz (200 MB'a kadar) — ayrı bir ham-ikili uca gider
 * (W27, oturum 37). XHR kullanılır ki tarayıcı yükleme ilerlemesini bildirebilsin (devam
 * talimatı §2: "yükleme ilerlemesi" gerekliliği). Gerçek süre/tür doğrulaması sunucuda yapılır;
 * burada yalnızca aktarım yapılır.
 */
export function stageVideo(file: File, onProgress?: (pct: number) => void): Promise<StagedVideo> {
  const { session, companyId } = auth.get();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${BASE}/api/attachments/video/stage`);
    if (session) xhr.setRequestHeader("authorization", `Bearer ${session.token}`);
    if (companyId) xhr.setRequestHeader("x-company-id", companyId);
    xhr.setRequestHeader("content-type", file.type);
    xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    if (onProgress) xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => {
      let data: any = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* boş/metin yanıt */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as StagedVideo);
      else reject(new ApiError(xhr.status, data?.error?.code ?? "error", data?.error?.message ?? `HTTP ${xhr.status}`, data?.error?.details));
    };
    xhr.onerror = () => reject(new ApiError(0, "offline", "Sunucuya ulaşılamıyor. Bağlantınızı kontrol edin."));
    xhr.send(file);
  });
}

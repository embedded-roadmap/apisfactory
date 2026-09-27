/**
 * Takvim sağlayıcıları (dış bağımlılık maddesi 5): Google Calendar API v3 ve Microsoft Graph v1.0.
 * OAuth istemcisi platform düzeyindedir (ortam değişkenleri); her kullanıcı kendi hesabını yetkilendirir.
 * Tüm HTTP çağrıları `calendarDeps.fetch` üzerinden yapılır (testlerde sahte yanıtlarla değiştirilir).
 * Uç noktalar sağlayıcıların belgelenmiş API'lerine göre yazıldı; gerçek hesapla doğrulama OAuth uygulama kaydını bekler.
 */

export type CalendarProviderKey = "google" | "microsoft";
export type Tokens = { accessToken: string; refreshToken: string; expiresAt: number };
export type EventInput = { title: string; description: string; location: string | null; startsAt: string; durationMinutes: number; attendees: { email: string; name: string }[] };
export type RemoteChange = { externalId: string; deleted: boolean; title?: string; startsAt?: string; durationMinutes?: number };

export class CalendarError extends Error {
  constructor(public readonly status: number, message: string, public readonly kind: "auth" | "gone" | "other" = "other") {
    super(message);
  }
}

export const calendarDeps: { fetch: typeof fetch } = { fetch: (...a) => fetch(...a) };

export interface CalendarProvider {
  configured(): boolean;
  authorizeUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<Tokens & { email: string | null }>;
  refresh(refreshToken: string): Promise<Tokens>;
  createEvent(token: string, e: EventInput): Promise<string>;
  updateEvent(token: string, id: string, e: EventInput): Promise<void>;
  cancelEvent(token: string, id: string, reason: string): Promise<void>;
  /** Artımlı değişiklikler. cursor null ise ilk senkron (yeni imleç alınır). 'gone' → imleç geçersiz, sıfırlanmalı. */
  pullChanges(token: string, cursor: string | null): Promise<{ changes: RemoteChange[]; cursor: string }>;
}

async function http(url: string, init: RequestInit & { form?: Record<string, string> } = {}): Promise<any> {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.form) {
    headers.set("content-type", "application/x-www-form-urlencoded");
    body = new URLSearchParams(init.form).toString();
  }
  const res = await calendarDeps.fetch(url, { ...init, headers, body });
  const text = await res.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!res.ok) {
    // Yanıt gövdesi (token, e-posta içerebilir) hata mesajına konmaz; yalnız durum kodu.
    throw new CalendarError(res.status, `Takvim sağlayıcısı hatası (${res.status})`, res.status === 401 || res.status === 400 && /invalid_grant/.test(text) ? "auth" : res.status === 410 ? "gone" : "other");
  }
  return data;
}

const endOf = (startsAt: string, min: number) => new Date(new Date(startsAt).getTime() + min * 60_000).toISOString();
const minutesBetween = (a: string, b: string) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60_000);
const tokensFrom = (j: any, prevRefresh?: string): Tokens => ({
  accessToken: j.access_token,
  refreshToken: j.refresh_token ?? prevRefresh ?? "",
  expiresAt: Date.now() + Number(j.expires_in ?? 3600) * 1000,
});
function jwtEmail(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    return JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")).email ?? null;
  } catch {
    return null;
  }
}

// ---- Google Calendar API v3 --------------------------------------------------------------------------------------
const G_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const G_TOKEN = "https://oauth2.googleapis.com/token";
const G_EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

const google: CalendarProvider = {
  configured: () => Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET),
  authorizeUrl(state, redirectUri) {
    const q = new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID ?? "",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email https://www.googleapis.com/auth/calendar.events",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    });
    return `${G_AUTH}?${q}`;
  },
  async exchangeCode(code, redirectUri) {
    const j = await http(G_TOKEN, { method: "POST", form: { code, client_id: process.env.GOOGLE_OAUTH_CLIENT_ID ?? "", client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "", redirect_uri: redirectUri, grant_type: "authorization_code" } });
    if (!j.refresh_token) throw new CalendarError(400, "Google yenileme belirteci vermedi (onay ekranı tekrar gösterilmeli)", "auth");
    return { ...tokensFrom(j), email: jwtEmail(j.id_token) };
  },
  async refresh(refreshToken) {
    const j = await http(G_TOKEN, { method: "POST", form: { refresh_token: refreshToken, client_id: process.env.GOOGLE_OAUTH_CLIENT_ID ?? "", client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "", grant_type: "refresh_token" } });
    return tokensFrom(j, refreshToken);
  },
  async createEvent(token, e) {
    const j = await http(`${G_EVENTS}?sendUpdates=all`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(googleBody(e)) });
    return j.id as string;
  },
  async updateEvent(token, id, e) {
    await http(`${G_EVENTS}/${encodeURIComponent(id)}?sendUpdates=all`, { method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(googleBody(e)) });
  },
  async cancelEvent(token, id) {
    await http(`${G_EVENTS}/${encodeURIComponent(id)}?sendUpdates=all`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
  },
  async pullChanges(token, cursor) {
    const changes: RemoteChange[] = [];
    let pageToken: string | undefined;
    for (;;) {
      const q = new URLSearchParams({ showDeleted: "true", maxResults: "250" });
      if (cursor) q.set("syncToken", cursor);
      else q.set("timeMin", new Date(Date.now() - 30 * 864e5).toISOString()); // ilk senkron: yakın geçmiş + gelecek
      if (pageToken) q.set("pageToken", pageToken);
      const j = await http(`${G_EVENTS}?${q}`, { headers: { authorization: `Bearer ${token}` } });
      for (const it of j.items ?? []) {
        if (it.status === "cancelled") changes.push({ externalId: it.id, deleted: true });
        else if (it.start?.dateTime && it.end?.dateTime) {
          changes.push({ externalId: it.id, deleted: false, title: it.summary, startsAt: new Date(it.start.dateTime).toISOString(), durationMinutes: minutesBetween(it.start.dateTime, it.end.dateTime) });
        }
      }
      if (j.nextPageToken) { pageToken = j.nextPageToken; continue; }
      return { changes, cursor: j.nextSyncToken ?? cursor ?? "" };
    }
  },
};

function googleBody(e: EventInput) {
  return {
    summary: e.title,
    description: e.description,
    location: e.location ?? undefined,
    start: { dateTime: e.startsAt },
    end: { dateTime: endOf(e.startsAt, e.durationMinutes) },
    attendees: e.attendees.map((a) => ({ email: a.email, displayName: a.name })),
  };
}

// ---- Microsoft Graph v1.0 ---------------------------------------------------------------------------------------
const MS_TENANT = () => process.env.MS_OAUTH_TENANT || "common";
const MS_SCOPES = "offline_access openid email User.Read Calendars.ReadWrite";
const GRAPH = "https://graph.microsoft.com/v1.0";
const UTC = { Prefer: 'outlook.timezone="UTC"' };
const msDate = (iso: string) => ({ dateTime: new Date(iso).toISOString().replace("Z", ""), timeZone: "UTC" });
const fromMsDate = (d: { dateTime: string }) => new Date(`${d.dateTime.replace(/Z$/, "")}Z`).toISOString();

const microsoft: CalendarProvider = {
  configured: () => Boolean(process.env.MS_OAUTH_CLIENT_ID && process.env.MS_OAUTH_CLIENT_SECRET),
  authorizeUrl(state, redirectUri) {
    const q = new URLSearchParams({ client_id: process.env.MS_OAUTH_CLIENT_ID ?? "", response_type: "code", redirect_uri: redirectUri, response_mode: "query", scope: MS_SCOPES, state });
    return `https://login.microsoftonline.com/${MS_TENANT()}/oauth2/v2.0/authorize?${q}`;
  },
  async exchangeCode(code, redirectUri) {
    const j = await http(`https://login.microsoftonline.com/${MS_TENANT()}/oauth2/v2.0/token`, {
      method: "POST",
      form: { client_id: process.env.MS_OAUTH_CLIENT_ID ?? "", client_secret: process.env.MS_OAUTH_CLIENT_SECRET ?? "", code, redirect_uri: redirectUri, grant_type: "authorization_code", scope: MS_SCOPES },
    });
    if (!j.refresh_token) throw new CalendarError(400, "Microsoft yenileme belirteci vermedi (offline_access izni gerekli)", "auth");
    const me = await http(`${GRAPH}/me`, { headers: { authorization: `Bearer ${j.access_token}` } });
    return { ...tokensFrom(j), email: me?.mail ?? me?.userPrincipalName ?? null };
  },
  async refresh(refreshToken) {
    const j = await http(`https://login.microsoftonline.com/${MS_TENANT()}/oauth2/v2.0/token`, {
      method: "POST",
      form: { client_id: process.env.MS_OAUTH_CLIENT_ID ?? "", client_secret: process.env.MS_OAUTH_CLIENT_SECRET ?? "", refresh_token: refreshToken, grant_type: "refresh_token", scope: MS_SCOPES },
    });
    return tokensFrom(j, refreshToken);
  },
  async createEvent(token, e) {
    const j = await http(`${GRAPH}/me/events`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(msBody(e)) });
    return j.id as string;
  },
  async updateEvent(token, id, e) {
    await http(`${GRAPH}/me/events/${encodeURIComponent(id)}`, { method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(msBody(e)) });
  },
  async cancelEvent(token, id, reason) {
    // Düzenleyen olarak iptal: katılımcılara iptal bildirimi gider.
    await http(`${GRAPH}/me/events/${encodeURIComponent(id)}/cancel`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ comment: reason }) });
  },
  async pullChanges(token, cursor) {
    const changes: RemoteChange[] = [];
    let url = cursor ?? `${GRAPH}/me/calendarView/delta?${new URLSearchParams({ startDateTime: new Date(Date.now() - 30 * 864e5).toISOString(), endDateTime: new Date(Date.now() + 365 * 864e5).toISOString() })}`;
    for (;;) {
      const j = await http(url, { headers: { authorization: `Bearer ${token}`, ...UTC } });
      for (const it of j.value ?? []) {
        if (it["@removed"] || it.isCancelled) changes.push({ externalId: it.id, deleted: true });
        else if (it.start?.dateTime && it.end?.dateTime) {
          const s = fromMsDate(it.start);
          changes.push({ externalId: it.id, deleted: false, title: it.subject, startsAt: s, durationMinutes: minutesBetween(s, fromMsDate(it.end)) });
        }
      }
      if (j["@odata.nextLink"]) { url = j["@odata.nextLink"]; continue; }
      return { changes, cursor: j["@odata.deltaLink"] ?? cursor ?? "" };
    }
  },
};

function msBody(e: EventInput) {
  return {
    subject: e.title,
    body: { contentType: "text", content: e.description },
    start: msDate(e.startsAt),
    end: msDate(endOf(e.startsAt, e.durationMinutes)),
    location: e.location ? { displayName: e.location } : undefined,
    attendees: e.attendees.map((a) => ({ emailAddress: { address: a.email, name: a.name }, type: "required" })),
  };
}

export const CALENDAR_PROVIDERS: Record<CalendarProviderKey, CalendarProvider> = { google, microsoft };

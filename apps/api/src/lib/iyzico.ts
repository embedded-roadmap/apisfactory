import { createHmac, randomBytes } from "node:crypto";

/**
 * iyzico Abonelik API istemcisi (dış bağımlılık maddesi 6). Kimlik doğrulama iyzico belgesine göre (IYZWSv2):
 *   imza = hex(HMAC-SHA256(secretKey, randomKey + uriPath + requestBody))
 *   Authorization: "IYZWSv2 " + base64("apiKey:" + apiKey + "&randomKey:" + randomKey + "&signature:" + imza)
 *   x-iyzi-rnd: randomKey
 * Uç noktalar: POST /v2/subscription/checkoutform/initialize, GET /v2/subscription/checkoutform/{token},
 * GET /v2/subscription/subscriptions/{ref}, POST /v2/subscription/subscriptions/{ref}/cancel.
 * HTTP `iyzicoDeps.fetch` üzerinden yapılır (testlerde sahte yanıtlarla değiştirilir).
 */

export const iyzicoDeps: { fetch: typeof fetch } = { fetch: (...a) => fetch(...a) };

export class IyzicoError extends Error {
  constructor(public readonly status: number, message: string, public readonly errorCode?: string) {
    super(message);
  }
}

export function iyzicoConfig() {
  return {
    configured: Boolean(process.env.IYZICO_API_KEY && process.env.IYZICO_SECRET_KEY),
    baseUrl: process.env.IYZICO_BASE_URL || "https://sandbox-api.iyzipay.com",
  };
}

export function iyzicoAuthHeaders(uriPath: string, body: string, randomKey = `${Date.now()}${randomBytes(4).toString("hex")}`) {
  const apiKey = process.env.IYZICO_API_KEY ?? "";
  const secretKey = process.env.IYZICO_SECRET_KEY ?? "";
  const signature = createHmac("sha256", secretKey).update(randomKey + uriPath + body).digest("hex");
  const auth = Buffer.from(`apiKey:${apiKey}&randomKey:${randomKey}&signature:${signature}`, "utf8").toString("base64");
  return { authorization: `IYZWSv2 ${auth}`, "x-iyzi-rnd": randomKey };
}

async function call<T = any>(method: "GET" | "POST", uriPath: string, payload?: unknown): Promise<T> {
  const cfg = iyzicoConfig();
  if (!cfg.configured) throw new IyzicoError(503, "iyzico erişim bilgisi tanımlı değil (IYZICO_API_KEY / IYZICO_SECRET_KEY)");
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const res = await iyzicoDeps.fetch(`${cfg.baseUrl}${uriPath}`, {
    method,
    headers: { ...iyzicoAuthHeaders(uriPath, body), "content-type": "application/json", accept: "application/json" },
    body: method === "POST" ? body : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* gövde JSON değil */
  }
  if (!res.ok || data?.status === "failure") {
    // iyzico hata kodu ve mesajı (kart/kişisel veri içermez) iletilir; ham gövde iletilmez.
    throw new IyzicoError(res.ok ? 502 : res.status, `iyzico hatası${data?.errorMessage ? `: ${data.errorMessage}` : ` (${res.status})`}`, data?.errorCode);
  }
  return data as T;
}

export type CheckoutCustomer = {
  name: string;
  surname: string;
  email: string;
  gsmNumber: string;
  identityNumber: string;
  billingAddress: { contactName: string; city: string; country: string; address: string; zipCode?: string };
};

export async function initializeCheckout(input: { conversationId: string; callbackUrl: string; pricingPlanReferenceCode: string; customer: CheckoutCustomer }) {
  const r = await call<{ token: string; checkoutFormContent: string; tokenExpireTime?: number }>("POST", "/v2/subscription/checkoutform/initialize", {
    locale: "tr",
    conversationId: input.conversationId,
    callbackUrl: input.callbackUrl,
    pricingPlanReferenceCode: input.pricingPlanReferenceCode,
    subscriptionInitialStatus: "ACTIVE",
    customer: { ...input.customer, shippingAddress: input.customer.billingAddress },
  });
  return { token: r.token, formContent: r.checkoutFormContent };
}

export async function retrieveCheckout(token: string) {
  const r = await call<{ data?: { referenceCode?: string; customerReferenceCode?: string; subscriptionStatus?: string } }>("GET", `/v2/subscription/checkoutform/${encodeURIComponent(token)}`);
  return r.data ?? {};
}

export type ProviderOrder = { referenceCode: string; orderStatus: string; price?: number; currencyCode?: string; startPeriod?: number; endPeriod?: number };
export type ProviderSubscription = { referenceCode?: string; subscriptionStatus?: string; customerReferenceCode?: string; orders?: ProviderOrder[] };

export async function getSubscription(ref: string): Promise<ProviderSubscription> {
  const r = await call<{ data?: ProviderSubscription }>("GET", `/v2/subscription/subscriptions/${encodeURIComponent(ref)}`);
  return r.data ?? {};
}

export async function cancelSubscription(ref: string) {
  await call("POST", `/v2/subscription/subscriptions/${encodeURIComponent(ref)}/cancel`, {});
}

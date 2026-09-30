/**
 * Oturum 41 devamı — dış bağımlılık 2b: MNG Kargo adaptörü (DOĞRULANMADI — gerçek hesap yok).
 * Sahte fetch ile MNG'nin resmi Swagger tanımlarındaki akış sınanır: token → CBS il/ilçe → createOrder → createbarcode,
 * takipte getshipmentstatusByShipmentId. Yanıt örnekleri Swagger'daki örneklerden alınmıştır.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cargoDeps, fold, mngDate, resetCargoAdapterCaches } from "../src/lib/cargo-adapters";
import { CARGO_PROVIDERS, type CargoShipmentRequest } from "../src/lib/cargo-providers";
import { ConnectorError } from "../src/lib/connector-credentials";

type Req = { method: string; url: string; path: string; headers: Headers; body: string };
let log: Req[] = [];
let routes: ((r: Req) => { status?: number; json?: unknown } | undefined)[] = [];
const realFetch = cargoDeps.fetch;
const M = CARGO_PROVIDERS.mng!;
const CREDS = { clientId: "app-id", clientSecret: "app-SECRET", customerNumber: "123456", password: "cust-SECRET" };
const SETTINGS = { shipmentServiceType: "1", packagingType: "4", paymentType: "1", desiPerPackage: "3" };

const req = (over: Partial<CargoShipmentRequest> = {}): CargoShipmentRequest => ({
  shipmentCode: "shp-000123",
  sender: { name: "Şirket A", phone: "02120000000", line1: "Sanayi Cad. 1", line2: null, district: "Kadıköy", city: "İstanbul", postalCode: null, country: "TR", taxNo: "1234567890" },
  recipient: { name: "Ayşe Alıcı", phone: "05550000000", line1: "Liman Yolu No:9", line2: "Kat 2", district: "ÇANKAYA", city: "ankara", postalCode: null, country: "TR" },
  packages: [{ code: "PK-1", weightKg: "2.300" }, { code: "PK-2", weightKg: "0.400" }],
  totalWeightKg: "2.700",
  ...over,
});

function mngHappy(opts: { barcode?: string } = {}) {
  routes = [
    (r) => (r.path === "/mngapi/api/token" ? { json: { jwt: "jwt-1", refreshToken: "r", jwtExpireDate: "10.03.2099 16:05:00", refreshTokenExpireDate: "09.04.2099 15:04:31" } } : undefined),
    (r) => (r.path === "/mngapi/api/cbsinfoapi/getcities" ? { json: [{ code: "01", name: "Adana" }, { code: "06", name: "Ankara" }] } : undefined),
    (r) => (r.path === "/mngapi/api/cbsinfoapi/getdistricts/06" ? { json: [{ cityCode: "06", cityName: "Ankara", code: "15", name: "Çankaya" }] } : undefined),
    (r) => (r.path === "/mngapi/api/standardcmdapi/createOrder" ? { json: { orderInvoiceId: "456764543", orderInvoiceDetailId: "25423565", shipperBranchCode: "1345", referenceId: "SHP-000123" } } : undefined),
    (r) => (r.path === "/mngapi/api/barcodecmdapi/createbarcode" ? { json: { referenceId: "SHP-000123", invoiceId: "564645774", shipmentId: "4536457657", barcodes: [{ pieceNumber: 1, value: opts.barcode ?? "Barcode1" }, { pieceNumber: 2, value: "Barcode2" }] } } : undefined),
  ];
}

beforeEach(() => {
  log = [];
  routes = [];
  resetCargoAdapterCaches();
  cargoDeps.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const r: Req = { method: init?.method ?? "GET", url: String(input), path: u.pathname, headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : "" };
    log.push(r);
    for (const fn of routes) {
      const out = fn(r);
      if (out) return new Response(out.json === undefined ? "" : JSON.stringify(out.json), { status: out.status ?? 200 });
    }
    return new Response("{}", { status: 599 });
  }) as typeof fetch;
});
afterEach(() => {
  cargoDeps.fetch = realFetch;
});

describe("Yardımcılar", () => {
  it("Türkçe sadeleştirme ve MNG tarih biçimleri (GMT+3)", () => {
    expect(fold("ÇANKAYA")).toBe(fold("Çankaya"));
    expect(fold("İstanbul")).toBe("istanbul");
    expect(mngDate("13-02-2019 12:03")).toBe("2019-02-13T09:03:00.000Z");
    expect(mngDate("10.03.2020 16:05:00")).toBe("2020-03-10T13:05:00.000Z");
    expect(mngDate("dün")).toBeNull();
  });
});

describe("MNG Kargo adaptörü", () => {
  it("kayıt defterinde, DOĞRULANMADI; erişim ve ayar alanları", () => {
    expect(M).toMatchObject({ verified: false, credentialFields: ["clientId", "clientSecret", "customerNumber", "password"] });
    expect(M.settingFields.filter((f) => f.required).map((f) => f.key)).toEqual(["shipmentServiceType", "packagingType", "paymentType", "desiPerPackage"]);
    expect(typeof M.track).toBe("function");
  });

  it("gönderi: token → il/ilçe kodu → createOrder → createbarcode; gövdeler resmi şemaya uygun", async () => {
    mngHappy();
    const out = await M.createShipment(req(), { credentials: CREDS, settings: SETTINGS, environment: "sandbox" });
    expect(out).toEqual({ trackingNo: "4536457657", labelRef: "Barcode1", label: undefined });
    expect(log.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /mngapi/api/token", "GET /mngapi/api/cbsinfoapi/getcities", "GET /mngapi/api/cbsinfoapi/getdistricts/06",
      "POST /mngapi/api/standardcmdapi/createOrder", "POST /mngapi/api/barcodecmdapi/createbarcode",
    ]);
    expect(log.every((r) => r.url.startsWith("https://testapi.mngkargo.com.tr/"))).toBe(true);
    expect(log.every((r) => r.headers.get("x-ibm-client-id") === "app-id" && r.headers.get("x-ibm-client-secret") === "app-SECRET")).toBe(true);
    expect(JSON.parse(log[0]!.body)).toEqual({ customerNumber: "123456", password: "cust-SECRET", identityType: 1 });
    expect(log[3]!.headers.get("authorization")).toBe("Bearer jwt-1");
    const order = JSON.parse(log[3]!.body);
    expect(order.order).toMatchObject({ referenceId: "SHP-000123", barcode: "SHP-000123", shipmentServiceType: 1, packagingType: 4, paymentType: 1, deliveryType: 1, isCOD: 0, smsPreference1: 0 });
    expect(order.orderPieceList).toEqual([
      { barcode: "SHP-000123-1", desi: 3, kg: 3, content: "PK-1" },
      { barcode: "SHP-000123-2", desi: 3, kg: 1, content: "PK-2" },
    ]);
    expect(order.recipient).toEqual({ fullName: "Ayşe Alıcı", cityCode: 6, districtCode: 15, address: "Liman Yolu No:9 Kat 2", mobilePhoneNumber: "05550000000" });
    expect(JSON.parse(log[4]!.body)).toEqual({ referenceId: "SHP-000123" });
  });

  it("barkod değeri ZPL ise etiket dosyası olarak döner; üretimde resmi adres kullanılır", async () => {
    mngHappy({ barcode: "^XA^FO50,50^BCN,100^FD4536457657^FS^XZ" });
    const out = await M.createShipment(req(), { credentials: CREDS, settings: SETTINGS, environment: "production" });
    expect(out.label?.contentType).toBe("application/zpl");
    expect(out.label?.data.toString()).toContain("^XA");
    expect(out.labelRef).toBe("MNG-4536457657");
    expect(log.every((r) => r.url.startsWith("https://api.mngkargo.com.tr/"))).toBe(true);
  });

  it("eksik ilçe/ağırlık, geçersiz desi ve yabancı test adresi: istek atılmadan kesin ret", async () => {
    const ctx = { credentials: CREDS, settings: SETTINGS, environment: "sandbox" as const };
    const notSent = async (p: Promise<unknown>, msg: RegExp) => {
      const e = await p.catch((x) => x);
      expect(e).toBeInstanceOf(ConnectorError);
      expect((e as ConnectorError).opts.notSent).toBe(true);
      expect((e as Error).message).toMatch(msg);
    };
    await notSent(M.createShipment(req({ recipient: { ...req().recipient, district: null } }), ctx), /ilçe/);
    await notSent(M.createShipment(req({ packages: [{ code: "PK-1", weightKg: null }] }), ctx), /PK-1/);
    await notSent(M.createShipment(req(), { ...ctx, settings: { ...SETTINGS, desiPerPackage: "0" } }), /desi/);
    await notSent(M.createShipment(req(), { ...ctx, settings: { ...SETTINGS, testApiHost: "evil.example.com" } }), /mngkargo/);
    expect(log).toHaveLength(0);
  });

  it("bilinmeyen il → kesin ret; sipariş reddi → kesin ret; gönderiye çevirme hatası → belirsiz (düz Error, referanslı)", async () => {
    mngHappy();
    const ctx = { credentials: CREDS, settings: SETTINGS, environment: "sandbox" as const };
    const e1 = await M.createShipment(req({ recipient: { ...req().recipient, city: "Atlantis" } }), ctx).catch((x) => x);
    expect((e1 as ConnectorError).opts.notSent).toBe(true);

    routes.splice(3, 1, (r) => (r.path.endsWith("/createOrder") ? { status: 400, json: { error: { Description: "ReferenceId daha önce kullanılmış" } } } : undefined));
    const e2 = await M.createShipment(req(), ctx).catch((x) => x);
    expect((e2 as ConnectorError).opts.notSent).toBe(true);
    expect((e2 as Error).message).toBe("MNG sipariş: HTTP 400: ReferenceId daha önce kullanılmış");

    mngHappy();
    routes.splice(4, 1, (r) => (r.path.endsWith("/createbarcode") ? { status: 500, json: {} } : undefined));
    const e3 = await M.createShipment(req(), ctx).catch((x) => x);
    expect(e3).not.toBeInstanceOf(ConnectorError);
    expect((e3 as Error).message).toMatch(/SHP-000123 açıldı ama gönderiye çevrilemedi/);
  });

  it("oturum reddi kesin ret; hata mesajında şifre yok; jeton önbellekte", async () => {
    routes = [() => ({ status: 401, json: { message: "invalid cust-SECRET" } })];
    const e = await M.createShipment(req(), { credentials: CREDS, settings: SETTINGS, environment: "sandbox" }).catch((x) => x);
    expect((e as ConnectorError).opts.notSent).toBe(true);
    expect((e as Error).message).not.toContain("SECRET");
    mngHappy();
    log = [];
    await M.createShipment(req(), { credentials: CREDS, settings: SETTINGS, environment: "sandbox" });
    await M.createShipment(req(), { credentials: CREDS, settings: SETTINGS, environment: "sandbox" });
    expect(log.filter((r) => r.path === "/mngapi/api/token")).toHaveLength(1);
    expect(log.filter((r) => r.path.endsWith("/getcities"))).toHaveLength(1);
  });

  it("takip: durum kodu ortak duruma eşlenir, ham metin ve tarih saklanır", async () => {
    mngHappy();
    routes.push((r) => (r.path === "/mngapi/api/standardqueryapi/getshipmentstatusByShipmentId/4536457657"
      ? { json: { shipmentStatusCode: 5, orderId: "5464767", referenceId: "SHP-000123", shipmentId: "4536457657", shipmentStatus: "Teslim_Edildi", statusDateTime: "13-02-2019 12:03", isDelivered: 1 } }
      : undefined));
    const t = await M.track!("4536457657", { credentials: CREDS, settings: SETTINGS, environment: "sandbox" });
    expect(t).toEqual({ status: "delivered", raw: "Teslim_Edildi", at: "2019-02-13T09:03:00.000Z" });
  });
});

describe("Basit Kargo adaptörü (toplayıcı)", () => {
  const BK = CARGO_PROVIDERS.basitkargo!;
  const BKS = { handlerCode: "SELF_ARAS", packageHeightCm: "20", packageWidthCm: "30", packageDepthCm: "15" };
  const ctx = (settings: Record<string, string> = BKS) => ({ credentials: { apiToken: "bk-SECRET" }, settings, environment: "production" as const });
  const happyBk = () => {
    routes = [
      (r) => (r.method === "POST" && r.path === "/api/v2/order" ? { json: { id: "888-6AR-OUP", barcode: null, type: "OUTGOING", status: "NEW", validationFailed: false } } : undefined),
      (r) => (r.path === "/api/v2/order/888-6AR-OUP/barcode"
        ? { json: { id: "888-6AR-OUP", barcode: "1234567890", type: "OUTGOING", status: "READY_TO_SHIP", shipmentInfo: { handler: { name: "Aras Kargo - KA", code: "SELF_ARAS" }, handlerShipmentCode: null } } }
        : undefined),
    ];
  };

  it("kayıt defterinde, DOĞRULANMADI; firma seçimi seçenekli ayar", () => {
    expect(BK).toMatchObject({ verified: false, credentialFields: ["apiToken"], docsUrl: "https://basitkargo.com/api" });
    expect(BK.settingFields.find((f) => f.key === "handlerCode")!.options).toEqual(expect.arrayContaining(["ARAS", "SELF_ARAS", "ECONOMIC"]));
  });

  it("taslak sipariş → kargo kodu; gövdeler belgeye uygun; telefon 10 haneye indirgenir", async () => {
    happyBk();
    const out = await BK.createShipment(req({ recipient: { ...req().recipient, phone: "+90 (555) 000 00 00" } }), ctx());
    expect(out).toEqual({ trackingNo: "1234567890", labelRef: "BK-888-6AR-OUP" });
    expect(log.map((r) => `${r.method} ${r.url}`)).toEqual(["POST https://basitkargo.com/api/v2/order", "POST https://basitkargo.com/api/v2/order/888-6AR-OUP/barcode"]);
    expect(log[0]!.headers.get("authorization")).toBe("Bearer bk-SECRET");
    expect(JSON.parse(log[0]!.body)).toEqual({
      type: "OUTGOING",
      content: { name: "Sevkiyat shp-000123", code: "shp-000123", packages: [{ height: 20, width: 30, depth: 15, weight: 2.3 }, { height: 20, width: 30, depth: 15, weight: 0.4 }] },
      client: { name: "Ayşe Alıcı", phone: "5550000000", city: "ankara", town: "ÇANKAYA", address: "Liman Yolu No:9 Kat 2" },
    });
    expect(JSON.parse(log[1]!.body)).toEqual({ handlerCode: "SELF_ARAS" });
  });

  it("geçersiz telefon/ölçü/firma: istek atılmadan kesin ret; kod reddi kesin, 5xx belirsiz", async () => {
    const notSent = async (p: Promise<unknown>, msg: RegExp) => {
      const e = await p.catch((x) => x);
      expect((e as ConnectorError).opts?.notSent).toBe(true);
      expect((e as Error).message).toMatch(msg);
    };
    await notSent(BK.createShipment(req({ recipient: { ...req().recipient, phone: "12345" } }), ctx()), /10 haneli/);
    await notSent(BK.createShipment(req(), ctx({ ...BKS, packageDepthCm: "0" })), /derinlik/);
    await notSent(BK.createShipment(req(), ctx({ ...BKS, handlerCode: "DHL" })), /firması/);
    expect(log).toHaveLength(0);

    happyBk();
    routes.splice(1, 1, (r) => (r.path.endsWith("/barcode") ? { status: 400, json: { message: "Yetersiz bakiye" } } : undefined));
    await notSent(BK.createShipment(req(), ctx()), /Yetersiz bakiye.*888-6AR-OUP/);
    happyBk();
    routes.splice(1, 1, (r) => (r.path.endsWith("/barcode") ? { status: 502, json: {} } : undefined));
    const e = await BK.createShipment(req(), ctx()).catch((x) => x);
    expect(e).not.toBeInstanceOf(ConnectorError);
    expect((e as Error).message).toMatch(/888-6AR-OUP/);
    expect((e as Error).message).not.toContain("SECRET");
  });

  it("takip: barkodla sorgu, durum eşlemesi", async () => {
    routes = [(r) => (r.path === "/api/v2/order/barcode/1234567890" ? { json: { id: "888-6AR-OUP", barcode: "1234567890", status: "OUT_FOR_DELIVERY" } } : undefined)];
    expect(await BK.track!("1234567890", ctx())).toEqual({ status: "out_for_delivery", raw: "OUT_FOR_DELIVERY", at: null });
  });
});

describe("Yurtiçi Kargo adaptörü (SOAP, resmi WSDL)", () => {
  const YK = CARGO_PROVIDERS.yurtici!;
  const ctx = (settings: Record<string, string> = {}, environment: "sandbox" | "production" = "production") => ({ credentials: { wsUserName: "YKUSER", wsPassword: "yk-SECRET" }, settings, environment });
  const env = (inner: string) => `<?xml version="1.0"?><env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"><env:Body>${inner}</env:Body></env:Envelope>`;
  const created = env(`<ns2:createShipmentResponse xmlns:ns2="http://yurticikargo.com.tr/ShippingOrderDispatcherServices"><ShippingOrderResultVO><outFlag>0</outFlag><outResult>Başarılı</outResult><count>1</count><jobId>123</jobId><shippingOrderDetailVO><cargoKey>SHP-000123</cargoKey><errCode>0</errCode><invoiceKey>SHP-000123</invoiceKey></shippingOrderDetailVO></ShippingOrderResultVO></ns2:createShipmentResponse>`);

  it("kayıt defterinde, DOĞRULANMADI, belge = resmi WSDL", () => {
    expect(YK).toMatchObject({ verified: false, credentialFields: ["wsUserName", "wsPassword"] });
    expect(YK.docsUrl).toMatch(/^https:\/\/ws\.yurticikargo\.com\/.*\?wsdl$/);
  });

  it("createShipment zarfı WSDL şemasına uygun; özel karakterler kaçışlı; takip no = kargo anahtarı", async () => {
    routes = [() => ({ json: undefined })];
    cargoDeps.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      log.push({ method: init?.method ?? "GET", url: String(input), path: new URL(String(input)).pathname, headers: new Headers(init?.headers), body: String(init?.body ?? "") });
      return new Response(created, { status: 200 });
    }) as typeof fetch;
    const out = await YK.createShipment(req({ recipient: { ...req().recipient, name: "Ayşe & Ali <Ltd>" } }), ctx({ desiPerPackage: "2" }));
    expect(out).toEqual({ trackingNo: "SHP-000123", labelRef: "YK-SHP-000123" });
    expect(log[0]!.url).toBe("https://ws.yurticikargo.com/KOPSWebServices/ShippingOrderDispatcherServices");
    expect(log[0]!.headers.get("content-type")).toBe("text/xml; charset=utf-8");
    const b = log[0]!.body;
    expect(b).toContain('<ns:createShipment xmlns:ns="http://yurticikargo.com.tr/ShippingOrderDispatcherServices">');
    expect(b).toContain("<wsUserName>YKUSER</wsUserName><wsPassword>yk-SECRET</wsPassword><userLanguage>TR</userLanguage>");
    for (const f of ["<cargoKey>SHP-000123</cargoKey>", "<invoiceKey>SHP-000123</invoiceKey>", "<receiverCustName>Ayşe &amp; Ali &lt;Ltd&gt;</receiverCustName>",
      "<cityName>ankara</cityName>", "<townName>ÇANKAYA</townName>", "<receiverPhone1>5550000000</receiverPhone1>", "<desi>4</desi>", "<kg>2.7</kg>", "<cargoCount>2</cargoCount>", "<taxOfficeId>0</taxOfficeId>"]) expect(b).toContain(f);
  });

  it("test ortamı adresi; outFlag/errCode ve SOAP hatası kesin ret (sır sızmaz); 5xx belirsiz", async () => {
    let reply = env(`<ShippingOrderResultVO><outFlag>1</outFlag><outResult>Hata</outResult><shippingOrderDetailVO><cargoKey>SHP-000123</cargoKey><errCode>60020</errCode><errMessage>Kargo anahtarı daha önce kullanılmış</errMessage></shippingOrderDetailVO></ShippingOrderResultVO>`);
    let status = 200;
    cargoDeps.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      log.push({ method: "POST", url: String(input), path: "", headers: new Headers(init?.headers), body: String(init?.body ?? "") });
      return new Response(reply, { status });
    }) as typeof fetch;
    const e1 = await YK.createShipment(req(), ctx({}, "sandbox")).catch((x) => x);
    expect(log[0]!.url).toBe("https://testapi.yurticikargo.com:9090/KOPSWebServices/ShippingOrderDispatcherServices");
    expect(e1).toMatchObject({ message: "Yurtiçi gönderi: Kargo anahtarı daha önce kullanılmış", opts: { notSent: true } });
    reply = env(`<env:Fault><faultcode>env:Server</faultcode><faultstring>Kullanıcı adı veya şifre hatalı</faultstring></env:Fault>`);
    status = 500;
    const e2 = await YK.createShipment(req(), ctx()).catch((x) => x);
    expect(e2).toMatchObject({ message: "Yurtiçi gönderi: Kullanıcı adı veya şifre hatalı", opts: { notSent: true } });
    expect((e2 as Error).message).not.toContain("SECRET");
    reply = "<html>Bad gateway</html>";
    status = 502;
    const e3 = await YK.createShipment(req(), ctx()).catch((x) => x);
    expect(e3).not.toBeInstanceOf(ConnectorError);
  });

  it("eksik telefon/ilçe/kısa ad istek atılmadan reddedilir", async () => {
    for (const r of [req({ recipient: { ...req().recipient, phone: null } }), req({ recipient: { ...req().recipient, district: null } }), req({ recipient: { ...req().recipient, name: "Al" } })]) {
      expect(await YK.createShipment(r, ctx()).catch((x) => (x as ConnectorError).opts?.notSent)).toBe(true);
    }
    expect(log).toHaveLength(0);
  });

  it("takip: queryShipment keyType 0; üç harfli durum eşlenir, teslimde tarih (GMT+3)", async () => {
    cargoDeps.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      log.push({ method: "POST", url: String(input), path: "", headers: new Headers(init?.headers), body: String(init?.body ?? "") });
      return new Response(env(`<ns2:queryShipmentResponse><ShippingDeliveryVO><outFlag>0</outFlag><shippingDeliveryDetailVO><cargoKey>SHP-000123</cargoKey><operationCode>5</operationCode><operationMessage>Kargo teslim edilmiştir.</operationMessage><operationStatus>DLV</operationStatus><shippingDeliveryItemDetailVO><deliveryDate>20260930</deliveryDate><deliveryTime>143005</deliveryTime></shippingDeliveryItemDetailVO></shippingDeliveryDetailVO></ShippingDeliveryVO></ns2:queryShipmentResponse>`));
    }) as typeof fetch;
    const t = await YK.track!("SHP-000123", ctx());
    expect(log[0]!.body).toContain("<keys>SHP-000123</keys><keyType>0</keyType>");
    expect(t).toEqual({ status: "delivered", raw: "DLV Kargo teslim edilmiştir.", at: "2026-09-30T11:30:05.000Z" });
  });
});

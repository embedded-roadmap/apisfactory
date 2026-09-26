import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ImportPreview } from "@apisfactory/shared";
import { get, post } from "../lib/api";
import { CsvWizard } from "../components/CsvWizard";
import { PageHeader, StateBadge, fmtDate, useCan } from "../lib/ui";

export function ImportsPage() {
  const can = useCan();
  const qc = useQueryClient();
  const jobs = useQuery({ queryKey: ["imports"], queryFn: () => get<any[]>("/api/imports") });
  return (
    <>
      <PageHeader title="İçe aktarım" sub="Açılış stoğu hareket olarak girer; aynı dosya ikinci kez işlenmez. BOM aktarımı ürün sayfasındadır." />
      {can("inventory.import") ? (
        <section className="card">
          <h2>Açılış stoğu</h2>
          <CsvWizard
            columns={["itemCode", "lotNo", "locationCode", "qty", "rev"]}
            fields={[
              { key: "itemCode", label: "Kalem kodu", required: true, guesses: ["kod", "stok kodu", "item", "code"] },
              { key: "qty", label: "Miktar", required: true, guesses: ["miktar", "qty", "adet", "quantity"] },
              { key: "lotNo", label: "Lot", required: true, guesses: ["lot", "lot no", "seri"] },
              { key: "locationCode", label: "Konum kodu", required: true, guesses: ["konum", "location", "depo"] },
              { key: "rev", label: "Revizyon (bitmiş ürün)", guesses: ["rev", "revizyon", "revision"] },
            ]}
            onPreview={(a) => post<ImportPreview>("/api/imports/stock/preview", a)}
            onCommit={async (jobId) => {
              const r = await post(`/api/imports/${jobId}/commit`, {});
              qc.invalidateQueries({ queryKey: ["imports"] });
              return r;
            }}
          />
        </section>
      ) : null}
      {can("sales.create") ? (
        <section className="card">
          <h2>Müşteriler (W39 devamı)</h2>
          <p className="muted" style={{ marginTop: 0 }}>Ana veri güncellemesidir: kod eşleşirse ad güncellenir, yoksa yeni müşteri açılır — hareket/sipariş etkilenmez.</p>
          <CsvWizard
            columns={["code", "name"]}
            fields={[
              { key: "code", label: "Müşteri kodu", required: true, guesses: ["kod", "code", "müşteri kodu"] },
              { key: "name", label: "Müşteri adı", required: true, guesses: ["ad", "isim", "name", "unvan"] },
            ]}
            onPreview={(a) => post<ImportPreview>("/api/imports/customers/preview", a)}
            onCommit={async (jobId) => {
              const r = await post(`/api/imports/${jobId}/commit`, {});
              qc.invalidateQueries({ queryKey: ["imports"] });
              return r;
            }}
          />
        </section>
      ) : null}
      {can("supplier.manage") ? (
        <section className="card">
          <h2>Tedarikçiler (W39 devamı)</h2>
          <p className="muted" style={{ marginTop: 0 }}>Ana veri güncellemesidir: kod eşleşirse ad/iletişim/teslim süresi güncellenir, yoksa yeni tedarikçi açılır.</p>
          <CsvWizard
            columns={["code", "name", "contactEmail", "leadTimeDays"]}
            fields={[
              { key: "code", label: "Tedarikçi kodu", required: true, guesses: ["kod", "code", "tedarikçi kodu"] },
              { key: "name", label: "Tedarikçi adı", required: true, guesses: ["ad", "isim", "name", "unvan"] },
              { key: "contactEmail", label: "İletişim e-posta", guesses: ["email", "e-posta", "eposta"] },
              { key: "leadTimeDays", label: "Varsayılan teslim süresi (gün)", guesses: ["teslim süresi", "lead time", "gün"] },
            ]}
            onPreview={(a) => post<ImportPreview>("/api/imports/suppliers/preview", a)}
            onCommit={async (jobId) => {
              const r = await post(`/api/imports/${jobId}/commit`, {});
              qc.invalidateQueries({ queryKey: ["imports"] });
              return r;
            }}
          />
        </section>
      ) : null}
      {can("sales.create") ? (
        <section className="card">
          <h2>Açık satış siparişleri (W39 devamı — tarihsel geçiş)</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Geçmişten taşınan siparişler doğrudan kaydedilir; canlı sipariş oluşturma akışından farklı olarak
            rezervasyon, üretim ihtiyacı, satın alma talebi veya kredi kontrolü otomatik <b>çalıştırılmaz</b> —
            geçmiş bir sipariş için hayali talep/arz sinyali üretilmez. Aynı "Sipariş kodu" değerine sahip satırlar
            tek siparişin kalemleri olarak gruplanır; boş bırakılırsa her satır kendi kodunda ayrı sipariş olur.
          </p>
          <CsvWizard
            columns={["orderCode", "customerCode", "productCode", "rev", "qty", "unitPrice", "currency", "requestedDate", "status"]}
            fields={[
              { key: "orderCode", label: "Sipariş kodu (opsiyonel — boşsa üretilir)", guesses: ["sipariş kodu", "sipariş no", "order code"] },
              { key: "customerCode", label: "Müşteri kodu", required: true, guesses: ["müşteri kodu", "customer code", "kod"] },
              { key: "productCode", label: "Ürün kodu", required: true, guesses: ["ürün kodu", "product code"] },
              { key: "rev", label: "Revizyon (opsiyonel — boşsa son yayımlanan)", guesses: ["rev", "revizyon", "revision"] },
              { key: "qty", label: "Miktar", required: true, guesses: ["miktar", "adet", "qty"] },
              { key: "unitPrice", label: "Birim fiyat (opsiyonel)", guesses: ["fiyat", "birim fiyat", "price"] },
              { key: "currency", label: "Para birimi (opsiyonel, varsayılan TRY)", guesses: ["para birimi", "currency", "kur"] },
              { key: "requestedDate", label: "İstenen tarih", required: true, guesses: ["tarih", "istenen tarih", "date"] },
              { key: "status", label: 'Durum (opsiyonel: "draft"/"firm", varsayılan "firm")', guesses: ["durum", "status"] },
            ]}
            onPreview={(a) => post<ImportPreview>("/api/imports/sales-orders/preview", a)}
            onCommit={async (jobId) => {
              const r = await post(`/api/imports/${jobId}/commit`, {});
              qc.invalidateQueries({ queryKey: ["imports"] });
              return r;
            }}
          />
        </section>
      ) : null}
      {can("invoice.manage") ? (
        <section className="card">
          <h2>Açık tedarikçi borcu (W39 devamı — tarihsel geçiş)</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Geçmişten taşınan faturalar doğrudan onaylı (tamamı ödenmişse "ödendi") kaydedilir; canlı fatura giriş
            akışından farklı olarak sipariş–mal kabul–fatura üç yönlü eşleştirmesi <b>çalıştırılmaz</b> (geçmiş bir
            faturanın sistemde bir siparişe/mal kabulüne bağlı olması beklenmez) ve hiçbir lot maliyeti yazılmaz.
            Fatura kaydında bu durum açıkça belirtilir. "Ödenen tutar" verilirse "Ödeme tarihi" de zorunludur.
          </p>
          <CsvWizard
            columns={["supplierCode", "invoiceNo", "invoiceDate", "dueDate", "currency", "netAmount", "taxAmount", "description", "paidAmount", "paidDate"]}
            fields={[
              { key: "supplierCode", label: "Tedarikçi kodu", required: true, guesses: ["tedarikçi kodu", "supplier code", "kod"] },
              { key: "invoiceNo", label: "Fatura no", required: true, guesses: ["fatura no", "invoice no", "fatura numarası"] },
              { key: "invoiceDate", label: "Fatura tarihi", required: true, guesses: ["fatura tarihi", "invoice date", "tarih"] },
              { key: "dueDate", label: "Vade tarihi (opsiyonel — boşsa tedarikçi ödeme vadesinden hesaplanır)", guesses: ["vade tarihi", "due date", "vade"] },
              { key: "currency", label: "Para birimi (opsiyonel, varsayılan TRY)", guesses: ["para birimi", "currency", "kur"] },
              { key: "netAmount", label: "Net tutar", required: true, guesses: ["net tutar", "net amount", "tutar"] },
              { key: "taxAmount", label: "KDV tutarı (opsiyonel)", guesses: ["kdv", "vergi", "tax amount"] },
              { key: "description", label: "Açıklama (opsiyonel)", guesses: ["açıklama", "description"] },
              { key: "paidAmount", label: "Ödenen tutar (opsiyonel)", guesses: ["ödenen tutar", "paid amount"] },
              { key: "paidDate", label: "Ödeme tarihi (ödenen tutar verilmişse zorunlu)", guesses: ["ödeme tarihi", "paid date"] },
            ]}
            onPreview={(a) => post<ImportPreview>("/api/imports/ap-invoices/preview", a)}
            onCommit={async (jobId) => {
              const r = await post(`/api/imports/${jobId}/commit`, {});
              qc.invalidateQueries({ queryKey: ["imports"] });
              return r;
            }}
          />
        </section>
      ) : null}
      {can("purchase.order.manage") ? (
        <section className="card">
          <h2>Açık satın alma siparişleri (W39 devamı — tarihsel geçiş)</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Geçmişten taşınan siparişler doğrudan kaydedilir; canlı akıştan (RFQ → teklif karşılaştırma → seçim)
            farklı olarak RFQ, teklif, satın alma talebi veya tahsisat <b>oluşturulmaz</b>. Sipariş durumu
            (gönderildi/teyitli/kısmen teslim alındı/teslim alındı) satırlarda verdiğiniz gerçek teyit tarihi ve
            teslim alınan miktardan hesaplanır — uydurulmaz. Aynı "Sipariş kodu" değerine sahip satırlar tek
            siparişin kalemleri olarak gruplanır; boş bırakılırsa her satır kendi kodunda ayrı sipariş olur.
          </p>
          <CsvWizard
            columns={["poCode", "supplierCode", "itemCode", "qty", "qtyReceived", "unitPrice", "currency", "requestedDate", "confirmedDate"]}
            fields={[
              { key: "poCode", label: "Sipariş kodu (opsiyonel — boşsa üretilir)", guesses: ["sipariş kodu", "sipariş no", "po code", "order code"] },
              { key: "supplierCode", label: "Tedarikçi kodu", required: true, guesses: ["tedarikçi kodu", "supplier code", "kod"] },
              { key: "itemCode", label: "Kalem kodu", required: true, guesses: ["kalem kodu", "item code", "stok kodu"] },
              { key: "qty", label: "Sipariş miktarı", required: true, guesses: ["miktar", "sipariş miktarı", "qty"] },
              { key: "qtyReceived", label: "Teslim alınan miktar (opsiyonel, varsayılan 0)", guesses: ["teslim alınan", "teslim alınan miktar", "qty received"] },
              { key: "unitPrice", label: "Birim fiyat (opsiyonel)", guesses: ["fiyat", "birim fiyat", "price"] },
              { key: "currency", label: "Para birimi (opsiyonel, varsayılan TRY)", guesses: ["para birimi", "currency", "kur"] },
              { key: "requestedDate", label: "İstenen tarih (opsiyonel)", guesses: ["istenen tarih", "requested date", "tarih"] },
              { key: "confirmedDate", label: "Tedarikçi teyit tarihi (opsiyonel)", guesses: ["teyit tarihi", "confirmed date", "vade"] },
            ]}
            onPreview={(a) => post<ImportPreview>("/api/imports/purchase-orders/preview", a)}
            onCommit={async (jobId) => {
              const r = await post(`/api/imports/${jobId}/commit`, {});
              qc.invalidateQueries({ queryKey: ["imports"] });
              return r;
            }}
          />
        </section>
      ) : null}
      {can("receivable.manage") ? (
        <section className="card">
          <h2>Açık alacak (W39 devamı — tarihsel geçiş)</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Geçmişten taşınan faturalar doğrudan kesildi (tamamı tahsil edilmişse "tahsil edildi") olarak
            kaydedilir; canlı fatura akışından (sevkiyattan taslak → kes) farklı olarak sipariş/sevkiyat
            bağlantısı <b>uydurulmaz</b> — fatura kaydında bu durum açıkça belirtilir. KDV oranı, verdiğiniz net/KDV
            tutarından hesaplanır. "Tahsil edilen tutar" verilirse "Tahsilat tarihi" de zorunludur.
          </p>
          <CsvWizard
            columns={["invoiceNo", "customerCode", "invoiceDate", "dueDate", "currency", "netAmount", "taxAmount", "description", "receivedAmount", "receivedDate"]}
            fields={[
              { key: "invoiceNo", label: "Fatura no (opsiyonel — boşsa üretilir)", guesses: ["fatura no", "invoice no", "fatura numarası"] },
              { key: "customerCode", label: "Müşteri kodu", required: true, guesses: ["müşteri kodu", "customer code", "kod"] },
              { key: "invoiceDate", label: "Fatura tarihi", required: true, guesses: ["fatura tarihi", "invoice date", "tarih"] },
              { key: "dueDate", label: "Vade tarihi (opsiyonel — boşsa müşteri ödeme vadesinden hesaplanır)", guesses: ["vade tarihi", "due date", "vade"] },
              { key: "currency", label: "Para birimi (opsiyonel, varsayılan TRY)", guesses: ["para birimi", "currency", "kur"] },
              { key: "netAmount", label: "Net tutar", required: true, guesses: ["net tutar", "net amount", "tutar"] },
              { key: "taxAmount", label: "KDV tutarı (opsiyonel)", guesses: ["kdv", "vergi", "tax amount"] },
              { key: "description", label: "Açıklama (opsiyonel)", guesses: ["açıklama", "description"] },
              { key: "receivedAmount", label: "Tahsil edilen tutar (opsiyonel)", guesses: ["tahsil edilen tutar", "received amount"] },
              { key: "receivedDate", label: "Tahsilat tarihi (tahsil edilen tutar verilmişse zorunlu)", guesses: ["tahsilat tarihi", "received date"] },
            ]}
            onPreview={(a) => post<ImportPreview>("/api/imports/ar-invoices/preview", a)}
            onCommit={async (jobId) => {
              const r = await post(`/api/imports/${jobId}/commit`, {});
              qc.invalidateQueries({ queryKey: ["imports"] });
              return r;
            }}
          />
        </section>
      ) : null}
      <section className="card">
        <h2>Geçmiş işler</h2>
        <p className="muted" style={{ marginTop: 0 }}>Uzlaşma: kaynak dosyadaki işlenebilir satır sayısı ile hedefte gerçekte oluşan kayıt sayısı karşılaştırılır (W39 devamı).</p>
        <table>
          <thead><tr><th>Tür</th><th>Dosya</th><th>Durum</th><th>Tarih</th><th>Uzlaşma</th></tr></thead>
          <tbody>
            {jobs.data?.map((j) => (
              <tr key={j.id}>
                <td>{JOB_KIND_LABEL[j.kind] ?? j.kind}</td>
                <td className="mono">{j.fileName}</td>
                <td><StateBadge value={j.status} prefix="job" /></td>
                <td className="muted">{fmtDate(j.createdAt)}</td>
                <td>
                  {j.reconciliation ? (
                    j.reconciliation.matched === null ? (
                      <span className="muted">—</span>
                    ) : (
                      <span className={`badge ${j.reconciliation.matched ? "ok" : "bad"}`}>
                        kaynak {j.reconciliation.sourceRows} / hedef {j.reconciliation.targetRows}
                        {j.reconciliation.matched ? "" : " — UYUŞMUYOR"}
                      </span>
                    )
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

const JOB_KIND_LABEL: Record<string, string> = { bom: "BOM", stock_opening: "Açılış stoğu", customers: "Müşteriler", suppliers: "Tedarikçiler", sales_orders: "Satış siparişleri", ap_invoices: "Tedarikçi faturaları", purchase_orders: "Satın alma siparişleri", ar_invoices: "Müşteri faturaları" };

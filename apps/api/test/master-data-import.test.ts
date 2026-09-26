/**
 * Oturum 39 devamı (W39 devamı — tarihsel veri geçişi): müşteri/tedarikçi ana veri içe aktarımı.
 * BOM/açılış stoğu ile aynı önizleme→onay deseni, ama hareket değil upsert (kod eşleşirse güncellenir).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

describe("Müşteri/tedarikçi ana veri içe aktarımı (W39 devamı)", () => {
  it("müşteri içe aktarımı: yeni kod açar, mevcut kodu günceller, mükerrer/boş satırları reddeder", async () => {
    const noAccess = await call(w.app, "warehouse@a.test", A, "POST", "/api/imports/customers/preview", {
      fileName: "c.csv", content: "kod,ad\nCUST-1,Acme", mapping: { code: "kod", name: "ad" },
    });
    expect(noAccess.status).toBe(403);

    const csv1 = "kod,ad\nCUST-1,Acme A.Ş.\nCUST-2,Beta Ltd.\nCUST-2,Beta Duplicate\n,Boş kod";
    const p1 = expectOk(
      await call(w.app, "sales@a.test", A, "POST", "/api/imports/customers/preview", { fileName: "c1.csv", content: csv1, mapping: { code: "kod", name: "ad" } }),
    );
    expect(p1.summary).toMatchObject({ total: 4, ok: 2, errors: 2 });
    expect(p1.rows[2].messages).toEqual(expect.arrayContaining([expect.stringContaining("mükerrer")]));
    expect(p1.rows[3].messages).toEqual(expect.arrayContaining([expect.stringContaining("kodu boş")]));

    const badCommit = await call(w.app, "sales@a.test", A, "POST", `/api/imports/${p1.jobId}/commit`, {});
    expect(badCommit.status).toBe(409);
    expect(badCommit.body.error.code).toBe("import_has_errors");

    const csv2 = "kod,ad\nCUST-1,Acme A.Ş.\nCUST-2,Beta Ltd.";
    const p2 = expectOk(
      await call(w.app, "sales@a.test", A, "POST", "/api/imports/customers/preview", { fileName: "c2.csv", content: csv2, mapping: { code: "kod", name: "ad" } }),
    );
    expect(p2.summary).toMatchObject({ total: 2, ok: 2, errors: 0 });
    const committed = expectOk(await call(w.app, "sales@a.test", A, "POST", `/api/imports/${p2.jobId}/commit`, {}));
    expect(committed).toMatchObject({ created: 2, updated: 0 });

    // Aynı dosya ikinci kez işlenemez (T13).
    const dupPreview = expectOk(
      await call(w.app, "sales@a.test", A, "POST", "/api/imports/customers/preview", { fileName: "c2.csv", content: csv2, mapping: { code: "kod", name: "ad" } }),
    );
    expect(dupPreview.duplicateOf).toBeTruthy();
    const dupCommit = await call(w.app, "sales@a.test", A, "POST", `/api/imports/${dupPreview.jobId}/commit`, {});
    expect(dupCommit.status).toBe(409);
    expect(dupCommit.body.error.code).toBe("duplicate_import");

    // Aynı kod farklı ad ile güncelleme: yeni kayıt açılmaz, mevcut satır güncellenir.
    const csv3 = "kod,ad\nCUST-1,Acme Yeni Unvan\nCUST-3,Gamma A.Ş.";
    const p3 = expectOk(
      await call(w.app, "sales@a.test", A, "POST", "/api/imports/customers/preview", { fileName: "c3.csv", content: csv3, mapping: { code: "kod", name: "ad" } }),
    );
    const c3 = expectOk(await call(w.app, "sales@a.test", A, "POST", `/api/imports/${p3.jobId}/commit`, {}));
    expect(c3).toMatchObject({ created: 1, updated: 1 });

    const list = expectOk(await call(w.app, "sales@a.test", A, "GET", "/api/customers"));
    expect(list.find((c: any) => c.code === "CUST-1")).toMatchObject({ name: "Acme Yeni Unvan" });
    expect(list.filter((c: any) => ["CUST-1", "CUST-2", "CUST-3"].includes(c.code))).toHaveLength(3);
  });

  it("tedarikçi içe aktarımı: iletişim/teslim süresi alanları isteğe bağlıdır, geçersiz teslim süresi reddedilir", async () => {
    const noAccess = await call(w.app, "sales@a.test", A, "POST", "/api/imports/suppliers/preview", {
      fileName: "s.csv", content: "kod,ad\nSUP-1,Tedarikçi A", mapping: { code: "kod", name: "ad" },
    });
    expect(noAccess.status).toBe(403);

    const csv = "kod,ad,eposta,gun\nSUP-1,Tedarikçi A,a@tedarikci.com,15\nSUP-2,Tedarikçi B,,\nSUP-3,Tedarikçi C,,400";
    const p = expectOk(
      await call(w.app, "purchasing@a.test", A, "POST", "/api/imports/suppliers/preview", {
        fileName: "s.csv", content: csv, mapping: { code: "kod", name: "ad", contactEmail: "eposta", leadTimeDays: "gun" },
      }),
    );
    expect(p.summary).toMatchObject({ total: 3, ok: 2, errors: 1 });
    expect(p.rows[2].messages).toEqual(expect.arrayContaining([expect.stringContaining("Teslim süresi geçersiz")]));

    const csvOk = "kod,ad,eposta,gun\nSUP-1,Tedarikçi A,a@tedarikci.com,15\nSUP-2,Tedarikçi B,,";
    const p2 = expectOk(
      await call(w.app, "purchasing@a.test", A, "POST", "/api/imports/suppliers/preview", {
        fileName: "s2.csv", content: csvOk, mapping: { code: "kod", name: "ad", contactEmail: "eposta", leadTimeDays: "gun" },
      }),
    );
    const committed = expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/imports/${p2.jobId}/commit`, {}));
    expect(committed).toMatchObject({ created: 2, updated: 0 });

    const list = expectOk(await call(w.app, "purchasing@a.test", A, "GET", "/api/suppliers"));
    expect(list.find((s: any) => s.code === "SUP-1")).toMatchObject({ contactEmail: "a@tedarikci.com", defaultLeadTimeDays: 15 });
  });

  it("şirket B kendi kaydını görmez (RLS)", async () => {
    const r = await call(w.app, "all@b.test", w.b.companyId, "GET", "/api/customers");
    expect(expectOk(r).some((c: any) => c.code === "CUST-1")).toBe(false);
  });

  it("kaynak-hedef uzlaşma: her onaylanan iş için kaynak satır sayısı hedef kayıt sayısıyla eşleşir", async () => {
    const csv = "kod,ad\nCUST-REC-1,Uzlaşma A.Ş.\nCUST-REC-2,Uzlaşma İkinci";
    const p = expectOk(
      await call(w.app, "sales@a.test", A, "POST", "/api/imports/customers/preview", { fileName: "rec.csv", content: csv, mapping: { code: "kod", name: "ad" } }),
    );
    expectOk(await call(w.app, "sales@a.test", A, "POST", `/api/imports/${p.jobId}/commit`, {}));

    const jobs = expectOk(await call(w.app, "sales@a.test", A, "GET", "/api/imports"));
    const job = jobs.find((j: any) => j.id === p.jobId);
    expect(job.reconciliation).toMatchObject({ sourceRows: 2, targetRows: 2, matched: true });

    // Henüz onaylanmamış (previewed) bir iş için uzlaşma hesaplanmaz.
    const p2 = expectOk(
      await call(w.app, "sales@a.test", A, "POST", "/api/imports/customers/preview", { fileName: "rec2.csv", content: "kod,ad\nCUST-REC-3,Üçüncü", mapping: { code: "kod", name: "ad" } }),
    );
    const jobs2 = expectOk(await call(w.app, "sales@a.test", A, "GET", "/api/imports"));
    expect(jobs2.find((j: any) => j.id === p2.jobId).reconciliation).toBeNull();
  });
});

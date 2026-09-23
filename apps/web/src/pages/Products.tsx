import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BomDiff, BomVersion, ProductSummary, RevisionDetail } from "@apisfactory/shared";
import { get, post } from "../lib/api";
import { Empty, ErrorNotice, Loading, PageHeader, StateBadge, fmt, fmtDate, useCan } from "../lib/ui";

export function ProductsPage() {
  const can = useCan();
  const nav = useNavigate();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["products"], queryFn: () => get<ProductSummary[]>("/api/products") });
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => post<ProductSummary>("/api/products", { code, name }),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ["products"] });
      nav(`/products/${p.id}`);
    },
  });
  return (
    <>
      <PageHeader title="Ar-Ge & BOM" sub="Ürünler, revizyonlar ve üretime devir durumu" />
      {can("product.create") ? (
        <form className="card" onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}>
          <h3>Yeni ürün</h3>
          <ErrorNotice error={create.error} />
          <div className="row">
            <label className="field">Ürün kodu<input required value={code} onChange={(e) => setCode(e.target.value)} /></label>
            <label className="field" style={{ flex: 1 }}>Ad<input required value={name} onChange={(e) => setName(e.target.value)} /></label>
            <button className="primary" disabled={create.isPending} style={{ alignSelf: "flex-end" }}>Oluştur</button>
          </div>
        </form>
      ) : null}
      <section className="card">
        {list.isLoading ? <Loading /> : <ErrorNotice error={list.error} />}
        {list.data?.length === 0 ? <Empty>Henüz ürün yok.</Empty> : null}
        {list.data && list.data.length > 0 ? (
          <table>
            <thead><tr><th>Kod</th><th>Ad</th><th>Revizyonlar</th></tr></thead>
            <tbody>
              {list.data.map((p) => (
                <tr key={p.id} className="click" onClick={() => nav(`/products/${p.id}`)}>
                  <td className="mono">{p.code}</td>
                  <td>{p.name}</td>
                  <td className="row">{p.revisions.map((r) => <span key={r.id} className="row" style={{ gap: 4 }}><b>Rev.{r.rev}</b><StateBadge value={r.status} /></span>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
    </>
  );
}

type ProductDetail = { id: string; code: string; name: string; revisions: RevisionDetail[]; boms: { id: string; versionNo: number; status: string; lineCount: number; publishedAt: string | null }[] };

const AREA_LABEL = { rd: "Ar-Ge", production: "Üretim", quality: "Kalite" } as const;

export function ProductDetailPage() {
  const { id } = useParams();
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["product", id], queryFn: () => get<ProductDetail>(`/api/products/${id}`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ["product", id] });
  const [selectedBom, setSelectedBom] = useState<string | null>(null);
  const [diffWith, setDiffWith] = useState<string | null>(null);
  const [rev, setRev] = useState("");

  const act = useMutation({ mutationFn: (f: () => Promise<unknown>) => f(), onSuccess: refresh });

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNotice error={q.error} />;
  const p = q.data!;
  const published = p.boms.filter((b) => b.status === "published");

  return (
    <>
      <PageHeader
        title={`${p.code} — ${p.name}`}
        actions={can("bom.import") ? <Link className="btn primary" to={`/products/${p.id}/bom-import`}>BOM içe aktar</Link> : null}
      />
      <ErrorNotice error={act.error} />

      <section className="card">
        <div className="row between">
          <h2>Revizyonlar ve üretime devir</h2>
          {can("product.create") ? (
            <form className="row" onSubmit={(e) => { e.preventDefault(); act.mutate(() => post(`/api/products/${p.id}/revisions`, { rev, bomVersionId: published.at(-1)?.id })); setRev(""); }}>
              <input aria-label="Revizyon" placeholder="Rev (ör. B)" required value={rev} onChange={(e) => setRev(e.target.value)} style={{ width: 120 }} />
              <button>Revizyon aç</button>
            </form>
          ) : null}
        </div>
        {p.revisions.length === 0 ? <Empty>Revizyon yok.</Empty> : null}
        {p.revisions.map((r) => (
          <div key={r.id} className="card" style={{ background: "var(--surface-2)" }}>
            <div className="row between">
              <div className="row">
                <h3>Rev.{r.rev}</h3>
                <StateBadge value={r.status} />
                {r.releasedAt ? <span className="muted">Yayım: {fmtDate(r.releasedAt)}</span> : null}
              </div>
              <div className="row">
                {can("product.create") && ["development", "pilot", "rejected", "draft"].includes(r.status) ? (
                  <select aria-label="BOM sürümü bağla" value={r.bomVersionId ?? ""} onChange={(e) => act.mutate(() => post(`/api/revisions/${r.id}/bom`, { bomVersionId: e.target.value }))}>
                    <option value="" disabled>BOM seç</option>
                    {p.boms.map((b) => <option key={b.id} value={b.id}>BOM v{b.versionNo} ({b.status === "published" ? "yayımlı" : "taslak"})</option>)}
                  </select>
                ) : null}
                {can("product.create") && r.status === "rejected" ? <button onClick={() => act.mutate(() => post(`/api/revisions/${r.id}/transition`, { action: "start_development" }))}>Geliştirmeye al</button> : null}
                {can("product.create") && r.status === "development" ? <button onClick={() => act.mutate(() => post(`/api/revisions/${r.id}/transition`, { action: "start_pilot" }))}>Pilota al</button> : null}
                {can("product.create") && ["development", "pilot"].includes(r.status) ? (
                  <button className="primary" onClick={() => act.mutate(() => post(`/api/revisions/${r.id}/transition`, { action: "submit_handover" }))}>Devre gönder</button>
                ) : null}
              </div>
            </div>
            {r.status === "handover_review" ? <HandoverPanel rev={r} onDone={refresh} /> : null}
            {r.approvals.length > 0 ? (
              <table>
                <thead><tr><th>Birim</th><th>Karar</th><th>Kim</th><th>Ne zaman</th><th>Not</th></tr></thead>
                <tbody>
                  {r.approvals.map((a) => (
                    <tr key={a.area + a.at}>
                      <td>{AREA_LABEL[a.area]}</td>
                      <td><StateBadge value={a.decision === "approve" ? "approved" : "rejected"} /></td>
                      <td>{a.by}</td><td className="muted">{fmtDate(a.at)}</td><td>{a.note ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            <RevisionQuality rev={r} onDone={refresh} />
            {r.status !== "released" ? <p className="muted" style={{ margin: 0 }}>Devir tamamlanmadan bu revizyonla kesin sipariş açılamaz; teklif taslağı hazırlanabilir.</p> : null}
          </div>
        ))}
      </section>

      <section className="card">
        <h2>BOM sürümleri</h2>
        {p.boms.length === 0 ? <Empty>BOM yok. Excel/CSV veya Altium/KiCad dışa aktarımını içe aktarın.</Empty> : null}
        <table>
          <tbody>
            {p.boms.map((b) => (
              <tr key={b.id}>
                <td><b>v{b.versionNo}</b></td>
                <td><StateBadge value={b.status} /></td>
                <td className="muted">{b.lineCount} satır</td>
                <td className="row" style={{ justifyContent: "flex-end" }}>
                  <button onClick={() => setSelectedBom(b.id)}>Görüntüle</button>
                  {p.boms.length > 1 ? <button onClick={() => { setSelectedBom(b.id); setDiffWith(p.boms.find((x) => x.id !== b.id)!.id); }}>Fark</button> : null}
                  {can("bom.publish") && b.status === "draft" ? <button className="primary" onClick={() => act.mutate(() => post(`/api/boms/${b.id}/publish`))}>Yayımla</button> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {selectedBom && !diffWith ? <BomView id={selectedBom} /> : null}
      {selectedBom && diffWith ? <BomDiffView a={diffWith} b={selectedBom} boms={p.boms} setA={setDiffWith} onClose={() => setDiffWith(null)} /> : null}
    </>
  );
}

function HandoverPanel({ rev, onDone }: { rev: RevisionDetail; onDone: () => void }) {
  const can = useCan();
  const [note, setNote] = useState("");
  const decide = useMutation({
    mutationFn: (v: { area: "rd" | "production" | "quality"; decision: "approve" | "reject" }) => post(`/api/revisions/${rev.id}/handover`, { ...v, note: note || undefined }),
    onSuccess: onDone,
  });
  const mine = rev.missingApprovals.filter((a) => can(`product.approve.${a}` as any));
  return (
    <div className="stack">
      <div className="notice warn">Bekleyen onaylar: {rev.missingApprovals.map((a) => AREA_LABEL[a]).join(", ")}</div>
      <ErrorNotice error={decide.error} />
      {mine.length > 0 ? (
        <div className="row">
          <input aria-label="Not / ret gerekçesi" placeholder="Not (ret için zorunlu)" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: 1 }} />
          {mine.map((area) => (
            <span key={area} className="row">
              <button className="primary" onClick={() => decide.mutate({ area, decision: "approve" })}>{AREA_LABEL[area]} onayı</button>
              <button className="danger" onClick={() => decide.mutate({ area, decision: "reject" })}>Reddet</button>
            </span>
          ))}
        </div>
      ) : <p className="muted" style={{ margin: 0 }}>Bu revizyon için karar yetkiniz yok.</p>}
    </div>
  );
}

function BomView({ id }: { id: string }) {
  const q = useQuery({ queryKey: ["bom", id], queryFn: () => get<BomVersion>(`/api/boms/${id}`) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNotice error={q.error} />;
  const b = q.data!;
  return (
    <section className="card">
      <div className="row"><h2>BOM v{b.versionNo}</h2><StateBadge value={b.status} /></div>
      <table>
        <thead><tr><th>#</th><th>Referans</th><th>İç kod</th><th>Üretici</th><th>MPN</th><th>Açıklama</th><th className="num">Miktar</th><th>DNP</th></tr></thead>
        <tbody>
          {b.lines.map((l) => (
            <tr key={l.id} style={l.dnp ? { opacity: 0.6 } : undefined}>
              <td>{l.lineNo}</td><td className="mono">{l.refdes}</td><td className="mono">{l.itemCode}</td><td>{l.manufacturer}</td>
              <td className="mono">{l.mpn}</td><td>{l.description}</td><td className="num">{fmt(l.qtyPer)}</td><td>{l.dnp ? "DNP" : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function BomDiffView({ a, b, boms, setA, onClose }: { a: string; b: string; boms: ProductDetail["boms"]; setA: (v: string) => void; onClose: () => void }) {
  const q = useQuery({ queryKey: ["diff", a, b], queryFn: () => get<BomDiff>(`/api/boms/${a}/diff/${b}`) });
  const nameOf = (id: string) => `v${boms.find((x) => x.id === id)?.versionNo}`;
  return (
    <section className="card">
      <div className="row between">
        <h2>BOM farkı: {nameOf(a)} → {nameOf(b)}</h2>
        <div className="row">
          <select aria-label="Karşılaştırılan sürüm" value={a} onChange={(e) => setA(e.target.value)}>
            {boms.filter((x) => x.id !== b).map((x) => <option key={x.id} value={x.id}>v{x.versionNo}</option>)}
          </select>
          <button onClick={onClose}>Kapat</button>
        </div>
      </div>
      {q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />}
      {q.data ? (
        <table>
          <thead><tr><th>Değişiklik</th><th>Referans</th><th>Önce</th><th>Sonra</th></tr></thead>
          <tbody>
            {q.data.added.map((l) => <tr key={"a" + l.id}><td><span className="badge ok">Eklendi</span></td><td className="mono">{l.refdes}</td><td>—</td><td className="mono">{l.mpn} × {fmt(l.qtyPer)}</td></tr>)}
            {q.data.removed.map((l) => <tr key={"r" + l.id}><td><span className="badge bad">Silindi</span></td><td className="mono">{l.refdes}</td><td className="mono">{l.mpn} × {fmt(l.qtyPer)}</td><td>—</td></tr>)}
            {q.data.changed.map((c) => (
              <tr key={c.key}>
                <td><span className="badge warn">Değişti: {c.fields.join(", ")}</span></td><td className="mono">{c.after.refdes}</td>
                <td className="mono">{c.before.mpn} × {fmt(c.before.qtyPer)}{c.before.dnp ? " DNP" : ""}</td>
                <td className="mono">{c.after.mpn} × {fmt(c.after.qtyPer)}{c.after.dnp ? " DNP" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {q.data && !q.data.added.length && !q.data.removed.length && !q.data.changed.length ? <Empty>Fark yok.</Empty> : null}
    </section>
  );
}

/** Revizyonun firmware'i ve test planı sürümleri. Yayımlanan plan değiştirilemez; değişiklik yeni sürümdür. */
function RevisionQuality({ rev, onDone }: { rev: RevisionDetail; onDone: () => void }) {
  const can = useCan();
  const qc = useQueryClient();
  const plans = useQuery({ queryKey: ["testPlans", rev.id], queryFn: () => get<any[]>(`/api/revisions/${rev.id}/test-plans`) });
  const [fw, setFw] = useState("");
  const [sha, setSha] = useState("");
  const [rows, setRows] = useState<{ name: string; unit: string; low: string; high: string; required: boolean }[]>([]);
  const act = useMutation({
    mutationFn: (f: () => Promise<unknown>) => f(),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["testPlans", rev.id] }); onDone(); },
  });
  const locked = ["handover_review", "released"].includes(rev.status);
  const last = plans.data?.at(-1);
  function startNew() {
    setRows(last ? last.limits.map((l: any) => ({ name: l.name, unit: l.unit ?? "", low: l.low ?? "", high: l.high ?? "", required: l.required })) : [{ name: "", unit: "", low: "", high: "", required: true }]);
  }
  const num = (v: string | number) => (v === "" || v === null ? undefined : Number(v));
  return (
    <div className="stack">
      <div className="row">
        <b>Firmware:</b>
        {rev.firmwareVersion ? <span className="mono">{rev.firmwareVersion}{rev.firmwareSha256 ? ` · sha256 ${rev.firmwareSha256.slice(0, 12)}…` : ""}</span> : <span className="muted">tanımsız (test firmware kontrolü yapılamaz)</span>}
        {can("product.create") && !locked ? (
          <form className="row" onSubmit={(e) => { e.preventDefault(); act.mutate(() => post(`/api/revisions/${rev.id}/firmware`, { version: fw, sha256: sha || undefined })); setFw(""); setSha(""); }}>
            <input aria-label="Firmware sürümü" placeholder="Sürüm (ör. 1.4.2)" required value={fw} onChange={(e) => setFw(e.target.value)} style={{ width: 150 }} />
            <input aria-label="SHA-256" placeholder="SHA-256 (isteğe bağlı)" pattern="[0-9a-f]{64}" value={sha} onChange={(e) => setSha(e.target.value)} style={{ width: 220 }} />
            <button>Kaydet</button>
          </form>
        ) : null}
      </div>
      <div className="row between">
        <b>Test planı</b>
        {can("quality.plan.manage") && rows.length === 0 ? <button onClick={startNew}>{last ? "Yeni sürüm" : "Test planı oluştur"}</button> : null}
      </div>
      {plans.data?.length === 0 ? <span className="muted">Test planı yok; iş emrinde sonuç elle seçilir.</span> : null}
      {plans.data?.map((p) => (
        <div key={p.id} className="row" style={{ alignItems: "flex-start" }}>
          <span className="mono">v{p.versionNo}</span><StateBadge value={p.status} />
          <span className="muted">{p.limits.map((l: any) => `${l.name}${l.required ? "" : "?"} ${l.low ?? "−∞"}…${l.high ?? "+∞"} ${l.unit ?? ""}`).join(" · ")}</span>
          {can("quality.plan.manage") && p.status === "draft" ? <button className="primary" onClick={() => act.mutate(() => post(`/api/test-plans/${p.id}/publish`))}>Yayımla</button> : null}
        </div>
      ))}
      {rows.length > 0 ? (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); act.mutate(() => post(`/api/revisions/${rev.id}/test-plans`, { limits: rows.map((r) => ({ name: r.name, unit: r.unit || undefined, low: num(r.low), high: num(r.high), required: r.required })) })); setRows([]); }}>
          <table>
            <thead><tr><th>Ölçüm</th><th>Birim</th><th>Alt</th><th>Üst</th><th>Zorunlu</th><th /></tr></thead>
            <tbody>
              {rows.map((r, i) => {
                const set = (patch: Partial<typeof r>) => setRows(rows.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                return (
                  <tr key={i}>
                    <td><input aria-label="Ölçüm adı" required value={r.name} onChange={(e) => set({ name: e.target.value })} /></td>
                    <td><input aria-label="Birim" value={r.unit} onChange={(e) => set({ unit: e.target.value })} style={{ width: 70 }} /></td>
                    <td><input aria-label="Alt limit" inputMode="decimal" value={r.low} onChange={(e) => set({ low: e.target.value })} style={{ width: 90 }} /></td>
                    <td><input aria-label="Üst limit" inputMode="decimal" value={r.high} onChange={(e) => set({ high: e.target.value })} style={{ width: 90 }} /></td>
                    <td><input type="checkbox" aria-label="Zorunlu" style={{ minHeight: 0 }} checked={r.required} onChange={(e) => set({ required: e.target.checked })} /></td>
                    <td><button type="button" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Sil</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="row">
            <button type="button" onClick={() => setRows([...rows, { name: "", unit: "", low: "", high: "", required: true }])}>Satır ekle</button>
            <button className="primary">Taslak kaydet</button>
            <button type="button" onClick={() => setRows([])}>Vazgeç</button>
          </div>
        </form>
      ) : null}
      <ErrorNotice error={act.error} />
    </div>
  );
}

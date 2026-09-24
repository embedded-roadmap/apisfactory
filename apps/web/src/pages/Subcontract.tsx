import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "../lib/api";
import { Empty, ErrorNotice, fmt, Loading, PageHeader, StateBadge, fmtDate, useCan } from "../lib/ui";

const KIND_TR: Record<string, string> = { pcb: "PCB", dizgi: "Dizgi", mekanik: "Mekanik", kablo: "Kablo", montaj: "Montaj", dis_test: "Dış test" };
const PROGRESS_NEXT: Record<string, string | null> = { accepted: "prep", prep: "in_production", in_production: "testing", testing: "ready_to_ship", ready_to_ship: null };
const PROGRESS_LABEL: Record<string, string> = { prep: "Hazırlık", in_production: "Üretimde", testing: "Testte", ready_to_ship: "Sevke hazır" };

/**
 * W32 — fason üretici portalı: iç personel (subcontract.manage) işleri yönetir; dış kullanıcı yalnızca
 * kendisine atanan işi görür (genel izinle değil, atamayla). Aynı bileşen her iki tarafa da hizmet eder.
 */
export function SubcontractJobsPage() {
  const can = useCan();
  const manage = can("subcontract.manage");
  const qc = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showPerf, setShowPerf] = useState(false);
  const list = useQuery({ queryKey: ["subJobs", manage], queryFn: () => get<any[]>(manage ? "/api/subcontract-jobs" : "/api/subcontract-jobs/mine") });

  return (
    <>
      <PageHeader
        title="Fason üretici işleri"
        sub={manage ? "PCB, dizgi, mekanik, kablo, montaj ve dış test hizmetleri; dış firma yalnız kendisine atanan işi görür." : "Size atanan fason işleri; başka müşteri veya şirket içi ticari veriye erişiminiz yoktur."}
        actions={manage ? <><button onClick={() => setShowPerf(!showPerf)}>{showPerf ? "Performansı gizle" : "Fasoncu performansı"}</button> <button onClick={() => setShowNew(!showNew)}>{showNew ? "Vazgeç" : "Yeni iş"}</button></> : null}
      />
      {showPerf ? <SubcontractorPerformance /> : null}
      {showNew ? <NewJobForm onDone={() => { setShowNew(false); list.refetch(); }} /> : null}
      {openId ? <JobDetail id={openId} manage={manage} onClose={() => { setOpenId(null); list.refetch(); }} /> : null}
      <section className="card">
        {list.isLoading ? <Loading /> : <ErrorNotice error={list.error} />}
        {list.data?.length === 0 ? <Empty>Kayıt yok.</Empty> : null}
        {list.data && list.data.length > 0 ? (
          <table>
            <thead><tr><th>Kod</th><th>Tür</th>{manage ? <th>Fason firma</th> : null}<th>Kapsam</th><th className="num">Adet</th><th>Durum</th><th>Termin</th></tr></thead>
            <tbody>
              {list.data.map((j) => (
                <tr key={j.id} className="click" onClick={() => setOpenId(j.id)}>
                  <td className="mono">{j.code}</td>
                  <td>{KIND_TR[j.kind]}</td>
                  {manage ? <td>{j.subcontractorName}</td> : null}
                  <td>{j.scope}</td>
                  <td className="num">{j.qty}</td>
                  <td><StateBadge value={j.status} prefix="sj" /></td>
                  <td className="muted">{j.promisedDate ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
    </>
  );
}

/**
 * Fasoncu performans raporu (W32 devamı): mevcut iş kayıtlarından hesaplanır, ayrı bir izleme tablosu tutulmaz.
 * Termin oranı yalnız hem termin hem kesin kabul tarihi olan tamamlanmış işlerden hesaplanır; eksikse "—" gösterilir,
 * uydurulmaz. Yalnız iç yönetim görür (ticari veri, dış kullanıcı erişemez).
 */
function SubcontractorPerformance() {
  const q = useQuery({ queryKey: ["subJobsPerformance"], queryFn: () => get<any[]>("/api/subcontract-jobs/performance") });
  const pct = (x: number | null) => (x === null ? "—" : `%${Math.round(x * 100)}`);
  return (
    <section className="card">
      <h2>Fasoncu performansı</h2>
      <p className="muted" style={{ margin: 0 }}>Tamamlanan işlerden hesaplanır. Termin/kabul tarihi eksik işler orana katılmaz; hiç işi olmayan fasoncu listede görünmez.</p>
      {q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />}
      {q.data?.length === 0 ? <Empty>Henüz tamamlanmış veya devam eden iş yok.</Empty> : null}
      {q.data && q.data.length > 0 ? (
        <table>
          <thead><tr><th>Fasoncu</th><th className="num">Toplam iş</th><th className="num">Tamamlanan</th><th className="num">Reddedilen</th><th className="num">Zamanında/geç</th><th className="num">Termin oranı</th><th className="num">Kabul edilen adet</th><th className="num">Fire oranı</th></tr></thead>
          <tbody>
            {q.data.map((r) => (
              <tr key={r.subcontractorUserId}>
                <td>{r.subcontractorName} <span className="muted">{r.subcontractorEmail}</span></td>
                <td className="num">{r.jobsTotal}</td>
                <td className="num">{r.jobsCompleted}</td>
                <td className="num">{r.jobsRejected}</td>
                <td className="num">{r.onTimeCompleted} / {r.lateCompleted}{Number(r.unevaluatedCompleted) > 0 ? <div className="muted">{r.unevaluatedCompleted} değerlendirilemedi</div> : null}</td>
                <td className="num">{pct(r.onTimeRate)}</td>
                <td className="num">{fmt(r.totalAcceptedGoodQty)}</td>
                <td className="num">{pct(r.scrapRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

function NewJobForm({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ subcontractorUserId: "", kind: "dizgi", scope: "", qty: "", promisedDate: "", price: "", companySupplies: "", subcontractorSupplies: "" });
  const users = useQuery({ queryKey: ["adminUsers"], queryFn: () => get<any[]>("/api/admin/users") });
  const subs = users.data?.filter((u) => u.roles.includes("subcontractor")) ?? [];
  const save = useMutation({
    mutationFn: () => post("/api/subcontract-jobs", { ...f, promisedDate: f.promisedDate || undefined, price: f.price || undefined, companySupplies: f.companySupplies || undefined, subcontractorSupplies: f.subcontractorSupplies || undefined }),
    onSuccess: () => onDone(),
  });
  return (
    <form className="card" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <h2>Yeni fason iş</h2>
      <ErrorNotice error={save.error} />
      <div className="grid4">
        <label className="field">Fason firma
          <select required value={f.subcontractorUserId} onChange={(e) => setF({ ...f, subcontractorUserId: e.target.value })}>
            <option value="">Seçin…</option>
            {subs.map((u) => <option key={u.userId} value={u.userId}>{u.name} · {u.email}</option>)}
          </select>
        </label>
        <label className="field">Hizmet türü
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            {Object.entries(KIND_TR).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="field">Adet<input required inputMode="decimal" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></label>
        <label className="field">Termin tarihi<input type="date" value={f.promisedDate} onChange={(e) => setF({ ...f, promisedDate: e.target.value })} /></label>
        <label className="field">Fiyat<input inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></label>
      </div>
      <label className="field">Kapsam<textarea required value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })} /></label>
      <div className="grid4">
        <label className="field">Şirketin sağlayacağı malzeme<input value={f.companySupplies} onChange={(e) => setF({ ...f, companySupplies: e.target.value })} /></label>
        <label className="field">Fason firmanın sağlayacağı malzeme<input value={f.subcontractorSupplies} onChange={(e) => setF({ ...f, subcontractorSupplies: e.target.value })} /></label>
      </div>
      <button className="primary" disabled={save.isPending}>Öneriyi gönder</button>
    </form>
  );
}

function JobDetail({ id, manage, onClose }: { id: string; manage: boolean; onClose: () => void }) {
  const can = useCan();
  const qc = useQueryClient();
  const job = useQuery({ queryKey: ["subJob", id], queryFn: () => get<any>(`/api/subcontract-jobs/${id}`) });
  const files = useQuery({ queryKey: ["subJobFiles", id], queryFn: () => get<any[]>(`/api/subcontract-jobs/${id}/files`) });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["subJob", id] }); qc.invalidateQueries({ queryKey: ["subJobFiles", id] }); qc.invalidateQueries({ queryKey: ["subJobs"] }); };
  const [counter, setCounter] = useState({ counterPrice: "", counterPromisedDate: "", note: "" });
  const [declareForm, setDeclareForm] = useState({ goodQty: "", scrapQty: "0", unusedQty: "0", note: "" });
  const [file, setFile] = useState<{ kind: string; data: string; name: string; type: string } | null>(null);

  const decide = useMutation({
    mutationFn: (decision: "accept" | "counter" | "reject") =>
      post(`/api/subcontract-jobs/${id}/decision`, {
        decision,
        counterPrice: counter.counterPrice || undefined,
        counterPromisedDate: counter.counterPromisedDate || undefined,
        note: counter.note || undefined,
      }),
    onSuccess: refresh,
  });
  const counterDecide = useMutation({ mutationFn: (decision: "accept" | "reject") => post(`/api/subcontract-jobs/${id}/counter-decision`, { decision }), onSuccess: refresh });
  const progress = useMutation({ mutationFn: (status: string) => post(`/api/subcontract-jobs/${id}/progress`, { status }), onSuccess: refresh });
  const declare = useMutation({ mutationFn: () => post(`/api/subcontract-jobs/${id}/declare`, declareForm), onSuccess: refresh });
  const upload = useMutation({
    mutationFn: () => post(`/api/subcontract-jobs/${id}/files`, { kind: file!.kind, fileName: file!.name, contentType: file!.type, contentBase64: file!.data }),
    onSuccess: () => { setFile(null); refresh(); },
  });

  function onPickFile(e: { target: HTMLInputElement }, kind: string) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setFile({ kind, name: f.name, type: f.type, data: String(reader.result).split(",")[1] ?? "" });
    reader.readAsDataURL(f);
  }

  if (job.isLoading) return <section className="card"><Loading /></section>;
  if (job.error) return <section className="card"><ErrorNotice error={job.error} /></section>;
  const j = job.data;
  const next = PROGRESS_NEXT[j.status];
  return (
    <section className="card">
      <div className="row between"><h2>{j.code} — {KIND_TR[j.kind]}</h2><button onClick={onClose}>Kapat</button></div>
      <div className="grid4">
        <div className="stat"><small>Durum</small><b><StateBadge value={j.status} prefix="sj" /></b></div>
        <div className="stat"><small>Adet</small><b>{j.qty}</b></div>
        <div className="stat"><small>Fiyat</small><b>{j.price ?? "—"} {j.currency}</b></div>
        <div className="stat"><small>Termin</small><b>{j.promisedDate ?? "—"}</b></div>
      </div>
      <p><b>Kapsam:</b> {j.scope}</p>
      {j.companySupplies ? <p className="muted">Şirketin sağlayacağı: {j.companySupplies}</p> : null}
      {j.subcontractorSupplies ? <p className="muted">Fason firmanın sağlayacağı: {j.subcontractorSupplies}</p> : null}

      {j.status === "proposed" && !manage ? (
        <div className="card">
          <h3>Kabul / karşı teklif</h3>
          <div className="row">
            <input placeholder="Karşı fiyat" value={counter.counterPrice} onChange={(e) => setCounter({ ...counter, counterPrice: e.target.value })} />
            <input type="date" value={counter.counterPromisedDate} onChange={(e) => setCounter({ ...counter, counterPromisedDate: e.target.value })} />
            <input placeholder="Not / gerekçe" value={counter.note} onChange={(e) => setCounter({ ...counter, note: e.target.value })} />
          </div>
          <div className="row">
            <button onClick={() => decide.mutate("accept")} disabled={decide.isPending}>Kabul et</button>
            <button onClick={() => decide.mutate("counter")} disabled={decide.isPending}>Karşı teklif ver</button>
            <button className="ghost" onClick={() => decide.mutate("reject")} disabled={decide.isPending}>Reddet</button>
          </div>
          <ErrorNotice error={decide.error} />
        </div>
      ) : null}

      {j.status === "countered" && manage ? (
        <div className="card">
          <h3>Karşı teklif: {j.counterPrice ?? "—"} {j.currency} / {j.counterPromisedDate ?? "—"}</h3>
          <p className="muted">{j.counterNote}</p>
          <div className="row">
            <button onClick={() => counterDecide.mutate("accept")}>Karşı teklifi kabul et</button>
            <button className="ghost" onClick={() => counterDecide.mutate("reject")}>Reddet</button>
          </div>
        </div>
      ) : null}

      {!manage && next && ["accepted", "prep", "in_production", "testing"].includes(j.status) ? (
        <button onClick={() => progress.mutate(next)} disabled={progress.isPending}>İlerlet: {PROGRESS_LABEL[next]}</button>
      ) : null}

      {!manage && j.status === "ready_to_ship" && !j.declaredAt ? (
        <div className="card">
          <h3>Beyan (sağlam / fire / kullanılmayan)</h3>
          <div className="row">
            <label className="field">Sağlam<input inputMode="decimal" value={declareForm.goodQty} onChange={(e) => setDeclareForm({ ...declareForm, goodQty: e.target.value })} /></label>
            <label className="field">Fire<input inputMode="decimal" value={declareForm.scrapQty} onChange={(e) => setDeclareForm({ ...declareForm, scrapQty: e.target.value })} /></label>
            <label className="field">Kullanılmayan<input inputMode="decimal" value={declareForm.unusedQty} onChange={(e) => setDeclareForm({ ...declareForm, unusedQty: e.target.value })} /></label>
          </div>
          <button onClick={() => declare.mutate()} disabled={declare.isPending}>Beyanı gönder</button>
          <ErrorNotice error={declare.error} />
        </div>
      ) : null}
      {j.declaredAt ? <p className="muted">Beyan: sağlam {j.declaredGoodQty}, fire {j.declaredScrapQty}, kullanılmayan {j.declaredUnusedQty} — {fmtDate(j.declaredAt)}</p> : null}
      {j.acceptedAt ? <p className="notice ok">Şirketin kesin kabulü: {j.acceptedGoodQty} adet — {fmtDate(j.acceptedAt)}</p> : null}

      <div className="card">
        <h3>Dosyalar (fotoğraf, video, test raporu, teslim belgesi)</h3>
        <div className="row">
          <select onChange={(e) => (e.target as any).dataset.kind = e.target.value} defaultValue="photo" id={`kind-${id}`}>
            <option value="photo">Fotoğraf</option>
            <option value="video">Video</option>
            <option value="test_report">Test raporu</option>
            <option value="delivery_doc">Teslim belgesi</option>
          </select>
          <input type="file" onChange={(e) => onPickFile(e, (document.getElementById(`kind-${id}`) as HTMLSelectElement)?.value ?? "photo")} />
          {file ? <button onClick={() => upload.mutate()} disabled={upload.isPending}>Yükle: {file.name}</button> : null}
        </div>
        <ErrorNotice error={upload.error} />
        {files.data?.length ? (
          <ul>{files.data.map((f) => (
            <li key={f.id}><a href={`/api/subcontract-jobs/${id}/files/${f.id}`} target="_blank" rel="noreferrer">{f.fileName}</a> <span className="muted">({f.kind}, {fmtDate(f.createdAt)})</span></li>
          ))}</ul>
        ) : <p className="muted">Dosya yok.</p>}
      </div>

      {manage && ["accepted", "prep", "in_production", "testing"].includes(j.status) ? <MaterialTransfer id={id} onDone={refresh} /> : null}
      {manage && ["testing", "ready_to_ship"].includes(j.status) ? <AcceptOutput id={id} onDone={refresh} /> : null}
    </section>
  );
}

function MaterialTransfer({ id, onDone }: { id: string; onDone: () => void }) {
  const [f, setF] = useState({ itemId: "", lotId: "", qty: "" });
  const send = useMutation({ mutationFn: () => post(`/api/subcontract-jobs/${id}/transfer-material`, f), onSuccess: () => { setF({ itemId: "", lotId: "", qty: "" }); onDone(); } });
  const [ret, setRet] = useState({ itemId: "", lotId: "", qty: "", kind: "scrap" });
  const returnMat = useMutation({ mutationFn: () => post(`/api/subcontract-jobs/${id}/return-material`, ret), onSuccess: () => { setRet({ ...ret, qty: "" }); onDone(); } });
  return (
    <div className="card">
      <h3>Malzeme gönder / iade al</h3>
      <p className="muted">Kalem ve lot kimliği (UUID) — Depo & Lot sayfasından bulunabilir.</p>
      <div className="row">
        <input placeholder="Kalem ID" value={f.itemId} onChange={(e) => setF({ ...f, itemId: e.target.value })} />
        <input placeholder="Lot ID" value={f.lotId} onChange={(e) => setF({ ...f, lotId: e.target.value })} />
        <input placeholder="Miktar" inputMode="decimal" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} />
        <button onClick={() => send.mutate()} disabled={send.isPending}>Fasona gönder</button>
      </div>
      <ErrorNotice error={send.error} />
      <div className="row">
        <input placeholder="Kalem ID" value={ret.itemId} onChange={(e) => setRet({ ...ret, itemId: e.target.value })} />
        <input placeholder="Lot ID" value={ret.lotId} onChange={(e) => setRet({ ...ret, lotId: e.target.value })} />
        <input placeholder="Miktar" inputMode="decimal" value={ret.qty} onChange={(e) => setRet({ ...ret, qty: e.target.value })} />
        <select value={ret.kind} onChange={(e) => setRet({ ...ret, kind: e.target.value })}><option value="scrap">Fire (imha)</option><option value="unused">Kullanılmayan (iade)</option></select>
        <button onClick={() => returnMat.mutate()} disabled={returnMat.isPending}>Uygula</button>
      </div>
      <ErrorNotice error={returnMat.error} />
    </div>
  );
}

function AcceptOutput({ id, onDone }: { id: string; onDone: () => void }) {
  const [f, setF] = useState({ itemId: "", lotNo: "", qty: "" });
  const accept = useMutation({ mutationFn: () => post(`/api/subcontract-jobs/${id}/accept-output`, f), onSuccess: onDone });
  return (
    <div className="card">
      <h3>Bitmiş çıktının kesin kabulü</h3>
      <p className="muted">Yeni bir lot açılır ve giriş kalite kontrolüne girer; dış firmanın beyanından ayrı, şirketin kesin kararıdır.</p>
      <div className="row">
        <input placeholder="Çıktı kalem ID" value={f.itemId} onChange={(e) => setF({ ...f, itemId: e.target.value })} />
        <input placeholder="Yeni lot no" value={f.lotNo} onChange={(e) => setF({ ...f, lotNo: e.target.value })} />
        <input placeholder="Miktar" inputMode="decimal" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} />
        <button onClick={() => accept.mutate()} disabled={accept.isPending}>Kesin kabul (işi tamamla)</button>
      </div>
      <ErrorNotice error={accept.error} />
    </div>
  );
}

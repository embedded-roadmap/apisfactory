import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, newKey, post } from "../lib/api";
import { ErrorNotice, useCan } from "../lib/ui";

/** Depo: Ar-Ge projesine stoktan çıkış / iade (proje bütçesi ve harcaması depoya gösterilmez). */
export function RdMaterialIssue() {
  const can = useCan();
  const qc = useQueryClient();
  const projects = useQuery({ queryKey: ["rdProjectsForIssue"], queryFn: () => get<any[]>("/api/rd-projects/open-for-issue"), enabled: can("inventory.issue") });
  const [f, setF] = useState({ projectId: "", lotCode: "", qty: "", kind: "issue" as "issue" | "return", note: "" });
  const [done, setDone] = useState<string | null>(null);
  const act = useMutation({
    mutationFn: async () => {
      const lot = (await get<any[]>(`/api/lots/lookup?code=${encodeURIComponent(f.lotCode)}`))[0];
      if (!lot) throw new Error(`Lot bulunamadı: ${f.lotCode}`);
      const path = f.kind === "issue" ? "material-issues" : "material-returns";
      await post(`/api/rd-projects/${f.projectId}/${path}`, { lotId: lot.id, qty: f.qty, note: f.note || undefined }, { "idempotency-key": newKey() });
      return `${f.kind === "issue" ? "Çıkış" : "İade"}: ${f.lotCode} × ${f.qty}`;
    },
    onSuccess: (msg) => { setDone(msg); setF({ ...f, lotCode: "", qty: "", note: "" }); qc.invalidateQueries(); },
  });
  if (!can("inventory.issue")) return null;
  return (
    <section className="card">
      <h2>Ar-Ge projesine malzeme çıkışı / iadesi</h2>
      <p className="muted" style={{ margin: 0 }}>Stoktan karşılanan proje talepleri için (görev listesinde "Ar-Ge projesine stoktan çıkış"). Yalnız kullanılabilir stoktan, ayrılmamış miktar çıkılır; Ar-Ge maliyetine lot maliyetiyle girer.</p>
      <form className="row" onSubmit={(e: FormEvent) => { e.preventDefault(); setDone(null); act.mutate(); }}>
        <label className="field">Proje
          <select aria-label="Ar-Ge projesi" required value={f.projectId} onChange={(e) => setF({ ...f, projectId: e.target.value })}>
            <option value="" disabled>Seç</option>{projects.data?.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
          </select>
        </label>
        <label className="field">İşlem
          <select aria-label="Çıkış veya iade" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as "issue" | "return" })}>
            <option value="issue">Çıkış</option><option value="return">İade (kullanılmayan)</option>
          </select>
        </label>
        <label className="field">Lot kodu<input aria-label="Proje lot kodu" required value={f.lotCode} onChange={(e) => setF({ ...f, lotCode: e.target.value })} /></label>
        <label className="field" style={{ width: 100 }}>Miktar<input aria-label="Proje çıkış miktarı" required inputMode="decimal" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></label>
        <label className="field" style={{ flex: 1 }}>Not{f.kind === "return" ? " (zorunlu)" : ""}<input aria-label="Proje çıkış notu" required={f.kind === "return"} minLength={f.kind === "return" ? 3 : undefined} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
        <button className="primary" style={{ alignSelf: "flex-end" }} disabled={act.isPending}>Kaydet</button>
      </form>
      {done ? <div className="notice">{done} kaydedildi.</div> : null}
      <ErrorNotice error={act.error} />
    </section>
  );
}

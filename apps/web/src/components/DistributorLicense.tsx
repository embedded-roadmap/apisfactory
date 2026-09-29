import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "../lib/api";
import { ErrorNotice, useCan } from "../lib/ui";

export const LICENSE_LABEL: Record<string, string> = {
  multi_tenant: "Çok müşterili kullanım", display: "Gösterim", cache: "Önbellek", history: "Tarihçe",
  derived_analysis: "Türetilmiş analiz (risk taraması)", export: "Dışa aktarım", account_pricing: "Özel hesap fiyatı", ai_processing: "AI işleme",
};
const LIVE_REQUIRED = ["multi_tenant", "display", "cache"];
const STATUS_LABEL: Record<string, string> = { allowed: "izinli", denied: "yasak", unknown: "bilinmiyor" };

/** Liste hücresi için kısa lisans durumu. */
export function licenseSummary(license: any | null) {
  if (!license) return "lisans teyidi yok";
  const missing = LIVE_REQUIRED.filter((k) => license.permissions?.[k] !== "allowed");
  return missing.length ? `lisans v${license.versionNo}: canlı için eksik (${missing.map((k) => LICENSE_LABEL[k]).join(", ")})` : `lisans v${license.versionNo}: canlı izinli`;
}

/** W03 — yazılı lisans teyidi: sekiz izin + belge referansı; canlı mod bunsuz açılmaz. Yalnız yönetici (workflow.manage). */
export function DistributorLicense({ connector, onSaved }: { connector: any; onSaved: () => void }) {
  const can = useCan();
  const qc = useQueryClient();
  const hist = useQuery({ queryKey: ["distLicense", connector.id], queryFn: () => get<any[]>(`/api/distributors/${connector.id}/license`) });
  const base = connector.license?.permissions ?? Object.fromEntries(Object.keys(LICENSE_LABEL).map((k) => [k, "unknown"]));
  const [perm, setPerm] = useState<Record<string, string>>(base);
  const [f, setF] = useState({ cacheMaxMinutes: connector.license?.cacheMaxMinutes ? String(connector.license.cacheMaxMinutes) : "", documentRef: "", note: "" });
  const save = useMutation({
    mutationFn: () => post<any>(`/api/distributors/${connector.id}/license`, {
      permissions: perm, cacheMaxMinutes: f.cacheMaxMinutes ? Number(f.cacheMaxMinutes) : null, documentRef: f.documentRef, note: f.note || undefined,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["distLicense", connector.id] }); onSaved(); },
  });
  return (
    <div style={{ marginTop: 12 }}>
      <h3>Lisans teyidi (W03)</h3>
      <p className="muted" style={{ margin: 0 }}>
        API anahtarı almak ticari gösterim izni demek değildir. Canlı mod için {LIVE_REQUIRED.map((k) => LICENSE_LABEL[k]).join(", ")} sağlayıcıdan yazılı olarak "izinli" teyit edilmelidir.
        Tarihçe ve türetilmiş analiz izni yoksa bu distribütörün teklifleri tedarik riski taramasına girmez; önbellek süresi sınırı verilirse ayar bu sınırı aşamaz.
      </p>
      {hist.data?.length ? (
        <table>
          <thead><tr><th>Sürüm</th>{Object.keys(LICENSE_LABEL).map((k) => <th key={k}>{LICENSE_LABEL[k]}</th>)}<th>Önbellek sınırı</th><th>Belge</th><th>Kim</th></tr></thead>
          <tbody>{hist.data.map((h) => (
            <tr key={h.id}>
              <td>v{h.versionNo}{h.current ? " (geçerli)" : ""}</td>
              {Object.keys(LICENSE_LABEL).map((k) => <td key={k}>{STATUS_LABEL[h.permissions[k]] ?? "?"}</td>)}
              <td>{h.cacheMaxMinutes ? `${h.cacheMaxMinutes} dk` : "—"}</td><td>{h.documentRef}</td><td className="muted">{h.confirmedBy}</td>
            </tr>
          ))}</tbody>
        </table>
      ) : <p className="muted">Teyit yok.</p>}
      {can("workflow.manage") ? (
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
          <div className="row" style={{ flexWrap: "wrap" }}>
            {Object.keys(LICENSE_LABEL).map((k) => (
              <label key={k} className="field">{LICENSE_LABEL[k]}
                <select aria-label={`Lisans: ${LICENSE_LABEL[k]}`} value={perm[k] ?? "unknown"} onChange={(e) => setPerm({ ...perm, [k]: e.target.value })}>
                  <option value="unknown">bilinmiyor</option><option value="allowed">izinli</option><option value="denied">yasak</option>
                </select>
              </label>
            ))}
          </div>
          <div className="row">
            <label className="field" style={{ width: 150 }}>Önbellek sınırı (dk)<input aria-label="Önbellek sınırı" inputMode="numeric" placeholder="boş = sınırsız" value={f.cacheMaxMinutes} onChange={(e) => setF({ ...f, cacheMaxMinutes: e.target.value })} /></label>
            <label className="field" style={{ flex: 1 }}>Belge referansı (sözleşme / e-posta)<input aria-label="Lisans belge referansı" required minLength={3} value={f.documentRef} onChange={(e) => setF({ ...f, documentRef: e.target.value })} /></label>
            <label className="field" style={{ flex: 1 }}>Not<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
            <button className="primary" style={{ alignSelf: "flex-end" }} disabled={save.isPending}>Teyidi kaydet</button>
          </div>
          {save.data?.leftLiveMode ? <div className="notice warn">Yeni teyit canlı mod şartlarını karşılamadığı için bağlayıcı canlıdan çıkarıldı.</div> : null}
        </form>
      ) : null}
      <ErrorNotice error={save.error} />
    </div>
  );
}

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { post } from "../lib/api";
import { ErrorNotice } from "../lib/ui";

/** Bağlayıcı (e-belge entegratörü, kargo firması) ortak ekran parçaları — oturum 41. */

export const MODE_LABEL: Record<string, [string, string]> = {
  not_connected: ["BAĞLANMADI", ""], test: ["TEST", "warn"], portal: ["PORTAL", "ok"], manual: ["ELLE", "ok"], live: ["CANLI", "ok"],
};
export const ENV_LABEL: Record<string, string> = { sandbox: "test ortamı", production: "üretim" };

export function ModeBadge({ mode }: { mode: string }) {
  const [label, cls] = MODE_LABEL[mode] ?? [mode, ""];
  return <span className={`badge ${cls}`}>{label}</span>;
}

/**
 * Mod seçici: CANLI yalnız gerçek adaptörü olan ve erişim bilgisi kayıtlı bağlayıcıda seçilebilir.
 * API'siz her sağlayıcı için elle çalışan resmi yol: e-belgede PORTAL (XML'i entegratör portalına yükle), kargoda ELLE (takip no gir).
 */
export function ModeOptions({ c, kind }: { c: { adapterAvailable?: boolean; hasCredentials?: boolean }; kind: "einvoice" | "cargo" }) {
  const why = !c.adapterAvailable ? " (gerçek bağlantı geliştirilmedi)" : !c.hasCredentials ? " (önce erişim bilgisi)" : "";
  return (
    <>
      <option value="not_connected">BAĞLANMADI</option>
      <option value="test">TEST</option>
      {kind === "einvoice" ? <option value="portal">PORTAL — XML'i entegratör portalına yükle</option> : <option value="manual">ELLE — kayıt firmanın sisteminde, takip no girilir</option>}
      <option value="live" disabled={!c.adapterAvailable || !c.hasCredentials}>CANLI{why}</option>
    </>
  );
}

/** Adaptör rozeti: yayımlanmış belgeden yazılıp gerçek hesapla denenmemiş adaptör "doğrulanmadı" olarak gösterilir. */
export function AdapterBadge({ c, extra = "" }: { c: { adapterVerified?: boolean | null; adapterDocsUrl?: string | null }; extra?: string }) {
  return (
    <>
      {c.adapterVerified === false
        ? <span className="badge warn" title="Yayımlanmış API belgesinden yazıldı; gerçek bir hesapla henüz denenmedi">var · doğrulanmadı{extra}</span>
        : <span className="badge ok">var{extra}</span>}
      {c.adapterDocsUrl ? <> <a href={c.adapterDocsUrl} target="_blank" rel="noopener noreferrer">belge</a></> : null}
    </>
  );
}

/** Listede olmayan sağlayıcıyı ekleme (entegratör / kargo firması). */
export function AddCustomConnector({ basePath, queryKey, label }: { basePath: string; queryKey: string; label: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [reason, setReason] = useState("");
  const add = useMutation({
    mutationFn: () => post(`${basePath}/custom`, { name, reason }),
    onSuccess: () => { setOpen(false); setName(""); setReason(""); qc.invalidateQueries({ queryKey: [queryKey] }); },
  });
  if (!open) return <button onClick={() => setOpen(true)}>+ Listede olmayan {label}</button>;
  return (
    <div className="stack">
      <ErrorNotice error={add.error} />
      <div className="row" style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
        <label className="field">Ad<input aria-label={`Yeni ${label} adı`} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field" style={{ flex: 1 }}>Gerekçe<input aria-label={`Yeni ${label} gerekçesi`} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <button className="primary" disabled={name.trim().length < 2 || reason.trim().length < 3 || add.isPending} onClick={() => add.mutate()}>Ekle</button>
        <button onClick={() => setOpen(false)}>Vazgeç</button>
      </div>
    </div>
  );
}

/**
 * Erişim bilgisi formu: yalnız yazılır, sunucu şifreli saklar ve hiçbir zaman geri göstermez.
 * Adaptör alanları tanımlıysa (credentialFields) onlar sorulur; değilse serbest alan adı/değer çiftleri girilir.
 */
export function ConnectorCredentialsForm({ basePath, connector: c, onSaved }: { basePath: string; connector: any; onSaved: () => void }) {
  const known: string[] | null = c.credentialFields;
  const [environment, setEnvironment] = useState<string>(c.environment ?? "sandbox");
  const [values, setValues] = useState<Record<string, string>>({});
  const [extra, setExtra] = useState([{ k: "", v: "" }]);
  const [reason, setReason] = useState("");
  const credentials = known
    ? Object.fromEntries(known.map((f) => [f, values[f] ?? ""]))
    : Object.fromEntries(extra.filter((x) => x.k.trim() && x.v).map((x) => [x.k.trim(), x.v]));
  const complete = Object.keys(credentials).length > 0 && Object.values(credentials).every(Boolean);
  const save = useMutation({ mutationFn: () => post(`${basePath}/${c.id}/credentials`, { environment, credentials, reason }), onSuccess: onSaved });
  return (
    <div className="stack" style={{ marginTop: 12 }}>
      <h4 style={{ margin: 0 }}>Erişim bilgisi {c.hasCredentials ? <span className="badge ok">kayıtlı</span> : null}</h4>
      <p className="muted" style={{ margin: 0 }}>Sağlayıcının verdiği kullanıcı/parola, müşteri kodu veya API anahtarı. Şifreli saklanır; kaydedildikten sonra hiçbir ekranda gösterilmez — değiştirmek için yeniden girin.</p>
      <ErrorNotice error={save.error} />
      <div className="row" style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
        <label className="field">Ortam
          <select aria-label="Sağlayıcı ortamı" value={environment} onChange={(e) => setEnvironment(e.target.value)}>
            <option value="sandbox">Test ortamı (sandbox)</option>
            <option value="production">Üretim</option>
          </select>
        </label>
        {known
          ? known.map((f) => (
              <label key={f} className="field">{f}<input aria-label={`Erişim bilgisi ${f}`} type="password" autoComplete="off" value={values[f] ?? ""} onChange={(e) => setValues({ ...values, [f]: e.target.value })} /></label>
            ))
          : extra.map((x, i) => (
              <div key={i} className="row" style={{ gap: 6 }}>
                <input aria-label="Alan adı" placeholder="alan (ör. username)" value={x.k} onChange={(e) => setExtra(extra.map((y, j) => (j === i ? { ...y, k: e.target.value } : y)))} />
                <input aria-label="Alan değeri" type="password" autoComplete="off" placeholder="değer" value={x.v} onChange={(e) => setExtra(extra.map((y, j) => (j === i ? { ...y, v: e.target.value } : y)))} />
              </div>
            ))}
        {!known && extra.length < 10 ? <button type="button" onClick={() => setExtra([...extra, { k: "", v: "" }])}>+ alan</button> : null}
        <label className="field" style={{ flex: 1 }}>Gerekçe<input aria-label="Erişim bilgisi gerekçesi" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <button className="primary" disabled={!complete || reason.trim().length < 3 || save.isPending} onClick={() => save.mutate()}>Erişim bilgisini kaydet</button>
      </div>
    </div>
  );
}

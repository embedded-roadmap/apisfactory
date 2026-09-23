import { useState } from "react";
import Papa from "papaparse";
import type { ImportPreview } from "@apisfactory/shared";
import { ErrorNotice, StateBadge } from "../lib/ui";

export type FieldDef = { key: string; label: string; required?: boolean; guesses: string[] };

/**
 * Ortak içe aktarım sihirbazı (prompt §21): dosya seç → başlıkları oku → kolon eşleştir → sunucu önizlemesi → onay.
 * Doğrulama sunucuda yapılır; istemci yalnızca başlıkları okur.
 */
export function CsvWizard(props: {
  fields: FieldDef[];
  onPreview: (args: { fileName: string; content: string; mapping: Record<string, string>; decimalSeparator: "." | "," }) => Promise<ImportPreview>;
  onCommit: (jobId: string, resolutions: Record<string, string>) => Promise<unknown>;
  resolveOptions?: (row: ImportPreview["rows"][number]) => Promise<{ id: string; label: string }[]>;
  columns: string[];
}) {
  const [file, setFile] = useState<{ name: string; content: string; headers: string[] } | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [sep, setSep] = useState<"." | ",">(".");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  const [options, setOptions] = useState<Record<string, { id: string; label: string }[]>>({});
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function onFile(f: File) {
    const content = await f.text();
    const parsed = Papa.parse<Record<string, string>>(content.replace(/^﻿/, ""), { header: true, preview: 5, delimitersToGuess: [",", ";", "\t"] });
    const headers = (parsed.meta.fields ?? []).map((h) => h.trim());
    const auto: Record<string, string> = {};
    for (const fd of props.fields) {
      const hit = headers.find((h) => fd.guesses.some((g) => h.toLowerCase() === g.toLowerCase()));
      if (hit) auto[fd.key] = hit;
    }
    setFile({ name: f.name, content, headers });
    setMapping(auto);
    setSep(/\d,\d/.test(content) && !/\d\.\d/.test(content) ? "," : ".");
    setPreview(null);
    setResult(null);
    setError(null);
  }

  async function runPreview() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const p = await props.onPreview({ fileName: file.name, content: file.content, mapping, decimalSeparator: sep });
      setPreview(p);
      if (props.resolveOptions) {
        const o: Record<string, { id: string; label: string }[]> = {};
        for (const r of p.rows.filter((x) => x.status === "ambiguous")) o[r.row] = await props.resolveOptions(r);
        setOptions(o);
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await props.onCommit(preview.jobId, resolutions));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const missingRequired = props.fields.some((f) => f.required && !mapping[f.key]);
  const unresolved = preview ? preview.rows.filter((r) => r.status === "ambiguous" && !resolutions[r.row]).length : 0;

  return (
    <div className="stack">
      <section className="card">
        <h3>1. Dosya</h3>
        <input type="file" accept=".csv,.txt,.tsv" aria-label="CSV dosyası" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
        <p className="muted" style={{ margin: 0 }}>Excel dosyasını CSV olarak kaydedin. Altium/KiCad BOM dışa aktarımları CSV olarak alınır.</p>
      </section>
      {file ? (
        <section className="card">
          <h3>2. Kolon eşleştirme</h3>
          <div className="grid4">
            {props.fields.map((f) => (
              <label key={f.key} className="field">
                {f.label}{f.required ? " *" : ""}
                <select value={mapping[f.key] ?? ""} onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value })}>
                  <option value="">— kullanılmıyor —</option>
                  {file.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              </label>
            ))}
            <label className="field">
              Ondalık ayırıcı
              <select value={sep} onChange={(e) => setSep(e.target.value as "." | ",")}>
                <option value=".">Nokta (1234.5)</option>
                <option value=",">Virgül (1.234,5)</option>
              </select>
            </label>
          </div>
          <div><button className="primary" disabled={missingRequired || busy} onClick={runPreview}>Önizle</button></div>
        </section>
      ) : null}
      <ErrorNotice error={error} />
      {preview ? (
        <section className="card">
          <div className="row between">
            <h3>3. Önizleme</h3>
            <div className="row muted">
              {preview.summary.total} satır · {preview.summary.ok} eşleşti · {preview.summary.newItems} yeni · {preview.summary.ambiguous} belirsiz · {preview.summary.errors} hatalı
            </div>
          </div>
          {preview.duplicateOf ? <div className="notice warn">Bu dosya daha önce işlenmiş. Onaylansa bile kayıtlar çoğaltılmaz; sunucu reddeder.</div> : null}
          <table>
            <thead><tr><th>Satır</th><th>Durum</th>{props.columns.map((c) => <th key={c}>{c}</th>)}<th>Mesaj / çözüm</th></tr></thead>
            <tbody>
              {preview.rows.map((r) => (
                <tr key={r.row}>
                  <td>{r.row}</td>
                  <td><StateBadge value={r.status} prefix="import" /></td>
                  {props.columns.map((c) => <td key={c} className="mono">{r.values[c]}</td>)}
                  <td>
                    {r.messages.join("; ")}
                    {r.status === "ambiguous" ? (
                      <select aria-label={`Satır ${r.row} için kalem seç`} value={resolutions[r.row] ?? ""} onChange={(e) => setResolutions({ ...resolutions, [r.row]: e.target.value })}>
                        <option value="">Kalem seçin…</option>
                        {(options[r.row] ?? []).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                      </select>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row">
            <button className="primary" disabled={busy || preview.summary.errors > 0 || unresolved > 0 || !!result} onClick={commit}>Onayla ve işle</button>
            {preview.summary.errors > 0 ? <span className="muted">Hatalı satırları dosyada düzeltip tekrar yükleyin.</span> : null}
            {unresolved > 0 ? <span className="muted">{unresolved} belirsiz satır için kalem seçin.</span> : null}
          </div>
        </section>
      ) : null}
      {result ? <div className="notice ok" role="status">İşlendi: <span className="mono">{JSON.stringify(result)}</span></div> : null}
    </div>
  );
}

import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "../lib/api";
import { Empty, ErrorNotice, Loading, PageHeader, fmtDate } from "../lib/ui";
import { Discussion } from "../components/Discussion";

/** W27 devamı — herhangi bir iş kaydına bağlı olmayan, tüm çalışanların görebildiği serbest konuşma kanalları. */
export function ChannelsPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["channels"], queryFn: () => get<any[]>("/api/channels") });
  const [show, setShow] = useState(false);
  const [f, setF] = useState({ name: "", description: "" });
  const create = useMutation({
    mutationFn: () => post<any>("/api/channels", { name: f.name, description: f.description || undefined }),
    onSuccess: (c) => { qc.invalidateQueries({ queryKey: ["channels"] }); nav(`/collaboration/channels/${c.id}`); },
  });
  const active = q.data?.filter((c) => !c.archivedAt) ?? [];
  const archived = q.data?.filter((c) => c.archivedAt) ?? [];
  return (
    <>
      <PageHeader title="Kanallar" sub="Herhangi bir iş kaydına bağlı olmayan, tüm çalışanların görebildiği serbest konuşma odaları." actions={<button className="primary" onClick={() => setShow(!show)}>Yeni kanal</button>} />
      {show ? (
        <form className="card" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <ErrorNotice error={create.error} />
          <label className="field">Ad<input required minLength={2} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label className="field">Açıklama<input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
          <button className="primary" disabled={create.isPending}>Oluştur</button>
        </form>
      ) : null}
      <section className="card">
        {q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />}
        {q.data && !active.length ? <Empty>Henüz kanal yok.</Empty> : null}
        <table>
          <tbody>{active.map((c) => (
            <tr key={c.id} className="click" onClick={() => nav(`/collaboration/channels/${c.id}`)}>
              <td><b>{c.name}</b> <span className="mono muted">{c.code}</span></td>
              <td className="muted">{c.description}</td>
              <td className="muted">{c.lastMessageAt ? `son mesaj ${fmtDate(c.lastMessageAt)}` : `oluşturan ${c.createdBy}`}</td>
            </tr>
          ))}</tbody>
        </table>
      </section>
      {archived.length ? (
        <section className="card">
          <h2>Arşivlenmiş</h2>
          <table>
            <tbody>{archived.map((c) => (
              <tr key={c.id} className="click" onClick={() => nav(`/collaboration/channels/${c.id}`)}>
                <td><span className="muted">{c.name}</span> <span className="mono muted">{c.code}</span></td>
                <td className="muted">{c.description}</td>
                <td><span className="badge">arşivlendi</span></td>
              </tr>
            ))}</tbody>
          </table>
        </section>
      ) : null}
    </>
  );
}

export function ChannelPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["channels"], queryFn: () => get<any[]>("/api/channels") });
  const [reason, setReason] = useState("");
  const archive = useMutation({
    mutationFn: () => post(`/api/channels/${id}/archive`, { reason }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["channels"] }),
  });
  const c = q.data?.find((x) => x.id === id);
  if (!c) return q.isLoading ? <Loading /> : <ErrorNotice error={q.error} />;
  return (
    <>
      <PageHeader title={c.name} sub={<>{c.description} · <span className="mono">{c.code}</span></>} actions={c.archivedAt ? <span className="badge">arşivlendi</span> : null} />
      <ErrorNotice error={archive.error} />
      {!c.archivedAt ? (
        <section className="card">
          <div className="row" style={{ alignItems: "flex-end" }}>
            <label className="field" style={{ flex: 1 }}>Arşivleme gerekçesi<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
            <button className="danger" disabled={reason.trim().length < 3 || archive.isPending} onClick={() => archive.mutate()}>Kanalı arşivle</button>
          </div>
          <p className="muted" style={{ margin: 0 }}>Yalnız oluşturan veya görev yönetimi yetkisi olan kişi arşivler. Arşivlenen kanalın geçmişi kalır ve listede ayrı gösterilir; mesajlaşma kapanmaz.</p>
        </section>
      ) : null}
      <Discussion entityType="channel" entityId={c.id} />
    </>
  );
}

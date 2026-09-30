import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, get, openDownload, post } from "../lib/api";
import { ErrorNotice, Loading, PageHeader, StateBadge, useCan, useMe } from "../lib/ui";

export function AdminPage() {
  const qc = useQueryClient();
  const { me } = useMe();
  const can = useCan();
  const [exporting, setExporting] = useState(false);
  const users = useQuery({ queryKey: ["admin-users"], queryFn: () => get<any[]>("/api/admin/users") });
  const roles = useQuery({ queryKey: ["admin-roles"], queryFn: () => get<any[]>("/api/admin/roles") });
  const [f, setF] = useState({ email: "", name: "", role: "technician" });
  const [created, setCreated] = useState<{ email: string; password: string | null } | null>(null);
  const invite = useMutation({
    mutationFn: () => post<any>("/api/admin/users", { email: f.email, name: f.name, roles: [f.role] }),
    onSuccess: (r) => { setCreated({ email: f.email, password: r.temporaryPassword }); setF({ ...f, email: "", name: "" }); qc.invalidateQueries({ queryKey: ["admin-users"] }); },
  });
  const act = useMutation({ mutationFn: (fn: () => Promise<unknown>) => fn(), onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-users"] }) });

  return (
    <>
      <PageHeader title="Kullanıcılar & roller" sub="Yetki değişiklikleri işlem geçmişine yazılır. Kimse kendi rolünü değiştiremez." />
      <form className="card" onSubmit={(e: FormEvent) => { e.preventDefault(); invite.mutate(); }}>
        <h2>Kullanıcı ekle</h2>
        <ErrorNotice error={invite.error} />
        {created ? (
          <div className="notice ok" role="status">
            {created.email} eklendi.{" "}
            {created.password ? <>Geçici parola (yalnızca bir kez gösterilir): <b className="mono">{created.password}</b>. E-posta bağlayıcısı bağlı olmadığı için kullanıcıya siz iletin.</> : "Kullanıcının mevcut hesabı şirkete bağlandı; parolası değişmedi."}
          </div>
        ) : null}
        <div className="grid4">
          <label className="field">E-posta<input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
          <label className="field">Ad soyad<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label className="field">Rol
            <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
              {roles.data?.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
            </select>
          </label>
          <button className="primary" style={{ alignSelf: "flex-end" }} disabled={invite.isPending}>Ekle</button>
        </div>
      </form>
      <ErrorNotice error={act.error} />
      <section className="card">
        {users.isLoading ? <Loading /> : <ErrorNotice error={users.error} />}
        <table>
          <thead><tr><th>Kullanıcı</th><th>Roller</th><th>Durum</th><th /></tr></thead>
          <tbody>
            {users.data?.map((u) => (
              <UserRow key={u.membershipId} u={u} roles={roles.data ?? []} self={u.userId === me?.user.id} act={(fn) => act.mutate(fn)} />
            ))}
          </tbody>
        </table>
      </section>
      {can("company.data.export") ? (
        <section className="card">
          <h2>Şirketin tam veri ve dosya çıkış paketi</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Şirket kapsamındaki tüm tabloların kayıtları, üye kimlikleri (parola hariç), mesaj/fason dosya ekleri ve bir veri sözlüğü tek bir ZIP'te indirilir.
            Bu indirme işlem geçmişine (olaylar) kaydedilir.
          </p>
          <button disabled={exporting} onClick={async () => { setExporting(true); try { await openDownload("/api/company/export", `sirket-veri-paketi-${new Date().toISOString().slice(0, 10)}.zip`, "application/zip"); } finally { setExporting(false); } }}>
            {exporting ? "Hazırlanıyor…" : "Veri paketini indir (.zip)"}
          </button>
        </section>
      ) : null}
    </>
  );
}

function UserRow({ u, roles, self, act }: { u: any; roles: any[]; self: boolean; act: (fn: () => Promise<unknown>) => void }) {
  const [sel, setSel] = useState<string[]>(u.roles);
  const [reason, setReason] = useState("");
  const changed = sel.slice().sort().join() !== u.roles.slice().sort().join();
  return (
    <tr>
      <td><b>{u.name}</b><div className="muted">{u.email}</div></td>
      <td>
        <div className="row" style={{ gap: 6 }}>
          {roles.map((r) => (
            <label key={r.code} className="row" style={{ gap: 4, fontSize: 13 }}>
              <input type="checkbox" style={{ minHeight: 0 }} disabled={self} checked={sel.includes(r.code)} onChange={(e) => setSel(e.target.checked ? [...sel, r.code] : sel.filter((x) => x !== r.code))} />
              {r.name}
            </label>
          ))}
        </div>
      </td>
      <td><StateBadge value={u.status === "active" ? "approved" : "suspended"} /></td>
      <td className="row">
        {self ? <span className="muted">Kendi hesabınız</span> : null}
        {!self && changed ? <button className="primary" onClick={() => act(() => post(`/api/admin/users/${u.membershipId}/roles`, { roles: sel }))}>Rolleri kaydet</button> : null}
        {!self ? (
          <>
            <input aria-label={`${u.name} için gerekçe`} placeholder="Gerekçe (en az 3 karakter)" value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: 200 }} />
            <button disabled={reason.trim().length < 3} onClick={() => { act(() => post(`/api/admin/users/${u.membershipId}/status`, { status: u.status === "active" ? "suspended" : "active", reason: reason.trim() })); setReason(""); }}>
              {u.status === "active" ? "Askıya al" : "Etkinleştir"}
            </button>
          </>
        ) : null}
      </td>
    </tr>
  );
}

export function PasswordPage() {
  const [f, setF] = useState({ current: "", next: "", again: "" });
  const ch = useMutation({ mutationFn: () => post("/api/auth/password", { current: f.current, next: f.next }) });
  return (
    <>
      <PageHeader title="Parola değiştir" sub="Değişiklikten sonra diğer cihazlardaki oturumlarınız sonlandırılır." />
      <form className="card" style={{ maxWidth: 480 }} onSubmit={(e) => { e.preventDefault(); if (f.next === f.again) ch.mutate(); }}>
        <ErrorNotice error={ch.error} />
        {ch.isSuccess ? <div className="notice ok">Parola değişti.</div> : null}
        <label className="field">Mevcut parola<input type="password" autoComplete="current-password" required value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></label>
        <label className="field">Yeni parola (en az 10 karakter)<input type="password" autoComplete="new-password" minLength={10} required value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} /></label>
        <label className="field">Yeni parola tekrar<input type="password" autoComplete="new-password" required value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} /></label>
        {f.again && f.next !== f.again ? <div className="notice warn">Parolalar eşleşmiyor.</div> : null}
        <button className="primary" disabled={ch.isPending}>Değiştir</button>
      </form>
      <NotifyPhoneCard />
    </>
  );
}

/** Kişinin kendi bildirim telefonu: şirket SMS açtıysa iç bildirimler (yükseltme, bahsedilme…) buraya gelir. */
function NotifyPhoneCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["notifyPhone"], queryFn: () => get<{ phone: string | null }>("/api/me/notify-phone") });
  const [v, setV] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (phone: string | null) => api<{ phone: string | null }>("PUT", "/api/me/notify-phone", { phone }),
    onSuccess: (r) => { setV(null); qc.setQueryData(["notifyPhone"], r); },
  });
  const cur = q.data?.phone ?? null;
  const shown = v ?? (cur ? `0${cur.slice(2)}` : "");
  return (
    <section className="card" style={{ maxWidth: 480 }}>
      <h2>Bildirim telefonum</h2>
      <p className="muted" style={{ margin: 0 }}>Şirketiniz SMS bildirimini açtıysa size gelen bildirimler bu numaraya da gönderilir. Numarayı yalnız siz görür ve değiştirirsiniz.</p>
      {q.isLoading ? <Loading /> : <ErrorNotice error={q.error ?? save.error} />}
      <div className="row" style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
        <label className="field" style={{ flex: 1 }}>Cep telefonu<input aria-label="Bildirim telefonu" inputMode="tel" placeholder="05xx xxx xx xx" value={shown} onChange={(e) => setV(e.target.value)} /></label>
        <button className="primary" disabled={save.isPending || !shown.trim()} onClick={() => save.mutate(shown)}>Kaydet</button>
        {cur ? <button disabled={save.isPending} onClick={() => save.mutate(null)}>Kaldır</button> : null}
      </div>
      {save.isSuccess ? <div className="notice ok">{save.data.phone ? "Kaydedildi." : "Kaldırıldı."}</div> : null}
    </section>
  );
}

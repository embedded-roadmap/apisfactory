import { auth } from "../lib/api";
import { PageHeader } from "../lib/ui";
import { readOfflineSnapshot } from "../lib/offline";

/**
 * R46 (W37 §28): "kesintide yayımlanmış talimat ve atanmış iş listesinin kontrollü çevrimdışı kopyası
 * kullanılabilsin". Bu sayfa AĞA HİÇ GİTMEZ — yalnızca `/help`'te "Çevrimdışı kopya indir ve sakla" ile
 * daha önce bu tarayıcıya kaydedilmiş `localStorage` kopyasını okur. `App.tsx`'teki `Shell`, `GET
 * /api/me` başarısız olduğunda (bağlantı kesintisi) ve yol `/offline` ise normal hata ekranı yerine
 * doğrudan bu sayfayı render eder — böylece gerçek bir kesintide de erişilebilir kalır.
 */
export function OfflinePage() {
  const companyId = auth.get().companyId;
  const stored = companyId ? readOfflineSnapshot(companyId) : null;

  if (!stored) {
    return (
      <>
        <PageHeader title="Çevrimdışı kopya" sub="Bu tarayıcıda henüz saklanmış bir çevrimdışı kopya yok." />
        <div className="card">
          <p>Bağlantınız varken "Yardım &amp; eğitim" sayfasından "Çevrimdışı kopya indir ve sakla" düğmesine basarak bir kopya oluşturabilirsiniz. Bağlantı şu an kesikse, önce bağlantınız geri geldiğinde bu adımı tamamlayın.</p>
        </div>
      </>
    );
  }

  const { snapshot, savedAt } = stored;

  return (
    <>
      <PageHeader
        title="Çevrimdışı kopya"
        sub={`Bu tarayıcıya kaydedildi: ${new Date(savedAt).toLocaleString("tr-TR")} — sunucudan alınma anı: ${new Date(snapshot.generatedAt).toLocaleString("tr-TR")}. Bu bir anlık görüntüdür, otomatik güncellenmez.`}
      />
      <div className="notice warn">Bu sayfa ağa bağlanmadan, yalnızca bu tarayıcıda saklı son kopyadan gösterilir. Gerçek/güncel veri için bağlantı geri geldiğinde normal ekranları kullanın.</div>

      <section className="card">
        <h2>Size atanmış açık işler ({snapshot.myTasks.length})</h2>
        {snapshot.myTasks.length === 0 ? (
          <p className="muted">Kopya alındığı anda size atanmış açık iş yoktu.</p>
        ) : (
          <table>
            <thead><tr><th>Başlık</th><th>Tür</th><th>Vade</th><th>Durum</th></tr></thead>
            <tbody>
              {snapshot.myTasks.map((t) => (
                <tr key={t.id}>
                  <td>{t.title}</td>
                  <td className="muted mono">{t.kind}</td>
                  <td className={t.overdue ? "bad" : undefined}>{t.dueDate ?? "—"}</td>
                  <td>{t.status}{t.overdue ? " (gecikmiş)" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Rol bazlı görev rehberleri</h2>
        <div className="grid2">
          {snapshot.roleGuides.map((g) => (
            <div key={g.role} className="card" style={{ margin: 0 }}>
              <h3 style={{ marginTop: 0 }}>{g.role}</h3>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {g.tasks.map((t, i) => <li key={i}>{t}</li>)}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>İçe/dışa aktarma yönergeleri</h2>
        <ul>{snapshot.importExportNotes.map((n, i) => <li key={i}>{n}</li>)}</ul>
      </section>

      <section className="card">
        <h2>Destek talebi politikası</h2>
        <table>
          <thead><tr><th>Öncelik</th><th>Tanım</th><th>Sorumlu</th><th>Eskalasyon</th></tr></thead>
          <tbody>
            {snapshot.supportPolicy.map((s) => (
              <tr key={s.level}><td>{s.level}</td><td>{s.desc}</td><td>{s.owner}</td><td className="muted">{s.escalation}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

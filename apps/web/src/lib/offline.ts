import type { OfflineSnapshot } from "@apisfactory/shared";

/**
 * R46 (W37 §28): "kesintide yayımlanmış talimat ve atanmış iş listesinin kontrollü çevrimdışı kopyası
 * kullanılabilsin". `/help` sayfasında indirilen `GET /api/offline/snapshot` yanıtı burada, şirket
 * bazında, tarayıcının kendi `localStorage`'ına da yazılır — bağlantı kesildiğinde `/offline` sayfası
 * ağa hiç gitmeden bu kopyadan okur. localStorage yalnızca bu tarayıcıda kalır (Claude'a asla geri
 * okunmaz); API çağrısı başarısız olursa özellik sessizce devre dışı kalır, sayfa çökmez.
 */
export const OFFLINE_SNAPSHOT_PREFIX = "apisfactory.offline_snapshot";

export type StoredOfflineSnapshot = { snapshot: OfflineSnapshot; savedAt: string; companyId: string };

export function readOfflineSnapshot(companyId: string): StoredOfflineSnapshot | null {
  try {
    const raw = localStorage.getItem(`${OFFLINE_SNAPSHOT_PREFIX}.${companyId}`);
    if (!raw) return null;
    return JSON.parse(raw) as StoredOfflineSnapshot;
  } catch {
    return null;
  }
}

export function writeOfflineSnapshot(companyId: string, snapshot: OfflineSnapshot): StoredOfflineSnapshot {
  const stored: StoredOfflineSnapshot = { snapshot, savedAt: new Date().toISOString(), companyId };
  try {
    localStorage.setItem(`${OFFLINE_SNAPSHOT_PREFIX}.${companyId}`, JSON.stringify(stored));
  } catch {
    // localStorage kullanılamıyorsa (gizli sekme, kota dolu vb.) yalnızca indirilen dosya elde kalır.
  }
  return stored;
}

export function downloadOfflineSnapshot(snapshot: OfflineSnapshot): void {
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `apisfactory-cevrimdisi-kopya-${snapshot.generatedAt.slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

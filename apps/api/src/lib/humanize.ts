import { t } from "@apisfactory/shared";

/** i18n sözlüğünde olmayan, hata mesajlarında geçen durum kodları. */
const EXTRA: Record<string, string> = {
  planned: "Planlandı",
  in_progress: "İşlemde",
  completed: "Tamamlandı",
  paused: "Duraklatıldı",
  failed: "Başarısız",
  unknown: "Belirsiz",
  problem: "Sorunlu",
  previewed: "Önizlendi",
  delivered: "Teslim edildi",
  packed: "Paketlendi",
  picking: "Hazırlanıyor",
  issued: "Kesildi",
  paid: "Tahsil edildi",
  converted: "Dönüştürüldü",
  sent: "Gönderildi",
  confirmed: "Teyitli",
  partially_received: "Kısmen teslim alındı",
  received: "Teslim alındı",
};

function label(code: string): string | null {
  for (const prefix of ["state", "dev"]) {
    const v = t("tr", `${prefix}.${code}`);
    if (v && !v.startsWith(`${prefix}.`)) return v;
  }
  return EXTRA[code] ?? null;
}

/**
 * Hata mesajındaki ham durum kodlarını Türkçe adlarıyla değiştirir: `"in_progress" durumunda` → `"İşlemde" durumunda`,
 * `(durum: scrapped)` → `(durum: Hurda)`. Sözlükte karşılığı olmayan kelimeye dokunulmaz (ürün kodu vb. bozulmaz).
 * Uçtan uca bot testi bulgusu (2026-10-05).
 */
export function humanizeStatuses(message: string): string {
  return message
    .replace(/"([a-z][a-z_]*)"/g, (m, code: string) => {
      const l = label(code);
      return l ? `"${l}"` : m;
    })
    .replace(/durum: ([a-z][a-z_]*)/g, (m, code: string) => {
      const l = label(code);
      return l ? `durum: ${l}` : m;
    });
}

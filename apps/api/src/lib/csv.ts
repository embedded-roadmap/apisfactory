import Papa from "papaparse";
import { createHash } from "node:crypto";

export function sha256(content: string): string {
  return createHash("sha256").update(content.replace(/\r\n/g, "\n").trim()).digest("hex");
}

export function parseCsv(content: string): { headers: string[]; rows: Record<string, string>[] } {
  const res = Papa.parse<Record<string, string>>(content.replace(/^﻿/, ""), {
    header: true,
    skipEmptyLines: "greedy",
    delimitersToGuess: [",", ";", "\t"],
    transformHeader: (h) => h.trim(),
  });
  return { headers: res.meta.fields ?? [], rows: res.data };
}

/** "1.234,5" veya "1,234.5" gibi değerleri seçilen ondalık ayırıcıya göre normalize eder. Geçersizse null. */
export function normalizeDecimal(raw: string | undefined, sep: "." | ","): string | null {
  if (raw == null) return null;
  let v = raw.trim().replace(/\s/g, "");
  if (!v) return null;
  if (sep === ",") v = v.replace(/\./g, "").replace(",", ".");
  else v = v.replace(/,/g, "");
  return /^-?\d+(\.\d+)?$/.test(v) ? v : null;
}

const TRUE = new Set(["1", "true", "yes", "evet", "x", "dnp", "dni", "nf"]);
export function parseFlag(raw: string | undefined): boolean {
  return raw ? TRUE.has(raw.trim().toLowerCase()) : false;
}

/** CSV/Excel formül enjeksiyonuna karşı dışa aktarımda hücre kaçışı (prompt §21). */
export function safeCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n;]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

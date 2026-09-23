/**
 * Sabit hassasiyetli miktar aritmetiği (6 ondalık, BigInt). Kayan nokta kullanılmaz (prompt §6).
 */
const SCALE = 6n;
const F = 10n ** SCALE;

export function toMicro(v: string | number | null | undefined): bigint {
  if (v == null || v === "") return 0n;
  const s = String(v).trim();
  const neg = s.startsWith("-");
  const [intPart, frac = ""] = (neg ? s.slice(1) : s).split(".");
  if (!/^\d*$/.test(intPart ?? "") || !/^\d*$/.test(frac)) throw new Error(`Geçersiz ondalık: ${s}`);
  const f = (frac + "000000").slice(0, Number(SCALE));
  const r = BigInt(intPart || "0") * F + BigInt(f || "0");
  return neg ? -r : r;
}

export function fromMicro(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const i = a / F;
  const f = (a % F).toString().padStart(Number(SCALE), "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${i}${f ? "." + f : ""}`;
}

export const min = (a: bigint, b: bigint) => (a < b ? a : b);
export const max = (a: bigint, b: bigint) => (a > b ? a : b);
/** qty × qtyPer: iki 6 ondalıklı sayının çarpımı, 6 ondalığa yukarı yuvarlanır (malzeme eksik hesaplanmaz). */
export function mul(a: bigint, b: bigint): bigint {
  const p = a * b;
  return p % F === 0n ? p / F : p / F + (p > 0n ? 1n : 0n);
}

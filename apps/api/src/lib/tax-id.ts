/**
 * Türkiye vergi kimlik numaraları — kontrol hanesi doğrulaması (şema yalnız hane sayısını kısıtlar).
 *  - VKN: 10 hane, tüzel kişiler (ve şahıs şirketleri için verilmiş vergi numaraları).
 *  - TCKN: 11 hane, gerçek kişiler; e-arşivde ve şahıs işletmelerinde VKN yerine kullanılır.
 */

const digits = (v: string) => Array.from(v, Number);

export function isValidVkn(v: string): boolean {
  if (!/^[0-9]{10}$/.test(v)) return false;
  const d = digits(v);
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const t = ((d[i] ?? 0) + 10 - (i + 1)) % 10;
    sum += t === 9 ? 9 : (t * 2 ** (10 - (i + 1))) % 9;
  }
  return (10 - (sum % 10)) % 10 === d[9];
}

export function isValidTckn(v: string): boolean {
  if (!/^[1-9][0-9]{10}$/.test(v)) return false;
  const [d1, d2, d3, d4, d5, d6, d7, d8, d9, d10, d11] = digits(v) as [number, number, number, number, number, number, number, number, number, number, number];
  const odd = d1 + d3 + d5 + d7 + d9;
  const even = d2 + d4 + d6 + d8;
  if ((((odd * 7 - even) % 10) + 10) % 10 !== d10) return false;
  return (odd + even + d10) % 10 === d11;
}

/** 10 hane → VKN, 11 hane → TCKN olarak doğrular. */
export function isValidTaxNo(v: string): boolean {
  return v.length === 10 ? isValidVkn(v) : v.length === 11 ? isValidTckn(v) : false;
}

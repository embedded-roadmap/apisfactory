import type { Db } from "../db/pool";

/**
 * Kur dönüşümü (ana talimat §6: "Para birimi, kur kaynağı/tarihi … açık tut"; §18: kur etkisi politikayla).
 * Kur, işlemin tarihine en yakın ÖNCEKİ (veya aynı gün) kayıttır; politikadaki azami yaştan eskiyse dönüştürülmez —
 * uydurma kur kullanılmaz, eksik olarak raporlanır. Doğrudan çift yoksa ters çift (1 / kur) kullanılır.
 * Tutarlar mikro birim (6 ondalık) BigInt; kur 10 ondalıkla çarpılır/bölünür, yarıya yuvarlanır.
 */

const RATE_SCALE = 10_000_000_000n; // 10 ondalık

function toRate(v: string): bigint {
  const [i, f = ""] = v.split(".");
  return BigInt(i || "0") * RATE_SCALE + BigInt((f + "0000000000").slice(0, 10));
}
function fmtRate(r: bigint): string {
  const s = `${r / RATE_SCALE}.${String(r % RATE_SCALE).padStart(10, "0")}`;
  return s.replace(/0+$/, "").replace(/\.$/, "");
}
const divRound = (a: bigint, b: bigint) => (a >= 0n ? (a + b / 2n) / b : -((-a + b / 2n) / b));

export type FxQuote = {
  from: string; to: string; rate: string; rateDate: string; source: string; inverse: boolean; ageDays: number;
};

export async function findRate(db: Db, from: string, to: string, onDate: string, maxAgeDays: number): Promise<FxQuote | { error: string }> {
  if (from === to) return { from, to, rate: "1", rateDate: onDate, source: "aynı para birimi", inverse: false, ageDays: 0 };
  const r = await db.query(
    `select base_currency, quote_currency, rate::text as rate, rate_date::text as "rateDate", source,
            ($3::date - rate_date) as age
       from exchange_rates
      where rate_date <= $3::date and ((base_currency = $1 and quote_currency = $2) or (base_currency = $2 and quote_currency = $1))
      order by rate_date desc, (base_currency = $1) desc, created_at desc limit 1`,
    [from, to, onDate],
  );
  const x = r.rows[0];
  if (!x) return { error: `${from}→${to} kuru yok (${onDate} ve öncesi)` };
  if (x.age > maxAgeDays) return { error: `${from}→${to} kuru ${x.rateDate} tarihli; ${onDate} için ${maxAgeDays} günden eski` };
  return { from, to, rate: fmtRate(toRate(x.rate)), rateDate: x.rateDate, source: x.source, inverse: x.base_currency !== from, ageDays: x.age };
}

/** Mikro birim tutarı çevirir. */
export function convertMicro(amount: bigint, q: FxQuote): bigint {
  const rate = toRate(q.rate);
  return q.inverse ? divRound(amount * RATE_SCALE, rate) : divRound(amount * rate, RATE_SCALE);
}

export function describeRate(q: FxQuote): string {
  if (q.from === q.to) return "";
  return `1 ${q.inverse ? q.to : q.from} = ${q.rate} ${q.inverse ? q.from : q.to} (${q.rateDate}, ${q.source})`;
}

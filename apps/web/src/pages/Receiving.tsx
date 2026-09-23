import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Item } from "@apisfactory/shared";
import { get, newKey, post } from "../lib/api";
import { Empty, ErrorNotice, Loading, PageHeader, StateBadge, fmt, fmtDate, useCan } from "../lib/ui";

type ReceiptRow = { id: string; code: string; supplierName: string; receivedAt: string; itemCode: string; itemName: string; mpn: string | null; lotNo: string; qty: string; inspectionStatus: string; acceptedQty: string | null; rejectedQty: string | null };

export function ReceivingPage() {
  const can = useCan();
  const qc = useQueryClient();
  const rows = useQuery({ queryKey: ["receipts"], queryFn: () => get<ReceiptRow[]>("/api/receipts") });
  const items = useQuery({ queryKey: ["items", "component"], queryFn: () => get<Item[]>("/api/items?kind=component"), enabled: can("inventory.receive") });
  const [form, setForm] = useState({ supplierName: "", itemId: "", qty: "", lotNo: "", dateCode: "" });
  // Tekrar gönderimde çift kayıt oluşmasın diye form başına tek anahtar
  const [key, setKey] = useState(newKey());
  const receive = useMutation({
    mutationFn: () =>
      post("/api/receipts", { supplierName: form.supplierName, lines: [{ itemId: form.itemId, qty: form.qty, lotNo: form.lotNo, dateCode: form.dateCode || undefined }] }, { "idempotency-key": key }),
    onSuccess: () => {
      setForm({ ...form, qty: "", lotNo: "", dateCode: "" });
      setKey(newKey());
      qc.invalidateQueries({ queryKey: ["receipts"] });
    },
  });

  return (
    <>
      <PageHeader title="Mal kabul ve giriş kalite" sub="Kabul edilen parça, kalite kararı verilene kadar üretimde kullanılamaz." />
      {can("inventory.receive") ? (
        <form className="card" onSubmit={(e: FormEvent) => { e.preventDefault(); receive.mutate(); }}>
          <h2>Yeni mal kabul</h2>
          <ErrorNotice error={receive.error} />
          <div className="grid4">
            <label className="field">Tedarikçi<input required value={form.supplierName} onChange={(e) => setForm({ ...form, supplierName: e.target.value })} /></label>
            <label className="field">Kalem
              <select required value={form.itemId} onChange={(e) => setForm({ ...form, itemId: e.target.value })}>
                <option value="">Seçin…</option>
                {items.data?.map((i) => <option key={i.id} value={i.id}>{i.code} · {i.mpn}</option>)}
              </select>
            </label>
            <label className="field">Miktar<input required inputMode="decimal" pattern="\d+(\.\d+)?" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} /></label>
            <label className="field">Lot / seri<input required value={form.lotNo} onChange={(e) => setForm({ ...form, lotNo: e.target.value })} /></label>
            <label className="field">Tarih kodu<input value={form.dateCode} onChange={(e) => setForm({ ...form, dateCode: e.target.value })} /></label>
          </div>
          <div><button className="primary" disabled={receive.isPending}>Kabul et (kontrole al)</button></div>
          {receive.isSuccess ? <div className="notice ok" role="status">Mal kabul kaydedildi; kalite görevi açıldı.</div> : null}
        </form>
      ) : null}
      <section className="card">
        <h2>Kabuller</h2>
        {rows.isLoading ? <Loading /> : <ErrorNotice error={rows.error} />}
        {rows.data?.length === 0 ? <Empty /> : null}
        {rows.data && rows.data.length > 0 ? (
          <table>
            <thead><tr><th>Kabul</th><th>Kalem</th><th>Lot</th><th className="num">Miktar</th><th>Giriş kalite</th><th /></tr></thead>
            <tbody>{rows.data.map((r) => <ReceiptLine key={r.id} r={r} />)}</tbody>
          </table>
        ) : null}
      </section>
    </>
  );
}

function ReceiptLine({ r }: { r: ReceiptRow }) {
  const can = useCan();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [acc, setAcc] = useState(r.qty);
  const [rej, setRej] = useState("0");
  const [note, setNote] = useState("");
  const decide = useMutation({
    mutationFn: () => post(`/api/receipt-lines/${r.id}/inspection`, { acceptedQty: acc, rejectedQty: rej, note: note || undefined }),
    onSuccess: () => { setOpen(false); qc.invalidateQueries({ queryKey: ["receipts"] }); },
  });
  return (
    <>
      <tr>
        <td><span className="mono">{r.code}</span><div className="muted">{r.supplierName} · {fmtDate(r.receivedAt)}</div></td>
        <td><span className="mono">{r.itemCode}</span><div className="muted">{r.mpn}</div></td>
        <td className="mono">{r.lotNo}</td>
        <td className="num">{fmt(r.qty)}</td>
        <td>
          <StateBadge value={r.inspectionStatus} prefix="insp" />
          {r.acceptedQty != null ? <div className="muted">kabul {fmt(r.acceptedQty)} / ret {fmt(r.rejectedQty)}</div> : null}
        </td>
        <td>{can("quality.incoming.decide") && r.inspectionStatus === "pending" ? <button onClick={() => setOpen(!open)}>Karar ver</button> : null}</td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={6}>
            <div className="row">
              <label className="field">Kabul<input value={acc} onChange={(e) => setAcc(e.target.value)} inputMode="decimal" /></label>
              <label className="field">Ret (karantina)<input value={rej} onChange={(e) => setRej(e.target.value)} inputMode="decimal" /></label>
              <label className="field" style={{ flex: 1 }}>Not<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
              <button className="primary" style={{ alignSelf: "flex-end" }} onClick={() => decide.mutate()} disabled={decide.isPending}>Kaydet</button>
            </div>
            <ErrorNotice error={decide.error} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

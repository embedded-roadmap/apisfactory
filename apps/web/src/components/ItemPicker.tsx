import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get } from "../lib/api";

/** Kalem seçici: kod, ad veya MPN ile arar. */
export function ItemPicker({ label, value, onChange }: { label: string; value: any | null; onChange: (i: any | null) => void }) {
  const [text, setText] = useState("");
  const q = useQuery({ queryKey: ["items", text], queryFn: () => get<any[]>(`/api/items?q=${encodeURIComponent(text)}`), enabled: text.length >= 2 && !value });
  if (value) return <div className="field">{label}<div><b className="mono">{value.code}</b> {value.name} <button type="button" className="link" onClick={() => onChange(null)}>değiştir</button></div></div>;
  return (
    <label className="field">{label}
      <input aria-label={label} placeholder="Kod, ad veya MPN" value={text} onChange={(e) => setText(e.target.value)} />
      {q.data?.length ? (
        <div style={{ maxHeight: 180, overflow: "auto" }}>{q.data.slice(0, 20).map((i) => (
          <button type="button" key={i.id} className="link" style={{ display: "block", textAlign: "left" }} onClick={() => onChange(i)}><span className="mono">{i.code}</span> · {i.name}</button>
        ))}</div>
      ) : null}
    </label>
  );
}

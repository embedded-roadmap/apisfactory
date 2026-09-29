import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { Button, ErrorBox, Field } from "./ui";
import { c, s } from "./theme";

type Item = { key: string; label: string; kind: "check" | "measure" | "text"; required: boolean; unit?: string; low?: number; high?: number };

/** Mobil kontrol listesi (R16/R17/R18): bağlama uyan plan yoksa hiçbir şey göstermez; karar sunucuda verilir. */
export function MobileCheckForm({ contextType, contextId }: { contextType: "operation" | "receipt_line" | "work_order"; contextId: string }) {
  const q = useQuery({ queryKey: ["checkStatus", contextType, contextId], queryFn: () => api<any[]>("GET", `/api/check-status?contextType=${contextType}&contextId=${contextId}`) });
  if (!q.data?.length) return null;
  return <View style={{ gap: 8 }}>{q.data.map((p) => <PlanRecord key={p.planId} p={p} contextType={contextType} contextId={contextId} />)}</View>;
}

function PlanRecord({ p, contextType, contextId }: { p: any; contextType: string; contextId: string }) {
  const qc = useQueryClient();
  const [vals, setVals] = useState<Record<string, string | boolean>>({});
  const save = useMutation({
    mutationFn: () => api<any>("POST", "/api/check-records", {
      planId: p.planId, contextType, contextId,
      results: (p.items as Item[]).map((it) => {
        const v = vals[it.key];
        return { key: it.key, value: v === undefined || v === "" ? null : it.kind === "measure" ? Number(String(v).replace(",", ".")) : v };
      }),
    }),
    onSuccess: () => { setVals({}); qc.invalidateQueries({ queryKey: ["checkStatus", contextType, contextId] }); },
  });
  const last = p.last;
  return (
    <View style={{ gap: 6, padding: 8, borderWidth: 1, borderColor: c.line, borderRadius: 8 }}>
      <Text style={s.text}>Kontrol: {p.code} v{p.versionNo} · {p.name}</Text>
      <Text style={{ color: last ? (last.passed ? c.ok : c.bad) : c.warn, fontWeight: "700" }}>{last ? (last.passed ? "Geçti" : `Kaldı: ${(last.findings as string[]).join(" · ")}`) : "Kayıt yok"}</Text>
      {(p.items as Item[]).map((it) =>
        it.kind === "check" ? (
          <View key={it.key} style={[s.row, { flexWrap: "wrap", alignItems: "center" }]}>
            <Text style={s.text}>{it.label}{it.required ? " *" : ""}</Text>
            {([["Uygun", true], ["Değil", false]] as const).map(([l, v]) => (
              <Pressable key={l} accessibilityRole="button" accessibilityLabel={`${it.label}: ${l}`} onPress={() => setVals({ ...vals, [it.key]: v })}
                style={[s.btn, { minHeight: 44, borderColor: vals[it.key] === v ? c.accent : c.line }]}>
                <Text style={s.text}>{l}</Text>
              </Pressable>
            ))}
          </View>
        ) : (
          <Field key={it.key} label={`${it.label}${it.required ? " *" : ""}${it.kind === "measure" ? ` (${it.low ?? "…"}–${it.high ?? "…"} ${it.unit ?? ""})` : ""}`}
            value={String(vals[it.key] ?? "")} onChangeText={(t) => setVals({ ...vals, [it.key]: t })} keyboardType={it.kind === "measure" ? "decimal-pad" : "default"} />
        ),
      )}
      <ErrorBox error={save.error} />
      <Button title="Kontrolü kaydet" busy={save.isPending} onPress={() => save.mutate()} />
    </View>
  );
}

import { useState } from "react";
import { FlatList, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, newKey } from "./api";
import { Scanner } from "./Scanner";
import { Button, ErrorBox, Field, OkBox } from "./ui";
import { c, s } from "./theme";

const LABEL: Record<string, string> = { preparing: "Hazırlanıyor", packed: "Paketlendi", shipped: "Sevk edildi" };
const CHECK: [string, string][] = [["box", "Kutu / ambalaj"], ["accessories", "Aksesuar ve evrak"], ["label", "Ürün / seri etiketi"], ["inspection", "Son görsel kontrol"]];

/** Depo: hazırlanan sevkiyatlar, okutmalı paketleme, paket kontrol listesi, paketleme tamamlama ve sevk. */
export function PackScreen() {
  const [id, setId] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ["packList"],
    queryFn: async () => [...(await api<any[]>("GET", "/api/shipments?status=preparing")), ...(await api<any[]>("GET", "/api/shipments?status=packed"))],
  });
  if (id) return <ShipmentScreen id={id} onBack={() => { setId(null); list.refetch(); }} />;
  return (
    <FlatList
      style={s.screen}
      contentContainerStyle={s.pad}
      data={list.data ?? []}
      keyExtractor={(x) => x.id}
      refreshControl={<RefreshControl refreshing={list.isFetching} onRefresh={() => list.refetch()} tintColor={c.accent} />}
      ListHeaderComponent={
        <View style={{ gap: 8 }}>
          <Text style={s.h1}>Sevkiyat hazırlığı</Text>
          <ErrorBox error={list.error} />
          {list.data && list.data.length === 0 ? <Text style={s.muted}>Hazırlanacak sevkiyat yok.</Text> : null}
        </View>
      }
      renderItem={({ item }) => (
        <Pressable accessibilityRole="button" onPress={() => setId(item.id)} style={({ pressed }) => [s.card, { opacity: pressed ? 0.8 : 1 }]}>
          <View style={[s.row, { justifyContent: "space-between" }]}>
            <Text style={s.mono}>{item.code}</Text>
            <Text style={{ color: c.warn, fontWeight: "700" }}>{LABEL[item.status] ?? item.status}</Text>
          </View>
          <Text style={s.text}>{item.customerName} · {item.salesOrderCode} · {Number(item.qty)} adet</Text>
        </Pressable>
      )}
    />
  );
}

function ShipmentScreen({ id, onBack }: { id: string; onBack: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["shipment", id], queryFn: () => api<any>("GET", `/api/shipments/${id}`) });
  const act = useMutation({ mutationFn: (f: () => Promise<unknown>) => f(), onSuccess: () => qc.invalidateQueries({ queryKey: ["shipment", id] }) });
  const [pkgId, setPkgId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [qty, setQty] = useState("");
  const [scan, setScan] = useState(false);
  const [check, setCheck] = useState<Record<string, boolean>>({});
  const [carrier, setCarrier] = useState("");
  const [tracking, setTracking] = useState("");
  const [shipKey] = useState(newKey());
  const [last, setLast] = useState<string | null>(null);
  if (!q.data) return <View style={[s.screen, s.pad]}><ErrorBox error={q.error} /></View>;
  const sh = q.data;
  const openPkgs = sh.packages.filter((p: any) => !p.closedAt);
  const pkg = sh.packages.find((p: any) => p.id === pkgId) ?? openPkgs[0];

  function add(v?: string) {
    const value = (v ?? code).trim();
    if (!value || !pkg) return;
    act.mutate(async () => {
      await api("POST", `/api/packages/${pkg.id}/items`, { code: value, qty: qty ? qty.replace(",", ".") : undefined });
      setLast(`${value} eklendi → ${pkg.code}`);
      setCode("");
      setQty("");
    });
  }

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
      <Button title="← Sevkiyatlar" onPress={onBack} />
      <Text style={s.h1}>{sh.code}</Text>
      <Text style={s.muted}>{sh.customerName} · {sh.salesOrderCode} · {LABEL[sh.status] ?? sh.status}</Text>
      <Text style={s.text}>{sh.address?.label}: {[sh.address?.line1, sh.address?.district, sh.address?.city].filter(Boolean).join(", ")}</Text>
      <ErrorBox error={act.error} />
      {last ? <OkBox>{last}</OkBox> : null}

      <View style={s.card}>
        <Text style={s.h2}>Ürünler</Text>
        {sh.lines.map((l: any) => (
          <View key={l.id} style={[s.row, { justifyContent: "space-between" }]}>
            <Text style={s.mono}>{l.productCode} Rev.{l.rev}</Text>
            <Text style={{ color: l.complete ? c.ok : c.warn, fontWeight: "700" }}>{Number(l.packed)} / {Number(l.qty)}</Text>
          </View>
        ))}
      </View>

      {sh.status === "preparing" ? (
        <View style={s.card}>
          <Text style={s.h2}>Paketle</Text>
          <View style={[s.row, { flexWrap: "wrap" }]}>
            {sh.packages.map((p: any) => (
              <Pressable key={p.id} accessibilityRole="radio" accessibilityState={{ selected: pkg?.id === p.id }} disabled={!!p.closedAt} onPress={() => setPkgId(p.id)}
                style={[s.btn, { minHeight: 44, borderColor: pkg?.id === p.id ? c.accent : c.line, opacity: p.closedAt ? 0.5 : 1 }]}>
                <Text style={pkg?.id === p.id ? { color: c.accent, fontWeight: "700" } : s.muted}>P{p.seq} · {p.items.length}{p.closedAt ? " · kapalı" : ""}</Text>
              </Pressable>
            ))}
            <Pressable accessibilityRole="button" onPress={() => act.mutate(() => api("POST", `/api/shipments/${id}/packages`, {}))} style={[s.btn, { minHeight: 44 }]}>
              <Text style={s.muted}>+ Paket</Text>
            </Pressable>
          </View>
          {pkg ? (
            <>
              <View style={s.row}>
                <View style={{ flex: 1 }}><Field label="Seri veya lot" value={code} onChangeText={setCode} autoCapitalize="characters" onSubmitEditing={() => add()} /></View>
                <View style={{ paddingTop: 22 }}><Button title="Okut" onPress={() => setScan(true)} /></View>
              </View>
              <Field label="Miktar (yalnızca serisiz lot)" value={qty} onChangeText={setQty} keyboardType="decimal-pad" />
              <Button title={`${pkg.code} paketine ekle`} primary disabled={!code} busy={act.isPending} onPress={() => add()} />
              {pkg.items.map((i: any) => <Text key={i.id} style={s.mono}>{i.serial ?? `Lot ${i.lotNo} × ${Number(i.qty)}`}</Text>)}
              {pkg.items.length ? (
                <View style={{ gap: 8 }}>
                  <Text style={s.text}>Paket kontrolü</Text>
                  {CHECK.map(([k, label]) => (
                    <Pressable key={k} accessibilityRole="checkbox" accessibilityState={{ checked: !!check[k] }} onPress={() => setCheck({ ...check, [k]: !check[k] })}
                      style={[s.btn, { minHeight: 44, borderColor: check[k] ? c.ok : c.line }]}>
                      <Text style={check[k] ? { color: c.ok, fontWeight: "700" } : s.muted}>{check[k] ? "☑" : "☐"} {label}</Text>
                    </Pressable>
                  ))}
                  <Button title="Paketi kapat" disabled={CHECK.some(([k]) => !check[k])}
                    onPress={() => act.mutate(async () => { await api("POST", `/api/packages/${pkg.id}/close`, { checklist: Object.fromEntries(CHECK.map(([k]) => [k, true])) }); setCheck({}); setPkgId(null); })} />
                </View>
              ) : null}
            </>
          ) : <Text style={s.muted}>Açık paket yok; yeni paket ekleyin.</Text>}
          <Button title="Paketlemeyi tamamla" primary onPress={() => act.mutate(() => api("POST", `/api/shipments/${id}/pack-complete`, {}))} />
        </View>
      ) : null}

      {sh.status === "packed" ? (
        <View style={s.card}>
          <Text style={s.h2}>Sevk et</Text>
          <Field label="Kargo / taşıyıcı" value={carrier} onChangeText={setCarrier} />
          <Field label="Takip no (isteğe bağlı)" value={tracking} onChangeText={setTracking} autoCapitalize="characters" />
          <Button title="Sevk et" primary disabled={carrier.length < 2} busy={act.isPending}
            onPress={() => act.mutate(() => api("POST", `/api/shipments/${id}/ship`, { carrier, trackingNo: tracking || undefined }, { "idempotency-key": shipKey }))} />
          <Text style={s.muted}>Kargo bağlayıcısı bağlı değil; irsaliye TASLAK.</Text>
        </View>
      ) : null}

      <Scanner visible={scan} onClose={() => setScan(false)} onScan={(v) => { setCode(v); add(v); }} />
    </ScrollView>
  );
}

import { useState } from "react";
import { FlatList, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Item, Session, Task } from "@apisfactory/shared";
import { api, newKey, store } from "./api";
import { Scanner } from "./Scanner";
import { Badge, Button, ErrorBox, Field, OkBox } from "./ui";
import { c, s } from "./theme";

export function LoginScreen() {
  const [apiUrl, setApiUrl] = useState(store.get().apiUrl);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const login = useMutation({
    mutationFn: async () => {
      await store.set({ apiUrl: apiUrl.replace(/\/$/, "") });
      const session = await api<Session>("POST", "/api/auth/login", { email, password });
      await store.set({ session, companyId: session.companies.length === 1 ? session.companies[0]!.id : null });
    },
  });
  return (
    <ScrollView style={s.screen} contentContainerStyle={[s.pad, { paddingTop: 72 }]} keyboardShouldPersistTaps="handled">
      <Text style={s.h1}>
        apis<Text style={{ color: c.muted, fontWeight: "500" }}>factory</Text>
      </Text>
      <Text style={s.muted}>Depo, mal kabul ve kalite</Text>
      <ErrorBox error={login.error} />
      <Field label="Sunucu adresi" value={apiUrl} onChangeText={setApiUrl} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
      <Field label="E-posta" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" />
      <Field label="Parola" value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" />
      <Button title="Giriş yap" primary busy={login.isPending} disabled={!email || password.length < 8} onPress={() => login.mutate()} />
    </ScrollView>
  );
}

export function CompanyScreen({ session }: { session: Session }) {
  return (
    <View style={[s.screen, s.pad, { paddingTop: 72 }]}>
      <Text style={s.h1}>Şirket seçin</Text>
      {session.companies.map((co) => (
        <Button key={co.id} title={co.name} onPress={() => store.set({ companyId: co.id })} />
      ))}
      <Button title="Çıkış" onPress={() => store.logout()} />
    </View>
  );
}

const KIND_LABEL: Record<string, string> = {
  incoming_inspection: "Giriş kalite",
  handover_approval: "Devir onayı",
  handover_fix: "Devir düzeltme",
  purchase_request_review: "Satın alma",
  production_planning: "Üretim planı",
};

export function TasksScreen({ go }: { go: (tab: string) => void }) {
  const q = useQuery({ queryKey: ["tasks"], queryFn: () => api<(Task & { kind: string })[]>("GET", "/api/tasks/mine") });
  return (
    <FlatList
      style={s.screen}
      contentContainerStyle={s.pad}
      data={q.data ?? []}
      keyExtractor={(t) => t.id}
      refreshControl={<RefreshControl refreshing={q.isFetching} onRefresh={() => q.refetch()} tintColor={c.accent} />}
      ListHeaderComponent={
        <View style={{ gap: 8 }}>
          <Text style={s.h1}>İşlerim</Text>
          <ErrorBox error={q.error} />
          {q.data?.length === 0 ? <Text style={s.muted}>Açık işiniz yok.</Text> : null}
        </View>
      }
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="button"
          onPress={() => item.kind === "incoming_inspection" && go("inspect")}
          style={({ pressed }) => [s.card, { opacity: pressed ? 0.8 : 1 }]}
        >
          <Text style={s.label}>{KIND_LABEL[item.kind] ?? item.kind}</Text>
          <Text style={s.text}>{item.title}</Text>
        </Pressable>
      )}
    />
  );
}

export function ReceiveScreen() {
  const qc = useQueryClient();
  const items = useQuery({ queryKey: ["components"], queryFn: () => api<Item[]>("GET", "/api/items?kind=component") });
  const [supplier, setSupplier] = useState("");
  const [search, setSearch] = useState("");
  const [item, setItem] = useState<Item | null>(null);
  const [qty, setQty] = useState("");
  const [lot, setLot] = useState("");
  const [scan, setScan] = useState<null | "item" | "lot">(null);
  const [key, setKey] = useState(newKey());
  const [done, setDone] = useState<string | null>(null);

  const receive = useMutation({
    mutationFn: () =>
      api<{ code: string }>("POST", "/api/receipts", { supplierName: supplier, lines: [{ itemId: item!.id, qty: qty.replace(",", "."), lotNo: lot }] }, { "idempotency-key": key }),
    onSuccess: (r) => {
      setDone(`${r.code} kaydedildi. Parça giriş kalite kontrolünde; kullanılabilir stok değildir.`);
      setQty("");
      setLot("");
      setItem(null);
      setKey(newKey());
      qc.invalidateQueries({ queryKey: ["pending"] });
    },
  });

  const matches = (items.data ?? []).filter((i) => {
    const q = search.trim().toLowerCase();
    return q.length >= 2 && (i.code.toLowerCase().includes(q) || (i.mpn ?? "").toLowerCase().includes(q));
  });

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
      <Text style={s.h1}>Mal kabul</Text>
      {done ? <OkBox>{done}</OkBox> : null}
      <ErrorBox error={receive.error} />
      <Field label="Tedarikçi" value={supplier} onChangeText={setSupplier} />
      <View style={s.card}>
        <Text style={s.label}>Kalem</Text>
        {item ? (
          <View style={{ gap: 4 }}>
            <Text style={s.mono}>{item.code}</Text>
            <Text style={s.muted}>
              {item.manufacturer} {item.mpn}
            </Text>
            <Button title="Değiştir" onPress={() => setItem(null)} />
          </View>
        ) : (
          <>
            <View style={s.row}>
              <View style={{ flex: 1 }}>
                <Field label="Kod veya MPN ara" value={search} onChangeText={setSearch} autoCapitalize="characters" />
              </View>
              <View style={{ paddingTop: 22 }}>
                <Button title="Okut" onPress={() => setScan("item")} />
              </View>
            </View>
            {matches.slice(0, 6).map((i) => (
              <Pressable key={i.id} accessibilityRole="button" onPress={() => setItem(i)} style={[s.btn, { alignItems: "flex-start" }]}>
                <Text style={s.mono}>{i.code}</Text>
                <Text style={s.muted}>{i.mpn}</Text>
              </Pressable>
            ))}
            {search.length >= 2 && matches.length === 0 ? <Text style={s.muted}>Eşleşen kalem yok. Belirsiz parça otomatik eşlenmez.</Text> : null}
          </>
        )}
      </View>
      <Field label="Miktar" value={qty} onChangeText={setQty} keyboardType="decimal-pad" />
      <View style={s.row}>
        <View style={{ flex: 1 }}>
          <Field label="Lot / seri" value={lot} onChangeText={setLot} autoCapitalize="characters" />
        </View>
        <View style={{ paddingTop: 22 }}>
          <Button title="Okut" onPress={() => setScan("lot")} />
        </View>
      </View>
      <Button title="Kabul et (kontrole al)" primary busy={receive.isPending} disabled={!supplier || !item || !qty || !lot} onPress={() => { setDone(null); receive.mutate(); }} />
      <Scanner
        visible={scan !== null}
        onClose={() => setScan(null)}
        onScan={(v) => {
          if (scan === "lot") setLot(v);
          else {
            const hit = (items.data ?? []).find((i) => i.code === v || (i.mpn ?? "").toLowerCase() === v.toLowerCase());
            if (hit) setItem(hit);
            else setSearch(v);
          }
        }}
      />
    </ScrollView>
  );
}

type Pending = { id: string; code: string; supplierName: string; itemCode: string; mpn: string | null; lotNo: string; qty: string; inspectionStatus: string };

export function InspectScreen({ canDecide }: { canDecide: boolean }) {
  const q = useQuery({ queryKey: ["pending"], queryFn: () => api<Pending[]>("GET", "/api/receipts?pending=1") });
  return (
    <FlatList
      style={s.screen}
      contentContainerStyle={s.pad}
      data={q.data ?? []}
      keyExtractor={(r) => r.id}
      refreshControl={<RefreshControl refreshing={q.isFetching} onRefresh={() => q.refetch()} tintColor={c.accent} />}
      ListHeaderComponent={
        <View style={{ gap: 8 }}>
          <Text style={s.h1}>Giriş kalite</Text>
          {!canDecide ? <Text style={s.muted}>Karar vermek için kalite yetkisi gerekir; listeyi görüntüleyebilirsiniz.</Text> : null}
          <ErrorBox error={q.error} />
          {q.data?.length === 0 ? <Text style={s.muted}>Kontrol bekleyen kabul yok.</Text> : null}
        </View>
      }
      renderItem={({ item }) => <InspectCard r={item} canDecide={canDecide} />}
    />
  );
}

function InspectCard({ r, canDecide }: { r: Pending; canDecide: boolean }) {
  const qc = useQueryClient();
  const [acc, setAcc] = useState(r.qty);
  const [rej, setRej] = useState("0");
  const [note, setNote] = useState("");
  const decide = useMutation({
    mutationFn: () => api("POST", `/api/receipt-lines/${r.id}/inspection`, { acceptedQty: acc.replace(",", "."), rejectedQty: rej.replace(",", "."), note: note || undefined }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pending"] }),
  });
  return (
    <View style={s.card}>
      <View style={[s.row, { justifyContent: "space-between" }]}>
        <Text style={s.mono}>{r.code}</Text>
        <Badge value={r.inspectionStatus} />
      </View>
      <Text style={s.text}>
        {r.itemCode} · {r.mpn}
      </Text>
      <Text style={s.muted}>
        Lot {r.lotNo} · {r.qty} adet · {r.supplierName}
      </Text>
      {canDecide ? (
        <>
          <ErrorBox error={decide.error} />
          <View style={s.row}>
            <View style={{ flex: 1 }}>
              <Field label="Kabul" value={acc} onChangeText={setAcc} keyboardType="decimal-pad" />
            </View>
            <View style={{ flex: 1 }}>
              <Field label="Ret (karantina)" value={rej} onChangeText={setRej} keyboardType="decimal-pad" />
            </View>
          </View>
          <Field label="Not" value={note} onChangeText={setNote} />
          <Button title="Kararı kaydet" primary busy={decide.isPending} onPress={() => decide.mutate()} />
        </>
      ) : null}
    </View>
  );
}

type Lookup = { id: string; lotNo: string; inspectionStatus: string; itemCode: string; itemName: string; mpn: string | null; balances: { locationCode: string; locationType: string; qty: string }[] };

export function LookupScreen() {
  const [code, setCode] = useState("");
  const [scan, setScan] = useState(false);
  const q = useQuery({ queryKey: ["lookup", code], enabled: code.trim().length > 0, queryFn: () => api<Lookup[]>("GET", `/api/lots/lookup?code=${encodeURIComponent(code.trim())}`) });
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
      <Text style={s.h1}>Stok sorgu</Text>
      <View style={s.row}>
        <View style={{ flex: 1 }}>
          <Field label="Lot, kalem kodu veya MPN" value={code} onChangeText={setCode} autoCapitalize="characters" />
        </View>
        <View style={{ paddingTop: 22 }}>
          <Button title="Okut" onPress={() => setScan(true)} />
        </View>
      </View>
      <ErrorBox error={q.error} />
      {q.data?.length === 0 ? <Text style={s.muted}>Kayıt bulunamadı.</Text> : null}
      {q.data?.map((l) => (
        <View key={l.id} style={s.card}>
          <View style={[s.row, { justifyContent: "space-between" }]}>
            <Text style={s.mono}>Lot {l.lotNo}</Text>
            {l.inspectionStatus !== "not_required" ? <Badge value={l.inspectionStatus} /> : null}
          </View>
          <Text style={s.text}>
            {l.itemCode} · {l.itemName}
          </Text>
          {l.balances.length === 0 ? <Text style={s.muted}>Bakiye yok</Text> : null}
          {l.balances.map((b) => (
            <View key={b.locationCode} style={[s.row, { justifyContent: "space-between" }]}>
              <View style={s.row}>
                <Text style={s.mono}>{b.locationCode}</Text>
                <Badge value={b.locationType} />
              </View>
              <Text style={[s.text, { fontWeight: "700" }]}>{Number(b.qty).toLocaleString("tr-TR")}</Text>
            </View>
          ))}
        </View>
      ))}
      <Scanner visible={scan} onClose={() => setScan(false)} onScan={setCode} />
    </ScrollView>
  );
}

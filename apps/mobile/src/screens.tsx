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
      <Text style={s.muted}>Üretim, depo ve kalite</Text>
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
  material_issue: "Malzeme hazırla",
  work_order_execution: "Üretim",
  device_disposition: "Test kararı",
  purchase_cancel_review: "Satın alma iptali",
};

export function TasksScreen({ go }: { go: (tab: string) => void }) {
  const q = useQuery({ queryKey: ["tasks"], queryFn: () => api<(Task & { kind: string } & Record<string, any>)[]>("GET", "/api/tasks/mine") });
  const [openId, setOpenId] = useState<string | null>(null);
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
          <Mentions />
          {q.data?.length === 0 ? <Text style={s.muted}>Açık işiniz yok.</Text> : null}
        </View>
      }
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="button"
          onPress={() => (item.kind === "manual" ? setOpenId(openId === item.id ? null : item.id) : item.kind === "incoming_inspection" ? go("inspect") : ["material_issue", "work_order_execution"].includes(item.kind) ? go("production") : undefined)}
          style={({ pressed }) => [s.card, { opacity: pressed ? 0.8 : 1 }]}
        >
          <Text style={s.label}>{item.kind === "manual" ? `Görev · ${PRI[item.priority] ?? ""}` : KIND_LABEL[item.kind] ?? item.kind}</Text>
          <Text style={s.text}>{item.milestone ? "◆ " : ""}{item.title}</Text>
          {item.dueDate ? <Text style={{ color: item.overdue ? c.bad : c.muted }}>Bitiş {item.dueDate}{item.overdue ? " · gecikti" : ""}{item.status === "blocked" ? " · engelli" : ""}</Text> : null}
          {openId === item.id ? <ManualTask id={item.id} onDone={() => { setOpenId(null); q.refetch(); }} /> : null}
        </Pressable>
      )}
    />
  );
}

const PRI: Record<string, string> = { low: "Düşük", normal: "Normal", high: "Yüksek", critical: "Kritik" };

/** Elle açılmış görev: kontrol listesi, başla, engel (tedarikçi/müşteri dış gecikme sayılır), tamamla. */
function ManualTask({ id, onDone }: { id: string; onDone: () => void }) {
  const qc = useQueryClient();
  const t = useQuery({ queryKey: ["task", id], queryFn: () => api<any>("GET", `/api/tasks/${id}`) });
  const act = useMutation({ mutationFn: (f: () => Promise<unknown>) => f(), onSuccess: () => qc.invalidateQueries({ queryKey: ["task", id] }) });
  const [reason, setReason] = useState("");
  const [cat, setCat] = useState("supplier");
  if (!t.data) return <ErrorBox error={t.error} />;
  const d = t.data;
  return (
    <View style={{ gap: 8, marginTop: 8 }}>
      <ErrorBox error={act.error} />
      {d.checklist.map((c: any, i: number) => (
        <Pressable key={i} accessibilityRole="checkbox" accessibilityState={{ checked: c.done }} onPress={() => act.mutate(() => api("POST", `/api/tasks/${id}/checklist`, { index: i, done: !c.done }))}
          style={[s.btn, { minHeight: 44, borderColor: c.done ? c.ok : c.line }]}>
          <Text style={c.done ? { color: c.ok } : s.text}>{c.done ? "☑" : "☐"} {c.text}</Text>
        </Pressable>
      ))}
      {d.status !== "in_progress" ? <Button title="Başladım" onPress={() => act.mutate(() => api("POST", `/api/tasks/${id}/status`, { status: "in_progress" }))} /> : null}
      <Button title="Tamamlandı" primary onPress={() => act.mutate(async () => { await api("POST", `/api/tasks/${id}/status`, { status: "done" }); onDone(); })} />
      <View style={[s.row, { flexWrap: "wrap" }]}>
        {[["supplier", "Tedarikçi"], ["customer", "Müşteri"], ["material", "Malzeme"], ["equipment", "Ekipman"], ["other", "Diğer"]].map(([k, v]) => (
          <Pressable key={k} accessibilityRole="radio" accessibilityState={{ selected: cat === k }} onPress={() => setCat(k!)} style={[s.btn, { minHeight: 44, borderColor: cat === k ? c.accent : c.line }]}>
            <Text style={cat === k ? { color: c.accent, fontWeight: "700" } : s.muted}>{v}</Text>
          </Pressable>
        ))}
      </View>
      <Field label="Engel açıklaması" value={reason} onChangeText={setReason} />
      <Button title="Engel bildir" disabled={reason.length < 3} onPress={() => act.mutate(() => api("POST", `/api/tasks/${id}/status`, { status: "blocked", blockedCategory: cat, reason }))} />
    </View>
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
      <RmaReceive />

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

type Lookup = {
  id: string; lotNo: string; inspectionStatus: string; itemCode: string; itemName: string; mpn: string | null;
  expiresAt: string | null; openedAt: string | null; mslLevel: string | null; floorLifeHours: number | null; storageCondition: string | null;
  balances: { locationCode: string; locationType: string; qty: string }[];
};

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
          {l.mslLevel || l.expiresAt || l.storageCondition ? (
            <Text style={s.muted}>
              {l.mslLevel ? `MSL ${l.mslLevel} · ` : ""}
              {l.expiresAt ? `SKT ${new Date(l.expiresAt).toLocaleDateString("tr-TR")}${new Date(l.expiresAt) < new Date() ? " (SÜRESİ GEÇTİ)" : ""} · ` : ""}
              {l.openedAt ? "paket açık · " : ""}
              {l.storageCondition ?? ""}
            </Text>
          ) : null}
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

const WO_LABEL: Record<string, string> = { planned: "Planlandı", released: "Yayımlandı", in_progress: "İşlemde", completed: "Tamamlandı", cancelled: "İptal", on_hold: "Beklemede" };
const CR_LABEL: Record<string, string> = { open: "Açık", approved: "Onaylandı", rejected: "Reddedildi", implemented: "Uygulandı" };
const OP_LABEL: Record<string, string> = { pending: "Bekliyor", in_progress: "İşlemde", paused: "Duraklatıldı", done: "Tamamlandı" };
const PAUSE_REASONS = ["Malzeme", "Ekipman", "Kalite", "Personel", "Dış bağımlılık"];

/** Teknisyen ve depo: iş emri operasyonları, barkodla malzeme çıkışı ve cihaz testi. */
export function ProductionScreen({ perms }: { perms: Set<string> }) {
  const [woId, setWoId] = useState<string | null>(null);
  const list = useQuery({ queryKey: ["wos"], queryFn: () => api<any[]>("GET", "/api/work-orders") });
  if (woId) return <WorkOrderScreen id={woId} perms={perms} onBack={() => setWoId(null)} />;
  const active = (list.data ?? []).filter((w) => ["released", "in_progress", "on_hold"].includes(w.status));
  return (
    <FlatList
      style={s.screen}
      contentContainerStyle={s.pad}
      data={active}
      keyExtractor={(w) => w.id}
      refreshControl={<RefreshControl refreshing={list.isFetching} onRefresh={() => list.refetch()} tintColor={c.accent} />}
      ListHeaderComponent={
        <View style={{ gap: 8 }}>
          <Text style={s.h1}>Üretim</Text>
          <ErrorBox error={list.error} />
          {list.data && active.length === 0 ? <Text style={s.muted}>Açık iş emri yok.</Text> : null}
        </View>
      }
      renderItem={({ item }) => (
        <Pressable accessibilityRole="button" onPress={() => setWoId(item.id)} style={({ pressed }) => [s.card, { opacity: pressed ? 0.8 : 1 }]}>
          <View style={[s.row, { justifyContent: "space-between" }]}>
            <Text style={s.mono}>{item.code}</Text>
            <Text style={{ color: c.warn, fontWeight: "700" }}>{WO_LABEL[item.status] ?? item.status}</Text>
          </View>
          <Text style={s.text}>
            {item.productCode} Rev.{item.rev} × {Number(item.qty)}
          </Text>
        </Pressable>
      )}
    />
  );
}

function WorkOrderScreen({ id, perms, onBack }: { id: string; perms: Set<string>; onBack: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["wo", id], queryFn: () => api<any>("GET", `/api/work-orders/${id}`) });
  const act = useMutation({
    mutationFn: (f: () => Promise<unknown>) => f(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["wo", id] }),
  });
  const [scan, setScan] = useState<null | "lot" | "serial">(null);
  const [lotCode, setLotCode] = useState("");
  const [issueQty, setIssueQty] = useState("");
  const [serial, setSerial] = useState("");
  const [vals, setVals] = useState<Record<string, string>>({});
  const [equipmentId, setEquipmentId] = useState("");
  const [firmware, setFirmware] = useState("");
  const [lastResult, setLastResult] = useState<string | null>(null);
  const [ecrOpen, setEcrOpen] = useState(false);
  const [ecr, setEcr] = useState({ title: "", description: "", stopProduction: false });
  const [issueKey, setIssueKey] = useState(newKey());
  const equipment = useQuery({ queryKey: ["equipment"], queryFn: () => api<any[]>("GET", "/api/equipment"), enabled: perms.has("production.test.record") });
  if (!q.data) return <View style={[s.screen, s.pad]}><ErrorBox error={q.error} /></View>;
  const wo = q.data;
  const testOp = wo.operations.find((o: any) => o.isQualityGate);
  const canTest = perms.has("production.test.record") && testOp?.status === "in_progress" && wo.status !== "on_hold";
  const limits: any[] = wo.testPlan?.limits ?? [{ name: "3V3", unit: "V", low: 3.2, high: 3.4, required: false }];
  const usableEq = (equipment.data ?? []).filter((e) => e.status === "active" && !e.calibrationExpired);

  async function issue() {
    const lots = await api<any[]>("GET", `/api/lots/lookup?code=${encodeURIComponent(lotCode)}`);
    const lot = lots.find((l) => l.lotNo === lotCode) ?? lots[0];
    if (!lot) throw new Error(`Lot bulunamadı: ${lotCode}`);
    await api("POST", `/api/work-orders/${id}/issue`, { lotId: lot.id, qty: issueQty.replace(",", ".") }, { "idempotency-key": issueKey });
    setLotCode("");
    setIssueQty("");
    setIssueKey(newKey());
  }

  function test(result?: "pass" | "fail") {
    const measurements = limits
      .filter((l) => vals[l.name])
      .map((l) => ({ name: l.name, value: Number(vals[l.name]!.replace(",", ".")), ...(wo.testPlan ? {} : { unit: l.unit, low: l.low, high: l.high }) }));
    act.mutate(async () => {
      const r = await api<any>("POST", `/api/devices/${encodeURIComponent(serial)}/test`, {
        result: wo.testPlan ? result : (result ?? "pass"),
        measurements,
        station: "mobil",
        equipmentId: equipmentId || undefined,
        firmwareVersion: firmware || undefined,
      });
      setLastResult(`${serial}: ${r.result === "pass" ? "GEÇTİ" : "KALDI"}${r.outOfLimit?.length ? ` (limit dışı: ${r.outOfLimit.join(", ")})` : ""}`);
      setSerial("");
      setVals({});
    });
  }

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
      <Button title="← İş emirleri" onPress={onBack} />
      <Text style={s.h1}>{wo.code}</Text>
      <Text style={s.muted}>
        {wo.productCode} Rev.{wo.rev} · BOM v{wo.bomVersionNo} · {Number(wo.qty)} adet · FW {wo.firmwareVersion ?? "—"}
      </Text>
      {wo.status === "on_hold" ? <ErrorBox error={new Error(`İş emri beklemede: ${wo.holdReason ?? ""}`)} /> : null}
      <ErrorBox error={act.error} />

      {perms.has("inventory.issue") ? (
        <View style={s.card}>
          <Text style={s.h2}>Malzeme çıkışı</Text>
          {wo.materials.map((m: any) => (
            <View key={m.itemId} style={[s.row, { justifyContent: "space-between" }]}>
              <View>
                <Text style={s.mono}>{m.itemCode}</Text>
                {Number(m.issuedAsAlternate) > 0 ? <Text style={s.muted}>onaylı alternatif: {Number(m.issuedAsAlternate)}</Text> : null}
              </View>
              <Text style={{ color: m.complete ? c.ok : c.warn, fontWeight: "700" }}>{m.complete ? "Tamam" : `Kalan ${Number(m.remaining)}`}</Text>
            </View>
          ))}
          <Text style={s.muted}>Onaylı alternatif parçanın lotu da okutulabilir; sunucu ürün kapsamındaki onayı otomatik doğrular.</Text>
          <View style={s.row}>
            <View style={{ flex: 1 }}>
              <Field label="Lot" value={lotCode} onChangeText={setLotCode} autoCapitalize="characters" />
            </View>
            <View style={{ paddingTop: 22 }}>
              <Button title="Okut" onPress={() => setScan("lot")} />
            </View>
          </View>
          <Field label="Miktar" value={issueQty} onChangeText={setIssueQty} keyboardType="decimal-pad" />
          <Button title="Çıkışı kaydet" primary disabled={!lotCode || !issueQty} busy={act.isPending} onPress={() => act.mutate(issue)} />
        </View>
      ) : null}

      <View style={s.card}>
        <Text style={s.h2}>Operasyonlar</Text>
        {wo.operations.map((o: any) => (
          <View key={o.id} style={{ gap: 8, paddingVertical: 6, borderTopWidth: 1, borderColor: c.line }}>
            <View style={[s.row, { justifyContent: "space-between" }]}>
              <Text style={s.text}>
                {o.seq}. {o.name}
                {o.isQualityGate ? " · kalite kapısı" : ""}
              </Text>
              <Text style={{ color: o.status === "done" ? c.ok : o.status === "pending" ? c.muted : c.warn, fontWeight: "700" }}>{OP_LABEL[o.status]}</Text>
            </View>
            {o.instructions ? <Text style={[s.text, { color: c.muted }]}>Talimat: {o.instructions}</Text> : null}
            {o.plannedMinutes != null ? <Text style={{ color: c.muted }}>Planlanan: {Math.round(o.plannedMinutes)} dk</Text> : null}
            {perms.has("production.execute") && ["pending", "paused"].includes(o.status) && wo.status !== "on_hold" ? (
              <Button title="Başla" onPress={() => act.mutate(() => api("POST", `/api/work-orders/${id}/operations/${o.id}/start`, {}))} />
            ) : null}
            {perms.has("production.execute") && o.status === "in_progress" && wo.status !== "on_hold" ? (
              <View style={{ gap: 8 }}>
                <Button title="Tamamla" primary onPress={() => act.mutate(() => api("POST", `/api/work-orders/${id}/operations/${o.id}/complete`, {}))} />
                <View style={[s.row, { flexWrap: "wrap" }]}>
                  {PAUSE_REASONS.map((r) => (
                    <Pressable key={r} accessibilityRole="button" accessibilityLabel={`Duraklat: ${r}`} onPress={() => act.mutate(() => api("POST", `/api/work-orders/${id}/operations/${o.id}/pause`, { reason: r }))} style={[s.btn, { minHeight: 44 }]}>
                      <Text style={s.muted}>Duraklat: {r}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ) : null}
          </View>
        ))}
      </View>

      {canTest ? (
        <View style={s.card}>
          <Text style={s.h2}>Fonksiyon testi</Text>
          <View style={s.row}>
            <View style={{ flex: 1 }}>
              <Field label="Seri no" value={serial} onChangeText={setSerial} autoCapitalize="characters" />
            </View>
            <View style={{ paddingTop: 22 }}>
              <Button title="Okut" onPress={() => setScan("serial")} />
            </View>
          </View>
          <Text style={s.muted}>{wo.testPlan ? `Test planı v${wo.testPlan.versionNo}: karar sunucuda verilir` : "Test planı yok: sonucu siz seçersiniz"}</Text>
          <Text style={s.text}>Ekipman</Text>
          <View style={[s.row, { flexWrap: "wrap" }]}>
            {usableEq.map((e) => (
              <Pressable key={e.id} accessibilityRole="radio" accessibilityState={{ selected: equipmentId === e.id }} onPress={() => setEquipmentId(e.id)}
                style={[s.btn, { minHeight: 44, borderColor: equipmentId === e.id ? c.accent : c.line }]}>
                <Text style={equipmentId === e.id ? { color: c.accent, fontWeight: "700" } : s.muted}>{e.code}</Text>
              </Pressable>
            ))}
            {usableEq.length === 0 ? <Text style={s.muted}>Kullanılabilir (kalibrasyonu geçerli) ekipman yok.</Text> : null}
          </View>
          <Field label={`Cihazdaki firmware${wo.firmwareVersion ? ` (beklenen ${wo.firmwareVersion})` : ""}`} value={firmware} onChangeText={setFirmware} autoCapitalize="none" />
          {limits.map((l) => (
            <Field key={l.name} label={`${l.name}${l.unit ? ` (${l.unit})` : ""} — ${l.low ?? "−∞"}…${l.high ?? "+∞"}${l.required ? "" : " · isteğe bağlı"}`}
              value={vals[l.name] ?? ""} onChangeText={(v) => setVals({ ...vals, [l.name]: v })} keyboardType="decimal-pad" />
          ))}
          <View style={s.row}>
            <View style={{ flex: 1 }}>
              {wo.testPlan
                ? <Button title="Testi kaydet" primary disabled={!serial} busy={act.isPending} onPress={() => test()} />
                : <Button title="Geçti" primary disabled={!serial} onPress={() => test("pass")} />}
            </View>
            <View style={{ flex: 1 }}>
              <Button title="Kaldı" disabled={!serial} onPress={() => test("fail")} />
            </View>
          </View>
          {lastResult ? <OkBox>{lastResult}</OkBox> : null}
          <Text style={s.muted}>
            İlk testte başarı: {wo.stats.firstPassYield == null ? "—" : `%${(wo.stats.firstPassYield * 100).toFixed(1)}`} · geçen {wo.stats.passed} · hurda {wo.stats.scrapped}
          </Text>
        </View>
      ) : null}

      {perms.has("change.create") && ["released", "in_progress", "on_hold"].includes(wo.status) ? (
        <View style={s.card}>
          <Text style={s.h2}>Sorun bildir (değişiklik talebi)</Text>
          {wo.changeRequests?.map((cr: any) => (
            <Text key={cr.id} style={s.muted}>{cr.code} · {cr.title} · {CR_LABEL[cr.status] ?? cr.status}</Text>
          ))}
          {!ecrOpen ? <Button title="Talep aç" onPress={() => setEcrOpen(true)} /> : (
            <View style={{ gap: 8 }}>
              <Field label="Başlık" value={ecr.title} onChangeText={(v) => setEcr({ ...ecr, title: v })} />
              <Field label="Açıklama (gözlem, seri)" value={ecr.description} onChangeText={(v) => setEcr({ ...ecr, description: v })} multiline />
              <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: ecr.stopProduction }} onPress={() => setEcr({ ...ecr, stopProduction: !ecr.stopProduction })} style={[s.btn, { minHeight: 44, borderColor: ecr.stopProduction ? c.bad : c.line }]}>
                <Text style={ecr.stopProduction ? { color: c.bad, fontWeight: "700" } : s.muted}>{ecr.stopProduction ? "☑" : "☐"} Üretimi durdur (iş emri bekletilir)</Text>
              </Pressable>
              <Button title="Gönder" primary disabled={ecr.title.length < 3 || ecr.description.length < 10} busy={act.isPending}
                onPress={() => act.mutate(async () => {
                  await api("POST", "/api/change-requests", { workOrderId: id, title: ecr.title, description: ecr.description, stopProduction: ecr.stopProduction, deviceSerial: serial || undefined });
                  setEcr({ title: "", description: "", stopProduction: false });
                  setEcrOpen(false);
                })} />
            </View>
          )}
        </View>
      ) : null}

      <Scanner visible={scan !== null} onClose={() => setScan(null)} onScan={(v) => (scan === "lot" ? setLotCode(v) : setSerial(v))} />
    </ScrollView>
  );
}

/** İade teslim alma: açık iadeler; teslim alınan ürün iade kabul alanına girer (satılabilir stok değişmez). */
function RmaReceive() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["rmasOpen"], queryFn: () => api<any[]>("GET", "/api/rmas?status=open") });
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const receive = useMutation({
    mutationFn: (id: string) => api<any>("POST", `/api/rmas/${id}/receive`, {}),
    onSuccess: (r) => { setMsg(`${r.code} teslim alındı → iade kabul alanı. Kalite incelemesi bekliyor.`); setCode(""); qc.invalidateQueries({ queryKey: ["rmasOpen"] }); },
  });
  const rows = (list.data ?? []).filter((r) => !code || r.serial === code.trim() || r.lotNo === code.trim() || r.code === code.trim());
  if (!list.data?.length) return null;
  return (
    <View style={s.card}>
      <Text style={s.h2}>İade teslim al</Text>
      <Field label="Seri / lot / iade no ile süz" value={code} onChangeText={setCode} autoCapitalize="characters" />
      <ErrorBox error={receive.error} />
      {msg ? <OkBox>{msg}</OkBox> : null}
      {rows.map((r) => (
        <View key={r.id} style={{ gap: 6, paddingVertical: 6, borderTopWidth: 1, borderColor: c.line }}>
          <Text style={s.text}>{r.code} · {r.customerName}</Text>
          <Text style={s.mono}>{r.serial ?? `${r.lotNo} × ${Number(r.qty)}`} · {r.productCode}</Text>
          <Button title="Teslim al" primary busy={receive.isPending} onPress={() => receive.mutate(r.id)} />
        </View>
      ))}
    </View>
  );
}

/** Bahsedildiğim okunmamış mesajlar: kısa önizleme, okundu işaretleme (ayrıntı ve yanıt web'de, kayıt ekranında). */
function Mentions() {
  const q = useQuery({ queryKey: ["mentions"], queryFn: () => api<any[]>("GET", "/api/mentions?unread=true") });
  const read = useMutation({ mutationFn: (m: any) => api("POST", `/api/threads/${m.entityType}/${m.entityId}/read`, {}), onSuccess: () => q.refetch() });
  if (!q.data?.length) return null;
  return (
    <View style={[s.card, { gap: 6 }]}>
      <Text style={s.label}>Bahsedildiğiniz mesajlar ({q.data.length})</Text>
      {q.data.map((m) => (
        <View key={m.messageId} style={{ gap: 4, borderTopWidth: 1, borderColor: c.line, paddingTop: 6 }}>
          <Text style={s.text}>{m.label ?? m.entityType}</Text>
          <Text style={{ color: c.muted }}>{m.authorName}: {m.excerpt ?? "geri çekildi"}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={`Okundu: ${m.label}`} onPress={() => read.mutate(m)} style={[s.btn, { minHeight: 44, alignSelf: "flex-start" }]}>
            <Text style={s.btnText}>Okundu</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

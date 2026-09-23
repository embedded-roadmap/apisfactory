import { useEffect, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Me } from "@apisfactory/shared";
import { api, store } from "./src/api";
import { CompanyScreen, InspectScreen, LoginScreen, LookupScreen, ProductionScreen, ReceiveScreen, TasksScreen } from "./src/screens";
import { PackScreen } from "./src/pack";
import { ErrorBox, Button } from "./src/ui";
import { c, s } from "./src/theme";

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });

export default function App() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    store.load().finally(() => setReady(true));
  }, []);
  return (
    <QueryClientProvider client={qc}>
      <SafeAreaProvider>
        <SafeAreaView style={s.screen}>
          <StatusBar style="light" />
          {ready ? <Root /> : null}
        </SafeAreaView>
      </SafeAreaProvider>
    </QueryClientProvider>
  );
}

function Root() {
  const st = useSyncExternalStore(store.subscribe, store.get);
  if (!st.session) return <LoginScreen />;
  if (!st.companyId) return <CompanyScreen session={st.session} />;
  return <Main key={st.companyId} />;
}

const TABS = [
  { key: "tasks", label: "İşlerim", perm: "task.view" },
  { key: "production", label: "Üretim", perm: "production.view" },
  { key: "receive", label: "Mal kabul", perm: "inventory.receive" },
  { key: "inspect", label: "Kalite", perm: "inventory.view" },
  { key: "pack", label: "Sevk", perm: "shipment.create" },
  { key: "lookup", label: "Stok", perm: "inventory.view" },
] as const;

function Main() {
  const client = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<Me>("GET", "/api/me") });
  const [tab, setTab] = useState<string>("tasks");
  if (me.error)
    return (
      <View style={s.pad}>
        <ErrorBox error={me.error} />
        <Button title="Tekrar giriş yap" onPress={() => store.logout()} />
      </View>
    );
  if (!me.data) return null;
  const perms = new Set<string>(me.data.permissions);
  const tabs = TABS.filter((t) => perms.has(t.perm));
  return (
    <View style={{ flex: 1 }}>
      <View style={[s.row, { justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderColor: c.line }]}>
        <View>
          <Text style={[s.text, { fontWeight: "700" }]}>{me.data.company.name}</Text>
          <Text style={s.muted}>{me.data.user.name}</Text>
        </View>
        <Pressable accessibilityRole="button" onPress={() => { client.clear(); store.logout(); }} style={{ padding: 12 }}>
          <Text style={s.muted}>Çıkış</Text>
        </Pressable>
      </View>
      <View style={{ flex: 1 }}>
        {tab === "tasks" ? <TasksScreen go={setTab} /> : null}
        {tab === "production" ? <ProductionScreen perms={perms} /> : null}
        {tab === "receive" ? <ReceiveScreen /> : null}
        {tab === "inspect" ? <InspectScreen canDecide={perms.has("quality.incoming.decide")} /> : null}
        {tab === "pack" ? <PackScreen /> : null}
        {tab === "lookup" ? <LookupScreen /> : null}
      </View>
      <View accessibilityRole="tablist" style={{ flexDirection: "row", borderTopWidth: 1, borderColor: c.line, backgroundColor: c.surface }}>
        {tabs.map((t) => (
          <Pressable
            key={t.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === t.key }}
            onPress={() => setTab(t.key)}
            style={{ flex: 1, minHeight: 60, alignItems: "center", justifyContent: "center" }}
          >
            <Text style={{ color: tab === t.key ? c.accent : c.muted, fontWeight: "700", fontSize: 14 }}>{t.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

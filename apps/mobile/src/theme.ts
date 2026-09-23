import { StyleSheet } from "react-native";

/** Tanıtım sitesi ve masaüstü uygulamayla aynı marka token'ları. Saha kullanımı için koyu tema ve büyük dokunma alanları. */
export const c = {
  bg: "#12130F",
  surface: "#1B1C17",
  surface2: "#23241E",
  line: "#2E2F28",
  text: "#F3F1EA",
  muted: "#A8A597",
  accent: "#F5B301",
  accentInk: "#1A1300",
  ok: "#7BD696",
  bad: "#F08A70",
  warn: "#F5B301",
};

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  pad: { padding: 16, gap: 12 },
  h1: { color: c.text, fontSize: 26, fontWeight: "800" },
  h2: { color: c.text, fontSize: 18, fontWeight: "700" },
  text: { color: c.text, fontSize: 16 },
  muted: { color: c.muted, fontSize: 14 },
  mono: { color: c.text, fontFamily: "monospace", fontSize: 14 },
  card: { backgroundColor: c.surface, borderColor: c.line, borderWidth: 1, borderRadius: 14, padding: 16, gap: 10 },
  label: { color: c.muted, fontSize: 13, fontWeight: "600" },
  input: { minHeight: 52, borderRadius: 10, borderWidth: 1, borderColor: c.line, backgroundColor: c.bg, color: c.text, paddingHorizontal: 14, fontSize: 17 },
  btn: { minHeight: 52, borderRadius: 10, alignItems: "center", justifyContent: "center", paddingHorizontal: 16, borderWidth: 1, borderColor: c.line },
  btnText: { color: c.text, fontSize: 16, fontWeight: "700" },
  primary: { backgroundColor: c.accent, borderColor: c.accent },
  primaryText: { color: c.accentInk },
  row: { flexDirection: "row", gap: 10, alignItems: "center" },
  error: { backgroundColor: "#2D1B16", borderRadius: 10, padding: 12 },
  errorText: { color: c.bad, fontSize: 15 },
  okBox: { backgroundColor: "#1F2A20", borderRadius: 10, padding: 12 },
  okText: { color: c.ok, fontSize: 15 },
});

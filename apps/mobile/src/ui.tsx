import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View, type TextInputProps } from "react-native";
import { c, s } from "./theme";

export function Button({ title, onPress, primary, disabled, busy }: { title: string; onPress: () => void; primary?: boolean; disabled?: boolean; busy?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!(disabled || busy) }}
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [s.btn, primary && s.primary, { opacity: disabled ? 0.5 : pressed ? 0.8 : 1 }]}
    >
      {busy ? <ActivityIndicator color={primary ? c.accentInk : c.text} /> : <Text style={[s.btnText, primary && s.primaryText]}>{title}</Text>}
    </Pressable>
  );
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput accessibilityLabel={label} placeholderTextColor={c.muted} style={s.input} {...props} />
    </View>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <View style={s.error} accessibilityRole="alert">
      <Text style={s.errorText}>{(error as Error).message}</Text>
    </View>
  );
}

export function OkBox({ children }: { children: ReactNode }) {
  return (
    <View style={s.okBox} accessibilityLiveRegion="polite">
      <Text style={s.okText}>{children}</Text>
    </View>
  );
}

const TONE: Record<string, string> = { pending: c.warn, accepted: c.ok, partial: c.warn, rejected: c.bad, stock: c.ok, finished: c.ok, quarantine: c.bad, incoming_inspection: c.warn };
const LABEL: Record<string, string> = {
  pending: "Kontrol bekliyor", accepted: "Kabul", partial: "Kısmi kabul", rejected: "Ret", not_required: "—",
  stock: "Kullanılabilir", finished: "Bitmiş ürün", quarantine: "Karantina", incoming_inspection: "Giriş kontrolü", production: "Üretim", subcontractor: "Fason",
};

/** Durum her zaman metinle yazılır; renk tek bilgi taşıyıcısı değildir. */
export function Badge({ value }: { value: string }) {
  const color = TONE[value] ?? c.muted;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999, backgroundColor: c.surface2 }}>
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color }} />
      <Text style={{ color, fontSize: 13, fontWeight: "600" }}>{LABEL[value] ?? value}</Text>
    </View>
  );
}

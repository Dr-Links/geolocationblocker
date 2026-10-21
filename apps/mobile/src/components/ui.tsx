import type { ReactNode } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput,
  useColorScheme, View, type TextInputProps,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export function useTheme() {
  const dark = useColorScheme() === 'dark';
  return dark
    ? { bg: '#0f1720', surface: '#17212b', text: '#e4e7eb', muted: '#9aa5b1', border: '#2d3a48', primary: '#3b82f6', danger: '#f87171', ok: '#34d399', warn: '#fbbf24' }
    : { bg: '#f4f6f8', surface: '#ffffff', text: '#1f2933', muted: '#52606d', border: '#d9e2ec', primary: '#1d4ed8', danger: '#b91c1c', ok: '#047857', warn: '#b45309' };
}

export function Screen({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  const t = useTheme();
  const body = <View style={styles.inner}>{children}</View>;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={['bottom', 'left', 'right']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {scroll ? <ScrollView contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled">{body}</ScrollView> : body}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export function Title({ children }: { children: ReactNode }) {
  const t = useTheme();
  return <Text accessibilityRole="header" style={[styles.title, { color: t.text }]}>{children}</Text>;
}

export function Body({ children, muted, style }: { children: ReactNode; muted?: boolean; style?: object }) {
  const t = useTheme();
  return <Text style={[styles.body, { color: muted ? t.muted : t.text }, style]}>{children}</Text>;
}

export function Card({ children }: { children: ReactNode }) {
  const t = useTheme();
  return <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.border }]}>{children}</View>;
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  const t = useTheme();
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={[styles.label, { color: t.text }]}>{label}</Text>
      <TextInput
        placeholderTextColor={t.muted}
        accessibilityLabel={label}
        style={[styles.input, { color: t.text, backgroundColor: t.surface, borderColor: t.border }]}
        {...props}
      />
    </View>
  );
}

export function Button({ title, onPress, busy, disabled, variant = 'primary' }: {
  title: string; onPress: () => void; busy?: boolean; disabled?: boolean; variant?: 'primary' | 'secondary' | 'danger' | 'link';
}) {
  const t = useTheme();
  const bg = variant === 'primary' ? t.primary : variant === 'danger' ? t.danger : 'transparent';
  const fg = variant === 'primary' || variant === 'danger' ? '#ffffff' : t.primary;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy, busy }}
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, borderColor: variant === 'secondary' ? t.border : bg, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 },
        variant === 'link' && { paddingVertical: 8, borderWidth: 0 },
      ]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={[styles.buttonText, { color: fg }]}>{title}</Text>}
    </Pressable>
  );
}

export function Message({ text, kind = 'error' }: { text?: string | null; kind?: 'error' | 'ok' | 'info' }) {
  const t = useTheme();
  if (!text) return null;
  const color = kind === 'error' ? t.danger : kind === 'ok' ? t.ok : t.muted;
  return <Text accessibilityLiveRegion="polite" style={[styles.body, { color, marginBottom: 12 }]}>{text}</Text>;
}

export function Loading() {
  const t = useTheme();
  return <View style={[styles.center, { backgroundColor: t.bg }]}><ActivityIndicator size="large" color={t.primary} /></View>;
}

const styles = StyleSheet.create({
  inner: { flex: 1, padding: 20, width: '100%', maxWidth: 520, alignSelf: 'center' },
  title: { fontSize: 24, fontWeight: '700', marginBottom: 12 },
  body: { fontSize: 15, lineHeight: 22 },
  card: { borderWidth: 1, borderRadius: 12, padding: 16, marginBottom: 16 },
  label: { fontSize: 14, fontWeight: '600', marginBottom: 6 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 11, fontSize: 16 },
  button: { borderRadius: 8, borderWidth: 1, paddingVertical: 13, alignItems: 'center', marginTop: 8 },
  buttonText: { fontSize: 16, fontWeight: '600' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

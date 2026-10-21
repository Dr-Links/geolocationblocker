import { Redirect, Stack } from 'expo-router';
import { useTheme } from '../../components/ui';
import { useAuth } from '../../lib/auth';

export default function AuthLayout() {
  const { state } = useAuth();
  const t = useTheme();
  if (state.kind === 'signedIn') return <Redirect href="/" />;
  return (
    <Stack screenOptions={{ headerStyle: { backgroundColor: t.surface }, headerTintColor: t.text, contentStyle: { backgroundColor: t.bg } }}>
      <Stack.Screen name="login" options={{ title: 'Sign in' }} />
      <Stack.Screen name="register" options={{ title: 'Create account' }} />
      <Stack.Screen name="check-email" options={{ title: 'Check your email' }} />
      <Stack.Screen name="forgot-password" options={{ title: 'Reset password' }} />
    </Stack>
  );
}

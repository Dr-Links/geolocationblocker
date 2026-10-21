import { Redirect, Stack } from 'expo-router';
import { Loading, useTheme } from '../../components/ui';
import { useAuth } from '../../lib/auth';

/** Everything in (app) requires an active (approved, unexpired) account. The server enforces this too. */
export default function AppLayout() {
  const { state } = useAuth();
  const t = useTheme();
  if (state.kind === 'loading') return <Loading />;
  if (state.kind !== 'signedIn' || state.account.displayStatus !== 'active') return <Redirect href="/" />;
  return (
    <Stack screenOptions={{ headerStyle: { backgroundColor: t.surface }, headerTintColor: t.text, contentStyle: { backgroundColor: t.bg } }}>
      <Stack.Screen name="home" options={{ title: 'Email Platform' }} />
      <Stack.Screen name="sessions" options={{ title: 'Signed-in devices' }} />
      <Stack.Screen name="change-password" options={{ title: 'Change password' }} />
    </Stack>
  );
}

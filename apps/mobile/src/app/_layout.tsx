import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useTheme } from '../components/ui';
import { AuthProvider } from '../lib/auth';
import { UndoProvider } from '../lib/undo';
import { setupWeb } from '../lib/pwa';
import { UpdateNotice } from '../components/UpdateNotice';

setupWeb();

export default function RootLayout() {
  const t = useTheme();
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <UndoProvider>
        <UpdateNotice>
        <StatusBar style="auto" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: t.surface },
            headerTintColor: t.text,
            contentStyle: { backgroundColor: t.bg },
          }}
        >
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="(auth)" options={{ headerShown: false }} />
          <Stack.Screen name="(app)" options={{ headerShown: false }} />
          <Stack.Screen name="status" options={{ title: 'Account status', headerBackVisible: false }} />
        </Stack>
        </UpdateNotice>
        </UndoProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}

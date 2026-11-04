import { useEffect, useState } from 'react';
import { Linking, Platform, Pressable, Text, View } from 'react-native';
import { api } from '../lib/api';
import { APP_VERSION } from '../lib/config';
import { Body, Button, Title, useTheme } from './ui';

const parts = (v: string) => v.split(/[.+-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
export const versionLess = (a: string, b: string) => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
};

/**
 * The Android app is installed from an APK (not an app store), so it checks the server for a newer version.
 * Below the minimum supported version it must update; otherwise a newer version is only suggested.
 * The web app always loads the newest version and shows nothing.
 */
export function UpdateNotice({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  const [cfg, setCfg] = useState<{ min: string; latest: string | null; url: string | null } | null>(null);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (Platform.OS === 'web') return;
    api.config().then((c) => setCfg({ min: c.minimumSupportedAppVersion, latest: c.latestAppVersion, url: c.appDownloadUrl }), () => undefined);
  }, []);
  if (!cfg) return <>{children}</>;
  const open = () => { if (cfg.url) Linking.openURL(cfg.url).catch(() => undefined); };
  if (versionLess(APP_VERSION, cfg.min)) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', padding: 24, backgroundColor: t.bg }}>
        <Title>Please update AllWebMails</Title>
        <Body style={{ marginBottom: 16 }}>This version ({APP_VERSION}) is no longer supported. Download and install the new version to continue. Your mail and settings are kept.</Body>
        {cfg.url ? <Button title="Download the update" onPress={open} /> : <Body muted>Ask the administrator for the new version.</Body>}
      </View>
    );
  }
  const newer = cfg.latest && versionLess(APP_VERSION, cfg.latest) && !dismissed;
  return (
    <View style={{ flex: 1 }}>
      {newer ? (
        <Pressable accessibilityRole="button" onPress={open} style={{ backgroundColor: t.primary, padding: 8 }}>
          <Text style={{ color: '#fff', textAlign: 'center', fontSize: 13 }}>
            Version {cfg.latest} is available{cfg.url ? ' — tap to download' : ''}.{' '}
            <Text onPress={() => setDismissed(true)} style={{ textDecorationLine: 'underline' }}>Later</Text>
          </Text>
        </Pressable>
      ) : null}
      {children}
    </View>
  );
}

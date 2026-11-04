import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { canInstall, installHint, onInstallAvailable, promptInstall } from '../lib/pwa';
import { Body, Button, Card } from './ui';

/** Web only: "Install AllWebMails" (Android/desktop browsers) or Add-to-Home-Screen instructions (iPhone). */
export function InstallApp() {
  const [, rerender] = useState(0);
  useEffect(() => onInstallAvailable(() => rerender((n) => n + 1)), []);
  if (Platform.OS !== 'web') return null;
  const hint = installHint();
  if (!canInstall() && !hint) return null;
  return (
    <Card>
      <Body style={{ fontWeight: '700' }}>Install AllWebMails</Body>
      <Body muted style={{ fontSize: 13, marginBottom: 6 }}>Open it like an app, from your home screen or desktop, and get new-mail notifications.</Body>
      {canInstall() ? <Button title="Install the app" variant="secondary" onPress={() => { promptInstall().catch(() => undefined); }} /> : <Body style={{ fontSize: 13 }}>{hint}</Body>}
    </Card>
  );
}

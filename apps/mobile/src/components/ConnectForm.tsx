import type { CertificateDto, ConnectFailureDetails, MailboxDto, Security, ServerSettingsDto } from '@app/shared';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { ApiError, type CertificatePin, type ConnectInput } from '../lib/api';
import { Body, Button, Card, Field, Message, useTheme } from './ui';

type Mode = 'add' | 'reconnect';

interface Props {
  mode: Mode;
  /** Fixed address when reconnecting. */
  email?: string;
  initialSettings?: { imap: ServerSettingsDto; smtp: ServerSettingsDto } | null;
  submit(input: ConnectInput): Promise<{ mailbox: MailboxDto }>;
  onDone(m: MailboxDto): void;
}

const emptyServer = (host = '', port = 993, security: Security = 'tls', username = ''): ServerSettingsDto => ({ host, port, security, username });

function SecurityPicker({ value, onChange }: { value: Security; onChange: (s: Security) => void }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
      {(['tls', 'starttls'] as const).map((s) => (
        <Pressable key={s} accessibilityRole="radio" accessibilityState={{ selected: value === s }} onPress={() => onChange(s)}
          style={{ flex: 1, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: value === s ? t.primary : t.border, backgroundColor: value === s ? t.primary : 'transparent' }}>
          <Text style={{ textAlign: 'center', color: value === s ? '#fff' : t.text, fontWeight: '600' }}>{s === 'tls' ? 'SSL/TLS' : 'STARTTLS'}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function ServerFields({ title, value, onChange }: { title: string; value: ServerSettingsDto; onChange: (v: ServerSettingsDto) => void }) {
  return (
    <Card>
      <Body style={{ fontWeight: '700', marginBottom: 8 }}>{title}</Body>
      <Field label="Server name" value={value.host} onChangeText={(host) => onChange({ ...value, host })} autoCapitalize="none" autoCorrect={false} placeholder="e.g. mail.yourdomain.com" />
      <Field label="Port" value={String(value.port || '')} onChangeText={(p) => onChange({ ...value, port: Number(p.replace(/\D/g, '')) || 0 })} keyboardType="number-pad" />
      <SecurityPicker value={value.security} onChange={(security) => onChange({ ...value, security })} />
      <Field label="Username" value={value.username} onChangeText={(username) => onChange({ ...value, username })} autoCapitalize="none" autoCorrect={false} />
    </Card>
  );
}

function CertificateWarning({ cert, stage, onTrust }: { cert: CertificateDto; stage: string; onTrust: () => void }) {
  const t = useTheme();
  return (
    <Card>
      <Body style={{ fontWeight: '700', color: t.warn }}>Security certificate not trusted ({stage === 'imap' ? 'incoming' : 'outgoing'} server)</Body>
      <Body muted style={{ marginTop: 6 }}>Issued to: {cert.subject ?? '—'}{cert.altNames.length ? ` (${cert.altNames.slice(0, 4).join(', ')})` : ''}</Body>
      <Body muted>Issued by: {cert.issuer ?? '—'}</Body>
      <Body muted>Valid until: {cert.validTo ?? '—'}</Body>
      <Body muted style={{ fontSize: 12 }}>Fingerprint: {cert.fingerprint256}</Body>
      {cert.altNames[0] && !cert.altNames[0].startsWith('*') ? (
        <Body style={{ marginTop: 8 }}>Tip: on shared hosting, using the server name above ({cert.altNames[0]}) in manual settings usually fixes this safely.</Body>
      ) : null}
      <Body style={{ marginTop: 8 }}>Only trust this certificate if you are sure the server belongs to your email provider. Someone intercepting your connection could otherwise read your password.</Body>
      <Button title="Trust this exact certificate" variant="secondary" onPress={onTrust} />
    </Card>
  );
}

export function ConnectForm({ mode, email: fixedEmail, initialSettings, submit, onDone }: Props) {
  const [email, setEmail] = useState(fixedEmail ?? '');
  const [password, setPassword] = useState('');
  const [smtpPassword, setSmtpPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [showManual, setShowManual] = useState(false);
  const [imap, setImap] = useState<ServerSettingsDto>(initialSettings?.imap ?? emptyServer());
  const [smtp, setSmtp] = useState<ServerSettingsDto>(initialSettings?.smtp ?? emptyServer('', 465));
  const [trust, setTrust] = useState<{ imap?: CertificatePin; smtp?: CertificatePin }>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<ConnectFailureDetails | null>(null);

  const openManual = () => {
    const user = email.trim().toLowerCase();
    const domain = user.split('@')[1] ?? '';
    if (!imap.host) setImap(emptyServer(domain ? `mail.${domain}` : '', 993, 'tls', user));
    if (!smtp.host) setSmtp(emptyServer(domain ? `mail.${domain}` : '', 465, 'tls', user));
    setShowManual(true);
  };

  const run = async (extraTrust = trust) => {
    setBusy(true); setError(null); setDetails(null);
    try {
      const r = await submit({
        email: email.trim().toLowerCase(),
        password,
        smtpPassword: smtpPassword || undefined,
        displayName: displayName.trim() || undefined,
        manual: showManual || mode === 'reconnect' && initialSettings ? (showManual ? { imap, smtp } : undefined) : undefined,
        trustCertificate: extraTrust.imap || extraTrust.smtp ? extraTrust : undefined,
      });
      setPassword(''); setSmtpPassword('');
      onDone(r.mailbox);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection failed.');
      if (e instanceof ApiError && e.code === 'mailbox_connect_failed') {
        const d = e.details as ConnectFailureDetails;
        setDetails(d);
        if (d.triedAutomatic && d.reason !== 'AUTH_FAILED' && !d.provider?.requiresOAuth) openManual();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <View>
      {mode === 'add' ? (
        <>
          <Field label="Email address" value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" placeholder="sales@yourcompany.com" />
          <Field label="Name shown to recipients (optional)" value={displayName} onChangeText={setDisplayName} placeholder="e.g. Sales Team" />
        </>
      ) : null}
      <Field label="Mailbox password" value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" autoCorrect={false} />
      <Body muted style={{ marginBottom: 12, fontSize: 13 }}>
        This is the password of the mailbox at your email provider (not your platform password). It is stored encrypted and is never shown again.
      </Body>

      <Message text={error} />
      {details?.provider?.requiresAppPassword && details.reason === 'AUTH_FAILED' ? (
        <Body style={{ marginBottom: 12 }}>{details.provider.name} needs an "app password" instead of your normal password. Create one in your {details.provider.name} security settings and enter it here.</Body>
      ) : null}
      {details?.certificate ? (
        <CertificateWarning cert={details.certificate} stage={details.stage} onTrust={() => {
          const pin = { sha256: details.certificate!.fingerprint256, pem: details.certificate!.pem };
          const next = { ...trust, [details.stage]: pin };
          setTrust(next);
          run(next);
        }} />
      ) : null}

      {showManual ? (
        <>
          <Body muted style={{ marginBottom: 10 }}>Enter the settings from your email provider or hosting control panel (for cPanel: Email Accounts → Connect Devices).</Body>
          <ServerFields title="Incoming mail (IMAP)" value={imap} onChange={setImap} />
          <ServerFields title="Outgoing mail (SMTP)" value={smtp} onChange={setSmtp} />
          <Field label="Outgoing password, if different (optional)" value={smtpPassword} onChangeText={setSmtpPassword} secureTextEntry autoCapitalize="none" />
        </>
      ) : (
        <Button title="Enter server settings manually" variant="link" onPress={openManual} />
      )}

      <Button title={busy ? 'Checking connection…' : mode === 'add' ? 'Connect mailbox' : 'Save and reconnect'} onPress={() => run()} busy={busy}
        disabled={!password || (mode === 'add' && !email)} />
      {busy ? <Body muted style={{ marginTop: 8, textAlign: 'center' }}>This can take up to a minute while we find and test the servers.</Body> : null}
    </View>
  );
}

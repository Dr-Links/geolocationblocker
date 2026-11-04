import { router } from 'expo-router';
import { Body, Screen, Title } from '../../components/ui';
import { ConnectForm } from '../../components/ConnectForm';
import { api } from '../../lib/api';

export default function AddMailbox() {
  return (
    <Screen>
      <Title>Add a mailbox</Title>
      <Body muted style={{ marginBottom: 16 }}>
        Connect a business mailbox (cPanel, Hostinger, Zoho, and other IMAP/SMTP providers). We find the server settings automatically and test them before saving.
      </Body>
      <ConnectForm mode="add" submit={api.connectMailbox} onDone={(m) => router.replace({ pathname: '/mailbox/[id]', params: { id: m.id } })} />
    </Screen>
  );
}

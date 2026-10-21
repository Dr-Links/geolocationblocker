import { Redirect } from 'expo-router';
import { Body, Button, Loading, Screen, Title } from '../components/ui';
import { useAuth } from '../lib/auth';

/** Routes the user to the right place for their account state. */
export default function Index() {
  const { state, reload, signOut } = useAuth();
  if (state.kind === 'loading') return <Loading />;
  if (state.kind === 'error') {
    return (
      <Screen>
        <Title>Can't connect</Title>
        <Body muted>{state.message}</Body>
        <Button title="Try again" onPress={reload} />
        <Button title="Sign out" variant="link" onPress={signOut} />
      </Screen>
    );
  }
  if (state.kind === 'signedOut') return <Redirect href="/login" />;
  return state.account.displayStatus === 'active' ? <Redirect href="/home" /> : <Redirect href="/status" />;
}

// Account: create an account or log in (email and password), to keep your hikes and saved trails on the
// Switchback server and on every phone you log in on. Optional: without an account everything stays on this
// phone. Logged in, it shows who you are, how syncing is going, and Log out.
import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { account, logIn, logOut, register, rename } from '../core/server';
import { lastSync, pendingCount, syncError, syncNow, syncOffline, syncing } from '../core/sync';
import { useValue } from '../ui/hooks';
import { Button, Card, Icon, Note, Segmented, T, Tap } from '../ui/kit';
import { fonts, radius, useTheme } from '../ui/theme';

type Mode = 'register' | 'login';

export function AccountScreen({ onBack }: { onBack: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const me = useValue(account);
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: t.c.bg }}>
      <View style={{ paddingTop: insets.top + 4, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center' }}>
        <Tap onPress={onBack} accessibilityRole="button" accessibilityLabel="Back" style={{ flexDirection: 'row', alignItems: 'center', padding: 8 }}>
          <Icon name="back" size={20} color={t.c.link} />
          <T v="strong" color={t.c.link}>Back</T>
        </Tap>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 18, paddingBottom: insets.bottom + 32 }} keyboardShouldPersistTaps="handled">
        {me ? <LoggedIn /> : <SignUpOrIn onDone={onBack} />}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field({ label, ...props }: { label: string } & React.ComponentProps<typeof TextInput>) {
  const t = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <T v="label" muted>{label}</T>
      <TextInput placeholderTextColor={t.c.muted} accessibilityLabel={label} {...props}
        style={{ height: 48, borderRadius: radius.control, backgroundColor: t.c.card, paddingHorizontal: 12, color: t.c.ink, fontFamily: fonts.regular, fontSize: 16 }} />
    </View>
  );
}

function SignUpOrIn({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<Mode>('register');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email.trim());
  const passwordOk = password.length >= 8;
  const go = async () => {
    setError(null);
    setBusy(true);
    try {
      if (mode === 'register') await register(email, password, name);
      else await logIn(email, password);
      setPassword('');
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <T v="name">{mode === 'register' ? 'Create an account' : 'Log in'}</T>
      <T v="body" muted>
        An account keeps your hikes, saved trails and photos on your Switchback account, so they're safe if you lose
        or reinstall the app and they're on every phone you log in on. You don't need one: without it everything
        stays on this phone. What's already here is added to your account when you log in.
      </T>
      <Segmented<Mode> value={mode} onChange={(m) => { setMode(m); setError(null); }}
        options={[{ value: 'register', label: 'Create account' }, { value: 'login', label: 'Log in' }]} />
      {mode === 'register' && (
        <Field label="Your name (shown with photos and reviews)" value={name} onChangeText={setName} placeholder="Hiker" maxLength={40} autoComplete="name" textContentType="name" />
      )}
      <Field label="Email" value={email} onChangeText={setEmail} placeholder="you@example.com" autoCapitalize="none" autoCorrect={false}
        keyboardType="email-address" autoComplete="email" textContentType="emailAddress" />
      <Field label={mode === 'register' ? 'Password (at least 8 characters)' : 'Password'} value={password} onChangeText={setPassword}
        secureTextEntry autoCapitalize="none" autoCorrect={false}
        autoComplete={mode === 'register' ? 'new-password' : 'current-password'} textContentType={mode === 'register' ? 'newPassword' : 'password'}
        onSubmitEditing={() => { if (emailOk && passwordOk && !busy) void go(); }} returnKeyType="go" />
      {error && <Note warn>{error}</Note>}
      <Button big kind="primary" title={busy ? 'One moment…' : mode === 'register' ? 'Create account' : 'Log in'} onPress={() => void go()}
        disabled={busy || !emailOk || !passwordOk} />
      <T v="tiny" muted>Your email is only used to log you in: Switchback keeps a scrambled form of it, never the address itself, and never emails you.</T>

    </>
  );
}

function LoggedIn() {
  const t = useTheme();
  const me = useValue(account)!;
  const busy = useValue(syncing);
  const err = useValue(syncError);
  const offline = useValue(syncOffline);
  const last = useValue(lastSync);
  const waiting = useValue(pendingCount);
  const [name, setName] = useState<string | null>(null);

  const out = () => Alert.alert('Log out?', 'Your hikes and saved trails stay on this phone and on your account. They stop syncing until you log in again.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Log out', style: 'destructive', onPress: () => void logOut() },
  ]);
  const saveName = async () => {
    const n = (name ?? '').trim();
    setName(null);
    if (n && n !== me.display_name) await rename(n).catch((e) => Alert.alert("Couldn't change your name", (e as Error).message));
  };

  return (
    <>
      <T v="name">Your account</T>
      <Card style={{ gap: 10 }}>
        {name != null ? (
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TextInput value={name} onChangeText={setName} autoFocus maxLength={40} onSubmitEditing={() => void saveName()} returnKeyType="done"
              style={{ flex: 1, height: 46, borderRadius: radius.control, backgroundColor: t.c.bg, paddingHorizontal: 12, color: t.c.ink, fontFamily: fonts.semibold, fontSize: 17 }} />
            <Button kind="primary" title="Save" onPress={() => void saveName()} />
          </View>
        ) : (
          <Tap onPress={() => setName(me.display_name)} accessibilityLabel="Change your name" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <T v="large">{me.display_name}</T>
            <Icon name="pencil" size={16} color={t.c.muted} />
          </Tap>
        )}
        <T v="small" muted>Your hikes, saved trails and photos are kept on your account and synced whenever there's a connection.</T>
      </Card>
      <Card style={{ gap: 10 }}>
        {err ? <T v="small" color={offline ? t.c.muted : t.c.hard}>{err}</T>
          : <T v="small" muted>{busy ? 'Syncing…' : last ? `Last synced ${new Date(last).toLocaleString()}` : 'Not synced yet'}</T>}
        {waiting > 0 && <T v="small" muted>{waiting} {waiting === 1 ? 'change' : 'changes'} waiting to upload</T>}
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <Button kind="primary" title={busy ? 'Syncing…' : 'Sync now'} onPress={() => void syncNow()} disabled={busy} />
        </View>
      </Card>
      <Button kind="danger" title="Log out" onPress={out} />
    </>
  );
}

// Settings: account & sync (optional: sign in to your own Switchback server), units, the trail files on this phone (reset and download again), the maps on this phone (Clear),
// downloading maps over mobile data, the look, and credits.
import { useEffect, useState } from 'react';
import { Alert, ScrollView, Switch, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Constants from 'expo-constants';
import { resetTrailFiles, trailFilesOnDevice, type TrailFilesInfo } from '@web/data';
import { mapsOverCellular, themePref, units, type ThemePref } from '../core/state';
import { clearMaps, offlineSummary } from '../core/offline';
import { platform } from '../platform';
import { api, hasKey, normaliseUrl, serverUrl, signIn, signOut } from '../core/server';
import { lastSync, pendingCount, syncError, syncNow, syncOffline, syncing } from '../core/sync';
import { useValue } from '../ui/hooks';
import { Button, Card, Icon, Segmented, T, Tap } from '../ui/kit';
import { fonts, useTheme } from '../ui/theme';

const mb = (b: number) => `${Math.max(0, b / 1e6).toFixed(b < 1e7 ? 1 : 0)} MB`;

export function SettingsScreen({ onBack }: { onBack: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const u = useValue(units);
  const theme = useValue(themePref);
  const cell = useValue(mapsOverCellular);
  const [files, setFiles] = useState<TrailFilesInfo | null>(null);
  const [maps, setMaps] = useState<{ packs: number; bytes: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => {
    void trailFilesOnDevice().then(setFiles, () => setFiles({ regions: [], bytes: 0 }));
    void offlineSummary().then(setMaps, () => setMaps({ packs: 0, bytes: 0 }));
  };
  useEffect(refresh, []);

  const reset = () => Alert.alert('Download the trail files again?', 'The trail files on this phone are replaced with the current ones.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Download again', onPress: async () => {
      setBusy('Downloading the trail files again…');
      const said = await resetTrailFiles();
      setBusy(null);
      Alert.alert('Trail files', said);
      refresh();
    } },
  ]);
  const clear = () => Alert.alert('Clear the maps on this phone?', 'Saved maps are removed. Maps around you and around trails you open are saved again when there is a connection.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Clear', style: 'destructive', onPress: async () => { setBusy('Clearing maps…'); await clearMaps(); setBusy(null); refresh(); } },
  ]);

  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <View style={{ gap: 8 }}>
      <T v="label" muted>{title}</T>
      <Card style={{ gap: 12 }}>{children}</Card>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: t.c.bg }}>
      <View style={{ paddingTop: insets.top + 4, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center' }}>
        <Tap onPress={onBack} accessibilityRole="button" accessibilityLabel="Back" style={{ flexDirection: 'row', alignItems: 'center', padding: 8 }}>
          <Icon name="back" size={20} color={t.c.link} />
          <T v="strong" color={t.c.link}>Back</T>
        </Tap>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 20, paddingBottom: insets.bottom + 32 }}>
        <T v="name">Settings</T>
        <AccountSection />
        <Section title="Units">
          <Segmented value={u} onChange={(v) => { units.value = v; }} options={[{ value: 'imperial', label: 'Miles and feet' }, { value: 'metric', label: 'Kilometres and metres' }]} />
        </Section>
        <Section title="Look">
          <Segmented<ThemePref> value={theme} onChange={(v) => { themePref.value = v; }}
            options={[{ value: 'auto', label: 'Like the phone' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
        </Section>
        <Section title="Trail files on this phone">
          <T v="small">
            {files == null ? 'Checking…' : files.regions.length
              ? `${files.regions.length} ${files.regions.length === 1 ? 'region' : 'regions'}, about ${mb(files.bytes)}: ${files.regions.join(', ')}`
              : 'None yet. A region downloads by itself when the map shows it.'}
          </T>
          <Button title="Reset and download again" onPress={reset} disabled={!!busy} />
        </Section>
        <Section title="Maps on this phone">
          <T v="small">
            {maps == null ? 'Checking…' : `${maps.packs} saved ${maps.packs === 1 ? 'area' : 'areas'}, ${mb(maps.bytes)}. The map around you and around trails you open, save or start is saved by itself; everything you look at is kept too.`}
          </T>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <T v="body" style={{ flex: 1 }}>Download maps over mobile data</T>
            <Switch value={cell} onValueChange={(v) => { mapsOverCellular.value = v; }} trackColor={{ true: t.c.primary, false: t.c.line2 }} />
          </View>
          <Button kind="danger" title="Clear" onPress={clear} disabled={!!busy} />
        </Section>
        {busy && <T v="small" muted>{busy}</T>}
        <Section title="Credits">
          <T v="small">Trail data © OpenStreetMap contributors (ODbL), with park and agency trail lists. Base map: OpenFreeMap, © OpenMapTiles, © OpenStreetMap contributors. Hillshade: Mapzen terrain tiles on AWS. Map engine: MapLibre Native. Type: Figtree and Bricolage Grotesque (SIL Open Font License).</T>
          <Tap onPress={() => platform.links.open('https://github.com/CadeWardC/switchback')}><T v="small" color={t.c.link}>Switchback on GitHub</T></Tap>
          <T v="tiny" muted>Version {Constants.expoConfig?.version ?? '1.0.0'} (React Native)</T>
        </Section>
      </ScrollView>
    </View>
  );
}

/** Account & sync. Signing in is optional: without it everything stays on this phone. */
function AccountSection() {
  const t = useTheme();
  const url = useValue(serverUrl);
  const keyStored = useValue(hasKey);
  const busy = useValue(syncing);
  const err = useValue(syncError);
  const offline = useValue(syncOffline);
  const last = useValue(lastSync);
  const waiting = useValue(pendingCount);
  const [editing, setEditing] = useState(false);
  const [address, setAddress] = useState(url ?? '');
  const [key, setKey] = useState('');
  const [check, setCheck] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const signedIn = !!url && keyStored;

  const input = { height: 46, borderRadius: 10, backgroundColor: t.c.bg, paddingHorizontal: 12, color: t.c.ink, fontSize: 16 } as const;
  const checkConnection = async () => {
    const base = normaliseUrl(address) ?? url;
    if (!base) { setCheck('Enter the server address first (https only).'); return; }
    setChecking(true);
    setCheck(await api.health(base));
    setChecking(false);
  };
  const doSignIn = async () => {
    try {
      await signIn(address, key);
      setKey('');
      setEditing(false);
      setCheck(null);
    } catch (e) {
      Alert.alert("Couldn't sign in", (e as Error).message);
    }
  };
  const doSignOut = () => Alert.alert('Sign out?', 'Your saved trails and hikes stay on this phone. They stop syncing with the server.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Sign out', style: 'destructive', onPress: () => { void signOut(); setAddress(''); } },
  ]);

  return (
    <View style={{ gap: 8 }}>
      <T v="label" muted>Account & sync</T>
      <Card style={{ gap: 12 }}>
        {signedIn && !editing ? (
          <>
            <T v="small">Signed in to <T v="small" style={{ fontFamily: fonts.semibold }}>{url!.replace(/^https:\/\//, '')}</T>. Saved trails and hikes are kept on this phone and synced with the server whenever it can be reached.</T>
            {err ? (
              <T v="small" color={offline ? t.c.muted : t.c.hard}>{err}</T>
            ) : (
              <T v="small" muted>{busy ? 'Syncing…' : last ? `Last synced ${new Date(last).toLocaleString()}` : 'Not synced yet'}</T>
            )}
            {waiting > 0 && <T v="small" muted>{waiting} {waiting === 1 ? 'change' : 'changes'} waiting to upload</T>}
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <Button kind="primary" title={busy ? 'Syncing…' : 'Sync now'} onPress={() => void syncNow()} disabled={busy} />
              <Button title={checking ? 'Checking…' : 'Check connection'} onPress={() => void checkConnection()} disabled={checking} />
            </View>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <Button kind="quiet" title="Change server or key" onPress={() => { setAddress(url ?? ''); setEditing(true); }} />
              <Button kind="danger" title="Sign out" onPress={doSignOut} />
            </View>
          </>
        ) : (
          <>
            <T v="small" muted>You don't need to sign in: without it, your saved trails and hikes stay on this phone. Sign in to back them up to a Switchback server, sync them between devices and submit hikes. What you already have is uploaded the first time.</T>
            <TextInput value={address} onChangeText={setAddress} placeholder="Server address (https://…)" placeholderTextColor={t.c.muted}
              autoCapitalize="none" autoCorrect={false} keyboardType="url" style={input} accessibilityLabel="Server address" />
            <TextInput value={key} onChangeText={setKey} placeholder={keyStored ? 'API key (saved; type to replace)' : 'API key'} placeholderTextColor={t.c.muted}
              autoCapitalize="none" autoCorrect={false} secureTextEntry style={input} accessibilityLabel="API key" />
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <Button kind="primary" title="Sign in" onPress={() => void doSignIn()} disabled={!normaliseUrl(address) || (!key.trim() && !keyStored)} />
              <Button title={checking ? 'Checking…' : 'Check connection'} onPress={() => void checkConnection()} disabled={checking} />
              {editing && <Button kind="quiet" title="Cancel" onPress={() => { setEditing(false); setKey(''); }} />}
            </View>
          </>
        )}
        {check && <T v="small" muted>{check}</T>}
      </Card>
    </View>
  );
}

// The app shell: the map always loaded underneath; one native sheet (gorhom) that follows the finger, with
// Explore, a trail, the hike or a recorded hike in it; Saved and Log as full native lists; and the bottom row
// of four plain words with the yellow blaze, which steps away during a hike. Settings is pushed on a native
// stack (native transition and back gesture).
import { useEffect, useMemo, useRef } from 'react';
import { BackHandler, StyleSheet, View, useWindowDimensions } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { NavigationContainer, DefaultTheme, DarkTheme, type NavigationProp } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import BottomSheet from '@gorhom/bottom-sheet';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import * as SystemUI from 'expo-system-ui';
import { StatusBar } from 'expo-status-bar';
import { effect } from '@preact/signals-core';
import {
  closeTrail, locationState, online, recState, selected, sheetIndex, shownWalk, tab, toast, type Tab,
} from './core/state';
import { locateMe, turnOnLocation } from './core/locate';
import { TrailMap } from './map/TrailMap';
import { ExploreSheet } from './screens/Explore';
import { TrailSheet } from './screens/TrailPage';
import { HikeSheet } from './screens/Hike';
import { LogScreen, SavedScreen, WalkSheet } from './screens/Lists';
import { SettingsScreen } from './screens/Settings';
import { useValue } from './ui/hooks';
import { Grabber, Icon, T, Tap } from './ui/kit';
import { fontFiles, fonts, mapColors, radius, shadow, size, useTheme } from './ui/theme';

void SplashScreen.preventAutoHideAsync().catch(() => {});

type Routes = { Home: undefined; Settings: undefined };
const Stack = createNativeStackNavigator<Routes>();

const TABS: { tab: Tab; label: string }[] = [
  { tab: 'explore', label: 'Explore' }, { tab: 'hike', label: 'Hike' }, { tab: 'saved', label: 'Saved' }, { tab: 'log', label: 'Log' },
];

function TabRow() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const current = useValue(tab);
  return (
    <View style={{
      position: 'absolute', left: 0, right: 0, bottom: 0, height: size.tabBar + insets.bottom, paddingBottom: insets.bottom,
      backgroundColor: t.c.bg, flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.c.line,
    }} accessibilityRole="tablist">
      {TABS.map((x) => {
        const on = current === x.tab;
        return (
          <Tap key={x.tab} onPress={() => { if (tab.peek() !== x.tab) tab.value = x.tab; else if (x.tab === 'explore') closeTrail(); }}
            accessibilityRole="tab" accessibilityState={{ selected: on }}
            style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4 }}>
            <View style={{ width: 8, height: 12, borderRadius: radius.blaze, backgroundColor: on ? mapColors.me : 'transparent' }} />
            <T v="body" style={{ fontFamily: on ? fonts.semibold : fonts.medium }} color={on ? t.c.ink : t.c.muted}>{x.label}</T>
          </Tap>
        );
      })}
    </View>
  );
}

function Toast({ bottom }: { bottom: number }) {
  const t = useTheme();
  const text = useValue(toast);
  if (!text) return null;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 24, right: 24, bottom, alignItems: 'center' }}>
      <View style={[{ backgroundColor: t.c.ink, borderRadius: radius.chip, paddingHorizontal: 16, paddingVertical: 10 }, shadow(t)]}>
        <T v="small" color={t.c.bg} style={{ fontFamily: fonts.semibold }}>{text}</T>
      </View>
    </View>
  );
}

/** Over the top of the map: "Offline", "Turn on location", and the locate button. */
function MapChrome() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const isOnline = useValue(online);
  const loc = useValue(locationState);
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', top: insets.top + 8, left: 12, right: 12, flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
      <View style={{ flex: 1, flexDirection: 'row', gap: 8 }} pointerEvents="box-none">
        {!isOnline && (
          <View style={[{ backgroundColor: t.c.card, borderRadius: radius.chip, paddingHorizontal: 12, paddingVertical: 7 }, shadow(t)]}>
            <T v="small" style={{ fontFamily: fonts.semibold }}>Offline</T>
          </View>
        )}
        {loc === 'denied' && (
          <Tap onPress={turnOnLocation} style={[{ backgroundColor: t.c.card, borderRadius: radius.chip, paddingHorizontal: 12, paddingVertical: 7 }, shadow(t)]}>
            <T v="small" color={t.c.link} style={{ fontFamily: fonts.semibold }}>Turn on location</T>
          </Tap>
        )}
      </View>
      <Tap onPress={locateMe} accessibilityRole="button" accessibilityLabel="Show where I am"
        style={[{ width: 44, height: 44, borderRadius: 22, backgroundColor: t.c.card, alignItems: 'center', justifyContent: 'center' }, shadow(t)]}>
        <Icon name="locate" size={22} color={t.c.ink} />
      </Tap>
    </View>
  );
}

function SheetContent() {
  const current = useValue(tab);
  const sel = useValue(selected);
  const walk = useValue(shownWalk);
  if (current === 'hike') return <HikeSheet />;
  if (current === 'log') return walk ? <WalkSheet /> : null;
  return sel ? <TrailSheet key={sel.key} /> : <ExploreSheet />;
}

function Home({ navigation }: { navigation: NavigationProp<Routes> }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const current = useValue(tab);
  const rec = useValue(recState);
  const walk = useValue(shownWalk);
  const index = useValue(sheetIndex);
  const sheet = useRef<BottomSheet>(null);
  const hiking = rec !== 'idle';
  const rowH = hiking ? 0 : size.tabBar + insets.bottom;
  const sheetShown = current === 'explore' || current === 'hike' || (current === 'log' && !!walk);
  const snapPoints = useMemo(() => [hiking ? 250 : 160, '52%', '92%'], [hiking]);

  // a hike in progress keeps the Hike screen (the bottom row steps away)
  useEffect(() => effect(() => { if (recState.value !== 'idle' && tab.peek() !== 'hike') tab.value = 'hike'; }), []);
  useEffect(() => {
    if (!sheetShown) sheet.current?.close();
    else sheet.current?.snapToIndex(Math.max(0, sheetIndex.peek()));
  }, [sheetShown, current]);
  useEffect(() => effect(() => {
    const i = sheetIndex.value;
    if (i >= 0) sheet.current?.snapToIndex(i);
  }), []);

  // Android back: close what is open, step back to Explore, then leave
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (tab.peek() === 'log' && shownWalk.peek()) { shownWalk.value = null; return true; }
      if (tab.peek() === 'explore' && selected.peek()) { closeTrail(); return true; }
      if (tab.peek() !== 'explore' && recState.peek() === 'idle') { tab.value = 'explore'; return true; }
      return false;
    });
    return () => sub.remove();
  }, []);

  const bottomInset = rowH + (index <= 0 ? (hiking ? 250 : 160) : height * 0.45);
  const openSettings = () => navigation.navigate('Settings');

  return (
    <View style={{ flex: 1, backgroundColor: t.c.mapLand }}>
      <StatusBar style={t.dark ? 'light' : 'dark'} />
      <TrailMap bottomInset={bottomInset} />
      <MapChrome />
      {current === 'saved' && <View style={[StyleSheet.absoluteFill, { bottom: rowH }]}><SavedScreen onSettings={openSettings} /></View>}
      {current === 'log' && !walk && <View style={[StyleSheet.absoluteFill, { bottom: rowH }]}><LogScreen onSettings={openSettings} /></View>}
      <BottomSheet
        ref={sheet}
        index={sheetShown ? 1 : -1}
        snapPoints={snapPoints}
        enableDynamicSizing={false}
        bottomInset={rowH}
        topInset={insets.top}
        onChange={(i) => { if (i >= 0 && i !== sheetIndex.peek()) sheetIndex.value = i; }}
        handleComponent={Grabber}
        backgroundStyle={{ backgroundColor: t.c.bg, borderRadius: radius.sheet }}
        keyboardBehavior="extend"
        keyboardBlurBehavior="restore"
        android_keyboardInputMode="adjustResize"
        style={shadow(t)}
      >
        <SheetContent />
      </BottomSheet>
      {!hiking && <TabRow />}
      <Toast bottom={rowH + 16} />
    </View>
  );
}

function SettingsRoute({ navigation }: { navigation: NavigationProp<Routes> }) {
  return <SettingsScreen onBack={() => navigation.goBack()} />;
}

export default function App() {
  const t = useTheme();
  const [loaded, error] = useFonts(fontFiles);
  const ready = loaded || !!error;
  useEffect(() => { if (ready) void SplashScreen.hideAsync().catch(() => {}); }, [ready]);
  useEffect(() => { void SystemUI.setBackgroundColorAsync(t.c.bg).catch(() => {}); }, [t.c.bg]);
  const navTheme = useMemo(() => {
    const base = t.dark ? DarkTheme : DefaultTheme;
    return { ...base, colors: { ...base.colors, background: t.c.bg, card: t.c.bg, text: t.c.ink, primary: t.c.primary, border: t.c.line } };
  }, [t]);
  if (!ready) return null;
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <NavigationContainer theme={navTheme}>
          <Stack.Navigator screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.c.bg } }}>
            <Stack.Screen name="Home" component={Home} />
            <Stack.Screen name="Settings" component={SettingsRoute} />
          </Stack.Navigator>
        </NavigationContainer>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

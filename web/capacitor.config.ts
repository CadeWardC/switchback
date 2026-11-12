import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.cadewardc.switchback',
  appName: 'Switchback',
  webDir: 'dist',
  android: {
    // Keeps location updates flowing to the page while the app is in the background
    // (@capacitor-community/background-geolocation asks for this; without it they stop after five minutes).
    useLegacyBridge: true,
  },
  ios: {
    // the page handles the safe areas itself (env(safe-area-inset-*))
    contentInset: 'never',
    backgroundColor: '#F7F6F2',
  },
  plugins: {
    // trail files come straight from the GitHub release: native HTTP has no CORS limit
    // (fetch stays the browser's own; the app calls native HTTP itself where it needs to)
    CapacitorHttp: { enabled: false },
    SplashScreen: { launchAutoHide: true, launchShowDuration: 600, backgroundColor: '#1F4D3A', showSpinner: false },
    LocalNotifications: { smallIcon: 'ic_stat_switchback', iconColor: '#1F6B45' },
  },
};

export default config;

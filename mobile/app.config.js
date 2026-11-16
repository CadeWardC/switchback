// Expo config for the React Native Switchback app (iPhone and Android). `npx expo prebuild` turns this into
// the native android/ and ios/ projects; they are not committed (CI regenerates them).

// The app id: ".rn" so it installs beside the existing Switchback apps while the two are compared.
// Change this one line to take over the real id later.
const APP_ID = 'com.cadewardc.switchback.rn';

const STONE = '#edf0ec';
const STONE_DARK = '#0d1512';

module.exports = {
  expo: {
    name: 'Switchback',
    slug: 'switchback',
    scheme: 'switchback',
    version: '1.0.0',
    orientation: 'portrait',
    // the Switchback server the app talks to for accounts: the Orange Pi, behind its Cloudflare tunnel. Not a
    // secret (accounts log in with their own passwords). SWITCHBACK_SERVER_URL overrides it, e.g. for a test server.
    extra: { serverUrl: process.env.SWITCHBACK_SERVER_URL || 'https://switchback2.opcw032522.uk' },
    icon: './assets/icon.png',
    userInterfaceStyle: 'automatic',
    backgroundColor: STONE,
    ios: {
      bundleIdentifier: APP_ID,
      supportsTablet: true,
      buildNumber: '1',
      infoPlist: {
        UIBackgroundModes: ['location'],
        // the hike on the lock screen (targets/hike draws it, modules/hike-activity starts it)
        NSSupportsLiveActivities: true,
        ITSAppUsesNonExemptEncryption: false,
      },
    },
    android: {
      package: APP_ID,
      versionCode: 1,
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-foreground.png',
        backgroundColor: '#f6ae6c',
      },
      predictiveBackGestureEnabled: false,
      permissions: [
        'ACCESS_COARSE_LOCATION',
        'ACCESS_FINE_LOCATION',
        'ACCESS_BACKGROUND_LOCATION',
        'FOREGROUND_SERVICE',
        'FOREGROUND_SERVICE_LOCATION',
        'POST_NOTIFICATIONS',
        'VIBRATE',
      ],
      blockedPermissions: ['android.permission.RECORD_AUDIO', 'android.permission.SYSTEM_ALERT_WINDOW'],
    },
    plugins: [
      // adds the widget extension in targets/hike to the iPhone project
      '@bacons/apple-targets',
      '@maplibre/maplibre-react-native',
      [
        'expo-location',
        {
          locationWhenInUsePermission: 'Switchback shows where you are on the map and finds the trails near you.',
          locationAlwaysAndWhenInUsePermission:
            'Switchback records your hike with the screen off and the phone in your pocket, and tells you if you leave the trail.',
          isIosBackgroundLocationEnabled: true,
          isAndroidBackgroundLocationEnabled: true,
          isAndroidForegroundServiceEnabled: true,
        },
      ],
      ['expo-notifications', { color: '#12543f' }],
      [
        'expo-image-picker',
        {
          photosPermission: 'Switchback adds the photos you choose to your hikes and to trails you have walked.',
          cameraPermission: 'Switchback takes photos on your hike and keeps them with it.',
          microphonePermission: false,
        },
      ],
      [
        'expo-splash-screen',
        {
          image: './assets/splash-icon.png',
          imageWidth: 120,
          resizeMode: 'contain',
          backgroundColor: STONE,
          dark: { image: './assets/splash-icon.png', backgroundColor: STONE_DARK },
        },
      ],
      'expo-font',
      [
        'expo-build-properties',
        {
          // R8 on; native libraries compressed in the APK (a much smaller download for an APK installed by hand)
          android: { enableMinifyInReleaseBuilds: true, enableShrinkResourcesInReleaseBuilds: true, useLegacyPackaging: true },
          ios: { deploymentTarget: '16.4' },
        },
      ],
    ],
  },
};

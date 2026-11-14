// The entry point. Order matters: the polyfills first; then the background location task is defined (it
// must exist whenever the bundle loads, also when Android starts only the task); then the recorder, which
// takes fixes that arrive before any screen is up.
import './src/core/polyfills';
import './src/platform/location';
import './src/core/recorder';
import { AppState } from 'react-native';
import { registerRootComponent } from 'expo';
import App from './src/App';
import { hydrate } from './src/core/state';
import { restoreDraft } from './src/core/recorder';
import { startController } from './src/core/controller';
import { startOffline } from './src/core/offline';
import { locationAtLaunch, retryLocation } from './src/core/locate';

void hydrate().then(restoreDraft);
startController();
startOffline();
// (location is asked for only with the app on screen, not when Android starts just the recording task)
let located = false;
const onScreen = () => {
  if (!located) { located = true; locationAtLaunch(); } else retryLocation();
};
if (AppState.currentState === 'active') onScreen();
AppState.addEventListener('change', (s) => { if (s === 'active') onScreen(); });

registerRootComponent(App);

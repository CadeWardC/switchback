import { render } from 'preact';
import { App } from './ui/App';
import { startController } from './controller';
import { restoreDraft } from './recorder';
import { hydrate } from './state';
import { startOffline } from './offline';
import { locationAtLaunch } from './locate';

void (async () => {
  // saved trails, routes and hikes are read from the device before the first screen (it is quick)
  await hydrate().catch(() => {});
  startController();
  // where you are, as early as possible (the phone apps ask at once; the website only when already allowed)
  void locationAtLaunch();
  render(<App />, document.getElementById('app')!);
  void restoreDraft();
  startOffline();
})();

import { render } from 'preact';
import { App } from './ui/App';
import { startController } from './controller';
import { restoreDraft } from './recorder';
import { hydrate } from './state';

void (async () => {
  // saved trails, routes and hikes are read from the device before the first screen (it is quick)
  await hydrate().catch(() => {});
  startController();
  render(<App />, document.getElementById('app')!);
  void restoreDraft();
})();

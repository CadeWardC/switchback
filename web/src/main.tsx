// Startup: the device layer first (the phone apps read their settings into memory), then the app.
import { platform } from './platform';
import { tokensCss } from './tokens';
import './styles.css';

// the design values (src/tokens.ts) become CSS custom properties before anything draws
const style = document.createElement('style');
style.id = 'tokens';
style.textContent = tokensCss();
document.head.prepend(style);
document.documentElement.dataset.platform = platform.name;

void platform.init().catch(() => {}).then(() => import('./boot'));

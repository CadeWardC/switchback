import { render } from 'preact';
import { tokensCss } from './tokens';
import './styles.css';
import { App } from './ui/App';
import { startController } from './controller';
import { restoreDraft } from './recorder';

// the design values (src/tokens.ts) become CSS custom properties before anything draws
const style = document.createElement('style');
style.id = 'tokens';
style.textContent = tokensCss();
document.head.prepend(style);

restoreDraft();
startController();
render(<App />, document.getElementById('app')!);

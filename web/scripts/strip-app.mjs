// The phone apps fetch trail files from the GitHub release and keep them on the device, so the copies used
// for developing the website (dist/data, from public/data) must not be packed into the apps.
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
rmSync(join(dist, 'data'), { recursive: true, force: true });
// (the apps carry their own files: no service worker)
rmSync(join(dist, 'sw.js'), { force: true });
console.log('dist/data removed for the app build');

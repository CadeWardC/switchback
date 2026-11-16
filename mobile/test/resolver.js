// Jest resolves like Metro (metro.config.js): the website's device layer becomes a small stub here, and
// web/src/lib/pack.ts becomes src/core/pack.ts.
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const webSrc = path.resolve(root, '..', 'web', 'src');
const WEB_PLATFORM = path.join(webSrc, 'platform', 'index.ts');
const WEB_PACK = path.join(webSrc, 'lib', 'pack.ts');
const APP_PACK = path.join(root, 'src', 'core', 'pack.ts');
const STUB = path.join(__dirname, 'platformStub.ts');

module.exports = (request, options) => {
  // a package imported from ../web is this app's copy
  const bare = !request.startsWith('.') && !path.isAbsolute(request);
  const opts = bare && options.basedir.startsWith(webSrc) ? { ...options, basedir: root } : options;
  const out = options.defaultResolver(request, opts);
  if (out === WEB_PLATFORM) return STUB;
  if (out === WEB_PACK && options.basedir !== path.dirname(APP_PACK)) return APP_PACK;
  return out;
};

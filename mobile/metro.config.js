// Metro: the app reuses the website's plain TypeScript logic straight from ../web/src (no copies). Three
// redirects make that work on a phone:
//   - "@web/…" is ../web/src/…;
//   - the website's device layer (web/src/platform/index.ts, which picks Capacitor or the browser) is
//     swapped for this app's native one (src/platform/index.ts), so web/src/lib/storage.ts, gpx.ts and
//     web/src/data.ts talk to the phone's files, network and location;
//   - web/src/lib/pack.ts is swapped for src/core/pack.ts, which re-exports it but unpacks trail cells with
//     fflate (the browser's DecompressionStream does not exist in Hermes);
//   - "@preact/signals" (used by web/src/filters.ts) is "@preact/signals-core": the same signals, no Preact.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const root = __dirname;
const webSrc = path.resolve(root, '..', 'web', 'src');
const WEB_PLATFORM = path.join(webSrc, 'platform', 'index.ts');
const WEB_PACK = path.join(webSrc, 'lib', 'pack.ts');
const APP_PLATFORM = path.join(root, 'src', 'platform', 'index.ts');
const APP_PACK = path.join(root, 'src', 'core', 'pack.ts');

const config = getDefaultConfig(root);
config.watchFolders = [webSrc];
config.resolver.nodeModulesPaths = [path.join(root, 'node_modules')];

config.resolver.resolveRequest = (context, moduleName, platform) => {
  let name = moduleName;
  if (name.startsWith('@web/')) name = path.join(webSrc, name.slice(5));
  else if (name === '@preact/signals') name = '@preact/signals-core';
  // a package imported from ../web is this app's copy, never web/node_modules (one copy of the signals)
  const bare = !name.startsWith('.') && !path.isAbsolute(name);
  const from = bare && context.originModulePath.startsWith(webSrc + path.sep)
    ? { ...context, originModulePath: path.join(root, 'index.ts') } : context;
  const res = from.resolveRequest(from, name, platform);
  if (res && res.type === 'sourceFile') {
    if (res.filePath === WEB_PLATFORM) return { type: 'sourceFile', filePath: APP_PLATFORM };
    if (res.filePath === WEB_PACK && context.originModulePath !== APP_PACK) return { type: 'sourceFile', filePath: APP_PACK };
  }
  return res;
};

module.exports = config;

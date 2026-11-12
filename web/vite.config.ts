import { defineConfig } from 'vite';
import pkg from './package.json' with { type: 'json' };

// Relative paths everywhere, so the site works at https://<user>.github.io/switchback/ and from any folder.
export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
  test: { include: ['test/**/*.test.ts'] },
} as any);

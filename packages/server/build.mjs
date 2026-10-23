// Production build: one self-contained ESM bundle per entry point (server + migrate), with
// @whiteboard/shared compiled in. The runtime image then needs only Node and these files.
import { build } from 'esbuild';

await build({
  entryPoints: { index: 'src/index.ts', migrate: 'src/db/migrate.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  // Smaller bundle, faster cold start; keepNames keeps class and function names in stack traces.
  minify: true,
  keepNames: true,
  // Optional native add-ons that ws and pg only try to load; they are not installed.
  external: ['bufferutil', 'utf-8-validate', 'pg-native'],
  // Bundled CommonJS dependencies call require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'warning',
});

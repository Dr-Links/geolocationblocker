import { defineConfig } from 'tsup';

// Bundles each entry point into dist/. @app/shared is inlined so the deployed
// package only needs the runtime dependencies listed in package.json.
export default defineConfig({
  entry: ['src/entry-api.ts', 'src/entry-admin.ts', 'src/cli.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: ['@app/shared'],
});

import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/bin.ts'],
  format: ['esm'],
  dts: true,
  deps: { neverBundle: ['better-sqlite3'] },
  clean: true,
  outDir: 'dist',
})

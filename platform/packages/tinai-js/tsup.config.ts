import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  // Do not bundle ws — it's a peer dependency for Node environments.
  // Browser bundlers will tree-shake the dynamic import away.
  external: ['ws'],
  outExtension({ format }) {
    return {
      js: format === 'esm' ? '.mjs' : '.js',
    };
  },
  esbuildOptions(options) {
    // Ensure the package is marked as side-effect-free for bundlers.
    options.define = {
      ...options.define,
    };
  },
  banner: {
    js: `/**
 * @tinai/client v0.1.0
 * TypeScript client SDK for the Tinai Cloud Platform
 * https://tinai.cloud
 * @license MIT
 */`,
  },
});

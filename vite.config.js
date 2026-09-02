import { defineConfig } from 'vite';

// School iPads are the target device, and many of them are frozen on older
// iPadOS releases. Vite 8's default build target is `ios16.4`, which lets
// three.js ship class static-initialisation blocks (`class X { static {…} }`)
// straight into the bundle. On iPadOS < 16.4 that is a *parse* error: the
// whole module is discarded before a single line runs, so the page renders a
// silent blank screen with nothing in the console.
//
// Dropping the target to ES2019 makes esbuild lower static blocks, logical
// assignment (`||=`, `&&=`), optional chaining and nullish coalescing.
// WebGL2 (required by three.js r163+) lands in iPadOS 15, so 15.x is the real
// floor — the JS target is set lower still so that older devices reach the
// friendly "can't run here" screen instead of a blank one.
const LEGACY_TARGET = ['es2019', 'safari13', 'ios13', 'chrome80', 'firefox75', 'edge80'];

export default defineConfig({
  build: {
    target: LEGACY_TARGET,
    // Keep Vite from rewriting colours/selectors into syntax older WebKit
    // chokes on (e.g. 8-digit hex).
    cssTarget: ['safari13', 'ios13'],
  },
  // Pre-bundled deps in `npm run dev` are transpiled separately from the
  // build, so they need the same floor for on-device testing over LAN.
  optimizeDeps: {
    rolldownOptions: { transform: { target: LEGACY_TARGET } },
  },
  server: {
    // Expose the dev server on the LAN so an iPad can load it for testing.
    host: true,
  },
});

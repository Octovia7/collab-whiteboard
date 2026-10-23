import { defineConfig } from 'vitest/config';

// `pnpm test` runs 50 convergence seeds for speed; this config runs only the convergence
// test, with all 500. Set here rather than `VAR=x` in the npm script so it also works under
// cmd.exe. Standalone rather than mergeConfig, which would concatenate `include` arrays.
export default defineConfig({
  test: {
    include: ['tests/convergence.test.ts'],
    env: { CONVERGENCE_SEEDS: process.env.CONVERGENCE_SEEDS ?? '500' },
  },
});

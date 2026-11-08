import { defineConfig } from 'vitest/config';

// Configuration de Vite (serveur de développement et build) et de Vitest (tests).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tools/**/*.test.ts'],
  },
});

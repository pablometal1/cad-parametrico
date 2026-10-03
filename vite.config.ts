import { defineConfig } from 'vitest/config';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid()],
  // Rutas relativas para poder desplegar en cualquier subcarpeta de un hosting estático.
  base: './',
  worker: { format: 'es' },
  // El módulo de emscripten no debe pre-empaquetarse: resuelve el .wasm por URL.
  optimizeDeps: { exclude: ['replicad-opencascadejs'] },
  build: { target: 'es2022' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
  },
});

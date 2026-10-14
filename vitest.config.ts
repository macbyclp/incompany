import { defineConfig } from 'vitest/config';

// Her test dosyası kendi bellek içi Postgres'ini (PGlite, WASM) kurar; çok dosya aynı anda başlayınca
// kurulum yavaşlar, bu yüzden bekleme süreleri cömert tutulur ve eşzamanlılık sınırlıdır.
export default defineConfig({
  test: {
    hookTimeout: 120_000,
    testTimeout: 60_000,
    maxWorkers: 3,
  },
});

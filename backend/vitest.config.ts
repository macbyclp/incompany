import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  /**
   * Yol takma adları AÇIKÇA tanımlanır.
   *
   * `vite-tsconfig-paths` eklentisi tsconfig'ten otomatik okuyabilirdi ama
   * yalnızca ESM olarak yayınlanır; backend CommonJS olduğu için bu config
   * dosyası CJS olarak yüklenir ve eklenti `require` edilemez.
   *
   * `@incompany/contracts` KAYNAĞA yönlendirilir, derlenmiş `dist`'e değil.
   * Böylece testler contracts derlemesini beklemez — `npm test`, `npm run
   * build` çalıştırılmadan da çalışır. Üretim derlemesi (nest build) ise
   * node_modules üzerinden derlenmiş paketi kullanır.
   */
  resolve: {
    alias: {
      '@incompany/contracts': resolve(__dirname, '../packages/contracts/src/events.ts'),
      '@': resolve(__dirname, './src'),
    },
  },

  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.spec.ts', 'src/**/*.spec.ts'],

    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.module.ts',
        'src/**/*.dto.ts',
        'src/main.ts',
        'src/**/index.ts',
      ],

      /**
       * KAPSAM EŞİKLERİ — ölçüm değil, kapı.
       *
       * Genel eşik %70'tir çünkü %100 kapsam hedefi, değer üretmeyen
       * testler yazmayı teşvik eder. Ancak GÜVENLİK KRİTİK modüller
       * ayrı ve çok daha yüksek eşiklere tabidir: bu dosyalardaki bir
       * hata sessizce veri sızdırır, çökmez.
       */
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 65,
        statements: 70,

        'src/common/crypto/crypto.service.ts': {
          lines: 95, functions: 95, branches: 90, statements: 95,
        },
        'src/dlp/validators.ts': {
          lines: 100, functions: 100, branches: 95, statements: 100,
        },
        'src/chat/sanitize.ts': {
          lines: 95, functions: 95, branches: 90, statements: 95,
        },
        'src/auth/guards/*.ts': {
          lines: 90, functions: 90, branches: 85, statements: 90,
        },
        'src/channels/channel-policy.service.ts': {
          lines: 90, functions: 90, branches: 85, statements: 90,
        },
      },
    },

    // Sızdırılan zamanlayıcı veya açık bağlantı varsa testler asılı kalmasın.
    testTimeout: 10_000,
    hookTimeout: 15_000,
    // Bir test dosyasının açık bıraktığı kaynağı erken fark et.
    teardownTimeout: 5_000,
  },
});

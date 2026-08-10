import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: {
      // Paylaşılan sözleşme doğrudan kaynaktan okunur — ayrı bir derleme
      // adımı gerekmez ve backend'de bir event değiştiğinde frontend
      // derlemesi anında kırılır. Sözleşmenin amacı tam olarak budur.
      '@incompany/contracts': resolve(__dirname, '../packages/contracts/src/events.ts'),
      '@': resolve(__dirname, './src'),
    },
  },

  server: {
    port: 5173,
    // Docker içinde çalışırken host makineden erişilebilmesi için.
    host: true,
    proxy: {
      // Geliştirmede API ve WebSocket aynı origin'den servis edilir.
      // Böylece CORS ve çerez (SameSite) davranışı üretimle aynı olur —
      // yalnızca üretimde ortaya çıkan çerez hatalarının önüne geçer.
      '/api': {
        target: process.env.VITE_API_URL ?? 'http://localhost:3000',
        changeOrigin: true,
      },
      '/ws': {
        target: process.env.VITE_WS_URL ?? 'ws://localhost:3000',
        ws: true,
        changeOrigin: true,
      },
    },
  },

  build: {
    target: 'es2022',
    // Üretimde kaynak haritası ÜRETİLİR ama dağıtılmaz: hata izleme
    // servisine (Sentry) yüklenir, ardından dosyalar sunucudan silinir.
    // 'hidden' modu, paketlere sourceMappingURL yorumu eklemez.
    sourcemap: 'hidden',
    rollupOptions: {
      output: {
        /**
         * Manuel parça (chunk) ayrımı.
         *
         * Nadiren değişen bağımlılıklar ayrı paketlere alınır: bir uygulama
         * güncellemesinde kullanıcı 800 KB'lık React paketini yeniden
         * indirmez, yalnızca değişen uygulama kodunu alır.
         */
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-realtime': ['socket.io-client'],
          'vendor-markdown': ['marked', 'dompurify'],
        },
      },
    },
    // Bu eşiği aşan bir paket, kod bölmenin (code splitting) gözden
    // geçirilmesi gerektiğinin işaretidir.
    chunkSizeWarningLimit: 600,
  },

  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
});

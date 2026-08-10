/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],

  // Karanlık mod, işletim sistemi tercihine DEĞİL sınıfa bağlanır.
  // Kullanıcının uygulama içinde ayrı bir tercih belirleyebilmesi gerekir;
  // 'media' modu bu seçeneği elinden alır.
  darkMode: 'class',

  theme: {
    extend: {
      fontFamily: {
        // Sistem font yığını: web fontu indirilmez, ilk boyama gecikmez
        // ve dış bir CDN'e bağımlılık oluşmaz (CSP açısından da temiz).
        sans: [
          '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto',
          'Helvetica Neue', 'Arial', 'sans-serif',
        ],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      typography: {
        DEFAULT: {
          css: {
            // Sohbet balonunda prose'un varsayılan üst/alt boşlukları
            // fazladır — mesajlar arasında gereksiz boşluk yaratır.
            'p:first-of-type': { marginTop: 0 },
            'p:last-of-type': { marginBottom: 0 },
            maxWidth: 'none',
          },
        },
      },
    },
  },

  plugins: [
    // Markdown render'ı için tipografi stilleri.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('@tailwindcss/typography'),
  ],
};

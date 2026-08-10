import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

/**
 * Test Ortamı Kurulumu.
 *
 * jsdom, tarayıcının tamamını taklit etmez. Aşağıdaki API'ler jsdom'da
 * YOKTUR ve kullanan bileşenler test sırasında çöker — ama üretimde
 * sorunsuz çalışırlar. Bunlar sahtelenmezse testler, gerçek bir hatayı
 * değil jsdom'un eksikliğini raporlar.
 */

afterEach(() => {
  // Her testten sonra DOM'u temizle. Yapılmazsa bir sonraki test,
  // öncekinin bıraktığı elemanları bulur ve hatalar birbirine karışır.
  cleanup();
  vi.clearAllMocks();
});

// --- IntersectionObserver ----------------------------------------------------
// Sanallaştırma ve tembel yükleme kullanır.
vi.stubGlobal(
  'IntersectionObserver',
  class {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
    takeRecords = vi.fn(() => []);
    root = null;
    rootMargin = '';
    thresholds = [];
  },
);

// --- ResizeObserver ----------------------------------------------------------
// `@tanstack/react-virtual` eleman yüksekliklerini bununla ölçer.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  },
);

// --- scrollTo ----------------------------------------------------------------
// jsdom düzen (layout) hesaplamaz, bu yüzden kaydırma da yapmaz.
Element.prototype.scrollTo = vi.fn();
Element.prototype.scrollIntoView = vi.fn();

// --- matchMedia --------------------------------------------------------------
// Karanlık mod ve `prefers-reduced-motion` sorguları için.
vi.stubGlobal(
  'matchMedia',
  vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
);

// --- crypto.randomUUID -------------------------------------------------------
// Eski jsdom sürümlerinde yoktur. MessageInput idempotency anahtarı üretmek
// için kullanır; eksikse mesaj gönderimi testleri anlamsız biçimde çöker.
if (!globalThis.crypto?.randomUUID) {
  vi.stubGlobal('crypto', {
    ...globalThis.crypto,
    randomUUID: () =>
      '10000000-1000-4000-8000-100000000000'.replace(/[018]/gu, (c) =>
        (
          Number(c) ^
          (crypto.getRandomValues(new Uint8Array(1))[0]! & (15 >> (Number(c) / 4)))
        ).toString(16),
      ),
  });
}

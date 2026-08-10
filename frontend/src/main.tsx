import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import './index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root elementi bulunamadi — index.html bozuk olabilir');
}

createRoot(container).render(
  // StrictMode geliştirmede etkileri iki kez çalıştırır. Bu bir sorun değil,
  // bir TEŞHİS ARACIDIR: temizlenmeyen socket bağlantıları ve zamanlayıcılar
  // burada anında görünür hale gelir. Üretim derlemesinde etkisizdir.
  <StrictMode>
    <App />
  </StrictMode>,
);

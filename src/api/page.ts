import { readFileSync } from 'node:fs';

/** Panel, derleme gerektirmeyen tek dosyadır: public/index.html (hem src hem dist'ten ../../public). */
export const indexHtml = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');

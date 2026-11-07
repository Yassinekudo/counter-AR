import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS is required for camera access on phones (localhost is the only exception).
// `npm run dev` serves https://<your-computer-ip>:5173 on your Wi-Fi network.
export default defineConfig(({ command }) => ({
  base: './',
  plugins: command === 'serve' ? [basicSsl()] : [],
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
  worker: { format: 'es' },
  build: { target: 'es2020' },
}));

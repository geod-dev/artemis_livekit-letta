import { fileURLToPath } from 'node:url';
import { type Plugin, defineConfig, loadEnv } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';

// One `.env` at the repo root is shared by Docker Compose, the backend, this app
// and the voice agent. The browser reaches the backend through the `/api` proxy.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('..', import.meta.url)), '');
  const assistantName = process.env.ASSISTANT_NAME || env.ASSISTANT_NAME || 'Artemis';
  const proxy = {
    '/api': {
      target:
        process.env.BACKEND_URL ||
        env.BACKEND_URL ||
        `http://${process.env.IP_ADDRESS || env.IP_ADDRESS || '127.0.0.1'}:3000`,
    },
  };
  return {
    plugins: [react(), tailwindcss(), assistantNameInHtml(assistantName)],
    define: { 'import.meta.env.ASSISTANT_NAME': JSON.stringify(assistantName) },
    resolve: { alias: { '@': fileURLToPath(new URL('src', import.meta.url)) } },
    server: { port: 5173, strictPort: true, proxy },
    preview: { port: 5173, strictPort: true, proxy },
  };
});

function assistantNameInHtml(name: string): Plugin {
  return {
    name: 'assistant-name',
    transformIndexHtml: (html) => html.replaceAll('%ASSISTANT_NAME%', name),
  };
}

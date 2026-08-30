import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@streampolis/shared': path.resolve(__dirname, '../shared/src/index.ts'),
    },
  },
  server: { host: '0.0.0.0', port: 5273, strictPort: true },
  build: { target: 'es2022', sourcemap: true },
});

import { resolve } from 'path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  root: './app',
  base: '/',
  build: {
    outDir: '../dist-web',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: resolve(__dirname, 'app/web-index.html'),
    },
  },
  resolve: {
    alias: {
      '@/app': resolve(__dirname, 'app'),
      '@/lib': resolve(__dirname, 'lib'),
      '@/resources': resolve(__dirname, 'resources'),
      '@sentry/electron/renderer': resolve(
        __dirname,
        'app/web/stubs/sentry.ts',
      ),
      '@sentry/electron': resolve(__dirname, 'app/web/stubs/sentry.ts'),
      'electron-log/renderer': resolve(
        __dirname,
        'app/web/stubs/electron-log.ts',
      ),
      'electron-log': resolve(__dirname, 'app/web/stubs/electron-log.ts'),
    },
  },
  define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('disabled'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(''),
    'import.meta.env.VITE_POSTHOG_API_KEY': JSON.stringify(''),
    'import.meta.env.VITE_POSTHOG_HOST': JSON.stringify(''),
    'import.meta.env.VITE_SENTRY_DSN': JSON.stringify(''),
  },
  plugins: [tailwindcss(), react()],
})

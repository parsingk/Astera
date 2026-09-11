import { fileURLToPath } from 'node:url'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: 'src/main/index.ts',
          cli: 'src/cli/index.ts',
          host: 'src/host/index.ts'
        }
      }
    }
  },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src/renderer/src', import.meta.url))
      }
    },
    plugins: [react(), tailwindcss()]
  }
})

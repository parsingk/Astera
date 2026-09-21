import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// CLI 는 Electron 없이 도는 번들이라(ELECTRON_RUN_AS_NODE) `app.getVersion()` 을 부를 수 없다.
// 앱과 CLI 는 한 프로그램이므로 버전도 하나여야 하고, 그 하나를 빌드가 박아 넣는다 — 두 곳에서
// 읽으면 갈라진다.
const version = (createRequire(import.meta.url)('./package.json') as { version: string }).version

export default defineConfig({
  main: {
    define: { __ASTERA_VERSION__: JSON.stringify(version) },
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

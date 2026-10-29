import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { isNoise } from './electron.vite.warnings'
import { enforceHookPlugin } from './electron.vite.enforceHook'

// CLI 는 Electron 없이 도는 번들이라(ELECTRON_RUN_AS_NODE) `app.getVersion()` 을 부를 수 없다.
// 앱과 CLI 는 한 프로그램이므로 버전도 하나여야 하고, 그 하나를 빌드가 박아 넣는다 — 두 곳에서
// 읽으면 갈라진다.
const version = (createRequire(import.meta.url)('./package.json') as { version: string }).version

export default defineConfig({
  main: {
    define: { __ASTERA_VERSION__: JSON.stringify(version) },
    // Enforce's hook, bundled into one file the sessions' settings point at (electron.vite.enforceHook.ts)
    plugins: [externalizeDepsPlugin(), enforceHookPlugin()],
    build: {
      rollupOptions: {
        // zod's prose about @__PURE__ reads to Rollup as a misplaced annotation on every build: see electron.vite.warnings.ts
        onwarn(warning, warn) {
          if (!isNoise(warning)) warn(warning)
        },
        input: {
          index: 'src/main/index.ts',
          cli: 'src/cli/index.ts',
          host: 'src/host/index.ts',
          'plugin-host': 'src/pluginHost/index.ts',
          // Astera's check runner (Task K), run by the app's or the Host's own executable as node: a sandboxed Claude Task's
          // check under srt on macOS and Linux (core/sandbox/srtCheck.ts), and a sandboxed Codex Task's check on Windows
          // (core/sandbox/checkRunner.ts), which the Windows Host runs from its runtime's copy (scripts/host-runtime.mjs)
          'sandbox-check': 'src/sandboxCheck/index.ts'
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

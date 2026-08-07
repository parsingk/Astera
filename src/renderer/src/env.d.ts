/// <reference types="vite/client" />

import type { RendererApi } from '../../core/types'

declare global {
  interface Window {
    api: RendererApi
  }
}

export {}

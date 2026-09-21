/// <reference types="electron-vite/node" />

/** 빌드가 박아 넣는 앱 버전(electron.vite.config.ts 의 `define`). CLI 번들은 Electron 없이 돌아
 *  `app.getVersion()` 을 부를 수 없고, 앱과 CLI 는 한 프로그램이라 버전도 하나여야 한다. */
declare const __ASTERA_VERSION__: string

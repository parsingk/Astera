<div align="center">

<img src="assets/banner.jpg" width="640" alt="Astera — build beyond the stars" />

**Mantén Claude Code y Codex trabajando mientras no estás.**

[![CI](https://github.com/parsingk/Astera/actions/workflows/ci.yml/badge.svg)](https://github.com/parsingk/Astera/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/parsingk/Astera?logo=github)](https://github.com/parsingk/Astera/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/parsingk/Astera/total)](https://github.com/parsingk/Astera/releases)
[![License](https://img.shields.io/github/license/parsingk/Astera?color=blue)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-555)

[Descargar](#instalación) · [Qué hace](#qué-hace) · [Documentación](#documentación) · [Reportar un error](https://github.com/parsingk/Astera/issues/new)

[English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · **Español**

</div>

Astera ejecuta tus sesiones de agente cuando no estás en el escritorio. Programa una para que empiece
a las 3 de la mañana y arrancará sin ti. Cuando cualquier sesión alcanza un límite de uso —programada
o no—, Astera lee la hora de reinicio en la transcripción, cambia a tu siguiente cuenta y retoma el
*mismo* trabajo. Slack te avisa cuando termina un turno o se alcanza un límite. Las sesiones conviven
en una sola ventana, cada una aislada en su propio worktree de git. Un agente puede iniciar otras
sesiones, repartirles tareas y esperar bloqueado hasta que informen: lo hace él mismo a través de una
CLI incluida, así que no vas despachando cada paso a mano.

> **Estado:** Windows y macOS. Ejecuta las CLI de `claude` y `codex`, así que solo llega tan lejos
> como la que tengas instalada.

## Instalación

Descarga la última versión desde
**[Releases](https://github.com/parsingk/Astera/releases/latest)** y ejecútala:
`astera-<version>-setup.exe` en Windows, `astera-<version>-universal.dmg` en macOS. En Windows la
aplicación se actualiza sola a partir de ahí, preguntando antes de descargar.

> **Las compilaciones de macOS aún no están notarizadas**, y eso cuesta dos cosas. Gatekeeper bloquea
> el primer arranque, así que después de arrastrar la aplicación a Aplicaciones, quita la marca de
> cuarentena que macOS le puso:
>
> ```bash
> xattr -cr /Applications/Astera.app
> ```
>
> Eso elimina la marca de «descargado de internet», que es lo único que estorba: la aplicación en sí
> está firmada (ad-hoc), así que nada más cambia. Ajustes del Sistema → **Privacidad y seguridad** →
> **Abrir igualmente** también funciona si prefieres hacer clic; el atajo Control-clic → **Abrir**
> no, macOS 15 (Sequoia) lo eliminó.
>
> Y la actualización automática seguirá desactivada hasta que la compilación esté notarizada, así que
> una versión nueva significa volver a descargar el dmg. En Windows, SmartScreen puede advertirte en
> el primer arranque: pulsa **Más información → Ejecutar de todas formas**.
>
> Se está preparando la firma mediante el programa de código abierto de la SignPath Foundation
> (Windows) y un Apple Developer ID (macOS) — consulta la
> [política de firma de código](docs/code-signing.md) para saber quién firma qué, y
> [docs/releasing.md](docs/releasing.md) para el procedimiento.

También necesitarás:

- **Windows 10 u 11**, o **macOS 12 (Monterey) o posterior**
- **[Claude Code](https://claude.com/claude-code) y/o la CLI de Codex** en tu `PATH` — Astera las
  ejecuta, no las sustituye

## Qué hace

**Sesiones**
- Muchas sesiones de `claude` / `codex` en una ventana, como pestañas y como paneles divididos
- Una terminal por proyecto

**Editor y atajos**
- Una tecla muestra y oculta el explorador: `Ctrl`/`Cmd`+`Shift`+`E` para el árbol de archivos, la
  barra de ejecución y la consola de ejecución, dejando los paneles donde están
- Una fila de pestañas por panel, con los dos tipos de pestaña: un archivo se sitúa junto a la sesión
  que lo está cambiando, una división muestra ambos a la vez y `Ctrl`+`Tab` recorre la fila del
  panel activo
- Un editor de verdad, no un cuadro de texto: CodeMirror con resaltado de sintaxis para TypeScript,
  JavaScript, Python, Go, Rust, C/C++, Java, PHP, SQL, HTML, CSS, Markdown, JSON, YAML y XML,
  abiertos en pestañas
- Un árbol de archivos con el estado de git en cada entrada (nuevo, modificado, eliminado, conflicto),
  y crear, renombrar, mover, copiar, eliminar y mostrar en Finder / el Explorador
- **Historial local:** se toma una instantánea antes de eliminar, así que lo que limpió el agente —o
  tú— se puede recuperar. Se conserva 30 días, hasta 200 MB por proyecto
- Todos los atajos se pueden reasignar en los ajustes, con `Cmd` por defecto en macOS y `Ctrl` en el
  resto: dividir paneles, mover el foco entre ellos, recorrer sesiones, cerrar una pestaña de archivo
- Elige la tipografía de la terminal, incluida la de reserva para texto CJK

**Cuentas**
- Varias cuentas por proveedor, cada una aislada mediante su propio `CLAUDE_CONFIG_DIR` / `CODEX_HOME`
- **Rotación de cuentas:** cuando una sesión alcanza un límite de uso, Astera lo detecta en la
  transcripción, calcula la hora de reinicio y retoma el trabajo en la siguiente cuenta
- Importación opcional de la configuración de una cuenta nueva desde tu cuenta predeterminada:
  `settings.json`, la lista de servidores MCP y los directorios `skills`, `commands` y `agents`

<div align="center">
<img src="assets/rolling.gif" width="820" alt="Diagrama: una sesión en marcha alcanza su límite semanal, Astera lee la hora de reinicio en la transcripción, cambia a la siguiente cuenta y la misma conversación continúa" />
</div>

**Programación y control remoto**
- Programa sesiones para que empiecen a una hora determinada
- Notificaciones de Slack cuando termina un turno o se alcanza un límite, y respuestas desde Slack
  que vuelven a la sesión — así puedes seguir una ejecución desde el móvil

<div align="center">
<img src="assets/schedule.gif" width="820" alt="Diagrama: a las 03:00 una sesión programada arranca sola, ejecuta el comando que le dejaste, termina, y Slack informa del resultado" />
</div>

**Orquestación entre proveedores**
- Una sesión coordinadora reparte tareas a sesiones trabajadoras — incluidas las del *otro* proveedor
- Las trabajadoras informan a través de la CLI `astera` incluida; la coordinadora espera
  finalizaciones, dependencias, preguntas y escalaciones
- Cada tarea puede ejecutarse en su propio worktree de git para que las trabajadoras en paralelo no
  choquen

**Además**
- Interfaz en coreano, inglés, japonés y español, más una opción System que sigue la configuración
  regional del sistema
- Actualización automática desde GitHub Releases

## Orquestación: primeros pasos

Activa la orquestación en los ajustes y luego inicia una sesión. Esa sesión recibe la CLI `astera` en
su `PATH` y una skill que describe cómo usarla, así que basta con pedirle que coordine el trabajo.
Para leer la referencia completa tú mismo:

```bash
astera help
```

Si `astera` responde `command not found`, la ruta absoluta está en `$ASTERA_CLI`: son el mismo
programa. Un `$ASTERA_CLI` vacío significa que la sesión no la inició Astera, o que la orquestación
está desactivada.

## Compilar desde el código fuente

Compilar requiere **Node.js 22.12+** y un conjunto de herramientas de C++ para la recompilación
nativa de `node-pty` (vía `electron-builder install-app-deps`): las **Visual Studio Build Tools
(C++)** en Windows, o las **Xcode Command Line Tools** (`xcode-select --install`) en macOS.

```bash
npm ci
npm run dev        # ejecutar en desarrollo
npm run typecheck  # tsc sobre los proyectos de node y de web
npm run build      # empaquetar el bundle
npm run dist       # empaquetar para la plataforma actual en dist-installer/
npm run dist:win   # instalador de Windows
npm run dist:mac   # dmg universal + zip de macOS
```

`npm run dist` lee los recursos de iconos ya versionados (`build/icon.ico` en Windows,
`build/icon.icns` en macOS y el `resources/tray.png` compartido) en lugar de generarlos. Si cambias
el logotipo, sustituye `resources/logo-source.png` y vuelve a ejecutar el script correspondiente en
su propia plataforma — `powershell -File scripts/gen-icon.ps1` (ico/png) en Windows,
`sh scripts/gen-icon-mac.sh` (icns) en macOS — y luego versiona los recursos regenerados.

Las pruebas viven junto a lo que prueban como `*.test.ts` y se ejecutan con `npm test` (Vitest). CI
ejecuta la comprobación de tipos, la suite y una compilación completa del bundle.

## Documentación

- [Configuración del bot de Slack](docs/slack-bot-setup.md) — crear la aplicación, tokens y permisos
- [Publicación de versiones](docs/releasing.md) — cómo se corta y publica una versión
- [Política de firma de código](docs/code-signing.md) — quién firma las versiones, qué se firma y
  privacidad

## Contribuir

Los issues y los pull requests son bienvenidos. Un par de cosas que conviene saber antes de empezar:

- Ejecuta `npm run typecheck`, `npm test` y `npm run build` antes de abrir un PR: es lo que comprueba
  CI.
- Se espera que un cambio de comportamiento venga con una prueba. Una regla que conviene conocer
  antes de tocar las pruebas de rotación: las frases de límite de uso están partidas con `+` a
  propósito, porque Astera vigila la salida de las sesiones buscándolas — consulta
  [CONTRIBUTING](.github/CONTRIBUTING.md).
- Los informes de errores son mucho más fáciles de atender con la versión de la aplicación, la
  versión de tu sistema operativo y las líneas relevantes de `rolling.log` cuando el problema
  involucra la rotación de cuentas — `%APPDATA%\astera\rolling.log` en Windows,
  `~/Library/Application Support/astera/rolling.log` en macOS.

## Agradecimientos

- El modelo de orquestación entre proveedores —una coordinadora que reparte tareas a sesiones
  trabajadoras a través de una CLI local, con preguntas bloqueantes y comprobaciones de propiedad—
  toma sus ideas de la orquestación de agentes de
  [Orca](https://github.com/stablyai/orca). La implementación aquí es propia.
- La cadena de firma de código para Windows sigue el flujo fail-open de SignPath que Orca usa para
  sus versiones — consulta [docs/releasing.md](docs/releasing.md).
- Las versiones de macOS están pensadas para firmarse y notarizarse con un Apple Developer ID, y el
  workflow ya está listo para ello. A diferencia del camino de Windows, este no es opcional: sin él,
  la actualización automática de `electron-updater` en macOS (construida sobre Squirrel.Mac) se niega
  a instalar actualizaciones — así que hasta que el certificado esté en su sitio, las compilaciones
  se publican con firma ad-hoc y no se actualizan solas.

## Licencia

[Apache License 2.0](LICENSE).

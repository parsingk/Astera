<div align="center">

<img src="assets/banner.jpg" width="640" alt="Astera — build beyond the stars" />

**Mantén Claude Code y Codex trabajando mientras no estás.**

[![CI](https://github.com/parsingk/Astera/actions/workflows/ci.yml/badge.svg)](https://github.com/parsingk/Astera/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/parsingk/Astera?logo=github)](https://github.com/parsingk/Astera/releases/latest)
[![License](https://img.shields.io/github/license/parsingk/Astera?color=blue)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-555)

[Descargar](#instalación) · [Qué hace](#qué-hace) · [Jobs](#jobs) · [Documentación](#documentación) · [Reportar un error](https://github.com/parsingk/Astera/issues/new)

[English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · **Español**

<img src="assets/hero.jpg" width="960" alt="Astera ejecutando cuatro sesiones en una ventana en una cuadrícula 2x2 — tres de Claude Code y una de Codex, sobre dos cuentas de Claude y una de Codex — con las cuentas y el historial del proyecto en la barra lateral" />

</div>

Astera ejecuta tus sesiones de agente cuando no estás en el escritorio. Programa una para que empiece
a las 3 de la mañana y arrancará sin ti. Cuando cualquier sesión alcanza un límite de uso —programada
o no—, Astera lee la hora de reinicio en la transcripción, cambia a tu siguiente cuenta y retoma el
*mismo* trabajo. Slack te avisa cuando termina un turno o se alcanza un límite. Las sesiones conviven
en una sola ventana, cada una aislada en su propio worktree de git. Y un trabajo de una docena de
pasos puede organizarse como un Job y ejecutarse desde la barra lateral de Jobs, o dejarse en manos
de una coordinadora mediante la skill `/astera-orchestration`.

> **Estado:** Windows, macOS y Linux. Ejecuta las CLI de `claude` y `codex`, así que solo llega tan lejos
> como la que tengas instalada.

## Qué hace

**Sesiones**
- Muchas sesiones de `claude` / `codex` en una ventana, como pestañas y como paneles divididos
- Una terminal por proyecto

**Cuentas**
- Varias cuentas por proveedor, cada una aislada mediante su propio `CLAUDE_CONFIG_DIR` / `CODEX_HOME`
- **Rotación de cuentas:** cuando una sesión alcanza un límite de uso, Astera lo detecta en la
  transcripción, calcula la hora de reinicio y retoma el trabajo en la siguiente cuenta
- Importación opcional de la configuración de una cuenta nueva desde tu cuenta predeterminada:
  `settings.json`, la lista de servidores MCP y los directorios `skills`, `commands` y `agents`

<div align="center">
<img src="assets/rolling.gif" width="820" alt="Diagrama: una sesión en marcha alcanza su límite semanal, Astera lee la hora de reinicio en la transcripción, cambia a la siguiente cuenta y la misma conversación continúa" />
<img src="assets/rolling-demo.gif" width="820" alt="Grabación de pantalla: una sesión alcanza su límite, Astera cambia a la siguiente cuenta con la misma conversación restaurada y, cuando no queda ninguna, indica a qué hora se reanudará" />
<p><a href="https://github.com/parsingk/Astera/blob/main/assets/astera-demo-rolling.mp4">▶ Grabación completa (28s)</a></p>
</div>

**Reanudación inteligente (experimental)**
- Desactivada por defecto. **Configuración → General → Estrategia de reanudación de sesión** elige entre el
  resume propio de la CLI y esta
- Con ella activada, cuando un límite mueve el trabajo a la siguiente cuenta esa sesión arranca **en
  blanco** y recibe un punto de control compacto como primer mensaje, en vez de reproducir toda la
  conversación
- El punto de control lleva la carpeta de trabajo y su estado de git, las peticiones recientes en
  orden, los archivos que tocó, el último comando que ejecutó y el final del intercambio — con los
  secretos ocultados al entrar
- Si no se puede construir un punto de control, el cambio recae en la reanudación normal, así que
  activarla nunca deja un relevo peor que antes

**Programación y control remoto**
- Programa sesiones para que empiecen a una hora determinada
- Notificaciones de Slack cuando termina un turno o se alcanza un límite, y respuestas desde Slack
  que vuelven a la sesión — así puedes seguir una ejecución desde el móvil

<div align="center">
<img src="assets/schedule.gif" width="820" alt="Diagrama: a las 03:00 una sesión programada arranca sola, ejecuta el comando que le dejaste, termina, y Slack informa del resultado" />
<img src="assets/schedule-demo.gif" width="820" alt="Grabación de pantalla: una sesión mostrando su horario, y el comando entrando solo cuando llega la hora" />
<p><a href="https://github.com/parsingk/Astera/blob/main/assets/astera-demo-schedule.mp4">▶ Grabación completa (22s)</a></p>
</div>

**Ejecución**
- Una configuración de ejecución tiene un tipo — Shell, npm, Node.js, Gradle, Maven, cargo, go,
  Python, pytest, Docker Compose, Dockerfile o .NET — y guarda solo los campos que ese tipo tiene
- El comando se arma al ejecutarlo, así que el wrapper de Gradle, el gestor de paquetes que implica
  tu lockfile y las comillas que pide tu shell se resuelven entonces, no se escriben en una casilla
- Se leen los archivos de compilación del proyecto, así que sus scripts de npm ya están ahí como
  configuraciones, y un proyecto de Gradle o Maven trae las tareas y los objetivos habituales. Las
  detectadas aparecen en cursiva hasta que editas una, lo que la guarda como tuya

**Editor y atajos**
- Una tecla muestra y oculta el explorador: `Ctrl`/`Cmd`+`Shift`+`E` para el árbol de archivos, la
  barra de ejecución y la consola de ejecución, dejando los paneles donde están
- Una fila de pestañas por panel, con los dos tipos de pestaña: un archivo se sitúa junto a la sesión
  que lo está cambiando, una división muestra ambos a la vez y `Ctrl`+`Tab` recorre la fila del
  panel activo
- Un editor de verdad, no un cuadro de texto: CodeMirror con resaltado de sintaxis para TypeScript,
  JavaScript, Python, Go, Rust, C/C++, Java, PHP, SQL, HTML, CSS, Markdown, JSON, YAML y XML,
  abiertos en pestañas
- **Markdown en paralelo:** un archivo markdown se abre como editor, dividido o previsualización, y
  `Ctrl`/`Cmd`+`Shift`+`V` recorre los tres — en la vista dividida, los dos paneles se siguen al
  desplazarse
- Un árbol de archivos con el estado de git en cada entrada (nuevo, modificado, eliminado, conflicto),
  y crear, renombrar, mover, copiar, eliminar y mostrar en Finder / el Explorador
- **Historial local:** se toma una instantánea antes de eliminar, así que lo que limpió el agente —o
  tú— se puede recuperar. Se conserva 30 días, hasta 200 MB por proyecto
- Todos los atajos se pueden reasignar en los ajustes, con `Cmd` por defecto en macOS y `Ctrl` en el
  resto: dividir paneles, mover el foco entre ellos, recorrer sesiones, cerrar una pestaña de archivo

**Apariencia**
- Siete temas — Vega, Orion, Umbra, Aurora, Antares, Quasar y Sirius — elegidos desde tarjetas que se dibujan
  cada una con su propia paleta, así que eliges mirando en vez de por el nombre
- Un tema es más que colores: el radio de las esquinas, las sombras, la tipografía de la interfaz y la
  densidad de las filas vienen con él, así que Quasar pone más en pantalla que Umbra
- Cambiarlo altera lo que ya está abierto — a una terminal en marcha se le sustituyen los colores en
  el sitio, así que conserva su scrollback
- La tipografía de la terminal se elige aparte, incluida la de reserva para texto CJK

**Además**
- Interfaz en coreano, inglés, japonés y español, más una opción System que sigue la configuración
  regional del sistema
- Actualización automática desde GitHub Releases

## Jobs

Jobs es opcional. Activa **Orquestación de agentes** en los ajustes para mostrar su barra lateral.
Un trabajo es un grafo de tareas con dependencias que pueden ejecutarse con cualquiera de los dos
proveedores, y hay dos formas de ponerlo en marcha.

<div align="center">
<img src="assets/jobs.gif" width="820" alt="Diagrama: una coordinadora sigue el grafo de dependencias, inicia dos tareas listas en proveedores distintos, comprueba una con pruebas, continúa cuando terminan sus dependencias y espera a una persona cuando hace falta una decisión" />
<img src="assets/jobs-demo.gif" width="820" alt="Grabación de pantalla: un trabajo avanzando por su grafo de dependencias — un trabajador alcanza su límite y se reanuda solo, ambas dependencias informan, y la última tarea pasa una validación y una revisión cruzada entre proveedores" />
<p><a href="https://github.com/parsingk/Astera/blob/main/assets/astera-killer-demo.mp4">▶ Grabación completa (30s)</a></p>
</div>

### 1. Prepararlo en la barra lateral de Jobs

1. Comprueba que el proyecto sea un repositorio git con una rama activa.
2. Pulsa **Nuevo trabajo**, indica el **Objetivo**, elige una **Cuenta coordinadora**, fija
   **En paralelo** y añade una programación si la necesitas.
3. Añade a cada tarea sus instrucciones, una o más cuentas trabajadoras y sus dependencias. También
   puedes usar compilaciones, pruebas y revisiones del otro proveedor como comprobaciones finales.
4. Pulsa **Ejecutar**. Un Job normal abre su coordinadora; uno programado activa su calendario.

La vista de Jobs muestra el grafo de dependencias, las trabajadoras activas, las preguntas y la línea
de tiempo. Las tareas paralelas pueden usar worktrees de git separados, y el resultado no entra en la
rama activa hasta que pulses **Fusionar**. Consulta el [ciclo de vida de un Job](docs/jobs.md) para
más detalles (actualmente solo en coreano).

### 2. Ejecutarlo con la skill `astera-orchestration` — un agente coordina

Activa **Orquestación de agentes antes de iniciar la sesión coordinadora**. Al arrancar, esa sesión
recibe la CLI `astera` en su `PATH` y la skill `astera-orchestration`. Puedes pedírselo con lenguaje
natural, por ejemplo:

> Usa la skill `astera-orchestration` para coordinar este trabajo: refactoriza el módulo de
> autenticación, añade después pruebas de regresión y verifícalo con la suite de pruebas.

También puedes invocar la skill explícitamente como `/astera-orchestration`. Sirve para trabajos de
varios pasos que necesitan supervisión, seguimiento de resultados o coordinación de dependencias.
La coordinadora crea el Run y las tareas, las reparte entre trabajadoras de Claude y Codex, espera sus
informes y te devuelve las preguntas que requieran una decisión. Los Runs del proyecto abierto
también aparecen en la barra lateral de Jobs.

Las skills se cargan al iniciar una sesión: activa primero **Orquestación de agentes** y abre después
una sesión coordinadora nueva. Una entrega sencilla y puntual no necesita un Run de orquestación.

Para leer la referencia de la CLI de coordinación:

```bash
astera help
```

Si `astera` responde `command not found`, la ruta absoluta está en `$ASTERA_CLI`: son el mismo
programa. Un `$ASTERA_CLI` vacío significa que la sesión no la inició Astera, o que la Orquestación
de agentes está desactivada.

## Instalación

Descarga la última versión desde
**[Releases](https://github.com/parsingk/Astera/releases/latest)** y ejecútala:
`astera-<version>-setup.exe` en Windows, `astera-<version>-universal.dmg` en macOS, y
`astera-<version>-x86_64.AppImage` o `astera-<version>-amd64.deb` en Linux. En Windows la
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

> **En Linux**, ninguno de los dos artefactos arranca tal como se descarga. Dale el bit de
> ejecución al AppImage:
>
> ```bash
> chmod +x astera-<version>-x86_64.AppImage
> ```
>
> e instala el deb con apt y no con `dpkg -i`, para que sus dependencias vengan con él:
>
> ```bash
> sudo apt install ./astera-<version>-amd64.deb
> ```
>
> El deb declara el mínimo soportado, así que apt rechaza un sistema más antiguo en vez de instalar
> algo que no podría arrancar.

También necesitarás:

- **Windows 10 u 11**, **macOS 12 (Monterey) o posterior**, o **Ubuntu 22.04 / Debian 12 o
  posterior**
- **[Claude Code](https://claude.com/claude-code) y/o la CLI de Codex** en tu `PATH` — Astera las
  ejecuta, no las sustituye

## Compilar desde el código fuente

Compilar requiere **Node.js 22.12+** y un conjunto de herramientas de C++ para la recompilación
nativa de `node-pty` (vía `electron-builder install-app-deps`): las **Visual Studio Build Tools
(C++)** en Windows, las **Xcode Command Line Tools** (`xcode-select --install`) en macOS, o
**build-essential** y **python3** en Linux, donde node-pty no trae binarios precompilados y siempre
se compila.

```bash
npm ci
npm run dev        # ejecutar en desarrollo
npm run typecheck  # tsc sobre los proyectos de node y de web
npm run build      # empaquetar el bundle
npm run dist       # empaquetar para la plataforma actual en dist-installer/
npm run dist:win   # instalador de Windows
npm run dist:mac   # dmg universal + zip de macOS
npm run dist:linux # AppImage + deb de Linux
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

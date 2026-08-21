import type { Catalog } from '../index'

/** Spanish. Partial by design — see ja.ts for why. */
export const es: Catalog = {
  'settings.title': 'Configuración',
  'settings.tab.general': 'General',
  'settings.tab.appearance': 'Apariencia',
  'settings.tab.accounts': 'Cuentas',
  'settings.tab.info': 'Información',
  'settings.tab.shortcuts': 'Atajos',
  'settings.tab.history': 'Historial',
  'settings.general.language': 'Idioma',
  // {lang} is the language the OS locale resolves to, shown so the effect of picking System is
  // visible before picking it
  'settings.general.language.system': 'Configuración del sistema ({lang})',
  'settings.general.language.saveFailed': 'No se pudo guardar la configuración de idioma: {detail}',
  // Agent orchestration
  'settings.orchestration.label': 'Orquestación de agentes (experimental)',
  'settings.orchestration.hint':
    'Cuando está activada, las sesiones de agente que abre la aplicación pueden abrir sesiones de trabajador con otro proveedor. ' +
    'Un agente podrá crear sesiones con cualquiera de las cuentas de la aplicación, así que actívela solo cuando la necesite. ' +
    'No se aplica a las sesiones que ya están abiertas: funciona a partir de las sesiones nuevas. ' +
    'Pida a la sesión que vaya a usar como orquestador que ejecute astera help para obtener la guía de uso completa.',
  'settings.orchestration.saveFailed':
    'No se pudo guardar la configuración de orquestación: {detail}',
  'settings.accounts.hint':
    '⤓ importa la configuración de la cuenta predeterminada del mismo CLI. La predeterminada es la primera cuenta registrada que tenga la sesión iniciada, una por CLI.',
  'common.cancel': 'Cancelar',
  'common.confirm': 'Aceptar',
  'common.close': 'Cerrar',
  'common.toastDismiss': 'Cerrar la notificación',
  // files/ops.ts — the Message keys validateName/canMove/canCopy return
  'files.validate.badChar': 'El nombre contiene un carácter no permitido: {char}',
  'files.validate.empty': 'Escriba un nombre',
  'files.validate.reserved': 'Ese nombre no se puede usar',
  'files.validate.separator': 'El nombre no puede contener separadores de ruta',
  'files.validate.windowsReserved': 'Es un nombre reservado en Windows',
  'files.validate.trailing': 'El nombre no puede terminar en espacio ni en punto',
  'files.validate.tooLong': 'El nombre es demasiado largo',
  'files.move.intoSelf': 'No se puede mover una carpeta dentro de sí misma',
  'files.move.alreadyThere': 'Ya se encuentra en esa ubicación',
  'files.copy.intoSelf': 'No se puede copiar una carpeta dentro de sí misma',
  'files.error.pathNotAllowed': 'Ruta no permitida',
  'files.error.unsupportedImageType': 'Tipo de imagen no compatible',
  'files.error.imageTooLarge': 'La imagen es demasiado grande',
  'files.error.alreadyExists': '«{name}» ya existe',
  'files.error.alreadyExistsInDest': '«{name}» ya existe en la carpeta de destino',
  'files.error.renameStranded':
    'No se pudo cambiar el nombre ni revertir el cambio. El archivo está en «{tmp}»',
  // worktrees/include.ts, worktrees/create.ts — worktree creation warnings
  'worktree.include.tooManyEntries':
    '.worktreeinclude supera las {max} entradas; se ignoraron las líneas restantes',
  'worktree.include.globUnsupported': 'Patrones glob y de negación no admitidos: {line}',
  'worktree.include.absolutePath': 'No se admiten rutas absolutas: {line}',
  'worktree.include.parentPath': 'No se admiten rutas superiores (..): {line}',
  'worktree.include.gitDir': 'No se admiten rutas dentro de .git: {line}',
  'worktree.include.fileTooLarge': '.worktreeinclude supera los {max} bytes y se ignoró',
  'worktree.include.missing': 'Omitido, no existe: {entry}',
  'worktree.include.notIgnored': 'Omitido, no está en gitignore: {entry}',
  'worktree.include.sizeFailed': 'No se pudo calcular el tamaño: {entry} ({detail})',
  'worktree.include.overLimit': 'Omitido, supera el límite de copia (200 MB): {entry}',
  'worktree.include.copyFailed': 'Error al copiar: {entry} ({detail})',
  'worktree.create.fetchFailed':
    'No se pudo actualizar desde el remoto; se creó a partir de {baseRef} local',
  'worktree.create.baseRecordFailed':
    'No se pudo registrar branch.base — al eliminar, la comprobación de fusión usará HEAD',
  'worktree.create.autoSetupRemoteFailed':
    'No se pudo establecer push.autoSetupRemote — el primer push necesitará -u',
  // worktreeErrors.ts — worktree IPC error code → user-facing message
  'worktree.error.notGitRepo': 'La carpeta seleccionada no es un repositorio de git.',
  'worktree.error.noBase':
    'No se encontró la rama base (origin/HEAD, main, master), así que no se puede crear el worktree.',
  'worktree.error.fetchFailed':
    'No se pudo obtener la rama base desde el remoto. Compruebe la red.',
  'worktree.error.nameExhausted':
    'Hay demasiados worktrees y ramas con este nombre. Indique otro nombre.',
  'worktree.error.invalidName': 'El nombre no contiene caracteres utilizables.',
  'worktree.error.notManaged': 'Este worktree no lo creó esta aplicación, así que no se puede eliminar.',
  'worktree.error.dangerousPath': 'Eliminación rechazada: la ruta no es segura.',
  'worktree.error.dirty': 'No se eliminó: hay cambios sin confirmar.',
  'worktree.error.orphanUnproven':
    'No se eliminó: no se pudo verificar la propiedad. Compruébelo manualmente antes de eliminar.',
  'worktree.error.orphanUnverifiable':
    'git no rastrea esta carpeta, así que no se puede saber si hay cambios sin confirmar.',
  'worktree.error.gitAddFailed': 'No se pudo crear el worktree de git.',
  'worktree.error.gitRemoveFailed': 'No se pudo eliminar el worktree de git.',
  'worktree.error.raw': '{detail}',
  'worktree.inUse.session':
    'La sesión «{title}» está en ejecución y usa este worktree. Cierre primero esa sesión.',
  'worktree.inUse.run':
    'El proceso «{name}» está en ejecución y usa este worktree. Deténgalo primero.',
  'worktree.inUse.unknown': 'Este worktree está en uso.',
  // ROLL_MIXED_PROVIDER in sessions/manager.ts — a session-rolling constraint unrelated to worktrees
  'session.roll.mixedProvider': 'La rotación no puede mezclar cuentas de Claude y de Codex',
  // App.tsx — shared window controls, resizer, separator
  'common.minimize': 'Minimizar',
  'common.maximize': 'Maximizar',
  'common.restore': 'Restaurar',
  'common.resizeSidebar': 'Ajustar el ancho de la barra lateral',
  'common.or': 'o',
  'common.quitConfirm.title': 'Cerrar y salir de Astera',
  'common.quitConfirm.body':
    'Al cerrar la ventana, Astera se cierra y se finalizarán {count} sesiones en curso. ¿Continuar?',
  // index.ts — system tray context menu
  'common.trayOpen': 'Abrir',
  'common.trayQuit': 'Salir',
  // App.tsx — rail, session spawn failure, placeholder, status bar usage
  'session.rail.toggleSidebar': 'Contraer o expandir la barra lateral',
  'session.spawn.failed': 'No se pudo iniciar la sesión: {message}',
  'session.spawn.failedWorktreeKept':
    'No se pudo iniciar la sesión: {message} (el worktree "{name}" se conservó; elimínelo desde el panel Worktrees)',
  // Rolling-resume guard hit — tells the user the tab was just focused and their chosen options were dropped
  'session.spawn.resumeLiveIgnored':
    'Esta sesión ya está en ejecución — las opciones seleccionadas no se aplicaron.',
  'session.placeholder.start': '+ Empiece con una sesión nueva',
  'session.usage.contextTitleWithTokens': 'Uso del contexto ({used} / {window} tokens)',
  'session.usage.contextTitle': 'Uso del contexto',
  'session.usage.contextEmpty': 'Uso del contexto (se muestra tras el primer turno)',
  'session.usage.fiveHourLabel': 'Uso de 5 h',
  'session.usage.fiveHourTitle': 'Uso de la sesión de 5 horas',
  'session.usage.weekly': 'Uso semanal',
  'session.statusbar.count': '{count} sesiones',
  'session.statusbar.none': 'Sin sesiones',
  'session.statusbar.accountCount': '{count} cuentas',
  // App.tsx — file editor buffer state, save, conflict, close confirmation
  'files.editor.binaryUnsupported': 'Los archivos binarios no se pueden mostrar.',
  'files.save.failed': 'Error al guardar: {detail}',
  'files.reload.failed': 'Error al recargar: {detail}',
  'files.unsaved.title': 'Cambios sin guardar',
  'files.unsaved.bodyWithTitle': 'El archivo «{title}» tiene cambios sin guardar. ¿Cerrarlo igualmente?',
  'files.unsaved.body': 'Hay cambios sin guardar. ¿Cerrar igualmente?',
  'files.editor.deletedExternally': 'El archivo se eliminó',
  'files.editor.readOnlyReason': 'Solo lectura (archivo grande o binario)',
  'files.editor.conflictChanged': 'Cambiado en el disco',
  'files.editor.reload': 'Recargar',
  'files.editor.keepMine': 'Conservar mis cambios',
  'files.editor.loading': 'Cargando…',
  'files.editor.selectPrompt': 'Seleccione un archivo en el árbol',
  // MarkdownPreview.tsx — fallo al cargar imagen, aviso de imagen remota
  'files.markdown.image.failed': 'No se pudo cargar la imagen',
  'files.markdown.renderError': 'No se pudo mostrar este documento',
  // MarkdownSplit.tsx — los tres botones de modo de la barra de herramientas, el divisor izquierda/derecha
  'files.markdown.mode.editor': 'Solo editor',
  'files.markdown.mode.split': 'Editor y vista previa',
  'files.markdown.mode.preview': 'Solo vista previa',
  'files.markdown.resizeSplit': 'Ajustar el tamaño de la división',
  // App.tsx — explorer close confirmation
  'explorer.closeConfirm.body': 'Hay cambios sin guardar. ¿Cerrar el explorador igualmente?',
  // App.tsx — run console resizer, start failure
  'run.resizeConsole': 'Ajustar el tamaño de la consola',
  'run.start.failed': 'Error al ejecutar: {detail}',
  'run.jump.notAllowed': 'No se puede ir a ese proyecto — debe ser uno que esta app haya abierto antes',
  // App.tsx — settings modal Info/Slack/Worktree tabs, CLI-not-found screen
  'settings.info.appName': 'Nombre de la aplicación',
  'settings.info.version': 'Versión',
  'settings.info.registeredAccounts': 'Cuentas registradas',
  'settings.info.update': 'Actualización',
  'settings.info.cliNotDetected': 'No detectado',
  'settings.slack.save': 'Guardar',
  'settings.slack.saved': 'Guardado',
  'settings.slack.saveFailed': 'No se pudo guardar la configuración de Slack: {detail}',
  'settings.slack.hint':
    'Si activa «Notificaciones de progreso en Slack» en una sesión nueva, se envía el progreso.',
  // Bot settings. Which delivery path is active has to be visible on screen at a glance —
  // a bot token with no channel ID silently falls back to Webhook (slack.ts applyConfig), so that state has to show
  'settings.slack.botSection': 'Bot (un hilo por sesión)',
  'settings.slack.channelIdHint':
    'Haga clic derecho en el canal → Detalles del canal; está al final.',
  'settings.slack.appTokenHint':
    'Para la recepción en Socket Mode. En modo bot, las respuestas del hilo llegan con este token.',
  // A channel is not a permission boundary — anyone invited to it could push input into someone else's
  // session. Only replies from this member are injected. Empty means nobody, not everybody.
  'settings.slack.memberIdHint':
    'Solo las respuestas de este miembro en el hilo llegan a la sesión. En Slack: su perfil → ⋯ → «Copiar ID de miembro».',
  'settings.slack.memberIdRequired':
    '⚠️ Sin Member ID no se entrega la respuesta de nadie en el hilo. Escriba su propio Member ID.',
  'settings.slack.modeBot': 'Modo bot: cada sesión reúne sus notificaciones en un mismo hilo.',
  'settings.slack.modeWebhook':
    'Webhook unidireccional: complete el token del bot y el ID de canal para pasar a un hilo por sesión.',
  'settings.slack.modeOff':
    'No hay ninguna vía de envío, así que no se envían notificaciones. Se necesita una URL de webhook, o un token de bot más el ID de canal.',
  'settings.slack.setupGuide':
    'Hay que invitar al bot al canal de destino para que publique. Consulte docs/slack-bot-setup.md para ver todos los pasos.',
  'settings.worktree.createLocation': 'Ubicación de los worktrees nuevos',
  'settings.worktree.change': 'Cambiar…',
  'settings.worktree.hint':
    'Los worktrees nuevos se crean bajo esta carpeta como <repo>/<nombre>. Los worktrees existentes no se mueven.',
  'settings.history.hiddenProjects': 'Proyectos ocultos',
  'settings.history.unhide': 'Mostrar',
  'settings.history.empty': 'No hay proyectos ocultos.',
  // ThemeSettings.tsx — the theme card grid
  'settings.theme.label': 'Tema',
  'settings.theme.hint':
    'Cambia colores, esquinas y tipografía a la vez. La fuente del terminal se elige aparte, más abajo.',
  'settings.theme.saveFailed': 'No se pudo guardar el tema: {detail}',
  // TerminalFontSettings.tsx — the terminal font picker rows
  'settings.font.latin': 'Fuente latina del terminal',
  'settings.font.hangul': 'Fuente hangul del terminal',
  'settings.font.system': 'Predeterminada del sistema',
  'settings.font.notInstalled': 'no instalada',
  'settings.font.sample': 'AaBb 한글 123',
  'settings.font.hangulShadowed':
    'La fuente latina seleccionada también dibuja el hangul, así que la fuente de hangul no tiene efecto.',
  'settings.font.listFailed': 'No se pudo obtener la lista de fuentes instaladas: {detail}',
  'settings.font.saveFailed': 'No se pudo guardar la configuración de fuentes: {detail}',
  'settings.font.checkingHangul': 'comprobando las fuentes instaladas…',
  'settings.font.loadingList': 'leyendo las fuentes instaladas…',
  // App.tsx — update status (the title-bar UpdateIndicator / the settings Info tab)
  'update.tb.restartInstallVersion': 'Reiniciar e instalar v{version}',
  'update.tb.checking': 'Comprobando actualizaciones…',
  'update.tb.available': 'Nueva versión {version} encontrada',
  'update.tb.downloading': 'Descargando {percent}%',
  'update.tb.error': 'Error de actualización',
  // index.ts — diagnostic message for when the electron-updater module does not export properly (title-bar tooltip)
  'update.tb.autoUpdaterMissing': 'No se encontró el export autoUpdater',
  'update.info.downloading': 'Descargando {percent}%…',
  'update.info.restartInstallVersion': 'Reiniciar e instalar v{version}',
  'update.info.checking': 'Comprobando…',
  'update.info.checkButton': 'Comprobar actualizaciones',
  'update.info.upToDateAt': 'Ya tiene la última versión (comprobado {time})',
  // 'available' means "found", not "downloading"
  'update.info.available': 'Nueva versión {version} disponible',
  'update.info.downloadVersion': 'Descargar {version}',
  'update.info.checkFailed': 'Error al comprobar',
  // App.tsx — the toast for a downloaded new version, and the session-kill confirmation when installing now
  'update.toast.available': 'Ya está disponible la versión v{version}',
  'update.toast.download': 'Descargar',
  'update.toast.ready': 'La actualización v{version} está lista',
  'update.toast.installNow': 'Instalar ahora',
  'update.confirm.title': 'Instalar y reiniciar ahora',
  'update.confirm.body': 'Se finalizarán {count} sesiones en curso. ¿Continuar?',
  // UpdateGate.tsx — the screen that covers the app when the version is below the minimum the release policy sets
  'update.gate.title': 'Hay que actualizar',
  'update.gate.body': 'Actualice a la versión {version}',
  'update.gate.bodyNoVersion': 'Actualice para continuar',
  'update.gate.preparing': 'Preparando la actualización…',
  'update.gate.ready': 'v{version} lista para instalar',
  'update.gate.failed':
    'No se pudo descargar la actualización. Compruebe la red y vuelva a intentarlo.',
  'update.gate.retry': 'Reintentar',
  'update.gate.quit': 'Salir de la aplicación',
  // App.tsx — settings modal Shortcuts tab
  'shortcut.group.terminal': 'Terminal',
  'shortcut.terminal.newline': 'Salto de línea',
  'shortcut.terminal.copyOrInterrupt': 'Copiar selección · interrumpir si no hay',
  'shortcut.paste': 'Pegar',
  'shortcut.group.sessionTab': 'Pestañas de sesión',
  'shortcut.sessionTab.prev': 'Pestaña anterior',
  'shortcut.sessionTab.next': 'Pestaña siguiente',
  'shortcut.gesture.tabDrag': 'Arrastrar la pestaña',
  'shortcut.sessionTab.reorder': 'Reordenar',
  'shortcut.group.pane': 'Paneles',
  'shortcut.pane.splitRight': 'Dividir a la derecha',
  'shortcut.pane.splitDown': 'Dividir abajo',
  'shortcut.pane.focusLeft': 'Panel izquierdo',
  'shortcut.pane.focusRight': 'Panel derecho',
  'shortcut.pane.focusUp': 'Panel de arriba',
  'shortcut.pane.focusDown': 'Panel de abajo',
  // ShortcutSettings.tsx — the editable shortcut list
  'shortcut.group.editable': 'Personalizables',
  'shortcut.edit': 'Cambiar',
  'shortcut.resetOne': 'Predeterminado',
  'shortcut.capturing': 'Presione una tecla (Esc para cancelar)',
  'shortcut.unbound': 'Ninguno',
  'shortcut.conflictWith': '{key} ya se usa en "{action}"',
  'shortcut.riskTitle': 'Asignar {key} como atajo de la aplicación',
  'shortcut.riskConfirm': 'Asignar igualmente',
  'shortcut.risk.interrupt':
    'Esta tecla interrumpe la tarea en ejecución en el terminal. Si la toma la aplicación, no podrá interrumpir desde una sesión.',
  'shortcut.risk.eof':
    'Esta tecla cierra el CLI en el terminal. Si la toma la aplicación, no podrá usarla en una sesión.',
  'shortcut.risk.readline':
    'Esta tecla sirve para editar la línea en el terminal (ir al inicio o al final, borrar una palabra, etc.). Si la toma la aplicación, no podrá usarla mientras escribe.',
  'shortcut.risk.historySearch':
    'Esta tecla busca en el historial del terminal. Si la toma la aplicación, no podrá usarla en una sesión.',
  'shortcut.risk.clear':
    'Esta tecla limpia la pantalla del terminal. Si la toma la aplicación, no podrá usarla en una sesión.',
  'shortcut.risk.newline':
    'Codex usa esta tecla para el salto de línea. Si la toma la aplicación, se bloquea la entrada de varias líneas.',
  'shortcut.risk.cliMode':
    'Claude Code y Codex usan esta tecla para cambiar de modo y autocompletar. Si la toma la aplicación, no podrá usarla en una sesión.',
  'shortcut.pane.dragSplit': 'Al borde para dividir · al centro para mover',
  'shortcut.group.explorer': 'Explorador de archivos',
  'shortcut.explorer.toggleMode': 'Mostrar/ocultar el explorador',
  'shortcut.explorer.saveFile': 'Guardar el archivo',
  'shortcut.explorer.closeFileTab': 'Cerrar la pestaña de archivo',
  'shortcut.explorer.cyclePreview': 'Cambiar el modo de vista previa de markdown',
  'shortcut.explorer.rename': 'Cambiar nombre',
  'shortcut.explorer.delete': 'Eliminar',
  'shortcut.explorer.selectAll': 'Seleccionar todo',
  'shortcut.explorer.cut': 'Cortar',
  'shortcut.explorer.copy': 'Copiar',
  'shortcut.gesture.itemDrag': 'Arrastrar el elemento',
  'shortcut.explorer.move': 'Mover · con Ctrl, copiar',
  'shortcut.explorer.undo': 'Deshacer',
  // useFileOps.ts, FileExplorer.tsx — file-operation action names
  'files.action.delete': 'Eliminar',
  'files.action.duplicate': 'Duplicar',
  'files.action.move': 'Mover',
  'files.action.copy': 'Copiar',
  'files.action.create': 'Crear',
  'files.action.rename': 'Cambiar nombre',
  // useFileOps.ts — runBatch partial-failure aggregation
  'files.batch.partialFail': '{label}: fallaron {failed} de {total} elementos: {shown}{more}',
  'files.batch.moreCount': ', y {count} más',
  // useFileOps.ts — inline edit (create/rename) failure
  'files.commit.failed': 'Error en {action}: {detail}',
  // useFileOps.ts — delete confirmation modal
  'files.delete.undoHint':
    'Puede recuperarlo con Ctrl+Z o desde Local History (se guarda hasta 30 días · se excluyen los elementos de más de 50MB).',
  'files.delete.confirmOne': '¿Eliminar «{name}»?\n{undoHint}',
  'files.delete.confirmDirWithCount':
    '¿Eliminar la carpeta «{name}» y los {count} elementos que contiene?\n{undoHint}',
  'files.delete.confirmDirAll': '¿Eliminar la carpeta «{name}» y todo su contenido?\n{undoHint}',
  'files.delete.confirmMany': '{shown}{more} — ¿eliminar {total} elementos?{dirNote}\n{undoHint}',
  'files.delete.dirNote': ' Se eliminará también el contenido de {count} carpetas.',
  'files.delete.moreNames': ', y {count} más',
  'files.delete.skippedTooLarge': 'El elemento era demasiado grande para guardarlo en Local History',
  'files.delete.skippedFailed':
    'No se pudo crear la instantánea en Local History — la eliminación sí se completó',
  // useFileOps.ts — cut/copy and paste
  'files.clipboard.cutDone': 'Se cortaron {count} elementos',
  'files.clipboard.copyDone': 'Se copiaron {count} elementos',
  'files.paste.blocked': 'No se puede pegar: {reason}',
  'files.paste.invalidTarget': 'El destino no es válido',
  'files.paste.empty': 'No hay nada que pegar',
  'files.transfer.movedTo': 'Se movieron {count} elementos a «{dest}»',
  'files.transfer.copiedTo': 'Se copiaron {count} elementos a «{dest}»',
  'files.transfer.skipped': 'Se omitieron {count} elementos: {reason}',
  // useFileOps.ts — Ctrl+Z undo
  'files.undo.empty': 'No hay nada que deshacer',
  'files.undo.changedOne': '«{name}» cambió',
  'files.undo.changedMany': '{shown}{more} cambiaron',
  'files.undo.blocked': 'No se puede deshacer {desc}: {detail}',
  'files.undo.partialFail': 'Al deshacer fallaron {failed} de {attempted} elementos: {shown}{more}',
  'files.undo.partialMissing': 'Al deshacer fallaron {missing} de {total} elementos: {shown}{more}',
  'files.undo.permanentTooLarge':
    'Se eliminó de forma permanente al deshacer — era demasiado grande para guardarlo en Local History, así que no se puede recuperar',
  'files.undo.permanentSnapshotFailed':
    'Se eliminó al deshacer — la instantánea en Local History falló, así que no se puede recuperar',
  'files.undo.done': 'Se deshizo {desc}',
  // undo.ts — the Message keys describe/describeRestored return
  'files.undo.desc.createdOne': 'la creación de «{name}»',
  'files.undo.desc.createdMany': 'la creación de {count} elementos',
  'files.undo.desc.copiedOne': 'la copia de «{name}»',
  'files.undo.desc.copiedMany': 'la copia de {count} elementos',
  'files.undo.desc.renamed': 'el cambio de nombre de «{from}» a «{to}»',
  'files.undo.desc.movedOne': 'el movimiento de «{name}»',
  'files.undo.desc.movedMany': 'el movimiento de {count} elementos',
  'files.undo.desc.deletedOne': 'la eliminación de «{name}»',
  'files.undo.desc.deletedMany': 'la eliminación de {count} elementos',
  'files.undo.restored.one': 'Se restauró «{name}»',
  'files.undo.restored.many': 'Se restauraron {count} elementos',
  'files.undo.restored.renamedOne':
    'Se restauró «{name}» — ya existía ese nombre, así que se recuperó en otra ruta: {to}',
  'files.undo.restored.renamedMany':
    'Se restauraron {count} elementos — {renamedCount} se recuperaron con otro nombre porque ya existía uno igual: {shown}',
  'files.undo.restored.renamedManyWithMore':
    'Se restauraron {count} elementos — {renamedCount} se recuperaron con otro nombre porque ya existía uno igual: {shown}, y {moreCount} más',
  // FileExplorer.tsx — panel header, context menu
  'explorer.title': 'Explorador',
  'explorer.noActiveSession': 'No hay ninguna sesión activa',
  // Folder state shown inside the tree (the .fx-note row)
  'explorer.dir.loading': 'Cargando…',
  'explorer.dir.readFailed': 'Error al leer: {detail}',
  'explorer.dir.empty': 'Vacío',
  'explorer.refresh': 'Actualizar',
  'explorer.reveal.failed': 'No se pudo abrir en el explorador: {detail}',
  'explorer.menu.newFile': 'Archivo nuevo',
  'explorer.menu.newFolder': 'Carpeta nueva',
  'explorer.menu.rename': 'Cambiar nombre (F2)',
  'explorer.menu.delete': 'Eliminar (Del)',
  'explorer.menu.deleteCount': 'Eliminar ({count}, Del)',
  'explorer.menu.duplicateCount': 'Duplicar ({count})',
  'explorer.menu.cut': 'Cortar (Ctrl+X)',
  'explorer.menu.copy': 'Copiar (Ctrl+C)',
  'explorer.menu.paste': 'Pegar (Ctrl+V)',
  'explorer.menu.copyPath': 'Copiar la ruta',
  'explorer.menu.copyRelativePath': 'Copiar la ruta relativa',
  'explorer.menu.reveal': 'Abrir en el explorador',
  // FileExplorer.tsx — git status on a tree row (tooltip, aria-label)
  'explorer.git.new': 'Archivo nuevo',
  'explorer.git.modified': 'Modificado',
  'explorer.git.deleted': 'Eliminado',
  'explorer.git.conflict': 'Conflicto',
  'explorer.git.folderCount': '{count} cambios',
  'explorer.rail.toggle': 'Explorador de archivos',
  // WorkbenchTabs.tsx — the dirty marker on a file tab
  'explorer.tab.unsaved': 'Sin guardar',
  // LocalHistoryDialog.tsx — the Local History browse/restore modal
  // ('Local History' is treated as a proper noun and left untranslated)
  'localHistory.loading': 'Cargando…',
  'localHistory.empty': 'No hay historial de eliminaciones',
  'localHistory.restore': 'Restaurar',
  'localHistory.restoring': 'Restaurando…',
  'localHistory.restored': 'Se restauró: {path}',
  'localHistory.restoreFailed': 'Error al restaurar: {detail}',
  'localHistory.listFailed': 'Error al consultar el historial: {detail}',
  'localHistory.notFound': 'No se encontró la entrada del historial',
  // AccountPanel.tsx — account register, import, detect, logout, settings sync
  'account.field.kind': 'Tipo',
  'account.field.label': 'Etiqueta',
  'account.panel.title': 'Cuentas',
  'account.panel.empty': 'Agregue una cuenta',
  'account.add.title': 'Agregar cuenta',
  'account.add.button': 'Agregar',
  'account.add.adding': 'Agregando…',
  'account.add.labelPlaceholder': 'Ej.: Cuenta del trabajo',
  'account.add.copySettingsLabel': 'Importar la configuración de la cuenta predeterminada',
  'account.add.loginHintClaude': 'Inicie sesión desde el terminal de la sesión con /login.',
  'account.add.loginHintCodex':
    'Inicie sesión desde el terminal de la sesión siguiendo las indicaciones de codex.',
  'account.add.syncFailed': 'La cuenta se agregó, pero falló la importación de la configuración: {detail}',
  'account.import.title': 'Importar cuenta',
  'account.import.button': 'Importar',
  'account.import.someFailed': 'No se pudieron registrar {count} cuentas.',
  'account.detect.title': 'Cuentas detectadas',
  'account.detect.button': 'Autodetectar',
  'account.detect.empty': 'No se detectaron cuentas',
  'account.detect.importSelected': 'Registrar selección',
  'account.detect.failed': 'Falló la detección automática: {detail}',
  'account.status.loggedIn': 'Sesión iniciada',
  'account.status.notLoggedIn': 'Sin iniciar',
  // AccountPanel.tsx — unregister. When logout comes with it, it says the credentials are removed (destructive).
  'account.remove.title': 'Anular el registro de la cuenta',
  'account.remove.button': 'Anular registro',
  'account.remove.confirm': '¿Anular el registro de la cuenta «{label}»?',
  'account.remove.logoutToo': 'Cerrar sesión también (elimina la autenticación)',
  'account.remove.logoutWarning':
    'Al cerrar sesión se elimina la autenticación de esta cuenta y tendrá que volver a iniciar sesión. Si la cuenta usa un directorio de inicio (~/.claude, ~/.codex), también se cerrará la sesión que utilizaba fuera de esta aplicación.',
  'account.remove.processing': 'Procesando…',
  'account.remove.confirmWithLogout': 'Anular y cerrar sesión',
  'account.logout.failed': 'Error al cerrar sesión: {detail}\n\nLa anulación del registro continúa igualmente.',
  // The Message key accountLogout in core.ts returns
  'account.error.raw': '{detail}',
  'account.error.logoutFailed': 'Error al cerrar sesión',
  // AccountPanel.tsx — default-account settings sync. A destructive action that overwrites the target account's settings.
  'account.sync.title': 'Importar la configuración de la cuenta predeterminada',
  'account.sync.confirmBody':
    'Se importará la configuración de la cuenta «{source}» a la cuenta «{label}».',
  'account.sync.mergeNote':
    'Los plugins, MCP y las habilidades, comandos y agentes personales se combinan elemento por elemento. Los elementos coincidentes toman el valor del origen y los que solo tiene esta cuenta se conservan.',
  'account.sync.replaceNote':
    'El archivo config.toml se reemplaza por completo con el del origen. La configuración exclusiva de esta cuenta se pierde; el archivo existente se respalda como .bak.',
  'account.sync.appliesNextSession':
    'No se aplica a las sesiones en ejecución: surte efecto a partir de la siguiente sesión.',
  'account.sync.confirm': 'Importar',
  'account.sync.confirming': 'Importando…',
  'account.sync.done': 'Se importó la configuración.',
  'account.sync.failed': 'Error al importar: {detail}',
  // The Message keys accountSyncSettings in core.ts returns
  'account.sync.isDefaultSource':
    'Esta cuenta es la predeterminada, por lo que es el origen de la configuración. No puede ser el destino.',
  'account.sync.noDefault':
    'No hay ninguna cuenta de este CLI con la sesión iniciada, así que no hay origen del que importar.',
  'account.sync.nothingToCopy':
    'No hay configuración que importar (la cuenta de origen no tiene archivo de configuración).',
  // AccountSelect.tsx
  'account.select.none': '(Sin seleccionar)',
  // NewSessionDialog.tsx — the new-session modal
  'session.new.title': 'Sesión nueva',
  'session.new.runningWarning': 'Hay {count} sesiones en ejecución. El rendimiento puede verse afectado.',
  'session.new.codexMissingPre': 'No se encontró el CLI de Codex.',
  'session.new.claudeMissingPre': 'No se encontró el CLI de Claude Code.',
  'session.new.cliMissingPost': 'Instálelo y vuelva a intentarlo.',
  'session.field.projectFolder': 'Carpeta del proyecto',
  'session.field.account': 'Cuenta',
  'session.new.folderNotSelected': '(Sin seleccionar)',
  'session.new.pickFolder': 'Seleccionar…',
  'session.new.useWorktree': 'Iniciar en un worktree aparte',
  'session.new.worktreeNoBase':
    'Este repositorio no tiene ninguna rama que sirva de base, así que no se puede crear el worktree. Cree un commit y vuelva a intentarlo.',
  'session.new.worktreeBaseRef': 'Rama base',
  'session.new.worktreeBaseCurrent': '(rama actual)',
  'session.new.worktreeBaseRemote': 'Remotas',
  'session.new.worktreeBaseLocal': 'Locales',
  'session.new.worktreeNamePlaceholder': 'Nombre del worktree (automático si se deja vacío)',
  'session.new.accountSlotPrimary': 'Cuenta 1',
  'session.new.accountSlotRoll': 'Cuenta {slot} (cambia al llegar al límite)',
  'session.new.removeAccountSlot': 'Quitar cuenta',
  'session.new.addAccountSlot': '+ Agregar cuenta',
  // NewSessionDialog.tsx — rolling, bypass permissions. Both spell out a risk, so keep the strength.
  'session.new.rollLabel': 'Al llegar al límite, esperar al restablecimiento y reanudar automáticamente',
  'session.new.multiAccountAuto': '(Varias cuentas: automático)',
  'session.new.rollPromptPlaceholder': 'Continúa con el trabajo',
  'session.new.rollPromptHint': 'Se envía al reanudar (valor predeterminado si se deja vacío)',
  'session.new.slackNotify': 'Notificaciones de progreso en Slack',
  'session.new.slackNeedsWebhook': '(Hay que registrar la URL del webhook en la configuración)',
  'session.new.saveDefaultAccount': 'Recordar esta cuenta para este proyecto',
  'session.new.bypassPermissions': 'Ejecutar sin comprobar permisos (bypass permissions)',
  'session.new.start': 'Iniciar',
  'session.new.starting': 'Iniciando la sesión…',
  'session.new.startingWorktree': 'Creando el worktree…',
  // NewSessionDialog.tsx scheduler UI
  'session.new.schedLabel': 'Programador — ejecutar un comando periódicamente',
  'session.new.schedMode.interval': 'Cada N minutos',
  'session.new.schedMode.daily': 'A diario',
  'session.new.schedMode.weekly': 'Semanal',
  'session.new.schedMode.monthly': 'Mensual',
  'session.new.schedMinutesUnit': 'minutos',
  'session.new.schedDaysUnit': 'día(s)',
  'session.new.schedCommandPlaceholder': 'Comando que ejecutar (obligatorio)',
  'session.new.schedHint': 'Este comando se envía a la sesión en cada ciclo indicado',
  // Weekday button labels. Index 0 = Sunday (matches the Date.getDay() convention)
  'session.sched.weekday.sun': 'dom',
  'session.sched.weekday.mon': 'lun',
  'session.sched.weekday.tue': 'mar',
  'session.sched.weekday.wed': 'mié',
  'session.sched.weekday.thu': 'jue',
  'session.sched.weekday.fri': 'vie',
  'session.sched.weekday.sat': 'sáb',
  // WorkbenchTabs.tsx
  'session.tab.rollTooltip': 'Rotación: {chain}',
  // PaneGrid / pane context menu
  'session.pane.splitRight': 'Dividir a la derecha',
  'session.pane.splitDown': 'Dividir abajo',
  'session.pane.unsplit': 'Quitar división',
  'session.pane.maxReached': 'Se puede dividir en 4 paneles como máximo',
  // ResumeDialog.tsx
  'session.resume.title': 'Reanudar la sesión',
  'session.resume.conversationLabel': 'Conversación',
  'session.resume.checkingLogin': 'Comprobando las cuentas con sesión iniciada…',
  'session.resume.noLoggedInAccounts':
    'No hay ninguna cuenta con la sesión iniciada. Inicie sesión en una cuenta primero.',
  'session.resume.originalAccountSuffix': ' (cuenta original)',
  'session.resume.crossAccountHint':
    'Se copia la transcripción a esta cuenta y luego se reanuda (la transcripción original se conserva).',
  'session.resume.rollChainHint': 'Al llegar al límite, se cambia en este orden: {chain}',
  'session.resume.confirm': 'Reanudar',
  // TerminalView.tsx — the rolling banner and the loading/exit overlays
  'session.terminal.rollSwitching': 'Continuando con «{label}»…',
  'session.terminal.trustAccepting': 'Aceptando automáticamente la confianza de la carpeta…',
  // {time} here is fmtDateTime (M/D HH:MM), not fmtTime — no preposition can precede it
  'session.terminal.weeklyLimitWaiting': 'Límite semanal agotado — reanudación: {time}',
  'session.terminal.limitWaiting': 'Límite alcanzado — se reanudará a las {time}',
  // Auto-resume failure toast
  'session.toast.stalled':
    'La sesión «{title}» está detenida — falló la reanudación automática, hay que revisarla',
  'session.terminal.loadingContent': 'Cargando el contenido…',
  'session.terminal.exited': 'Finalizado (código {code})',
  'session.terminal.restart': 'Reiniciar',
  // TerminalView.tsx schedule banner
  'session.terminal.schedFallback': 'Programación',
  'session.terminal.schedSummary.interval': 'cada {minutes} min',
  'session.terminal.schedSummary.daily': 'a diario a las {time}',
  'session.terminal.schedSummary.weekly': '{days} a las {time}',
  'session.terminal.schedSummary.monthly': 'el día {days} de cada mes a las {time}',
  'session.terminal.schedNextRun': ' · próxima ejecución {time}',
  'session.terminal.schedDisable': 'Desactivar',
  // HistoryBrowser.tsx
  'history.panel.title': 'Historial',
  'history.panel.empty': 'Sin registros',
  'history.loading': 'Cargando…',
  'history.filter.deletedSuffix': ' (eliminada)',
  // HistoryBrowser.tsx — account filter labels
  'session.resume.originAccount': 'Cuenta original',
  'session.resume.originDeleted': 'Cuenta eliminada',
  'history.filter.allAccounts': 'Todas las cuentas',
  'history.refresh.tooltip': 'Alternativa manual si falla el watcher',
  'history.menu.hide': 'Ocultar',
  'history.project.noSessions': 'Sin sesiones',
  'history.entry.preview': 'Vista previa',
  'history.preview.truncated': '(solo lo reciente)',
  'history.preview.me': 'Yo',
  'history.resume.folderMissingTitle': 'No se encontró la carpeta del proyecto',
  'history.resume.folderMissingBody':
    'La carpeta original del proyecto no existe:\n{cwd}\n\n¿Elegir otra carpeta para reanudar?',
  'history.resume.pickFolder': 'Elegir carpeta',
  // WorktreePanel.tsx — status labels
  'worktree.status.orphanDir': 'Registro de git perdido',
  'worktree.status.missing': 'Falta la carpeta',
  // WorktreePanel.tsx — delete confirmation modal, result toasts
  'worktree.remove.title': 'Eliminar worktree',
  'worktree.remove.body':
    '{name} ({branch})\n{path}\n\n¿Eliminar este worktree? Se eliminan juntas la carpeta y la rama. Una rama sin fusionar se conserva para no perder sus commits.',
  'worktree.remove.branchPreserved': 'La rama {branch} no estaba fusionada, así que se conservó',
  'worktree.remove.done': 'Se eliminó el worktree',
  'worktree.remove.alreadyGone': '{name} ya se había eliminado, así que se quitó de la lista',
  // Shown on the row while deleting
  'worktree.remove.removing': 'Eliminando…',
  // WorktreePanel.tsx — force-delete second confirmation
  'worktree.forceRemove.unverifiableTitle': 'No se puede comprobar si hay cambios',
  'worktree.forceRemove.dirtyTitle': 'Cambios sin confirmar',
  'worktree.forceRemove.unverifiableBody':
    'git ya no rastrea {name}, así que no se puede saber si hay cambios sin confirmar.\n{path}\nSi fuerza la eliminación, se perderá el contenido de la carpeta. Ábrala y compruébelo antes de continuar.',
  'worktree.forceRemove.dirtyBody':
    '{name} tiene {count} cambios sin confirmar.\nSi fuerza la eliminación, se perderán esos cambios. ¿Continuar?',
  'worktree.forceRemove.confirm': 'Forzar eliminación',
  // WorktreePanel.tsx — panel header, row icon buttons
  'worktree.refresh': 'Actualizar',
  'worktree.action.startSession': 'Nueva sesión',
  // RunToolbar.tsx — config select, run/stop, the running list, ⋮ menu (only item opens RunConfigManager)
  'run.config.selectLabel': 'Configuración de ejecución',
  'run.config.none': 'Sin configuraciones de ejecución',
  'run.config.more': 'Más acciones',
  'run.action.run': 'Ejecutar',
  'run.action.stop': 'Detener',
  'run.global.listTitle': 'Ejecuciones activas',
  'run.global.jump': 'Ir',
  'run.validation.tag': 'Validación',
  // App.tsx runManagerSave — shown when the run.saveConfig IPC fails
  'run.config.saveFailed': 'Error al guardar: {detail}',
  // main/run/prepare.ts resolveRunCwd (run.start) and ipc.ts assertConfigCwd (run.saveConfig) — translated in main before throwing (the layering rule)
  'run.config.cwdNotString': 'La carpeta de trabajo de la configuración de ejecución no es válida',
  'run.config.cwdOutsideProject':
    'La carpeta de trabajo de la configuración de ejecución debe estar dentro del proyecto',
  'run.start.incomplete': 'Esta configuración de ejecución tiene un campo obligatorio vacío: {fields}',
  // RunConfigForm.tsx — name field and the JDK/file pickers shared by every per-kind form
  'run.form.nameLabel': 'Nombre',
  'run.form.jdkLoading': 'Buscando JDK…',
  'run.form.jdkNone': 'No usar (entorno de la aplicación tal cual)',
  'run.form.jdkCustom': '{path} (personalizado)',
  'run.form.jdkBrowse': 'Examinar…',
  'run.form.cwdBrowse': 'Seleccionar…',
  'run.form.fileBrowse': 'Examinar…',
  'run.form.interpreterLoading': 'Buscando intérpretes de Python…',
  'run.form.interpreterAuto': 'Automático (python en PATH)',
  'run.form.interpreterCustom': '{path} (personalizado)',
  'run.form.interpreterBrowse': 'Examinar…',
  'run.form.composeFileBrowse': 'Examinar…',
  'run.form.composeServicesLoading': 'Buscando servicios de Compose…',
  'run.form.composeServicesHint': 'Candidatos: {list}',
  'run.form.dockerfilePathBrowse': 'Examinar…',
  'run.form.projectLoading': 'Buscando proyectos de .NET…',
  'run.form.projectCustom': '{path} (personalizado)',
  'run.form.projectBrowse': 'Examinar…',
  // RunConfigManager.tsx — the two-pane dialog
  'run.manager.title': 'Configuraciones de ejecución',
  'run.manager.open': 'Gestionar configuraciones de ejecución…',
  'run.manager.add': 'Añadir',
  'run.manager.remove': 'Quitar',
  'run.manager.duplicate': 'Duplicar',
  'run.manager.seedHint':
    'Editar una configuración detectada automáticamente la guarda como una copia de configuración de usuario.',
  'run.type.shell': 'Shell',
  'run.type.npm': 'npm',
  'run.type.node': 'Node.js',
  'run.type.gradle': 'Gradle',
  'run.type.maven': 'Maven',
  'run.type.cargo': 'cargo',
  'run.type.go': 'go',
  'run.type.python': 'Python',
  'run.type.pytest': 'pytest',
  'run.type.compose': 'Docker Compose',
  'run.type.dockerfile': 'Dockerfile',
  'run.type.dotnet': '.NET',
  'run.field.javaHome': 'JDK',
  'run.field.springProfiles': 'Perfiles de Spring',
  'run.field.args': 'Argumentos',
  'run.field.cwd': 'Carpeta de trabajo',
  'run.field.env': 'Variables de entorno',
  'run.field.command': 'Comando',
  'run.field.script': 'Script',
  'run.field.file': 'Archivo',
  'run.field.tasks': 'Tareas',
  'run.field.goals': 'Objetivos',
  'run.field.subcommand': 'Subcomando',
  'run.field.packageManager': 'Gestor de paquetes',
  'run.field.packageManagerAuto': 'Automático',
  'run.field.release': 'Compilación release',
  'run.field.features': 'Características',
  'run.field.packagePath': 'Ruta del paquete',
  'run.field.nodePath': 'Ejecutable de Node',
  'run.field.interpreter': 'Intérprete',
  'run.field.target': 'Objetivo de la prueba',
  'run.field.composeFile': 'Archivo de Compose',
  'run.field.services': 'Servicios',
  'run.field.action': 'Acción',
  'run.field.imageTag': 'Etiqueta de imagen',
  'run.field.dockerfilePath': 'Ruta de Dockerfile',
  'run.field.buildArgs': 'Argumentos de compilación',
  'run.field.runArgs': 'Argumentos de ejecución',
  'run.field.project': 'Archivo de proyecto',
  'run.field.configuration': 'Configuración de compilación',
  'run.picker.search': 'Buscar…',
  'run.picker.detected': 'Detectado en este proyecto',
  'run.picker.other': 'Otros',
  'run.form.addOption': 'Añadir opción',
  // BottomPanel.tsx — the Run tab label, clear and collapse buttons
  'run.panel.noActiveRun': 'Ejecución',
  'run.panel.exited': ' · Finalizado (código {code})',
  'run.panel.clear': 'Limpiar',
  'run.panel.collapse': 'Contraer',
  // BottomPanel, the rail terminal button
  'terminal.rail.open': 'Terminal',
  'terminal.tab.label': 'Terminal {n}',
  'terminal.tab.new': 'Terminal nuevo',
  'terminal.tab.close': 'Cerrar el terminal',
  'terminal.open.failed': 'Error al abrir el terminal: {detail}',
  // rolling.ts and codexRolling.ts — the default resume prompt. Must stay identical to
  // session.new.rollPromptPlaceholder, which shows this value as its placeholder.
  'rolling.continuePrompt': 'Continúa con el trabajo',
  // slack.ts — the notification text that goes out to Slack
  'slack.turnDone': '✅ Respuesta completada',
  // {at} is HH:MM for the 5-hour scope but M/D HH:MM for the weekly one (fmtAt in main/slack.ts),
  // so no preposition can precede it
  'slack.limitWaiting': '⏸ Límite alcanzado — reanudación: {at} (límite {scope})',
  'slack.limitScope.weekly': 'semanal',
  'slack.limitScope.session': 'de 5 horas',
  'slack.accountSwitched': '🔁 Cambio de cuenta → {label}',
  'slack.limitReset': '▶️ Límite restablecido — se envió el mensaje de reanudación automática',
  'slack.stalled': '⚠️ La sesión está detenida — falló la reanudación automática, hay que revisarla',
  'slack.sessionExited': '⏹ Sesión finalizada (exit {code})',
  'slack.inputNeeded': '🙋 Entrada necesaria',
  'slack.inputNeededWith': '🙋 Entrada necesaria — {message}',
  // core/slack/inbound.ts buildChoiceKeys — why a choice reply was in the wrong shape
  'slack.choice.hintPerQuestion': '💡 Responda separando cada pregunta con `/` (ej.: 1,3 / 2)',
  'slack.choice.hintMulti': '💡 Para varias opciones, respóndalas separadas por comas (ej.: 1,3)',
  'slack.pending.charCount': '{key}: {len} caracteres',
  'slack.choice.noShape': 'No se encontraron las opciones pendientes',
  'slack.choice.countMismatch':
    "Hay {expected} preguntas pero {got} respuestas — separe cada pregunta con '/' (ej.: 1,3 / 2)",
  'slack.choice.noNumber': 'No se encontró ningún número',
  'slack.choice.noNumberAt': 'Pregunta {index}: no se encontró ningún número',
  'slack.choice.singleOnly': 'Solo se puede elegir una opción',
  'slack.choice.singleOnlyAt': 'Pregunta {index}: solo se puede elegir una opción',
  'slack.choice.outOfRange': 'No existe la opción {n} (1-{max})',
  'slack.choice.outOfRangeAt': 'Pregunta {index}: no existe la opción {n} (1-{max})',
  // slackInbox.ts — the notice left in the thread when a reply could not be injected
  'slack.inbox.tooLong':
    '⚠️ La respuesta era demasiado larga y no se entregó (máximo {max} caracteres)',
  'slack.inbox.sessionEnded': '⚠️ Esta sesión finalizó, así que no se pudo entregar la entrada',
  'slack.inbox.injectFailed': '⚠️ No se pudo entregar la entrada',
  'slack.limitNoResume': '⛔ Límite alcanzado — sin reanudación automática',
  'slack.limitNoResumeAt': '⛔ Límite alcanzado — sin reanudación automática (se restablece {at})',
  // JobsView.tsx, App.tsx — la barra lateral de Jobs, de solo lectura (la lista de Run/Task de la orquestación)
  'jobs.rail.open': 'Jobs',
  'jobs.empty': 'Aún no se ha iniciado ningún trabajo',
  // Una sesión coordinadora sigue siendo otra forma de que aparezca un trabajo, incluso con el botón
  // "+ Nuevo trabajo" de la barra lateral — esta frase dice ambas cosas en vez de descartar una.
  'jobs.empty.hint': 'Puedes crear uno aquí mismo — los trabajos creados desde una sesión coordinadora también aparecerán aquí',
  'jobs.noProject': 'No hay ningún proyecto abierto',
  'jobs.noProject.hint': 'Abre una sesión y su carpeta pasa a ser el proyecto de esta ventana — desde entonces se pueden crear trabajos aquí',
  // Descripciones emergentes de los ocho glifos de estado (JobIcons.tsx). La barra lateral ya no
  // escribe el estado, así que no están siempre en pantalla: son donde se aprenden los iconos.
  // pending y blocked deben leerse distinto — a la primera la retiene una dependencia, a la otra una persona.
  'jobs.state.pending': 'Aún retenida por una dependencia',
  'jobs.state.ready': 'Lista para empezar',
  'jobs.state.dispatched': 'Un worker está en ello',
  'jobs.state.dispatchedStopped': 'El worker se detuvo',
  'jobs.state.validating': 'La validación está en marcha',
  'jobs.state.reviewing': 'Otro agente la está revisando',
  'jobs.state.completed': 'Terminada',
  'jobs.state.failed': 'Falló',
  'jobs.state.blocked': 'Esperando a una persona',
  'jobs.run.running': 'en curso',
  'jobs.run.delete': 'Eliminar trabajo',
  'jobs.run.deleteBody': 'Se eliminará "{objective}" — junto con {tasks} Task(s) y {events} evento(s), y no se puede deshacer.\n\nLos worktrees y las ramas que creó este trabajo no se tocan (puedes borrarlos desde el panel de worktrees del explorador).',
  'jobs.run.deleteBusy': 'Hay un worker corriendo en este trabajo, así que no se puede eliminar — deténlo primero',
  'jobs.run.deleteFailed': 'No se pudo eliminar el trabajo',
  'jobs.run.sharedFolder': 'carpeta compartida',
  'jobs.run.sharedFolderHint': 'Corre en la misma carpeta que el worker de otro trabajo — sus ediciones pueden mezclarse, y la app ni lo impide ni lo detecta',
  'jobs.run.scheduled': 'Programado',
  'jobs.run.scheduleNext': 'siguiente {time}',
  'jobs.run.scheduleRuns': '{count} ejecuciones',
  'jobs.run.scheduleEmpty': 'En espera',
  'jobs.gates.more': '+{count} más',
  // RunDetail.tsx, panel inferior — la lista de eventos. La insignia la elige el tipo de evento (o el tipo
  // de mensaje). Los nombres jobs.timeline.* se mantienen: ese panel es la línea de tiempo, y
  // jobs.detail.open lo usa la barra lateral (JobsView.tsx) para abrir la ventana — esa ventana ahora
  // también contiene el grafo de dependencias, por eso es "Detalles" y no "Historial". Los textos de la
  // ventana en sí son los jobs.detail.* de abajo
  'jobs.detail.open': 'Detalles',
  'jobs.timeline.empty': 'Aún no ha ocurrido nada',
  'jobs.timeline.close': 'Cerrar',
  'jobs.timeline.openSession': 'Abrir sesión',
  'jobs.timeline.retry': 'reintento',
  'jobs.event.runCreated': 'trabajo iniciado',
  'jobs.event.taskCreated': 'Task añadida',
  'jobs.event.dispatchStarted': 'worker iniciado',
  'jobs.event.gateOpened': 'esperando decisión',
  'jobs.event.gateResolved': 'decidido',
  'jobs.event.status': 'estado',
  'jobs.event.workerDone': 'informe del worker',
  'jobs.event.question': 'pregunta',
  'jobs.event.escalation': 'escalación',
  'jobs.event.heartbeat': 'latido',
  'jobs.event.decisionGate': 'decisión',
  // Mismo lugar que retry (junto al resumen de dispatch-started), solo cuando el Dispatch es de revisión (Dispatch.review)
  'jobs.event.review': 'revisión',
  // El resultado de worker_done — no jobs.state.completed/failed, que etiquetan una Task (y una Task
  // puede tener varios informes de worker)
  'jobs.event.succeeded': 'correcto',
  'jobs.event.outcomeFailed': 'fallido',
  // RunDetail.tsx — los textos de la ventana de detalle: el grafo de arriba y el filtro que abre
  'jobs.detail.cycle': 'Sus dependencias se apuntan entre sí, así que no hay orden que dibujar — estas Tasks nunca empezarán',
  'jobs.detail.hidden': '{count} eventos de otras Tasks — pulsa el nodo otra vez para quitar el filtro',
  'jobs.detail.clearFilter': 'Quitar filtro',
  'jobs.detail.edgeWaiting': 'dependencia pendiente',
  'jobs.detail.edgeResolved': 'dependencia ya resuelta',
  // NewRunModal.tsx — el formulario que abre el botón "+ Nuevo trabajo" de la barra lateral.
  // jobs.new.concurrency es un límite por Run, no del proyecto entero: cuántos workers mantiene
  // abiertos a la vez este Run en concreto, distinto de cualquier otro ajuste de concurrencia.
  'jobs.new.open': 'Nuevo trabajo',
  'jobs.new.title': 'Crear un trabajo',
  'jobs.new.objective': 'Objetivo',
  'jobs.new.provider': 'Agente',
  'jobs.new.concurrency': 'En paralelo',
  'jobs.new.concurrencyHint': 'Cuántos workers mantiene abiertos a la vez',
  'jobs.new.schedule': 'Ejecución programada',
  'jobs.new.scheduleHint': 'Inicia una ejecución de este trabajo en cada hora programada',
  'jobs.new.scheduleOverlapHint': 'Se inicia una nueva ejecución aunque la anterior siga en curso — los trabajadores pueden solaparse',
  'jobs.new.create': 'Crear',
  'jobs.new.folderBusy': 'Ya hay un worker trabajando en esta carpeta — con límite 1 el worker de este trabajo también corre ahí, así que sus ediciones pueden mezclarse',
  'jobs.new.failed': 'No se pudo crear el trabajo',
  'jobs.gate.noAccount': 'Ninguna cuenta de {provider} tiene la sesión iniciada, así que esta Task no puede empezar',
  'jobs.gate.assignedAccountUnusable': 'La cuenta asignada a esta Task no se puede usar — no tiene la sesión iniciada, fue eliminada o pertenece a otro agente',
  // NewTaskModal.tsx — el formulario en el que se convierte el panel inferior de RunDetail
  // (.detail-events) mientras se está creando una Task. deps pertenece al grafo, no a este formulario
  // (el grafo es donde se eligen las dependencias) — por eso este catálogo solo tiene el texto que
  // apunta al grafo, no los valores de deps en sí.
  'jobs.task.new': 'Añadir tarea',
  'jobs.task.title': 'Título',
  'jobs.task.spec': 'Instrucciones',
  'jobs.task.deps': 'Depende de',
  'jobs.task.depsHint': 'Empieza cuando todas las Task elegidas terminen',
  'jobs.task.depsAdd': 'Elegir una Task',
  'jobs.task.account': 'Cuenta',
  'jobs.task.accountDefault': 'Cuenta por defecto',
  'jobs.task.accountHint': 'La cuenta en la que esta Task levanta su worker — la cuenta por defecto si no eliges',
  'jobs.task.accountTrust': 'La primera vez que esta cuenta abre esta carpeta, la pestaña de sesión pide confirmar que confías en ella — el worker no empieza hasta que respondas',
  'jobs.task.validate': 'Configuración que prueba que terminó',
  'jobs.task.validateNone': 'Sin validación',
  'jobs.task.review': 'Revisión por otro agente',
  'jobs.task.create': 'Añadir',
  'jobs.task.failed': 'No se pudo crear la tarea',
  'jobs.node.start': 'Iniciar',
  'jobs.node.stop': 'Detener',
  'jobs.node.restart': 'Iniciar de nuevo',
  'jobs.node.gate': 'Bloquear',
  'jobs.node.answer': 'Desbloquear',
  'jobs.node.answerLabel': 'Decisión',
  'jobs.node.gateQuestion': 'Por qué queda en espera',
  'jobs.node.failed': 'No se pudo completar esta acción'
}

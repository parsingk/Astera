import type { Catalog } from '../index'

/** Spanish. Partial by design — see ja.ts for why. */
export const es: Catalog = {
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
    'No se pudo actualizar desde el remoto; se creó a partir del {baseRef} local',
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
    'La sesión «{title}» está en ejecución y usa este worktree. Cierre antes la sesión.',
  'worktree.inUse.run':
    'El proceso «{name}» está en ejecución y usa este worktree. Deténgalo antes.',
  'worktree.inUse.unknown': 'Este worktree está en uso.',
  // ROLL_MIXED_PROVIDER in sessions/manager.ts — a session-rolling constraint unrelated to worktrees
  'session.roll.mixedProvider': 'La rotación no puede mezclar cuentas de Claude y de Codex',
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
  'files.undo.changedOne': '«{name}» ha cambiado',
  'files.undo.changedMany': '{shown}{more} han cambiado',
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
  'account.detect.button': 'Detección automática',
  'account.detect.empty': 'No se detectaron cuentas',
  'account.detect.importSelected': 'Registrar selección',
  'account.detect.failed': 'Falló la detección automática: {detail}',
  'account.status.loggedIn': 'Sesión iniciada',
  'account.status.notLoggedIn': 'Sesión no iniciada',
  // AccountPanel.tsx — unregister. When logout comes with it, it says the credentials are removed (destructive).
  'account.remove.title': 'Anular el registro de la cuenta',
  'account.remove.button': 'Anular registro',
  'account.remove.confirm': '¿Anular el registro de la cuenta «{label}»?',
  'account.remove.logoutToo': 'Cerrar sesión también (elimina la autenticación)',
  'account.remove.logoutWarning':
    'Al cerrar sesión se elimina la autenticación de esta cuenta y tendrá que volver a iniciar sesión. Si la cuenta usa un directorio de inicio (~/.claude, ~/.codex), también se cerrará la sesión que utilizaba fuera de esta aplicación.',
  'account.remove.processing': 'Procesando…',
  'account.remove.confirmWithLogout': 'Anular registro y cerrar sesión',
  'account.logout.failed': 'Error al cerrar sesión: {detail}\n\nLa anulación del registro continúa igualmente.',
  // The Message key accountLogout in core.ts returns
  'account.error.raw': '{detail}',
  'account.error.logoutFailed': 'Error al cerrar sesión',
  // AccountPanel.tsx — default-account settings sync. A destructive action that overwrites the target account's settings.
  'account.sync.title': 'Importar la configuración de la cuenta predeterminada',
  'account.sync.confirmBody':
    'Se importará la configuración de la cuenta «{source}» a la cuenta «{label}».',
  'account.sync.mergeNote':
    'Los complementos, MCP y las habilidades, comandos y agentes personales se combinan elemento por elemento. Los elementos coincidentes toman el valor del origen y los que solo tiene esta cuenta se conservan.',
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
  // SessionTabs.tsx
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
    'Copia la transcripción a esta cuenta y luego reanuda (la transcripción original se conserva).',
  'session.resume.rollChainHint': 'Al llegar al límite, cambia en este orden: {chain}',
  'session.resume.confirm': 'Reanudar',
  // TerminalView.tsx — the rolling banner and the loading/exit overlays
  'session.terminal.rollSwitching': 'Continuando con «{label}»…',
  'session.terminal.trustAccepting': 'Aceptando automáticamente la confianza de la carpeta…',
  'session.terminal.weeklyLimitWaiting': 'Límite semanal agotado — se reanudará a las {time}',
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
  // HistoryBrowser.tsx — account filter labels
  'session.resume.originAccount': 'Cuenta original',
  'session.resume.originDeleted': 'Cuenta eliminada',
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
    'git ya no rastrea {name}, así que no se puede saber si hay cambios sin confirmar.\n{path}\nSi fuerza la eliminación, se perderá el contenido de la carpeta. Ábrala usted mismo para comprobarlo antes de continuar.',
  'worktree.forceRemove.dirtyBody':
    '{name} tiene {count} cambios sin confirmar.\nSi fuerza la eliminación, se perderán esos cambios. ¿Continuar?',
  'worktree.forceRemove.confirm': 'Forzar eliminación',
  // WorktreePanel.tsx — panel header, row icon buttons
  'worktree.refresh': 'Actualizar',
  'worktree.action.startSession': 'Nueva sesión',
  'worktree.action.openExplorer': 'Explorador'
}

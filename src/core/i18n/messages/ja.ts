import type { Catalog } from '../index'

/** Japanese. Partial by design: a key that is not here falls back to English, then to Korean, so a new
 *  string can ship before its translation does. */
export const ja: Catalog = {
  // files/ops.ts — the Message keys validateName/canMove/canCopy return
  'files.validate.badChar': '名前に使用できない文字が含まれています: {char}',
  'files.validate.empty': '名前を入力してください',
  'files.validate.reserved': '使用できない名前です',
  'files.validate.separator': '名前にパス区切り文字は使用できません',
  'files.validate.windowsReserved': 'Windows で予約されている名前です',
  'files.validate.trailing': '名前を空白やピリオドで終えることはできません',
  'files.validate.tooLong': '名前が長すぎます',
  'files.move.intoSelf': 'フォルダを自分自身の中へ移動することはできません',
  'files.move.alreadyThere': 'すでにその場所にあります',
  'files.copy.intoSelf': 'フォルダを自分自身の中へコピーすることはできません',
  'files.error.pathNotAllowed': '許可されていないパスです',
  'files.error.alreadyExists': '「{name}」はすでに存在します',
  'files.error.alreadyExistsInDest': '「{name}」は移動先フォルダにすでに存在します',
  'files.error.renameStranded':
    '名前の変更に失敗し、元に戻すこともできませんでした。ファイルは「{tmp}」にあります',
  // worktrees/include.ts, worktrees/create.ts — worktree creation warnings
  'worktree.include.tooManyEntries':
    '.worktreeinclude の項目が {max} 件を超えたため、以降の行は無視しました',
  'worktree.include.globUnsupported': 'glob・否定パターンは未対応です: {line}',
  'worktree.include.absolutePath': '絶対パスは使用できません: {line}',
  'worktree.include.parentPath': '親パス (..) は使用できません: {line}',
  'worktree.include.gitDir': '.git 配下は使用できません: {line}',
  'worktree.include.fileTooLarge': '.worktreeinclude が {max} バイトを超えたため無視しました',
  'worktree.include.missing': '存在しないためスキップしました: {entry}',
  'worktree.include.notIgnored': 'gitignore されていないためスキップしました: {entry}',
  'worktree.include.sizeFailed': '容量の計算に失敗しました: {entry} ({detail})',
  'worktree.include.overLimit': 'コピー上限 (200MB) を超えたためスキップしました: {entry}',
  'worktree.include.copyFailed': 'コピーに失敗しました: {entry} ({detail})',
  'worktree.create.fetchFailed':
    'リモートの更新に失敗したため、ローカルの {baseRef} を基準に作成しました',
  'worktree.create.baseRecordFailed':
    'branch.base の記録に失敗しました — 削除時のマージ判定が HEAD 基準になります',
  'worktree.create.autoSetupRemoteFailed':
    'push.autoSetupRemote の設定に失敗しました — 最初の push に -u が必要です',
  // worktreeErrors.ts — worktree IPC error code → user-facing message
  'worktree.error.notGitRepo': '選択したフォルダは git リポジトリではありません。',
  'worktree.error.noBase':
    '既定ブランチ (origin/HEAD・main・master) が見つからないため worktree を作成できません。',
  'worktree.error.fetchFailed':
    'リモートから既定ブランチを取得できませんでした。ネットワークを確認してください。',
  'worktree.error.nameExhausted':
    '同じ名前の worktree・ブランチが多すぎます。別の名前を指定してください。',
  'worktree.error.invalidName': '名前に使用できる文字がありません。',
  'worktree.error.notManaged': 'このアプリが作成した worktree ではないため削除できません。',
  'worktree.error.dangerousPath': '安全でないパスのため削除を拒否しました。',
  'worktree.error.dirty': 'コミットされていない変更があるため削除しませんでした。',
  'worktree.error.orphanUnproven':
    '所有権を確認できないため削除しませんでした。手動で確認してから削除してください。',
  'worktree.error.orphanUnverifiable':
    'git がこのフォルダを追跡していないため、未コミットの変更の有無を確認できません。',
  'worktree.error.gitAddFailed': 'git worktree の作成に失敗しました。',
  'worktree.error.gitRemoveFailed': 'git worktree の削除に失敗しました。',
  'worktree.error.raw': '{detail}',
  'worktree.inUse.session':
    '実行中のセッション「{title}」がこの worktree を使用中です。先にセッションを閉じてください。',
  'worktree.inUse.run':
    '実行中のプロセス「{name}」がこの worktree を使用中です。先に実行を停止してください。',
  'worktree.inUse.unknown': 'この worktree は使用中です。',
  // ROLL_MIXED_PROVIDER in sessions/manager.ts — a session-rolling constraint unrelated to worktrees
  'session.roll.mixedProvider': 'Claude と Codex のアカウントを混在させてローリングはできません',
  // App.tsx — rail, session spawn failure, placeholder, status bar usage
  'session.rail.toggleSidebar': 'サイドバーの折りたたみ/展開',
  'session.spawn.failed': 'セッションの開始に失敗しました: {message}',
  'session.spawn.failedWorktreeKept':
    'セッションの開始に失敗しました: {message} (worktree "{name}" は残っているので Worktrees パネルから削除してください)',
  // Rolling-resume guard hit — tells the user the tab was just focused and their chosen options were dropped
  'session.spawn.resumeLiveIgnored':
    'すでに実行中のセッションです — 選択したオプションは適用されませんでした。',
  'session.placeholder.start': '+ 新しいセッションを開始してください',
  'session.usage.contextTitleWithTokens': 'コンテキスト使用率 ({used} / {window} トークン)',
  'session.usage.contextTitle': 'コンテキスト使用率',
  'session.usage.contextEmpty': 'コンテキスト使用量 (最初のターン以降に表示)',
  'session.usage.fiveHourLabel': '5時間使用量',
  'session.usage.fiveHourTitle': '5時間セッション使用量',
  'session.usage.weekly': '週間使用量',
  'session.statusbar.count': 'セッション {count}',
  'session.statusbar.none': 'セッションなし',
  'session.statusbar.accountCount': 'アカウント {count}',
  // App.tsx — file editor buffer state, save, conflict, close confirmation
  'files.editor.binaryUnsupported': 'バイナリファイルは表示できません。',
  'files.save.failed': '保存に失敗しました: {detail}',
  'files.reload.failed': '再読み込みに失敗しました: {detail}',
  'files.unsaved.title': '保存していない変更',
  'files.unsaved.bodyWithTitle': 'ファイル「{title}」に保存していない変更があります。閉じますか？',
  'files.unsaved.body': '保存していない変更があります。閉じますか？',
  'files.editor.deletedExternally': 'ファイルが削除されました',
  'files.editor.readOnlyReason': '読み取り専用 (大きなファイルまたはバイナリ)',
  'files.editor.conflictChanged': 'ディスク上で変更されました',
  'files.editor.reload': '再読み込み',
  'files.editor.keepMine': '自分の編集を保持',
  'files.editor.loading': '読み込み中…',
  'files.editor.selectPrompt': 'ツリーからファイルを選択してください',
  // useFileOps.ts, FileExplorer.tsx — file-operation action names
  'files.action.delete': '削除',
  'files.action.duplicate': '複製',
  'files.action.move': '移動',
  'files.action.copy': 'コピー',
  'files.action.create': '作成',
  'files.action.rename': '名前の変更',
  // useFileOps.ts — runBatch partial-failure aggregation
  'files.batch.partialFail': '{label} {total} 件中 {failed} 件が失敗しました: {shown}{more}',
  'files.batch.moreCount': ' ほか {count} 件',
  // useFileOps.ts — inline edit (create/rename) failure
  'files.commit.failed': '{action}に失敗しました: {detail}',
  // useFileOps.ts — delete confirmation modal
  'files.delete.undoHint':
    'Ctrl+Z または Local History から復元できます (最大30日間保管 · 50MB を超える項目は除く)。',
  'files.delete.confirmOne': '「{name}」を削除しますか？\n{undoHint}',
  'files.delete.confirmDirWithCount':
    'フォルダ「{name}」と配下の {count} 件の項目を削除しますか？\n{undoHint}',
  'files.delete.confirmDirAll': 'フォルダ「{name}」と配下の項目をすべて削除しますか？\n{undoHint}',
  'files.delete.confirmMany': '{shown}{more} — {total} 件の項目を削除しますか？{dirNote}\n{undoHint}',
  'files.delete.dirNote': ' フォルダ {count} 件の配下の項目も一緒に削除されます。',
  'files.delete.moreNames': ' ほか {count} 件',
  'files.delete.skippedTooLarge': '項目が大きすぎるため Local History に残しませんでした',
  'files.delete.skippedFailed':
    'Local History のスナップショットに失敗しました — 削除は完了しています',
  // useFileOps.ts — cut/copy and paste
  'files.clipboard.cutDone': '{count} 件の項目を切り取りました',
  'files.clipboard.copyDone': '{count} 件の項目をコピーしました',
  'files.paste.blocked': '貼り付けできません: {reason}',
  'files.paste.invalidTarget': '対象が正しくありません',
  'files.paste.empty': '貼り付ける項目がありません',
  'files.transfer.movedTo': '{count} 件の項目を「{dest}」に移動しました',
  'files.transfer.copiedTo': '{count} 件の項目を「{dest}」にコピーしました',
  'files.transfer.skipped': '{count} 件の項目はスキップしました: {reason}',
  // useFileOps.ts — Ctrl+Z undo
  'files.undo.empty': '元に戻せる操作がありません',
  'files.undo.changedOne': '「{name}」が変更されました',
  'files.undo.changedMany': '{shown}{more} が変更されました',
  'files.undo.blocked': '{desc}を元に戻せません: {detail}',
  'files.undo.partialFail': '元に戻す {attempted} 件中 {failed} 件が失敗しました: {shown}{more}',
  'files.undo.partialMissing': '元に戻す {total} 件中 {missing} 件が失敗しました: {shown}{more}',
  'files.undo.permanentTooLarge':
    '元に戻す操作で完全に削除されました — 容量が大きく Local History に残していないため復元できません',
  'files.undo.permanentSnapshotFailed':
    '元に戻す操作で削除されました — Local History のスナップショットに失敗したため復元できません',
  'files.undo.done': '{desc}を元に戻しました',
  // undo.ts — the Message keys describe/describeRestored return
  'files.undo.desc.createdOne': '「{name}」の作成',
  'files.undo.desc.createdMany': '{count} 件の項目の作成',
  'files.undo.desc.copiedOne': '「{name}」のコピー',
  'files.undo.desc.copiedMany': '{count} 件の項目のコピー',
  'files.undo.desc.renamed': '「{from}」→「{to}」の名前変更',
  'files.undo.desc.movedOne': '「{name}」の移動',
  'files.undo.desc.movedMany': '{count} 件の項目の移動',
  'files.undo.desc.deletedOne': '「{name}」の削除',
  'files.undo.desc.deletedMany': '{count} 件の項目の削除',
  'files.undo.restored.one': '「{name}」の削除を元に戻しました',
  'files.undo.restored.many': '{count} 件の項目の削除を元に戻しました',
  'files.undo.restored.renamedOne':
    '「{name}」の削除を元に戻しました — 同名の項目があるため別のパスに復元しました: {to}',
  'files.undo.restored.renamedMany':
    '{count} 件の項目の削除を元に戻しました — {renamedCount} 件は同名の項目があるため別の名前で復元しました: {shown}',
  'files.undo.restored.renamedManyWithMore':
    '{count} 件の項目の削除を元に戻しました — {renamedCount} 件は同名の項目があるため別の名前で復元しました: {shown} ほか {moreCount} 件',
  // AccountPanel.tsx — account register, import, detect, logout, settings sync
  'account.field.kind': '種類',
  'account.field.label': 'ラベル',
  'account.panel.title': 'アカウント',
  'account.panel.empty': 'アカウントを追加してください',
  'account.add.title': 'アカウントを追加',
  'account.add.button': '追加',
  'account.add.adding': '追加中…',
  'account.add.labelPlaceholder': '例: 会社アカウント',
  'account.add.copySettingsLabel': '既定のアカウントから設定を取り込む',
  'account.add.loginHintClaude': 'ログインはセッションのターミナルで /login から行います。',
  'account.add.loginHintCodex':
    'ログインはセッションのターミナルで codex のログイン案内に従って行います。',
  'account.add.syncFailed': 'アカウントは追加されましたが、設定の取り込みに失敗しました: {detail}',
  'account.import.title': 'アカウントの取り込み',
  'account.import.button': '取り込む',
  'account.import.someFailed': '{count} 件のアカウントの登録に失敗しました。',
  'account.detect.title': '検出されたアカウント',
  'account.detect.button': '自動検出',
  'account.detect.empty': '検出されたアカウントはありません',
  'account.detect.importSelected': '選択項目を登録',
  'account.detect.failed': '自動検出に失敗しました: {detail}',
  'account.status.loggedIn': 'ログイン済み',
  'account.status.notLoggedIn': '未ログイン',
  // AccountPanel.tsx — unregister. When logout comes with it, it says the credentials are removed (destructive).
  'account.remove.title': 'アカウントの登録解除',
  'account.remove.button': '登録解除',
  'account.remove.confirm': '「{label}」アカウントの登録を解除しますか？',
  'account.remove.logoutToo': 'ログアウトも実行 (認証情報を削除)',
  'account.remove.logoutWarning':
    'ログアウトするとこのアカウントの認証情報が削除され、再度ログインが必要になります。ホームディレクトリ (~/.claude, ~/.codex) を使うアカウントの場合、このアプリの外で使っていたログインも一緒に解除されます。',
  'account.remove.processing': '処理中…',
  'account.remove.confirmWithLogout': '解除 + ログアウト',
  'account.logout.failed': 'ログアウトに失敗しました: {detail}\n\n登録解除はこのまま続行します。',
  // The Message key accountLogout in core.ts returns
  'account.error.raw': '{detail}',
  'account.error.logoutFailed': 'ログアウトに失敗しました',
  // AccountPanel.tsx — default-account settings sync. A destructive action that overwrites the target account's settings.
  'account.sync.title': '既定アカウントの設定を取り込む',
  'account.sync.confirmBody':
    '「{source}」アカウントの設定を「{label}」アカウントへ取り込みます。',
  'account.sync.mergeNote':
    'プラグイン・MCP・個人のスキル/コマンド/エージェントを項目単位でマージします。同じ項目は取り込み元の値で上書きし、このアカウントにしかない項目は残ります。',
  'account.sync.replaceNote':
    'config.toml ファイルが取り込み元のものでまるごと置き換えられます。このアカウントにしかなかった設定は失われ、既存のファイルは .bak としてバックアップします。',
  'account.sync.appliesNextSession':
    '実行中のセッションには適用されず、次のセッションから反映されます。',
  'account.sync.confirm': '取り込む',
  'account.sync.confirming': '取り込み中…',
  'account.sync.done': '設定を取り込みました。',
  'account.sync.failed': '取り込みに失敗しました: {detail}',
  // The Message keys accountSyncSettings in core.ts returns
  'account.sync.isDefaultSource':
    'このアカウントは既定アカウントであり設定の取り込み元です。取り込み先にはできません。',
  'account.sync.noDefault': 'この CLI にログイン済みのアカウントがないため、取り込み元がありません。',
  'account.sync.nothingToCopy': '取り込む設定がありません (取り込み元アカウントに設定ファイルなし)。',
  // AccountSelect.tsx
  'account.select.none': '(未選択)',
  // NewSessionDialog.tsx — the new-session modal
  'session.new.title': '新しいセッション',
  'session.new.runningWarning':
    '実行中のセッションが {count} 件あります。パフォーマンスが低下する可能性があります。',
  'session.new.codexMissingPre': 'Codex CLI が見つかりません。',
  'session.new.claudeMissingPre': 'Claude Code CLI が見つかりません。',
  'session.new.cliMissingPost': 'インストール後に再試行してください。',
  'session.field.projectFolder': 'プロジェクトフォルダ',
  'session.field.account': 'アカウント',
  'session.new.folderNotSelected': '(未選択)',
  'session.new.pickFolder': '選択…',
  'session.new.useWorktree': 'worktree に分離して開始',
  'session.new.worktreeNoBase':
    'このリポジトリには基準にできるブランチがないため worktree を作成できません。コミットを1つ作成してから再試行してください。',
  'session.new.worktreeBaseRef': '基準ブランチ',
  'session.new.worktreeBaseCurrent': '(現在のブランチ)',
  'session.new.worktreeBaseRemote': 'リモート',
  'session.new.worktreeBaseLocal': 'ローカル',
  'session.new.worktreeNamePlaceholder': 'worktree 名 (空欄なら自動)',
  'session.new.accountSlotPrimary': 'アカウント 1',
  'session.new.accountSlotRoll': 'アカウント {slot} (上限到達時に切り替え)',
  'session.new.removeAccountSlot': 'アカウントを削除',
  'session.new.addAccountSlot': '+ アカウントを追加',
  // NewSessionDialog.tsx — rolling, bypass permissions. Both spell out a risk, so keep the strength.
  'session.new.rollLabel': '上限到達時はリセットまで待って自動再開',
  'session.new.multiAccountAuto': '(複数アカウント: 自動)',
  'session.new.rollPromptPlaceholder': '続けて作業を進めて',
  'session.new.rollPromptHint': '再開時にこの文言を送信 (空欄なら既定値)',
  'session.new.slackNotify': 'Slack 進捗通知',
  'session.new.slackNeedsWebhook': '(設定で Webhook URL の登録が必要)',
  'session.new.saveDefaultAccount': 'このプロジェクトでこのアカウントを記憶',
  'session.new.bypassPermissions': '権限確認なしで実行 (bypass permissions)',
  'session.new.start': '開始',
  'session.new.starting': 'セッションを開始しています…',
  'session.new.startingWorktree': 'worktree を作成しています…',
  // NewSessionDialog.tsx scheduler UI
  'session.new.schedLabel': 'スケジューラー — 定期的にコマンドを自動実行',
  'session.new.schedMode.interval': 'N分ごと',
  'session.new.schedMode.daily': '毎日',
  'session.new.schedMode.weekly': '毎週',
  'session.new.schedMode.monthly': '毎月',
  'session.new.schedMinutesUnit': '分ごと',
  'session.new.schedDaysUnit': '日',
  'session.new.schedCommandPlaceholder': '実行するコマンド (必須)',
  'session.new.schedHint': '指定した周期でこのコマンドをセッションに送信',
  // Weekday button labels. Index 0 = Sunday (matches the Date.getDay() convention)
  'session.sched.weekday.sun': '日',
  'session.sched.weekday.mon': '月',
  'session.sched.weekday.tue': '火',
  'session.sched.weekday.wed': '水',
  'session.sched.weekday.thu': '木',
  'session.sched.weekday.fri': '金',
  'session.sched.weekday.sat': '土',
  // SessionTabs.tsx
  'session.tab.rollTooltip': 'ローリング: {chain}',
  // PaneGrid / pane context menu
  'session.pane.splitRight': '右に分割',
  'session.pane.splitDown': '下に分割',
  'session.pane.unsplit': '分割を解除',
  'session.pane.maxReached': 'パネルは最大4つまで分割できます',
  // ResumeDialog.tsx
  'session.resume.title': 'セッションを再開',
  'session.resume.conversationLabel': '会話',
  'session.resume.checkingLogin': 'ログイン済みアカウントを確認中…',
  'session.resume.noLoggedInAccounts':
    'ログイン済みのアカウントがありません。先にアカウントにログインしてください。',
  'session.resume.originalAccountSuffix': ' (元のアカウント)',
  'session.resume.crossAccountHint':
    'トランスクリプトをこのアカウントにコピーしてから再開します (元のトランスクリプトは保持されます)。',
  'session.resume.rollChainHint': '上限到達時はこの順で切り替えます: {chain}',
  'session.resume.confirm': '再開',
  // TerminalView.tsx — the rolling banner and the loading/exit overlays
  'session.terminal.rollSwitching': '「{label}」に引き継いでいます…',
  'session.terminal.trustAccepting': 'フォルダの信頼を自動承認しています…',
  'session.terminal.weeklyLimitWaiting': '週間上限に到達 — {time} に自動再開',
  'session.terminal.limitWaiting': '上限に到達 — {time} に自動再開',
  // Auto-resume failure toast
  'session.toast.stalled':
    'セッション「{title}」が停止しています — 自動再開に失敗しました。確認が必要です',
  'session.terminal.loadingContent': '内容を読み込み中…',
  'session.terminal.exited': '終了しました (コード {code})',
  'session.terminal.restart': '再起動',
  // TerminalView.tsx schedule banner
  'session.terminal.schedFallback': 'スケジュール',
  'session.terminal.schedSummary.interval': '{minutes}分ごと',
  'session.terminal.schedSummary.daily': '毎日 {time}',
  'session.terminal.schedSummary.weekly': '毎週 {days} {time}',
  'session.terminal.schedSummary.monthly': '毎月 {days}日 {time}',
  'session.terminal.schedNextRun': ' · 次回実行 {time}',
  'session.terminal.schedDisable': 'オフにする',
  // HistoryBrowser.tsx — the account filter labels
  'session.resume.originAccount': '元のアカウント',
  'session.resume.originDeleted': '削除されたアカウント',
  // WorktreePanel.tsx — status labels
  'worktree.status.orphanDir': 'git 登録が消失',
  'worktree.status.missing': 'フォルダなし',
  // WorktreePanel.tsx — delete confirmation modal, result toasts
  'worktree.remove.title': 'worktree の削除',
  'worktree.remove.body':
    '{name} ({branch})\n{path}\n\nこの worktree を削除しますか？ フォルダとブランチを一緒に削除します。マージされていないブランチはコミットを失わないよう残します。',
  'worktree.remove.branchPreserved': 'ブランチ {branch} はマージされていないため残しました',
  'worktree.remove.done': 'worktree を削除しました',
  'worktree.remove.alreadyGone': '{name} はすでに削除されていたため一覧から整理しました',
  // Shown on the row while deleting
  'worktree.remove.removing': '削除中…',
  // WorktreePanel.tsx — force-delete second confirmation
  'worktree.forceRemove.unverifiableTitle': '変更の有無を確認できません',
  'worktree.forceRemove.dirtyTitle': 'コミットされていない変更',
  'worktree.forceRemove.unverifiableBody':
    '{name} は git がもう追跡していないため、未コミットの変更の有無を確認できません。\n{path}\n強制削除するとフォルダの内容が失われます。フォルダを直接開いて確認してから進めてください。',
  'worktree.forceRemove.dirtyBody':
    '{name} にコミットされていない変更が {count} 件あります。\n強制削除すると変更内容が失われます。続行しますか？',
  'worktree.forceRemove.confirm': '強制削除',
  // WorktreePanel.tsx — panel header, row icon buttons
  'worktree.refresh': '更新',
  'worktree.action.startSession': 'セッションを開始',
  'worktree.action.openExplorer': 'エクスプローラー'
}

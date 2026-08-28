// Korean catalog — this file is the source. A key added here must be added to en.ts too for
// typecheck to pass (en's type is tied to this object's key set).
// Key rule: <domain>.<context>.<name> — the domains are settings/files/explorer/worktree/
// account/session/history/run/rolling/common.
export const ko = {
  'settings.title': '설정',
  'settings.tab.general': '일반',
  'settings.tab.appearance': '모양',
  'settings.tab.accounts': '계정',
  'settings.tab.info': '정보',
  'settings.tab.shortcuts': '단축키',
  'settings.tab.history': '히스토리',
  'settings.general.language': '언어',
  // {lang} is the language the OS locale resolves to, shown so the effect of picking System is
  // visible before picking it
  'settings.general.language.system': '시스템 설정 ({lang})',
  'settings.general.language.saveFailed': '언어 설정을 저장하지 못했습니다: {detail}',
  // Agent orchestration
  'settings.orchestration.label': '에이전트 오케스트레이션 (실험)',
  'settings.orchestration.hint':
    '켜면 앱이 띄운 에이전트 세션이 다른 벤더의 워커 세션을 띄울 수 있습니다. ' +
    '에이전트가 앱의 어느 계정으로든 세션을 만들 수 있게 되므로 필요할 때만 켜세요. ' +
    '이미 열려 있는 세션에는 적용되지 않습니다 — 새 세션부터 동작합니다. ' +
    '오케스트레이터로 쓸 세션에서 astera help 를 실행하게 하면 전체 사용법을 얻습니다.',
  'settings.orchestration.saveFailed': '오케스트레이션 설정을 저장하지 못했습니다: {detail}',
  'settings.accounts.hint':
    '⤓ 는 같은 CLI의 기본 계정에서 설정을 가져옵니다. 기본 계정은 로그인된 계정 중 가장 먼저 등록된 것으로, CLI마다 하나씩 있습니다.',
  'common.cancel': '취소',
  'common.confirm': '확인',
  'common.close': '닫기',
  'common.toastDismiss': '알림 닫기',
  // A key with interpolation — added so a test pins t()'s placeholder substitution.
  // validateName uses this key as-is (the FORBIDDEN check in files/ops.ts).
  'files.validate.badChar': '이름에 쓸 수 없는 문자가 있습니다: {char}',
  // files/ops.ts — the Message keys validateName/canMove/canCopy return
  'files.validate.empty': '이름을 입력하세요',
  'files.validate.reserved': '사용할 수 없는 이름입니다',
  'files.validate.separator': '이름에 경로 구분자를 쓸 수 없습니다',
  'files.validate.windowsReserved': 'Windows에서 예약된 이름입니다',
  'files.validate.trailing': '이름은 공백이나 마침표로 끝날 수 없습니다',
  'files.validate.tooLong': '이름이 너무 깁니다',
  'files.move.intoSelf': '폴더를 자기 자신 안으로 옮길 수 없습니다',
  'files.move.alreadyThere': '이미 그 위치에 있습니다',
  'files.copy.intoSelf': '폴더를 자기 자신 안으로 복사할 수 없습니다',
  'files.error.pathNotAllowed': '허용되지 않은 경로입니다',
  'files.error.unsupportedImageType': '지원하지 않는 이미지 형식입니다',
  'files.error.imageTooLarge': '이미지가 너무 큽니다',
  'files.error.alreadyExists': "'{name}' 이(가) 이미 있습니다",
  'files.error.alreadyExistsInDest': "'{name}' 이(가) 대상 폴더에 이미 있습니다",
  'files.error.renameStranded': "이름 변경에 실패했고 되돌리지도 못했습니다. 파일이 '{tmp}' 에 있습니다",
  // worktrees/include.ts, worktrees/create.ts — worktree creation warnings
  'worktree.include.tooManyEntries': '.worktreeinclude 항목이 {max}개를 넘어 이후 줄은 무시했습니다',
  'worktree.include.globUnsupported': 'glob·부정 패턴 미지원: {line}',
  'worktree.include.absolutePath': '절대 경로 불가: {line}',
  'worktree.include.parentPath': '상위 경로(..) 불가: {line}',
  'worktree.include.gitDir': '.git 하위 불가: {line}',
  'worktree.include.fileTooLarge': '.worktreeinclude가 {max}바이트를 넘어 무시했습니다',
  'worktree.include.missing': '존재하지 않아 건너뜀: {entry}',
  'worktree.include.notIgnored': 'gitignore되지 않아 건너뜀: {entry}',
  'worktree.include.sizeFailed': '용량 계산 실패: {entry} ({detail})',
  'worktree.include.overLimit': '복사 상한(200MB) 초과로 건너뜀: {entry}',
  'worktree.include.copyFailed': '복사 실패: {entry} ({detail})',
  'worktree.create.fetchFailed': '원격 갱신에 실패해 로컬에 있는 {baseRef} 기준으로 생성했습니다',
  'worktree.create.baseRecordFailed': 'branch.base 기록 실패 — 삭제 시 머지 판정이 HEAD 기준이 됩니다',
  'worktree.create.autoSetupRemoteFailed': 'push.autoSetupRemote 설정 실패 — 첫 push에 -u가 필요합니다',
  // worktreeErrors.ts — worktree IPC error code → user-facing message
  'worktree.error.notGitRepo': '선택한 폴더가 git 저장소가 아닙니다.',
  'worktree.error.noBase': '기본 브랜치(origin/HEAD·main·master)를 찾을 수 없어 worktree를 만들 수 없습니다.',
  'worktree.error.fetchFailed': '원격에서 기본 브랜치를 가져오지 못했습니다. 네트워크를 확인하세요.',
  'worktree.error.nameExhausted': '같은 이름의 worktree·브랜치가 너무 많습니다. 다른 이름을 지정하세요.',
  'worktree.error.invalidName': '이름에 사용할 수 있는 문자가 없습니다.',
  'worktree.error.notManaged': '이 앱이 만든 worktree가 아니라 삭제할 수 없습니다.',
  'worktree.error.dangerousPath': '안전하지 않은 경로라 삭제를 거부했습니다.',
  'worktree.error.dirty': '커밋되지 않은 변경 사항이 있어 삭제하지 않았습니다.',
  'worktree.error.orphanUnproven': '소유권을 확인할 수 없어 삭제하지 않았습니다. 수동으로 확인 후 삭제하세요.',
  'worktree.error.orphanUnverifiable': 'git이 이 폴더를 추적하지 않아 미커밋 변경 여부를 확인할 수 없습니다.',
  'worktree.error.gitAddFailed': 'git worktree 생성에 실패했습니다.',
  'worktree.error.gitRemoveFailed': 'git worktree 제거에 실패했습니다.',
  'worktree.error.raw': '{detail}',
  'worktree.inUse.session': "실행 중 세션 '{title}'이(가) 이 worktree를 사용 중입니다. 세션을 먼저 닫으세요.",
  'worktree.inUse.run': "실행 중 프로세스 '{name}'이(가) 이 worktree를 사용 중입니다. 실행을 먼저 중지하세요.",
  'worktree.inUse.unknown': '이 worktree를 사용 중입니다.',
  // ROLL_MIXED_PROVIDER in sessions/manager.ts — a session-rolling constraint unrelated to worktrees, so it uses
  // session.* rather than worktree.*. The MESSAGES array in worktreeErrors.ts maps to this key
  'session.roll.mixedProvider': 'Claude와 Codex 계정을 섞어 롤링할 수 없습니다',
  // App.tsx — shared window controls, resizer, separator
  'common.minimize': '최소화',
  'common.maximize': '최대화',
  'common.restore': '이전 크기로',
  'common.resizeSidebar': '사이드바 크기 조절',
  'common.or': '또는',
  // App.tsx — Linux에서만 뜨는 창 닫기 확인. 거기서는 트레이로 숨는 대신 앱이 실제로 종료되고
  // will-quit이 실행 중 세션을 모두 죽인다. 업데이트 설치와 같은 결과이므로 같은 동의를 받는다
  'common.quitConfirm.title': '닫고 Astera 종료',
  'common.quitConfirm.body': '창을 닫으면 Astera가 종료되고 진행 중인 세션 {count}개도 함께 종료됩니다. 계속할까요?',
  // index.ts — system tray context menu
  'common.trayOpen': '열기',
  'common.trayQuit': '종료',
  // App.tsx — rail, session spawn failure, placeholder, status bar usage
  'session.rail.toggleSidebar': '사이드바 접기/펼치기',
  'session.spawn.failed': '세션 시작 실패: {message}',
  'session.spawn.failedWorktreeKept':
    '세션 시작 실패: {message} (worktree "{name}"는 남아 있으니 Worktrees 패널에서 삭제하세요)',
  // Rolling-resume guard hit — tells the user the tab was just focused and their chosen options were dropped
  'session.spawn.resumeLiveIgnored': '이미 실행 중인 세션입니다 — 선택한 옵션은 적용되지 않았습니다.',
  'session.placeholder.start': '+ 새 세션으로 시작하세요',
  'session.usage.contextTitleWithTokens': '컨텍스트 사용률 ({used} / {window} 토큰)',
  'session.usage.contextTitle': '컨텍스트 사용률',
  'session.usage.contextEmpty': '컨텍스트 사용량 (첫 턴 이후 표시)',
  'session.usage.fiveHourLabel': '5시간 사용량',
  'session.usage.fiveHourTitle': '5시간 세션 사용량',
  'session.usage.weekly': '주간 사용량',
  'session.statusbar.count': '세션 {count}',
  'session.statusbar.none': '세션 없음',
  'session.statusbar.accountCount': '계정 {count}',
  // App.tsx — file editor buffer state, save, conflict, close confirmation
  'files.editor.binaryUnsupported': '바이너리 파일은 표시할 수 없습니다.',
  'files.save.failed': '저장 실패: {detail}',
  'files.reload.failed': '다시 로드 실패: {detail}',
  'files.unsaved.title': '저장하지 않은 변경',
  'files.unsaved.bodyWithTitle': "'{title}' 파일에 저장하지 않은 변경이 있습니다. 닫을까요?",
  'files.unsaved.body': '저장하지 않은 변경이 있습니다. 닫을까요?',
  'files.editor.deletedExternally': '파일이 삭제되었습니다',
  'files.editor.readOnlyReason': '읽기전용 (큰 파일 또는 바이너리)',
  'files.editor.conflictChanged': '디스크에서 변경됨',
  'files.editor.reload': '다시 로드',
  'files.editor.keepMine': '내 편집 유지',
  'files.editor.loading': '불러오는 중…',
  'files.editor.selectPrompt': '트리에서 파일을 선택하세요',
  // MarkdownPreview.tsx — 이미지 로드 실패·원격 이미지 안내
  'files.markdown.image.failed': '이미지를 열 수 없습니다',
  'files.markdown.renderError': '이 문서를 표시할 수 없습니다',
  // MarkdownSplit.tsx — 모드 툴바 버튼 세 개, 좌우 분할 리사이저
  'files.markdown.mode.editor': '편집기만',
  'files.markdown.mode.split': '편집기와 프리뷰',
  'files.markdown.mode.preview': '프리뷰만',
  'files.markdown.resizeSplit': '분할 크기 조절',
  // App.tsx — explorer close confirmation
  'explorer.closeConfirm.body': '저장하지 않은 변경이 있습니다. 탐색기를 닫을까요?',
  // App.tsx — run console resizer, start failure
  'run.resizeConsole': '콘솔 크기 조절',
  'run.start.failed': '실행 실패: {detail}',
  'run.jump.notAllowed': '그 프로젝트로 갈 수 없습니다 — 앱에서 한 번 열어 본 프로젝트여야 합니다',
  // App.tsx — settings modal Info/Slack/Worktree tabs, CLI-not-found screen
  'settings.info.appName': '앱 이름',
  'settings.info.version': '버전',
  'settings.info.registeredAccounts': '등록 계정',
  'settings.info.update': '업데이트',
  'settings.info.cliNotDetected': '감지 안 됨',
  'settings.slack.save': '저장',
  'settings.slack.saved': '저장됨',
  'settings.slack.saveFailed': 'Slack 설정을 저장하지 못했습니다: {detail}',
  'settings.slack.hint': '새 세션에서 “Slack 진행상황 알림”을 켜면 진행 상황을 보냅니다.',
  // Bot settings. Which delivery path is active has to be visible on screen at a glance —
  // a bot token with no channel ID silently falls back to Webhook (slack.ts applyConfig), so that state has to show
  'settings.slack.botSection': '봇 (세션별 스레드)',
  'settings.slack.channelIdHint': '채널 우클릭 → 채널 세부정보 맨 아래에서 확인할 수 있습니다.',
  'settings.slack.appTokenHint': 'Socket Mode 수신용입니다. 봇 모드일 때 스레드 답장을 이 토큰으로 받습니다.',
  // 채널만으로는 권한 경계가 되지 않는다 — 채널에 초대된 사람은 누구나 남의 세션에 입력을 밀어넣을 수 있다.
  // 그래서 이 값과 일치하는 사람의 답장만 주입한다. 비어 있으면 전원 허용이 아니라 전원 차단이다.
  'settings.slack.memberIdHint':
    '이 멤버의 스레드 답장만 세션에 전달합니다. Slack에서 내 프로필 → ⋯ → “멤버 ID 복사”로 확인하세요.',
  'settings.slack.memberIdRequired':
    '⚠️ Member ID가 없어 스레드 답장이 아무에게서도 전달되지 않습니다. 본인 Member ID를 입력하세요.',
  'settings.slack.modeBot': '봇 모드 — 세션마다 스레드 하나에 알림이 모입니다.',
  'settings.slack.modeWebhook': 'Webhook 단방향 — 봇 토큰과 채널 ID를 함께 채우면 세션별 스레드로 바뀝니다.',
  'settings.slack.modeOff': '전송 경로가 없어 알림이 나가지 않습니다. Webhook URL 또는 봇 토큰+채널 ID가 필요합니다.',
  'settings.slack.setupGuide': '봇을 대상 채널에 초대해야 게시됩니다. 자세한 절차는 docs/slack-bot-setup.md 참고.',
  'settings.worktree.createLocation': 'worktree 생성 위치',
  'settings.worktree.change': '변경…',
  'settings.worktree.hint':
    '새 worktree가 이 폴더 아래 <repo명>/<이름>으로 생성됩니다. 기존 worktree는 이동하지 않습니다.',
  'settings.history.hiddenProjects': '숨긴 프로젝트',
  'settings.history.unhide': '해제',
  'settings.history.empty': '숨긴 프로젝트가 없습니다.',
  // 목록이 한 페이지를 넘길 때만 붙는 검색·페이지 이동. 전체 개수는 검색으로 걸러도 그대로 둔다 —
  // 검색 결과만 보이면 몇 개를 숨겨 뒀는지 알 길이 없다
  'settings.history.search': '경로 검색…',
  'settings.history.noMatch': '검색과 일치하는 항목이 없습니다.',
  'settings.history.total': '전체 {count}개',
  'settings.history.prevPage': '이전 페이지',
  'settings.history.nextPage': '다음 페이지',
  // 기록 삭제 — 되돌릴 수 없는 쪽이라 무엇이 남는지까지 문구에 적는다
  'settings.history.selectAll': '전체 선택',
  'settings.history.deleteSelected': '기록 삭제 ({count})',
  'settings.history.deleteTitle': '선택한 프로젝트의 기록을 지울까요?',
  'settings.history.deleteBody':
    '대화 기록 {count}개를 휴지통으로 보냅니다. 프로젝트 폴더와 그 안의 파일은 지우지 않습니다.\n\n{list}',
  'settings.history.deleteConfirm': '휴지통으로 보내기',
  'settings.history.deleteDone': '기록 {count}개를 휴지통으로 보냈습니다.',
  'settings.history.deleteBusy': '{name} 이(가) 실행 중이라 {count}개를 건너뛰었습니다.',
  'settings.history.deleteFailed': '{count}개는 지우지 못했습니다.',
  // ThemeSettings.tsx — the theme card grid
  'settings.theme.label': '테마',
  'settings.theme.hint': '색과 모서리, 서체가 함께 바뀝니다. 터미널 폰트는 아래에서 따로 고릅니다.',
  'settings.theme.saveFailed': '테마 저장 실패: {detail}',
  // ResumeStrategySettings.tsx — the two-way resume strategy picker
  'settings.resumeStrategy.label': '세션 재개 방식',
  'settings.resumeStrategy.smart.label': '스마트 재개 (실험)',
  'settings.resumeStrategy.smart.hint': '간결한 체크포인트만으로 대화를 이어갑니다.',
  'settings.resumeStrategy.original.label': '원래 세션 재개',
  'settings.resumeStrategy.original.hint': '기존 Resume 방식으로 대화를 이어갑니다.',
  'settings.resumeStrategy.saveFailed': '재개 방식을 저장하지 못했습니다: {detail}',
  // TerminalFontSettings.tsx — the terminal font picker rows
  'settings.font.latin': '터미널 영문 폰트',
  'settings.font.hangul': '터미널 한글 폰트',
  'settings.font.system': '시스템 기본',
  'settings.font.notInstalled': '설치되지 않음',
  'settings.font.sample': 'AaBb 한글 123',
  'settings.font.hangulShadowed':
    '선택한 영문 폰트가 한글도 그리기 때문에 한글 폰트 설정은 적용되지 않습니다.',
  'settings.font.listFailed': '설치된 폰트 목록을 가져오지 못했습니다: {detail}',
  'settings.font.saveFailed': '폰트 설정을 저장하지 못했습니다: {detail}',
  'settings.font.checkingHangul': '설치된 폰트 확인 중…',
  'settings.font.loadingList': '설치된 폰트 읽는 중…',
  // No settings.cliMissing.* here on purpose. That screen replaces the whole workbench, so the rail
  // and the language switch on it are gone — it is hardcoded English in App.tsx instead.
  // App.tsx — update status (the title-bar UpdateIndicator / the settings Info tab)
  'update.tb.restartInstallVersion': '재시작하여 v{version} 설치',
  'update.tb.checking': '업데이트 확인 중…',
  'update.tb.available': '새 버전 {version} 발견',
  'update.tb.downloading': '다운로드 중 {percent}%',
  'update.tb.error': '업데이트 오류',
  // index.ts — diagnostic message for when the electron-updater module does not export properly (title-bar tooltip)
  'update.tb.autoUpdaterMissing': 'autoUpdater export를 찾지 못함',
  'update.info.downloading': '다운로드 중 {percent}%…',
  'update.info.restartInstallVersion': '재시작하여 v{version} 설치',
  'update.info.checking': '확인 중…',
  'update.info.checkButton': '업데이트 확인',
  'update.info.upToDateAt': '현재 최신 버전입니다 ({time} 확인)',
  // 'available' means "found", not "downloading" — the download announces itself through the
  // 'downloading' state, which has wording of its own.
  'update.info.available': '새 버전 {version} 있음',
  'update.info.downloadVersion': '{version} 다운로드',
  'update.info.checkFailed': '확인 실패',
  // App.tsx — the toast for a downloaded new version, and the session-kill confirmation when installing now
  'update.toast.available': '새 버전 v{version}이 나왔습니다',
  'update.toast.download': '다운로드',
  'update.toast.ready': '업데이트 v{version} 준비됨',
  'update.toast.installNow': '지금 설치',
  'update.confirm.title': '지금 설치하고 재시작',
  'update.confirm.body': '진행 중인 세션 {count}개가 종료됩니다. 계속할까요?',
  // UpdateGate.tsx — the screen that covers the app when the version is below the minimum the release policy sets
  'update.gate.title': '업데이트가 필요합니다',
  'update.gate.body': '{version} 버전으로 업데이트를 진행해주세요',
  'update.gate.bodyNoVersion': '업데이트를 진행해주세요',
  'update.gate.preparing': '업데이트를 준비하고 있습니다…',
  'update.gate.ready': 'v{version} 설치 준비 완료',
  'update.gate.failed': '업데이트를 받지 못했습니다. 네트워크를 확인하고 다시 시도하세요.',
  'update.gate.retry': '다시 시도',
  'update.gate.quit': '앱 종료',
  // App.tsx — settings modal Shortcuts tab (the SHORTCUTS array; a module-level constant, so translated at render time)
  'shortcut.group.terminal': '터미널',
  'shortcut.terminal.newline': '줄바꿈',
  'shortcut.terminal.copyOrInterrupt': '선택 복사 · 없으면 중단',
  'shortcut.paste': '붙여넣기',
  'shortcut.group.sessionTab': '세션 탭',
  'shortcut.sessionTab.prev': '이전 탭',
  'shortcut.sessionTab.next': '다음 탭',
  'shortcut.gesture.tabDrag': '탭 드래그',
  'shortcut.sessionTab.reorder': '순서 변경',
  'shortcut.group.pane': '패널',
  'shortcut.pane.splitRight': '우측 분할',
  'shortcut.pane.splitDown': '하단 분할',
  'shortcut.pane.focusLeft': '왼쪽 패널',
  'shortcut.pane.focusRight': '오른쪽 패널',
  'shortcut.pane.focusUp': '위 패널',
  'shortcut.pane.focusDown': '아래 패널',
  // ShortcutSettings.tsx — the editable shortcut list
  'shortcut.group.editable': '변경 가능',
  'shortcut.edit': '변경',
  'shortcut.resetOne': '기본값',
  'shortcut.capturing': '키를 누르세요 (Esc 취소)',
  'shortcut.unbound': '없음',
  'shortcut.conflictWith': '{key}는 이미 "{action}"에 쓰입니다',
  'shortcut.riskTitle': '{key}를 앱 단축키로 지정',
  'shortcut.riskConfirm': '그래도 지정',
  'shortcut.risk.interrupt': '터미널에서 실행 중인 작업을 중단하는 키입니다. 앱이 가져가면 세션에서 중단할 수 없습니다.',
  'shortcut.risk.eof': '터미널에서 CLI를 종료하는 키입니다. 앱이 가져가면 세션에서 쓸 수 없습니다.',
  'shortcut.risk.readline': '터미널 줄 편집에 쓰이는 키입니다(줄 처음·끝 이동, 단어 삭제 등). 앱이 가져가면 프롬프트 입력 중에 쓸 수 없습니다.',
  'shortcut.risk.historySearch': '터미널 히스토리 검색에 쓰이는 키입니다. 앱이 가져가면 세션에서 쓸 수 없습니다.',
  'shortcut.risk.clear': '터미널 화면을 지우는 키입니다. 앱이 가져가면 세션에서 쓸 수 없습니다.',
  'shortcut.risk.newline': 'Codex에서 줄바꿈에 쓰이는 키입니다. 앱이 가져가면 여러 줄 입력이 막힙니다.',
  'shortcut.risk.cliMode': 'Claude Code·Codex가 모드 전환·자동완성에 쓰는 키입니다. 앱이 가져가면 세션에서 쓸 수 없습니다.',
  'shortcut.pane.dragSplit': '가장자리로 분할 · 가운데로 이동',
  'shortcut.group.explorer': '파일 탐색기',
  'shortcut.explorer.toggleMode': '탐색기 보이기/숨기기',
  'shortcut.explorer.saveFile': '파일 저장',
  'shortcut.explorer.closeFileTab': '파일 탭 닫기',
  'shortcut.explorer.cyclePreview': '마크다운 프리뷰 모드 전환',
  'shortcut.explorer.rename': '이름 변경',
  'shortcut.explorer.delete': '삭제',
  'shortcut.explorer.selectAll': '전체 선택',
  'shortcut.explorer.cut': '잘라내기',
  'shortcut.explorer.copy': '복사',
  'shortcut.gesture.itemDrag': '항목 드래그',
  'shortcut.explorer.move': '이동 · Ctrl 누르면 복사',
  'shortcut.explorer.undo': '되돌리기',
  // useFileOps.ts, FileExplorer.tsx — file-operation action names (shared by the runBatch label and the menu labels)
  'files.action.delete': '삭제',
  'files.action.duplicate': '복제',
  'files.action.move': '이동',
  'files.action.copy': '복사',
  'files.action.create': '생성',
  'files.action.rename': '이름 변경',
  // useFileOps.ts — runBatch partial-failure aggregation
  'files.batch.partialFail': '{label} {total}개 중 {failed}개 실패: {shown}{more}',
  'files.batch.moreCount': ' 외 {count}건',
  // useFileOps.ts — inline edit (create/rename) failure
  'files.commit.failed': '{action} 실패: {detail}',
  // useFileOps.ts — delete confirmation modal. The undoHint wording is settled —
  // the "up to" and "over 50MB excluded" specifics have to stay (no over-promising; see the undoHint declaration comment).
  'files.delete.undoHint':
    'Ctrl+Z 또는 Local History에서 복구할 수 있습니다 (최대 30일 보관 · 50MB 초과 항목은 제외).',
  'files.delete.confirmOne': "'{name}' 을(를) 삭제할까요?\n{undoHint}",
  'files.delete.confirmDirWithCount': "'{name}' 폴더와 하위 {count}개 항목을 삭제할까요?\n{undoHint}",
  'files.delete.confirmDirAll': "'{name}' 폴더와 하위 항목 전부를 삭제할까요?\n{undoHint}",
  'files.delete.confirmMany': '{shown}{more} — {total}개 항목을 삭제할까요?{dirNote}\n{undoHint}',
  'files.delete.dirNote': ' 폴더 {count}개의 하위 항목이 함께 삭제됩니다.',
  'files.delete.moreNames': ' 외 {count}개',
  'files.delete.skippedTooLarge': '항목이 너무 커서 Local History에 남기지 않았습니다',
  'files.delete.skippedFailed': 'Local History 스냅샷에 실패했습니다 — 삭제는 완료됐습니다',
  // useFileOps.ts — cut/copy and paste
  'files.clipboard.cutDone': '{count}개 항목을 잘라냈습니다',
  'files.clipboard.copyDone': '{count}개 항목을 복사했습니다',
  'files.paste.blocked': '붙여넣기 불가: {reason}',
  'files.paste.invalidTarget': '대상이 올바르지 않습니다',
  'files.paste.empty': '붙여넣을 항목이 없습니다',
  'files.transfer.movedTo': "{count}개 항목을 '{dest}' 에 이동했습니다",
  'files.transfer.copiedTo': "{count}개 항목을 '{dest}' 에 복사했습니다",
  'files.transfer.skipped': '{count}개 항목은 건너뜀: {reason}',
  // useFileOps.ts — Ctrl+Z undo
  'files.undo.empty': '되돌릴 조작이 없습니다',
  'files.undo.changedOne': "'{name}' 이(가) 변경되었습니다",
  'files.undo.changedMany': '{shown}{more} 이(가) 변경되었습니다',
  'files.undo.blocked': '{desc} 되돌리기 불가: {detail}',
  'files.undo.partialFail': '되돌리기 {attempted}개 중 {failed}개 실패: {shown}{more}',
  'files.undo.partialMissing': '되돌리기 {total}개 중 {missing}개 실패: {shown}{more}',
  'files.undo.permanentTooLarge':
    '되돌리기로 영구 삭제됐습니다 — 용량이 커 Local History에 남기지 않아 복구할 수 없습니다',
  'files.undo.permanentSnapshotFailed':
    '되돌리기로 지워졌습니다 — Local History 스냅샷에 실패해 복구할 수 없습니다',
  'files.undo.done': '{desc} 되돌렸습니다',
  // undo.ts — the Message keys describe/describeRestored return. undo.ts is a pure core
  // module and cannot call t(), so it builds keys only, not finished sentences. Plurals get their own keys (the rule).
  'files.undo.desc.createdOne': "'{name}' 생성",
  'files.undo.desc.createdMany': '{count}개 항목 생성',
  'files.undo.desc.copiedOne': "'{name}' 복사",
  'files.undo.desc.copiedMany': '{count}개 항목 복사',
  'files.undo.desc.renamed': "'{from}' → '{to}' 이름 변경",
  'files.undo.desc.movedOne': "'{name}' 이동",
  'files.undo.desc.movedMany': '{count}개 항목 이동',
  'files.undo.desc.deletedOne': "'{name}' 삭제",
  'files.undo.desc.deletedMany': '{count}개 항목 삭제',
  'files.undo.restored.one': "'{name}' 삭제 되돌렸습니다",
  'files.undo.restored.many': '{count}개 항목 삭제 되돌렸습니다',
  'files.undo.restored.renamedOne': "'{name}' 삭제 되돌림 — 같은 이름이 있어 다른 경로로 복구됨: {to}",
  'files.undo.restored.renamedMany':
    '{count}개 항목 삭제 되돌림 — {renamedCount}개는 같은 이름이 있어 다른 이름으로 복구됨: {shown}',
  'files.undo.restored.renamedManyWithMore':
    '{count}개 항목 삭제 되돌림 — {renamedCount}개는 같은 이름이 있어 다른 이름으로 복구됨: {shown} 외 {moreCount}건',
  // FileExplorer.tsx — panel header, context menu
  'explorer.title': '탐색기',
  'explorer.noActiveSession': '활성 세션이 없습니다',
  // Folder state shown inside the tree (the .fx-note row)
  'explorer.dir.loading': '불러오는 중…',
  'explorer.dir.readFailed': '읽기 실패: {detail}',
  'explorer.dir.empty': '비어 있음',
  'explorer.refresh': '새로고침',
  'explorer.reveal.failed': '탐색기 열기 실패: {detail}',
  'explorer.menu.newFile': '새 파일',
  'explorer.menu.newFolder': '새 폴더',
  'explorer.menu.rename': '이름 변경 (F2)',
  'explorer.menu.delete': '삭제 (Del)',
  'explorer.menu.deleteCount': '삭제 ({count}개, Del)',
  'explorer.menu.duplicateCount': '복제 ({count}개)',
  'explorer.menu.cut': '잘라내기 (Ctrl+X)',
  'explorer.menu.copy': '복사 (Ctrl+C)',
  'explorer.menu.paste': '붙여넣기 (Ctrl+V)',
  'explorer.menu.copyPath': '경로 복사',
  'explorer.menu.copyRelativePath': '상대 경로 복사',
  'explorer.menu.reveal': '탐색기에서 열기',
  // FileExplorer.tsx — git status on a tree row (tooltip, aria-label)
  'explorer.git.new': '새 파일',
  'explorer.git.modified': '수정됨',
  'explorer.git.deleted': '삭제됨',
  'explorer.git.conflict': '충돌',
  'explorer.git.folderCount': '변경 {count}건',
  'explorer.rail.toggle': '파일 탐색기',
  // WorkbenchTabs.tsx — the dirty marker on a file tab
  'explorer.tab.unsaved': '저장 안 됨',
  // LocalHistoryDialog.tsx — the Local History browse/restore modal
  // ('Local History' is treated as a proper noun and left untranslated — following the existing catalog precedent)
  'localHistory.loading': '불러오는 중…',
  'localHistory.empty': '삭제 이력이 없습니다',
  'localHistory.restore': '복구',
  'localHistory.restoring': '복구 중…',
  'localHistory.restored': '복구됨: {path}',
  'localHistory.restoreFailed': '복구 실패: {detail}',
  'localHistory.listFailed': '이력 조회 실패: {detail}',
  // The error store.ts (core, which does not know the language) throws with the LOCAL_HISTORY_NOT_FOUND code — main
  // (localHistory.restore in ipc.ts) inspects the code and rethrows it translated through this key (the layering rule)
  'localHistory.notFound': '이력 항목을 찾을 수 없습니다',
  // AccountPanel.tsx — account register, import, detect, logout, settings sync
  'account.field.kind': '종류',
  'account.field.label': '라벨',
  'account.panel.title': '계정',
  'account.panel.empty': '계정을 추가하세요',
  'account.add.title': '계정 추가',
  'account.add.button': '추가',
  'account.add.adding': '추가 중…',
  'account.add.labelPlaceholder': '예: 회사 계정',
  'account.add.copySettingsLabel': '기본 계정에서 설정 가져오기',
  'account.add.loginHintClaude': '로그인은 세션 터미널에서 /login으로 진행합니다.',
  'account.add.loginHintCodex': '로그인은 세션 터미널에서 codex 로그인 안내에 따라 진행합니다.',
  'account.add.syncFailed': '계정은 추가됐지만 설정 가져오기에 실패했습니다: {detail}',
  'account.import.title': '계정 가져오기',
  'account.import.button': '가져오기',
  'account.import.someFailed': '{count}개 계정 등록에 실패했습니다.',
  'account.detect.title': '감지된 계정',
  'account.detect.button': '자동 감지',
  'account.detect.empty': '감지된 계정이 없습니다',
  'account.detect.importSelected': '선택 등록',
  'account.detect.failed': '자동 감지 실패: {detail}',
  'account.status.loggedIn': '로그인됨',
  'account.status.notLoggedIn': '미로그인',
  // AccountPanel.tsx — unregister. When logout comes with it, it says the credentials are removed (destructive).
  'account.remove.title': '계정 등록 해제',
  'account.remove.button': '등록 해제',
  'account.remove.confirm': '‘{label}’ 계정 등록을 해제하시겠습니까?',
  'account.remove.logoutToo': '로그아웃까지 진행 (인증 제거)',
  'account.remove.logoutWarning':
    '로그아웃하면 이 계정의 인증이 제거되어 다시 로그인해야 합니다. 홈 디렉토리(~/.claude, ~/.codex)를 쓰는 계정이면 이 앱 밖에서 쓰던 로그인도 함께 해제됩니다.',
  'account.remove.processing': '처리 중…',
  'account.remove.confirmWithLogout': '해제 + 로그아웃',
  'account.logout.failed': '로그아웃 실패: {detail}\n\n등록 해제는 계속 진행합니다.',
  'account.remove.inUse': '돌아가는 세션이 이 계정을 쓰고 있어 등록을 해제할 수 없습니다: {titles}\n\n세션을 닫거나, 그 세션의 롤링 순서에서 이 계정을 빼 주세요.',
  // The Message key accountLogout in core.ts returns. account.logout.failed (above) is the outer template that
  // slots this value into {detail}, so the two cannot share a name — it was split into the
  // account.error.* namespace, alongside account.error.raw.
  'account.error.raw': '{detail}',
  'account.error.logoutFailed': '로그아웃 실패',
  // AccountPanel.tsx — default-account settings sync. A destructive action that overwrites the target account's settings.
  'account.sync.title': '기본 계정 설정 가져오기',
  'account.sync.confirmBody': '‘{source}’ 계정의 설정을 ‘{label}’ 계정으로 가져옵니다.',
  // The two CLIs copy differently and the wording has to say so — claude merges per key, codex has
  // everything in one config.toml and there is no TOML parser here, so that file is replaced outright.
  'account.sync.mergeNote':
    '플러그인·MCP·개인 스킬/커맨드/에이전트를 항목 단위로 합칩니다. 같은 항목은 원본 값으로 덮어쓰고, 이 계정에만 있는 항목은 남습니다.',
  'account.sync.replaceNote':
    'config.toml 파일이 원본으로 통째 대체됩니다. 이 계정에만 있던 설정은 사라지며, 기존 파일은 .bak으로 백업합니다.',
  'account.sync.appliesNextSession': '실행 중인 세션에는 적용되지 않고 다음 세션부터 반영됩니다.',
  'account.sync.confirm': '가져오기',
  'account.sync.confirming': '가져오는 중…',
  'account.sync.done': '설정을 가져왔습니다.',
  'account.sync.failed': '가져오기 실패: {detail}',
  // The Message keys accountSyncSettings in core.ts returns
  'account.sync.isDefaultSource': '이 계정이 기본 계정이라 설정의 원본입니다. 가져올 대상이 아닙니다.',
  'account.sync.noDefault': '이 CLI에 로그인된 계정이 없어 가져올 원본이 없습니다.',
  'account.sync.nothingToCopy': '가져올 설정이 없습니다 (원본 계정에 설정 파일 없음).',
  // AccountSelect.tsx
  'account.select.none': '(선택 안 됨)',
  // NewSessionDialog.tsx — the new-session modal
  'session.new.title': '새 세션',
  'session.new.runningWarning': '실행 중 세션이 {count}개입니다. 성능 저하가 있을 수 있습니다.',
  // Either CLI alone is enough to open the app, so the missing one can be either — the wording is
  // picked per the selected account's provider, and the closing sentence is shared.
  'session.new.codexMissingPre': 'Codex CLI를 찾을 수 없습니다.',
  'session.new.claudeMissingPre': 'Claude Code CLI를 찾을 수 없습니다.',
  'session.new.cliMissingPost': '설치 후 다시 시도하세요.',
  'session.field.projectFolder': '프로젝트 폴더',
  'session.field.account': '계정',
  'session.new.folderNotSelected': '(선택 안 됨)',
  'session.new.pickFolder': '선택…',
  'session.new.useWorktree': 'worktree로 분리해서 시작',
  'session.new.worktreeNoBase': '이 저장소에는 기준으로 삼을 브랜치가 없어 worktree 를 만들 수 없습니다. 커밋을 하나 만든 뒤 다시 시도하세요.',
  'session.new.worktreeBaseRef': '기준 브랜치',
  'session.new.worktreeBaseCurrent': '(현재 브랜치)',
  'session.new.worktreeBaseRemote': '원격',
  'session.new.worktreeBaseLocal': '로컬',
  'session.new.worktreeNamePlaceholder': 'worktree 이름 (비우면 자동)',
  'session.new.accountSlotPrimary': '계정 1',
  'session.new.accountSlotRoll': '계정 {slot} (한도 시 전환)',
  'session.new.removeAccountSlot': '계정 제거',
  'session.new.addAccountSlot': '+ 계정 추가',
  // NewSessionDialog.tsx — rolling, bypass permissions. Both spell out a risk, so keep the strength.
  'session.new.rollLabel': '한도 도달 시 리셋까지 대기 후 자동 재개',
  'session.new.multiAccountAuto': '(다계정: 자동)',
  'session.new.rollPromptPlaceholder': '이어서 작업 진행해 줘',
  'session.new.rollPromptHint': '재개 시 이 문구를 전송 (비우면 기본값)',
  'session.new.slackNotify': 'Slack 진행상황 알림',
  'session.new.slackNeedsWebhook': '(설정에서 Webhook URL 등록 필요)',
  // Nothing to do with the default account above — this only remembers which account this project used,
  // so the next new session preselects it. Named accordingly to stop the two reading as one feature.
  'session.new.saveDefaultAccount': '이 프로젝트에서 이 계정을 기억',
  'session.new.bypassPermissions': '권한 확인 없이 실행 (bypass permissions)',
  'session.new.start': '시작',
  // Waiting text between pressing Start and the tab opening. Splitting off a worktree chains fetch, worktree add and
  // the include copy, taking several seconds, so what is in progress is announced separately.
  'session.new.starting': '세션을 시작하는 중…',
  'session.new.startingWorktree': 'worktree를 만드는 중…',
  // NewSessionDialog.tsx scheduler UI — a merge from main brought in hardcoded text, later moved into this catalog
  'session.new.schedLabel': '스케쥴러 — 주기적으로 명령 자동 실행',
  'session.new.schedMode.interval': 'N분마다',
  'session.new.schedMode.daily': '매일',
  'session.new.schedMode.weekly': '매주',
  'session.new.schedMode.monthly': '매월',
  'session.new.schedMinutesUnit': '분마다',
  'session.new.schedDaysUnit': '일',
  'session.new.schedCommandPlaceholder': '실행할 명령어 (필수)',
  'session.new.schedHint': '지정 주기마다 이 명령을 세션에 전송',
  // Shared by NewSessionDialog.tsx and TerminalView.tsx — weekday button labels, weekday text in the schedule summary.
  // Index 0 = Sunday (matches the Date.getDay() convention)
  'session.sched.weekday.sun': '일',
  'session.sched.weekday.mon': '월',
  'session.sched.weekday.tue': '화',
  'session.sched.weekday.wed': '수',
  'session.sched.weekday.thu': '목',
  'session.sched.weekday.fri': '금',
  'session.sched.weekday.sat': '토',
  // WorkbenchTabs.tsx
  'session.tab.rollTooltip': '롤링: {chain}',
  // PaneGrid / pane context menu
  'session.pane.splitRight': '우측 분할',
  'session.pane.splitDown': '하단 분할',
  'session.pane.unsplit': '분할 해제',
  'session.pane.maxReached': '패널은 최대 4개까지 나눌 수 있습니다',
  // ResumeDialog.tsx
  'session.resume.title': '세션 이어하기',
  'session.resume.conversationLabel': '대화',
  'session.resume.checkingLogin': '로그인 계정 확인 중…',
  'session.resume.noLoggedInAccounts': '로그인된 계정이 없습니다. 계정에 먼저 로그인하세요.',
  'session.resume.originalAccountSuffix': ' (원 계정)',
  'session.resume.crossAccountHint': '전사를 이 계정으로 복사한 뒤 이어갑니다 (원본 전사는 보존).',
  'session.resume.rollChainHint': '한도 도달 시 이 순서로 전환합니다: {chain}',
  'session.resume.confirm': '이어하기',
  // TerminalView.tsx — only the rolling banner and the loading/exit overlays the renderer draws (main's direct PTY
  // writes are separate and handled elsewhere)
  'session.terminal.rollSwitching': "'{label}'(으)로 이어가는 중…",
  'session.terminal.trustAccepting': '폴더 신뢰 자동 수락 중…',
  'session.terminal.weeklyLimitWaiting': '주간 한도 소진 — {time} 자동 재개',
  'session.terminal.limitWaiting': '한도 도달 — {time} 자동 재개',
  // Auto-resume failure toast. See the App.tsx comment for why it is a toast and not a banner —
  // for a rolling session with Slack off, this is the only path that calls a human.
  'session.toast.stalled': "'{title}' 세션이 멈춰 있습니다 — 자동 재개 실패, 확인이 필요합니다",
  'session.terminal.loadingContent': '내용 불러오는 중…',
  'session.terminal.exited': '종료됨 (코드 {code})',
  'session.terminal.restart': '다시 시작',
  // TerminalView.tsx schedule banner — schedRuleSummary is a module-level pure function, so it takes t as an argument
  // (the same convention as fmtTime/fmtDateTime). A merge from main brought in hardcoded text, later moved into this catalog
  'session.terminal.schedFallback': '스케쥴',
  'session.terminal.schedSummary.interval': '{minutes}분마다',
  'session.terminal.schedSummary.daily': '매일 {time}',
  'session.terminal.schedSummary.weekly': '매주 {days} {time}',
  'session.terminal.schedSummary.monthly': '매월 {days}일 {time}',
  'session.terminal.schedNextRun': ' · 다음 실행 {time}',
  'session.terminal.schedDisable': '끄기',
  // HistoryBrowser.tsx
  'history.panel.title': '히스토리',
  'history.panel.empty': '기록 없음',
  'history.loading': '불러오는 중…',
  'history.filter.deletedSuffix': ' (삭제됨)',
  'session.resume.originAccount': '원래 계정',
  'session.resume.originDeleted': '삭제된 계정',
  'history.filter.allAccounts': '모든 계정',
  'history.refresh.tooltip': '워쳐 실패 시 수동 폴백',
  'history.menu.hide': '숨기기',
  'history.project.noSessions': '세션 없음',
  'history.entry.preview': '미리보기',
  'history.entry.resume': '세션 이어하기',
  'history.preview.truncated': '(최근 대화만)',
  'history.preview.me': '나',
  'history.resume.folderMissingTitle': '프로젝트 폴더 없음',
  'history.resume.folderMissingBody':
    '원래 프로젝트 폴더가 없습니다:\n{cwd}\n\n재개할 폴더를 새로 선택할까요?',
  'history.resume.pickFolder': '폴더 선택',
  // WorktreePanel.tsx — status labels (STATUS_LABEL; a module-level constant, so translated at render time)
  'worktree.status.orphanDir': 'git 등록 소실',
  // WorktreePanel.tsx — delete confirmation modal, result toasts
  'worktree.remove.title': 'worktree 삭제',
  'worktree.remove.body':
    '{name} ({branch})\n{path}\n\n이 worktree를 삭제할까요? 폴더와 브랜치를 함께 삭제합니다. 머지되지 않은 브랜치는 커밋을 잃지 않도록 남겨둡니다.',
  'worktree.remove.branchPreserved': '브랜치 {branch}는 머지되지 않아 남겨두었습니다',
  'worktree.remove.done': 'worktree를 삭제했습니다',
  'worktree.remove.alreadyGone': '{name}은(는) 이미 삭제되어 목록에서 정리했습니다',
  // Shown on the row while deleting — git status, folder removal and the merge check (remote fetch) chain up and can pass 10 seconds
  'worktree.remove.removing': '삭제 중…',
  // WorktreePanel.tsx — force-delete second confirmation. When dirtyCount() is null the count is unknown, so it is
  // left out of unverifiableBody — the keys split on whether a count is shown, not on singular/plural.
  'worktree.forceRemove.unverifiableTitle': '변경 여부 확인 불가',
  'worktree.forceRemove.dirtyTitle': '커밋되지 않은 변경',
  'worktree.forceRemove.unverifiableBody':
    '{name}은(는) git이 더 이상 추적하지 않아 미커밋 변경 여부를 확인할 수 없습니다.\n{path}\n강제 삭제하면 폴더 내용이 사라집니다. 폴더를 직접 열어 확인한 뒤 진행하세요.',
  'worktree.forceRemove.dirtyBody':
    '{name}에 커밋되지 않은 변경 {count}개가 있습니다.\n강제 삭제하면 변경 내용이 사라집니다. 계속할까요?',
  'worktree.forceRemove.confirm': '강제 삭제',
  // WorktreePanel.tsx — panel header, row icon buttons
  'worktree.refresh': '새로 고침',
  'worktree.action.startSession': '세션 시작',
  // RunToolbar.tsx — config select, run/stop, the running list, ⋮ menu (only item opens RunConfigManager)
  'run.config.selectLabel': '실행 구성 선택',
  'run.config.none': '실행 구성 없음',
  'run.config.more': '추가 동작',
  'run.action.run': '실행',
  'run.action.stop': '중지',
  'run.global.listTitle': '실행 중 목록',
  'run.global.jump': '이동',
  // 오케스트레이션이 Task 를 판정하려고 띄운 실행이라는 라벨. 사용자가 시작한 실행과 구별되지
  // 않으면 정지시켜 그 Task 를 실패시킨다(core/run/config.ts 의 RunStatus.validation)
  'run.validation.tag': '검증',
  // App.tsx runManagerSave — the text shown when the run.saveConfig IPC fails
  'run.config.saveFailed': '저장 실패: {detail}',
  // main/run/prepare.ts resolveRunCwd (run.start) and ipc.ts assertConfigCwd (run.saveConfig) — a
  // sentence main throws also shows up verbatim in a renderer toast, so it is translated here first (the layering rule)
  'run.config.cwdNotString': '실행 구성의 작업 폴더가 올바르지 않습니다',
  'run.config.cwdOutsideProject': '실행 구성의 작업 폴더는 프로젝트 안이어야 합니다',
  // ipc.ts run.start — 필수 항목이 빈 구성은 저장은 되지만 실행은 거부한다. {fields} 는 아래 run.field.* 라벨이다
  'run.start.incomplete': '실행 구성의 필수 항목이 비어 있습니다: {fields}',
  // RunConfigForm.tsx — name field and the JDK/file pickers shared by every per-kind form.
  // 종류별 필드 라벨은 shell 의 명령까지 모두 아래 run.field.* 에 모여 있다
  'run.form.nameLabel': '이름',
  'run.form.jdkLoading': 'JDK 조회 중…',
  'run.form.jdkNone': '사용 안 함 (앱 환경 그대로)',
  'run.form.jdkCustom': '{path} (직접 지정)',
  'run.form.jdkBrowse': '찾아보기…',
  'run.form.cwdBrowse': '선택…',
  'run.form.fileBrowse': '찾아보기…',
  // Python 인터프리터 Select + 찾기 버튼 (Task 9) — JDK 필드와 같은 모양
  'run.form.interpreterLoading': '인터프리터 조회 중…',
  'run.form.interpreterAuto': '자동 (PATH 의 python)',
  'run.form.interpreterCustom': '{path} (직접 지정)',
  'run.form.interpreterBrowse': '찾아보기…',
  // Compose 파일 찾기 버튼과 services 필드의 후보 힌트 (Task 10)
  'run.form.composeFileBrowse': '찾아보기…',
  'run.form.composeServicesLoading': 'Compose 서비스 조회 중…',
  'run.form.composeServicesHint': '후보: {list}',
  // Dockerfile 경로 찾기 버튼 (Task 11)
  'run.form.dockerfilePathBrowse': '찾아보기…',
  // .NET 프로젝트 파일 Select + 찾기 버튼 (Task 12) — 인터프리터·JDK 필드와 같은 모양이다:
  // 스캐너가 찾은 것을 고르거나, 찾지 못한 파일은 찾기 버튼으로 직접 지정한다
  'run.form.projectLoading': '.NET 프로젝트 조회 중…',
  'run.form.projectCustom': '{path} (직접 지정)',
  'run.form.projectBrowse': '찾아보기…',
  // RunConfigManager.tsx — the two-pane dialog. run.type.* are kind labels grouping the tree;
  // product/tool names among them (npm, Gradle, Maven, cargo, go, Python, pytest) are not translated.
  'run.manager.title': '실행 구성',
  'run.manager.open': '실행 구성 관리…',
  'run.manager.add': '추가',
  'run.manager.remove': '제거',
  'run.manager.duplicate': '복제',
  // 시드를 고치면 그 순간 사용자 구성 사본으로 승격된다(promoteSeed) — 더 이상 읽기 전용이 아니다
  'run.manager.seedHint': '자동 감지된 구성을 수정하면 사용자 구성 사본으로 저장됩니다.',
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
  // RunConfigForm.tsx / RunTypePicker.tsx (Task 7) — per-kind field labels and the ＋ kind-picker popup.
  'run.field.javaHome': 'JDK',
  'run.field.springProfiles': 'Spring 프로파일',
  'run.field.args': '인자',
  'run.field.cwd': '작업 폴더',
  'run.field.env': '환경변수',
  // 종류별 필수 필드. shell 의 command 도 여기 있어야 run.start 의 "빈 필수 항목" 메시지가
  // run.field.<이름> 으로 라벨을 찾을 수 있다 (migrate.ts 의 REQUIRED 에 있는 이름은 모두 여기 있다)
  'run.field.command': '명령',
  'run.field.script': '스크립트',
  'run.field.file': '파일',
  'run.field.tasks': '작업',
  'run.field.goals': '목표',
  'run.field.subcommand': '하위 명령',
  'run.field.packageManager': '패키지 매니저',
  'run.field.packageManagerAuto': '자동',
  'run.field.release': '릴리스 빌드',
  'run.field.features': '기능',
  'run.field.packagePath': '패키지 경로',
  'run.field.nodePath': 'Node 실행 파일',
  // Python(파일 필수)·pytest(대상 선택) 공용 인터프리터 필드와 pytest 전용 대상 필드 (Task 9)
  'run.field.interpreter': '인터프리터',
  'run.field.target': '테스트 대상',
  // Docker Compose 필드 (Task 10) — 모두 선택 항목이다: composeFile 이 비면 문맥이 찾은 파일, services 가
  // 비면 전체 서비스로 실행한다
  'run.field.composeFile': 'Compose 파일',
  'run.field.services': '서비스',
  'run.field.action': '동작',
  // Dockerfile 필드 (Task 11) — imageTag 만 필수, 나머지는 선택
  'run.field.imageTag': '이미지 태그',
  'run.field.dockerfilePath': 'Dockerfile 경로',
  'run.field.buildArgs': '빌드 인자',
  'run.field.runArgs': '실행 인자',
  // .NET 필드 (Task 12) — project(.csproj/.fsproj/.sln) 만 필수다. 앱이 여는 '프로젝트'와 헷갈리지
  // 않도록 '프로젝트 파일'로 적는다. subcommand 는 비면 run 이다
  'run.field.project': '프로젝트 파일',
  'run.field.configuration': '빌드 구성',
  'run.picker.search': '검색…',
  'run.picker.detected': '이 프로젝트에서 감지됨',
  'run.picker.other': '기타',
  'run.form.addOption': '선택 항목 추가',
  // BottomPanel.tsx — the Run tab label in the tab strip (the default for the configName slot when no run is active),
  // clear and collapse buttons. The header RunPanel.tsx used to own moved into BottomPanel; RunPanel.tsx itself remains as the body.
  // noActiveRun was originally that header status text, and BottomPanel's Run tab label has the same value, so it is reused
  // (a separately added terminal.tab.run was an exact duplicate of the value and was cleaned up).
  'run.panel.noActiveRun': '실행',
  'run.panel.exited': ' · 종료(코드 {code})',
  // 종료된 실행에만 붙는 ✕ — 실행 중에는 그리지 않는다(⏹ 로 먼저 정지시킨다)
  'run.panel.close': '실행 탭 닫기',
  'run.panel.clear': '지우기',
  'run.panel.collapse': '접기',
  // BottomPanel, the rail terminal button. The Run tab and the terminal tabs share the bottom panel.
  'terminal.rail.open': '터미널',
  'terminal.tab.label': '터미널 {n}',
  'terminal.tab.new': '새 터미널',
  'terminal.tab.close': '터미널 닫기',
  'terminal.open.failed': '터미널 열기 실패: {detail}',
  // rolling.ts and codexRolling.ts — the default resume prompt main writes straight into the Claude PTY,
  // or passes as a Codex CLI argument, when rolling resumes after a limit. It is also the default for the
  // user's rollPrompt setting (session.new.rollPromptPlaceholder shows this value as its placeholder). It is
  // an instruction sent to a CLI, but it follows the app language by decision.
  'rolling.continuePrompt': '이어서 작업 진행해 줘',
  // slack.ts — the notification text that goes out to Slack. Follows the app language (core.lang at send time).
  'slack.turnDone': '✅ 응답 완료',
  'slack.limitWaiting': '⏸ 한도 도달 — {at} 재개 예정 ({scope} 한도)',
  'slack.limitScope.weekly': '주간',
  'slack.limitScope.session': '5시간',
  'slack.accountSwitched': '🔁 계정 전환 → {label}',
  'slack.limitReset': '▶️ 한도 리셋 — 자동 재개 프롬프트 전송',
  'slack.stalled': '⚠️ 세션이 멈춰 있습니다 — 자동 재개 실패, 확인이 필요합니다',
  'slack.sessionExited': '⏹ 세션 종료 (exit {code})',
  'slack.inputNeeded': '🙋 입력 필요',
  'slack.inputNeededWith': '🙋 입력 필요 — {message}',
  // core/slack/inbound.ts buildChoiceKeys — the reason a choice reply was in the wrong shape.
  // core does not know the language, so it hands back a Message and main (slackInbox) translates it and posts it to the thread.
  // With more than one question, the *At variants that say which question it was are used.
  // core/slack/transcript.ts describePendingToolUse — the reply-format hint attached to the thread notification, and
  // the notation for summarizing a sensitive argument as a character count instead of its value.
  'slack.choice.hintPerQuestion': '💡 질문마다 `/`로 구분해 답장 (예: 1,3 / 2)',
  'slack.choice.hintMulti': '💡 여러 개는 쉼표로 구분해 답장 (예: 1,3)',
  'slack.pending.charCount': '{key}: {len}자',
  'slack.choice.noShape': '대기 중인 선택지 정보를 찾지 못했습니다',
  'slack.choice.countMismatch':
    "질문이 {expected}개인데 답은 {got}개입니다 — 질문마다 '/'로 구분해 주세요 (예: 1,3 / 2)",
  'slack.choice.noNumber': '번호를 찾지 못했습니다',
  'slack.choice.noNumberAt': '{index}번째 질문: 번호를 찾지 못했습니다',
  'slack.choice.singleOnly': '하나만 고를 수 있습니다',
  'slack.choice.singleOnlyAt': '{index}번째 질문: 하나만 고를 수 있습니다',
  'slack.choice.outOfRange': '{n}번은 없습니다 (1~{max})',
  'slack.choice.outOfRangeAt': '{index}번째 질문: {n}번은 없습니다 (1~{max})',
  // slackInbox.ts — the notice left in the thread when a thread reply could not be injected into the session
  'slack.inbox.tooLong': '⚠️ 답장이 너무 길어 전달하지 않았습니다 ({max}자 이하만 가능)',
  'slack.inbox.sessionEnded': '⚠️ 이 세션은 종료되어 입력을 전달하지 못했습니다',
  'slack.inbox.injectFailed': '⚠️ 입력을 전달하지 못했습니다',
  'slack.limitNoResume': '⛔ 한도 도달 — 자동 재개 없음',
  'slack.limitNoResumeAt': '⛔ 한도 도달 — 자동 재개 없음 (리셋 {at})',
  // JobsView.tsx, App.tsx — the read-only Jobs sidebar (오케스트레이션 Run/Task 목록)
  // 'Jobs'는 번역하지 않는다 — '작업'은 이미 Task를 가리키는 말이라, 뷰 이름까지 '작업'이라 하면
  // 그 안의 Task 행들과 이름이 겹친다. catalog.test.ts의 LITERALS가 네 카탈로그 모두에서 그대로
  // 남도록 강제한다.
  'jobs.rail.open': 'Jobs',
  'jobs.empty': '아직 시작한 작업이 없습니다',
  // 사이드바에 '+ 새 작업' 버튼이 생긴 뒤로도 코디네이터 세션은 여전히 작업이 생기는 또 다른 경로다
  // — 이 문장은 둘 중 하나를 지우지 않고 함께 말한다.
  'jobs.empty.hint': '새 작업은 여기서 바로 만들 수 있습니다 — 코디네이터 세션에서 만든 작업도 여기에 나타납니다',
  // 프로젝트가 없을 때의 두 줄. **위 두 문구를 대신한다** — 프로젝트가 없으면 '+ 새 작업'
  // 버튼이 그려지지 않으므로(JobsView 의 hasProject, App.tsx 의 그 주석이 이유를 적었다)
  // jobs.empty.hint 의 '여기서 바로 만들 수 있습니다' 가 거짓이 된다. 무엇을 하면 되는지
  // 적는 자리가 화면에 없으면 사람은 버튼이 사라진 줄 안다
  'jobs.noProject': '열린 프로젝트가 없습니다',
  'jobs.noProject.hint': '세션을 열면 그 폴더가 이 창의 프로젝트가 되고, 그때부터 여기서 작업을 만들 수 있습니다',
  // 여덟 상태의 툴팁 — JobIcons.tsx 의 글리프가 달고 다닌다. 사이드바가 상태를 말로 적지 않게 된
  // 뒤로 이 문구들은 상시로 보이지 않는다: 아이콘을 처음 보는 사람이 배우는 자리다.
  // pending 과 blocked 를 다르게 적는 것이 특히 중요하다 — 앞은 의존이, 뒤는 사람이 막고 있다
  'jobs.state.pending': '아직 막혀 있다',
  'jobs.state.ready': '시작할 수 있다',
  'jobs.state.dispatched': '워커가 일하는 중',
  // dispatched 인데 워커가 없는 상태 — worker-stop 이 세션을 죽이고 Task 는 그대로 둔다.
  // 글리프는 여전히 도는 모양이다(결론이 나지 않았다는 뜻이라 그것은 맞다) — 거짓이 되는 것은
  // 살아 있는 워커를 약속하는 위 문구뿐이라, 그 자리에만 이것을 쓴다
  'jobs.state.dispatchedStopped': '워커가 멈췄다',
  'jobs.state.validating': '검증이 도는 중',
  'jobs.state.reviewing': '다른 에이전트가 검토 중',
  'jobs.state.completed': '끝났다',
  'jobs.state.failed': '실패했다',
  'jobs.state.blocked': '사람을 기다린다',
  'jobs.run.running': '도는 중',
  // 얽힌 Run 의 줄에 붙는 글자와 그 툴팁. Gate 의 주황 `!` 를 빌리지 않는 이유는 뜻이
  // 다르기 때문이다 — 막힌 것이 아니라 나눠 쓰는 중이고, 기다리는 사람이 없다
  // Run 을 물러나게 하기. **자동 정리(store.ts 의 TTL)가 손대지 못하는 것을 위해 있다** — 그것은
  // 모든 Task 가 끝난 Run 만, 그것도 30일 뒤에 버린다. 중단한 작업이나 워커가 죽어 dispatched 에
  // 멈춘 Task 를 가진 Run 은 영원히 남는다
  'jobs.run.start': '실행',
  'jobs.run.pause': '일시 중지',
  'jobs.run.pauseHint': '이 예약을 세웁니다 — 도는 Task 도 함께 멈춥니다',
  'jobs.run.pauseConfirmTitle': '예약 일시 중지',
  'jobs.run.pauseConfirmBody': '현재 작업 중인 모든 task가 중지되며 다시 실행 시 다음 예약 시간부터 실행됩니다.',
  'jobs.run.paused': '일시 중지됨',
  'jobs.run.roundStopped': '중지됨',
  'jobs.run.roundStoppedHint': '예약이 세워져 이 회차는 멈췄습니다 — 다시 실행하면 다음 예약 시각의 새 회차가 돕니다',
  'jobs.run.pauseFailed': '일시 중지하지 못했습니다',
  'jobs.run.pauseRetained': 'worker-retain 으로 붙잡아 둔 세션이 있어 멈출 수 없습니다 — 먼저 놓아 주세요',
  'jobs.run.resume': '다시 실행',
  'jobs.run.resumeHint': '다음 예약 시각부터 다시 돌기 시작합니다',
  'jobs.run.startHint': 'Task 를 다 짠 뒤 누르면 이 작업이 돌기 시작합니다',
  'jobs.run.startFailed': '작업을 시작하지 못했습니다',
  'jobs.run.merge': '병합',
  'jobs.run.mergeHint': '워커가 워크트리에 커밋한 일을 프로젝트 폴더로 합칩니다 (워크트리 {count}개)',
  'jobs.run.merged': '워크트리 {count}개를 프로젝트 폴더로 합쳤습니다',
  'jobs.run.mergeConfirmTitle': '프로젝트 폴더에 병합',
  'jobs.run.mergeConfirmBody': '워커가 워크트리에 커밋한 일을 프로젝트 폴더로 합칩니다 (워크트리 {count}개).\n\n프로젝트 폴더의 현재 브랜치에 커밋으로 추가됩니다.',
  'jobs.run.mergeNothing': '합칠 것이 남아 있지 않습니다 — 워크트리 폴더가 이미 사라졌습니다',
  'jobs.run.mergeUncommitted': '커밋되지 않은 변경 {count}개는 합쳐지지 않았습니다 — 워크트리에 그대로 있고, 폴더를 지우면 사라집니다',
  'jobs.run.mergeFailed': '합치지 못했습니다: {reason}',
  'jobs.run.notStarted': '실행 대기',
  'jobs.run.notStartedHint': '아직 실행하지 않았습니다 — 상세 창에서 실행을 누르면 시작합니다',
  'jobs.run.deleteMerge': '프로젝트 폴더에 병합하기',
  'jobs.run.deleteMergeHint': '워커가 워크트리에 커밋한 일을 지금 합칩니다 (워크트리 {count}개)',
  'jobs.run.deleteHide': '히스토리 목록에서 감추기',
  'jobs.run.deleteWorktrees': '워크트리 폴더 삭제 ({count}개)',
  'jobs.run.deleteWorktreesHint': '병합하지 않고 지우면 합치지 않은 커밋이 함께 사라집니다',
  'jobs.run.delete': '작업 지우기',
  'jobs.run.deleteBody': '"{objective}" 를 지웁니다 — Task {tasks}개와 이벤트 {events}개가 함께 사라지고 되돌릴 수 없습니다.\n\n아직 합쳐지지 않은 워크트리와 브랜치는 지우지 않습니다(합친 것은 병합할 때 이미 지워졌습니다 — 남은 것은 파일 탐색기의 워크트리 패널에서 지울 수 있습니다).',
  'jobs.run.deleteStopsWorkers': '도는 워커 {workers}개를 정지시킵니다. 워크트리에 있고 아직 프로젝트 폴더로 병합되지 않은 작업은 함께 사라집니다.',
  'jobs.run.deleteRetained': 'worker-retain 으로 붙잡아 둔 세션이 있어 지울 수 없습니다 — 먼저 놓아 주세요',
  'jobs.run.deleteBusy': '이 작업에 도는 워커가 있어 지울 수 없습니다 — 먼저 멈춰 주세요',
  'jobs.run.deleteFailed': '작업을 지우지 못했습니다',
  'jobs.run.sharedFolder': '폴더 공유',
  'jobs.run.sharedFolderHint': '다른 작업의 워커와 같은 폴더에서 돌고 있습니다 — 서로의 편집이 섞일 수 있고, 앱은 그것을 막지도 알아채지도 못합니다',
  'jobs.run.scheduled': '예약',
  'jobs.run.scheduleNext': '다음 {time}',
  'jobs.run.scheduleRuns': '{count}회 실행',
  // 회차 줄의 번호. 발화 시점에 찍힌 서수라 기록을 지워도 남은 번호가 바뀌지 않는다
  'jobs.run.scheduleOrdinal': '{n}회차',
  'jobs.run.scheduleEmpty': '대기 중',
  'jobs.run.scheduleMore': '{count}개 더 보기',
  'jobs.run.schedulePending': '실행을 누르면 예약이 시작됩니다',
  'jobs.gates.more': '외 {count}건',
  // RunDetail.tsx 의 아래 칸 — 이벤트 목록. 종류 배지는 이벤트 종류(또는 메시지 종류)가 고른다.
  // Run 을 '작업'이라 부르는 것은 위의 jobs.empty 와 같고, 그 안의 Task 는 'Task' 로 적는다 —
  // 한 목록에 두 층의 사건이 나란히 나오므로 같은 낱말이면 구분되지 않는다.
  // 이름이 timeline 으로 남는 것은 이 칸이 곧 타임라인이기 때문이다. 창을 여는 사이드바의 입구는
  // jobs.detail.open 이다 — 그 창은 이제 기록만이 아니라 의존 그래프도 담으므로 '기록' 이 아니라
  // '자세히' 다. 창 자체의 문구도 jobs.detail.* 이다
  'jobs.detail.open': '자세히',
  'jobs.timeline.empty': '아직 기록이 없습니다',
  'jobs.timeline.close': '닫기',
  'jobs.timeline.openSession': '세션 열기',
  'jobs.timeline.retry': '재시도',
  'jobs.event.runCreated': '작업 시작',
  'jobs.event.taskCreated': 'Task 추가',
  'jobs.event.dispatchStarted': '워커 시작',
  'jobs.event.gateOpened': '결정 대기',
  'jobs.event.gateResolved': '결정 완료',
  'jobs.event.limitHit': '한도 정지',
  'jobs.event.resumed': '워커 재개',
  'jobs.event.status': '소식',
  'jobs.event.workerDone': '워커 보고',
  'jobs.event.question': '질문',
  'jobs.event.escalation': '에스컬레이션',
  'jobs.event.heartbeat': '신호',
  'jobs.event.decisionGate': '결정 요청',
  // retry 와 같은 자리(dispatch-started 의 요약 옆)에, 이 Dispatch 가 검토용(Dispatch.review)일 때만 붙는다
  'jobs.event.review': '검토',
  // worker_done 의 결과. jobs.state.completed/failed 를 쓰지 않는다 — 그 둘은 Task 의 상태를
  // 가리키는 말이고, 한 Task 에는 워커 보고가 여럿 있을 수 있다. 같은 낱말을 두 층에 쓰면 어느
  // 쪽 주장인지 사라진다
  'jobs.event.succeeded': '성공',
  'jobs.event.outcomeFailed': '실패',
  // RunDetail.tsx — 상세 창 자신의 문구. 위의 그래프와 그것이 여는 필터가 쓴다.
  // 순환은 코디네이터의 실수인데 이 화면 말고는 아무도 잡아 주지 않으므로, 한 문장이 왜 그려질 수
  // 없는지와 그래서 그 Task 들이 어떻게 되는지를 함께 말한다
  'jobs.detail.cycle': '의존이 서로를 가리켜 순서를 정할 수 없습니다 — 이 Task 들은 영원히 시작되지 않습니다',
  'jobs.detail.hidden': '다른 Task 의 이벤트 {count}개 — 노드를 다시 눌러 해제',
  'jobs.detail.clearFilter': '필터 해제',
  // 선 색의 뜻. 아이콘과 달리 선에는 툴팁을 달 곳이 없어 그래프 아래에 두 줄로 적는다
  'jobs.detail.edgeWaiting': '기다리는 중인 의존',
  'jobs.detail.edgeResolved': '이미 풀린 의존',
  // NewRunModal.tsx — 사이드바의 '+ 새 작업'이 여는 Run 생성 폼의 문구. jobs.new.concurrency 는
  // 프로젝트 전체가 아니라 이 Run 하나가 동시에 열어 둘 워커 수의 상한이다 — 다른 동시 실행
  // 설정과 자리가 다르므로 섞어 쓰면 안 된다.
  'jobs.new.open': '새 작업',
  'jobs.new.title': '새 작업 만들기',
  'jobs.new.gitRequired': 'git 저장소로 등록된 폴더에서만 실행됩니다',
  'jobs.new.objective': '목표',
  'jobs.new.coordinator': '코디네이터 계정',
  'jobs.new.coordinatorNone': '코디네이터 없이 (앱이 직접 돌림)',
  'jobs.new.coordinatorHint':
    '이 작업을 관리할 에이전트 세션의 계정입니다 — 워커를 띄우고, 워커의 질문에 답하고, 필요할 때 사람을 부릅니다. 비워 두면 앱이 직접 돌리고 워커의 질문은 앱이 고정 답변으로 풀어 줍니다. 둘 이상 고르면 코디네이터가 한도에 걸렸을 때 적은 순서대로 갈아탑니다',
  'jobs.new.concurrency': '동시 실행',
  'jobs.new.concurrencyHint': '이 작업이 한 번에 열어 둘 워커 수',
  'jobs.new.schedule': '예약 실행',
  'jobs.new.scheduleHint': '정한 시각마다 이 작업의 회차를 하나 만들어 돌린다',
  // 겹침을 막지 않기로 한 결정을 사람에게 알리는 자리 — 도는 워커 수가 상한을 넘을 수 있다
  'jobs.new.scheduleOverlapHint': '이전 회차가 돌고 있어도 새 회차를 띄운다 — 워커가 겹칠 수 있다',
  'jobs.new.create': '만들기',
  // 동시 실행 1 을 골랐는데 그 폴더에 이미 워커가 있을 때. 막지 않고 알려만 준다 —
  // 파일을 안 건드리는 워커끼리는 충돌할 것이 없고 앱은 그것을 알 수 없다
  'jobs.new.folderBusy': '이 폴더에서 이미 워커가 일하고 있습니다 — 동시 실행 1 이면 이 작업의 워커도 같은 폴더에서 돌아 서로의 편집이 섞일 수 있습니다',
  'jobs.new.failed': '작업을 만들지 못했습니다',
  // 스케줄러가 워커를 띄울 계정을 못 골랐을 때 여는 Gate 의 문구(ipc.ts). 첫째는 예전부터
  // 있던 경우(그 provider 에 로그인된 계정이 없다), 둘째는 사람이 이 Task 에 지정한 계정을
  // 쓸 수 없는 경우다 — 지정을 무시하고 기본 계정으로 갈아타지 않으므로 사람에게 말해야 한다
  'jobs.gate.noAccountAssigned': '이 Task 에 계정이 지정되지 않아 어느 에이전트로 띄울지 알 수 없습니다 — 계정을 지정하세요',
  'jobs.gate.noAccount': '{provider} 계정에 로그인되어 있지 않아 이 Task 를 시작할 수 없습니다',
  'jobs.gate.assignedAccountUnusable':
    '이 Task 에 지정된 첫 계정을 쓸 수 없고, 그 뒤의 계정들은 나중에 갈아탈 순서일 뿐입니다 — 그 계정에 다시 로그인하거나 이 Task 의 계정 목록을 고치세요',
  // NewTaskModal.tsx — Task 를 짜는 동안 상세 창의 아래 칸(.detail-events)이 바뀌는 폼. deps 는
  // 이 폼이 아니라 그래프가 쥐고 있다(고르는 자리가 그래프이므로) — 그래서 이 카탈로그에는 deps
  // 자체의 값이 아니라 그것을 고르라고 안내하는 문구(depsHint)만 있다.
  'jobs.task.new': 'Task 추가',
  'jobs.task.title': '제목',
  'jobs.task.spec': '지시',
  'jobs.task.deps': '선행 Task',
  // 예전 문구는 '위 그래프에서 노드를 눌러 고릅니다'였다 — 고르는 자리가 셀렉트로 옮겨져
  // 거짓이 됐다. 대신 고른 것이 무엇을 뜻하는지 적는다(recomputeReady 의 규칙 그대로다)
  'jobs.task.depsHint': '고른 Task 가 모두 끝나야 시작합니다',
  'jobs.task.depsAdd': '선행 Task 고르기',
  // 계정 칸. **계정이 하나도 없을 때만 접힌다** — 하나여도 그린다: "지정 안 함"과 "이 계정으로
  // 못박음"은 계정이 하나뿐이어도 뜻이 다르다(로그아웃되고 둘째가 등록되면 갈리는 동작이
  // NewTaskModal.tsx 에 있다). 안 고르면 그 provider 의 기본 계정으로 간다(core/accounts/dispatchAccount.ts)
  'jobs.task.account': '계정',
  'jobs.task.accountPick': '계정을 고르세요',
  'jobs.task.accountNone': '추가 안 함',
  'jobs.task.accountEmpty': '등록된 계정이 없습니다 — 설정 → 계정에서 먼저 추가하세요',
  'jobs.task.accountHint':
    '이 Task 의 워커를 띄울 계정입니다 — 첫 계정이 어느 에이전트로 돌릴지 정하므로 반드시 하나는 고르세요. 둘 이상 고르면 한도에 걸렸을 때 적은 순서대로 갈아탑니다',
  // 고른 계정이 이 폴더를 처음 쓰면 CLI 가 신뢰 확인을 띄우고 **거기서 멈춘다** — 앱은 그것을
  // 모르고 노드는 도는 모양 그대로라, 미리 말해 두지 않으면 왜 아무 일도 없는지 알 길이 없다
  'jobs.task.accountTrust': '고른 계정이 이 폴더를 처음 쓰면 세션 탭에 폴더 신뢰 확인이 뜹니다 — 승인해야 워커가 일을 시작합니다',
  'jobs.task.validate': '완료를 검증할 실행 구성',
  'jobs.task.validateNone': '검증 없음',
  'jobs.task.review': '다른 에이전트가 검토',
  'jobs.task.create': '추가',
  'jobs.task.failed': 'Task 를 만들지 못했습니다',
  // JobsView.tsx — 도는 줄의 provider 뒤. 대기 중이면 경과 대신 이것을 적고, 이어진 적이 있으면
  // 그 뒤에 이어 붙인다({left}·{n} 은 core/i18n/index.ts 의 {name} 치환).
  'jobs.task.waitingReset': '리셋 대기 · {left}',
  'jobs.task.waitingNoTime': '리셋 대기',
  'jobs.task.resumedCount': '{n}번 이어짐',
  // RunDetail.tsx — 그래프 노드 위의 버튼. 띄우기와 다시 띄우기는 같은 글리프(▶)를 쓴다 — 전이표상
  // 한 노드에 둘이 함께 나오는 일이 없어(서로 배타적인 상태에서만 보인다) 뜻이 섞이지 않는다.
  // jobs.node.failed 는 이 네 동작(띄우기·멈추기·물어보기·다시 띄우기)이 함께 쓰는 하나의 실패
  // 안내다 — 이 버튼들에는 NewTaskModal/NewRunModal 같은 자기 폼이 없어(물어보기만 예외) 동작별로
  // 문구를 나눌 자리가 없다. 계정을 못 찾은 경우는 새 키를 만들지 않고 이미 있는
  // session.resume.noLoggedInAccounts 를 그대로 쓴다.
  'jobs.node.start': '띄우기',
  'jobs.node.stop': '멈추기',
  'jobs.node.restart': '다시 띄우기',
  'jobs.node.gate': '잠그기',
  // 열린 Gate 에 답하는 자리. 앱이 Gate 를 열고 보여 주기만 하고 푸는 곳이 아무 데도 없던
  // 것을 없앤 문구다 — 5번이 '답하는 자리를 앱에 둔다'로 좁아진 결과다
  'jobs.node.answer': '잠금 풀기',
  'jobs.node.answerLabel': '결정',
  // **묻는 말이 아니라 잠그는 이유다.** 한때 '물어보기'/'답하기'/'질문'/'답' 이었는데 대화처럼
  // 읽혔다 — 실제로 하는 일은 Task 를 blocked 로 내려 시작을 막고 그것을 되돌리는 것이고,
  // 화면에서 만든 Run 에는 그 글을 읽는 코디네이터가 아예 없다. 코디네이터가 있는 Run 에서는
  // 여전히 질문으로 읽히므로 잃는 것이 없다(가이드: a decision block for deciding the task DAG)
  'jobs.node.gateQuestion': '왜 세워 두는지',
  'jobs.node.failed': '이 동작을 하지 못했습니다'
} as const

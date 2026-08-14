<div align="center">

<img src="assets/banner.jpg" width="640" alt="Astera — build beyond the stars" />

**자리에 없는 동안에도 Claude Code와 Codex를 계속 일하게 하세요.**

[![CI](https://github.com/parsingk/Astera/actions/workflows/ci.yml/badge.svg)](https://github.com/parsingk/Astera/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/parsingk/Astera?logo=github)](https://github.com/parsingk/Astera/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/parsingk/Astera/total)](https://github.com/parsingk/Astera/releases)
[![License](https://img.shields.io/github/license/parsingk/Astera?color=blue)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-555)

[다운로드](#설치) · [기능](#무엇을-하는-앱인가) · [문서](#문서) · [버그 신고](https://github.com/parsingk/Astera/issues/new)

[English](README.md) · **한국어** · [日本語](README.ja.md) · [Español](README.es.md)

</div>

Astera는 책상 앞에 없을 때에도 에이전트 세션을 대신 돌립니다. 새벽 3시에 시작하도록 예약해 두면 그
시간에 알아서 시작합니다. 어떤 세션이든 사용량 한도에 걸리면 — 예약된 세션이든 아니든 — Astera가
트랜스크립트에서 리셋 시각을 읽어내고, 다음 계정으로 전환한 뒤 *같은* 작업을 이어갑니다. 턴이
끝났을 때와 한도에 걸렸을 때는 Slack이 알려줍니다. 세션들은 한 창 안에 나란히 놓이고 각자 자기
git worktree에 격리됩니다. 한 에이전트가 다른 세션을 띄우고 작업을 넘긴 뒤 보고가 올 때까지 기다릴 수
있는데, 함께 설치되는 CLI로 에이전트가 직접 하는 일이라 단계마다 손으로 지시할 필요가 없습니다.

> **상태:** Windows와 macOS를 지원합니다. `claude`와 `codex` CLI를 구동하는 방식이므로, 설치된
> CLI가 할 수 있는 만큼만 할 수 있습니다.

## 설치

**[Releases](https://github.com/parsingk/Astera/releases/latest)** 에서 최신 릴리스를 받아
실행하세요 — Windows는 `astera-<version>-setup.exe`, macOS는 `astera-<version>-universal.dmg`
입니다. Windows에서는 이후 앱이 스스로 업데이트하며, 내려받기 전에 물어봅니다.

> **macOS 빌드는 아직 공증(notarize)되지 않았고**, 그 때문에 두 가지 불편이 있습니다. Gatekeeper가
> 첫 실행을 막으므로, 앱을 Applications로 옮긴 뒤 macOS가 붙여 둔 격리 플래그를 지워 주세요.
>
> ```bash
> xattr -cr /Applications/Astera.app
> ```
>
> "인터넷에서 다운로드됨" 표시만 제거하는 명령이며, 그 표시가 유일한 걸림돌입니다 — 앱 자체는
> (ad-hoc) 서명되어 있으므로 다른 것은 바뀌지 않습니다. 클릭이 편하다면 시스템 설정 →
> **개인정보 보호 및 보안** → **확인 없이 열기** 도 됩니다. Control-클릭 → **열기** 는 macOS 15
> (Sequoia)에서 없어져 더 이상 동작하지 않습니다.
>
> 그리고 공증 전까지는 자동 업데이트가 꺼져 있어, 새 버전이 나오면 dmg를 다시 받아야 합니다.
> Windows에서는 첫 실행 때 SmartScreen 경고가 뜰 수 있습니다 — **추가 정보 → 실행** 을 누르세요.
>
> SignPath Foundation 오픈소스 프로그램(Windows)과 Apple Developer ID(macOS)를 통한 서명을
> 준비하고 있습니다 — 누가 무엇에 서명하는지는 [코드 서명 정책](docs/code-signing.md), 구체적인
> 절차는 [docs/releasing.md](docs/releasing.md)를 보세요.

이 밖에 필요한 것:

- **Windows 10 또는 11**, 혹은 **macOS 12 (Monterey) 이상**
- `PATH` 상의 **[Claude Code](https://claude.com/claude-code) 또는 Codex CLI** (둘 다여도 됩니다) —
  Astera는 이들을 실행할 뿐, 대체하지는 않습니다

## 무엇을 하는 앱인가

**세션**
- 여러 개의 `claude` / `codex` 세션을 한 창에서 탭과 분할 창으로
- 프로젝트별 터미널

**에디터와 단축키**
- 키 하나로 탐색기를 켜고 끕니다 — `Ctrl`/`Cmd`+`Shift`+`E`가 파일 트리와 Run 툴바, Run 콘솔을
  여닫고 페인 배치는 그대로 둡니다
- 탭 줄은 페인마다 하나이고 두 종류의 탭을 함께 담습니다. 파일이 그것을 고치고 있는 세션 옆에
  놓이고, 분할하면 둘을 나란히 보며, `Ctrl`+`Tab`이 활성 페인의 줄을 넘나듭니다
- 텍스트 상자가 아닌 진짜 에디터입니다. CodeMirror 기반으로 TypeScript·JavaScript·Python·Go·
  Rust·C/C++·Java·PHP·SQL·HTML·CSS·Markdown·JSON·YAML·XML 문법 강조를 지원하고, 탭으로 여러
  파일을 엽니다
- 항목마다 git 상태(추가·수정·삭제·충돌)가 표시되는 파일 트리, 그리고 생성·이름 변경·이동·복사·
  삭제·탐색기(Finder)에서 열기
- **로컬 히스토리:** 삭제하기 전에 스냅샷을 남기므로, 에이전트가 정리해 버린 것도 직접 지운 것도
  되살릴 수 있습니다. 30일간, 프로젝트당 최대 200 MB 보관
- 모든 단축키는 설정에서 다시 지정할 수 있고, 기본값은 macOS에서 `Cmd`, 그 외에서 `Ctrl`입니다 —
  창 분할, 분할된 창 사이 포커스 이동, 세션 순회, 파일 탭 닫기
- 터미널 폰트 선택 — CJK 텍스트에 쓰이는 대체 폰트까지

**실행 구성**
- 실행 구성에는 종류가 있습니다 — Shell·npm·Node.js·Gradle·Maven·cargo·go·Python·pytest·
  Docker Compose·Dockerfile·.NET — 그리고 그 종류에 실제로 있는 항목만 담습니다
- 명령은 실행할 때 조립됩니다. Gradle 래퍼, 락파일이 가리키는 패키지 매니저, 셸에 맞는 인용은
  칸에 적어 넣는 것이 아니라 그때 정해집니다
- 프로젝트의 빌드 파일을 읽으므로 npm 스크립트는 그대로 구성으로 올라오고, Gradle·Maven 프로젝트에는
  표준 태스크와 골이 준비됩니다. 자동으로 찾은 것은 기울임꼴로 보이다가, 손대는 순간 내 구성으로
  저장됩니다

**계정**
- 벤더별로 여러 계정을 두고, 각 계정을 자체 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`으로 격리
- **계정 롤링:** 세션이 사용량 한도에 걸리면 Astera가 트랜스크립트에서 이를 감지하고 리셋 시각을
  계산한 뒤, 다음 계정에서 작업을 이어갑니다
- 새 계정의 설정을 기본 계정에서 가져오기(선택) — `settings.json`, MCP 서버 목록, 그리고 `skills`·
  `commands`·`agents` 디렉터리

<div align="center">
<img src="assets/rolling.gif" width="820" alt="다이어그램: 실행 중인 세션이 주간 한도에 걸리고, Astera가 트랜스크립트에서 리셋 시각을 읽어 다음 계정으로 전환하며, 같은 대화가 그대로 이어진다" />
</div>

**예약 실행과 원격 조작**
- 지정한 시각에 세션이 시작되도록 예약
- 턴이 끝나거나 한도에 걸릴 때 Slack 알림, 그리고 Slack에서 보낸 답장을 세션으로 다시 전달 —
  휴대폰으로 진행 상황을 지켜볼 수 있습니다

<div align="center">
<img src="assets/schedule.gif" width="820" alt="다이어그램: 03:00에 예약된 세션이 스스로 시작해 남겨 둔 명령을 실행하고, 끝나면 Slack이 결과를 알린다" />
</div>

**벤더를 넘나드는 오케스트레이션**
- 코디네이터 세션이 워커 세션들에 작업을 배분합니다 — *다른* 벤더의 워커까지
- 워커는 함께 설치되는 `astera` CLI로 보고하고, 코디네이터는 완료·의존성·질문·에스컬레이션을
  기다립니다
- 각 작업을 자기 git worktree에서 실행해 병렬 워커가 서로 충돌하지 않게 할 수 있습니다

**그 외**
- 한국어·영어·일본어·스페인어 UI, 그리고 OS 로케일을 따르는 System 옵션
- GitHub Releases를 통한 자동 업데이트

## 오케스트레이션 빠른 시작

설정에서 오케스트레이션을 켠 뒤 세션을 시작하세요. 그 세션의 `PATH`에 `astera` CLI가 올라가고 사용법을
설명하는 스킬이 함께 주어지므로, 작업을 조율하라고 그냥 말하면 됩니다. 전체 레퍼런스를 직접 보려면:

```bash
astera help
```

`astera`가 `command not found`로 나오면 절대 경로가 `$ASTERA_CLI`에 들어 있습니다 — 같은 프로그램입니다.
`$ASTERA_CLI`가 비어 있다면 그 세션은 Astera가 시작한 것이 아니거나, 오케스트레이션이 꺼져 있습니다.

## 소스에서 빌드하기

빌드에는 **Node.js 22.12+** 와, `node-pty` 네이티브 재빌드(`electron-builder install-app-deps`)를 위한
C++ 툴체인이 필요합니다. Windows는 **Visual Studio Build Tools (C++)**, macOS는
**Xcode Command Line Tools** (`xcode-select --install`) 입니다.

```bash
npm ci
npm run dev        # 개발 모드로 실행
npm run typecheck  # node·web 두 프로젝트에 tsc 실행
npm run build      # 번들
npm run dist       # 현재 플랫폼용으로 dist-installer/ 에 패키징
npm run dist:win   # Windows 인스톨러
npm run dist:mac   # macOS universal dmg + zip
```

`npm run dist`는 아이콘을 생성하지 않고 커밋된 에셋(Windows `build/icon.ico`, macOS `build/icon.icns`,
양쪽 공용 `resources/tray.png`)을 읽습니다. 로고를 바꿀 때는 `resources/logo-source.png`를 교체하고
해당 플랫폼에서 스크립트를 다시 실행하세요 — Windows는 `powershell -File scripts/gen-icon.ps1`
(ico/png), macOS는 `sh scripts/gen-icon-mac.sh` (icns) — 그리고 생성된 에셋을 커밋하세요.

테스트는 대상 옆에 `*.test.ts`로 두고 `npm test`(Vitest)로 실행합니다. CI는 타입체크, 테스트, 전체
번들 빌드를 돌립니다.

## 문서

- [Slack 봇 설정](docs/slack-bot-setup.md) — 앱 생성, 토큰, 권한
- [릴리스](docs/releasing.md) — 버전을 자르고 배포하는 방법
- [코드 서명 정책](docs/code-signing.md) — 누가 릴리스에 서명하는지, 무엇에 서명하는지, 개인정보

## 기여

이슈와 풀 리퀘스트를 환영합니다. 시작하기 전에 알아 두면 좋은 것들:

- PR을 열기 전에 `npm run typecheck`, `npm test`, `npm run build`를 실행하세요 — CI가 확인하는 것들입니다.
- 동작이 바뀌는 변경에는 테스트가 함께 오기를 기대합니다. 롤링 테스트를 건드릴 때 알아 둘 규칙이
  하나 있습니다. 사용량 한도 문구는 의도적으로 `+`로 쪼개 놓았습니다. Astera가 세션 출력에서 그
  문구를 감시하기 때문입니다 — [CONTRIBUTING](.github/CONTRIBUTING.md)을 보세요.
- 버그 신고에는 앱 버전, OS 버전, 그리고 계정 롤링과 관련된 문제라면 `rolling.log`의 해당 부분을
  함께 적어 주시면 훨씬 다루기 쉽습니다 — Windows는 `%APPDATA%\astera\rolling.log`, macOS는
  `~/Library/Application Support/astera/rolling.log` 입니다.

## 감사

- 벤더를 넘나드는 오케스트레이션 모델 — 코디네이터가 로컬 CLI를 통해 워커 세션에 작업을 배분하고,
  질문으로 블로킹하고, 소유권을 확인하는 방식 — 은
  [Orca](https://github.com/stablyai/orca)의 에이전트 오케스트레이션에서 착안했습니다. 구현은
  이 프로젝트의 것입니다.
- Windows 코드 서명 파이프라인은 Orca가 릴리스에 쓰는 fail-open SignPath 흐름을 따릅니다 —
  [docs/releasing.md](docs/releasing.md)를 보세요.
- macOS 릴리스는 Apple Developer ID로 서명·공증하도록 되어 있고 워크플로도 준비되어 있습니다.
  Windows와 달리 이쪽은 선택이 아닙니다. 서명이 없으면 `electron-updater`의 macOS 자동
  업데이트(Squirrel.Mac 기반)가 업데이트 설치를 아예 거부하기 때문입니다 — 그래서 인증서가
  준비될 때까지는 ad-hoc 서명으로 배포되며 자동 업데이트가 되지 않습니다.

## 라이선스

[Apache License 2.0](LICENSE).

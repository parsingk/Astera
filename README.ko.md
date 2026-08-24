<div align="center">

<img src="assets/banner.jpg" width="640" alt="Astera — build beyond the stars" />

**자리에 없는 동안에도 Claude Code와 Codex를 계속 일하게 하세요.**

[![CI](https://github.com/parsingk/Astera/actions/workflows/ci.yml/badge.svg)](https://github.com/parsingk/Astera/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/parsingk/Astera?logo=github)](https://github.com/parsingk/Astera/releases/latest)
[![License](https://img.shields.io/github/license/parsingk/Astera?color=blue)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-555)

[다운로드](#설치) · [기능](#무엇을-하는-앱인가) · [Jobs](#jobs) · [문서](#문서) · [버그 신고](https://github.com/parsingk/Astera/issues/new)

[English](README.md) · **한국어** · [日本語](README.ja.md) · [Español](README.es.md)

</div>

Astera는 오래 걸리는 Claude Code와 Codex 작업을 위한 데스크톱 워크벤치입니다. 자리를 비운 동안에도
여러 세션을 계속 진행할 수 있습니다. 예약한 시각에 세션을 시작하고, 사용량 한도에 걸리면 다음
계정으로 전환해 같은 작업을 이어갑니다. 병렬 세션은 각자의 git worktree에서 격리되며, Slack으로
휴대폰에서도 진행 상황을 확인하고 응답할 수 있습니다. 작업에 의존 관계가 있다면 Job으로 구성해 두
벤더에 걸쳐 조율하고, 결과를 확인하며, 사람이 판단해야 할 지점에서 멈출 수 있습니다.

> **상태:** Windows·macOS·Linux를 지원합니다. `claude`와 `codex` CLI를 구동하는 방식이므로, 설치된
> CLI가 할 수 있는 만큼만 할 수 있습니다.

## 오래 걸리는 에이전트 작업을 위해

- **세션을 지켜보지 않아도 됩니다.** 지정한 시각에 작업을 시작하고, 턴 완료나 사용량 한도 도달을
  Slack으로 알림 받으며, 작업 흐름을 잃지 않고 다음 계정에서 이어갑니다.
- **체크아웃을 공유하지 않고 병렬로 작업합니다.** Claude Code와 Codex 세션을 한 창에서 관리하면서,
  필요하면 각 세션을 별도의 git worktree에서 실행할 수 있습니다.
- **여러 단계의 작업을 조율합니다.** 의존 관계를 Job으로 모델링하고, 준비된 Task를 어느 벤더에서든
  실행하며, 빌드·테스트·리뷰·사람의 판단을 완료 조건으로 둘 수 있습니다.

## 설치

**[Releases](https://github.com/parsingk/Astera/releases/latest)** 에서 최신 릴리스를 내려받아
실행합니다. Windows는 `astera-<version>-setup.exe`, macOS는 `astera-<version>-universal.dmg`,
Linux는 `astera-<version>-x86_64.AppImage` 또는 `astera-<version>-amd64.deb`를 사용합니다.
Windows에서는 이후 업데이트를 자동으로 확인하고, 내려받기 전에 묻습니다.

> **macOS 빌드는 아직 공증(notarize)되지 않았습니다.** 따라서 Gatekeeper가 첫 실행을 막을 수 있습니다.
> 앱을 Applications로 옮긴 뒤 macOS가 붙인 격리 플래그를 지워 주세요.
>
> ```bash
> xattr -cr /Applications/Astera.app
> ```
>
> 이 명령은 "인터넷에서 다운로드됨" 표시만 제거합니다. 그 표시가 유일한 실행 차단 요인이며, 앱은
> ad-hoc 서명 상태로 유지됩니다. 클릭으로 처리하고 싶다면 시스템 설정 → **개인정보 보호 및 보안** →
> **확인 없이 열기**를 사용해도 됩니다. Control-클릭 → **열기** 방식은 macOS 15 (Sequoia)에서
> 없어져 더 이상 동작하지 않습니다.
>
> 그리고 공증 전까지는 자동 업데이트가 꺼져 있어, 새 버전이 나오면 dmg를 다시 받아야 합니다.
> Windows에서는 첫 실행 때 SmartScreen 경고가 뜰 수 있습니다 — **추가 정보 → 실행** 을 누르세요.
>
> SignPath Foundation 오픈소스 프로그램(Windows)과 Apple Developer ID(macOS)를 통한 서명을
> 준비하고 있습니다 — 누가 무엇에 서명하는지는 [코드 서명 정책](docs/code-signing.md), 구체적인
> 절차는 [docs/releasing.md](docs/releasing.md)를 보세요. Linux 빌드는 서명하지 않습니다. Linux
> 배포 환경에서는 일반적인 방식입니다.

> **Linux에서는** 두 파일 모두 다운로드만으로는 사용할 수 없습니다. AppImage에는 실행 권한을 주세요.
>
> ```bash
> chmod +x astera-<version>-x86_64.AppImage
> ```
>
> deb는 `dpkg -i` 대신 apt로 설치해야 의존성도 함께 설치됩니다.
>
> ```bash
> sudo apt install ./astera-<version>-amd64.deb
> ```
>
> 지원 하한은 deb에 선언돼 있어서, 더 낮은 시스템에는 apt가 설치를 거부합니다 — 설치는 되고 실행만
> 안 되는 상황을 만들지 않습니다.

이 밖에 필요한 것:

- **Windows 10 또는 11**, **macOS 12 (Monterey) 이상**, 혹은 **Ubuntu 22.04 / Debian 12 이상**
- `PATH` 상의 **[Claude Code](https://claude.com/claude-code) 또는 Codex CLI** (둘 다여도 됩니다) —
  Astera는 이들을 실행할 뿐, 대체하지는 않습니다

## 무엇을 하는 앱인가

**프로젝트 작업 공간**
- 여러 개의 `claude` / `codex` 세션을 한 창에서 탭과 분할 창으로
- 프로젝트별 터미널

**에디터와 단축키**
- 키 하나로 탐색기를 켜고 끕니다 — `Ctrl`/`Cmd`+`Shift`+`E`가 파일 트리와 Run 툴바, Run 콘솔을
  여닫고 페인 배치는 그대로 둡니다
- 각 페인에는 파일 탭과 세션 탭을 함께 담는 탭 표시줄이 하나씩 있습니다. 파일을 수정하는 세션은
  그 파일 옆에 둘 수 있고, 분할 화면에서는 둘을 나란히 보며, `Ctrl`+`Tab`으로 활성 페인의 탭을
  순환합니다
- 단순 텍스트 상자가 아닌 CodeMirror 기반 편집기입니다. TypeScript·JavaScript·Python·Go·Rust·
  C/C++·Java·PHP·SQL·HTML·CSS·Markdown·JSON·YAML·XML 문법 강조를 지원하며, 여러 파일을 탭으로
  열 수 있습니다
- **마크다운은 나란히 볼 수 있습니다:** 마크다운 파일은 에디터·분할·프리뷰 중 하나로 열리고
  `Ctrl`/`Cmd`+`Shift`+`V`가 셋을 순환합니다. 분할에서는 양쪽 스크롤이 서로를 따라갑니다
- 항목마다 git 상태(추가·수정·삭제·충돌)를 표시하는 파일 트리와 생성·이름 변경·이동·복사·삭제·
  Finder/Explorer에서 보기
- **로컬 히스토리:** 삭제하기 전에 스냅샷을 남기므로, 에이전트가 정리해 버린 것도 직접 지운 것도
  되살릴 수 있습니다. 30일간, 프로젝트당 최대 200 MB 보관
- 모든 단축키는 설정에서 다시 지정할 수 있고, 기본값은 macOS에서 `Cmd`, 그 외에서 `Ctrl`입니다 —
  창 분할, 분할된 창 사이 포커스 이동, 세션 순회, 파일 탭 닫기

**실행 구성**
- 실행 구성은 Shell·npm·Node.js·Gradle·Maven·cargo·go·Python·pytest·Docker Compose·Dockerfile·
  .NET 유형을 지원하며, 유형별로 필요한 항목만 입력합니다
- 명령은 실행할 때 조합됩니다. Gradle Wrapper, 락파일이 가리키는 패키지 매니저, 셸에 맞는 인용은
  입력란에 직접 적는 대신 실행 시점에 결정됩니다
- 프로젝트의 빌드 파일을 읽어 npm 스크립트를 실행 구성으로 가져오고, Gradle·Maven 프로젝트에는 표준
  태스크와 골을 준비합니다. 자동으로 찾은 구성은 기울임꼴로 표시되며, 수정하는 순간 내 구성으로
  저장됩니다

**계정**
- 벤더별로 여러 계정을 둘 수 있으며, 각 계정은 자체 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`으로 격리
- **계정 롤링:** 세션이 사용량 한도에 걸리면 Astera가 트랜스크립트에서 이를 감지하고 리셋 시각을
  계산한 뒤, 다음 계정에서 작업을 이어갑니다
- 새 계정의 설정을 기본 계정에서 가져오기(선택) — `settings.json`, MCP 서버 목록, 그리고 `skills`·
  `commands`·`agents` 디렉터리

<div align="center">
<img src="assets/rolling.gif" width="820" alt="다이어그램: 실행 중인 세션이 주간 한도에 걸리고, Astera가 트랜스크립트에서 리셋 시각을 읽어 다음 계정으로 전환하며, 같은 대화가 그대로 이어진다" />
</div>

**예약 실행과 Slack 원격 제어**
- 지정한 시각에 세션이 시작되도록 예약
- 턴이 끝나거나 한도에 걸릴 때 Slack 알림, 그리고 Slack에서 보낸 답장을 세션으로 다시 전달 —
  휴대폰으로 진행 상황을 지켜볼 수 있습니다

<div align="center">
<img src="assets/schedule.gif" width="820" alt="다이어그램: 03:00에 예약된 세션이 스스로 시작해 남겨 둔 명령을 실행하고, 끝나면 Slack이 결과를 알린다" />
</div>

**테마와 모양**
- 테마 여섯 — Vega, Orion, Umbra, Aurora, Antares, Quasar. 카드마다 자기 팔레트로 스스로를 그리므로
  이름이 아니라 눈으로 고릅니다
- 테마는 색만이 아닙니다: 모서리 반경, 그림자, UI 서체, 행 밀도가 함께 따라옵니다 — Quasar는 Umbra보다
  한 화면에 더 많이 담습니다
- 바꾸면 이미 열려 있는 것도 함께 바뀝니다 — 돌고 있는 터미널은 색만 갈아 끼우므로 스크롤백이
  그대로 남습니다
- 터미널 폰트는 따로 고릅니다 — CJK 텍스트에 쓰이는 대체 폰트까지

**그 외**
- 한국어·영어·일본어·스페인어 UI, 그리고 OS 로케일을 따르는 System 옵션
- GitHub Releases를 통한 자동 업데이트

## Jobs

Jobs는 선택 기능입니다. 설정에서 **에이전트 오케스트레이션**을 켜면 Jobs 사이드바가 나타납니다.
Job은 Claude와 Codex에서 실행할 수 있는 Task의 의존성 그래프이며, 실행 방식은 두 가지입니다.

### 1. Jobs 사이드바에서 실행 — Astera가 조율

이 방식은 앱이 직접 관리합니다.

1. 프로젝트가 git 저장소이고 브랜치가 체크아웃되어 있는지 확인합니다.
2. Jobs 사이드바에서 **새 작업**을 누르고 **목표**·**에이전트**·**동시 실행**과 필요하면
   **예약 실행**을 정한 뒤 **만들기**를 누릅니다.
3. Job 상세 창에서 **Task 추가**를 누르고 **제목**과 **지시**를 쓴 뒤 **선행 Task**를 고릅니다.
   필요하면 **계정**, 완료를 검증할 실행 구성, 다른 에이전트의 검토를 함께 정합니다 — 검토는
   언제나 다른 벤더에서 돕니다.
4. Task를 모두 구성한 뒤 **실행**을 누릅니다. Job을 만들거나 Task를 추가하는 것만으로는 시작되지
   않습니다. 예약 Job에서는 **실행**이 즉시 회차를 띄우는 대신 예약을 활성화합니다.

Astera는 의존성이 끝난 Task만 시작합니다. 그 뒤는 **동시 실행** 값에 따라 갈립니다. 2 이상이면
(기본값은 3) Task마다 자기 worktree가 생기고, 다음 Task를 시작하기 전에 완료된 것들을 Job 자체의
worktree로 모으며 충돌이 나면 에이전트에게 해결을 맡깁니다. 1이면 Task들이 한 worktree를 순서대로
물려받으므로 합칠 것이 생기지 않습니다. 어느 쪽이든 완료된 Job은 프로젝트의 현재 브랜치로 자동
병합되지 않습니다. 결과를 가져올 준비가 됐을 때 상세 창에서 **병합**을 누르세요. 전체 흐름은
[Job은 어떻게 도는가](docs/jobs.md)에 자세히 설명되어 있습니다.

### 2. `astera-orchestration` 스킬로 실행 — 에이전트가 조율

코디네이터 세션을 시작하기 **전에 에이전트 오케스트레이션을 켜세요**. 그러면 새 세션의 `PATH`에
`astera` CLI가 올라가고 `astera-orchestration` 스킬이 함께 주어집니다. 다음처럼 자연어로 요청할 수
있습니다.

> `astera-orchestration` 스킬을 사용해 인증 모듈을 리팩터링하고, 그 뒤 회귀 테스트를 추가한 다음,
> 테스트 스위트로 검증하는 작업을 조율해 줘.

스킬은 `/astera-orchestration`으로 직접 호출할 수도 있습니다. 코디네이터는 Run과 Task를 만들고,
*다른* 벤더를 포함한 워커 세션에 작업을 배분하며 완료·의존성·질문·에스컬레이션을 기다립니다. 워커는
함께 설치되는 `astera` CLI로 결과를 보고합니다. Run의 작업 경로가 현재 연 프로젝트와 같으면 Jobs
사이드바에도 표시되지만, 무엇을 배분할지는 Astera의 자동 스케줄러가 아니라 코디네이터가 결정합니다.

두 방식 모두:

- **작업 완료를 보고만 믿지 않고 검증할 수 있습니다.** 프로젝트의 실행 구성을 하나 연결하면, 그
  빌드나 테스트가 `0`으로 끝났을 때에만 Task가 완료됩니다
- 종료 코드만으로 판단하기 어려운 것, 즉 요청한 대로 구현됐는지는 *다른* 벤더의 리뷰어에게 맡길 수
  있으며, Task는 그 판정을 기다립니다
- 각 작업을 자기 git worktree에서 실행해 병렬 워커가 서로 충돌하지 않게 할 수 있습니다
- 자동으로 결정할 수 없는 부분에서는 멈추고 사람의 답을 기다립니다
- 이렇게 띄운 에이전트에게는 프로젝트가 자기 결정을 적어 둔 자리(`knowledge/`, `docs/adr/`,
  `docs/decisions/` 등)를 함께 알려 줍니다

<div align="center">
<img src="assets/jobs.gif" width="820" alt="다이어그램: Job의 작업들이 의존성 그래프로 그려지고, 준비된 두 작업이 서로 다른 벤더에서 동시에 시작되며, 테스트가 하나의 완료를 증명하고, 끝난 Task worktree들이 Job worktree로 합쳐진 뒤, 스스로 정할 수 없는 결정이 사람을 기다린다" />
</div>

그리고 그 과정이 그대로 보입니다: 열려 있는 프로젝트의 Job이 사이드바에 모이고, 작업들은 의존성
그래프로 그려지며 지나간 일은 타임라인으로 쌓입니다. 어느 벤더가 어떤 작업을 얼마나 오래 붙들고
있는지도 그대로 보입니다. 시작·중지·재시도, 사람에게 묻기, 기다리고 있는 결정에 답하기 — 모두
그래프의 노드에서 합니다.

코디네이터 CLI의 전체 레퍼런스를 직접 보려면:

```bash
astera help
```

`astera`가 `command not found`로 나오면 절대 경로가 `$ASTERA_CLI`에 들어 있습니다 — 같은 프로그램입니다.
`$ASTERA_CLI`가 비어 있다면 그 세션은 Astera가 시작한 것이 아니거나, 에이전트 오케스트레이션이 꺼져
있습니다.

## 소스에서 빌드하기

빌드에는 **Node.js 22.12+**와 `node-pty` 네이티브 재빌드(`electron-builder install-app-deps`)를 위한
C++ 툴체인이 필요합니다. Windows는 **Visual Studio Build Tools (C++)**, macOS는
**Xcode Command Line Tools** (`xcode-select --install`), Linux는 **build-essential**과 **python3**
입니다 — Linux에는 node-pty 프리빌드가 없어 항상 직접 컴파일합니다.

```bash
npm ci
npm run dev        # 개발 모드로 실행
npm run typecheck  # node·web 두 프로젝트에 tsc 실행
npm run build      # 번들
npm run dist       # 현재 플랫폼용으로 dist-installer/ 에 패키징
npm run dist:win   # Windows 인스톨러
npm run dist:mac   # macOS universal dmg + zip
npm run dist:linux # Linux AppImage + deb
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
- 동작을 바꾸는 변경에는 테스트도 함께 포함해야 합니다. 롤링 테스트를 수정할 때 알아 둘 규칙이
  하나 있습니다. 사용량 한도 문구는 Astera가 세션 출력에서 감시하므로 의도적으로 `+`로 나눠 두었습니다
  — [CONTRIBUTING](.github/CONTRIBUTING.md)을 보세요.
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

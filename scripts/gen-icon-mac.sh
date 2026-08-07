#!/bin/sh
# macOS 앱 번들 아이콘을 브랜드 원본 하나에서 만든다.
#   저장소 루트에서:  sh scripts/gen-icon-mac.sh
#
#   입력   resources/icon.png          (256x256 RGBA. gen-icon.ps1 이 라운드 마스크를 적용한 산출물)
#   출력   build/icon.icns             16..1024 다해상도 (.app 번들 아이콘)
#
# gen-icon.ps1 의 macOS 짝이다. 그쪽은 System.Drawing 을 써서 Windows 에서만 돌고, 이쪽은
# sips/iconutil 을 써서 macOS 에서만 돈다. 어느 쪽도 CI 의존이 아니다 — 생성물을 커밋한다.
# **원본을 공유하는 것이 요점이다**: 두 스크립트가 서로 다른 원본을 읽기 시작하면 두 플랫폼의
# 아이콘이 시간이 지나며 조용히 어긋난다.
#
# **왜 logo-source.png 가 아니라 icon.png 를 읽는가 (실측):** logo-source.png 는 hasAlpha:no 이고
# 타일의 둥근 테두리 **바깥**이 불투명한 남색으로 채워져 있다 (모서리 픽셀 [15,21,36]). 그대로
# icns 를 만들면 Dock·Finder·Launchpad·앱 전환기가 임의 배경 위에 그릴 때 네 모서리가 어두운
# 네모로 드러난다 — 커밋 dd6a006 "fix: cut the opaque corners off the app icon" 이 Windows 에서
# 고친 바로 그 버그다. macOS 는 iOS 와 달리 앱 아이콘을 자동으로 둥글려주지 않으므로 더 눈에 띈다.
# icon.png 는 gen-icon.ps1 이 이미 타일의 실루엣으로 클리핑해 둔 산출물이라 모서리가 투명하다
# (모서리 픽셀 [0,0,0,0]).
#
# 대가는 해상도다: icon.png 는 256x256 이라 512 는 2배, 1024 는 4배 확대 보간이 된다. 마스크를
# 여기서 직접 그려 352px 원본을 쓰는 편이 더 선명하겠지만, sips 에는 합성 기능이 없고 이 저장소는
# ImageMagick 의존을 의도적으로 피한다 (gen-icon.ps1 헤더 참고). 모서리가 맞는 쪽이 선명한 쪽보다
# 중요하다 — 확대는 조금 흐릴 뿐이지만 불투명 모서리는 명백한 결함이다. 더 선명하게 하려면
# gen-icon.ps1 이 512 나 1024 짜리 마스크 적용본도 내보내게 하고 여기서 그걸 읽으면 된다.
#
# **트레이 아이콘은 여기서 만들지 않는다.** macOS 메뉴바의 템플릿 이미지는 알파만 읽어 시스템이
# 색을 칠하는데, logo-source.png 는 hasAlpha:no 이고 마크가 불투명한 타일 위에 얹혀 있다. 그대로
# 템플릿으로 넣으면 메뉴바에 단색 라운드 사각형이 뜬다. 배경이 투명한 마크-only 자산이 있어야
# 하고 그건 새 아트워크다 (sips 에는 알파 키잉이 없고, 이 저장소는 ImageMagick 의존을 피한다).
# 그때까지 macOS 도 기존 컬러 resources/tray.png 를 그대로 쓴다 — src/main/index.ts 참고.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
src="$root/resources/icon.png"
build="$root/build"

[ -f "$src" ] || { echo "원본을 찾을 수 없다: $src" >&2; exit 1; }
command -v sips >/dev/null || { echo "sips 가 없다 (macOS 에서 실행할 것)" >&2; exit 1; }
command -v iconutil >/dev/null || { echo "iconutil 이 없다 (macOS 에서 실행할 것)" >&2; exit 1; }

mkdir -p "$build"

# iconutil 은 정해진 이름 규칙의 .iconset 디렉터리만 받는다.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
iconset="$work/icon.iconset"
mkdir -p "$iconset"
for spec in "16 icon_16x16" "32 icon_16x16@2x" "32 icon_32x32" "64 icon_32x32@2x" \
            "128 icon_128x128" "256 icon_128x128@2x" "256 icon_256x256" \
            "512 icon_256x256@2x" "512 icon_512x512" "1024 icon_512x512@2x"; do
  size=${spec%% *}
  name=${spec##* }
  sips -s format png -z "$size" "$size" "$src" --out "$iconset/$name.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$build/icon.icns"
echo "wrote build/icon.icns"

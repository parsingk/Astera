#!/bin/sh
# macOS 앱 번들 아이콘을 브랜드 원본 하나에서 만든다.
#   저장소 루트에서:  sh scripts/gen-icon-mac.sh
#
#   입력   resources/logo-source.png   (정사각. 어두운 타일 위 브랜드 마크)
#   출력   build/icon.icns             16..1024 다해상도 (.app 번들 아이콘)
#
# gen-icon.ps1 의 macOS 짝이다. 그쪽은 System.Drawing 을 써서 Windows 에서만 돌고, 이쪽은
# sips/iconutil 을 써서 macOS 에서만 돈다. 어느 쪽도 CI 의존이 아니다 — 생성물을 커밋한다.
# **원본을 공유하는 것이 요점이다**: 두 스크립트가 서로 다른 원본을 읽기 시작하면 두 플랫폼의
# 아이콘이 시간이 지나며 조용히 어긋난다.
#
# 1024 슬롯은 확대 보간이다. 원본이 352x352 이기 때문인데, 이것이 브랜드 마크가 존재하는 최대
# 해상도다 — 저장소 루트의 astera.png(1254x1254, gitignore) 는 브랜드 시트 전체이고 그 안의 앱
# 아이콘 타일 자체가 약 370px 이다. Dock 과 Finder 가 실제로 쓰는 크기(<=512)에는 영향이 없고,
# 나중에 더 큰 마크가 생기면 logo-source.png 를 갈아끼우고 이 스크립트를 다시 돌리면 된다.
#
# **트레이 아이콘은 여기서 만들지 않는다.** macOS 메뉴바의 템플릿 이미지는 알파만 읽어 시스템이
# 색을 칠하는데, logo-source.png 는 hasAlpha:no 이고 마크가 불투명한 타일 위에 얹혀 있다. 그대로
# 템플릿으로 넣으면 메뉴바에 단색 라운드 사각형이 뜬다. 배경이 투명한 마크-only 자산이 있어야
# 하고 그건 새 아트워크다 (sips 에는 알파 키잉이 없고, 이 저장소는 ImageMagick 의존을 피한다).
# 그때까지 macOS 도 기존 컬러 resources/tray.png 를 그대로 쓴다 — src/main/index.ts 참고.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
src="$root/resources/logo-source.png"
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

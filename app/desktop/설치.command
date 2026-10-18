#!/bin/bash
# TWIN Reservoir Lab: 로컬 서명을 넣고 ~/Applications에 복사한 뒤 실행합니다.
cd "$(dirname "$0")"
APP="TWIN Reservoir Lab.app"
if [ ! -d "$APP" ]; then echo "같은 폴더에 '$APP'이 없습니다."; read -r -p "Enter를 누르면 닫힙니다."; exit 1; fi
xattr -dr com.apple.quarantine "$APP" 2>/dev/null
codesign --force --deep --sign - "$APP" && echo "로컬 서명 완료"
mkdir -p "$HOME/Applications"
rm -rf "$HOME/Applications/$APP"
cp -R "$APP" "$HOME/Applications/" && echo "복사 완료: $HOME/Applications/$APP"
open "$HOME/Applications/$APP"

#!/bin/bash
set -e
unset ELECTRON_RUN_AS_NODE
DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$DIR/Muse AI Studio.app"
echo "Đang làm mới tiến trình và mở Muse AI Studio v2.0 (shadcn/ui)..."
pkill -f "Muse AI Studio.app/Contents/MacOS/Electron" 2>/dev/null || true
sleep 0.5
xattr -cr "$APP" 2>/dev/null || true
chmod +x "$APP/Contents/MacOS/Electron" 2>/dev/null || true
env -u ELECTRON_RUN_AS_NODE open -a "$APP"

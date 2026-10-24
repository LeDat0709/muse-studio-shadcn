#!/bin/bash
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$DIR/Muse AI Studio.app"
echo "Đang gỡ chặn Gatekeeper (nếu có) và mở Muse AI Studio v2.0 (shadcn/ui)..."
xattr -cr "$APP" 2>/dev/null || true
chmod +x "$APP/Contents/MacOS/Electron" 2>/dev/null || true
open "$APP"

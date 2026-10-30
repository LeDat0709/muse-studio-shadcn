#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Zero-dependency ASAR Packager & macOS App Builder for Muse AI Studio (Node.js + Electron + shadcn/ui)
"""

import os
import sys
import json
import shutil
import struct
import hashlib
import plistlib
import subprocess

BLOCK_SIZE = 4 * 1024 * 1024
EXCLUDED_TOP = {
    ".git",
    ".DS_Store",
    ".agent",
    ".claude",
    ".github",
    ".hallmark",
    ".ts",
    "node_modules",
    "data",
    "dist",
    "graphify-out",
    "scripts",
    "tests",
    "tools",
    "Muse AI Studio.app",
    "Mo-App-MacBook.command",
}


def compute_integrity(buf: bytes) -> dict:
    full_hash = hashlib.sha256(buf).hexdigest()
    blocks = []
    if len(buf) == 0:
        blocks.append(full_hash)
    else:
        for i in range(0, len(buf), BLOCK_SIZE):
            chunk = buf[i : i + BLOCK_SIZE]
            blocks.append(hashlib.sha256(chunk).hexdigest())
    return {
        "algorithm": "SHA256",
        "hash": full_hash,
        "blockSize": BLOCK_SIZE,
        "blocks": blocks,
    }


def build_asar(src_dir: str, out_asar_path: str):
    file_buffers = []
    current_offset = 0

    def walk_dir(dir_path: str, is_root: bool = False) -> dict:
        nonlocal current_offset
        files_obj = {}
        for name in sorted(os.listdir(dir_path)):
            if name == ".DS_Store":
                continue
            if is_root and name in EXCLUDED_TOP:
                continue
            full_path = os.path.join(dir_path, name)
            if os.path.isdir(full_path) and not os.path.islink(full_path):
                files_obj[name] = walk_dir(full_path, False)
            elif os.path.isfile(full_path):
                with open(full_path, "rb") as f:
                    buf = f.read()
                size = len(buf)
                offset_str = str(current_offset)
                current_offset += size
                file_buffers.append(buf)
                files_obj[name] = {
                    "size": size,
                    "offset": offset_str,
                    "integrity": compute_integrity(buf),
                }
        return {"files": files_obj}

    header_tree = walk_dir(src_dir, True)
    header_json_bytes = json.dumps(header_tree, separators=(",", ":")).encode("utf-8")
    str_size = len(header_json_bytes)
    aligned_str_size = (str_size + 3) & ~3
    str_pickle_size = 4 + aligned_str_size
    header_pickle_size = 4 + str_pickle_size

    prefix = bytearray(16 + aligned_str_size)
    struct.pack_into("<IIII", prefix, 0, 4, header_pickle_size, str_pickle_size, str_size)
    prefix[16 : 16 + str_size] = header_json_bytes

    os.makedirs(os.path.dirname(out_asar_path), exist_ok=True)
    tmp_asar_path = out_asar_path + ".tmp"
    if os.path.exists(tmp_asar_path):
        os.remove(tmp_asar_path)
    with open(tmp_asar_path, "wb") as out:
        out.write(prefix)
        for b in file_buffers:
            out.write(b)
    if os.path.exists(out_asar_path):
        os.remove(out_asar_path)
    os.replace(tmp_asar_path, out_asar_path)

    total_mb = (len(prefix) + current_offset) / (1024 * 1024)
    print(f"✅ Đã đóng gói {len(file_buffers)} file -> {out_asar_path} ({total_mb:.2f} MB)")


def main():
    root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    orig_folder = "/Users/dat/Downloads/EM-BONG-AI-Muse-Studio-MacBook-1.2.0-AppleSilicon-M1-M2-M3-M4-arm64"
    orig_app = os.path.join(orig_folder, "EM BONG AI Muse Studio.app")
    orig_source = os.path.join(orig_folder, "source-code")
    new_app = os.path.join(root_dir, "Muse AI Studio.app")

    # 1. Sync updated src files and repack into original EM BONG AI Muse Studio.app
    if os.path.isdir(orig_source) and os.path.isdir(orig_app):
        for fname in ("gateway.js", "routes.json", "engine.js", "server.js", "store.js"):
            src_f = os.path.join(root_dir, "src", fname)
            dst_f = os.path.join(orig_source, "src", fname)
            if os.path.isfile(src_f) and os.path.isdir(os.path.dirname(dst_f)):
                shutil.copy2(src_f, dst_f)
        orig_asar = os.path.join(orig_app, "Contents", "Resources", "app.asar")
        build_asar(orig_source, orig_asar)

    # 2. Clone Electron runtime bundle into Muse AI Studio.app (if Frameworks not present yet)
    frameworks_dir = os.path.join(new_app, "Contents", "Frameworks")
    if os.path.isdir(orig_app) and not os.path.isdir(frameworks_dir):
        if os.path.exists(new_app):
            shutil.rmtree(new_app)
        print("📦 Đang sao chép Electron Runtime cho Muse AI Studio.app...")
        shutil.copytree(orig_app, new_app, symlinks=True)

    # 3. Update Info.plist of Muse AI Studio.app
    plist_path = os.path.join(new_app, "Contents", "Info.plist")
    if os.path.isfile(plist_path):
        with open(plist_path, "rb") as f:
            plist_data = plistlib.load(f)
        plist_data["CFBundleDisplayName"] = "Muse AI Studio"
        plist_data["CFBundleName"] = "Muse AI Studio"
        plist_data["CFBundleIdentifier"] = "com.museai.studio.shadcn"
        plist_data["CFBundleShortVersionString"] = "2.0.0"
        plist_data["CFBundleVersion"] = "2.0.0"
        with open(plist_path, "wb") as f:
            plistlib.dump(plist_data, f)

    # 4. Pack new shadcn/ui project into Muse AI Studio.app/Contents/Resources/app.asar
    new_asar = os.path.join(new_app, "Contents", "Resources", "app.asar")
    build_asar(root_dir, new_asar)

    # 4b. Clear quarantine attributes for Apple Silicon (M1/M2/M3/M4)
    for app_bundle in (orig_app, new_app):
        if os.path.isdir(app_bundle):
            subprocess.run(["xattr", "-cr", app_bundle], check=False)
    print("🔐 Đã làm sạch thuộc tính Gatekeeper (Apple Silicon M1/M2/M3/M4) cho ứng dụng.")

    # 5. Create 1-click MacBook launcher script
    launcher_path = os.path.join(root_dir, "Mo-App-MacBook.command")
    launcher_content = """#!/bin/bash
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
"""
    with open(launcher_path, "w", encoding="utf-8") as f:
        f.write(launcher_content)
    os.chmod(launcher_path, 0o755)
    print(f"✅ Đã tạo file chạy nhanh: {launcher_path}")


if __name__ == "__main__":
    main()

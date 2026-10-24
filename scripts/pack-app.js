"use strict";

/**
 * Pure Node.js ASAR Builder & MacBook .app Packager for EM BÔNG AI · Muse Studio
 * Zero external dependencies required.
 *
 * Usage:
 *   node scripts/pack-app.js
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const DIST_DIR = path.resolve(ROOT_DIR, "..");
const MAC_APP_PATH = path.join(DIST_DIR, "EM BONG AI Muse Studio.app");
const TARGET_ASAR = path.join(MAC_APP_PATH, "Contents", "Resources", "app.asar");

const BLOCK_SIZE = 4 * 1024 * 1024; // 4MB block size per ASAR specification
const EXCLUDED_TOP_DIRS = new Set([
  ".git",
  ".DS_Store",
  "node_modules",
  "data",
  "scripts",
]);

function computeIntegrity(buf) {
  const fullHash = crypto.createHash("sha256").update(buf).digest("hex");
  const blocks = [];
  if (buf.length === 0) {
    blocks.push(fullHash);
  } else {
    for (let i = 0; i < buf.length; i += BLOCK_SIZE) {
      const slice = buf.subarray(i, Math.min(i + BLOCK_SIZE, buf.length));
      blocks.push(crypto.createHash("sha256").update(slice).digest("hex"));
    }
  }
  return {
    algorithm: "SHA256",
    hash: fullHash,
    blockSize: BLOCK_SIZE,
    blocks,
  };
}

function buildAsarArchive(srcDir, outAsarPath) {
  const fileBuffers = [];
  let currentOffset = 0;

  function walkDir(dirPath, isRoot = false) {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const filesObj = {};

    for (const entry of entries) {
      if (entry.name === ".DS_Store") continue;
      if (isRoot && EXCLUDED_TOP_DIRS.has(entry.name)) continue;

      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        filesObj[entry.name] = walkDir(fullPath, false);
      } else if (entry.isFile()) {
        const buf = fs.readFileSync(fullPath);
        const size = buf.length;
        const offsetStr = String(currentOffset);
        currentOffset += size;
        fileBuffers.push(buf);

        filesObj[entry.name] = {
          size,
          offset: offsetStr,
          integrity: computeIntegrity(buf),
        };
      }
    }
    return { files: filesObj };
  }

  const headerTree = walkDir(srcDir, true);
  const headerJsonBuf = Buffer.from(JSON.stringify(headerTree), "utf-8");
  const strSize = headerJsonBuf.length;
  const alignedStrSize = (strSize + 3) & ~3; // 4-byte aligned
  const strPickleSize = 4 + alignedStrSize;
  const headerPickleSize = 4 + strPickleSize;

  const prefixBuf = Buffer.alloc(16 + alignedStrSize, 0);
  prefixBuf.writeUInt32LE(4, 0);
  prefixBuf.writeUInt32LE(headerPickleSize, 4);
  prefixBuf.writeUInt32LE(strPickleSize, 8);
  prefixBuf.writeUInt32LE(strSize, 12);
  headerJsonBuf.copy(prefixBuf, 16);

  fs.mkdirSync(path.dirname(outAsarPath), { recursive: true });
  const finalBuf = Buffer.concat([prefixBuf, ...fileBuffers]);
  fs.writeFileSync(outAsarPath, finalBuf);
  return {
    outAsarPath,
    totalBytes: finalBuf.length,
    fileCount: fileBuffers.length,
  };
}

function main() {
  console.log("==============================================================");
  console.log("  📦 ĐÓNG GÓI MÃ NGUỒN EM BÔNG AI · MUSE STUDIO (.ASAR)");
  console.log("==============================================================");

  const res = buildAsarArchive(ROOT_DIR, TARGET_ASAR);
  console.log(`✅ Đã đóng gói ${res.fileCount} file vào:`);
  console.log(`   ${res.outAsarPath} (${(res.totalBytes / 1024 / 1024).toFixed(2)} MB)`);

  if (process.platform === "darwin" && fs.existsSync(MAC_APP_PATH)) {
    try {
      execFileSync("xattr", ["-cr", MAC_APP_PATH], { stdio: "ignore" });
    } catch (_e) {
      // ignore
    }
    console.log("✅ Đã cập nhật thành công vào ứng dụng MacBook:");
    console.log(`   ${MAC_APP_PATH}`);
  }
}

if (require.main === module) {
  main();
}

module.exports = { buildAsarArchive };

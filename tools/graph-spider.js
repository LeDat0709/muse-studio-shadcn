"use strict";

/**
 * Graph spider: walks graphify's graph.json and reports likely bugs.
 *   1. Functions nothing calls (the graph finds candidates, a text search confirms).
 *   2. Async calls left floating: no await / return / .catch, and the callee has no try/catch of its own.
 *   3. Server routes that no test mentions.
 *
 * Usage: graphify update . && node tools/graph-spider.js
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const GRAPH_FILE = path.join(ROOT, "graphify-out", "graph.json");
const REPORT_FILE = path.join(ROOT, "graphify-out", "graph-spider-report.md");
// graphify rewrites manifest.json on every update, graph.json only when the topology changes.
const MANIFEST_FILE = path.join(ROOT, "graphify-out", "manifest.json");
const SOURCE_DIRS = ["desktop", "src", "tests", "tools", "scripts", "extension"];
const SOURCE_EXT = /\.(c?js|mjs|py|html)$/;
const JS_EXT = /\.(c?js|mjs)$/;
const CALL_RELATIONS = new Set(["calls", "indirect_call", "references"]);
// Called by the runtime, never by name in our code.
const RUNTIME_NAMES = new Set(["constructor"]);

const lineNo = (loc) => Number(String(loc || "").replace(/^L/, "")) || 0;
const bareName = (label) => String(label).replace(/^\./, "").replace(/\(\)$/, "");
const escapeRe = (s) => s.replace(/[$.*+?^{}()|[\]\\]/g, "\\$&");

// Index just past the string/template literal that opens at i.
function skipLiteral(text, i) {
  const quote = text[i];
  for (let j = i + 1; j < text.length; j += 1) {
    if (text[j] === "\\") j += 1;
    else if (text[j] === quote) return j + 1;
    else if (quote === "`" && text[j] === "$" && text[j + 1] === "{") j = matchClose(text, j + 1) - 1;
  }
  return text.length;
}

// Index just past the bracket that closes the one at `open`; skips literals and comments.
function matchClose(text, open) {
  const pairs = { "(": ")", "{": "}", "[": "]" };
  const stack = [pairs[text[open]]];
  let i = open + 1;
  while (i < text.length && stack.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") { i = skipLiteral(text, i); continue; }
    if (c === "/" && text[i + 1] === "/") { const nl = text.indexOf("\n", i); i = nl < 0 ? text.length : nl; continue; }
    if (c === "/" && text[i + 1] === "*") { const end = text.indexOf("*/", i + 2); i = end < 0 ? text.length : end + 2; continue; }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack[stack.length - 1]) stack.pop();
    i += 1;
  }
  return i;
}

/** True when the function defined at defLine wraps its body in its own try/catch. Unknown shapes count as handled. */
function handlesOwnErrors(lines, defLine) {
  const text = lines.slice(defLine - 1).join("\n");
  const paramsOpen = text.indexOf("(");
  if (paramsOpen < 0) return true;
  const paramsEnd = matchClose(text, paramsOpen);
  const bodyOpen = text.indexOf("{", paramsEnd);
  if (bodyOpen < 0 || !/^\s*(=>)?\s*$/.test(text.slice(paramsEnd, bodyOpen))) return true;
  const body = text.slice(bodyOpen + 1, matchClose(text, bodyOpen) - 1);
  let depth = 0;
  let sawTry = false;
  let sawCatch = false;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === '"' || c === "'" || c === "`") { i = skipLiteral(body, i) - 1; continue; }
    if (c === "{") depth += 1;
    else if (c === "}") depth -= 1;
    else if (depth === 0 && !/[\w$.]/.test(body[i - 1] || "")) {
      if (/^try\b/.test(body.slice(i, i + 4))) sawTry = true;
      if (/^catch\b/.test(body.slice(i, i + 6))) sawCatch = true;
    }
  }
  return sawTry && sawCatch;
}

/** True when the call to `name` on callLine is a bare statement whose promise nobody awaits, returns or catches. */
function isFloatingCall(lines, callLine, name) {
  const line = lines[callLine - 1] || "";
  const m = new RegExp(`(^|[^\\w$])${escapeRe(name)}\\s*\\(`).exec(line);
  if (!m) return false;
  const nameStart = m.index + m[1].length;
  let exprStart = nameStart;
  while (exprStart > 0 && /[\w$.?]/.test(line[exprStart - 1])) exprStart -= 1;
  const before = line.slice(0, exprStart).trim();
  if (!(before === "" || /[;{})]$|\belse$/.test(before))) return false;
  const text = lines.slice(callLine - 1).join("\n");
  const after = text.slice(matchClose(text, line.indexOf("(", nameStart))).trimStart();
  return !/^\??\.(then|catch|finally)\s*\(/.test(after);
}

function findDeadFunctions(graph, corpusText) {
  const called = new Set(graph.edges.filter((e) => CALL_RELATIONS.has(e.relation)).map((e) => e.target));
  const countWord = (word) => (corpusText.match(new RegExp(`\\b${escapeRe(word)}\\b`, "g")) || []).length;
  return graph.nodes
    .filter((n) => n.file_type === "code" && n._callable && !n._callable_class && /\(\)$/.test(n.label))
    .filter((n) => !called.has(n.id) && !RUNTIME_NAMES.has(bareName(n.label)))
    .filter((n) => countWord(bareName(n.label)) <= 1)
    .map((n) => ({ name: n.label, file: n.source_file, line: lineNo(n.source_location) }));
}

function findFloatingAsyncCalls(graph, readLines) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const isRisky = (n) => {
    const lines = readLines(n.source_file);
    const def = lineNo(n.source_location);
    return /\basync\b/.test(lines[def - 1] || "") && !handlesOwnErrors(lines, def);
  };
  const seen = new Set();
  return graph.edges
    .filter((e) => e.relation === "calls" && JS_EXT.test(e.source_file || ""))
    .map((e) => ({ edge: e, callee: byId.get(e.target), caller: byId.get(e.source) }))
    .filter(({ callee }) => callee && callee._callable && JS_EXT.test(callee.source_file || "") && isRisky(callee))
    .filter(({ edge, callee }) => isFloatingCall(readLines(edge.source_file), lineNo(edge.source_location), bareName(callee.label)))
    .map(({ edge, callee, caller }) => ({
      caller: caller ? caller.label : "?",
      callee: callee.label,
      file: edge.source_file,
      line: lineNo(edge.source_location),
      inferred: edge.confidence !== "EXTRACTED",
    }))
    .filter((f) => !seen.has(`${f.file}:${f.line}:${f.callee}`) && seen.add(`${f.file}:${f.line}:${f.callee}`));
}

function findUntestedRoutes(serverSource, testsText) {
  return [...serverSource.matchAll(/pathname === "(\/[^"]+)"/g)]
    .map((m) => ({ route: m[1], line: serverSource.slice(0, m.index).split("\n").length }))
    .filter(({ route }, i, all) => all.findIndex((r) => r.route === route) === i && !testsText.includes(route));
}

function listSourceFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    if (d.name.startsWith(".") || d.name === "node_modules") return [];
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return listSourceFiles(p);
    return SOURCE_EXT.test(d.name) ? [p] : [];
  });
}

function writeReport({ graph, stale, dead, floating, routes }) {
  const link = (file, line) => `[${file}:${line}](../${file}#L${line})`;
  const out = [
    "# Báo cáo con nhện graph",
    "",
    `Graph: graphify-out/graph.json, ${graph.nodes.length} nút, dựng từ commit \`${String(graph.commit || "?").slice(0, 8)}\`.`,
    stale ? "\n> Graph cũ hơn code: chạy `graphify update .` rồi chạy lại con nhện.\n" : "",
    `## Hàm không ai gọi (${dead.length})`,
    "",
    ...dead.map((d) => `- \`${d.name}\` ${link(d.file, d.line)}`),
    "",
    `## Gọi hàm async mà bỏ lửng lỗi (${floating.length})`,
    "",
    "Hàm được gọi là async, không tự try/catch, và chỗ gọi không await, return hay .catch: lỗi sẽ thành \"Uncaught (in promise)\".",
    "",
    ...floating.map((f) => `- \`${f.caller}\` gọi \`${f.callee}\` ${link(f.file, f.line)}${f.inferred ? " (graph suy luận, cần xem lại)" : ""}`),
    "",
    `## Route server chưa có test nào nhắc tới (${routes.length})`,
    "",
    ...routes.map((r) => `- \`${r.route}\` ${link("src/server.js", r.line)}`),
    "",
  ];
  fs.writeFileSync(REPORT_FILE, out.join("\n"));
}

function main() {
  if (!fs.existsSync(GRAPH_FILE)) {
    console.error("Chưa có graphify-out/graph.json. Chạy trước: graphify update .");
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(GRAPH_FILE, "utf8"));
  const graph = { nodes: raw.nodes || [], edges: raw.links || raw.edges || [], commit: raw.built_at_commit };

  const files = SOURCE_DIRS.flatMap((d) => listSourceFiles(path.join(ROOT, d)));
  const cache = new Map();
  // A file the graph names but that is gone now (stale graph) reads as empty and yields no findings.
  const readLines = (rel) => {
    if (!cache.has(rel)) {
      const p = path.join(ROOT, rel);
      cache.set(rel, fs.existsSync(p) ? fs.readFileSync(p, "utf8").split("\n") : []);
    }
    return cache.get(rel);
  };
  const corpus = files.map((f) => fs.readFileSync(f, "utf8")).join("\n");
  const testsText = files.filter((f) => f.startsWith(path.join(ROOT, "tests"))).map((f) => fs.readFileSync(f, "utf8")).join("\n");
  const builtAt = fs.statSync(fs.existsSync(MANIFEST_FILE) ? MANIFEST_FILE : GRAPH_FILE).mtimeMs;
  const stale = files.some((f) => fs.statSync(f).mtimeMs > builtAt);

  const dead = findDeadFunctions(graph, corpus);
  const floating = findFloatingAsyncCalls(graph, readLines);
  const routes = findUntestedRoutes(readLines("src/server.js").join("\n"), testsText);
  writeReport({ graph, stale, dead, floating, routes });

  if (stale) console.warn("⚠ Graph cũ hơn code, nên chạy: graphify update .");
  console.log(`✖ ${dead.length} hàm không ai gọi`);
  console.log(`✖ ${floating.length} lời gọi async bỏ lửng lỗi`);
  console.log(`⚠ ${routes.length} route server chưa có test`);
  console.log(`→ báo cáo: ${path.relative(process.cwd(), REPORT_FILE)}`);
}

if (require.main === module) main();

module.exports = { findDeadFunctions, findFloatingAsyncCalls, findUntestedRoutes, handlesOwnErrors, isFloatingCall };

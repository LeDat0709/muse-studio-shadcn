"use strict";

const test = require("node:test");
const assert = require("node:assert");
const {
  findDeadFunctions,
  findFloatingAsyncCalls,
  findUntestedRoutes,
  handlesOwnErrors,
  isFloatingCall,
} = require("../tools/graph-spider");

const lines = (src) => src.split("\n");

test("a bare call to an async function is floating; await, return and .catch are not", () => {
  assert.strictEqual(isFloatingCall(["  api('/x');"], 1, "api"), true);
  assert.strictEqual(isFloatingCall(["  if (ok) api('/x');"], 1, "api"), true);
  assert.strictEqual(isFloatingCall(["  await api('/x');"], 1, "api"), false);
  assert.strictEqual(isFloatingCall(["  return api('/x');"], 1, "api"), false);
  assert.strictEqual(isFloatingCall(["  const p = api('/x');"], 1, "api"), false);
  assert.strictEqual(isFloatingCall(["  void api('/x');"], 1, "api"), false);
  assert.strictEqual(isFloatingCall(["  this.gw.close();"], 1, "close"), true);
  assert.strictEqual(isFloatingCall(lines("  api('/x', {\n    body: { a: ')' },\n  }).catch(() => {});"), 1, "api"), false);
});

test("a callee with its own try/catch handles its errors; default params do not fool the body search", () => {
  const guarded = lines("async function run(row, opts = {}) {\n  if (!row) return;\n  try {\n    await go();\n  } catch (err) {\n    show(err);\n  }\n}");
  const bare = lines("async function save(data = {}) {\n  await api('/save', { body: `${data.id}` });\n  done();\n}");
  const onlyMethodCatch = lines("async connect() {\n  await this.open().catch(() => {});\n}");
  assert.strictEqual(handlesOwnErrors(guarded, 1), true);
  assert.strictEqual(handlesOwnErrors(bare, 1), false);
  assert.strictEqual(handlesOwnErrors(onlyMethodCatch, 1), false, ".catch( on one call does not guard the body");
});

test("floating calls are reported only when the async callee does not catch its own errors", () => {
  const files = {
    "a.js": lines("async function risky() {\n  await net();\n}\nasync function safe() {\n  try { await net(); } catch (e) {}\n}\nfunction onClick() {\n  risky();\n  safe();\n}"),
  };
  const graph = {
    nodes: [
      { id: "risky", label: "risky()", _callable: true, file_type: "code", source_file: "a.js", source_location: "L1" },
      { id: "safe", label: "safe()", _callable: true, file_type: "code", source_file: "a.js", source_location: "L4" },
      { id: "onClick", label: "onClick()", _callable: true, file_type: "code", source_file: "a.js", source_location: "L7" },
    ],
    edges: [
      { source: "onClick", target: "risky", relation: "calls", confidence: "EXTRACTED", source_file: "a.js", source_location: "L8" },
      { source: "onClick", target: "safe", relation: "calls", confidence: "EXTRACTED", source_file: "a.js", source_location: "L9" },
    ],
  };

  const found = findFloatingAsyncCalls(graph, (f) => files[f] || []);

  assert.deepStrictEqual(found, [{ caller: "onClick()", callee: "risky()", file: "a.js", line: 8, inferred: false }]);
});

test("dead functions need both no caller in the graph and no other mention in the code", () => {
  const graph = {
    nodes: [
      { id: "used", label: "used()", _callable: true, file_type: "code", source_file: "a.js", source_location: "L1" },
      { id: "handler", label: "handler()", _callable: true, file_type: "code", source_file: "a.js", source_location: "L2" },
      { id: "orphan", label: "orphan()", _callable: true, file_type: "code", source_file: "a.js", source_location: "L3" },
      { id: "Klass", label: "Klass", _callable: true, _callable_class: true, file_type: "code", source_file: "a.js", source_location: "L4" },
    ],
    edges: [{ source: "x", target: "used", relation: "calls" }],
  };
  const corpus = "function used(){}\nfunction handler(){}\nfunction orphan(){}\nbtn.addEventListener('click', handler);";

  assert.deepStrictEqual(findDeadFunctions(graph, corpus), [{ name: "orphan()", file: "a.js", line: 3 }]);
});

test("routes are untested when no test file mentions their path", () => {
  const server = 'if (pathname === "/admin/a") {}\nif (pathname === "/admin/b") {}\nif (pathname === "/admin/a") {}';

  assert.deepStrictEqual(findUntestedRoutes(server, 'post("/admin/a")'), [{ route: "/admin/b", line: 2 }]);
});

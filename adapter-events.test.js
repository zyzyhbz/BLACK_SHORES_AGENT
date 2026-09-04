const assert = require("node:assert/strict");
const test = require("node:test");

const { normalizeEvent } = require("./adapter-events");

const codex = { id: "codex", label: "Codex" };
const grok = { id: "grok", label: "Grok Build" };
const cursor = { id: "cursor", label: "Cursor" };

test("codex tool steps carry their native command and exit code", () => {
  const events = normalizeEvent(codex, {
    type: "item.completed",
    item: { type: "command_execution", command: "pnpm test", exit_code: 0 },
  }, {});
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "hub.progress");
  assert.match(events[0].message, /pnpm test/);
  assert.match(events[0].message, /退出码 0/);
  assert.match(events[0].detail, /pnpm test/);
});

test("codex tool starts name their command instead of a generic label", () => {
  const events = normalizeEvent(codex, {
    type: "item.started",
    item: { type: "command_execution", command: "git status" },
  }, {});
  assert.match(events[0].message, /git status/);
});

test("generic tool events keep their native subtype", () => {
  const events = normalizeEvent(cursor, { type: "tool.execute", subtype: "read_file" }, {});
  assert.match(events[0].message, /read_file/);
  assert.match(events[0].detail, /read_file/);
});

test("grok deltas accumulate quietly but volume triggers progress", () => {
  const state = { lastDeltaProgressAt: Date.now(), lastDeltaProgressChars: 0 };
  const small = normalizeEvent(grok, { type: "text", data: "hello" }, state);
  assert.deepEqual(small.map((event) => event.type), ["hub.delta"]);
  const big = normalizeEvent(grok, { type: "text", data: "x".repeat(4000) }, state);
  assert.ok(big.some((event) => event.type === "hub.delta"));
  const progress = big.find((event) => event.type === "hub.progress");
  assert.match(progress.message, /持续生成中/);
  assert.match(progress.detail, /4005/);
});

test("usage events never pose as progress", () => {
  const events = normalizeEvent(grok, { type: "usage", usage: { input_tokens: 10 } }, {});
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "hub.usage");
  assert.equal(events[0].message, undefined);
});

test("zcode text deltas are volume-tracked like grok", () => {
  const state = {};
  const events = normalizeEvent({ id: "zcode", label: "ZCode" },
    { type: "model.streaming", payload: { kind: "text_delta", delta: "y".repeat(3500) } }, state);
  assert.ok(events.some((event) => event.type === "hub.delta"));
  assert.ok(events.some((event) => event.type === "hub.progress"));
});

test("opencode step lifecycle maps to session, deltas and usage", () => {
  const adapter = { id: "opencode", label: "OpenCode" };
  const state = {};
  const started = normalizeEvent(adapter, { type: "step_start", sessionID: "ses_1", part: {} }, state);
  assert.ok(started.some((event) => event.type === "hub.session"));
  assert.ok(started.some((event) => event.type === "hub.progress"));
  const text = normalizeEvent(adapter, { type: "text", sessionID: "ses_1", part: { type: "text", text: "hello" } }, state);
  assert.ok(text.some((event) => event.type === "hub.delta"));
  const finish = normalizeEvent(adapter, {
    type: "step_finish",
    sessionID: "ses_1",
    part: { reason: "stop", tokens: { total: 100, input: 90, output: 10, reasoning: 5 } },
  }, state);
  const usage = finish.find((event) => event.type === "hub.usage");
  assert.equal(usage.usage.total_tokens, 100);
  assert.equal(usage.usage.reasoning_tokens, 5);
  const failed = normalizeEvent(adapter, {
    type: "step_finish",
    sessionID: "ses_1",
    part: { reason: "error", tokens: {} },
  }, {});
  assert.ok(failed.some((event) => event.type === "hub.error"));
});

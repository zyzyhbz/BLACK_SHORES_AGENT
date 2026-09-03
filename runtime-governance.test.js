const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { JsonlLedger } = require("./organization-core");
const { RuntimeGovernance, loadRuntimePolicy } = require("./runtime-governance");

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "black-shores-governance-"));
  const projectDirectory = path.join(directory, "project");
  fs.mkdirSync(projectDirectory);
  fs.writeFileSync(path.join(projectDirectory, "source.txt"), "before\n", "utf8");
  const ledger = new JsonlLedger(path.join(directory, "ledger.jsonl"), { projectId: "project-test" });
  const governance = new RuntimeGovernance({
    policyPath: path.join(__dirname, "runtime-policy.json"),
    project: { id: "project-test", workingDirectory: projectDirectory },
    ledger,
    backupDirectory: path.join(directory, "backups"),
    traceDirectory: path.join(directory, "traces"),
  });
  return { directory, projectDirectory, ledger, governance };
}

test("runtime policy contains every mandatory action field", () => {
  const policy = loadRuntimePolicy(path.join(__dirname, "runtime-policy.json"));
  assert.equal(policy.controller.displayName, "群星的调律者");
  assert.equal(policy.backup.requiredBeforeMutation, true);
  assert.deepEqual(policy.actionTrace.requiredFields, [
    "actionModel",
    "actionTime",
    "actionObject",
    "actionScope",
    "actionGoal",
    "actionResult",
  ]);
});

test("engineering action creates a pre-action archive and a role JSONL record", async () => {
  const { projectDirectory, ledger, governance } = fixture();
  const action = await governance.begin({
    roleId: "engineering",
    roleName: "工程执行岗",
    missionId: "mission-1",
    runId: "run-1",
    invocationId: "invocation-1",
    adapterId: "codex",
    model: "code-model",
    reasoningEffort: "high",
    goal: "修改 source.txt",
    scope: ["source.txt"],
  });
  assert.ok(action.backupArchive.endsWith(".zip"));
  assert.equal(fs.existsSync(action.backupArchive), true);
  assert.equal(fs.readFileSync(action.backupArchive).subarray(0, 2).toString(), "PK");

  fs.writeFileSync(path.join(projectDirectory, "source.txt"), "after\n", "utf8");
  const record = governance.complete(action, { status: "completed", summary: "修改完成" });
  assert.equal(record.actionModel.model, "code-model");
  assert.equal(record.actionObject.roleId, "engineering");
  assert.equal(record.actionGoal, "修改 source.txt");
  assert.equal(record.actionResult.status, "completed");
  assert.equal(record.actionResult.backupArchive, action.backupArchive);
  assert.equal(governance.status().backup.archiveCount, 1);
  assert.equal(governance.status().backup.latestArchive, action.backupArchive);
  assert.equal(fs.existsSync(record.tracePath), true);
  const persisted = JSON.parse(fs.readFileSync(record.tracePath, "utf8").trim());
  assert.equal(persisted.actionTime.startedAt, action.startedAt);
  assert.equal(persisted.actionScope.declared[0], "source.txt");
  assert.deepEqual(
    ledger.events().filter((event) => event.type.startsWith("action.") || event.type === "role_action.recorded").map((event) => event.type),
    ["action.safeguard_started", "role_action.recorded"],
  );
});

test("read-only roles are traced without creating mutation backups", async () => {
  const { governance } = fixture();
  const action = await governance.begin({
    roleId: "requirements-lead",
    roleName: "需求明确岗",
    missionId: "mission-2",
    runId: "run-2",
    invocationId: "invocation-2",
    adapterId: "vendor",
    model: "analysis-model",
    reasoningEffort: "medium",
    goal: "澄清范围",
    scope: ["只读调查"],
  });
  assert.equal(action.backupArchive, null);
  const record = governance.complete(action, { status: "failed", error: "上游不可用" });
  assert.equal(record.actionResult.status, "failed");
  assert.equal(record.actionResult.error, "上游不可用");
  assert.equal(governance.status().backup.archiveCount, 0);
  assert.equal(governance.status().actionTrace.roleLogCount, 1);
});

test("a completed action can be reverted from its pre-action backup with human confirmation", async () => {
  const { projectDirectory, ledger, governance } = fixture();
  const action = await governance.begin({
    roleId: "engineering",
    roleName: "工程执行岗",
    missionId: "mission-3",
    runId: "run-3",
    invocationId: "invocation-3",
    adapterId: "codex",
    model: "code-model",
    reasoningEffort: "high",
    goal: "修改 source.txt",
    scope: ["source.txt"],
  });
  fs.writeFileSync(path.join(projectDirectory, "source.txt"), "after\n", "utf8");
  fs.writeFileSync(path.join(projectDirectory, "scratch-new.txt"), "new\n", "utf8");
  governance.complete(action, { status: "completed", summary: "修改完成" });
  assert.equal(fs.readFileSync(path.join(projectDirectory, "source.txt"), "utf8"), "after\n");
  assert.throws(() => governance.revertAction(action.id, { reason: "改错了", confirmedBy: "engineering" }), /人类负责人另行确认/);
  const result = governance.revertAction(action.id, {
    reason: "改错了需要回滚",
    confirmedBy: "human-owner",
    paths: ["source.txt", "scratch-new.txt"],
  });
  assert.deepEqual(result.restored, ["source.txt"]);
  assert.deepEqual(result.deleted, ["scratch-new.txt"]);
  assert.equal(fs.readFileSync(path.join(projectDirectory, "source.txt"), "utf8"), "before\n");
  assert.equal(fs.existsSync(path.join(projectDirectory, "scratch-new.txt")), false);
  assert.throws(() => governance.revertAction(action.id, { reason: "再撤一次", confirmedBy: "human-owner", paths: ["source.txt"] }), /已经撤销过/);
  assert.ok(ledger.events().some((event) => event.type === "action.reverted"));
});

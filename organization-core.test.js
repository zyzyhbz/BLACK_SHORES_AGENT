const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  JsonlLedger,
  OrganizationService,
  ROLE_DEFINITIONS,
  extractJsonObject,
} = require("./organization-core");

function tempLedger() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "black-coast-ledger-"));
  return { directory, ledger: new JsonlLedger(path.join(directory, "ledger.jsonl")) };
}

function project(directory) {
  return {
    id: "project-example",
    name: "Example Project",
    workingDirectory: directory,
    repository: "example/project",
  };
}

async function settle(service) {
  let idleTicks = 0;
  while (idleTicks < 3) {
    if (service.activeRuns.size) {
      await Promise.all([...service.activeRuns.values()].map((entry) => entry.task));
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
    idleTicks = service.activeRuns.size ? 0 : idleTicks + 1;
  }
}

test("registers all twelve logical roles with fixed contracts", () => {
  assert.equal(ROLE_DEFINITIONS.length, 12);
  assert.equal(new Set(ROLE_DEFINITIONS.map((role) => role.id)).size, 12);
  assert.equal(ROLE_DEFINITIONS.find((role) => role.id === "evolution-lead").mode, "shadow");
});

test("ledger survives a new process-level reader", () => {
  const { directory, ledger } = tempLedger();
  ledger.append("mission.created", {
    missionId: "mission-1",
    payload: { title: "目标", goal: "一个可以验证的目标" },
  });
  const reopened = new JsonlLedger(path.join(directory, "ledger.jsonl"));
  assert.equal(reopened.events().length, 1);
  assert.equal(reopened.events()[0].missionId, "mission-1");
});

test("corrupt ledger fails closed instead of hiding data", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "black-coast-corrupt-"));
  const file = path.join(directory, "ledger.jsonl");
  fs.writeFileSync(file, "{not-json}\n", "utf8");
  assert.throws(() => new JsonlLedger(file), /账本损坏/);
});

test("role JSON accepts fenced output and rejects prose-only output", () => {
  assert.deepEqual(extractJsonObject("```json\n{\"ok\":true}\n```"), { ok: true });
  assert.throws(() => extractJsonObject("没有结构化结果"), /不包含可读取/);
});

test("a returned role output rejected by the contract is traced distinctly", async () => {
  const { directory, ledger } = tempLedger();
  const outcomes = [];
  const service = new OrganizationService({
    ledger,
    project: project(directory),
    runRole: async () => ({
      output: "没有结构化结果",
      completeAction(outcome) {
        outcomes.push(outcome);
      },
    }),
  });
  service.createMission("调查并修复一个能够稳定复现的页面加载问题");
  await settle(service);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].status, "output_rejected");
  assert.match(outcomes[0].error, /不包含可读取/);
});

test("mission creation fails closed when no AGENT assignment is available", () => {
  const { directory, ledger } = tempLedger();
  const service = new OrganizationService({
    ledger,
    project: project(directory),
    managerAssignment: {
      adapterId: "auto",
      ready: false,
      message: "请先配置至少一个 AGENT",
    },
    runRole: async () => ({ output: "{}" }),
  });
  assert.throws(
    () => service.createMission("处理一个已经描述清楚的任务"),
    /至少一个 AGENT/,
  );
  assert.equal(service.state().missions.length, 0);
});

test("mission starts with requirements role using its configured assignment", async () => {
  const { directory, ledger } = tempLedger();
  const calls = [];
  const service = new OrganizationService({
    ledger,
    project: project(directory),
    managerAssignment: {
      adapterId: "custom-test",
      adapterLabel: "Custom Test",
      model: "vendor/model-a",
      reasoningEffort: "high",
    },
    runRole: async (input) => {
      calls.push(input);
      return {
        output: JSON.stringify({
          readyForBaseline: false,
          message: "还需要确认手机停留状态。",
          knownFacts: [],
          unknowns: ["停留状态"],
          questions: [{ id: "screen", question: "停在哪里？", why: "确定故障层" }],
          baseline: null,
        }),
      };
    },
  });

  const mission = service.createMission("登录完成后页面无法加载，请组织处理");
  assert.equal(mission.status, "clarifying");
  await settle(service);
  const updated = service.mission(mission.id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].role.id, "requirements-lead");
  assert.equal(calls[0].adapterId, "custom-test");
  assert.equal(calls[0].model, "vendor/model-a");
  assert.equal(calls[0].reasoningEffort, "high");
  assert.equal(updated.status, "clarifying");
  assert.match(updated.messages.at(-1).content, /停留状态/);
  assert.equal(updated.workItems.length, 0);
});

test("engineering cannot start until human confirms the baseline", async () => {
  const { directory, ledger } = tempLedger();
  const calls = [];
  const service = new OrganizationService({
    ledger,
    project: project(directory),
    runRole: async (input) => {
      calls.push(input.role.id);
      if (input.role.id === "requirements-lead") {
        return {
          output: JSON.stringify({
            readyForBaseline: true,
            message: "基线草案已形成。",
            questions: [],
            baseline: {
              outcome: "进入工作页面",
              inScope: ["登录后导航"],
              outOfScope: ["无关的视觉改版"],
              acceptanceCriteria: ["用户可进入"],
              testRequirements: ["端到端验证"],
              constraints: ["保留现有会话恢复能力"],
              knownFacts: [],
              openRisks: [],
            },
          }),
        };
      }
      if (input.role.id === "chief-manager") {
        return {
          output: JSON.stringify({
            message: "计划已建立。",
            charter: { outcome: "修复", scope: ["启动"], constraints: [], successEvidence: [], escalationConditions: [] },
            workItems: [
              { title: "实现", ownerRoleId: "engineering", deliverable: "commit", acceptance: [] },
              { title: "复核", ownerRoleId: "independent-reviewer", deliverable: "review", acceptance: [] },
              { title: "测试", ownerRoleId: "tester", deliverable: "tests", acceptance: [] },
            ],
            decisionRequired: false,
            decisionQuestion: "",
          }),
        };
      }
      if (input.role.id === "engineering") {
        return { output: JSON.stringify({ message: "已实现", result: "blocked", next: "测试中停止" }) };
      }
      throw new Error("unexpected role");
    },
  });

  const mission = service.createMission("登录完成后页面无法加载，请组织处理");
  await settle(service);
  assert.equal(service.mission(mission.id).status, "awaiting_baseline_confirmation");
  assert.deepEqual(calls, ["requirements-lead"]);

  service.confirmBaseline(mission.id);
  await settle(service);
  assert.deepEqual(calls.slice(0, 3), ["requirements-lead", "chief-manager", "engineering"]);
  assert.equal(service.mission(mission.id).baseline.status, "confirmed");
});

test("role run failure creates a blocker and never marks completion", async () => {
  const { directory, ledger } = tempLedger();
  const service = new OrganizationService({
    ledger,
    project: project(directory),
    runRole: async () => {
      throw new Error("model unavailable");
    },
  });
  const mission = service.createMission("登录完成后页面无法加载，请组织处理");
  await settle(service);
  const updated = service.mission(mission.id);
  assert.equal(updated.status, "blocked");
  assert.equal(updated.blockers.length, 1);
  assert.match(updated.blockers[0].error, /model unavailable/);
  assert.equal(updated.runs[0].status, "failed");
});

test("review rejection creates engineering rework without rewriting the completed review run as failed", async () => {
  const { directory, ledger } = tempLedger();
  let engineeringRuns = 0;
  const service = new OrganizationService({
    ledger,
    project: project(directory),
    runRole: async ({ role }) => {
      if (role.id === "requirements-lead") {
        return {
          output: JSON.stringify({
            readyForBaseline: true,
            message: "基线已形成",
            questions: [],
            baseline: {
              outcome: "修复对话页",
              inScope: ["启动"],
              outOfScope: [],
              acceptanceCriteria: ["可进入"],
              testRequirements: ["回归"],
              constraints: [],
              knownFacts: [],
              openRisks: [],
            },
          }),
        };
      }
      if (role.id === "chief-manager") {
        return {
          output: JSON.stringify({
            message: "计划完成",
            charter: { outcome: "修复", scope: ["启动"], constraints: [], successEvidence: [], escalationConditions: [] },
            workItems: [
              { title: "实现", ownerRoleId: "engineering", deliverable: "commit", acceptance: [] },
              { title: "复核", ownerRoleId: "independent-reviewer", deliverable: "review", acceptance: [] },
              { title: "测试", ownerRoleId: "tester", deliverable: "tests", acceptance: [] },
            ],
          }),
        };
      }
      if (role.id === "engineering") {
        engineeringRuns += 1;
        return {
          output: JSON.stringify(
            engineeringRuns === 1
              ? { message: "首轮实现", result: "completed", artifacts: ["commit-1"], tests: [] }
              : { message: "返工需要外部条件", result: "blocked", artifacts: [], tests: [], next: "等待依赖" },
          ),
        };
      }
      if (role.id === "independent-reviewer") {
        return {
          output: JSON.stringify({
            message: "发现回归",
            verdict: "changes_required",
            findings: [{ severity: "P1", title: "回归", evidence: "test", requiredChange: "修正" }],
            requirementCoverage: [],
            residualRisks: [],
          }),
        };
      }
      throw new Error(`unexpected role ${role.id}`);
    },
  });

  const mission = service.createMission("修复登录后无法进入工作页面的问题");
  await settle(service);
  service.confirmBaseline(mission.id);
  await settle(service);

  const updated = service.mission(mission.id);
  const reviewRun = updated.runs.find((run) => run.roleId === "independent-reviewer");
  assert.equal(reviewRun.status, "completed");
  assert.equal(updated.workItems.filter((item) => item.kind === "rework").length, 1);
  assert.equal(engineeringRuns, 2);
  assert.equal(updated.status, "blocked");
  assert.equal(
    ledger.events().some(
      (event) => event.type === "run.failed" && event.payload.runId === reviewRun.id,
    ),
    false,
  );
});

test("finite recovery closes the old blocker and counts attempts across retries", async () => {
  const { directory, ledger } = tempLedger();
  const service = new OrganizationService({
    ledger,
    project: project(directory),
    maxRecoveryAttempts: 2,
    runRole: async () => {
      throw new Error("adapter unavailable");
    },
  });
  const mission = service.createMission("修复登录后无法进入工作页面的问题");
  await settle(service);
  service.retry(mission.id);
  await settle(service);
  service.retry(mission.id);
  await settle(service);

  const updated = service.mission(mission.id);
  assert.equal(updated.blockers.filter((item) => item.status === "closed").length, 2);
  assert.equal(updated.blockers.filter((item) => item.status === "open").length, 1);
  assert.deepEqual(
    updated.blockers.filter((item) => item.status === "closed").map((item) => item.attemptNumber),
    [1, 2],
  );
  assert.throws(() => service.retry(mission.id), /恢复预算已耗尽/);
});

test("release source, merge, deployment, external evidence and acceptance are distinct gates", async () => {
  const { directory, ledger } = tempLedger();
  const service = new OrganizationService({
    ledger,
    project: project(directory),
    runRole: async ({ role }) => {
      const outputs = {
        "requirements-lead": {
          readyForBaseline: true,
          message: "基线已形成",
          questions: [],
          baseline: { outcome: "可进入工作页面", inScope: ["导航"], outOfScope: [], acceptanceCriteria: ["可进入"], testRequirements: ["端到端"], constraints: [], knownFacts: [], openRisks: [] },
        },
        "chief-manager": {
          message: "计划完成",
          charter: { outcome: "修复", scope: ["启动"], constraints: [], successEvidence: [], escalationConditions: [] },
          workItems: [
            { title: "实现", ownerRoleId: "engineering", deliverable: "commit", acceptance: [] },
            { title: "复核", ownerRoleId: "independent-reviewer", deliverable: "review", acceptance: [] },
            { title: "测试", ownerRoleId: "tester", deliverable: "tests", acceptance: [] },
          ],
        },
        engineering: { message: "实现完成", result: "completed", artifacts: ["commit-1"], tests: [] },
        "independent-reviewer": { message: "复核通过", verdict: "pass", findings: [], requirementCoverage: [], residualRisks: [] },
        tester: {
          message: "测试通过",
          verdict: "pass",
          candidate: { commit: "b".repeat(40), clean: true },
          runs: [{ testId: "project-regression", level: "unit", result: "passed", evidence: "全部通过" }],
          externalEvidencePackage: { buildIdentity: "pending", steps: [] },
        },
      };
      return { output: JSON.stringify(outputs[role.id]) };
    },
  });
  const mission = service.createMission("修复登录后无法进入工作页面的问题", "heavy");
  await settle(service);
  service.confirmBaseline(mission.id);
  await settle(service);
  assert.equal(service.mission(mission.id).status, "release_candidate_ready");

  service.verifyReleaseSource(mission.id, {
    repository: "example/project",
    workingDirectory: directory,
    sourceRef: "origin/main",
    sourceRefCommit: "a".repeat(40),
    branch: "codex/fix-chat-page",
    headCommit: "b".repeat(40),
    clean: true,
    ahead: 1,
    behind: 0,
    diffStat: "1 file changed",
    projectConfigHashes: {},
  });
  assert.equal(service.mission(mission.id).status, "awaiting_release_approval");
  service.approveMerge(mission.id);
  assert.equal(service.mission(mission.id).status, "awaiting_release_approval");
  service.approveDeployment(mission.id);
  assert.equal(service.mission(mission.id).status, "awaiting_external_evidence");
  service.recordExternalEvidence(mission.id, {
    buildIdentity: "release-2026-09-03-01",
    result: "passed",
    notes: "外部验收环境通过",
  });
  assert.equal(service.mission(mission.id).status, "awaiting_result_acceptance");
  service.acceptResult(mission.id);

  const accepted = service.mission(mission.id);
  assert.equal(accepted.status, "accepted");
  assert.deepEqual(
    accepted.approvals.filter((item) => item.candidateId).map((item) => item.kind),
    ["merge_approval", "deployment_approval", "result_acceptance"],
  );
  assert.equal(accepted.externalEvidence[0].candidateDigest, accepted.releaseCandidate.digest);
});

test("illegal state jumps are rejected", () => {
  const { directory, ledger } = tempLedger();
  ledger.append("mission.created", {
    missionId: "mission-illegal",
    payload: { title: "目标", goal: "一个明确可验证的目标" },
  });
  const service = new OrganizationService({
    ledger,
    project: project(directory),
    runRole: async () => ({ output: "{}" }),
  });
  assert.throws(() => service._setStatus("mission-illegal", "accepted", "跳过全部门禁"), /非法状态跳转/);
});

test("startup resumes an interrupted physical invocation inside the same logical run", async () => {
  const { directory, ledger } = tempLedger();
  ledger.append("mission.created", {
    missionId: "mission-restart",
    payload: { title: "目标", goal: "一个明确可验证的目标" },
  });
  ledger.append("mission.status_changed", {
    missionId: "mission-restart",
    payload: { from: "intake", to: "clarifying", reason: "需求澄清" },
  });
  ledger.append("run.started", {
    missionId: "mission-restart",
    actorRoleId: "requirements-lead",
    payload: { runId: "run-interrupted", roleId: "requirements-lead", roleName: "需求明确岗" },
  });
  const service = new OrganizationService({
    ledger,
    project: project(directory),
    runRole: async () => ({
      output: JSON.stringify({
        readyForBaseline: false,
        message: "已从账本恢复需求现场",
        questions: [{ id: "resume", question: "请继续补充", why: "完成需求" }],
      }),
    }),
  });
  await settle(service);
  const resumed = service.mission("mission-restart");
  assert.equal(resumed.status, "clarifying");
  assert.equal(resumed.blockers.length, 0);
  assert.equal(resumed.runs.length, 1);
  assert.equal(resumed.runs[0].status, "completed");
  assert.equal(resumed.runs[0].invocations.length, 1);
  assert.equal(resumed.runs[0].invocations[0].resumed, true);
  assert.equal(ledger.events().filter((event) => event.type === "physical_invocation.interrupted").length, 1);

  const reopened = new OrganizationService({
    ledger: new JsonlLedger(ledger.filePath),
    project: project(directory),
    runRole: async () => ({ output: "{}" }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reopened.mission("mission-restart").runs.length, 1);
  assert.equal(reopened.mission("mission-restart").blockers.length, 0);
});

test("light workflow stops after independent trace review and records ChangeRecord", async () => {
  const { directory, ledger } = tempLedger();
  const calls = [];
  const service = new OrganizationService({
    ledger,
    project: project(directory),
    runRole: async ({ role, onActivity }) => {
      calls.push(role.id);
      onActivity?.({ type: "hub.progress", message: `${role.name}正在工作` });
      const outputs = {
        "requirements-lead": {
          readyForBaseline: true,
          message: "基线已形成",
          questions: [],
          baseline: { outcome: "按钮文案更新", inScope: ["按钮"], outOfScope: [], acceptanceCriteria: ["文案正确"], testRequirements: ["目标检查"], constraints: [], knownFacts: [], openRisks: [] },
        },
        "chief-manager": {
          message: "轻度计划完成",
          charter: { outcome: "更新文案", scope: ["按钮"], constraints: [], successEvidence: [], escalationConditions: [] },
          workItems: [
            { title: "实现与自测", ownerRoleId: "engineering", deliverable: "commit", acceptance: [] },
            { title: "留痕复核", ownerRoleId: "independent-reviewer", deliverable: "ChangeRecord", acceptance: [] },
          ],
        },
        engineering: { message: "实现完成", result: "completed", changes: ["修改按钮文案"], artifacts: ["commit-1"], tests: [{ command: "targeted", result: "passed" }], risks: [] },
        "independent-reviewer": { message: "留痕真实完整", verdict: "pass", findings: [], requirementCoverage: [], residualRisks: [] },
      };
      if (!outputs[role.id]) throw new Error(`unexpected role ${role.id}`);
      return { output: JSON.stringify(outputs[role.id]) };
    },
  });

  const mission = service.createMission("更新兑换按钮的提示文案并留下完整记录", "light");
  await settle(service);
  service.confirmBaseline(mission.id);
  await settle(service);
  const completed = service.mission(mission.id);
  assert.deepEqual(calls, ["requirements-lead", "chief-manager", "engineering", "independent-reviewer"]);
  assert.equal(completed.status, "light_completed");
  assert.equal(completed.changeRecords.length, 1);
  assert.equal(completed.changeRecords[0].fullFunctionalVerification, false);
  assert.equal(completed.testRuns.length, 0);
  assert.equal(completed.verifiedBaselines.length, 0);
  assert.equal(completed.releaseCandidate, null);
  assert.ok(completed.runs.every((run) => run.lastHeartbeatAt && run.lastCheckpointAt));
});

test("heavy workflow binds all required project tests to a VerifiedBaseline", async () => {
  const { directory, ledger } = tempLedger();
  const testManifest = {
    id: "ptm-test-project",
    version: "7",
    requiredTests: [
      { id: "unit-all", name: "全部单测", level: "unit" },
      { id: "environment-preflight", name: "外部环境预检", level: "preflight" },
    ],
  };
  const service = new OrganizationService({
    ledger,
    project: { ...project(directory), testManifest },
    runRole: async ({ role }) => {
      const outputs = {
        "requirements-lead": { readyForBaseline: true, message: "基线", questions: [], baseline: { outcome: "发布候选", inScope: ["发布"], outOfScope: [], acceptanceCriteria: ["功能通过"], testRequirements: ["全量"], constraints: [], knownFacts: [], openRisks: [] } },
        "chief-manager": { message: "重度计划", charter: { outcome: "发布", scope: ["全部"], constraints: [], successEvidence: [], escalationConditions: [] }, workItems: [
          { title: "实现", ownerRoleId: "engineering", deliverable: "commit", acceptance: [] },
          { title: "复核", ownerRoleId: "independent-reviewer", deliverable: "review", acceptance: [] },
          { title: "全量测试", ownerRoleId: "tester", deliverable: "baseline", acceptance: [] },
        ] },
        engineering: { message: "实现", result: "completed", artifacts: ["abcdef1234567890"], tests: [] },
        "independent-reviewer": { message: "通过", verdict: "pass", findings: [], requirementCoverage: [], residualRisks: [] },
        tester: { message: "全量通过", verdict: "pass", candidate: { commit: "abcdef1234567890", clean: true }, runs: [
          { testId: "unit-all", result: "passed", evidence: "ok" },
          { testId: "environment-preflight", result: "passed", evidence: "ok" },
        ], externalEvidencePackage: { buildIdentity: "pending", steps: [] } },
      };
      return { output: JSON.stringify(outputs[role.id]) };
    },
  });
  const mission = service.createMission("准备一个需要全量验证的发布候选", "heavy");
  await settle(service);
  service.confirmBaseline(mission.id);
  await settle(service);
  const verified = service.mission(mission.id);
  assert.equal(verified.status, "release_candidate_ready");
  assert.equal(verified.verifiedBaselines.length, 1);
  assert.equal(verified.verifiedBaselines[0].projectTestManifestVersion, "7");
  assert.equal(verified.releaseCandidate.verifiedBaselineId, verified.verifiedBaselines[0].id);
});

test("heavy failures open GapCases and can keep reworking until a new candidate passes", async () => {
  const { directory, ledger } = tempLedger();
  let testAttempts = 0;
  const service = new OrganizationService({
    ledger,
    project: project(directory),
    maxReworkCycles: 1,
    runRole: async ({ role }) => {
      if (role.id === "requirements-lead") return { output: JSON.stringify({ readyForBaseline: true, message: "基线", questions: [], baseline: { outcome: "恢复功能", inScope: ["功能"], outOfScope: [], acceptanceCriteria: ["全量通过"], testRequirements: ["回归"], constraints: [], knownFacts: [], openRisks: [] } }) };
      if (role.id === "chief-manager") return { output: JSON.stringify({ message: "计划", charter: { outcome: "恢复", scope: ["功能"], constraints: [], successEvidence: [], escalationConditions: [] }, workItems: [
        { title: "实现", ownerRoleId: "engineering", deliverable: "commit", acceptance: [] },
        { title: "复核", ownerRoleId: "independent-reviewer", deliverable: "review", acceptance: [] },
        { title: "测试", ownerRoleId: "tester", deliverable: "baseline", acceptance: [] },
      ] }) };
      if (role.id === "engineering") return { output: JSON.stringify({ message: "修复候选", result: "completed", artifacts: [`candidate-${testAttempts}`], tests: [] }) };
      if (role.id === "independent-reviewer") return { output: JSON.stringify({ message: "复核通过", verdict: "pass", findings: [], requirementCoverage: [], residualRisks: [] }) };
      testAttempts += 1;
      const passed = testAttempts === 4;
      return { output: JSON.stringify({
        message: passed ? "功能恢复" : "用户功能仍失败",
        verdict: passed ? "pass" : "fail",
        candidate: { commit: `abcdef${testAttempts}234567890`, clean: true },
        runs: [{ testId: "project-regression", result: passed ? "passed" : "failed", evidence: `attempt-${testAttempts}` }],
        externalEvidencePackage: { buildIdentity: "pending", steps: [] },
      }) };
    },
  });
  const mission = service.createMission("修复发布回归并完成全量验证", "heavy");
  await settle(service);
  service.confirmBaseline(mission.id);
  await settle(service);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await settle(service);
  const completed = service.mission(mission.id);
  assert.equal(testAttempts, 4);
  assert.equal(completed.status, "release_candidate_ready");
  assert.equal(completed.workItems.filter((item) => item.kind === "rework").length, 3);
  assert.equal(completed.gapCases.length, 3);
  assert.ok(completed.gapCases.every((item) => item.status === "closed"));
  assert.equal(completed.verifiedBaselines.length, 1);
});

test("natural-language command bus records commands and controls workflow profile", async () => {
  const { directory, ledger } = tempLedger();
  const service = new OrganizationService({
    ledger,
    project: project(directory),
    runRole: async () => ({ output: JSON.stringify({ readyForBaseline: false, message: "请补充", questions: [] }) }),
  });
  const created = service.executeCommand({ content: "使用轻度模式，修复设置页的一处局部文案问题" });
  assert.equal(created.action, "create_mission");
  assert.equal(created.mission.workflowProfile.resolved, "light");
  await settle(service);
  const queried = service.executeCommand({ content: "查看当前任务状态", missionId: created.mission.id });
  assert.equal(queried.action, "query_status");
  assert.equal(ledger.events().filter((event) => event.type === "command.requested").length, 2);
  assert.equal(ledger.events().filter((event) => event.type === "command.executed").length, 2);
});

test("global tuner context stays independent from a blocked Mission", async () => {
  const { directory, ledger } = tempLedger();
  const service = new OrganizationService({
    ledger,
    project: project(directory),
    runRole: async () => {
      throw new Error("model unavailable");
    },
  });

  const blockedMission = service.createMission("调查一个会阻塞的旧任务并保留现场");
  assert.throws(
    () => service.executeCommand({
      content: "在旧任务仍运行时启动另一个目标",
      channel: "tuner-chat",
      context: "global",
    }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.missionId, blockedMission.id);
      assert.match(error.message, new RegExp(blockedMission.id));
      return true;
    },
  );
  await settle(service);
  assert.equal(service.mission(blockedMission.id).status, "blocked");

  const globalStatus = service.executeCommand({
    content: "查看当前任务状态",
    channel: "tuner-chat",
    context: "global",
  });
  assert.equal(globalStatus.action, "query_organization_status");
  assert.equal(globalStatus.mission, null);
  assert.match(globalStatus.reply, /1 个 Mission.*1 个阻塞/);

  const missionStatus = service.executeCommand({
    content: "查看当前任务状态",
    missionId: blockedMission.id,
    channel: "local-workbench",
  });
  assert.equal(missionStatus.action, "query_status");
  assert.equal(missionStatus.mission.id, blockedMission.id);
  assert.equal(missionStatus.mission.status, "blocked");

  const newMission = service.executeCommand({
    content: "处理一个与旧阻塞任务无关的新目标",
    channel: "tuner-chat",
    context: "global",
  });
  assert.equal(newMission.action, "create_mission");
  assert.notEqual(newMission.mission.id, blockedMission.id);
  assert.equal(service.state().missions.length, 2);
  await settle(service);

  const tunerRequests = ledger.events().filter(
    (event) => event.type === "command.requested" && event.payload.channel === "tuner-chat",
  );
  assert.ok(tunerRequests.every((event) => event.payload.context === "global"));
  assert.ok(tunerRequests.every((event) => event.missionId === null));
});

test("safe pause preserves the logical run and resume creates a new physical invocation", async () => {
  const { directory, ledger } = tempLedger();
  let invocationCount = 0;
  const service = new OrganizationService({
    ledger,
    project: project(directory),
    runRole: async ({ signal }) => {
      invocationCount += 1;
      if (invocationCount === 1) {
        await new Promise((resolve, reject) => {
          const stop = () => reject(Object.assign(new Error("paused by owner"), { code: "SAFE_PAUSE" }));
          if (signal.aborted) stop();
          else signal.addEventListener("abort", stop, { once: true });
        });
      }
      return {
        output: JSON.stringify({
          readyForBaseline: false,
          message: "已从暂停检查点继续需求整理",
          questions: [],
        }),
      };
    },
  });

  const mission = service.createMission("验证活动任务能够安全暂停并继续运行");
  const firstTask = service.activeRuns.get(mission.id).task;
  const paused = service.executeCommand({
    content: "安全暂停任务",
    channel: "tuner-chat",
    context: "global",
  });
  assert.equal(paused.action, "pause_requested");
  assert.equal(paused.mission.id, mission.id);
  await firstTask;

  const waiting = service.mission(mission.id);
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.blockers.length, 0);
  assert.equal(waiting.runs.length, 1);
  assert.equal(waiting.runs[0].status, "paused");
  assert.equal(waiting.runs[0].invocations[0].status, "interrupted");

  const resumed = service.resumePaused(mission.id);
  assert.equal(resumed.runs.length, 1);
  await settle(service);
  const completed = service.mission(mission.id);
  assert.equal(completed.status, "clarifying");
  assert.equal(completed.runs.length, 1);
  assert.equal(completed.runs[0].status, "completed");
  assert.equal(completed.runs[0].invocations.length, 2);
  assert.equal(completed.runs[0].invocations[1].resumed, true);
  assert.equal(ledger.events().filter((event) => event.type === "run.pause_requested").length, 1);
  assert.equal(ledger.events().filter((event) => event.type === "run.paused").length, 1);
  assert.equal(ledger.events().filter((event) => event.type === "run.resume_requested").length, 1);
});

test("a paused Mission can return to requirements clarification with a new instruction", async () => {
  const { directory, ledger } = tempLedger();
  ledger.append("mission.created", {
    missionId: "mission-paused-revision",
    payload: { title: "暂停中的任务", goal: "实现一个需要中途修改的完整功能", workflowProfile: "light" },
  });
  ledger.append("mission.status_changed", {
    missionId: "mission-paused-revision",
    payload: { from: "intake", to: "clarifying", reason: "开始澄清" },
  });
  ledger.append("run.started", {
    missionId: "mission-paused-revision",
    actorRoleId: "requirements-lead",
    payload: { runId: "run-paused", roleId: "requirements-lead", roleName: "需求明确岗" },
  });
  ledger.append("run.paused", {
    missionId: "mission-paused-revision",
    actorRoleId: "requirements-lead",
    payload: { runId: "run-paused", reason: "人类请求安全暂停" },
  });
  ledger.append("mission.status_changed", {
    missionId: "mission-paused-revision",
    payload: { from: "clarifying", to: "waiting", reason: "等待修改" },
  });
  const service = new OrganizationService({
    ledger,
    project: project(directory),
    runRole: async () => ({
      output: JSON.stringify({ readyForBaseline: false, message: "已按新要求重新整理", questions: [] }),
    }),
  });

  const revised = service.executeCommand({
    content: "调整需求：保留现有数据并缩小改动范围",
    missionId: "mission-paused-revision",
  });
  assert.equal(revised.action, "revise_requirements");
  assert.equal(revised.mission.status, "clarifying");
  assert.equal(ledger.events().filter((event) => event.type === "requirements_revision.requested").length, 1);
  await settle(service);
  assert.match(service.mission("mission-paused-revision").messages.at(-1).content, /新要求/);
});

test("available actions disable unrelated Mission controls while another Run is active", async () => {
  const { directory, ledger } = tempLedger();
  ledger.append("mission.created", {
    missionId: "mission-release-waiting",
    payload: { title: "待验收任务", goal: "验证跨 Mission 控制隔离保持一致", workflowProfile: "heavy" },
  });
  ledger.append("mission.status_changed", {
    missionId: "mission-release-waiting",
    payload: { from: "intake", to: "awaiting_result_acceptance", reason: "等待验收" },
  });
  const service = new OrganizationService({
    ledger,
    project: project(directory),
    runRole: async ({ signal }) => new Promise((resolve, reject) => {
      const stop = () => reject(Object.assign(new Error("paused"), { code: "SAFE_PAUSE" }));
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
    }),
  });
  const activeMission = service.createMission("启动另一个持续运行的任务用于验证控制隔离");
  const activeTask = service.activeRuns.get(activeMission.id).task;

  const state = service.state();
  assert.equal(state.controls.canCreateMission, false);
  assert.deepEqual(
    state.missions.find((mission) => mission.id === "mission-release-waiting").availableActions,
    ["query-status"],
  );
  assert.ok(state.missions.find((mission) => mission.id === activeMission.id).availableActions.includes("pause"));
  assert.throws(
    () => service.acceptResult("mission-release-waiting"),
    /另一个 Mission 正在执行/,
  );

  service.requestSafePause(activeMission.id);
  await activeTask;
});

test("auto workflow profile explains deterministic light and heavy selections", async () => {
  const first = tempLedger();
  const lightService = new OrganizationService({ ledger: first.ledger, project: project(first.directory), runRole: async () => ({ output: JSON.stringify({ readyForBaseline: false, message: "等待", questions: [] }) }) });
  const light = lightService.createMission("修正本地帮助文字的一个错别字");
  assert.equal(light.workflowProfile.resolved, "light");
  assert.match(light.workflowProfile.reason, /轻度/);
  await settle(lightService);

  const second = tempLedger();
  const heavyService = new OrganizationService({ ledger: second.ledger, project: project(second.directory), runRole: async () => ({ output: JSON.stringify({ readyForBaseline: false, message: "等待", questions: [] }) }) });
  const heavy = heavyService.createMission("准备部署新的生产版本");
  assert.equal(heavy.workflowProfile.resolved, "heavy");
  assert.match(heavy.workflowProfile.reason, /部署|生产/);
  await settle(heavyService);
});

test("human gates automatically open a decision request with object version", async () => {
  const { directory, ledger } = tempLedger();
  const service = new OrganizationService({
    ledger,
    project: project(directory),
    runRole: async () => ({
      output: JSON.stringify({
        readyForBaseline: true,
        message: "基线草案已形成。",
        questions: [],
        baseline: {
          outcome: "进入工作页面",
          inScope: ["登录后导航"],
          outOfScope: [],
          acceptanceCriteria: ["用户可进入"],
          testRequirements: ["端到端验证"],
          constraints: [],
          knownFacts: [],
          openRisks: [],
        },
      }),
    }),
  });
  const mission = service.createMission("登录完成后页面无法加载，请组织处理");
  await settle(service);
  const updated = service.mission(mission.id);
  assert.equal(updated.status, "awaiting_baseline_confirmation");
  assert.equal(updated.decisions.length, 1);
  assert.equal(updated.decisions[0].status, "open");
  assert.equal(updated.decisions[0].kind, "baseline_confirmation");
  assert.match(updated.decisions[0].objectVersion, /-v1$/);
  assert.ok(updated.availableActions.includes("decide"));
});

test("only the human owner can resolve a decision, and it closes exactly once", async () => {
  const { directory, ledger } = tempLedger();
  const service = new OrganizationService({
    ledger,
    project: project(directory),
    runRole: async () => ({ output: JSON.stringify({ readyForBaseline: false, message: "等待", questions: [] }) }),
  });
  const mission = service.createMission("整理一份面向人类的发布说明文档");
  await settle(service);
  const created = service.requestDecision(mission.id, {
    title: "是否扩大本次发布范围",
    kind: "scope",
    options: ["保持范围", "扩大范围"],
    urgency: "high",
  });
  const decisionId = created.decisions.at(-1).id;
  assert.throws(() => service.resolveDecision(mission.id, decisionId, { resolution: "approved", decidedBy: "chief-manager" }), /只有人类负责人/);
  assert.throws(() => service.resolveDecision(mission.id, decisionId, { resolution: "maybe", decidedBy: "human-owner" }), /批准、驳回或暂缓/);
  const resolved = service.resolveDecision(mission.id, decisionId, { resolution: "approved", decidedBy: "human-owner", note: "同意保持范围" });
  assert.equal(resolved.decisions.find((item) => item.id === decisionId).status, "approved");
  assert.throws(() => service.resolveDecision(mission.id, decisionId, { resolution: "rejected", decidedBy: "human-owner" }), /不存在或已处理/);
});

test("emergency override requires explicit gates and opens a linked risk debt", async () => {
  const { directory, ledger } = tempLedger();
  const service = new OrganizationService({
    ledger,
    project: project(directory),
    runRole: async () => ({ output: JSON.stringify({ readyForBaseline: false, message: "等待", questions: [] }) }),
  });
  const mission = service.createMission("修复一个导致发布阻塞的线上缺陷");
  await settle(service);
  assert.throws(() => service.grantOverride(mission.id, {
    decidedBy: "chief-manager", overriddenGates: ["test"], reason: "着急", risk: "有风险", expiresAt: new Date(Date.now() + 3600000).toISOString(),
  }), /只有人类负责人/);
  assert.throws(() => service.grantOverride(mission.id, {
    decidedBy: "human-owner", overriddenGates: [], reason: "着急发布", risk: "可能回归", expiresAt: new Date(Date.now() + 3600000).toISOString(),
  }), /明确列出/);
  const updated = service.grantOverride(mission.id, {
    decidedBy: "human-owner",
    overriddenGates: ["模拟器全量测试"],
    reason: "线上事故止血",
    risk: "可能漏过回归缺陷",
    allowedActions: ["approve-deployment"],
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  assert.equal(updated.overrides.length, 1);
  assert.equal(updated.overrides[0].status, "active");
  assert.equal(updated.riskDebts.length, 1);
  assert.equal(updated.riskDebts[0].status, "open");
  assert.equal(updated.riskDebts[0].linkedOverrideId, updated.overrides[0].id);
  const expired = service.expireOverride(mission.id, updated.overrides[0].id);
  assert.equal(expired.overrides[0].status, "expired");
  const closed = service.closeRiskDebt(mission.id, updated.riskDebts[0].id, { resolution: "已补测并复盘" });
  assert.equal(closed.riskDebts[0].status, "closed");
});

test("cancel ends a waiting mission and emergency stop blocks an active run", async () => {
  const { directory, ledger } = tempLedger();
  const service = new OrganizationService({
    ledger,
    project: project(directory),
    runRole: async ({ signal }) => new Promise((resolve, reject) => {
      const stop = () => reject(Object.assign(new Error("stopped by owner"), { code: "STOP" }));
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
    }),
  });
  const mission = service.createMission("验证取消与紧急停止语义互相区分");
  const firstTask = service.activeRuns.get(mission.id).task;
  const stopped = service.emergencyStop(mission.id, { reason: "测试紧急停止" });
  assert.ok(stopped);
  await firstTask;
  const blocked = service.mission(mission.id);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.runs[0].status, "stopped");
  assert.equal(blocked.blockers.at(-1).category, "emergency_stop");
  const cancelled = service.cancelMission(mission.id, { reason: "测试取消" });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.cancellations.length, 1);
  assert.throws(() => service.cancelMission(mission.id, {}), /已终结/);
});

test("stale-generation outputs are traced but never advance the new baseline", async () => {
  const { directory, ledger } = tempLedger();
  const service = new OrganizationService({
    ledger,
    project: project(directory),
    runRole: async () => ({
      output: JSON.stringify({
        readyForBaseline: true,
        message: "旧世代基线",
        questions: [],
        baseline: {
          outcome: "旧目标", inScope: ["旧范围"], outOfScope: [],
          acceptanceCriteria: ["旧标准"], testRequirements: [], constraints: [], knownFacts: [], openRisks: [],
        },
      }),
    }),
  });
  const mission = service.createMission("验证旧世代迟到输出隔离");
  assert.equal(service.mission(mission.id).revision, 1);
  ledger.append("mission.revision_incremented", {
    missionId: mission.id,
    actorRoleId: "human-owner",
    payload: { revision: 2, reason: "测试递增世代" },
  });
  await settle(service);
  const updated = service.mission(mission.id);
  assert.equal(updated.revision, 2);
  assert.equal(updated.runs[0].status, "superseded");
  assert.equal(updated.baseline, null);
  assert.ok(ledger.events().some((event) => event.type === "run.output_rejected"));
});

test("decision cases separate divergence, deliberation and the owner decision", async () => {
  const { directory, ledger } = tempLedger();
  const service = new OrganizationService({
    ledger,
    project: project(directory),
    runRole: async () => ({ output: JSON.stringify({ readyForBaseline: false, message: "等待", questions: [] }) }),
  });
  const mission = service.createMission("验证发散审议决定分离");
  await settle(service);
  assert.throws(() => service.openDecisionCase(mission.id, { title: "选择缓存方案" }), /DecisionOwner/);
  const opened = service.openDecisionCase(mission.id, { title: "选择缓存方案", context: "读多写少", ownerRoleId: "human-owner" });
  const caseId = opened.decisionCases.at(-1).id;
  assert.throws(() => service.recordIdeaSet(mission.id, { decisionCaseId: caseId, clusters: [] }), /实质不同/);
  service.recordIdeaSet(mission.id, { decisionCaseId: caseId, problem: "缓存", clusters: ["本地缓存", "集中式缓存"], extremeOptions: ["无缓存"] });
  assert.throws(() => service.recordDecisionBrief(mission.id, { decisionCaseId: caseId, candidates: ["本地缓存"] }), /少数意见/);
  service.recordDecisionBrief(mission.id, {
    decisionCaseId: caseId,
    candidates: ["本地缓存", "集中式缓存"],
    recommendation: "本地缓存",
    minorityOpinions: ["集中式更易观测"],
  });
  assert.throws(() => service.decideCase(mission.id, caseId, { decision: "采用本地缓存", decidedBy: "chief-manager" }), /决定权属于/);
  const decided = service.decideCase(mission.id, caseId, { decision: "采用本地缓存", decidedBy: "human-owner" });
  assert.equal(decided.decisionCases.find((item) => item.id === caseId).status, "decided");
});

test("role dispatch respects operating modes and blocker activation", async () => {
  const { directory, ledger } = tempLedger();
  ledger.append("mission.created", {
    missionId: "mission-modes",
    payload: { title: "模式门控任务", goal: "验证运行模式门控", workflowProfile: "light" },
  });
  ledger.append("mission.status_changed", {
    missionId: "mission-modes",
    payload: { from: "intake", to: "clarifying", reason: "开始澄清" },
  });
  const service = new OrganizationService({
    ledger,
    project: project(directory),
    runRole: async ({ signal }) => new Promise((resolve, reject) => {
      const stop = () => reject(Object.assign(new Error("paused"), { code: "SAFE_PAUSE" }));
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
    }),
  });
  assert.throws(() => service._queueRoleRun("mission-modes", "evolution-lead", () => "", () => {}), /shadow 模式/);
  assert.throws(() => service._queueRoleRun("mission-modes", "creator", () => "", () => {}), /条件认知角色/);
  assert.throws(() => service._queueRoleRun("mission-modes", "blocker-lead", () => "", () => {}), /BlockerCase/);
  assert.throws(() => service._queueRoleRun("mission-modes", "ghost-role", () => "", () => {}), /未知角色/);
  service.openDecisionCase("mission-modes", { title: "开放问题", ownerRoleId: "human-owner" });
  service._queueRoleRun("mission-modes", "creator", () => "提示", () => {});
  assert.ok(service.activeRuns.has("mission-modes"));
  service.requestSafePause("mission-modes");
  await service.activeRuns.get("mission-modes").task;
});

test("evolution proposals and skills stay advisory until humans decide", async () => {
  const { directory, ledger } = tempLedger();
  const service = new OrganizationService({
    ledger,
    project: project(directory),
    runRole: async () => ({ output: JSON.stringify({ readyForBaseline: false, message: "等待", questions: [] }) }),
  });
  const mission = service.createMission("验证演进与技能生命周期");
  await settle(service);
  assert.throws(() => service.submitEvolutionProposal(mission.id, { problem: "太短", hypothesis: "x" }), /可证伪假设/);
  const proposed = service.submitEvolutionProposal(mission.id, {
    problem: "复核经常漏掉鉴权变更",
    evidence: "近三次复核记录",
    hypothesis: "鉴权检查表可复用",
    rollback: "删除检查表文件",
  });
  const proposalId = proposed.evolutionProposals.at(-1).id;
  assert.throws(() => service.decideEvolutionProposal(mission.id, proposalId, { decision: "approved", decidedBy: "evolution-lead" }), /人类负责人/);
  const decided = service.decideEvolutionProposal(mission.id, proposalId, { decision: "approved", decidedBy: "human-owner" });
  assert.equal(decided.evolutionProposals.at(-1).status, "approved");
  const skilled = service.recordSkillCandidate(mission.id, { name: "鉴权复核表", source: "复核记录" });
  const skillId = skilled.skills.at(-1).id;
  assert.throws(() => service.decideSkill(mission.id, skillId, { decision: "published", decidedBy: "engineering" }), /信息与技能管理岗/);
  const published = service.decideSkill(mission.id, skillId, { decision: "published", decidedBy: "human-owner", version: "1.1.0" });
  assert.equal(published.skills.at(-1).status, "published");
});

test("assignment changes take snapshots that later runs carry", async () => {
  const { directory, ledger } = tempLedger();
  const service = new OrganizationService({
    ledger,
    project: project(directory),
    runRole: async () => ({ output: JSON.stringify({ readyForBaseline: false, message: "等待", questions: [] }) }),
  });
  const updated = service.setAssignments({
    managerAssignment: { adapterId: "codex", model: "m", reasoningEffort: "high", ready: true },
    roleAssignments: {},
  });
  assert.equal(updated.assignmentSnapshots.length, 1);
  const mission = service.createMission("验证任职快照跟随");
  await settle(service);
  const run = service.mission(mission.id).runs[0];
  assert.equal(run.assignmentSnapshotId, updated.assignmentSnapshots[0].id);
});

test("due light deliveries can be started in bulk for heavy review", async () => {
  const { directory, ledger } = tempLedger();
  ledger.append("mission.created", {
    missionId: "mission-light-done",
    payload: { title: "轻度完成任务", goal: "验证自动重度回顾评估", workflowProfile: "light" },
  });
  for (const status of ["clarifying", "awaiting_baseline_confirmation", "planning", "executing", "awaiting_review"]) {
    ledger.append("mission.status_changed", { missionId: "mission-light-done", payload: { from: "intake", to: status, reason: "推进" } });
  }
  ledger.append("mission.status_changed", { missionId: "mission-light-done", payload: { from: "awaiting_review", to: "light_completed", reason: "轻度交付" } });
  for (let index = 0; index < 5; index += 1) {
    ledger.append("change_record.recorded", { missionId: "mission-light-done", payload: { id: `change-${index}`, summary: `变更 ${index}` } });
  }
  const service = new OrganizationService({
    ledger,
    project: project(directory),
    runRole: async () => ({ output: JSON.stringify({ message: "测试", verdict: "pass", candidate: { commit: "abc", clean: true }, runs: [], externalEvidencePackage: { buildIdentity: "x", preconditions: [], steps: [], uncoveredRisks: [] } }) }),
  });
  const evaluation = service.evaluateAutoReview("mission-light-done");
  assert.equal(evaluation.triggered, true);
  assert.match(evaluation.reasons.join(""), /阈值/);
  const result = service.autoStartDueReviews();
  assert.deepEqual(result.started, ["mission-light-done"]);
});

test("roles receive versioned contracts plus dedicated retrieval views", async () => {
  const { retrievalFocusFor, ideaClusterSimilarity } = require("./organization-core");
  assert.ok(retrievalFocusFor("tester").includes("manifest"));
  assert.ok(retrievalFocusFor("unknown-role").includes("goal"));
  assert.equal(ideaClusterSimilarity("本地缓存方案", "本地缓存方案"), 1);
  assert.ok(ideaClusterSimilarity("本地缓存方案", "集中式远端缓存集群") < 0.8);
  const { directory, ledger } = tempLedger();
  const service = new OrganizationService({
    ledger,
    project: project(directory),
    runRole: async () => ({ output: JSON.stringify({ readyForBaseline: false, message: "等待", questions: [] }) }),
  });
  const mission = service.createMission("验证角色检索视图");
  await settle(service);
  const opened = service.openDecisionCase(mission.id, { title: "视图验证事项", ownerRoleId: "human-owner" });
  const caseId = opened.decisionCases.at(-1).id;
  assert.throws(() => service.recordIdeaSet(mission.id, {
    decisionCaseId: caseId,
    clusters: ["本地缓存方案", "本地缓存方案"],
  }), /同义/);
  assert.throws(() => service.decideCase(mission.id, caseId, { decision: "直接决定", decidedBy: "human-owner" }), /DecisionBrief/);
});

test("override never rewrites failure and every entity carries a project id", async () => {
  const { directory, ledger } = tempLedger();
  const service = new OrganizationService({
    ledger,
    project: project(directory),
    runRole: async () => { throw new Error("model unavailable"); },
  });
  const mission = service.createMission("验证绕过不改写失败");
  await settle(service);
  assert.equal(service.mission(mission.id).status, "blocked");
  const updated = service.grantOverride(mission.id, {
    decidedBy: "human-owner",
    overriddenGates: ["自动化回归"],
    reason: "线上事故止血",
    risk: "可能漏过回归缺陷",
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  assert.equal(updated.status, "blocked");
  assert.ok(updated.blockers.some((item) => item.status === "open"));
  assert.equal(updated.riskDebts.length, 1);
  const state = service.state();
  assert.ok(state.missions.every((item) => typeof item.projectId === "string" && item.projectId.length > 0));
  const direct = service.requestDecision(mission.id, { title: "直报验证", directReport: true });
  assert.equal(direct.decisions.at(-1).directReport, true);
});

test("command bus stops, cancels and guards assignment switches", async () => {  const { directory, ledger } = tempLedger();
  const service = new OrganizationService({
    ledger,
    project: project(directory),
    runRole: async ({ signal }) => new Promise((resolve, reject) => {
      if (signal.aborted) reject(Object.assign(new Error("stopped"), { code: "STOP" }));
      else signal.addEventListener("abort", () => reject(Object.assign(new Error("stopped"), { code: "STOP" })), { once: true });
    }),
  });
  const mission = service.createMission("验证命令总线急停与取消");
  assert.throws(() => service.setAssignments({
    managerAssignment: { adapterId: "codex", model: "m", reasoningEffort: "high", ready: true },
    roleAssignments: {},
  }), /安全暂停/);
  const stopped = service.executeCommand({ content: "紧急停止", missionId: mission.id });
  assert.equal(stopped.action, "emergency_stopped");
  await service.activeRuns.get(mission.id).task;
  assert.equal(service.mission(mission.id).status, "blocked");
  const cancelled = service.executeCommand({ content: "确认取消任务", missionId: mission.id });
  assert.equal(cancelled.action, "mission_cancelled");
  assert.equal(service.mission(mission.id).status, "cancelled");
});

test("published project manifests drive heavy runs and device packages", async () => {
  const { directory, ledger } = tempLedger();
  const service = new OrganizationService({
    ledger,
    project: project(directory),
    runRole: async ({ role }) => {
      if (role.id === "requirements-lead") {
        return { output: JSON.stringify({ readyForBaseline: true, message: "基线", questions: [], baseline: { outcome: "修复", inScope: ["功能"], outOfScope: [], acceptanceCriteria: ["通过"], testRequirements: ["回归"], constraints: [], knownFacts: [], openRisks: [] } }) };
      }
      if (role.id === "chief-manager") {
        return { output: JSON.stringify({ message: "计划", charter: { outcome: "修复", scope: ["功能"], constraints: [], successEvidence: [], escalationConditions: [] }, workItems: [
          { title: "实现", ownerRoleId: "engineering", deliverable: "commit", acceptance: [] },
          { title: "复核", ownerRoleId: "independent-reviewer", deliverable: "review", acceptance: [] },
          { title: "测试", ownerRoleId: "tester", deliverable: "tests", acceptance: [] },
        ] }) };
      }
      if (role.id === "engineering") return { output: JSON.stringify({ message: "完成", result: "completed", artifacts: ["c1"], tests: [] }) };
      if (role.id === "independent-reviewer") return { output: JSON.stringify({ message: "通过", verdict: "pass", findings: [], requirementCoverage: [], residualRisks: [] }) };
      return { output: JSON.stringify({
        message: "全量通过",
        verdict: "pass",
        candidate: { commit: "abcdef1234567890", clean: true },
        runs: [
          { testId: "project-regression", result: "passed", evidence: "ok" },
          { testId: "mini-smoke", result: "passed", evidence: "ok" },
        ],
        externalEvidencePackage: { buildIdentity: "pending", steps: [] },
      }) };
    },
  });
  const mission = service.createMission("修复发布回归并完成全量验证", "heavy");
  const manifest = service.publishTestManifest({
    projectId: service.mission(mission.id).projectId,
    version: "2026.09-mvp.2",
    requiredTests: [
      { id: "project-regression", name: "项目自动化回归", level: "integration", command: "pnpm test", environment: "冻结候选工作树" },
      { id: "mini-smoke", name: "小程序冒烟", level: "e2e", command: "pnpm run smoke", environment: "模拟器" },
    ],
  });
  assert.throws(() => service.publishTestManifest({ projectId: "x", version: "v2", requiredTests: [] }), /至少需要一个必跑项/);
  await settle(service);
  service.confirmBaseline(mission.id);
  await settle(service);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await settle(service);
  const ready = service.mission(mission.id);
  assert.equal(ready.status, "release_candidate_ready");
  assert.equal(ready.testRuns[0].projectTestManifestId, manifest.id);
  assert.match(ready.releaseCandidate.version, /2026\.09-mvp\.2-rc/);
  assert.equal(ready.releaseCandidate.environment, "preview");
  assert.ok(ready.releaseCandidate.requirementBaselineVersion);
  const packaged = service.generateDevicePackage(mission.id, {
    version: "v2.1.12",
    buildIdentity: "mini-build-abc123",
    commit: "abcdef1234567890",
    devices: ["Pixel 7"],
  });
  const devicePackage = packaged.externalEvidencePackages.at(-1);
  assert.equal(devicePackage.steps.length, 2);
  assert.throws(() => service.recordDeviceEvidence(mission.id, devicePackage.id, {
    tester: "人类测试人",
    results: [{ stepId: devicePackage.steps[0].id, result: "passed", evidence: "截图" }],
  }), /缺少步骤证据/);
  const evidenced = service.recordDeviceEvidence(mission.id, devicePackage.id, {
    tester: "人类测试人",
    results: devicePackage.steps.map((step) => ({ stepId: step.id, result: "passed", evidence: "截图已留存" })),
  });
  assert.equal(evidenced.externalEvidencePackages.at(-1).status, "passed");
  const deprecated = service.deprecateTestManifest(manifest.id, { reason: "新版本接管" });
  assert.equal(deprecated.deprecated, true);
});

test("every work item has exactly one responsible role", async () => {
  const { directory, ledger } = tempLedger();
  const service = new OrganizationService({
    ledger,
    project: project(directory),
    runRole: async ({ role }) => {
      if (role.id === "requirements-lead") {
        return { output: JSON.stringify({ readyForBaseline: true, message: "基线", questions: [], baseline: { outcome: "修复", inScope: ["功能"], outOfScope: [], acceptanceCriteria: ["通过"], testRequirements: ["回归"], constraints: [], knownFacts: [], openRisks: [] } }) };
      }
      return { output: JSON.stringify({ message: "计划", charter: { outcome: "修复", scope: ["功能"], constraints: [], successEvidence: [], escalationConditions: [] }, workItems: [
        { title: "实现", ownerRoleId: "engineering", deliverable: "commit", acceptance: [] },
        { title: "复核", ownerRoleId: "independent-reviewer", deliverable: "review", acceptance: [] },
      ] }) };
    },
  });
  const mission = service.createMission("验证工作项唯一负责人");
  await settle(service);
  service.confirmBaseline(mission.id);
  await settle(service);
  const planned = service.mission(mission.id);
  assert.ok(planned.workItems.length > 0);
  for (const item of planned.workItems) {
    assert.equal(typeof item.ownerRoleId, "string");
    assert.ok(item.ownerRoleId.length > 0);
  }
});

test("recording waiting consumes no model runs", async () => {  const { directory, ledger } = tempLedger();
  ledger.append("mission.created", {
    missionId: "mission-wait-quiet",
    payload: { title: "等待任务", goal: "验证等待不消耗模型", workflowProfile: "light" },
  });
  ledger.append("mission.status_changed", {
    missionId: "mission-wait-quiet",
    payload: { from: "intake", to: "clarifying", reason: "开始" },
  });
  const service = new OrganizationService({
    ledger,
    project: project(directory),
    runRole: async () => { throw new Error("must not be dispatched"); },
  });
  const updated = service.recordWaiting("mission-wait-quiet", { reason: "等外部排期" });
  assert.equal(updated.waitingConditions.length, 1);
  assert.equal(service.activeRuns.size, 0);
  assert.equal(updated.runs.length, 0);
});

test("model outputs are not silently truncated by count, only bounded by size", async () => {
  const { directory, ledger } = tempLedger();
  const questions = Array.from({ length: 12 }, (_, index) => ({ id: `q${index}`, question: `问题${index}`, why: "覆盖" }));
  const workItems = Array.from({ length: 10 }, (_, index) => ({ title: `工作${index}`, ownerRoleId: index % 2 ? "engineering" : "independent-reviewer", deliverable: "交付", acceptance: [] }));
  let requirementCalls = 0;
  const baseline = { outcome: "做事", inScope: ["全"], outOfScope: [], acceptanceCriteria: ["成"], testRequirements: [], constraints: [], knownFacts: [], openRisks: [] };
  const service = new OrganizationService({
    ledger,
    project: project(directory),
    runRole: async ({ role }) => {
      if (role.id === "requirements-lead") {
        requirementCalls += 1;
        if (requirementCalls === 1) return { output: JSON.stringify({ readyForBaseline: false, message: "请回答", questions }) };
        return { output: JSON.stringify({ readyForBaseline: true, message: "基线", questions: [], baseline }) };
      }
      return { output: JSON.stringify({ message: "计划", charter: { outcome: "做事", scope: ["全"], constraints: [], successEvidence: [], escalationConditions: [] }, workItems }) };
    },
  });
  const mission = service.createMission("验证数量截断已放开");
  await settle(service);
  assert.equal(service.mission(mission.id).messages.at(-1).questions.length, 12);
  service.addHumanMessage(mission.id, "补充全部十二个问题的答案");
  await settle(service);
  service.confirmBaseline(mission.id);
  await settle(service);
  assert.equal(service.mission(mission.id).workItems.length, 10);
  assert.throws(() => ledger.append("oversize.probe", { payload: { blob: "x".repeat(300 * 1024) } }), /256 KB/);
});

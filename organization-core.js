const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");

const SYSTEM_VERSION = "0.8.0-mvp";
const PROJECT_ID = "project-default";
const MANAGER_MODEL = "configured-model";
const MANAGER_REASONING = "model-default";

const TERMINAL_STATUSES = new Set(["light_completed", "accepted", "failed", "cancelled", "superseded"]);
const WORKFLOW_PROFILES = new Set(["auto", "light", "heavy"]);

const ALLOWED_STATUS_TRANSITIONS = new Map([
  ["intake", new Set(["clarifying", "cancelled"])],
  ["clarifying", new Set(["clarifying", "awaiting_baseline_confirmation", "waiting", "blocked", "cancelled"])],
  ["awaiting_baseline_confirmation", new Set(["clarifying", "planning", "waiting", "blocked", "cancelled"])],
  ["planning", new Set(["executing", "waiting", "blocked", "cancelled"])],
  ["executing", new Set(["awaiting_review", "waiting", "blocked", "cancelled"])],
  ["awaiting_review", new Set(["executing", "testing", "light_completed", "waiting", "blocked", "cancelled"])],
  ["testing", new Set(["executing", "release_candidate_ready", "waiting", "blocked", "cancelled"])],
  ["release_candidate_ready", new Set(["awaiting_release_approval", "blocked", "cancelled"])],
  ["awaiting_release_approval", new Set(["awaiting_release_approval", "awaiting_external_evidence", "blocked", "cancelled"])],
  ["awaiting_external_evidence", new Set(["executing", "awaiting_result_acceptance", "blocked", "cancelled"])],
  ["awaiting_result_acceptance", new Set(["executing", "accepted", "blocked", "cancelled"])],
  ["light_completed", new Set(["testing", "cancelled"])],
  ["waiting", new Set(["clarifying", "planning", "executing", "awaiting_review", "testing", "blocked", "cancelled"])],
  ["blocked", new Set(["clarifying", "planning", "executing", "awaiting_review", "testing", "failed", "cancelled"])],
]);

const ROLE_DEFINITIONS = [
  {
    id: "chief-manager",
    name: "群星的调律者",
    mode: "active",
    contractVersion: "1.0.0",
    mission: "把人类目标组织为可验证结果，并只在真实决策或授权边界升级。",
    may: ["建立 Charter", "分解工作", "任职资源", "要求返工", "汇总证据"],
    mustNot: ["代替人类确认需求", "自我验收", "隐式批准合并或发布"],
  },
  {
    id: "requirements-lead",
    name: "需求明确岗",
    mode: "active",
    contractVersion: "1.0.0",
    mission: "在工程开工前澄清用户结果、边界、证据和验收方式。",
    may: ["直接向人类追问", "读取项目事实", "形成需求基线草案"],
    mustNot: ["修改产品代码", "替人类确认基线", "把实现偏好写成需求"],
  },
  {
    id: "task-owner",
    name: "任务负责人",
    mode: "active",
    contractVersion: "1.0.0",
    mission: "维护任务章程、工作分解、责任、依赖和进度检查点。",
    may: ["创建 WorkItem", "安排依赖", "请求重新任职"],
    mustNot: ["改变需求基线", "替执行者生产产物", "宣告质量通过"],
  },
  {
    id: "engineering",
    name: "工程执行岗",
    mode: "active",
    contractVersion: "1.0.0",
    mission: "基于已确认需求诊断、实现并提交带证据的工程交付包。",
    may: ["修改任务工作树", "运行测试", "创建提交"],
    mustNot: ["修改已确认需求", "自我复核", "合并或部署"],
  },
  {
    id: "management-inspector",
    name: "管理巡检岗",
    mode: "active",
    contractVersion: "1.0.0",
    mission: "发现停滞、缺证、责任漂移和状态失真。",
    may: ["创建异常", "催办", "建议 BlockerCase"],
    mustNot: ["代替执行", "代替复核", "篡改进度证据"],
  },
  {
    id: "blocker-lead",
    name: "解障负责人",
    mode: "active_on_blocker",
    contractVersion: "1.0.0",
    mission: "在阻塞时保存现场、管理假设与尝试预算并恢复工作流。",
    may: ["切换路径", "重新任职", "建立恢复检查点"],
    mustNot: ["静默降低门禁", "无限重试", "接管业务结果责任"],
  },
  {
    id: "independent-reviewer",
    name: "独立复核岗",
    mode: "active",
    contractVersion: "1.0.0",
    mission: "独立判断方案和产物是否正确、完整、符合需求且可维护。",
    may: ["读取需求与完整差异", "提出阻断发现", "要求返工"],
    mustNot: ["修改被复核产物", "用执行者自评代替审查", "批准发布"],
  },
  {
    id: "tester",
    name: "测试岗",
    mode: "active",
    contractVersion: "1.0.0",
    mission: "在指定构建和环境执行测试并记录实际结果。",
    may: ["运行自动化", "运行项目测试工具", "生成外部验收执行包"],
    mustNot: ["用静态阅读代替运行", "伪造外部验收结果", "修改需求"],
  },
  {
    id: "creator",
    name: "创造者",
    mode: "advisory",
    contractVersion: "1.0.0",
    mission: "为开放问题生成语义实质不同的可能性空间。",
    may: ["形成 IdeaSet", "挑战锚定", "暴露未知项"],
    mustNot: ["作最终决定", "伪造事实", "直接执行想法"],
  },
  {
    id: "deliberator",
    name: "抉择者",
    mode: "advisory",
    contractVersion: "1.0.0",
    mission: "覆盖全部候选、证据与少数意见并形成 DecisionBrief。",
    may: ["比较权衡", "提出建议", "定义重审条件"],
    mustNot: ["自动成为 DecisionOwner", "遗漏候选", "直接执行决定"],
  },
  {
    id: "information-skill-steward",
    name: "信息与技能管理岗",
    mode: "shadow",
    contractVersion: "1.0.0",
    mission: "观察检索缺口、来源关系和可复用技能候选。",
    may: ["登记索引改进", "形成 SkillCandidate"],
    mustNot: ["改写原始事实", "自动发布技能", "推动主流程状态"],
  },
  {
    id: "evolution-lead",
    name: "自动调律演进负责人",
    mode: "shadow",
    contractVersion: "1.0.0",
    mission: "观察组织运行并形成有证据、可验证、可回滚的演进提案。",
    may: ["形成 EvolutionProposal", "建议隔离实验"],
    mustNot: ["自行修改真实系统", "自行批准提案", "阻塞主任务"],
  },
];

const ROLE_BY_ID = new Map(ROLE_DEFINITIONS.map((role) => [role.id, role]));

const ROLE_RETRIEVAL_FOCUS = {
  "chief-manager": ["goal", "status", "workflowProfile", "baseline", "charter", "blockers", "evidence", "reviews", "testRuns", "approvals"],
  "requirements-lead": ["goal", "humanMessages", "baseline", "openRisks"],
  "task-owner": ["charter", "workItems", "blockers", "checkpoints"],
  "engineering": ["goal", "baseline", "charter", "workItems", "evidence", "gapCases"],
  "management-inspector": ["status", "blockers", "checkpoints", "feedbacks"],
  "blocker-lead": ["blockers", "checkpoints", "attempts", "evidence"],
  "independent-reviewer": ["baseline", "diff", "evidence", "selfTests", "risks"],
  "tester": ["manifest", "candidate", "testRuns", "evidencePackage"],
  creator: ["problem", "ideaSets", "unknowns"],
  deliberator: ["candidates", "evidence", "briefs", "minorityOpinions"],
  "information-skill-steward": ["sources", "retrievalGaps", "skills"],
  "evolution-lead": ["problems", "experiments", "metrics", "rollbacks"],
};

function retrievalFocusFor(roleId) {
  return ROLE_RETRIEVAL_FOCUS[roleId] || ["goal", "status", "baseline"];
}

const CLARIFICATION_BUDGET_MS = 20 * 60_000;

const ISSUE_STATUSES = new Set(["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"]);

const DEFAULT_SELF_PROJECT = {
  id: "project-black-shores",
  name: "黑海岸 Agent 自身",
  repository: "zyzyhbz/BLACK_SHORES_AGENT",
  sourceRef: "origin/main",
  workingDirectory: "D:\\BLACK_SHORES_AGENT",
  testCommand: "npm test",
};

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value, maxLength = 20_000) {
  if (typeof value !== "string") return "";
  return value.replace(/\0/g, "").trim().slice(0, maxLength);
}

function organizationStatusReply(missions) {
  if (!missions.length) return "当前没有 Mission。可以直接下达新的结果目标。";
  const running = missions.filter((mission) => !TERMINAL_STATUSES.has(mission.status) && !["blocked", "waiting"].includes(mission.status));
  const blocked = missions.filter((mission) => mission.status === "blocked");
  const waiting = missions.filter((mission) => mission.status === "waiting");
  const latest = missions.slice().sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0];
  return `组织共有 ${missions.length} 个 Mission：${running.length} 个进行中，${blocked.length} 个阻塞，${waiting.length} 个等待；最近更新“${latest.title}”，状态为 ${latest.status}。`;
}

function commandReply(action, mission, missions = [], extra = null) {
  if (action === "query_organization_status") return organizationStatusReply(missions);
  if (action === "query_status") {
    return mission
      ? `${mission.title}：${mission.status}。${mission.statusReason || "状态已刷新。"}`
      : "当前没有 Mission。可以直接下达新的结果目标。";
  }
  const replies = {
    create_mission: "Mission 已建立，需求明确岗开始整理需求基线。",
    add_requirement_message: "补充内容已进入同一 Mission，需求明确岗将重新整理。",
    set_workflow_profile: "工作流档位已更新。",
    confirm_baseline: "需求基线已确认，群星的调律者开始建立任务章程。",
    retry_blocked: "已按恢复预算启动续作。",
    pause_requested: "安全暂停请求已下达；系统正在保存现场并停止本次物理调用。",
    emergency_stopped: "已紧急停止本次物理调用且不可恢复，现场保留等待人类决定下一步。",
    mission_cancelled: "Mission 已取消，不再恢复执行。",
    resume_paused: "已从最近检查点恢复同一逻辑 Run。",
    revise_requirements: "修改要求已记录，Mission 已回到需求明确岗重新整理基线。",
    start_heavy_review: "重度全量回顾已启动。",
  };
  if (action === "auto_heavy_review" && extra) {
    const started = extra.started?.length ? `已启动：${extra.started.join("、")}` : "暂无达到触发条件的任务";
    const skipped = extra.skipped?.length ? `；未启动：${extra.skipped.map((item) => `${item.id}（${item.reason}）`).join("、")}` : "";
    return `自动重度回顾评估完成。${started}${skipped}`;
  }
  return replies[action] || "命令已执行。";
}

function resolveWorkflowProfile(requested, goal) {
  const normalized = WORKFLOW_PROFILES.has(requested) ? requested : "auto";
  if (normalized !== "auto") {
    return { requested: normalized, resolved: normalized, reason: `人类明确选择${normalized === "light" ? "轻度" : "重度"}模式` };
  }
  const highRiskPattern = /(发布|部署|生产环境|外部验收|安全|权限|支付|账户|数据迁移|跨模块|全量|回归|版本治理|CI\b|release|deploy|production|migration)/i;
  const highRiskMatch = normalizeText(goal, 4000).match(highRiskPattern);
  if (highRiskMatch) {
    return { requested: "auto", resolved: "heavy", reason: `自动模式识别到高风险或发布相关信号：${highRiskMatch[0]}` };
  }
  return { requested: "auto", resolved: "light", reason: "自动模式未识别到强制重度信号，按日常局部变更进入轻度模式" };
}

function normalizeProjectTestManifest(project) {
  const supplied = project?.testManifest;
  if (supplied && Array.isArray(supplied.requiredTests) && supplied.requiredTests.length) {
    return {
      id: normalizeText(supplied.id, 200) || `ptm-${project.id}`,
      version: normalizeText(supplied.version, 100) || "1.0.0",
      projectId: project.id,
      requiredTests: supplied.requiredTests.map((item, index) => ({
        id: normalizeText(item.id, 160) || `required-${index + 1}`,
        name: normalizeText(item.name, 500) || `必跑项 ${index + 1}`,
        level: normalizeText(item.level, 80) || "integration",
        command: normalizeText(item.command, 2000),
        environment: normalizeText(item.environment, 1000),
      })),
    };
  }
  return {
    id: `ptm-${project?.id || PROJECT_ID}`,
    version: "1.0.0-mvp",
    projectId: project?.id || PROJECT_ID,
    requiredTests: [
      { id: "project-regression", name: "项目自动化回归", level: "integration", command: "项目约定的完整自动化测试", environment: "当前候选工作树" },
    ],
  };
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`);
  }
}

class JsonlLedger {
  constructor(filePath, { projectId = PROJECT_ID, onAppend = null } = {}) {
    this.filePath = path.resolve(filePath);
    this.projectId = projectId;
    this.onAppend = typeof onAppend === "function" ? onAppend : null;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) fs.writeFileSync(this.filePath, "", "utf8");
    this._events = this._load();
  }

  _load() {
    const content = fs.readFileSync(this.filePath, "utf8");
    if (!content.trim()) return [];
    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line, index) => {
        try {
          const event = JSON.parse(line);
          assertObject(event, `账本第 ${index + 1} 行`);
          if (!event.id || !event.type || !event.at) throw new Error("缺少 id/type/at");
          return event;
        } catch (error) {
          throw new Error(`账本损坏：第 ${index + 1} 行无法读取（${error.message}）`);
        }
      });
  }

  append(type, fields = {}) {
    const event = {
      id: makeId("evt"),      type,
      at: nowIso(),
      projectId: fields.projectId || this.projectId,
      missionId: fields.missionId || null,
      actorRoleId: fields.actorRoleId || "system",
      causationId: fields.causationId || null,
      payload: fields.payload || {},
    };
    const serialized = JSON.stringify(event);
    if (serialized.length > 256 * 1024) {
      throw new Error(`账本事件超过 256 KB 上限（${type}），拒绝写入以保护账本`);
    }
    fs.appendFileSync(this.filePath, `${serialized}\n`, "utf8");
    this._events.push(event);
    if (this.onAppend) {
      try {
        this.onAppend(event);
      } catch {}
    }
    return event;
  }

  events() {
    return this._events.map((event) => ({ ...event, payload: { ...event.payload } }));
  }
}

function emptyMission(event) {
  const profile = event.payload.workflowProfile
    ? resolveWorkflowProfile(event.payload.workflowProfile, event.payload.goal)
    : { requested: "auto", resolved: "heavy", reason: "旧账本未记录工作流档位，兼容按重度模式处理" };
  return {
    id: event.missionId,
    projectId: event.projectId,
    targetProjectId: event.payload.targetProjectId || event.projectId,
    title: event.payload.title,
    goal: event.payload.goal,
    status: "intake",
    workflowProfile: profile,
    workflowProfileHistory: [],
    createdAt: event.at,
    updatedAt: event.at,
    messages: [],
    runs: [],
    workItems: [],
    blockers: [],
    evidence: [],
    reviews: [],
    testRuns: [],
    changeRecords: [],
    gapCases: [],
    verifiedBaselines: [],
    externalEvidence: [],
    externalEvidencePackages: [],
    approvals: [],
    baseline: null,
    charter: null,
    releaseCandidate: null,
    revocations: [],
    cancellations: [],
    decisions: [],
    waitingConditions: [],
    overrides: [],
    riskDebts: [],
    qualityDecisions: [],
    decisionCases: [],
    ideaSets: [],
    evolutionProposals: [],
    skills: [],
    revision: 1,
  };
}

function reduceLedger(events) {
  const missions = new Map();
  for (const event of events) {
    if (event.type === "mission.created") {
      missions.set(event.missionId, emptyMission(event));
      continue;
    }
    if (!event.missionId) continue;
    const mission = missions.get(event.missionId);
    if (!mission) throw new Error(`账本事件 ${event.id} 引用了不存在的 Mission`);
    mission.updatedAt = event.at;
    switch (event.type) {
      case "mission.status_changed":
        mission.status = event.payload.to;
        mission.statusReason = event.payload.reason || "";
        break;
      case "workflow_profile.selected":
        mission.workflowProfile = {
          requested: event.payload.requested,
          resolved: event.payload.resolved,
          reason: event.payload.reason,
          selectedAt: event.at,
        };
        mission.workflowProfileHistory.push({ id: event.id, at: event.at, ...event.payload });
        break;
      case "message.recorded":
        mission.messages.push({ id: event.id, at: event.at, ...event.payload });
        break;
      case "run.started":
        mission.runs.push({ id: event.payload.runId, at: event.at, status: "running", invocations: [], ...event.payload });
        break;
      case "physical_invocation.started": {
        const run = mission.runs.find((item) => item.id === event.payload.runId);
        if (run) {
          run.status = "running";
          run.pauseRequested = false;
          run.invocations.push({ id: event.payload.invocationId, at: event.at, status: "running", ...event.payload });
          run.currentInvocationId = event.payload.invocationId;
        }
        break;
      }
      case "physical_invocation.completed":
      case "physical_invocation.failed":
      case "physical_invocation.interrupted": {
        const run = mission.runs.find((item) => item.id === event.payload.runId);
        const invocation = run?.invocations.find((item) => item.id === event.payload.invocationId);
        if (invocation) {
          const status = event.type.split(".")[1];
          Object.assign(invocation, event.payload, { status, completedAt: event.at });
        }
        break;
      }
      case "run.heartbeat": {
        const run = mission.runs.find((item) => item.id === event.payload.runId);
        if (run) Object.assign(run, { lastHeartbeatAt: event.at, currentAction: event.payload.currentAction || run.currentAction });
        break;
      }
      case "run.pause_requested": {
        const run = mission.runs.find((item) => item.id === event.payload.runId);
        if (run) Object.assign(run, { pauseRequested: true, pauseRequestedAt: event.at, currentAction: event.payload.reason || "正在安全暂停" });
        break;
      }
      case "run.paused": {
        const run = mission.runs.find((item) => item.id === event.payload.runId);
        if (run) Object.assign(run, event.payload, { status: "paused", pauseRequested: false, pausedAt: event.at });
        break;
      }
      case "run.stopped": {
        const run = mission.runs.find((item) => item.id === event.payload.runId);
        if (run) Object.assign(run, event.payload, { status: "stopped", pauseRequested: false, stoppedAt: event.at });
        break;
      }
      case "run.superseded": {
        const run = mission.runs.find((item) => item.id === event.payload.runId);
        if (run) Object.assign(run, event.payload, { status: "superseded", supersededAt: event.at });
        break;
      }
      case "run.resume_requested": {
        const run = mission.runs.find((item) => item.id === event.payload.runId);
        if (run) Object.assign(run, { pauseRequested: false, resumeRequestedAt: event.at });
        break;
      }
      case "run.checkpointed": {
        const run = mission.runs.find((item) => item.id === event.payload.runId);
        if (run) {
          run.lastCheckpoint = { id: event.id, at: event.at, ...event.payload };
          run.lastCheckpointAt = event.at;
          run.currentAction = event.payload.summary || run.currentAction;
        }
        break;
      }
      case "run.completed": {
        const run = mission.runs.find((item) => item.id === event.payload.runId);
        if (run) Object.assign(run, event.payload, { status: "completed", completedAt: event.at });
        break;
      }
      case "run.failed": {
        const run = mission.runs.find((item) => item.id === event.payload.runId);
        if (run) Object.assign(run, event.payload, { status: "failed", completedAt: event.at });
        break;
      }
      case "baseline.drafted":
        mission.baseline = { status: "draft", version: event.payload.version, ...event.payload.baseline };
        break;
      case "baseline.confirmed":
        mission.baseline = { ...mission.baseline, status: "confirmed", confirmedAt: event.at };
        mission.approvals.push({ id: event.id, at: event.at, kind: "baseline_confirmation", ...event.payload });
        break;
      case "charter.created":
        mission.charter = { id: event.id, at: event.at, ...event.payload };
        break;
      case "work_item.created":
        mission.workItems.push({ id: event.payload.id, status: "queued", createdAt: event.at, ...event.payload });
        break;
      case "work_item.status_changed": {
        const item = mission.workItems.find((candidate) => candidate.id === event.payload.id);
        if (item) Object.assign(item, event.payload, { updatedAt: event.at });
        break;
      }
      case "blocker.opened":
        mission.blockers.push({ id: event.payload.id, status: "open", openedAt: event.at, ...event.payload });
        break;
      case "blocker.closed": {
        const blocker = mission.blockers.find((item) => item.id === event.payload.id);
        if (blocker) Object.assign(blocker, event.payload, { status: "closed", closedAt: event.at });
        break;
      }
      case "evidence.recorded":
        mission.evidence.push({ id: event.id, at: event.at, ...event.payload });
        break;
      case "review.recorded":
        mission.reviews.push({ id: event.id, at: event.at, ...event.payload });
        break;
      case "test_run.recorded":
        mission.testRuns.push({ id: event.id, at: event.at, ...event.payload });
        break;
      case "change_record.recorded":
        mission.changeRecords.push({ id: event.payload.id || event.id, at: event.at, ...event.payload });
        break;
      case "gap_case.opened":
        mission.gapCases.push({ id: event.payload.id, at: event.at, status: "open", ...event.payload });
        break;
      case "gap_case.closed": {
        const gapCase = mission.gapCases.find((item) => item.id === event.payload.id);
        if (gapCase) Object.assign(gapCase, event.payload, { status: "closed", closedAt: event.at });
        break;
      }
      case "verified_baseline.recorded":
        mission.verifiedBaselines.push({ id: event.payload.id || event.id, at: event.at, ...event.payload });
        break;
      case "release_candidate.created":
        mission.releaseCandidate = { id: event.payload.id, at: event.at, ...event.payload };
        break;
      case "release_candidate.source_verified":
        if (mission.releaseCandidate?.id === event.payload.id) {
          Object.assign(mission.releaseCandidate, event.payload, {
            status: "source_verified",
            sourceVerifiedAt: event.at,
          });
        }
        break;
      case "release_candidate.invalidated":
        if (mission.releaseCandidate?.id === event.payload.id) {
          Object.assign(mission.releaseCandidate, event.payload, {
            status: "invalidated",
            invalidatedAt: event.at,
          });
        }
        break;
      case "external_evidence.recorded":
        mission.externalEvidence.push({ id: event.id, at: event.at, ...event.payload });
        break;
      case "device_package.created":
        mission.externalEvidencePackages.push({ id: event.payload.id, status: "open", createdAt: event.at, ...event.payload });
        break;
      case "device_package.evidence_recorded": {
        const devicePackage = mission.externalEvidencePackages.find((item) => item.id === event.payload.id);
        if (devicePackage) Object.assign(devicePackage, event.payload, { status: event.payload.verdict, evidencedAt: event.at });
        break;
      }
      case "approval.recorded":
        mission.approvals.push({ id: event.id, at: event.at, ...event.payload });
        break;
      case "decision.requested":
        mission.decisions.push({ id: event.payload.id, status: "open", requestedAt: event.at, ...event.payload });
        break;
      case "decision.resolved": {
        const decision = mission.decisions.find((item) => item.id === event.payload.id);
        if (decision) Object.assign(decision, event.payload, { status: event.payload.resolution, resolvedAt: event.at });
        break;
      }
      case "waiting_condition.recorded":
        mission.waitingConditions.push({ id: event.payload.id, status: "open", recordedAt: event.at, ...event.payload });
        break;
      case "waiting_condition.closed": {
        const waiting = mission.waitingConditions.find((item) => item.id === event.payload.id);
        if (waiting) Object.assign(waiting, event.payload, { status: "closed", closedAt: event.at });
        break;
      }
      case "override.granted":
        mission.overrides.push({ id: event.payload.id, status: "active", grantedAt: event.at, ...event.payload });
        break;
      case "override.expired": {
        const override = mission.overrides.find((item) => item.id === event.payload.id);
        if (override) Object.assign(override, event.payload, { status: "expired", expiredAt: event.at });
        break;
      }
      case "risk_debt.recorded":
        mission.riskDebts.push({ id: event.payload.id, status: "open", recordedAt: event.at, ...event.payload });
        break;
      case "risk_debt.closed": {
        const debt = mission.riskDebts.find((item) => item.id === event.payload.id);
        if (debt) Object.assign(debt, event.payload, { status: "closed", closedAt: event.at });
        break;
      }
      case "quality.decided":
        mission.qualityDecisions.push({ id: event.id, at: event.at, ...event.payload });
        break;
      case "mission.revision_incremented":
        mission.revision = event.payload.revision;
        break;
      case "mission.cancelled":
        mission.cancellations.push({ id: event.id, at: event.at, ...event.payload });
        break;
      case "action.reverted":
        mission.revocations.push({ id: event.id, at: event.at, ...event.payload });
        break;
      case "decision_case.opened":
        mission.decisionCases.push({ id: event.payload.id, status: "open", openedAt: event.at, ...event.payload });
        break;
      case "idea_set.recorded": {
        const decisionCase = mission.decisionCases.find((item) => item.id === event.payload.decisionCaseId);
        const ideaSet = { id: event.payload.id, recordedAt: event.at, ...event.payload };
        if (decisionCase) {
          decisionCase.ideaSets = decisionCase.ideaSets || [];
          decisionCase.ideaSets.push(ideaSet);
        } else {
          mission.ideaSets.push(ideaSet);
        }
        break;
      }
      case "decision_brief.recorded": {
        const decisionCase = mission.decisionCases.find((item) => item.id === event.payload.decisionCaseId);
        const brief = { id: event.id, recordedAt: event.at, ...event.payload };
        if (decisionCase) {
          decisionCase.briefs = decisionCase.briefs || [];
          decisionCase.briefs.push(brief);
        }
        break;
      }
      case "decision_case.decided": {
        const decisionCase = mission.decisionCases.find((item) => item.id === event.payload.id);
        if (decisionCase) Object.assign(decisionCase, event.payload, { status: "decided", decidedAt: event.at });
        break;
      }
      case "evolution_proposal.submitted":
        mission.evolutionProposals.push({ id: event.payload.id, status: "proposed", submittedAt: event.at, ...event.payload });
        break;
      case "evolution_proposal.decided": {
        const proposal = mission.evolutionProposals.find((item) => item.id === event.payload.id);
        if (proposal) Object.assign(proposal, event.payload, { status: event.payload.decision, decidedAt: event.at });
        break;
      }
      case "skill_candidate.recorded":
        mission.skills.push({ id: event.payload.id, status: "candidate", recordedAt: event.at, ...event.payload });
        break;
      case "skill.decided": {
        const skill = mission.skills.find((item) => item.id === event.payload.id);
        if (skill) Object.assign(skill, event.payload, { status: event.payload.decision, decidedAt: event.at });
        break;
      }
      default:
        break;
    }
  }
  return [...missions.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function extractJsonObject(text) {
  const source = normalizeText(text, 200_000);
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || source.slice(source.indexOf("{"), source.lastIndexOf("}") + 1);
  if (!candidate || !candidate.startsWith("{") || !candidate.endsWith("}")) {
    throw new Error("角色输出不包含可读取的 JSON 对象");
  }
  const parsed = JSON.parse(candidate);
  assertObject(parsed, "角色输出");
  return parsed;
}

function renderRoleContract(roleId) {
  const role = ROLE_BY_ID.get(roleId);
  if (!role) throw new Error(`未知角色：${roleId}`);
  return [
    `角色：${role.name}`,
    `角色合同版本：${role.contractVersion}`,
    `使命：${role.mission}`,
    `可以：${role.may.join("；")}`,
    `禁止：${role.mustNot.join("；")}`,
  ].join("\n");
}

function missionContext(mission, roleId = null) {
  const full = {
    missionId: mission.id,
    projectId: mission.projectId,
    goal: mission.goal,
    status: mission.status,
    workflowProfile: mission.workflowProfile,
    humanMessages: mission.messages.filter((message) => message.authorType === "human"),
    baseline: mission.baseline,
    charter: mission.charter,
    workItems: mission.workItems,
    blockers: mission.blockers.filter((item) => item.status === "open"),
    engineeringEvidence: mission.evidence.slice(-3),
    reviews: mission.reviews.slice(-3),
    testRuns: mission.testRuns.slice(-3),
    changeRecords: mission.changeRecords.slice(-3),
    gapCases: mission.gapCases.filter((item) => item.status === "open"),
    verifiedBaselines: mission.verifiedBaselines.slice(-2),
    releaseCandidate: mission.releaseCandidate,
  };
  if (!roleId) return JSON.stringify(full, null, 2);
  const focus = retrievalFocusFor(roleId);
  const view = { missionId: full.missionId, projectId: full.projectId, roleView: roleId, focus };
  for (const key of Object.keys(full)) {
    if (key === "missionId" || key === "projectId") continue;
    view[key] = focus.some((term) => key.toLowerCase().includes(term.toLowerCase()) || term.toLowerCase().includes(key.toLowerCase()))
      ? full[key]
      : "[按角色检索表折叠：与本职无关]";
  }
  return JSON.stringify(view, null, 2);
}

function ideaClusterSimilarity(left, right) {
  const tokenize = (text) => new Set(String(text || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(" ").filter((token) => token.length > 1));
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  let overlap = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) overlap += 1;
  return overlap / Math.max(leftTokens.size, rightTokens.size);
}

function buildRequirementPrompt(mission) {
  return `${renderRoleContract("requirements-lead")}

你正在黑海岸 AGENT 系统中处理一个真实项目任务。你拥有本机适配器授予的工具能力，但本阶段组织授权仅允许只读调查和需求澄清，禁止修改产品代码、创建提交、合并或发布。

任务事实：
${missionContext(mission, "requirements-lead")}

请判断信息是否足以形成可交给人类确认的需求基线。按当前任务核对预期结果、范围与非范围、复现或触发条件、运行环境、约束、来源身份、已有证据、可观察验收标准和必须保留的既有行为。只询问会实质影响结果或验收的未知项，不要把诊断假设当成事实。每轮先给出已确认的结论，再列出新的问题；不要为凑数重复追问。

只输出一个 JSON 对象，不要输出 Markdown 或额外文字：
{
  "readyForBaseline": false,
  "message": "面向人类负责人的简洁署名消息",
  "knownFacts": ["事实"],
  "unknowns": ["未知项"],
  "questions": [{"id":"stable-id","question":"一次可直接回答的问题","why":"为什么影响验收或实现"}],
  "baseline": null
}

信息足够时把 readyForBaseline 设为 true，questions 设为空，并提供：
{"baseline":{"outcome":"用户结果","inScope":["范围"],"outOfScope":["非范围"],"acceptanceCriteria":["可观察标准"],"testRequirements":["测试要求"],"constraints":["约束"],"knownFacts":["事实"],"openRisks":["不阻断确认的风险"]}}`;
}

function buildManagerPrompt(mission) {
  const isLight = mission.workflowProfile?.resolved === "light";
  const workItems = isLight
    ? `    {"title":"复现、根因验证、实现与必要小型自测","ownerRoleId":"engineering","deliverable":"工程交付与自测留痕","acceptance":["实现目标结果","记录实际动作与自测"]},
    {"title":"独立留痕复核","ownerRoleId":"independent-reviewer","deliverable":"ChangeRecord 复核","acceptance":["核对范围、diff、提交、产物、自测、风险与授权留痕"]}`
    : `    {"title":"复现、根因验证与实现","ownerRoleId":"engineering","deliverable":"交付物","acceptance":["完成实现并提供证据"]},
    {"title":"独立复核","ownerRoleId":"independent-reviewer","deliverable":"Review","acceptance":["独立核对产物"]},
    {"title":"项目全量功能测试","ownerRoleId":"tester","deliverable":"TestRun、VerifiedBaseline 与外部验收包","acceptance":["执行 ProjectTestManifest 全部必跑项"]}`;
  return `${renderRoleContract("chief-manager")}

需求基线已经由人类明确确认。你本阶段只建立 Mission Charter 和工作分解，不修改代码、不创建 PR、不合并、不发布。
当前 WorkflowProfile 为 ${mission.workflowProfile?.resolved || "heavy"}；必须严格按该档位组织角色。

任务事实：
${missionContext(mission, "chief-manager")}

只输出一个 JSON 对象：
{
  "message":"给人类的简洁阶段汇报",
  "charter":{"outcome":"结果","scope":["范围"],"constraints":["约束"],"successEvidence":["证据"],"escalationConditions":["升级条件"]},
  "workItems":[
${workItems}
  ],
  "decisionRequired":false,
  "decisionQuestion":""
}

${isLight ? "WorkItem 只覆盖工程执行与独立留痕复核，不得启动独立测试岗。" : "WorkItem 必须分别覆盖生产、独立复核和项目全量测试。"}不得引入 RequirementBaseline 之外的工作；必须停在合并与部署授权之前。`;
}

function buildEngineeringPrompt(mission) {
  return `${renderRoleContract("engineering")}

RequirementBaseline 已确认，任务负责人已建立 Charter。你可以在配置的项目工作目录内诊断和修改代码、增加测试并创建提交。你不能改变需求、合并变更或执行部署。

任务事实：
${missionContext(mission, "engineering")}

执行要求：先核对配置的来源基线与工作目录，建立可证伪的根因假设；按 RequirementBaseline 复现或解释环境差异；实施范围受控的根修；增加回归测试并运行与风险相称的验证。输入中的诊断只能作为待验证假设。每完成一个 WorkItem 先记录检查点与证据再继续，不要攒到最后一次输出。完成后形成可定位的交付物与证据，但不要合并或部署。

最终只输出一个 JSON 对象：
{"message":"阶段汇报","result":"completed|blocked","rootCause":"有证据的根因或未知","changes":["变更"],"artifacts":["绝对路径或 commit"],"tests":[{"command":"命令","result":"passed|failed","evidence":"摘要"}],"risks":["风险"],"next":"下一步"}`;
}

function buildReviewPrompt(mission) {
  const lightInstruction = mission.workflowProfile?.resolved === "light"
    ? "当前为轻度模式。重点独立核对需求范围、基线、实际动作、文件与 diff、提交、产物、自测声明、风险、授权边界和恢复信息是否真实完整；不要把本次复核冒充为完整功能测试。"
    : "当前为重度模式。独立核对需求、方案、实现、证据、完整性、一致性、可维护性和约束。";
  return `${renderRoleContract("independent-reviewer")}

你只能独立复核，不得修改文件、创建提交、PR、合并或发布。直接读取已确认需求、当前分支、相对基线的完整差异和测试。
${lightInstruction}

任务事实：
${missionContext(mission, "independent-reviewer")}

只输出一个 JSON 对象：
{"message":"复核结论","verdict":"pass|changes_required|blocked","findings":[{"severity":"P0|P1|P2|P3","title":"问题","evidence":"文件/行或行为证据","requiredChange":"要求"}],"requirementCoverage":[{"criterion":"标准","status":"covered|missing|unclear","evidence":"证据"}],"residualRisks":["风险"]}`;
}

function buildTestPrompt(mission, manifest = {}) {
  return `${renderRoleContract("tester")}

你负责实际执行测试，不修改产品实现，不以静态代码阅读冒充测试，不伪造外部环境结果。可以运行 ProjectTestManifest 指定的自动化、类型检查、集成测试、端到端测试和预检工具。
当前 ProjectTestManifest：
${JSON.stringify(manifest, null, 2)}
必须对冻结候选执行全部 requiredTests，并在 runs 中用 testId 逐项对应。任一必跑项失败即 verdict=fail。

任务事实：
${missionContext(mission, "tester")}

只输出一个 JSON 对象：
{"message":"测试结论","verdict":"pass|fail|blocked","candidate":{"commit":"精确 SHA 或明确候选身份","clean":true},"runs":[{"testId":"Manifest 测试 ID","level":"unit|integration|e2e|preflight","command":"命令或步骤","result":"passed|failed|blocked","evidence":"可定位证据"}],"externalEvidencePackage":{"buildIdentity":"候选身份或待生成","preconditions":["前置"],"steps":[{"id":"E1","action":"人类或外部系统操作","expected":"预期","requiredEvidence":"证据","stopCondition":"停止条件"}],"uncoveredRisks":["未覆盖风险"]}}`;
}

function publicMission(mission) {
  return JSON.parse(JSON.stringify(mission));
}

class OrganizationService {
  constructor({
    ledger,
    runRole,
    project,
    projects = {},
    managerAssignment = {},
    roleAssignments = {},
    maxRecoveryAttempts = 2,
    heartbeatIntervalMs = 60_000,
  }) {
    this.ledger = ledger;
    this.runRole = runRole;
    this.project = project;
    this.projects = {
      [project.id]: { ...project },
      [DEFAULT_SELF_PROJECT.id]: { ...DEFAULT_SELF_PROJECT, ...(projects[DEFAULT_SELF_PROJECT.id] || {}) },
      ...projects,
    };
    this.managerAssignment = {
      adapterId: managerAssignment.adapterId || "test",
      adapterLabel: managerAssignment.adapterLabel || managerAssignment.adapterId || "Test adapter",
      model: Object.hasOwn(managerAssignment, "model") ? managerAssignment.model : MANAGER_MODEL,
      reasoningEffort: Object.hasOwn(managerAssignment, "reasoningEffort")
        ? managerAssignment.reasoningEffort
        : MANAGER_REASONING,
      ready: managerAssignment.ready !== false,
      message: managerAssignment.message || "",
    };
    this.roleAssignments = Object.fromEntries(
      Object.entries(roleAssignments || {}).map(([roleId, assignment]) => [
        roleId,
        { ...this.managerAssignment, ...assignment },
      ]),
    );
    this.projectTestManifest = normalizeProjectTestManifest(project);
    this.maxRecoveryAttempts = maxRecoveryAttempts;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.activeRuns = new Map();
    this._recoverInterruptedRuns();
  }

  state() {
    const missions = reduceLedger(this.ledger.events());
    return {
      version: SYSTEM_VERSION,
      productName: "黑海岸 AGENT 系统",
      authority: {
        approved: true,
        ledgerMode: "local-single-machine",
        managerAdapter: this.managerAssignment.adapterId,
        managerAdapterLabel: this.managerAssignment.adapterLabel,
        managerModel: this.managerAssignment.model,
        managerReasoning: this.managerAssignment.reasoningEffort,
        executionReady: this.managerAssignment.ready,
        configurationMessage: this.managerAssignment.message,
      },
      roleAssignments: Object.fromEntries(
        ROLE_DEFINITIONS.map((role) => [role.id, this._assignmentForRole(role.id)]),
      ),
      project: this.project,
      projects: this._projectRegistry(),
      issues: this._issueRegistry(),      projectTestManifest: this.projectTestManifest,
      projectTestManifests: this.ledger.events()
        .filter((event) => event.type === "test_manifest.published")
        .map((event) => ({
          eventId: event.id,
          at: event.at,
          ...event.payload,
          deprecated: this.ledger.events().some(
            (candidate) => candidate.type === "test_manifest.deprecated" && candidate.payload?.id === event.payload?.id,
          ),
        })),
      assignmentSnapshots: this.ledger.events()
        .filter((event) => event.type === "assignment.snapshot")
        .map((event) => ({ id: event.id, at: event.at, ...event.payload })),
      roles: ROLE_DEFINITIONS,
      missions: missions.map((mission) => ({
        ...publicMission(mission),
        availableActions: this._availableActions(mission),
      })),
      controls: {
        canCreateMission: this.activeRuns.size === 0,
        directAgentInvocation: "internal-diagnostic-only",
      },
      activeRunIds: [...this.activeRuns.keys()],
      activeRuns: [...this.activeRuns.entries()].map(([missionId, active]) => ({
        missionId,
        runId: active.runId,
        invocationId: active.invocationId,
        roleId: active.roleId,
        roleName: ROLE_BY_ID.get(active.roleId)?.name || active.roleId,
        model: active.model,
        reasoningEffort: active.reasoningEffort,
        scope: active.scope || [],
        startedAt: active.startedAt,
        currentAction: active.currentAction,
        lastHeartbeatAt: active.lastHeartbeatAt,
        lastCheckpointAt: active.lastCheckpointAt,
        lastCheckpoint: active.lastCheckpoint,
        resumed: active.resumed === true,
        pauseRequested: active.pauseRequested === true,
      })),
      ledger: { path: this.ledger.filePath, eventCount: this.ledger.events().length },
    };
  }

  setAssignments({ managerAssignment, roleAssignments = {} }) {
    if (this.activeRuns.size) {
      throw Object.assign(new Error("存在活动 Run 时不能切换任职，请先安全暂停，变更只影响后续物理调用"), { statusCode: 409 });
    }
    if (!managerAssignment?.adapterId) {
      throw Object.assign(new Error("群星的调律者任职缺少适配器"), { statusCode: 400 });
    }
    this.managerAssignment = { ...managerAssignment };
    this.roleAssignments = Object.fromEntries(
      Object.entries(roleAssignments).map(([roleId, assignment]) => [
        roleId,
        { ...this.managerAssignment, ...assignment },
      ]),
    );
    this.ledger.append("agent_assignments.updated", {
      actorRoleId: "human-owner",
      payload: {
        manager: {
          adapterId: this.managerAssignment.adapterId,
          model: this.managerAssignment.model,
          reasoningEffort: this.managerAssignment.reasoningEffort,
        },
        roles: Object.fromEntries(
          Object.entries(this.roleAssignments).map(([roleId, assignment]) => [
            roleId,
            {
              adapterId: assignment.adapterId,
              model: assignment.model,
              reasoningEffort: assignment.reasoningEffort,
            },
          ]),
        ),
        activeRunIds: [...this.activeRuns.values()].map((run) => run.runId),
        appliesTo: "next-physical-invocation",
      },
    });
    this.ledger.append("assignment.snapshot", {
      actorRoleId: "human-owner",
      payload: {
        id: makeId("asgn"),
        manager: {
          adapterId: this.managerAssignment.adapterId,
          model: this.managerAssignment.model,
          reasoningEffort: this.managerAssignment.reasoningEffort,
        },
        roles: Object.fromEntries(
          Object.entries(this.roleAssignments).map(([roleId, assignment]) => [
            roleId,
            {
              adapterId: assignment.adapterId,
              model: assignment.model,
              reasoningEffort: assignment.reasoningEffort,
            },
          ]),
        ),
      },
    });
    return this.state();
  }

  _latestAssignmentSnapshotId() {
    const snapshots = this.ledger.events().filter((event) => event.type === "assignment.snapshot");
    return snapshots.at(-1)?.payload?.id || null;
  }

  publishTestManifest(input) {
    assertObject(input, "测试集");
    const projectId = normalizeText(input.projectId, 200) || this.project.id;
    const version = normalizeText(input.version, 100);
    if (!version) throw Object.assign(new Error("测试集需要版本号"), { statusCode: 400 });
    const requiredTests = Array.isArray(input.requiredTests) ? input.requiredTests : [];
    if (!requiredTests.length || requiredTests.length > 200) {
      throw Object.assign(new Error("测试集至少需要一个必跑项"), { statusCode: 400 });
    }
    const normalized = requiredTests.map((item, index) => {
      assertObject(item, `必跑项 ${index + 1}`);
      const id = normalizeText(item.id, 160) || `required-${index + 1}`;
      const name = normalizeText(item.name, 500);
      if (!name) throw Object.assign(new Error(`必跑项 ${index + 1} 需要名称`), { statusCode: 400 });
      return {
        id,
        name,
        level: normalizeText(item.level, 80) || "integration",
        command: normalizeText(item.command, 2000),
        environment: normalizeText(item.environment, 1000),
      };
    });
    const ids = normalized.map((item) => item.id);
    if (new Set(ids).size !== ids.length) throw Object.assign(new Error("必跑项 ID 不能重复"), { statusCode: 400 });
    const id = makeId("ptm");
    this.ledger.append("test_manifest.published", {
      actorRoleId: "human-owner",
      payload: { id, projectId, version, requiredTests: normalized },
    });
    return { id, projectId, version, requiredTests: normalized };
  }

  deprecateTestManifest(manifestId, input = {}) {
    const manifests = this.state().projectTestManifests;
    const manifest = manifests.find((item) => item.id === manifestId);
    if (!manifest || manifest.deprecated) throw Object.assign(new Error("测试集不存在或已废弃"), { statusCode: 409 });
    this.ledger.append("test_manifest.deprecated", {
      actorRoleId: "human-owner",
      payload: { id: manifestId, reason: normalizeText(input.reason, 2000) || "被新版本替代" },
    });
    return { id: manifestId, deprecated: true };
  }

  _projectRegistry() {
    const registered = new Map();
    for (const event of this.ledger.events()) {
      if (event.type === "project.registered") {
        registered.set(event.payload.id, { status: "active", registeredAt: event.at, ...event.payload });
      } else if (event.type === "project.archived" && registered.has(event.payload.id)) {
        registered.get(event.payload.id).status = "archived";
      } else if (event.type === "project.reopened" && registered.has(event.payload.id)) {
        registered.get(event.payload.id).status = "active";
      }
    }
    return [...Object.values(this.projects).map((item) => ({ status: "active", builtin: true, ...item })), ...registered.values()];
  }

  _issueRegistry() {
    const issues = new Map();
    for (const event of this.ledger.events()) {
      if (event.type === "issue.opened") {
        issues.set(event.payload.id, { openedAt: event.at, history: [], ...event.payload });
      } else if (event.type === "issue.status_changed" && issues.has(event.payload.id)) {
        const issue = issues.get(event.payload.id);
        issue.status = event.payload.to;
        issue.updatedAt = event.at;
        issue.history.push({ at: event.at, from: event.payload.from, to: event.payload.to, reason: event.payload.reason });
      }
    }
    return [...issues.values()].sort((left, right) => String(right.openedAt).localeCompare(String(left.openedAt)));
  }

  openIssue(input) {
    assertObject(input, "问题事项");
    const title = normalizeText(input.title, 500);
    if (title.length < 4) throw Object.assign(new Error("问题事项需要明确标题"), { statusCode: 400 });
    const status = normalizeText(input.status, 40) || "backlog";
    if (!ISSUE_STATUSES.has(status)) throw Object.assign(new Error("未知的问题状态"), { statusCode: 400 });
    const id = makeId("iss");
    this.ledger.append("issue.opened", {
      actorRoleId: "human-owner",
      payload: {
        id,
        title,
        description: normalizeText(input.description, 8000),
        severity: ["low", "medium", "high", "critical"].includes(input.severity) ? input.severity : "medium",
        status,
        source: normalizeText(input.source, 500),
      },
    });
    return this._issueRegistry().find((item) => item.id === id);
  }

  setIssueStatus(issueId, input) {
    assertObject(input, "状态变更");
    const to = normalizeText(input.to, 40);
    if (!ISSUE_STATUSES.has(to)) throw Object.assign(new Error("未知的问题状态"), { statusCode: 400 });
    const issue = this._issueRegistry().find((item) => item.id === issueId);
    if (!issue) throw Object.assign(new Error("问题事项不存在"), { statusCode: 404 });
    if ((issue.status === "done" || issue.status === "cancelled") && to !== "todo" && to !== "backlog") {
      throw Object.assign(new Error("已终结的问题只能重开回待办或规划"), { statusCode: 409 });
    }
    this.ledger.append("issue.status_changed", {
      actorRoleId: "human-owner",
      payload: { id: issueId, from: issue.status, to, reason: normalizeText(input.reason, 2000) || "" },
    });
    return this._issueRegistry().find((item) => item.id === issueId);
  }

  _projectFor(mission) {    const target = mission?.targetProjectId || mission?.projectId;
    const registry = this._projectRegistry();
    return registry.find((item) => item.id === target && item.status !== "archived")
      || this.projects[target]
      || this.project;
  }

  _discoverProject(workingDirectory) {
    const discovered = { repository: "", name: "", testCommand: "" };
    try {
      const remote = spawnSync("git", ["remote", "get-url", "origin"], {
        cwd: workingDirectory,
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
      });
      if (remote.status === 0) discovered.repository = String(remote.stdout || "").trim().slice(0, 500);
    } catch {}
    try {
      const raw = fs.readFileSync(path.join(workingDirectory, "package.json"), "utf8").replace(/^﻿/, "");
      const manifest = JSON.parse(raw);
      if (manifest?.name) discovered.name = String(manifest.name).slice(0, 200);
      if (manifest?.scripts?.test) discovered.testCommand = `npm test (${String(manifest.scripts.test).slice(0, 200)})`;
    } catch {}
    return discovered;
  }

  publishProject(input) {
    assertObject(input, "项目定义");
    const workingDirectory = path.resolve(normalizeText(input.workingDirectory, 2000));
    if (!workingDirectory) throw Object.assign(new Error("定义项目只需要指定初始工作空间"), { statusCode: 400 });
    if (!fs.existsSync(workingDirectory) || !fs.statSync(workingDirectory).isDirectory()) {
      throw Object.assign(new Error("初始工作空间不存在或不是目录"), { statusCode: 400 });
    }
    const discovered = this._discoverProject(workingDirectory);
    const id = makeId("proj");
    this.ledger.append("project.registered", {
      actorRoleId: "human-owner",
      payload: {
        id,
        name: normalizeText(input.name, 200) || discovered.name || path.basename(workingDirectory),
        workingDirectory,
        repository: normalizeText(input.repository, 500) || discovered.repository,
        testCommand: normalizeText(input.testCommand, 500) || discovered.testCommand,
        sourceRef: normalizeText(input.sourceRef, 200) || "origin/main",
      },
    });
    return this._projectRegistry().find((item) => item.id === id);
  }

  archiveProject(projectId, input = {}) {
    const registry = this._projectRegistry();
    const target = registry.find((item) => item.id === projectId);
    if (!target) throw Object.assign(new Error("项目不存在"), { statusCode: 404 });
    if (target.status === "archived") throw Object.assign(new Error("项目已归档"), { statusCode: 409 });
    const activeMissions = this.state().missions.filter(
      (mission) => (mission.targetProjectId || mission.projectId) === projectId && !TERMINAL_STATUSES.has(mission.status),
    );
    if (activeMissions.length) {
      throw Object.assign(new Error(`项目下还有 ${activeMissions.length} 个未终结会话，不能归档`), { statusCode: 409 });
    }
    this.ledger.append("project.archived", {
      actorRoleId: "human-owner",
      payload: { id: projectId, reason: normalizeText(input.reason, 2000) || "人类归档" },
    });
    return this._projectRegistry().find((item) => item.id === projectId);
  }

  reopenProject(projectId) {
    const registry = this._projectRegistry();
    const target = registry.find((item) => item.id === projectId);
    if (!target) throw Object.assign(new Error("项目不存在"), { statusCode: 404 });
    if (target.status !== "archived") throw Object.assign(new Error("项目未归档，无需重开"), { statusCode: 409 });
    this.ledger.append("project.reopened", { actorRoleId: "human-owner", payload: { id: projectId } });
    return this._projectRegistry().find((item) => item.id === projectId);
  }

  _manifestFor(mission) {
    const projectId = mission?.targetProjectId || mission?.projectId;
    const published = this.state().projectTestManifests
      .filter((item) => item.projectId === projectId && !item.deprecated)
      .sort((left, right) => String(left.at).localeCompare(String(right.at)));
    return published.at(-1) || this.projectTestManifest;
  }

  _assertRoleDispatchable(missionId, roleId) {
    const role = ROLE_BY_ID.get(roleId);
    if (!role) throw Object.assign(new Error(`未知角色：${roleId}`), { statusCode: 404 });
    if (role.mode === "off" || role.mode === "shadow") {
      throw Object.assign(new Error(`${role.name} 当前处于 ${role.mode} 模式，不能直接派活执行`), { statusCode: 409 });
    }
    const mission = this._requireMission(missionId);
    if (role.mode === "advisory" && !mission.decisionCases.some((item) => item.status === "open")) {
      throw Object.assign(new Error(`${role.name} 是条件认知角色，需要开放的决策事项才能进入`), { statusCode: 409 });
    }
    if (role.id === "blocker-lead" && !mission.blockers.some((item) => item.status === "open")) {
      throw Object.assign(new Error("没有开放的 BlockerCase，解障负责人不能激活"), { statusCode: 409 });
    }
  }

  mission(missionId) {
    return this.state().missions.find((mission) => mission.id === missionId) || null;
  }

  _availableActions(mission) {
    const actions = ["query-status"];
    if (mission.decisions?.some((item) => item.status === "open")) actions.push("decide");
    const active = this.activeRuns.has(mission.id);
    const anotherMissionActive = [...this.activeRuns.keys()].some((missionId) => missionId !== mission.id);
    if (!anotherMissionActive && ["clarifying", "awaiting_baseline_confirmation", "waiting", "light_completed"].includes(mission.status)) {
      actions.push("workflow-profile");
    }
    if (active) actions.push("pause");
    if (active) actions.push("emergency-stop");
    if (!anotherMissionActive && !TERMINAL_STATUSES.has(mission.status)) {
      actions.push("cancel", "record-waiting", "open-case");
      if ((mission.decisionCases || []).some((item) => item.status === "open")) actions.push("decide-case");
      if (["blocked", "awaiting_release_approval", "awaiting_external_evidence", "awaiting_result_acceptance"].includes(mission.status)) {
        actions.push("override");
      }
      if (["testing", "awaiting_review"].includes(mission.status)) actions.push("quality-decision");
    }
    if (!anotherMissionActive && mission.status === "waiting" && mission.runs.some((run) => run.status === "paused")) {
      actions.push("resume", "revise-requirements");
    }
    if (!active && !anotherMissionActive && mission.status === "blocked") {
      if (mission.blockers.some((blocker) => blocker.status === "open")) actions.push("retry");
      actions.push("revise-requirements");
    }
    if (!active && !anotherMissionActive && mission.status === "light_completed") actions.push("start-heavy-review");
    if (!anotherMissionActive && ["clarifying", "awaiting_baseline_confirmation"].includes(mission.status)) actions.push("messages");
    if (!anotherMissionActive && mission.status === "awaiting_baseline_confirmation" && mission.baseline) actions.push("confirm-baseline");
    if (!anotherMissionActive && mission.status === "release_candidate_ready" && mission.releaseCandidate) actions.push("verify-source");
    if (!anotherMissionActive && mission.status === "awaiting_release_approval" && mission.releaseCandidate?.digest) {
      const approvals = mission.approvals.filter(
        (approval) => approval.candidateId === mission.releaseCandidate.id
          && approval.candidateDigest === mission.releaseCandidate.digest,
      );
      if (!approvals.some((approval) => approval.kind === "merge_approval")) actions.push("approve-merge");
      else if (!approvals.some((approval) => approval.kind === "deployment_approval")) actions.push("approve-deployment");
    }
    if (!anotherMissionActive && mission.status === "awaiting_external_evidence") actions.push("external-evidence");
    if (!anotherMissionActive && ["release_candidate_ready", "awaiting_external_evidence"].includes(mission.status)) {
      actions.push("device-package");
    }
    if (!anotherMissionActive && (mission.externalEvidencePackages || []).some((item) => item.status === "open")) {
      actions.push("device-evidence");
    }
    if (!anotherMissionActive && mission.status === "awaiting_result_acceptance") actions.push("accept-result");
    return actions;
  }

  _assignmentForRole(roleId) {
    const inherited = !Object.hasOwn(this.roleAssignments, roleId);
    return {
      ...this.managerAssignment,
      ...(this.roleAssignments[roleId] || {}),
      inherited,
    };
  }

  _assertNoOtherActiveRun(missionId) {
    const activeMissionId = this.activeRuns.keys().next().value;
    if (activeMissionId && activeMissionId !== missionId) {
      throw Object.assign(
        new Error(`另一个 Mission 正在执行，完成或安全暂停后再继续：${activeMissionId}`),
        { statusCode: 409, missionId: activeMissionId },
      );
    }
  }

  createMission(goal, workflowProfile = "auto", targetProjectId = null) {
    const normalizedGoal = normalizeText(goal, 4000);
    if (normalizedGoal.length < 8) throw Object.assign(new Error("请描述一个明确的结果目标"), { statusCode: 400 });
    if (!this.managerAssignment.ready) {
      throw Object.assign(
        new Error(this.managerAssignment.message || "尚未配置可用的 AGENT 适配器，请先运行 npm run setup"),
        { statusCode: 503 },
      );
    }
    const activeMissionId = this.activeRuns.keys().next().value;
    if (activeMissionId) {
      throw Object.assign(new Error(`当前有角色正在执行，完成或安全暂停后才能启动新 Mission：${activeMissionId}`), { statusCode: 409, missionId: activeMissionId });
    }
    const missionId = makeId("mission");
    const profile = resolveWorkflowProfile(workflowProfile, normalizedGoal);
    const target = normalizeText(targetProjectId, 200);
    if (target) {
      const registered = this._projectRegistry().find((item) => item.id === target);
      if (!registered) throw Object.assign(new Error(`未知目标项目：${target}`), { statusCode: 400 });
      if (registered.status === "archived") throw Object.assign(new Error("目标项目已归档，请重开后再建会话"), { statusCode: 409 });
    }
    this.ledger.append("mission.created", {
      missionId,
      actorRoleId: "chief-manager",
      payload: { title: normalizedGoal.slice(0, 42), goal: normalizedGoal, workflowProfile: profile.requested, targetProjectId: target || null },
    });
    this.ledger.append("workflow_profile.selected", {
      missionId,
      actorRoleId: "chief-manager",
      payload: profile,
    });
    this.ledger.append("message.recorded", {
      missionId,
      actorRoleId: "human-owner",
      payload: { authorType: "human", roleId: "human-owner", roleName: "人类负责人", content: normalizedGoal },
    });
    this._setStatus(missionId, "clarifying", "需求明确岗开始建立需求基线");
    this._queueRequirementRun(missionId);
    return this.mission(missionId);
  }

  setWorkflowProfile(missionId, requested) {
    const mission = this._requireMission(missionId);
    if (this.activeRuns.has(missionId) && !["clarifying", "awaiting_baseline_confirmation"].includes(mission.status)) {
      throw Object.assign(new Error("活动 Run 执行中，档位变更需要先安全暂停或等待当前角色完成"), { statusCode: 409 });
    }
    if (!["clarifying", "awaiting_baseline_confirmation", "waiting", "light_completed"].includes(mission.status)) {
      throw Object.assign(new Error(`当前状态 ${mission.status} 不能直接变更工作流档位`), { statusCode: 409 });
    }
    const profile = resolveWorkflowProfile(requested, mission.goal);
    if (mission.status === "light_completed" && profile.resolved === "heavy") {
      this._assertNoOtherActiveRun(missionId);
    }
    this.ledger.append("workflow_profile.selected", {
      missionId,
      actorRoleId: "human-owner",
      payload: profile,
    });
    this.ledger.append("message.recorded", {
      missionId,
      actorRoleId: "human-owner",
      payload: {
        authorType: "human",
        roleId: "human-owner",
        roleName: "人类负责人",
        content: `工作流档位设为 ${profile.requested}，本次解析为 ${profile.resolved}。`,
      },
    });
    if (mission.status === "light_completed" && profile.resolved === "heavy") {
      this._startHeavyReview(missionId);
    }
    return this.mission(missionId);
  }

  executeCommand({ content, missionId = null, channel = "local-workbench", context = "automatic", targetProjectId = null }) {
    const normalized = normalizeText(content, 12_000);
    if (!normalized) throw Object.assign(new Error("命令不能为空"), { statusCode: 400 });
    const commandId = makeId("command");
    const missions = this.state().missions;
    const activeMission = missions.find((mission) => !TERMINAL_STATUSES.has(mission.status)) || null;
    const statusQuery = /^(?:查看|查询|汇报)?(?:当前)?(?:任务|Mission)?状态[？?。\s]*$/i.test(normalized);
    const pauseRequest = /^(?:请)?(?:安全)?暂停(?:当前)?(?:任务|Mission|运行)?[。！!\s]*$/i.test(normalized);
    const emergencyStopRequest = /^(?:请)?(?:紧急停止|立刻停止|马上停止)(?:当前)?(?:任务|Mission|运行)?[。！!\s]*$/i.test(normalized);
    const cancelRequest = /^(?:确认取消|取消)(?:当前|这个)?(?:任务|Mission)[。！!\s]*$/i.test(normalized);
    const resumeRequest = /^(?:恢复|继续)(?:任务|运行|这个任务|Mission)?[。！!\s]*$/i.test(normalized);
    const requirementRevision = /^(?:调整|修改|变更|补充|重做)(?:需求|目标|范围|验收|任务)/.test(normalized);
    const contextMode = context === "global" ? "global" : "automatic";
    const referencedMission = missions.find((mission) => normalized.includes(mission.id)) || null;
    const activeRunMissionIds = [...this.activeRuns.keys()];
    const resumableMissions = missions.filter((mission) => ["waiting", "blocked"].includes(mission.status));
    const globalActionTarget = referencedMission
      || (pauseRequest && activeRunMissionIds.length === 1 ? this._requireMission(activeRunMissionIds[0]) : null)
      || (resumeRequest && resumableMissions.length === 1 ? resumableMissions[0] : null);
    const selectedMission = missionId
      ? this._requireMission(missionId)
      : contextMode === "global"
        ? globalActionTarget
        : activeMission || (statusQuery ? missions[0] || null : null);
    const normalizedChannel = normalizeText(channel, 80) || "local-workbench";
    this.ledger.append("command.requested", {
      missionId: selectedMission?.id || null,
      actorRoleId: "human-owner",
      payload: { id: commandId, channel: normalizedChannel, context: contextMode, content: normalized },
    });
    try {
      let action;
      let mission;
      const profileMatch = normalized.match(/(?:使用|切换(?:为|到)?|改为|采用|设为)?\s*(轻度|重度|自动|light|heavy|auto)\s*模式/i);
      const profileMap = { 轻度: "light", 重度: "heavy", 自动: "auto", light: "light", heavy: "heavy", auto: "auto" };
      if (pauseRequest) {
        if (!selectedMission) throw Object.assign(new Error("没有可安全暂停的活动 Mission"), { statusCode: 409 });
        mission = this.requestSafePause(selectedMission.id);
        action = "pause_requested";
      } else if (emergencyStopRequest) {
        if (!selectedMission) throw Object.assign(new Error("没有可紧急停止的活动 Mission"), { statusCode: 409 });
        mission = this.emergencyStop(selectedMission.id);
        action = "emergency_stopped";
      } else if (cancelRequest) {
        if (!selectedMission) throw Object.assign(new Error("没有可取消的 Mission"), { statusCode: 409 });
        mission = this.cancelMission(selectedMission.id, { reason: `人类通过命令总线取消：${normalized}`.slice(0, 200) });
        action = "mission_cancelled";
      } else if (/(夜间|闲时|自动|定时).*(全量|重度).*(回顾|验证)/.test(normalized)) {
        const result = this.autoStartDueReviews();
        mission = selectedMission;
        action = "auto_heavy_review";
        this.ledger.append("command.executed", {
          missionId: mission?.id || selectedMission?.id || null,
          actorRoleId: "chief-manager",
          causationId: commandId,
          payload: { id: commandId, action, status: mission?.status || null, reply: commandReply(action, mission, this.state().missions, result), channel: normalizedChannel, context: contextMode },
        });
        return { commandId, action, reply: commandReply(action, mission, this.state().missions, result), mission: mission ? publicMission(mission) : null };
      } else if (/(开始|执行|安排|进入).*(重度|全量).*(回顾|验证|测试)/.test(normalized)) {
        if (!selectedMission) throw Object.assign(new Error("没有可进入重度回顾的 Mission"), { statusCode: 409 });
        mission = this.startHeavyReview(selectedMission.id);
        action = "start_heavy_review";
      } else       if (profileMatch) {
        if (!selectedMission) {
          mission = this.createMission(normalized, profileMap[profileMatch[1].toLowerCase()] || "auto", targetProjectId);
          action = "create_mission";
        } else {
          mission = this.setWorkflowProfile(selectedMission.id, profileMap[profileMatch[1].toLowerCase()] || "auto");
          action = "set_workflow_profile";
        }
      } else if (/确认.*(?:需求)?基线|(?:需求)?基线.*确认/.test(normalized)) {
        if (!selectedMission) throw Object.assign(new Error("没有可确认基线的 Mission"), { statusCode: 409 });
        mission = this.confirmBaseline(selectedMission.id);
        action = "confirm_baseline";
      } else if (resumeRequest) {
        if (!selectedMission) throw Object.assign(new Error("没有可恢复的 Mission"), { statusCode: 409 });
        if (selectedMission.status === "waiting") {
          mission = this.resumePaused(selectedMission.id);
          action = "resume_paused";
        } else {
          mission = this.retry(selectedMission.id);
          action = "retry_blocked";
        }
      } else if (statusQuery) {
        mission = selectedMission;
        action = contextMode === "global" && !selectedMission
          ? "query_organization_status"
          : "query_status";
      } else if (requirementRevision && selectedMission) {
        mission = this.reviseRequirements(selectedMission.id, normalized);
        action = "revise_requirements";
      } else if (!selectedMission || /^(?:新建|创建|开始)(?:一个)?(?:任务|Mission)[:：\s]/i.test(normalized)) {
        mission = this.createMission(normalized, "auto", targetProjectId);
        action = "create_mission";
      } else if (["clarifying", "awaiting_baseline_confirmation"].includes(selectedMission.status)) {
        mission = this.addHumanMessage(selectedMission.id, normalized);
        action = "add_requirement_message";
      } else if (["waiting", "blocked"].includes(selectedMission.status)) {
        mission = this.reviseRequirements(selectedMission.id, normalized);
        action = "revise_requirements";
      } else {
        throw Object.assign(new Error(`当前状态 ${selectedMission.status} 无法解释这条命令，请明确说明要查询状态、切换模式或执行门禁动作`), { statusCode: 409 });
      }
      const reply = commandReply(action, mission, this.state().missions);
      this.ledger.append("command.executed", {
        missionId: mission?.id || selectedMission?.id || null,
        actorRoleId: "chief-manager",
        causationId: commandId,
        payload: { id: commandId, action, status: mission?.status || null, reply, channel: normalizedChannel, context: contextMode },
      });
      return { commandId, action, reply, mission: mission ? publicMission(mission) : null };
    } catch (error) {
      this.ledger.append("command.rejected", {
        missionId: selectedMission?.id || null,
        actorRoleId: "chief-manager",
        causationId: commandId,
        payload: { id: commandId, error: normalizeText(error.message || String(error), 4000), channel: normalizedChannel, context: contextMode },
      });
      throw error;
    }
  }

  addHumanMessage(missionId, content) {
    const mission = this._requireMission(missionId);
    if (!["clarifying", "awaiting_baseline_confirmation"].includes(mission.status)) {
      throw Object.assign(new Error(`当前状态 ${mission.status} 不接受需求补充`), { statusCode: 409 });
    }
    this._assertNoOtherActiveRun(missionId);
    const normalized = normalizeText(content, 12_000);
    if (!normalized) throw Object.assign(new Error("补充内容不能为空"), { statusCode: 400 });
    this.ledger.append("message.recorded", {
      missionId,
      actorRoleId: "human-owner",
      payload: { authorType: "human", roleId: "human-owner", roleName: "人类负责人", content: normalized },
    });
    this._setStatus(missionId, "clarifying", "已收到人类补充，需求明确岗重新整理");
    this._queueRequirementRun(missionId);
    return this.mission(missionId);
  }

  startHeavyReview(missionId) {
    const mission = this._requireMission(missionId);
    if (mission.status !== "light_completed") {
      throw Object.assign(new Error("只有已完成的轻度交付可以直接开始重度回顾"), { statusCode: 409 });
    }
    if (this.activeRuns.has(missionId)) {
      throw Object.assign(new Error("Mission 已有活动 Run"), { statusCode: 409 });
    }
    this._assertNoOtherActiveRun(missionId);
    const profile = { requested: "heavy", resolved: "heavy", reason: "人类或系统明确启动重度全量回顾" };
    this.ledger.append("workflow_profile.selected", {
      missionId,
      actorRoleId: "human-owner",
      payload: profile,
    });
    return this._startHeavyReview(missionId);
  }

  requestSafePause(missionId) {
    const mission = this._requireMission(missionId);
    const active = this.activeRuns.get(missionId);
    if (!active) {
      if (mission.status === "waiting") return mission;
      throw Object.assign(new Error("当前 Mission 没有可暂停的活动 Run"), { statusCode: 409 });
    }
    if (active.pauseRequested) return mission;
    active.pauseRequested = true;
    active.currentAction = "正在保存检查点并安全暂停";
    this.ledger.append("run.pause_requested", {
      missionId,
      actorRoleId: "human-owner",
      payload: {
        runId: active.runId,
        invocationId: active.invocationId,
        reason: "人类请求安全暂停",
        checkpointId: active.lastCheckpoint?.id || null,
      },
    });
    active.abortController.abort();
    return this.mission(missionId);
  }

  resumePaused(missionId) {
    const mission = this._requireMission(missionId);
    if (mission.status !== "waiting") {
      throw Object.assign(new Error("只有已安全暂停的 Mission 可以继续运行"), { statusCode: 409 });
    }
    this._assertNoOtherActiveRun(missionId);
    const pausedRun = mission.runs.findLast((run) => run.status === "paused");
    if (!pausedRun) throw Object.assign(new Error("没有可恢复的暂停 Run"), { statusCode: 409 });
    const previousInvocation = pausedRun.invocations?.at(-1) || null;
    this.ledger.append("run.resume_requested", {
      missionId,
      actorRoleId: "human-owner",
      payload: {
        runId: pausedRun.id,
        previousInvocationId: previousInvocation?.id || null,
        checkpointId: pausedRun.lastCheckpoint?.id || null,
      },
    });
    this._setStatus(missionId, this._statusForRole(pausedRun.roleId), "人类要求从最近检查点继续运行");
    this._dispatchRole(missionId, pausedRun.roleId, {
      runId: pausedRun.id,
      resumed: true,
      previousInvocationId: previousInvocation?.id || null,
      checkpoint: pausedRun.lastCheckpoint || null,
    });
    return this.mission(missionId);
  }

  reviseRequirements(missionId, content) {
    const mission = this._requireMission(missionId);
    if (this.activeRuns.has(missionId)) {
      throw Object.assign(new Error("请先安全暂停当前 Run，再提交中途修改"), { statusCode: 409 });
    }
    this._assertNoOtherActiveRun(missionId);
    if (!["waiting", "blocked"].includes(mission.status)) {
      throw Object.assign(new Error(`当前状态 ${mission.status} 不能回到需求明确岗`), { statusCode: 409 });
    }
    const normalized = normalizeText(content, 12_000);
    if (!normalized) throw Object.assign(new Error("修改要求不能为空"), { statusCode: 400 });
    mission.blockers
      .filter((item) => item.status === "open")
      .forEach((blocker) => this.ledger.append("blocker.closed", {
        missionId,
        actorRoleId: "human-owner",
        payload: { id: blocker.id, resolution: "requirements_revised" },
      }));
    mission.workItems
      .filter((item) => !["completed", "superseded"].includes(item.status))
      .forEach((item) => this.ledger.append("work_item.status_changed", {
        missionId,
        actorRoleId: "task-owner",
        payload: { id: item.id, status: "superseded", reason: "人类中途修改需求" },
      }));
    this.ledger.append("requirements_revision.requested", {
      missionId,
      actorRoleId: "human-owner",
      payload: { content: normalized },
    });
    this.ledger.append("mission.revision_incremented", {
      missionId,
      actorRoleId: "human-owner",
      payload: { revision: mission.revision + 1, reason: "人类中途修改需求" },
    });
    this.ledger.append("message.recorded", {
      missionId,
      actorRoleId: "human-owner",
      payload: { authorType: "human", roleId: "human-owner", roleName: "人类负责人", content: normalized },
    });
    this._setStatus(missionId, "clarifying", "人类中途修改需求，需求明确岗重新整理基线");
    this._queueRequirementRun(missionId);
    return this.mission(missionId);
  }

  confirmBaseline(missionId) {
    const mission = this._requireMission(missionId);
    if (mission.status !== "awaiting_baseline_confirmation" || !mission.baseline) {
      throw Object.assign(new Error("当前没有可确认的需求基线"), { statusCode: 409 });
    }
    this._assertNoOtherActiveRun(missionId);
    this.ledger.append("baseline.confirmed", {
      missionId,
      actorRoleId: "human-owner",
      payload: { version: mission.baseline.version, humanExpression: "通过工作台明确确认" },
    });
    this._setStatus(missionId, "planning", "需求基线已确认，群星的调律者建立任务章程");
    this._queueManagerPlan(missionId);
    return this.mission(missionId);
  }

  retry(missionId) {
    const mission = this._requireMission(missionId);
    if (mission.status !== "blocked") {
      throw Object.assign(new Error("只有阻塞 Mission 可以重试"), { statusCode: 409 });
    }
    this._assertNoOtherActiveRun(missionId);
    const openBlocker = mission.blockers.findLast((item) => item.status === "open");
    if (!openBlocker) throw Object.assign(new Error("没有开放的 BlockerCase"), { statusCode: 409 });
    const attempts = mission.blockers.filter(
      (item) => item.status === "closed" && item.resolution === "retry",
    ).length;
    if (attempts >= this.maxRecoveryAttempts) {
      throw Object.assign(new Error("恢复预算已耗尽，需要人类处理"), { statusCode: 409 });
    }
    const roleId = openBlocker.failedRoleId || mission.runs.at(-1)?.roleId;
    if (!roleId) throw Object.assign(new Error("BlockerCase 缺少可恢复责任角色"), { statusCode: 409 });
    this.ledger.append("blocker.closed", {
      missionId,
      actorRoleId: "blocker-lead",
      payload: {
        id: openBlocker.id,
        resolution: "retry",
        attemptNumber: attempts + 1,
        attemptBudget: this.maxRecoveryAttempts,
      },
    });
    this._setStatus(missionId, this._statusForRole(roleId), `解障负责人发起第 ${attempts + 1} 次有限恢复`);
    if (roleId === "requirements-lead") this._queueRequirementRun(missionId);
    else if (roleId === "chief-manager") this._queueManagerPlan(missionId);
    else if (roleId === "engineering") this._queueEngineeringRun(missionId);
    else if (roleId === "independent-reviewer") this._queueReviewRun(missionId);
    else if (roleId === "tester") this._queueTestRun(missionId);
    else throw Object.assign(new Error(`暂不支持恢复角色 ${roleId}`), { statusCode: 409 });
    return this.mission(missionId);
  }

  verifyReleaseSource(missionId, source) {
    const mission = this._requireMission(missionId);
    this._assertNoOtherActiveRun(missionId);
    if (mission.status !== "release_candidate_ready" || !mission.releaseCandidate) {
      throw Object.assign(new Error("当前没有待核对来源的发布候选"), { statusCode: 409 });
    }
    assertObject(source, "发布来源快照");
    const snapshot = {
      repository: normalizeText(source.repository, 500),
      workingDirectory: normalizeText(source.workingDirectory, 2000),
      sourceRef: normalizeText(source.sourceRef, 300),
      sourceRefCommit: normalizeText(source.sourceRefCommit, 100),
      branch: normalizeText(source.branch, 300),
      headCommit: normalizeText(source.headCommit, 100),
      clean: source.clean === true,
      ahead: Number(source.ahead),
      behind: Number(source.behind),
      diffStat: normalizeText(source.diffStat, 12_000),
      projectConfigHashes:
        source.projectConfigHashes && typeof source.projectConfigHashes === "object"
          ? source.projectConfigHashes
          : {},
    };
    if (path.resolve(snapshot.workingDirectory) !== path.resolve(this._projectFor(mission).workingDirectory || this.project.workingDirectory)) {
      throw Object.assign(new Error("发布来源工作树与 Mission 目标项目工作树不一致"), { statusCode: 409 });
    }
    if (!snapshot.sourceRefCommit || !snapshot.headCommit || !snapshot.branch) {
      throw Object.assign(new Error("发布来源缺少分支或提交身份"), { statusCode: 409 });
    }
    if (!snapshot.clean) {
      throw Object.assign(new Error("发布候选工作树不干净，不能申请发布授权"), { statusCode: 409 });
    }
    if (!Number.isInteger(snapshot.ahead) || snapshot.ahead < 1 || snapshot.behind !== 0) {
      throw Object.assign(new Error("发布候选必须领先且不落后于已核对的远端基线"), { statusCode: 409 });
    }
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          candidateId: mission.releaseCandidate.id,
          baselineVersion: mission.releaseCandidate.baselineVersion,
          evidenceIds: mission.releaseCandidate.evidenceIds,
          snapshot,
        }),
      )
      .digest("hex");
    this.ledger.append("release_candidate.source_verified", {
      missionId,
      actorRoleId: "task-owner",
      payload: { id: mission.releaseCandidate.id, sourceSnapshot: snapshot, digest },
    });
    this._setStatus(missionId, "awaiting_release_approval", "候选来源已核对，等待人类批准合并");
    return this.mission(missionId);
  }

  approveMerge(missionId) {
    const mission = this._requireVerifiedCandidate(missionId);
    this._assertNoOtherActiveRun(missionId);
    if (this._candidateApproval(mission, "merge_approval")) {
      throw Object.assign(new Error("该发布候选已获得合并授权"), { statusCode: 409 });
    }
    this._recordCandidateApproval(mission, "merge_approval", "人类明确批准合并该候选");
    this._setStatus(missionId, "awaiting_release_approval", "合并授权已记录，等待人类批准部署候选");
    return this.mission(missionId);
  }

  approveDeployment(missionId) {
    const mission = this._requireVerifiedCandidate(missionId);
    this._assertNoOtherActiveRun(missionId);
    if (!this._candidateApproval(mission, "merge_approval")) {
      throw Object.assign(new Error("必须先单独批准合并"), { statusCode: 409 });
    }
    if (this._candidateApproval(mission, "deployment_approval")) {
      throw Object.assign(new Error("该发布候选已获得部署授权"), { statusCode: 409 });
    }
    this._recordCandidateApproval(
      mission,
      "deployment_approval",
      "人类明确批准部署该候选",
    );
    this._setStatus(missionId, "awaiting_external_evidence", "部署授权已记录，等待绑定候选身份的外部验收证据");
    return this.mission(missionId);
  }

  generateDevicePackage(missionId, input) {
    const mission = this._requireMission(missionId);
    assertObject(input, "真机执行包");
    if (!mission.releaseCandidate) throw Object.assign(new Error("当前没有发布候选，不能生成真机执行包"), { statusCode: 409 });
    const version = normalizeText(input.version, 200);
    const buildIdentity = normalizeText(input.buildIdentity, 500);
    if (version.length < 1 || buildIdentity.length < 4) {
      throw Object.assign(new Error("必须填写版本号与精确构建身份"), { statusCode: 400 });
    }
    const manifest = this._manifestFor(mission);
    const generated = manifest.requiredTests.map((item, index) => ({
      id: `E${index + 1}`,
      action: `在真机上按验收标准执行：${item.name}`,
      expected: item.command ? `达到“${item.command}”的预期结果` : "达到需求基线中的对应验收标准",
      requiredEvidence: "截图或录像",
      stopCondition: "失败即停止并记录严重度",
    }));
    const customSteps = Array.isArray(input.customSteps) ? input.customSteps : [];
    const steps = [...generated, ...customSteps.map((item, index) => {
      assertObject(item, `自定义步骤 ${index + 1}`);
      return {
        id: normalizeText(item.id, 40) || `C${index + 1}`,
        action: normalizeText(item.action, 2000),
        expected: normalizeText(item.expected, 2000),
        requiredEvidence: normalizeText(item.requiredEvidence, 1000) || "截图或录像",
        stopCondition: normalizeText(item.stopCondition, 1000),
      };
    })].filter((item) => item.action);
    if (!steps.length) throw Object.assign(new Error("执行包至少需要一个步骤"), { statusCode: 400 });
    const id = makeId("devpkg");
    this.ledger.append("device_package.created", {
      missionId,
      actorRoleId: "tester",
      payload: {
        id,
        candidateId: mission.releaseCandidate.id,
        version,
        buildIdentity,
        commit: normalizeText(input.commit, 100) || mission.releaseCandidate.headCommit || null,
        devices: Array.isArray(input.devices) ? input.devices.map((item) => normalizeText(item, 300)).filter(Boolean) : [],
        preconditions: Array.isArray(input.preconditions) ? input.preconditions.map((item) => normalizeText(item, 1000)).filter(Boolean) : [],
        steps,
      },
    });
    return this.mission(missionId);
  }

  recordDeviceEvidence(missionId, packageId, input) {
    const mission = this._requireMission(missionId);
    assertObject(input, "真机证据");
    const devicePackage = mission.externalEvidencePackages.find((item) => item.id === packageId);
    if (!devicePackage || devicePackage.status !== "open") {
      throw Object.assign(new Error("真机执行包不存在或已回填"), { statusCode: 409 });
    }
    const results = Array.isArray(input.results) ? input.results : [];
    const missing = devicePackage.steps.map((step) => step.id).filter((id) => !results.some((item) => item.stepId === id));
    if (missing.length) throw Object.assign(new Error(`缺少步骤证据：${missing.join("、")}`), { statusCode: 400 });
    const bad = results.find((item) => !["passed", "failed", "blocked"].includes(item.result));
    if (bad) throw Object.assign(new Error("步骤结论只能是 passed、failed 或 blocked"), { statusCode: 400 });
    const tester = normalizeText(input.tester, 200);
    if (tester.length < 1) throw Object.assign(new Error("必须记录测试人"), { statusCode: 400 });
    const verdict = results.every((item) => item.result === "passed") ? "passed" : "failed";
    this.ledger.append("device_package.evidence_recorded", {
      missionId,
      actorRoleId: "human-owner",
      payload: {
        id: packageId,
        verdict,
        results: results.map((item) => ({
          stepId: normalizeText(item.stepId, 40),
          result: item.result,
          evidence: normalizeText(item.evidence, 2000),
          at: normalizeText(item.at, 100),
        })),
        tester,
        testedAt: normalizeText(input.testedAt, 100) || nowIso(),
      },
    });
    return this.mission(missionId);
  }

  recordExternalEvidence(missionId, input) {    const mission = this._requireMission(missionId);
    this._assertNoOtherActiveRun(missionId);
    if (mission.status !== "awaiting_external_evidence" || !mission.releaseCandidate?.digest) {
      throw Object.assign(new Error("当前不接受外部验收证据"), { statusCode: 409 });
    }
    assertObject(input, "外部验收证据");
    const buildIdentity = normalizeText(input.buildIdentity, 500);
    const result = input.result === "passed" ? "passed" : input.result === "failed" ? "failed" : "";
    const notes = normalizeText(input.notes, 6000);
    if (buildIdentity.length < 4 || !result) {
      throw Object.assign(new Error("必须填写准确候选身份并选择通过或失败"), { statusCode: 400 });
    }
    this.ledger.append("external_evidence.recorded", {
      missionId,
      actorRoleId: "human-owner",
      payload: {
        candidateId: mission.releaseCandidate.id,
        candidateDigest: mission.releaseCandidate.digest,
        buildIdentity,
        result,
        notes,
      },
    });
    if (result === "passed") {
      this._setStatus(missionId, "awaiting_result_acceptance", "绑定候选的外部验收证据通过，等待人类验收业务结果");
      return this.mission(missionId);
    }
    this.ledger.append("release_candidate.invalidated", {
      missionId,
      actorRoleId: "human-owner",
      payload: { id: mission.releaseCandidate.id, reason: "外部验收失败" },
    });
    if (this._createReworkItem(missionId, "外部验收返工", "external_evidence_failure", notes || buildIdentity)) {
      this._setStatus(missionId, "executing", "外部验收失败，工程执行岗开始返工");
      setImmediate(() => this._queueEngineeringRun(missionId));
    }
    return this.mission(missionId);
  }

  acceptResult(missionId) {
    const mission = this._requireMission(missionId);
    this._assertNoOtherActiveRun(missionId);
    if (mission.status !== "awaiting_result_acceptance" || !mission.releaseCandidate?.digest) {
      throw Object.assign(new Error("当前没有可验收的业务结果"), { statusCode: 409 });
    }
    const evidence = mission.externalEvidence.findLast(
      (item) => item.candidateId === mission.releaseCandidate.id && item.result === "passed",
    );
    if (!evidence) throw Object.assign(new Error("缺少绑定当前候选的通过外部验收证据"), { statusCode: 409 });
    this._recordCandidateApproval(mission, "result_acceptance", "人类明确验收业务结果");
    this._setStatus(missionId, "accepted", "人类已验收业务结果，Mission 完成");
    return this.mission(missionId);
  }

  requestDecision(missionId, input) {
    const mission = this._requireMission(missionId);
    assertObject(input, "决策事项");
    const title = normalizeText(input.title, 500);
    if (title.length < 4) throw Object.assign(new Error("决策事项需要明确标题"), { statusCode: 400 });
    const options = Array.isArray(input.options) ? input.options.map((item) => normalizeText(item, 2000)).filter(Boolean) : [];
    const id = makeId("dec");
    this.ledger.append("decision.requested", {
      missionId,
      actorRoleId: normalizeText(input.submittedRoleId, 80) || "chief-manager",
      payload: {
        id,
        title,
        kind: normalizeText(input.kind, 80) || "general",
        facts: normalizeText(input.facts, 6000),
        impacts: normalizeText(input.impacts, 6000),
        options,
        recommendation: normalizeText(input.recommendation, 4000),
        urgency: ["low", "normal", "high", "critical"].includes(input.urgency) ? input.urgency : "normal",
        noDecisionConsequence: normalizeText(input.noDecisionConsequence, 2000),
        objectKind: normalizeText(input.objectKind, 120),
        objectVersion: normalizeText(input.objectVersion, 300),
        ownerRoleId: normalizeText(input.ownerRoleId, 80) || "human-owner",
        directReport: input.directReport === true,
      },
    });
    return this.mission(missionId);
  }

  resolveDecision(missionId, decisionId, input) {
    const mission = this._requireMission(missionId);
    assertObject(input, "决策裁决");
    const decision = mission.decisions.find((item) => item.id === decisionId);
    if (!decision || decision.status !== "open") {
      throw Object.assign(new Error("决策事项不存在或已处理"), { statusCode: 409 });
    }
    if (!["approved", "rejected", "deferred"].includes(input.resolution)) {
      throw Object.assign(new Error("裁决只能是批准、驳回或暂缓"), { statusCode: 400 });
    }
    if (normalizeText(input.decidedBy, 80) !== "human-owner") {
      throw Object.assign(new Error("只有人类负责人能裁决决策事项"), { statusCode: 403 });
    }
    this.ledger.append("decision.resolved", {
      missionId,
      actorRoleId: "human-owner",
      payload: { id: decisionId, resolution: input.resolution, note: normalizeText(input.note, 4000) },
    });
    return this.mission(missionId);
  }

  _autoRequestGateDecision(missionId, to) {
    const templates = {
      awaiting_baseline_confirmation: { kind: "baseline_confirmation", title: "确认需求基线", objectKind: "RequirementBaseline" },
      awaiting_release_approval: { kind: "release_approval", title: "批准发布候选", objectKind: "ReleaseCandidate" },
      awaiting_external_evidence: { kind: "external_evidence", title: "回填外部验收证据", objectKind: "ReleaseCandidate" },
      awaiting_result_acceptance: { kind: "result_acceptance", title: "验收业务结果", objectKind: "ReleaseCandidate" },
    };
    const template = templates[to];
    if (!template) return;
    const mission = this.mission(missionId);
    if (!mission) return;
    const objectVersion = template.objectKind === "RequirementBaseline"
      ? mission.baseline?.version || ""
      : mission.releaseCandidate ? `${mission.releaseCandidate.id}:${mission.releaseCandidate.digest || ""}` : "";
    const exists = mission.decisions.some(
      (item) => item.status === "open" && item.kind === template.kind && (item.objectVersion || "") === objectVersion,
    );
    if (exists) return;
    this.requestDecision(missionId, {
      ...template,
      objectVersion,
      facts: mission.statusReason || "",
      urgency: "high",
      noDecisionConsequence: "不处理将阻塞 Mission 继续推进",
    });
  }

  grantOverride(missionId, input) {
    const mission = this._requireMission(missionId);
    assertObject(input, "紧急绕过授权");
    if (normalizeText(input.decidedBy, 80) !== "human-owner") {
      throw Object.assign(new Error("只有人类负责人能授予紧急绕过"), { statusCode: 403 });
    }
    const overriddenGates = Array.isArray(input.overriddenGates)
      ? input.overriddenGates.map((item) => normalizeText(item, 200)).filter(Boolean)
      : [];
    if (!overriddenGates.length) {
      throw Object.assign(new Error("必须明确列出被绕过的门禁或缺失证据"), { statusCode: 400 });
    }
    const reason = normalizeText(input.reason, 4000);
    const risk = normalizeText(input.risk, 4000);
    if (reason.length < 4 || risk.length < 4) {
      throw Object.assign(new Error("必须说明绕过原因与承担风险"), { statusCode: 400 });
    }
    const expiresAt = normalizeText(input.expiresAt, 100);
    if (!expiresAt || Number.isNaN(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) {
      throw Object.assign(new Error("必须设定一个未来的到期时间"), { statusCode: 400 });
    }
    const id = makeId("ovr");
    this.ledger.append("override.granted", {
      missionId,
      actorRoleId: "human-owner",
      payload: {
        id,
        overriddenGates,
        reason,
        risk,
        allowedActions: Array.isArray(input.allowedActions) ? input.allowedActions.map((item) => normalizeText(item, 300)).filter(Boolean) : [],
        forbiddenActions: Array.isArray(input.forbiddenActions) ? input.forbiddenActions.map((item) => normalizeText(item, 300)).filter(Boolean) : [],
        expiresAt,
        rollbackTrigger: normalizeText(input.rollbackTrigger, 2000),
        compensation: normalizeText(input.compensation, 2000),
      },
    });
    this.ledger.append("risk_debt.recorded", {
      missionId,
      actorRoleId: "human-owner",
      payload: {
        id: makeId("risk"),
        source: "emergency_override",
        linkedOverrideId: id,
        description: `紧急绕过 ${id} 产生的风险债务：${risk}`.slice(0, 4000),
        ownerRoleId: "human-owner",
        dueAt: expiresAt,
      },
    });
    return this.mission(missionId);
  }

  expireOverride(missionId, overrideId) {
    const mission = this._requireMission(missionId);
    const override = mission.overrides.find((item) => item.id === overrideId);
    if (!override || override.status !== "active") {
      throw Object.assign(new Error("绕过授权不存在或已失效"), { statusCode: 409 });
    }
    this.ledger.append("override.expired", {
      missionId,
      actorRoleId: "human-owner",
      payload: { id: overrideId, reason: "人类手动终止或到期" },
    });
    return this.mission(missionId);
  }

  recordRiskDebt(missionId, input) {
    const mission = this._requireMission(missionId);
    assertObject(input, "风险债务");
    const description = normalizeText(input.description, 4000);
    if (description.length < 4) throw Object.assign(new Error("风险债务需要明确描述"), { statusCode: 400 });
    this.ledger.append("risk_debt.recorded", {
      missionId,
      actorRoleId: "human-owner",
      payload: {
        id: makeId("risk"),
        source: normalizeText(input.source, 200) || "manual",
        linkedOverrideId: normalizeText(input.linkedOverrideId, 200),
        description,
        ownerRoleId: normalizeText(input.ownerRoleId, 80) || "human-owner",
        dueAt: normalizeText(input.dueAt, 100),
      },
    });
    return this.mission(missionId);
  }

  closeRiskDebt(missionId, debtId, input = {}) {
    const mission = this._requireMission(missionId);
    const debt = mission.riskDebts.find((item) => item.id === debtId);
    if (!debt || debt.status !== "open") {
      throw Object.assign(new Error("风险债务不存在或已关闭"), { statusCode: 409 });
    }
    this.ledger.append("risk_debt.closed", {
      missionId,
      actorRoleId: "human-owner",
      payload: { id: debtId, resolution: normalizeText(input.resolution, 2000) || "已补偿并复盘" },
    });
    return this.mission(missionId);
  }

  decideQuality(missionId, input) {
    const mission = this._requireMission(missionId);
    assertObject(input, "质量判定");
    if (!["testing", "awaiting_review", "awaiting_result_acceptance"].includes(mission.status)) {
      throw Object.assign(new Error(`当前状态 ${mission.status} 不需要质量判定`), { statusCode: 409 });
    }
    if (normalizeText(input.decidedBy, 80) !== "human-owner") {
      throw Object.assign(new Error("只有人类负责人能签署质量判定"), { statusCode: 403 });
    }
    if (!["passed", "blocked"].includes(input.verdict)) {
      throw Object.assign(new Error("质量 verdict 只能是 passed 或 blocked"), { statusCode: 400 });
    }
    this.ledger.append("quality.decided", {
      missionId,
      actorRoleId: "human-owner",
      payload: {
        verdict: input.verdict,
        reviewCount: mission.reviews.length,
        testRunCount: mission.testRuns.length,
        openGapCases: mission.gapCases.filter((item) => item.status === "open").length,
        basis: normalizeText(input.basis, 4000),
      },
    });
    return this.mission(missionId);
  }

  recordWaiting(missionId, input) {
    const mission = this._requireMission(missionId);
    assertObject(input, "等待条件");
    const reason = normalizeText(input.reason, 2000);
    if (reason.length < 4) throw Object.assign(new Error("等待条件需要明确原因"), { statusCode: 400 });
    const id = makeId("wait");
    this.ledger.append("waiting_condition.recorded", {
      missionId,
      actorRoleId: normalizeText(input.recordedRoleId, 80) || "chief-manager",
      payload: {
        id,
        reason,
        responsibleRoleId: normalizeText(input.responsibleRoleId, 80) || "chief-manager",
        expectedAt: normalizeText(input.expectedAt, 100),
      },
    });
    return this.mission(missionId);
  }

  closeWaiting(missionId, waitingId, input = {}) {
    const mission = this._requireMission(missionId);
    const waiting = mission.waitingConditions.find((item) => item.id === waitingId);
    if (!waiting || waiting.status !== "open") {
      throw Object.assign(new Error("等待条件不存在或已关闭"), { statusCode: 409 });
    }
    this.ledger.append("waiting_condition.closed", {
      missionId,
      actorRoleId: "human-owner",
      payload: { id: waitingId, outcome: normalizeText(input.outcome, 2000) || "条件满足" },
    });
    return this.mission(missionId);
  }

  openDecisionCase(missionId, input) {
    const mission = this._requireMission(missionId);
    assertObject(input, "决策事项");
    const title = normalizeText(input.title, 500);
    if (title.length < 4) throw Object.assign(new Error("决策事项需要明确标题"), { statusCode: 400 });
    const ownerRoleId = normalizeText(input.ownerRoleId, 80);
    if (!ownerRoleId || (!ROLE_BY_ID.has(ownerRoleId) && ownerRoleId !== "human-owner")) {
      throw Object.assign(new Error("必须明确指定 DecisionOwner"), { statusCode: 400 });
    }
    const id = makeId("dcase");
    this.ledger.append("decision_case.opened", {
      missionId,
      actorRoleId: "human-owner",
      payload: {
        id,
        title,
        context: normalizeText(input.context, 6000),
        ownerRoleId,
        ideaSets: [],
        briefs: [],
      },
    });
    return this.mission(missionId);
  }

  recordIdeaSet(missionId, input) {
    const mission = this._requireMission(missionId);
    assertObject(input, "创意集合");
    const clusters = Array.isArray(input.clusters) ? input.clusters.map((item) => normalizeText(item, 2000)).filter(Boolean) : [];
    if (!clusters.length) throw Object.assign(new Error("IdeaSet 至少需要一个实质不同的方案簇"), { statusCode: 400 });
    for (let left = 0; left < clusters.length; left += 1) {
      for (let right = left + 1; right < clusters.length; right += 1) {
        if (ideaClusterSimilarity(clusters[left], clusters[right]) > 0.8) {
          throw Object.assign(new Error("方案簇之间过于同义，请提供语义实质不同的可能性"), { statusCode: 400 });
        }
      }
    }
    if (input.decisionCaseId) {
      const decisionCase = mission.decisionCases.find((item) => item.id === input.decisionCaseId);
      if (!decisionCase || decisionCase.status !== "open") throw Object.assign(new Error("决策事项不存在或已关闭"), { statusCode: 409 });
    }
    this.ledger.append("idea_set.recorded", {
      missionId,
      actorRoleId: normalizeText(input.recordedRoleId, 80) || "creator",
      payload: {
        id: makeId("idea"),
        decisionCaseId: normalizeText(input.decisionCaseId, 200) || null,
        problem: normalizeText(input.problem, 2000),
        clusters,
        extremeOptions: Array.isArray(input.extremeOptions) ? input.extremeOptions.map((item) => normalizeText(item, 2000)).filter(Boolean) : [],
        assumptions: Array.isArray(input.assumptions) ? input.assumptions.map((item) => normalizeText(item, 2000)).filter(Boolean) : [],
        unknowns: Array.isArray(input.unknowns) ? input.unknowns.map((item) => normalizeText(item, 2000)).filter(Boolean) : [],
      },
    });
    return this.mission(missionId);
  }

  recordDecisionBrief(missionId, input) {
    const mission = this._requireMission(missionId);
    assertObject(input, "抉择简报");
    const decisionCase = mission.decisionCases.find((item) => item.id === input.decisionCaseId);
    if (!decisionCase || decisionCase.status !== "open") throw Object.assign(new Error("决策事项不存在或已关闭"), { statusCode: 409 });
    const candidates = Array.isArray(input.candidates) ? input.candidates.map((item) => normalizeText(item, 2000)).filter(Boolean) : [];
    if (!candidates.length) throw Object.assign(new Error("DecisionBrief 必须覆盖全部已登记候选"), { statusCode: 400 });
    if (!Array.isArray(input.minorityOpinions)) throw Object.assign(new Error("必须明确记录少数意见（可为空数组，但不能缺席）"), { statusCode: 400 });
    this.ledger.append("decision_brief.recorded", {
      missionId,
      actorRoleId: normalizeText(input.recordedRoleId, 80) || "deliberator",
      payload: {
        decisionCaseId: decisionCase.id,
        candidates,
        tradeoffs: normalizeText(input.tradeoffs, 6000),
        recommendation: normalizeText(input.recommendation, 4000),
        confidence: ["low", "medium", "high"].includes(input.confidence) ? input.confidence : "medium",
        minorityOpinions: input.minorityOpinions.map((item) => normalizeText(item, 2000)),
        reconsiderConditions: normalizeText(input.reconsiderConditions, 2000),
      },
    });
    return this.mission(missionId);
  }

  decideCase(missionId, caseId, input) {
    const mission = this._requireMission(missionId);
    assertObject(input, "正式决定");
    const decisionCase = mission.decisionCases.find((item) => item.id === caseId);
    if (!decisionCase || decisionCase.status !== "open") {
      throw Object.assign(new Error("决策事项不存在或已关闭"), { statusCode: 409 });
    }
    if (!(decisionCase.briefs || []).length) {
      throw Object.assign(new Error("需要至少一份 DecisionBrief 才能形成正式决定，避免无限反刍占用组织资源"), { statusCode: 409 });
    }
    const decidedBy = normalizeText(input.decidedBy, 80);
    if (decidedBy !== decisionCase.ownerRoleId) {
      throw Object.assign(new Error(`最终决定权属于 ${decisionCase.ownerRoleId}，不能由他人代替`), { statusCode: 403 });
    }
    const decision = normalizeText(input.decision, 4000);
    if (decision.length < 4) throw Object.assign(new Error("正式决定需要明确内容"), { statusCode: 400 });
    this.ledger.append("decision_case.decided", {
      missionId,
      actorRoleId: decidedBy,
      payload: { id: caseId, decision },
    });
    return this.mission(missionId);
  }

  submitEvolutionProposal(missionId, input) {
    const mission = this._requireMission(missionId);
    assertObject(input, "演进提案");
    const problem = normalizeText(input.problem, 4000);
    const hypothesis = normalizeText(input.hypothesis, 4000);
    if (problem.length < 4 || hypothesis.length < 4) {
      throw Object.assign(new Error("演进提案需要有证据的问题定义与可证伪假设"), { statusCode: 400 });
    }
    const id = makeId("evo");
    this.ledger.append("evolution_proposal.submitted", {
      missionId,
      actorRoleId: normalizeText(input.submittedRoleId, 80) || "evolution-lead",
      payload: {
        id,
        problem,
        evidence: normalizeText(input.evidence, 6000),
        hypothesis,
        impact: normalizeText(input.impact, 4000),
        experiment: normalizeText(input.experiment, 4000),
        metrics: normalizeText(input.metrics, 2000),
        rollback: normalizeText(input.rollback, 2000),
      },
    });
    return this.mission(missionId);
  }

  decideEvolutionProposal(missionId, proposalId, input) {
    const mission = this._requireMission(missionId);
    assertObject(input, "演进裁决");
    const proposal = mission.evolutionProposals.find((item) => item.id === proposalId);
    if (!proposal || proposal.status !== "proposed") {
      throw Object.assign(new Error("演进提案不存在或已裁决"), { statusCode: 409 });
    }
    if (normalizeText(input.decidedBy, 80) !== "human-owner") {
      throw Object.assign(new Error("只有人类负责人能裁决演进提案"), { statusCode: 403 });
    }
    if (!["approved", "rejected"].includes(input.decision)) {
      throw Object.assign(new Error("演进裁决只能是批准或驳回"), { statusCode: 400 });
    }
    this.ledger.append("evolution_proposal.decided", {
      missionId,
      actorRoleId: "human-owner",
      payload: { id: proposalId, decision: input.decision, note: normalizeText(input.note, 4000) },
    });
    return this.mission(missionId);
  }

  recordSkillCandidate(missionId, input) {
    const mission = this._requireMission(missionId);
    assertObject(input, "技能候选");
    const name = normalizeText(input.name, 300);
    if (name.length < 2) throw Object.assign(new Error("技能候选需要名称"), { statusCode: 400 });
    const id = makeId("skill");
    this.ledger.append("skill_candidate.recorded", {
      missionId,
      actorRoleId: normalizeText(input.recordedRoleId, 80) || "information-skill-steward",
      payload: {
        id,
        kind: input.kind === "index_gap" ? "index_gap" : "skill",
        name,
        description: normalizeText(input.description, 4000),
        source: normalizeText(input.source, 2000),
        hits: 0,
      },
    });
    return this.mission(missionId);
  }

  evaluateInspections() {
    const findings = [];
    const now = Date.now();
    for (const mission of this.state().missions) {
      for (const run of mission.runs || []) {
        if (run.status !== "running") continue;
        const heartbeatAge = run.lastHeartbeatAt ? now - Date.parse(run.lastHeartbeatAt) : Number.POSITIVE_INFINITY;
        const checkpointAge = run.lastCheckpointAt ? now - Date.parse(run.lastCheckpointAt) : Number.POSITIVE_INFINITY;
        if (checkpointAge > 5 * 60_000) {
          findings.push({ level: "warning", missionId: mission.id, kind: "suspected_stall", detail: `Run ${run.id} 已超过 5 分钟没有有效进度检查点` });
        } else if (heartbeatAge > 5 * 60_000) {
          findings.push({ level: "warning", missionId: mission.id, kind: "connection_anomaly", detail: `Run ${run.id} 已超过 5 分钟没有心跳` });
        }
      }
      if (mission.status === "blocked") {
        const exhausted = (mission.blockers || []).some(
          (item) => item.status === "closed" && item.resolution === "retry" && (item.attemptNumber || 0) >= this.maxRecoveryAttempts,
        );
        if (exhausted || !(mission.blockers || []).some((item) => item.status === "open")) {
          findings.push({ level: "critical", missionId: mission.id, kind: "needs_human", detail: "阻塞恢复预算已耗尽或无开放恢复路径，需要人类处理" });
        }
      }
      for (const waiting of mission.waitingConditions || []) {
        if (waiting.status === "open" && waiting.expectedAt && Date.parse(waiting.expectedAt) < now) {
          findings.push({ level: "warning", missionId: mission.id, kind: "waiting_overdue", detail: `等待条件 ${waiting.id} 已超过预计时间` });
        }
      }
    }
    return { at: nowIso(), findings };
  }

  decideSkill(missionId, skillId, input) {
    const mission = this._requireMission(missionId);
    assertObject(input, "技能裁决");
    const skill = mission.skills.find((item) => item.id === skillId);
    if (!skill || skill.status !== "candidate") {
      throw Object.assign(new Error("技能候选不存在或已裁决"), { statusCode: 409 });
    }
    const decidedBy = normalizeText(input.decidedBy, 80);
    if (decidedBy !== "information-skill-steward" && decidedBy !== "human-owner") {
      throw Object.assign(new Error("技能只能由信息与技能管理岗或人类负责人裁决"), { statusCode: 403 });
    }
    if (!["published", "deprecated"].includes(input.decision)) {
      throw Object.assign(new Error("技能裁决只能是发布或废弃"), { statusCode: 400 });
    }
    this.ledger.append("skill.decided", {
      missionId,
      actorRoleId: decidedBy,
      payload: { id: skillId, decision: input.decision, version: normalizeText(input.version, 100) || "1.0.0" },
    });
    return this.mission(missionId);
  }

  evaluateAutoReview(missionId) {    const mission = this._requireMission(missionId);
    if (mission.status !== "light_completed") {
      return { missionId, triggered: false, reasons: ["非轻度完成状态"], changeCount: 0, lastBaselineAt: null };
    }
    const lastBaselineAt = mission.verifiedBaselines.at(-1)?.at || null;
    const changesSince = mission.changeRecords.filter((item) => !lastBaselineAt || item.at > lastBaselineAt);
    const reasons = [];
    if (!lastBaselineAt && changesSince.length) reasons.push("从未生成验证基线");
    if (changesSince.length >= 5) reasons.push(`未覆盖轻度变更 ${changesSince.length} 项达到阈值`);
    if (lastBaselineAt && Date.now() - Date.parse(lastBaselineAt) > 7 * 86400_000) reasons.push("距上次全量验证超过 7 天");
    return { missionId, triggered: reasons.length > 0, reasons, changeCount: changesSince.length, lastBaselineAt };
  }

  autoStartDueReviews() {
    const started = [];
    const skipped = [];
    for (const mission of this.state().missions) {
      if (mission.status !== "light_completed") continue;
      const evaluation = this.evaluateAutoReview(mission.id);
      if (!evaluation.triggered) {
        skipped.push({ id: mission.id, reason: evaluation.reasons.join("；") || "暂未达到触发条件" });
        continue;
      }
      try {
        this.startHeavyReview(mission.id);
        started.push(mission.id);
      } catch (error) {
        skipped.push({ id: mission.id, reason: error.message || String(error) });
      }
    }
    return { started, skipped };
  }

  cancelMission(missionId, input = {}) {    const mission = this._requireMission(missionId);
    if (TERMINAL_STATUSES.has(mission.status)) {
      throw Object.assign(new Error(`Mission 已终结（${mission.status}），不能取消`), { statusCode: 409 });
    }
    this._assertNoOtherActiveRun(missionId);
    if (this.activeRuns.has(missionId)) this.requestSafePause(missionId);
    const reason = normalizeText(input.reason, 2000) || "人类负责人取消任务";
    this.ledger.append("mission.cancelled", {
      missionId,
      actorRoleId: "human-owner",
      payload: { reason, revision: mission.revision },
    });
    this._setStatus(missionId, "cancelled", reason);
    return this.mission(missionId);
  }

  emergencyStop(missionId, input = {}) {
    const mission = this._requireMission(missionId);
    const active = this.activeRuns.get(missionId);
    if (!active) {
      throw Object.assign(new Error("当前 Mission 没有可紧急停止的活动 Run，请使用安全暂停或取消"), { statusCode: 409 });
    }
    if (active.pauseRequested) {
      throw Object.assign(new Error("已有安全暂停在进行，紧急停止与其互斥"), { statusCode: 409 });
    }
    const reason = normalizeText(input.reason, 2000) || "人类负责人紧急停止";
    active.stopRequested = true;
    active.currentAction = "正在紧急停止并保存现场";
    this.ledger.append("run.stop_requested", {
      missionId,
      actorRoleId: "human-owner",
      payload: { runId: active.runId, invocationId: active.invocationId, reason },
    });
    active.abortController.abort();
    return this.mission(missionId);
  }

  _requireMission(missionId) {
    const mission = this.mission(missionId);
    if (!mission) throw Object.assign(new Error("Mission 不存在"), { statusCode: 404 });
    return mission;
  }

  _requireVerifiedCandidate(missionId) {
    const mission = this._requireMission(missionId);
    if (mission.status !== "awaiting_release_approval" || !mission.releaseCandidate?.digest) {
      throw Object.assign(new Error("发布候选尚未完成来源核对"), { statusCode: 409 });
    }
    return mission;
  }

  _candidateApproval(mission, kind) {
    return mission.approvals.find(
      (approval) =>
        approval.kind === kind &&
        approval.candidateId === mission.releaseCandidate?.id &&
        approval.candidateDigest === mission.releaseCandidate?.digest,
    );
  }

  _recordCandidateApproval(mission, kind, humanExpression) {
    this.ledger.append("approval.recorded", {
      missionId: mission.id,
      actorRoleId: "human-owner",
      payload: {
        kind,
        candidateId: mission.releaseCandidate.id,
        candidateDigest: mission.releaseCandidate.digest,
        humanExpression,
      },
    });
  }

  _continueAfterCurrentRun(missionId, callback) {
    const current = this.activeRuns.get(missionId);
    if (!current?.task) {
      setImmediate(callback);
      return;
    }
    current.task.finally(() => setImmediate(callback));
  }

  _statusForRole(roleId) {
    const statuses = {
      "requirements-lead": "clarifying",
      "chief-manager": "planning",
      engineering: "executing",
      "independent-reviewer": "awaiting_review",
      tester: "testing",
    };
    return statuses[roleId] || "blocked";
  }

  _recoverInterruptedRuns() {
    const missions = reduceLedger(this.ledger.events());
    for (const mission of missions) {
      if (TERMINAL_STATUSES.has(mission.status)) continue;
      const interrupted = mission.runs.findLast((run) => run.status === "running");
      if (!interrupted) {
        const latestRun = mission.runs.at(-1);
        if (latestRun?.status === "paused" && mission.status !== "waiting") {
          this._setStatus(mission.id, "waiting", "服务恢复了已完成的安全暂停现场");
        }
        continue;
      }
      const invocation = interrupted.invocations?.findLast((item) => item.status === "running");
      const pauseWasRequested = interrupted.pauseRequested === true;
      this.ledger.append("physical_invocation.interrupted", {
        missionId: mission.id,
        actorRoleId: "management-inspector",
        payload: {
          runId: interrupted.id,
          invocationId: invocation?.id || `${interrupted.id}-legacy-invocation`,
          reason: pauseWasRequested
            ? "服务重启时完成了此前请求的安全暂停"
            : "服务重启中断了物理调用，逻辑 Run 将从最近检查点续作",
          checkpointId: interrupted.lastCheckpoint?.id || null,
        },
      });
      if (pauseWasRequested) {
        this.ledger.append("run.paused", {
          missionId: mission.id,
          actorRoleId: "management-inspector",
          payload: {
            runId: interrupted.id,
            invocationId: invocation?.id || null,
            checkpointId: interrupted.lastCheckpoint?.id || null,
            reason: "人类请求的安全暂停已在服务恢复时完成",
          },
        });
        this._setStatus(mission.id, "waiting", "安全暂停已完成，等待人类继续或修改需求");
        continue;
      }
      setImmediate(() => this._dispatchRole(mission.id, interrupted.roleId, {
        runId: interrupted.id,
        resumed: true,
        previousInvocationId: invocation?.id || null,
        checkpoint: interrupted.lastCheckpoint || null,
      }));
    }
  }

  _openBlocker(missionId, { category, roleId, runId = null, error }) {
    const mission = this._requireMission(missionId);
    const usedAttempts = mission.blockers.filter(
      (item) => item.status === "closed" && item.resolution === "retry",
    ).length;
    const blockerId = makeId("blocker");
    this.ledger.append("blocker.opened", {
      missionId,
      actorRoleId: "management-inspector",
      payload: {
        id: blockerId,
        category,
        ownerRoleId: "blocker-lead",
        failedRoleId: roleId,
        runId,
        attemptsUsed: usedAttempts,
        attemptBudget: this.maxRecoveryAttempts,
        error: normalizeText(error, 12_000),
      },
    });
    this.ledger.append("message.recorded", {
      missionId,
      actorRoleId: "management-inspector",
      payload: {
        authorType: "role",
        roleId: "management-inspector",
        roleName: "管理巡检岗",
        content: `${ROLE_BY_ID.get(roleId)?.name || roleId} 无法继续，已建立 BlockerCase。系统没有把失败标记为完成，也没有静默切换模型。`,
      },
    });
    this._setStatus(missionId, "blocked", `${ROLE_BY_ID.get(roleId)?.name || roleId} 无法继续，等待恢复`);
    return blockerId;
  }

  _createReworkItem(missionId, title, sourceType, sourceDetails) {
    const mission = this._requireMission(missionId);
    const existing = mission.workItems.filter((item) => item.kind === "rework");
    this.ledger.append("work_item.created", {
      missionId,
      actorRoleId: "task-owner",
      payload: {
        id: `${missionId}-RW-${String(existing.length + 1).padStart(2, "0")}`,
        kind: "rework",
        title,
        ownerRoleId: "engineering",
        ownerRoleName: ROLE_BY_ID.get("engineering").name,
        deliverable: mission.workflowProfile?.resolved === "light" ? "修正交付包并重新进入独立留痕复核" : "修正交付包并重新进入独立复核与全量测试",
        acceptance: mission.workflowProfile?.resolved === "light"
          ? ["关闭触发返工的发现", "更新工程证据", "重新通过独立留痕复核"]
          : ["关闭触发返工的发现", "更新工程证据", "重新通过独立复核和全量测试"],
        sourceType,
        sourceDetails: normalizeText(sourceDetails, 12_000),
      },
    });
    return true;
  }

  _startHeavyReview(missionId) {
    const mission = this._requireMission(missionId);
    if (!mission.workItems.some((item) => item.ownerRoleId === "tester" && item.kind === "heavy_review")) {
      this.ledger.append("work_item.created", {
        missionId,
        actorRoleId: "task-owner",
        payload: {
          id: `${missionId}-HV-${String(mission.testRuns.length + 1).padStart(2, "0")}`,
          kind: "heavy_review",
          title: "项目全量功能回顾",
          ownerRoleId: "tester",
          ownerRoleName: ROLE_BY_ID.get("tester").name,
          deliverable: "ProjectTestManifest 全量结果与 VerifiedBaseline",
          acceptance: ["冻结精确候选", "执行全部必跑项", "证据完整"],
        },
      });
    }
    this._setStatus(missionId, "testing", "已启动重度回顾，测试岗执行项目全部必跑功能");
    setImmediate(() => this._queueTestRun(missionId));
    return this.mission(missionId);
  }

  _setStatus(missionId, to, reason) {
    const current = this.mission(missionId)?.status || "intake";
    if (current !== to && !ALLOWED_STATUS_TRANSITIONS.get(current)?.has(to)) {
      throw Object.assign(new Error(`非法状态跳转：${current} -> ${to}`), { statusCode: 409 });
    }
    this.ledger.append("mission.status_changed", {
      missionId,
      actorRoleId: "chief-manager",
      payload: { from: current, to, reason },
    });
    this._autoRequestGateDecision(missionId, to);
  }

  _escalateStalemate(missionId) {
    const mission = this.mission(missionId);
    if (!mission || mission.baseline) return;
    if (Date.now() - Date.parse(mission.createdAt) < CLARIFICATION_BUDGET_MS) return;
    const open = mission.decisions.some((item) => item.status === "open" && item.kind === "requirements_stalemate");
    if (open) return;
    this.requestDecision(missionId, {
      kind: "requirements_stalemate",
      title: "需求澄清已超过 20 分钟基线时间",
      facts: `Mission 创建于 ${mission.createdAt}，至今未形成可确认的需求基线。`,
      impacts: "继续追问将消耗更多组织资源；可缩小范围或接受风险开工",
      options: ["继续追问", "缩小范围", "接受遗留风险直接开工"],
      urgency: "high",
      objectKind: "Mission",
      objectVersion: mission.id,
      noDecisionConsequence: "需求明确岗将继续追问直到人类介入",
    });
  }

  _queueRequirementRun(missionId, runOptions = {}) {
    this._queueRoleRun(missionId, "requirements-lead", buildRequirementPrompt, (mission, parsed, run) => {
      const questions = Array.isArray(parsed.questions) ? parsed.questions : [];
      const message = normalizeText(parsed.message, 6000) || "需求明确岗已完成本轮整理。";
      this.ledger.append("message.recorded", {
        missionId,
        actorRoleId: "requirements-lead",
        causationId: run.id,
        payload: {
          authorType: "role",
          roleId: "requirements-lead",
          roleName: "需求明确岗",
          content: message,
          directReport: true,
          questions,
        },
      });
      if (parsed.readyForBaseline === true && parsed.baseline && typeof parsed.baseline === "object") {
        const version = `RB-${missionId}-v${(mission.baseline?.versionNumber || 0) + 1}`;
        this.ledger.append("baseline.drafted", {
          missionId,
          actorRoleId: "requirements-lead",
          causationId: run.id,
          payload: { version, baseline: { ...parsed.baseline, versionNumber: (mission.baseline?.versionNumber || 0) + 1 } },
        });
        this._setStatus(missionId, "awaiting_baseline_confirmation", "需求基线草案等待人类明确确认");
      } else {
        this._setStatus(missionId, "clarifying", questions.length ? "等待人类回答澄清问题" : "需求信息仍不足");
        this._escalateStalemate(missionId);
      }
    }, runOptions);
  }

  _queueManagerPlan(missionId, runOptions = {}) {
    this._queueRoleRun(missionId, "chief-manager", buildManagerPrompt, (_mission, parsed, run) => {
      const requiredOwners = _mission.workflowProfile?.resolved === "light"
        ? ["engineering", "independent-reviewer"]
        : ["engineering", "independent-reviewer", "tester"];
      const ownerIds = Array.isArray(parsed.workItems) ? parsed.workItems.map((item) => item.ownerRoleId) : [];
      if (!parsed.charter || !requiredOwners.every((owner) => ownerIds.includes(owner))) {
        throw new Error(`群星的调律者输出缺少 Charter 或 ${requiredOwners.join("/")} WorkItem`);
      }
      this.ledger.append("charter.created", {
        missionId,
        actorRoleId: "chief-manager",
        causationId: run.id,
        payload: parsed.charter,
      });
      parsed.workItems.forEach((item, index) => {
        const ownerRoleId = ROLE_BY_ID.has(item.ownerRoleId) ? item.ownerRoleId : "task-owner";
        this.ledger.append("work_item.created", {
          missionId,
          actorRoleId: "task-owner",
          causationId: run.id,
          payload: {
            id: `${missionId}-WI-${String(index + 1).padStart(2, "0")}`,
            title: normalizeText(item.title, 200),
            ownerRoleId,
            ownerRoleName: ROLE_BY_ID.get(ownerRoleId).name,
            deliverable: normalizeText(item.deliverable, 1000),
            acceptance: Array.isArray(item.acceptance) ? item.acceptance : [],
          },
        });
      });
      this.ledger.append("message.recorded", {
        missionId,
        actorRoleId: "chief-manager",
        causationId: run.id,
        payload: { authorType: "role", roleId: "chief-manager", roleName: "群星的调律者", content: normalizeText(parsed.message, 6000) || "任务章程与分工已建立。" },
      });
      this._setStatus(missionId, "executing", "工程执行岗开始处理已确认工作项");
      this._continueAfterCurrentRun(missionId, () => this._queueEngineeringRun(missionId));
    }, runOptions);
  }

  _queueEngineeringRun(missionId, runOptions = {}) {
    this._queueRoleRun(missionId, "engineering", buildEngineeringPrompt, (mission, parsed, run) => {
      if (!["completed", "blocked"].includes(parsed.result)) {
        throw new Error("工程输出 result 必须是 completed 或 blocked");
      }
      const item = mission.workItems.findLast(
        (candidate) =>
          candidate.ownerRoleId === "engineering" &&
          ["queued", "in_progress", "rework_required", "blocked"].includes(candidate.status),
      );
      if (item) {
        this.ledger.append("work_item.status_changed", {
          missionId,
          actorRoleId: "engineering",
          causationId: run.id,
          payload: { id: item.id, status: parsed.result === "completed" ? "awaiting_review" : "blocked", evidence: parsed.artifacts || [] },
        });
      }
      this.ledger.append("evidence.recorded", {
        missionId,
        actorRoleId: "engineering",
        causationId: run.id,
        payload: { kind: "engineering_delivery", summary: parsed.message || parsed.rootCause || "工程交付", data: parsed },
      });
      this.ledger.append("message.recorded", {
        missionId,
        actorRoleId: "engineering",
        causationId: run.id,
        payload: { authorType: "role", roleId: "engineering", roleName: "工程执行岗", content: normalizeText(parsed.message, 6000) || "工程执行完成，等待独立复核。" },
      });
      if (parsed.result === "blocked") {
        this._openBlocker(missionId, {
          category: "engineering_blocked",
          roleId: "engineering",
          runId: run.id,
          error: parsed.next || "工程执行报告阻塞",
        });
        return;
      }
      this._setStatus(missionId, "awaiting_review", "工程交付已提交独立复核");
      this._continueAfterCurrentRun(missionId, () => this._queueReviewRun(missionId));
    }, runOptions);
  }

  _queueReviewRun(missionId, runOptions = {}) {
    this._queueRoleRun(missionId, "independent-reviewer", buildReviewPrompt, (mission, parsed, run) => {
      this.ledger.append("review.recorded", {
        missionId,
        actorRoleId: "independent-reviewer",
        causationId: run.id,
        payload: { verdict: parsed.verdict || "blocked", findings: parsed.findings || [], coverage: parsed.requirementCoverage || [], risks: parsed.residualRisks || [] },
      });
      this.ledger.append("message.recorded", {
        missionId,
        actorRoleId: "independent-reviewer",
        causationId: run.id,
        payload: { authorType: "role", roleId: "independent-reviewer", roleName: "独立复核岗", content: normalizeText(parsed.message, 6000) || "独立复核已记录。" },
      });
      const item = mission.workItems.find((candidate) => candidate.ownerRoleId === "independent-reviewer");
      if (item) this.ledger.append("work_item.status_changed", { missionId, actorRoleId: "independent-reviewer", payload: { id: item.id, status: "completed" } });
      if (parsed.verdict === "changes_required") {
        const engineeringItem = mission.workItems.findLast(
          (candidate) => candidate.ownerRoleId === "engineering" && candidate.status !== "completed",
        ) || mission.workItems.find((candidate) => candidate.ownerRoleId === "engineering");
        if (engineeringItem) {
          this.ledger.append("work_item.status_changed", {
            missionId,
            actorRoleId: "task-owner",
            payload: { id: engineeringItem.id, status: "rework_required" },
          });
        }
        if (
          this._createReworkItem(
            missionId,
            "独立复核返工",
            "review_changes_required",
            JSON.stringify(parsed.findings || []),
          )
        ) {
          this._setStatus(missionId, "executing", "独立复核要求修改，工程执行岗开始返工");
          this._continueAfterCurrentRun(missionId, () => this._queueEngineeringRun(missionId));
        }
        return;
      }
      if (parsed.verdict === "blocked") {
        this._openBlocker(missionId, {
          category: "review_blocked",
          roleId: "independent-reviewer",
          runId: run.id,
          error: parsed.message || "独立复核无法继续",
        });
        return;
      }
      if (parsed.verdict !== "pass") throw new Error("复核输出 verdict 无效");
      if (mission.workflowProfile?.resolved === "light") {
        const delivery = mission.evidence.at(-1) || null;
        this.ledger.append("change_record.recorded", {
          missionId,
          actorRoleId: "independent-reviewer",
          causationId: run.id,
          payload: {
            id: makeId("change"),
            baselineVersion: mission.baseline?.version || null,
            goal: mission.goal,
            engineeringEvidenceId: delivery?.id || null,
            actions: delivery?.data?.changes || [],
            artifacts: delivery?.data?.artifacts || [],
            selfTests: delivery?.data?.tests || [],
            risks: [...(delivery?.data?.risks || []), ...(parsed.residualRisks || [])],
            reviewRunId: run.id,
            reviewVerdict: "pass",
            fullFunctionalVerification: false,
          },
        });
        this._setStatus(missionId, "light_completed", "实现与工作留痕已通过独立复核；本结果不代表全量功能验证或发布资格");
        return;
      }
      this._setStatus(missionId, "testing", "独立复核通过，测试岗开始实际验证");
      this._continueAfterCurrentRun(missionId, () => this._queueTestRun(missionId));
    }, runOptions);
  }

  _queueTestRun(missionId, runOptions = {}) {
    this._queueRoleRun(missionId, "tester", (mission) => buildTestPrompt(mission, this._manifestFor(mission)), (mission, parsed, run) => {
      const manifest = this._manifestFor(mission);
      const testRuns = Array.isArray(parsed.runs) ? parsed.runs : [];
      const requiredIds = manifest.requiredTests.map((item) => item.id);
      const missingIds = requiredIds.filter((id) => !testRuns.some((testRun) => testRun.testId === id));
      const failedRequiredIds = requiredIds.filter((id) => testRuns.find((testRun) => testRun.testId === id)?.result !== "passed");
      if (parsed.verdict === "pass" && (missingIds.length || failedRequiredIds.length)) {
        throw new Error(`ProjectTestManifest 必跑项未全部通过：${[...new Set([...missingIds, ...failedRequiredIds])].join(", ")}`);
      }
      const testRunEvent = this.ledger.append("test_run.recorded", {
        missionId,
        actorRoleId: "tester",
        causationId: run.id,
        payload: {
          verdict: parsed.verdict || "blocked",
          runs: testRuns,
          projectTestManifestId: manifest.id,
          projectTestManifestVersion: manifest.version,
          candidate: parsed.candidate || null,
          externalEvidencePackage: parsed.externalEvidencePackage || null,
        },
      });
      this.ledger.append("message.recorded", {
        missionId,
        actorRoleId: "tester",
        causationId: run.id,
        payload: { authorType: "role", roleId: "tester", roleName: "测试岗", content: normalizeText(parsed.message, 6000) || "测试运行已记录。" },
      });
      const item = mission.workItems.find((candidate) => candidate.ownerRoleId === "tester");
      if (item) this.ledger.append("work_item.status_changed", { missionId, actorRoleId: "tester", payload: { id: item.id, status: "completed" } });
      if (parsed.verdict === "fail") {
        this.ledger.append("gap_case.opened", {
          missionId,
          actorRoleId: "tester",
          causationId: testRunEvent.id,
          payload: {
            id: makeId("gap"),
            projectTestManifestVersion: this.projectTestManifest.version,
            expected: "项目全部必跑用户功能通过",
            actual: testRuns.filter((entry) => entry.result !== "passed"),
            ownerRoleId: "engineering",
          },
        });
        if (
          this._createReworkItem(
            missionId,
            "测试失败返工",
            "test_failure",
            JSON.stringify(parsed.runs || []),
          )
        ) {
          this._setStatus(missionId, "executing", "测试发现失败，工程执行岗开始返工");
          this._continueAfterCurrentRun(missionId, () => this._queueEngineeringRun(missionId));
        }
        return;
      }
      if (parsed.verdict === "blocked") {
        this._openBlocker(missionId, {
          category: "test_blocked",
          roleId: "tester",
          runId: run.id,
          error: parsed.message || "测试运行无法继续",
        });
        return;
      }
      if (parsed.verdict !== "pass") throw new Error("测试输出 verdict 无效");
      const candidateIdentity = normalizeText(parsed.candidate?.commit, 500);
      if (candidateIdentity.length < 7 || parsed.candidate?.clean !== true) {
        throw new Error("重度验证必须绑定精确且干净的候选身份");
      }
      mission.gapCases.filter((item) => item.status === "open").forEach((gapCase) => {
        this.ledger.append("gap_case.closed", {
          missionId,
          actorRoleId: "tester",
          causationId: testRunEvent.id,
          payload: { id: gapCase.id, resolution: "新候选已通过项目全部必跑项" },
        });
      });
      const verifiedBaselineId = makeId("vb");
      this.ledger.append("verified_baseline.recorded", {
        missionId,
        actorRoleId: "tester",
        causationId: testRunEvent.id,
        payload: {
          id: verifiedBaselineId,
          projectId: mission.projectId,
          candidateIdentity,
          projectTestManifestId: manifest.id,
          projectTestManifestVersion: manifest.version,
          testRunId: testRunEvent.id,
          evidence: testRuns,
        },
      });
      const candidateId = makeId("rc");
      const candidateCount = mission.releaseCandidate ? 2 : 1;
      this.ledger.append("release_candidate.created", {
        missionId,
        actorRoleId: "chief-manager",
        causationId: run.id,
        payload: {
          id: candidateId,
          status: "draft",
          version: `${manifest.version}-rc${candidateCount}`,
          environment: "preview",
          source: "由发布负责人核对前的本地候选",
          projectPath: this.project.workingDirectory,
          baselineVersion: mission.baseline?.version || null,
          requirementBaselineVersion: mission.baseline?.version || null,
          evidenceIds: mission.evidence.map((entry) => entry.id),
          reviewId: mission.reviews.at(-1)?.id || null,
          testRunId: testRunEvent.id,
          verifiedBaselineId,
          requiredApprovals: ["merge_approval", "deployment_approval", "result_acceptance"],
          knownRisks: [],
          rollbackPlan: "",
          decisionRefs: mission.decisions.filter((item) => item.status !== "open").map((item) => item.id),
          externalEvidencePackage: parsed.externalEvidencePackage || null,
        },
      });
      this._setStatus(missionId, "release_candidate_ready", "项目必跑测试通过，等待发布候选来源核对");
    }, runOptions);
  }

  _dispatchRole(missionId, roleId, runOptions = {}) {
    if (roleId === "requirements-lead") this._queueRequirementRun(missionId, runOptions);
    else if (roleId === "chief-manager") this._queueManagerPlan(missionId, runOptions);
    else if (roleId === "engineering") this._queueEngineeringRun(missionId, runOptions);
    else if (roleId === "independent-reviewer") this._queueReviewRun(missionId, runOptions);
    else if (roleId === "tester") this._queueTestRun(missionId, runOptions);
    else {
      this._openBlocker(missionId, {
        category: "unsupported_resume_role",
        roleId,
        runId: runOptions.runId || null,
        error: `暂不支持续作角色 ${roleId}`,
      });
    }
  }

  _queueRoleRun(missionId, roleId, promptBuilder, onSuccess, runOptions = {}) {
    if (this.activeRuns.has(missionId)) return;
    this._assertNoOtherActiveRun(missionId);
    this._assertRoleDispatchable(missionId, roleId);
    const mission = this._requireMission(missionId);
    const revision = runOptions.revision || mission.revision || 1;
    const runId = runOptions.runId || makeId("run");
    const invocationId = makeId("invocation");
    const role = ROLE_BY_ID.get(roleId);
    const assignment = this._assignmentForRole(roleId);
    if (!assignment.ready) {
      this._openBlocker(missionId, {
        category: "agent_assignment_unavailable",
        roleId,
        runId,
        error: assignment.message || `角色 ${role.name} 没有可用的 AGENT 任职`,
      });
      return;
    }
    const contextPackageId = makeId("ctx");
    const resumeContext = runOptions.resumed
      ? `\n\n这是同一逻辑 Run 的后继物理调用。上次调用因进程或连接中断；请从下列最近检查点继续，不要把已完成动作伪装为本次新动作：\n${JSON.stringify(runOptions.checkpoint || { summary: "没有可用检查点，请从权威账本重建现场" }, null, 2)}`
      : "";
    const prompt = `${promptBuilder(mission)}${resumeContext}`;
    if (!runOptions.resumed) {
      this.ledger.append("run.started", {
        missionId,
        actorRoleId: roleId,
        payload: {
          runId,
          roleId,
          roleName: role.name,
          roleContractVersion: role.contractVersion,
          revision,
          contextProjectId: mission.projectId,
          importedSources: [],
          assignmentSnapshotId: this._latestAssignmentSnapshotId(),
          assignmentId: `assignment-${roleId}-${assignment.adapterId}-v1`,
          adapterId: assignment.adapterId,
          model: assignment.model,
          reasoningEffort: assignment.reasoningEffort,
          contextPackageId,
          contextEventCount: this.ledger.events().filter((event) => event.missionId === missionId).length,
        },
      });
    }
    this.ledger.append("physical_invocation.started", {
      missionId,
      actorRoleId: roleId,
      payload: {
        runId,
        invocationId,
        previousInvocationId: runOptions.previousInvocationId || null,
        resumed: runOptions.resumed === true,
        adapterId: assignment.adapterId,
        model: assignment.model,
        reasoningEffort: assignment.reasoningEffort,
      },
    });
    const startedAt = nowIso();
    const abortController = new AbortController();
    const active = {
      runId,
      invocationId,
      roleId,
      model: assignment.model,
      reasoningEffort: assignment.reasoningEffort,
      scope: mission.workItems
        .filter((item) => item.ownerRoleId === roleId && item.status !== "completed")
        .map((item) => item.title),
      startedAt,
      currentAction: runOptions.resumed ? "从最近检查点恢复现场" : "建立角色执行上下文",
      lastHeartbeatAt: startedAt,
      lastCheckpointAt: runOptions.checkpoint?.at || null,
      lastCheckpoint: runOptions.checkpoint || null,
      lastDeltaAt: 0,
      lastDeltaCheckpointAt: 0,
      lastPersistedHeartbeatAt: 0,
      resumed: runOptions.resumed === true,
      pauseRequested: false,
      abortController,
      task: null,
    };
    this.activeRuns.set(missionId, active);
    const recordHeartbeat = (force = false) => {
      const timestamp = Date.now();
      active.lastHeartbeatAt = nowIso();
      if (!force && timestamp - active.lastPersistedHeartbeatAt < this.heartbeatIntervalMs) return;
      this.ledger.append("run.heartbeat", {
        missionId,
        actorRoleId: roleId,
        payload: { runId, invocationId, currentAction: active.currentAction },
      });
      active.lastPersistedHeartbeatAt = timestamp;
    };
    const onActivity = (event = {}) => {
      if (this.activeRuns.get(missionId) !== active) return;
      if ((event.message || event.text) && event.type !== "hub.usage") {
        active.currentAction = normalizeText(event.message || event.text, 2000);
      }
      recordHeartbeat(false);
      if (event.type === "hub.progress" || event.type === "hub.runtime") {
        const checkpoint = this.ledger.append("run.checkpointed", {
          missionId,
          actorRoleId: roleId,
          payload: {
            runId,
            invocationId,
            kind: event.type === "hub.progress" ? "progress" : "runtime",
            summary: normalizeText(event.message || active.currentAction, 2000),
            detail: normalizeText(event.detail, 2000) || undefined,
            runtime: event.type === "hub.runtime" ? event : undefined,
          },
        });
        active.lastCheckpointAt = checkpoint.at;
        active.lastCheckpoint = { id: checkpoint.id, at: checkpoint.at, ...checkpoint.payload };
      } else if (event.type === "hub.delta") {
        const timestamp = Date.now();
        active.lastDeltaAt = timestamp;
        if (!active.lastDeltaCheckpointAt || timestamp - active.lastDeltaCheckpointAt > 60_000) {
          active.lastDeltaCheckpointAt = timestamp;
          const checkpoint = this.ledger.append("run.checkpointed", {
            missionId,
            actorRoleId: roleId,
            payload: { runId, invocationId, kind: "progress", summary: "持续接收模型输出" },
          });
          active.lastCheckpointAt = checkpoint.at;
          active.lastCheckpoint = { id: checkpoint.id, at: checkpoint.at, ...checkpoint.payload };
        }
      }
    };
    recordHeartbeat(true);
    const heartbeatTimer = setInterval(() => recordHeartbeat(false), 10_000);
    heartbeatTimer.unref?.();
    let runCompleted = false;
    const task = Promise.resolve()
      .then(() => this.runRole({
        role,
        missionId,
        goal: mission.goal,
        scope: mission.workItems
          .filter((item) => item.ownerRoleId === roleId && item.status !== "completed")
          .map((item) => item.title),
        adapterId: assignment.adapterId,
        prompt,
        cwd: this._projectFor(mission).workingDirectory || this.project.workingDirectory,
        model: assignment.model,
        reasoningEffort: assignment.reasoningEffort,
        runId,
        invocationId,
        onActivity,
        signal: abortController.signal,
      }))
      .then((result) => {
        active.roleResult = result;
        const parsed = extractJsonObject(result.output);
        const fresh = this._requireMission(missionId);
        if (revision < (fresh.revision || 1)) {
          this.ledger.append("run.output_rejected", {
            missionId,
            actorRoleId: roleId,
            payload: { runId, error: `旧世代输出（r${revision} < r${fresh.revision}），仅留痕不推进状态`, output: result.output.slice(0, 4000) },
          });
          this.ledger.append("run.superseded", {
            missionId,
            actorRoleId: roleId,
            payload: { runId, revision, currentRevision: fresh.revision, error: "需求世代已递增，旧 Run 被取代" },
          });
          active.roleResult?.completeAction?.({ status: "output_rejected", error: "旧世代迟到输出" });
          runCompleted = true;
          return;
        }
        const finalCheckpoint = this.ledger.append("run.checkpointed", {
          missionId,
          actorRoleId: roleId,
          payload: {
            runId,
            invocationId,
            kind: "result",
            summary: normalizeText(parsed.message || parsed.result || parsed.verdict || "角色已形成最终结果", 2000),
          },
        });
        active.lastCheckpointAt = finalCheckpoint.at;
        active.lastCheckpoint = { id: finalCheckpoint.id, at: finalCheckpoint.at, ...finalCheckpoint.payload };
        this.ledger.append("physical_invocation.completed", {
          missionId,
          actorRoleId: roleId,
          payload: { runId, invocationId, runtime: result.runtime || {}, usage: result.usage || null },
        });
        this.ledger.append("run.completed", {
          missionId,
          actorRoleId: roleId,
          payload: { runId, output: result.output, runtime: result.runtime || {}, usage: result.usage || null },
        });
        runCompleted = true;
        onSuccess(this._requireMission(missionId), parsed, { id: runId, result });
        result.completeAction?.({
          status: "completed",
          summary: normalizeText(parsed.message || parsed.result || parsed.verdict || result.output, 6000),
        });
      })
      .catch((error) => {
        const errorMessage = normalizeText(error?.message || String(error), 12_000);
        const currentStatus = this.mission(missionId)?.status;
        const terminal = TERMINAL_STATUSES.has(currentStatus);
        if (active.stopRequested && !runCompleted) {
          this.ledger.append("physical_invocation.interrupted", {
            missionId,
            actorRoleId: roleId,
            payload: {
              runId,
              invocationId,
              reason: "人类负责人紧急停止，物理调用已终止且不可恢复",
              checkpointId: active.lastCheckpoint?.id || null,
            },
          });
          this.ledger.append("run.stopped", {
            missionId,
            actorRoleId: roleId,
            payload: {
              runId,
              invocationId,
              checkpointId: active.lastCheckpoint?.id || null,
              reason: errorMessage || "紧急停止",
            },
          });
          this.ledger.append("message.recorded", {
            missionId,
            actorRoleId: "management-inspector",
            payload: {
              authorType: "role",
              roleId: "management-inspector",
              roleName: "管理巡检岗",
              content: `${ROLE_BY_ID.get(roleId)?.name || roleId} 已被紧急停止；现场已保留但本次逻辑 Run 不再恢复，需要人类决定下一步。`,
            },
          });
          if (!terminal) {
            this._openBlocker(missionId, {
              category: "emergency_stop",
              roleId,
              runId,
              error: errorMessage || "紧急停止",
            });
          }
          return;
        }
        if (active.pauseRequested && !runCompleted) {
          this.ledger.append("physical_invocation.interrupted", {
            missionId,
            actorRoleId: roleId,
            payload: {
              runId,
              invocationId,
              reason: "人类请求安全暂停，物理调用已终止",
              checkpointId: active.lastCheckpoint?.id || null,
            },
          });
          this.ledger.append("run.paused", {
            missionId,
            actorRoleId: roleId,
            payload: {
              runId,
              invocationId,
              checkpointId: active.lastCheckpoint?.id || null,
              reason: errorMessage || "安全暂停",
            },
          });
          this.ledger.append("message.recorded", {
            missionId,
            actorRoleId: "management-inspector",
            payload: {
              authorType: "role",
              roleId: "management-inspector",
              roleName: "管理巡检岗",
              content: `${ROLE_BY_ID.get(roleId)?.name || roleId} 已安全暂停；现场和最近检查点已保留，可继续运行或修改需求。`,
            },
          });
          this._setStatus(missionId, "waiting", "安全暂停已完成，等待人类继续或修改需求");
          return;
        }
        if (terminal) {
          this.ledger.append("run.output_rejected", {
            missionId,
            actorRoleId: roleId,
            payload: { runId, error: `Mission 已终结（${currentStatus}），迟到输出仅留痕` },
          });
          return;
        }
        active.roleResult?.completeAction?.({
          status: "output_rejected",
          error: errorMessage,
        });
        if (runCompleted) {
          this.ledger.append("run.output_rejected", {
            missionId,
            actorRoleId: roleId,
            payload: { runId, error: errorMessage },
          });
        } else {
          this.ledger.append("physical_invocation.failed", {
            missionId,
            actorRoleId: roleId,
            payload: { runId, invocationId, error: errorMessage },
          });
          this.ledger.append("run.failed", {
            missionId,
            actorRoleId: roleId,
            payload: { runId, error: errorMessage },
          });
        }
        this._openBlocker(missionId, {
          category: runCompleted ? "role_output_rejected" : "role_run_failure",
          roleId,
          runId,
          error: errorMessage,
        });
      })
      .finally(() => {
        clearInterval(heartbeatTimer);
        if (this.activeRuns.get(missionId) === active) this.activeRuns.delete(missionId);
      });
    active.task = task;
  }
}

module.exports = {
  JsonlLedger,
  OrganizationService,
  ROLE_DEFINITIONS,
  SYSTEM_VERSION,
  PROJECT_ID,
  MANAGER_MODEL,
  MANAGER_REASONING,
  reduceLedger,
  extractJsonObject,
  buildRequirementPrompt,
  retrievalFocusFor,
  ideaClusterSimilarity,
};

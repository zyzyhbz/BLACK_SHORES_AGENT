const navItems = [
  { id: "workbench", label: "人类工作台", icon: "messages-square" },
  { id: "missions", label: "Mission", icon: "list-tree" },
  { id: "organization", label: "组织与角色", icon: "network" },
  { id: "ledger", label: "证据账本", icon: "scroll-text" },
  { id: "resources", label: "AGENT 资源", icon: "cpu" },
];

const pageMeta = {
  workbench: ["组织入口", "人类工作台"],
  missions: ["业务结果", "Mission"],
  organization: ["责任结构", "组织与角色"],
  ledger: ["统一事实源", "证据账本"],
  resources: ["诊断入口", "AGENT 资源"],
};

const statusMeta = {
  intake: ["已接收", "neutral"],
  clarifying: ["需求澄清", "working"],
  awaiting_baseline_confirmation: ["待确认需求", "decision"],
  planning: ["组织规划", "working"],
  executing: ["工程执行", "working"],
  awaiting_review: ["独立复核", "working"],
  testing: ["测试验证", "working"],
  light_completed: ["轻度交付完成", "success"],
  release_candidate_ready: ["候选待核对", "decision"],
  awaiting_release_approval: ["待发布授权", "decision"],
  awaiting_external_evidence: ["待外部证据", "decision"],
  awaiting_result_acceptance: ["待结果验收", "decision"],
  blocked: ["已阻塞", "danger"],
  waiting: ["外部等待", "waiting"],
  accepted: ["已验收", "success"],
  failed: ["已失败", "danger"],
  cancelled: ["已取消", "neutral"],
};

let activeView = "workbench";
let selectedMissionId = "";
let organizationState = null;
let healthState = null;
let configurationState = null;
let ledgerEvents = [];
let loading = true;
let requestInFlight = false;
let toastTimer = null;
let pollTimer = null;
let assignmentDraft = null;
const commandDrafts = new Map();
const commandSelections = new Map();

const navList = document.getElementById("navList");
const mainContent = document.getElementById("mainContent");
const pageEyebrow = document.getElementById("pageEyebrow");
const pageTitle = document.getElementById("pageTitle");
const sidebar = document.getElementById("sidebar");
const mobileBackdrop = document.getElementById("mobileBackdrop");
const systemState = document.getElementById("systemState");
const detailDialog = document.getElementById("detailDialog");
const detailContent = document.getElementById("detailContent");

function icon(name, className = "") {
  return `<i data-lucide="${name}"${className ? ` class="${className}"` : ""} aria-hidden="true"></i>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function refreshIcons() {
  window.lucide?.createIcons({ attrs: { "stroke-width": 1.8 } });
}

function showToast(message, tone = "success") {
  const toast = document.getElementById("toast");
  const toastText = document.getElementById("toastText");
  toast.dataset.tone = tone;
  toastText.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 3200);
}

function statusPill(status) {
  const [label, tone] = statusMeta[status] || [status, "neutral"];
  return `<span class="status-pill status-${tone}"><span></span>${escapeHtml(label)}</span>`;
}

function managerSummary() {
  const authority = organizationState?.authority || {};
  const parts = [authority.managerAdapterLabel || authority.managerAdapter];
  if (authority.managerModel) parts.push(authority.managerModel);
  if (authority.managerReasoning) parts.push(authority.managerReasoning);
  return parts.filter(Boolean).join(" · ") || "未配置";
}

function updateAppIdentity() {
  const projectName = document.getElementById("sidebarProjectName");
  const manager = document.getElementById("sidebarManagerAssignment");
  const runtime = document.getElementById("sidebarRuntimeNote");
  if (projectName) projectName.textContent = organizationState?.project?.name || "My Project";
  if (manager) manager.textContent = managerSummary();
  if (runtime) {
    runtime.textContent = organizationState?.authority?.executionReady
      ? "本地账本 · AGENT 已就绪"
      : "本地账本 · 待配置 AGENT";
  }
}

function renderNav() {
  const missionCount = organizationState?.missions?.length || 0;
  navList.innerHTML = navItems
    .map(
      (item) => `
        <button type="button" class="nav-button ${activeView === item.id ? "active" : ""}" data-view="${item.id}">
          ${icon(item.icon)}
          <span>${item.label}</span>
          ${item.id === "missions" && missionCount ? `<small>${missionCount}</small>` : ""}
        </button>`,
    )
    .join("");
  navList.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });
}

function activeMission() {
  const missions = organizationState?.missions || [];
  if (selectedMissionId === "__new__") return null;
  return missions.find((mission) => mission.id === selectedMissionId) || missions[0] || null;
}

function commandKey(mission = activeMission()) {
  return mission?.id || "new";
}

function missionProgress(status) {
  const order = [
    "intake",
    "clarifying",
    "awaiting_baseline_confirmation",
    "planning",
    "executing",
    "awaiting_review",
    "testing",
    "light_completed",
    "release_candidate_ready",
    "awaiting_release_approval",
    "awaiting_external_evidence",
    "awaiting_result_acceptance",
    "accepted",
  ];
  if (status === "light_completed") return 100;
  if (status === "blocked" || status === "waiting") return 42;
  const index = Math.max(0, order.indexOf(status));
  return Math.round((index / (order.length - 1)) * 100);
}

function renderEmptyWorkbench() {
  return `
    <section class="workbench-empty" aria-labelledby="newMissionTitle">
      <div class="empty-context">
        <span class="section-kicker">总管 AGENT · 命令入口</span>
        <h2 id="newMissionTitle">你要组织完成什么结果？</h2>
        <p>直接描述目标，或在同一句中指定轻度、重度或自动模式。</p>
      </div>
      <form class="goal-composer command-composer" id="commandForm">
        <label for="commandInput">给黑海岸下达命令</label>
        <textarea
          id="commandInput"
          name="content"
          rows="5"
          maxlength="12000"
          placeholder="例如：修复登录后偶发白屏，并保留现有会话恢复能力。"
          required
        >${escapeHtml(commandDrafts.get("new") || "")}</textarea>
        <div class="composer-footer">
          <span>${icon("shield-check")} 创建后先进入需求门禁</span>
          <button type="submit" class="button button-primary" ${requestInFlight ? "disabled" : ""}>
            ${icon(requestInFlight ? "loader-circle" : "arrow-up", requestInFlight ? "spin" : "")}
            <span>${requestInFlight ? "正在执行命令" : "交给组织"}</span>
          </button>
        </div>
      </form>
      <div class="operating-baseline" aria-label="当前运行基线">
        <div><span>总管任职</span><strong>${escapeHtml(managerSummary())}</strong></div>
        <div><span>权威账本</span><strong>本地单机</strong></div>
        <div><span>项目</span><strong>${escapeHtml(organizationState?.project?.name || "未配置")}</strong></div>
        <div><span>发布权限</span><strong>人类保留</strong></div>
      </div>
    </section>`;
}

function renderMessage(message) {
  const isHuman = message.authorType === "human";
  const roleClass = isHuman ? "human" : message.directReport ? "direct" : "role";
  const questions = Array.isArray(message.questions) && message.questions.length
    ? `<div class="question-list">${message.questions
        .map(
          (item, index) => `
            <div class="question-item">
              <span>${index + 1}</span>
              <div><strong>${escapeHtml(item.question || item)}</strong>${item.why ? `<small>${escapeHtml(item.why)}</small>` : ""}</div>
            </div>`,
        )
        .join("")}</div>`
    : "";
  return `
    <article class="message message-${roleClass}">
      <header>
        <span class="role-avatar">${isHuman ? "人" : escapeHtml(message.roleName?.slice(0, 1) || "岗")}</span>
        <div><strong>${escapeHtml(message.roleName || "未知角色")}</strong><small>${formatTime(message.at)}</small></div>
        ${message.directReport ? '<span class="direct-badge">独立直报</span>' : ""}
      </header>
      <p>${escapeHtml(message.content).replaceAll("\n", "<br />")}</p>
      ${questions}
    </article>`;
}

function listBlock(title, items) {
  const values = Array.isArray(items) ? items : [];
  return `
    <section class="baseline-section">
      <h4>${escapeHtml(title)}</h4>
      ${values.length ? `<ul>${values.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : "<p>无</p>"}
    </section>`;
}

function renderBaseline(mission) {
  if (!mission.baseline) return "";
  const baseline = mission.baseline;
  return `
    <section class="baseline-panel" aria-labelledby="baselineTitle">
      <header class="section-heading">
        <div>
          <span class="section-kicker">${escapeHtml(baseline.version)}</span>
          <h3 id="baselineTitle">需求基线草案</h3>
        </div>
        <span class="status-pill status-decision"><span></span>等待你的确认</span>
      </header>
      <div class="baseline-outcome"><span>目标结果</span><strong>${escapeHtml(baseline.outcome)}</strong></div>
      <div class="baseline-grid">
        ${listBlock("范围内", baseline.inScope)}
        ${listBlock("非范围", baseline.outOfScope)}
        ${listBlock("验收标准", baseline.acceptanceCriteria)}
        ${listBlock("测试要求", baseline.testRequirements)}
        ${listBlock("约束", baseline.constraints)}
        ${listBlock("开放风险", baseline.openRisks)}
      </div>
      <div class="decision-actions">
        <button type="button" class="button button-secondary" data-action="request-baseline-change">补充或修正</button>
        <button type="button" class="button button-primary" data-action="confirm-baseline" ${requestInFlight ? "disabled" : ""}>
          ${icon("check")}
          <span>确认需求基线</span>
        </button>
      </div>
    </section>`;
}

function renderResponseComposer(mission) {
  const blocker = mission.status === "blocked" ? mission.blockers?.findLast((item) => item.status === "open") : null;
  const blockerBar = blocker
    ? `
      <section class="blocker-bar">
        <div>${icon("octagon-alert")}<span><strong>组织运行已停止</strong><small>${escapeHtml(blocker.error || mission.statusReason)}</small></span></div>
      </section>`
    : "";
  const placeholder = ["clarifying", "awaiting_baseline_confirmation"].includes(mission.status)
    ? "回答需求明确岗，或输入“使用轻度模式”“确认需求基线”。"
    : mission.status === "blocked"
      ? "输入“恢复任务”或查询当前状态。"
      : "输入命令，例如“查看当前任务状态”或“开始重度全量回顾”。";
  return `${blockerBar}
    <form class="response-composer command-composer" id="commandForm">
      <label for="commandInput">命令总线 · ${escapeHtml(mission.workflowProfile?.requested || "auto")} → ${escapeHtml(mission.workflowProfile?.resolved || "heavy")}</label>
      <textarea id="commandInput" name="content" rows="3" maxlength="12000" placeholder="${escapeHtml(placeholder)}" required>${escapeHtml(commandDrafts.get(commandKey(mission)) || "")}</textarea>
      <button type="submit" class="icon-submit" aria-label="发送命令" title="发送命令" ${requestInFlight ? "disabled" : ""}>${icon("arrow-up")}</button>
    </form>`;
}

function candidateApproval(mission, kind) {
  return mission.approvals?.find(
    (approval) =>
      approval.kind === kind &&
      approval.candidateId === mission.releaseCandidate?.id &&
      approval.candidateDigest === mission.releaseCandidate?.digest,
  );
}

function shortCommit(value) {
  return value ? String(value).slice(0, 12) : "待核对";
}

function renderReleaseGate(mission) {
  const candidate = mission.releaseCandidate;
  if (!candidate) return "";
  const mergeApproval = candidateApproval(mission, "merge_approval");
  const deploymentApproval = candidateApproval(mission, "deployment_approval");
  const latestExternalEvidence = mission.externalEvidence?.findLast(
    (item) => item.candidateId === candidate.id,
  );
  let action = "";
  if (mission.status === "release_candidate_ready") {
    action = `
      <div class="gate-action">
        <div><strong>核对候选来源</strong><small>系统将同步远端并校验分支、提交、工作树与项目配置指纹。</small></div>
        <button type="button" class="button button-primary" data-action="verify-source" ${requestInFlight ? "disabled" : ""}>${icon("scan-search")}核对来源</button>
      </div>`;
  } else if (mission.status === "awaiting_release_approval" && !mergeApproval) {
    action = `
      <div class="gate-action gate-warning">
        <div><strong>合并授权</strong><small>只授权合并当前指纹候选，不包含部署。</small></div>
        <button type="button" class="button button-primary" data-action="approve-merge" ${requestInFlight ? "disabled" : ""}>${icon("git-merge")}批准合并</button>
      </div>`;
  } else if (mission.status === "awaiting_release_approval" && !deploymentApproval) {
    action = `
      <div class="gate-action gate-warning">
        <div><strong>部署授权</strong><small>合并授权已记录；本动作只授权部署当前候选。</small></div>
        <button type="button" class="button button-primary" data-action="approve-deployment" ${requestInFlight ? "disabled" : ""}>${icon("upload-cloud")}批准部署</button>
      </div>`;
  } else if (mission.status === "awaiting_external_evidence") {
    action = `
      <form class="external-evidence-form" id="externalEvidenceForm">
        <label for="buildIdentity">候选身份</label>
        <input id="buildIdentity" name="buildIdentity" maxlength="500" placeholder="版本号、部署时间或构建 ID" required />
        <fieldset class="result-segment"><legend>外部验收结果</legend><label><input type="radio" name="result" value="passed" required /><span>${icon("check")}通过</span></label><label><input type="radio" name="result" value="failed" required /><span>${icon("x")}失败</span></label></fieldset>
        <label for="externalNotes">证据摘要</label>
        <textarea id="externalNotes" name="notes" rows="3" maxlength="6000" placeholder="环境、步骤、观察结果与证据路径"></textarea>
        <button type="submit" class="button button-primary" ${requestInFlight ? "disabled" : ""}>${icon("clipboard-check")}提交外部证据</button>
      </form>`;
  } else if (mission.status === "awaiting_result_acceptance") {
    action = `
      <div class="gate-action gate-success">
        <div><strong>业务结果验收</strong><small>${escapeHtml(latestExternalEvidence?.buildIdentity || "当前候选")} 的外部证据已通过。</small></div>
        <button type="button" class="button button-primary" data-action="accept-result" ${requestInFlight ? "disabled" : ""}>${icon("badge-check")}验收结果</button>
      </div>`;
  } else if (mission.status === "accepted") {
    action = `<div class="gate-action gate-success"><div><strong>Mission 已验收</strong><small>发布授权、外部证据和结果验收均已独立留痕。</small></div>${icon("badge-check")}</div>`;
  }
  return `
    <section class="release-gate" aria-labelledby="releaseGateTitle">
      <header class="section-heading">
        <div><span class="section-kicker">${escapeHtml(candidate.id)}</span><h3 id="releaseGateTitle">发布候选与人类门禁</h3></div>
        <span class="candidate-state">${escapeHtml(candidate.status)}</span>
      </header>
      <div class="candidate-facts">
        <div><span>候选提交</span><code>${escapeHtml(shortCommit(candidate.sourceSnapshot?.headCommit))}</code></div>
        <div><span>远端基线</span><code>${escapeHtml(shortCommit(candidate.sourceSnapshot?.sourceRefCommit))}</code></div>
        <div><span>需求基线</span><strong>${escapeHtml(candidate.baselineVersion || "—")}</strong></div>
        <div><span>候选指纹</span><code>${escapeHtml(shortCommit(candidate.digest))}</code></div>
      </div>
      <div class="approval-track">
        <span class="${candidate.digest ? "done" : "current"}">${icon(candidate.digest ? "check" : "search")}来源</span>
        <span class="${mergeApproval ? "done" : candidate.digest ? "current" : ""}">${icon(mergeApproval ? "check" : "git-merge")}合并</span>
        <span class="${deploymentApproval ? "done" : mergeApproval ? "current" : ""}">${icon(deploymentApproval ? "check" : "upload-cloud")}部署</span>
        <span class="${latestExternalEvidence?.result === "passed" ? "done" : deploymentApproval ? "current" : ""}">${icon(latestExternalEvidence?.result === "passed" ? "check" : "clipboard-check")}外部证据</span>
        <span class="${mission.status === "accepted" ? "done" : mission.status === "awaiting_result_acceptance" ? "current" : ""}">${icon(mission.status === "accepted" ? "check" : "badge-check")}验收</span>
      </div>
      ${action}
    </section>`;
}

function renderWorkItems(mission) {
  if (!mission.workItems?.length) {
    return `<div class="quiet-empty">需求基线确认后，总管 AGENT 才会建立任务章程与分工。</div>`;
  }
  return mission.workItems
    .map(
      (item) => `
        <div class="work-item">
          <span class="work-state work-${escapeHtml(item.status)}"></span>
          <div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.ownerRoleName)} · ${escapeHtml(item.deliverable)}</small></div>
          <span>${escapeHtml(item.status)}</span>
        </div>`,
    )
    .join("");
}

function renderRun(run) {
  const activity = run.status === "running"
    ? run.currentAction || run.lastCheckpoint?.summary || "角色正在执行"
    : `${run.invocations?.length || 1} 次物理调用`;
  return `
    <div class="run-row">
      <span class="run-icon">${icon(run.status === "running" ? "loader-circle" : run.status === "completed" ? "check" : "x", run.status === "running" ? "spin" : "")}</span>
      <div><strong>${escapeHtml(run.roleName)}</strong><small>${escapeHtml(activity)} · ${formatTime(run.lastHeartbeatAt || run.at)}</small></div>
      <span class="run-status">${escapeHtml(run.status)}</span>
    </div>`;
}

function renderActiveRun(mission) {
  const active = organizationState?.activeRuns?.find((run) => run.missionId === mission.id);
  if (!active) return "";
  return `
    <section class="inspector-section activity-section">
      <header><span>活动 Run</span><span class="live-indicator"><i></i>运行中</span></header>
      <div class="activity-line"><span>当前动作</span><strong>${escapeHtml(active.currentAction || "正在建立执行上下文")}</strong></div>
      <div class="activity-line"><span>物理调用</span><code>${escapeHtml(active.invocationId || "—")}</code></div>
      <div class="activity-line"><span>最后心跳</span><time>${formatTime(active.lastHeartbeatAt)}</time></div>
      <div class="activity-line"><span>最后检查点</span><time>${formatTime(active.lastCheckpointAt)}</time></div>
    </section>`;
}

function renderMissionWorkbench(mission) {
  const progress = missionProgress(mission.status);
  const currentRun = organizationState?.activeRuns?.find((run) => run.missionId === mission.id);
  return `
    <div class="workbench-grid">
      <section class="conversation-column">
        <header class="mission-header">
          <div>
            <span class="section-kicker">${escapeHtml(mission.id)}</span>
            <h2>${escapeHtml(mission.title)}</h2>
          </div>
          <div class="mission-header-state"><span class="workflow-profile">${escapeHtml(mission.workflowProfile?.requested || "auto")} → ${escapeHtml(mission.workflowProfile?.resolved || "heavy")}</span>${statusPill(mission.status)}</div>
        </header>
        <div class="mission-progress" aria-label="Mission 进度"><span style="width:${progress}%"></span></div>
        <div class="conversation-stream">
          ${mission.messages.map(renderMessage).join("") || '<div class="quiet-empty">尚无消息</div>'}
        </div>
        ${mission.status === "awaiting_baseline_confirmation" ? renderBaseline(mission) : ""}
        ${renderResponseComposer(mission)}
        ${renderReleaseGate(mission)}
      </section>

      <aside class="mission-inspector">
        <section class="inspector-section">
          <header><span>当前责任</span>${icon("user-round-check")}</header>
          <strong>${escapeHtml(currentRun?.roleName || mission.runs?.at(-1)?.roleName || "需求明确岗")}</strong>
          <p>${escapeHtml(mission.statusReason || "组织正在读取任务状态")}</p>
        </section>
        ${renderActiveRun(mission)}
        <section class="inspector-section">
          <header><span>工作分解</span><small>${mission.workItems?.length || 0}</small></header>
          <div class="work-item-list">${renderWorkItems(mission)}</div>
        </section>
        <section class="inspector-section">
          <header><span>最近 Run</span><small>${mission.runs?.length || 0}</small></header>
          <div class="run-list">${(mission.runs || []).slice(-4).reverse().map(renderRun).join("") || '<div class="quiet-empty">等待首个角色 Run</div>'}</div>
        </section>
        <section class="inspector-section evidence-summary">
          <header><span>质量证据</span>${icon("shield-check")}</header>
          <div><span>工程交付</span><strong>${mission.evidence?.length || 0}</strong></div>
          <div><span>独立复核</span><strong>${mission.reviews?.length || 0}</strong></div>
          <div><span>测试运行</span><strong>${mission.testRuns?.length || 0}</strong></div>
          <div><span>ChangeRecord</span><strong>${mission.changeRecords?.length || 0}</strong></div>
          <div><span>VerifiedBaseline</span><strong>${mission.verifiedBaselines?.length || 0}</strong></div>
          <div><span>开放 GapCase</span><strong>${mission.gapCases?.filter((item) => item.status === "open").length || 0}</strong></div>
          <div><span>开放阻塞</span><strong>${mission.blockers?.filter((item) => item.status === "open").length || 0}</strong></div>
        </section>
      </aside>
    </div>`;
}

function renderWorkbench() {
  const mission = activeMission();
  return mission ? renderMissionWorkbench(mission) : renderEmptyWorkbench();
}

function renderMissions() {
  const missions = organizationState?.missions || [];
  return `
    <section class="page-section">
      <header class="section-heading">
        <div><span class="section-kicker">业务结果容器</span><h2>Mission</h2></div>
        <button type="button" class="button button-primary" data-action="new-mission" ${missions.some((item) => !["light_completed", "accepted", "failed", "cancelled", "superseded"].includes(item.status)) ? "disabled" : ""}>${icon("plus")}新建 Mission</button>
      </header>
      <div class="mission-table">
        <div class="table-head"><span>Mission</span><span>状态</span><span>责任阶段</span><span>更新时间</span><span></span></div>
        ${missions.length
          ? missions
              .map(
                (mission) => `
                  <button type="button" class="mission-row" data-mission-id="${escapeHtml(mission.id)}">
                    <span><strong>${escapeHtml(mission.title)}</strong><small>${escapeHtml(mission.id)}</small></span>
                    ${statusPill(mission.status)}
                    <span>${escapeHtml(mission.runs?.at(-1)?.roleName || "总管 AGENT")}</span>
                    <time>${formatTime(mission.updatedAt)}</time>
                    ${icon("chevron-right")}
                  </button>`,
              )
              .join("")
          : '<div class="table-empty">还没有 Mission。请从人类工作台提交第一个目标。</div>'}
      </div>
    </section>`;
}

function renderOrganization() {
  const roles = organizationState?.roles || [];
  const groups = [
    ["active", "主动运行"],
    ["active_on_blocker", "按阻塞激活"],
    ["advisory", "条件认知"],
    ["shadow", "影子观察"],
  ];
  return `
    <section class="page-section">
      <header class="section-heading"><div><span class="section-kicker">角色先于模型</span><h2>组织与角色</h2></div><span class="count-badge">${roles.length} 个角色合同</span></header>
      <div class="org-map">
        <div class="org-owner"><span class="org-node-icon">人</span><div><strong>人类负责人</strong><small>目标、基线、验收与发布授权</small></div></div>
        <div class="org-line"></div>
        <div class="org-manager"><span class="org-node-icon">总</span><div><strong>总管 AGENT</strong><small>${escapeHtml(managerSummary())} · ${organizationState?.authority?.executionReady ? "active" : "unconfigured"}</small></div></div>
      </div>
      ${groups
        .map(([mode, label]) => {
          const modeRoles = roles.filter((role) => role.mode === mode);
          if (!modeRoles.length) return "";
          return `<section class="role-group"><header><h3>${label}</h3><span>${modeRoles.length}</span></header><div class="role-grid">${modeRoles
            .map(
              (role) => `<article class="role-card"><div class="role-card-head"><span>${escapeHtml(role.name.slice(0, 1))}</span><div><strong>${escapeHtml(role.name)}</strong><small>${escapeHtml(role.id)} · v${escapeHtml(role.contractVersion)}</small></div></div><p>${escapeHtml(role.mission)}</p><div class="role-mode">${escapeHtml(role.mode)}</div></article>`,
            )
            .join("")}</div></section>`;
        })
        .join("")}
    </section>`;
}

function eventLabel(event) {
  const labels = {
    "mission.created": "创建 Mission",
    "mission.status_changed": "推进状态",
    "message.recorded": "记录消息",
    "run.started": "启动 Run",
    "run.completed": "完成 Run",
    "run.failed": "Run 失败",
    "run.output_rejected": "拒绝不合约输出",
    "run.heartbeat": "记录 Run 心跳",
    "run.checkpointed": "保存进度检查点",
    "physical_invocation.started": "启动物理调用",
    "physical_invocation.completed": "完成物理调用",
    "physical_invocation.failed": "物理调用失败",
    "physical_invocation.interrupted": "物理调用中断",
    "workflow_profile.selected": "选择工作流档位",
    "baseline.drafted": "生成基线草案",
    "baseline.confirmed": "确认需求基线",
    "charter.created": "建立任务章程",
    "work_item.created": "创建 WorkItem",
    "work_item.status_changed": "更新 WorkItem",
    "blocker.opened": "创建 BlockerCase",
    "blocker.closed": "关闭 BlockerCase",
    "evidence.recorded": "登记证据",
    "review.recorded": "记录独立复核",
    "test_run.recorded": "记录测试运行",
    "change_record.recorded": "记录轻度交付",
    "gap_case.opened": "建立 GapCase",
    "gap_case.closed": "关闭 GapCase",
    "verified_baseline.recorded": "生成验证基线",
    "command.requested": "接收自然语言命令",
    "command.executed": "执行领域命令",
    "command.rejected": "拒绝无效命令",
    "release_candidate.created": "建立发布候选",
    "release_candidate.source_verified": "核对候选来源",
    "release_candidate.invalidated": "作废发布候选",
    "external_evidence.recorded": "记录外部验收证据",
    "approval.recorded": "记录人类授权",
  };
  return labels[event.type] || event.type;
}

function renderLedger() {
  return `
    <section class="page-section">
      <header class="section-heading"><div><span class="section-kicker">追加留痕 · 本地单机</span><h2>证据账本</h2></div><div class="ledger-identity"><span>${organizationState?.ledger?.eventCount || 0} 个事件</span><code>${escapeHtml(organizationState?.ledger?.path || "")}</code></div></header>
      <div class="event-list">
        ${ledgerEvents.length
          ? ledgerEvents
              .slice()
              .reverse()
              .slice(0, 120)
              .map(
                (event) => `<button type="button" class="event-row" data-event-id="${escapeHtml(event.id)}"><time>${formatTime(event.at)}</time><span class="event-mark"></span><span><strong>${escapeHtml(eventLabel(event))}</strong><small>${escapeHtml(event.actorRoleId)} · ${escapeHtml(event.missionId || "organization")}</small></span><code>${escapeHtml(event.id)}</code></button>`,
              )
              .join("")
          : '<div class="table-empty">账本已就绪，尚无组织事件。</div>'}
      </div>
    </section>`;
}

function configuredAgent(adapterId) {
  const agents = Object.values(healthState?.agents || {});
  if (adapterId === "auto") return agents.find((agent) => agent.connected) || null;
  return healthState?.agents?.[adapterId] || null;
}

function adapterOptions(selected) {
  const agents = Object.values(healthState?.agents || {});
  const autoReady = agents.some((agent) => agent.connected);
  return [
    `<option value="auto" ${selected === "auto" ? "selected" : ""} ${autoReady ? "" : "disabled"}>自动选择</option>`,
    ...agents.map((agent) => {
      const unavailable = agent.connected ? "" : "（不可用）";
      return `<option value="${escapeHtml(agent.id)}" ${selected === agent.id ? "selected" : ""} ${agent.connected || selected === agent.id ? "" : "disabled"}>${escapeHtml(agent.label)}${unavailable}</option>`;
    }),
  ].join("");
}

function reasoningOptions(agent, model, selected) {
  const supplied = agent?.reasoningByModel?.[model] || agent?.reasoningOptions || [];
  const options = [...new Set([selected, ...supplied].filter(Boolean))];
  return [
    `<option value="" ${selected ? "" : "selected"}>本地默认</option>`,
    ...options
    .map((value) => `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(value)}</option>`)
  ].join("");
}

function modelOptions(agent) {
  return (agent?.modelOptions || [])
    .map((model) => `<option value="${escapeHtml(model)}"></option>`)
    .join("");
}

function assignmentRow({ key, label, subtitle, assignment, effective, inherited = false }) {
  const selectedAdapter = assignment?.adapter || assignment?.adapterId || effective?.adapterId || "auto";
  const agent = configuredAgent(selectedAdapter);
  const model = assignment?.model ?? effective?.model ?? agent?.model ?? "";
  const reasoning = assignment?.reasoningEffort ?? effective?.reasoningEffort ?? agent?.reasoningEffort ?? "";
  const disabled = inherited ? "disabled" : "";
  const listId = `models-${key}`;
  return `
    <div class="assignment-row" data-assignment-key="${escapeHtml(key)}">
      <div class="assignment-role">
        <strong>${escapeHtml(label)}</strong>
        <small>${escapeHtml(subtitle || (inherited ? "继承总管任职" : "独立任职"))}</small>
      </div>
      <label class="field-label">
        <span>适配器</span>
        <select data-assignment-field="adapter" ${disabled}>${adapterOptions(selectedAdapter)}</select>
      </label>
      <label class="field-label">
        <span>模型</span>
        <input type="text" data-assignment-field="model" list="${listId}" value="${escapeHtml(model)}" placeholder="本地默认" ${disabled} />
        <datalist id="${listId}">${modelOptions(agent)}</datalist>
      </label>
      <label class="field-label">
        <span>推理强度</span>
        <select data-assignment-field="reasoningEffort" ${disabled}>${reasoningOptions(agent, model, reasoning)}</select>
      </label>
      ${key === "manager" ? '<span class="assignment-scope">组织默认</span>' : `<label class="inherit-toggle"><input type="checkbox" data-assignment-inherit ${inherited ? "checked" : ""} /><span>继承总管</span></label>`}
    </div>`;
}

function currentAssignmentData() {
  if (assignmentDraft) return assignmentDraft;
  return {
    manager: configurationState?.manager || {},
    roles: configurationState?.roles || {},
  };
}

function renderAssignmentConsole() {
  const data = currentAssignmentData();
  const managerEffective = organizationState?.authority || {};
  const managerRow = assignmentRow({
    key: "manager",
    label: "总管 AGENT",
    subtitle: "全部未单独任职角色的默认配置",
    assignment: data.manager,
    effective: {
      adapterId: managerEffective.managerAdapter,
      model: managerEffective.managerModel,
      reasoningEffort: managerEffective.managerReasoning,
    },
  });
  const roleRows = (organizationState?.roles || []).map((role) => {
    const hasOverride = Object.hasOwn(data.roles || {}, role.id) && data.roles[role.id]?.inherit !== true;
    return assignmentRow({
      key: role.id,
      label: role.name,
      subtitle: hasOverride ? `${role.id} · 独立任职` : `${role.id} · 继承总管`,
      assignment: hasOverride ? data.roles[role.id] : data.manager,
      effective: organizationState?.roleAssignments?.[role.id],
      inherited: !hasOverride,
    });
  }).join("");
  return `
    <section class="assignment-console" aria-labelledby="assignmentTitle">
      <header class="subsection-heading">
        <div><span class="section-kicker">运行时任职</span><h3 id="assignmentTitle">角色模型与推理强度</h3></div>
        <button type="button" class="button button-primary" data-action="save-assignments" ${requestInFlight ? "disabled" : ""}>${icon("save")}保存任职</button>
      </header>
      <form id="assignmentForm">
        <div class="assignment-list assignment-manager">${managerRow}</div>
        <div class="assignment-list">
          <div class="assignment-list-title"><strong>角色覆盖</strong><span>关闭继承后可单独任职</span></div>
          ${roleRows}
        </div>
      </form>
    </section>`;
}

function renderResources() {
  const agents = healthState?.agents || {};
  const authority = organizationState?.authority || {};
  return `
    <section class="page-section">
      <header class="section-heading"><div><span class="section-kicker">管理诊断入口</span><h2>AGENT 资源</h2></div><div class="section-actions"><span class="resource-policy">模型厂商不限</span><button type="button" class="button button-secondary" data-action="new-agent">${icon("plus")}新增 AGENT</button></div></header>
      <div class="manager-assignment">
        <div>${icon("crown")}<span><small>当前总管任职</small><strong>${escapeHtml(managerSummary())}</strong></span></div>
        <div><span>角色</span><strong>总管 AGENT</strong></div>
        <div><span>适配器</span><strong>${escapeHtml(authority.managerAdapterLabel || authority.managerAdapter || "未配置")}</strong></div>
        <div><span>降级策略</span><strong>失败即阻塞，不静默降级</strong></div>
      </div>
      ${renderAssignmentConsole()}
      <div class="resource-table">
        <div class="table-head"><span>资源</span><span>连接</span><span>默认模型</span><span>权限模式</span></div>
        ${Object.values(agents)
          .map(
            (agent) => `<div class="resource-row"><span><strong>${escapeHtml(agent.label)}</strong><small>${escapeHtml(agent.adapter)}</small></span><span class="connection ${agent.connected ? "online" : "offline"}"><i></i>${agent.connected ? "可用" : "不可用"}</span><code>${escapeHtml(agent.model || "本地默认")}</code><span>${escapeHtml(agent.permissionMode)}</span></div>`,
          )
          .join("")}
      </div>
      <div class="diagnostic-note">可使用内置 CLI 或 custom 命令适配器接入任意厂商和本地模型。任职来自本机 black-shores.config.json，不会上传到仓库。</div>
    </section>`;
}

function renderLoading() {
  return `<div class="loading-state">${icon("loader-circle", "spin")}<span>正在读取本地组织账本</span></div>`;
}

function renderError(message) {
  return `<div class="error-state">${icon("triangle-alert")}<div><strong>组织工作台无法读取</strong><p>${escapeHtml(message)}</p><button type="button" class="button button-secondary" data-action="refresh">重试</button></div></div>`;
}

function assignmentValue(row) {
  return {
    adapter: row.querySelector('[data-assignment-field="adapter"]')?.value || "auto",
    model: row.querySelector('[data-assignment-field="model"]')?.value.trim() || "",
    reasoningEffort:
      row.querySelector('[data-assignment-field="reasoningEffort"]')?.value || "",
  };
}

function captureAssignmentDraft() {
  const form = document.getElementById("assignmentForm");
  if (!form) return;
  const managerRow = form.querySelector('[data-assignment-key="manager"]');
  const roles = {};
  form.querySelectorAll("[data-assignment-key]").forEach((row) => {
    const key = row.dataset.assignmentKey;
    if (key === "manager") return;
    roles[key] = row.querySelector("[data-assignment-inherit]")?.checked
      ? { inherit: true }
      : assignmentValue(row);
  });
  assignmentDraft = { manager: assignmentValue(managerRow), roles };
}

function syncAssignmentRow(row, { resetModel = false, resetReasoning = false } = {}) {
  const adapterSelect = row.querySelector('[data-assignment-field="adapter"]');
  const modelInput = row.querySelector('[data-assignment-field="model"]');
  const reasoningSelect = row.querySelector('[data-assignment-field="reasoningEffort"]');
  const datalist = row.querySelector("datalist");
  const agent = configuredAgent(adapterSelect?.value);
  if (resetModel && modelInput) modelInput.value = agent?.model || "";
  if (datalist) datalist.innerHTML = modelOptions(agent);
  if (reasoningSelect) {
    const current = resetModel || resetReasoning
      ? agent?.reasoningDefaultsByModel?.[modelInput?.value] || agent?.reasoningEffort || ""
      : reasoningSelect.value;
    reasoningSelect.innerHTML = reasoningOptions(agent, modelInput?.value || "", current);
  }
  captureAssignmentDraft();
}

function syncInheritedRowsFromManager() {
  const form = document.getElementById("assignmentForm");
  const managerRow = form?.querySelector('[data-assignment-key="manager"]');
  if (!managerRow) return;
  const manager = assignmentValue(managerRow);
  form.querySelectorAll('[data-assignment-key]:not([data-assignment-key="manager"])').forEach((row) => {
    if (!row.querySelector("[data-assignment-inherit]")?.checked) return;
    row.querySelector('[data-assignment-field="adapter"]').value = manager.adapter;
    row.querySelector('[data-assignment-field="model"]').value = manager.model;
    syncAssignmentRow(row);
    row.querySelector('[data-assignment-field="reasoningEffort"]').value = manager.reasoningEffort;
  });
  captureAssignmentDraft();
}

function bindAssignmentEvents() {
  const form = document.getElementById("assignmentForm");
  if (!form) return;
  form.querySelectorAll("[data-assignment-key]").forEach((row) => {
    const isManager = row.dataset.assignmentKey === "manager";
    const adapterSelect = row.querySelector('[data-assignment-field="adapter"]');
    const modelInput = row.querySelector('[data-assignment-field="model"]');
    const reasoningSelect = row.querySelector('[data-assignment-field="reasoningEffort"]');
    const inheritToggle = row.querySelector("[data-assignment-inherit]");

    adapterSelect?.addEventListener("change", () => {
      syncAssignmentRow(row, { resetModel: true });
      if (isManager) syncInheritedRowsFromManager();
    });
    modelInput?.addEventListener("input", () => {
      syncAssignmentRow(row, { resetReasoning: true });
      if (isManager) syncInheritedRowsFromManager();
    });
    reasoningSelect?.addEventListener("change", () => {
      captureAssignmentDraft();
      if (isManager) syncInheritedRowsFromManager();
    });
    inheritToggle?.addEventListener("change", () => {
      const inherited = inheritToggle.checked;
      row.querySelectorAll("[data-assignment-field]").forEach((field) => {
        field.disabled = inherited;
      });
      const subtitle = row.querySelector(".assignment-role small");
      if (subtitle) subtitle.textContent = `${row.dataset.assignmentKey} · ${inherited ? "继承总管" : "独立任职"}`;
      if (inherited) syncInheritedRowsFromManager();
      else captureAssignmentDraft();
    });
  });
}

async function saveAssignments() {
  if (requestInFlight) return;
  captureAssignmentDraft();
  requestInFlight = true;
  renderCurrentView();
  try {
    const result = await api("/api/configuration/assignments", {
      method: "PUT",
      body: JSON.stringify(assignmentDraft),
    });
    assignmentDraft = null;
    showToast(
      result.activeRunIds?.length
        ? "任职已保存，将从下一次物理调用生效"
        : "任职已保存并立即生效",
    );
    await refreshState({ quiet: true });
  } catch (error) {
    showToast(error.message, "danger");
  } finally {
    requestInFlight = false;
    renderCurrentView();
  }
}

function openAgentConfigDialog() {
  detailContent.innerHTML = `
    <header class="dialog-header"><div><span class="section-kicker">本地适配器</span><h2>接入新 AGENT</h2></div><button type="button" class="icon-button" data-close-dialog aria-label="关闭" title="关闭">${icon("x")}</button></header>
    <form class="agent-config-form" id="agentConfigForm">
      <div class="form-grid">
        <label class="field-label"><span>AGENT ID</span><input type="text" name="id" pattern="[a-z0-9][a-z0-9-]{1,62}" placeholder="my-agent" required /></label>
        <label class="field-label"><span>显示名称</span><input type="text" name="label" placeholder="My AGENT" required /></label>
        <label class="field-label form-span"><span>可执行命令</span><input type="text" name="command" placeholder="命令名或绝对路径" required /></label>
        <label class="field-label"><span>模型 ID</span><input type="text" name="model" placeholder="provider/model" required /></label>
        <label class="field-label"><span>推理强度</span><input type="text" name="reasoningEffort" value="default" required /></label>
        <label class="field-label form-span"><span>参数模板（JSON 数组）</span><textarea name="args" rows="4" spellcheck="false">[]</textarea></label>
        <label class="field-label"><span>提示词输入</span><select name="promptMode"><option value="stdin">标准输入</option><option value="argument">参数 {prompt}</option></select></label>
        <label class="field-label"><span>输出格式</span><select name="outputFormat"><option value="text">纯文本</option><option value="ndjson">逐行 JSON</option></select></label>
      </div>
      <label class="check-line"><input type="checkbox" name="skipVersionCheck" /><span>跳过 --version 检查</span></label>
      <footer class="dialog-actions"><button type="button" class="button button-secondary" data-close-dialog>取消</button><button type="submit" class="button button-primary">${icon("plug")}接入 AGENT</button></footer>
    </form>`;
  detailDialog.showModal();
  detailContent.querySelectorAll("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => detailDialog.close());
  });
  document.getElementById("agentConfigForm")?.addEventListener("submit", submitAgentConfig);
  refreshIcons();
}

async function submitAgentConfig(event) {
  event.preventDefault();
  if (requestInFlight) return;
  const form = new FormData(event.currentTarget);
  let args;
  try {
    args = JSON.parse(form.get("args") || "[]");
    if (!Array.isArray(args)) throw new Error("必须是数组");
  } catch (error) {
    showToast(`参数模板无效：${error.message}`, "danger");
    return;
  }
  requestInFlight = true;
  try {
    const result = await api("/api/configuration/adapters", {
      method: "POST",
      body: JSON.stringify({
        id: form.get("id"),
        label: form.get("label"),
        command: form.get("command"),
        model: form.get("model"),
        reasoningEffort: form.get("reasoningEffort"),
        args,
        promptMode: form.get("promptMode"),
        outputFormat: form.get("outputFormat"),
        skipVersionCheck: form.get("skipVersionCheck") === "on",
      }),
    });
    detailDialog.close();
    assignmentDraft = null;
    showToast(result.agent.connected ? "AGENT 已接入，可以分配角色" : "配置已保存，但命令尚不可用", result.agent.connected ? "success" : "danger");
    await refreshState({ quiet: true });
  } catch (error) {
    showToast(error.message, "danger");
  } finally {
    requestInFlight = false;
    renderCurrentView();
  }
}

function captureEditorFocus() {
  const editor = document.activeElement;
  if (!(editor instanceof HTMLTextAreaElement) || editor.id !== "commandInput") return null;
  const snapshot = {
    key: commandKey(),
    start: editor.selectionStart,
    end: editor.selectionEnd,
  };
  commandSelections.set(snapshot.key, snapshot);
  return snapshot;
}

function restoreEditorFocus(snapshot) {
  if (!snapshot || snapshot.key !== commandKey()) return;
  const editor = document.getElementById("commandInput");
  if (!(editor instanceof HTMLTextAreaElement)) return;
  editor.focus({ preventScroll: true });
  const end = editor.value.length;
  editor.setSelectionRange(Math.min(snapshot.start ?? end, end), Math.min(snapshot.end ?? end, end));
}

function renderCurrentView(editorFocus = captureEditorFocus()) {
  updateAppIdentity();
  renderNav();
  const [eyebrow, title] = pageMeta[activeView];
  pageEyebrow.textContent = eyebrow;
  pageTitle.textContent = title;
  if (loading) {
    mainContent.innerHTML = renderLoading();
  } else if (!organizationState) {
    mainContent.innerHTML = renderError("本地组织服务未返回有效状态。");
  } else {
    const renderers = {
      workbench: renderWorkbench,
      missions: renderMissions,
      organization: renderOrganization,
      ledger: renderLedger,
      resources: renderResources,
    };
    mainContent.innerHTML = renderers[activeView]();
  }
  bindDynamicEvents();
  refreshIcons();
  restoreEditorFocus(editorFocus);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `请求失败 (${response.status})`);
    error.missionId = payload.missionId;
    throw error;
  }
  return payload;
}

async function refreshState({ quiet = false } = {}) {
  const editorFocus = captureEditorFocus() || commandSelections.get(commandKey()) || null;
  if (!quiet) loading = true;
  if (!quiet) renderCurrentView();
  try {
    const [state, health, ledger, configuration] = await Promise.all([
      api("/api/organization/state"),
      api("/api/health"),
      api("/api/organization/events"),
      api("/api/configuration"),
    ]);
    organizationState = state;
    healthState = health;
    ledgerEvents = ledger.events || [];
    configurationState = configuration;
    if (!selectedMissionId && state.missions?.length) selectedMissionId = state.missions[0].id;
    systemState.classList.remove("offline");
    systemState.innerHTML = '<span class="system-state-dot" aria-hidden="true"></span>组织在线';
  } catch (error) {
    if (!quiet) {
      organizationState = null;
      showToast(error.message, "danger");
    }
    systemState.classList.add("offline");
    systemState.innerHTML = '<span class="system-state-dot" aria-hidden="true"></span>组织离线';
  } finally {
    loading = false;
    renderCurrentView(editorFocus);
  }
}

async function submitCommand(event) {
  event.preventDefault();
  if (requestInFlight) return;
  const mission = activeMission();
  const content = new FormData(event.currentTarget).get("content");
  const key = commandKey(mission);
  commandDrafts.set(key, content);
  event.currentTarget.querySelector("textarea")?.blur();
  requestInFlight = true;
  renderCurrentView();
  try {
    const payload = await api("/api/organization/commands", {
      method: "POST",
      body: JSON.stringify({ content, missionId: mission?.id || null }),
    });
    if (payload.mission?.id) selectedMissionId = payload.mission.id;
    commandDrafts.delete(key);
    commandSelections.delete(key);
    const actionLabels = {
      create_mission: "Mission 已建立，需求明确岗开始工作",
      add_requirement_message: "补充已交给需求明确岗",
      set_workflow_profile: "工作流档位已更新",
      confirm_baseline: "需求基线已确认，总管 AGENT 开始组织规划",
      retry_blocked: "已启动有限恢复",
      start_heavy_review: "重度全量回顾已启动",
      query_status: "任务状态已刷新",
    };
    showToast(actionLabels[payload.action] || "命令已执行");
    await refreshState({ quiet: true });
  } catch (error) {
    if (error.missionId) selectedMissionId = error.missionId;
    showToast(error.message, "danger");
  } finally {
    requestInFlight = false;
    renderCurrentView();
  }
}

async function submitExternalEvidence(event) {
  event.preventDefault();
  if (requestInFlight) return;
  const mission = activeMission();
  const form = new FormData(event.currentTarget);
  requestInFlight = true;
  renderCurrentView();
  try {
    await api(`/api/organization/missions/${encodeURIComponent(mission.id)}/external-evidence`, {
      method: "POST",
      body: JSON.stringify({
        buildIdentity: form.get("buildIdentity"),
        result: form.get("result"),
        notes: form.get("notes"),
      }),
    });
    showToast(form.get("result") === "passed" ? "外部证据已绑定候选" : "外部验收失败，已进入工程返工");
    await refreshState({ quiet: true });
  } catch (error) {
    showToast(error.message, "danger");
  } finally {
    requestInFlight = false;
    renderCurrentView();
  }
}

async function missionAction(action) {
  const mission = activeMission();
  if (!mission || requestInFlight) return;
  requestInFlight = true;
  renderCurrentView();
  try {
    if (action === "confirm-baseline") {
      await api(`/api/organization/missions/${encodeURIComponent(mission.id)}/confirm-baseline`, { method: "POST" });
      showToast("需求基线已确认，总管 AGENT 开始组织规划");
    } else if (action === "retry") {
      await api(`/api/organization/missions/${encodeURIComponent(mission.id)}/retry`, { method: "POST" });
      showToast("已在恢复预算内重新任职");
    } else if (action === "verify-source") {
      await api(`/api/organization/missions/${encodeURIComponent(mission.id)}/verify-source`, { method: "POST" });
      showToast("候选来源已核对并生成固定指纹");
    } else if (action === "approve-merge") {
      await api(`/api/organization/missions/${encodeURIComponent(mission.id)}/approve-merge`, { method: "POST" });
      showToast("合并授权已独立记录");
    } else if (action === "approve-deployment") {
      await api(`/api/organization/missions/${encodeURIComponent(mission.id)}/approve-deployment`, { method: "POST" });
      showToast("部署授权已独立记录");
    } else if (action === "accept-result") {
      await api(`/api/organization/missions/${encodeURIComponent(mission.id)}/accept-result`, { method: "POST" });
      showToast("业务结果已验收，Mission 完成");
    }
    await refreshState({ quiet: true });
  } catch (error) {
    showToast(error.message, "danger");
  } finally {
    requestInFlight = false;
    renderCurrentView();
  }
}

function openEventDetail(eventId) {
  const event = ledgerEvents.find((item) => item.id === eventId);
  if (!event) return;
  detailContent.innerHTML = `
    <header class="dialog-header"><div><span class="section-kicker">${escapeHtml(event.type)}</span><h2>${escapeHtml(eventLabel(event))}</h2></div><button type="button" class="icon-button" data-close-dialog aria-label="关闭" title="关闭">${icon("x")}</button></header>
    <dl class="event-detail"><div><dt>事件 ID</dt><dd><code>${escapeHtml(event.id)}</code></dd></div><div><dt>时间</dt><dd>${escapeHtml(event.at)}</dd></div><div><dt>Mission</dt><dd>${escapeHtml(event.missionId || "organization")}</dd></div><div><dt>责任角色</dt><dd>${escapeHtml(event.actorRoleId)}</dd></div><div><dt>因果事件</dt><dd>${escapeHtml(event.causationId || "—")}</dd></div></dl>
    <section class="event-payload"><h3>原始载荷</h3><pre>${escapeHtml(JSON.stringify(event.payload, null, 2))}</pre></section>`;
  detailDialog.showModal();
  detailContent.querySelector("[data-close-dialog]")?.addEventListener("click", () => detailDialog.close());
  refreshIcons();
}

function bindDynamicEvents() {
  document.getElementById("commandForm")?.addEventListener("submit", submitCommand);
  bindAssignmentEvents();
  const responseEditor = document.getElementById("commandInput");
  responseEditor?.addEventListener("input", (event) => {
    commandDrafts.set(commandKey(), event.currentTarget.value);
    captureEditorFocus();
  });
  responseEditor?.addEventListener("select", captureEditorFocus);
  responseEditor?.addEventListener("keyup", captureEditorFocus);
  document.getElementById("externalEvidenceForm")?.addEventListener("submit", submitExternalEvidence);
  mainContent.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.action;
      if (action === "new-mission") {
        selectedMissionId = "__new__";
        switchView("workbench");
      }
      else if (action === "request-baseline-change") document.getElementById("commandInput")?.focus();
      else if (action === "refresh") refreshState();
      else if (action === "save-assignments") saveAssignments();
      else if (action === "new-agent") openAgentConfigDialog();
      else missionAction(action);
    });
  });
  mainContent.querySelectorAll("[data-mission-id]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedMissionId = button.dataset.missionId;
      switchView("workbench");
    });
  });
  mainContent.querySelectorAll("[data-event-id]").forEach((button) => {
    button.addEventListener("click", () => openEventDetail(button.dataset.eventId));
  });
}

function switchView(view) {
  activeView = view;
  closeMobileNav();
  renderCurrentView();
}

function openMobileNav() {
  sidebar.classList.add("open");
  mobileBackdrop.classList.add("visible");
}

function closeMobileNav() {
  sidebar.classList.remove("open");
  mobileBackdrop.classList.remove("visible");
}

document.getElementById("mobileMenuButton").addEventListener("click", openMobileNav);
document.getElementById("mobileBackdrop").addEventListener("click", closeMobileNav);
document.getElementById("refreshButton").addEventListener("pointerdown", captureEditorFocus);
document.getElementById("refreshButton").addEventListener("click", () => refreshState());
detailDialog.addEventListener("click", (event) => {
  if (event.target === detailDialog) detailDialog.close();
});

refreshState();
pollTimer = setInterval(() => {
  const hasActiveRun = Boolean(organizationState?.activeRunIds?.length);
  if (hasActiveRun && !requestInFlight) refreshState({ quiet: true });
}, 2500);

window.addEventListener("beforeunload", () => clearInterval(pollTimer));

const navItems = [
  { id: "workbench", label: "人类工作台", icon: "messages-square" },
  { id: "missions", label: "Mission", icon: "list-tree" },
  { id: "decisions", label: "决策收件箱", icon: "inbox" },
  { id: "blockers", label: "阻塞与恢复", icon: "life-buoy" },
  { id: "quality", label: "质量与发布", icon: "shield-check" },
  { id: "cognition", label: "认知与决策", icon: "brain" },
  { id: "evolution", label: "演进实验室", icon: "flask-conical" },
  { id: "knowledge", label: "信息与技能", icon: "library" },
  { id: "organization", label: "组织与角色", icon: "network" },
  { id: "ledger", label: "证据账本", icon: "scroll-text" },
  { id: "resources", label: "AGENT 资源", icon: "cpu" },
];

const pageMeta = {
  workbench: ["组织入口", "人类工作台"],
  missions: ["业务结果", "Mission"],
  decisions: ["待你处理", "决策收件箱"],
  blockers: ["等待与恢复", "阻塞与恢复"],
  quality: ["验证与门禁", "质量与发布"],
  cognition: ["发散与审议", "认知与决策"],
  evolution: ["观察与改进", "演进实验室"],
  knowledge: ["检索与技能", "信息与技能"],
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
  waiting: ["已安全暂停", "waiting"],
  accepted: ["已验收", "success"],
  failed: ["已失败", "danger"],
  cancelled: ["已取消", "neutral"],
};

let activeView = "workbench";
let selectedMissionId = "";
let organizationState = null;
let healthState = null;
let configurationState = null;
let emailState = null;
let governanceState = null;
let ledgerEvents = [];
let inspectionState = null;
let loading = true;
let requestInFlight = false;
let tunerInFlight = false;
let emailRequestInFlight = false;
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
const appShell = document.getElementById("appShell");
const tunerDock = document.getElementById("tunerDock");
const tunerBackdrop = document.getElementById("tunerBackdrop");
const tunerInput = document.getElementById("tunerInput");
const tunerMessages = document.getElementById("tunerMessages");
const tunerSubmitButton = document.getElementById("tunerSubmitButton");
const tunerLayoutQuery = window.matchMedia("(max-width: 1120px)");

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
  const openDecisions = (organizationState?.missions || []).reduce(
    (count, mission) => count + (mission.decisions || []).filter((item) => item.status === "open").length,
    0,
  );
  const openBlockers = (organizationState?.missions || []).reduce(
    (count, mission) => count + (mission.blockers || []).filter((item) => item.status === "open").length,
    0,
  );
  const badges = { missions: missionCount, decisions: openDecisions, blockers: openBlockers };
  navList.innerHTML = navItems
    .map(
      (item) => `
        <button type="button" class="nav-button ${activeView === item.id ? "active" : ""}" data-view="${item.id}">
          ${icon(item.icon)}
          <span>${item.label}</span>
          ${badges[item.id] ? `<small>${badges[item.id]}</small>` : ""}
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

function workItemProgress(mission) {
  const items = mission?.workItems || [];
  if (!items.length) return null;
  const done = items.filter((item) => ["completed", "superseded"].includes(item.status)).length;
  return { done, total: items.length };
}

function renderEmptyWorkbench() {
  return `
    <section class="workbench-empty" aria-labelledby="newMissionTitle">
      <div class="empty-context">
        <span class="section-kicker">群星的调律者 · 命令入口</span>
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
        <div><span>调律者任职</span><strong>${escapeHtml(managerSummary())}</strong></div>
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

function commandConversation() {
  const globalTunerCommandIds = new Set(
    ledgerEvents
      .filter((event) => event.type === "command.requested"
        && event.payload.channel === "tuner-chat"
        && event.payload.context === "global")
      .map((event) => event.payload.id),
  );
  return ledgerEvents
    .filter((event) => ["command.requested", "command.executed", "command.rejected"].includes(event.type))
    .filter((event) => globalTunerCommandIds.has(event.payload.id) || globalTunerCommandIds.has(event.causationId))
    .slice(-40);
}

function renderTunerDock() {
  const status = document.getElementById("tunerStatus");
  const context = document.getElementById("tunerContext");
  const governance = document.getElementById("tunerGovernance");
  const emailIndicator = document.getElementById("emailChannelIndicator");
  const conversation = commandConversation();
  const lastEventId = conversation.at(-1)?.id || "";
  const previousEventId = tunerMessages.dataset.lastEventId || "";
  const nearBottom = tunerMessages.scrollHeight - tunerMessages.scrollTop - tunerMessages.clientHeight < 80;

  if (status) {
    status.textContent = organizationState?.authority?.executionReady
      ? `${managerSummary()} · 在线`
      : "等待配置可用 AGENT";
  }
  if (context) {
    context.innerHTML = `<span>独立上下文</span><strong>组织全局</strong><small>不自动绑定页面 Mission</small>`;
  }
  if (tunerMessages) {
    tunerMessages.innerHTML = conversation.length
      ? conversation.map((event) => {
          if (event.type === "command.requested") {
            const channel = event.payload.channel === "email" ? "邮箱" : "软件";
            return `<article class="tuner-message tuner-message-human"><header><span>你 · ${channel}</span><time>${formatTime(event.at)}</time></header><p>${escapeHtml(event.payload.content).replaceAll("\n", "<br />")}</p></article>`;
          }
          const rejected = event.type === "command.rejected";
          const content = rejected ? event.payload.error : event.payload.reply;
          return `<article class="tuner-message tuner-message-agent ${rejected ? "tuner-message-error" : ""}"><header><span>群星的调律者</span><time>${formatTime(event.at)}</time></header><p>${escapeHtml(content || (rejected ? "命令被拒绝" : "命令已执行")).replaceAll("\n", "<br />")}</p>${event.missionId ? `<button type="button" data-tuner-mission="${escapeHtml(event.missionId)}">${escapeHtml(event.missionId)}</button>` : ""}</article>`;
        }).join("")
      : `<div class="tuner-empty">群星的调律者已就位。所有命令会进入统一账本，并由组织工作流执行。</div>`;
    tunerMessages.dataset.lastEventId = lastEventId;
    if (!previousEventId || previousEventId !== lastEventId || nearBottom) {
      tunerMessages.scrollTop = tunerMessages.scrollHeight;
    }
    tunerMessages.querySelectorAll("[data-tuner-mission]").forEach((button) => {
      button.addEventListener("click", () => {
        selectedMissionId = button.dataset.tunerMission;
        switchView("workbench");
      });
    });
  }
  if (governance) {
    const traceCount = governanceState?.actionTrace?.roleLogCount || 0;
    const archiveCount = governanceState?.backup?.archiveCount || 0;
    governance.innerHTML = `
      <span>${icon("shield-check")} 强制治理已启用</span>
      <small>${archiveCount} 个修改前备份 · ${traceCount} 份角色日志</small>`;
  }
  if (emailIndicator) {
    const enabled = emailState?.enabled === true;
    emailIndicator.className = `channel-indicator ${enabled ? (emailState.status === "error" ? "error" : "online") : ""}`;
  }
  if (tunerSubmitButton) {
    tunerSubmitButton.disabled = tunerInFlight;
    tunerSubmitButton.innerHTML = icon(tunerInFlight ? "loader-circle" : "arrow-up", tunerInFlight ? "spin" : "");
  }
  refreshIcons();
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
        <button type="button" class="button button-primary" data-action="confirm-baseline" ${requestInFlight || !missionActionAvailable(mission, "confirm-baseline") ? "disabled" : ""}>
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
      ? "描述要修改的需求，或点击上方“恢复任务”。"
      : mission.status === "waiting"
        ? "输入中途修改要求，或点击上方“继续运行”。"
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

function missionActionAvailable(mission, action) {
  return Array.isArray(mission?.availableActions) && mission.availableActions.includes(action);
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
        <button type="button" class="button button-primary" data-action="verify-source" ${requestInFlight || !missionActionAvailable(mission, "verify-source") ? "disabled" : ""}>${icon("scan-search")}核对来源</button>
      </div>`;
  } else if (mission.status === "awaiting_release_approval" && !mergeApproval) {
    action = `
      <div class="gate-action gate-warning">
        <div><strong>合并授权</strong><small>只授权合并当前指纹候选，不包含部署。</small></div>
        <button type="button" class="button button-primary" data-action="approve-merge" ${requestInFlight || !missionActionAvailable(mission, "approve-merge") ? "disabled" : ""}>${icon("git-merge")}批准合并</button>
      </div>`;
  } else if (mission.status === "awaiting_release_approval" && !deploymentApproval) {
    action = `
      <div class="gate-action gate-warning">
        <div><strong>部署授权</strong><small>合并授权已记录；本动作只授权部署当前候选。</small></div>
        <button type="button" class="button button-primary" data-action="approve-deployment" ${requestInFlight || !missionActionAvailable(mission, "approve-deployment") ? "disabled" : ""}>${icon("upload-cloud")}批准部署</button>
      </div>`;
  } else if (mission.status === "awaiting_external_evidence") {
    action = `
      <form class="external-evidence-form" id="externalEvidenceForm" aria-disabled="${!missionActionAvailable(mission, "external-evidence")}">
        <label for="buildIdentity">候选身份</label>
        <input id="buildIdentity" name="buildIdentity" maxlength="500" placeholder="版本号、部署时间或构建 ID" required />
        <fieldset class="result-segment"><legend>外部验收结果</legend><label><input type="radio" name="result" value="passed" required /><span>${icon("check")}通过</span></label><label><input type="radio" name="result" value="failed" required /><span>${icon("x")}失败</span></label></fieldset>
        <label for="externalNotes">证据摘要</label>
        <textarea id="externalNotes" name="notes" rows="3" maxlength="6000" placeholder="环境、步骤、观察结果与证据路径"></textarea>
        <button type="submit" class="button button-primary" ${requestInFlight || !missionActionAvailable(mission, "external-evidence") ? "disabled" : ""}>${icon("clipboard-check")}提交外部证据</button>
      </form>`;
  } else if (mission.status === "awaiting_result_acceptance") {
    action = `
      <div class="gate-action gate-success">
        <div><strong>业务结果验收</strong><small>${escapeHtml(latestExternalEvidence?.buildIdentity || "当前候选")} 的外部证据已通过。</small></div>
        <button type="button" class="button button-primary" data-action="accept-result" ${requestInFlight || !missionActionAvailable(mission, "accept-result") ? "disabled" : ""}>${icon("badge-check")}验收结果</button>
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
    return `<div class="quiet-empty">需求基线确认后，群星的调律者才会建立任务章程与分工。</div>`;
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
  const runIcon = run.status === "running"
    ? "loader-circle"
    : run.status === "completed"
      ? "check"
      : run.status === "paused"
        ? "pause"
        : "x";
  const activity = run.status === "running"
    ? run.currentAction || run.lastCheckpoint?.summary || "角色正在执行"
    : `${run.invocations?.length || 1} 次物理调用`;
  return `
    <div class="run-row">
      <span class="run-icon">${icon(runIcon, run.status === "running" ? "spin" : "")}</span>
      <div><strong>${escapeHtml(run.roleName)}</strong><small>${escapeHtml(activity)} · ${formatTime(run.lastHeartbeatAt || run.at)}</small></div>
      <span class="run-status">${escapeHtml(run.status)}</span>
    </div>`;
}

function renderMissionControls(mission) {
  const active = organizationState?.activeRuns?.find((run) => run.missionId === mission.id);
  const profileEditable = missionActionAvailable(mission, "workflow-profile");
  const profile = mission.workflowProfile?.requested || "auto";
  const profileButtons = [
    ["auto", "自动"],
    ["light", "轻度"],
    ["heavy", "重度"],
  ].map(([value, label]) => `
    <button type="button" class="segment-button ${profile === value ? "active" : ""}" data-workflow-profile="${value}" ${!profileEditable || requestInFlight ? "disabled" : ""}>${label}</button>`).join("");
  const pauseLabel = active?.pauseRequested
    ? "正在安全暂停"
    : mission.status === "waiting"
      ? "已安全暂停"
      : "安全暂停";
  const pauseButton = `<button type="button" class="button button-danger" data-action="pause" ${requestInFlight || !missionActionAvailable(mission, "pause") || active?.pauseRequested ? "disabled" : ""}>${icon(active?.pauseRequested ? "loader-circle" : "pause", active?.pauseRequested ? "spin" : "")} ${pauseLabel}</button>`;
  const stopButton = active && missionActionAvailable(mission, "emergency-stop")
    ? `<button type="button" class="button button-danger" data-action="emergency-stop" data-mission-id="${escapeHtml(mission.id)}" ${requestInFlight ? "disabled" : ""}>${icon("octagon-x")}紧急停止</button>`
    : "";
  const cancelButton = missionActionAvailable(mission, "cancel")
    ? `<button type="button" class="button button-secondary" data-action="cancel" data-mission-id="${escapeHtml(mission.id)}" ${requestInFlight ? "disabled" : ""}>${icon("ban")}取消任务</button>`
    : "";
  const overrideButton = missionActionAvailable(mission, "override")
    ? `<button type="button" class="button button-secondary" data-action="new-override" data-mission-id="${escapeHtml(mission.id)}" ${requestInFlight ? "disabled" : ""}>${icon("siren")}紧急绕过</button>`
    : "";
  const deviceButton = missionActionAvailable(mission, "device-package")
    ? `<button type="button" class="button button-secondary" data-action="device-package" data-mission-id="${escapeHtml(mission.id)}" ${requestInFlight ? "disabled" : ""}>${icon("smartphone")}真机执行包</button>`
    : "";
  const deviceEvidenceButton = missionActionAvailable(mission, "device-evidence")
    ? `<button type="button" class="button button-secondary" data-action="device-evidence" data-mission-id="${escapeHtml(mission.id)}" ${requestInFlight ? "disabled" : ""}>${icon("clipboard-check")}回填真机证据</button>`
    : "";
  const qualityButton = missionActionAvailable(mission, "quality-decision")
    ? `<button type="button" class="button button-secondary" data-action="quality-decision" ${requestInFlight ? "disabled" : ""}>${icon("stamp")}签署质量判定</button>`
    : "";
  const waitingButton = missionActionAvailable(mission, "record-waiting")
    ? `<button type="button" class="button button-secondary" data-action="new-waiting" data-mission-id="${escapeHtml(mission.id)}" ${requestInFlight ? "disabled" : ""}>${icon("hourglass")}记录等待</button>`
    : "";
  let contextualActions = "";
  if (mission.status === "waiting") {
    contextualActions = `<button type="button" class="button button-secondary" data-action="request-revision" ${requestInFlight || !missionActionAvailable(mission, "revise-requirements") ? "disabled" : ""}>${icon("pencil-line")}修改需求</button><button type="button" class="button button-primary" data-action="resume" ${requestInFlight || !missionActionAvailable(mission, "resume") ? "disabled" : ""}>${icon("play")}继续运行</button>`;
  } else if (mission.status === "blocked") {
    contextualActions = `<button type="button" class="button button-secondary" data-action="request-revision" ${requestInFlight || !missionActionAvailable(mission, "revise-requirements") ? "disabled" : ""}>${icon("pencil-line")}修改需求</button><button type="button" class="button button-primary" data-action="retry" ${requestInFlight || !missionActionAvailable(mission, "retry") ? "disabled" : ""}>${icon("rotate-ccw")}恢复任务</button>`;
  } else if (mission.status === "light_completed") {
    contextualActions = `<button type="button" class="button button-primary" data-action="start-heavy-review" ${requestInFlight || !missionActionAvailable(mission, "start-heavy-review") ? "disabled" : ""}>${icon("shield-check")}启动重度全量回顾</button>`;
  }
  return `
    <section class="mission-controls" aria-label="Mission 控制">
      <div class="workflow-control"><span>工作模式</span><div class="segmented-control" aria-label="工作流模式">${profileButtons}</div><small>${escapeHtml(mission.workflowProfile?.reason || "")}</small></div>
      <div class="mission-control-actions">${contextualActions}${pauseButton}${stopButton}${cancelButton}${overrideButton}${deviceButton}${deviceEvidenceButton}${qualityButton}${waitingButton}</div>
    </section>`;
}

function renderActiveRun(mission) {
  const active = organizationState?.activeRuns?.find((run) => run.missionId === mission.id);
  if (!active) return "";
  const runRecord = (mission.runs || []).find((run) => run.id === active.runId);
  return `
    <section class="inspector-section activity-section">
      <header><span>活动 Run</span><span class="live-indicator"><i></i>${active.pauseRequested ? "暂停中" : "运行中"}</span></header>
      <div class="activity-line"><span>当前动作</span><strong>${escapeHtml(active.currentAction || "正在建立执行上下文")}</strong></div>
      <div class="activity-line"><span>角色</span><strong>${escapeHtml(active.roleName || "")}</strong></div>
      <div class="activity-line"><span>实际模型</span><code>${escapeHtml(runRecord?.model || "—")}${runRecord?.reasoningEffort ? ` · ${escapeHtml(runRecord.reasoningEffort)}` : ""}</code></div>
      <div class="activity-line"><span>物理调用</span><code>${escapeHtml(active.invocationId || "—")}</code></div>
      <div class="activity-line"><span>最后心跳</span><time>${formatTime(active.lastHeartbeatAt)}</time></div>
      <div class="activity-line"><span>最后检查点</span><time>${formatTime(active.lastCheckpointAt)}</time></div>
    </section>`;
}

function renderMissionWorkbench(mission) {
  const progress = workItemProgress(mission);
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
        <div class="mission-progress" aria-label="工作合同完成项">${progress ? `<span>已完成工作项 ${progress.done}/${progress.total}</span>` : `<span>工作合同尚未建立，暂无可计数项</span>`}</div>
        ${renderMissionControls(mission)}
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
        <button type="button" class="button button-primary" data-action="new-mission" ${organizationState?.controls?.canCreateMission === false ? "disabled" : ""}>${icon("plus")}新建 Mission</button>
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
                    <span>${escapeHtml(mission.runs?.at(-1)?.roleName || "群星的调律者")}</span>
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
        <div class="org-manager"><span class="org-node-icon">调</span><div><strong>群星的调律者</strong><small>${escapeHtml(managerSummary())} · ${organizationState?.authority?.executionReady ? "active" : "unconfigured"}</small></div></div>
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
    "run.pause_requested": "请求安全暂停",
    "run.paused": "暂停 Run",
    "run.resume_requested": "恢复 Run",
    "run.output_rejected": "拒绝不合约输出",
    "run.heartbeat": "记录 Run 心跳",
    "run.checkpointed": "保存进度检查点",
    "physical_invocation.started": "启动物理调用",
    "physical_invocation.completed": "完成物理调用",
    "physical_invocation.failed": "物理调用失败",
    "physical_invocation.interrupted": "物理调用中断",
    "workflow_profile.selected": "选择工作流档位",
    "requirements_revision.requested": "记录中途需求修改",
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
    "action.safeguard_started": "建立动作保护点",
    "action.safeguard_failed": "动作保护失败",
    "role_action.recorded": "写入角色动作留痕",
    "email.channel_configured": "配置邮箱通道",
    "email.command_received": "接收邮箱命令",
    "email.command_ignored": "忽略未授权邮件",
    "email.notification_sent": "发送决策邮件",
    "email.channel_error": "邮箱通道异常",
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
        <small>${escapeHtml(subtitle || (inherited ? "继承调律者任职" : "独立任职"))}</small>
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
      ${key === "manager" ? '<span class="assignment-scope">组织默认</span>' : `<label class="inherit-toggle"><input type="checkbox" data-assignment-inherit ${inherited ? "checked" : ""} /><span>继承调律者</span></label>`}
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
    label: "群星的调律者",
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
      subtitle: hasOverride ? `${role.id} · 独立任职` : `${role.id} · 继承调律者`,
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
        <div>${icon("crown")}<span><small>当前调律者任职</small><strong>${escapeHtml(managerSummary())}</strong></span></div>
        <div><span>角色</span><strong>群星的调律者</strong></div>
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

function allDecisions() {
  const out = [];
  for (const mission of organizationState?.missions || []) {
    for (const decision of mission.decisions || []) {
      out.push({ mission, decision });
    }
  }
  return out.sort((left, right) => {
    const openRank = (item) => (item.decision.status === "open" ? 0 : 1);
    return openRank(left) - openRank(right)
      || String(right.decision.requestedAt || "").localeCompare(String(left.decision.requestedAt || ""));
  });
}

function decisionCard({ mission, decision }) {
  const open = decision.status === "open";
  return `
    <article class="role-card">
      <div class="role-card-head">
        <span>${open ? "待" : "毕"}</span>
        <div>
          <strong>${escapeHtml(decision.title)}</strong>
          <small>${escapeHtml(decision.id)} · ${escapeHtml(mission.title)} · ${escapeHtml(decision.kind || "")} · 紧迫度 ${escapeHtml(decision.urgency || "normal")}</small>
        </div>
      </div>
      <p>${escapeHtml(decision.facts || "暂无背景事实")}</p>
      ${decision.impacts ? `<p>影响：${escapeHtml(decision.impacts)}</p>` : ""}
      ${(decision.options || []).length ? `<div class="work-item-list">${decision.options.map((option) => `<div class="work-item"><span>${escapeHtml(option)}</span></div>`).join("")}</div>` : ""}
      ${decision.recommendation ? `<p>建议：${escapeHtml(decision.recommendation)}</p>` : ""}
      ${decision.noDecisionConsequence ? `<p>不决策后果：${escapeHtml(decision.noDecisionConsequence)}</p>` : ""}
      ${decision.objectVersion ? `<div class="role-mode">对象版本 ${escapeHtml(decision.objectVersion)}</div>` : ""}
      ${open
        ? `<div class="decision-actions">
            <button type="button" class="button button-primary" data-action="resolve-decision" data-mission-id="${escapeHtml(mission.id)}" data-decision-id="${escapeHtml(decision.id)}" data-resolution="approved" ${requestInFlight ? "disabled" : ""}>批准</button>
            <button type="button" class="button button-secondary" data-action="resolve-decision" data-mission-id="${escapeHtml(mission.id)}" data-decision-id="${escapeHtml(decision.id)}" data-resolution="rejected" ${requestInFlight ? "disabled" : ""}>驳回</button>
            <button type="button" class="button button-secondary" data-action="resolve-decision" data-mission-id="${escapeHtml(mission.id)}" data-decision-id="${escapeHtml(decision.id)}" data-resolution="deferred" ${requestInFlight ? "disabled" : ""}>暂缓</button>
          </div>`
        : `<div class="role-mode">已${decision.status === "approved" ? "批准" : decision.status === "rejected" ? "驳回" : "暂缓"}</div>`}
    </article>`;
}

function renderDecisions() {
  const items = allDecisions();
  const open = items.filter((item) => item.decision.status === "open");
  return `
    <section class="page-section">
      <header class="section-heading">
        <div><span class="section-kicker">真正需要人类处理</span><h2>决策收件箱${open.length ? `（${open.length} 待处理）` : ""}</h2></div>
        <button type="button" class="button button-secondary" data-action="new-decision">${icon("plus")}新建决策事项</button>
      </header>
      ${items.length ? `<div class="role-grid">${items.map(decisionCard).join("")}</div>` : '<div class="table-empty">暂无决策事项，正常工作不需要你审批。</div>'}
    </section>`;
}

function blockerCard(mission, blocker) {
  return `
    <article class="role-card">
      <div class="role-card-head">
        <span>阻</span>
        <div>
          <strong>${escapeHtml(blocker.category || "阻塞")}</strong>
          <small>${escapeHtml(blocker.id)} · ${escapeHtml(mission.title)} · 已用 ${escapeHtml(blocker.attemptsUsed ?? 0)}/${escapeHtml(blocker.attemptBudget ?? 2)} 次恢复</small>
        </div>
      </div>
      <p>${escapeHtml(blocker.error || "等待诊断")}</p>
      <div class="role-mode">责任 ${escapeHtml(blocker.ownerRoleId || "blocker-lead")} · 失败角色 ${escapeHtml(blocker.failedRoleId || "—")}</div>
      <div class="decision-actions">
        <button type="button" class="button button-primary" data-action="retry" data-mission-id="${escapeHtml(mission.id)}" ${requestInFlight ? "disabled" : ""}>${icon("rotate-ccw")}恢复任务</button>
      </div>
    </article>`;
}

function waitingCard(mission, waiting) {
  return `
    <article class="role-card">
      <div class="role-card-head">
        <span>等</span>
        <div>
          <strong>正常等待</strong>
          <small>${escapeHtml(waiting.id)} · ${escapeHtml(mission.title)} · 责任 ${escapeHtml(waiting.responsibleRoleId || "")}</small>
        </div>
      </div>
      <p>${escapeHtml(waiting.reason || "")}</p>
      ${waiting.expectedAt ? `<div class="role-mode">预计 ${escapeHtml(waiting.expectedAt)}</div>` : ""}
      <div class="decision-actions">
        <button type="button" class="button button-secondary" data-action="close-waiting" data-mission-id="${escapeHtml(mission.id)}" data-waiting-id="${escapeHtml(waiting.id)}" ${requestInFlight ? "disabled" : ""}>关闭等待</button>
      </div>
    </article>`;
}

function renderBlockers() {
  const openBlockers = [];
  const openWaiting = [];
  for (const mission of organizationState?.missions || []) {
    for (const blocker of mission.blockers || []) {
      if (blocker.status === "open") openBlockers.push({ mission, blocker });
    }
    for (const waiting of mission.waitingConditions || []) {
      if (waiting.status === "open") openWaiting.push({ mission, waiting });
    }
  }
  return `
    <section class="page-section">
      <header class="section-heading"><div><span class="section-kicker">等待是等待，阻塞是阻塞</span><h2>阻塞与恢复</h2></div><button type="button" class="button button-secondary" data-action="new-waiting">${icon("plus")}记录等待</button></header>
      ${(inspectionState?.findings || []).length ? `<div class="work-item-list"><div class="assignment-list-title"><strong>巡检发现（${inspectionState.findings.length}）</strong><span>停滞、缺证、逾期等待独立于执行持续检查</span></div>${inspectionState.findings.map((finding) => `<div class="work-item"><span><strong>${escapeHtml(finding.kind)}</strong> ${escapeHtml(finding.detail || "")}</span><small>${escapeHtml(finding.missionId || "")} · ${escapeHtml(finding.level || "")}</small></div>`).join("")}</div>` : ""}
      <div class="assignment-list-title"><strong>真实阻塞（${openBlockers.length}）</strong><span>需要换路或升级，不会自动消失</span></div>
      ${openBlockers.length ? `<div class="role-grid">${openBlockers.map(({ mission, blocker }) => blockerCard(mission, blocker)).join("")}</div>` : '<div class="table-empty">无开放阻塞。</div>'}
      <div class="assignment-list-title"><strong>正常等待（${openWaiting.length}）</strong><span>不消耗模型调用，条件满足即关闭</span></div>
      ${openWaiting.length ? `<div class="role-grid">${openWaiting.map(({ mission, waiting }) => waitingCard(mission, waiting)).join("")}</div>` : '<div class="table-empty">无正常等待。</div>'}
    </section>`;
}

function simpleList(title, items, renderItem) {
  return `
    <section class="inspector-section">
      <header><span>${escapeHtml(title)}</span><small>${items.length}</small></header>
      ${items.length ? `<div class="work-item-list">${items.map(renderItem).join("")}</div>` : '<div class="quiet-empty">暂无</div>'}
    </section>`;
}

function renderQuality() {
  const missions = organizationState?.missions || [];
  const gapCases = missions.flatMap((mission) => (mission.gapCases || []).map((gap) => ({ mission, gap })));
  const baselines = missions.flatMap((mission) => (mission.verifiedBaselines || []).map((baseline) => ({ mission, baseline })));
  const reviews = missions.flatMap((mission) => (mission.reviews || []).map((review) => ({ mission, review })));
  const testRuns = missions.flatMap((mission) => (mission.testRuns || []).map((run) => ({ mission, run })));
  const changes = missions.flatMap((mission) => (mission.changeRecords || []).map((record) => ({ mission, record })));
  const overrides = missions.flatMap((mission) => (mission.overrides || []).map((override) => ({ mission, override })));
  const debts = missions.flatMap((mission) => (mission.riskDebts || []).map((debt) => ({ mission, debt })));
  const packages = missions.flatMap((mission) => (mission.externalEvidencePackages || []).map((devicePackage) => ({ mission, devicePackage })));
  const roleActions = (ledgerEvents || []).filter((event) => event.type === "role_action.recorded").slice(-20).reverse();
  const manifests = organizationState?.projectTestManifests || [];
  return `
    <section class="page-section">
      <header class="section-heading">
        <div><span class="section-kicker">证据先于状态 · 三权分离</span><h2>质量与发布</h2></div>
        <div class="section-actions">
          <button type="button" class="button button-secondary" data-action="new-manifest">${icon("plus")}发布测试集</button>
          <button type="button" class="button button-secondary" data-action="new-override">${icon("siren")}紧急绕过</button>
        </div>
      </header>
      <div class="workbench-grid">
        <section class="conversation-column">
          ${simpleList("开放 GapCase", gapCases, ({ mission, gap }) => `<div class="work-item"><span><strong>${escapeHtml(gap.id)}</strong> ${escapeHtml(mission.title)}</span><small>${escapeHtml(gap.status)} · ${escapeHtml(gap.at || "")}</small></div>`)}
          ${simpleList("VerifiedBaseline", baselines, ({ mission, baseline }) => `<div class="work-item"><span><strong>${escapeHtml(baseline.id || "")}</strong> ${escapeHtml(mission.title)}</span><small>候选 ${escapeHtml(baseline.candidateIdentity || "")}</small></div>`)}
          ${simpleList("独立复核", reviews, ({ mission, review }) => `<div class="work-item"><span><strong>${escapeHtml(review.verdict || "")}</strong> ${escapeHtml(mission.title)}</span><small>${escapeHtml(review.at || "")}</small></div>`)}
          ${simpleList("测试运行", testRuns, ({ mission, run }) => `<div class="work-item"><span><strong>${escapeHtml(run.verdict || "")}</strong> ${escapeHtml(mission.title)}</span><small>清单 ${escapeHtml(run.projectTestManifestVersion || "")}</small></div>`)}
          ${simpleList("轻度 ChangeRecord", changes, ({ mission, record }) => `<div class="work-item"><span><strong>${escapeHtml(record.id || "")}</strong> ${escapeHtml(mission.title)}</span><small>留痕复核通过，非全量验证</small></div>`)}
        </section>
        <aside class="mission-inspector">
          ${simpleList("紧急绕过", overrides, ({ mission, override }) => `<div class="work-item"><span><strong>${escapeHtml(override.id)}</strong> ${escapeHtml((override.overriddenGates || []).join("、"))}</span><small>${escapeHtml(override.status)} · 到期 ${escapeHtml(override.expiresAt || "")}</small></div>`)}
          ${simpleList("风险债务", debts, ({ mission, debt }) => `<div class="work-item"><span><strong>${escapeHtml(debt.id)}</strong> ${escapeHtml((debt.description || "").slice(0, 40))}</span><small>${escapeHtml(debt.status)}</small></div>`)}
          ${simpleList("真机执行包", packages, ({ mission, devicePackage }) => `<div class="work-item"><span><strong>${escapeHtml(devicePackage.id)}</strong> ${escapeHtml(devicePackage.buildIdentity || "")}</span><small>${escapeHtml(devicePackage.status)}</small></div>`)}
          ${simpleList("项目测试集", manifests, (manifest) => `<div class="work-item"><span><strong>${escapeHtml(manifest.id)}</strong> v${escapeHtml(manifest.version)}</span><small>${escapeHtml(manifest.projectId)} · ${manifest.deprecated ? "已废弃" : "生效中"} · ${(manifest.requiredTests || []).length} 必跑项</small></div>`)}
          <section class="inspector-section">
            <header><span>动作留痕与撤销</span><small>${roleActions.length}</small></header>
            <div class="work-item-list">${roleActions.map((event) => `<div class="work-item"><span><strong>${escapeHtml(event.payload?.actionId || event.id)}</strong> ${escapeHtml(event.actorRoleId)}</span><span><small>${escapeHtml(event.payload?.backupArchive ? "有备份" : "无备份")}</small> <button type="button" class="button button-secondary" data-action="revert-action" data-action-id="${escapeHtml(event.payload?.actionId || "")}" ${requestInFlight ? "disabled" : ""}>撤销</button></span></div>`).join("") || '<div class="quiet-empty">暂无</div>'}</div>
          </section>
        </aside>
      </div>
    </section>`;
}

function renderCognition() {
  const missions = organizationState?.missions || [];
  const cases = missions.flatMap((mission) => (mission.decisionCases || []).map((decisionCase) => ({ mission, decisionCase })));
  return `
    <section class="page-section">
      <header class="section-heading"><div><span class="section-kicker">发散、审议、决定分离</span><h2>认知与决策</h2></div><button type="button" class="button button-secondary" data-action="new-case">${icon("plus")}开启决策事项</button></header>
      ${cases.length ? cases.map(({ mission, decisionCase }) => `
        <section class="inspector-section">
          <header><span>${escapeHtml(decisionCase.title)}</span><small>${escapeHtml(mission.title)} · Owner ${escapeHtml(decisionCase.ownerRoleId || "")} · ${escapeHtml(decisionCase.status)}</small></header>
          <p>${escapeHtml(decisionCase.context || "")}</p>
          ${(decisionCase.ideaSets || []).map((idea) => `<div class="work-item-list"><div class="assignment-list-title"><strong>IdeaSet</strong><span>${escapeHtml(idea.id)}</span></div>${(idea.clusters || []).map((cluster) => `<div class="work-item"><span>${escapeHtml(cluster)}</span></div>`).join("")}</div>`).join("")}
          ${(decisionCase.briefs || []).map((brief) => `<div class="work-item-list"><div class="assignment-list-title"><strong>DecisionBrief · 建议 ${escapeHtml(brief.recommendation || "")}</strong><span>置信度 ${escapeHtml(brief.confidence || "")}</span></div><div class="work-item"><span>候选：${escapeHtml((brief.candidates || []).join(" / "))}</span></div>${(brief.minorityOpinions || []).map((opinion) => `<div class="work-item"><span>少数意见：${escapeHtml(opinion)}</span></div>`).join("")}</div>`).join("")}
          ${decisionCase.status === "open" ? `<div class="decision-actions">
            <button type="button" class="button button-secondary" data-action="new-idea" data-mission-id="${escapeHtml(mission.id)}" data-case-id="${escapeHtml(decisionCase.id)}">补创意</button>
            <button type="button" class="button button-secondary" data-action="new-brief" data-mission-id="${escapeHtml(mission.id)}" data-case-id="${escapeHtml(decisionCase.id)}">写简报</button>
            <button type="button" class="button button-primary" data-action="decide-case" data-mission-id="${escapeHtml(mission.id)}" data-case-id="${escapeHtml(decisionCase.id)}" data-owner-id="${escapeHtml(decisionCase.ownerRoleId || "")}">正式决定</button>
          </div>` : `<div class="role-mode">已决定：${escapeHtml(decisionCase.decision || "")}</div>`}
        </section>`).join("") : '<div class="table-empty">暂无决策事项，重大或开放性需求会自动建议开启。</div>'}
    </section>`;
}

function renderEvolution() {
  const missions = organizationState?.missions || [];
  const proposals = missions.flatMap((mission) => (mission.evolutionProposals || []).map((proposal) => ({ mission, proposal })));
  return `
    <section class="page-section">
      <header class="section-heading"><div><span class="section-kicker">观察、实验、获批后修改</span><h2>演进实验室</h2></div><button type="button" class="button button-secondary" data-action="new-evolution">${icon("plus")}提交演进提案</button></header>
      ${proposals.length ? `<div class="role-grid">${proposals.map(({ mission, proposal }) => `
        <article class="role-card">
          <div class="role-card-head"><span>进</span><div><strong>${escapeHtml((proposal.problem || "").slice(0, 40))}</strong><small>${escapeHtml(proposal.id)} · ${escapeHtml(mission.title)} · ${escapeHtml(proposal.status)}</small></div></div>
          <p>假设：${escapeHtml(proposal.hypothesis || "")}</p>
          <p>回滚：${escapeHtml(proposal.rollback || "未声明")}</p>
          ${proposal.status === "proposed" ? `<div class="decision-actions">
            <button type="button" class="button button-primary" data-action="decide-evolution" data-mission-id="${escapeHtml(mission.id)}" data-proposal-id="${escapeHtml(proposal.id)}" data-decision="approved">批准</button>
            <button type="button" class="button button-secondary" data-action="decide-evolution" data-mission-id="${escapeHtml(mission.id)}" data-proposal-id="${escapeHtml(proposal.id)}" data-decision="rejected">驳回</button>
          </div>` : ""}
        </article>`).join("")}</div>` : '<div class="table-empty">暂无演进提案。演进负责人在影子模式观察后会提交有证据的提案。</div>'}
    </section>`;
}

function renderKnowledge() {
  const missions = organizationState?.missions || [];
  const skills = missions.flatMap((mission) => (mission.skills || []).map((skill) => ({ mission, skill })));
  const manifests = organizationState?.projectTestManifests || [];
  const snapshots = organizationState?.assignmentSnapshots || [];
  return `
    <section class="page-section">
      <header class="section-heading"><div><span class="section-kicker">结构、来源、技能</span><h2>信息与技能</h2></div><button type="button" class="button button-secondary" data-action="new-skill">${icon("plus")}登记技能候选</button></header>
      <div class="workbench-grid">
        <section class="conversation-column">
          ${simpleList("技能目录", skills, ({ mission, skill }) => `<div class="work-item"><span><strong>${escapeHtml(skill.name || skill.id)}</strong> ${escapeHtml((skill.description || "").slice(0, 60))}</span><span><small>${escapeHtml(skill.status)}</small> ${skill.status === "candidate" ? `<button type="button" class="button button-secondary" data-action="decide-skill" data-mission-id="${escapeHtml(mission.id)}" data-skill-id="${escapeHtml(skill.id)}" data-decision="published">发布</button> <button type="button" class="button button-secondary" data-action="decide-skill" data-mission-id="${escapeHtml(mission.id)}" data-skill-id="${escapeHtml(skill.id)}" data-decision="deprecated">废弃</button>` : ""}</span></div>`)}
          ${simpleList("项目测试集", manifests, (manifest) => `<div class="work-item"><span><strong>${escapeHtml(manifest.id)}</strong> v${escapeHtml(manifest.version)}</span><small>${escapeHtml(manifest.projectId)} · ${manifest.deprecated ? "已废弃" : "生效中"}</small></div>`)}
        </section>
        <aside class="mission-inspector">
          ${simpleList("任职快照", snapshots, (snapshot) => `<div class="work-item"><span><strong>${escapeHtml(snapshot.id || snapshot.payload?.id || "")}</strong></span><small>${escapeHtml(snapshot.at || "")}</small></div>`)}
        </aside>
      </div>
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
      if (subtitle) subtitle.textContent = `${row.dataset.assignmentKey} · ${inherited ? "继承调律者" : "独立任职"}`;
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
      <div class="probe-line"><button type="button" class="button button-secondary" id="probeAgentButton">探测命令</button><small id="probeAgentResult">先探测，再决定是否接入；接入前会自动保存配置回滚点。</small></div>
      <footer class="dialog-actions"><button type="button" class="button button-secondary" data-close-dialog>取消</button><button type="submit" class="button button-primary">${icon("plug")}接入 AGENT</button></footer>
    </form>`;
  detailDialog.showModal();
  detailContent.querySelectorAll("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => detailDialog.close());
  });
  document.getElementById("agentConfigForm")?.addEventListener("submit", submitAgentConfig);
  document.getElementById("probeAgentButton")?.addEventListener("click", probeAgentCommand);
  refreshIcons();
}

async function probeAgentCommand() {
  const form = document.getElementById("agentConfigForm");
  const result = document.getElementById("probeAgentResult");
  const command = form?.command?.value?.trim();
  if (!command) {
    if (result) result.textContent = "请先填写可执行命令。";
    return;
  }
  if (result) result.textContent = "正在探测（只读 --version，不写入任何配置）…";
  try {
    const probe = await api("/api/configuration/adapters/probe", {
      method: "POST",
      body: JSON.stringify({ command }),
    });
    if (result) result.textContent = probe.detected ? `探测到版本：${probe.version}（${probe.durationMs}ms）` : "命令不可用，请检查路径与权限。";
  } catch (error) {
    if (result) result.textContent = `探测失败：${error.message}`;
  }
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
    if (result.agent.rollbackPath) showToast(`配置回滚点：${result.agent.rollbackPath}`);
    await refreshState({ quiet: true });
  } catch (error) {
    showToast(error.message, "danger");
  } finally {
    requestInFlight = false;
    renderCurrentView();
  }
}

function syncEmailProviderFields(form) {
  const custom = form.elements.provider.value === "custom";
  form.querySelectorAll("[data-custom-email]").forEach((field) => {
    field.disabled = !custom;
  });
  form.querySelector("[data-email-custom-fields]")?.classList.toggle("disabled", !custom);
}

function emailConfigurationPayload(form) {
  const values = new FormData(form);
  return {
    enabled: values.get("enabled") === "on",
    provider: values.get("provider"),
    address: values.get("address"),
    ownerAddress: values.get("ownerAddress"),
    username: values.get("username"),
    password: values.get("password"),
    allowedSenders: [values.get("ownerAddress")],
    pollIntervalSeconds: Number(values.get("pollIntervalSeconds")),
    imap: {
      host: form.elements.imapHost.value,
      port: Number(form.elements.imapPort.value),
      secure: form.elements.imapSecure.checked,
    },
    smtp: {
      host: form.elements.smtpHost.value,
      port: Number(form.elements.smtpPort.value),
      secure: form.elements.smtpSecure.checked,
    },
  };
}

async function persistEmailConfiguration(form) {
  const state = await api("/api/channels/email", {
    method: "PUT",
    body: JSON.stringify(emailConfigurationPayload(form)),
  });
  emailState = state;
  return state;
}

async function runEmailAction(form, action) {
  if (emailRequestInFlight) return;
  emailRequestInFlight = true;
  form.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  try {
    await persistEmailConfiguration(form);
    if (action === "test") {
      await api("/api/channels/email/test", { method: "POST" });
      showToast("邮箱收发连接测试通过");
    } else if (action === "poll") {
      await api("/api/channels/email/poll", { method: "POST" });
      showToast("已完成一次邮箱收取与通知发送");
    } else {
      detailDialog.close();
      showToast("邮箱通道配置已保存在本机");
    }
    await refreshState({ quiet: true });
  } catch (error) {
    showToast(error.message, "danger");
  } finally {
    emailRequestInFlight = false;
    form.querySelectorAll("button").forEach((button) => { button.disabled = false; });
  }
}

function openEmailConfigDialog() {
  const state = emailState || {};
  const selected = (value) => state.provider === value ? "selected" : "";
  const checked = (value) => value ? "checked" : "";
  detailContent.innerHTML = `
    <header class="dialog-header"><div><span class="section-kicker">远程命令与决策回流</span><h2>邮箱通道</h2></div><button type="button" class="icon-button" data-close-dialog aria-label="关闭" title="关闭">${icon("x")}</button></header>
    <div class="channel-summary ${state.status === "error" ? "channel-summary-error" : ""}">
      <span>${icon(state.enabled ? "radio" : "circle-off")} ${state.enabled ? "通道已启用" : "通道未启用"}</span>
      <small>${escapeHtml(state.lastError || (state.lastPollAt ? `最近收取 ${formatTime(state.lastPollAt)}` : "尚未连接邮箱"))}</small>
    </div>
    <form class="agent-config-form email-config-form" id="emailConfigForm">
      <label class="check-line channel-enable"><input type="checkbox" name="enabled" ${checked(state.enabled)} /><span>启用邮箱远程命令与决策通知</span></label>
      <div class="form-grid">
        <label class="field-label"><span>邮箱服务商</span><select name="provider"><option value="qq" ${selected("qq")}>QQ 邮箱</option><option value="163" ${selected("163")}>163 邮箱</option><option value="outlook" ${selected("outlook")}>Outlook</option><option value="gmail" ${selected("gmail")}>Gmail</option><option value="custom" ${selected("custom")}>自定义</option></select></label>
        <label class="field-label"><span>轮询间隔（秒）</span><input type="number" name="pollIntervalSeconds" min="15" max="600" value="${escapeHtml(state.pollIntervalSeconds || 30)}" required /></label>
        <label class="field-label"><span>系统邮箱</span><input type="email" name="address" value="${escapeHtml(state.address || "")}" placeholder="agent@example.com" /></label>
        <label class="field-label"><span>你的邮箱</span><input type="email" name="ownerAddress" value="${escapeHtml(state.ownerAddress || "")}" placeholder="owner@example.com" /></label>
        <label class="field-label"><span>登录用户名</span><input type="text" name="username" value="${escapeHtml(state.username || state.address || "")}" placeholder="通常与系统邮箱一致" /></label>
        <label class="field-label"><span>授权码或应用密码</span><input type="password" name="password" placeholder="${state.hasPassword ? "已保存，留空表示不修改" : "仅保存在本机"}" autocomplete="new-password" /></label>
      </div>
      <section class="email-provider-fields" data-email-custom-fields>
        <div class="form-grid">
          <label class="field-label"><span>IMAP 主机</span><input type="text" name="imapHost" data-custom-email value="${escapeHtml(state.imap?.host || "")}" /></label>
          <label class="field-label"><span>IMAP 端口</span><input type="number" name="imapPort" data-custom-email min="1" max="65535" value="${escapeHtml(state.imap?.port || 993)}" /></label>
          <label class="check-line"><input type="checkbox" name="imapSecure" data-custom-email ${checked(state.imap?.secure !== false)} /><span>IMAP TLS</span></label>
          <span></span>
          <label class="field-label"><span>SMTP 主机</span><input type="text" name="smtpHost" data-custom-email value="${escapeHtml(state.smtp?.host || "")}" /></label>
          <label class="field-label"><span>SMTP 端口</span><input type="number" name="smtpPort" data-custom-email min="1" max="65535" value="${escapeHtml(state.smtp?.port || 465)}" /></label>
          <label class="check-line"><input type="checkbox" name="smtpSecure" data-custom-email ${checked(state.smtp?.secure !== false)} /><span>SMTP TLS</span></label>
        </div>
      </section>
      <footer class="dialog-actions email-dialog-actions"><button type="button" class="button button-secondary" data-email-action="poll">${icon("inbox")}立即收取</button><button type="button" class="button button-secondary" data-email-action="test">${icon("plug-zap")}保存并测试</button><button type="submit" class="button button-primary">${icon("save")}保存</button></footer>
    </form>`;
  detailDialog.showModal();
  const form = document.getElementById("emailConfigForm");
  detailContent.querySelector("[data-close-dialog]")?.addEventListener("click", () => detailDialog.close());
  form.elements.provider.addEventListener("change", () => syncEmailProviderFields(form));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    runEmailAction(form, "save");
  });
  form.querySelectorAll("[data-email-action]").forEach((button) => {
    button.addEventListener("click", () => runEmailAction(form, button.dataset.emailAction));
  });
  syncEmailProviderFields(form);
  refreshIcons();
}

function missionOptions(selectedId) {
  return (organizationState?.missions || [])
    .map((mission) => `<option value="${escapeHtml(mission.id)}" ${mission.id === selectedId ? "selected" : ""}>${escapeHtml(mission.title)}（${escapeHtml(mission.status)}）</option>`)
    .join("");
}

function openFormDialog(kicker, title, formId, fieldsHtml, submitLabel) {
  detailContent.innerHTML = `
    <header class="dialog-header"><div><span class="section-kicker">${escapeHtml(kicker)}</span><h2>${escapeHtml(title)}</h2></div><button type="button" class="icon-button" data-close-dialog aria-label="关闭" title="关闭">${icon("x")}</button></header>
    <form class="agent-config-form" id="${formId}">
      <div class="form-grid">${fieldsHtml}</div>
      <footer class="dialog-actions"><button type="button" class="button button-secondary" data-close-dialog>取消</button><button type="submit" class="button button-primary">${escapeHtml(submitLabel)}</button></footer>
    </form>`;
  detailDialog.showModal();
  detailContent.querySelectorAll("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => detailDialog.close());
  });
  refreshIcons();
}

function missionField(selectedId) {
  return `<label class="field-label form-span"><span>Mission</span><select name="missionId">${missionOptions(selectedId)}</select></label>`;
}

function openDecisionCreateDialog(missionId) {
  openFormDialog("决策收件箱", "新建决策事项", "decisionCreateForm", `
    ${missionField(missionId || activeMission()?.id)}
    <label class="field-label form-span"><span>标题</span><input type="text" name="title" required /></label>
    <label class="field-label"><span>类型</span><input type="text" name="kind" value="general" /></label>
    <label class="field-label"><span>紧迫度</span><select name="urgency"><option value="normal">normal</option><option value="low">low</option><option value="high">high</option><option value="critical">critical</option></select></label>
    <label class="field-label form-span"><span>事实</span><textarea name="facts" rows="2"></textarea></label>
    <label class="field-label form-span"><span>影响</span><textarea name="impacts" rows="2"></textarea></label>
    <label class="field-label form-span"><span>选项（每行一个）</span><textarea name="options" rows="2"></textarea></label>
    <label class="field-label form-span"><span>建议</span><input type="text" name="recommendation" /></label>`, "创建决策事项");
  document.getElementById("decisionCreateForm")?.addEventListener("submit", submitDecisionCreate);
}

async function submitDecisionCreate(event) {
  event.preventDefault();
  if (requestInFlight) return;
  const form = new FormData(event.currentTarget);
  requestInFlight = true;
  try {
    await api(`/api/organization/missions/${encodeURIComponent(form.get("missionId"))}/decisions`, {
      method: "POST",
      body: JSON.stringify({
        title: form.get("title"),
        kind: form.get("kind"),
        facts: form.get("facts"),
        impacts: form.get("impacts"),
        options: String(form.get("options") || "").split("\n").map((line) => line.trim()).filter(Boolean),
        recommendation: form.get("recommendation"),
        urgency: form.get("urgency"),
      }),
    });
    detailDialog.close();
    showToast("决策事项已创建");
    await refreshState({ quiet: true });
  } catch (error) {
    showToast(error.message, "danger");
  } finally {
    requestInFlight = false;
    renderCurrentView();
  }
}

async function resolveDecision(missionId, decisionId, resolution) {
  if (requestInFlight) return;
  requestInFlight = true;
  renderCurrentView();
  try {
    await api(`/api/organization/missions/${encodeURIComponent(missionId)}/decisions/${encodeURIComponent(decisionId)}/resolve`, {
      method: "POST",
      body: JSON.stringify({ resolution, decidedBy: "human-owner" }),
    });
    showToast(resolution === "approved" ? "已批准" : resolution === "rejected" ? "已驳回" : "已暂缓");
    await refreshState({ quiet: true });
  } catch (error) {
    showToast(error.message, "danger");
  } finally {
    requestInFlight = false;
    renderCurrentView();
  }
}

function openOverrideDialog(missionId) {
  openFormDialog("三权分离 · 紧急绕过", "授予限时例外", "overrideForm", `
    ${missionField(missionId || activeMission()?.id)}
    <label class="field-label form-span"><span>被绕过的门禁（每行一个）</span><textarea name="gates" rows="2" required></textarea></label>
    <label class="field-label form-span"><span>原因</span><textarea name="reason" rows="2" required></textarea></label>
    <label class="field-label form-span"><span>承担风险</span><textarea name="risk" rows="2" required></textarea></label>
    <label class="field-label"><span>到期时间</span><input type="datetime-local" name="expiresAt" required /></label>
    <label class="field-label"><span>允许动作（逗号分隔）</span><input type="text" name="allowedActions" /></label>
    <label class="field-label form-span"><span>回滚触发器</span><input type="text" name="rollbackTrigger" /></label>`, "授予绕过（自动建风险债务）");
  document.getElementById("overrideForm")?.addEventListener("submit", submitOverride);
}

async function submitOverride(event) {
  event.preventDefault();
  if (requestInFlight) return;
  const form = new FormData(event.currentTarget);
  requestInFlight = true;
  try {
    await api(`/api/organization/missions/${encodeURIComponent(form.get("missionId"))}/override`, {
      method: "POST",
      body: JSON.stringify({
        decidedBy: "human-owner",
        overriddenGates: String(form.get("gates") || "").split("\n").map((line) => line.trim()).filter(Boolean),
        reason: form.get("reason"),
        risk: form.get("risk"),
        expiresAt: form.get("expiresAt") ? new Date(form.get("expiresAt")).toISOString() : "",
        allowedActions: String(form.get("allowedActions") || "").split(/[,，]/).map((line) => line.trim()).filter(Boolean),
        rollbackTrigger: form.get("rollbackTrigger"),
      }),
    });
    detailDialog.close();
    showToast("紧急绕过已记录，失败事实仍保留");
    await refreshState({ quiet: true });
  } catch (error) {
    showToast(error.message, "danger");
  } finally {
    requestInFlight = false;
    renderCurrentView();
  }
}

function openWaitingDialog(missionId) {
  openFormDialog("阻塞与恢复", "记录正常等待", "waitingForm", `
    ${missionField(missionId || activeMission()?.id)}
    <label class="field-label form-span"><span>等待原因</span><textarea name="reason" rows="2" required></textarea></label>
    <label class="field-label"><span>责任角色</span><input type="text" name="responsibleRoleId" value="chief-manager" /></label>
    <label class="field-label"><span>预计时间</span><input type="text" name="expectedAt" placeholder="如 2026-09-04T18:00" /></label>`, "记录等待");
  document.getElementById("waitingForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (requestInFlight) return;
    const form = new FormData(event.currentTarget);
    requestInFlight = true;
    try {
      await api(`/api/organization/missions/${encodeURIComponent(form.get("missionId"))}/record-waiting`, {
        method: "POST",
        body: JSON.stringify({ reason: form.get("reason"), responsibleRoleId: form.get("responsibleRoleId"), expectedAt: form.get("expectedAt") }),
      });
      detailDialog.close();
      showToast("等待条件已记录，不消耗模型调用");
      await refreshState({ quiet: true });
    } catch (error) {
      showToast(error.message, "danger");
    } finally {
      requestInFlight = false;
      renderCurrentView();
    }
  });
}

function openDevicePackageDialog(missionId) {
  openFormDialog("质量与发布", "生成真机执行包", "devicePackageForm", `
    ${missionField(missionId || activeMission()?.id)}
    <label class="field-label"><span>版本号</span><input type="text" name="version" required /></label>
    <label class="field-label"><span>构建身份</span><input type="text" name="buildIdentity" required /></label>
    <label class="field-label form-span"><span>机型（每行一个）</span><textarea name="devices" rows="2"></textarea></label>
    <label class="field-label form-span"><span>前置条件（每行一个）</span><textarea name="preconditions" rows="2"></textarea></label>`, "生成执行包");
  document.getElementById("devicePackageForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (requestInFlight) return;
    const form = new FormData(event.currentTarget);
    requestInFlight = true;
    try {
      await api(`/api/organization/missions/${encodeURIComponent(form.get("missionId"))}/device-package`, {
        method: "POST",
        body: JSON.stringify({
          version: form.get("version"),
          buildIdentity: form.get("buildIdentity"),
          devices: String(form.get("devices") || "").split("\n").map((line) => line.trim()).filter(Boolean),
          preconditions: String(form.get("preconditions") || "").split("\n").map((line) => line.trim()).filter(Boolean),
        }),
      });
      detailDialog.close();
      showToast("真机执行包已生成，请按包执行并回填证据");
      await refreshState({ quiet: true });
    } catch (error) {
      showToast(error.message, "danger");
    } finally {
      requestInFlight = false;
      renderCurrentView();
    }
  });
}

function openDeviceEvidenceDialog(missionId, packageId) {
  const mission = (organizationState?.missions || []).find((item) => item.id === (missionId || activeMission()?.id));
  const devicePackage = mission?.externalEvidencePackages?.find((item) => item.id === packageId)
    || (mission?.externalEvidencePackages || []).find((item) => item.status === "open");
  if (!devicePackage) {
    showToast("没有可回填的真机执行包", "danger");
    return;
  }
  openFormDialog("质量与发布", "回填真机证据", "deviceEvidenceForm", `
    <input type="hidden" name="missionId" value="${escapeHtml(mission.id)}" />
    <input type="hidden" name="packageId" value="${escapeHtml(devicePackage.id)}" />
    <label class="field-label"><span>测试人</span><input type="text" name="tester" required /></label>
    ${(devicePackage.steps || []).map((step) => `
      <label class="field-label"><span>${escapeHtml(step.id)} 通过？</span><select name="result-${escapeHtml(step.id)}"><option value="passed">passed</option><option value="failed">failed</option><option value="blocked">blocked</option></select></label>
      <label class="field-label form-span"><span>${escapeHtml(step.id)} 证据</span><input type="text" name="evidence-${escapeHtml(step.id)}" placeholder="${escapeHtml(step.action || "").slice(0, 60)}" /></label>`).join("")}`, "提交证据核对");
  document.getElementById("deviceEvidenceForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (requestInFlight) return;
    const form = new FormData(event.currentTarget);
    requestInFlight = true;
    try {
      await api(`/api/organization/missions/${encodeURIComponent(form.get("missionId"))}/device-packages/${encodeURIComponent(form.get("packageId"))}/evidence`, {
        method: "POST",
        body: JSON.stringify({
          tester: form.get("tester"),
          results: (devicePackage.steps || []).map((step) => ({
            stepId: step.id,
            result: form.get(`result-${step.id}`),
            evidence: form.get(`evidence-${step.id}`),
          })),
        }),
      });
      detailDialog.close();
      showToast("真机证据已核对回填");
      await refreshState({ quiet: true });
    } catch (error) {
      showToast(error.message, "danger");
    } finally {
      requestInFlight = false;
      renderCurrentView();
    }
  });
}

function openCaseDialog() {
  openFormDialog("认知与决策", "开启决策事项", "caseForm", `
    ${missionField(activeMission()?.id)}
    <label class="field-label form-span"><span>标题</span><input type="text" name="title" required /></label>
    <label class="field-label form-span"><span>背景</span><textarea name="context" rows="2"></textarea></label>
    <label class="field-label"><span>DecisionOwner</span><input type="text" name="ownerRoleId" value="human-owner" required /></label>`, "开启事项");
  document.getElementById("caseForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (requestInFlight) return;
    const form = new FormData(event.currentTarget);
    requestInFlight = true;
    try {
      await api(`/api/organization/missions/${encodeURIComponent(form.get("missionId"))}/cases`, {
        method: "POST",
        body: JSON.stringify({ title: form.get("title"), context: form.get("context"), ownerRoleId: form.get("ownerRoleId") }),
      });
      detailDialog.close();
      showToast("决策事项已开启，最终决定权已明确归属");
      await refreshState({ quiet: true });
    } catch (error) {
      showToast(error.message, "danger");
    } finally {
      requestInFlight = false;
      renderCurrentView();
    }
  });
}

function openIdeaDialog(missionId, caseId) {
  openFormDialog("认知与决策", "补创造者创意", "ideaForm", `
    <input type="hidden" name="missionId" value="${escapeHtml(missionId)}" />
    <input type="hidden" name="caseId" value="${escapeHtml(caseId)}" />
    <label class="field-label form-span"><span>问题重构</span><input type="text" name="problem" /></label>
    <label class="field-label form-span"><span>方案簇（每行一个，至少一个）</span><textarea name="clusters" rows="3" required></textarea></label>
    <label class="field-label form-span"><span>极端方案（每行一个）</span><textarea name="extremeOptions" rows="2"></textarea></label>`, "记录 IdeaSet");
  document.getElementById("ideaForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (requestInFlight) return;
    const form = new FormData(event.currentTarget);
    requestInFlight = true;
    try {
      await api(`/api/organization/missions/${encodeURIComponent(form.get("missionId"))}/cases/${encodeURIComponent(form.get("caseId"))}/idea-sets`, {
        method: "POST",
        body: JSON.stringify({
          decisionCaseId: form.get("caseId"),
          problem: form.get("problem"),
          clusters: String(form.get("clusters") || "").split("\n").map((line) => line.trim()).filter(Boolean),
          extremeOptions: String(form.get("extremeOptions") || "").split("\n").map((line) => line.trim()).filter(Boolean),
        }),
      });
      detailDialog.close();
      showToast("IdeaSet 已记录，不淘汰方案");
      await refreshState({ quiet: true });
    } catch (error) {
      showToast(error.message, "danger");
    } finally {
      requestInFlight = false;
      renderCurrentView();
    }
  });
}

function openBriefDialog(missionId, caseId) {
  openFormDialog("认知与决策", "写抉择简报", "briefForm", `
    <input type="hidden" name="missionId" value="${escapeHtml(missionId)}" />
    <input type="hidden" name="caseId" value="${escapeHtml(caseId)}" />
    <label class="field-label form-span"><span>候选（每行一个，须覆盖全部）</span><textarea name="candidates" rows="2" required></textarea></label>
    <label class="field-label form-span"><span>权衡</span><textarea name="tradeoffs" rows="2"></textarea></label>
    <label class="field-label"><span>推荐方案</span><input type="text" name="recommendation" /></label>
    <label class="field-label form-span"><span>少数意见（每行一个，可空但不可缺）</span><textarea name="minorityOpinions" rows="2"></textarea></label>`, "记录 DecisionBrief");
  document.getElementById("briefForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (requestInFlight) return;
    const form = new FormData(event.currentTarget);
    requestInFlight = true;
    try {
      await api(`/api/organization/missions/${encodeURIComponent(form.get("missionId"))}/cases/${encodeURIComponent(form.get("caseId"))}/briefs`, {
        method: "POST",
        body: JSON.stringify({
          candidates: String(form.get("candidates") || "").split("\n").map((line) => line.trim()).filter(Boolean),
          tradeoffs: form.get("tradeoffs"),
          recommendation: form.get("recommendation"),
          minorityOpinions: String(form.get("minorityOpinions") || "").split("\n").map((line) => line.trim()).filter(Boolean),
        }),
      });
      detailDialog.close();
      showToast("DecisionBrief 已记录，只给建议不做决定");
      await refreshState({ quiet: true });
    } catch (error) {
      showToast(error.message, "danger");
    } finally {
      requestInFlight = false;
      renderCurrentView();
    }
  });
}

async function decideCase(missionId, caseId, ownerId) {
  const decision = window.prompt("请输入正式决定内容（决定权属于 " + ownerId + "）：");
  if (!decision) return;
  if (requestInFlight) return;
  requestInFlight = true;
  renderCurrentView();
  try {
    await api(`/api/organization/missions/${encodeURIComponent(missionId)}/cases/${encodeURIComponent(caseId)}/decide`, {
      method: "POST",
      body: JSON.stringify({ decision, decidedBy: ownerId }),
    });
    showToast("正式决定已记录");
    await refreshState({ quiet: true });
  } catch (error) {
    showToast(error.message, "danger");
  } finally {
    requestInFlight = false;
    renderCurrentView();
  }
}

function openEvolutionDialog() {
  openFormDialog("演进实验室", "提交演进提案", "evolutionForm", `
    ${missionField(activeMission()?.id)}
    <label class="field-label form-span"><span>有证据的问题</span><textarea name="problem" rows="2" required></textarea></label>
    <label class="field-label form-span"><span>可证伪假设</span><textarea name="hypothesis" rows="2" required></textarea></label>
    <label class="field-label form-span"><span>证据</span><textarea name="evidence" rows="2"></textarea></label>
    <label class="field-label form-span"><span>回滚方案</span><textarea name="rollback" rows="2"></textarea></label>`, "提交提案（不自动修改系统）");
  document.getElementById("evolutionForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (requestInFlight) return;
    const form = new FormData(event.currentTarget);
    requestInFlight = true;
    try {
      await api(`/api/organization/missions/${encodeURIComponent(form.get("missionId"))}/evolutions`, {
        method: "POST",
        body: JSON.stringify({ problem: form.get("problem"), hypothesis: form.get("hypothesis"), evidence: form.get("evidence"), rollback: form.get("rollback") }),
      });
      detailDialog.close();
      showToast("演进提案已提交，等待人类裁决");
      await refreshState({ quiet: true });
    } catch (error) {
      showToast(error.message, "danger");
    } finally {
      requestInFlight = false;
      renderCurrentView();
    }
  });
}

function openSkillDialog() {
  openFormDialog("信息与技能", "登记技能候选", "skillForm", `
    ${missionField(activeMission()?.id)}
    <label class="field-label form-span"><span>名称</span><input type="text" name="name" required /></label>
    <label class="field-label form-span"><span>描述</span><textarea name="description" rows="2"></textarea></label>
    <label class="field-label form-span"><span>来源</span><input type="text" name="source" /></label>`, "登记候选");
  document.getElementById("skillForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (requestInFlight) return;
    const form = new FormData(event.currentTarget);
    requestInFlight = true;
    try {
      await api(`/api/organization/missions/${encodeURIComponent(form.get("missionId"))}/skills`, {
        method: "POST",
        body: JSON.stringify({ name: form.get("name"), description: form.get("description"), source: form.get("source") }),
      });
      detailDialog.close();
      showToast("技能候选已登记，发布前只是候选");
      await refreshState({ quiet: true });
    } catch (error) {
      showToast(error.message, "danger");
    } finally {
      requestInFlight = false;
      renderCurrentView();
    }
  });
}

function openManifestDialog() {
  openFormDialog("质量与发布", "发布项目测试集", "manifestForm", `
    <label class="field-label"><span>项目 ID</span><input type="text" name="projectId" value="${escapeHtml(organizationState?.project?.id || "")}" required /></label>
    <label class="field-label"><span>版本</span><input type="text" name="version" placeholder="2026.09-mvp.2" required /></label>
    <label class="field-label form-span"><span>必跑项 JSON 数组（id/name/command/environment）</span><textarea name="requiredTests" rows="4" spellcheck="false">[{"id":"t1","name":"冒烟","command":"run","environment":"冻结候选"}]</textarea></label>`, "发布测试集版本");
  document.getElementById("manifestForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (requestInFlight) return;
    const form = new FormData(event.currentTarget);
    let requiredTests;
    try {
      requiredTests = JSON.parse(form.get("requiredTests") || "[]");
    } catch (error) {
      showToast("必跑项 JSON 无效", "danger");
      return;
    }
    requestInFlight = true;
    try {
      await api("/api/test-manifests", {
        method: "POST",
        body: JSON.stringify({ projectId: form.get("projectId"), version: form.get("version"), requiredTests }),
      });
      detailDialog.close();
      showToast("测试集新版本已发布，重度模式将执行它");
      await refreshState({ quiet: true });
    } catch (error) {
      showToast(error.message, "danger");
    } finally {
      requestInFlight = false;
      renderCurrentView();
    }
  });
}

function openQualityDialog() {
  const mission = activeMission();
  if (!mission) return;
  openFormDialog("质量与发布", "签署质量判定", "qualityForm", `
    <input type="hidden" name="missionId" value="${escapeHtml(mission.id)}" />
    <label class="field-label"><span>结论</span><select name="verdict"><option value="passed">passed</option><option value="blocked">blocked</option></select></label>
    <label class="field-label form-span"><span>依据（复核与测试证据摘要）</span><textarea name="basis" rows="3"></textarea></label>`, "签署判定（不补写下级证据）");
  document.getElementById("qualityForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (requestInFlight) return;
    const form = new FormData(event.currentTarget);
    requestInFlight = true;
    try {
      await api(`/api/organization/missions/${encodeURIComponent(form.get("missionId"))}/quality-decision`, {
        method: "POST",
        body: JSON.stringify({ verdict: form.get("verdict"), basis: form.get("basis"), decidedBy: "human-owner" }),
      });
      detailDialog.close();
      showToast("质量判定已签署");
      await refreshState({ quiet: true });
    } catch (error) {
      showToast(error.message, "danger");
    } finally {
      requestInFlight = false;
      renderCurrentView();
    }
  });
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
      decisions: renderDecisions,
      blockers: renderBlockers,
      quality: renderQuality,
      cognition: renderCognition,
      evolution: renderEvolution,
      knowledge: renderKnowledge,
      organization: renderOrganization,
      ledger: renderLedger,
      resources: renderResources,
    };
    mainContent.innerHTML = renderers[activeView]();
  }
  bindDynamicEvents();
  renderTunerDock();
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
    const [state, health, ledger, configuration, email, governance, inspections] = await Promise.all([
      api("/api/organization/state"),
      api("/api/health"),
      api("/api/organization/events"),
      api("/api/configuration"),
      api("/api/channels/email"),
      api("/api/governance/status"),
      api("/api/organization/inspections"),
    ]);
    organizationState = state;
    healthState = health;
    ledgerEvents = ledger.events || [];
    inspectionState = inspections;
    configurationState = configuration;
    emailState = email;
    governanceState = governance;
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

async function submitTunerCommand(event) {
  event.preventDefault();
  if (tunerInFlight) return;
  const content = tunerInput.value.trim();
  if (!content) return;
  tunerInFlight = true;
  renderTunerDock();
  try {
    const payload = await api("/api/organization/commands", {
      method: "POST",
      body: JSON.stringify({
        content,
        channel: "tuner-chat",
        context: "global",
      }),
    });
    if (payload.mission?.id) selectedMissionId = payload.mission.id;
    tunerInput.value = "";
    await refreshState({ quiet: true });
  } catch (error) {
    showToast(error.message, "danger");
    await refreshState({ quiet: true });
  } finally {
    tunerInFlight = false;
    renderCurrentView();
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
      confirm_baseline: "需求基线已确认，群星的调律者开始组织规划",
      retry_blocked: "已启动有限恢复",
      start_heavy_review: "重度全量回顾已启动",
      auto_heavy_review: "自动重度回顾评估已执行",
      pause_requested: "安全暂停请求已下达",
      emergency_stopped: "已紧急停止",
      mission_cancelled: "Mission 已取消",
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

async function missionAction(action, dataset = {}) {
  const missions = organizationState?.missions || [];
  const mission = (dataset.missionId && missions.find((item) => item.id === dataset.missionId)) || activeMission();
  if (!mission || requestInFlight) return;
  requestInFlight = true;
  renderCurrentView();
  try {
    if (action === "pause") {
      await api(`/api/organization/missions/${encodeURIComponent(mission.id)}/pause`, { method: "POST" });
      showToast("安全暂停请求已下达，正在保存现场");
    } else if (action === "emergency-stop") {
      if (!window.confirm("紧急停止将终止本次物理调用且不可恢复，继续吗？")) {
        requestInFlight = false;
        renderCurrentView();
        return;
      }
      await api(`/api/organization/missions/${encodeURIComponent(mission.id)}/emergency-stop`, { method: "POST", body: JSON.stringify({}) });
      showToast("已紧急停止，现场保留，等待人类决定下一步");
    } else if (action === "cancel") {
      if (!window.confirm(`取消 Mission「${mission.title}」吗？取消后不可恢复执行。`)) {
        requestInFlight = false;
        renderCurrentView();
        return;
      }
      await api(`/api/organization/missions/${encodeURIComponent(mission.id)}/cancel`, { method: "POST", body: JSON.stringify({}) });
      showToast("Mission 已取消");
    } else if (action === "resume") {
      await api(`/api/organization/missions/${encodeURIComponent(mission.id)}/resume`, { method: "POST" });
      showToast("已从最近检查点继续运行");
    } else if (action === "confirm-baseline") {
      await api(`/api/organization/missions/${encodeURIComponent(mission.id)}/confirm-baseline`, { method: "POST" });
      showToast("需求基线已确认，群星的调律者开始组织规划");
    } else if (action === "retry") {
      await api(`/api/organization/missions/${encodeURIComponent(mission.id)}/retry`, { method: "POST" });
      showToast("已在恢复预算内重新任职");
    } else if (action === "start-heavy-review") {
      await api(`/api/organization/missions/${encodeURIComponent(mission.id)}/start-heavy-review`, { method: "POST" });
      showToast("重度全量回顾已启动");
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
    } else if (action === "resolve-decision") {
      await api(`/api/organization/missions/${encodeURIComponent(mission.id)}/decisions/${encodeURIComponent(dataset.decisionId)}/resolve`, {
        method: "POST",
        body: JSON.stringify({ resolution: dataset.resolution, decidedBy: "human-owner" }),
      });
      showToast(dataset.resolution === "approved" ? "已批准" : dataset.resolution === "rejected" ? "已驳回" : "已暂缓");
    } else if (action === "close-waiting") {
      await api(`/api/organization/missions/${encodeURIComponent(mission.id)}/waiting/${encodeURIComponent(dataset.waitingId)}/close`, { method: "POST", body: JSON.stringify({}) });
      showToast("等待条件已关闭");
    } else if (action === "decide-evolution") {
      await api(`/api/organization/missions/${encodeURIComponent(mission.id)}/evolutions/${encodeURIComponent(dataset.proposalId)}/decide`, {
        method: "POST",
        body: JSON.stringify({ decision: dataset.decision, decidedBy: "human-owner" }),
      });
      showToast(dataset.decision === "approved" ? "演进提案已批准（批准不等于已应用）" : "演进提案已驳回");
    } else if (action === "decide-skill") {
      await api(`/api/organization/missions/${encodeURIComponent(mission.id)}/skills/${encodeURIComponent(dataset.skillId)}/decide`, {
        method: "POST",
        body: JSON.stringify({ decision: dataset.decision, decidedBy: "human-owner" }),
      });
      showToast(dataset.decision === "published" ? "技能已发布" : "技能已废弃");
    } else if (action === "revert-action") {
      const reason = window.prompt("请输入撤销原因（撤销将按备份恢复文件）：");
      if (!reason) {
        requestInFlight = false;
        renderCurrentView();
        return;
      }
      await api(`/api/governance/actions/${encodeURIComponent(dataset.actionId)}/revert`, {
        method: "POST",
        body: JSON.stringify({ reason, confirmedBy: "human-owner" }),
      });
      showToast("已按修改前备份撤销");
    }
    await refreshState({ quiet: true });
  } catch (error) {
    showToast(error.message, "danger");
  } finally {
    requestInFlight = false;
    renderCurrentView();
  }
}

async function setWorkflowProfile(profile) {
  const mission = activeMission();
  if (!mission || requestInFlight) return;
  requestInFlight = true;
  renderCurrentView();
  try {
    await api(`/api/organization/missions/${encodeURIComponent(mission.id)}/workflow-profile`, {
      method: "POST",
      body: JSON.stringify({ profile }),
    });
    showToast(`工作模式已设为${{ auto: "自动", light: "轻度", heavy: "重度" }[profile] || profile}`);
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
      else if (["request-baseline-change", "request-revision"].includes(action)) document.getElementById("commandInput")?.focus();
      else if (action === "refresh") refreshState();
      else if (action === "save-assignments") saveAssignments();
      else if (action === "new-agent") openAgentConfigDialog();
      else if (action === "new-decision") openDecisionCreateDialog(button.dataset.missionId);
      else if (action === "new-override") openOverrideDialog(button.dataset.missionId);
      else if (action === "new-waiting") openWaitingDialog(button.dataset.missionId);
      else if (action === "new-manifest") openManifestDialog();
      else if (action === "new-case") openCaseDialog();
      else if (action === "new-idea") openIdeaDialog(button.dataset.missionId, button.dataset.caseId);
      else if (action === "new-brief") openBriefDialog(button.dataset.missionId, button.dataset.caseId);
      else if (action === "decide-case") decideCase(button.dataset.missionId, button.dataset.caseId, button.dataset.ownerId);
      else if (action === "new-evolution") openEvolutionDialog();
      else if (action === "new-skill") openSkillDialog();
      else if (action === "device-package") openDevicePackageDialog(button.dataset.missionId);
      else if (action === "device-evidence") openDeviceEvidenceDialog(button.dataset.missionId, button.dataset.packageId);
      else if (action === "quality-decision") openQualityDialog();
      else missionAction(action, button.dataset);
    });
  });
  mainContent.querySelectorAll("[data-workflow-profile]").forEach((button) => {
    button.addEventListener("click", () => setWorkflowProfile(button.dataset.workflowProfile));
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

function tunerIsOpen() {
  return tunerLayoutQuery.matches
    ? tunerDock.classList.contains("open")
    : !appShell.classList.contains("tuner-collapsed");
}

function setTunerOpen(open) {
  const mobile = tunerLayoutQuery.matches;
  if (mobile) {
    tunerDock.classList.toggle("open", open);
    tunerBackdrop.classList.toggle("visible", open);
  } else {
    appShell.classList.toggle("tuner-collapsed", !open);
  }
  document.getElementById("tunerToggleButton").setAttribute("aria-expanded", String(open));
}

function handleViewportChange() {
  tunerDock.classList.remove("open");
  tunerBackdrop.classList.remove("visible");
  appShell.classList.remove("tuner-collapsed");
  document.getElementById("tunerToggleButton").setAttribute(
    "aria-expanded",
    String(!tunerLayoutQuery.matches),
  );
}

document.getElementById("mobileMenuButton").addEventListener("click", openMobileNav);
document.getElementById("mobileBackdrop").addEventListener("click", closeMobileNav);
document.getElementById("refreshButton").addEventListener("pointerdown", captureEditorFocus);
document.getElementById("refreshButton").addEventListener("click", () => refreshState());
document.getElementById("tunerToggleButton").addEventListener("click", () => setTunerOpen(!tunerIsOpen()));
document.getElementById("tunerCloseButton").addEventListener("click", () => setTunerOpen(false));
document.getElementById("emailSettingsButton").addEventListener("click", openEmailConfigDialog);
document.getElementById("tunerForm").addEventListener("submit", submitTunerCommand);
document.getElementById("tunerBackdrop").addEventListener("click", () => setTunerOpen(false));
tunerLayoutQuery.addEventListener("change", handleViewportChange);
detailDialog.addEventListener("click", (event) => {
  if (event.target === detailDialog) detailDialog.close();
});

handleViewportChange();
refreshState();
pollTimer = setInterval(() => {
  const hasActiveRun = Boolean(organizationState?.activeRunIds?.length);
  const emailEnabled = emailState?.enabled === true;
  if ((hasActiveRun || emailEnabled) && !requestInFlight && !tunerInFlight && !emailRequestInFlight) {
    refreshState({ quiet: true });
  }
}, 3500);

window.addEventListener("beforeunload", () => clearInterval(pollTimer));

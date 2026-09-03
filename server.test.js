const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

const { JsonlLedger } = require("./organization-core");

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "black-coast-server-"));
}

function allocatePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const port = listener.address().port;
      listener.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function startServer({ ledgerPath, worktree, manager, roles, adapters }) {
  const port = await allocatePort();
  const configPath = path.join(path.dirname(ledgerPath), "black-shores.config.json");
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({
      project: {
        id: "project-server-test",
        name: "Server Test Project",
        path: worktree,
        repository: "example/server-test",
        sourceRef: "origin/main",
      },
      manager: manager || { adapter: "auto", model: "", reasoningEffort: "" },
      roles: roles || {},
      ledger: { path: ledgerPath },
      testManifest: { id: "ptm-server-test", version: "1", requiredTests: [] },
      adapters: adapters || {
        codex: { enabled: false },
        cursor: { enabled: false },
        zcode: { enabled: false },
        grok: { enabled: false },
        custom: [],
      },
    }, null, 2)}\n`,
    "utf8",
  );
  const child = spawn(process.execPath, ["server.js"], {
    cwd: __dirname,
    windowsHide: true,
    env: {
      ...process.env,
      BLACK_SHORES_PORT: String(port),
      BLACK_SHORES_CONFIG: configPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`服务启动超时：${output}`)), 15_000);
    function inspect(chunk) {
      output += chunk.toString();
      if (output.includes(`http://127.0.0.1:${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    }
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`服务提前退出 (${code})：${output}`));
    });
  });
  return { child, origin: `http://127.0.0.1:${port}`, configPath };
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

test("HTTP surface serves the workbench and rejects invalid mission input", async (context) => {
  const directory = tempDirectory();
  const server = await startServer({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    worktree: directory,
  });
  context.after(() => stopServer(server.child));

  const healthResponse = await fetch(`${server.origin}/api/health`);
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.service, "black-shores-agent");
  assert.equal(health.organization.managerAdapter, "auto");
  assert.equal(health.organization.executionReady, false);
  assert.equal(health.configuration.configured, true);

  const governance = await (await fetch(`${server.origin}/api/governance/status`)).json();
  assert.equal(governance.controllerName, "群星的调律者");
  assert.equal(governance.required, true);
  const email = await (await fetch(`${server.origin}/api/channels/email`)).json();
  assert.equal(email.enabled, false);
  assert.equal(Object.hasOwn(email, "password"), false);

  const pageResponse = await fetch(`${server.origin}/`);
  assert.equal(pageResponse.status, 200);
  assert.match(await pageResponse.text(), /黑海岸 AGENT 系统/);
  const cssResponse = await fetch(`${server.origin}/black-coast.css`);
  assert.equal(cssResponse.status, 200);
  assert.match(await cssResponse.text(), /\.workbench-grid/);

  const invalidResponse = await fetch(`${server.origin}/api/organization/missions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goal: "短" }),
  });
  assert.equal(invalidResponse.status, 400);
  assert.match((await invalidResponse.json()).error, /明确的结果目标/);
  const commandResponse = await fetch(`${server.origin}/api/organization/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "查看当前任务状态" }),
  });
  assert.equal(commandResponse.status, 202);
  assert.equal((await commandResponse.json()).action, "query_status");
  const globalCommandResponse = await fetch(`${server.origin}/api/organization/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "查看当前任务状态", channel: "tuner-chat", context: "global" }),
  });
  assert.equal(globalCommandResponse.status, 202);
  const globalCommand = await globalCommandResponse.json();
  assert.equal(globalCommand.action, "query_organization_status");
  assert.equal(globalCommand.mission, null);
  const serverSource = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  assert.doesNotMatch(serverSource, /组织 Run 超过.*分钟/);
  assert.doesNotMatch(serverSource, /timeoutMs\s*=\s*45\s*\*/);
  assert.equal((await fetch(`${server.origin}/missing`)).status, 404);
});

test("a process restart rebuilds the same mission from the local ledger", async (context) => {
  const directory = tempDirectory();
  const ledgerPath = path.join(directory, "ledger.jsonl");
  const ledger = new JsonlLedger(ledgerPath);
  ledger.append("mission.created", {
    missionId: "mission-persisted",
    payload: { title: "持久任务", goal: "验证服务重启后的任务恢复" },
  });
  ledger.append("mission.status_changed", {
    missionId: "mission-persisted",
    payload: { from: "intake", to: "clarifying", reason: "等待输入" },
  });

  const first = await startServer({ ledgerPath, worktree: directory });
  const firstState = await (await fetch(`${first.origin}/api/organization/state`)).json();
  await stopServer(first.child);

  const second = await startServer({ ledgerPath, worktree: directory });
  context.after(() => stopServer(second.child));
  const secondState = await (await fetch(`${second.origin}/api/organization/state`)).json();
  assert.deepEqual(secondState.missions, firstState.missions);
  assert.equal(secondState.missions[0].id, "mission-persisted");
  assert.equal(secondState.missions[0].status, "clarifying");
  assert.equal(secondState.ledger.eventCount, 2);
});

test("a custom command adapter can run an unrestricted vendor model", async (context) => {
  const directory = tempDirectory();
  const ledgerPath = path.join(directory, "ledger.jsonl");
  const mockAgent = path.join(directory, "mock-agent.js");
  fs.writeFileSync(
    mockAgent,
    `process.stdin.resume();
process.stdin.on("end", () => console.log(JSON.stringify({
  readyForBaseline: false,
  message: "需要补充验收环境。",
  knownFacts: [],
  unknowns: ["验收环境"],
  questions: [{ id: "environment", question: "在哪个环境验收？", why: "确定证据来源" }],
  baseline: null
})));
`,
    "utf8",
  );
  const server = await startServer({
    ledgerPath,
    worktree: directory,
    manager: { adapter: "vendor-agent", model: "vendor/model-x", reasoningEffort: "high" },
    adapters: {
      codex: { enabled: false },
      cursor: { enabled: false },
      zcode: { enabled: false },
      grok: { enabled: false },
      custom: [{
        id: "vendor-agent",
        label: "Vendor AGENT",
        enabled: true,
        command: process.execPath,
        args: [mockAgent],
        promptMode: "stdin",
        outputFormat: "text",
        model: "vendor/model-x",
        models: ["vendor/model-x"],
        reasoningEffort: "high",
        reasoningOptions: ["high"],
      }],
    },
  });
  context.after(() => stopServer(server.child));

  const response = await fetch(`${server.origin}/api/organization/missions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goal: "调查登录后页面加载失败的原因", workflowProfile: "light" }),
  });
  assert.equal(response.status, 202);
  const missionId = (await response.json()).mission.id;

  let mission;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const state = await (await fetch(`${server.origin}/api/organization/state`)).json();
    mission = state.missions.find((item) => item.id === missionId);
    if (mission?.runs?.[0]?.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(mission.runs[0].adapterId, "vendor-agent");
  assert.equal(mission.runs[0].model, "vendor/model-x");
  assert.match(mission.messages.at(-1).content, /验收环境/);

  const directResponse = await fetch(`${server.origin}/api/agents/vendor-agent/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "直接检查当前项目", cwd: directory }),
  });
  assert.equal(directResponse.status, 200);
  assert.match(await directResponse.text(), /hub.exit/);
  const governance = await (await fetch(`${server.origin}/api/governance/status`)).json();
  assert.equal(governance.backup.archiveCount, 1);
  const directTrace = governance.actionTrace.files.find((file) => file.endsWith("direct-agent.jsonl"));
  assert.ok(directTrace);
  const directRecord = JSON.parse(fs.readFileSync(directTrace, "utf8").trim());
  assert.equal(directRecord.actionObject.roleId, "direct-agent");
  assert.equal(directRecord.actionResult.status, "completed");
});

test("an active organization Run can be safely paused through HTTP", async (context) => {
  const directory = tempDirectory();
  const ledgerPath = path.join(directory, "ledger.jsonl");
  const mockAgent = path.join(directory, "waiting-agent.js");
  fs.writeFileSync(
    mockAgent,
    "process.stdin.resume(); setInterval(() => {}, 1000);\n",
    "utf8",
  );
  const server = await startServer({
    ledgerPath,
    worktree: directory,
    manager: { adapter: "waiting-agent", model: "local/wait", reasoningEffort: "high" },
    adapters: {
      codex: { enabled: false },
      cursor: { enabled: false },
      zcode: { enabled: false },
      grok: { enabled: false },
      custom: [{
        id: "waiting-agent",
        label: "Waiting AGENT",
        enabled: true,
        command: process.execPath,
        args: [mockAgent],
        promptMode: "stdin",
        outputFormat: "text",
        model: "local/wait",
        models: ["local/wait"],
        reasoningEffort: "high",
        reasoningOptions: ["high"],
      }],
    },
  });
  context.after(() => stopServer(server.child));

  const createdResponse = await fetch(`${server.origin}/api/organization/missions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goal: "验证服务能够保存现场并安全暂停活动任务", workflowProfile: "light" }),
  });
  assert.equal(createdResponse.status, 202);
  const missionId = (await createdResponse.json()).mission.id;

  let state;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    state = await (await fetch(`${server.origin}/api/organization/state`)).json();
    if (state.activeRuns.some((run) => run.missionId === missionId)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(state.activeRuns.some((run) => run.missionId === missionId), true);

  const pauseResponse = await fetch(`${server.origin}/api/organization/missions/${encodeURIComponent(missionId)}/pause`, {
    method: "POST",
  });
  assert.equal(pauseResponse.status, 202);
  assert.equal((await pauseResponse.json()).pauseRequested, true);

  let mission;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    state = await (await fetch(`${server.origin}/api/organization/state`)).json();
    mission = state.missions.find((item) => item.id === missionId);
    if (mission?.status === "waiting" && state.activeRuns.length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(mission.status, "waiting");
  assert.equal(mission.runs[0].status, "paused");
  assert.equal(mission.runs[0].invocations[0].status, "interrupted");
  assert.equal(mission.blockers.length, 0);
});

test("the workbench exposes every human-facing Mission control", () => {
  const source = fs.readFileSync(path.join(__dirname, "black-coast-app.js"), "utf8");
  const controls = [
    'data-action="pause"',
    'data-action="resume"',
    'data-action="retry"',
    'data-action="request-revision"',
    'data-action="start-heavy-review"',
    'data-action="confirm-baseline"',
    'data-action="verify-source"',
    'data-action="approve-merge"',
    'data-action="approve-deployment"',
    'data-action="accept-result"',
    "data-workflow-profile",
    "externalEvidenceForm",
  ];
  controls.forEach((control) => assert.ok(source.includes(control), `前端缺少人工动作入口：${control}`));
  assert.match(source, /missionActionAvailable\(mission, "pause"\)/);
  assert.match(source, /organizationState\?\.controls\?\.canCreateMission/);
});

test("the Windows command launcher never owns the long-running Node process", () => {
  const commandLauncher = fs.readFileSync(path.join(__dirname, "start-black-shores-agent.cmd"), "utf8");
  const backgroundLauncher = fs.readFileSync(path.join(__dirname, "launch-black-shores-agent.ps1"), "utf8");
  const installer = fs.readFileSync(path.join(__dirname, "install-windows-autostart.ps1"), "utf8");
  assert.doesNotMatch(commandLauncher, /\bnode(?:\.exe)?\s+server\.js\b/i);
  assert.match(commandLauncher, /launch-black-shores-agent\.ps1/i);
  assert.match(backgroundLauncher, /Start-ScheduledTask/);
  assert.match(backgroundLauncher, /Start-Process/);
  assert.match(backgroundLauncher, /WindowStyle Hidden/);
  assert.match(installer, /watchdogTrigger/);
  assert.match(installer, /RepetitionInterval/);
});

test("configuration API persists manager and per-role assignments and registers a new AGENT", async (context) => {
  const directory = tempDirectory();
  const server = await startServer({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    worktree: directory,
    manager: { adapter: "vendor-agent", model: "vendor/model-x", reasoningEffort: "high" },
    adapters: {
      codex: { enabled: false },
      cursor: { enabled: false },
      zcode: { enabled: false },
      grok: { enabled: false },
      custom: [{
        id: "vendor-agent",
        label: "Vendor AGENT",
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume()"],
        promptMode: "stdin",
        outputFormat: "text",
        model: "vendor/model-x",
        models: ["vendor/model-x"],
        reasoningEffort: "high",
        reasoningOptions: ["high"],
      }],
    },
  });
  context.after(() => stopServer(server.child));

  const initial = await (await fetch(`${server.origin}/api/configuration`)).json();
  assert.equal(initial.manager.adapter, "vendor-agent");
  assert.deepEqual(initial.roles, {});

  const invalidResponse = await fetch(`${server.origin}/api/configuration/assignments`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      manager: { adapter: "vendor-agent", model: "vendor/model-x", reasoningEffort: "low" },
      roles: {},
    }),
  });
  assert.equal(invalidResponse.status, 400);
  assert.match((await invalidResponse.json()).error, /不支持推理强度 low/);

  const saveResponse = await fetch(`${server.origin}/api/configuration/assignments`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      manager: { adapter: "vendor-agent", model: "vendor/model-x", reasoningEffort: "high" },
      roles: {
        engineering: { adapter: "vendor-agent", model: "vendor/model-x", reasoningEffort: "high" },
        tester: { inherit: true },
      },
    }),
  });
  assert.equal(saveResponse.status, 200);
  const saved = await saveResponse.json();
  assert.deepEqual(Object.keys(saved.roles), ["engineering"]);
  assert.equal(saved.appliesTo, "next-physical-invocation");

  const state = await (await fetch(`${server.origin}/api/organization/state`)).json();
  assert.equal(state.roleAssignments.engineering.adapterId, "vendor-agent");
  assert.equal(state.roleAssignments.engineering.inherited, false);
  assert.equal(state.roleAssignments.tester.adapterId, "vendor-agent");
  assert.equal(state.roleAssignments.tester.inherited, true);
  const persisted = JSON.parse(fs.readFileSync(server.configPath, "utf8"));
  assert.equal(persisted.roles.engineering.model, "vendor/model-x");
  assert.equal(persisted.roles.tester, undefined);

  const addResponse = await fetch(`${server.origin}/api/configuration/adapters`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "second-vendor",
      label: "Second Vendor",
      command: process.execPath,
      args: ["-e", "process.stdin.resume()"],
      promptMode: "stdin",
      outputFormat: "text",
      model: "second/model-y",
      reasoningEffort: "medium",
      skipVersionCheck: true,
    }),
  });
  assert.equal(addResponse.status, 201);
  const added = await addResponse.json();
  assert.equal(added.agent.connected, true);
  assert.equal(added.agent.model, "second/model-y");
  const health = await (await fetch(`${server.origin}/api/health`)).json();
  assert.equal(health.agents["second-vendor"].connected, true);
  const updatedConfig = JSON.parse(fs.readFileSync(server.configPath, "utf8"));
  assert.ok(updatedConfig.adapters.custom.some((adapter) => adapter.id === "second-vendor"));
});

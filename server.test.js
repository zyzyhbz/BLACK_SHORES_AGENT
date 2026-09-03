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

async function startServer({ ledgerPath, worktree, manager, adapters }) {
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
  return { child, origin: `http://127.0.0.1:${port}` };
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
});

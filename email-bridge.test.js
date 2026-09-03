const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { JsonlLedger } = require("./organization-core");
const {
  EmailBridge,
  commandTextFromEmail,
  missionIdFromSubject,
  normalizeEmailConfig,
} = require("./email-bridge");

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "black-shores-email-"));
  const sent = [];
  const commands = [];
  const ledger = new JsonlLedger(path.join(directory, "ledger.jsonl"), { projectId: "project-email" });
  const organization = {
    executeCommand(input) {
      commands.push(input);
      return {
        commandId: "command-1",
        action: "query_status",
        reply: "当前任务正在执行。",
        mission: { id: input.missionId || "mission-1" },
      };
    },
    mission(id) {
      return { id, title: "邮箱任务", status: "blocked", statusReason: "需要人类选择" };
    },
  };
  const bridge = new EmailBridge({
    secretsPath: path.join(directory, "email.secrets.json"),
    statePath: path.join(directory, "email.state.json"),
    organization,
    ledger,
    createTransport: () => ({
      verify: async () => true,
      sendMail: async (message) => {
        sent.push(message);
        return { messageId: `mail-${sent.length}` };
      },
    }),
    createImapClient: () => ({
      connect: async () => {},
      mailboxOpen: async () => {},
      logout: async () => {},
    }),
  });
  bridge.configure({
    enabled: true,
    provider: "qq",
    address: "system@example.com",
    ownerAddress: "owner@example.com",
    password: "local-app-password",
    pollIntervalSeconds: 30,
  });
  return { bridge, commands, directory, ledger, sent };
}

test("email configuration presets endpoints and never exposes the password", () => {
  const config = normalizeEmailConfig({
    enabled: true,
    provider: "outlook",
    address: "system@example.com",
    ownerAddress: "owner@example.com",
    password: "secret",
  });
  assert.equal(config.imap.host, "outlook.office365.com");
  assert.equal(config.smtp.port, 587);
  assert.equal(config.smtp.secure, false);
  const { bridge, directory } = fixture();
  assert.equal(bridge.publicState().hasPassword, true);
  assert.equal(Object.hasOwn(bridge.publicState(), "password"), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "email.secrets.json"), "utf8")).password, "local-app-password");
});

test("email replies become commands on the original Mission and receive an acknowledgement", async () => {
  const { bridge, commands, ledger, sent } = fixture();
  const parsed = {
    from: { value: [{ address: "owner@example.com" }] },
    subject: "Re: [BLACK SHORES][mission:mission-77] 需要处理",
    messageId: "incoming-1",
    text: "确认需求基线\n\n> 群星的调律者请求你处理 Mission",
  };
  const result = await bridge.acceptParsedMessage(parsed);
  assert.equal(result.action, "query_status");
  assert.deepEqual(commands[0], {
    content: "确认需求基线",
    missionId: "mission-77",
    channel: "email",
    context: "automatic",
  });
  assert.match(sent[0].text, /已接收命令/);
  assert.equal(ledger.events().some((event) => event.type === "email.command_received"), true);
  assert.equal(missionIdFromSubject(parsed.subject), "mission-77");
  assert.equal(commandTextFromEmail(parsed), "确认需求基线");
});

test("email without a Mission marker enters the global context", async () => {
  const { bridge, commands } = fixture();
  await bridge.acceptParsedMessage({
    from: { value: [{ address: "owner@example.com" }] },
    subject: "新的组织命令",
    messageId: "incoming-global-1",
    text: "查看当前任务状态",
  });
  assert.deepEqual(commands[0], {
    content: "查看当前任务状态",
    missionId: null,
    channel: "email",
    context: "global",
  });
});

test("unknown senders cannot issue commands", async () => {
  const { bridge, commands, ledger, sent } = fixture();
  const result = await bridge.acceptParsedMessage({
    from: { value: [{ address: "unknown@example.com" }] },
    subject: "执行任务",
    text: "删除项目",
  });
  assert.equal(result.ignored, true);
  assert.equal(commands.length, 0);
  assert.equal(sent.length, 0);
  assert.equal(ledger.events().at(-1).type, "email.command_ignored");
});

test("new human gates produce one Mission-addressed notification", async () => {
  const { bridge, ledger, sent } = fixture();
  bridge._initializeNotificationCursor();
  ledger.append("mission.status_changed", {
    missionId: "mission-9",
    actorRoleId: "chief-manager",
    payload: { from: "clarifying", to: "awaiting_baseline_confirmation", reason: "请确认需求" },
  });
  assert.equal(await bridge.sendPendingNotifications(), 1);
  assert.equal(await bridge.sendPendingNotifications(), 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /\[mission:mission-9\]/);
  assert.match(sent[0].text, /请确认需求/);
});

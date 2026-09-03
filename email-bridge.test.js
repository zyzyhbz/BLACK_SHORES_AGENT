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

test("system-sent notifications are skipped instead of becoming commands", async () => {
  const { bridge, commands, ledger, sent } = fixture();
  bridge._rememberSentMessageId("own-notification-1");
  const result = await bridge.acceptParsedMessage({
    from: { value: [{ address: "owner@example.com" }] },
    subject: "[BLACK SHORES][mission:mission-77] 需要处理",
    messageId: "own-notification-1",
    text: "群星的调律者请求你处理 Mission。",
  });
  assert.equal(result.ignored, true);
  assert.equal(commands.length, 0);
  assert.equal(sent.length, 0);
  assert.equal(ledger.events().at(-1).type, "email.command_ignored");
  assert.equal(ledger.events().at(-1).payload.reason, "self_notification");
});

test("a hanging IMAP logout cannot wedge future polls", async () => {
  const { bridge } = fixture();
  bridge.logoutTimeoutMs = 50;
  bridge.createImapClient = () => ({
    connect: async () => {},
    mailboxOpen: async () => {},
    search: async () => [],
    logout: () => new Promise(() => {}),
  });
  const state = await bridge.poll();
  assert.equal(state.status, "connected");
  assert.equal(bridge.inFlight, false);
});

test("a stalled IMAP search fails one poll but leaves the next poll usable", async () => {
  const { bridge, ledger } = fixture();
  bridge.imapOpTimeoutMs = 50;
  let calls = 0;
  bridge.createImapClient = () => ({
    connect: async () => {},
    mailboxOpen: async () => {},
    search: async () => {
      calls += 1;
      if (calls === 1) return new Promise(() => {});
      return [];
    },
    logout: async () => {},
  });
  await assert.rejects(() => bridge.poll(), /检索新邮件/);
  assert.equal(bridge.inFlight, false);
  assert.equal(ledger.events().at(-1).type, "email.channel_error");
  const state = await bridge.poll();
  assert.equal(state.status, "connected");
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

test("open decisions are delivered with options instead of generic handling", async () => {
  const { bridge, ledger, sent } = fixture();
  bridge._initializeNotificationCursor();
  ledger.append("decision.requested", {
    missionId: "mission-9",
    actorRoleId: "chief-manager",
    payload: { id: "dec-1", title: "是否扩大范围", kind: "scope", options: ["保持", "扩大"], urgency: "high", objectVersion: "RB-v1" },
  });
  assert.equal(await bridge.sendPendingNotifications(), 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /需要决策/);
  assert.match(sent[0].text, /是否扩大范围/);
});

test("owner notifications are sent and their self-copies are skipped on receipt", async () => {
  const { bridge, commands, ledger, sent } = fixture();
  const { messageId, subject } = await bridge.notifyOwner("待决策：验证回路", "请回复“查询状态”验证本回路。");
  assert.match(subject, /\[BLACK SHORES\]/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "owner@example.com");
  const result = await bridge.acceptParsedMessage({
    from: { value: [{ address: "owner@example.com" }] },
    subject: `Re: ${subject}`,
    messageId,
    text: "请回复“查询状态”验证本回路。",
  });
  assert.equal(result.ignored, true);
  assert.equal(commands.length, 0);
  assert.equal(ledger.events().at(-1).payload.reason, "self_notification");
});

test("rewritten server message-ids still match by content fingerprint", async () => {
  const { bridge, commands, ledger, sent } = fixture();
  const { subject } = await bridge.notifyOwner("探针", "探针正文：验证指纹跳过。");
  const result = await bridge.acceptParsedMessage({
    from: { value: [{ address: "owner@example.com" }] },
    subject,
    messageId: "tencent_rewritten_server_id",
    text: "探针正文：验证指纹跳过。\n\n——直接回复本邮件即可下达命令（仅 owner@example.com 的回复会被执行）。",
  });
  assert.equal(result.ignored, true);
  assert.equal(commands.length, 0);
  assert.equal(sent.length, 1);
  assert.equal(ledger.events().at(-1).payload.reason, "self_notification");
});

test("dev-thread mails are never executed by the organization poll", async () => {
  const { bridge, commands, ledger, sent } = fixture();
  const result = await bridge.acceptParsedMessage({
    from: { value: [{ address: "owner@example.com" }] },
    subject: "回复：[BLACK SHORES-DEV] 身份分离",
    messageId: "user-dev-reply-1",
    text: "确认：先做决策收件箱",
  });
  assert.equal(result.ignored, true);
  assert.equal(commands.length, 0);
  assert.equal(sent.length, 0);
  const ignored = ledger.events().filter((event) => event.type === "email.command_ignored").at(-1);
  assert.equal(ignored.payload.reason, "dev_thread");
});

test("dev replies are queued for the development session", async () => {
  const { bridge, commands, directory, ledger } = fixture();
  await bridge.acceptParsedMessage({
    from: { value: [{ address: "owner@example.com" }] },
    subject: "回复：[BLACK SHORES-DEV] 待决策",
    messageId: "user-dev-reply-2",
    inReplyTo: "dev-original-1",
    text: "选 B，先清理探针 Mission",
  });
  assert.equal(commands.length, 0);
  const queuePath = path.join(directory, "dev-inbox.jsonl");
  const lines = fs.readFileSync(queuePath, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.channel, "dev-email");
  assert.equal(record.messageId, "user-dev-reply-2");
  assert.match(record.text, /选 B/);
  assert.equal(ledger.events().at(-1).type, "email.dev_queued");
});

test("dev self-copies without a reply prefix are not queued", async () => {
  const { bridge, directory } = fixture();
  await bridge.acceptParsedMessage({
    from: { value: [{ address: "owner@example.com" }] },
    subject: "[BLACK SHORES-DEV] 待决策",
    messageId: "dev-self-copy-1",
    text: "待决策正文",
  });
  assert.equal(fs.existsSync(path.join(directory, "dev-inbox.jsonl")), false);
});

test("already-delivered mails are skipped exactly once", async () => {
  const { bridge, commands } = fixture();
  const parsed = {
    from: { value: [{ address: "owner@example.com" }] },
    subject: "查看当前任务状态",
    messageId: "dup-1",
    text: "查看当前任务状态",
  };
  await bridge.acceptParsedMessage(parsed);
  assert.equal(commands.length, 1);
  bridge._rememberReceivedId("dup-1");
  const result = await bridge.acceptParsedMessage(parsed);
  assert.equal(result.ignored, true);
  assert.equal(commands.length, 1);
});

test("poll follows the UID cursor so already-read replies are not lost", async () => {
  const { bridge, commands } = fixture();
  bridge.notificationState.imapUidValidity = 99;
  bridge.notificationState.imapLastUid = 6;
  bridge.createImapClient = () => ({
    connect: async () => {},
    mailboxOpen: async () => ({ uidValidity: 99 }),
    search: async () => [7],
    fetch: async function* () {
      yield { uid: 7, source: "raw-seen-reply" };
    },
    logout: async () => {},
  });
  bridge.parseMail = async () => ({
    from: { value: [{ address: "owner@example.com" }] },
    subject: "查看当前任务状态",
    messageId: "poll-msg-1",
    text: "查看当前任务状态",
  });
  const state = await bridge.poll();
  assert.equal(state.status, "connected");
  assert.equal(commands.length, 1);
  assert.equal(commands[0].channel, "email");
  assert.equal(bridge.notificationState.imapLastUid, 7);
});

test("poll without a cursor only records its position instead of replaying the backlog", async () => {
  const { bridge, commands } = fixture();
  let fetched = false;
  bridge.createImapClient = () => ({
    connect: async () => {},
    mailboxOpen: async () => ({ uidValidity: 5 }),
    search: async () => [1, 2, 3],
    fetch: async function* () {
      fetched = true;
      yield { uid: 3, source: "raw" };
    },
    logout: async () => {},
  });
  const state = await bridge.poll();
  assert.equal(state.status, "connected");
  assert.equal(fetched, false);
  assert.equal(commands.length, 0);
  assert.equal(bridge.notificationState.imapUidValidity, 5);
  assert.equal(bridge.notificationState.imapLastUid, 3);
});

test("bigint mailbox values never break cursor persistence", async () => {
  const { bridge, commands, directory } = fixture();
  bridge.notificationState.imapUidValidity = 99;
  bridge.notificationState.imapLastUid = 6;
  bridge.createImapClient = () => ({
    connect: async () => {},
    mailboxOpen: async () => ({ uidValidity: 99n }),
    search: async () => [7n],
    fetch: async function* () {
      yield { uid: 7n, source: "raw-bigint" };
    },
    logout: async () => {},
  });
  bridge.parseMail = async () => ({
    from: { value: [{ address: "owner@example.com" }] },
    subject: "查看当前任务状态",
    messageId: "poll-bigint-1",
    text: "查看当前任务状态",
  });
  const state = await bridge.poll();
  assert.equal(state.status, "connected");
  assert.equal(commands.length, 1);
  const persisted = JSON.parse(fs.readFileSync(path.join(directory, "email.state.json"), "utf8"));
  assert.equal(persisted.imapUidValidity, 99);
  assert.equal(persisted.imapLastUid, 7);
});

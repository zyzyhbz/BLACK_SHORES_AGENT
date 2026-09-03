const fs = require("node:fs");
const path = require("node:path");
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const nodemailer = require("nodemailer");

const PROVIDERS = {
  qq: {
    imap: { host: "imap.qq.com", port: 993, secure: true },
    smtp: { host: "smtp.qq.com", port: 465, secure: true },
  },
  "163": {
    imap: { host: "imap.163.com", port: 993, secure: true },
    smtp: { host: "smtp.163.com", port: 465, secure: true },
  },
  outlook: {
    imap: { host: "outlook.office365.com", port: 993, secure: true },
    smtp: { host: "smtp.office365.com", port: 587, secure: false },
  },
  gmail: {
    imap: { host: "imap.gmail.com", port: 993, secure: true },
    smtp: { host: "smtp.gmail.com", port: 465, secure: true },
  },
};

function cleanText(value, maxLength = 12_000) {
  return typeof value === "string" ? value.replace(/\0/g, "").trim().slice(0, maxLength) : "";
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function normalizePort(value, fallback) {
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

function normalizeEmailConfig(input = {}, existing = {}) {
  const enabled = input.enabled === true;
  const provider = ["qq", "163", "outlook", "gmail", "custom"].includes(input.provider)
    ? input.provider
    : existing.provider || "qq";
  const preset = PROVIDERS[provider] || null;
  const address = cleanText(input.address || existing.address, 320).toLowerCase();
  const ownerAddress = cleanText(input.ownerAddress || existing.ownerAddress, 320).toLowerCase();
  const username = cleanText(input.username || existing.username || address, 320);
  const password = cleanText(input.password || existing.password, 2000);
  if (enabled && (!validEmail(address) || !validEmail(ownerAddress))) {
    throw Object.assign(new Error("启用邮箱通道需要有效的系统邮箱和人类邮箱"), { statusCode: 400 });
  }
  if (enabled && !password) {
    throw Object.assign(new Error("启用邮箱通道需要授权码或应用密码"), { statusCode: 400 });
  }
  const allowedSenders = [
    ...new Set(
      (Array.isArray(input.allowedSenders) ? input.allowedSenders : [ownerAddress])
        .map((item) => cleanText(item, 320).toLowerCase())
        .filter(validEmail),
    ),
  ];
  if (enabled && !allowedSenders.length) allowedSenders.push(ownerAddress);
  const imap = preset || input.imap || existing.imap || {};
  const smtp = preset || input.smtp || existing.smtp || {};
  return {
    enabled,
    provider,
    address,
    ownerAddress,
    username,
    password,
    allowedSenders,
    pollIntervalSeconds: Math.max(15, Math.min(600, normalizePort(input.pollIntervalSeconds, existing.pollIntervalSeconds || 30))),
    imap: {
      host: cleanText(preset?.imap.host || imap.host, 500),
      port: normalizePort(preset?.imap.port || imap.port, 993),
      secure: preset ? preset.imap.secure : imap.secure !== false,
    },
    smtp: {
      host: cleanText(preset?.smtp.host || smtp.host, 500),
      port: normalizePort(preset?.smtp.port || smtp.port, 465),
      secure: preset ? preset.smtp.secure : smtp.secure !== false,
    },
  };
}

function commandTextFromEmail(parsed) {
  const source = cleanText(parsed?.text || parsed?.html || "", 20_000);
  return source
    .split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    .split(/\n(?:On .+ wrote:|发件人[:：]|From:)/i)[0]
    .trim()
    .slice(0, 12_000);
}

function missionIdFromSubject(subject) {
  return cleanText(subject, 1000).match(/\[mission:([^\]]+)\]/i)?.[1] || null;
}

class EmailBridge {
  constructor({
    secretsPath,
    statePath,
    organization,
    ledger,
    createImapClient = (options) => new ImapFlow(options),
    createTransport = (options) => nodemailer.createTransport(options),
    parseMail = simpleParser,
  }) {
    this.secretsPath = path.resolve(secretsPath);
    this.statePath = path.resolve(statePath);
    this.organization = organization;
    this.ledger = ledger;
    this.createImapClient = createImapClient;
    this.createTransport = createTransport;
    this.parseMail = parseMail;
    this.config = this._loadJson(this.secretsPath, {});
    this.notificationState = this._loadJson(this.statePath, { initialized: false, eventIds: [] });
    this.timer = null;
    this.started = false;
    this.inFlight = false;
    this.runtime = {
      status: this.config.enabled ? "idle" : "disabled",
      lastPollAt: null,
      lastReceivedAt: null,
      lastSentAt: null,
      lastError: null,
    };
  }

  publicState() {
    return {
      enabled: this.config.enabled === true,
      configured: Boolean(this.config.address && this.config.ownerAddress && this.config.password),
      provider: this.config.provider || "qq",
      address: this.config.address || "",
      ownerAddress: this.config.ownerAddress || "",
      username: this.config.username || "",
      hasPassword: Boolean(this.config.password),
      allowedSenders: [...(this.config.allowedSenders || [])],
      pollIntervalSeconds: this.config.pollIntervalSeconds || 30,
      imap: {
        host: this.config.imap?.host || "",
        port: this.config.imap?.port || 993,
        secure: this.config.imap?.secure !== false,
      },
      smtp: {
        host: this.config.smtp?.host || "",
        port: this.config.smtp?.port || 465,
        secure: this.config.smtp?.secure !== false,
      },
      ...this.runtime,
    };
  }

  configure(input) {
    this.config = normalizeEmailConfig(input, this.config);
    this._writeJson(this.secretsPath, this.config);
    this.runtime.status = this.config.enabled ? "idle" : "disabled";
    this.runtime.lastError = null;
    if (this.started) this._reschedule();
    this.ledger.append("email.channel_configured", {
      actorRoleId: "human-owner",
      payload: {
        enabled: this.config.enabled,
        provider: this.config.provider,
        address: this.config.address,
        ownerAddress: this.config.ownerAddress,
        pollIntervalSeconds: this.config.pollIntervalSeconds,
      },
    });
    return this.publicState();
  }

  start() {
    this.started = true;
    this._initializeNotificationCursor();
    this._reschedule();
  }

  stop() {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll() {
    if (!this.config.enabled || this.inFlight) return this.publicState();
    this.inFlight = true;
    this.runtime.status = "polling";
    this.runtime.lastPollAt = new Date().toISOString();
    let client;
    try {
      client = this.createImapClient(this._imapOptions());
      await client.connect();
      await client.mailboxOpen("INBOX");
      const unseen = await client.search({ seen: false }, { uid: true });
      if (unseen.length) {
        for await (const message of client.fetch(unseen, { uid: true, source: true }, { uid: true })) {
          try {
            const parsed = await this.parseMail(message.source);
            await this.acceptParsedMessage(parsed);
          } finally {
            await client.messageFlagsAdd(message.uid, ["\\Seen"], { uid: true });
          }
        }
      }
      await this.sendPendingNotifications();
      this.runtime.status = "connected";
      this.runtime.lastError = null;
    } catch (error) {
      this.runtime.status = "error";
      this.runtime.lastError = cleanText(error.message || String(error), 2000);
      this.ledger.append("email.channel_error", {
        actorRoleId: "channel-email",
        payload: { stage: "poll", error: this.runtime.lastError },
      });
      throw error;
    } finally {
      this.inFlight = false;
      if (client) await client.logout().catch(() => {});
    }
    return this.publicState();
  }

  async acceptParsedMessage(parsed) {
    const sender = cleanText(parsed?.from?.value?.[0]?.address, 320).toLowerCase();
    const subject = cleanText(parsed?.subject, 1000);
    const messageId = cleanText(parsed?.messageId, 1000);
    if (!this.config.allowedSenders.includes(sender)) {
      this.ledger.append("email.command_ignored", {
        actorRoleId: "channel-email",
        payload: { sender, subject, messageId, reason: "sender_not_allowed" },
      });
      return { ignored: true };
    }
    const content = commandTextFromEmail(parsed);
    if (!content) {
      this.ledger.append("email.command_ignored", {
        actorRoleId: "channel-email",
        payload: { sender, subject, messageId, reason: "empty_command" },
      });
      return { ignored: true };
    }
    const missionId = missionIdFromSubject(subject);
    try {
      const result = this.organization.executeCommand({
        content,
        missionId,
        channel: "email",
        context: missionId ? "automatic" : "global",
      });
      this.runtime.lastReceivedAt = new Date().toISOString();
      this.ledger.append("email.command_received", {
        missionId: result.mission?.id || missionId,
        actorRoleId: "channel-email",
        causationId: result.commandId,
        payload: { sender, subject, messageId, commandId: result.commandId, action: result.action },
      });
      await this._send({
        to: sender,
        subject: this._replySubject(subject, result.mission?.id || missionId),
        text: `群星的调律者已接收命令。\n\n${result.reply}`,
      });
      return result;
    } catch (error) {
      await this._send({
        to: sender,
        subject: this._replySubject(subject, missionId),
        text: `群星的调律者未能执行该命令。\n\n${cleanText(error.message || String(error), 4000)}`,
      });
      throw error;
    }
  }

  async sendPendingNotifications() {
    const known = new Set(this.notificationState.eventIds || []);
    const events = this.ledger.events();
    const pending = events.filter((event) => !known.has(event.id) && this._requiresHuman(event));
    for (const event of pending) {
      const mission = event.missionId ? this.organization.mission(event.missionId) : null;
      const reason = event.type === "blocker.opened"
        ? event.payload.error || "Mission 已阻塞"
        : event.payload.reason || mission?.statusReason || "需要人类处理";
      await this._send({
        to: this.config.ownerAddress,
        subject: `[BLACK SHORES][mission:${event.missionId}] 需要处理`,
        text: `群星的调律者请求你处理 Mission。\n\n任务：${mission?.title || event.missionId}\n状态：${mission?.status || event.type}\n原因：${reason}\n\n直接回复本邮件即可继续下达命令。`,
      });
      known.add(event.id);
    }
    for (const event of events) known.add(event.id);
    this.notificationState = { initialized: true, eventIds: [...known].slice(-2000) };
    this._writeJson(this.statePath, this.notificationState);
    return pending.length;
  }

  async testConnection() {
    if (!this.config.enabled) throw Object.assign(new Error("请先启用并保存邮箱通道"), { statusCode: 409 });
    const client = this.createImapClient(this._imapOptions());
    try {
      await client.connect();
      await client.mailboxOpen("INBOX");
    } finally {
      await client.logout().catch(() => {});
    }
    const transport = this.createTransport(this._smtpOptions());
    await transport.verify();
    await this._send({
      to: this.config.ownerAddress,
      subject: "[BLACK SHORES] 邮箱通道测试",
      text: "群星的调律者邮箱通道已连接。你可以回复带有 [mission:Mission-ID] 的通知邮件，或发送新邮件远程下达命令。",
    });
    this.runtime.status = "connected";
    this.runtime.lastError = null;
    return this.publicState();
  }

  _requiresHuman(event) {
    if (event.type === "blocker.opened") return true;
    return event.type === "mission.status_changed" && new Set([
      "awaiting_baseline_confirmation",
      "awaiting_release_approval",
      "awaiting_external_evidence",
      "awaiting_result_acceptance",
    ]).has(event.payload.to);
  }

  _initializeNotificationCursor() {
    if (this.notificationState.initialized) return;
    this.notificationState = {
      initialized: true,
      eventIds: this.ledger.events().map((event) => event.id).slice(-2000),
    };
    this._writeJson(this.statePath, this.notificationState);
  }

  _reschedule() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.started || !this.config.enabled) return;
    this.timer = setInterval(() => this.poll().catch(() => {}), this.config.pollIntervalSeconds * 1000);
    this.timer.unref?.();
    setImmediate(() => this.poll().catch(() => {}));
  }

  _imapOptions() {
    return {
      host: this.config.imap.host,
      port: this.config.imap.port,
      secure: this.config.imap.secure,
      auth: { user: this.config.username, pass: this.config.password },
      logger: false,
    };
  }

  _smtpOptions() {
    return {
      host: this.config.smtp.host,
      port: this.config.smtp.port,
      secure: this.config.smtp.secure,
      auth: { user: this.config.username, pass: this.config.password },
    };
  }

  async _send({ to, subject, text }) {
    const transport = this.createTransport(this._smtpOptions());
    const info = await transport.sendMail({
      from: `"群星的调律者" <${this.config.address}>`,
      to,
      subject,
      text,
    });
    this.runtime.lastSentAt = new Date().toISOString();
    this.ledger.append("email.notification_sent", {
      actorRoleId: "channel-email",
      payload: { to, subject, messageId: cleanText(info?.messageId, 1000) },
    });
    return info;
  }

  _replySubject(subject, missionId) {
    const base = subject || "BLACK SHORES 命令";
    const token = missionId && !base.includes("[mission:") ? `[mission:${missionId}] ` : "";
    return `${/^re:/i.test(base) ? "" : "Re: "}${token}${base}`;
  }

  _loadJson(filePath, fallback) {
    if (!fs.existsSync(filePath)) return fallback;
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      throw new Error(`邮箱通道本地文件损坏：${filePath}（${error.message}）`);
    }
  }

  _writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

module.exports = {
  EmailBridge,
  PROVIDERS,
  commandTextFromEmail,
  missionIdFromSubject,
  normalizeEmailConfig,
};

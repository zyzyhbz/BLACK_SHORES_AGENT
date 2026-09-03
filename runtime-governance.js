const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const archiver = require("archiver");

function loadRuntimePolicy(policyPath) {
  const resolved = path.resolve(policyPath);
  const policy = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (!policy?.version || policy?.actionTrace?.required !== true) {
    throw new Error(`运行时策略无效：${resolved}`);
  }
  const required = new Set(policy.actionTrace.requiredFields || []);
  for (const field of [
    "actionModel",
    "actionTime",
    "actionObject",
    "actionScope",
    "actionGoal",
    "actionResult",
  ]) {
    if (!required.has(field)) throw new Error(`运行时策略缺少强制字段：${field}`);
  }
  return { ...policy, path: resolved };
}

function safeSegment(value, fallback = "action") {
  const normalized = String(value || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  return normalized.replace(/^-+|-+$/g, "").slice(0, 80) || fallback;
}

function summarize(value, maxLength = 6000) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return String(text || "").replace(/\0/g, "").slice(0, maxLength);
}

function gitSnapshot(workingDirectory) {
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: workingDirectory,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  const status = spawnSync("git", ["status", "--short", "--untracked-files=all"], {
    cwd: workingDirectory,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  return {
    head: head.status === 0 ? String(head.stdout).trim() : null,
    status: status.status === 0 ? String(status.stdout).trim().split(/\r?\n/).filter(Boolean) : [],
  };
}

class RuntimeGovernance {
  constructor({ policyPath, project, ledger, backupDirectory, traceDirectory }) {
    this.policy = loadRuntimePolicy(policyPath);
    this.project = project;
    this.ledger = ledger;
    const policyDirectory = path.dirname(this.policy.path);
    this.backupDirectory = path.resolve(
      backupDirectory || path.resolve(policyDirectory, this.policy.backup.directory),
    );
    this.traceDirectory = path.resolve(
      traceDirectory || path.resolve(policyDirectory, this.policy.actionTrace.directory),
    );
    fs.mkdirSync(this.backupDirectory, { recursive: true });
    fs.mkdirSync(this.traceDirectory, { recursive: true });
  }

  async begin(input) {
    const startedAt = new Date().toISOString();
    const action = {
      id: `action-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      startedAt,
      roleId: input.roleId,
      roleName: input.roleName,
      missionId: input.missionId || null,
      runId: input.runId || null,
      invocationId: input.invocationId || null,
      adapterId: input.adapterId,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      goal: summarize(input.goal, 12_000),
      scope: Array.isArray(input.scope) ? input.scope.map((item) => summarize(item, 1000)) : [],
      workingDirectory: path.resolve(input.workingDirectory || this.project.workingDirectory),
      before: null,
      backupArchive: null,
    };
    action.before = gitSnapshot(action.workingDirectory);
    const needsBackup = this.policy.backup.roles.includes(action.roleId);
    try {
      if (needsBackup) action.backupArchive = await this._createBackup(action);
      this.ledger.append("action.safeguard_started", {
        missionId: action.missionId,
        actorRoleId: action.roleId,
        payload: {
          actionId: action.id,
          runId: action.runId,
          invocationId: action.invocationId,
          backupArchive: action.backupArchive,
          policyVersion: this.policy.version,
        },
      });
      return action;
    } catch (error) {
      const record = this._record(action, {
        status: "backup_failed",
        error: error.message || String(error),
      });
      this.ledger.append("action.safeguard_failed", {
        missionId: action.missionId,
        actorRoleId: action.roleId,
        payload: { actionId: action.id, tracePath: record.tracePath, error: record.actionResult.error },
      });
      throw new Error(`修改前备份失败，已阻止模型开始行动：${error.message || String(error)}`);
    }
  }

  complete(action, outcome = {}) {
    const record = this._record(action, outcome);
    this.ledger.append("role_action.recorded", {
      missionId: action.missionId,
      actorRoleId: action.roleId,
      payload: {
        actionId: action.id,
        runId: action.runId,
        invocationId: action.invocationId,
        status: record.actionResult.status,
        tracePath: record.tracePath,
        backupArchive: action.backupArchive,
        changedPaths: record.actionScope.detectedChanges,
        policyVersion: this.policy.version,
      },
    });
    return record;
  }

  revertAction(actionId, input = {}) {
    const decidedBy = typeof input.confirmedBy === "string" ? input.confirmedBy : "";
    if (decidedBy !== "human-owner") {
      throw Object.assign(new Error("撤销改动必须由人类负责人另行确认"), { statusCode: 403 });
    }
    const reason = typeof input.reason === "string" ? input.reason.trim() : "";
    if (reason.length < 4) throw Object.assign(new Error("撤销改动需要说明原因"), { statusCode: 400 });
    const actionIdText = String(actionId || "").trim();
    const recorded = this.ledger.events().find(
      (event) => event.type === "role_action.recorded" && event.payload?.actionId === actionIdText,
    );
    if (!recorded) throw Object.assign(new Error("找不到指定的角色动作留痕"), { statusCode: 404 });
    if (this.ledger.events().some((event) => event.type === "action.reverted" && event.payload?.actionId === actionIdText)) {
      throw Object.assign(new Error("该动作已经撤销过，不能重复撤销"), { statusCode: 409 });
    }
    const archive = recorded.payload?.backupArchive;
    if (!archive || !fs.existsSync(archive)) {
      throw Object.assign(new Error("没有修改前备份，不能安全撤销"), { statusCode: 409 });
    }
    const workingDirectory = path.resolve(recorded.payload?.workingDirectory || this._traceWorkingDirectory(recorded) || this.project.workingDirectory);
    const explicit = Array.isArray(input.paths) ? input.paths.map((item) => String(item || "").trim()).filter(Boolean) : [];
    const detected = this._traceChangedPaths(recorded);
    const targets = [...new Set([...explicit, ...detected])].slice(0, 200);
    if (!targets.length) throw Object.assign(new Error("无法确定变更范围，请明确列出要恢复的文件"), { statusCode: 400 });
    const extractDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "black-shores-revert-"));
    this._expandArchive(archive, extractDirectory);
    const restored = [];
    const deleted = [];
    for (const relative of targets) {
      if (relative.includes("..") || path.isAbsolute(relative)) continue;
      const source = path.join(extractDirectory, relative);
      const destination = path.join(workingDirectory, relative);
      if (fs.existsSync(source) && fs.statSync(source).isFile()) {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(source, destination);
        restored.push(relative);
      } else if (fs.existsSync(destination) && fs.statSync(destination).isFile()) {
        fs.rmSync(destination);
        deleted.push(relative);
      }
    }
    fs.rmSync(extractDirectory, { recursive: true, force: true });
    this.ledger.append("action.reverted", {
      missionId: recorded.missionId,
      actorRoleId: "human-owner",
      payload: { actionId: actionIdText, restored, deleted, backupArchive: archive, reason },
    });
    return { actionId: actionIdText, restored, deleted };
  }

  status() {
    const backupFiles = this._files(this.backupDirectory, ".zip");
    const traceFiles = this._files(this.traceDirectory, ".jsonl");
    return {
      policyVersion: this.policy.version,
      controllerName: this.policy.controller.displayName,
      required: true,
      backup: {
        directory: this.backupDirectory,
        roles: [...this.policy.backup.roles],
        archiveCount: backupFiles.length,
        latestArchive: backupFiles.at(-1) || null,
      },
      actionTrace: {
        directory: this.traceDirectory,
        roleLogCount: traceFiles.length,
        files: traceFiles,
      },
    };
  }

  _record(action, outcome) {
    const completedAt = new Date().toISOString();
    const after = gitSnapshot(action.workingDirectory);
    const detectedChanges = [...new Set([...action.before.status, ...after.status])];
    const record = {
      schemaVersion: "1.0.0",
      actionId: action.id,
      actionModel: {
        adapterId: action.adapterId,
        model: action.model,
        reasoningEffort: action.reasoningEffort,
      },
      actionTime: {
        startedAt: action.startedAt,
        completedAt,
        durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(action.startedAt)),
      },
      actionObject: {
        projectId: this.project.id,
        missionId: action.missionId,
        runId: action.runId,
        invocationId: action.invocationId,
        roleId: action.roleId,
        roleName: action.roleName,
        workingDirectory: action.workingDirectory,
      },
      actionScope: {
        declared: action.scope,
        beforeHead: action.before.head,
        afterHead: after.head,
        detectedChanges,
      },
      actionGoal: action.goal,
      actionResult: {
        status: outcome.status || "completed",
        summary: summarize(outcome.summary, 6000),
        error: summarize(outcome.error, 6000),
        backupArchive: action.backupArchive,
      },
    };
    const tracePath = path.join(this.traceDirectory, `${safeSegment(action.roleId, "unknown-role")}.jsonl`);
    fs.appendFileSync(tracePath, `${JSON.stringify(record)}\n`, "utf8");
    record.tracePath = tracePath;
    return record;
  }

  _traceRecord(tracePath, actionId) {
    try {
      const content = fs.readFileSync(tracePath, "utf8");
      for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (record?.actionId === actionId) return record;
        } catch {}
      }
    } catch {}
    return null;
  }

  _traceWorkingDirectory(recorded) {
    const tracePath = recorded.payload?.tracePath;
    if (!tracePath || !fs.existsSync(tracePath)) return null;
    return this._traceRecord(tracePath, recorded.payload.actionId)?.actionObject?.workingDirectory || null;
  }

  _traceChangedPaths(recorded) {
    const tracePath = recorded.payload?.tracePath;
    const fromPayload = Array.isArray(recorded.payload?.changedPaths) ? recorded.payload.changedPaths : [];
    const fromTrace = (() => {
      if (!tracePath || !fs.existsSync(tracePath)) return [];
      return this._traceRecord(tracePath, recorded.payload.actionId)?.actionScope?.detectedChanges || [];
    })();
    const out = [];
    for (const line of [...fromPayload, ...fromTrace]) {
      const text = String(line || "");
      const withoutStatus = text.replace(/^.{0,3}\s+/, "").trim();
      const renamed = withoutStatus.split(" -> ").at(-1).trim();
      if (renamed && !renamed.includes("..") && !path.isAbsolute(renamed)) out.push(renamed);
    }
    return [...new Set(out)];
  }

  _expandArchive(archivePath, extractDirectory) {
    if (process.platform !== "win32") {
      throw new Error("当前仅在 Windows 本机支持从备份恢复");
    }
    const quoted = (value) => `'${String(value).replace(/'/g, "''")}'`;
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath ${quoted(archivePath)} -DestinationPath ${quoted(extractDirectory)} -Force`],
      { encoding: "utf8", windowsHide: true, timeout: 120_000 },
    );
    if (result.status !== 0) throw new Error(`备份解包失败：${String(result.stderr || result.stdout || "未知错误").trim().slice(0, 1000)}`);
  }

  _files(directory, extension) {    if (!fs.existsSync(directory)) return [];
    const files = [];
    const pending = [directory];
    while (pending.length) {
      const current = pending.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const itemPath = path.join(current, entry.name);
        if (entry.isDirectory()) pending.push(itemPath);
        else if (entry.isFile() && entry.name.endsWith(extension)) files.push(itemPath);
      }
    }
    return files.sort();
  }

  _createBackup(action) {
    const dateDirectory = path.join(this.backupDirectory, action.startedAt.slice(0, 10));
    fs.mkdirSync(dateDirectory, { recursive: true });
    const timestamp = action.startedAt.replace(/[:.]/g, "-");
    const archivePath = path.join(
      dateDirectory,
      `${timestamp}-${safeSegment(action.roleId)}-${safeSegment(action.runId)}.zip`,
    );
    const workingDirectory = action.workingDirectory;
    const backupRelative = path.relative(workingDirectory, this.backupDirectory).replaceAll("\\", "/");
    const ignore = [...this.policy.backup.exclude];
    if (backupRelative && !backupRelative.startsWith("..")) ignore.push(`${backupRelative}/**`);
    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(archivePath, { flags: "wx" });
      const archive = archiver("zip", { zlib: { level: 6 } });
      output.once("close", () => resolve(archivePath));
      output.once("error", reject);
      archive.once("warning", (error) => {
        if (error.code !== "ENOENT") reject(error);
      });
      archive.once("error", reject);
      archive.pipe(output);
      archive.append(JSON.stringify({
        actionId: action.id,
        createdAt: action.startedAt,
        projectId: this.project.id,
        missionId: action.missionId,
        runId: action.runId,
        invocationId: action.invocationId,
        roleId: action.roleId,
        goal: action.goal,
        before: action.before,
        policyVersion: this.policy.version,
      }, null, 2), { name: "_black_shores_action.json" });
      archive.glob("**/*", {
        cwd: workingDirectory,
        dot: true,
        followSymlinks: false,
        ignore,
      });
      archive.finalize();
    });
  }
}

module.exports = { RuntimeGovernance, loadRuntimePolicy };

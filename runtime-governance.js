const fs = require("node:fs");
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

  _files(directory, extension) {
    if (!fs.existsSync(directory)) return [];
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

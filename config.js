const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_CONFIG = {
  product: {
    name: "黑海岸 AGENT 系统",
    locale: "zh-CN",
  },
  project: {
    id: "project-default",
    name: "My Project",
    path: ".",
    repository: "local/project",
    sourceRef: "origin/main",
  },
  inactiveProjects: [
    { id: "project-fixture-inactive", name: "Inactive Fixture", status: "inactive" },
  ],
  manager: {
    adapter: "auto",
    model: "",
    reasoningEffort: "",
  },
  roles: {},
  ledger: {
    path: "./data/black-shores-ledger.jsonl",
  },
  runtime: {
    policyPath: "./runtime-policy.json",
    backupDirectory: "./data/action-backups",
    traceDirectory: "./data/action-traces",
  },
  channels: {
    email: {
      secretsPath: "./data/email-channel.secrets.json",
      statePath: "./data/email-channel.state.json",
      devInboxPath: "./data/dev-inbox.jsonl"
    },
  },
  testManifest: {
    id: "ptm-default",
    version: "1.0.0",
    requiredTests: [],
  },
  adapters: {
    codex: {
      enabled: true,
      command: "",
      model: "",
      models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.2"],
      reasoningEffort: "",
    },
    cursor: { enabled: true, command: "", model: "auto", reasoningEffort: "model-default" },
    zcode: { enabled: true, node: "", script: "", model: "", reasoningEffort: "" },
    grok: { enabled: true, command: "", model: "", reasoningEffort: "default" },
    custom: [],
  },
};

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function mergeConfig(base, override) {
  if (!isObject(override)) return { ...base };
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isObject(value) && isObject(base[key])) result[key] = mergeConfig(base[key], value);
    else result[key] = value;
  }
  return result;
}

function resolveFrom(baseDirectory, value, fallback) {
  const supplied = typeof value === "string" && value.trim() ? value.trim() : fallback;
  return path.resolve(baseDirectory, supplied);
}

function loadConfig(rootDirectory = __dirname) {
  const explicitPath = process.env.BLACK_SHORES_CONFIG;
  const configPath = path.resolve(explicitPath || path.join(rootDirectory, "black-shores.config.json"));
  let localConfig = {};
  let configured = false;
  if (fs.existsSync(configPath)) {
    try {
      localConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (!isObject(localConfig)) throw new Error("根值必须是对象");
      configured = true;
    } catch (error) {
      throw new Error(`无法读取配置 ${configPath}：${error.message}`);
    }
  }

  const config = mergeConfig(DEFAULT_CONFIG, localConfig);
  const baseDirectory = path.dirname(configPath);
  config.configPath = configPath;
  config.configured = configured;
  config.project.path = resolveFrom(baseDirectory, config.project.path, ".");
  config.ledger.path = path.resolve(
    process.env.BLACK_SHORES_LEDGER || resolveFrom(baseDirectory, config.ledger.path, "./data/black-shores-ledger.jsonl"),
  );
  config.project.testManifest = config.testManifest;
  const hasPolicyOverride = typeof localConfig.runtime?.policyPath === "string"
    && localConfig.runtime.policyPath.trim();
  config.runtime.policyPath = hasPolicyOverride
    ? resolveFrom(baseDirectory, localConfig.runtime.policyPath, "./runtime-policy.json")
    : path.resolve(rootDirectory, DEFAULT_CONFIG.runtime.policyPath);
  config.runtime.backupDirectory = resolveFrom(baseDirectory, config.runtime.backupDirectory, "./data/action-backups");
  config.runtime.traceDirectory = resolveFrom(baseDirectory, config.runtime.traceDirectory, "./data/action-traces");
  config.channels.email.secretsPath = resolveFrom(
    baseDirectory,
    config.channels.email.secretsPath,
    "./data/email-channel.secrets.json",
  );
  config.channels.email.statePath = resolveFrom(
    baseDirectory,
    config.channels.email.statePath,
    "./data/email-channel.state.json",
  );
  config.channels.email.devInboxPath = resolveFrom(
    baseDirectory,
    config.channels.email.devInboxPath,
    "./data/dev-inbox.jsonl",
  );
  if (!Array.isArray(config.adapters.custom)) config.adapters.custom = [];
  if (!Array.isArray(config.inactiveProjects)) config.inactiveProjects = [];
  return config;
}

module.exports = { DEFAULT_CONFIG, loadConfig, mergeConfig };

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const {
  JsonlLedger,
  OrganizationService,
} = require("./organization-core");
const { loadConfig } = require("./config");

const HOST = "127.0.0.1";
const requestedPort = Number.parseInt(process.env.BLACK_SHORES_PORT || "4782", 10);
const PORT = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : 4782;
const ROOT = __dirname;
const appConfig = loadConfig(ROOT);
const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/black-coast.css", ["black-coast.css", "text/css; charset=utf-8"]],
  ["/black-coast-app.js", ["black-coast-app.js", "text/javascript; charset=utf-8"]],
]);

function existingFile(filePath) {
  return Boolean(filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile());
}

function commandSpec(command, prefixArgs = []) {
  return existingFile(command) ? { command, prefixArgs } : null;
}

function findLatestCursorRuntime(rootDirectory) {
  const versionsDirectory = path.join(rootDirectory, "versions");
  if (!fs.existsSync(versionsDirectory)) return null;
  const versions = fs
    .readdirSync(versionsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));

  for (const version of versions) {
    const runtimeDirectory = path.join(versionsDirectory, version);
    const nodePath = path.join(runtimeDirectory, "node.exe");
    const scriptPath = path.join(runtimeDirectory, "index.js");
    if (existingFile(nodePath) && existingFile(scriptPath)) {
      return { command: nodePath, prefixArgs: [scriptPath], runtimeDirectory };
    }
  }
  return null;
}

function resolveCodexCommand() {
  if (appConfig.adapters.codex.enabled === false) return null;
  const override = process.env.BLACK_SHORES_CODEX_BIN || appConfig.adapters.codex.command;
  if (override && existingFile(override)) return commandSpec(override);

  if (process.platform === "win32") {
    const lookup = spawnSync("where.exe", ["codex"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const candidates = String(lookup.stdout || "")
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
    const executable = candidates.find(
      (item) => item.toLowerCase().endsWith(".exe") && existingFile(item),
    );
    if (executable) return commandSpec(executable);

    const commandShim = candidates.find(
      (item) => item.toLowerCase().endsWith(".cmd") && existingFile(item),
    );
    if (commandShim) {
      const cliScript = path.join(
        path.dirname(commandShim),
        "node_modules",
        "@openai",
        "codex",
        "bin",
        "codex.js",
      );
      if (existingFile(cliScript)) return commandSpec(process.execPath, [cliScript]);
    }
  }
  return { command: "codex", prefixArgs: [] };
}

function resolveCursorCommand() {
  if (appConfig.adapters.cursor.enabled === false) return null;
  const override = process.env.BLACK_SHORES_CURSOR_BIN || appConfig.adapters.cursor.command;
  if (override) {
    if (override.toLowerCase().endsWith(".cmd")) {
      const runtime = findLatestCursorRuntime(path.dirname(override));
      if (runtime) return runtime;
    }
    if (existingFile(override)) return commandSpec(override);
  }
  if (process.platform === "win32") {
    const lookup = spawnSync("where.exe", ["agent"], { encoding: "utf8", windowsHide: true });
    const candidate = String(lookup.stdout || "").split(/\r?\n/).map((item) => item.trim()).find(existingFile);
    if (candidate) return commandSpec(candidate);
  }
  return null;
}

function resolveZcodeCommand(cursorCommand) {
  if (appConfig.adapters.zcode.enabled === false) return null;
  const scriptPath =
    process.env.BLACK_SHORES_ZCODE_SCRIPT || appConfig.adapters.zcode.script;
  const nodePath =
    process.env.BLACK_SHORES_ZCODE_NODE ||
    appConfig.adapters.zcode.node ||
    (cursorCommand && path.basename(cursorCommand.command).toLowerCase() === "node.exe"
      ? cursorCommand.command
      : "");
  return existingFile(nodePath) && existingFile(scriptPath)
    ? commandSpec(nodePath, [scriptPath])
    : null;
}

function resolveGrokCommand() {
  if (appConfig.adapters.grok.enabled === false) return null;
  const override = process.env.BLACK_SHORES_GROK_BIN || appConfig.adapters.grok.command;
  if (override && existingFile(override)) return commandSpec(override);
  return override ? { command: override, prefixArgs: [] } : { command: "grok", prefixArgs: [] };
}

function resolveZcodeBridge() {
  if (process.env.ZCODE_MODEL && process.env.ZCODE_API_KEY) {
    const parts = process.env.ZCODE_MODEL.split("/");
    return {
      model: parts.pop(),
      providerId: parts.join("/") || "anthropic",
      models: [process.env.ZCODE_MODEL.split("/").pop()],
      reasoningByModel: {},
      reasoningDefaultsByModel: {},
      source: "environment",
      env: {},
    };
  }

  const desktopConfigPath = path.join(os.homedir(), ".zcode", "v2", "config.json");
  try {
    const desktopConfig = JSON.parse(fs.readFileSync(desktopConfigPath, "utf8"));
    const providers = desktopConfig?.provider;
    if (!providers || typeof providers !== "object") return null;
    const preferredProvider = process.env.BLACK_SHORES_ZCODE_PROVIDER || "builtin:zai";
    const providerEntries = Object.entries(providers).sort(([left], [right]) => {
      if (left === preferredProvider) return -1;
      if (right === preferredProvider) return 1;
      return 0;
    });
    const selected = providerEntries.find(([, provider]) => {
      return (
        provider?.enabled === true &&
        typeof provider?.options?.apiKey === "string" &&
        provider.options.apiKey.trim() &&
        typeof provider?.options?.baseURL === "string" &&
        provider.options.baseURL.trim()
      );
    });
    if (!selected) return null;

    const [providerKey, provider] = selected;
    const availableModels = Object.keys(provider.models || {});
    const requestedModel = process.env.BLACK_SHORES_ZCODE_MODEL || "GLM-5.3";
    const model = availableModels.includes(requestedModel)
      ? requestedModel
      : availableModels[0];
    if (!model) return null;
    const reasoning = zcodeReasoningCatalog(provider.models);
    return {
      model,
      models: availableModels,
      providerId: providerKey.replace(/^builtin:/, ""),
      ...reasoning,
      source: desktopConfigPath,
      env: {
        ZCODE_BASE_URL: provider.options.baseURL,
        ZCODE_API_KEY: provider.options.apiKey,
      },
    };
  } catch {
    return null;
  }
}

function readVersion(spec, versionArgs = ["--version"]) {
  if (!spec) return null;
  const result = spawnSync(spec.command, [...spec.prefixArgs, ...versionArgs], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000,
  });
  if (result.status !== 0) return null;
  return String(result.stdout || result.stderr || "").trim().split(/\r?\n/)[0] || null;
}

const CURSOR_MODEL_FALLBACK = ["auto"];

const CURSOR_REASONING_SUFFIXES = [
  ["extra-high", "xhigh"],
  ["minimal", "minimal"],
  ["medium", "medium"],
  ["xhigh", "xhigh"],
  ["high", "high"],
  ["low", "low"],
  ["max", "max"],
  ["none", "none"],
];

const REASONING_ORDER = [
  "model-default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "enabled",
  "off",
];

function sortReasoningOptions(options) {
  return [...options].sort((left, right) => {
    const leftIndex = REASONING_ORDER.indexOf(left);
    const rightIndex = REASONING_ORDER.indexOf(right);
    if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right);
    if (leftIndex === -1) return 1;
    if (rightIndex === -1) return -1;
    return leftIndex - rightIndex;
  });
}

function readCursorModels(spec) {
  if (!spec) return CURSOR_MODEL_FALLBACK;
  const result = spawnSync(spec.command, [...spec.prefixArgs, "models"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
  });
  if (result.status !== 0) return CURSOR_MODEL_FALLBACK;
  const models = String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.match(/^([^\s]+)\s+-\s+.+$/)?.[1])
    .filter(Boolean);
  return models.length ? [...new Set(models)] : CURSOR_MODEL_FALLBACK;
}

function parseCursorModelVariant(model) {
  let base = model;
  const fast = base.endsWith("-fast");
  if (fast) base = base.slice(0, -5);
  for (const [suffix, effort] of CURSOR_REASONING_SUFFIXES) {
    if (base.endsWith(`-${suffix}`)) {
      return { base: base.slice(0, -(suffix.length + 1)), effort, fast };
    }
  }
  for (const [suffix, effort] of CURSOR_REASONING_SUFFIXES) {
    const marker = `-${suffix}-thinking`;
    if (base.endsWith(marker)) {
      return {
        base: `${base.slice(0, -marker.length)}-thinking`,
        effort,
        fast,
      };
    }
  }
  return { base, effort: "model-default", fast };
}

function buildCursorReasoningCatalog(models) {
  const variantsByModel = {};
  const defaultsByModel = {};
  const modelOptions = [];
  const modelByConcreteId = {};
  const effortByConcreteId = {};
  const defaultPreference = [
    "model-default",
    "medium",
    "high",
    "low",
    "none",
    "xhigh",
    "max",
    "minimal",
  ];

  for (const concreteModel of models) {
    const parsed = parseCursorModelVariant(concreteModel);
    const visibleModel = `${parsed.base}${parsed.fast ? "-fast" : ""}`;
    if (!variantsByModel[visibleModel]) {
      variantsByModel[visibleModel] = {};
      modelOptions.push(visibleModel);
    }
    variantsByModel[visibleModel][parsed.effort] ||= concreteModel;
    modelByConcreteId[concreteModel] = visibleModel;
    effortByConcreteId[concreteModel] = parsed.effort;
  }

  for (const [visibleModel, variants] of Object.entries(variantsByModel)) {
    const efforts = Object.keys(variants);
    defaultsByModel[visibleModel] =
      defaultPreference.find((effort) => efforts.includes(effort)) || efforts[0];
  }
  return {
    variantsByModel,
    defaultsByModel,
    modelOptions,
    modelByConcreteId,
    effortByConcreteId,
  };
}

function zcodeReasoningCatalog(models) {
  const reasoningByModel = {};
  const reasoningDefaultsByModel = {};
  for (const [model, definition] of Object.entries(models || {})) {
    const reasoning = definition?.reasoning;
    const options = reasoning?.levels || reasoning?.variants || [];
    const fallback = reasoning?.defaultLevel || reasoning?.defaultVariant;
    reasoningByModel[model] = sortReasoningOptions(options);
    reasoningDefaultsByModel[model] = fallback || options[0] || "configured";
  }
  return { reasoningByModel, reasoningDefaultsByModel };
}

const codexCommand = resolveCodexCommand();
const cursorCommand = resolveCursorCommand();
const zcodeCommand = resolveZcodeCommand(cursorCommand);
const grokCommand = resolveGrokCommand();
const zcodeConfigPath = path.join(os.homedir(), ".zcode", "cli", "config.json");
const zcodeSessionDbPath = path.join(
  os.homedir(),
  ".zcode",
  "cli",
  "db",
  "db.sqlite",
);
const zcodeBridge = resolveZcodeBridge();
const cursorModels = readCursorModels(cursorCommand);
const cursorReasoning = buildCursorReasoningCatalog(cursorModels);
const configuredCursorModel =
  process.env.BLACK_SHORES_CURSOR_MODEL || appConfig.adapters.cursor.model || "auto";
const cursorDefaultModel =
  cursorReasoning.modelByConcreteId[configuredCursorModel] ||
  (cursorReasoning.variantsByModel[configuredCursorModel]
    ? configuredCursorModel
    : "auto");
const cursorDefaultReasoning =
  cursorReasoning.effortByConcreteId[configuredCursorModel] ||
  cursorReasoning.defaultsByModel[cursorDefaultModel] ||
  "model-default";
const activeExclusiveRuns = new Set();

function configuredCommand(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const command = value.trim();
  return existingFile(command) ? commandSpec(command) : { command, prefixArgs: [] };
}

function customArgs(definition, values) {
  const replacements = {
    "{prompt}": values.prompt,
    "{cwd}": values.cwd,
    "{model}": values.model,
    "{reasoningEffort}": values.reasoningEffort,
  };
  return (Array.isArray(definition.args) ? definition.args : [])
    .map((argument) => {
      let output = String(argument);
      for (const [token, value] of Object.entries(replacements)) {
        output = output.replaceAll(token, value || "");
      }
      return output;
    })
    .filter((argument) => argument !== "");
}

function createCustomAdapter(definition) {
  const id = String(definition.id || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(id) || definition.enabled === false) return null;
  const command = configuredCommand(definition.command);
  const versionArgs = Array.isArray(definition.versionArgs) ? definition.versionArgs : ["--version"];
  return {
    id,
    label: String(definition.label || id),
    adapter: String(definition.adapter || "Custom command adapter"),
    command,
    version: readVersion(command, versionArgs),
    skipVersionCheck: definition.skipVersionCheck === true,
    model: String(definition.model || ""),
    reasoningEffort: String(definition.reasoningEffort || "default"),
    modelOptions: Array.isArray(definition.models) ? definition.models.map(String) : [],
    reasoningOptions: Array.isArray(definition.reasoningOptions)
      ? definition.reasoningOptions.map(String)
      : [String(definition.reasoningEffort || "default")],
    supportsReasoning: definition.supportsReasoning !== false,
    strictModels: false,
    exclusive: definition.exclusive === true,
    permissionMode: String(definition.permissionMode || "configured-by-owner"),
    authMode: "local-environment",
    outputFormat: definition.outputFormat === "ndjson" ? "ndjson" : "text",
    promptViaStdin: definition.promptMode !== "argument",
    childEnv: definition.env && typeof definition.env === "object" ? definition.env : {},
    buildArgs(values) {
      return customArgs(definition, values);
    },
  };
}

const adapters = {
  codex: {
    id: "codex",
    label: "Codex",
    adapter: "Codex CLI",
    command: codexCommand,
    version: readVersion(codexCommand),
    model: process.env.BLACK_SHORES_CODEX_MODEL || appConfig.adapters.codex.model || "",
    reasoningEffort:
      process.env.BLACK_SHORES_CODEX_REASONING || appConfig.adapters.codex.reasoningEffort || "",
    modelOptions: Array.isArray(appConfig.adapters.codex.models)
      ? appConfig.adapters.codex.models.map(String)
      : [],
    reasoningOptions: ["minimal", "low", "medium", "high", "xhigh"],
    supportsReasoning: true,
    permissionMode: "full-access",
    authMode: "local-cli",
    buildArgs({ cwd, model, reasoningEffort }) {
      const modelArgs = model ? ["--model", model] : [];
      const reasoningArgs = reasoningEffort
        ? ["--config", `model_reasoning_effort=\"${reasoningEffort}\"`]
        : [];
      return [
        ...codexCommand.prefixArgs,
        "exec",
        ...modelArgs,
        ...reasoningArgs,
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        "--dangerously-bypass-hook-trust",
        "--skip-git-repo-check",
        "--cd",
        cwd,
        "-",
      ];
    },
    promptViaStdin: true,
  },
  cursor: {
    id: "cursor",
    label: "Cursor",
    adapter: "Cursor Agent CLI",
    command: cursorCommand,
    version: readVersion(cursorCommand),
    model: cursorDefaultModel,
    reasoningEffort: cursorDefaultReasoning,
    modelOptions: cursorReasoning.modelOptions,
    reasoningOptions: [
      "model-default",
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ],
    reasoningByModel: Object.fromEntries(
      Object.entries(cursorReasoning.variantsByModel).map(([model, variants]) => [
        model,
        sortReasoningOptions(Object.keys(variants)),
      ]),
    ),
    reasoningDefaultsByModel: cursorReasoning.defaultsByModel,
    supportsReasoning: true,
    strictModels: true,
    permissionMode: "full-access",
    authMode: "local-cli",
    normalizeModel(model) {
      return cursorReasoning.modelByConcreteId[model] || model;
    },
    reasoningForSubmittedModel(model) {
      return cursorReasoning.effortByConcreteId[model];
    },
    resolveModel(model, reasoningEffort) {
      const resolved = cursorReasoning.variantsByModel[model]?.[reasoningEffort];
      if (!resolved) {
        const error = new Error(`${model} 不支持推理强度 ${reasoningEffort}`);
        error.statusCode = 400;
        throw error;
      }
      return resolved;
    },
    buildArgs({ prompt, cwd, model }) {
      const modelArgs = model && model !== "auto" ? ["--model", model] : [];
      return [
        ...cursorCommand.prefixArgs,
        "-p",
        "--output-format",
        "stream-json",
        "--stream-partial-output",
        ...modelArgs,
        "--force",
        "--sandbox",
        "disabled",
        "--approve-mcps",
        "--trust",
        "--workspace",
        cwd,
        prompt,
      ];
    },
  },
  zcode: {
    id: "zcode",
    label: "ZCode / GLM",
    adapter: "ZCode CLI",
    command: zcodeCommand,
    version: readVersion(zcodeCommand),
    model:
      zcodeBridge?.model || process.env.BLACK_SHORES_ZCODE_MODEL || appConfig.adapters.zcode.model || "",
    reasoningEffort:
      zcodeBridge?.reasoningDefaultsByModel?.[zcodeBridge?.model] || "configured",
    modelOptions: zcodeBridge?.models || [],
    reasoningOptions: [
      ...new Set(Object.values(zcodeBridge?.reasoningByModel || {}).flat()),
    ],
    reasoningByModel: zcodeBridge?.reasoningByModel || {},
    reasoningDefaultsByModel: zcodeBridge?.reasoningDefaultsByModel || {},
    supportsReasoning: true,
    strictModels: true,
    exclusive: true,
    permissionMode: "yolo",
    authMode: "local-cli",
    configurationReady:
      existingFile(zcodeConfigPath) &&
      existingFile(zcodeSessionDbPath) &&
      Boolean(zcodeBridge),
    childEnv: zcodeBridge?.env || {},
    buildEnv({ model }) {
      return {
        ...this.childEnv,
        ZCODE_MODEL: `${zcodeBridge.providerId}/${model}`,
      };
    },
    prepareRun({ reasoningEffort }) {
      const helperPath = path.join(ROOT, "zcode-reasoning.js");
      const result = spawnSync(
        zcodeCommand.command,
        ["--no-warnings", helperPath, zcodeSessionDbPath, reasoningEffort],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: 10000,
        },
      );
      if (result.status !== 0) {
        const error = new Error(
          String(result.stderr || result.stdout || "ZCode 推理强度写入失败").trim(),
        );
        error.statusCode = 500;
        throw error;
      }
    },
    buildArgs({ prompt, cwd }) {
      return [
        ...zcodeCommand.prefixArgs,
        "--prompt",
        prompt,
        "--cwd",
        cwd,
        "--output-format",
        "stream-json",
        "--mode",
        "yolo",
        "--surface",
        "terminal",
        "--no-color",
      ];
    },
  },
  grok: {
    id: "grok",
    label: "Grok Build",
    adapter: "Grok Build CLI",
    command: grokCommand,
    version: readVersion(grokCommand),
    model: process.env.BLACK_SHORES_GROK_MODEL || appConfig.adapters.grok.model || "",
    reasoningEffort: appConfig.adapters.grok.reasoningEffort || "default",
    modelOptions: [],
    reasoningOptions: ["default", "low", "medium", "high", "xhigh"],
    supportsReasoning: true,
    permissionMode: "bypassPermissions",
    authMode: "local-cli",
    buildArgs({ prompt, cwd, model, reasoningEffort }) {
      const modelArgs = model ? ["--model", model] : [];
      const reasoningArgs =
        reasoningEffort && reasoningEffort !== "default"
          ? ["--reasoning-effort", reasoningEffort]
          : [];
      return [
        ...grokCommand.prefixArgs,
        "--single",
        prompt,
        "--cwd",
        cwd,
        ...modelArgs,
        ...reasoningArgs,
        "--output-format",
        "streaming-json",
        "--always-approve",
        "--permission-mode",
        "bypassPermissions",
        "--verbatim",
      ];
    },
  },
};

for (const definition of appConfig.adapters.custom) {
  const adapter = createCustomAdapter(definition);
  if (adapter && !adapters[adapter.id]) adapters[adapter.id] = adapter;
}

function refreshAdapterStatus(adapter) {
  adapter.installed = Boolean(adapter.command && (adapter.version || adapter.skipVersionCheck));
  adapter.connected = adapter.installed && adapter.configurationReady !== false;
  adapter.message = !adapter.installed
    ? `未找到可用的 ${adapter.adapter}`
    : adapter.configurationReady === false
      ? "CLI 已安装，但缺少可用的本地模型配置"
      : adapter.id === "zcode" && zcodeBridge
        ? "复用本机 ZCode 桌面配置，凭据不会进入网页"
      : "使用本机登录状态，凭据不会进入网页";
}

for (const adapter of Object.values(adapters)) refreshAdapterStatus(adapter);

function resolveAssignment(input = {}, fallback = null) {
  const requestedId = String(input.adapter || input.adapterId || "auto").trim().toLowerCase();
  const adapter = requestedId === "auto"
    ? Object.values(adapters).find((candidate) => candidate.connected)
    : adapters[requestedId];
  if (!adapter?.connected) {
    return {
      adapterId: requestedId,
      adapterLabel: requestedId === "auto" ? "自动选择" : adapter?.label || requestedId,
      model: String(input.model || ""),
      reasoningEffort: String(input.reasoningEffort || ""),
      ready: false,
      message: requestedId === "auto"
        ? "没有可用的 AGENT 适配器。请运行 npm run setup，或配置任意厂商的 custom 命令适配器。"
        : adapter?.message || `AGENT 适配器 ${requestedId} 不可用`,
    };
  }
  return {
    adapterId: adapter.id,
    adapterLabel: adapter.label,
    model: String(input.model || adapter.model || fallback?.model || ""),
    reasoningEffort: String(
      input.reasoningEffort || adapter.reasoningEffort || fallback?.reasoningEffort || "",
    ),
    ready: true,
    message: adapter.message,
  };
}

const managerAssignment = resolveAssignment(appConfig.manager);
const projectDirectoryReady = (() => {
  try {
    return fs.statSync(appConfig.project.path).isDirectory();
  } catch {
    return false;
  }
})();
if (!projectDirectoryReady) {
  managerAssignment.ready = false;
  managerAssignment.message = `项目目录不存在：${appConfig.project.path}`;
}
const roleAssignments = Object.fromEntries(
  Object.entries(appConfig.roles || {}).map(([roleId, assignment]) => [
    roleId,
    resolveAssignment(assignment, managerAssignment),
  ]),
);

function configurationForDisk() {
  return {
    product: appConfig.product,
    project: {
      id: appConfig.project.id,
      name: appConfig.project.name,
      path: appConfig.project.path,
      repository: appConfig.project.repository,
      sourceRef: appConfig.project.sourceRef,
    },
    manager: appConfig.manager,
    roles: appConfig.roles,
    ledger: { path: appConfig.ledger.path },
    testManifest: appConfig.testManifest,
    adapters: appConfig.adapters,
  };
}

function persistConfiguration() {
  fs.mkdirSync(path.dirname(appConfig.configPath), { recursive: true });
  fs.writeFileSync(
    appConfig.configPath,
    `${JSON.stringify(configurationForDisk(), null, 2)}\n`,
    "utf8",
  );
  appConfig.configured = true;
}

function normalizeAssignmentInput(input, fallback = null) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw Object.assign(new Error("AGENT 任职必须是对象"), { statusCode: 400 });
  }
  const requestedId = readRunOption(input.adapter || input.adapterId, "auto", "适配器").toLowerCase();
  const adapter = requestedId === "auto"
    ? Object.values(adapters).find((candidate) => candidate.connected)
    : adapters[requestedId];
  if (!adapter?.connected) {
    throw Object.assign(
      new Error(adapter?.message || "没有可用于该任职的 AGENT 适配器"),
      { statusCode: 409 },
    );
  }
  const settings = resolveRunSettings(adapter, {
    model: input.model || fallback?.model || adapter.model,
    reasoningEffort:
      input.reasoningEffort || fallback?.reasoningEffort || adapter.reasoningEffort,
  });
  const raw = {
    adapter: requestedId,
    model: settings.requestedModel,
    reasoningEffort: settings.reasoningEffort,
  };
  return { raw, resolved: resolveAssignment(raw, fallback) };
}

function applyAssignmentConfiguration(payload) {
  const normalizedManager = normalizeAssignmentInput(payload.manager || appConfig.manager);
  const requestedRoles = payload.roles && typeof payload.roles === "object" ? payload.roles : {};
  const roleIds = new Set(organization.state().roles.map((role) => role.id));
  const rawRoles = {};
  const resolvedRoles = {};
  for (const [roleId, input] of Object.entries(requestedRoles)) {
    if (!roleIds.has(roleId)) {
      throw Object.assign(new Error(`未知角色：${roleId}`), { statusCode: 400 });
    }
    if (input?.inherit === true) continue;
    const normalized = normalizeAssignmentInput(input, normalizedManager.resolved);
    rawRoles[roleId] = normalized.raw;
    resolvedRoles[roleId] = normalized.resolved;
  }
  appConfig.manager = normalizedManager.raw;
  appConfig.roles = rawRoles;
  Object.assign(managerAssignment, normalizedManager.resolved);
  for (const key of Object.keys(roleAssignments)) delete roleAssignments[key];
  Object.assign(roleAssignments, resolvedRoles);
  persistConfiguration();
  return organization.setAssignments({
    managerAssignment,
    roleAssignments,
  });
}

function normalizeCustomAdapterInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw Object.assign(new Error("自定义 AGENT 配置必须是对象"), { statusCode: 400 });
  }
  const id = readRunOption(input.id, "", "AGENT ID").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(id)) {
    throw Object.assign(new Error("AGENT ID 只能包含小写字母、数字和连字符，长度为 2-63"), { statusCode: 400 });
  }
  if (adapters[id]) throw Object.assign(new Error(`AGENT ${id} 已存在`), { statusCode: 409 });
  const command = readRunOption(input.command, "", "可执行命令");
  if (!command) throw Object.assign(new Error("必须填写可执行命令"), { statusCode: 400 });
  const args = Array.isArray(input.args) ? input.args.map((item) => String(item)) : [];
  if (args.length > 64 || args.some((item) => item.length > 2000)) {
    throw Object.assign(new Error("命令参数超出限制"), { statusCode: 400 });
  }
  const model = readRunOption(input.model, "", "模型");
  if (!model) throw Object.assign(new Error("必须配置至少一个模型"), { statusCode: 400 });
  const reasoningEffort = readRunOption(input.reasoningEffort, "default", "推理强度");
  return {
    id,
    label: readRunOption(input.label, id, "名称"),
    enabled: true,
    command,
    args,
    promptMode: input.promptMode === "argument" ? "argument" : "stdin",
    outputFormat: input.outputFormat === "ndjson" ? "ndjson" : "text",
    skipVersionCheck: input.skipVersionCheck === true,
    model,
    models: [model],
    reasoningEffort,
    reasoningOptions: [reasoningEffort],
    permissionMode: "configured-by-owner",
  };
}

function addCustomAdapter(input) {
  const definition = normalizeCustomAdapterInput(input);
  const adapter = createCustomAdapter(definition);
  refreshAdapterStatus(adapter);
  adapters[adapter.id] = adapter;
  appConfig.adapters.custom.push(definition);
  persistConfiguration();
  return publicAdapter(adapter);
}

function publicAdapter(adapter) {
  return {
    id: adapter.id,
    label: adapter.label,
    adapter: adapter.adapter,
    connected: adapter.connected,
    installed: adapter.installed,
    version: adapter.version,
    model: adapter.model,
    reasoningEffort: adapter.reasoningEffort,
    modelOptions: adapter.modelOptions || [],
    reasoningOptions: adapter.reasoningOptions || [],
    reasoningByModel: adapter.reasoningByModel || {},
    reasoningDefaultsByModel: adapter.reasoningDefaultsByModel || {},
    supportsReasoning: Boolean(adapter.supportsReasoning),
    strictModels: Boolean(adapter.strictModels),
    permissionMode: adapter.permissionMode,
    authMode: adapter.authMode,
    message: adapter.message,
  };
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

function writeEvent(response, payload) {
  if (!response.writableEnded && !response.destroyed) {
    response.write(`${JSON.stringify(payload)}\n`);
  }
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) {
      const error = new Error("请求内容超过 64 KB");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("请求 JSON 无效");
    error.statusCode = 400;
    throw error;
  }
}

function stopProcessTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  child.kill("SIGTERM");
}

function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "");
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item && (item.type === "text" || typeof item.text === "string"))
    .map((item) => item.text || "")
    .join("");
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  return {
    input_tokens: usage.input_tokens ?? usage.inputTokens ?? 0,
    cached_input_tokens:
      usage.cached_input_tokens ??
      usage.cache_read_input_tokens ??
      usage.cacheReadInputTokens ??
      usage.cacheReadTokens ??
      0,
    output_tokens: usage.output_tokens ?? usage.outputTokens ?? 0,
    reasoning_tokens: usage.reasoning_tokens ?? usage.reasoningTokens ?? 0,
    total_tokens: usage.total_tokens ?? usage.totalTokens,
  };
}

function sessionEvent(raw, state) {
  const sessionId = raw.session_id || raw.sessionId || raw.thread_id || raw.threadId;
  if (!sessionId || sessionId === state.sessionId) return null;
  state.sessionId = sessionId;
  return { type: "hub.session", sessionId };
}

function normalizeEvent(adapter, raw, state) {
  const events = [];
  const session = sessionEvent(raw, state);
  if (session) events.push(session);

  if (raw.type === "error" || raw.type === "turn.failed" || raw.is_error === true) {
    events.push({
      type: "hub.error",
      message: raw.error?.message || raw.message || raw.result || `${adapter.label} 执行失败`,
    });
    return events;
  }

  if (adapter.id === "codex") {
    if (raw.type === "thread.started") {
      events.push({ type: "hub.progress", message: "正在分析任务" });
    } else if (raw.type === "item.started") {
      events.push({ type: "hub.progress", message: "正在执行" });
    } else if (raw.type === "item.completed") {
      if (raw.item?.type === "agent_message" && raw.item.text) {
        events.push({ type: "hub.result", text: raw.item.text });
      } else if (raw.item?.type === "command_execution") {
        events.push({ type: "hub.progress", message: "工具步骤已完成" });
      }
    } else if (raw.type === "turn.completed") {
      const usage = normalizeUsage(raw.usage);
      if (usage) events.push({ type: "hub.usage", usage });
    }
    return events;
  }

  if (adapter.id === "grok") {
    if (raw.type === "thought" && !state.thinking) {
      state.thinking = true;
      events.push({ type: "hub.progress", message: "正在推理" });
    } else if (raw.type === "text" && typeof raw.data === "string") {
      events.push({ type: "hub.delta", text: raw.data });
    } else if (raw.type === "usage" || raw.type === "end") {
      const usage = normalizeUsage(raw.usage);
      if (usage) events.push({ type: "hub.usage", usage });
    }
    return events;
  }

  if (adapter.id === "zcode") {
    if (raw.type === "model.streaming") {
      const kind = raw.payload?.kind;
      if (kind === "reasoning_start" && !state.thinking) {
        state.thinking = true;
        events.push({ type: "hub.progress", message: "正在推理" });
      } else if (kind === "text_delta" && typeof raw.payload?.delta === "string") {
        events.push({ type: "hub.delta", text: raw.payload.delta });
      }
    } else if (raw.type === "session.updated") {
      const runtimeModel =
        typeof raw.payload?.model === "string"
          ? raw.payload.model
          : raw.payload?.model?.providerId && raw.payload?.model?.modelId
            ? `${raw.payload.model.providerId}/${raw.payload.model.modelId}`
            : "";
      if (runtimeModel && runtimeModel !== state.runtimeModel) {
        state.runtimeModel = runtimeModel;
        events.push({ type: "hub.runtime", model: runtimeModel });
      }
      const runtimeReasoning = raw.payload?.modelCall?.reasoning?.effectiveLevel;
      const runtimeReasoningBudget =
        raw.payload?.modelCall?.reasoning?.effectiveBudgetTokens;
      if (
        runtimeReasoning &&
        (runtimeReasoning !== state.runtimeReasoning ||
          runtimeReasoningBudget !== state.runtimeReasoningBudget)
      ) {
        state.runtimeReasoning = runtimeReasoning;
        state.runtimeReasoningBudget = runtimeReasoningBudget;
        events.push({
          type: "hub.runtime",
          model: state.runtimeModel,
          reasoningEffort: runtimeReasoning,
          reasoningBudgetTokens: runtimeReasoningBudget,
        });
      }
      if (typeof raw.payload?.content === "string") {
        events.push({ type: "hub.result", text: raw.payload.content });
      }
      const usage = normalizeUsage(raw.payload?.usage);
      if (usage) events.push({ type: "hub.usage", usage });
    } else if (raw.type === "turn.completed") {
      if (typeof raw.payload?.response === "string") {
        events.push({ type: "hub.result", text: raw.payload.response });
      }
      const usage = normalizeUsage(raw.payload?.usage);
      if (usage) events.push({ type: "hub.usage", usage });
    } else if (raw.type === "result") {
      if (typeof raw.response === "string") {
        events.push({ type: "hub.result", text: raw.response });
      }
      const usage = normalizeUsage(raw.usage);
      if (usage) events.push({ type: "hub.usage", usage });
    }
    return events;
  }

  if (raw.type === "connection" || raw.type === "retry") {
    const message = raw.subtype === "reconnecting" ? "上游连接中断，正在重连" : "正在连接上游服务";
    events.push({ type: "hub.progress", message });
  } else if (raw.type === "system" && raw.subtype === "init") {
    if (raw.model) events.push({ type: "hub.runtime", model: raw.model });
    events.push({ type: "hub.progress", message: "会话已建立" });
  } else if (raw.type === "assistant") {
    const text = contentText(raw.message?.content ?? raw.content);
    if (text) events.push({ type: "hub.result", text });
  } else if (raw.type === "result") {
    const text =
      typeof raw.result === "string"
        ? raw.result
        : contentText(raw.message?.content ?? raw.content);
    if (text) events.push({ type: "hub.result", text });
    const usage = normalizeUsage(raw.usage);
    if (usage) events.push({ type: "hub.usage", usage });
  } else if (raw.type === "text" && typeof raw.data === "string") {
    events.push({ type: "hub.delta", text: raw.data });
  } else if (raw.type === "usage") {
    const usage = normalizeUsage(raw.usage);
    if (usage) events.push({ type: "hub.usage", usage });
  } else if (raw.type?.includes("tool")) {
    events.push({ type: "hub.progress", message: "正在执行工具步骤" });
  }

  return events;
}

function readRunOption(value, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") {
    const error = new Error(`${label}必须是字符串`);
    error.statusCode = 400;
    throw error;
  }
  const normalized = value.trim();
  if (!normalized) return fallback;
  if (normalized.length > 160 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    const error = new Error(`${label}格式无效`);
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function resolveRunSettings(adapter, payload) {
  const submittedModel = readRunOption(payload.model, adapter.model, "模型");
  const requestedModel = adapter.normalizeModel
    ? adapter.normalizeModel(submittedModel)
    : submittedModel;
  if (
    adapter.strictModels &&
    adapter.modelOptions.length &&
    !adapter.modelOptions.includes(requestedModel)
  ) {
    const error = new Error(`模型不在当前 ${adapter.label} 可用清单中：${requestedModel}`);
    error.statusCode = 400;
    throw error;
  }
  const reasoningOptions =
    adapter.reasoningByModel?.[requestedModel] || adapter.reasoningOptions;
  const defaultReasoning =
    adapter.reasoningForSubmittedModel?.(submittedModel) ||
    adapter.reasoningDefaultsByModel?.[requestedModel] ||
    adapter.reasoningEffort;
  let reasoningEffort = defaultReasoning;
  if (adapter.supportsReasoning) {
    reasoningEffort = readRunOption(
      payload.reasoningEffort,
      defaultReasoning,
      "推理强度",
    );
    if (reasoningEffort && reasoningOptions.length && !reasoningOptions.includes(reasoningEffort)) {
      const error = new Error(
        `${requestedModel} 不支持推理强度 ${reasoningEffort}；可用值为 ${reasoningOptions.join(", ")}`,
      );
      error.statusCode = 400;
      throw error;
    }
  }
  const model = adapter.resolveModel
    ? adapter.resolveModel(requestedModel, reasoningEffort)
    : requestedModel;
  return { model, requestedModel, reasoningEffort };
}

async function handleAgentRun(request, response, adapter) {
  if (!adapter.connected) {
    sendJson(response, 503, { error: adapter.message, agent: adapter.id });
    return;
  }

  let payload;
  try {
    payload = await readJsonBody(request);
  } catch (error) {
    sendJson(response, error.statusCode || 400, { error: error.message });
    return;
  }

  const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
  if (!prompt) {
    sendJson(response, 400, { error: "任务文本不能为空" });
    return;
  }
  if (prompt.length > 50000) {
    sendJson(response, 413, { error: "任务文本超过 50,000 字符" });
    return;
  }

  let runSettings;
  try {
    runSettings = resolveRunSettings(adapter, payload);
  } catch (error) {
    sendJson(response, error.statusCode || 400, { error: error.message });
    return;
  }

  const requestedDirectory =
    typeof payload.cwd === "string" && payload.cwd.trim() ? payload.cwd.trim() : process.cwd();
  const workingDirectory = path.resolve(requestedDirectory);
  try {
    if (!fs.statSync(workingDirectory).isDirectory()) throw new Error();
  } catch {
    sendJson(response, 400, { error: `工作目录不存在：${workingDirectory}` });
    return;
  }

  if (adapter.exclusive && activeExclusiveRuns.has(adapter.id)) {
    sendJson(response, 409, {
      error: `${adapter.label} 正在运行另一项任务，请等待其完成后再提交`,
    });
    return;
  }
  if (adapter.exclusive) activeExclusiveRuns.add(adapter.id);
  try {
    adapter.prepareRun?.(runSettings);
  } catch (error) {
    activeExclusiveRuns.delete(adapter.id);
    sendJson(response, error.statusCode || 400, { error: error.message });
    return;
  }

  response.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Content-Type-Options": "nosniff",
  });

  writeEvent(response, {
    type: "hub.started",
    agent: adapter.id,
    label: adapter.label,
    model: runSettings.model,
    requestedModel: runSettings.requestedModel,
    reasoningEffort: runSettings.reasoningEffort,
    cwd: workingDirectory,
    permissionMode: adapter.permissionMode,
  });

  const childEnv = adapter.buildEnv
    ? adapter.buildEnv(runSettings)
    : adapter.childEnv || {};
  const child = spawn(
    adapter.command.command,
    adapter.buildArgs({ prompt, cwd: workingDirectory, ...runSettings }),
    {
      cwd: workingDirectory,
      env: { ...process.env, ...childEnv },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const state = {
    sessionId: "",
    thinking: false,
    runtimeModel: "",
    runtimeReasoning: "",
    runtimeReasoningBudget: null,
  };
  let completed = false;
  let abortedByClient = false;
  let stdoutBuffer = "";
  let stderrBuffer = "";

  response.on("close", () => {
    if (!completed) {
      abortedByClient = true;
      stopProcessTree(child);
    }
  });

  function processLine(line) {
    const cleanLine = stripAnsi(line).trim();
    if (!cleanLine || response.writableEnded || response.destroyed) return;
    try {
      const raw = JSON.parse(cleanLine);
      for (const event of normalizeEvent(adapter, raw, state)) writeEvent(response, event);
    } catch {
      writeEvent(response, { type: "hub.log", message: cleanLine });
    }
  }

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    if (adapter.outputFormat === "text") {
      stdoutBuffer += chunk;
      writeEvent(response, { type: "hub.delta", text: chunk });
      return;
    }
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) processLine(line);
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrBuffer = `${stderrBuffer}${stripAnsi(chunk)}`.slice(-20000);
  });

  child.on("error", (error) => {
    completed = true;
    activeExclusiveRuns.delete(adapter.id);
    writeEvent(response, { type: "hub.error", message: error.message });
    if (!response.writableEnded && !response.destroyed) response.end();
  });

  child.on("close", (code, signal) => {
    completed = true;
    activeExclusiveRuns.delete(adapter.id);
    if (adapter.outputFormat !== "text" && stdoutBuffer.trim()) processLine(stdoutBuffer);
    if (!abortedByClient && code !== 0) {
      writeEvent(response, {
        type: "hub.error",
        message: stderrBuffer.trim() || `${adapter.label} 退出，代码 ${code ?? "未知"}`,
        code,
        signal,
      });
    }
    writeEvent(response, { type: "hub.exit", agent: adapter.id, code, signal });
    if (!response.writableEnded && !response.destroyed) response.end();
  });

  if (adapter.promptViaStdin) child.stdin.end(prompt, "utf8");
  else child.stdin.end();
}

function runAdapterBuffered(
  adapter,
  { prompt, cwd, model, reasoningEffort, onActivity },
) {
  if (!adapter.connected) return Promise.reject(new Error(adapter.message));
  const workingDirectory = path.resolve(cwd);
  try {
    if (!fs.statSync(workingDirectory).isDirectory()) throw new Error();
  } catch {
    return Promise.reject(new Error(`组织 Run 工作目录不存在：${workingDirectory}`));
  }

  let runSettings;
  try {
    runSettings = resolveRunSettings(adapter, { model, reasoningEffort });
    if (adapter.exclusive && activeExclusiveRuns.has(adapter.id)) {
      throw new Error(`${adapter.label} 正在运行另一项任务`);
    }
    if (adapter.exclusive) activeExclusiveRuns.add(adapter.id);
    adapter.prepareRun?.(runSettings);
  } catch (error) {
    activeExclusiveRuns.delete(adapter.id);
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    const childEnv = adapter.buildEnv ? adapter.buildEnv(runSettings) : adapter.childEnv || {};
    const child = spawn(
      adapter.command.command,
      adapter.buildArgs({ prompt, cwd: workingDirectory, ...runSettings }),
      {
        cwd: workingDirectory,
        env: { ...process.env, ...childEnv },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const state = {
      sessionId: "",
      thinking: false,
      runtimeModel: "",
      runtimeReasoning: "",
      runtimeReasoningBudget: null,
    };
    const resultParts = [];
    let usage = null;
    let runtime = {};
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let settled = false;

    function finish(error, value) {
      if (settled) return;
      settled = true;
      activeExclusiveRuns.delete(adapter.id);
      if (error) reject(error);
      else resolve(value);
    }

    function processLine(line) {
      const cleanLine = stripAnsi(line).trim();
      if (!cleanLine) return;
      try {
        const raw = JSON.parse(cleanLine);
        for (const event of normalizeEvent(adapter, raw, state)) {
          onActivity?.(event);
          if (event.type === "hub.result" || event.type === "hub.delta") {
            if (event.text) resultParts.push(event.text);
          } else if (event.type === "hub.usage") {
            usage = event.usage;
          } else if (event.type === "hub.runtime") {
            runtime = { ...runtime, ...event };
          } else if (event.type === "hub.error") {
            stderrBuffer = `${stderrBuffer}\n${event.message}`.trim().slice(-20_000);
          }
        }
      } catch {
        stderrBuffer = `${stderrBuffer}\n${cleanLine}`.trim().slice(-20_000);
      }
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (adapter.outputFormat === "text") {
        stdoutBuffer += chunk;
        onActivity?.({ type: "hub.progress", message: "AGENT 正在生成结果" });
        return;
      }
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      lines.forEach(processLine);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrBuffer = `${stderrBuffer}${stripAnsi(chunk)}`.slice(-20_000);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      if (adapter.outputFormat !== "text" && stdoutBuffer.trim()) processLine(stdoutBuffer);
      const output = (adapter.outputFormat === "text" ? stdoutBuffer : resultParts.join("")).trim();
      if (code !== 0 || !output) {
        finish(
          new Error(
            stderrBuffer.trim() ||
              `${adapter.label} 组织 Run 退出，代码 ${code ?? "未知"}${signal ? `，信号 ${signal}` : ""}`,
          ),
        );
        return;
      }
      finish(null, {
        output,
        usage,
        runtime: {
          adapterId: adapter.id,
          model: runtime.model || runSettings.model,
          reasoningEffort: runtime.reasoningEffort || runSettings.reasoningEffort,
          sessionId: state.sessionId,
        },
      });
    });

    if (adapter.promptViaStdin) child.stdin.end(prompt, "utf8");
    else child.stdin.end();
  });
}

const organizationLedger = new JsonlLedger(
  appConfig.ledger.path,
  { projectId: appConfig.project.id },
);
const organizationProject = {
  id: appConfig.project.id,
  name: appConfig.project.name,
  repository: appConfig.project.repository,
  sourceRef: appConfig.project.sourceRef,
  testManifest: appConfig.testManifest,
  workingDirectory: appConfig.project.path,
};
const organization = new OrganizationService({
  ledger: organizationLedger,
  project: organizationProject,
  managerAssignment,
  roleAssignments,
  runRole: ({ adapterId, prompt, cwd, model, reasoningEffort, onActivity }) => {
    const adapter = adapters[adapterId];
    if (!adapter) return Promise.reject(new Error(`未知 AGENT 适配器：${adapterId}`));
    return runAdapterBuffered(adapter, { prompt, cwd, model, reasoningEffort, onActivity });
  },
});

function gitValue(cwd, args, { timeout = 30_000 } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout,
  });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "Git 命令失败").trim();
    throw Object.assign(new Error(detail), { statusCode: 409 });
  }
  return String(result.stdout || "").trim();
}

function inspectReleaseSource(project) {
  const workingDirectory = path.resolve(project.workingDirectory);
  const resolvedRoot = path.resolve(gitValue(workingDirectory, ["rev-parse", "--show-toplevel"]));
  if (resolvedRoot !== workingDirectory) {
    throw Object.assign(new Error("Mission 工作目录不是独立 Git 工作树根目录"), { statusCode: 409 });
  }
  gitValue(workingDirectory, ["fetch", "--prune", "origin"], { timeout: 120_000 });
  const branch = gitValue(workingDirectory, ["branch", "--show-current"]);
  if (!branch) throw Object.assign(new Error("发布候选处于 detached HEAD，不能核对来源"), { statusCode: 409 });
  const sourceRef = project.sourceRef || "origin/main";
  const sourceRefCommit = gitValue(workingDirectory, ["rev-parse", sourceRef]);
  const headCommit = gitValue(workingDirectory, ["rev-parse", "HEAD"]);
  const status = gitValue(workingDirectory, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const counts = gitValue(workingDirectory, ["rev-list", "--left-right", "--count", `${sourceRef}...HEAD`])
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10));
  const configFiles = ["project.config.json", "project.private.config.json"];
  const projectConfigHashes = Object.fromEntries(
    configFiles
      .map((fileName) => [fileName, path.join(workingDirectory, fileName)])
      .filter(([, filePath]) => fs.existsSync(filePath) && fs.statSync(filePath).isFile())
      .map(([fileName, filePath]) => [
        fileName,
        createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"),
      ]),
  );
  return {
    repository: project.repository,
    workingDirectory,
    sourceRef,
    sourceRefCommit,
    branch,
    headCommit,
    clean: status === "",
    ahead: counts[1],
    behind: counts[0],
    diffStat: gitValue(workingDirectory, ["diff", "--stat", `${sourceRef}...HEAD`]),
    projectConfigHashes,
  };
}

function organizationError(response, error) {
  sendJson(response, error.statusCode || 500, {
    error: error.message || String(error),
    missionId: error.missionId || null,
  });
}

function serveStatic(response, pathname) {
  const file = STATIC_FILES.get(pathname);
  if (!file) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }
  const [fileName, contentType] = file;
  fs.readFile(path.join(ROOT, fileName), (error, content) => {
    if (error) {
      sendJson(response, 500, { error: "无法读取静态文件" });
      return;
    }
    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(content);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || HOST}`);

  if (request.method === "GET" && url.pathname === "/api/health") {
    const publicAdapters = Object.fromEntries(
      Object.entries(adapters).map(([id, adapter]) => [id, publicAdapter(adapter)]),
    );
    sendJson(response, 200, {
      ok: true,
      service: "black-shores-agent",
      agents: publicAdapters,
      configuration: {
        configured: appConfig.configured,
        fileName: path.basename(appConfig.configPath),
        projectReady: projectDirectoryReady,
      },
      organization: {
        version: organization.state().version,
        ledgerMode: organization.state().authority.ledgerMode,
        managerAdapter: managerAssignment.adapterId,
        managerAdapterLabel: managerAssignment.adapterLabel,
        managerModel: managerAssignment.model,
        managerReasoning: managerAssignment.reasoningEffort,
        executionReady: managerAssignment.ready,
      },
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/organization/state") {
    sendJson(response, 200, organization.state());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/organization/events") {
    const missionId = url.searchParams.get("missionId");
    const events = organizationLedger
      .events()
      .filter((event) => !missionId || event.missionId === missionId);
    sendJson(response, 200, { events });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/configuration") {
    sendJson(response, 200, {
      manager: appConfig.manager,
      roles: appConfig.roles,
      configured: appConfig.configured,
      activeRunIds: organization.state().activeRunIds,
    });
    return;
  }

  if (request.method === "PUT" && url.pathname === "/api/configuration/assignments") {
    try {
      const payload = await readJsonBody(request);
      const state = applyAssignmentConfiguration(payload);
      sendJson(response, 200, {
        manager: appConfig.manager,
        roles: appConfig.roles,
        activeRunIds: state.activeRunIds,
        appliesTo: "next-physical-invocation",
      });
    } catch (error) {
      organizationError(response, error);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/configuration/adapters") {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, 201, { agent: addCustomAdapter(payload) });
    } catch (error) {
      organizationError(response, error);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/organization/missions") {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, 202, { mission: organization.createMission(payload.goal, payload.workflowProfile) });
    } catch (error) {
      organizationError(response, error);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/organization/commands") {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, 202, organization.executeCommand({
        content: payload.content,
        missionId: payload.missionId || null,
      }));
    } catch (error) {
      organizationError(response, error);
    }
    return;
  }

  const missionMatch = url.pathname.match(/^\/api\/organization\/missions\/([^/]+)$/);
  if (request.method === "GET" && missionMatch) {
    const mission = organization.mission(decodeURIComponent(missionMatch[1]));
    if (!mission) sendJson(response, 404, { error: "Mission 不存在" });
    else sendJson(response, 200, { mission });
    return;
  }

  const missionActionMatch = url.pathname.match(
    /^\/api\/organization\/missions\/([^/]+)\/(messages|confirm-baseline|retry|verify-source|approve-merge|approve-deployment|external-evidence|accept-result)$/,
  );
  if (request.method === "POST" && missionActionMatch) {
    const missionId = decodeURIComponent(missionActionMatch[1]);
    const action = missionActionMatch[2];
    try {
      if (action === "messages") {
        const payload = await readJsonBody(request);
        sendJson(response, 202, { mission: organization.addHumanMessage(missionId, payload.content) });
      } else if (action === "confirm-baseline") {
        sendJson(response, 202, { mission: organization.confirmBaseline(missionId) });
      } else if (action === "retry") {
        sendJson(response, 202, { mission: organization.retry(missionId) });
      } else if (action === "verify-source") {
        const source = inspectReleaseSource(organizationProject);
        sendJson(response, 200, { mission: organization.verifyReleaseSource(missionId, source) });
      } else if (action === "approve-merge") {
        sendJson(response, 200, { mission: organization.approveMerge(missionId) });
      } else if (action === "approve-deployment") {
        sendJson(response, 200, { mission: organization.approveDeployment(missionId) });
      } else if (action === "external-evidence") {
        const payload = await readJsonBody(request);
        sendJson(response, 200, { mission: organization.recordExternalEvidence(missionId, payload) });
      } else if (action === "accept-result") {
        sendJson(response, 200, { mission: organization.acceptResult(missionId) });
      }
    } catch (error) {
      organizationError(response, error);
    }
    return;
  }

  const runMatch = url.pathname.match(/^\/api\/agents\/([a-z0-9-]+)\/run$/);
  if (request.method === "POST" && runMatch) {
    const adapter = adapters[runMatch[1]];
    if (!adapter) {
      sendJson(response, 404, { error: `未知 AGENT：${runMatch[1]}` });
      return;
    }
    await handleAgentRun(request, response, adapter);
    return;
  }

  if (request.method === "GET") {
    serveStatic(response, url.pathname);
    return;
  }

  sendJson(response, 405, { error: "Method not allowed" });
});

server.listen(PORT, HOST, () => {
  console.log(`BLACK_SHORES_AGENT: http://${HOST}:${PORT}`);
  for (const adapter of Object.values(adapters)) {
    console.log(
      adapter.connected
        ? `${adapter.label}: ${adapter.version} | ${adapter.model} | ${adapter.permissionMode}`
        : `${adapter.label}: ${adapter.message}`,
    );
  }
});

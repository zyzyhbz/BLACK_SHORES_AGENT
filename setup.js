const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");

const ROOT = __dirname;
const TARGET = path.join(ROOT, "black-shores.config.json");

async function ask(interface_, label, fallback = "") {
  const suffix = fallback ? ` [${fallback}]` : "";
  const value = (await interface_.question(`${label}${suffix}: `)).trim();
  return value || fallback;
}

async function askRequired(interface_, label) {
  while (true) {
    const value = await ask(interface_, label);
    if (value) return value;
    stdout.write("该项不能为空。\n");
  }
}

async function askAdapter(interface_) {
  const allowed = new Set(["codex", "cursor", "zcode", "grok", "custom"]);
  while (true) {
    const value = (await ask(
      interface_,
      "群星的调律者适配器 (codex/cursor/zcode/grok/custom)",
      "codex",
    )).toLowerCase();
    if (allowed.has(value)) return value;
    stdout.write("请选择 codex、cursor、zcode、grok 或 custom。\n");
  }
}

async function askProjectPath(interface_) {
  while (true) {
    const value = await ask(interface_, "项目目录", ".");
    const resolved = path.resolve(ROOT, value);
    try {
      if (fs.statSync(resolved).isDirectory()) return value;
    } catch {
      // Ask again with a concrete path instead of writing an unusable configuration.
    }
    stdout.write(`目录不存在：${resolved}\n`);
  }
}

async function main() {
  const interface_ = readline.createInterface({ input: stdin, output: stdout });
  try {
    if (fs.existsSync(TARGET)) {
      const overwrite = (await ask(interface_, "配置已存在，是否覆盖", "n")).toLowerCase();
      if (!new Set(["y", "yes", "是"]).has(overwrite)) {
        stdout.write(`保留现有配置：${TARGET}\n`);
        return;
      }
    }

    stdout.write("BLACK_SHORES_AGENT 本地初始化\n");
    const projectName = await ask(interface_, "项目名称", "My Project");
    const projectPath = await askProjectPath(interface_);
    const repository = await ask(interface_, "仓库标识", "local/project");
    const sourceRef = await ask(interface_, "发布来源基线", "origin/main");
    const adapter = await askAdapter(interface_);
    const model = await askRequired(interface_, "模型 ID（由对应厂商或本地运行时定义）");
    const reasoningEffort = await ask(interface_, "推理强度", "default");

    const adapters = {
      codex: { enabled: adapter === "codex", command: "", model: adapter === "codex" ? model : "", reasoningEffort: adapter === "codex" ? reasoningEffort : "" },
      cursor: { enabled: adapter === "cursor", command: "", model: adapter === "cursor" ? model : "auto", reasoningEffort: adapter === "cursor" ? reasoningEffort : "model-default" },
      zcode: { enabled: adapter === "zcode", node: "", script: "", model: adapter === "zcode" ? model : "", reasoningEffort: adapter === "zcode" ? reasoningEffort : "" },
      grok: { enabled: adapter === "grok", command: "", model: adapter === "grok" ? model : "", reasoningEffort: adapter === "grok" ? reasoningEffort : "default" },
      custom: [],
    };

    let managerAdapter = adapter;
    if (adapter === "custom") {
      const id = (await ask(interface_, "自定义适配器 ID", "my-agent")).toLowerCase();
      const command = await askRequired(interface_, "可执行命令或绝对路径");
      const rawArgs = await ask(
        interface_,
        "参数模板（JSON 数组，可用 {cwd}/{model}/{reasoningEffort}/{prompt}）",
        "[]",
      );
      let args;
      try {
        args = JSON.parse(rawArgs);
        if (!Array.isArray(args)) throw new Error("不是数组");
      } catch (error) {
        throw new Error(`参数模板无效：${error.message}`);
      }
      adapters.custom.push({
        id,
        label: id,
        enabled: true,
        command,
        args,
        promptMode: args.some((item) => String(item).includes("{prompt}")) ? "argument" : "stdin",
        outputFormat: "text",
        skipVersionCheck: false,
        model,
        models: [model],
        reasoningEffort,
        reasoningOptions: [reasoningEffort],
      });
      managerAdapter = id;
    }

    const config = {
      product: { name: "黑海岸 AGENT 系统", locale: "zh-CN" },
      project: {
        id: `project-${projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "default"}`,
        name: projectName,
        path: projectPath,
        repository,
        sourceRef,
      },
      manager: { adapter: managerAdapter, model, reasoningEffort },
      roles: {},
      ledger: { path: "./data/black-shores-ledger.jsonl" },
      testManifest: { id: "ptm-default", version: "1.0.0", requiredTests: [] },
      adapters,
    };
    fs.writeFileSync(TARGET, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", flag: "w" });
    stdout.write(`\n配置已写入 ${TARGET}\n运行 npm start 启动系统。\n`);
  } finally {
    interface_.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

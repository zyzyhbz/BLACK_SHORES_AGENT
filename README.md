# BLACK_SHORES_AGENT

黑海岸 AGENT 系统是一个本地优先的多角色组织运行台。人类只需要描述结果目标，系统按需求明确、总管规划、工程执行、独立复核和测试门禁推进任务，并把消息、Run、心跳、检查点、证据和授权追加写入本地 JSONL 账本。

本仓库只包含可运行代码、测试和示例配置，不包含任何项目 PRD、实施纲要、真实任务账本、凭据或用户数据。

## 运行要求

- Node.js 18 或更高版本
- 一个已经安装并登录的 AGENT CLI，或一个能通过命令行调用的任意厂商/本地模型
- 一个要让 AGENT 工作的本地项目目录

模型厂商不受限制。内置适配器支持 Codex、Cursor Agent、ZCode 和 Grok Build；`custom` 适配器可接其他厂商、反代或本地模型。BLACK_SHORES_AGENT 不捆绑模型和凭据。

## 快速开始

```bash
git clone https://github.com/zyzyhbz/BLACK_SHORES_AGENT.git
cd BLACK_SHORES_AGENT
npm run setup
npm test
npm start
```

打开 `http://127.0.0.1:4782/`。Windows 也可以运行 `start-black-shores-agent.cmd`，macOS/Linux 可以运行 `./start-black-shores-agent.sh`。

`npm run setup` 会创建仅保存在本机的 `black-shores.config.json`。该文件、`data/` 账本、日志和环境变量文件都已加入 `.gitignore`。

## 配置

完整结构见 `black-shores.config.example.json`。最小配置需要项目目录、总管适配器和至少一个模型 ID：

```json
{
  "project": {
    "id": "project-app",
    "name": "My App",
    "path": "../my-app",
    "repository": "owner/my-app",
    "sourceRef": "origin/main"
  },
  "manager": {
    "adapter": "codex",
    "model": "your-model-id",
    "reasoningEffort": "high"
  }
}
```

将 `manager.adapter` 设为 `auto` 时，系统会选择第一个已安装且配置可用的内置或自定义适配器。没有可用适配器时，工作台仍可启动并显示诊断，但会在创建 Mission 前明确阻止执行。

可以为单个角色覆盖总管配置：

```json
{
  "roles": {
    "engineering": {
      "adapter": "my-local-agent",
      "model": "local/code-model",
      "reasoningEffort": "high"
    },
    "independent-reviewer": {
      "adapter": "cursor",
      "model": "review-model",
      "reasoningEffort": "medium"
    }
  }
}
```

可覆盖的活跃角色 ID 包括 `requirements-lead`、`chief-manager`、`engineering`、`independent-reviewer` 和 `tester`。未单独配置的角色继承总管任职。

### 任意厂商或本地模型

`custom` 适配器直接启动一个本地命令，不经过 shell。参数支持 `{cwd}`、`{model}`、`{reasoningEffort}` 和 `{prompt}` 占位符：

```json
{
  "manager": {
    "adapter": "my-agent",
    "model": "provider/model-name",
    "reasoningEffort": "default"
  },
  "adapters": {
    "custom": [
      {
        "id": "my-agent",
        "label": "My AGENT",
        "enabled": true,
        "command": "my-agent",
        "args": ["run", "--model", "{model}", "--cwd", "{cwd}"],
        "promptMode": "stdin",
        "outputFormat": "text",
        "model": "provider/model-name",
        "models": ["provider/model-name"],
        "reasoningEffort": "default",
        "reasoningOptions": ["default"]
      }
    ]
  }
}
```

`promptMode` 可取 `stdin` 或 `argument`。使用 `argument` 时应在 `args` 中放置 `{prompt}`。`outputFormat` 可取纯文本 `text` 或逐行 JSON `ndjson`。命令若不支持 `--version`，可设置 `"skipVersionCheck": true`，但应使用可验证的绝对路径。

认证信息应放在 CLI 自身配置、操作系统凭据存储或进程环境变量中。不要把密钥写入示例配置或提交到 Git。

## 工作流

- `light`：需求明确岗 -> 总管 AGENT -> 工程执行岗 -> 独立复核岗。完成后记录 `ChangeRecord`，不宣称已经完成全量功能验证。
- `heavy`：在完整分工与独立复核后，由测试岗执行项目的全部必跑测试，形成 `VerifiedBaseline` 和发布候选。
- `auto`：根据目标中的风险、发布、部署、权限、迁移和全量回归信号确定轻度或重度模式。

重度模式的必跑项来自项目自己的 `testManifest.requiredTests`。任一必跑项缺失或失败，发布候选不会通过。

## 权限与数据

服务只监听 `127.0.0.1`。内置执行适配器按其全权限/自动批准模式运行，目的是让本地 AGENT 能实际完成工程任务；这也意味着它们可以修改配置的项目目录并执行命令。请只在你信任的机器、项目和模型上运行。

账本默认写入 `./data/black-shores-ledger.jsonl`。它是本机统一事实源，不应提交到仓库。系统不会通过网页返回适配器凭据。

## 验证

```bash
npm test
node --check server.js
node --check organization-core.js
node --check black-coast-app.js
```

当前 MVP 使用 Node.js 标准库，无需安装运行时依赖。工作台图标库 lucide 已随仓库本地化在 `vendor/`，离线环境同样可用。

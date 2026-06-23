<p align="center">
  <a href="README.md">English</a> | 简体中文
</p>

# Starling

<p align="center">
  <img src="assets/starling.png" alt="Starling logo" width="160">
</p>

Starling 是一个本地 Agent 会话管理工具，面向 Claude Code 和 OpenAI Codex。它可以发现本机已有会话，按项目和 Catalog 组织会话，监控正在运行的 Agent 状态，并提供一套快速的 CLI 工作流，用来浏览、恢复、启动和管理会话。

当前版本：**0.1.4**

- npm：[`starling-ai`](https://www.npmjs.com/package/starling-ai)
- GitHub Release：[`rust-v0.1.4`](https://github.com/huang-sh/Starling/releases/tag/rust-v0.1.4)
- VS Code 扩展：[`huangsh.starling-ai`](https://marketplace.visualstudio.com/items?itemName=huangsh.starling-ai)

## 功能

- 从本地 Claude Code 和 Codex 会话文件中发现历史会话。
- 按 Catalog、项目目录或最近活动浏览会话。
- 创建 `paper-review` 这类 Catalog，也支持按路径组织层级 Catalog。
- 给会话添加标题、标签、笔记和 Catalog 归档信息。
- 用一条命令恢复 Claude Code 或 Codex 会话。
- 在会话文件提供信息时统计 token 使用量。
- 在 `~/.starling/session-index.json` 维护本地索引，加速项目和 Catalog 视图。
- 通过 `starling run` 启动 Claude Code 或 Codex，并把新会话自动归档到指定 Catalog。
- 在 `~/.starling/settings` 下管理 Claude 和 Codex 的模型配置。
- 通过类似 `top` 的终端视图监控 pinned sessions，区分 `running`、`waiting`、`idle`、`stopped` 状态。
- 使用 JSON 输出作为终端渲染和 VS Code 扩展共享的数据契约。
- 配套 VS Code 扩展，提供 Catalog、Projects、Models 和 Monitor 视图。

## 安装

```bash
npm install -g starling-ai
```

npm 包名是 `starling-ai`，安装后的命令是：

```bash
starling --help
```

Linux 和 macOS 下，npm 会安装一个小的 JavaScript 启动器，并自动拉取匹配当前平台的 native 包：

- `starling-linux-x64`
- `starling-darwin-x64`
- `starling-darwin-arm64`

相同的 native 压缩包和 sha256 文件也会附在 GitHub Release 中：

```text
https://github.com/huang-sh/Starling/releases/tag/rust-v0.1.4
```

npm 安装时还会把 Starling skill 安装到：

```text
~/.codex/skills/starling/SKILL.md
~/.claude/skills/starling/SKILL.md
```

如果安装时使用了 `--ignore-scripts` 禁用了 npm 生命周期脚本，可以手动安装 skill：

```bash
npm explore -g starling-ai -- npm run install:skill
```

Starling 需要 Node.js 16 或更新版本。Claude Code 和 Codex 需要单独安装；Starling 负责发现、启动和恢复这些 Agent 的会话，但不内置 Agent 本身。

## 快速开始

列出最近会话：

```bash
starling session ls
```

查看会话详情，包括 Catalog 元数据和 token 使用量：

```bash
starling session show <session-id>
```

恢复一个会话：

```bash
starling resume <session-id>
```

监控 pinned sessions：

```bash
starling top
starling top --watch
starling top --recent
starling top --json
```

创建 Catalog 并加入会话：

```bash
starling catalog create paper-review
starling catalog add paper-review <session-id> --title "Figure review"
```

启动 Codex，并把新会话归档到 Catalog：

```bash
starling run -c paper-review codex
```

使用 Starling 配置启动 Claude Code：

```bash
starling run --setting ds -c paper-review claude
```

Starling 自己的参数必须放在 Agent 名称之前。`-s` 是 `--setting` 的短别名，`-c` 是 `--catalog` 的短别名。`claude` 或 `codex` 后面的参数会原样传给对应 Agent：

```bash
starling run --catalog paper-review codex exec "summarize this repo"
starling run --catalog paper-review claude --dangerously-skip-permissions
```

查看 Starling run 记录：

```bash
starling run status
```

## 命令

### Sessions

```bash
starling session ls
starling session ls --all
starling session ls --agent claude
starling session ls --cataloged
starling session ls --catalog paper-review
starling session show <session-id>
starling session resume <session-id>
starling session meta <session-id> --title "New title" --tags review,important
starling session note <session-id> "Follow up on benchmark results"
starling session unpin <session-id>
starling session delete <session-id> --yes
```

`starling ses` 是 `starling session` 的别名。

也可以在 session 命名空间下管理 Catalog 归档：

```bash
starling session catalog add <session-id> paper-review --title "Important run"
starling session catalog remove <session-id> paper-review
starling session catalog clear <session-id>
```

### Catalogs

```bash
starling catalog create <name>
starling catalog create parent/child/grandchild
starling catalog create child --parent parent
starling catalog ls
starling catalog tree
starling catalog tree --sessions
starling catalog show <catalog>
starling catalog add <catalog> <session-id>
starling catalog detach <catalog> <session-id>
starling catalog clear <catalog>
starling catalog delete <catalog>
starling catalog del <catalog>
starling catalog rename <catalog> <new-name>
starling catalog move <catalog> --parent <parent-catalog>
starling catalog move <catalog> --root
starling catalog edit <catalog> --rename <new-name>
starling catalog edit <catalog> --parent <parent-catalog>
starling catalog edit <catalog> --root
starling catalog tag <catalog> tag1 tag2
```

`starling cat` 是 `starling catalog` 的别名。

不同父级下可以有同名 Catalog。遇到歧义时，使用 `parent/child` 这样的路径，或者直接使用 Catalog ID。

### Projects

```bash
starling project ls
starling project ls --all
starling project ls --agent codex
starling project show /path/to/project
```

`starling prj` 是 `starling project` 的别名。

Project 命令默认使用本地会话索引。索引过期或排查问题时，可以重建或绕过索引：

```bash
starling session index status
starling session index rebuild
starling session index clear
starling project ls --refresh-index
starling project ls --no-index
```

### Top

`starling top` 是 Starling 的实时会话监控视图。默认显示 pinned sessions，并按会话状态排序：

1. `running`：Agent 正在处理任务。
2. `waiting`：Agent 正在等待用户输入或权限确认。
3. `idle`：Agent 进程存在，但模型当前没有处理任务。
4. `stopped`：没有与该会话关联的活动进程。

```bash
starling top
starling top --watch
starling top --recent
starling top --catalog paper-review
starling top paper-review
starling top --json
```

默认终端视图由 npm CLI wrapper 渲染，数据来自 Rust core 输出的 JSON。`--json` 会返回原始 monitor snapshot，适合脚本、VS Code 扩展或其他前端使用。

### Run Records

`starling run` 用于在 Starling 跟踪下启动 Agent。run record 记录的是启动历史，它和当前 session state 是两件事：

```bash
starling run --setting glm-5.2 --catalog research/paper claude
starling run --setting gpt-5.5 --catalog research/paper codex
starling run status
starling run stop <run-id>
```

查看当前会话状态用 `starling top`；查看启动/运行历史用 `starling run status`。

### Model Profiles

模型配置保存在：

```text
~/.starling/settings/claude
~/.starling/settings/codex
```

列出现有配置：

```bash
starling model ls
starling model ls --agent claude
starling model ls --agent codex
```

创建 Claude 配置：

```bash
starling model add ds --agent claude \
  --model deepseek-v4-pro \
  --base-url https://api.example.com \
  --api-key "$API_KEY"
```

创建 Codex 配置：

```bash
starling model add demo --agent codex \
  --model gpt-5.2 \
  --base-url https://api.example.com/v1 \
  --api-key "$OPENAI_API_KEY" \
  --reasoning high \
  --wire-api responses

starling model delete demo --agent codex
```

启动 Agent 时使用配置：

```bash
starling run --setting demo --catalog paper-review codex
starling run --setting ds --catalog paper-review claude
```

如果不传 `--setting`，Starling 会使用 Agent 自己的默认配置。

## 配置文件

Starling 默认把自己的数据保存在 `~/.starling`：

```text
~/.starling/
  store.json
  session-index.json
  settings/
    claude/
      <profile>.json
    codex/
      <profile>.toml
```

可以通过 `STARLING_HOME` 临时指定 Starling 数据目录：

```bash
STARLING_HOME=/data20T/dev/.starling starling project ls
```

也可以通过 CLI 持久设置默认数据目录：

```bash
starling config set home /data20T/dev/.starling --migrate
starling config show
```

`STARLING_HOME` 的优先级最高，会覆盖保存的 CLI 设置。

Starling 不会移动或重写 Claude Code 和 Codex 原始会话文件。它会从 Agent 自己的位置读取数据，例如 `~/.claude/projects` 和 `~/.codex/sessions`，并只把 Starling 元数据和模型配置保存在 Starling 数据目录下。

本地会话索引用来优化 CLI 和 VS Code 侧边栏的重复读取：

- `sessions`：session、catalog 和 project 视图使用的会话元数据。
- `files`：已索引的会话文件路径和 mtime，用于只刷新变化文件。
- `directories`：已扫描的会话目录和 mtime，用于发现新会话文件。
- `projects`：预计算的项目汇总，用于快速渲染项目树和项目列表。

Project 和 Catalog 视图默认会增量刷新索引。热路径通过目录 mtime 发现新会话文件，不需要每次 stat 所有历史会话。像 `starling session show <session-id>` 这类精确会话查询，只会按需刷新匹配到的会话文件。只有需要完整重扫时才使用 `starling session index rebuild`。

完整的数据路径和索引刷新设计见 [docs/data-path-design.md](docs/data-path-design.md)。

## 机器可读输出

大多数 Starling 读取命令都支持 `--json`。Rust core 负责发现、索引、元数据、实时状态和 JSON 输出；npm wrapper 基于同一份 JSON 渲染终端表格和 top 风格视图，VS Code 扩展也消费这份 JSON。

常用 JSON 入口：

```bash
starling session ls --json
starling catalog list --json --pins
starling project ls --json
starling model ls --json
starling top --json
starling run status --json
```

Claude profile 是 JSON 文件，Starling 会把它作为 settings 传给 Claude Code。

Codex profile 使用 Codex 风格的 TOML。Starling 会把配置复制到临时 Codex profile 中运行，所以 `starling run --setting <name> codex` 不会覆盖用户默认的 `~/.codex/config.toml`。

Codex profile 示例：

```toml
model_provider = "custom"
model = "gpt-5.2"
model_reasoning_effort = "high"
disable_response_storage = true

[model_providers.custom]
name = "custom"
base_url = "https://api.example.com/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "sk-..."
```

如果服务商只支持 Chat Completions，需要在 profile 中加入：

```toml
api_format = "openai_chat"
```

## VS Code 扩展

VS Code 扩展单独维护在：

```text
https://github.com/huang-sh/Starling-ext
```

Starling 侧边栏包含四个视图：

- Catalog：层级 Catalog 树，按需显示会话。
- Projects：项目目录树和会话数量。
- Models：Claude 和 Codex 模型配置。
- Monitor：pinned、active、recent sessions 的实时状态，包含 context、token、CPU、内存、任务和 PID 等信息。

扩展支持常用右键操作：

- 恢复会话。
- 查看会话详情。
- Pin 到 Catalog。
- 移除 pin 元数据。
- 删除会话。
- 在新的 VS Code 窗口打开项目。
- 复制项目路径。
- 复制 session ID。

扩展会调用本机 `starling` CLI。如果 VS Code 在 `PATH` 中找不到它，可以在 VS Code 设置中把 `starling.cliPath` 设置为绝对路径。要使用不同的 Starling 数据目录，可以设置 `starling.homePath`；扩展会通过 `STARLING_HOME` 传给 CLI。

常用扩展设置：

```json
{
  "starling.cliPath": "starling",
  "starling.homePath": "",
  "starling.cacheTtlSeconds": 30,
  "starling.monitorRefreshSeconds": 5,
  "starling.monitorCacheTtlSeconds": 2,
  "starling.projectSessionLimit": 30,
  "starling.sessionTreeLimit": 50
}
```

扩展日志会写到 VS Code **Output** 面板中的 `Starling` 通道。CLI 和 monitor 刷新失败时，也会在适用的情况下显示到 VS Code **Problems** 诊断里。

## 开发

```bash
npm install
npm run build
npm test
```

从仓库本地运行：

```bash
npm run build
node npm/bin/starling.js --help
```

## License

MIT

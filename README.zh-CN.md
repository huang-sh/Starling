<p align="center">
  <a href="README.md">English</a> | 简体中文
</p>

# Starling

<p align="center">
  <img src="assets/starling.png" alt="Starling logo" width="160">
</p>

Starling 用来启动、切换和组织 Claude Code、Codex 与 Pi 会话，支持模型配置、Catalog、项目视图、实时监控和 VS Code 集成。

当前版本：**0.3.2**

- npm：[`starling-ai`](https://www.npmjs.com/package/starling-ai)
- GitHub Release：[`rust-v0.3.2`](https://github.com/huang-sh/Starling/releases/tag/rust-v0.3.2)
- VS Code 扩展：[`huangsh.starling-ai`](https://marketplace.visualstudio.com/items?itemName=huangsh.starling-ai)

## 功能

- 从本地 Claude Code、Codex 和 Pi 会话文件中发现历史会话。
- 按 Catalog、项目目录或最近活动浏览会话。
- 创建 `paper-review` 这类 Catalog，也支持按路径组织层级 Catalog。
- 给会话添加标题、标签、笔记和 Catalog 归档信息。
- 用一条命令恢复 Claude Code、Codex 或 Pi 会话。
- 在会话文件提供信息时统计 token 使用量。
- 在 `~/.starling/session-index.json` 维护本地索引，加速项目和 Catalog 视图。
- 通过 `starling run` 启动 Claude Code、Codex 或 Pi，并把新会话自动归档到指定 Catalog。
- 不带子命令运行 `starling`，通过托管 launcher（`starling run pi` 同一路径）启动 Pi 自带的交互式 TUI（经 Pi 官方支持的 `piConfig.name` 改品牌为 "starling"），run 记录与 `starling top` 可见性保持不变。
- 用 `starling trajectory` 把 Pi、Claude Code、Codex 会话投影成 turn 粒度的 trajectory 台账：steps、工具耗时、token 用量、错误与中止状态；JSON 输出沿用 codex-trajectory 的 trajectory-v1 结构。
- 通过 `starling chat pi` 把与传输无关的 `ChatSession` 引擎独立暴露为机器可读 JSONL 适配器，供编辑器集成使用。
- 在 `~/.starling/settings` 下管理 Claude、Codex 和 Pi 的模型配置。
- 通过类似 `top` 的终端视图混合监控最活跃的 20 个 pinned 和 unpinned sessions，区分 `running`、`waiting`、`idle`、`stopped` 状态。
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

- `starling-linux-x64`：glibc Linux x64
- `starling-linux-x64-musl`：musl/Alpine Linux x64
- `starling-linux-arm64`：glibc Linux arm64
- `starling-darwin-x64`
- `starling-darwin-arm64`

GNU Linux 包以 GLIBC 2.31 为兼容基线构建，x64 binary 在发布前还会在 Ubuntu 20.04 中执行烟测。Alpine 或其他 musl 发行版请使用 x64 musl 包。

相同的 native 压缩包和 sha256 文件也会附在 GitHub Release 中：

```text
https://github.com/huang-sh/Starling/releases/tag/rust-v0.3.2
```

npm 安装时还会把 Starling skill 安装到：

```text
~/.codex/skills/starling/SKILL.md
~/.claude/skills/starling/SKILL.md
~/.pi/agent/skills/starling/SKILL.md
```

如果安装时使用了 `--ignore-scripts` 禁用了 npm 生命周期脚本，可以手动安装 skill：

```bash
npm explore -g starling-ai -- npm run install:skill
```

npm 版 Starling 需要 Node.js 22.19.0 或更新版本，并以 `>=0.82.0` 的版本范围安装 `@earendil-works/pi-coding-agent`，新安装会自动取得当前的 Pi 版本而不是固定旧版。裸 `starling` 通过托管 launcher（`starling run pi`）启动 Pi 自带的 TUI，不会启动 native chat supervisor 或 JSONL 子进程；普通 session 管理命令不会初始化 SDK。postinstall 阶段会通过 `piConfig.name` 把内置 Pi 包品牌改为 "starling"；其 `PI_CODING_AGENT_DIR`/`PI_CODING_AGENT_SESSION_DIR` 覆盖变量会被镜像到对应的 `STARLING_*` 名称，保证两侧一致。Pi resource loader 发起的 npm/pnpm 包安装会继承 `ignore-scripts`，不会执行依赖的生命周期脚本。

## 快速开始

在当前目录打开新的 SDK 编码会话：

```bash
starling
```

这里通过 Starling 的托管 launcher（与 `starling run pi` 同一条路径）启动 Pi 的交互式 TUI。Starling 不再自研 TUI：界面就是 Pi 自带的 TUI（`>=0.82.0` 版本范围安装），并在安装时通过 Pi 官方支持的 `piConfig.name` 字段改品牌为 "Starling"，启动头部与终端标题显示 `starling`，而 session、凭据与设置仍存放在 `~/.pi`。托管 launcher 会记录 run，因此活动 session 仍可被 `starling top` 看到。

Pi 的全部交互功能原样可用：`/settings`、`/new`、`/resume`、`/fork`、`/clone`、`/import`、`/export`、`/copy`、`/scoped-models`、`/model`、`/tree`、`/login`、`/logout`、`/compact`、`/name`、`/session`、`/share`、`/changelog`、`/hotkeys`、`/trust`、`/reload`，以及 extension 命令、prompt template 和 `skill:*` 命令。输入以 `!` 开头会运行 bash 并把结果放入上下文；`!!` 则不放入上下文。键盘快捷键详见 Pi 自身文档（`/hotkeys`）。

列出最近会话：

```bash
starling session ls
```

查看会话详情，包括 Catalog 元数据和 token 使用量：

```bash
starling session show <session-id>
```

把 Pi 会话投影成 turn 粒度的 trajectory 台账（turn → step → record，含耗时、token 用量与工具结果）：

```bash
starling trajectory                 # 最近的 Pi 会话，终端台账
starling trajectory <session-id>    # 指定会话
starling trajectory --json --full   # trajectory-v1 JSON，含限幅的输入/输出文本
starling trajectory --max-records 1000
```

JSON 输出采用 codex-trajectory 使用的 trajectory-v1 结构（schemaVersion 1，其设计源自 DeepSeek Harness 的事件台账）：`session`、`stats`、`turns`、`records`、`warnings`。每条 user 消息开启一个新 turn；工具结果之后恢复的 assistant 输出开启一个新 step。`toolResult`/`tool_result`/`*_call_output` 会补全对应 tool record 的耗时与错误状态；`model_change`、`thinking_level_change`、`compaction`、`branch_summary` 记为 `system`/`compaction` record。默认 summary 限幅 100 字符，`--full` 时包含限幅（4 KiB）的输入/输出文本；超过 `--max-records`（50–1000，默认 500）时从最旧开始截断。支持全部三个 provider：Pi、Claude Code、Codex（Codex 的 reasoning record 使用 summary 文本，token 总量来自累进的 `token_count` 快照）。

恢复一个会话：

```bash
starling resume <session-id>
```

监控实时 sessions：

```bash
starling top
starling top --watch
starling top --pinned
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

启动 Pi，并把新会话归档到 Catalog：

```bash
starling run -c paper-review pi
```

普通的 `starling run pi` 不会添加 session selector。Pi 按原生方式创建新 session ID，Starling runtime hook 会在启动后记录实际 ID。

供 VS Code 或其他机器客户端启动外部 JSONL 适配器：

```bash
starling chat --cwd /path/to/project --title "Review" pi
starling chat --cwd /path/to/project pi --session /absolute/path/to/session.jsonl
```

`starling chat pi` 是 Starling 的外部 JSONL 适配器；裸 `starling` 不依赖它。两种入口共用同一个与传输无关的 `ChatSession.request()` API，覆盖 prompt、interrupt/queue、模型与 thinking 切换、compaction、bash、export/copy、settings/trust/authentication，以及 new/resume/fork/clone/import session replacement。它们采用 OMP 的同进程 SDK 生命周期：创建 agent session、订阅 SDK 事件、直接提交 prompt，最后取消订阅并 dispose。在 Starling 捆绑的 Node 兼容 Pi SDK（`>=0.82.0`）中，这套生命周期会先构造 `ModelRuntime`、`SessionManager`、`SettingsManager` 和 `DefaultResourceLoader`，再调用 `createAgentSession()`。适配器不会执行 `pi --mode rpc`，也不会启动 Pi TUI。新 chat 由 `SessionManager.create()` 生成真实 session identity，不会预分配 `--session-id`；恢复时的 `--session` 只接受已有 Pi transcript 的绝对路径。标准输入与 SDK 事件采用换行分隔 JSON，单条物理行上限为 1 MiB。标准输出只包含以 LF 结尾的 JSON 记录：Starling 会在兼容消息前后发送 `starling_started` 与 `starling_exited`，其 `schema` 为 `starling.chat`、`schemaVersion` 为 `1`。诊断日志只写到标准错误。

chat runtime 会关闭自动发现的用户级和项目级 Pi extensions，加载 Starling 的 tracking/session guard，并启用唯一一份由 Node 管理的权限 gate。内置只读工具 `read`、`grep`、`find` 和 `ls` 自动放行；`bash`、`edit`、`write` 以及未知工具会发出 Pi `extension_ui_request` 确认事件，RPC client 必须响应。拒绝、取消、UI 异常或 30 秒内没有响应时都会阻止工具调用。Starling 展示的工具文本上限为 16 KiB。这套确认策略是审批边界，不是 sandbox；获批工具仍以 Starling 进程的操作系统权限运行。普通交互式 `starling run pi` 的权限行为不变。

Starling 自己的参数必须放在 Agent 名称之前。`-s` 是 `--setting` 的短别名，`-c` 是 `--catalog` 的短别名。Agent 参数放在 `claude`、`codex` 或 `pi` 后面。Starling 可能额外注入 runtime hook，并把显式的已有 session selector 固定到已锁定的 transcript 路径：

```bash
starling run --catalog paper-review codex exec "summarize this repo"
starling run --catalog paper-review claude --dangerously-skip-permissions
starling run --catalog paper-review pi --provider anthropic --model claude-sonnet-4-5
```

Pi 没有内建的 MCP 配置契约，因此 Starling 的 `--mcp` 和 `--mcp-profile` 不支持 Pi；需要 MCP 集成时请使用 Pi extension。

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
starling session ls --agent pi
starling session ls --cataloged
starling session ls --catalog paper-review
starling session show <session-id>
starling session resume <session-id>
starling session meta <session-id> --title "New title" --tags review,important
starling session note <session-id> "Follow up on benchmark results"
starling session unpin <session-id>
starling session delete <session-id> --yes
```

### Trajectory

<p align="center">
  <img src="assets/Starling-trajectory.png" alt="VS Code 扩展中的 Starling trajectory 台账" width="720">
  <br><em>上图为 VS Code 扩展中的 trajectory 可视化。</em>
</p>

把 Pi、Claude Code、Codex 会话投影成 turn 粒度的台账：

```bash
starling trajectory                 # 任意 provider 中最近的一个会话
starling trajectory <session-id>    # 指定会话（支持 ID 前缀）
starling trajectory --json --full --max-records 1000
```

投影规则（turn/step 语义、工具配对、aborted 状态、嵌套 Codex rollout）见上文「快速开始」部分；JSON 字段见下方机器可读输出。

`starling ses` 是 `starling session` 的别名。

恢复 Pi 会话时，Starling 使用 `pi --session <absolute-jsonl-path>`。Pi session ID 只在 cwd 内唯一；如果不同项目复用了同一 ID，Starling 会报告歧义而不会擅自选择项目，此时可把绝对 JSONL 路径直接传给 `starling resume`。Starling 查询自定义 Pi session ID 时仍区分大小写。

`starling run pi --continue` 会在启动前解析并锁定当前项目最近的 transcript，再把启动目标固定为其绝对路径；如果项目尚无 transcript，Starling 会沿用 Pi“创建新会话”的语义，并预分配一个受锁的 session ID。Pi 的交互式 `--resume` 选择器无法在用户完成选择前锁定目标，因此受管的 `starling run pi --resume` 会明确拒绝；请改用 `starling resume <session-id-or-absolute-path>`。出于相同的互斥原因，受管 Pi 会话会阻止进程内的 `/new`、`/resume` 和 `/fork`；请先退出 Pi，再启动或恢复另一个受管会话。

显式使用 `starling run pi --session <path>` 时，目标必须已是非空且有效的 Pi transcript（旧版 v1/v2 transcript 也可使用，Pi 可能在打开时迁移格式）。Pi 原生命令可以初始化不存在或零字节的显式路径，但这时启动前尚无 session ID 可供 Starling 加锁，因此受管启动会明确拒绝。需要安全创建新的受管会话时，请使用 `starling run pi --session-id <id>`；若必须指定确切路径，请先用 Pi 直接初始化一次，再交给 Starling 恢复。

Linux 上，Pi 启动后会把进程命令行改为标题 `pi`。因此，对从 Starling 之外直接启动的 Pi，实时进程映射无法在启动稳定后可靠还原一次性的 `--session` 或 `--session-dir`。受管启动会携带明确的 hook/环境身份；若外部 Pi 的自定义根目录也必须被可靠监控，请用 `PI_CODING_AGENT_SESSION_DIR` 或 `settings.json` 做持久配置。

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
starling project ls --agent pi
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

`starling top` 是 Starling 的实时会话监控视图。默认混合 pinned 和 unpinned sessions，并显示最活跃的前 20 个：

1. `running`：Agent 正在处理任务。
2. `waiting`：Agent 正在等待用户输入或权限确认。
3. `idle`：Agent 进程存在，但模型当前没有处理任务。
4. `stopped`：没有与该会话关联的活动进程。

```bash
starling top
starling top --watch
starling top --pinned
starling top --limit 40
starling top --agent codex
starling top --agent claude --sort cpu
starling top --agent pi
starling top --sort tokens
starling top --sort cpu
starling top --catalog paper-review
starling top paper-review
starling top --json
```

Agent 过滤：`--agent claude`、`--agent codex` 或 `--agent pi`。

排序模式：`activity`（默认）、`recent`、`tokens`、`created`、`memory`、`cpu`、`ctx`、`skills`、`tools`。

默认终端视图由 npm CLI wrapper 渲染，数据来自 Rust core 输出的 JSON。`--json` 会返回原始 monitor snapshot，适合脚本、VS Code 扩展或其他前端使用。

VS Code 扩展还会把这份 snapshot 渲染成实时仪表盘视图（统计卡片、带上下文进度条和 token 趋势图的会话卡片、含聊天尾部和会话操作的抽屉）：

<p align="center">
  <img src="assets/Starling-monitor.png" alt="VS Code 中的 Starling Monitor 仪表盘" width="720">
</p>

### Run Records

`starling run` 用于在 Starling 跟踪下启动 Agent。run record 记录的是启动历史，它和当前 session state 是两件事：

```bash
starling run --setting glm-5.2 --catalog research/paper claude
starling run --setting gpt-5.5 --catalog research/paper codex
starling run --catalog research/paper pi
starling run status
starling run stop <run-id>
```

查看当前会话状态用 `starling top`；查看启动/运行历史用 `starling run status`。

### Model Profiles

模型配置保存在：

```text
~/.starling/settings/claude
~/.starling/settings/codex
~/.starling/settings/pi
```

列出现有配置：

```bash
starling model ls
starling model ls --agent claude
starling model ls --agent codex
starling model ls --agent pi
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

在 `~/.starling/settings/pi/research.json` 创建 Pi 配置：

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-5",
  "thinking": "high"
}
```

Pi 认证仍由 Pi 自己的认证/配置文件（例如 `~/.pi/agent/auth.json` 和 `~/.pi/agent/models.json`）或 provider 环境变量管理，不要把凭据写进 Starling Pi profile。

```bash
starling model delete research --agent pi
```

启动 Agent 时使用配置：

```bash
starling run --setting demo --catalog paper-review codex
starling run --setting ds --catalog paper-review claude
starling run --setting research --catalog paper-review pi
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
    pi/
      <profile>.json
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

Starling 按以下优先级解析 Pi 可执行文件：`STARLING_PI_BIN`、保存的 `piPath`、npm launcher 设置的 `STARLING_BUNDLED_PI_BIN`，最后是 `PATH` 中的 `pi`。可以这样设置或检查：

```bash
starling config set pi /absolute/path/to/pi
starling config unset pi
starling config show
```

对于显式 `starling chat pi`，npm launcher 会把外部 JSONL SDK Host 暴露为 `STARLING_PI_SDK_HOST`，并把兼容的 Node 可执行文件放在 `STARLING_PI_SDK_NODE`；native chat 命令使用这两个变量启动适配器。裸 `starling` 不配置也不启动该 Host。launcher 会通过公开的 `rpc-entry` export 定位 `cli.js`，并通过 `STARLING_BUNDLED_PI_BIN` 提供给裸 `starling` 复用的托管 `starling run pi` 启动路径；同时把 `PI_CODING_AGENT_DIR`/`PI_CODING_AGENT_SESSION_DIR` 覆盖变量镜像到 Starling 品牌下 Pi 实际读取的 `STARLING_*` 名称。显式设置的 `STARLING_PI_BIN` 或 `STARLING_BUNDLED_PI_BIN` 不会被覆盖。

Starling 不会移动或重写 Claude Code、Codex 和 Pi 的原始会话文件。它会从 Agent 自己的位置读取数据，例如 `~/.claude/projects`、`~/.codex/sessions` 和 `~/.pi/agent/sessions`，并只把 Starling 元数据和模型配置保存在 Starling 数据目录下。当启动 cwd 已知时，Starling 会遵循 Pi 的 `PI_CODING_AGENT_DIR`、`PI_CODING_AGENT_SESSION_DIR`、全局 `settings.json` 和项目级 `<cwd>/.pi/settings.json` 中的 `sessionDir` 设置。

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
starling trajectory --json --full --max-records 1000
```

Claude profile 是 JSON 文件，Starling 会把它作为 settings 传给 Claude Code。

Codex profile 使用 Codex 风格的 TOML。Starling 会把配置复制到临时 Codex profile 中运行，所以 `starling run --setting <name> codex` 不会覆盖用户默认的 `~/.codex/config.toml`。

Pi profile 是包含 `provider`、`model` 和可选 `thinking` 字段的 JSON 文件。Starling 会在本次运行中把它们转换为 Pi 的 `--provider`、`--model` 和 `--thinking` 参数，不会覆盖 Pi 全局的 `~/.pi/agent/settings.json`。

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

扩展会在 VS Code 右侧边栏提供 Starling Chat，并在活动栏保留四个管理视图：

- Catalog：层级 Catalog 树，按需显示会话。
- Projects：项目目录树和会话数量。
- Models：Claude、Codex 和 Pi 模型配置。
- Monitor：pinned、active、recent sessions 的实时状态，包含 context、token、CPU、内存、任务和 PID 等信息。
- Starling Chat：SDK 驱动的流式对话、工具活动和 VS Code 原生权限确认。

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

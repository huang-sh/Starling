# 使用 Starling 丝滑切换模型运行 Claude Code

Starling 可以把不同 Claude Code 模型配置保存成独立 profile，然后在 VS Code 侧边栏或命令行里一键切换。你不需要反复修改 Claude Code 的默认配置，也不需要记住每个 provider、model、api key 的环境变量。

## 安装 Starling CLI 和 VS Code 扩展

### 安装 CLI

Starling 的 npm 包名是 `starling-ai`，安装后提供的命令是 `starling`：

```bash
npm install -g starling-ai
```

检查安装结果：

```bash
starling --version
starling --help
```

如果系统里已经有旧的本地开发版 `starling` 链接，npm 可能提示命令已存在。可以先确认当前命令位置：

```bash
which starling
starling --version
```

需要使用发布版时，重新安装：

```bash
npm uninstall -g starling-ai
npm install -g starling-ai
```

### 安装 VS Code 扩展

在 VS Code 扩展市场搜索并安装：

```text
Starling Agent
```

扩展标识是：

```text
huangsh.starling-ai
```

安装后，VS Code 侧边栏会出现 Starling 视图。扩展会调用本机的 `starling` CLI，所以需要先确保命令行里能正常运行：

```bash
starling --version
```

如果 VS Code 找不到 `starling`，可以在扩展设置里把 `starling.cliPath` 设置为完整路径。完整路径可以这样查看：

```bash
which starling
```

## 推荐方式：在 VS Code 扩展里启动

安装 Starling CLI 和 Starling Agent VS Code 扩展后，侧边栏会显示：

```text
Catalog
Projects
Models
Sessions
```

切换 Claude 模型时，优先使用 `Models` 区域：

1. 打开 VS Code 的 Starling 侧边栏。
2. 展开 `Models`。
3. 找到 `Claude` 下的目标模型配置，例如 `kimi`、`ds`、`glm-5.2`。
4. 右键模型，选择启动 Claude session。
5. 如果需要归档，选择目标 catalog，或者启动后从 session 右键加入 catalog。

这样做的好处是：模型配置、项目路径、session 记录、catalog 归档都在一个侧边栏里完成。你可以直接从不同模型启动 Claude，再在 `Sessions` 或 `Catalog` 中继续查看和恢复历史会话。

## CLI 方式：用 `starling run --config`

等价的命令行方式是：

```bash
starling run --config kimi claude
```

这里的含义是：

- `starling run`：由 Starling 启动 agent。
- `--config kimi`：使用 `~/.starling/settings/claude/kimi.json` 这个 Starling 模型配置。
- `claude`：真正要启动的 agent 是 Claude Code。

Starling 会把 `kimi` 配置转换为 Claude Code 可用的启动参数，并在 Claude 运行结束后记录 session，方便后续通过 Starling 查看、归档和恢复。

## Starling 参数放在 `claude` 前面

Starling 的参数必须放在 agent 名字前面：

```bash
starling run --config kimi --catalog paper-review --title "Kimi review" claude
```

常用 Starling 参数：

```bash
starling run --config kimi claude
starling run --config kimi --catalog paper-review claude
starling run --config kimi --catalog paper-review --title "Benchmark run" claude
starling run --cwd /data20T/dev/project --config kimi claude
```

如果不指定 `--config`，Starling 会使用 Claude Code 的系统默认配置：

```bash
starling run claude
```

## Claude 原始参数照常放在 `claude` 后面

`claude` 后面的内容会原样传给 Claude Code。也就是说，你平时怎么用 Claude，前面加上 Starling 的参数后仍然可以用。

例如，使用 Claude Code 的非交互 prompt：

```bash
starling run --config kimi claude -p "总结这个项目的结构"
```

跳过权限确认：

```bash
starling run --config kimi claude --dangerously-skip-permissions
```

同时使用 Starling catalog 和 Claude 原始参数：

```bash
starling run \
  --config kimi \
  --catalog paper-review \
  --title "Kimi paper review" \
  claude \
  --dangerously-skip-permissions \
  -p "检查 README 是否完整，并给出修改建议"
```

规则很简单：

```text
starling run [Starling 参数] claude [Claude 原始参数]
```

## 配置文件放在哪里

Claude profile 存放在：

```text
~/.starling/settings/claude/<name>.json
```

例如：

```text
~/.starling/settings/claude/kimi.json
~/.starling/settings/claude/ds.json
~/.starling/settings/claude/glm-5.2.json
```

查看已有模型配置：

```bash
starling model ls --agent claude
```

新增模型配置：

```bash
starling model add kimi --agent claude
```

也可以在 VS Code 扩展的 `Models` 区域创建或查看配置文件。扩展会打开配置模板，你填写 provider、model、api key 等内容后保存即可。

## 添加 Claude 模型配置

### 在 VS Code 扩展中添加

推荐从扩展里添加配置：

1. 打开 Starling 侧边栏。
2. 找到 `Models` 区域。
3. 点击添加模型配置，或在 `Claude` 分组上右键添加。
4. 选择 Claude。
5. 输入配置名，例如 `kimi`。
6. Starling 会生成一个 Claude 配置模板并在 VS Code 中打开。
7. 按你的 provider 填写模型名、base URL、API key、权限等配置。
8. 保存文件后，回到 `Models` 刷新即可看到新配置。

配置名就是之后 `--config` 使用的名字：

```bash
starling run --config kimi claude
```

### 用 CLI 添加

也可以用命令创建 Claude profile：

```bash
starling model add kimi --agent claude
```

如果已经知道模型、接口和 key，可以直接传入：

```bash
starling model add kimi --agent claude \
  --model kimi-k2.7-code \
  --base-url https://api.example.com \
  --api-key "$API_KEY"
```

创建后查看：

```bash
starling model ls --agent claude
```

打开配置文件继续手动调整：

```bash
code ~/.starling/settings/claude/kimi.json
```

Claude profile 是普通 JSON 文件。你可以为不同模型建立多个文件：

```text
~/.starling/settings/claude/kimi.json
~/.starling/settings/claude/ds.json
~/.starling/settings/claude/glm-5.2.json
```

然后按名字切换：

```bash
starling run --config kimi claude
starling run --config ds claude
starling run --config glm-5.2 claude
```

## Catalog 归档

切换模型时，建议同时把 session 放到 catalog，后续对比不同模型会更清晰：

```bash
starling catalog create paper-review
starling run --config kimi --catalog paper-review claude
starling run --config ds --catalog paper-review claude
starling run --config glm-5.2 --catalog paper-review claude
```

查看 catalog 下的 session：

```bash
starling catalog show paper-review
```

在 VS Code 扩展里，也可以直接从 `Catalog` 区域查看这些 session，并右键恢复、查看详情、打开项目目录或复制 session ID。

## 一个常见工作流

1. 在 `Models` 里准备 `kimi`、`ds`、`glm-5.2` 等 Claude profile。
2. 在 `Catalog` 里创建一个 catalog，例如 `paper-review`。
3. 从 VS Code 扩展中右键某个模型启动 Claude。
4. 或者用 CLI 启动：

```bash
starling run --config kimi --catalog paper-review claude -p "审阅这篇论文项目"
```

5. 运行结束后，在 `Catalog` 或 `Sessions` 中查看结果。
6. 换另一个模型重复运行：

```bash
starling run --config ds --catalog paper-review claude -p "审阅这篇论文项目"
```

这样就可以在同一个项目、同一个 catalog 下，对比不同模型的 Claude Code session。

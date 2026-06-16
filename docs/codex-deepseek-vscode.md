# 使用 Starling VS Code 扩展接入 DeepSeek Codex 模型

Starling 可以把 Codex 的模型配置保存成独立 profile，然后在 VS Code 侧边栏里直接选择 DeepSeek profile 启动新的 Codex session。这样不需要反复修改 `~/.codex/config.toml`，也不会覆盖 Codex 的默认配置。

这篇教程主要介绍 VS Code 扩展用法。命令行方式放在后面，用于验证和排错。

## 安装

### 安装 Starling CLI

Starling 的 npm 包名是 `starling-ai`，安装后提供 `starling` 命令：

```bash
npm install -g starling-ai
starling --version
```

如果系统里已有本地开发版链接，可以先确认当前命令来源：

```bash
which starling
starling --version
```

### 安装 VS Code 扩展

在 VS Code 扩展市场搜索：

```text
Starling Agent
```

扩展标识：

```text
huangsh.starling-ai
```

扩展会调用本机的 `starling` CLI。如果 VS Code 找不到命令，在设置里指定：

```json
{
  "starling.cliPath": "/home/shuang/.nvm/versions/node/v22.17.0/bin/starling"
}
```

如果 Starling 数据不放在默认 `~/.starling`，也可以指定：

```json
{
  "starling.homePath": "/data20T/shuang_home"
}
```

## 在扩展里添加 DeepSeek 模型配置

打开 VS Code 左侧的 Starling 视图，会看到：

```text
Catalog
Projects
Models
Sessions
```

推荐从 `Models` 区域创建 Codex profile：

1. 展开 `Models`。
2. 在 `codex` 分组上右键。
3. 选择添加模型配置。
4. 输入配置名，例如 `deepseek` 或 `ds`。
5. Starling 会创建一个 TOML 模板并在 VS Code 中打开。
6. 按 DeepSeek 信息填写 `model`、`base_url` 和 API key。
7. 保存文件。
8. 回到 Starling 侧边栏，刷新 `Models`。

配置名就是之后启动时选择的 profile 名。例如配置名是 `deepseek`，等价 CLI 是：

```bash
starling run --config deepseek codex
```

## DeepSeek Codex profile 示例

Codex profile 存放在：

```text
~/.starling/settings/codex/<name>.toml
```

如果设置了 `starling.homePath` 或 `starling config set home`，则存放在对应 Starling home 下：

```text
<starling-home>/settings/codex/<name>.toml
```

DeepSeek 示例：

```toml
model_provider = "deepseek"
model = "deepseek-v4-pro"
model_reasoning_effort = "high"
disable_response_storage = true
api_format = "openai_chat"

[model_providers.deepseek]
name = "deepseek"
base_url = "https://api.deepseek.com"
wire_api = "responses"
requires_openai_auth = true
api_format = "openai_chat"
experimental_bearer_token = "sk-..."
```

需要关注的字段：

- `model_provider`：当前 profile 使用的 provider 名字。
- `model`：DeepSeek 模型名。
- `model_reasoning_effort`：Codex 推理强度，可按需要设置为 `low`、`medium`、`high`。
- `base_url`：DeepSeek API 地址。
- `api_format = "openai_chat"`：告诉 Starling 使用 Chat Completions 兼容适配。
- `experimental_bearer_token`：当前 profile 使用的 API key。

不要把真实 API key 提交到 Git 仓库。

## 为什么要设置 `api_format = "openai_chat"`

Codex 原生更偏向 OpenAI Responses API。但很多第三方 OpenAI-compatible 服务，包括常见 DeepSeek 接入方式，实际更稳定的是 Chat Completions 格式。

Starling 看到 Codex profile 里有：

```toml
api_format = "openai_chat"
```

会在运行 Codex 时启动本地适配器，把 Codex 的工具调用请求转换成上游 Chat Completions 更容易接受的格式，再转发到 DeepSeek。

运行时如果看到类似信息：

```text
Starling Codex adapter: routing deepseek via http://127.0.0.1:<port>/v1
```

说明 Starling 已经启用了本地适配器。

## 从 VS Code 启动 DeepSeek Codex

在 Starling 扩展里：

1. 打开 `Models`。
2. 展开 `codex`。
3. 找到 DeepSeek profile，例如 `deepseek`。
4. 右键该模型。
5. 选择启动新的 Codex session。
6. 如果需要归档，选择 catalog，或启动后在 session 上右键加入 catalog。

启动后可以继续在 Starling 侧边栏里：

- 在 `Sessions` 查看新会话。
- 在 `Catalog` 查看归档后的 session。
- 右键 session 恢复、打开项目、复制 session ID、查看详情。

## 同时归档到 Catalog

如果你想把 DeepSeek Codex 的运行结果直接归档到某个 catalog，可以在启动时选择 catalog。

CLI 等价命令：

```bash
starling run --config deepseek --catalog codex-deepseek codex
```

Starling 参数放在 `codex` 前面，Codex 原始参数放在 `codex` 后面：

```bash
starling run --config deepseek --catalog codex-deepseek codex exec "总结这个项目"
```

规则是：

```text
starling run [Starling 参数] codex [Codex 原始参数]
```

## 查看和编辑模型配置

在扩展里：

1. 打开 `Models`。
2. 展开 `codex`。
3. 右键 DeepSeek profile。
4. 选择查看或编辑 model setting。

也可以用 CLI 查看：

```bash
starling model ls --agent codex
```

删除不再需要的 profile：

```bash
starling model delete deepseek --agent codex
```

## 验证 DeepSeek 是否生效

可以先用一个短任务测试：

```bash
starling run --config deepseek codex exec "say hi"
```

或者启动 TUI：

```bash
starling run --config deepseek codex
```

进入 Codex 后问：

```text
你是什么模型？
```

注意：第三方模型有时会根据训练数据自称为其他模型，这不一定代表路由失败。更可靠的判断方式是：

- `starling model ls --agent codex` 显示的 profile source 是否正确。
- 启动时 Codex 顶部显示的 model 是否是 DeepSeek 模型名。
- 是否出现 `Starling Codex adapter: routing ...`。
- 上游 API 控制台是否有对应请求。

## 常见问题

### 1. 提示 Model metadata not found

例如：

```text
Model metadata for `deepseek-v4-pro` not found. Defaulting to fallback metadata
```

这是 Codex 不认识第三方模型的内置 metadata。通常不是致命错误，只是 Codex 无法使用官方模型的上下文长度、能力标签等内置信息。

如果后续请求能正常返回，可以先忽略这个提示。

### 2. 401 Unauthorized

检查 profile 里的 API key：

```toml
experimental_bearer_token = "sk-..."
```

也检查 `base_url` 是否正确：

```toml
base_url = "https://api.deepseek.com"
```

不要把 DeepSeek key 写到错误 provider 的 profile 里。

### 3. 工具调用或 apply_patch 参数错误

第三方模型对工具调用 JSON 的稳定性可能不同。如果出现类似：

```text
failed to parse function arguments
tool apply_patch invoked with incompatible payload
```

优先确认 profile 使用了：

```toml
api_format = "openai_chat"
```

如果仍然频繁出现，说明该模型对长时间 agentic tool use 的兼容性不足。可以换更稳定的 DeepSeek/Codex profile，或把任务拆小。

### 4. VS Code 里看不到新 profile

刷新 Starling 侧边栏的 `Models`。

如果仍然看不到，检查配置文件路径：

```bash
starling model ls --agent codex
```

如果扩展配置了自定义 Starling home，确认 VS Code 设置里的 `starling.homePath` 和 CLI 使用的是同一个路径。

### 5. 不想影响默认 Codex

使用 Starling profile 启动：

```bash
starling run --config deepseek codex
```

不要直接修改 `~/.codex/config.toml`。Starling 会为本次运行生成临时 Codex 配置，并在结束后清理，不应该覆盖默认 Codex 配置。

## 推荐工作流

1. 在 VS Code 扩展 `Models` 中创建 `deepseek` Codex profile。
2. 填写 TOML，确保包含 `api_format = "openai_chat"`。
3. 右键该模型启动 Codex session。
4. 需要对比不同模型时，把 session 放入同一个 catalog。
5. 在 `Catalog` 或 `Sessions` 中查看、恢复、复制 session ID。

这样 DeepSeek、默认 Codex、其他第三方模型可以并排存在，通过 Starling 侧边栏一键切换。

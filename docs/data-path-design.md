# Starling 数据路径设计

Starling 不接管 Claude Code、Codex 或 Pi 的原始会话数据。原始 transcript 仍然留在各自工具自己的目录里，Starling 只在 `~/.starling` 下保存本地元数据、模型配置和索引。

## 路径分层

### 原始会话数据

这些目录由 agent 自己维护：

```text
~/.claude/projects/
~/.codex/sessions/
~/.pi/agent/sessions/
```

Starling 只读这些文件，用于发现 session、project、模型和 token 使用信息。删除 Starling 或重新安装 Starling 不会删除这些原始会话文件。

Pi 可以通过 `PI_CODING_AGENT_DIR` 覆盖默认的 `~/.pi/agent` 配置目录。全局历史发现遵循 `PI_CODING_AGENT_SESSION_DIR`、配置目录下 `settings.json` 的 `sessionDir`、最后是配置目录下的 `sessions/`。对于已知 cwd 的受管启动，Starling 使用 Pi 的完整优先级：`--session-dir`、`PI_CODING_AGENT_SESSION_DIR`、`<cwd>/.pi/settings.json`、全局 `settings.json`、默认 `sessions/`。项目级或单次 session root 不会自动成为其他 Starling 进程的全局发现路径；需要跨进程发现时，请同时设置 `PI_CODING_AGENT_SESSION_DIR`。

Linux 上，直接从 Starling 之外启动的 Pi 会在启动后把进程命令行标题改为 `pi`，因此 Starling 无法在进程稳定运行后可靠还原一次性的 `--session` 或 `--session-dir` 参数。默认目录以及环境变量/设置文件配置的目录仍可按 cwd 和 transcript 活动推断；若自定义路径必须被实时监控准确识别，请通过 `starling run`/`starling resume` 启动，或把目录持久配置到 `PI_CODING_AGENT_SESSION_DIR`/`settings.json`。

### Starling 本地数据

Starling 自己的数据放在：

```text
~/.starling/
  session-index.json
  settings/
    claude/
      <profile>.json
    codex/
      <profile>.toml
    pi/
      <profile>.json
```

`settings` 存模型 profile。Pi profile 只保存 `provider`、`model` 和可选的 `thinking`；认证仍由 Pi 自己的 auth/config（例如 `~/.pi/agent/auth.json`、`~/.pi/agent/models.json`）或 provider 环境变量管理。`session-index.json` 是派生索引，可以删除后重建。

Linux/Unix 上受管 Pi writer 的互斥文件位于系统创建的 `/run/user/<uid>/starling/pi-session-locks/`；没有安全 runtime dir 时回退到 OS account home 下的 `.cache/starling/pi-session-locks/`。Windows 使用 Known Folder API 返回的 LocalAppData。这个用户级锁域故意不跟随 `STARLING_HOME`、`TEMP` 等逐进程覆盖，确保不同 Starling metadata home 的进程仍会争用同一把 session 锁。锁文件是持久 sidecar；真正的互斥由 Pi 子进程在 spawn 时继承的 OS 文件锁句柄提供，Pi 退出后自动释放，不会修改原始 transcript。

受管的显式 `pi --session <path>` 只接受已经存在、非空且带有效 session header 的 transcript（v1/v2 也可由 Pi 打开并迁移）。Pi 原生可以为缺失或零字节路径临时生成 ID，但 Starling 在 spawn 前无法据此取得同一把 ID+cwd writer 锁，因此不会替用户预写或覆盖该路径。普通的 `starling run pi` 让 Pi 原生创建 ID；只有调用方需要预先指定 ID 时才使用 `--session-id`。

## session-index.json 结构

索引文件保存四类数据：

```text
sessions     已解析 session 元数据
files        已索引 session 文件路径和 mtime
directories  已扫描目录路径和 mtime
projects     预聚合 project 摘要
```

这样设计的目的：

- `session show/resume` 可以先查索引，避免完整扫描。
- `project ls` 可以直接读取 `projects` 摘要，避免每次聚合全部 session。
- `project show <path>` 只筛选目标 project 的 session，再聚合这个 project。
- `session show <session-id>` 只刷新匹配到的 session 文件。
- 新建 session 文件通过目录 mtime 发现，不需要每次重读全部 jsonl。

## 增量刷新规则

默认视图会调用增量刷新：

```bash
starling project ls
starling project show /path/to/project
starling session ls --cataloged
starling catalog show <catalog>
```

刷新流程：

1. 读取 `~/.starling/session-index.json`。
2. stat 已扫描目录。
3. 如果目录 mtime 没变，只沿着上次索引里的子目录继续检查，不 readdir/stat 普通 session 文件。
4. 如果目录 mtime 变新，检查新增的 `.jsonl` session 文件。
5. 写回新的 `sessions/files/directories/projects`。

默认 project/catalog/session 列表视图不会 stat 所有已索引 session 文件。精确 session 查询会按 ID 刷新对应文件：

```bash
starling session show <session-id>
starling resume <session-id>
```

需要完整重扫时使用：

```bash
starling session index rebuild
```

需要绕过索引排查问题时使用：

```bash
starling project ls --no-index
starling project show /path/to/project --no-index
```

## 性能目标

常见操作应该走索引热路径：

- 展示 project 树：读 `projects` 摘要。
- 展示某个 project：只过滤该 project 的 session。
- 展示 catalog 下 session：通过 catalog metadata 得到 session id，再从 index 精确匹配。
- 展示 session 详情：优先从 index 精确匹配 session id。

只有以下情况需要全量扫描：

- 第一次运行还没有 index。
- 用户显式执行 `--refresh-index` 或 `session index rebuild`。
- 用户显式执行 `--no-index`。
- 索引损坏或缺失。

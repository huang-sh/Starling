# Starling 数据路径设计

Starling 不接管 Claude Code 或 Codex 的原始会话数据。原始 transcript 仍然留在各自工具自己的目录里，Starling 只在 `~/.starling` 下保存本地元数据、模型配置和索引。

## 路径分层

### 原始会话数据

这些目录由 agent 自己维护：

```text
~/.claude/projects/
~/.codex/sessions/
```

Starling 只读这些文件，用于发现 session、project、模型和 token 使用信息。删除 Starling 或重新安装 Starling 不会删除这些原始会话文件。

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
```

`settings` 存模型 profile。`session-index.json` 是派生索引，可以删除后重建。

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

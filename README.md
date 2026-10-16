# task-lines

Split a long task in Claude Code into a main line and side lines. Each line runs in its own sidebar session and git worktree. A task ledger on disk is put back into the conversation after every compaction, and the coordinator merges each line back into the main working tree.

把很长的开发任务拆成主线和支线，每条线开一个侧边栏独立会话（各自的 worktree）去做。你正在用的会话当协调者，负责计划、写任务书、收汇报、合并和验证。

长任务一直在一个对话里做，对话会被一次次压缩，细节就丢了。task-lines 的做法是：

- **每条线只装一段上下文**：主线按阶段切成 L1、L2……，支线是 S1、S2……，各在一个新会话里从头做到尾。
- **细节落在账本里**：用户原话、已定的决定、线表、合并记录都写在 `~/.claude/mods-data/task-lines/boards/<账本 id>/`。对话被压缩后，插件把账本放回上下文：协调者拿回 board.md 和 log.md 的最新部分，线拿回自己的任务书和进度。
- **合并不碰你的分支**：开线前给主目录拍一个快照当基线（包括没提交的改动），线做完后按文件三方合并回主目录的工作区。暂存区、HEAD 和分支都不动，提不提交由你决定。

## 安装

在终端里的 Claude Code 会话中输入：

```
/plugin install task-lines --marketplace 1017293270/claude-task-lines
```

提示添加 marketplace 时输入 `y`，再选安装范围。

在 shell 里：

```bash
claude plugin install task-lines --marketplace 1017293270/claude-task-lines
```

## 要求

- **Claude 桌面端的 Code 标签页**。开线靠桌面端的 `spawn_task` 卡片，线和协调者之间靠桌面端的会话消息。
- **项目是 git 仓库**，而且是你在桌面端打开过的项目。
- 合并脚本用 bash 和 git，macOS 自带的 bash 3.2 就能跑。

## 用法

在协调者会话里输入：

```
/task-lines:lines <要做的事>
```

Claude 会按 skill 里的手册做：

1. 建账本，把你的原话逐字记下来。
2. 侦察代码，拆线，拍基线快照。
3. 给每条线写任务书，每条线出一张卡片。
4. 你点卡片，开出线的会话。线照任务书干活，做完把汇报发回协调者。
5. 协调者预演合并、审查、合并、在主目录跑检查，然后记进账本。

拆完直接开工，不等你批准计划。你随时可以叫停或改需求，也可以直接进线的会话跟它聊。

其他命令：

- `/lines`：看本会话挂着的账本。
- `/lines list`：列出所有账本。

## 里面有什么

| 文件 | 作用 |
| --- | --- |
| `skills/lines/SKILL.md` | 协调者手册：怎么拆线、任务书模板、收线与合并、压缩之后怎么接着做 |
| `skills/lines/scripts/snapshot.sh` | 把一个目录的工作区（含未提交和未跟踪的文件）记成一个提交，用作基线，不动暂存区和 HEAD |
| `skills/lines/scripts/merge-line.sh` | 把一条线的改动按文件三方合并回主目录；`--check` 只预演 |
| `hooks/register.ts` | 工具 `task_board`、`task_line_attach`、`task_note`，命令 `/lines`，以及压缩后放回账本的 hook |
| `hooks/ledger.ts` | 账本的路径、格式和放回上下文的内容 |
| `tests/task-lines.test.ts` | `claude plugin test .` 跑的测试 |

## 要留意的

- 线只能开在你在桌面端打开过的项目里。Claude 在临时目录里新建的仓库，桌面端不给建 worktree，点卡片会看到「Couldn't start the suggested task」。原因在 `~/Library/Logs/Claude/main.log` 里，搜 `createWorktree`。
- 线的 worktree 里没有被忽略的目录，比如 `node_modules` 和 Rust 的 `target`，任务书里要写清楚怎么补。
- 两个会话的权限模式不同时，它们之间的消息要先等你批准。
- 基线快照存在 `refs/task-lines/<账本 id>/` 下，不出现在分支列表里。任务结束后用 `git for-each-ref refs/task-lines/<账本 id>` 列出来，用 `git update-ref -d` 删掉。
- 符号链接，以及两边都改了的二进制文件，合并脚本不处理，会列为「需手动处理」。
- 由组织统一管理的 Claude Code 里，自己装的插件不会收到压缩相关的事件，压缩后放回账本这一步就不生效，除非组织把这个插件列进托管设置。账本还在磁盘上，可以让 Claude 自己去读。

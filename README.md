# Pi Friends · 派的伙伴

> 让几个有名字的小伙伴在 Pi 里并行帮你干活：各做各的文件、各有各的会话，你在上方常驻面板看着，最后统一验收。

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

<!-- TODO(截图)：这里放 1 张面板截图 + 1 张多成员工作的 GIF，是本 README 收益最大的一项
| 常驻面板（输入框上方） | 多个成员并行工作 |
|---|---|
| ![面板](docs/images/panel.png) | ![并行](docs/images/parallel.gif) |
-->

## 30 秒看懂

- **并行干活**：一次派出多位小伙伴，各改各的文件，互不等待；主 Agent 继续做自己的事，结果异步返回。
- **看得见**：输入框上方常驻面板，显示每个人在做什么、多久没汇报。
- **有人管**：完成后先待验收，主 Agent 实际检查后才算通过；验收后自动离队。

## 目录

- [快速开始](#快速开始)
- [日常用法](#日常用法)
- [面板与状态](#面板与状态)
- [验收与离队](#验收与离队)
- [名字与身份](#名字与身份)
- [能力与边界](#能力与边界)
- [Provider 与模型](#provider-与模型)
- [可配置的运行策略](#可配置的运行策略)
- [文件协作机制](#文件协作机制)
- [常见问题](#常见问题)
- [安装与开发](#安装与开发)
- [术语表](#术语表)
- [工具接口（给主 Agent）](#工具接口给主-agent)
- [许可证](#许可证)

## 快速开始

```bash
# 从 GitHub 安装
pi install https://github.com/whoamihappyhacking/pi-friends

# 本机开发目录可以直接安装
pi install /path/to/pi-friends
```

装好后在 Pi 里直接说人话即可，例如「派两位小伙伴，一位调整导航，一位修复表单」。已有 Pi 窗口用 `/reload` 加载修改，新窗口直接生效。

> ⚠️ 不要同时启用旧的子代理插件。旧包和历史数据可以保留，只从 Pi 的启用配置里移除旧包。

## 日常用法

不需要记命令，直接说：

> 派两位小伙伴，一位调整导航，一位修复表单。使用必点 AI，分别用 glm-5.3-flash 和 qwen3.8-flash。不要改同一个文件，改完告诉我验证结果。

> 看看大家的进度；平时只更新上方面板，最后统一告诉我。

> 告诉🙂沈，注意保留键盘导航。

> 🙂沈做完之后，再让他处理侧栏。

> 😎陈这项任务改成静默，完成再通知。

> 停止🤓许的任务。

> 验收通过，让🙂沈离开。

> 验收失败，让他离开，保留失败原因。

> 让😎陈离开。

可选 `/f` 打开成员列表：选人后查看详情、补充要求、追加任务、切换静默或停止。当前菜单是键盘选择，不需要填写 JSON，也不占用 Pi 自带快捷键。详情是只读快照：编辑详情窗口内的文本不会发给小伙伴。

## 面板与状态

面板默认出现在输入框上方，只显示尚未结束的任务，每 5 秒刷新一次，没有标题行或状态图标。每行三列，按终端显示宽度对齐竖线：

```text
🙂沈 | 04分 | 跑全量测试 (3/5 包)
😎陈 | 25秒 | 在改 debug_settings.go
```

长活在上，名字深绿；短活在下，名字浅绿。颜色只作用于头像与姓氏。秒数按 5 秒一跳显示 `05秒` 至 `55秒`，满一分钟只显示补零分钟（如 `01分`、`38分`），超过 99 分钟改为 `1时40` 等小时格式。普通时间列为三个字符、四个终端格；出现小时格式时整列扩宽一格，以保持竖线对齐。

完成、报错和主 Agent 主动停止的成员立即退出面板，各弹一次通知；完成名字金色，报错名字红色。通知去重记录独立保存，list/wait 消费结果及重新加载不会导致重复弹出。`/f` 详情仍能查看完整名字、ID、结果、模型、文件与消息记录。

## 验收与离队

成员完成后先待验收。主 Agent 实际检查后调用 accept 或 reject，插件自动离队；**不会从一段聊天文字猜测验收结论**。主动遣散用 dismiss，也可在 `/f` 里选择验收通过、验收失败或请他离开。

| 操作 | 效果 | 成员是否还在队 |
|---|---|---|
| `stop` | 停止当前任务 | ✅ 保留，可继续派活 |
| `accept` / `reject` | 通过 / 不通过并记录原因 | ❌ 自动离队 |
| `dismiss` | 主动遣散（如用户取消任务） | ❌ 自动离队 |

离队成员从常驻面板、默认列表和 `/f` 菜单移除，正在运行的进程终止，待处理消息取消。修改文件、完整结果、会话及离开原因保留，`list` 的 `history=true` 或指定原 ID 可查。离开后不再接受续派，应派新成员。

模型调用失败本身仍显示「失败」等待主 Agent 处理，不会冒充「验收失败」。

## 名字与身份

- 面板身份使用指定的 30 个头像 × 20 个姓氏，共 600 种组合；在队成员之间不重复，优先分配不同脸与不同姓。身份随成员持久化，改完整昵称不会改变头像姓氏。
- **对外称呼统一使用 `displayName`（如 `😀陈`），与常驻面板一致。** 以前工具返回的完整 `name`（如 `褚二五`）与面板名字不同，容易让主 Agent 和用户对不上人。现在 spawn/list/wait/send/stop/accept/reject/dismiss，以及 quiet/model 的成员返回都提供 `displayName`，返回文本、完成通知、checkDue 提醒与 `/f` 菜单优先使用它；`models` 返回的是模型目录，不涉及成员命名。
- 完整人名仍在派发时分配，不依赖模型记住命名要求；`name` 保留在工具 `details`、`list history=true`、指定成员的列表与 `/f` 详情中，连同内部 UUID 可查。默认 list/wait 文本只展示 `displayName` 作为名字，向用户交流不要改叫 `name`。旧记录加载时自动补齐 `displayName`。
- 完整人名只是内部昵称：启动时随机分配不重名的人名，小伙伴可自己另选；同一会话续派保留身份，对外仍使用 `displayName`。
- 内部 UUID 才是真实身份，名字不固定绑定技能、任务或模型。历史同名成员以 UUID 区分，按人名操作时优先匹配**当前在队**成员。
- 已离队成员不再占用名字，新成员可复用；候选池用完后生成普通人名，不使用「伙伴1、伙伴2」编号。`displayName` 也可能复用，因此旧任务与新任务请按返回的 UUID 区分，历史操作优先传 UUID；本轮保留现有分配策略，没有加入名字冷却期。

## 能力与边界

### 隔离与并发
- 每位小伙伴是独立 Pi RPC 子进程；只显式加载本包的 `worker.ts`，禁用其它扩展发现与提示词模板，绝不调用旧 `pi-subagents`。技能默认关闭，可设置 `skills=true` 允许 Pi 发现技能。
- 默认最多 4 个子进程，最多 16 个未完成任务，超额排队。主 Agent 继续工作，子代理结果异步返回。
- 运行时仍仅加载本插件的子代理工具，不自动加载其它扩展，也不会递归派代理。

### 进度与通知
- 派发前主 Agent 必须指定 `taskType=long` 或 `short`。长活前 5 分钟在第 2、4 分钟检查；之后在第 10、15、20…分钟检查，并每次主动向用户汇报一句。短活每分钟检查，不向用户播报；发现卡住或重复时由主 Agent 直接 stop。
- 到期只发一条隐藏 `checkDue` 提醒并唤醒主 Agent，不向子代理堆积催报。主 Agent 调用 list/wait 获取最新状态并确认检查，重新安排下一次检查；也可随时 list/send，stop 须遵守下述二次验证规则。
- 完成、失败、阻塞和主动停止会唤醒主 Agent 收尾；主 Agent 已通过 list/wait 收到的结果不再重复推送。模型切换仅提供隐藏上下文。
- 派出伙伴后，主 Agent 在每次模型调用中都会收到隐藏的收尾规则：除非用户明确要求后台继续，最终回复前应先等待伙伴、检查交付、验收或处理异常，再只向用户发送一次合并总结。该规则在 spawn 后的同一轮也生效。
- `friends` 工具调用使用无边框的一行提示；成功结果不另铺大块内容，详细数据只进入主 Agent 上下文，错误保留一行提示。常驻面板仍是用户观察状态的主要位置。
- `quiet` 保留兼容；主 Agent 的长短任务检查职责不受静默开关影响。检查提醒本身不向用户展示，是否主动汇报由任务类型决定。

### 停伙伴前的二次验证

短活每分钟检查；发现卡住或重复可直接 `stop`，不加确认步骤。长活停止前必须先 `friends send` 询问当前状态，等待伙伴回应或至少一轮检查后，再结合工具活动判断。`delivered` 只说明消息已送达。判断依据是 `lastActivityMs`、`toolElapsedMs`、`lastToolOutcome`、`interruptions` 和具体重复/跑偏行为；`noProgressMs` 只表示阶段汇报的间隔，读大文件、写长报告时几分钟没汇报很正常。只有确信跑偏、重复或工具长时间无响应才停止，`reason` 必须写清问询后的结论与证据。

运行时 `Team.stop` 强制保护所有调用入口：

- `taskType='long'` 且 `lastActivityMs < 180000` 时，默认拒绝停止，返回 `isError=true`、`code='LONG_TASK_STOP_VERIFICATION'`、`requiresConfirmation=true` 及 `evidence`（活动间隔、工具耗时、当前/最近工具、无进度间隔和失败/中断记录）。拒绝不终止进程、不取消消息、不改变任务状态。
- 完成上述二次验证后，确需停止最近仍有活动的长活，必须显式传布尔值 `confirm=true`，同时提供非空 `reason`；未填写 reason 仍拒绝。确认是调用方依据证据作出的覆盖决定，插件不判断理由的语义是否真实，也不自动证明已完成问询与等待。
- 长活 `lastActivityMs >= 180000` 可在填写证据 reason 后直接停止；没有最近活动时间记录时按仍有活动处理。门槛从不读取 `noProgressMs`，也不会自动停止成员。
- 长活实际停止时保留完整 `stopReason`（最多 2000 字符）及 `stopEvidence` 快照与 `confirmed`，摘要仍为短文本。短活维持原有直接停止行为，无需 reason 或 confirm。
- `/f` 的长活停止同样经过运行时保护：先填写证据，最近仍有活动时再显示确认；取消确认则继续运行。

例如，`noProgressMs=159000`、`lastActivityMs=31000` 的长活会被拒绝停止。先发状态问询并等一轮；仅在确有重复/跑偏等证据时明确确认，不能因为进度栏没刷新就确认停止。

### 消息与结果
- `send` 默认排下一项任务，`steer` 才在工具结束后干预当前任务；消息分别记录 pending / delivered / read / rejected / cancelled。read 表示进入子代理会话，**不保证模型已经正确执行了要求**。
- 结果保存为待主 Agent 验收；主 Agent 应检查组合后的效果。没有自动保证「所有检查已通过」。

### 失败与超时
- 插件不再设置成员任务截止时间，也不再给 `friend_exec` 默认 60 秒。主 Agent 可以针对某条命令显式指定 `timeout` 秒；省略即不限时。
- 命令结果保留 `killed`、`timedOut` 与 `signal`。超时、被信号终止、正常非零退出分别返回可读错误和 `failureKind=timeout/killed/exit`；任何 killed/信号终止都失败，即使底层给出 `code=0`。
- **普通工具失败无论连续多少次都不会自动停止任务，长活与短活相同；没有额外的次数兜底。** `failures` 继续记录普通工具的连续失败次数，普通工具成功后归零；`lastToolOutcome` 保留最近工具、时间与失败信息，`lastError` 仍保留模型错误。超时与被杀计入独立 `interruptions.timeout/killed`，不增加也不重置普通错误次数。
- 主 Agent 依 `list` / `wait` 中的 `failures`、`lastToolOutcome`、`lastError` 和工具活动判断是否继续；`checkDue` 同时提示当前 `failures` 与 `lastToolOutcome`。停止须由主 Agent 主动操作，并遵守现有长活二次验证规则；模型调用报错、子进程崩溃及成员自行结束仍走原有流程。
- 旧 `maxToolFailures` 配置已废弃并忽略，即使保留 `3` 也不会恢复次数自动停止。

### 会话与恢复
- 每人保留自己的 Pi 会话和简短任务上下文。跟进任务复用会话，Pi 自身处理自动上下文压缩。不会默认复制主 Agent 的全部聊天历史。
- `/reload` 或正常退出时，运行中任务停止并记为「已中断」；恢复同一个主会话后可用同一名字继续。**不会假装从某一条 shell 指令的中间自动断点续跑。** 新建一个无关的主会话不会自动接管旧团队。
- 意外崩溃后再次打开原团队，会检查之前记录的子进程身份并停止遗留进程，然后标为中断。此清理在 Linux 上实现；文件、会话和最后进度保留。

## Provider 与模型

插件不内置任何 Provider 或模型名。选择顺序为：

1. 派发时显式指定的 provider/model
2. 本机配置
3. 主会话当前模型

显式选择时**必须同时提供 provider 和 model**，防止把两个来源拼成无效组合。`friends models` 默认列出全部可用模型，也可按 Provider 筛选。

thinking 优先使用显式参数，其次 `modelDefaults[provider][model].thinking`；使用配置默认模型时也可设置顶层 thinking。均未设置则交给 Pi 处理。插件不覆盖显式档位，也不内置厂商兼容分支。

插件本身不硬编码启用备用模型。默认配置位于 `~/.pi/agent/friends/config.json`：

```json
{
  "provider": "openai-codex",
  "model": "gpt-5.6-sol",
  "fast": true,
  "modelDefaults": {
    "openai-codex": {
      "gpt-5.6-sol": { "thinking": "xhigh", "fast": true }
    }
  },
  "maxConcurrent": 4,
  "progressMs": 60000,
  "stallMs": 180000,
  "timeoutMs": 1800000
}
```

> 上面是当前这台机器的个人配置，不是插件代码中的默认值。

当前未配置自动备用模型。需要时可另加 `fallback`；`fromProvider` 可限定哪些来源允许切换，省略则适用于任何来源，目标 Provider、模型及档位均由配置提供。模型需在 Pi 中已配置且可用。登录和 API 凭据由 Pi 管理，本插件不复制凭据。

## 可配置的运行策略

以下字段均放在本机 `friends/config.json`；省略时使用表中默认值，非法值报错，不暗中改值。

| 字段 | 默认 | 含义 |
|---|---|---|
| maxConcurrent | 4 | 并发进程数，正整数，无隐藏的 8 人上限 |
| maxTasks | 16 | 新派发时的未完成任务额度，0 不限制 |
| maxToolFailures | 已弃用，忽略 | 旧配置不再生效；工具失败仅记录次数，不会自动停止 |
| timeoutMs | 0 | 已弃用，仅接受旧配置/调用，不再按成员任务总时长停止 |
| progressMs | 60000 | 已弃用，长短检查节奏由 taskType 决定 |
| stallMs | 180000 | 已弃用，无进展作为 list/wait 异常提示交给主 Agent 判断 |
| namePool | 内置示例人名 | 可替换候选池；空数组或候选占用时自动生成普通人名，不使用编号 |
| skills | false | 是否允许子代理发现 Pi 技能 |

`friend_exec` 不设默认超时；`timeout` 单位秒，由主 Agent 依任务长短显式指定。协作规则仍要求声明写入路径，命令工具可执行任务需要的操作，不限于测试。list/wait 提供 `displayName`、任务类型、运行时长、当前工具及工具耗时、距阶段汇报时长、下一次检查时间、异常提示、`failures`、`interruptions`、`lastToolOutcome` 与 `lastError`。

> 状态保存在 `~/.pi/agent/friends/`，可用 `PI_FRIENDS_HOME` 覆盖（测试用它隔离数据）。

## 文件协作机制

- 主 Agent 和小伙伴的 read/edit/write 都有文件占用检查。现有文件必须先 read，写入前检查内容 SHA-256；读后发生变化时拒绝旧快照写入，重新读取后才能再改。符号链接按真实路径协调。
- 共享记录包含修改人、时间、摘要、前后指纹，保留最近 30 次变更。
- 文件锁覆盖**一次工具操作**，避免同一时刻覆盖；它不是长期的任务分工预留。主 Agent 仍应按文件拆任务。
- 子代理的 `friend_exec` 用于测试命令，必须声明预计写入的 `writePaths`；工具为声明的文件加锁并记录变化。

> **这是一套可信 Agent 之间的协作机制，不是操作系统沙箱。** shell 命令可以产生未声明的写入，外部编辑器也不会遵守锁；这些情况无法保证拦截。两个代理写不同文件造成的逻辑冲突同样需要主 Agent 验收。

## 常见问题

**会和我以前的子代理插件冲突吗？**
会。不要同时启用旧插件；旧包和历史数据可以保留，只从启用配置里移除旧包。

**子代理会不会再派子代理？**
不会。子代理只加载本包的 `worker.ts`，禁用其它扩展发现，也不会递归派代理。

**面板上一直没更新，是卡住了吗？**
用 friends list 查看阶段进度、当前工具、工具耗时和异常提示。`noProgressMs` 不能单独用来判断卡死；长活停止前先 send 询问并等一轮，近 3 分钟仍有活动时插件会拒绝直接停止，返回证据并要求显式确认。命令持续输出不等于取得阶段进展；插件不会因达到固定任务时长而自动停止。

**能让不同小伙伴用不同模型吗？**
可以。派发时同时指定 provider 和 model，例如「一位用必点 AI 的 glm-5.3-flash，一位用 qwen3.8-flash」。

**Pi 崩了 / 我 `/reload` 了，任务怎么办？**
运行中任务停止并记为「已中断」，恢复同一个主会话后可用同一名字继续。不会从某条 shell 指令中间自动续跑，需要重新说明剩余目标。

**小伙伴会改到我正在编辑的文件吗？**
同一时刻的写入会被文件锁和 SHA-256 校验挡住；但这不是沙箱，外部编辑器和未声明的 shell 写入不受保护。建议按文件拆任务。

## 安装与开发

见 [快速开始](#快速开始)。开发相关：

```bash
npm run check  # 编译全部 TypeScript；本项目未配置静态类型检查
npm test
npm run preview  # 输出 ANSI 渲染样例并写入 /tmp/pi-friends-ui-preview.txt
# 无默认超时的真实 61 秒命令验证，须在后台运行：
node test/no-deadline.mjs
# 同一 Pi 进程更新重载、菜单与工具遣散回归，不调用模型：
node test/reload-live.mjs
# 以下是真实模型调用，会使用账户额度：
node test/live.mjs
node test/parent-live.mjs
```

`test/live.mjs` 派四位子代理修改导航、表单、弹窗和移动端 CSS，并验证静默、文件记录和继续会话。`test/parent-live.mjs` 让真实主模型调用本包的 friends 工具派出两人，检查算术修复、结果汇总、TUI widget 事件及旧插件没有参与。

实现使用 Pi 官方 RPC 与扩展接口，不依赖第三方子代理包：

- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md

直接运行测试需要 Node >=22.18。内部运行模块使用 `.ts`，以便 Pi 的 `/reload` 重载更新，避免 Node 原生 `.mjs` 缓存导致入口与运行模块版本不一致（详见 TESTING.md）。

## 术语表

| 术语 | 含义 |
|---|---|
| 小伙伴 / 成员 | 插件派出的一个子代理进程（独立 Pi RPC 子进程） |
| 主 Agent | 你正在对话的这个 Pi 会话，负责派活和验收 |
| `/f` | 成员列表菜单，可查看详情、追加任务、静默、停止、验收 |
| `send` / `steer` | 追加下一项任务 / 在工具结束后干预当前任务 |
| `friend_exec` | 子代理执行 shell 命令的工具，必须声明 `writePaths` |
| `writePaths` | 这次命令预计会写入的文件路径，用于加锁和记录 |
| `/reload` | Pi 重新加载扩展；运行中任务会停止并记为「已中断」 |
| 待验收 | 成员已完成，但主 Agent 尚未实际检查 |

## 工具接口（给主 Agent）

只有 `friends` 一个主工具。action 为 spawn / list / wait / send / stop / quiet / models / model / accept / reject / dismiss。

```json
{"action":"spawn","taskType":"short","task":"修复导航","provider":"bai","model":"qwen3.8-flash","context":"只改 nav.css；窄屏不横向溢出"}
{"action":"send","id":"🙂沈","message":"注意保留键盘导航","mode":"steer"}
{"action":"send","id":"🙂沈","message":"完成后继续侧栏"}
{"action":"send","id":"🙂沈","message":"请报告当前状态、正在执行的工具以及是否有重复尝试","mode":"steer"}
```

长活应先问询并等至少一轮，再检查 `list`；确认工具长时间无响应、跑偏或重复后，填写实际观察到的证据。近 3 分钟仍有活动时，首次停止会返回错误与证据；以下 `confirm=true` 仅用于二次验证后明确覆盖活动保护（数值仅为调用格式示例，不能照抄作证据）：

```json
{"action":"stop","id":"🙂沈","reason":"已问询并等一轮；lastActivityMs=31000，lastToolOutcome.tool=friend_exec；连续三轮重复同一失败命令，已确认跑偏","confirm":true}
{"action":"accept","id":"🙂沈","reason":"检查通过：键盘导航和窄屏布局符合要求"}
{"action":"reject","id":"😎陈","reason":"提交结果未满足表单校验要求"}
{"action":"dismiss","id":"🤓许","reason":"用户取消任务"}
{"action":"list","history":true}
{"action":"model","id":"🙂沈","provider":"openai-codex","model":"gpt-5.6-luna","thinking":"minimal"}
```

## 许可证

[MIT](./LICENSE) © 2026 whoamihappyhacking

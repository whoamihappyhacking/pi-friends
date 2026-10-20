# Pi Friends 0.1.0 验收记录

## 工具失败只记录、对外显示名统一（本轮）

仅修改本插件目录与 `/tmp` 测试产物；没有重启或重载当前会话，没有接触微服，也没有修改用户个人配置。

- 删除 `Team` 构造参数/成员属性中的 `maxToolFailures` 和 `tool_execution_end` 中达到阈值调用 `fail()` 的分支；旧配置值被忽略，没有替代上限。保留普通错误连续计数、成功归零、最近工具结果、模型错误以及独立的超时/被杀计数。
- spawn 和历史记录加载补齐 `displayName`；所有成员工具返回都能取到它，默认文本以面板头像姓氏称呼。完整 `name` 保留在 details、history/指定成员查询及 `/f` 详情。send 同时返回成员 `agentId`，其 `id` 仍是消息回执 ID。完成与 checkDue 提醒、菜单、工具调用提示和拒停错误使用显示名；checkDue 同时附带 failures / lastToolOutcome。
- 注入规则与工具指南明确：工具失败不会自动停止任务，由主 Agent 依 list 中的 failures / lastToolOutcome 判断；向用户称呼使用 displayName。长活二次验证、普通完成、模型报错与子进程异常退出沿用原流程。

后台执行 `npm run check && npm test`，真实日志：`/tmp/pi-friends-failure-name-validation.log`。

```text
PASS TypeScript compilation: 10 source files (esbuild); static type checking is not configured in this project
✔ short: 60 consecutive tool failures keep running (default config), observable and persisted
✔ short: 60 consecutive tool failures keep running (legacy maxToolFailures=3), observable and persisted
✔ long: 60 consecutive tool failures keep running (default config), observable and persisted
✔ long: 60 consecutive tool failures keep running (legacy maxToolFailures=3), observable and persisted
✔ model errors and unexpected child exits still fail after repeated tool failures
ℹ tests 40
ℹ pass 40
ℹ fail 0
VALIDATION_EXIT=0
```

`test/failure-name.test.mjs` 通过本机 Pi 的真实扩展加载器加载独立的 friends 工具，使用 `/tmp` 状态与一个真实 RPC 子进程发送模拟事件；不调用模型、不加载当前团队。short / long 各连续 5 次 read 失败，真实 list 返回字段节选如下（完整 content/details 与 checkDue 原文在上述日志中）：

```json
[
  {"id":"6008c078-1b93-46f8-8eed-89cb6edab996","displayName":"🙂林","name":"褚二五","taskType":"short","status":"running","failures":5,"lastError":"","lastToolOutcome":{"at":1792177868295,"tool":"read","failureKind":"tool","error":"ENOENT simulated-5"}},
  {"id":"344766ea-4153-4140-86c4-611e92cd35d9","displayName":"😀陈","name":"内部长活名","taskType":"long","status":"running","failures":5,"lastError":"","lastToolOutcome":{"at":1792177868344,"tool":"read","failureKind":"tool","error":"ENOENT simulated-5"}}
]
```

已验证：默认/旧配置、long/short 共四组连续 60 次失败仍运行且状态持久化；成功后失败计数归零；模型错误和异常进程退出仍失败收尾；spawn/list/wait/send/stop/accept/reject/dismiss/quiet/model 所有成员返回包含显示名；默认文本与生产面板一致，完整名字仍可在详情查询；旧记录补齐显示名；checkDue/done 提醒与长活拒停使用显示名；原长活二次验证等已有测试均通过。测试中的成员完成/失败事件是模拟事件，不是模型实际交付。

未验证：当前会话重载后是否获得新规则及实际运行时的 UI 表现、真实模型是否据失败记录合理决策；本轮未调用模型或重载当前会话。后续在无运行任务的安全时机加载更新后，应确认 spawn/list/提醒里的 displayName 与面板一致，并观察真实工具连续失败时任务仍继续。check 是 esbuild 编译检查，本项目没有静态类型检查配置。

## 停伙伴前的二次验证（上轮）

仅修改本插件目录；没有重启或重载正在使用的会话，没有接触微服。运行时保护位于 `Team.stop`，`friends stop` 与 `/f` 的停止操作共用：长活 `lastActivityMs < 180000` 默认拒绝，返回结构化证据并要求 `confirm=true`；显式确认仍须非空 reason。长活停止保存证据快照，短活直接停止。注入规则要求长活先 send 问询并等一轮，不能以 noProgressMs 代替工具活动证据。

已在后台执行项目原有命令，日志为 `/tmp/pi-friends-stop-validation.log`：

```text
> npm run check
PASS TypeScript compilation: 10 source files (esbuild); static type checking is not configured in this project
> npm test
ℹ tests 34
ℹ pass 34
ℹ fail 0
VALIDATION_EXIT=0
```

新增 `test/stop.test.mjs` 的 7 项回归覆盖：31 秒前仍有活动且 159 秒没汇报时拒停并保留进程/消息/状态；超过 3 分钟无活动可停；179999/180000 毫秒边界；短活直接停；布尔确认与非空理由；未知活动记录的保护；真实扩展加载器加载隔离的 friends 工具并模拟 stop，同时验证上下文注入与 `/f` 取消/确认。

模拟通过真实插件工具入口执行，但成员和 RPC 子进程是假数据，不调用真实模型。实际返回 `isError=true`、`code=LONG_TASK_STOP_VERIFICATION`、`requiresConfirmation=true`，证据包含 `lastActivityMs=31000`、`noProgressMs=159000`、`activity=read evidence.txt`、`lastToolOutcome.tool=read`，拒绝后成员仍为 running。显式确认并填写证据后返回 stopped，保存 `stopEvidence.confirmed=true`。

验证边界：本项目仍没有静态类型检查配置，check 是 esbuild 编译检查。运行时强制活动门槛、显式确认和非空理由，不自动验证理由的真实性或 send/等待是否真的完成。主模型在真实长活中的规则遵循，以及当前会话在安全重载后获得新参数和保护，仍需后续观察；本轮未触碰当前会话。

## 取消固定超时与面板重做（上轮）

本轮修改限定在本插件目录。未重载当前会话、未调用真实模型、未修改本机个人配置或线上服务。测试使用 `/tmp` 隔离状态和产物。

可复现命令：

```bash
npm run check
npm test
node test/reload-live.mjs
npm run preview
# 超过 25 秒的验证必须后台启动；退出码及日志异步读取：
setsid bash -c 'node test/no-deadline.mjs > /tmp/pi-friends-61s.log 2>&1' >/dev/null 2>&1 &
```

已验证：

- 10 个 TypeScript 源文件经 esbuild 编译通过，父/子插件由本机 Pi 扩展加载器实际加载通过。项目原来只有 `npm test`，没有静态类型检查配置；新增 `npm run check` 是编译检查，不应称为 `tsc` 类型检查。
- 27 项自动化测试通过，覆盖 `killed=true,code=0` 必须失败、真实 SIGTERM、显式命令超时、abort、普通非零退出、两类计数分离、旧成员任务超时不再停止、检查提醒去重和主 Agent 主动停止。
- 真正执行 worker 注册的 friend_exec，不传 timeout，运行 `printf before; sleep 61; printf after`；实测 61.2 秒，返回 `stdout=beforeafter, code=0, killed=false, success=true`。
- 面板覆盖长短排序、四种名字颜色、颜色范围、时间格式与显示格对齐、标题与状态图标删除、已结束成员移除、600 种头像姓氏不重复；父插件通知覆盖完成/报错/主动停止，每个 revision 只弹一次，list 与再次加载不重复。
- 原有 `node test/reload-live.mjs` 同进程更新、菜单遣散、工具验收和 widget 移除回归通过。
- `npm run preview` 使用生产 `renderPanel` 生成带 ANSI 颜色的文本，留在 `/tmp/pi-friends-ui-preview.txt`。这是固定样例数据的真实渲染，不是当前用户会话的实况。

策略细节：

- 命令执行保留 `killed/timedOut/signal`，判定顺序为 timeout、killed/signal、普通非零退出。被杀却报告 code=0 时将 code 改为 null，并返回 success=false、isError=true。进程组取消与 SIGKILL 收尾避免遗留子进程；只在主 Agent 显式指定命令 timeout 时设置计时器。
- 普通错误只累计 failures，阈值仍为 maxToolFailures=3；超时和被杀分别累计 interruptions.timeout/killed，不增加也不重置普通错误次数。
- 旧 timeoutMs/progressMs/stallMs 参数保留解析兼容，不再自动结束成员或催报。spawn 必须由主 Agent 指定 long/short；长活在第 2、4 分钟检查，第 5 分钟后进入五分钟刻度，随后第 10、15…分钟检查；短活每分钟检查。只提醒大哥查看，不自动停止子代理。list/wait 确认检查并给出新的下一次检查时间。
- 时间规格同时给了“超过 99 分才用小时”和示例 `1时02`（62 分钟），两者无法同时作为 elapsed 输出。实现遵守明确阈值：62 分显示 `62分`、100 分显示 `1时40`；小时格式函数单测覆盖 `1时02`。新任务首个不足 5 秒的区间显示 `05秒`，避免出现规格未列出的 `00秒`。

仍需真机观察：用户终端中深浅绿色的观感、emoji 字体实际占宽，以及主模型在真实长任务里是否按隐藏提醒逐次检查并主动汇报。提醒和调度已经确定性测试；本轮没有等待真实模型运行 10 分钟以上，也没有重载正在使用的会话。

以下为历史版本验收记录，旧超时/面板策略不代表当前实现。

## 人名、对话降噪与收尾顺序（2026-09-07）

确认编号名来自同一团队 44 条历史记录长期占用候选池，并非模型遗忘。离队名现可复用，当前成员按人名优先解析；内置候选用尽后生成普通人名，不再退回“伙伴N”。所有自动状态消息改为 display=false 的紧凑隐藏上下文，工具结果取消 Markdown 表格；friends 工具用无边框单行渲染，成功后不铺结果块，错误显示一行。状态观察留在常驻面板。主 Agent 的收尾规则通过系统提示和每次模型调用的非持久上下文同时注入，spawn 后同一轮也覆盖：默认先等待、检查、验收和离队，再作一次合并总结；用户明确要求后台继续时除外。10 项自动化测试和同进程加载测试通过，未调用真实模型。

## 遣散 TypeError 修复（2026-09-05）

确认 `t.depart is not a function` 来自同一 Pi 进程重载时缓存了旧 .mjs 运行模块。内部模块改为由 Pi 扩展加载器重新编译的 .ts，菜单异常也转换为界面错误提示。`node test/reload-live.mjs` 使用本机 Pi 扩展加载器，先复现 .mjs 缓存旧类，再在同进程加载修正版，实际执行 `/f` 遣散处理及工具 accept/reject，检查成员归档和面板移除，全部通过；未调用模型。

## 成员离队（2026-09-05）

新增 accept/reject/dismiss 与 `/f` 离队入口。9 项自动化测试通过，覆盖未完成不能验收通过、通过后自动离队、失败离队、运行中遣散与排队取消、完整结果保留、重复离队幂等、拒绝离队后续派/切模型、刷新不复活。新增功能本轮未调用真实模型；自动验收依赖主 Agent 检查后调用相应工具，插件不会解析聊天文字或自报完成来猜测验收结论。

## 固定策略审查（2026-09-05）

并发数、任务额度、连续错误阈值、人名候选、技能发现改为可配置；超时支持 0 禁用及逐任务设置。命令超时取消 120 秒封顶。最新结果与消息记录不再按固定长度静默丢弃。8 项自动化测试通过，新增覆盖 9 位并发、自定义人名、技能启用、错误阈值禁用、长任务不限时及普通超时仍生效。此轮不重复消耗真实模型额度。

## 模型配置修正（2026-09-05）

移除运行代码中的具体 Provider/模型默认值、厂商限流条件及 GLM 档位覆盖。模型从派发参数、本机配置或当前主会话解析。7 项回归测试通过，覆盖任意 Provider、参数优先级、不完整参数拒绝、显式档位不覆盖，以及其它厂商触发配置备用。此前的真实模型测试记录见下，属于修正前版本，不代表此轮重新调用过真实模型。

环境：Linux / Pi 0.85.0。测试使用本包 `runtime.ts`（早期为 runtime.mjs）+ `worker.ts`，及真实 Pi 主会话加载 `index.ts`；没有调用旧 `pi-subagents`。

## 自动化测试

`npm test`：7 项测试全部通过。

- 文件占用互斥；旧版本拒写；重新读取后成功；记录修改人、时间及前后指纹。
- 符号链接路径无法绕过同一文件的占用。
- 并发上限与排队；逐成员指定模型；消息送达与已读；续派保持身份；关闭恢复。
- 静默任务不催报；普通任务只保留一条待处理催报；连续工具失败停止。
- 同一父会话禁止重复接管，正常关闭后可恢复。
- 持续 429 时使用授权备用模型，原名字与任务不丢失。
- 模型配置优先级、当前会话继承与显式档位原样保留。

## 真实模型测试

`live-report.json`：通过。

四位子代理同时启动，分别改导航 CSS、表单标签和校验、弹窗无障碍属性、移动端宽度。读取最终文件做确定性断言，四项全部通过；其中一位静默。继续给原导航成员追加对齐要求，同一个名字与 Pi 会话继续成功，消息标记 read，文件记录可查。

这轮均先指定必点 AI：两位 `bai/glm-5.3-flash`、两位 `bai/qwen3.8-flash`。连续 429 后按用户授权切到 `openai-codex/gpt-5.6-luna`，思考 minimal，最终完成。不能据此声称必点 AI 高并发目前稳定。

`parent-live-report.json`：通过。

真实主模型通过本包 friends 工具派出两位小伙伴，修复加法和最大值模块，调用 wait/list 后汇总。测试实际导入修复后的 JS 并执行正负数、顺序等断言。确认工具调用中没有旧 subagent/Agent；收到包含成员名字的 Pi TUI widget 事件。

最后一轮一凡使用 `bai/glm-5.3-flash`、舒淇使用 `bai/qwen3.8-flash`，两位均完成，未切换备用模型。四人前端测试中的限流情况仍保留如上。最终案例文件保存在 cases/。

`control-live-report.json`：通过。

使用授权的 Luna/minimal，给真实子代理一个短暂等待工具。在等待期间发送 steer，确认先 delivered、工具边界后 read，实际文件按新要求写入。再派一个等待任务并停止，确认进程退出、文件保留。关闭运行时后重新创建，恢复同一名字与同一 Pi 会话，继续修改成功。

## 原生 TUI 人工检查

在真实 PTY 中启动 Pi，按正常全局配置加载插件：

- 扩展列表出现 `pi-friends`，不出现旧 `pi-subagents`。
- 输入框上方直接显示 Pi Friends 与已完成成员名字。
- `/f` 打开成员选择，再打开详情/补充/追加/静默/停止菜单。
- `/reload` 后成员记录恢复。
- 初次检查发现快捷键与 Pi 内置搜索冲突，已移除自定义快捷键。
- 初次检查发现中文长摘要换行，已改为按终端显示宽度截断，每人一行。

## 已发现并处理的外部兼容问题

- 必点 AI 频繁 429：显示重试状态；第二次自动重试后启用已授权的 Luna 备用，记录 modelHistory。
- 早期本机 GLM 档位兼容分支已移除；目前只在本机插件配置中设置该模型默认 high，显式参数不被覆盖。

早期失败报告保存在 reports/，用于区分插件逻辑问题和真实 Provider 返回，避免只保留成功样本。

GitHub 仓库不跟踪原始运行报告；报告保留在本机与 Harness 归档中，仓库包含测试脚本、确定性案例和本验收摘要。

## 验证范围

前端案例验证了具体文件修改和目标属性，未进行真实浏览器截图或完整产品视觉验收。文件协调不拦截外部编辑器或 shell 未声明写入；刷新后需要继续派活，不保证从中断指令中间自动续跑。

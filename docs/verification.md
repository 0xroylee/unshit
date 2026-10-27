# 验证记录

验证日期：2026-10-10。环境：macOS arm64，Bun 1.3.8，Codex CLI 0.160.0。以下记录区分平台接入试验、CLI 实际执行与测试夹具。

## Grep 代码搜索

### 接口探测（2026-10-13）

| 检查 | 结果 |
| --- | --- |
| 无会话调用 | `initialize`、`tools/list`、`tools/call` 均直接返回，响应为 `text/event-stream`，没有 `Mcp-Session-Id` |
| 工具与参数 | 只有 `searchGitHub`：`query` 必填；`repo`、`path` 为部分匹配；另有 `language`、`matchCase`、`matchWholeWords`、`useRegexp` |
| 返回内容 | 每次最多 10 条；每条含仓库、路径、指向分支的链接、许可证和带行号片段；不含星数、日期、归档或 fork |
| 仓库内定位 | `alfio-event/alf.io` 搜 `refund`、`osTicket/osTicket` 搜 `class Ticket`、`saleor/saleor` 搜 `refund` 均命中核心实现文件 |
| 索引覆盖 | 限定 `pretix/pretix` 搜 `class OrderRefund` 无结果，而 `src/pretix/base/models/orders.py` 第 2130 行定义了该类 |
| 批量元数据 | 一次 GitHub 搜索 `repo:alfio-event/alf.io repo:osTicket/osTicket repo:saleor/saleor repo:pretix/pretix` 返回 4 个仓库 |

以上为设计阶段的一次手动探测，不属于自动化验证；原始响应保存在仓库之外，其中没有 `tools/list` 输出和批量 GitHub 搜索的响应体。

本次运行未执行搜索 smoke。

## 模块化更新验证

`reference-plan` 入口由 95 行、13108 字节缩为 34 行、2905 字节。详细内容分到 intake、research、design、plan、review 五个模块。入口保留工作范围和路由，CLI 每轮只新增当前阶段的模块内容；此前回合仍由 Codex 的原生历史保留。

| 检查 | 结果 | 证据边界 |
| --- | --- | --- |
| 官方技能格式检查 | 通过 | `skill-creator/scripts/quick_validate.py` 验证用户级技能入口 |
| 资源完整性 | 通过 | 六份 canonical 文件与内嵌资源字节一致；12 个相对指针及适用锚点有效 |
| 阶段路由和规则版本 | 通过 | 实际 gateway 请求夹具覆盖 blocked intake、研究、两种计划修正和独立复核；任一模块变化都会改变规则包摘要 |
| 全量类型和测试检查 | 通过 | `bun run typecheck`；40 项测试、303 次断言，0 失败 |
| 编译与原生调用 | 通过 | 编译 help、产品原生客户端连续两轮模型输出及第三轮取消、二进制 SIGINT 检查通过 |
| 项目外二进制真实需求调用 | 通过 | `build a ticketing system` 返回 3 个业务问题、`needs_input` 和退出码 2；尚未开始研究，JSONL 只有 1 条终态结果 |
| 编译后规则包绑定 | 通过 | 生成的 answers 文件含与入口及所有模块一致的规则包摘要，运行不需要从源码目录读取模块文件 |
| 独立技能行为复核 | 通过 | 含糊请求只读取 intake；现有 callback 方案审查按需读取 review 与 plan，复现同一事件回放计数 1 → 2，并输出 Draft 与修正任务 |

独立行为复核、资源核对、命令证据与编译后真实调用记录保存在本地 `.scratch/deliver-code/reference-plan-modules/`。执行日志和临时产物不随源码发布；本页记录检查结果与证据边界。

独立代码复核无 Standards 发现或 Spec 阻塞项。复核者另行核对六份 canonical 与内嵌字节、全部回合路由和共同指令边界，聚焦测试通过 12 项、143 次断言；类型检查通过。

本次没有重新执行完整售票规划；下面的售票产物来自首版的真实运行。模块化后的完整回合路由通过 gateway 夹具检查，真实服务检查覆盖原生客户端、需求门槛及取消。

## 已执行的平台接入试验

| 检查 | 结果 | 证据边界 |
| --- | --- | --- |
| Bun 启动 Codex App Server，initialize → initialized → account/read | 通过 | 使用已有 ChatGPT 登录；未读取或记录凭证原文 |
| 同一服务、同一 thread 连续两轮 outputSchema 输出 | 通过 | 两轮均收到 completed，最终 JSON 符合预期，服务进程保持运行 |
| 原生取消 | 通过 | 等待匹配 turn/started 后发送 turn/interrupt，收到 interrupted |
| thread 级纯规划工具配置 | 通过接入 | 本次线程禁用搜索、shell、apps、multi-agent、hooks 与已有 MCP/plugin；未写入全局配置 |
| GitHub 与 GitLab 公开仓库发现 API | 通过 | 两个服务均返回 HTTP 200 与候选条目 |
| GitHub 固定提交文件读取 | 通过 | rpc.rs，2656 字节、88 行；L1-L79 范围有效 |

固定提交文件为 `openai/codex@322bbf4d8486efd7dbbcf49598711a9e3fefc282` 的 `codex-rs/app-server-protocol/src/rpc.rs`，SHA256 为 `78c516097c55b665e375807be6dcdceba232805c9ae9fa48420b0a537f0df705`。

这些试验使用独立的最小协议客户端，证明所选平台接口可用。产品客户端与完整流程的执行证据另记如下。

## 首版 CLI 验证

| 检查 | 结果 | 证据边界 |
| --- | --- | --- |
| TypeScript 类型检查 | 通过 | `bun run typecheck` |
| Bun 自动化测试 | 通过，36 项、208 次断言 | 协议夹具、需求门槛、候选筛选、来源归属、覆盖检查、答案上下文、保存、报告、JSONL 与失败处理 |
| 产品原生客户端真实模型调用 | 通过 | 实际 `AppServerClient` 连续两轮结构化输出，再通过 AbortSignal 取消第三轮 |
| 含糊需求 | 通过 | 非交互调用 `build a ticketing system` 返回 `needs_input`、4 个问题和绑定上下文的 answers 文件；退出码 2，尚未读取远程源码 |
| 业务补答后的完整规划 | 通过 | 同一提示词与目录补充 3 项答案，读取 1 个参考项目、17 份源码快照、20 个片段，形成 8 项任务；独立复核后修正一次，再次复核无发现 |
| 最终报告与答案保存 | 通过 | 用上述实际运行的计划、原始补答文件和快照重新渲染；报告和 manifest 包含 3 项原问题与答案，初始摘要单独标注。未重新请求模型 |
| 来源与行号核对 | 通过 | 17 份快照 SHA256 与 manifest 一致；20 个片段范围及哈希有效；远程链接包含固定提交和行号 |
| 编译后二进制 | 通过 | `bun run build`；在项目外目录运行 help 和真实 JSONL 含糊需求；JSONL 只有 1 条终态结果，退出码 2 |
| 编译后二进制 SIGINT | 通过 | 在项目外启动真实模型流程后取消；退出码 130，JSONL 只有 1 条 interrupted 结果。已观察的原生子进程在短暂清理窗口后全部退出，检查上限为 2 秒 |
| GitLab 真实回退读取 | 通过 | 模拟 GitHub 搜索 HTTP 503，其余请求使用真实 GitLab API；发现、提交、分页目录和固定提交源码均 HTTP 200 |
| Linux x64 交叉编译 | 通过 | `bun build src/cli.ts --compile --target=bun-linux-x64`；未执行该 Linux 二进制 |

真实售票示例保留 **Draft**。参考项目没有可读测试源码，Stripe Checkout 时限、付款与退款终态等关键契约尚未核实；完整事务与并发行为也缺少足够证据。CLI 如实列出这些缺口，没有将计划标为 Ready，也没有执行售票应用的实施或测试。

售票参考为 `vivekstackk/seatwise@94c3cc81754e11adc934eba91f2b6f4e4ce4cda2`。示例计划、原始运行摘要和最终渲染核对保存在本地 `.scratch/deliver-code/unshit-v1/live-cli/`。

GitLab 读取使用[官方单提交接口](https://docs.gitlab.com/api/commits/#retrieve-a-commit)，固定到 `opentrainticketing/opentrainticketing@8e0d33a8257952f4d02d92fd566297082b9a7f2e`。读取 `backend/authservice-next/src/appstate.rs`，1228 字节，SHA256 为 `f439313902c2acde77e5d3dec912b65e7f275d76f6e1822f35a9596455c0d353`。本次 smoke 将文件索引限制为 100 条，保留截断标记；它验证 API 链路，不代表完成了整个项目的架构研究。运行摘要保存在本地 `live-cli/gitlab.summary.json`。

两轮独立代码复核已关闭发现项；最终两处修正的聚焦复核通过 15 项测试、89 次断言，没有剩余阻塞项。复核者的夹具测试与上表的真实服务验证分别记录。

最终统一验证通过 deliver-code 的验证证据收集器执行，包含工作区内容摘要、命令时间、退出码与输出，防止把修改前的结果作为最终验证。首版的 `verification-evidence.json` 与 `verification-outcome.json` 保存在本地 `.scratch/deliver-code/unshit-v1/`。

## 自审修正验证（2026-10-15）

| 检查 | 结果 |
| --- | --- |
| `bun run check` | 260 项通过，0 失败，1439 次 expect |
| 变异测试 | `run-mutants.ts` 对 99 个变异逐一运行，99 个 KILLED |
| `bun run build` 与 `./dist/unshit --help` | 帮助列出 `--turn-timeout <seconds>` 和超时退出码 124 |
| 本地读取 | `src/local.ts`、`test/local.test.ts`、`test/github.test.ts`、`test/workflow.test.ts` 均可读取，疑似凭证值已遮蔽，分别遮蔽 2、24、8、2 个值 |

这次没有运行 unshit，没有调用 Codex，也没有发出 GitHub 或 Grep 请求。真实的自审重跑另行安排。

## 文件挑选修正验证（2026-10-16）

2026-10-15 与 2026-10-16 的两次 CLI 自审重跑都停在文件挑选。提示序列化了完整的 `RepositorySnapshot`，包括每个已选仓库的全部文件。第一次的原因已经确认：模型选了这些完整文件列表中的一个文件 ID，它不在可选清单里。第二次，Codex 拒绝了文件挑选回合的请求，日志只留下 `request turn/start failed`。同样的完整文件列表使输入过大是最可能的原因，但这是推断，日志里没有 Codex 给出的理由。

| 检查 | 结果 |
| --- | --- |
| `bun run check` | 266 项通过，0 失败，1471 次 expect |
| 变异测试 | `run-mutants.ts` 对 118 个变异逐一运行，118 个 KILLED |

这次同样没有运行 unshit，没有调用 Codex，也没有发出 GitHub 或 Grep 请求。修正后的自审重跑另行记录。

## 进程退出处理验证（2026-10-16）

Codex 先回应错误、随后进程退出、而回应仍在 stdout 缓冲区时，读取端先读完这些回应，再让未完成的请求失败；stdout 在退出后 1 秒内仍未关闭时，未完成的请求按时失败。

| 检查 | 结果 |
| --- | --- |
| `bun run check` | 268 项通过，0 失败，1476 次 expect |
| 变异测试 | `run-mutants.ts` 对 121 个变异逐一运行，121 个 KILLED |


## 证据摘录验证（2026-10-16）

2026-10-16 的 CLI 自审计划是 Draft，原因之一是摘录缺少关键函数的主体：每个文件最多两段 90 行，第一段固定是文件开头。新规则下，对 unshit 自身的 `src/workflow.ts`、`src/evidence.ts`、`src/model-schema.ts`、`src/github.ts` 用同一段需求文字比较，摘录从约 26,000 个字符增加到约 61,000 个字符，`runWorkflow` 的就绪、复核与修复流程也包含在内。进程退出处理的一秒上限测试也收紧了：两秒的上限会让它失败。

| 检查 | 结果 |
| --- | --- |
| `bun run check` | 276 项通过，0 失败，1511 次 expect |
| 变异测试 | `run-mutants.ts` 对 141 个变异逐一运行，141 个 KILLED |

## 摘录规则修正验证（2026-10-16）

采用上述摘录规则后的第 7 次 CLI 自审仍是 Draft。`src/code-search.ts` 全文 6,374 个字符，份额有 24,249 个字符，却只摘了开头 30 行：本地文件没有代码 pattern 加分，而这个文件没有一行包含 brief 的前 30 个词。另有一段摘录被份额截到只剩两行。现在全文放得进份额的文件整份摘录，所有文件都按 brief 的代码 pattern 加分，每个文件的区段数不设上限，区段不再被截短（开头 30 行仍在份额不够时截短）。

用第 7 次保存的输入模拟：旧规则的模拟结果在 31 个文件中有 28 个与第 7 次的实际摘录完全相同。新规则下，摘录从 208,485 个字符增加到 247,691 个字符，`src/code-search.ts` 整份摘录，没有被截短的区段。第 7 次计划点名缺少的另外两处，即 `src/evidence.ts` 的 `repositoryPermalink` 与 `src/model-schema.ts` 中 `parsePlan` 的开头，仍不在摘录里。主机在模型读到源码之前就要选定摘录，这两处需要模型读后提出补充请求，另行处理。

| 检查 | 结果 |
| --- | --- |
| `bun run check` | 276 项通过，0 失败，1519 次 expect |
| 变异测试 | `run-mutants.ts` 对 152 个变异逐一运行，152 个 KILLED |

这次没有运行 unshit，没有调用 Codex，也没有发出 GitHub 或 Grep 请求。

## 本地凭证遮蔽速度验证（2026-10-16）

查找凭证名称的正则在一长串字母、数字、`_` 或 `-` 上耗时随长度的平方增长：一行 40,000 个这类字符要 4.2 秒，80,000 个要 17 秒。现在先找出每一段这类字符，再检查它是否含凭证名称、后面是否紧跟 `:` 或 `=` 和值的开头引号，耗时随文本长度线性增长；同样的 80,000 个字符约 1 毫秒。新旧两种写法在 300,000 个随机输入上的遮蔽结果完全相同，其中约 27% 的输入有遮蔽。

| 检查 | 结果 |
| --- | --- |
| `bun run check` | 278 项通过，0 失败，1522 次 expect |
| 变异测试 | `run-mutants.ts` 对 157 个变异逐一运行，157 个 KILLED |

这次没有运行 unshit，没有调用 Codex，也没有发出 GitHub 或 Grep 请求。

## 补充请求验证（2026-10-16）

第 7 次和第 8 次 CLI 自审都是 Draft，计划点名缺少的部分有一类是大文件里的函数：host 在模型读到源码之前就要选定摘录。现在读完文件后多一个回合，模型可以要已读文件里的定义或行范围，或未读文件；首轮摘录最多 220,000 个字符，补充后合计不超过 260,000 个字符。测试用假模型和假 GitHub 读取验证：补充的定义出现在计划提示里；已摘录的行不重复；放不下、找不到或不在清单里的项目记为非重大缺口；这个回合失败或超时后计划仍用首轮摘录，被中断或要求输入时运行在写计划前停止；检查点包含补充的摘录。

| 检查 | 结果 |
| --- | --- |
| `bun run check` | 295 项通过，0 失败，1592 次 expect |
| 变异测试 | `run-mutants.ts` 对 201 个变异逐一运行，201 个 KILLED |

这次没有运行 unshit，没有调用 Codex，也没有发出 GitHub 或 Grep 请求。真实执行的效果由第 9 次 CLI 自审验证。

## CLI 自审实跑记录（2026-10-14 至 2026-10-21）

需求文字每次相同，都是请 unshit 检查自身并规划最需要的改进。第 1 次没有指定 `--effort`，使用 Codex 配置里的 xhigh；第 2 次和第 4 到 10 次用 `--effort medium` 直接运行 CLI；第 3 次用仓库外的驱动脚本调用同一个 `runWorkflow`，effort 为 medium，回合上限 900 秒。

| 次数 | 版本 | 结果 |
| --- | --- | --- |
| 1、2 | `b7d3ae2` | 计划回合到达 150 秒的回合上限，超时被报告为中断，退出码 130 |
| 3 | `b7d3ae2`，驱动脚本 | 退出码 0，Draft，计划回合 281 秒，1 个参考仓库（oracle/opengrok） |
| 4 | `7a7ee17` | 71 秒后停在文件挑选：模型选了清单外的文件 ID，退出码 1 |
| 5 | `7a7ee17` | 53 秒后停在文件挑选：Codex 对 `turn/start` 请求返回错误，退出码 1 |
| 6 | `4ef8ead` | 退出码 0，Draft，6.4 分钟，3 个参考仓库 |
| 7 | `7d2fa2f` | 退出码 0，Draft，摘录 204,811 个字符 |
| 8 | `77371a2` | 退出码 0，Draft，摘录 234,035 个字符，`src/code-search.ts` 整份摘录 |
| 9 | `3b5e9e0` | 退出码 0，Draft，补充请求 8 项全部处理，摘录 255,461 个字符，复核 0 项发现 |
| 10 | `9a7d6c8` | 退出码 0，Draft，6.7 分钟，1 个参考仓库；文件挑选选满 20 个文件，`src/app-server.ts` 有摘录，`src/cli.ts` 和 `src/storage.ts` 仍没有；补充请求的 6 个文件名额用了 4 个；摘录 257,292 个字符 |

每次都发出了真实的 GitHub 和 Grep 请求，发现阶段的 Grep 代码搜索每次匹配 6 到 13 个仓库。第 1 到 3 次的每个定位查询都返回 `ok`；第 6 到 9 次各用满 12 次的 Grep 请求额度，各有 1 到 3 个定位查询记为 `skipped`，没有发出。第 10 次的第 2 个发现查询（`evidence`）以 `invalid_response` 失败，之后的查询都记为 `skipped`；当时的记录只有失败类别。运行日志和输出保存在仓库之外。

## 后续修正验证（2026-10-17）

- 持久化测试的研究摘要加入 Grep 查询记录（`research.codeSearch`），最终和检查点两份 manifest 都要原样保存它。
- 新测试检查：至少一个发现查询返回 `ok` 时，进度回调报告代码搜索匹配的仓库数。
- 识别定义的正则在返回类型部分去掉了与 `[^=]+` 重叠的 `\s*`，能匹配的行不变。原来参数列后的 `:` 后面有一长串空白、之后的 `=` 又不接 `>` 时，匹配时间随空白长度的平方增长，99,000 个字符的一行约 3.7 秒；现在同一行不到 1 毫秒。
- 单行箭头函数的参数里有括号时（例如默认值调用 `(order = makeOrder())` 或函数类型 `(check: () => boolean)`），仍不识别为定义。两次评审都发现，放宽参数写法后，字符串、注释或解构键名里的文字会被读成参数列，所以参数写法保持不变。新测试里四个在字符串、注释或键名中含 `(…(…)…) =>` 的声明都不被当成定义；字符串里只有 `) =>` 时仍可能被当成定义，这是原有行为。

| 检查 | 结果 |
| --- | --- |
| `bun run check` | 298 项通过，0 失败，1596 次 expect |
| 变异测试 | `run-mutants.ts` 对 208 个变异逐一运行，208 个 KILLED |

这次没有运行 unshit，没有调用 Codex，也没有发出 GitHub 或 Grep 请求。

## 断开前的完成通知验证（2026-10-18）

- Codex 发出回合的完成通知后进程退出或关闭 stdout：五种顺序（`turn/start` 的回应和通知在同一块、分块发送、`turn/start` 一直没有回应、回应在完成通知之后、没有 `turn/started`）在退出和关闭 stdout 两种情况下都返回完成结果。原来这些情况都报告 “Codex App Server disconnected during the active turn.”。
- 完成通知的状态是 `failed` 或 `interrupted` 时返回这个状态。完成通知之前已记录的超时、取消、输入请求和被拦截的工具动作仍然优先；属于其他回合的完成通知不采用。
- 回合结果要用的通知（完成通知、每一级最新的最终消息候选、最新的 `error` 通知）按回合 ID 单独保留，不受 500 条滚动缓冲的限制：这些通知之后又有 500 条其他线程的通知或 500 个其他回合的完成通知、随后断开连接，仍返回完成结果和最终文本，失败时仍带失败原因。同一级有两条最终消息时取较晚的一条，和原来扫描缓冲的结果相同。
- 滚动缓冲收进的通知和原来相同（所有线程的 `turn/started`、`turn/completed`、`item/started`、`item/completed` 和 `error`），挤出通知的时机也和原来相同：没有完成通知、`turn/started` 之后又有 500 条通知时，仍回报未宣布回合；499 条时回合按空闲时限超时。
- 请求时限、开始时限、中断等待和空闲时限都设为 10 秒时，在 `turn/start` 阶段或回合进行中断开连接，失败结果在 0.5 秒内返回。原来在 `turn/start` 阶段要再等 2 秒，回合进行中要等满中断等待的时长。

| 检查 | 结果 |
| --- | --- |
| `bun run check` | 313 项通过，0 失败，1669 次 expect |
| 变异测试 | `run-mutants.ts` 对 229 个变异逐一运行，229 个 KILLED |

这次没有运行 unshit，没有调用 Codex，也没有发出 GitHub 或 Grep 请求。

## 回合结束后的进程退出验证（2026-10-20）

回合进行中连接断开，或回合被取消而 Codex 不回应 `turn/interrupt` 时，没有 `turn/completed` 到来。原来等待回合结束的那一路仍挂着一个计时器，要到空闲时限才触发，CLI 打印结果后进程不退出：空闲时限设为 4 秒时，进程在 `turn()` 返回后又停留约 4 秒。现在回合有了结果后，这一路随即停止并清除计时器；同样的情况下，进程在约 0.2 秒（断开）和约 0.8 秒（取消，含中断等待）后退出。

| 检查 | 结果 |
| --- | --- |
| `bun run check` | 314 项通过，0 失败，1673 次 expect |
| 变异测试 | `run-mutants.ts` 对 232 个变异逐一运行，232 个 KILLED |

这次没有运行 unshit，没有调用 Codex，也没有发出 GitHub 或 Grep 请求。

## 选文件与补充请求上限验证（2026-10-21）

第 9 次 CLI 自审的 readiness 说明写着：CLI、App Server 适配层、产物存储和它们的测试都没有出现在摘录里。第 8、9 次的文件挑选都选满了 15 个文件；第 9 次补充请求的 4 个文件名额只用了 3 个，要的是 `src/local.ts`、`src/file-ranking.ts` 和 `src/instructions.ts`。现在文件挑选最多 20 个文件（schema、解析和提示用同一个常量），补充请求最多加 6 个未读文件，提示要求模型先要计划否则会列为缺少上下文的未读文件和定义。首轮摘录和全部摘录的额度不变（220,000 和 260,000 个字符），文件多了，每个文件分到的份额会变小。

| 检查 | 结果 |
| --- | --- |
| `bun run check` | 315 项通过，0 失败，1677 次 expect |
| 变异测试 | `run-mutants.ts` 对 238 个变异逐一运行，238 个 KILLED |

这次没有运行 unshit，没有调用 Codex，也没有发出 GitHub 或 Grep 请求。真实效果由第 10 次 CLI 自审验证。

## Grep 失败原因验证（2026-10-22）

第 10 次 CLI 自审的 Grep 查询以 `invalid_response` 失败，记录里只有失败类别，看不出响应是哪一种。现在失败记录的 `responseProblem` 写明第一个没通过的检查（`not_json_rpc`、`rpc_error`、`tool_error`、`no_hits`），适用时再记下媒体类型或 JSON-RPC 整数错误码，缺口信息带上同样的原因。重试、本次运行停止代码搜索和查询状态都不变。新测试对四种原因各用一个含标记文字的响应，检查研究结果里没有这段文字。

| 检查 | 结果 |
| --- | --- |
| `bun run check` | 318 项通过，0 失败，1743 次 expect |
| 变异测试 | `run-mutants.ts` 对 272 个变异逐一运行，272 个 KILLED |

这次没有运行 unshit，没有调用 Codex，也没有发出 GitHub 或 Grep 请求。

## agent skill 安装验证（2026-10-22）

`install.sh` 和 `unshit --install-skill` 来自 2026-10-12 未提交的 stale-puma 工作区，这次移植到当前代码。skill 写入 Claude Code 的 skills 目录，以及 Codex 的 `$CODEX_HOME/skills`（默认 `~/.codex/skills`）和 `~/.agents/skills`；skill 文字补上退出码 124、`--turn-timeout`、`research.selected` 和 Grep 需要的网络访问。README 只写克隆仓库后运行 `./install.sh`。测试只在临时目录里安装 skill；`install.sh` 只测试了语法、可执行权限、`--help` 和参数错误，生产安装和开发安装需要联网和 `bun install`，这次没有运行。

| 检查 | 结果 |
| --- | --- |
| `bun run check` | 332 项通过，0 失败，1835 次 expect |
| 变异测试 | `run-mutants.ts` 对 313 个变异逐一运行，313 个 KILLED |

这次没有运行 unshit，没有调用 Codex，也没有发出 GitHub 或 Grep 请求，也没有在真实的 home 目录安装 skill。

## Trusted, not checked 一节验证（2026-10-25）

plan.md 在“Checks performed”之后新增“Trusted, not checked”一节，写明计划信任但 host 没有核对的内容，参照 PDD Kit PR 的 Trusted 与 Limitations 两行。“Checks performed”原来写“validated citations against source line ranges”，实际只核对摘录 ID 和参考比较的仓库提交，现在改成实际做的检查。这一项本身没有新增存储字段，也没有改规则包；其他几项新增的字段、加进这一节的行和规则包的变化见各自一节。

复核后补的测试：模型没有选中的候选仓库（`decidedBy: "model"`、`outcome: "rejected"`）和 host 排除的仓库一样不出现在这一节；只有 `production` 角色计为实现文件，许可证、manifest 和 ci 文件不计入；GitLab 仓库按提供方和仓库匹配读取的文件，同路径的 GitHub 仓库的文件不计入；GitLab 报告了创建日期时照写；错误实现个数跨任务累加，参考测试摘录个数跨模式累加。措辞也改了三处：引用一行与“Checks performed”一致，写明引用的参考测试还要来自 host 读作测试的文件；测试路径数来自 host 收到的文件树列表，列表被截断时（另有缺口记录）只是下限；本地源码的 SHA-256 是遮蔽凭证之后的内容的哈希。

这次没有运行 unshit，没有调用 Codex，也没有发出 GitHub 或 Grep 请求。

## 具名错误实现验证（2026-10-25）

借鉴 PDD Kit PR #4 的做法：14 个单子句变异各自让对应子句失败，说明没有空转的子句。现在计划的每个验证方法为它覆盖的每条验收写出至少一个错误实现和预期的失败，host 校验覆盖关系、数量和长度并编号；plan.md 在验证下面列出，每个任务有一句 Done when，“Trusted, not checked”写出错误实现的个数并说明没有应用或运行。新测试为每条规则命名了要拒绝的变异；例如把 `rejectsMutants` 的最少项数从 1 改成 0，空数组仍会因为 A1 没有错误实现而失败，所以测试断言完整的错误消息。

复核后补的测试：缺少错误实现的验收排在覆盖列表的第一位或中间时同样被拒绝，同一验收写两次不能顶替另一条；错误消息里的验证序号是它的实际位置；existing 命令验证下面同样列出错误实现；复核提示和复核修正提示里的计划 JSON 带 host 编号的 `rejectsMutants`。规划提示写明 host 的上限：每个验证最多 24 个错误实现，两段文字各最多 500 个字符，`acceptanceId` 必须是这个验证覆盖的 A* ID，`untestedReason` 最多 700 个字符，`testEvidence` 只引用同一参考仓库固定提交里角色为 test 的来源。

这次没有运行 unshit，没有调用 Codex，也没有发出 GitHub 或 Grep 请求；计划里的错误实现也没有被应用或运行。

## 参考测试引用验证（2026-10-25）

- 计划 schema 的采用模式加入 `testEvidence` 和 `untestedReason`。新测试检查：测试摘录来自同一仓库、同一提交，而且 host 记为测试文件时，解析保留它；生产文件摘录、另一个参考仓库的测试摘录都被拒绝，错误信息写明原因；两者都没有、两者都有、原因只有空白或测试引用超过 6 个时也被拒绝。schema 测试固定了 `testEvidence` 每一项的结构，与生产证据引用相同。
- 所有采用模式都没有引用参考测试时，计划为 Draft，缺口列表和 readinessNotes 都有这条重大缺口，第一次复核的提示里能看到它。这两个 Draft 测试都批准了 brief，readinessNotes 只有这一条，Draft 只来自这条缺口。复核修正引用了参考测试后，后续复核看不到这条缺口，计划为 Ready；修正后仍没有引用时，后续复核仍然看到它，缺口只记一次。复核中途被中断或超时时，保存的检查点的缺口列表与计划的 readinessNotes 一致，都有或都没有这条缺口；正常结束时最后的检查点只记一次。第二个参考比较里有一个模式引用了测试就够了。没有参考比较时不加这条缺口。
- 原先结束于 Ready 的 workflow 测试仍为 Ready：夹具计划的采用模式引用参考仓库测试文件的摘录 E2；读取失败、E2 不是测试摘录的测试改用 `untestedReason`。
- 模型把生产文件选为测试时，host 不给它 `test` 角色；计划把这个文件的摘录作为参考测试引用时被校验拒绝，拒绝原因记入校验历史。规划、复核和复核修正收到的来源登记都带每个来源的 `roles`。
- 报告在每个采用模式下写出 `Reference test (read, not run)` 加引用，或 `No reference test` 加原因，有参考测试的模式下面没有 `No reference test`；“Trusted, not checked”写出引用的不同参考测试摘录个数，同一摘录引用多次只算一个，并说明 host 只按路径名认定测试文件。
- 规则包摘要改变，旧的补答文件需要重新生成。

这次没有运行 unshit，没有调用 Codex，也没有发出 GitHub 或 Grep 请求。参考测试只读取，没有运行。

## brief 批准与要求来源验证（2026-10-25）

PDD Kit 的意图对照表把起草的性质和“你说的原话”并列，规格获批后才进入证明；Chopin 只允许人批准草稿。现在 brief 定稿后、参考检索之前由人批准要求与验收，每条要求标出原话或推断，`Ready` 需要这条批准。测试用假模型和假研究器验证：终端批准发生在补答之后、本地扫描之前，批准记录带摘要、方式和注入的时间；拒绝时返回 `needs_input`，没有发出搜索；脚本运行完成为 Draft 并写出 `approveBrief: false` 的补答文件；带 `approveBrief: true` 的补答文件跳过需求提取、补答和重建，可以达到 Ready；引文只有归一化后至少 4 个码位且出现在用户文本里才算原话。原先结束于 Ready 的测试加上终端批准后仍为 Ready。brief 重建块缩进了两格，旧变异目录里的 WT12 按新的缩进更新了查找文本。

复核后的修改：`approveBrief` 为 true 而 request 里有问题没有答案时，读取补答文件失败，并列出没有答案的问题 ID；`approveBrief` 为 true 而没有 brief 时也失败。从补答文件批准的运行，plan.md 的范围一节写 `Approved brief (from the answers file)`，不再把批准的摘要标成初始摘要；终端批准在“Brief approval”和“Trusted, not checked”两节写成在交互终端输入的 yes，host 分辨不出是谁。新测试还检查：完成结果的补答文件写入失败时结果仍为完成；引文先去掉首尾空白再算码位；带 brief 的补答文件同样按目录绑定；终端显示和可编辑 brief 带上非空的排除项和假设。

终端里的批准提示没有在真实终端中运行。从 `main()` 抽出的部分有测试：`terminalPrompts` 只在交互运行时提供补答提问和批准（`--json`、`--jsonl`、stdin 或 stderr 不是终端时都没有）；`createBriefApprover` 只认 `yes`，显示的 brief 含摘要、带来源标签的 R*/A*、排除项和假设；`createTerminalAsk` 在内存流上的终端 readline 里，按 Ctrl+C（提示处或两次提示之间）或输入结束时中断运行，等待中的提问随即失败，运行自己关闭提示时不中断；两次提问共用一个 readline，运行关闭提示时它随之关闭；输入在一次回答之后结束时，下一次提问中断运行并以 AbortError 失败；`runWithAnswers` 把读入的答案交给 workflow 和之后的补答文件。workflow 测试在补答提问或批准提示处中止时结果为 `interrupted`，没有发出搜索。批准只由 host 执行：workflow 测试在未批准、终端批准和补答文件批准三种运行里检查，计划生成、两次复核和复核修正的提示词都只带对应的那句批准状态，并要求模型不为批准设 `shouldDraft` 或报告问题；规则包测试检查每个提到批准的句子都由 host 负责，入口 SKILL.md 阶段表的 intake 一行仍是原来的“The business decision gate has passed”，没有把批准列为继续条件；intake 和 plan 模块的改动使规则包摘要改变。`main()` 换上假的 workflow 测试：`--json` 下 stdin 和 stderr 都设为终端时也不提供补答提问和批准，未批准的 Draft 计划写出补答文件，stdout 上唯一的 JSON 结果带 `answersFile`；`--jsonl`（两个流都设为终端）同样不提供，唯一的 JSONL 结果行带 `answersFile`；不带这两个参数时，stdin 或 stderr 的 isTTY 为 undefined 都不提供，两个都是终端才提供；stdin 不是终端时，计划写到 stdout，stderr 上只有一行，写明没有人批准、计划为 Draft，并给出补答文件路径和批准做法。`main()` 其余的接线（创建 readline、进程 SIGINT 处理、终端运行的 stdout 和 stderr 输出）没有测试。这次没有运行 unshit，没有调用 Codex，也没有发出 GitHub 或 Grep 请求。

## 复核存活错误实现验证（2026-10-25）

独立复核为每条验收标准 A* 尝试构造一个所有计划检查仍会通过的错误实现，写入 `survivingMutants`。测试用假模型脚本化两次复核：第一次复核报告、不需要决定的错误实现进入修正提示，第二次复核干净时计划为 Ready；第二次复核仍报告时为 Draft；只在第一次复核报告的待定决定，在第二次复核干净后仍是 Draft 原因，也没有出现在修正提示里。

复核后的修改：存活错误实现不再能让运行失败。`parseReview` 仍严格校验 `findings`；存活错误实现中空白的 `decisionNeeded` 当作没有决定，`acceptanceId` 不是 brief 中 A* ID 的项、不是对象或文字超长的项、第 12 项之后的项都被丢弃，字段不是列表时按没有处理；每次丢弃在计划的缺口列表和 manifest 的 `gaps` 里记一条信息性缺口，就绪状态不变（2026-10-27 起改为重大缺口，计划保持 Draft，缺少 `survivingMutants` 键也记一条，见下文“复核里被丢弃的存活错误实现让计划保持 Draft”）。复核提示写明 `acceptanceId` 用 brief 的 A* ID 而不是 T1-A1 这样的任务验收 ID，最多 12 项，并要求 brief 没有定下的业务选择只作为带 `decisionNeeded` 的存活错误实现报告，不写成问题或修正建议。待决事项的说明引用验收标准原文，并按 brief 的批准方式给出做法。修正通过校验而后续复核没有完成时，计划为 Draft，原因写明没有完成的复核覆盖修正后的计划，第一次复核的问题和不需要决定的存活错误实现不再写成 Draft 原因，任何一次复核的待决事项仍是 Draft 原因；修正本身失败时仍写 `The bounded review repair did not complete.`。“Trusted, not checked”多了一行：存活错误实现和没有存活错误实现都只是复核模型的推理。新测试检查：只有修正后的复核报告的待定决定同样让计划为 Draft；有两条要求时，A2 的存活错误实现转成针对 R2 的完整重大问题；复核提示里 `decisionNeeded` 的条件、先给反例的要求、A* ID 与 12 项上限和业务选择这几句整句固定；两次复核里无法使用的存活错误实现都被丢弃，丢弃记录写进 plan.md 和 manifest，运行照常完成；修正后的复核失败时计划写明没有复核覆盖，去掉第一次复核过时的说明，并保留第一次复核的待决事项；三种批准方式各有对应的待决事项做法；复核 schema 的 `maxItems` 为 12；进度行写出存活错误实现的个数。

这次没有运行 unshit，没有调用 Codex，也没有发出 GitHub 或 Grep 请求。复核者在真实计划上报告多少存活错误实现，要等下一次 CLI 自审实跑记录。

## agent skill 符合性报告验证（2026-10-25）

unshit agent skill 增加了需求摘要批准、“Trusted, not checked”、待决事项和实施后的符合性报告。用 `--json` 运行时 unshit 不能当场请人批准，skill 让 agent 把 brief 按“你说的”和“推断的”交给用户，由用户自己把补答文件的 `approveBrief` 改为 true。符合性报告按任务写出每个具名错误实现（`T1-V1-M1` 等）是否被杀死和实际运行的命令，实际运行的验证命令和计划中的验证分开写，并说明每个参考模式和它的参考测试是否沿用。skill 不在规则包摘要里，补答文件的规则版本校验不受影响。测试检查 skill 带有这些规则的整行文字，并用 host 类型检查 skill 用到的字段名。

复核后的修改：agent 交给用户批准的是整份 brief，包括排除项和假设，与终端提示和批准摘要覆盖的内容一致；“inferred”只表示没有找到用户原话的引文，不再说成 unshit 加的。用户定下待决事项后，决定写进补答文件的 brief、由用户自己设 `approveBrief`，或者 agent 把决定按用户原话加进需求、由用户在终端运行并批准；unshit 重新规划后再实施。终端运行没有 JSON 结果，计划在最新的 `.unshit/<run-id>/plan.md`。符合性报告里每个具名错误实现写明杀死、存活、失败方式与预期不同或没有运行，错误实现在临时副本或单独的 git worktree 里应用；失败方式与预期不同的，在修好测试或改正预期的失败之前不算杀死，这两种修改都要写明原因，不能只为对上看到的失败而改预期；有存活的，先补强测试或如实报告，才算任务完成。结果没有 `answersFile`（补答文件写入失败）时，skill 让 agent 告诉用户，并用相同命令重新运行。计划来自已批准的补答文件时，那个文件的 `approveBrief` 已经是 true，用户重读并保存修改后的 brief 就是批准；agent 写进去的决定，要等用户读过并接受后才重新运行。待决事项的说明也写明这两点：没有保存补答文件时用相同命令重新运行，已批准的文件里 `approveBrief` 已经是 true。plan.md 的“Trusted, not checked”标题和“Open decision for”前缀改由 `TRUSTED_SECTION_HEADING` 和 `OPEN_DECISION_PREFIX` 两个导出常量生成，测试检查 skill 引用的正是这两个值，代码改名而 skill 没跟上时测试失败。测试还检查：提到 `approveBrief` 的行只有三条固定的行，含 approv、type yes 或 yourself（不分大小写）的行只有八条固定的行，含 killed 或 surviv 的行只有两条；新加一行只要含这些词，测试就会失败，不含这些词的新行测不出来；批准一节的标题固定；`brief.summary`、`brief.requirements`、`brief.outOfScope`、`brief.assumptions` 和 `stated`/`inferred` 由 host 类型检查。`main()` 的测试见 brief 批准一节。

这次没有让真实的 agent 按 skill 实施计划，没有运行 unshit，没有调用 Codex，也没有在真实的 home 目录安装 skill。

## PDD Kit 借鉴改动的检查记录

上面六节（2026-10-25）是同一组改动，在同一个工作区里一起实现，复核后的修改也在其中。各节写每项改了什么、由哪些测试覆盖；检查结果只在这里记一次，对应这组改动交付时的代码，不再列各步骤中间状态的数字。下表的 `bun run check` 和技能格式检查于 2026-10-27 在这个工作区运行。

| 检查 | 结果 |
| --- | --- |
| `bun run check` | 433 项通过，0 失败，2340 次 expect |
| 变异目录 | 共 721 个变异，保存在仓库之外：此前各节的 313 个，加上这六项和复核修改新增的 408 个；全部变异的完整运行结果记在本节末尾的“完整变异运行”一行 |
| 官方技能格式检查 | `skill-creator/scripts/quick_validate.py` 验证 `src/resources/unshit-skill`：Skill is valid! |

最后一轮验收后的修改：共同指令写明从已批准补答文件开始的运行使用该 brief；规则包的 intake 和 plan 模块补上没有 host 程序时由模型自己请用户批准、批准前保持 Draft；`main()` 增加测试，brief 已批准而计划因证据缺口为 Draft 时，stderr 不提示批准，也不写补答文件；skill 要求“失败方式与预期不同”时说明对测试或预期失败的修改及原因，不能只为对上看到的失败而改预期。

这组改动没有运行 unshit，没有调用 Codex，也没有发出 GitHub 或 Grep 请求；计划里的错误实现没有被应用或运行，参考测试只读取，没有运行。

完整变异运行：2026-10-27 在这个工作区用 `run-mutants.ts` 逐一运行全部 721 个变异，721 个 KILLED。

## 第 11 次自审提案的修改验证（2026-10-27）

第 11 次 CLI 自审的计划提出了几项后续改进。这里每项一小节，写改了什么、由哪些测试覆盖。

### 采用模式的参考测试必须和实现摘录成对

第 11 次自审里，graphify 的采用模式把同一段测试摘录（`tests/test_evidence_binding.py` 第 43 到 59 行）同时当作模式的实现证据和参考测试，host 校验照样通过，报告把它显示成有参考测试的模式。这个测试用到的 `graphify.llm` 实现没有读到，只有计划自己写的说明提到。原因是 host 只核对 `testEvidence` 来自同一仓库固定提交、读作测试的文件，不核对模式的 `evidence` 是什么角色；摘录分配也不把实现文件和测试配对。

现在的做法：

- 采用模式的 `testEvidence` 不为空时，`evidence` 至少要有一段来源 `roles` 含 `production` 的摘录（同一仓库、同一提交仍由原有校验保证），否则 `parsePlan` 报错 `Adopted pattern N for C… cites a reference test, but its evidence cites no excerpt of a file the host read as production; cite the production excerpt that the test exercises, or give an untestedReason.`，进入唯一一次计划修正。没有参考测试的模式不受这条限制。
- 补充请求读入的文件，满足 `isTestPath` 时记为 `test`，满足 `isImplementationSourceFile` 时记为 `production`，其余（README、文档、清单等）记为 `config`，不能充当实现摘录。
- 规划提示要求在模式的 evidence 里引用测试所测代码的实现摘录，没有这样的摘录时写 `untestedReason`；提示里列出的 host 上限加上这条。复核提示要求核对每个参考测试是否用到同一模式引用的实现摘录；复核修正提示要求保留成对的引用。
- “Checks performed”写明 host 核对了这一对，也写明没有核对测试是否用到这段实现代码；“Trusted, not checked”的参考测试一行改为：测试是否用到同一模式引用的实现摘录，由规划和复核判断。
- 摘录分配、预算、计划 schema、manifest 和规则包都没有改，规则包摘要不变。

新测试：

- `rejects a reference test on an adopted pattern whose evidence holds no production excerpt`：同一段测试摘录同时作为实现证据和参考测试（第 11 次的形状）时解析失败，断言完整的错误消息。
- `accepts a tested pattern with one production excerpt among its evidence, and an untested pattern that rests on a test excerpt`：evidence 里有测试摘录也有实现摘录时，参考测试引用保留；没有参考测试、只引用测试摘录并写明原因的模式照常解析。
- `repairs a pattern that cites the comparator test as its own production evidence when the production source was not read`：参考仓库的实现文件读取失败、只读到测试时，把测试当作实现证据和参考测试的计划被拒绝，校验历史记下这条错误并标为已由修正解决；修正后的模式没有参考测试、写明原因，计划带“没有采用模式引用参考测试”的重大缺口。
- `gives a requested file that is neither a test nor implementation source no production role`：补充请求读入的 `docs/design.md` 角色为 `config`，`src/extra.ts` 为 `production`。
- 规划、复核和复核修正提示里关于参考测试的整句，host 上限一句，“Checks performed”一段和“Trusted, not checked”的参考测试一行，都按新文字整句固定。

变异：新增 15 个（`T4-01` 到 `T4-15`），每个由一个具名测试杀死（上面的新测试，或按新文字整句固定的原有测试）：去掉这条校验、任何角色都算实现、在测试引用里找实现摘录、没有参考测试的模式也要求实现摘录、要求 evidence 全部是实现摘录、补充请求读入的文档记为 `production`，以及提示和报告里新加的每一句各删一处。变异目录里有 6 个原有变异（CR11、I2-M23、I3-P3、I3-X5、FX-G5-W3、FX-G5-W5）的查找文本随这次修改的文字更新，编号和意图不变。第 11 次计划为这项改进写了两个错误实现。T4-V1-M2（分配器丢掉了实现定义，这一对仍算成立）对应 `T4-01` 和 `T4-06`：去掉这条校验后，实现文件没有读到、只把测试当作实现证据的计划照样通过，两个测试都失败。T4-V1-M1（任何正数的 testFileCount 都显示为有测试的采用行为）在现有代码里没有对应的路径：报告只按 `testEvidence` 和 `untestedReason` 写模式下面的一行，缺口也只看 `testEvidence`；与它最接近的单行变异 I3-W2 和 I3-R3 早已由参考测试引用一节的测试杀死。2026-10-27 在这个工作区用 `run-mutants.ts` 逐一运行这 15 个新变异和 6 个更新的变异，全部 KILLED；改动涉及的源文件和测试文件里其余 406 个原有变异重新运行，也全部 KILLED。

复核后的修改：两位复核者发现几处与这条规则矛盾或说过头的地方。

- 复核提示原来要求：readinessNotes 写明没有采用模式引用参考测试、而提供的测试摘录用到了某个采用模式时，报告重大问题；复核修正提示要求有测试摘录时就引用它。参考仓库只读到测试、没有实现摘录时（例如实现文件读取失败），修正会引用这个测试，host 拒绝修正后的计划，同一次修正里无关的改动也一起丢掉。现在复核只在同一参考仓库既有这样的测试摘录、又有它所测代码的实现摘录时才报告，并写出两段摘录；复核修正只在两者都有时把测试和实现摘录成对引用，也不能为消除这条说明引用测试没有用到的实现摘录。两个提示里的触发条件也改用缺口的说法：readinessNotes 写明没有采用模式把参考测试和它测的实现代码成对引用。
- 没有采用模式引用参考测试时的缺口原来写 `the reference comparison rests on production excerpts alone`，没有读到实现摘录时这句不对。现在写 `No adopted pattern pairs a reference test with the production code it exercises, so no read reference test stands behind the adopted reference code.`，后面按路径名认定测试文件的一句不变。
- “Trusted, not checked”里引用说法一行加上：引用的参考测试旁边，同一模式还要引用一段 host 读作实现文件的摘录。
- README 原来说只读到测试、没有读到它测的实现时，模式只能写明原因，但 host 只核对角色：第 11 次读到了 graphify 的 `graphify/extract.py`（实现角色），没有读到 `graphify.llm`，引用 extract.py 的摘录 E12 加上测试 E16 也能通过。README 现在写明 host 只核对这段摘录来自读作实现文件的源文件，不核对它是不是测试用到的代码，同一仓库没有读作实现文件的摘录时才只能写明原因。

复核后补的测试：`rejects a reference test on an adopted pattern whose evidence cites only a manifest or a document excerpt` 检查模式的 evidence 只引用 host 读作清单的 `package.json`，或读作 `config` 的文档时，引用参考测试照样被拒绝；此前把 `roles.includes("production")` 换成“任何不是 test 的角色”的探测变异在全部测试下都存活。`documents in the README that the host checks only the role of the production excerpt next to a cited reference test` 按整句固定 README 的这两处说法，并检查旧的说法已经去掉。复核提示、复核修正提示、缺口文字和“Trusted, not checked”的引用一行都按新文字整句固定；没有参考仓库时不加这条缺口的测试，改为按新的缺口开头判断。

复核后的变异：新增 9 个（`T4-F1` 到 `T4-F9`）：上面的探测变异，复核和复核修正提示各两处，缺口文字，引用一行，以及 README 两处。变异目录里 4 个原有变异（I2-M19、I3-P5、I3-P6、FX-G5-R11）的查找文本随新文字更新，编号和意图不变。这 13 个，加上断言改过的 I3-W9 和查找文本紧挨着改动的 FX-G2-W8，逐一运行全部 KILLED；这次改动涉及的源文件、README 和测试文件里其余 410 个原有变异重新运行，也全部 KILLED。

这次没有运行 unshit，没有调用 Codex，也没有发出 GitHub 或 Grep 请求；参考测试只读取，没有运行。

### 搜索名额先给具体的领域词，并记下没有搜索的 brief 内容

第 6 到 11 次 CLI 自审，GitHub 搜索每次只发了 9 次请求中的 3 次：前两个领域词和第一个 topic。第 0 档就有足够的候选，后两档没有发出。第 6、7、8、10、11 次，第 0 档的一个名额给了 `reference code`，这两个词都在 `GENERIC_WORDS` 里，5 次共 100 个结果没有一个进入文件树检查；`topic:code-search` 每次有 4 到 5 个仓库通过文件树检查，选中的参考仓库大多来自这里。第 11 次 brief 里的领域词 `repository search`、`code search`、`pinned commit`、`source evidence` 和 topic `code-analysis`、`software-engineering` 都没有搜索，报告和 manifest 也没有记下。

现在的做法：

- `domainMaterialFromBrief` 把领域词清理、去重后取两个：除去 a、an、the、of、to、in、on、for、and、or、with 这些虚词后，至少有一个词不在 `GENERIC_WORDS` 里的领域词按 brief 顺序在前，不论这个词多短；其余的排在最后，只在没有别的领域词时使用，只由虚词组成的领域词也算在其余里。一个领域词都不剩时仍退回 `researchQueries[0]` 或摘要。topic 取前两个符合 slug 格式的。
- `planSearches` 每档发两个领域词和第一个 topic，第二个 topic 只在最严的第 0 档（至少 200 星、12 个月内有推送）发。计划不再截成 9 条；GitHub 搜索仍最多发 9 次请求，超出的计划查询记为 `skipped`。brief 有两个领域词和两个 topic 时，第 0 档就有足够候选的运行从 3 次请求变为 4 次；只要搜到第 2 档，第 10 条计划查询（第 2 档的第一个 topic）一定因预算记为 `skipped`，这次请求挪给了第 0 档的第二个 topic。这个取舍已经批准。
- 没有用上的领域词和 topic 写进 `DomainMaterial.omitted`，`discover()` 合成一条非重大 `search` 缺口，例如 `Brief material not searched on GitHub: domain term "reference code" (generic words only; specific terms took the two phrase slots); …`。清理后没有可搜索字符的领域词（`no searchable words`）和不符合 slug 格式的 topic（`not a GitHub topic slug`）按 brief 原文列出，用 JSON 字符串引出。这条缺口在其余缺口的重大标记重设之后加入：没有候选通过时它仍是非重大缺口，也不会挡掉“No public repository matched the host-built queries.”这条重大缺口。`researchQueries` 只作退路，不列入这条缺口。
- 固定提交的读取原来就不经过分支：分支只用来解析提交，文件树、源码和固定链接都用提交 SHA。原有测试里，只有 GitHub 源码 URL 改用分支时会失败，而且是故障注入测试的匹配条件里恰好带着提交 SHA；GitLab 的源码和文件树、GitHub 的文件树和两种固定链接改用分支时，没有测试失败。这次补了两个守护测试，这部分生产代码没有改。
- 按新规则，第 11 次的 brief 在第 0 档搜 `implementation plan`、`repository search`（替换 `reference code`）、`topic:code-search` 和 `topic:code-analysis`，用 9 次请求中的 4 次；缺口列出 `reference code`、`code search`、`pinned commit`、`source evidence` 和 `software-engineering`。提案阶段用第 11 次第 0 档的条件对 GitHub 手动搜过这两个新查询，不属于自动化验证：`topic:code-analysis` 前 20 个结果里有 18 个是第 11 次没有见过的仓库，`repository search` 的 16 个结果多数与需求无关。模型排序、文件树检查和选择没有模拟。

新测试：

- `gives a later specific domain term the slot of a generic-only one and names what it leaves out`：第 11 次的领域词和 topic，断言两个领域词、两个 topic 和五条遗漏的完整文字。
- `keeps generic-only terms when no specific term remains and omits nothing from a two-term brief`：只有泛用词时仍取前两个；两个领域词、一个 topic 的 brief 没有 `omitted`。
- `searches a domain term that the brief repeats once and gives the second slot to the next term`：清理后相同的领域词只占一个名额。
- `searches the second topic only at the strictest tier`：第 11 次材料的完整 10 条查询计划。
- `keeps nine GitHub search requests with a second topic and records the query past the budget as skipped`：所有搜索都没有结果时发 9 次 GitHub 请求，第 10 条计划查询记为 `skipped`。
- `records brief material that no query searched as one informational search gap`：第 0 档后停止，只发 4 次请求，缺口列表只有这一条非重大缺口；没有任何候选时它仍是非重大缺口，后面照样加上没有仓库匹配的重大缺口。
- `reads trees and sources at the resolved SHA after the default branch moves`：解析提交之后，按分支名请求到的文件树没有测试文件，源码是另一份内容；GitHub 和 GitLab 两个候选都按提交 SHA 读取文件树和源码。
- `links each remote source to its commit, not to its default branch`：GitHub 和 GitLab 来源的固定链接都带提交 SHA。

变异：新增 23 个（`T5-M1` 到 `T5-M10g`），每个由上面的一个具名测试杀死：前两个之后的领域词在考虑具体程度之前被丢掉、按 brief 顺序取词、没有具体领域词时丢掉泛用词、含一个泛用词就算泛用、重复的领域词占两个名额、只保留第一个 topic、查询计划丢掉第二个 topic、第二个 topic 在每一档或在最宽的一档搜索、计划截成 9 条、不报告遗漏、遗漏原因写错或漏掉 topic、`omitted` 总是存在、缺口在重设重大标记之前加入或被标为重大、请求上限改成 10 次，以及文件树、源码和固定链接各改用默认分支。第 11 次计划为这项改进写了两个错误实现：T5-V1-M1（分配器在考虑工作流具体程度之前丢掉前两个之后的所有短语）对应 `T5-M1`；T5-V1-M2（读取时用默认分支代替固定的 SHA）对应 `T5-M2`（GitHub 源码）和 `T5-M2g`（GitLab 源码），文件树和固定链接的同类变异是 `T5-M9`、`T5-M9g`、`T5-M10` 和 `T5-M10g`。变异目录里原有变异的查找文本都不受这次修改影响，没有更新。2026-10-27 在这个工作区用 `run-mutants.ts` 逐一运行这 23 个新变异，全部 KILLED；改动涉及的源文件和测试文件里其余 83 个原有变异重新运行，也全部 KILLED。

复核后的修改：两位复核者指出三处问题。

- 判断泛用词时用的是 `wordTokens`，它丢掉三个字母以下的词。`QR code` 因此被当成只有泛用词，搜索名额让给了 `event platform`；`ci cd` 也被标成只有泛用词，其实这两个词都不在 `GENERIC_WORDS` 里。现在按清理后领域词的每一个词判断，不论长短。
- 遗漏原因写错：几个只有泛用词的领域词互相争名额时，落选的也写 `generic words only`。现在只有两个名额都给了具体领域词时，落选的泛用领域词才写 `generic words only; specific terms took the two phrase slots`，其余写 `over the two-phrase limit`。协调者给的条件是 `phrases.some((p) => !generic(p))`，实现用的是 `phrases.every(...)`：一个具体领域词加两个泛用领域词时，第二个名额给的是泛用领域词，用 `some` 会把落选的泛用领域词说成被具体领域词挤掉。
- 有的 brief 内容没有记下就丢了。不符合 slug 格式的 topic（如 `Code Search`、`code_search`）和清理后没有可搜索字符的领域词，现在按 brief 原文列入同一条缺口，用 JSON 字符串引出，原文里的换行不会拆开报告的缺口行；空白值和重复值不列。
- README 和 architecture 写明了两个领域词、两个 topic 时第 2 档第一个 topic 的查询一定记为 `skipped`，也写明了上面的规则。

新测试：

- `counts short words such as QR and CI when it decides whether a domain term is generic`：`QR code` 和 `ticket checkin` 占两个名额，`event platform` 记为超出名额；`ci cd` 排在 `web app` 前面。
- `says a generic-only term was displaced only when specific terms hold both phrase slots`：三个都只有泛用词时，落选的写 `over the two-phrase limit`；一个具体领域词加两个泛用领域词时也是这样。
- `lists topic slugs that are not GitHub topic slugs and domain terms with no searchable words, each once`：断言完整的遗漏列表，重复的只列一次；含换行的原文按 JSON 转义，空白值不列。
- `gives a later specific domain term the slot of a generic-only one and names what it leaves out` 按新的原因文字整句固定。

变异：新增 11 个（`T5-F1` 到 `T5-F11`），每个由上面的一个新测试杀死：用 `wordTokens` 判断泛用；名额条件用 `some`；恢复旧的原因文字；不列不合规的 topic；不列没有可搜索字符的领域词；重复的 topic 或领域词列两次；原文不按 JSON 引出（topic 和领域词各一个）；空白的 topic 或领域词也列入。`T5-M1d`、`T5-M3`、`T5-M6b` 的查找文本随代码更新，编号和意图不变。2026-10-27 在这个工作区用 `run-mutants.ts` 逐一运行这 11 个新变异和 3 个更新的变异，全部 KILLED；`src/repository-screening.ts`、`test/repository-screening.test.ts` 和 README 上其余 21 个原有变异重新运行，也全部 KILLED。

最后一轮复查后的修改：

- 上一轮改成逐词判断后，`an api`、`a tool` 里的 `an`、`a` 不在 `GENERIC_WORDS` 里，这两个领域词被当成具体的，占了两个名额，`event ticketing` 和 `ticket sales` 反而没有搜索。现在判断前先除去 a、an、the、of、to、in、on、for、and、or、with 这 11 个虚词（`SHORT_STOP_WORDS`）；只由虚词组成的领域词算作只有泛用词，只在没有别的领域词时使用。`QR code`、`ci cd` 仍是具体的领域词。
- 测试缺口：topic 名额的条件改成按已见过的 topic 数（含不合规的 slug）计算时，原有测试全部通过。

新测试：

- `ignores stop words such as an and a when it decides whether a domain term is generic`：`["an api", "a tool", "event ticketing", "ticket sales"]` 搜两个具体领域词，两个泛用领域词的遗漏原因整句固定；`of the` 排在 `event ticketing` 之后。
- `does not let an invalid topic slug take one of the two topic slots`：`["Code Search", "refunds", "payments"]` 两个 topic 都被搜索，只列出 `Code Search`。

变异：新增 3 个：不除去虚词（`T5-G1`）；不合规的 slug 占用 topic 名额（`T5-G2`，即复查的探针 NP2）；只由虚词组成的领域词算作具体的（`T5-G3`）。`T5-F1` 的查找文本随代码更新，编号和意图不变。2026-10-27 在这个工作区用 `run-mutants.ts` 逐一运行这 3 个新变异和 1 个更新的变异，全部 KILLED；`src/repository-screening.ts`、`test/repository-screening.test.ts` 和 README 上其余 34 个原有变异重新运行，也全部 KILLED。

这次实现没有运行 unshit，没有调用 Codex，也没有发出 GitHub 或 Grep 请求。

### 复核里被丢弃的存活错误实现让计划保持 Draft

第 11 次 CLI 自审把这一项列为 P0：复核结果里 host 用不上的内容不能支持 Ready。原来 `parseReview` 丢弃无法使用的存活错误实现（`acceptanceId` 不是 brief 的 A* ID、不是对象、文字为空或超长、第 12 项之后的项）时只记一条信息性缺口，就绪状态不变；缺少 `survivingMutants` 键的复核结果按没有错误实现处理，连缺口也不记。原有测试 `drops surviving mutants it cannot use from either review, records each drop in plan.md and the manifest and still completes` 正是这种情况：第一次复核的一条待决事项把验收 ID 写成 `T1-A1`，第二次复核的一条存活错误实现写成 `R1`，两条都被丢弃，计划仍为 Ready。复核 schema 要求 `survivingMutants` 键，按 schema 约束的输出缺不了这个键，也给不出 null 或非列表；但 `acceptanceId` 是任意字符串，文字没有长度限制，写错的 ID 和超长文字照样会出现。第 11 次的第一次复核报告了 5 项存活错误实现，都用了 A* ID，第二次复核报告 0 项，没有丢弃。

现在的做法：

- `recordReview` 把每条丢弃记为重大 `review` 缺口（`material: true`），文字不变，例如 `In review 2, the host dropped surviving mutant 1: R1 is not an acceptance criterion of the brief.`。重大缺口本来就让计划为 Draft，也写进 Draft 原因，所以没有加新的就绪条件；报告的缺口列表写 `Material (review)`。第一次复核里的丢弃同样算数：丢掉的一项可能是待决事项，而待决事项不论哪次复核报告都算数。
- `parseReview` 对缺少 `survivingMutants` 键的复核结果也记一条 `the host read survivingMutants as none because the review omitted it.`，值不是列表时仍是 `… because it is not a list.`。只有显式的空列表表示复核者没有找到错误实现。
- `parseReview` 仍不因 `survivingMutants` 让复核失败，能用的项照常保留，`findings` 照旧严格校验，运行不会因此失败。复核提示里关于 A* ID 和 12 项上限的一句后面加了 `Each dropped entry, and a review without a survivingMutants array, keeps the plan Draft.`；schema、manifest 格式和规则包都没有改。复核提示写在 `src/workflow.ts` 里，不计入规则包摘要，摘要不变，已有的补答文件仍然适用。
- 测试里的假复核默认返回 `{ findings: [], survivingMutants: [] }`，原先缺这个键的复核脚本也补上 `survivingMutants: []`，与 schema 的要求一致。
- 第 11 次为这项提出的另一条要求（只有针对最终计划的完整复核才能支持 Ready，复核要记下所复核计划的标识）现有代码已经满足：修正后的计划只由修正后完成的复核判断；那次复核失败时没有复核描述修正后的计划，还有一条校验问题让计划为 Draft。触发修正的是第一次复核里 blocking 或 material 的问题、不需要决定的存活错误实现，或没有被算作找到的计划引文（第 11 次提案的 T3 之后）。前两种本身让计划为 Draft；只因引文触发修正时，第一次复核可能是干净的。所以现在挡住“第一次复核代表修正后的计划”的只有那条校验问题：在副本里让第一次复核代表修正后的计划、同时去掉那条校验问题，由重大问题触发的修正仍为 Draft，只因引文触发、修正后引文都找到的计划会成为 Ready。这条路径由下面复核后补的测试固定。这次没有加计划标识。

新测试：

- `requires survivingMutants in the review schema and notes a review without the key`（原名 `requires survivingMutants in the review schema and reads a review without the key as none`）：缺少键时 `dropped` 为 `["the host read survivingMutants as none because the review omitted it."]`，显式空列表时 `dropped` 为空。
- `drops surviving mutants it cannot use from either review, records each drop as a material gap in plan.md and the manifest and completes as Draft`（原名见上）：两条丢弃都是重大 `review` 缺口，计划为 Draft，Draft 原因正好是这两条，plan.md 写 `Material (review)`。
- `keeps the plan Draft when the follow-up review omits survivingMutants`：第一次复核报告一条存活错误实现，修正后的复核没有 `survivingMutants` 键；计划为 Draft，唯一的 Draft 原因和唯一的 `review` 缺口都是 `In review 2, the host read survivingMutants as none because the review omitted it.`。修正后的复核给出显式空列表时计划为 Ready，由原有测试 `repairs a surviving mutant that needs no decision as a material finding and clears it after a clean review` 检查。

变异：新增 9 个（`T2-MA` 到 `T2-MH`，以及 `T2-M3b`），每个由一个具名测试杀死：丢弃仍记为信息性缺口、只有修正后复核的丢弃算重大、只有第一次复核的丢弃算重大、缺少键时不记、缺少键记成“不是列表”、null 不记、null 记成缺少键、显式空列表也记，以及跳过修正后的复核、让第一次复核代表修正后的计划。第 11 次计划为这项改进写了三个错误实现。T2-V1-M1（解析把格式不对的 survivingMutants 当作完整）在解析一侧早由 `FX-G3-M1`、`FX-G3-M2` 和 `FX-G3-M4` 杀死，在 workflow 一侧对应 `T2-MA` 和 `FX-G3-W15`。T2-V1-M2（解析把缺少的 survivingMutants 当作完整的空复核）是改动前代码的实际行为，现在对应 `I5-M01` 和 `T2-MD`。T2-V1-M3（修正改变说法后沿用 P 的完整复核）在现有代码里最接近的单行变异是 `FX-G3-W17`、`FX-G3-W19` 和 `T2-M3b`，都由原有测试杀死。变异目录里有 9 个原有变异（`I5-M01`、`I5-M02`、`I5-M03`、`FX-G3-M1`、`FX-G3-M7`、`FX-G3-W14`、`FX-G3-W15`、`FX-G3-W16`、`FX-P1-S1`）的查找文本、替换文本或测试名随这次修改更新，编号和意图不变；`FX-G3-W15` 原来守护“丢弃是信息性的”，现在守护“丢弃是重大的”，`I5-M01` 现在去掉缺少键时的说明。2026-10-27 在这个工作区用 `run-mutants.ts` 逐一运行这 9 个新变异和 9 个更新的变异，全部 KILLED；改动涉及的源文件和测试文件里其余 280 个原有变异重新运行，也全部 KILLED。

复核后的修改：两位复核者指出两处问题。

- 这一节原来说，第一次复核不可能让修正后的计划成为 Ready，因为触发修正的问题本身就让计划为 Draft。第 11 次提案的 T3 之后这不再成立：有引文没有被算作找到时也会触发唯一一次修正，第一次复核干净时同样修正。复核者在副本里让第一次复核代表修正后的计划，同时去掉后续复核失败时加的校验问题：只因引文触发、后续复核失败的修正以 Ready 结束，由重大问题触发的仍为 Draft。上面的说法已经改正，这条路径由新测试固定。
- 复核提示原来只说 host 丢弃哪些项，没有说丢弃会让计划保持 Draft。当初不改提示的理由也写错了：规则包摘要只覆盖 `src/resources/reference-plan`，不包括 `src/workflow.ts` 里的提示。现在提示加了上面列表里的那一句。

复核后补的测试和变异：

- `keeps a repaired plan Draft when only the host's quote finding started the repair, the first review was clean and the follow-up review failed`：第一份计划有一条 E1 里没有的引文，第一次复核干净，修正只收到 host 的引文问题；修正后的计划引文都找到，后续复核引用了不存在的 R9 而失败。计划为 Draft，没有任何重大缺口，Draft 原因正好是没有完成复核的说明和那条校验问题，`validationIssues` 只有这一条。
- `asks the reviewer for one wrong implementation per acceptance criterion and for the decision it needs` 按新文字整句固定 A* ID 和 12 项上限这一句。
- 新增 3 个变异。`T2-F2` 只去掉后续复核失败时加的校验问题：在副本里跑完整套测试，只有新测试失败，此前它在全部测试下存活。`T2-F1` 用一处替换同时去掉这条校验问题和“没有复核覆盖”的标记，等于复核者的双重变异，新测试和原有的 `says that no review covers a repaired plan …` 都会失败。`T2-F3` 删掉提示的新句子，由提示测试杀死。只把 `latestReview` 改成 `reviews.at(-1)` 的 `FX-G3-W17` 在新测试的情形下看不出区别，因为干净的第一次复核不加任何说明，它仍由原有测试杀死。
- 2026-10-27 在这个工作区用 `run-mutants.ts` 逐一运行这 3 个新变异，全部 KILLED；`src/workflow.ts` 和 `test/workflow.test.ts` 上其余 223 个原有变异重新运行，也全部 KILLED。

这次实现没有运行 unshit，没有调用 Codex，也没有发出 GitHub 或 Grep 请求。

### 计划引用附逐字引文，host 只在被引用的摘录里核对

第 11 次 CLI 自审把这一项列为 P1。原来计划里的引用只有摘录 ID 和模型写的说法：host 核对 ID 是它切出的摘录、参考比较的摘录来自该仓库的固定提交、引用的参考测试来自读作测试的文件，但说法依据的是摘录里的哪几行，没有任何可查的东西。第 11 次的计划有 64 个引用，37 个指向 50 行以上的摘录（中位数 60 行，最长 458 行）；这一项自己的一条依据引用的就是 `src/model-schema.ts` 第 689 到 876 行。第 11 次读到的 graphify 参考测试（`tests/test_evidence_binding.py` 第 43 到 59 行）检查另一种做法：模型返回的代码节点名在发送的源码里找不到时标为 `unverified`，节点保留，真实的节点不动，概念节点不查；它按标识符在整份发送的文件里查找，那组测试里的切片测试（第 179 到 200 行）用的切片其实是整份文件，按整份文件查找的实现也能通过。

现在的做法：

- 计划里的每个引用（任务、设计决策、模块、数据实体、不变式、访问边界、采用和淘汰的参考模式、参考测试、风险）多一个 `quote`，即被引用摘录里的一段原文。只有不是文字的引文（包括缺少引文）让 `parsePlan` 报错，和其他结构错误一样走一次计划修正；空、过短、过长和找不到的引文都不会让运行失败。复核意见的引用不变，仍只有摘录 ID 和说法。
- host 先把引文和摘录文字（发给模型的那几行）都做 NFKC 与空白归一化，和核对 `userWords` 的方法相同；归一化后的引文有 8 到 300 个字符（按 Unicode 码位计）并且出现在被引用的那段摘录里，`quoteInExcerpt` 才为 true。同一文件的其他摘录和文件的其余部分都不查。空的、不到 8 个码位的、超过 300 个码位的和摘录里没有的引文都保留，`quoteInExcerpt` 为 false，`quoteProblem` 写明原因：`empty`、`too_short`、`too_long`（保存时截到前 300 个码位）或 `not_found`。
- 没有算作找到的引文让计划带一条重大 `validation` 缺口 `The host did not count the quote of N plan citation(s) as found in the excerpt each cites; plan.md marks each one, and the plan JSON gives each quoteInExcerpt false.`，计划保持 Draft。这条缺口和参考测试缺口一样按每份计划计算：第一次复核前写进计划的 readinessNotes，修正后的计划重新计算，中途的检查点也带上它，最终就绪状态按最终计划。这些引用按它们在模型输出里的位置（例如 `decisions[1].evidence[2] cites E1`）列成一条 host 生成的重大问题，最多列 20 个（位置的序号从 1 开始），其余写成 `and N more, each with quoteInExcerpt false in CURRENT PLAN`，问题写明 host 的计数规则；它进入唯一一次复核修正，复核本身没有问题时也修正一次。进度分别写出复核的问题数和 host 的问题数（`Repairing N independent review finding(s) and M host finding(s) once.`），修正提示以 `Repair the current plan for the findings below, from the independent review or the host's checks.` 开头。
- plan.md 在找到的引文所在的引用旁边显示引文（行内代码，引文里有反引号时用更长的围栏）；没有算作找到的，按原因写 `the quote is empty, so the host did not count it as found in E1`、`the quote … is shorter than 8 characters, …`、`the quote …… is longer than 300 characters, …`（截下的部分加省略号）或 `the host did not find the quoted … in E1`。“Checks performed”写明 host 核对了引文的字数和它是否在被引用摘录的行里，并标出每个没有算作找到的引用，没有核对引文或摘录是否支持旁边的说法；“Trusted, not checked”的引用一行写明 host 只核对引文出现在摘录里，引文是否支持说法由规划和独立复核判断。
- 规划提示写明引文的要求：被引用摘录里连续的一段，逐字抄写，空白合并后 8 到 300 个字符，不用省略号缩短，不拼接，不引用别的摘录；过短、过长或找不到的引文都不算找到，计划保持 Draft。复核修正提示写同一条规则；host 上限一句不再提引文，因为 host 从不因引文长度拒绝计划。复核提示写明 `quoteInExcerpt` 只说明 host 在被引用的摘录里找到了引文，不说明引文支持说法，引文不支持说法的引用算作无依据的引用。计划修正通过后的进度写明核对的是引用的 ID，没有算作找到的引文仍标着。manifest 原样保存计划，每个引用带 `quote` 和 `quoteInExcerpt`，没有算作找到时还带 `quoteProblem`。规则包没有改，摘要不变。
- unshit agent skill 多了一行：把计划里每个引用的引文放回它引用的那几行里读；`quoteInExcerpt` 为 true 只说明 unshit 在那几行里找到了引文，没有核对它支持说法；为 false 时 plan.md 在引用后写明原因，agent 要先读那几行再依赖这条说法，并告诉用户哪些任务依赖它。skill 不计入规则包摘要，已有的补答文件仍然可用。
- 第 11 次为这项提出的另外几条要求，现有代码已经满足，这次没有改。任务的 `requirementIds` 解析后原样保存进 manifest（`storage.ts` 保存整份计划）；设计项、决策和风险本来就没有要求关联，加上属于新范围。修正会重新解析整份计划，现有代码没有保存任何对说法的支持判断，`quoteInExcerpt` 每次解析都重新计算，修正后的说法不会沿用修正前的结论。搜索命中和 host 核对过的引用本来就分开：引用只能指向 host 从读过的文件切出的摘录，代码搜索的命中只在仓库筛选一节写成 `Code search matched`。

测试夹具里每个计划引用都改为引用摘录里确有的文字。检查方法：在这个工作区的副本里让 host 每遇到没有算作找到的引文就记一行，跑完整套测试，除了下面新测试有意构造的情况，一行也没有。为此，10 个工作流测试的计划改用它们实际引用的摘录里的文字：其中 9 个测试的 E1 不是默认的 `src/index.ts`，而是测试文件、`package.json`、文件树里的填充文件，或内容为 `export const value = true;` 的文件；另一个测试把 `src/index.ts` 的摘录当作参考测试引用，这条引用的引文也改为抄自这段摘录。一个没有参考仓库的测试改用不带引用的计划。

测试（括号里是复核后改过的旧名）：

- `keeps a plan citation's quote normalized and finds it only in the lines of the excerpt it cites`：跨行、带多余空白的引文归一化后找到；同一文件另一段摘录里有、被引用摘录里没有的文字找不到；不在任何摘录里的文字找不到；8 个码位的引文找到，7 个码位的找不到，含一个 emoji 的 7 个码位引文（8 个 UTF-16 单元）也找不到。
- `rejects only a quote that is not text, and keeps an empty, too short, too long or unfound quote with its reason`（原名 `rejects a plan citation whose quote is missing, blank or longer than 300 characters`）：缺少和不是文字的引文各给出确切的错误消息；空白的引文记为 `empty`，7 个码位的记为 `too_short`，摘录里没有的记为 `not_found`；300 个字符的引文找到，301 个字符的记为 `too_long` 并截到 300。
- `counts a quote's characters after whitespace is collapsed, so ten indented lines fit and 'a  b  c  d' is too short`：十行缩进代码的引文写出来 349 个字符、空白合并后 229 个，算作找到；`a  b  c  d` 合并后 7 个码位，记为 `too_short`。
- `finds a verbatim Chinese and full-width quote, and quotes that only NFKC equates with the excerpt`：`// 计算退款金额（不含运费），单位：分` 原样引用时找到；引文用半角标点而摘录用全角标点，或引文用全角字母而摘录用半角字母时，也找到。
- `finds a quote written with spaces in a Go excerpt indented with tabs`：用空格缩进的引文在用 tab 缩进的 Go 摘录里找到。
- `lists every plan citation whose quote the host did not count as found, by its output path, from tasks, decisions, design, comparisons and risks`（原名 `lists every plan citation whose quote the host did not find, from tasks, decisions, design, comparisons and risks`）：九种引用各有一个没有算作找到时，`unquotedCitations` 按解析顺序列出九个确切的位置，决策的第二个引用写成 `decisions[1].evidence[2]`；都找到时为空。
- `asks for a quote on every plan citation and none on a review finding`：计划 schema 的各类引用都要求 `quote`，复核意见的引用不要求；解析出的复核引用只有摘录 ID 和说法。
- `shows each plan citation's quote and says when the host did not find it in the cited excerpt`：十处计划引用都显示引文，含反引号的引文用双反引号围栏，找不到的写明没有找到。
- `says after each citation why the host did not count its quote as found`：四种原因各一句确切的文字，过长的引文显示截下的部分和省略号。
- `keeps a plan Draft with a material gap and asks the review repair to fix a citation whose quote is not in its excerpt`：运行照常完成，校验历史为空；计划为 Draft，唯一的 Draft 原因是这条缺口，两次复核都看到它；复核修正收到 host 生成的问题，修正提示的开头和进度都写明问题来自复核和 host 的检查；manifest 里这个引用带引文、`quoteInExcerpt: false` 和 `quoteProblem: "not_found"`，任务带 `requirementIds`；plan.md 写明没有找到。
- `counts and names every citation whose quote the host did not count as found, with the reason for each in plan.md`：两个引用没有算作找到（一个不在摘录里，一个过短），缺口写 2 个，host 的问题列出两个位置，plan.md 写明过短的原因。
- `names at most 20 citations in the host's finding and counts the rest`：26 个没有算作找到的引用，问题列出前 20 个位置，再写 `and 6 more`；缺口写 26 个。
- `says that a passed validation repair checked citation IDs and keeps the marks of the quotes it did not count as found`：计划修正通过后的进度用新文字，修正后的计划仍标着没有算作找到的引文。
- `clears the quote gap when the review repair copies the quote from the cited excerpt`：修正后的引文找到，缺口消失，修正后的复核看不到它，计划为 Ready。
- `keeps a plan Draft when the review repair changes a citation to a quote that is not in its excerpt`：第一份计划的引文都找到，修正改了说法和引文且找不到，计划为 Draft。
- `tells the planner, the reviewer and the review repair how the host counts a quote, and leaves quotes out of the host's rejection limits`（原名 `tells the planner and the review repair to copy each citation's quote from the excerpt it cites`）：规划提示、复核提示和复核修正提示的整句；host 上限一句里没有引文。
- `saves each plan gap with every checkpoint whose plan notes hold it, also when review is interrupted or times out`（原名 `saves the reference-test gap with every checkpoint whose plan notes hold it, also when review is interrupted or times out`）：场景表加了引文缺口的三个场景：第一次复核中断、修正改好了引文、修正没有改好。
- `names only fields that the run result and the plan carry`：skill 写到的 `quote` 和 `quoteInExcerpt` 由 host 类型检查。
- 原有测试按新文字固定：“Checks performed”一段（测试改名为 `describes the checks performed as excerpt ID, quote, comparator commit, coverage, command and dependency checks`）、“Trusted, not checked”的引用一行、参考测试在报告里的显示、host 上限一句、存活错误实现修正时的进度，以及解析后的采用模式和计划 schema 里参考测试引用的形状。

变异：新增 42 个（`T3-M1` 到 `T3-M18b`，以及十个 `T3-R-*`），每个由一个具名测试杀死：在同一来源的全部摘录或在全部摘录里查找、引文或摘录不归一化、没有码位下限、按 UTF-16 单元计数、下限差一、引文可以缺少、上限改为 400、记录漏掉一部分引用、`unquotedCitations` 恒为空、计划 schema 不要求引文、复核 schema 也要求引文、找不到引文时报校验错误（第 11 次提议的 `Citation witness is absent from the supplied excerpt.`，第二次找不到就让运行以错误结束）、没有缺口、缺口不是重大缺口、第一份计划不带这条缺口、不请修正、host 的问题是 minor、引文都找到时也请修正、修正后保留旧缺口、修正后仍按第一份计划判断、三处提示各删一处、报告把找不到的显示成找到、围栏长度或空格不对、十处引用各自不显示引文，以及“Checks performed”和“Trusted, not checked”各删一处。第 11 次计划为这项写了四个错误实现。T3-V1-M2（引文核对查整个文件）对应 `T3-M1` 和 `T3-M2`。T3-V1-M4（修改过的说法沿用上一份计划的支持判断）对应 `T3-M11`，反方向是 `T3-M10`。T3-V1-M1（序列化保留引文却丢掉要求关联）和 T3-V1-M3（只有搜索命中的记录显示成 host 核对过的引用）在现有代码里没有对应的路径；前一个由 `keeps a plan Draft with a material gap …` 读取保存的 manifest 时一并检查。变异目录里有 10 个原有变异（`I2-M19`、`I2-M23`、`I3-M11`、`I3-R2`、`I3-W1`、`I5-W03`、`FX-G4-S2`、`FX-G4-W6`、`FX-G4-W7`、`FX-G5-W3`）的查找文本或替换文本随这次修改更新，编号和意图不变；另有 6 个原有变异的测试名随改名更新。2026-10-27 在这个工作区用 `run-mutants.ts` 逐一运行这 42 个新变异、10 个更新的变异和另外 5 个改了测试名的变异，全部 KILLED；改动涉及的源文件和测试文件里其余 360 个原有变异重新运行，也全部 KILLED。

复核后的修改：两位复核者发现，第一版对引文长度的上限是在合并空白之前、对原文施加的，而且超长或空白的引文算结构错误。复核者复现了一次会让运行失败的情况：采用模式引用十行缩进代码，原文 316 个字符、合并后 204 个；计划修正只收到第一条错误（`adopted pattern evidence[1].quote must contain 1 to 300 characters.`，没有比较的序号），修正后的计划把同一段引文放到模块的引用里，运行以错误结束，而这份计划在加引文核对之前是能通过的。另外，不到 8 个码位的引文根本不查找，plan.md 却写“host 没有找到”，host 的问题让模型重新抄写，这修不好过短的引文；进度把 host 的问题算成复核的问题；问题里重复每条说法，没有上限，决策和风险的标签没有序号；缺口的“no checked witness”读起来像找到的引文就支持说法。修改后的做法见上面的列表：只有不是文字的引文报错；先归一化，再按码位数下限和上限，空的、过短的、过长的和找不到的引文都保留并记下原因；每种原因在 plan.md 里有自己的一句；问题和修正建议写明计数规则；进度和修正提示写明问题来自复核和 host 的检查；问题按位置列出引用，最多 20 个；缺口改了措辞；规划、复核修正和复核提示写了新规则，host 上限一句去掉了引文；skill 加了一行。README 不再说空白或超长的引文要走计划修正。`docs/architecture.md` 改正了 manifest 摘录 SHA-256 的说法：它是对归一化之前的摘录文字算的，host 查找用的是归一化后的文字。

复核后补的测试和变异：复核者有六个探针变异在原来的 455 个测试下都存活：引文一侧不做 NFKC（PB2）、`normalizedWords` 不合并 tab（PB3）、下限按归一化之前的原文计数（PB7）、host 的问题只列第一个引用（PB4）、缺口的个数写死为 1（PB6）、检查点丢掉 `validation` 类缺口（PB5）。上面列表里的新测试逐一杀死它们，这六个探针记为 `T3-F-PB2`、`T3-F-PB3`、`T3-F-PB7`、`T3-F-PB4`、`T3-F-PB6` 和 `T3-F-PB5`。另外新增 23 个 `T3-F-*` 变异：上限按原文计数、上限差一、过长的引文不截、空的引文记成过短、位置序号从 0 开始、采用模式的引用用不带序号的错误标签、问题不设 20 个的上限、不写其余的个数、进度和修正提示把 host 的问题算成复核的、计划修正后的进度仍写“citation checks”、缺口回到“no checked witness”、问题和修正建议回到旧文字、复核提示没有新的一句、规划提示不说空白合并后计数、plan.md 把空的、过短的和过长的引文都写成“没有找到”、过长的引文不加省略号、“Checks performed”回到“did not find there”或只写下限、skill 没有新的一行。变异目录里有 16 个原有变异的查找文本或替换文本随修改更新（`I3-M11`、`FX-G5-W3`、`T3-M2`、`T3-M3`、`T3-M4`、`T3-M4b`、`T3-M4c`、`T3-M5`、`T3-M6`、`T3-M8b`、`T3-M9b`、`T3-M9c`、`T3-M12`、`T3-M12b`、`T3-M13`、`T3-M17`），编号和意图不变，只有 `T3-M12b` 换了方向：host 上限一句不再提引文，它现在守护的是这一句没有重新加回引文长度；另有 11 个原有变异的测试名随改名更新。2026-10-27 在这个工作区用 `run-mutants.ts` 逐一运行这 29 个新变异、16 个更新的变异和另外 6 个只改了测试名的变异，全部 KILLED；改动涉及的源文件、测试文件、skill 和 README 上其余 494 个原有变异重新运行，也全部 KILLED。

最后一轮复核后的修改：

- 复核者又有三个探针变异在全部测试下存活，现在各有测试杀死。NP1：引用位置里比较和模式的序号对调，因为每个夹具都只有一个比较、一个模式。新测试 `names each citation by the 1-based indices of its comparison, pattern, decision, design item and risk` 用两个比较，第二个比较的第三个采用模式和第三个淘汰模式、第二个决策、第二个设计项和第二个风险的引文都没有算作找到，断言九个确切的位置，例如 `referenceComparisons[2].adoptedPatterns[3].evidence[1]`。NP3：先查摘录再查长度。`rejects only a quote that is not text, …` 加了两条：400 个码位、摘录里也没有的引文记为 `too_long` 并截到 300，3 个码位、摘录里也没有的记为 `too_short`。NP4：300 的上限按 UTF-16 单元计数。新测试 `counts the 300 limit in code points, so a quote of 200 emoji, 400 UTF-16 units, counts as found` 用 200 个 emoji 的引文。
- 修正时的进度分开写出两种问题的个数：`Repairing N independent review finding(s) and M host finding(s) once.`，只因存活错误实现而修正时写 `… and 0 host finding(s) …`。修正提示的第一句改为 `Repair the current plan for the findings below, from the independent review or the host's checks.`。host 的问题写明位置的序号从 1 开始，只计数的引用写成 `and N more, each with quoteInExcerpt false in CURRENT PLAN`；README 改为修正收到一条按位置列出这些引用的 host 问题（最多 20 个，其余只写个数）。
- 参考测试缺口的第一句改为 `No adopted pattern pairs a reference test with the production code it exercises, so no read reference test stands behind the adopted reference code.`，不再说计划凭信任采用参考代码，好像有成对的测试就等于检查过代码；测试只读取，没有运行。复核和复核修正提示的触发条件随之改为缺口的说法。
- skill 那一行改为先说引文是模型从引用的那几行抄来的，`quoteInExcerpt` 为 true 时 unshit 在那几行里找到了引文、没有核对它支持说法，为 false 时先读那几行再依赖这条说法；新测试 `has the agent read each citation's quote in the lines it cites, and says what quoteInExcerpt does not show` 按整行固定它。README 对 skill 的说明跟着改。文档里“没有计入找到”的说法改为“没有被算作找到”；“引文问题不会让运行失败”改为只说空、过短、过长和找不到的引文不会让运行失败，因为缺少或不是文字的引文仍是结构错误，计划修正也失败时运行以错误结束。
- 变异：新增 20 个 `T3-G-*`（`T3-G-NP1a` 到 `T3-G-NP1i`、`T3-G-NP3`、`T3-G-NP4`、三个计数和来源的说法、缺口的旧说法、两个旧的触发条件、不说序号从 1 开始、不说其余引用带 `quoteInExcerpt: false`、skill 不说没有核对支持），8 个原有变异的查找文本或替换文本随修改更新（`I3-P5`、`T3-M9`、`T4-F6`、`T3-F-A1`、`T3-F-A2`、`T3-F-F1`、`T3-F-MORE`、`T3-F-S1`），编号和意图不变。2026-10-27 在这个工作区用 `run-mutants.ts` 逐一运行这 28 个，全部 KILLED；改动涉及的 `src/workflow.ts`、skill、README 和三个测试文件上其余 439 个原有变异重新运行，也全部 KILLED。

### 检查记录

上面四节是同一组改动，在同一个工作区里依次实现；两位复核者（行为与测试、文字）各复核两次，之后的修改也在其中。检查结果只在这里记一次，对应这组改动交付时的代码。下表于 2026-10-27 在这个工作区运行。

| 检查 | 结果 |
| --- | --- |
| `bun run check` | 473 项通过，0 失败，2497 次 expect |
| `bun run build` | 成功 |
| 变异目录 | 共 885 个变异，保存在仓库之外：此前的 721 个，加上这四项和复核修改新增的 164 个 |
| 完整变异运行 | `run-mutants.ts` 逐一运行全部 885 个变异，885 个 KILLED |
| 官方技能格式检查 | `skill-creator/scripts/quick_validate.py` 验证 `src/resources/unshit-skill`：Skill is valid! |

以上四项修改都没有运行 unshit，没有调用 Codex，也没有发出 GitHub 或 Grep 请求；引文核对对真实模型的影响（引文找不到的比例、计划大小、计划回合用时）要等下一次 CLI 实跑才知道。

## 未执行的环境

Linux 原生运行尚未验证。读取上游源码和测试文件不代表执行了上游测试，也不代表已验证目标业务系统。

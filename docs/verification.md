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

## CLI 自审实跑记录（2026-10-14 至 2026-10-16）

需求文字每次相同，都是请 unshit 检查自身并规划最需要的改进。第 1 次没有指定 `--effort`，使用 Codex 配置里的 xhigh；第 2 次和第 4 到 9 次用 `--effort medium` 直接运行 CLI；第 3 次用仓库外的驱动脚本调用同一个 `runWorkflow`，effort 为 medium，回合上限 900 秒。

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

每次都发出了真实的 GitHub 和 Grep 请求，发现阶段的 Grep 代码搜索每次匹配 6 到 13 个仓库。第 1 到 3 次的每个定位查询都返回 `ok`；第 6 到 9 次各用满 12 次的 Grep 请求额度，各有 1 到 3 个定位查询记为 `skipped`，没有发出。运行日志和输出保存在仓库之外。

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

## 未执行的环境

Linux 原生运行尚未验证。读取上游源码和测试文件不代表执行了上游测试，也不代表已验证目标业务系统。

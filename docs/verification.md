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

## CLI 自审实跑记录（2026-10-14 至 2026-10-27）

需求文字每次相同，都是请 unshit 检查自身并规划最需要的改进。第 1 次没有指定 `--effort`，使用 Codex 配置里的 xhigh；第 2 次和第 4 到 11 次用 `--effort medium` 直接运行 CLI；第 3 次用仓库外的驱动脚本调用同一个 `runWorkflow`，effort 为 medium，回合上限 900 秒。

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
| 11 | `a97848e` | 退出码 0，Draft，9.9 分钟，2 个参考仓库（bgauryy/octocode、Graphify-Labs/graphify）；PDD Kit 借鉴改动之后的第一次实跑，见下文；文件挑选选满 20 个文件，`src/cli.ts`、`src/storage.ts`、`src/app-server.ts` 和 `src/local.ts` 都没有摘录；补充请求 8 项处理了 7 项 |

每次都发出了真实的 GitHub 和 Grep 请求，发现阶段的 Grep 代码搜索每次匹配 6 到 13 个仓库。第 1 到 3 次的每个定位查询都返回 `ok`；第 6 到 9 次各用满 12 次的 Grep 请求额度，各有 1 到 3 个定位查询记为 `skipped`，没有发出。第 10 次的第 2 个发现查询（`evidence`）以 `invalid_response` 失败，之后的查询都记为 `skipped`；当时的记录只有失败类别。第 11 次的 3 个发现查询和 8 个定位查询都返回 `ok`。运行日志和输出保存在仓库之外。

第 11 次（2026-10-27，Codex CLI 0.162.1）是具名错误实现、参考测试引用、brief 批准、复核存活错误实现和“Trusted, not checked”这组改动合并之后的第一次实跑。用 `--jsonl` 运行，所以 host 没有请人批准 brief。结果如下：

- 计划和修正后的计划第一次就通过 host 校验，没有校验修正回合；新增的必填字段（`rejectsMutants`、`testEvidence` 或 `untestedReason`、`userWords`、`survivingMutants`）都按 schema 和长度上限填写。
- intake 得到 4 条要求，没有重大问题；4 条都在需求原文里找到引文，标为“you said”。
- 6 个任务各有 1 个验证方法（2 个人工检查，4 个使用已读的项目脚本），共 21 个具名错误实现。
- 两个参考仓库各有一个采用模式，各引用一个读作测试的参考测试摘录，所以没有记录“没有采用模式引用参考测试”的缺口。只有 octocode 的模式是真正成对的：`evidence` 引用实现文件 `research-output.ts` 的摘录，`testEvidence` 引用它的测试。graphify 的模式只引用了测试文件 `tests/test_evidence_binding.py` 的同一段摘录，`evidence` 和 `testEvidence` 都是它；这个测试所测的 `graphify.llm` 实现没有读到。host 只检查 `testEvidence` 来自读作测试的文件，没有要求同一模式引用实现摘录，所以没有拦下这种情况；计划自己的 Draft 原因提到了它。
- 第一次复核报告 3 项重大问题和 5 个存活错误实现，都不需要业务决定，一起进入唯一一次修正；修正后的复核没有问题，也没有存活错误实现。第 10 次的第一次复核只有 1 项重大问题。
- 计划为 Draft，原因有三条：两条是计划自己写的证据缺口（摘录里没有 CLI、App Server、本地扫描、存储、安装和失败处理的实现及测试；graphify 的证据绑定测试所测的实现没有读到），另一条是没有人批准 brief。补答文件保存了可编辑的 brief，`approveBrief` 为 false。
- plan.md 的“Trusted, not checked”列出两个参考仓库的星数、日期、运行时解析的默认分支最新提交、按文件名统计的测试路径、读取但未运行的文件数和许可证依据，并写明 21 个错误实现、2 个参考测试摘录和复核结论都没有运行过。

这次没有人批准 brief，所以 Ready 的完整路径还没有在实跑中验证；计划自己写的两条证据缺口也还没有解决。

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

复核后的修改：存活错误实现不再能让运行失败。`parseReview` 仍严格校验 `findings`；存活错误实现中空白的 `decisionNeeded` 当作没有决定，`acceptanceId` 不是 brief 中 A* ID 的项、不是对象或文字超长的项、第 12 项之后的项都被丢弃，字段不是列表时按没有处理；每次丢弃在计划的缺口列表和 manifest 的 `gaps` 里记一条信息性缺口，就绪状态不变。复核提示写明 `acceptanceId` 用 brief 的 A* ID 而不是 T1-A1 这样的任务验收 ID，最多 12 项，并要求 brief 没有定下的业务选择只作为带 `decisionNeeded` 的存活错误实现报告，不写成问题或修正建议。待决事项的说明引用验收标准原文，并按 brief 的批准方式给出做法。修正通过校验而后续复核没有完成时，计划为 Draft，原因写明没有完成的复核覆盖修正后的计划，第一次复核的问题和不需要决定的存活错误实现不再写成 Draft 原因，任何一次复核的待决事项仍是 Draft 原因；修正本身失败时仍写 `The bounded review repair did not complete.`。“Trusted, not checked”多了一行：存活错误实现和没有存活错误实现都只是复核模型的推理。新测试检查：只有修正后的复核报告的待定决定同样让计划为 Draft；有两条要求时，A2 的存活错误实现转成针对 R2 的完整重大问题；复核提示里 `decisionNeeded` 的条件、先给反例的要求、A* ID 与 12 项上限和业务选择这几句整句固定；两次复核里无法使用的存活错误实现都被丢弃，丢弃记录写进 plan.md 和 manifest，运行照常完成；修正后的复核失败时计划写明没有复核覆盖，去掉第一次复核过时的说明，并保留第一次复核的待决事项；三种批准方式各有对应的待决事项做法；复核 schema 的 `maxItems` 为 12；进度行写出存活错误实现的个数。

这次没有运行 unshit，没有调用 Codex，也没有发出 GitHub 或 Grep 请求。复核者在真实计划上报告的存活错误实现见“CLI 自审实跑记录”的第 11 次。

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

## 步骤与参考预览（2026-10-28）

提交 `4b83f46`（`feat: preview each run stage and the references it used`）：搜索之后写出 `.unshit/<run-id>/preview.html`，在终端列出每一步和它用到的参考，输入 `yes` 才开始候选排序；之后每一步完成时先更新页面和终端；最终的 `plan.md`、`preview.html` 和 manifest 是同一版；`--json`、`--jsonl` 或没有终端的运行停在预览，退出码 2。这项改动先用 unshit 规划（Draft，任务 T1 到 T5，33 个具名错误实现），再按计划实施。

| 检查 | 结果 |
| --- | --- |
| `bun run check` | 469 项通过，0 失败（原有 433 项，新增 36 项） |
| 具名错误实现 | 计划中 31 个可自动检查的错误实现，加上第二次复核报告存活的 3 个，逐个在仓库之外的临时副本里应用，34 个都被指定的测试杀死，失败方式与计划写的一致 |
| 页面的手动检查（T2-V2） | 在本机 Chrome 直接从磁盘打开页面：键盘展开参考细节、跳到参考条目，中英文标签，浅色和深色，390px 宽，没有页面之外的请求，17 项通过；细节只放在悬停提示里的错误实现，键盘检查失败 |
| Markdown 的手动检查（T5-V2） | 用 marked 渲染含恶意标签的计划，只有 host 生成的链接可以点击，没有伪造的标题、图片或脚本，5 项通过；把标签原样写进 Markdown 的错误实现，5 项都失败 |
| 流程图 | 先用原来的步骤重新生成，四个 SVG 与仓库中的逐字节相同；再把第 4 步改为“搜索与预览”后重新生成 |
| 网站 | 按 DESIGN.md 的四种设置渲染，没有横向溢出、控制台错误或失败的请求 |

真实运行：2026-10-28 在这个工作区用源码运行（`bun src/cli.ts`，提交 `4b83f46`，工作区没有未提交的改动），需求与 `.unshit/2026-10-28T08-46-42-409Z-c9c4d9e6` 相同，并用同一份补答文件。终端中输入 `yes` 批准 brief 之后，搜索匹配 30 个仓库，27 个通过元数据门槛，3 个因建立不到 180 天被排除；运行在预览处停下，终端列出全部步骤，下游步骤都是 pending。终端输入 `yes` 后，候选排序、文件树检查、选择、选文件、读取、补充证据、计划、复核、就绪判定依次发布第 2 到第 10 版，保存后为第 11 版。`plan.md` 的“Stages and references”一节、`preview.html` 和 manifest 的 `preview` 都是第 11 版；页面链接的 30 个源码快照都能打开，SHA-256 与页面所示一致。运行 39 分钟（本地时间 21:12 到 21:51），结果为 Draft：azure-dev 和 sparkMeasure 在固定提交没有索引到 manifest 文件，sparkMeasure 没有可读的测试文件，复核后的修正没有通过 host 校验，复核留下两个重大问题。其中一个与这项改动有关：候选排序和选文件两步只记录模型返回的结果，没有记录提供给模型的全部候选和文件。

这次没有用 `--json` 真实运行新版本；脚本运行停在预览的行为由测试覆盖。

## 未执行的环境

Linux 原生运行尚未验证。读取上游源码和测试文件不代表执行了上游测试，也不代表已验证目标业务系统。

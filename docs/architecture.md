# 实现结构与参考

```text
CLI / JSON caller
       |
       v
workflow: intake -> answers -> brief rebuild -> search -> tree screen -> selection -> evidence -> plan -> fresh review
    |                |          |                  |
    v                v          v                  v
Codex App Server   public APIs  snapshots        PlanDoc
auth / thread /    + local FS   + manifest          |
turn / interrupt                                  v
                                           Markdown / JSON
```

## 边界

| 文件 | 职责 |
| --- | --- |
| [cli.ts](../src/cli.ts) | 参数、终端澄清、ASCII 进度、JSON/JSONL 和退出码 |
| [workflow.ts](../src/workflow.ts) | 需求门槛、答复后的 brief 重建、候选预排序、筛选与选择、读取、计划生成、独立复核与有界修正、超时结果与检查点 |
| [app-server.ts](../src/app-server.ts) | 原生双向 RPC、活动回合关联、最终文本、取消、空闲与总时长超时、失败原因和进程清理 |
| [github.ts](../src/github.ts) | host-built GitHub 查询、Grep 代码搜索、质量门槛、固定提交树验证与 GitLab 官方 API 回退 |
| [code-search.ts](../src/code-search.ts) | Grep 请求体、响应解析、按仓库聚合命中、批量 GitHub 元数据查询条件 |
| [local.ts](../src/local.ts) | 本地文件基线、排除规则、凭证值遮蔽与私钥文件排除、已存在脚本依据 |
| [repository-screening.ts](../src/repository-screening.ts) | 领域查询材料清理、查询计划、候选信号解析、整词候选排序、元数据与树质量判断 |
| [file-ranking.ts](../src/file-ranking.ts) | 需求词加权、测试与实现文件配额、文本路径和根许可证路径判断、许可证文件选择 |
| [evidence.ts](../src/evidence.ts) | 有界读取、共享文件排序、源码哈希、行范围、来源 ID 与固定链接 |
| [model-schema.ts](../src/model-schema.ts) | 每轮 JSON Schema、结构校验、来源归属、完整覆盖和依赖无环 |
| [report.ts](../src/report.ts) | 设计、比较、任务、验收、验证与源码对应表的 Markdown 输出 |
| [storage.ts](../src/storage.ts) | 原子保存报告、证据快照和可核对的补答请求上下文 |
| [instructions.ts](../src/instructions.ts) | 内嵌技能入口、阶段模块与 host/model 职责约束，计算整个规则包的摘要 |

## 状态归属

Codex 管理认证与会话。CLI 在内存中关联 RPC 和当前回合；应用保存源码字节、哈希、有效行范围、计划及缺口。这些数据用于核对引用和保存中断前已有结果。

`needs_input` 的补答文件保存原问题与提示词、目录、规则版本的摘要。它解决非交互重跑时问题顺序或措辞变化的问题。重新运行后仍由需求门槛检查未解决的重大业务问题。

已回答的问题以 `resolvedAnswers` 传给候选选择、规划、复核及修正回合，并写入最终结果、报告、manifest 和中断检查点。报告将初始摘要与最终范围分别标注。

已有本地脚本与实施后要创建的命令分开记录。上游测试读取只支持参考判断；CLI 不把它们当作目标应用已执行的测试。

每个 Codex 回合有两个时限。thread 上连续 10 分钟没有任何通知算空闲超时；session 就绪、回合请求发出之后，超过空闲时限的 3 倍算总时长超时。`--turn-timeout` 设置空闲时限。超时后 host 发送 `turn/interrupt`；即使 Codex 以 `interrupted` 结束该回合，结果仍是 `timed_out`，不当作用户取消，CLI 退出码为 124。brief 重建、候选排序、计划修正和复核修正超时后走各自原有的失败处理。失败的回合会读取 `turn.error`，没有时读取该回合最后一条 `error` 通知，去掉链接和 token 后最多保留 300 个字符。Codex 拒绝 `turn/start` 请求时，错误消息保留 Codex 给出的原因，连接随后断开时也一样；去掉链接和 token 后，整条消息最多 240 个字符。Codex 进程退出后，读取端最多再等 1 秒，把 stdout 中已有的回应读完，之后才让未完成的请求失败。

检查点按实际原因保存：`evidence`、`plan`、`interrupted`、`timed_out`、`failed`、`needs_input`。还没有计划时，占位计划的标题和说明对应这个原因；只有未通过 host 验证的计划才标为 `Draft plan blocked by validation`。

通过元数据门槛的候选多于 `GitHubResearcher.treeResolutionLimit` 时，workflow 先按 research 阶段的规则请模型排序，再按这个顺序检查文件树；排序失败、超时或返回未知 ID 时退回 host 排序，并记录非重大缺口。`research.trustworthyReferenceFound` 在读取源码之后计算。

公开仓库搜索由 host 使用 intake 的 `domainTerms` 和 `topicSlugs` 构建三档查询；模型不能直接编写 GitHub 查询语法。GitHub 与 GitLab 返回的星数、fork、归档、许可证、语言、topic 和日期信号写入研究摘要。host 先应用星数、推送日期、创建年龄、归档与 fork 门槛，再读取固定提交的树，确认存在测试文件；若搜索元数据没有可识别的 SPDX 许可证，包括 GitHub 无法识别时返回的 `NOASSERTION`，则要求树中有根目录许可证文件；同时有多个时优先标准文件名，`LICENSE-*` 只作备选，证据读取使用同一个文件。树检查通过后才交给模型选择，筛选原因和未发送查询也保存在 manifest 中。

GitHub 树响应上限为 8 MB，源码响应仍为 1 MB。文件树不再按字母顺序裁剪；GitHub 的 `treeTruncated` 使用提供方返回的截断标志。GitLab 树最多读取 25 页、每页 100 项；若 host 达到页数上限且仍有下一页，也会将该树标为截断。`file-ranking.ts` 被文件候选展示和自动证据挑选共享：它按 brief 与答复的领域词打分，并为测试、实现文件分别保留配额。

文件挑选回合的提示只列出每个已选仓库的来源、提交和日期，不附整棵文件树。可选文件按来源分组，每个文件只带 ID、路径、大小、角色提示和代码搜索命中。整份文件清单最多 300,000 个字符，本地项目和每个已选仓库平分额度，排名靠后的文件先被省略，省略的数量记为非重大缺口。模型返回未提供或重复的文件 ID 时，host 忽略这些 ID 并记录非重大缺口，运行继续。

证据摘录：不超过 150 行的文件整份摘录。更长的文件先取开头 30 行，再按需求词和代码 pattern 的得分从高到低取最多 4 个区段。每个命中行扩展到包住它的函数、类或类型定义：定义不超过 150 行就整段摘录，更长时取命中行附近的 150 行；没有定义包住时取附近 60 行。所有摘录合计最多 260,000 个字符；每个文件分到剩余额度的平均份额，小文件用不完的额度留给后面的文件。

代码搜索同样由 host 执行，模型线程的 MCP 仍全部关闭。host 向 `https://mcp.grep.app` 发送 JSON-RPC `tools/call`，调用 `searchGitHub`，请求不带任何凭证。该服务无会话，响应为 SSE；每次最多 10 条结果，链接指向分支而不是提交，也没有星数和日期。发现阶段最多搜 3 个 pattern，按命中的不同 pattern 数排序，忽略示例和文档路径，最多把 4 个新仓库合并为一次 `repo:` GitHub 搜索，再交给 `collectEntries` 的同一门槛。树验证通过后，每个仓库最多再搜 2 个发现阶段未命中的 pattern。`repo` 参数是部分匹配，所以 host 只保留仓库名完全一致、且路径存在于固定提交树的命中，写入 `RepositorySnapshot.codeMatches`。文件挑选和证据读取优先使用这些文件，摘录窗口对准 pattern 所在行。查询记录写入 `research.codeSearch`，随 manifest 保存。`research.md` 没有修改，规则包摘要不变。

## 功能与固定源码依据

下表记录采用的原生协议行为。固定版本为 `openai/codex@322bbf4d8486efd7dbbcf49598711a9e3fefc282`，本机实际验证版本为 Codex 0.160.0。

| 功能 | 参考位置 | 本项目采用方式 |
| --- | --- | --- |
| 请求、响应、通知及 ID | [rpc.rs L1-L79](https://github.com/openai/codex/blob/322bbf4d8486efd7dbbcf49598711a9e3fefc282/codex-rs/app-server-protocol/src/rpc.rs#L1-L79) | 双向消息分类与请求关联 |
| 回合完成判定 | [turn.rs L30-L38](https://github.com/openai/codex/blob/322bbf4d8486efd7dbbcf49598711a9e3fefc282/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L30-L38) | completed、failed、interrupted 分开处理 |
| 每轮结构化输出 | [turn.rs L273-L276](https://github.com/openai/codex/blob/322bbf4d8486efd7dbbcf49598711a9e3fefc282/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L273-L276)、[跨轮测试 L107-L217](https://github.com/openai/codex/blob/322bbf4d8486efd7dbbcf49598711a9e3fefc282/codex-rs/app-server/tests/suite/v2/output_schema.rs#L107-L217) | 每个相关 turn 提交 schema，再进行 host 校验 |
| 可移植工作流规则 | [thread.rs L99-L106](https://github.com/openai/codex/blob/322bbf4d8486efd7dbbcf49598711a9e3fefc282/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L99-L106) | 技能入口与共同约束通过 developerInstructions 发送，详细模块随对应回合提供 |
| 原生取消 | [turn_interrupt.rs L98-L147](https://github.com/openai/codex/blob/322bbf4d8486efd7dbbcf49598711a9e3fefc282/codex-rs/app-server/tests/suite/v2/turn_interrupt.rs#L98-L147) | 匹配 turn/started 后 interrupt；无结束通知时有界清理 |
| 原生会话历史 | [thread.rs L1705-L1722](https://github.com/openai/codex/blob/322bbf4d8486efd7dbbcf49598711a9e3fefc282/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L1705-L1722) | 使用原生 thread，应用保留引用所需证据 |

配置取值以实际安装版本为准。[官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)说明命令网络限制不会禁用 hosted search、MCP 或 apps；本次规划线程另外关闭这些工具，并保留用户模型与认证设置。

## 规则模块

规则入口为 [SKILL.md](../src/resources/reference-plan/SKILL.md)，完整文件随二进制内嵌，运行时不依赖用户技能目录。需求提取使用 intake；候选和文件选择使用 research；计划生成及修正使用 design 与 plan；独立复核使用 design、plan 与 review。

这些模块按阶段加入当前请求，不会全部放进初始 thread 指令。已经完成的回合仍由 Codex 原生会话历史保留。无需新增会话状态管理或加载服务。

规则包 SHA256 使用入口与五个模块的路径和字节计算。模块内容变化也会使旧补答请求的规则版本校验失败。具体摘要记录在运行的 manifest 中，实际打包与运行结果见[验证记录](verification.md)。

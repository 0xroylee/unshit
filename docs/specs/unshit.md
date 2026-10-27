# unshit 首版验收约定

本约定记录对话中已批准的 CLI 范围及审阅修正。实现使用 TypeScript 与 Bun，输入开发需求，生成有源码依据的实施计划。模型访问复用本机 Codex 登录和原生 App Server，不实现提示词要求的目标应用。

## 入口与结果

```text
unshit "build an event ticketing system for a single team"
```

只有一个主要命令。提供 `--cwd`、`--out`、`--answers`、`--json`、`--jsonl`、`--turn-timeout` 和可选模型设置；正常调用继承本机模型配置。另有 `--install-skill`（可配 `--skill-dir`、`--force`、`--json`），把内嵌的 unshit agent skill 安装到 Claude Code 和 Codex 的 skills 目录。skill 要求 agent 把整份需求摘要交给用户批准、不自行写入批准；实施前把“Trusted, not checked”和待决事项交给用户，待决事项定下后由 unshit 重新规划；实施后按任务给出符合性报告，具名错误实现写明杀死、存活、失败方式与预期不同（不算杀死）或没有运行，实际运行的检查和计划中的检查分开写。进度用 ASCII 显示真实阶段，引用在计划中内联。默认保存计划、证据 manifest 和源码快照。缺少重大业务答案时，交互模式询问，非交互模式返回结构化 `needs_input`，不开始参考检索。交互模式还要在参考检索前请人批准 brief，见下文。

不增加独立 resume/refs/export 命令，不引入 SQLite、后台服务、插件框架或完整作业恢复协议。不发布 npm 包、GitHub Issues、提交或部署。

## brief 批准（2026-10-25 批准）

brief 定稿后，即补答重建后的 brief（重建失败时是需求提取的 brief，补答作为上下文），或没有问题时需求提取的 brief，由人批准其中的要求 R* 与验收 A*，之后才开始本地扫描和参考检索。交互终端显示 brief 的概述、每条要求及其验收（标出用户原话 `you said: "…"` 或 `inferred`）、排除项和假设，只有输入 `yes`（不分大小写）才继续；其他回复返回 `needs_input`（`approvalRequested: true`），退出码 2，并生成带 brief 的补答文件。host 只知道有人在终端输入了 `yes`，不知道是谁；在提示处按 Ctrl+C 或输入结束时返回 `interrupted`，退出码 130；输入在两次提问之间结束时，下一次提问同样返回 `interrupted`。`--json`、`--jsonl` 或非终端运行不等待批准，计划保持 Draft，并生成同样的补答文件（`approveBrief: false`）；补答文件写入失败时计划照常保存，结果没有 `answersFile`。`Ready` 需要这条批准；完成结果、manifest 和 plan.md 记录批准的摘要、方式和时间，或没有批准。批准只由 host 执行：没有批准时由 host 让计划保持 Draft；计划和复核回合的提示写明 host 记录的批准状态，并要求模型不为批准把计划标为 Draft、不为此报告问题，host 不核对模型是否照做。

补答文件可以携带已批准的 brief（`approveBrief: true`）。这不是新命令，也不是作业恢复协议：重跑仍然重新扫描本地项目、检索和读取参考源码，只是不再做需求提取、补答和重建。文件仍按提示词、目录和规则版本摘要绑定。批准不能代替补答：request 里的每个问题都必须有答案，否则读取失败并列出没有答案的问题 ID。brief 按需求提取的规则重新校验，不能含 `materialQuestions`，host 重新分配 R*/A* 并重新判定来源。host 无法分辨是谁改了 `approveBrief`，记录为 `via: "answers_file"`。

## 要求、任务与验证

| 要求 | 任务与依赖 | 可观察验收 | 验证 |
| --- | --- | --- | --- |
| R1 需求门槛 | T2，在 T1 后 | A2：重大歧义先澄清；未解决前没有外部参考查询；交互模式在 brief 获批前没有外部参考查询；非 TTY 不无限等待，未获批准的计划保持 Draft | V2：明确、含糊、脚本补充答案、终端批准与拒绝、补答文件批准场景 |
| R2 原生模型接入 | T1，首个任务 | A1：已有登录；按 ID 分流双向 RPC；每轮 schema；只有 completed 与有效最终结果才成功 | V1：真实 Bun/stdio 接入与故障协议夹具 |
| R3 有界参考研究 | T3，在 T2 后 | A3：本地基线与 GitHub/GitLab 公开读取；深入比较最多三仓库；真实路径、固定提交；缺口明确 | V3：API 夹具与公开源码读取；超限、超时、不可访问场景 |
| R4 可追溯证据 | T4，与 T3 同一读取流程 | A4：host 生成 ID、SHA、路径、有效行号、哈希和 permalink；保存可检查快照 | V4：有效证据与错误路径、范围、哈希场景 |
| R5 完整计划与复核 | T5，在 T4 后 | A5：需求→任务→验收→验证；每个验证为它覆盖的每条验收写出至少一个必须让它失败的错误实现；依赖无环；重要设计有依据或必要的新设计理由；重大缺口保持 Draft | V5：覆盖遗漏、缺少错误实现、伪引用、循环依赖、独立复核与存活错误实现场景 |
| R6 人类进度 | T6，支持前述任务 | A6：ASCII 反映实际阶段；取消清理子进程；无虚构百分比 | V6：终端、管道、SIGINT 场景 |
| R7 脚本输出 | T6，支持前述任务 | A6：JSON/JSONL 稳定；进度与结果不混杂；需要输入时有明确状态及退出码 | V6：JSON 解析、非 TTY、服务端输入请求场景 |
| R8 状态与交付 | T7/T8，在 T5/T6 后 | A7/A8：原生会话与取消；应用只保留证据和结果；原子保存；任意安装目录使用内嵌规则 | V7/V8：断连、保存失败、编译二进制及异地目录 smoke |

## 协议与证据边界

- `codex app-server` 持续运行。初始化响应后发送 `initialized`。区分响应、通知和服务端请求，匹配活动 thread/turn。收到 `turn/completed` 不等于成功；状态还有 failed/interrupted。
- 内嵌技能入口和 host 约束通过 `thread/start.developerInstructions` 传入，各阶段的详细规则随对应 turn 输入提供。`outputSchema` 每个相关 turn 提交。读写策略使用实际版本协议，不能照抄不匹配的示例枚举。
- 计划回合只读，不自动批准写入或权限升级。服务端请求必须回答或明确拒绝，不允许悬挂。断连不自动重放、不保证 exactly-once。
- 原生会话历史由 Codex 管理。源码字节、哈希、行号和证据裁决由 unshit 管理。不能用会话历史替代证据。
- 外部源码作为不可信数据传给模型。host 校验候选 ID、路径、提交与引用，不采信模型生成的任意 URL/命令或已运行测试声明。
- 源码、测试、依赖、CI 与许可证读取记录分开；文件缺失须说明。计划中的验证命令需有已读项目脚本依据，或明确标为实施时创建。参考测试只读不代表执行通过。计划列出的错误实现交给实施者核对，unshit 没有应用或运行。采用的参考模式须引用该参考仓库中用到这段代码的测试摘录，或写明没有的原因；所有采用模式都没有引用参考测试时，计划保持 Draft。
- 独立复核使用新会话，修正循环有界。复核者为每条可观察验收尝试构造一个计划检查都拦不住的错误实现；修正后仍拦不住的，以及只有业务决定才能排除的，都留在 Draft 中，业务决定不由模型代做。存活错误实现只是复核的建议：host 丢弃无法使用的项并记为信息性缺口，不因它们让运行失败；修正通过校验而之后的复核没有完成时，计划同样留在 Draft。无法消除的重大缺口留在 Draft 中。完成生成不等于目标项目已经实施或验证。
- 报告列出计划信任但 host 没有核对的内容：选中的参考仓库（运行时默认分支的最新提交、星数、日期、按文件名统计的测试路径、读取但未运行的测试、许可证依据），模型写的引用说法，没有提交的本地源码，同一模型的复核，以及复核报告或没有报告的存活错误实现都只是模型的推理。计划有错误实现时写出个数，并写明没有应用或运行；引用了参考测试时写出不同参考测试摘录的个数，并写明只按路径名认定测试文件、没有运行；brief 已获批准时写明批准来自终端还是补答文件，host 不知道是谁批准的。没有选中参考仓库时直接写明。

## 固定源码依据

本机协议验证版本：Codex 0.160.0、Bun 1.3.8。固定参考 `openai/codex@322bbf4d8486efd7dbbcf49598711a9e3fefc282`。

- [RPC 消息与请求 ID](https://github.com/openai/codex/blob/322bbf4d8486efd7dbbcf49598711a9e3fefc282/codex-rs/app-server-protocol/src/rpc.rs#L1-L79)
- [Turn 状态](https://github.com/openai/codex/blob/322bbf4d8486efd7dbbcf49598711a9e3fefc282/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L30-L38)
- [每轮 outputSchema](https://github.com/openai/codex/blob/322bbf4d8486efd7dbbcf49598711a9e3fefc282/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L273-L276)
- [跨轮 schema 测试](https://github.com/openai/codex/blob/322bbf4d8486efd7dbbcf49598711a9e3fefc282/codex-rs/app-server/tests/suite/v2/output_schema.rs#L107-L217)
- [内联 developerInstructions](https://github.com/openai/codex/blob/322bbf4d8486efd7dbbcf49598711a9e3fefc282/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L99-L106)
- [原生 thread/read](https://github.com/openai/codex/blob/322bbf4d8486efd7dbbcf49598711a9e3fefc282/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L1705-L1722)
- [Bun 内嵌资源与编译](https://bun.com/docs/bundler/executables)

## 验证记录边界

对话审阅已读取上述固定源码、相关测试与配置，并生成本机协议类型。CLI 运行、模型请求、真实取消和打包测试在本约定建立时仍待执行；实际结果记入 `docs/verification.md`，不得把计划中的检查称为已通过。

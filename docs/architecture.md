# 实现结构与参考

```text
CLI / JSON caller
       |
       v
workflow: scope -> sources -> evidence -> plan -> fresh review
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
| [workflow.ts](../src/workflow.ts) | 需求门槛、候选选择、读取、计划生成、独立复核与有界修正 |
| [app-server.ts](../src/app-server.ts) | 原生双向 RPC、活动回合关联、最终文本、取消和进程清理 |
| [github.ts](../src/github.ts) | GitHub 发现与固定提交读取，GitLab 官方 API 回退 |
| [local.ts](../src/local.ts) | 本地文件基线、排除规则、凭证内容过滤、已存在脚本依据 |
| [evidence.ts](../src/evidence.ts) | 有界读取、源码哈希、行范围、来源 ID 与固定链接 |
| [model-schema.ts](../src/model-schema.ts) | 每轮 JSON Schema、结构校验、来源归属、完整覆盖和依赖无环 |
| [report.ts](../src/report.ts) | 设计、比较、任务、验收、验证与源码对应表的 Markdown 输出 |
| [storage.ts](../src/storage.ts) | 原子保存报告、证据快照和可核对的补答请求上下文 |
| [instructions.ts](../src/instructions.ts) | 内嵌技能入口、阶段模块与 host/model 职责约束，计算整个规则包的摘要 |

## 状态归属

Codex 管理认证与会话。CLI 在内存中关联 RPC 和当前回合；应用保存源码字节、哈希、有效行范围、计划及缺口。这些数据用于核对引用和保存中断前已有结果。

`needs_input` 的补答文件保存原问题与提示词、目录、规则版本的摘要。它解决非交互重跑时问题顺序或措辞变化的问题。重新运行后仍由需求门槛检查未解决的重大业务问题。

已回答的问题以 `resolvedAnswers` 传给候选选择、规划、复核及修正回合，并写入最终结果、报告、manifest 和中断检查点。报告将初始摘要与最终范围分别标注。

已有本地脚本与实施后要创建的命令分开记录。上游测试读取只支持参考判断；CLI 不把它们当作目标应用已执行的测试。

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

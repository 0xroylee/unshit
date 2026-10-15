# unshit 首版验收约定

本约定记录对话中已批准的 CLI 范围及审阅修正。实现使用 TypeScript 与 Bun，输入开发需求，生成有源码依据的实施计划。模型访问复用本机 Codex 登录和原生 App Server，不实现提示词要求的目标应用。

## 入口与结果

```text
unshit "build an event ticketing system for a single team"
```

只有一个主要命令。提供 `--cwd`、`--out`、`--answers`、`--json`、`--jsonl`、`--turn-timeout` 和可选模型设置；正常调用继承本机模型配置。进度用 ASCII 显示真实阶段，引用在计划中内联。默认保存计划、证据 manifest 和源码快照。缺少重大业务答案时，交互模式询问，非交互模式返回结构化 `needs_input`，不开始参考检索。

不增加独立 resume/refs/export 命令，不引入 SQLite、后台服务、插件框架或完整作业恢复协议。不发布 npm 包、GitHub Issues、提交或部署。

## 要求、任务与验证

| 要求 | 任务与依赖 | 可观察验收 | 验证 |
| --- | --- | --- | --- |
| R1 需求门槛 | T2，在 T1 后 | A2：重大歧义先澄清；未解决前没有外部参考查询；非 TTY 不无限等待 | V2：明确、含糊、脚本补充答案场景 |
| R2 原生模型接入 | T1，首个任务 | A1：已有登录；按 ID 分流双向 RPC；每轮 schema；只有 completed 与有效最终结果才成功 | V1：真实 Bun/stdio 接入与故障协议夹具 |
| R3 有界参考研究 | T3，在 T2 后 | A3：本地基线与 GitHub/GitLab 公开读取；深入比较最多三仓库；真实路径、固定提交；缺口明确 | V3：API 夹具与公开源码读取；超限、超时、不可访问场景 |
| R4 可追溯证据 | T4，与 T3 同一读取流程 | A4：host 生成 ID、SHA、路径、有效行号、哈希和 permalink；保存可检查快照 | V4：有效证据与错误路径、范围、哈希场景 |
| R5 完整计划与复核 | T5，在 T4 后 | A5：需求→任务→验收→验证；依赖无环；重要设计有依据或必要的新设计理由；重大缺口保持 Draft | V5：覆盖遗漏、伪引用、循环依赖与独立复核场景 |
| R6 人类进度 | T6，支持前述任务 | A6：ASCII 反映实际阶段；取消清理子进程；无虚构百分比 | V6：终端、管道、SIGINT 场景 |
| R7 脚本输出 | T6，支持前述任务 | A6：JSON/JSONL 稳定；进度与结果不混杂；需要输入时有明确状态及退出码 | V6：JSON 解析、非 TTY、服务端输入请求场景 |
| R8 状态与交付 | T7/T8，在 T5/T6 后 | A7/A8：原生会话与取消；应用只保留证据和结果；原子保存；任意安装目录使用内嵌规则 | V7/V8：断连、保存失败、编译二进制及异地目录 smoke |

## 协议与证据边界

- `codex app-server` 持续运行。初始化响应后发送 `initialized`。区分响应、通知和服务端请求，匹配活动 thread/turn。收到 `turn/completed` 不等于成功；状态还有 failed/interrupted。
- 内嵌技能入口和 host 约束通过 `thread/start.developerInstructions` 传入，各阶段的详细规则随对应 turn 输入提供。`outputSchema` 每个相关 turn 提交。读写策略使用实际版本协议，不能照抄不匹配的示例枚举。
- 计划回合只读，不自动批准写入或权限升级。服务端请求必须回答或明确拒绝，不允许悬挂。断连不自动重放、不保证 exactly-once。
- 原生会话历史由 Codex 管理。源码字节、哈希、行号和证据裁决由 unshit 管理。不能用会话历史替代证据。
- 外部源码作为不可信数据传给模型。host 校验候选 ID、路径、提交与引用，不采信模型生成的任意 URL/命令或已运行测试声明。
- 源码、测试、依赖、CI 与许可证读取记录分开；文件缺失须说明。计划中的验证命令需有已读项目脚本依据，或明确标为实施时创建。参考测试只读不代表执行通过。
- 独立复核使用新会话，修正循环有界。无法消除的重大缺口留在 Draft 中。完成生成不等于目标项目已经实施或验证。

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

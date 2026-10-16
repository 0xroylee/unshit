# unshit

用一个开发需求，生成带源码依据、任务清单和验收方式的实施计划。

```text
unshit "为单个团队构建活动售票系统，支持售票、退款和入场核验"
```

```text
prompt
  |
  v
范围 / 必要澄清
  |
  v
本地项目 + 公开参考仓库
  |
  v
固定提交 / 文件 / 行号 / 内容校验
  |
  v
实施计划 -> 独立复核 -> plan.md
```

模型通过本机 Codex App Server 使用已有登录。CLI 负责读取参考代码、校验证据与保存结果，Codex 负责模型回合和会话。输出的是实施计划。

## 从源码运行

需要 Bun 和已登录的 Codex CLI。已验证环境记录见 [验证报告](docs/verification.md)。

```sh
bun install
bun run check
bun run build
./dist/unshit "构建一个面向单团队的活动售票系统"
```

编译后的 `dist/unshit` 内含 Bun 运行时和规划规则。可将这个文件放入自己的 PATH；运行时仍需能找到本机 `codex`。

## 使用

```sh
# 使用现有项目的约定、依赖与脚本作为基线
./dist/unshit "增加订单退款流程" --cwd ../my-project

# 指定计划文件
./dist/unshit "为单团队构建活动售票系统" --out ./ticketing-plan.md

# 单个 JSON 结果，适合脚本读取
./dist/unshit "为单团队构建活动售票系统" --json

# JSONL 进度事件及最终结果
./dist/unshit "为单团队构建活动售票系统" --jsonl

# 在非交互调用中补充澄清答案
./dist/unshit "build a ticketing system" --answers ./answers.json --json

# 单个模型回合连续 15 分钟没有任何活动才算超时，默认是 10 分钟
./dist/unshit "为单团队构建活动售票系统" --turn-timeout 900
```

默认继承 Codex 的模型配置。`--model` 和 `--effort` 可覆盖本次规划设置，支持的值以当前 Codex 版本为准。公开代码读取默认无需额外凭证；现有 `GITHUB_TOKEN` 或 `GITLAB_TOKEN` 可用于对应服务的 API 配额。

每个模型回合在 Codex 连续 10 分钟没有任何活动时超时；即使一直有活动，一个回合最长也只能运行这个时限的 3 倍，默认 30 分钟。`--turn-timeout <秒>` 设置空闲时限，范围 30 到 3600，总时长随之变为 3 倍。brief 重建、候选排序、计划修正和复核修正这几个回合超时后，按它们原有的失败处理继续，并记录缺口；其他回合超时会结束运行，返回 `timed_out` 并保存检查点。

必要业务问题未回答时，交互终端会询问。非交互模式会返回 `needs_input`、问题 ID 和 `answersFile`，退出码为 2。在生成的文件中填写 `answers` 对象，使用文件内的问题 ID 作为键、答案文本作为值，保留 `request` 上下文，再用相同提示词和目录重新调用。文件会校验提示词、目录和规则版本，避免把旧答案套到新问题上。模型回合超时退出码为 124，取消退出码为 130，无法完成的运行退出码为 1。

## 结果与依据

默认结果保存在目标目录的 `.unshit/<run-id>/`。计划文件包含范围、已确认的业务答案、排除项、模块与数据设计、按依赖排序的任务、验收场景、验证方法，以及采用或淘汰参考模式的理由。每个重要引用指向实际读取的文件与行号；远程引用固定到提交版本。初始需求摘要与最终范围分别标注，补答后的决定同时保存在报告和 manifest 中。

证据 manifest 和源码快照与计划一起保存。源码读取、已有测试文件和实际执行过的检查分别记录。存在重大问题或证据缺口时，结果保持 `Draft`；完整覆盖且复核通过时标为 `Ready`。

本地文件中疑似凭证的单行值，例如 `apiKey = "..."` 或以 `ghp_` 开头的 token，在发给模型之前替换为 `[redacted by unshit]`。合法 JSON 文件遮蔽后仍是合法 JSON，`package.json` 的脚本依然可读。文件仍会读取，行号不变，保存的快照和哈希对应遮蔽后的内容，并记录一条非重大缺口。含私钥块的文件，以及成员名含疑似凭证值的合法 JSON 文件，整份排除，并记录一条重大缺口。

公开参考仓库会先按需求提取的领域词和 topic 由 host 构建 GitHub 搜索条件，再按星数与最近推送时间逐级放宽。搜索结果先通过星数、年龄、活跃度、归档状态和 fork 检查；进入候选名单前还要在固定提交的文件树中找到测试文件，并确认许可证：GitHub 能识别的 SPDX 许可证，或根目录许可证文件。GitHub 返回 `NOASSERTION` 表示找到了许可证文件但无法识别，这时必须在根目录找到许可证文件；有多个时先选 `LICENSE`、`LICENSE.txt`、`COPYING` 这类标准文件名，`LICENSE-*` 只作备选，证据读取使用同一个文件。筛选条件、查询记录、仓库信号与排除原因保存在报告和 manifest 中。没有满足条件的参考仓库时，报告会明确标记，计划保持 `Draft`。

通过元数据门槛的候选多于文件树检查名额时，默认名额为 8 个，模型先依描述、topic 和代码命中排出最多 12 个，host 按这个顺序检查文件树；排序失败或超时就退回 host 的关键词排序，并记录非重大缺口。关键词排序只算整词，复数也算命中；`code`、`reference` 这类泛用词和普通单词形式的代码 pattern 权重较低。超出大小上限的响应不再重试。`research.shortlisted` 是通过文件树检查的仓库数，`research.selected` 是模型选中的数量；只有至少一个被选中的仓库提供了实现或测试源码摘录，`research.trustworthyReferenceFound` 才为 true。

参考仓库的文件列表按需求领域词排序，并为测试文件和实现文件保留名额。读取源码仍有独立大小限制；完整文件树使用更高的响应上限。GitHub 的 `treeTruncated` 使用提供方返回的截断标志；GitLab 若 host 达到 25 页上限且仍有下一页，也会将该树标为截断。

需求提取时，模型还会给出 1–4 个代码 pattern，例如 `OrderRefund`、`refund_amount`。host 用 Grep by Vercel 按字面搜索这些 pattern，模型线程本身仍不能调用任何工具。命中的仓库会补进候选名单：host 用一次带多个 `repo:` 条件的 GitHub 搜索取回星数、日期和许可证，再走同一套门槛。示例、样例和文档目录里的命中不计入。通过固定提交文件树检查后，host 会在每个仓库内再搜最多两个 pattern，只保留仓库名完全一致、且路径存在于固定提交树中的命中。这些文件排在文件清单前面，摘录也会对准命中的行。Grep 的结果只用来定位，证据仍按固定提交读取。整次运行最多发 12 次 Grep 请求；第一次失败后本次运行不再请求 Grep，其余流程照常。只要有候选仓库通过门槛，这个失败就记为非重大缺口；没有任何候选通过时，它和其他搜索缺口一样记为重大缺口。代码 pattern 会发送到 Grep by Vercel。

进度显示实际阶段。人类进度写入 stderr，JSON 结果写入 stdout；JSONL 模式的事件与结果均为逐行 JSON。

## 开发与核验

```sh
bun run check
bun run build
```

协议、需求门槛、源码校验、失败处理和机器输出通过公开接口夹具测试。真实登录与模型 smoke 单独记录，以免把测试夹具等同于真实服务验证。

- [已批准的要求与验收](docs/specs/unshit.md)
- [实现结构与固定源码参考](docs/architecture.md)
- [实际验证结果与限制](docs/verification.md)

`reference-plan` 使用一个入口和五个按需读取的模块：

```text
reference-plan/
  SKILL.md
  references/
    intake.md    需求和业务决策门槛
    research.md  本地基线、参考仓库和源码证据
    design.md    最小设计、原生能力复用和取舍
    plan.md      任务、验收、验证和 Draft / Ready
    review.md    现有计划或系统的审查
```

CLI 内嵌[入口与模块](src/resources/reference-plan/SKILL.md)。原生 thread 的共同指令只含入口和 host 约束；每轮再提供对应阶段的模块，沿用 Codex 的会话历史。入口或任一模块改变都会更新规则包摘要，旧版本的补答文件需用新版本重新生成。普通技能调用也按入口中的条件读取模块。

规划时优先复用项目和平台已有能力。新增模块、存储或抽象需要说明具体需求、已有能力缺口，以及更简单方案为何不足。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.svg">
  <img alt="unshit 标志：2×4 和 2×2 积木上面放着一坨便便" src="docs/images/logo-light.svg" width="96">
</picture>

# unshit

[English](README.md) · 简体中文 · [网站](https://0xroylee.github.io/unshit/)

unshit 把一句开发需求变成建立在真实、有测试的代码上的实施计划：找到成熟的公开仓库，在固定提交读取它们的源码，并为每个任务标出依据的文件和行号。它只写计划，不写应用。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/how-it-works-dark.svg">
  <img alt="unshit 的九个步骤：1 提问，2 批准 brief，3 本地项目，4 搜索与预览，5 筛选参考，6 固定读取，7 生成计划，8 独立复核，9 保存结果" src="docs/images/how-it-works-light.svg" width="900">
</picture>

## 安装

需要 git、[Bun](https://bun.sh) 1.3 或更新版本，以及已用 `codex login` 登录的 [Codex CLI](https://github.com/openai/codex)。

```sh
git clone https://github.com/0xroylee/unshit.git
cd unshit
./install.sh
```

这会把 `unshit` 命令装到 `~/.local/bin`，并为 Claude Code 和 Codex 装好 unshit skill。

## 使用

```sh
mkdir my-app && cd my-app
unshit "为单个团队构建活动售票系统，支持售票、退款和入场核验"
```

1. 回答它提出的业务问题。
2. 读一遍 brief，输入 `yes`。搜索之后，看一下它找到的参考，再输入一次 `yes`。
3. 等十几到三十分钟，计划保存在 `.unshit/<run-id>/plan.md`。旁边的 `preview.html` 列出每一步用到的参考，`stack.html` 把计划的模块画成一叠积木：打开一块积木，就能看到支撑它的代码。

也可以在 Claude Code 或 Codex 里说“用 unshit 规划……”，再请它按计划实施。

只有你批准了 brief，并且没有遗留重大事项（重大缺口、未解决的复核问题、待决的业务决定）时，计划才是 **Ready**；否则是 **Draft**，计划里会写明原因。

## 文档

- [使用说明](docs/usage.zh-CN.md)：安装选项、脚本运行、补答文件、结果，以及参考仓库怎么选
- [实现结构](docs/architecture.zh-CN.md)：模块和背后的固定源码依据
- [首版验收约定](docs/specs/unshit.zh-CN.md)
- [验证记录](docs/verification.md)
- [AGENTS.md](AGENTS.md) 和 [DESIGN.md](DESIGN.md)（英文）：给编码 agent 的规则和设计风格

## 开发

```sh
bun install
bun run check   # 类型检查与测试
bun run build   # 编译 dist/unshit
./install.sh --dev   # 安装直接运行这份源码的 unshit-dev
```

## 致谢

流程图和标志使用 [Hairline](https://hairline.lucasmarkes.com/figures) 的线条图（MIT，© Lucas Marques）。代码搜索使用 [Grep by Vercel](https://grep.app)。

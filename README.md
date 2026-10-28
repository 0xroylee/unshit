<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.svg">
  <img alt="unshit logo: a poop on top of a 2×2 and a 2×4 brick" src="docs/images/logo-light.svg" width="96">
</picture>

# unshit

English · [简体中文](README.zh-CN.md) · [Website](https://0xroylee.github.io/unshit/)

unshit turns a plain-language requirement into an implementation plan built on real, tested code. It finds mature public repositories, reads their source at pinned commits, and cites the files and lines behind each task. It writes the plan, not the app.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/how-it-works-en-dark.svg">
  <img alt="The nine steps of unshit: 1 Ask, 2 Approve the brief, 3 Local project, 4 Search and preview, 5 Screen references, 6 Pinned reads, 7 Plan, 8 Independent review, 9 Save" src="docs/images/how-it-works-en-light.svg" width="900">
</picture>

## Install

You need git, [Bun](https://bun.sh) 1.3 or later, and the [Codex CLI](https://github.com/openai/codex) logged in with `codex login`.

```sh
git clone https://github.com/0xroylee/unshit.git
cd unshit
./install.sh
```

This puts the `unshit` command in `~/.local/bin` and adds the unshit skill to Claude Code and Codex.

## Use

```sh
mkdir my-app && cd my-app
unshit "Build an event ticketing system for one team, with ticket sales, refunds and entry check-in"
```

1. Answer its business questions.
2. Read the brief and type `yes`. After the search, check the references it found and type `yes` again.
3. Wait 15 to 30 minutes. The plan is saved in `.unshit/<run-id>/plan.md`, and `preview.html` next to it shows each step with the references it used.

You can also ask Claude Code or Codex to "use unshit to plan …", and then to implement the plan.

A plan is **Ready** only when you approved the brief and nothing material is left open: no material gap, no unresolved review finding, no open business decision. Otherwise it is **Draft**, and the plan says why.

## Docs

- [Usage](docs/usage.md): install options, scripted runs, answers files, results, and how references are chosen
- [Architecture](docs/architecture.md): modules and the pinned sources behind them
- [Acceptance agreement](docs/specs/unshit.md)
- [Verification records](docs/verification.md) (in Chinese)
- [AGENTS.md](AGENTS.md) and [DESIGN.md](DESIGN.md): rules for coding agents and the design style

## Develop

```sh
bun install
bun run check   # typecheck and tests
bun run build   # compiles dist/unshit
./install.sh --dev   # installs unshit-dev, which runs this checkout's source
```

## Credits

The diagram and the logo use [Hairline](https://hairline.lucasmarkes.com/figures) line figures (MIT, © Lucas Marques). Code search uses [Grep by Vercel](https://grep.app).

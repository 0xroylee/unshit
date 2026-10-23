#!/bin/sh
# Install unshit. Run it from a clone of the repository:
#   git clone https://github.com/0xroylee/unshit.git && cd unshit
#
# Production (default): build the unshit binary from a clean clone of --ref and install it.
#   ./install.sh
#   ./install.sh --ref <branch|tag|commit>
#
# Development: install dependencies, run the checks, and install an unshit-dev
# command that runs this checkout's TypeScript source directly (no rebuild after edits).
#   ./install.sh --dev
#
# Both modes then run "--install-skill", which installs the unshit agent skill
# for Claude Code and Codex (skip it with --no-skill).

set -eu

REPO_URL="${UNSHIT_REPO:-https://github.com/0xroylee/unshit.git}"
REF="${UNSHIT_REF:-main}"
BIN_DIR="${UNSHIT_BIN_DIR:-$HOME/.local/bin}"
MODE=production
DEV_DIR=""
RUN_CHECKS=1
INSTALL_SKILL=1
MIN_BUN_VERSION=1.3.0

info() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: install.sh [--dev] [options]

Modes:
  (default)          Production: clone the repository at --ref, run the checks,
                     build the binary, and install it as "unshit".
  --dev              Development: use this checkout (or clone one into --dir),
                     install dependencies, run the checks, and install
                     "unshit-dev", which runs src/cli.ts with Bun.

Options:
  --ref <ref>        Branch, tag, or commit to install (default: main).
                     Development mode uses it only when it clones.
  --bin-dir <dir>    Where to install the command (default: ~/.local/bin).
  --dir <dir>        Development checkout to use or create
                     (default: this checkout, else ./unshit).
  --repo <url>       Repository to clone
                     (default: https://github.com/0xroylee/unshit.git).
  --skip-checks      Do not run "bun run check" before installing.
  --no-skill         Do not install the agent skill. By default the installed
                     command runs "--install-skill", which writes the unshit
                     skill to ~/.claude/skills/unshit (Claude Code), and to
                     $CODEX_HOME/skills/unshit (default ~/.codex/skills) and
                     ~/.agents/skills/unshit (Codex), for the agents it finds.
  -h, --help         Show this help.

Environment: UNSHIT_REF, UNSHIT_BIN_DIR, UNSHIT_REPO set the same defaults.

Requirements: git, Bun 1.3 or newer. At runtime unshit also needs the Codex
CLI with a login ("codex login"). Set GITHUB_TOKEN to raise GitHub API limits.

Uninstall: rm ~/.local/bin/unshit ~/.local/bin/unshit-dev
           rm -r ~/.claude/skills/unshit ~/.codex/skills/unshit ~/.agents/skills/unshit
EOF
}

# Print $1 as a single-quoted shell word.
shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# True if version $1 >= version $2 (numeric major.minor.patch).
version_at_least() {
  lowest=$(printf '%s\n%s\n' "$2" "$1" | sort -t. -k1,1n -k2,2n -k3,3n | head -n 1)
  [ "$lowest" = "$2" ]
}

require_tools() {
  command -v git >/dev/null 2>&1 || die "git is required. Install it from https://git-scm.com/downloads."
  command -v bun >/dev/null 2>&1 || die "Bun is required. Install it with: curl -fsSL https://bun.sh/install | bash"
  bun_version=$(bun --version)
  bun_version=${bun_version%%-*}
  bun_version=${bun_version%%+*}
  version_at_least "$bun_version" "$MIN_BUN_VERSION" \
    || die "Bun $MIN_BUN_VERSION or newer is required (found $bun_version). Upgrade with: bun upgrade"
}

check_codex() {
  if ! command -v codex >/dev/null 2>&1; then
    warn "Codex CLI not found. unshit uses your Codex login at runtime: install the Codex CLI, then run 'codex login'."
  elif ! codex login status 2>&1 | grep -qi '^logged in'; then
    warn "Codex CLI is not logged in. Run 'codex login' before using unshit."
  fi
}

check_path() {
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) warn "$BIN_DIR is not on your PATH. Add this to your shell profile: export PATH=\"$BIN_DIR:\$PATH\"" ;;
  esac
}

# Write $1 to $2 through a temporary file in the same directory, then make it executable.
install_file() {
  mkdir -p "$(dirname "$2")"
  staged="$2.tmp.$$"
  if ! cp "$1" "$staged"; then
    rm -f "$staged"
    die "could not write $2"
  fi
  chmod 755 "$staged"
  mv -f "$staged" "$2"
}

run_checks() {
  if [ "$RUN_CHECKS" -eq 1 ]; then
    info "Running typecheck and tests"
    (cd "$1" && bun run check) || die "checks failed in $1 (use --skip-checks to install anyway)"
  fi
}

is_checkout() {
  [ -f "$1/package.json" ] && [ -f "$1/src/cli.ts" ] && grep -q '"name": "unshit"' "$1/package.json"
}

install_production() {
  work=$(mktemp -d "${TMPDIR:-/tmp}/unshit-install.XXXXXX")
  trap 'rm -rf "$work"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  info "Fetching $REPO_URL at $REF"
  git init -q "$work/src"
  git -C "$work/src" remote add origin "$REPO_URL"
  git -C "$work/src" fetch -q --depth 1 origin "$REF" || die "could not fetch '$REF' from $REPO_URL"
  git -C "$work/src" checkout -q --detach FETCH_HEAD
  commit=$(git -C "$work/src" rev-parse --short HEAD)

  info "Installing dependencies"
  (cd "$work/src" && bun install --frozen-lockfile) || die "bun install failed"
  run_checks "$work/src"
  info "Building the binary"
  (cd "$work/src" && bun run build) || die "build failed"

  install_file "$work/src/dist/unshit" "$BIN_DIR/unshit"
  "$BIN_DIR/unshit" --help >/dev/null 2>&1 || die "the installed binary did not start: $BIN_DIR/unshit"
  info "Installed unshit ($commit) at $BIN_DIR/unshit"
}

install_development() {
  script_dir=""
  case "$0" in
    */install.sh | install.sh) script_dir=$(cd "$(dirname "$0")" && pwd) ;;
  esac

  if [ -n "$DEV_DIR" ] && is_checkout "$DEV_DIR"; then
    repo=$(cd "$DEV_DIR" && pwd)
  elif [ -z "$DEV_DIR" ] && [ -n "$script_dir" ] && is_checkout "$script_dir"; then
    repo=$script_dir
  else
    target=${DEV_DIR:-$PWD/unshit}
    [ ! -e "$target" ] || die "$target exists but is not an unshit checkout. Pass --dir <path>."
    info "Cloning $REPO_URL ($REF) into $target"
    git clone -q --branch "$REF" "$REPO_URL" "$target" \
      || die "could not clone '$REF' from $REPO_URL (development mode clones branches and tags)"
    repo=$(cd "$target" && pwd)
  fi
  info "Using checkout $repo"

  info "Installing dependencies"
  (cd "$repo" && bun install --frozen-lockfile) || die "bun install failed in $repo"
  run_checks "$repo"
  info "Building dist/unshit"
  (cd "$repo" && bun run build) || die "build failed in $repo"

  launcher=$(mktemp "${TMPDIR:-/tmp}/unshit-dev.XXXXXX")
  {
    printf '#!/bin/sh\n'
    printf '# unshit development launcher: runs the source in %s\n' "$repo"
    printf 'command -v bun >/dev/null 2>&1 || { echo "unshit-dev: bun is not on PATH" >&2; exit 1; }\n'
    printf 'exec bun %s "$@"\n' "$(shell_quote "$repo/src/cli.ts")"
  } > "$launcher"
  install_file "$launcher" "$BIN_DIR/unshit-dev"
  rm -f "$launcher"
  "$BIN_DIR/unshit-dev" --help >/dev/null 2>&1 || die "the installed launcher did not start: $BIN_DIR/unshit-dev"
  info "Installed unshit-dev at $BIN_DIR/unshit-dev (runs $repo/src/cli.ts)"
  info "Daily commands in $repo: bun run dev \"<requirement>\" --cwd <project>, bun run check, bun run build"
}

# Let the installed command install its own embedded agent skill.
install_skill() {
  if [ "$INSTALL_SKILL" -ne 1 ]; then
    return 0
  fi
  info "Installing the unshit agent skill for Claude Code and Codex"
  if ! "$1" --install-skill; then
    warn "the agent skill was not installed. Run '$(basename "$1") --install-skill' later (or with --skill-dir <dir>)."
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dev) MODE=development ;;
    --ref) [ $# -ge 2 ] || die "--ref needs a value"; REF=$2; shift ;;
    --ref=*) REF=${1#*=} ;;
    --bin-dir) [ $# -ge 2 ] || die "--bin-dir needs a value"; BIN_DIR=$2; shift ;;
    --bin-dir=*) BIN_DIR=${1#*=} ;;
    --dir) [ $# -ge 2 ] || die "--dir needs a value"; DEV_DIR=$2; shift ;;
    --dir=*) DEV_DIR=${1#*=} ;;
    --repo) [ $# -ge 2 ] || die "--repo needs a value"; REPO_URL=$2; shift ;;
    --repo=*) REPO_URL=${1#*=} ;;
    --skip-checks) RUN_CHECKS=0 ;;
    --no-skill) INSTALL_SKILL=0 ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

[ -n "$REF" ] || die "--ref must not be empty"
[ -n "$BIN_DIR" ] || die "--bin-dir must not be empty"

require_tools
if [ "$MODE" = production ]; then
  install_production
  install_skill "$BIN_DIR/unshit"
else
  install_development
  install_skill "$BIN_DIR/unshit-dev"
fi
check_path
check_codex
if [ -z "${GITHUB_TOKEN:-}" ]; then
  info "Tip: export GITHUB_TOKEN=\$(gh auth token) to raise GitHub API limits for reference search."
fi

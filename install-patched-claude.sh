#!/usr/bin/env bash
#
# Calico bootstrapper for macOS and Linux.
#
# Installs Calico side by side as `calico-claude` and keeps it current. The
# official `claude` is never written. What it does, in order:
#
#   1. Refuses to run as root, and under Git Bash/MSYS (use the PowerShell
#      installer there).
#   2. Resolves the source ref (main) to one commit SHA with a single API call,
#      then fetches every file it needs from raw.githubusercontent.com at that
#      SHA, so all files come from the same commit even if main moves mid-run.
#   3. Writes ~/.claude/calico/config (`repo=<owner>/<name>`), the updater
#      ~/.claude/calico/update.sh, and ~/.claude/calico/source-commit.
#   4. Runs the updater with --force, which installs ~/.local/bin/calico-claude.
#   5. Adds a SessionStart hook to ~/.claude/settings.json that runs the updater
#      in --hook mode (at most hourly, never blocking startup).
#   6. macOS only: loads an hourly launchd agent (gui/<uid>/com.calico.auto-update)
#      that runs the updater in --unattended-run mode. Linux gets the hook only.
#   7. Prints every item it created and the exact uninstall command.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Nanako0129/calico-claude/main/install-patched-claude.sh | bash
#   ... | bash -s -- --uninstall
#
# Environment:
#   PATCH_CLAUDE_REPO / CALICO_REPO  Release repo (default Nanako0129/calico-claude).
#                                    Written to ~/.claude/calico/config, which is
#                                    where the hook and the timer read it from.
#   GITHUB_TOKEN / GH_TOKEN          Bearer token for the one API call; otherwise
#                                    an authenticated `gh` supplies one.
#   CALICO_SOURCE_REF                TESTING ONLY: ref to install from (default main).
#   CALICO_TEST_LAUNCHD_LABEL        TESTING ONLY: launchd label to use instead of
#                                    com.calico.auto-update, so a test never touches
#                                    the real job.

set -euo pipefail

REPO_SLUG="${PATCH_CLAUDE_REPO:-${CALICO_REPO:-Nanako0129/calico-claude}}"
SOURCE_REF="${CALICO_SOURCE_REF:-main}"
LAUNCHD_LABEL="${CALICO_TEST_LAUNCHD_LABEL:-com.calico.auto-update}"

# Paths the updater itself derives from HOME in its unattended modes. They are
# not configurable here for the same reason they are not there: the hook and the
# timer must manage exactly what this installer installed.
STATE_DIR="${HOME}/.claude/calico"
UPDATER="${STATE_DIR}/update.sh"
LAUNCHER="${HOME}/.local/bin/calico-claude"
SHARE_DIR="${HOME}/.local/share/calico-claude"
SETTINGS="${HOME}/.claude/settings.json"
PLIST="${HOME}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
LAUNCHD_LOG="${HOME}/Library/Logs/calico-auto-update.log"
HOOK_COMMAND="/bin/bash \"${HOME}/.claude/calico/update.sh\" --hook"

# Set once the first file is written, so any later failure tells the user how to
# remove what was already written.
UNINSTALL_HINT=""
TMP_DIR=""

log() {
  printf '%s\n' "$*" >&2
}

fail() {
  log "Error: $*"
  if [[ -n "$UNINSTALL_HINT" ]]; then
    log ""
    log "To remove what this run already installed:"
    log "  ${UNINSTALL_HINT}"
  fi
  exit 1
}

cleanup() {
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

# Sets OS_KIND to darwin or linux. Architecture is left to the updater, which
# already knows which platforms have releases.
detect_os() {
  case "$(uname -s)" in
    Darwin) OS_KIND=darwin ;;
    Linux)  OS_KIND=linux ;;
    MINGW*|MSYS*|CYGWIN*)
      fail "This is the macOS/Linux installer. On Windows, run the PowerShell installer instead:
  irm https://raw.githubusercontent.com/${REPO_SLUG}/main/install-patched-claude.ps1 | iex"
      ;;
    *) fail "Unsupported operating system: $(uname -s)" ;;
  esac
}

# Everything this installs belongs in one user's home and runs as that user.
# Under sudo it would land in root's home, or leave root-owned files in the
# user's, and the hook and the timer would then run as the wrong user.
refuse_root() {
  local uid
  uid="$(id -u)"
  if [[ "$uid" == "0" ]]; then
    fail "Do not run this installer as root or with sudo. It installs into your own home directory and needs no elevated rights."
  fi
}

validate_inputs() {
  [[ "$REPO_SLUG" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] ||
    fail "Invalid repository '${REPO_SLUG}': expected <owner>/<name>."
  [[ "$SOURCE_REF" =~ ^[A-Za-z0-9._/-]+$ ]] || fail "Invalid CALICO_SOURCE_REF '${SOURCE_REF}'."
  [[ "$LAUNCHD_LABEL" =~ ^[A-Za-z0-9._-]+$ ]] || fail "Invalid launchd label '${LAUNCHD_LABEL}'."
  # HOME is written into the hook command, which Claude Code runs under /bin/sh
  # inside double quotes, where these characters are still interpreted.
  case "$HOME" in
    /*) ;;
    *) fail "HOME must be an absolute path (got '${HOME}')." ;;
  esac
  case "$HOME" in
    *'"'*|*'$'*|*'`'*|*'\'*|*$'\n'*)
      fail "HOME contains a character that cannot be quoted safely in the hook command: ${HOME}" ;;
  esac
}

github_api_get() {
  local url="$1" output_file="$2" accept="$3"

  # Anonymous calls are capped at 60 an hour per address, and a shared egress
  # (a VPN, an office NAT) spends that for everyone behind it. An authenticated
  # gh is the credential most users already have, so it comes after the
  # explicit variables and before anonymous.
  local token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
  if [[ -z "$token" ]] && command -v gh >/dev/null 2>&1; then
    token="$(gh auth token 2>/dev/null </dev/null || true)"
  fi

  # The header travels on stdin (`-H @-`), never in curl's argv, which other
  # local users can read through `ps` while the request runs. printf is a
  # builtin, so no process carries the token in its argv at all. See the same
  # block in examples/local-auto-update/update.sh for the measurement.
  if [[ -n "$token" ]]; then
    printf 'Authorization: Bearer %s\n' "$token" | curl -fsSL \
      -H "Accept: ${accept}" \
      -H "User-Agent: calico-claude-installer" \
      -H @- \
      "$url" \
      -o "$output_file"
  else
    curl -fsSL \
      -H "Accept: ${accept}" \
      -H "User-Agent: calico-claude-installer" \
      "$url" \
      -o "$output_file" </dev/null
  fi
}

# One API call turns the ref into a commit SHA; every file after that is
# fetched by SHA, so a push to main during the run cannot mix two revisions.
resolve_source_commit() {
  local out="${TMP_DIR}/sha"
  github_api_get "https://api.github.com/repos/${REPO_SLUG}/commits/${SOURCE_REF}" "$out" \
    "application/vnd.github.sha" ||
    fail "Could not resolve ${REPO_SLUG}@${SOURCE_REF} to a commit."
  SOURCE_COMMIT="$(tr -d '[:space:]' < "$out")"
  [[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] ||
    fail "GitHub returned something other than a commit SHA for ${REPO_SLUG}@${SOURCE_REF}."
  RAW_BASE="https://raw.githubusercontent.com/${REPO_SLUG}/${SOURCE_COMMIT}"
  UNINSTALL_CMD="curl -fsSL ${RAW_BASE}/install-patched-claude.sh | bash -s -- --uninstall"
}

fetch_source_file() { # <repo-relative path> <local file>
  curl -fsSL "${RAW_BASE}/$1" -o "$2" </dev/null || fail "Could not download $1 at ${SOURCE_COMMIT}."
  [[ -s "$2" ]] || fail "Downloaded $1 at ${SOURCE_COMMIT} is empty."
}

# Written through a rename: a hook-spawned updater may be running the old file,
# and bash reads a script as it goes, so overwriting it in place could feed that
# run a mix of two files.
install_updater() {
  UNINSTALL_HINT="$UNINSTALL_CMD"
  mkdir -p "$STATE_DIR"
  local tmp
  tmp="$(mktemp "${STATE_DIR}/.update.sh.XXXXXX")"
  cat "${TMP_DIR}/update.sh" > "$tmp"
  chmod 0755 "$tmp"
  mv -f "$tmp" "$UPDATER"
  printf 'repo=%s\n' "$REPO_SLUG" > "${STATE_DIR}/config"
  printf '%s\n' "$SOURCE_COMMIT" > "${STATE_DIR}/source-commit"
}

# The interactive updater honours CALICO_* path overrides; the hook and the
# timer do not. Dropping them here keeps this install where those will look,
# and CALICO_REPO is the repo just written to the config.
run_updater() {
  log "Installing calico-claude with the updater (${REPO_SLUG})..."
  env -u CALICO_BIN_LINK -u CALICO_VERSIONS_DIR -u CALICO_STATE_DIR \
    CALICO_REPO="$REPO_SLUG" /bin/bash "$UPDATER" --force </dev/null ||
    fail "The updater could not install calico-claude (see its output above)."
  [[ -x "$LAUNCHER" ]] ||
    fail "The updater finished but ${LAUNCHER} is missing; another update may still be running. Re-run this installer in a minute."
}

# One python3 program for both directions, so install and uninstall share the
# parse, the comparison and the write path. Prints the backup path when it
# wrote one.
#
#   install:   every SessionStart hook whose command references
#              `.claude/calico/update.` is Calico's. The first is replaced in
#              place by the current entry; any others are removed. With none,
#              a new matcher group is appended.
#   uninstall: every such hook is removed. A group, the SessionStart array or
#              the hooks object that the removal empties is removed with it.
#
# Nothing else is touched, and key order is kept. The file is parsed strictly:
# invalid JSON, duplicate keys, NaN/Infinity or a non-object top level abort
# without writing. A missing or blank file reads as {}. When the result is the
# same as the input the file is not rewritten at all. Otherwise the new text is
# written BOM-less to a temp file beside the real file (symlinks are followed),
# the file is read again and must still hold the bytes that were parsed, the
# previous bytes are saved to settings.json.calico-bak (0600, replaced each
# time), and the temp file is renamed over the real one.
merge_settings() { # <install|uninstall>
  python3 - "$1" "$SETTINGS" "$HOOK_COMMAND" <<'PY'
import json, os, sys, tempfile

MARKER = ".claude/calico/update."
mode, settings_path, command = sys.argv[1], sys.argv[2], sys.argv[3]


class Abort(Exception):
    pass


def unique_pairs(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise Abort("duplicate key %r" % key)
        obj[key] = value
    return obj


def no_constants(name):
    raise Abort("non-standard JSON value %s" % name)


def read_bytes(path):
    try:
        with open(path, "rb") as handle:
            return handle.read()
    except FileNotFoundError:
        return None


def is_calico(hook):
    return isinstance(hook, dict) and isinstance(hook.get("command"), str) and MARKER in hook["command"]


def main():
    real = os.path.realpath(settings_path)
    raw = read_bytes(real)
    text = raw.decode("utf-8-sig") if raw else ""
    if text.strip():
        try:
            data = json.loads(text, object_pairs_hook=unique_pairs, parse_constant=no_constants)
        except ValueError as exc:
            raise Abort("cannot parse %s: %s" % (real, exc))
    else:
        data = {}
    if not isinstance(data, dict):
        raise Abort("%s does not hold a JSON object" % real)
    before = json.dumps(data, ensure_ascii=False)

    hooks = data.get("hooks")
    if hooks is not None and not isinstance(hooks, dict):
        raise Abort("%s: \"hooks\" is not an object" % real)
    groups = hooks.get("SessionStart") if hooks is not None else None
    if groups is not None and not isinstance(groups, list):
        raise Abort("%s: \"hooks.SessionStart\" is not an array" % real)

    entry = {"type": "command", "command": command, "timeout": 10, "async": True}
    placed = False
    kept = []
    for group in groups or []:
        if isinstance(group, dict) and isinstance(group.get("hooks"), list):
            inner = []
            removed = False
            for hook in group["hooks"]:
                if is_calico(hook):
                    removed = True
                    if mode == "install" and not placed:
                        inner.append(dict(entry))
                        placed = True
                    continue
                inner.append(hook)
            if removed and not inner:
                continue
            group["hooks"] = inner
        kept.append(group)

    if mode == "install":
        if not placed:
            kept.append({"hooks": [entry]})
        if hooks is None:
            data["hooks"] = {"SessionStart": kept}
        else:
            hooks["SessionStart"] = kept
    elif groups is not None:
        if kept or not groups:
            hooks["SessionStart"] = kept
        else:
            del hooks["SessionStart"]
            if not hooks:
                del data["hooks"]

    # Also covers uninstall with no file: nothing to remove, so nothing is created.
    if json.dumps(data, ensure_ascii=False) == before:
        return

    out = (json.dumps(data, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    directory = os.path.dirname(real)
    fd, tmp = tempfile.mkstemp(prefix=".settings.json.calico-", dir=directory)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(out)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, (os.stat(real).st_mode & 0o7777) if raw is not None else 0o600)
        if read_bytes(real) != raw:
            raise Abort("%s changed while it was being updated; nothing was written. Run the installer again." % real)
        backup = ""
        if raw is not None:
            backup = real + ".calico-bak"
            if os.path.lexists(backup):
                os.unlink(backup)
            bfd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(bfd, "wb") as handle:
                os.fchmod(handle.fileno(), 0o600)
                handle.write(raw)
        os.replace(tmp, real)
    except BaseException:
        if os.path.lexists(tmp):
            os.unlink(tmp)
        raise
    print(backup)


try:
    main()
except Abort as exc:
    sys.stderr.write("Error: %s\n" % exc)
    sys.exit(1)
except (OSError, UnicodeDecodeError) as exc:
    sys.stderr.write("Error: settings.json update failed: %s\n" % exc)
    sys.exit(1)
PY
}

# __HOME__ is substituted with the XML-escaped HOME in Python, not sed: `&`,
# `<` and `>` are legal in a macOS home path, and sed reads `&` in a
# replacement as the whole match. The template is not parsed as XML here: its
# comments contain `--`, which XML forbids and Python's plistlib rejects
# (measured), while plutil and launchd accept it. plutil then sets the label
# and HOME in the job's environment, and lints the result. HOME is set because
# the plist names files under this HOME and the updater derives its state from
# $HOME; the two must not disagree.
render_plist() {
  mkdir -p "$(dirname "$PLIST")" "$(dirname "$LAUNCHD_LOG")"
  local tmp
  tmp="$(mktemp "$(dirname "$PLIST")/.calico-plist.XXXXXX")"
  if ! python3 - "${TMP_DIR}/template.plist" "$HOME" > "$tmp" <<'PY'
import html, sys
with open(sys.argv[1], encoding="utf-8") as handle:
    text = handle.read()
sys.stdout.buffer.write(text.replace("__HOME__", html.escape(sys.argv[2], quote=False)).encode("utf-8"))
PY
  then
    rm -f "$tmp"
    fail "Could not render ${PLIST}."
  fi
  if ! { plutil -replace Label -string "$LAUNCHD_LABEL" "$tmp" &&
         plutil -replace EnvironmentVariables.HOME -string "$HOME" "$tmp" &&
         plutil -lint "$tmp" >/dev/null; }; then
    rm -f "$tmp"
    fail "The rendered ${PLIST} did not pass plutil."
  fi
  chmod 0644 "$tmp"
  mv -f "$tmp" "$PLIST"
}

# bootout, then check whether the label is still there. Absent means it was not
# loaded (measured: `bootout` exits 3, "No such process"), which is fine; still
# loaded means the bootout really failed, and bootstrapping over a loaded job
# fails anyway (measured: exit 5, "Input/output error").
launchd_unload() {
  local target="gui/$(id -u)/${LAUNCHD_LABEL}"
  if launchctl bootout "$target" </dev/null 2>/dev/null; then
    return 0
  fi
  if launchctl print "$target" </dev/null >/dev/null 2>&1; then
    fail "launchctl bootout ${target} failed and the job is still loaded."
  fi
}

launchd_load() {
  launchd_unload
  local rc=0
  launchctl bootstrap "gui/$(id -u)" "$PLIST" </dev/null || rc=$?
  (( rc == 0 )) || fail "launchctl bootstrap gui/$(id -u) ${PLIST} failed (exit ${rc})."
}

# The official `claude` is never touched. An earlier version of this installer
# wrote over it, and those builds do not update themselves, so say how to get
# the official one back.
report_patched_official() {
  local path version
  path="$(command -v claude 2>/dev/null || true)"
  [[ -n "$path" ]] || return 0
  version="$("$path" --version 2>/dev/null </dev/null || true)"
  [[ "$version" == *"(patched)"* ]] || return 0
  log ""
  log "Note: ${path} reports '${version//$'\n'/ }'."
  log "An earlier version of this installer replaced the official claude with a Calico build."
  log "It was left untouched. To restore the official build, run Anthropic's installer,"
  log "then check that \`claude --version\` no longer prints (patched):"
  log "  curl -fsSL https://claude.ai/install.sh | bash"
}

do_install() {
  require_cmd curl
  require_cmd python3
  TMP_DIR="$(mktemp -d)"

  resolve_source_commit
  log "Installing from ${REPO_SLUG} at ${SOURCE_COMMIT}"
  fetch_source_file "examples/local-auto-update/update.sh" "${TMP_DIR}/update.sh"
  if [[ "$OS_KIND" == darwin ]]; then
    fetch_source_file "examples/local-auto-update/com.calico.auto-update.plist" "${TMP_DIR}/template.plist"
  fi

  install_updater
  run_updater

  local backup
  backup="$(merge_settings install)" || fail "Could not add the SessionStart hook to ${SETTINGS}; it was left unchanged."

  if [[ "$OS_KIND" == darwin ]]; then
    render_plist
    launchd_load
  fi

  report_patched_official

  cat >&2 <<EOF

Installed calico-claude from ${REPO_SLUG} at ${SOURCE_COMMIT}.
$("$LAUNCHER" --version 2>/dev/null </dev/null | tr '\n' ' ')

Created or updated:
  ${LAUNCHER}  (launcher symlink; run Calico with this name)
  ${SHARE_DIR}/versions/  (installed builds)
  ${UPDATER}  (updater)
  ${STATE_DIR}/config  (repo=${REPO_SLUG})
  ${STATE_DIR}/source-commit  (${SOURCE_COMMIT})
  ${STATE_DIR}/  (also the updater's log, lock and throttle stamp)
  ${SETTINGS}  (SessionStart hook: ${HOOK_COMMAND})
EOF
  if [[ -n "$backup" ]]; then
    log "  ${backup}  (settings.json as it was before this run)"
  fi
  if [[ "$OS_KIND" == darwin ]]; then
    cat >&2 <<EOF
  ${PLIST}  (hourly timer, loaded as gui/$(id -u)/${LAUNCHD_LABEL})
  ${LAUNCHD_LOG}  (the timer's log)
EOF
  else
    log "  No timer on Linux: updates run from the SessionStart hook only."
  fi
  cat >&2 <<EOF

The official claude was not modified.

To uninstall:
  ${UNINSTALL_CMD}
EOF
}

# Removes only what do_install creates. The official claude, other hooks and
# the rest of settings.json are left alone, and so is settings.json.calico-bak.
do_uninstall() {
  require_cmd python3
  # The settings file goes first: it is the one step that can refuse (a file
  # that does not parse), and a refusal should leave everything else in place.
  local backup
  backup="$(merge_settings uninstall)" || fail "Could not remove the SessionStart hook from ${SETTINGS}; nothing was removed."

  if [[ "$OS_KIND" == darwin ]]; then
    launchd_unload
    rm -f "$PLIST" "$LAUNCHD_LOG"
  fi

  if [[ -L "$LAUNCHER" ]]; then
    rm -f "$LAUNCHER"
  elif [[ -e "$LAUNCHER" ]]; then
    log "Left ${LAUNCHER} in place: it is not a symlink, so the updater did not create it."
  fi
  rm -rf "$SHARE_DIR" "$STATE_DIR"

  log "Removed calico-claude, its builds, the updater and its state, and the SessionStart hook."
  if [[ "$OS_KIND" == darwin ]]; then
    log "Removed the launchd job gui/$(id -u)/${LAUNCHD_LABEL} and ${PLIST}."
  fi
  if [[ -n "$backup" ]]; then
    log "settings.json before this change: ${backup}"
  fi
  report_patched_official
}

main() {
  local mode=install
  case "${1:-}" in
    "") ;;
    --uninstall) mode=uninstall ;;
    *)
      log "Usage: install-patched-claude.sh [--uninstall]"
      exit 2
      ;;
  esac
  [[ $# -le 1 ]] || { log "Usage: install-patched-claude.sh [--uninstall]"; exit 2; }

  detect_os
  refuse_root
  validate_inputs

  if [[ "$mode" == uninstall ]]; then
    do_uninstall
  else
    do_install
  fi
}

main "$@"

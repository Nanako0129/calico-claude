# Local auto-update

Keeps a locally installed patched Claude binary current with this repo's releases,
without letting it fight Anthropic's own updater.

The design is deliberately side-by-side:

> `~/.local/bin/claude` stays a symlink managed by the official installer.
> `~/.local/bin/calico-claude` is a **separately named** symlink managed by `update.sh`.
> Neither updater ever writes the other's path.

Point your launcher (remora's `runtime.claude_binary`, a shell alias, an editor
setting) at the Calico name; leave `claude` alone.

On Windows, use `update.ps1` instead; see [Windows](#windows). It follows the
same rules, but the launcher is a copy rather than a symlink, so several
mechanisms differ.

## What it does

```
SessionStart hook ──► update.sh --hook ──► throttled? ──► exit 0
                                            │
                                            └─ spawn detached `--unattended-run`, exit 0
                                                     │
   GitHub releases API ── highest v<X.Y.Z>-<platform>[-<rebuild>] with our asset
                                                     │
   download ─► checksums.txt (fail-hard) ─► gh attestation verify (fail-hard)
                                                     │
   run the downloaded file in place: exact version + `(patched)` (fail-hard)
                                                     │
   install versions/<X.Y.Z>, or a uniquely named sibling when that path is
   taken; the path is reserved exclusively and never written over
                                                     │
   verify the installed file DIRECTLY: exact version + `(patched)` (fail-hard)
                                                     │
                              mismatch ─► leave the launcher untouched and exit;
                                          the rejected build is pruned later
                                                     │
              write the tag record, then atomic symlink swap; a failed write
                                     leaves the launcher unchanged
                                                     │
                                                  prune
```

Two properties are worth stating explicitly, because they are the reason this is
a script and not a one-line `curl | bash` in a cron job:

| Property | Why |
| --- | --- |
| Verification happens **before** install | A failed checksum, attestation, or version check must never reach `versions/`, let alone the symlink. |
| Installs **never overwrite** | If the destination exists (`--force`, the self-heal, a same-version rebuild), the new build goes to a unique sibling `<X.Y.Z>.<pid>` instead. No intermediate state where the working binary is gone can exist, so no preserve/restore/recover machinery is needed — rollback is only ever a symlink swap back to a file that was never touched. |
| Versions are compared as **whole tokens** | `2.1.24` is a substring of `2.1.240`; a substring test would accept a mislabeled release at the one gate meant to catch it. The installed version is the leading `X.Y.Z` of the symlink target's basename, so a pid-suffixed install still reads as its bare version. |
| The build is verified **before** the swap | It is checked directly, never through the launcher symlink. Reading it through the link is unsound once runs can overlap — another updater may have repointed it — and verifying first removes the need to undo a swap at all. |
| A launcher that is not a symlink is **refused** | Replacing a regular file would destroy something this updater did not create and cannot restore. |
| The tag record and the launcher **advance together** | They describe one fact between them. The record is written before the swap, so a failure to write it is caught while the launcher is still untouched. |
| The lock is an **efficiency device**, not a correctness one | Because installs never overwrite, two concurrent updaters cost a duplicate download, never a broken install. So the lock has no claim protocol: a lock younger than an hour means another run is working and this one exits; an older (or unmeasurable) one is *ignored* — never deleted, moved, or taken over, and a run that ignored a lock leaves it in place on exit. A run only ever removes a lock it created itself. |
| Rebuilds are tracked by **release tag**, not version | A corrected build is republished as `-2` at the same version. Comparing versions alone would report "up to date" and no unattended user would ever receive it. |

It also self-heals one specific failure: if the installed version already matches
the latest release but `--version` no longer prints `(patched)`, the official
updater (or a manual `claude install`) has overwritten the patched build, and the
script reinstalls it.

Concurrent updaters are outside this example's scope: normal use is one hook, on
one machine, at most once an hour, and the behavior of two overlapping runs is
not defined.

## Install

On macOS and Linux, [`install-patched-claude.sh`](../../install-patched-claude.sh) at the repository
root does all of this: it installs the script, writes `~/.claude/calico/config`, runs `--force` once,
adds the SessionStart hook, and on macOS loads the launchd timer. The hook it writes is
`/bin/bash "<your home>/.claude/calico/update.sh" --hook`; re-running it replaces an entry from the
manual steps below instead of adding a second one. The steps below are the manual equivalent, and
what this directory documents is the updater itself.

**1. Put the script somewhere stable.**

```bash
mkdir -p ~/.claude/calico
cp examples/local-auto-update/update.sh ~/.claude/calico/update.sh
chmod +x ~/.claude/calico/update.sh
```

**2. Do the first install by hand and look at the output.**

```bash
~/.claude/calico/update.sh --check   # read-only: installed vs latest
~/.claude/calico/update.sh --run
~/.local/bin/calico-claude --version # expect: <version> (Claude Code) (patched)
```

Running `--run` once manually matters: it is the only time you will see the
checksum and attestation lines on your terminal instead of in a log file.

**3. Wire the SessionStart hook** in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.claude/calico/update.sh --hook",
            "timeout": 10,
            "async": true
          }
        ]
      }
    ]
  }
}
```

`--hook` reads its throttle file, spawns a detached `--unattended-run` at most once an hour,
and returns immediately; it never blocks session startup and ignores the hook's
stdin payload. `async: true` plus the short timeout are belt and braces.

An updated binary is picked up by the **next** session, not the running one.

**4. Optional — add a launchd timer (macOS).**

The hook only fires when a session starts, so a release published while you are
not opening sessions waits. Observed on one machine: `v2.1.258-macos-arm64`
published at 08:08 local and was installed at 12:00, the next time a session
began. [`com.calico.auto-update.plist`](./com.calico.auto-update.plist) closes
that to at most an hour.

```bash
mkdir -p ~/Library/LaunchAgents ~/Library/Logs
python3 - <<'PY' > ~/Library/LaunchAgents/com.calico.auto-update.plist
import html, os
tpl = open("examples/local-auto-update/com.calico.auto-update.plist").read()
print(tpl.replace("__HOME__", html.escape(os.environ["HOME"], quote=False)), end="")
PY
plutil -lint ~/Library/LaunchAgents/com.calico.auto-update.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.calico.auto-update.plist
```

Python rather than `sed` because `&`, `<`, `>` and `|` are all legal in a macOS
home path and all mean something to one of the two layers involved. `sed` reads
`&` in a replacement as the whole match, so `HOME=/Users/a&b` writes
`/Users/a__HOME__b` into valid XML that `plutil` and launchd both accept — a job
pointed at a path that does not exist, with nothing to indicate why.

If you track a fork, say so in `~/.claude/calico/config`, not in the plist or your
shell: one line, `repo=<owner>/<name>`. The hook and the timer both run in the
unattended mode, which reads the repo from that file and ignores `CALICO_REPO`
and the `CALICO_*` path overrides (see [Configuration](#configuration)).

```bash
printf 'repo=%s\n' your-name/calico-claude > ~/.claude/calico/config
```

`RunAtLoad` makes it run immediately, so you can read the result rather than
assume it:

```bash
launchctl list | grep com.calico.auto-update   # second column is the last exit status
tail ~/Library/Logs/calico-auto-update.log
```

Three choices in that file are deliberate, and the comments say why: it calls
`--unattended-run` rather than `--hook`, it sets `PATH`, and it logs somewhere
other than `update.log`. `PATH` exists because launchd hands the agent a clean
environment, and its absence fails quietly: without it `gh` is missing and every
run installs on the checksum alone with attestation skipped, and the job still
exits 0. The repo is not in the plist: the unattended mode ignores `CALICO_REPO`
and reads `~/.claude/calico/config`, the same file the hook reads.

The timer does not touch the `last-check` stamp, so the SessionStart hook keeps
its own schedule. Both can check within the same hour; the cost is one extra
release lookup.

Remove it with `launchctl bootout gui/$(id -u)/com.calico.auto-update` and
deleting the plist.

## Modes

| Mode | Effect |
| --- | --- |
| `--hook` | Throttled entry point. Exits 0 immediately inside the window; otherwise stamps `last-check`, rotates the log, spawns a detached `--unattended-run`, exits 0. |
| `--unattended-run` | `--run` for the hook's child and the launchd agent. The repo comes from `~/.claude/calico/config` and every path from `HOME`; `CALICO_REPO` and the `CALICO_*` path overrides are ignored. |
| `--run` | Update if a newer verified release exists. |
| `--force` | Reinstall even when already up to date — skips *only* the version gate. Checksum, attestation and post-verify still run. Use after a rebuilt release at the same version. |
| `--check` | Report installed vs latest. Changes nothing, downloads nothing. |

## Configuration

Every path and policy knob is an environment variable with a sane default, so the
script itself needs no editing. The two unattended modes, `--hook` and
`--unattended-run`, ignore `CALICO_REPO`, `CALICO_BIN_LINK`, `CALICO_VERSIONS_DIR`
and `CALICO_STATE_DIR`: they inherit an environment someone else chose (a Claude
Code session, which a project's settings can add variables to, or launchd), and
a repo taken from there could point every later update at another repository.
They read the repo from `~/.claude/calico/config` instead (`repo=<owner>/<name>`;
without it, `Nanako0129/calico-claude`) and derive every path from `HOME`.
`GH_HOST` and `GH_REPO` are dropped in those modes as well.

| Variable | Default | Meaning |
| --- | --- | --- |
| `CALICO_REPO` | `Nanako0129/calico-claude` | Release repo to track. Interactive modes only; the unattended modes read `~/.claude/calico/config`. |
| `CALICO_PLATFORM` | auto-detected | Force a platform suffix (`linux-x64`, `linux-arm64`, `macos-arm64`, `win32-x64`, `win32-arm64`). |
| `CALICO_BIN_LINK` | `~/.local/bin/calico-claude` | The managed symlink. |
| `CALICO_VERSIONS_DIR` | `~/.local/share/calico-claude/versions` | Where builds are kept. |
| `CALICO_STATE_DIR` | `~/.claude/calico` | Lock, throttle stamp, installed release tag, and `update.log`. |
| `CALICO_KEEP_VERSIONS` | `3` | Newest builds to keep. `0` disables pruning. The current symlink target is always kept — after a rollback it survives on top of the newest N. |
| `CALICO_THROTTLE_SECONDS` | `3600` | Minimum gap between `--hook` checks. |
| `GH_TOKEN` / `GITHUB_TOKEN` | unset | Bearer token for the releases API, `GH_TOKEN` first. When neither is set, an authenticated `gh` supplies one (`gh auth token`); with none of the three, the call is anonymous and capped at 60 an hour per address. Whichever is used reaches `curl` on stdin, never on its command line. |

Pruning is not cosmetic. Each build is roughly 300 MB, so an unattended updater
left alone for a few months will quietly consume several gigabytes.

## Requirements

`bash` 3.2+, `curl`, `python3`, and `shasum` (macOS) or `sha256sum` (Linux).

`gh` is optional but strongly recommended, for two reasons. Without an
authenticated `gh`, build provenance attestation cannot be checked and the
script logs a warning and proceeds on the checksum alone. The checksum proves
the file matches the release asset; the attestation proves the release asset
came out of this repo's CI. That difference matters: `checksums.txt` is
published in the same release as the asset, so anyone able to publish a release
can publish a matching checksum with it. Without `gh`, a compromised release is
installed. This is an accepted trade-off, not an oversight.

The attestation is pinned to the release workflow on `main`: `gh attestation
verify` runs with `--signer-workflow <repo>/.github/workflows/patch-claude.yml`
and `--source-ref refs/heads/main`, so an attestation produced by another
workflow, or from a branch, is rejected. A `gh` too old for those flags fails
the install and says so rather than verifying without them; gh 2.97.0 has both.

Drafts and prereleases are never installed. If the installed version is newer
than every published release, the log says so instead of reporting "up to
date".

It is also what keeps the releases query off GitHub's anonymous limit, 60 an
hour per address. Neither launchd nor the SessionStart hook exports a token, so
without an authenticated `gh` every check goes out anonymous, and on a shared
address that allowance is spent by everyone behind it. Measured on one machine: 4 of 12
consecutive checks failed with `curl: (56) ... error: 403`, one of them the only
check after a new release was published. The hook stamps its throttle before it
queries, so each of those 403s also cost the next hour.

The launchd timer needs that authentication to be **persistent** — `gh auth
login`, which stores the credential on disk. launchd starts the agent with a
clean environment, so a `GH_TOKEN` or `GITHUB_TOKEN` exported in your shell
never reaches it: `gh auth status` fails there, every scheduled install skips
attestation, and the job still exits 0. Do not work around that by putting a
token in the plist — `~/Library/LaunchAgents` is not a credential store.

The agent's log says which happened, the next time it actually installs
something:

```bash
grep -E 'Attestation verified|gh unavailable' ~/Library/Logs/calico-auto-update.log
```

## Verify it works

```bash
bash examples/local-auto-update/test-update.sh
```

Offline checks cover platform detection, the checksum gate (tampered, absent,
empty, and a decoy that only matches through an unescaped dot), pruning
(including the rollback shape where the symlink points at an older build), hook
throttling, lock behaviour (a young lock blocks; an aged one is ignored but
never removed), log rotation, release selection, and end-to-end `--run` cases
driven through stubbed `curl` and `gh`:

| Case | Expected |
|---|---|
| A good artifact | Installs; symlink points at it |
| A bad artifact under `--force` | Run fails before install; the existing same-version build survives byte-for-byte |
| A `--force` reinstall over an existing build | New build lands on a **new suffixed path**; the existing file is byte-identical afterwards |
| Passes pre-install, fails once installed | Run fails; symlink returns to the untouched previous target |
| A version that merely *contains* the expected one | Rejected; nothing installed |
| Passes pre-install, fails afterwards, no previous target | Run fails; no symlink left behind |
| A `-2` rebuild of the installed version | Installed; the tag is recorded |
| A rebuild already installed, or no tag recorded | Left alone |
| A suffixed symlink target | Reads as its bare version; pruning never deletes it |
| The tag record can't be written | Run exits 0; launcher and record both stay unchanged |

Two of those cases run under `/bin/bash` specifically rather than whatever `bash`
is on `PATH`. Stock macOS ships bash 3.2, where `"${empty_array[@]}"` is an
unbound variable under `set -u`; a Homebrew bash 5.x on `PATH` hides that entire
class of bug, and it hid a real one here — the releases API call aborted before
its first request for anyone without `GH_TOKEN` set.

The suite runs entirely in a sandbox: no network, no writes to real install paths.

The root installer has its own offline suite, run under both shells:

```bash
/bin/bash examples/local-auto-update/test-install.sh
bash examples/local-auto-update/test-install.sh
```

It runs the real installer in a sandbox `HOME` with `curl`, `gh`, `launchctl`, `id` and `uname`
stubbed, and covers the root and Git Bash refusals, the SHA-pinned fetch, the config, the
settings.json merge (missing, empty, unrelated hooks, a stale Calico entry, a symlinked file,
non-ASCII, a BOM, strict parsing, a change between read and rename, and the `0600` backup), the
launchd bootout and bootstrap handling, Linux, and uninstall.

## Windows

`update.ps1` is the Windows counterpart. It runs under PowerShell 7 and Windows
PowerShell 5.1, and it is not wired to anything yet: this section covers running
it by hand. Hook and scheduled-task wiring are not part of this example yet.

| Path | Holds |
| --- | --- |
| `%USERPROFILE%\.local\bin\calico-claude.exe` | The launcher: a **copy** of the verified build, not a link |
| `%USERPROFILE%\.local\share\calico-claude\versions\<X.Y.Z>` | Kept copies (newest `CALICO_KEEP_VERSIONS`, default 3) |
| `%USERPROFILE%\.claude\calico\` | `update.log`, `last-check`, `installed-tag`, and `config` (`repo=<owner>/<name>`) |

The official `claude.exe` and `%USERPROFILE%\.local\share\claude` are never
touched, and neither is Anthropic's own `claude.exe.old.*`.

```powershell
$u = "$env:USERPROFILE\.claude\calico\update.ps1"
New-Item -ItemType Directory -Force (Split-Path $u) | Out-Null
Copy-Item examples\local-auto-update\update.ps1 $u
powershell -NoProfile -ExecutionPolicy Bypass -File $u -Mode check
powershell -NoProfile -ExecutionPolicy Bypass -File $u -Mode run
& "$env:USERPROFILE\.local\bin\calico-claude.exe" --version   # expect: <version> (Claude Code) / (patched)
```

| Mode | Effect |
| --- | --- |
| `-Mode hook` | Throttled; inside the window it exits 0. Otherwise it stamps `last-check` and starts a hidden, detached `-Mode unattended-run`, then exits 0. |
| `-Mode unattended-run` | `run` with the repo from `config` only (absent or malformed means `Nanako0129/calico-claude`) and every path from `USERPROFILE`; `CALICO_REPO`, the `CALICO_*` path overrides, `GH_HOST` and `GH_REPO` are ignored. |
| `-Mode run` / `force` / `check` | As in `update.sh`. They honour `CALICO_REPO`, `CALICO_BIN_LINK` (the launcher path), `CALICO_VERSIONS_DIR` and `CALICO_STATE_DIR`. |
| `-PinTag <tag>` | `run`/`force` only: install exactly that published tag, skipping the version gate but no verification. Refused in `hook`, `unattended-run` and `check`. |

What differs from `update.sh`, and why:

| Property | Why |
| --- | --- |
| Ownership comes from a **record**, not a link target | A copied launcher carries no sign of who put it there. `installed-tag` holds the tag and the SHA256 of the launcher this script installed. When there is no launcher, the script installs one. If a launcher exists but has no record, or its hash differs from the recorded one, the script **refuses** and leaves the file byte-for-byte unchanged. If the hash matches, the installed version is whatever the launcher's own `--version` prints (it must include `(patched)`). A record naming another version has an unknown rebuild rank, so the latest rebuild is reinstalled. |
| The swap is **two renames** in one directory | Windows cannot overwrite a running `.exe`, but it can rename one. The build is downloaded and verified as a uniquely named staging file next to the launcher. Then the launcher is renamed to `calico-claude.exe.calico-old.<ms>`, and the staging file is renamed to the launcher. If either rename fails, the old launcher and the record are put back. Open sessions keep running the old build from the aside. |
| A **named mutex** replaces the lock directory | `Local\calico-claude-update`. A second run exits at once. If a run is killed, Windows marks its mutex abandoned, and the next run takes it over, so no stale lock is possible. Old asides are removed only while the mutex is held, and an aside still in use is left for a later run. |
| gh success is its **exit code** | Windows PowerShell 5.1 turns any stderr line of a redirected native command into an error. Every native call runs under a local `$ErrorActionPreference = 'Continue'`, and success is decided by the exit code alone. |
| Checksums are compared **exactly** | Each `checksums.txt` line is split on whitespace, and a leading `*` is stripped from the name. The line is used only if that name equals `claude.native.windows.patched.exe`, with no pattern matching; exactly one such line must exist. |

**Without `gh`, attestation is skipped.** The run logs `WARNING: gh not found`,
or `gh is not authenticated`, and installs on the checksum alone. As explained
under [Requirements](#requirements), the checksum is published by whoever
publishes the release, so a compromised release is installed in that case. This
is an accepted risk; install and authenticate gh to close it. When gh is
present, attestation is pinned exactly as in `update.sh`. A gh that reports
`unknown flag` fails the install with a message saying so.

The API token is taken from `GITHUB_TOKEN`, then `GH_TOKEN`, then `gh auth
token`. It goes only into the releases API request header. It is never sent
with asset downloads, never placed on a child process's command line, and never
written to the log. The hook's child derives the token again itself.

Verify with the offline suite. It needs Windows, because it builds a stand-in
`claude.exe` with the `csc.exe` that ships with the .NET Framework.

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File examples\local-auto-update\test-update.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File examples\local-auto-update\test-update.ps1
```

It stubs the network by shadowing `Invoke-RestMethod` and `Invoke-WebRequest`,
uses a `gh.cmd` stub on `PATH`, and points `USERPROFILE` at a sandbox under
`%TEMP%`. It covers:

- the checksum, version and `(patched)` gates, including decoy checksum lines
- skipping drafts and prereleases
- the record rules
- gh exit-code handling and the attestation arguments
- a launcher held by a running process
- rollback after a failed rename, and after a partial download
- a second run blocked by the mutex, and a killed holder's mutex taken over
- the aside sweep, and version pruning
- the unattended settings, and `-PinTag` refusals
- keeping the token out of the hook child's command line and out of the log

## Uninstall

If the root installer set it up, use its `--uninstall` mode; it removes the hook entry, the timer,
and everything below, and nothing else:

```bash
curl -fsSL https://raw.githubusercontent.com/Nanako0129/calico-claude/main/install-patched-claude.sh | bash -s -- --uninstall
```

By hand:

```bash
# Remove the hook entry from ~/.claude/settings.json, then:
rm -rf ~/.claude/calico
rm -f ~/.local/bin/calico-claude
rm -rf ~/.local/share/calico-claude
```

On Windows:

```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\.claude\calico", "$env:USERPROFILE\.local\share\calico-claude"
Remove-Item -Force "$env:USERPROFILE\.local\bin\calico-claude.exe*"
```

# Local auto-update

Keeps a locally installed patched Claude binary current with this repo's releases,
without letting it fight Anthropic's own updater.

The design is deliberately side-by-side:

> `~/.local/bin/claude` stays a symlink managed by the official installer.
> `~/.local/bin/calico-claude` is a **separately named** symlink managed by `update.sh`.
> Neither updater ever writes the other's path.

Point your launcher (remora's `runtime.claude_binary`, a shell alias, an editor
setting) at the Calico name; leave `claude` alone.

## What it does

```
SessionStart hook ──► update.sh --hook ──► throttled? ──► exit 0
                                            │
                                            └─ spawn detached `--run`, exit 0
                                                     │
   GitHub releases API ── highest v<X.Y.Z>-<platform>[-<rebuild>] with our asset
                                                     │
   download ─► checksums.txt (fail-hard) ─► gh attestation verify (fail-hard)
                                                     │
   run the downloaded file in place: exact version + `(patched)` (fail-hard)
                                                     │
   install versions/<X.Y.Z> — or a unique sibling <X.Y.Z>.<pid> when that path
   already exists; an install NEVER writes over an existing file
                                                     │
   atomic symlink swap ─► re-check through the link
                                                     │
                              mismatch ─► point the link back at the previous
                                          target (never touched), or remove it
                                          when there is no previous one
                                                     │
                                            prune to the newest 3 versions
```

Two properties are worth stating explicitly, because they are the reason this is
a script and not a one-line `curl | bash` in a cron job:

| Property | Why |
| --- | --- |
| Verification happens **before** install | A failed checksum, attestation, or version check must never reach `versions/`, let alone the symlink. |
| Installs **never overwrite** | If the destination exists (`--force`, the self-heal, a same-version rebuild), the new build goes to a unique sibling `<X.Y.Z>.<pid>` instead. No intermediate state where the working binary is gone can exist, so no preserve/restore/recover machinery is needed — rollback is only ever a symlink swap back to a file that was never touched. |
| Versions are compared as **whole tokens** | `2.1.24` is a substring of `2.1.240`; a substring test would accept a mislabeled release at the one gate meant to catch it. The installed version is the leading `X.Y.Z` of the symlink target's basename, so a pid-suffixed install still reads as its bare version. |
| Post-install verify can **roll back** | If the installed binary does not report both the expected version and `(patched)`, the symlink returns to its previous target — or is removed outright when this was a first install, since a link to a binary that just failed its check is worse than no link. The failed build stays in `versions/` and is pruned like any other old one. |
| Pruning only runs while **holding the lock** | An ignored lock lets runs overlap by design, and an overlapping run may have installed a destination without swapping its symlink yet. Deleting it would strand that run, so a run without the lock skips the cleanup pass. |
| The lock is an **efficiency device**, not a correctness one | Because installs never overwrite, two concurrent updaters cost a duplicate download, never a broken install. So the lock has no claim protocol: a lock younger than an hour means another run is working and this one exits; an older (or unmeasurable) one is *ignored* — never deleted, moved, or taken over, and a run that ignored a lock leaves it in place on exit. A run only ever removes a lock it created itself. |
| Rebuilds are tracked by **release tag**, not version | A corrected build is republished as `-2` at the same version. Comparing versions alone would report "up to date" and no unattended user would ever receive it. |

It also self-heals one specific failure: if the installed version already matches
the latest release but `--version` no longer prints `(patched)`, the official
updater (or a manual `claude install`) has overwritten the patched build, and the
script reinstalls it.

## Install

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

`--hook` reads its throttle file, spawns a detached `--run` at most once an hour,
and returns immediately; it never blocks session startup and ignores the hook's
stdin payload. `async: true` plus the short timeout are belt and braces.

An updated binary is picked up by the **next** session, not the running one.

## Modes

| Mode | Effect |
| --- | --- |
| `--hook` | Throttled entry point. Exits 0 immediately inside the window; otherwise stamps `last-check`, rotates the log, spawns a detached `--run`, exits 0. |
| `--run` | Update if a newer verified release exists. |
| `--force` | Reinstall even when already up to date — skips *only* the version gate. Checksum, attestation and post-verify still run. Use after a rebuilt release at the same version. |
| `--check` | Report installed vs latest. Changes nothing, downloads nothing. |

## Configuration

Every path and policy knob is an environment variable with a sane default, so the
script itself needs no editing:

| Variable | Default | Meaning |
| --- | --- | --- |
| `CALICO_REPO` | `Nanako0129/calico-claude` | Release repo to track. |
| `CALICO_PLATFORM` | auto-detected | Force a platform suffix (`linux-x64`, `linux-arm64`, `macos-arm64`, `win32-x64`, `win32-arm64`). |
| `CALICO_BIN_LINK` | `~/.local/bin/calico-claude` | The managed symlink. |
| `CALICO_VERSIONS_DIR` | `~/.local/share/calico-claude/versions` | Where builds are kept. |
| `CALICO_STATE_DIR` | `~/.claude/calico` | Lock, throttle stamp, installed release tag, and `update.log`. |
| `CALICO_KEEP_VERSIONS` | `3` | Newest builds to keep. `0` disables pruning. The current symlink target is always kept — after a rollback it survives on top of the newest N. |
| `CALICO_THROTTLE_SECONDS` | `3600` | Minimum gap between `--hook` checks. |
| `GH_TOKEN` / `GITHUB_TOKEN` | unset | Bearer token for the releases API, if you hit the anonymous rate limit. |

Pruning is not cosmetic. Each build is roughly 300 MB, so an unattended updater
left alone for a few months will quietly consume several gigabytes.

## Requirements

`bash` 3.2+, `curl`, `python3`, and `shasum` (macOS) or `sha256sum` (Linux).

`gh` is optional but strongly recommended: without an authenticated `gh`, build
provenance attestation cannot be checked and the script logs a warning and
proceeds on the checksum alone. The checksum proves the file matches the release
asset; the attestation proves the release asset came out of this repo's CI.

## Verify it works

```bash
bash examples/local-auto-update/test-update.sh
```

70 assertions, offline: platform detection, the checksum gate (tampered, absent,
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

Two of those cases run under `/bin/bash` specifically rather than whatever `bash`
is on `PATH`. Stock macOS ships bash 3.2, where `"${empty_array[@]}"` is an
unbound variable under `set -u`; a Homebrew bash 5.x on `PATH` hides that entire
class of bug, and it hid a real one here — the releases API call aborted before
its first request for anyone without `GH_TOKEN` set.

The suite runs entirely in a sandbox: no network, no writes to real install paths.

## Uninstall

```bash
# Remove the hook entry from ~/.claude/settings.json, then:
rm -rf ~/.claude/calico
rm -f ~/.local/bin/calico-claude
rm -rf ~/.local/share/calico-claude
```

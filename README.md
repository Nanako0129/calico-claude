# Calico Claude

> **Calico Claude** is a self-hosted, verifiable supply chain for patched native Claude Code binaries.
> It is a fork of [`a-connoisseur/patch-claude-code`](https://github.com/a-connoisseur/patch-claude-code)
> (reviewed at upstream commit `729494e`). The display patches are unchanged in intent; this fork adds
> its own branding ("Calico Claude"), patch-integrity assertions, dependency pinning, and a CI pipeline
> that publishes sha256 checksums plus build provenance attestations. Releases live at
> [`Nanako0129/calico-claude`](https://github.com/Nanako0129/calico-claude).

## What this does

This repo publishes patched native Claude binaries that make output more transparent without verbose mode.
Here is an exhaustive list of things it changes:

- Shows detailed tool calls instead of collapsed summaries.
- Hard disables spinner tips.
- Streams thinking live in the UI. This is helpful for instances where Claude thinks for over 10 minutes and you want to know if it's actually still doing something.
- Shows subagent `Prompt:` blocks in the non-verbose UI.
- Renames the startup header to `Calico Claude v...` (this makes it easy to identify when Claude has auto updated and lost the patch).
- Adds a dormant, opt-in custom-model context adapter. It changes nothing unless
  `CALICO_MODEL_CONTEXT_WINDOWS` is supplied by a launcher such as remora.
- Adds a dormant active-turn identity adapter for remora. It changes nothing
  unless the launcher sets `REMORA_ACTIVE=1`.
- Refreshes background GPT agent accounting after terminal stream usage or late wrapper
  mutation, so the agent row shows finalized token usage alongside elapsed time.
- Exposes only committed terminal assistant usage to the status line, so provisional
  thinking/responding wrappers and synthetic all-zero fallbacks cannot erase the last
  completed snapshot.

### Background-agent token usage

Claude Code's native background tracker normally samples assistant usage as stream messages
arrive. OpenAI-compatible gateways can create the assistant wrapper with provisional `0/0`
usage, then deliver authoritative accounting in a terminal `message_delta` or mutate that same
wrapper after the tracker sampled it. The foreground summary reads the finalized wrapper later,
but without this patch the live background row can show elapsed time without any token count.

Calico tracks usage by response ID across `message_start`, terminal `message_delta`, and completed
assistant wrappers. It refreshes from the mutated transcript at both progress and completion seams,
while deduplicating output tokens seen through more than one path. The displayed total preserves
Claude Code's native semantics: the latest response input and cache tokens plus cumulative output
across the background agent's turns. This changes only local accounting; it does not modify the
Claude or OpenAI-compatible gateway protocol.

The structural verifier requires `__calicoTrackAgentUsage`, `__calicoRefreshAgentUsage`, the
response-output deduplication map, and both refresh seams. Regression tests cover provisional
`0/0`, terminal accounting, late mutation, repeated deltas, direct completed wrappers, and
multi-turn totals.

### Committed status-line usage

The status-line usage display is sourced from Calico's patched Claude Code message stream.
The canonical query-stream assistant wrapper starts with a shared mutable commit cell,
`__calicoUsageState: { committed: false, usage: null }`. The object cell is intentional:
Claude Code shallow-copies the provisional wrapper into app state before the terminal event, so
a primitive top-level boolean would remain stale even after the canonical wrapper commits. The
shallow copies retain the cell reference. A trusted terminal `message_delta` stores both
`committed: true` and the exact aggregated usage snapshot in that cell. Downstream tool-input and
fallback transforms synchronize the same cell alongside usage and stop fields, and the status-line
selector projects the saved snapshot instead of trusting later mutations to the provisional
message usage.

A terminal event is trusted only when its raw usage is not the exact all-zero sentinel and the
aggregated usage contains a non-zero accounting field (`input_tokens`, `output_tokens`, cache
creation, or cache read). The sentinel requires explicit numeric `input_tokens: 0` and
`output_tokens: 0`; flat cache creation/read fields may be omitted or zero, and nested
`cache_creation.ephemeral_1h_input_tokens` and
`cache_creation.ephemeral_5m_input_tokens` may also be omitted or zero. Any non-zero flat or
nested cache field makes it non-sentinel. A raw event with only `output_tokens: 0` is not
classified as the fallback because its input field is missing. The raw guard is required because
Claude's `xAe` aggregation can retain positive message-start or previous-turn values when a
synthetic terminal event reports all zeros. The saved snapshot is monotonic: a later untrusted
all-zero delta cannot erase it. Valid partial-zero responses such as `input_tokens > 0` and
`output_tokens = 0` are still committed.

Wrappers created at `message_start` or content-block cleanup remain provisional. UI-only
thinking/responding virtual messages, `message_stop` cleanup, direct stream-error synthesized
stop reasons, and the exact all-zero `[DONE]` fallback are therefore ignored by the status-line
selector. Before the first committed response the display is unknown; while a later turn is
still provisional it keeps the previous committed usage. The selector only projects committed
snapshots from the already-sliced message array supplied by Claude Code, so compaction boundaries
remain owned by the existing `kb()` slice and are never searched across by the new helper.

The structural verifier checks the shared commit cell, terminal snapshot mutation, downstream
clone synchronization, selector replacement, and absence of message-stop/UI-reducer commits. Run it
against the exact binary you intend to use;
a `(patched)` version label alone is not sufficient.

### Optional custom-model context windows

Stock Claude Code safely treats an unknown custom model id as a 200K model. Calico can instead use an
exact model-to-window map when the gateway advertises a larger operational ceiling:

```bash
export CALICO_MODEL_CONTEXT_WINDOWS='{"gpt-5.6-sol":372000}'
export CALICO_CONTEXT_DISPLAY_PERCENT=95
export CLAUDE_CODE_AUTO_COMPACT_WINDOW=372000
export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=90
claude --model gpt-5.6-sol
```

The map is parsed locally, accepts only exact model ids and integer windows from 100K through 1M, and
falls back to Claude Code's stock behavior on malformed input. The display percentage only affects the
status-line denominator. In this opt-in mode Calico also bypasses Claude's separate output-reserve and
precompute-buffer deductions, so the compact percentage is applied once to the raw mapped window. With
the values above, status-line consumers see 353.4K usable tokens and compaction starts at 334.8K.

remora users should select its `calico` context mode instead of exporting these variables manually.
The default remora `stock` mode does not require Calico and remains capped at Claude Code's native 200K.

### Optional active-turn identity

Claude Code already maintains a prompt UUID across the initial model request and
its tool-result continuations. When `REMORA_ACTIVE=1`, Calico exposes that value
to a compatible gateway as `x-calico-prompt-id` and sends
`x-calico-active-turn-version: 1`. Spawned agents freeze the prompt UUID in
their async context, and nested agents inherit the frozen parent value, so a
background agent keeps its original turn identity if the main session accepts a
later user prompt.

Only Claude's own `main` and `subagent` query-source classes receive these
headers. Quota checks, token counting, compaction, side queries, and other
auxiliary requests are excluded so they cannot read or overwrite agentic turn
state. Calico-owned header values are written after custom headers and therefore
cannot be replaced through `ANTHROPIC_CUSTOM_HEADERS`.

The adapter marker is `calico-active-turn-adapter:v1`. The patch gate requires
both the AsyncLocalStorage capture and HTTP header anchors; if either upstream
shape changes, the module applies nothing and the release build fails. The
adapter does not store or forward Codex backend state. A compatible gateway
must still capture and replay the server-issued `x-codex-turn-state`; the Calico
header only provides the Claude-side turn boundary. Plain Calico launches do
not emit either header.

## Trust and security

Calico replaces the native Claude Code executable, so installing it is a supply-chain decision rather than a normal remora configuration change. Releases are built in GitHub Actions from Anthropic's native installer, use pinned patch dependencies, fail when a selected patch no longer matches the upstream bundle, and publish SHA-256 checksums plus GitHub provenance attestations.

The context adapter is dormant by default. It never contacts a server or reads credentials; it only accepts a child-process environment map. Exact model matching, bounded integer validation, malformed-input fallback, and remora's binary capability check prevent a broad or silent context increase. Plain Claude Code launches without those variables retain stock context behavior.

Before installation, review the workflow and patch source, verify the release checksum and attestation, and keep a copy or reinstall path for the official Claude binary. remora's approval-gated installer deliberately does not install Calico on the user's behalf.

#### Thinking note:

- If you want thinking to stream live in the UI without verbose mode, add this to your Claude settings:

```json
"showThinkingSummaries": true
```
- Settings can come from `~/.claude/settings.json`, `.claude/settings.json`, or `.claude/settings.local.json`.

## Questions and answers

### Does Calico send prompts or credentials anywhere?

No. Calico is a patched native Claude Code executable, not a gateway or hosted service. The build pipeline downloads Anthropic's native binary, applies reviewable local patches, and publishes the result. Claude Code still sends data to whichever provider or gateway its runtime configuration selects.

### Does Calico itself route Claude Code to OpenAI models?

No. The OpenAI routing comes from a launcher such as remora plus an Anthropic-compatible gateway. Calico contributes UI transparency, optional custom-model context handling, and a stable prompt identity for compatible active-turn bridges.

### Will Claude Code updates remove the patches?

Yes. The official updater can install a new version and move the `claude` symlink to that unpatched binary. Re-run the Calico installer after every Claude Code update, then verify the new release before relying on it.

### Why can the startup banner say Calico while a newer adapter is missing?

The branding patch and functional adapters are separate modules. An older Calico build may still print the patched banner but lack a later `custom-context-window` or `active-turn-prompt-id` module. Use the binary verifier, or `remora doctor --online` when using remora, instead of treating the banner as a complete capability check.

### Can I keep official Claude and Calico side by side?

Yes. This avoids updater contention and makes rollback explicit. Download and verify the patched release, install it under a separate name, and point remora at that path:

```bash
install -m 0755 ./claude.native.patched ~/.local/bin/calico-claude
~/.local/bin/calico-claude --version
```

```toml
[runtime]
claude_binary = "/absolute/path/to/.local/bin/calico-claude"
```

Leave the official `~/.local/bin/claude` symlink under Anthropic's updater. A separately named Calico binary does not update automatically; replace it only after verifying a matching newer release.

### Does the active-turn adapter bypass Codex quota limits?

No. It only exposes Claude's existing prompt boundary to a compatible gateway. The gateway must preserve the server-issued Codex state, and OpenAI still decides whether a recognized turn may continue under fair-use policy.

### How do I verify the installed binary?

Check the release SHA-256 and GitHub attestation first. From a source checkout, the structural verifier confirms every enabled patch module:

```bash
node scripts/verify-patched-binary.ts \
  --input "$(command -v calico-claude)" \
  --disable tool-call-verbose
```

The verifier must report `active-turn-prompt-id`, `background-agent-usage`, `statusline-committed-usage`, and `custom-context-window` as `ok`; a patched version label alone is insufficient.

## Quick Start

### Prerequisite

If you installed Claude Code via npm, remove it and install the native build first:

```bash
npm uninstall -g @anthropic-ai/claude-code
curl -fsSL https://claude.ai/install.sh | bash
claude --version
```

### Automatic Install

This installer detects your OS and CPU architecture and downloads the matching patched release for that version and platform. If an immutable rebuild such as `-2` exists, it selects the highest published rebuild suffix instead of overwriting or silently using the older artifact.
```bash
curl -fsSL https://raw.githubusercontent.com/Nanako0129/calico-claude/main/install-patched-claude.sh | bash
```

On Windows, use PowerShell:
```powershell
irm https://raw.githubusercontent.com/Nanako0129/calico-claude/main/install-patched-claude.ps1 | iex
```

If you'd rather avoid blindly running scripts from the internet, you can do it the manual way below.
That said, the binaries are built on Github Actions and the patcher is also free for you to see and modify, so there's no reason to trust this repo or the release builds other than convenience.

### Manual Install (From Releases, native only)

1. Pick the release tag for your platform:
   - macOS arm64: `macos-arm64`
   - Linux x64: `linux-x64`
   - Linux arm64: `linux-arm64`
   - Windows x64: `win32-x64`
   - Windows arm64: `win32-arm64`

2. In that release, download the regular patched binary for your platform.

3. Follow the install instructions for your platform below.

### Install (Linux)

```bash
chmod +x ./claude.native.patched
sudo mv ./claude.native.patched "$(which claude)"
claude --version
```

### Install (macOS)

```bash
chmod +x ./claude.native.macos.patched
sudo mv ./claude.native.macos.patched "$(which claude)"
xattr -dr com.apple.quarantine "$(which claude)"
claude --version
```

### Install (Windows)

```powershell
$target = (Get-Command claude).Source
Copy-Item .\claude.native.windows.patched.exe $target -Force
claude --version
```

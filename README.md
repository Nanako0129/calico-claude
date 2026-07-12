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
  `CALICO_MODEL_CONTEXT_WINDOWS` is supplied by a launcher such as Remora.

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

Remora users should select its `calico` context mode instead of exporting these variables manually.
The default Remora `stock` mode does not require Calico and remains capped at Claude Code's native 200K.

## Trust and security

Calico replaces the native Claude Code executable, so installing it is a supply-chain decision rather than a normal Remora configuration change. Releases are built in GitHub Actions from Anthropic's native installer, use pinned patch dependencies, fail when a selected patch no longer matches the upstream bundle, and publish SHA-256 checksums plus GitHub provenance attestations.

The context adapter is dormant by default. It never contacts a server or reads credentials; it only accepts a child-process environment map. Exact model matching, bounded integer validation, malformed-input fallback, and Remora's binary capability check prevent a broad or silent context increase. Plain Claude Code launches without those variables retain stock context behavior.

Before installation, review the workflow and patch source, verify the release checksum and attestation, and keep a copy or reinstall path for the official Claude binary. Remora's approval-gated installer deliberately does not install Calico on the user's behalf.

#### Thinking note:

- If you want thinking to stream live in the UI without verbose mode, add this to your Claude settings:

```json
"showThinkingSummaries": true
```
- Settings can come from `~/.claude/settings.json`, `.claude/settings.json`, or `.claude/settings.local.json`.

## Quick Start

### Prerequisite

If you installed Claude Code via npm, remove it and install the native build first:

```bash
npm uninstall -g @anthropic-ai/claude-code
curl -fsSL https://claude.ai/install.sh | bash
claude --version
```

### Automatic Install

This installer detects your OS and CPU architecture and downloads the matching patched release for that version and platform.
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

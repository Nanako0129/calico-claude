#!/usr/bin/env node

const path = require("node:path") as typeof import("node:path");
const fs = require("node:fs") as typeof import("node:fs");

type NativeContentHandle = {
  content: string;
  write(patchedContent: string): Promise<void>;
};

type NativeContentModule = {
  readNativeContent(binaryPath: string): Promise<NativeContentHandle>;
};

const nativeContent = require("./native-content.ts") as NativeContentModule;

type VerifyOptions = {
  input: string;
  disable: string[];
};

// Each module's expected post-patch signature. `presence` markers must be found
// in the extracted bundle; `absence` markers assert the original (unpatched)
// construct is gone. These mirror the injection strings in patch-claude-display.ts;
// when upstream refactors the bundle, one or more of these will fail, which is the
// intended supply-chain gate.
type Check = {
  id: string;
  kind: "presence" | "absence" | "custom";
  // For presence/absence: a RegExp or a literal string to search for.
  marker?: RegExp | string;
  // For custom checks: return null on success, or a failure detail string.
  run?: (content: string) => string | null;
  describe: string;
};

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let index = content.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = content.indexOf(needle, index + needle.length);
  }
  return count;
}

function markerPresent(content: string, marker: RegExp | string): boolean {
  if (typeof marker === "string") {
    return content.includes(marker);
  }
  return marker.test(content);
}

const CHECKS: Check[] = [
  {
    id: "active-turn-prompt-id",
    kind: "custom",
    describe: "remora-scoped prompt identity header with per-agent frozen turn id",
    run: (content: string): string | null => {
      const requiredStrings = [
        '"calico-active-turn-adapter:v1"',
        '"x-calico-prompt-id"',
        '"x-calico-active-turn-version":"1"',
      ];
      const missing = requiredStrings.filter((marker) => !content.includes(marker));
      if (missing.length > 0) {
        return `missing marker(s): ${missing.join(", ")}`;
      }
      const frozenAgentContext =
        /process\.env\.REMORA_ACTIVE==="1"&&[A-Za-z_$][\w$]*\.__calicoPromptId===void 0&&\([A-Za-z_$][\w$]*\.__calicoPromptId=([A-Za-z_$][\w$]*)\.getStore\(\)\?\.__calicoPromptId\?\?[A-Za-z_$][\w$]*\(\)\),\1\.run\(/;
      if (!frozenAgentContext.test(content)) {
        return "missing nested-agent prompt inheritance at AsyncLocalStorage boundary";
      }
      const sourceGate =
        /__calicoQueryKind==="main"\|\|__calicoQueryKind==="subagent"/;
      if (!sourceGate.test(content)) {
        return "missing main/subagent query-source gate";
      }
      const protectedHeaderOrder =
        /"X-Claude-Code-Session-Id":[A-Za-z_$][\w$]*\(\),\.\.\.[A-Za-z_$][\w$]*,\.\.\.__calicoPromptId&&\{"x-calico-prompt-id":__calicoPromptId,"x-calico-active-turn-version":"1"\}/;
      return protectedHeaderOrder.test(content)
        ? null
        : "Calico-owned headers are missing or can be overridden by custom headers";
    },
  },
  {
    id: "background-agent-usage",
    kind: "custom",
    describe: "background agent tracker accounts terminal stream usage by response id",
    run: (content: string): string | null => {
      const required = [
        "function __calicoTrackAgentUsage",
        "function __calicoRefreshAgentUsage",
        "responseOutputTokens:new Map",
        't.event.type==="message_delta"',
        "__calicoTrackAgentUsage(e,t.event.usage,e.activeMessageId",
        "__calicoRefreshAgentUsage(re,g)",
        "__calicoRefreshAgentUsage(re,oe)",
      ];
      const missing = required.filter((marker) => !content.includes(marker));
      if (missing.length > 0) {
        return `missing marker(s): ${missing.join(", ")}`;
      }
      const oldAssistantOnlyTracker =
        'if(t.type!=="assistant")return;let o=t.message.usage;e.latestInputTokens=o.input_tokens+(o.cache_creation_input_tokens??0)+(o.cache_read_input_tokens??0),e.cumulativeOutputTokens+=o.output_tokens;';
      return content.includes(oldAssistantOnlyTracker)
        ? "original assistant-only usage tracker is still present"
        : null;
    },
  },
  {
    id: "statusline-committed-usage",
    kind: "custom",
    describe: "terminal-only usage snapshot preserved through shallow state copies",
    run: (content: string): string | null => {
      const terminalCommit =
        "Se!=null&&!__calicoUsageIsExactAllZero(ar.usage)&&__calicoUsageHasAccountingSignal(pn)&&(Ou.__calicoUsageState.committed=!0,Ou.__calicoUsageState.usage=pn);";
      const cloneSync =
        "for(let{src:_i,dst:Ii}of eo)Ii.message.usage=_i.message.usage,Ii.message.stop_reason=_i.message.stop_reason,Ii.message.stop_details=_i.message.stop_details,Ii.__calicoUsageState=_i.__calicoUsageState;";
      const required = [
        "__calicoUsageState:{committed:!1,usage:null}",
        "function __calicoUsageHasAccountingSignal",
        "function __calicoUsageIsExactAllZero",
        "return e.input_tokens===0&&e.output_tokens===0&&(e.cache_creation_input_tokens===void 0||e.cache_creation_input_tokens===0)&&(e.cache_read_input_tokens===void 0||e.cache_read_input_tokens===0)&&(e.cache_creation?.ephemeral_1h_input_tokens===void 0||e.cache_creation?.ephemeral_1h_input_tokens===0)&&(e.cache_creation?.ephemeral_5m_input_tokens===void 0||e.cache_creation?.ephemeral_5m_input_tokens===0)",
        "function __calicoStatuslineMessages",
        "r=t.__calicoUsageState",
        "r?.committed===!0&&r.usage",
        terminalCommit,
        "eo.push({src:an,dst:lo})",
        "eo.push({src:an,dst:Gi})",
        cloneSync,
        "S=aJt(__calicoStatuslineMessages(o)),b=sw(y,UE())",
      ];
      const missing = required.filter((marker) => !content.includes(marker));
      if (missing.length > 0) {
        return `missing marker(s): ${missing.join(", ")}`;
      }

      const expectedCounts: Array<[string, number]> = [
        ["__calicoUsageState:{committed:!1,usage:null}", 1],
        ["function __calicoUsageHasAccountingSignal", 1],
        ["function __calicoUsageIsExactAllZero", 1],
        ["return e.input_tokens===0&&e.output_tokens===0&&(e.cache_creation_input_tokens===void 0||e.cache_creation_input_tokens===0)&&(e.cache_read_input_tokens===void 0||e.cache_read_input_tokens===0)&&(e.cache_creation?.ephemeral_1h_input_tokens===void 0||e.cache_creation?.ephemeral_1h_input_tokens===0)&&(e.cache_creation?.ephemeral_5m_input_tokens===void 0||e.cache_creation?.ephemeral_5m_input_tokens===0)", 1],
        ["function __calicoStatuslineMessages", 1],
        ["r=t.__calicoUsageState", 1],
        ["__calicoUsageHasAccountingSignal(", 3],
        ["__calicoUsageIsExactAllZero(", 2],
        ["__calicoStatuslineMessages(", 2],
        [terminalCommit, 1],
        ["eo.push({src:an,dst:lo})", 1],
        ["eo.push({src:an,dst:Gi})", 1],
        [cloneSync, 1],
        ["S=aJt(__calicoStatuslineMessages(o)),b=sw(y,UE())", 1],
      ];
      for (const [marker, expected] of expectedCounts) {
        const actual = countOccurrences(content, marker);
        if (actual !== expected) {
          return `expected ${expected} occurrence(s) of ${marker}, found ${actual}`;
        }
      }

      if (content.includes("__calicoUsageCommitted")) {
        return "obsolete wrapper-level boolean marker is still present";
      }
      if (
        content.includes("eo.push({src:an.message,dst:lo.message})") ||
        content.includes("eo.push({src:an.message,dst:Gi.message})")
      ) {
        return "downstream clones still synchronize message fields without wrapper ownership";
      }

      const commitIndex = content.indexOf(terminalCommit);
      const rawAggregationIndex = content.lastIndexOf("pn=xAe(pn,ar.usage);", commitIndex);
      const terminalLoopIndex = content.lastIndexOf("for(let Ou of _r)", commitIndex);
      if (rawAggregationIndex === -1 || terminalLoopIndex === -1) {
        return "usage snapshot is not attached to the canonical terminal usage aggregation loop";
      }
      const terminalSegment = content.slice(rawAggregationIndex, commitIndex + terminalCommit.length);
      if (
        !terminalSegment.includes("Ou.message.usage=pn") ||
        !terminalSegment.includes("Ou.message.stop_reason=Se") ||
        !terminalSegment.includes("Ou.message.stop_details=ar.delta.stop_details??null") ||
        !terminalSegment.includes("!__calicoUsageIsExactAllZero(ar.usage)") ||
        terminalSegment.includes('case"message_stop"') ||
        terminalSegment.includes("onStreamingThinking")
      ) {
        return "usage snapshot escaped the canonical terminal message_delta mutation loop";
      }

      const cloneSyncIndex = content.indexOf(cloneSync);
      const cloneEventIndex = content.lastIndexOf(
        'if(an.type==="stream_event"&&an.event.type==="message_delta")',
        cloneSyncIndex
      );
      if (cloneEventIndex === -1 || cloneSyncIndex - cloneEventIndex > 300) {
        return "shared usage state is not synchronized from the downstream message_delta path";
      }

      if (/message_stop[\s\S]{0,1200}__calicoUsageState\.committed=/.test(content)) {
        return "usage snapshot is committed from a message_stop path";
      }
      if (/onStreamingThinking[\s\S]{0,1200}__calicoUsageState\.committed=/.test(content)) {
        return "usage snapshot is committed from a UI-only thinking reducer";
      }
      return null;
    },
  },
  {
    id: "custom-context-window",
    kind: "custom",
    describe: "validated opt-in context resolver and effective status-line window",
    run: (content: string): string | null => {
      const required = [
        "CALICO_MODEL_CONTEXT_WINDOWS",
        "CALICO_CONTEXT_DISPLAY_PERCENT",
        "__calico_context_window",
        "__calico_display_window",
        "CALICO_MODEL_CONTEXT_WINDOWS?o:o-r",
        "if(process.env.CALICO_MODEL_CONTEXT_WINDOWS)return",
      ];
      const missing = required.filter((marker) => !content.includes(marker));
      return missing.length > 0 ? `missing marker(s): ${missing.join(", ")}` : null;
    },
  },
  {
    id: "tool-call-verbose",
    kind: "presence",
    marker: /case"collapsed_read_search":(?:return|\{)[\s\S]{0,600}?verbose:!0/,
    describe: 'verbose:!0 forced within case"collapsed_read_search"',
  },
  {
    id: "create-diff-colors",
    kind: "presence",
    marker: "__cc_line",
    describe: "injected __cc_line diff mapper for created files",
  },
  {
    id: "word-diff-line-bg",
    kind: "presence",
    // The unpatched bundle already contains the `x==="add"?...:"diffAdded"` ternary
    // at another site, so match the injected `backgroundColor:VAR??(...)` fallback
    // specifically — that `??(` guard is what this patch adds.
    marker:
      /backgroundColor:[A-Za-z_$][\w$]*\?\?\([A-Za-z_$][\w$]*==="add"\?[A-Za-z_$][\w$]*\?"diffAddedDimmed":"diffAdded"/,
    describe: "injected word-diff backgroundColor fallback ternary",
  },
  {
    id: "thinking-inline",
    kind: "presence",
    marker: /case"thinking":[\s\S]{0,2000}?isTranscriptMode:!0/,
    describe: 'isTranscriptMode:!0 forced within case"thinking"',
  },
  {
    id: "redacted-thinking-inline",
    kind: "presence",
    marker: /param:\{type:"thinking",thinking:[A-Za-z_$][\w$]*\.data\?\?""\}/,
    describe: "redacted thinking rendered inline as thinking text",
  },
  {
    id: "thinking-streaming",
    kind: "presence",
    marker: "__cc_streamingThinking",
    describe: "injected __cc_streamingThinking live-streaming plumbing",
  },
  {
    id: "subagent-prompt",
    kind: "absence",
    // Original empty-state gate: `if(rows.length===0&&!(transcriptMode&&prompt))return`.
    // The patch drops the transcript-mode conjunct, leaving `!prompt`, so the
    // `!(X&&Y))return` grouping must be gone. Verified present in the unpatched
    // 2.1.206 bundle and absent after patching.
    marker: /\.length===0&&!\([A-Za-z_$][\w$]*&&[A-Za-z_$][\w$]*\)\)return/,
    describe: "original transcript-gated subagent Prompt empty-state must be gone",
  },
  {
    id: "disable-spinner-tips",
    kind: "absence",
    marker: "spinnerTipsEnabled===!1)return;",
    describe: "original spinner-tips disabled guard must be gone",
  },
  {
    id: "version-output",
    kind: "presence",
    // The literal marker; \n here is a backslash + n (two chars) inside the bundle's
    // template literal, not a newline.
    marker: "}.VERSION} (Claude Code)\\n(patched)",
    describe: "(patched) appended to --version output",
  },
  // NOTE: the "installer-label" module was retired from patch-claude-display.ts
  // because its target string ("switched from npm to native installer") no longer
  // exists in current Claude bundles. Its verify check is dropped in lockstep.
  {
    id: "welcome-badge",
    kind: "custom",
    describe: '"Calico Claude" branding present (>=3) and "Welcome to Claude Code" gone',
    run: (content: string): string | null => {
      const calicoCount = countOccurrences(content, '"Calico Claude"');
      const oldWelcome = content.includes('"Welcome to Claude Code"');
      const problems: string[] = [];
      if (calicoCount < 3) {
        problems.push(`expected >=3 occurrences of "Calico Claude", found ${calicoCount}`);
      }
      if (oldWelcome) {
        problems.push('found residual "Welcome to Claude Code"');
      }
      return problems.length > 0 ? problems.join("; ") : null;
    },
  },
];

function parsePatchIds(value: string): string[] {
  const ids = value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    throw new Error("Expected a comma-separated list for --disable");
  }

  return ids;
}

function parseArgs(argv: string[]): VerifyOptions {
  const opts: VerifyOptions = { input: "", disable: [] };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--input") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --input");
      }
      opts.input = value;
      i += 1;
      continue;
    }

    if (arg === "--disable") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --disable");
      }
      opts.disable.push(...parsePatchIds(value));
      i += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  if (!opts.input) {
    throw new Error("--input is required");
  }

  const validIds = new Set(CHECKS.map((check) => check.id));
  const invalid = opts.disable.filter((id) => !validIds.has(id));
  if (invalid.length > 0) {
    throw new Error(`Unknown --disable patch id(s): ${invalid.join(", ")}`);
  }

  return opts;
}

function printHelp(): void {
  console.log("Verify a patched native Claude binary contains all expected patches");
  console.log("");
  console.log("Usage:");
  console.log(
    "  node scripts/verify-patched-binary.ts --input <patched-binary> [--disable <ids>]"
  );
  console.log("");
  console.log("  --disable <ids>  Comma-separated patch ids that were intentionally");
  console.log("                   NOT applied. Their normal check is skipped; for");
  console.log("                   presence-type modules the marker is reverse-asserted");
  console.log("                   to be ABSENT, confirming the patch really is missing.");
}

function evaluateCheck(check: Check, content: string): string | null {
  if (check.kind === "custom") {
    return check.run ? check.run(content) : "no check implementation";
  }

  const marker = check.marker;
  if (marker === undefined) {
    return "no marker configured";
  }

  const present = markerPresent(content, marker);
  if (check.kind === "presence") {
    return present ? null : `expected marker not found (${check.describe})`;
  }
  // absence
  return present ? `unexpected marker still present (${check.describe})` : null;
}

async function main(): Promise<void> {
  let opts: VerifyOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    console.error("");
    printHelp();
    process.exit(1);
  }

  const inputPath = path.resolve(opts.input);
  if (!fs.existsSync(inputPath)) {
    console.error(`Error: input binary not found: ${inputPath}`);
    process.exit(1);
  }

  let content: string;
  try {
    const handle = await nativeContent.readNativeContent(inputPath);
    content = handle.content;
  } catch (error) {
    console.error(
      `Error: failed to extract bundle from ${inputPath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    process.exit(1);
  }

  console.log(`Verifying patched bundle extracted from: ${inputPath}`);

  const disableSet = new Set(opts.disable);

  const failures: { id: string; detail: string }[] = [];
  let verifiedCount = 0;
  let skippedCount = 0;
  for (const check of CHECKS) {
    if (disableSet.has(check.id)) {
      // This module was intentionally not applied. Skip its normal check, and
      // for presence-type modules reverse-assert the marker is ABSENT so the
      // disable is proven (the patch really isn't in the bundle), not merely
      // ignored.
      if (check.kind === "presence" && check.marker !== undefined) {
        if (markerPresent(content, check.marker)) {
          console.log(`  FAIL ${check.id}`);
          failures.push({
            id: check.id,
            detail: `disabled module marker unexpectedly present (${check.describe})`,
          });
        } else {
          console.log(`  skip ${check.id} (disabled; marker confirmed absent)`);
          skippedCount += 1;
        }
      } else {
        console.log(`  skip ${check.id} (disabled)`);
        skippedCount += 1;
      }
      continue;
    }

    const detail = evaluateCheck(check, content);
    if (detail === null) {
      console.log(`  ok   ${check.id}`);
      verifiedCount += 1;
    } else {
      console.log(`  FAIL ${check.id}`);
      failures.push({ id: check.id, detail });
    }
  }

  if (failures.length > 0) {
    console.error("");
    console.error(`Verification failed for ${failures.length} module(s):`);
    for (const failure of failures) {
      console.error(`  - ${failure.id}: ${failure.detail}`);
    }
    process.exit(1);
  }

  console.log("");
  if (skippedCount > 0) {
    console.log(
      `${verifiedCount} patch module(s) verified, ${skippedCount} disabled/skipped.`
    );
  } else {
    console.log(`All ${CHECKS.length} patch modules verified.`);
  }
}

void main();

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

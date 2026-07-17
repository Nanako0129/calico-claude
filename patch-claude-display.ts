const fs = require("fs");
const path = require("path");

const TARGET_FILE_ENCODING = "utf8";

function printHelp() {
  console.log("Claude display patcher");
  console.log("======================");
  console.log("");
  console.log("Usage:");
  console.log(
    "  node patch-claude-display.ts --file <path> [--dry-run] [--disable <ids>] [--enable <ids>] [--list-patches] [--assert-all]"
  );
  console.log("");
  console.log("Options:");
  console.log("  --file <path>   Target extracted Claude JS content");
  console.log("  --dry-run       Show what would change without writing");
  console.log("  --disable <ids> Comma-separated patch ids to disable");
  console.log("  --enable <ids>  Comma-separated patch ids to enable");
  console.log("  --list-patches  Print available patch ids and exit");
  console.log(
    "  --assert-all    Exit non-zero if any selected patch applied 0 changes"
  );
  console.log("  --help, -h      Show this help");
}

function parsePatchIds(value, flagName) {
  const ids = value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    throw new Error(`Expected a comma-separated list for ${flagName}`);
  }

  return ids;
}

function parseArgs(argv) {
  const opts = {
    file: null,
    dryRun: false,
    disable: [],
    enable: [],
    listPatches: false,
    assertAll: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--file") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --file");
      }
      opts.file = value;
      i += 1;
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--disable") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --disable");
      }
      opts.disable.push(...parsePatchIds(value, "--disable"));
      i += 1;
    } else if (arg === "--enable") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --enable");
      }
      opts.enable.push(...parsePatchIds(value, "--enable"));
      i += 1;
    } else if (arg === "--list-patches") {
      opts.listPatches = true;
    } else if (arg === "--assert-all") {
      opts.assertAll = true;
    } else if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return opts;
}

function ensureFileExists(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Target file not found: ${filePath}`);
  }
}

function resolveTargetPath(opts) {
  if (opts.file) {
    return path.resolve(opts.file);
  }

  const localContent = path.resolve("content.js");
  if (fs.existsSync(localContent)) {
    return localContent;
  }

  throw new Error("No target file found. Pass --file <path> or place content.js in the current folder.");
}

function patchCollapsedReadSearch(content, ctx = {}) {
  let candidates = 0;
  let patched = 0;
  let output = content;

  const pattern =
    /case"collapsed_read_search":return ([A-Za-z_$][\w$]*)\.createElement\(([A-Za-z_$][\w$]*),\{([^}]*)\}\)/g;

  output = output.replace(pattern, (full, ns, component, props) => {
    if (!props.includes("verbose:")) {
      return full;
    }

    candidates += 1;
    const replacement = ctx.preserveLength ? "verbose:1" : "verbose:!0";
    const nextProps = props.replace(/verbose:[^,}]+/, replacement);

    if (nextProps !== props) {
      patched += 1;
      return `case"collapsed_read_search":return ${ns}.createElement(${component},{${nextProps}})`;
    }

    return full;
  });

  const o7qCaseNeedle = 'case"collapsed_read_search":{';
  let index = 0;
  while (true) {
    const start = output.indexOf(o7qCaseNeedle, index);
    if (start === -1) {
      break;
    }

    const nextCase = output.indexOf('case"', start + o7qCaseNeedle.length);
    const nextDefault = output.indexOf("default:", start + o7qCaseNeedle.length);
    const endCandidates = [nextCase, nextDefault].filter((value) => value !== -1);
    const end = endCandidates.length > 0 ? Math.min(...endCandidates) : output.length;
    const segment = output.slice(start, end);

    const hasRendererCall =
      segment.includes("createElement(") || segment.includes("jsx(") || segment.includes("jsxs(");
    if (!hasRendererCall || !segment.includes("verbose:")) {
      index = start + o7qCaseNeedle.length;
      continue;
    }

    const callMatch = segment.match(
      /(?:createElement|jsx|jsxs)\([A-Za-z_$][\w$]*,\{message:[^}]*inProgressToolUseIDs:[^}]*shouldAnimate:[^}]*verbose:[^,}]+,tools:[^}]*lookups:[^}]*isActiveGroup:[^}]*\}\)/
    );
    if (!callMatch) {
      index = start + o7qCaseNeedle.length;
      continue;
    }

    candidates += 1;
    const replacement = ctx.preserveLength ? "verbose:1" : "verbose:!0";
    const nextSegment = segment.replace(/verbose:[^,}]+/, replacement);

    if (nextSegment !== segment) {
      patched += 1;
      output = output.slice(0, start) + nextSegment + output.slice(end);
      index = start + nextSegment.length;
      continue;
    }

    index = start + o7qCaseNeedle.length;
  }

  return {
    content: output,
    candidates,
    patched,
  };
}

function patchWriteCreateDiffColors(content) {
  const createNeedle = 'case"create":';
  const updateNeedle = 'case"update":';

  let index = 0;
  let candidates = 0;
  let patched = 0;
  let output = content;

  while (true) {
    const createStart = output.indexOf(createNeedle, index);
    if (createStart === -1) {
      break;
    }

    const updateStart = output.indexOf(updateNeedle, createStart + createNeedle.length);
    if (updateStart === -1) {
      index = createStart + createNeedle.length;
      continue;
    }

    const nextCase = output.indexOf('case"', updateStart + updateNeedle.length);
    const nextDefault = output.indexOf("default:", updateStart + updateNeedle.length);
    const endCandidates = [nextCase, nextDefault].filter((value) => value !== -1);
    const switchEnd = endCandidates.length > 0 ? Math.min(...endCandidates) : output.length;

    const createSegment = output.slice(createStart, updateStart);
    const updateSegment = output.slice(updateStart, switchEnd);

    if (createSegment.includes("structuredPatch:[{oldStart:1,oldLines:0,newStart:1")) {
      index = updateStart + updateNeedle.length;
      continue;
    }

    const createReturnMatch = createSegment.match(
      /return ([A-Za-z_$][\w$]*)\.(createElement|jsx|jsxs)\(([A-Za-z_$][\w$]*),\{filePath:([A-Za-z_$][\w$]*),content:([A-Za-z_$][\w$]*),verbose:([A-Za-z_$][\w$]*)\}\)/
    );
    if (!createReturnMatch) {
      index = updateStart + updateNeedle.length;
      continue;
    }

    const updateRendererMatch = updateSegment.match(
      /(?:createElement|jsx|jsxs)\(([A-Za-z_$][\w$]*),\{filePath:[^}]*structuredPatch:[^}]*style:([A-Za-z_$][\w$]*),verbose:[A-Za-z_$][\w$]*/
    );
    if (!updateRendererMatch) {
      index = updateStart + updateNeedle.length;
      continue;
    }

    candidates += 1;

    const reactNs = createReturnMatch[1];
    const jsxFactory = createReturnMatch[2];
    const fileVar = createReturnMatch[4];
    const contentVar = createReturnMatch[5];
    const verboseVar = createReturnMatch[6];
    const diffRenderer = updateRendererMatch[1];
    const styleVar = updateRendererMatch[2];

    const lineCounterMatch = createSegment.match(
      /let [A-Za-z_$][\w$]*=([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\);return [A-Za-z_$][\w$]*\.(?:createElement|jsxs)\([A-Za-z_$][\w$]*,(?:null,|\{children:\[)"Wrote "/
    );
    const lineCountExpr = lineCounterMatch
      ? `${lineCounterMatch[1]}(${contentVar})`
      : `${contentVar}===""?0:${contentVar}.split(\`\\n\`).length`;

    const before = createReturnMatch[0];
    const after = `return ${reactNs}.${jsxFactory}(${diffRenderer},{filePath:${fileVar},structuredPatch:[{oldStart:1,oldLines:0,newStart:1,newLines:${lineCountExpr},lines:${contentVar}===""?[]:${contentVar}.split(\`\\n\`).map((__cc_line)=>"+"+__cc_line)}],firstLine:${contentVar}.split(\`\\n\`)[0]??null,fileContent:"",style:${styleVar},verbose:${verboseVar},previewHint:void 0})`;

    if (!createSegment.includes(before)) {
      index = updateStart + updateNeedle.length;
      continue;
    }

    const nextCreateSegment = createSegment.replace(before, after);
    if (nextCreateSegment !== createSegment) {
      patched += 1;
      output = output.slice(0, createStart) + nextCreateSegment + output.slice(updateStart);
      index = createStart + nextCreateSegment.length;
      continue;
    }

    index = updateStart + updateNeedle.length;
  }

  return {
    content: output,
    candidates,
    patched,
  };
}

function patchWordDiffLineBackgrounds(content) {
  const anchor = '"diffAddedWord";else if(!';
  let output = content;
  let candidates = 0;
  let patched = 0;

  let index = 0;
  while (true) {
    const anchorIndex = output.indexOf(anchor, index);
    if (anchorIndex === -1) {
      break;
    }

    const fnStart = output.lastIndexOf("function ", anchorIndex);
    const fnEnd = output.indexOf("function ", anchorIndex + anchor.length);
    if (fnStart === -1 || fnEnd === -1) {
      index = anchorIndex + anchor.length;
      continue;
    }

    const segment = output.slice(fnStart, fnEnd);
    if (segment.includes("diffAddedDimmed") && segment.includes("backgroundColor:") && segment.includes("??(")) {
      index = anchorIndex + anchor.length;
      continue;
    }

    const signatureMatch = segment.match(/^function [A-Za-z_$][\w$]*\(([^)]*)\)\{/);
    const typeVarMatch = segment.match(/let\{type:([A-Za-z_$][\w$]*),/);
    if (!signatureMatch || !typeVarMatch) {
      index = anchorIndex + anchor.length;
      continue;
    }

    const params = signatureMatch[1].split(",").map((p) => p.trim());
    if (params.length < 4) {
      index = anchorIndex + anchor.length;
      continue;
    }

    const dimVar = params[3];
    const typeVar = typeVarMatch[1];

    const legacyChildBgPattern =
      /(key:`part-\$\{[A-Za-z_$][\w$]*\}-\$\{[A-Za-z_$][\w$]*\}`,backgroundColor:)([A-Za-z_$][\w$]*)(\},[A-Za-z_$][\w$]*\)\))/;
    const jsxChildBgPattern =
      /(backgroundColor:)([A-Za-z_$][\w$]*)(,children:[A-Za-z_$][\w$]*\},`part-\$\{[A-Za-z_$][\w$]*\}-\$\{[A-Za-z_$][\w$]*\}`\)\))/;

    if (!legacyChildBgPattern.test(segment) && !jsxChildBgPattern.test(segment)) {
      index = anchorIndex + anchor.length;
      continue;
    }

    candidates += 1;
    const backgroundFallback = (bgVar) =>
      `${bgVar}??(${typeVar}==="add"?${dimVar}?"diffAddedDimmed":"diffAdded":${dimVar}?"diffRemovedDimmed":"diffRemoved")`;
    let nextSegment = segment.replace(legacyChildBgPattern, (_full, prefix, bgVar, suffix) => {
      return `${prefix}${bgVar}??(${typeVar}==="add"?${dimVar}?"diffAddedDimmed":"diffAdded":${dimVar}?"diffRemovedDimmed":"diffRemoved")${suffix}`;
    });
    nextSegment = nextSegment.replace(jsxChildBgPattern, (_full, prefix, bgVar, suffix) => {
      return `${prefix}${backgroundFallback(bgVar)}${suffix}`;
    });

    if (nextSegment !== segment) {
      patched += 1;
      output = output.slice(0, fnStart) + nextSegment + output.slice(fnEnd);
      index = fnStart + nextSegment.length;
      continue;
    }

    index = anchorIndex + anchor.length;
  }

  return {
    content: output,
    candidates,
    patched,
  };
}

function patchThinkingCase(content, ctx = {}) {
  const caseNeedle = 'case"thinking":';
  let index = 0;
  let candidates = 0;
  let patched = 0;
  let output = content;

  while (true) {
    const start = output.indexOf(caseNeedle, index);
    if (start === -1) {
      break;
    }

    const nextCase = output.indexOf('case"', start + caseNeedle.length);
    const nextDefault = output.indexOf("default:", start + caseNeedle.length);
    const endCandidates = [nextCase, nextDefault].filter((value) => value !== -1);
    const end = endCandidates.length > 0 ? Math.min(...endCandidates) : output.length;
    const segment = output.slice(start, end);

    if (!segment.includes("isTranscriptMode:")) {
      index = start + caseNeedle.length;
      continue;
    }

    candidates += 1;

    let nextSegment = segment;
    nextSegment = nextSegment.replace(
      /if\(![A-Za-z_$][\w$]*(?:&&![A-Za-z_$][\w$]*){1,2}\)return null;/,
      (full) => {
        if (!ctx.preserveLength) {
          return "";
        }
        return `;${" ".repeat(Math.max(0, full.length - 1))}`;
      }
    );
    nextSegment = nextSegment.replace(
      /((?:createElement|jsx|jsxs)\([A-Za-z_$][\w$]*,\{)([^}]*)\}/g,
      (full, prefix, props) => {
        let nextProps = props;
        nextProps = nextProps.replace(/isTranscriptMode:[^,}]+/g, (entry) => {
          const desired = ctx.preserveLength ? "isTranscriptMode:1" : "isTranscriptMode:!0";
          if (!ctx.preserveLength || desired.length > entry.length) {
            return desired;
          }
          return `${desired}${" ".repeat(entry.length - desired.length)}`;
        });
        nextProps = nextProps.replace(/hideInTranscript:[^,}]+/g, (entry) => {
          const desired = ctx.preserveLength ? "hideInTranscript:0" : "hideInTranscript:!1";
          if (!ctx.preserveLength || desired.length > entry.length) {
            return desired;
          }
          return `${desired}${" ".repeat(entry.length - desired.length)}`;
        });
        if (nextProps === props) {
          return full;
        }
        return `${prefix}${nextProps}}`;
      }
    );

    if (nextSegment !== segment) {
      patched += 1;
      output = output.slice(0, start) + nextSegment + output.slice(end);
      index = start + nextSegment.length;
      continue;
    }

    index = start + caseNeedle.length;
  }

  return {
    content: output,
    candidates,
    patched,
  };
}

function patchRedactedThinkingSummaries(content) {
  const redactedNeedle = 'case"redacted_thinking":';
  const thinkingNeedle = 'case"thinking":';
  const maxRendererGap = 2000;

  let index = 0;
  let candidates = 0;
  let patched = 0;
  let output = content;

  while (true) {
    const redactedStart = output.indexOf(redactedNeedle, index);
    if (redactedStart === -1) {
      break;
    }

    const thinkingStart = output.indexOf(thinkingNeedle, redactedStart + redactedNeedle.length);
    if (thinkingStart === -1) {
      break;
    }

    const nextCase = output.indexOf('case"', thinkingStart + thinkingNeedle.length);
    const nextDefault = output.indexOf("default:", thinkingStart + thinkingNeedle.length);
    const endCandidates = [nextCase, nextDefault].filter((value) => value !== -1);
    const thinkingEnd = endCandidates.length > 0 ? Math.min(...endCandidates) : output.length;

    const redactedSegment = output.slice(redactedStart, thinkingStart);
    const thinkingSegment = output.slice(thinkingStart, thinkingEnd);

    const hasRedactedRendererCall =
      redactedSegment.includes("createElement(") ||
      redactedSegment.includes("jsx(") ||
      redactedSegment.includes("jsxs(");
    if (
      thinkingStart - redactedStart > maxRendererGap ||
      thinkingEnd - thinkingStart > maxRendererGap ||
      !hasRedactedRendererCall ||
      !thinkingSegment.includes("isTranscriptMode:")
    ) {
      index = redactedStart + redactedNeedle.length;
      continue;
    }

    const thinkingRendererMatch = thinkingSegment.match(
      /([A-Za-z_$][\w$]*)\.(createElement|jsx|jsxs)\(([A-Za-z_$][\w$]*),\{addMargin:([A-Za-z_$][\w$]*),param:([A-Za-z_$][\w$]*),isTranscriptMode:[^,}]+,verbose:[^,}]+(?:,hideInTranscript:[^}]+)?\}\)/
    );
    if (!thinkingRendererMatch) {
      index = redactedStart + redactedNeedle.length;
      continue;
    }

    const reactNs = thinkingRendererMatch[1];
    const jsxFactory = thinkingRendererMatch[2];
    const thinkingComponent = thinkingRendererMatch[3];
    const addMarginVar = thinkingRendererMatch[4];
    const paramVar = thinkingRendererMatch[5];
    const hideInTranscriptProp = thinkingRendererMatch[0].includes("hideInTranscript:")
      ? ",hideInTranscript:!1"
      : "";

    candidates += 1;

    const replacement =
      `case"redacted_thinking":{return ${reactNs}.${jsxFactory}(${thinkingComponent},{` +
      `addMargin:${addMarginVar},param:{type:"thinking",thinking:${paramVar}.data??""},` +
      `isTranscriptMode:!0,verbose:!0${hideInTranscriptProp}})}`;

    if (redactedSegment !== replacement) {
      output = output.slice(0, redactedStart) + replacement + output.slice(thinkingStart);
      patched += 1;
      index = redactedStart + replacement.length + thinkingNeedle.length;
      continue;
    }

    index = redactedStart + redactedNeedle.length;
  }

  return {
    content: output,
    candidates,
    patched,
  };
}

function patchThinkingStreaming(content) {
  let output = content;
  let candidates = 0;
  let patched = 0;

  let memoCandidates = 0;
  let memoPatched = 0;

  const streamingMemoPattern =
    /if\(([A-Za-z_$][\w$]*)\[(\d+)\]!==([A-Za-z_$][\w$]*)\|\|\1\[(\d+)\]!==([A-Za-z_$][\w$]*)\|\|\1\[(\d+)\]!==([A-Za-z_$][\w$]*)\)([\s\S]{0,700}?thinking:\5\.thinking[\s\S]{0,700}?)\1\[\2\]=\3,\1\[\4\]=\5,\1\[\6\]=\7,(\1\[\d+\]=[A-Za-z_$][\w$]*;)/g;

  output = output.replace(
    streamingMemoPattern,
    (full, cacheVar, i1, v1, i2, v2, i3, v3, middle, tail) => {
      memoCandidates += 1;
      if (full.includes(`${v2}?.thinking`)) {
        return full;
      }

      const replacement = `if(${cacheVar}[${i1}]!==${v1}||${cacheVar}[${i2}]!==${v2}?.thinking||${cacheVar}[${i3}]!==${v3})${middle}${cacheVar}[${i1}]=${v1},${cacheVar}[${i2}]=${v2}?.thinking,${cacheVar}[${i3}]=${v3},${tail}`;
      if (replacement !== full) {
        memoPatched += 1;
        return replacement;
      }
      return full;
    }
  );

  candidates += memoCandidates;
  patched += memoPatched;

  let propCandidates = 0;
  let propPatched = 0;
  const identifierPattern = "[A-Za-z_$][\\w$]*";
  const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let streamingVar =
    output.match(/hidePastThinking:!0,streamingThinking:([A-Za-z_$][\w$]*)/)?.[1] ?? null;

  if (streamingVar === null) {
    const onStreamingThinkingPattern = /onStreamingThinking:([A-Za-z_$][\w$]*)/g;
    let onStreamingThinkingMatch;
    while ((onStreamingThinkingMatch = onStreamingThinkingPattern.exec(output)) !== null) {
      const setStreamingThinkingVar = onStreamingThinkingMatch[1];
      const anchor = onStreamingThinkingMatch.index;
      const searchStart = Math.max(0, anchor - 50000);
      const searchSegment = output.slice(searchStart, anchor);
      const statePattern = new RegExp(
        `\\[(${identifierPattern}),${escapeRegExp(setStreamingThinkingVar)}\\]=${identifierPattern}\\.useState\\(null\\)`,
        "g"
      );
      let stateMatch;
      while ((stateMatch = statePattern.exec(searchSegment)) !== null) {
        streamingVar = stateMatch[1];
      }
      if (streamingVar !== null) {
        break;
      }
    }
  }

  if (streamingVar !== null) {
    const createElementCallPattern = /createElement\(([A-Za-z_$][\w$]*),\{([^{}]*?)\}\)/g;
    const promptRendererCallPattern =
      /createElement\(([A-Za-z_$][\w$]*),\{([\s\S]{0,2000}?placeholderElement:[\s\S]{0,2000}?agentDefinitions:[^}]*?onOpenRateLimitOptions:[^}]*?isLoading:)([^,}]+)(,streamingText:[^}]*?(?:showThinkingHint:[^}]*?)?isBriefOnly:[^}]*?)\}\)/g;
    const jsxMainRendererPropsPattern =
      /(screen:[^,}]+,streamingToolUses:[^,}]+,)(showAllInTranscript:[^,}]+,agentDefinitions:[^,}]+,onOpenRateLimitOptions:[^,}]+,isLoading:[^,}]+)/g;
    const jsxTranscriptRendererPropsPattern =
      /(screen:[^,}]+,agentDefinitions:[^,}]+,streamingToolUses:[^,}]+,)(showAllInTranscript:[^,}]+,onOpenRateLimitOptions:[^,}]+,isLoading:[^,}]+)/g;

    output = output.replace(createElementCallPattern, (full, component, props) => {
      if (!props.includes("streamingToolUses:")) {
        return full;
      }
      if (props.includes("streamingThinking:")) {
        return full;
      }
      if (!props.includes("toolJSX:")) {
        return full;
      }
      if (!props.includes("agentDefinitions:") || !props.includes("onOpenRateLimitOptions:")) {
        return full;
      }
      if (props.includes("hidePastThinking:")) {
        return full;
      }
      if (!props.includes("conversationId:") || !props.includes("isLoading:")) {
        return full;
      }

      propCandidates += 1;
      const replacement = `createElement(${component},{${props},streamingThinking:${streamingVar}})`;
      if (replacement !== full) {
        propPatched += 1;
        return replacement;
      }
      return full;
    });

    output = output.replace(
      promptRendererCallPattern,
      (full, component, beforeIsLoadingValue, isLoadingValue, afterIsLoadingValue) => {
        if (full.includes("streamingThinking:")) {
          return full;
        }

        propCandidates += 1;
        const replacement = `createElement(${component},{${beforeIsLoadingValue}${isLoadingValue},streamingThinking:${streamingVar}${afterIsLoadingValue}})`;
        if (replacement !== full) {
          propPatched += 1;
          return replacement;
        }
        return full;
      }
    );

    const injectStreamingThinking = (full, before, after) => {
      if (full.includes("streamingThinking:")) {
        return full;
      }

      propCandidates += 1;
      const replacement = `${before}streamingThinking:${streamingVar},${after}`;
      if (replacement !== full) {
        propPatched += 1;
        return replacement;
      }
      return full;
    };

    output = output.replace(jsxMainRendererPropsPattern, injectStreamingThinking);
    output = output.replace(jsxTranscriptRendererPropsPattern, injectStreamingThinking);
  }

  candidates += propCandidates;
  patched += propPatched;

  // Newer builds can enable thinking without actually requesting
  // summarized display text. In that case the UI only gets signature-only
  // thinking blocks and falls back to the placeholder hint row. Default the
  // request display mode to "summarized" when upstream leaves it unset.
  let displayCandidates = 0;
  let displayPatched = 0;
  const thinkingDisplayPattern =
    /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.type!=="disabled"&&!([A-Za-z_$][\w$]*)\(process\.env\.CLAUDE_CODE_DISABLE_THINKING\),([A-Za-z_$][\w$]*)=\1(?:&&[A-Za-z_$][\w$]*\(\)&&[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\))?\?\2\.display(?:\?\?void 0)?:void 0,([A-Za-z_$][\w$]*)=void 0;/g;
  output = output.replace(
    thinkingDisplayPattern,
    (full, enabledVar, thinkingConfigVar, envFlagHelper, displayVar, requestVar) => {
      displayCandidates += 1;
      if (full.includes('display??"summarized"')) {
        return full;
      }

      const replacement =
        `${enabledVar}=${thinkingConfigVar}.type!=="disabled"&&!${envFlagHelper}(process.env.CLAUDE_CODE_DISABLE_THINKING),` +
        `${displayVar}=${enabledVar}?${thinkingConfigVar}.display??"summarized":void 0,${requestVar}=void 0;`;
      if (replacement !== full) {
        displayPatched += 1;
        return replacement;
      }
      return full;
    }
  );
  candidates += displayCandidates;
  patched += displayPatched;

  let redactedSummaryCandidates = 0;
  let redactedSummaryPatched = 0;
  const assistantThinkingPattern =
    /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.message\.content\.find\(\(([A-Za-z_$][\w$]*)\)=>\3\.type==="thinking"\);if\(\1&&\1\.type==="thinking"\)([A-Za-z_$][\w$]*)\?\.\(\(\)=>\(\{thinking:\1\.thinking,isStreaming:!1,streamingEndedAt:Date\.now\(\)\}\)\)/g;
  output = output.replace(
    assistantThinkingPattern,
    (_full, blockVar, messageVar, itemVar, setStreamingVar) => {
      redactedSummaryCandidates += 1;
      redactedSummaryPatched += 1;
      return `let ${blockVar}=${messageVar}.message.content.find((${itemVar})=>${itemVar}.type==="thinking"||${itemVar}.type==="redacted_thinking");if(${blockVar}&&(${blockVar}.type==="thinking"||${blockVar}.type==="redacted_thinking"))${setStreamingVar}?.(()=>({thinking:${blockVar}.type==="thinking"?${blockVar}.thinking:${blockVar}.data??"",isStreaming:!1,streamingEndedAt:Date.now()}))`;
    }
  );
  candidates += redactedSummaryCandidates;
  patched += redactedSummaryPatched;

  // Disable memo wrapper around message-row renderer. Match by comparator body
  // shape (screen/columns/lastThinkingBlockId checks), not by minified symbol
  // names, so this survives variable renaming across releases.
  const memoAssignPattern = /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.memo\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)/g;
  let memoMatch;
  while ((memoMatch = memoAssignPattern.exec(output)) !== null) {
    const [full, lhs, _reactNs, renderFn, comparatorFn] = memoMatch;
    const comparatorStart = output.indexOf(`function ${comparatorFn}(`);
    if (comparatorStart === -1) {
      continue;
    }

    const comparatorSlice = output.slice(comparatorStart, comparatorStart + 2200);
    const looksLikeRowComparator =
      comparatorSlice.includes(".screen!==") &&
      comparatorSlice.includes(".columns!==") &&
      comparatorSlice.includes(".lastThinkingBlockId") &&
      comparatorSlice.includes(".streamingToolUseIDs");

    if (!looksLikeRowComparator) {
      continue;
    }

    candidates += 1;
    const replacement = `${lhs}=${renderFn}`;
    if (replacement !== full) {
      output = `${output.slice(0, memoMatch.index)}${replacement}${output.slice(
        memoMatch.index + full.length
      )}`;
      patched += 1;
      memoAssignPattern.lastIndex = memoMatch.index + replacement.length;
    }
  }

  // In some builds the streaming snippet remains visible for 30s after message
  // stop; force visibility to active-stream only.
  let lingerCandidates = 0;
  let lingerPatched = 0;
  const lingerPattern =
    /([A-Za-z_$][\w$]*):\{if\(!([A-Za-z_$][\w$]*)\)\{([A-Za-z_$][\w$]*)=!1;break \1\}if\(\2\.isStreaming\)\{\3=!0;break \1\}if\(\2\.streamingEndedAt\)\{\3=Date\.now\(\)-\2\.streamingEndedAt<30000;break \1\}\3=!1\}let ([A-Za-z_$][\w$]*)=\3/g;
  output = output.replace(lingerPattern, (_full, _label, streamVar, _tmpVar, visibleVar) => {
    lingerCandidates += 1;
    lingerPatched += 1;
    return `let ${visibleVar}=!!(${streamVar}&&${streamVar}.isStreaming)`;
  });
  const promptLingerPattern =
    /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.useMemo\(\(\)=>\{if\(!([A-Za-z_$][\w$]*)\)return!1;if\(\3\.isStreaming\)return!0;if\(\3\.streamingEndedAt\)return Date\.now\(\)-\3\.streamingEndedAt<30000;return!1\},\[\3\]\)/g;
  output = output.replace(promptLingerPattern, (_full, visibleVar, reactNs, streamVar) => {
    lingerCandidates += 1;
    lingerPatched += 1;
    return `${visibleVar}=${reactNs}.useMemo(()=>!!(${streamVar}&&${streamVar}.isStreaming),[${streamVar}])`;
  });
  candidates += lingerCandidates;
  patched += lingerPatched;

  const transcriptToolUseHelpersMatch = output.match(
    /let [A-Za-z_$][\w$]*=([A-Za-z_$][\w$]*)\(\{content:\[[A-Za-z_$][\w$]*\.contentBlock\]\}\);return [A-Za-z_$][\w$]*\.uuid=([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\.contentBlock\.id,0\),([A-Za-z_$][\w$]*)\(\[[A-Za-z_$][\w$]*\]\)/
  );
  let createVirtualMessageHelper = transcriptToolUseHelpersMatch?.[1] ?? null;
  let transcriptStreamingThinkingVar = null;
  const rendererStreamingThinkingMatch = output.match(
    /\(\{messages:[^}]*?streamingToolUses:[A-Za-z_$][\w$]*,streamingThinking:([A-Za-z_$][\w$]*),showAllInTranscript:/
  );
  if (rendererStreamingThinkingMatch) {
    transcriptStreamingThinkingVar = rendererStreamingThinkingMatch[1];
  } else if (streamingVar !== null) {
    const rendererSignaturePattern =
      /(\(\{messages:[^}]*?streamingToolUses:[A-Za-z_$][\w$]*,)(showAllInTranscript:)/;
    output = output.replace(rendererSignaturePattern, (full, beforeStreamingThinking, afterStreamingThinking) => {
      if (full.includes("streamingThinking:")) {
        return full;
      }
      candidates += 1;
      patched += 1;
      transcriptStreamingThinkingVar = "__cc_streamingThinking";
      return `${beforeStreamingThinking}streamingThinking:${transcriptStreamingThinkingVar},${afterStreamingThinking}`;
    });
  }

  const transcriptStreamingThinkingMatch = output.match(
    /streamingToolUses:[A-Za-z_$][\w$]*,[^}]*streamingThinking:([A-Za-z_$][\w$]*),streamingText:/
  );
  if (transcriptStreamingThinkingVar === null) {
    transcriptStreamingThinkingVar = transcriptStreamingThinkingMatch?.[1] ?? null;
  }
  if (transcriptStreamingThinkingVar) {
    let inlineThinkingCandidates = 0;
    let inlineThinkingPatched = 0;
    const inlineThinkingPattern =
      /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.useMemo\(\(\)=>([A-Za-z_$][\w$]*)\.flatMap\(\(([A-Za-z_$][\w$]*)\)=>\{let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\{content:\[\4\.contentBlock\]\}\);return \5\.uuid=([A-Za-z_$][\w$]*)\(\4\.contentBlock\.id,0\),([A-Za-z_$][\w$]*)\(\[\5\]\)\}\),\[\3\]\)/g;
    output = output.replace(
      inlineThinkingPattern,
      (
        _full,
        extrasVar,
        reactNs,
        streamingToolUsesVar,
        toolUseEntryVar,
        toolUseMessageVar,
        createMessageHelper,
        createUUIDHelper,
        normalizeMessagesHelper
      ) => {
        inlineThinkingCandidates += 1;
        inlineThinkingPatched += 1;
        createVirtualMessageHelper = createMessageHelper;
        return `${extrasVar}=${reactNs}.useMemo(()=>{let __cc_streamingToolUseExtras=${streamingToolUsesVar}.map((${toolUseEntryVar})=>{let ${toolUseMessageVar}=${createMessageHelper}({content:[${toolUseEntryVar}.contentBlock]});return ${toolUseMessageVar}.uuid=${createUUIDHelper}(${toolUseEntryVar}.contentBlock.id,0),{index:${toolUseEntryVar}.index??9007199254740991,messages:${normalizeMessagesHelper}([${toolUseMessageVar}])}}),__cc_streamingThinkingExtras=(${transcriptStreamingThinkingVar}?.messages??[]).map((__cc_entry,__cc_index)=>({index:__cc_entry.index??9007199254740991+__cc_index,messages:${normalizeMessagesHelper}([__cc_entry.message??__cc_entry])}));return[...__cc_streamingToolUseExtras,...__cc_streamingThinkingExtras].sort((__cc_a,__cc_b)=>__cc_a.index===__cc_b.index?0:__cc_a.index-__cc_b.index).flatMap((__cc_entry)=>__cc_entry.messages)},[${streamingToolUsesVar},${transcriptStreamingThinkingVar}])`;
      }
    );
    candidates += inlineThinkingCandidates;
    patched += inlineThinkingPatched;
  }

  // The dedicated live thinking row sits outside the message flow, so when the
  // inline transcript extras are active it becomes a duplicate copy pinned at
  // the bottom. Suppress that extra row and keep streamed thinking inline.
  let liveRowCandidates = 0;
  let liveRowPatched = 0;
  const liveThinkingRowPattern =
    /([A-Za-z_$][\w$]*)&{2}([A-Za-z_$][\w$]*)&{2}!([A-Za-z_$][\w$]*)&{2}([A-Za-z_$][\w$]*)\.createElement\(([A-Za-z_$][\w$]*),\{marginTop:1\},\4\.createElement\(([A-Za-z_$][\w$]*),\{param:\{type:"thinking",thinking:\2\.thinking\},addMargin:!1,isTranscriptMode:!0,verbose:([A-Za-z_$][\w$]*),hideInTranscript:!1\}\)\)/g;
  output = output.replace(liveThinkingRowPattern, (_full) => {
    liveRowCandidates += 1;
    liveRowPatched += 1;
    return "null";
  });
  candidates += liveRowCandidates;
  patched += liveRowPatched;

  // Instead, the renderer materializes virtual thinking messages from
  // `streamingThinking.messages` inline with the other live transcript extras,
  // and the reducer patch below keeps that state in sync as blocks stream.

  const replaceSegmentNeedle = (segment, before, after) => {
    if (!segment.includes(before)) {
      return {
        segment,
        changed: false,
      };
    }

    return {
      segment: segment.replace(before, after),
      changed: true,
    };
  };

  const buildStreamingThinkingStartExpression = (
    eventParam,
    setStreamingThinkingParam,
    createMessageHelper
  ) =>
    `${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>{let __cc_streamingThinkingMessage=${createMessageHelper}({content:[${eventParam}.event.content_block.type==="redacted_thinking"?{type:"redacted_thinking",data:${eventParam}.event.content_block.data??""}:{type:"thinking",thinking:""}],isVirtual:!0}),__cc_nextStreamingThinkingMessages=[...(__cc_prevStreamingThinking?.messages??[]).filter((__cc_entry)=>__cc_entry.index!==${eventParam}.event.index),{index:${eventParam}.event.index,message:__cc_streamingThinkingMessage}];return{thinking:${eventParam}.event.content_block.type==="redacted_thinking"?${eventParam}.event.content_block.data??"":"",isStreaming:!0,streamingEndedAt:void 0,currentIndex:${eventParam}.event.index,currentMessage:__cc_streamingThinkingMessage,messages:__cc_nextStreamingThinkingMessages}})`;

  const buildStreamingThinkingDeltaStatement = (
    eventParam,
    setStreamingThinkingParam,
    createMessageHelper
  ) =>
    `${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>{let __cc_nextStreamingThinkingDelta=typeof ${eventParam}.event.delta.thinking==="string"?${eventParam}.event.delta.thinking:"",__cc_nextStreamingThinkingText=(__cc_prevStreamingThinking?.thinking??"")+__cc_nextStreamingThinkingDelta,__cc_nextStreamingThinkingIndex=__cc_prevStreamingThinking?.currentIndex??${eventParam}.event.index,__cc_nextStreamingThinkingMessage=${createMessageHelper}({content:[{type:"thinking",thinking:__cc_nextStreamingThinkingText}],isVirtual:!0}),__cc_nextStreamingThinkingMessages=[...(__cc_prevStreamingThinking?.messages??[]).filter((__cc_entry)=>__cc_entry.index!==__cc_nextStreamingThinkingIndex),{index:__cc_nextStreamingThinkingIndex,message:__cc_nextStreamingThinkingMessage}];return __cc_prevStreamingThinking?{...__cc_prevStreamingThinking,thinking:__cc_nextStreamingThinkingText,isStreaming:!0,streamingEndedAt:void 0,currentIndex:__cc_nextStreamingThinkingIndex,currentMessage:__cc_nextStreamingThinkingMessage,messages:__cc_nextStreamingThinkingMessages}:{thinking:__cc_nextStreamingThinkingText,isStreaming:!0,streamingEndedAt:void 0,currentIndex:${eventParam}.event.index,currentMessage:__cc_nextStreamingThinkingMessage,messages:[{index:${eventParam}.event.index,message:__cc_nextStreamingThinkingMessage}]}});`;

  // 2.1.138 moved the UI stream reducer to a destructured options-bag shape.
  // Patch it by semantic option names instead of assuming positional params.
  if (createVirtualMessageHelper !== null) {
    const destructuredStreamHandlerPattern =
      /function [A-Za-z_$][\w$]*\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{let\{([^}]*onStreamingThinking:[A-Za-z_$][\w$]*[^}]*)\}=\2;/g;
    let destructuredMatch;
    while ((destructuredMatch = destructuredStreamHandlerPattern.exec(output)) !== null) {
      const eventParam = destructuredMatch[1];
      const optionsParam = destructuredMatch[2];
      const props = destructuredMatch[3];
      const propVar = (name) => {
        const match = props.match(new RegExp(`${name}:([A-Za-z_$][\\w$]*)`));
        return match?.[1] ?? null;
      };
      const setModeParam = propVar("onSetStreamMode");
      const setStreamingToolsParam = propVar("onStreamingToolUses");
      const setStreamingThinkingParam = propVar("onStreamingThinking");

      if (
        setModeParam === null ||
        setStreamingToolsParam === null ||
        setStreamingThinkingParam === null
      ) {
        continue;
      }

      const handlerStart = destructuredMatch.index;
      const handlerEnd = output.indexOf("function ", handlerStart + destructuredMatch[0].length);
      if (handlerEnd === -1) {
        continue;
      }

      const handlerSegment = output.slice(handlerStart, handlerEnd);
      if (
        !handlerSegment.includes(`type==="stream_request_start"`) ||
        !handlerSegment.includes(`case"thinking_delta"`) ||
        !handlerSegment.includes("content_block_start")
      ) {
        continue;
      }

      const requestStartBefore = `if(${eventParam}.type==="stream_request_start"){${setModeParam}("requesting");return}`;
      const requestStartAfter = `if(${eventParam}.type==="stream_request_start"){${setStreamingThinkingParam}?.(null),${setModeParam}("requesting");return}`;

      const messageStopBefore = `if(${eventParam}.event.type==="message_stop"){${setModeParam}("tool-use"),${setStreamingToolsParam}(()=>[]);return}`;
      const messageStopAfter = `if(${eventParam}.event.type==="message_stop"){${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:Date.now(),currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}("tool-use"),${setStreamingToolsParam}(()=>[]);return}`;
      const messageStopFinalizeBefore = `if(${eventParam}.event.type==="message_stop"){${optionsParam}.displayTransform?.finalize(),${setModeParam}("tool-use"),${setStreamingToolsParam}(()=>[]);return}`;
      const messageStopFinalizeAfter = `if(${eventParam}.event.type==="message_stop"){${optionsParam}.displayTransform?.finalize(),${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:Date.now(),currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}("tool-use"),${setStreamingToolsParam}(()=>[]);return}`;

      const thinkingStartBefore = `case"thinking":case"redacted_thinking":${setModeParam}("thinking");return;`;
      const thinkingStartAfter = `case"thinking":case"redacted_thinking":${buildStreamingThinkingStartExpression(
        eventParam,
        setStreamingThinkingParam,
        createVirtualMessageHelper
      )},${setModeParam}("thinking");return;`;

      const textStartBefore = `case"text":${setModeParam}("responding");return;`;
      const textStartAfter = `case"text":${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:void 0,currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}("responding");return;`;

      const messageDeltaIfBefore = `case"message_delta":if(${setModeParam}("responding"),${eventParam}.event.usage.output_tokens!=null)`;
      const messageDeltaIfAfter = `case"message_delta":if(${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:void 0,currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}("responding"),${eventParam}.event.usage.output_tokens!=null)`;
      const messageDeltaReturnBefore = `case"message_delta":${setModeParam}("responding");return;`;
      const messageDeltaReturnAfter = `case"message_delta":${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:void 0,currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}("responding");return;`;
      const messageDeltaBlockBefore = `case"message_delta":{${setModeParam}("responding");`;
      const messageDeltaBlockAfter = `case"message_delta":{${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:void 0,currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}("responding");`;

      const thinkingDeltaBefore = `case"thinking_delta":return;`;
      const thinkingDeltaBody = buildStreamingThinkingDeltaStatement(
        eventParam,
        setStreamingThinkingParam,
        createVirtualMessageHelper
      );
      const thinkingDeltaAfter = `case"thinking_delta":{${thinkingDeltaBody}return;}`;
      const thinkingDeltaProgressPattern = new RegExp(
        `case"thinking_delta":\\{let\\{delta:([A-Za-z_$][\\w$]*)\\}=${eventParam}\\.event;if\\("estimated_tokens"in \\1&&typeof \\1\\.estimated_tokens==="number"\\)([A-Za-z_$][\\w$]*)\\?\\.\\(\\{type:"thinking_progress",estimatedTokensDelta:\\1\\.estimated_tokens\\}\\);return\\}`
      );
      const thinkingDeltaProgressWithTextPattern = new RegExp(
        `case"thinking_delta":\\{let\\{delta:([A-Za-z_$][\\w$]*)\\}=${eventParam}\\.event;if\\("estimated_tokens"in \\1&&typeof \\1\\.estimated_tokens==="number"\\)([A-Za-z_$][\\w$]*)\\?\\.\\(\\{type:"thinking_progress",estimatedTokensDelta:\\1\\.estimated_tokens\\}\\);else if\\("thinking"in \\1&&typeof \\1\\.thinking==="string"&&\\1\\.thinking\\.length>0\\)\\2\\?\\.\\(\\{type:"thinking_progress",estimatedTokensDelta:([A-Za-z_$][\\w$]*)\\(\\1\\.thinking\\)\\}\\);return\\}`
      );

      const replacements = [
        [requestStartBefore, requestStartAfter],
        [messageStopFinalizeBefore, messageStopFinalizeAfter],
        [messageStopBefore, messageStopAfter],
        [thinkingStartBefore, thinkingStartAfter],
        [textStartBefore, textStartAfter],
        [messageDeltaIfBefore, messageDeltaIfAfter],
        [messageDeltaReturnBefore, messageDeltaReturnAfter],
        [messageDeltaBlockBefore, messageDeltaBlockAfter],
        [thinkingDeltaBefore, thinkingDeltaAfter],
      ];

      let nextHandlerSegment = handlerSegment;
      for (const [before, after] of replacements) {
        const result = replaceSegmentNeedle(nextHandlerSegment, before, after);
        if (!result.changed) {
          continue;
        }
        candidates += 1;
        nextHandlerSegment = result.segment;
        if (nextHandlerSegment.includes(after)) {
          patched += 1;
        }
      }

      const nextThinkingDeltaProgressSegment = nextHandlerSegment.replace(
        thinkingDeltaProgressPattern,
        (_full, deltaVar, metricsVar) => {
          return `case"thinking_delta":{${thinkingDeltaBody}let{delta:${deltaVar}}=${eventParam}.event;if("estimated_tokens"in ${deltaVar}&&typeof ${deltaVar}.estimated_tokens==="number")${metricsVar}?.({type:"thinking_progress",estimatedTokensDelta:${deltaVar}.estimated_tokens});return}`;
        }
      );
      if (nextThinkingDeltaProgressSegment !== nextHandlerSegment) {
        candidates += 1;
        patched += 1;
        nextHandlerSegment = nextThinkingDeltaProgressSegment;
      }
      const nextThinkingDeltaProgressWithTextSegment = nextHandlerSegment.replace(
        thinkingDeltaProgressWithTextPattern,
        (_full, deltaVar, metricsVar, estimateHelper) => {
          return `case"thinking_delta":{${thinkingDeltaBody}let{delta:${deltaVar}}=${eventParam}.event;if("estimated_tokens"in ${deltaVar}&&typeof ${deltaVar}.estimated_tokens==="number")${metricsVar}?.({type:"thinking_progress",estimatedTokensDelta:${deltaVar}.estimated_tokens});else if("thinking"in ${deltaVar}&&typeof ${deltaVar}.thinking==="string"&&${deltaVar}.thinking.length>0)${metricsVar}?.({type:"thinking_progress",estimatedTokensDelta:${estimateHelper}(${deltaVar}.thinking)});return}`;
        }
      );
      if (nextThinkingDeltaProgressWithTextSegment !== nextHandlerSegment) {
        candidates += 1;
        patched += 1;
        nextHandlerSegment = nextThinkingDeltaProgressWithTextSegment;
      }

      if (nextHandlerSegment !== handlerSegment) {
        output = output.slice(0, handlerStart) + nextHandlerSegment + output.slice(handlerEnd);
        destructuredStreamHandlerPattern.lastIndex = handlerStart + nextHandlerSegment.length;
      }
    }
  }

  // 2.1.183 keeps onStreamingThinking on the outer dispatcher but moves the
  // stream-event switch into an inner handler that omits it from destructuring.
  // Re-introduce the option there, then patch the same semantic stream cases.
  if (createVirtualMessageHelper !== null) {
    const missingStreamingThinkingHandlerPattern =
      /function [A-Za-z_$][\w$]*\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)(?:,[A-Za-z_$][\w$]*)?\)\{let\{([^}]*)\}=\2;/g;
    let missingStreamingThinkingMatch;
    while ((missingStreamingThinkingMatch = missingStreamingThinkingHandlerPattern.exec(output)) !== null) {
      const eventParam = missingStreamingThinkingMatch[1];
      const optionsParam = missingStreamingThinkingMatch[2];
      const props = missingStreamingThinkingMatch[3];
      if (props.includes("onStreamingThinking:")) {
        continue;
      }

      const propVar = (name) => {
        const aliasMatch = props.match(new RegExp(`${name}:(${identifierPattern})`));
        if (aliasMatch) {
          return aliasMatch[1];
        }
        const shorthandMatch = props.match(new RegExp(`(?:^|,)${name}(?:,|$)`));
        return shorthandMatch ? name : null;
      };
      const setModeParam = propVar("onSetStreamMode");
      const setStreamingToolsParam = propVar("onStreamingToolUses");
      const displayTransformParam = propVar("displayTransform");
      const setStreamingThinkingParam = "__cc_onStreamingThinking";

      if (setModeParam === null || setStreamingToolsParam === null) {
        continue;
      }

      const handlerStart = missingStreamingThinkingMatch.index;
      const handlerEnd = output.indexOf("function ", handlerStart + missingStreamingThinkingMatch[0].length);
      if (handlerEnd === -1) {
        continue;
      }

      const handlerSegment = output.slice(handlerStart, handlerEnd);
      if (
        !handlerSegment.includes(`type==="stream_request_start"`) ||
        !handlerSegment.includes(`case"thinking_delta"`) ||
        !handlerSegment.includes("content_block_start")
      ) {
        continue;
      }

      const thinkingDeltaBody = buildStreamingThinkingDeltaStatement(
        eventParam,
        setStreamingThinkingParam,
        createVirtualMessageHelper
      );

      const replacements = [
        [
          `let{${props}}=${optionsParam};`,
          `let{${props},onStreamingThinking:${setStreamingThinkingParam}}=${optionsParam};`,
        ],
        [
          `if(${eventParam}.type==="stream_request_start"){${setModeParam}("requesting");return}`,
          `if(${eventParam}.type==="stream_request_start"){${setStreamingThinkingParam}?.(null),${setModeParam}?.("requesting");return}`,
        ],
        [
          `if(${eventParam}.type==="stream_request_start"){${setModeParam}?.("requesting");return}`,
          `if(${eventParam}.type==="stream_request_start"){${setStreamingThinkingParam}?.(null),${setModeParam}?.("requesting");return}`,
        ],
        [
          `if(${eventParam}.event.type==="message_stop"){${setModeParam}("tool-use"),${setStreamingToolsParam}(()=>[]);return}`,
          `if(${eventParam}.event.type==="message_stop"){${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:Date.now(),currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}?.("tool-use"),${setStreamingToolsParam}?.(()=>[]);return}`,
        ],
        [
          `if(${eventParam}.event.type==="message_stop"){${setModeParam}?.("tool-use"),${setStreamingToolsParam}?.(()=>[]);return}`,
          `if(${eventParam}.event.type==="message_stop"){${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:Date.now(),currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}?.("tool-use"),${setStreamingToolsParam}?.(()=>[]);return}`,
        ],
        [
          `case"thinking":case"redacted_thinking":${setModeParam}("thinking");return;`,
          `case"thinking":case"redacted_thinking":${buildStreamingThinkingStartExpression(
            eventParam,
            setStreamingThinkingParam,
            createVirtualMessageHelper
          )},${setModeParam}?.("thinking");return;`,
        ],
        [
          `case"thinking":case"redacted_thinking":${setModeParam}?.("thinking");return;`,
          `case"thinking":case"redacted_thinking":${buildStreamingThinkingStartExpression(
            eventParam,
            setStreamingThinkingParam,
            createVirtualMessageHelper
          )},${setModeParam}?.("thinking");return;`,
        ],
        [
          `case"text":${setModeParam}("responding");return;`,
          `case"text":${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:void 0,currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}?.("responding");return;`,
        ],
        [
          `case"text":${setModeParam}?.("responding");return;`,
          `case"text":${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:void 0,currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}?.("responding");return;`,
        ],
        [
          `case"message_delta":${setModeParam}("responding");return;`,
          `case"message_delta":${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:void 0,currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}?.("responding");return;`,
        ],
        [
          `case"message_delta":${setModeParam}?.("responding");return;`,
          `case"message_delta":${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:void 0,currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}?.("responding");return;`,
        ],
        [
          `case"message_delta":{${setModeParam}("responding");`,
          `case"message_delta":{${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:void 0,currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}?.("responding");`,
        ],
        [
          `case"message_delta":{${setModeParam}?.("responding");`,
          `case"message_delta":{${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:void 0,currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}?.("responding");`,
        ],
        [
          `case"thinking_delta":return;`,
          `case"thinking_delta":{${thinkingDeltaBody}return;}`,
        ],
      ];

      if (displayTransformParam !== null) {
        replacements.push(
          [
            `if(${eventParam}.event.type==="message_stop"){${displayTransformParam}.finalize(),${setModeParam}("tool-use"),${setStreamingToolsParam}(()=>[]);return}`,
            `if(${eventParam}.event.type==="message_stop"){${displayTransformParam}?.finalize(),${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:Date.now(),currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}?.("tool-use"),${setStreamingToolsParam}?.(()=>[]);return}`,
          ],
          [
            `if(${eventParam}.event.type==="message_stop"){${displayTransformParam}?.finalize(),${setModeParam}?.("tool-use"),${setStreamingToolsParam}?.(()=>[]);return}`,
            `if(${eventParam}.event.type==="message_stop"){${displayTransformParam}?.finalize(),${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:Date.now(),currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}?.("tool-use"),${setStreamingToolsParam}?.(()=>[]);return}`,
          ]
        );
      }

      let nextHandlerSegment = handlerSegment;
      for (const [before, after] of replacements) {
        const result = replaceSegmentNeedle(nextHandlerSegment, before, after);
        if (!result.changed) {
          continue;
        }
        candidates += 1;
        nextHandlerSegment = result.segment;
        if (nextHandlerSegment.includes(after)) {
          patched += 1;
        }
      }

      const thinkingDeltaProgressPattern = new RegExp(
        `case"thinking_delta":\\{let\\{delta:(${identifierPattern})\\}=${eventParam}\\.event;if\\("estimated_tokens"in \\1&&typeof \\1\\.estimated_tokens==="number"\\)(${identifierPattern})\\?\\.\\(\\{type:"thinking_progress",estimatedTokensDelta:\\1\\.estimated_tokens\\}\\);return\\}`
      );
      const thinkingDeltaProgressWithTextPattern = new RegExp(
        `case"thinking_delta":\\{let\\{delta:(${identifierPattern})\\}=${eventParam}\\.event;if\\("estimated_tokens"in \\1&&typeof \\1\\.estimated_tokens==="number"\\)(${identifierPattern})\\?\\.\\(\\{type:"thinking_progress",estimatedTokensDelta:\\1\\.estimated_tokens\\}\\);else if\\("thinking"in \\1&&typeof \\1\\.thinking==="string"&&\\1\\.thinking\\.length>0\\)\\2\\?\\.\\(\\{type:"thinking_progress",estimatedTokensDelta:(${identifierPattern})\\(\\1\\.thinking\\)\\}\\);return\\}`
      );

      const nextThinkingDeltaProgressSegment = nextHandlerSegment.replace(
        thinkingDeltaProgressPattern,
        (_full, deltaVar, metricsVar) => {
          return `case"thinking_delta":{${thinkingDeltaBody}let{delta:${deltaVar}}=${eventParam}.event;if("estimated_tokens"in ${deltaVar}&&typeof ${deltaVar}.estimated_tokens==="number")${metricsVar}?.({type:"thinking_progress",estimatedTokensDelta:${deltaVar}.estimated_tokens});return}`;
        }
      );
      if (nextThinkingDeltaProgressSegment !== nextHandlerSegment) {
        candidates += 1;
        patched += 1;
        nextHandlerSegment = nextThinkingDeltaProgressSegment;
      }
      const nextThinkingDeltaProgressWithTextSegment = nextHandlerSegment.replace(
        thinkingDeltaProgressWithTextPattern,
        (_full, deltaVar, metricsVar, estimateHelper) => {
          return `case"thinking_delta":{${thinkingDeltaBody}let{delta:${deltaVar}}=${eventParam}.event;if("estimated_tokens"in ${deltaVar}&&typeof ${deltaVar}.estimated_tokens==="number")${metricsVar}?.({type:"thinking_progress",estimatedTokensDelta:${deltaVar}.estimated_tokens});else if("thinking"in ${deltaVar}&&typeof ${deltaVar}.thinking==="string"&&${deltaVar}.thinking.length>0)${metricsVar}?.({type:"thinking_progress",estimatedTokensDelta:${estimateHelper}(${deltaVar}.thinking)});return}`;
        }
      );
      if (nextThinkingDeltaProgressWithTextSegment !== nextHandlerSegment) {
        candidates += 1;
        patched += 1;
        nextHandlerSegment = nextThinkingDeltaProgressWithTextSegment;
      }

      if (nextHandlerSegment !== handlerSegment) {
        output = output.slice(0, handlerStart) + nextHandlerSegment + output.slice(handlerEnd);
        missingStreamingThinkingHandlerPattern.lastIndex = handlerStart + nextHandlerSegment.length;
      }
    }
  }

  // Ensure streaming thinking state is reset and updated from thinking deltas.
  // Without this, some builds keep stale previous-turn thinking and only show
  // final thinking text after completion.
  const streamEventAnchor = 'type!=="stream_event"&&';
  const streamRequestAnchor = 'type==="stream_request_start"';
  const thinkingDeltaAnchor = 'case"thinking_delta"';
  const anchorIndex = output.indexOf(streamEventAnchor);
  if (
    anchorIndex !== -1 &&
    output.indexOf(streamRequestAnchor, anchorIndex) !== -1 &&
    output.indexOf(thinkingDeltaAnchor, anchorIndex) !== -1
  ) {
    const wg6Start = output.lastIndexOf("function ", anchorIndex);
    const wg6End = output.indexOf("function ", anchorIndex + streamEventAnchor.length);
    if (wg6Start !== -1 && wg6End !== -1) {
      const wg6Segment = output.slice(wg6Start, wg6End);
      const signatureMatch = wg6Segment.match(/^function [A-Za-z_$][\w$]*\(([^)]*)\)\{/);

      if (signatureMatch) {
        const params = signatureMatch[1].split(",").map((param) => param.trim());
        if (params.length >= 7) {
          const eventParam = params[0];
          const appendOutputParam = params[2];
          const setModeParam = params[3];
          const setStreamingToolsParam = params[4];
          const setStreamingThinkingParam = params[6];

          const requestStartBefore = `if(${eventParam}.type==="stream_request_start"){${setModeParam}("requesting");return}`;
          const requestStartAfter = `if(${eventParam}.type==="stream_request_start"){${setStreamingThinkingParam}?.(null),${setModeParam}("requesting");return}`;

          const messageStopBefore = `if(${eventParam}.event.type==="message_stop"){${setModeParam}("tool-use"),${setStreamingToolsParam}(()=>[]);return}`;
          const messageStopAfter = `if(${eventParam}.event.type==="message_stop"){${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:Date.now(),currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}("tool-use"),${setStreamingToolsParam}(()=>[]);return}`;

          const thinkingStartBefore = `case"thinking":case"redacted_thinking":${setModeParam}("thinking");return;`;
          const thinkingStartAfter =
            createVirtualMessageHelper === null
              ? null
              : `case"thinking":case"redacted_thinking":${buildStreamingThinkingStartExpression(
                  eventParam,
                  setStreamingThinkingParam,
                  createVirtualMessageHelper
                )},${setModeParam}("thinking");return;`;

          const textStartBefore = `case"text":${setModeParam}("responding");return;`;
          const textStartAfter = `case"text":${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:void 0,currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}("responding");return;`;

          const messageDeltaBefore = `case"message_delta":${setModeParam}("responding");return;`;
          const messageDeltaAfter = `case"message_delta":${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:void 0,currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}("responding");return;`;
          const messageDeltaBlockBefore = `case"message_delta":{${setModeParam}("responding");`;
          const messageDeltaBlockAfter = `case"message_delta":{${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:void 0,currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}("responding");`;

          const thinkingDeltaBefore = `case"thinking_delta":${appendOutputParam}(${eventParam}.event.delta.thinking);return;`;
          const thinkingDeltaBareBefore = `case"thinking_delta":return;`;
          const thinkingDeltaBody =
            createVirtualMessageHelper === null
              ? null
              : buildStreamingThinkingDeltaStatement(
                  eventParam,
                  setStreamingThinkingParam,
                  createVirtualMessageHelper
                );
          const thinkingDeltaAfter =
            thinkingDeltaBody === null
              ? null
              : `case"thinking_delta":{${appendOutputParam}(${eventParam}.event.delta.thinking);${thinkingDeltaBody}return;}`;
          const thinkingDeltaBareAfter =
            thinkingDeltaBody === null ? null : `case"thinking_delta":{${thinkingDeltaBody}return;}`;
          const thinkingDeltaProgressPattern =
            thinkingDeltaBody === null
              ? null
              : new RegExp(
                  `case"thinking_delta":\\{let\\{delta:([A-Za-z_$][\\w$]*)\\}=${eventParam}\\.event;if\\("estimated_tokens"in \\1&&typeof \\1\\.estimated_tokens==="number"\\)([A-Za-z_$][\\w$]*)\\?\\.\\(\\{type:"thinking_progress",estimatedTokensDelta:\\1\\.estimated_tokens\\}\\);return\\}`
                );
          const thinkingDeltaProgressWithTextPattern =
            thinkingDeltaBody === null
              ? null
              : new RegExp(
                  `case"thinking_delta":\\{let\\{delta:([A-Za-z_$][\\w$]*)\\}=${eventParam}\\.event;if\\("estimated_tokens"in \\1&&typeof \\1\\.estimated_tokens==="number"\\)([A-Za-z_$][\\w$]*)\\?\\.\\(\\{type:"thinking_progress",estimatedTokensDelta:\\1\\.estimated_tokens\\}\\);else if\\("thinking"in \\1&&typeof \\1\\.thinking==="string"&&\\1\\.thinking\\.length>0\\)\\2\\?\\.\\(\\{type:"thinking_progress",estimatedTokensDelta:([A-Za-z_$][\\w$]*)\\(\\1\\.thinking\\)\\}\\);return\\}`
                );

          const wg6Replacements = [
            [requestStartBefore, requestStartAfter],
            [messageStopBefore, messageStopAfter],
            [textStartBefore, textStartAfter],
            [messageDeltaBefore, messageDeltaAfter],
          ];
          if (thinkingStartAfter !== null) {
            wg6Replacements.splice(2, 0, [thinkingStartBefore, thinkingStartAfter]);
          }
          if (thinkingDeltaAfter !== null) {
            wg6Replacements.push([thinkingDeltaBefore, thinkingDeltaAfter]);
          }
          if (thinkingDeltaBareAfter !== null) {
            wg6Replacements.push([thinkingDeltaBareBefore, thinkingDeltaBareAfter]);
          }
          wg6Replacements.push([messageDeltaBlockBefore, messageDeltaBlockAfter]);

          let nextWg6Segment = wg6Segment;
          for (const [before, after] of wg6Replacements) {
            if (nextWg6Segment.includes(before)) {
              candidates += 1;
              nextWg6Segment = nextWg6Segment.replace(before, after);
              if (nextWg6Segment.includes(after)) {
                patched += 1;
              }
            }
          }

          if (thinkingDeltaProgressPattern !== null) {
            const nextThinkingDeltaProgressSegment = nextWg6Segment.replace(
              thinkingDeltaProgressPattern,
              (_full, deltaVar, metricsVar) => {
                return `case"thinking_delta":{${thinkingDeltaBody}let{delta:${deltaVar}}=${eventParam}.event;if("estimated_tokens"in ${deltaVar}&&typeof ${deltaVar}.estimated_tokens==="number")${metricsVar}?.({type:"thinking_progress",estimatedTokensDelta:${deltaVar}.estimated_tokens});return}`;
              }
            );
            if (nextThinkingDeltaProgressSegment !== nextWg6Segment) {
              candidates += 1;
              patched += 1;
              nextWg6Segment = nextThinkingDeltaProgressSegment;
            }
          }
          if (thinkingDeltaProgressWithTextPattern !== null) {
            const nextThinkingDeltaProgressWithTextSegment = nextWg6Segment.replace(
              thinkingDeltaProgressWithTextPattern,
              (_full, deltaVar, metricsVar, estimateHelper) => {
                return `case"thinking_delta":{${thinkingDeltaBody}let{delta:${deltaVar}}=${eventParam}.event;if("estimated_tokens"in ${deltaVar}&&typeof ${deltaVar}.estimated_tokens==="number")${metricsVar}?.({type:"thinking_progress",estimatedTokensDelta:${deltaVar}.estimated_tokens});else if("thinking"in ${deltaVar}&&typeof ${deltaVar}.thinking==="string"&&${deltaVar}.thinking.length>0)${metricsVar}?.({type:"thinking_progress",estimatedTokensDelta:${estimateHelper}(${deltaVar}.thinking)});return}`;
              }
            );
            if (nextThinkingDeltaProgressWithTextSegment !== nextWg6Segment) {
              candidates += 1;
              patched += 1;
              nextWg6Segment = nextThinkingDeltaProgressWithTextSegment;
            }
          }

          if (nextWg6Segment !== wg6Segment) {
            output = output.slice(0, wg6Start) + nextWg6Segment + output.slice(wg6End);
          }
        }
      }
    }
  }

  return {
    content: output,
    candidates,
    patched,
  };
}

function patchSubagentPromptVisibility(content, ctx = {}) {
  const backgroundedAnchor = '"Backgrounded agent"';
  const livePromptMountPattern =
    /([A-Za-z_$][\w$]*)&&([A-Za-z_$][\w$]*)&&([A-Za-z_$][\w$]*)\.createElement\(m,\{marginBottom:1\},\3\.createElement\(([A-Za-z_$][\w$]*),\{prompt:\2\}\)\)/g;
  const livePromptEmptyStatePattern =
    /if\(([A-Za-z_$][\w$]*)\.length===0&&!?\(([A-Za-z_$][\w$]*)&&([A-Za-z_$][\w$]*)\)\)return/g;
  let output = content;
  let candidates = 0;
  let patched = 0;

  let index = 0;
  while (true) {
    const anchorIndex = output.indexOf(backgroundedAnchor, index);
    if (anchorIndex === -1) {
      break;
    }

    const fnStart = output.lastIndexOf("function ", anchorIndex);
    const fnEndCandidate = output.indexOf("function ", anchorIndex + backgroundedAnchor.length);
    const fnEnd = fnEndCandidate === -1 ? output.length : fnEndCandidate;

    if (fnStart === -1 || fnEnd <= fnStart) {
      index = anchorIndex + backgroundedAnchor.length;
      continue;
    }

    const segment = output.slice(fnStart, fnEnd);

    const isRelevantRenderer =
      segment.includes('action:"app:toggleTranscript"') &&
      segment.includes('fallback:"ctrl+o"') &&
      segment.includes("isTranscriptMode:") &&
      segment.includes("{prompt:") &&
      segment.includes(",theme:");

    if (!isRelevantRenderer) {
      index = anchorIndex + backgroundedAnchor.length;
      continue;
    }

    const transcriptModeMatch = segment.match(/isTranscriptMode:([A-Za-z_$][\w$]*)=!1/);
    if (!transcriptModeMatch) {
      index = anchorIndex + backgroundedAnchor.length;
      continue;
    }

    const transcriptModeVar = transcriptModeMatch[1];
    const gatePattern = new RegExp(`${transcriptModeVar}&&([A-Za-z_$][\\w$]*)&&`, "g");

    let localCandidates = 0;
    let localPatched = 0;

    const nextSegment = segment.replace(gatePattern, (full, promptVar, offset, source) => {
      const nearby = source.slice(offset, offset + 260);
      if (!nearby.includes(`{prompt:${promptVar},theme:`)) {
        return full;
      }

      localCandidates += 1;
      localPatched += 1;
      if (!ctx.preserveLength) {
        return `${promptVar}&&`;
      }
      const replacement = `${promptVar}&&${promptVar}&&`;
      if (replacement.length > full.length) {
        return full;
      }
      return `${replacement}${" ".repeat(full.length - replacement.length)}`;
    });

    candidates += localCandidates;

    if (nextSegment !== segment) {
      patched += localPatched;
      output = output.slice(0, fnStart) + nextSegment + output.slice(fnEnd);
      index = fnStart + nextSegment.length;
      continue;
    }

    index = anchorIndex + backgroundedAnchor.length;
  }

  output = output.replace(livePromptMountPattern, (full, transcriptModeVar, promptVar, reactNs, promptComponent) => {
    candidates += 1;

    const replacement = `${promptVar}&&${reactNs}.createElement(m,{marginBottom:1},${reactNs}.createElement(${promptComponent},{prompt:${promptVar}}))`;
    if (!ctx.preserveLength) {
      if (full === replacement) {
        return full;
      }
      patched += 1;
      return replacement;
    }

    if (replacement.length > full.length) {
      return full;
    }

    patched += 1;
    return `${replacement}${" ".repeat(full.length - replacement.length)}`;
  });

  output = output.replace(livePromptEmptyStatePattern, (full, rowsVar, transcriptModeVar, promptVar) => {
    candidates += 1;

    const replacement = `if(${rowsVar}.length===0&&!${promptVar})return`;
    if (!ctx.preserveLength) {
      if (full === replacement) {
        return full;
      }
      patched += 1;
      return replacement;
    }

    if (replacement.length > full.length) {
      return full;
    }

    patched += 1;
    return `${replacement}${" ".repeat(full.length - replacement.length)}`;
  });

  return {
    content: output,
    candidates,
    patched,
  };
}

function patchDisableSpinnerTips(content, ctx = {}) {
  const disabledGuardPattern = /if\([A-Za-z_$][\w$]*\(\)\.spinnerTipsEnabled===!1\)return;/g;
  const enabledExpressionPattern = /[A-Za-z_$][\w$]*\.spinnerTipsEnabled!==!1/g;
  const forcedReturn = "if(!0)return;";
  const forcedDisabled = "!1";

  let candidates = 0;
  let patched = 0;
  let output = content.replace(disabledGuardPattern, (full) => {
    candidates += 1;

    if (!ctx.preserveLength) {
      if (full === forcedReturn) {
        return full;
      }
      patched += 1;
      return forcedReturn;
    }

    if (forcedReturn.length > full.length) {
      return full;
    }

    patched += 1;
    return `${forcedReturn}${" ".repeat(full.length - forcedReturn.length)}`;
  });

  output = output.replace(enabledExpressionPattern, (full) => {
    candidates += 1;

    if (!ctx.preserveLength) {
      if (full === forcedDisabled) {
        return full;
      }
      patched += 1;
      return forcedDisabled;
    }

    if (forcedDisabled.length > full.length) {
      return full;
    }

    patched += 1;
    return `${forcedDisabled}${" ".repeat(full.length - forcedDisabled.length)}`;
  });

  return {
    content: output,
    candidates,
    patched,
  };
}

function patchInstallerMigrationMessage(content, ctx = {}) {
  const needle = "switched from npm to native installer";
  let output = content;
  let candidates = 0;
  let patched = 0;
  let idx = output.indexOf(needle);

  while (idx !== -1) {
    candidates += 1;

    let start = idx;
    while (start >= 0 && output[start] !== '"' && output[start] !== "'" && output[start] !== "`") {
      start -= 1;
    }
    if (start < 0) {
      idx = output.indexOf(needle, idx + needle.length);
      continue;
    }

    const quote = output[start];
    let end = start + 1;
    while (end < output.length) {
      if (output[end] === quote && output[end - 1] !== "\\") {
        break;
      }
      end += 1;
    }
    if (end >= output.length) {
      idx = output.indexOf(needle, idx + needle.length);
      continue;
    }

    const currentPayload = output.slice(start + 1, end);
    const desiredPayload = ctx.preserveLength
      ? "(patched)".padEnd(currentPayload.length, " ")
      : "(patched)";
    if (currentPayload !== desiredPayload) {
      output = `${output.slice(0, start + 1)}${desiredPayload}${output.slice(end)}`;
      patched += 1;
      idx = output.indexOf(needle, start + 11);
      continue;
    }

    idx = output.indexOf(needle, idx + needle.length);
  }

  return {
    content: output,
    candidates,
    patched,
  };
}

function patchVersionOutput(content) {
  const needle = "}.VERSION} (Claude Code)";
  const marker = "\\n(patched)";
  let candidates = 0;
  let patched = 0;
  let output = content;

  let index = output.indexOf(needle);
  while (index !== -1) {
    candidates += 1;

    const markerStart = index + needle.length;
    if (output.slice(markerStart, markerStart + marker.length) === marker) {
      index = output.indexOf(needle, markerStart + marker.length);
      continue;
    }

    output =
      output.slice(0, markerStart) +
      marker +
      output.slice(markerStart);
    patched += 1;
    index = output.indexOf(needle, markerStart + marker.length);
  }

  return {
    content: output,
    candidates,
    patched,
  };
}

function patchWelcomePatchedBadge(content) {
  let candidates = 0;
  let patched = 0;
  let output = content;

  output = output.replace(
    /([A-Za-z_$][\w$]*)\.createElement\(([A-Za-z_$][\w$]*),\{bold:!0\},"Claude Code"\)/g,
    (full, reactVar, textComponent) => {
      candidates += 1;
      const replacement = `${reactVar}.createElement(${textComponent},{bold:!0},"Calico Claude")`;
      if (replacement !== full) {
        patched += 1;
        return replacement;
      }
      return full;
    }
  );

  output = output.replace(
    /([A-Za-z_$][\w$]*)\.(jsx|jsxs)\(([A-Za-z_$][\w$]*),\{bold:!0,children:"Claude Code"\}\)/g,
    (full, reactVar, jsxFactory, textComponent) => {
      candidates += 1;
      const replacement = `${reactVar}.${jsxFactory}(${textComponent},{bold:!0,children:"Calico Claude"})`;
      if (replacement !== full) {
        patched += 1;
        return replacement;
      }
      return full;
    }
  );

  output = output.replace(
    /title:(`Claude Code v\$\{[\s\S]*?\.VERSION\}`),color:"professionalBlue",defaultTab:"general"/g,
    (full, titleExpr) => {
      candidates += 1;
      const replacement = `title:${titleExpr}.replace("Claude Code","Calico Claude"),color:"professionalBlue",defaultTab:"general"`;
      if (replacement !== full) {
        patched += 1;
        return replacement;
      }
      return full;
    }
  );

  output = output.replace(
    /"Welcome to Claude Code for "/g,
    (full) => {
      candidates += 1;
      const replacement = `"Welcome to Calico Claude for "`;
      if (replacement !== full) {
        patched += 1;
        return replacement;
      }
      return full;
    }
  );

  output = output.replace(
    /"Welcome to Claude Code"/g,
    (full) => {
      candidates += 1;
      const replacement = `"Welcome to Calico Claude"`;
      if (replacement !== full) {
        patched += 1;
        return replacement;
      }
      return full;
    }
  );

  output = output.replace(
    /(color:"claude",bold:!0,children:\[)"Claude Code"(," "\])/g,
    (full, prefix, suffix) => {
      candidates += 1;
      const replacement = `${prefix}"Calico Claude"${suffix}`;
      if (replacement !== full) {
        patched += 1;
        return replacement;
      }
      return full;
    }
  );

  output = output.replace(
    /([A-Za-z_$][\w$]*)\("claude",([A-Za-z_$][\w$]*)\)\("Claude Code"\)/g,
    (full, colorFn, themeVar) => {
      candidates += 1;
      const replacement = `${colorFn}("claude",${themeVar})("Calico Claude")`;
      if (replacement !== full) {
        patched += 1;
        return replacement;
      }
      return full;
    }
  );

  output = output.replace(
    /([A-Za-z_$][\w$]*)\("claude",([A-Za-z_$][\w$]*)\)\(" Claude Code "\)/g,
    (full, colorFn, themeVar) => {
      candidates += 1;
      const replacement = `${colorFn}("claude",${themeVar})(" Calico Claude ")`;
      if (replacement !== full) {
        patched += 1;
        return replacement;
      }
      return full;
    }
  );

  return {
    content: output,
    candidates,
    patched,
  };
}

function patchCustomContextWindows(content) {
  let candidates = 0;
  let patched = 0;
  let output = content;

  // Claude Code normally assigns unknown custom model ids a 200K context
  // window. Calico keeps that default unless a launcher supplies an exact,
  // validated model-to-window map. Exact matching is intentional: a typo must
  // fail closed to Claude's stock behavior instead of widening another model.
  const resolverPattern =
    /(function [A-Za-z_$][\w$]*\(e,t\)\{)(if\([A-Za-z_$][\w$]*\(e\)\)return 1e6;if\(t\?\.includes\()/g;

  output = output.replace(resolverPattern, (full, functionStart, originalBody) => {
    candidates += 1;
    const helpers =
      'function __calico_context_window(e){try{let t=process.env.CALICO_MODEL_CONTEXT_WINDOWS;if(!t)return null;let r=JSON.parse(t);if(!r||typeof r!=="object"||Array.isArray(r)||!Object.hasOwn(r,e))return null;let n=r[e];if(!Number.isInteger(n)||n<100000||n>1000000)return null;return n}catch{return null}}' +
      'function __calico_display_window(e){let t=Number(process.env.CALICO_CONTEXT_DISPLAY_PERCENT??100);if(!Number.isFinite(t)||t<1||t>100)return e;return Math.floor(e*t/100)}';
    const replacement =
      `${helpers}${functionStart}let __calico_window=__calico_context_window(e);` +
      `if(__calico_window!==null)return __calico_window;${originalBody}`;
    patched += 1;
    return replacement;
  });

  // Claude's stock pipeline subtracts an output reserve and may precompute at
  // a separate buffer fraction. In opt-in Calico mode, use the raw mapped
  // window and the explicit percentage as the single compact boundary.
  const effectiveWindowPattern =
    /(function [A-Za-z_$][\w$]*\(e,t\)\{let r=Math\.min\([A-Za-z_$][\w$]*\(e\),[A-Za-z_$][\w$]*\),n=[A-Za-z_$][\w$]*\(\)\?t:void 0,\{window:o\}=[A-Za-z_$][\w$]*\(e,n\);return )(o-r)(\})/g;
  output = output.replace(
    effectiveWindowPattern,
    (full, prefix, originalReturn, suffix) => {
      candidates += 1;
      patched += 1;
      return `${prefix}process.env.CALICO_MODEL_CONTEXT_WINDOWS?o:${originalReturn}${suffix}`;
    }
  );

  const precomputePattern =
    /(function [A-Za-z_$][\w$]*\(e,t\)\{)(return Math\.min\(e-Math\.round\(e\*t\.precomputeBufferFraction\),([A-Za-z_$][\w$]*)\(e,t\)\)\})/g;
  output = output.replace(
    precomputePattern,
    (full, functionStart, originalBody, percentFn) => {
      candidates += 1;
      patched += 1;
      return `${functionStart}if(process.env.CALICO_MODEL_CONTEXT_WINDOWS)return ${percentFn}(e,t);${originalBody}`;
    }
  );

  // Status-line consumers (including TokenBar) receive an effective display
  // window while the internal model/compact logic continues to use the raw
  // provider window. This mirrors Codex's raw-vs-usable distinction.
  const statuslinePattern =
    /context_window:([A-Za-z_$][\w$]*)\(([^,{}]+),([A-Za-z_$][\w$]*)\),exceeds_200k_tokens:/g;
  output = output.replace(
    statuslinePattern,
    (full, contextFn, usage, windowValue) => {
      candidates += 1;
      patched += 1;
      return `context_window:${contextFn}(${usage},__calico_display_window(${windowValue})),exceeds_200k_tokens:`;
    }
  );

  return { content: output, candidates, patched };
}

function patchBackgroundAgentUsage(content) {
  const original = content;
  const identifierPattern = "[A-Za-z_$][\\w$]*";
  const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const trackerPattern = new RegExp(
    `function (${identifierPattern})\\(\\)\\{return\\{toolUseCount:0,latestInputTokens:0,cumulativeOutputTokens:0,recentActivities:\\[\\]\\}\\}`,
    "g"
  );
  const totalPattern = new RegExp(
    `function (${identifierPattern})\\((${identifierPattern})\\)\\{return \\2\\.latestInputTokens\\+\\2\\.cumulativeOutputTokens\\}`,
    "g"
  );
  const accountingPattern = new RegExp(
    `if\\((${identifierPattern})\\.type!=="assistant"\\)return;let (${identifierPattern})=\\1\\.message\\.usage;(${identifierPattern})\\.latestInputTokens=\\2\\.input_tokens\\+\\(\\2\\.cache_creation_input_tokens\\?\\?0\\)\\+\\(\\2\\.cache_read_input_tokens\\?\\?0\\),\\3\\.cumulativeOutputTokens\\+=\\2\\.output_tokens;`,
    "g"
  );
  const trackerMatches = [...content.matchAll(trackerPattern)];
  const totalMatches = [...content.matchAll(totalPattern)];
  const accountingMatches = [...content.matchAll(accountingPattern)];
  const trackerName = trackerMatches[0]?.[1];
  const totalName = totalMatches[0]?.[1];
  const accountingMatch = accountingMatches[0];
  const eventVar = accountingMatch?.[1];
  const usageVar = accountingMatch?.[2];
  const trackerVar = accountingMatch?.[3];
  const eventIndex = accountingMatch?.index ?? -1;
  const eventFunctionStart = eventIndex === -1 ? -1 : content.lastIndexOf("function ", eventIndex);
  const eventHeaderMatch =
    eventFunctionStart === -1
      ? null
      : content
          .slice(eventFunctionStart, eventIndex)
          .match(new RegExp(`^function (${identifierPattern})\\((${identifierPattern}),(${identifierPattern}),(${identifierPattern}),(${identifierPattern})\\)\\{`));
  const eventName = eventHeaderMatch?.[1];
  const headerTracker = eventHeaderMatch?.[2];
  const headerEvent = eventHeaderMatch?.[3];
  const summaryPattern = totalName
    ? new RegExp(
        `function (${identifierPattern})\\((${identifierPattern})\\)\\{return\\{toolUseCount:\\2\\.toolUseCount,tokenCount:${escapeRegExp(totalName)}\\(\\2\\),lastActivity:\\2\\.recentActivities\\.at\\(-1\\),recentActivities:\\[\\.\\.\\.\\2\\.recentActivities\\]\\}\\}`,
        "g"
      )
    : null;
  const summaryMatches = summaryPattern ? [...content.matchAll(summaryPattern)] : [];
  const summaryName = summaryMatches[0]?.[1];
  const progressPattern =
    eventName && summaryName
      ? new RegExp(
          `${escapeRegExp(eventName)}\\((${identifierPattern}),(${identifierPattern}),(${identifierPattern}),(${identifierPattern})\\.options\\.tools\\),(${identifierPattern})\\((${identifierPattern}),${escapeRegExp(summaryName)}\\(\\1\\),(${identifierPattern})\\);`,
          "g"
        )
      : null;
  const legacyCompletionPattern = new RegExp(
    `let (${identifierPattern})=(${identifierPattern})\\((${identifierPattern}),(${identifierPattern}),(${identifierPattern})\\),(${identifierPattern})=(${identifierPattern})\\(\\1,\\4,(${identifierPattern}),\\{suppressTelemetry:(${identifierPattern})\\}\\);`,
    "g"
  );
  const modelsUsedCompletionPattern = new RegExp(
    `let (${identifierPattern})=(${identifierPattern})\\((${identifierPattern}),(${identifierPattern}),(${identifierPattern})\\),(${identifierPattern})=(${identifierPattern})\\(\\1,\\4,\\{\\.\\.\\.(${identifierPattern}),modelsUsed:(${identifierPattern})\\},\\{suppressTelemetry:(${identifierPattern})\\}\\);`,
    "g"
  );
  const progressMatches = progressPattern ? [...content.matchAll(progressPattern)] : [];
  const completionMatches = [
    ...[...content.matchAll(legacyCompletionPattern)].map((match) => ({
      match,
      result: match[1],
      status: match[3],
      owner: match[4],
      transcript: match[5],
    })),
    ...[...content.matchAll(modelsUsedCompletionPattern)].map((match) => ({
      match,
      result: match[1],
      status: match[3],
      owner: match[4],
      transcript: match[5],
    })),
  ];
  const progressMatch = progressMatches[0];
  const completionMatch = completionMatches[0];
  const progressOwner = progressMatch?.[6];
  const progressStatus = progressMatch?.[7];
  const progressIndex = progressMatch?.index ?? -1;
  const progressFunctionStart =
    progressIndex === -1 ? -1 : content.lastIndexOf("function ", progressIndex);
  const progressEnd =
    progressIndex === -1 || !progressMatch ? -1 : progressIndex + progressMatch[0].length;
  const completionResult = completionMatch?.result;
  const completionStatus = completionMatch?.status;
  const completionOwner = completionMatch?.owner;
  const completionTranscript = completionMatch?.transcript;
  const completionIndex = completionMatch?.match.index ?? -1;
  const completionFunctionStart =
    completionIndex === -1 ? -1 : content.lastIndexOf("function ", completionIndex);
  const progressToCompletionSegment =
    progressEnd === -1 || completionIndex === -1
      ? ""
      : content.slice(progressEnd, completionIndex);
  const completionRemainsDirect =
    progressEnd !== -1 &&
    completionIndex >= progressEnd &&
    !progressToCompletionSegment.includes("=>") &&
    !progressToCompletionSegment.includes("function ");
  const trackerCount = trackerMatches.length;
  const eventCount = accountingMatches.length;
  const progressCount = progressMatches.length;
  const completionCount = completionMatches.length;
  const candidates = trackerCount + eventCount + progressCount + completionCount;

  if (
    trackerCount !== 1 ||
    totalMatches.length !== 1 ||
    eventCount !== 1 ||
    !eventName ||
    !accountingMatch ||
    headerTracker !== trackerVar ||
    headerEvent !== eventVar ||
    summaryMatches.length !== 1 ||
    progressCount !== 1 ||
    completionCount !== 1 ||
    progressOwner !== completionOwner ||
    progressStatus !== completionStatus ||
    progressFunctionStart === -1 ||
    completionFunctionStart === -1 ||
    progressFunctionStart !== completionFunctionStart ||
    !completionRemainsDirect
  ) {
    return { content: original, candidates, patched: 0 };
  }

  // Background-agent progress is sampled while stream frames are still
  // arriving. Native Claude responses usually expose input usage at
  // message_start, but OpenAI-compatible gateways can leave that provisional
  // wrapper at 0/0 and deliver the authoritative accounting in message_delta.
  // Track both paths by response id and apply cumulative output deltas once.
  const trackerReplacement =
    'function __calicoTrackAgentUsage(e,t,r,n){if(!t||typeof t!=="object")return;let o=["input_tokens","cache_creation_input_tokens","cache_read_input_tokens"].some((s)=>typeof t[s]==="number"),i=(t.input_tokens??0)+(t.cache_creation_input_tokens??0)+(t.cache_read_input_tokens??0);if(o&&(n||i>0))e.latestInputTokens=i;let s=typeof t.output_tokens==="number"&&Number.isFinite(t.output_tokens)?Math.max(0,t.output_tokens):0;if(r==null){if(s>0)e.cumulativeOutputTokens+=s;return}let a=e.responseOutputTokens.get(r)??0;if(s>a)e.cumulativeOutputTokens+=s-a;if(s>a||!e.responseOutputTokens.has(r))e.responseOutputTokens.set(r,Math.max(a,s))}' +
    'function __calicoRefreshAgentUsage(e,t){if(!Array.isArray(t))return;let r=!1;for(let n=t.length-1;n>=0;n--){let o=t[n];if(o?.type==="assistant")r=!0,__calicoTrackAgentUsage(e,o.message?.usage,o.message?.id,o.message?.stop_reason!=null);else if(o?.type==="user"&&r)break}}' +
    `function ${trackerName}(){return{toolUseCount:0,latestInputTokens:0,cumulativeOutputTokens:0,recentActivities:[],activeMessageId:null,responseOutputTokens:new Map}}`;
  const eventReplacement =
    `if(${eventVar}.type==="stream_event"){if(${eventVar}.event.type==="message_start")${trackerVar}.activeMessageId=${eventVar}.event.message.id,__calicoTrackAgentUsage(${trackerVar},${eventVar}.event.message.usage,${trackerVar}.activeMessageId,!1);else if(${eventVar}.event.type==="message_delta")__calicoTrackAgentUsage(${trackerVar},${eventVar}.event.usage,${trackerVar}.activeMessageId,${eventVar}.event.delta.stop_reason!=null);else if(${eventVar}.event.type==="message_stop")${trackerVar}.activeMessageId=null;return}if(${eventVar}.type!=="assistant")return;let ${usageVar}=${eventVar}.message.usage;__calicoTrackAgentUsage(${trackerVar},${usageVar},${eventVar}.message.id,${eventVar}.message.stop_reason!=null);`;
  const progressReplacement = `${eventName}(${progressMatch[1]},${progressMatch[2]},${progressMatch[3]},${progressMatch[4]}.options.tools),__calicoRefreshAgentUsage(${progressMatch[1]},${completionTranscript}),${progressMatch[5]}(${progressOwner},${summaryName}(${progressMatch[1]}),${progressStatus});`;
  const completionRefresh = `__calicoRefreshAgentUsage(${progressMatch[1]},${completionResult}),${progressMatch[5]}(${progressOwner},${summaryName}(${progressMatch[1]}),${progressStatus});`;

  let output = original.replace(trackerPattern, trackerReplacement);
  output = output.replace(accountingPattern, eventReplacement);
  output = output.replace(progressPattern, progressReplacement);
  output = output.replace(
    completionMatch.match[0],
    completionMatch.match[0] + completionRefresh
  );

  if (
    output.split("function __calicoTrackAgentUsage").length - 1 !== 1 ||
    output.split("function __calicoRefreshAgentUsage").length - 1 !== 1 ||
    output.split("responseOutputTokens:new Map").length - 1 !== 1 ||
    output.split(eventReplacement).length - 1 !== 1 ||
    output.split(progressReplacement).length - 1 !== 1 ||
    output.split(completionRefresh).length - 1 !== 1
  ) {
    return { content: original, candidates, patched: 0 };
  }

  return { content: output, candidates, patched: 4 };
}

function patchStatuslineCommittedUsage(content) {
  const original = content;
  const identifierPattern = "[A-Za-z_$][\\w$]*";
  const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const reducerPattern = new RegExp(
    `function (${identifierPattern})\\((${identifierPattern})\\)\\{for\\(let (${identifierPattern})=\\2\\.length-1;\\3>=0;\\3--\\)\\{let (${identifierPattern})=\\2\\[\\3\\],(${identifierPattern})=\\4\\?(${identifierPattern})\\(\\4\\):void 0;if\\(\\5\\)return\\{input_tokens:\\5\\.input_tokens,output_tokens:\\5\\.output_tokens,cache_creation_input_tokens:\\5\\.cache_creation_input_tokens\\?\\?0,cache_read_input_tokens:\\5\\.cache_read_input_tokens\\?\\?0\\}\\}return null\\}`,
    "g"
  );
  const wrapperPattern = new RegExp(
    `let (${identifierPattern})=\\{message:\\{\\.\\.\\.(${identifierPattern}),content:(${identifierPattern})\\(\\[(${identifierPattern})\\],(${identifierPattern}),(${identifierPattern})\\.agentId,\\{requestId:(${identifierPattern})\\?\\?void 0,messageId:\\2\\.id\\}\\)\\},requestId:\\7\\?\\?void 0,\\.\\.\\.(${identifierPattern})\\(\\6\\.querySource,\\6\\.spawnedBySkill,\\6\\.activeSkill,\\6\\.activeMcpServer,\\6\\.activeMcpTool\\),type:"assistant",uuid:(${identifierPattern})\\.randomUUID\\(\\),timestamp:new Date\\(\\)\\.toISOString\\(\\),\\.\\.\\.!1,\\.\\.\\.(${identifierPattern})&&\\{advisorModel:\\10\\}\\};`,
    "g"
  );
  const terminalPattern = new RegExp(
    `for\\(let (${identifierPattern}) of (${identifierPattern})\\)\\1\\.message\\.usage=(${identifierPattern}),\\1\\.message\\.stop_reason=(${identifierPattern}),\\1\\.message\\.stop_details=(${identifierPattern})\\.delta\\.stop_details\\?\\?null;`,
    "g"
  );
  const cloneSyncPattern = new RegExp(
    `for\\(let\\{src:(${identifierPattern}),dst:(${identifierPattern})\\}of (${identifierPattern})\\)\\2\\.usage=\\1\\.usage,\\2\\.stop_reason=\\1\\.stop_reason,\\2\\.stop_details=\\1\\.stop_details;`,
    "g"
  );
  const reducerMatches = [...content.matchAll(reducerPattern)];
  const reducerName = reducerMatches[0]?.[1];
  const selectorPattern = reducerName
    ? new RegExp(
        `(${identifierPattern})=${escapeRegExp(reducerName)}\\((${identifierPattern})\\),(${identifierPattern})=(${identifierPattern})\\((${identifierPattern}),(${identifierPattern})\\(\\)\\)`,
        "g"
      )
    : null;
  const wrapperMatches = [...content.matchAll(wrapperPattern)];
  const wrapperMatch = wrapperMatches[0];
  const wrapperIndex = wrapperMatch?.index ?? -1;
  const wrapperLocal = wrapperMatch?.[1];
  const wrapperFunctionStart = wrapperIndex === -1 ? -1 : content.lastIndexOf("function ", wrapperIndex);
  const terminalMatches = [...content.matchAll(terminalPattern)];
  const terminalMatch = terminalMatches[0];
  const terminalIndex = terminalMatch?.index ?? -1;
  const terminalFunctionStart = terminalIndex === -1 ? -1 : content.lastIndexOf("function ", terminalIndex);
  const terminalItem = terminalMatch?.[1];
  const terminalArray = terminalMatch?.[2];
  const terminalUsage = terminalMatch?.[3];
  const terminalStop = terminalMatch?.[4];
  const terminalRawEvent = terminalMatch?.[5];
  const aggregationPattern =
    terminalUsage && terminalRawEvent
      ? new RegExp(
          `case"message_delta":\\{${escapeRegExp(terminalUsage)}=(${identifierPattern})\\(${escapeRegExp(terminalUsage)},${escapeRegExp(terminalRawEvent)}\\.usage\\);`,
          "g"
        )
      : null;
  const aggregationSegment =
    terminalFunctionStart === -1 ? "" : content.slice(terminalFunctionStart, terminalIndex);
  const aggregationMatches = aggregationPattern
    ? [...aggregationSegment.matchAll(aggregationPattern)]
    : [];
  const firstMessageDelta = aggregationSegment.match(/case"message_delta":\{/);
  const canonicalAggregation = aggregationMatches[0];
  const canonicalAggregationIsFirst =
    canonicalAggregation !== undefined &&
    firstMessageDelta !== null &&
    canonicalAggregation.index === firstMessageDelta.index;
  const canonicalAggregationIndex =
    terminalFunctionStart === -1 || canonicalAggregation?.index === undefined
      ? -1
      : terminalFunctionStart + canonicalAggregation.index;
  const terminalDirectSegment =
    canonicalAggregationIndex === -1
      ? ""
      : content.slice(canonicalAggregationIndex, terminalIndex);
  const terminalCommitIsDirect =
    canonicalAggregationIndex !== -1 &&
    !terminalDirectSegment.includes("=>") &&
    !terminalDirectSegment.includes("function ");
  const cloneSyncMatches = [...content.matchAll(cloneSyncPattern)];
  const selectorCandidates = selectorPattern ? [...content.matchAll(selectorPattern)] : [];
  const selectorMatches = selectorCandidates.filter((match) => {
    const index = match.index ?? -1;
    const functionStart = content.lastIndexOf("function ", index);
    const functionEnd = content.indexOf("function ", index + match[0].length);
    const segment = content.slice(functionStart, functionEnd === -1 ? content.length : functionEnd);
    return segment.includes("context_window:");
  });
  const cloneArray = cloneSyncMatches[0]?.[3];
  const cloneRegistrationPattern = cloneArray
    ? new RegExp(
        `${escapeRegExp(cloneArray)}\\.push\\(\\{src:(${identifierPattern})\\.message,dst:(${identifierPattern})\\.message\\}\\)`,
        "g"
      )
    : null;
  const cloneMatches = cloneRegistrationPattern
    ? [...content.matchAll(cloneRegistrationPattern)]
    : [];
  const cloneSyncMatch = cloneSyncMatches[0];
  const cloneSyncIndex = cloneSyncMatch?.index ?? -1;
  const cloneSyncFunctionStart =
    cloneSyncIndex === -1 ? -1 : content.lastIndexOf("function ", cloneSyncIndex);
  const cloneSyncFunctionEnd =
    cloneSyncFunctionStart === -1
      ? -1
      : content.indexOf("function ", cloneSyncIndex + (cloneSyncMatch?.[0].length ?? 0));
  const cloneSyncFunctionSegment =
    cloneSyncFunctionStart === -1
      ? ""
      : content.slice(
          cloneSyncFunctionStart,
          cloneSyncFunctionEnd === -1 ? content.length : cloneSyncFunctionEnd
        );
  const cloneEventPattern = new RegExp(
    `if\\((${identifierPattern})\\.type==="stream_event"&&\\1\\.event\\.type==="message_delta"\\)\\{`,
    "g"
  );
  const cloneEventMatches = [...cloneSyncFunctionSegment.matchAll(cloneEventPattern)].filter(
    (match) => {
      const relativeIndex = match.index ?? -1;
      return (
        relativeIndex !== -1 &&
        cloneSyncFunctionStart + relativeIndex + match[0].length <= cloneSyncIndex
      );
    }
  );
  const cloneEventMatch = cloneEventMatches.at(-1);
  const cloneEventSource = cloneEventMatch?.[1];
  const cloneEventIndex =
    cloneSyncFunctionStart === -1 || cloneEventMatch?.index === undefined
      ? -1
      : cloneSyncFunctionStart + cloneEventMatch.index;
  const cloneSyncDirectSegment =
    cloneEventIndex === -1 ? "" : content.slice(cloneEventIndex, cloneSyncIndex);
  const cloneSyncIsDirect =
    cloneEventIndex !== -1 &&
    !cloneSyncDirectSegment.includes("=>") &&
    !cloneSyncDirectSegment.includes("function ");
  const cloneRegistrationFunctionStarts = cloneMatches.map((match) => {
    const index = match.index ?? -1;
    return index === -1 ? -1 : content.lastIndexOf("function ", index);
  });
  const wrapperCount = wrapperMatches.length;
  const terminalCount = terminalMatches.length;
  const aggregationCount = canonicalAggregationIsFirst ? 1 : 0;
  const cloneSyncCount = cloneSyncMatches.length;
  const selectorCount = selectorMatches.length;
  const candidates =
    wrapperCount + terminalCount + cloneMatches.length + cloneSyncCount + selectorCount;
  const wrapperFunctionEnd =
    wrapperIndex === -1 || !wrapperMatch
      ? -1
      : content.indexOf("function ", wrapperIndex + wrapperMatch[0].length);
  const wrapperFunctionSegment =
    wrapperFunctionStart === -1
      ? ""
      : content.slice(
          wrapperFunctionStart,
          wrapperFunctionEnd === -1 ? content.length : wrapperFunctionEnd
        );
  const wrapperPushPattern =
    terminalArray && wrapperLocal
      ? new RegExp(`${escapeRegExp(terminalArray)}\\.push\\(${escapeRegExp(wrapperLocal)}\\)`)
      : null;
  const cloneSources = new Set(cloneMatches.map((match) => match[1]));
  const cloneSource = cloneMatches[0]?.[1];
  const wrapperAndTerminalShareFunction =
    wrapperFunctionStart !== -1 && terminalFunctionStart === wrapperFunctionStart;
  const cloneRegistrationsOwnSync =
    cloneSyncFunctionStart !== -1 &&
    cloneRegistrationFunctionStarts.every((start) => start === cloneSyncFunctionStart);
  const cloneSourcesMatchStreamEvent =
    cloneEventSource !== undefined &&
    cloneSources.size === 1 &&
    cloneSource === cloneEventSource;
  const wrapperOwnsTerminalArray =
    terminalIndex > wrapperIndex &&
    wrapperPushPattern !== null &&
    wrapperPushPattern.test(content.slice(wrapperIndex + (wrapperMatch?.[0].length ?? 0), terminalIndex));
  const cloneArrayIsDistinctFromTerminal = cloneArray !== terminalArray;

  if (
    reducerMatches.length !== 1 ||
    wrapperCount !== 1 ||
    terminalCount !== 1 ||
    aggregationCount !== 1 ||
    cloneMatches.length !== 2 ||
    cloneSyncCount !== 1 ||
    selectorCount !== 1 ||
    !wrapperAndTerminalShareFunction ||
    !wrapperOwnsTerminalArray ||
    !terminalCommitIsDirect ||
    !cloneRegistrationsOwnSync ||
    !cloneSourcesMatchStreamEvent ||
    !cloneSyncIsDirect ||
    !cloneArrayIsDistinctFromTerminal
  ) {
    return { content: original, candidates, patched: 0 };
  }

  const accountingHelper =
    'function __calicoUsageHasAccountingSignal(e){if(!e||typeof e!=="object")return!1;return["input_tokens","output_tokens","cache_creation_input_tokens","cache_read_input_tokens"].some((t)=>typeof e[t]==="number"&&e[t]!==0)}' +
    'function __calicoUsageIsExactAllZero(e){if(!e||typeof e!=="object")return!1;return e.input_tokens===0&&e.output_tokens===0&&(e.cache_creation_input_tokens===void 0||e.cache_creation_input_tokens===0)&&(e.cache_read_input_tokens===void 0||e.cache_read_input_tokens===0)&&(e.cache_creation?.ephemeral_1h_input_tokens===void 0||e.cache_creation?.ephemeral_1h_input_tokens===0)&&(e.cache_creation?.ephemeral_5m_input_tokens===void 0||e.cache_creation?.ephemeral_5m_input_tokens===0)}' +
    'function __calicoStatuslineMessages(e){if(!Array.isArray(e))return e;return e.flatMap((t)=>{if(t?.type!=="assistant")return[t];let r=t.__calicoUsageState;if(r?.committed===!0&&r.usage)return[{...t,message:{...t.message,usage:r.usage}}];if(r===void 0&&t.message?.stop_reason!=null&&__calicoUsageHasAccountingSignal(t.message?.usage))return[t];return[]})}';
  const wrapperTailPattern = new RegExp(
    `,\\.\\.\\.!1,\\.\\.\\.${identifierPattern}&&\\{advisorModel:${identifierPattern}\\}\\};$`
  );
  const wrapperReplacement = wrapperMatch[0].replace(
    wrapperTailPattern,
    `,...!1,__calicoUsageState:{committed:!1,usage:null},...${wrapperMatch[10]}&&{advisorModel:${wrapperMatch[10]}}};`
  );
  if (wrapperReplacement === wrapperMatch[0]) {
    return { content: original, candidates, patched: 0 };
  }
  const terminalReplacement = `for(let ${terminalItem} of ${terminalArray})${terminalItem}.message.usage=${terminalUsage},${terminalItem}.message.stop_reason=${terminalStop},${terminalItem}.message.stop_details=${terminalRawEvent}.delta.stop_details??null,${terminalStop}!=null&&!__calicoUsageIsExactAllZero(${terminalRawEvent}.usage)&&__calicoUsageHasAccountingSignal(${terminalUsage})&&(${terminalItem}.__calicoUsageState.committed=!0,${terminalItem}.__calicoUsageState.usage=${terminalUsage});`;
  const cloneReplacements = cloneMatches.map(
    (match) => `${cloneArray}.push({src:${match[1]},dst:${match[2]}})`
  );
  const cloneSyncSource = cloneSyncMatches[0][1];
  const cloneSyncDestination = cloneSyncMatches[0][2];
  const cloneSyncReplacement = `for(let{src:${cloneSyncSource},dst:${cloneSyncDestination}}of ${cloneArray})${cloneSyncDestination}.message.usage=${cloneSyncSource}.message.usage,${cloneSyncDestination}.message.stop_reason=${cloneSyncSource}.message.stop_reason,${cloneSyncDestination}.message.stop_details=${cloneSyncSource}.message.stop_details,${cloneSyncDestination}.__calicoUsageState=${cloneSyncSource}.__calicoUsageState;`;
  const selectorMatch = selectorMatches[0];
  const selectorReplacement = `${selectorMatch[1]}=${reducerName}(__calicoStatuslineMessages(${selectorMatch[2]})),${selectorMatch[3]}=${selectorMatch[4]}(${selectorMatch[5]},${selectorMatch[6]}())`;

  let output = original.replace(wrapperPattern, wrapperReplacement);
  output = output.replace(terminalPattern, terminalReplacement);
  let cloneIndex = 0;
  output = output.replace(cloneRegistrationPattern, () => cloneReplacements[cloneIndex++]);
  output = output.replace(cloneSyncPattern, cloneSyncReplacement);

  const selectorOutputMatch = [...output.matchAll(selectorPattern)][0];
  const selectorIndex = selectorOutputMatch?.index ?? -1;
  const functionStart = output.lastIndexOf("function ", selectorIndex);
  if (selectorIndex === -1 || functionStart === -1) {
    return { content: original, candidates, patched: 0 };
  }

  output =
    output.slice(0, functionStart) + accountingHelper + output.slice(functionStart);
  output = output.replace(selectorPattern, selectorReplacement);

  if (
    output.split(wrapperReplacement).length - 1 !== 1 ||
    output.split(terminalReplacement).length - 1 !== 1 ||
    cloneReplacements.some((replacement) => output.split(replacement).length - 1 !== 1) ||
    output.split(cloneSyncReplacement).length - 1 !== 1 ||
    output.split(selectorReplacement).length - 1 !== 1 ||
    output.split("function __calicoUsageHasAccountingSignal").length - 1 !== 1 ||
    output.split("function __calicoUsageIsExactAllZero").length - 1 !== 1 ||
    output.split("function __calicoStatuslineMessages").length - 1 !== 1
  ) {
    return { content: original, candidates, patched: 0 };
  }

  return { content: output, candidates, patched: 6 };
}

function patchGatewayFastMode(content) {
  const original = content;
  const identifier = "[A-Za-z_$][\\w$]*";
  const interactivePattern = new RegExp(
    "async function (" +
      identifier +
      ")\\((" +
      identifier +
      "),(" +
      identifier +
      "),(" +
      identifier +
      ")\\)\\{if\\(!(" +
      identifier +
      ")\\(\\)\\)return \\2\\((" +
      identifier +
      ")\\(\\)\\?\\?\"Fast mode is not available\"\\),null;",
    "g"
  );
  const thinPattern = new RegExp(
    "async function (" +
      identifier +
      ")\\((" +
      identifier +
      "),(" +
      identifier +
      ")\\)\\{if\\(!(" +
      identifier +
      ")\\(\\)\\)return\\{type:\"text\",value:(" +
      identifier +
      ")\\(\\)\\?\\?\"Fast mode is not available\"\\};",
    "g"
  );
  const localJsxPattern =
    /([A-Za-z_$][\w$]*)=\{type:"local-jsx",name:"fast",get description\(\)\{return`Toggle fast mode \(\$\{([A-Za-z_$][\w$]*)\(\)\}\)`\},get isHidden\(\)\{return!([A-Za-z_$][\w$]*)\(\)\},argumentHint:"\[on\|off\]",get immediate\(\)\{return ([A-Za-z_$][\w$]*)\(\)\},requires:\{ink:!0\},thinClientDispatch:"control-request"\}/g;
  const localPattern =
    /([A-Za-z_$][\w$]*)=\{type:"local",name:"fast",supportsNonInteractive:!0,get description\(\)\{return`Toggle fast mode \(\$\{([A-Za-z_$][\w$]*)\(\)\}\)`\},argumentHint:"\[on\|off\]",isEnabled:\(\)=>([A-Za-z_$][\w$]*)\(\),get isHidden\(\)\{return!([A-Za-z_$][\w$]*)\(\)\}/g;
  const builderPattern = new RegExp(
    "function (" +
      identifier +
      ")\\((" +
      identifier +
      ")\\)\\{let (" +
      identifier +
      ")=process\\.env\\.CLAUDE_CODE_EXTRA_BODY,(" +
      identifier +
      ")=\\{\\};",
    "g"
  );
  const workerPattern = new RegExp(
    "\\.\\.\\.(" +
      identifier +
      ")\\.CLAUDE_CODE_EXTRA_BODY&&\\{CLAUDE_CODE_EXTRA_BODY:\\1\\.CLAUDE_CODE_EXTRA_BODY\\}",
    "g"
  );

  const interactiveMatches = [...content.matchAll(interactivePattern)];
  const thinMatches = [...content.matchAll(thinPattern)];
  const localJsxMatches = [...content.matchAll(localJsxPattern)];
  const localMatches = [...content.matchAll(localPattern)];
  const builderMatches = [...content.matchAll(builderPattern)];
  const workerMatches = [...content.matchAll(workerPattern)];
  const candidates =
    interactiveMatches.length +
    thinMatches.length +
    localJsxMatches.length +
    localMatches.length +
    builderMatches.length +
    workerMatches.length;

  if (
    interactiveMatches.length !== 1 ||
    thinMatches.length !== 1 ||
    localJsxMatches.length !== 1 ||
    localMatches.length !== 1 ||
    builderMatches.length !== 1 ||
    workerMatches.length !== 1
  ) {
    return { content: original, candidates, patched: 0 };
  }

  const interactive = interactiveMatches[0];
  const thin = thinMatches[0];
  const localJsx = localJsxMatches[0];
  const local = localMatches[0];
  const builder = builderMatches[0];
  const worker = workerMatches[0];

  if (
    interactive[5] !== thin[4] ||
    interactive[6] !== thin[5] ||
    local[3] !== local[4]
  ) {
    return { content: original, candidates, patched: 0 };
  }

  const interactiveStart = interactive.index ?? -1;
  const interactiveEndCandidate = content.indexOf(
    "async function ",
    interactiveStart + interactive[0].length
  );
  const interactiveEnd = interactiveEndCandidate === -1 ? content.length : interactiveEndCandidate;
  const interactiveSegment = content.slice(interactiveStart, interactiveEnd);
  const interactiveAction = interactiveSegment.match(
    /await ([A-Za-z_$][\w$]*)\([^;]*?"shortcut"/
  )?.[1];
  if (
    interactiveStart === -1 ||
    !interactiveAction ||
    !interactiveSegment.includes("tengu_fast_mode_picker_shown") ||
    !interactiveSegment.includes(".getAppState") ||
    !interactiveSegment.includes(".setAppState") ||
    !interactiveSegment.includes(".jsx(")
  ) {
    return { content: original, candidates, patched: 0 };
  }

  const thinStart = thin.index ?? -1;
  const thinEndCandidate = content.indexOf("async function ", thinStart + thin[0].length);
  const thinEnd = thinEndCandidate === -1 ? content.length : thinEndCandidate;
  const thinSegment = content.slice(thinStart, thinEnd);
  const thinAction = thinSegment.match(/await ([A-Za-z_$][\w$]*)\([^;]*?"bridge"/)?.[1];
  if (
    thinStart === -1 ||
    !thinAction ||
    thinAction !== interactiveAction ||
    !thinSegment.includes(".options.fastMode") ||
    !thinSegment.includes("Unknown argument") ||
    !thinSegment.includes(".getAppState") ||
    !thinSegment.includes(".setAppState")
  ) {
    return { content: original, candidates, patched: 0 };
  }

  const builderStart = builder.index ?? -1;
  const builderEndCandidate = content.indexOf("function ", builderStart + builder[0].length);
  const builderEnd = builderEndCandidate === -1 ? content.length : builderEndCandidate;
  const builderSegment = content.slice(builderStart, builderEnd);
  const betaMergeNeedle = `if(${builder[2]}&&${builder[2]}.length>0){`;
  const builderReturnNeedle = `return ${builder[4]}}`;
  if (
    builderStart === -1 ||
    builderSegment.split(betaMergeNeedle).length - 1 !== 1 ||
    builderSegment.split(builderReturnNeedle).length - 1 !== 1
  ) {
    return { content: original, candidates, patched: 0 };
  }

  const workerIndex = worker.index ?? -1;
  const workerStart = content.lastIndexOf("async function ", workerIndex);
  if (workerIndex === -1 || workerStart === -1) {
    return { content: original, candidates, patched: 0 };
  }
  const workerEndCandidate = content.indexOf("async function ", workerIndex + worker[0].length);
  const workerEnd = workerEndCandidate === -1 ? content.length : workerEndCandidate;
  const workerSegment = content.slice(workerStart, workerEnd);
  const workerLocalIndex = workerIndex - workerStart;
  function findObjectEnd(source, openIndex) {
    if (source[openIndex] !== "{") return -1;
    let depth = 0;
    let quote = null;
    let escaped = false;
    for (let index = openIndex; index < source.length; index += 1) {
      const character = source[index];
      if (quote !== null) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'" || character === "`") {
        quote = character;
      } else if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth === 0) return index;
      }
    }
    return -1;
  }
  const dispatchRecordPattern = new RegExp(
    "let (" +
      identifier +
      ")=\\{proto:" +
      identifier +
      ",short:" +
      identifier +
      ",sessionId:" +
      identifier +
      ",",
    "g"
  );
  const dispatchRecords = [...workerSegment.matchAll(dispatchRecordPattern)]
    .map((match) => {
      const recordStart = match.index ?? -1;
      const recordOpen = recordStart + match[0].indexOf("{");
      const recordEnd = findObjectEnd(workerSegment, recordOpen);
      const respawnIndex = workerSegment.indexOf("respawnFlags:", recordStart + match[0].length);
      const envIndex = workerSegment.indexOf("env:{", respawnIndex);
      const envEnd = findObjectEnd(workerSegment, envIndex + "env:".length);
      return { match, recordStart, recordEnd, respawnIndex, envIndex, envEnd };
    })
    .filter(
      ({ recordStart, recordEnd, respawnIndex, envIndex, envEnd }) =>
        recordStart !== -1 &&
        recordStart < respawnIndex &&
        respawnIndex < envIndex &&
        envIndex < workerLocalIndex &&
        workerLocalIndex < envEnd &&
        envEnd < recordEnd
    );
  if (dispatchRecords.length !== 1) {
    return { content: original, candidates, patched: 0 };
  }
  const dispatchRecord = dispatchRecords[0];
  const dispatchRecordLocal = dispatchRecord.match[1];
  const awaitedDispatchPattern = new RegExp(
    "\\},\\[,(" +
      identifier +
      ")\\]=await Promise\\.all\\(\\[(?:(?!\\]\\))[\\s\\S])*?,(" +
      identifier +
      ")\\(" +
      dispatchRecordLocal +
      "\\)\\]\\)",
    "g"
  );
  const awaitedDispatches = [...workerSegment.matchAll(awaitedDispatchPattern)];
  const directDispatchPattern = new RegExp(
    "(" + identifier + ")\\(" + dispatchRecordLocal + "\\)",
    "g"
  );
  const directDispatches = [...workerSegment.matchAll(directDispatchPattern)];
  if (
    awaitedDispatches.length !== 1 ||
    directDispatches.length !== 1 ||
    (awaitedDispatches[0].index ?? -1) !== dispatchRecord.recordEnd ||
    awaitedDispatches[0][2] !== directDispatches[0][1]
  ) {
    return { content: original, candidates, patched: 0 };
  }

  const helperBlock = String.raw`var __calicoGatewayFastNode={fs:process.getBuiltinModule("fs"),path:process.getBuiltinModule("path"),os:process.getBuiltinModule("os"),crypto:process.getBuiltinModule("crypto")};
var __calicoGatewayFastState={path:null,dir:null,owner:!1};
function __calicoGatewayFastEnsure(){if(process.env.REMORA_ACTIVE!=="1")return __calicoGatewayFastState;let e=process.env.CALICO_GATEWAY_FAST_STATE_FILE;if(e){if(__calicoGatewayFastState.path!==e)__calicoGatewayFastState={path:e,dir:null,owner:!1};return __calicoGatewayFastState}if(__calicoGatewayFastState.path){process.env.CALICO_GATEWAY_FAST_STATE_FILE=__calicoGatewayFastState.path;return __calicoGatewayFastState}let t=__calicoGatewayFastNode,r=t.fs.mkdtempSync(t.path.join(t.os.tmpdir(),"calico-gateway-fast-"));try{t.fs.chmodSync(r,0o700);let n=t.path.join(r,"mode");t.fs.writeFileSync(n,"inherit",{encoding:"utf8",mode:0o600,flag:"wx"});t.fs.chmodSync(n,0o600);process.env.CALICO_GATEWAY_FAST_STATE_FILE=n;__calicoGatewayFastState={path:n,dir:r,owner:!0};typeof process.once==="function"&&process.once("exit",()=>{try{t.fs.rmSync(r,{recursive:!0,force:!0})}catch{}});return __calicoGatewayFastState}catch(n){try{t.fs.rmSync(r,{recursive:!0,force:!0})}catch{}throw n}}
__calicoGatewayFastEnsure();
function __calicoGatewayFastRead(){let e=__calicoGatewayFastEnsure();if(!e.path)throw Error("gateway fast state is unavailable");let t=__calicoGatewayFastNode.fs.readFileSync(e.path,"utf8");if(t!=="inherit"&&t!=="on"&&t!=="off")throw Error("gateway fast state is invalid");return t}
function __calicoGatewayFastParse(e){let t=String(e??"");t=t.trim()===""?"{}":t;let r=0;function n(){while(r<t.length&&/\s/.test(t[r]))r++}function o(e=r){if(t[r++]!=='"')throw Error("expected JSON string");while(r<t.length){let n=t[r++];if(n==='"')return JSON.parse(t.slice(e,r));if(n==='\\'){if(r>=t.length)throw Error("invalid JSON escape");let e=t[r++];if(!'"\\/bfnrtu'.includes(e))throw Error("invalid JSON escape");if(e==='u'){if(r+4>t.length||!/^[0-9a-fA-F]{4}$/.test(t.slice(r,r+4)))throw Error("invalid JSON unicode escape");r+=4}}else if(n.charCodeAt(0)<32)throw Error("invalid JSON string character")}throw Error("unterminated JSON string")}
function i(){n();if(t[r++]!=='{')throw Error("expected JSON object");let e=new Set;n();if(t[r]==='}'){r++;return}for(;;){n();let s=r,a=o(s);if(e.has(a))throw Error('duplicate JSON key "'+a+'"');e.add(a);n();if(t[r++]!==':')throw Error("expected JSON colon");l();n();if(t[r]==='}'){r++;return}if(t[r++]!==',')throw Error("expected JSON comma")}}
function s(){n();if(t[r++]!=='[')throw Error("expected JSON array");n();if(t[r]===']'){r++;return}for(;;){l();n();if(t[r]===']'){r++;return}if(t[r++]!==',')throw Error("expected JSON comma")}}
function a(){let e=r;while(r<t.length&&!/[\s,\]}]/.test(t[r]))r++;if(r===e)throw Error("expected JSON value")}
function l(){n();if(t[r]==='{')return i();if(t[r]==='[')return s();if(t[r]==='"'){o(r);return}a()}
l();n();if(r!==t.length)throw Error("unexpected JSON content");let c=JSON.parse(t);if(c===null||typeof c!=="object"||Array.isArray(c))throw Error("CLAUDE_CODE_EXTRA_BODY must be a JSON object");(function e(t){if(typeof t==="number"&&!Number.isFinite(t))throw Error("CLAUDE_CODE_EXTRA_BODY contains a non-finite number");if(Array.isArray(t))for(let r of t)e(r);else if(t&&typeof t==="object")for(let r of Object.values(t))e(r)})(c);return c}
function __calicoGatewayFastTier(e){if(!Object.prototype.hasOwnProperty.call(e,"service_tier"))return!1;let t=e.service_tier;if(t==="fast"||t==="priority")return!0;throw Error('CLAUDE_CODE_EXTRA_BODY service_tier must be "fast" or "priority"')}
function __calicoGatewayFastRestore(e,t){if(e)process.env.CLAUDE_CODE_EXTRA_BODY=t;else delete process.env.CLAUDE_CODE_EXTRA_BODY}
function __calicoGatewayFastPublish(e,t,r,n){let o=__calicoGatewayFastEnsure();if(!o.path)throw Error("gateway fast state is unavailable");let i=__calicoGatewayFastNode,s=i.path.dirname(o.path),a=i.path.basename(o.path)+"."+process.pid+"."+i.crypto.randomBytes(8).toString("hex")+".tmp",l=i.path.join(s,a),c=!1;try{i.fs.writeFileSync(l,e,{encoding:"utf8",mode:0o600,flag:"wx"});c=!0;i.fs.chmodSync(l,0o600);process.env.CLAUDE_CODE_EXTRA_BODY=t;i.fs.renameSync(l,o.path)}catch(u){__calicoGatewayFastRestore(r,n);if(c)try{i.fs.unlinkSync(l)}catch{}throw u}}
function __calicoGatewayFastCommandValue(e){let t=typeof e==="string"?e.trim().toLowerCase():"";if(t!==""&&t!=="on"&&t!=="off")return'Unknown argument "'+t+'". Use: /fast [on|off]';try{let r=__calicoGatewayFastRead(),n=Object.prototype.hasOwnProperty.call(process.env,"CLAUDE_CODE_EXTRA_BODY"),o=process.env.CLAUDE_CODE_EXTRA_BODY,i=__calicoGatewayFastParse(o),s;if(t==="on")s="on";else if(t==="off")s="off";else if(r==="on")s="off";else if(r==="off")s="on";else s=__calicoGatewayFastTier(i)?"off":"on";if(s==="on"){__calicoGatewayFastTier(i);i.service_tier="priority"}else delete i.service_tier;let a=JSON.stringify(i);__calicoGatewayFastPublish(s,a,n,o);return s==="on"?"Gateway priority mode ON (this session only)":"Gateway priority mode OFF (this session only)"}catch(r){return"Gateway priority mode error: "+(r&&r.message?r.message:String(r))}}
function __calicoGatewayFastInteractive(e,t){e(__calicoGatewayFastCommandValue(t));return null}
function __calicoGatewayFastThin(e){return{type:"text",value:__calicoGatewayFastCommandValue(e)}}
function __calicoGatewayFastApply(e){if(process.env.REMORA_ACTIVE!=="1")return e;let t=__calicoGatewayFastRead(),r={...e};if(t==="on")r.service_tier="priority";else if(t==="off")delete r.service_tier;return r}
`;

  const interactiveReplacement = interactive[0].replace(
    `if(!${interactive[5]}())return ${interactive[2]}(${interactive[6]}()??"Fast mode is not available"),null;`,
    `if(process.env.REMORA_ACTIVE==="1")return __calicoGatewayFastInteractive(${interactive[2]},${interactive[4]});if(!${interactive[5]}())return ${interactive[2]}(${interactive[6]}()??"Fast mode is not available"),null;`
  );
  const thinReplacement = thin[0].replace(
    `if(!${thin[4]}())return{type:"text",value:${thin[5]}()??"Fast mode is not available"};`,
    `if(process.env.REMORA_ACTIVE==="1")return __calicoGatewayFastThin(${thin[2]});if(!${thin[4]}())return{type:"text",value:${thin[5]}()??"Fast mode is not available"};`
  );

  const jsxDescription =
    'get description(){return`Toggle fast mode (${'+localJsx[2]+'()})`}';
  const jsxGatewayDescription =
    'get description(){return process.env.REMORA_ACTIVE==="1"?"Toggle gateway priority tier":`Toggle fast mode (${'+localJsx[2]+'()})`}';
  let localJsxReplacement = localJsx[0].replace(jsxDescription, jsxGatewayDescription);
  localJsxReplacement = localJsxReplacement.replace(
    `get isHidden(){return!${localJsx[3]}()}`,
    `get isHidden(){return process.env.REMORA_ACTIVE==="1"?!1:!${localJsx[3]}()}`
  );

  const localDescription =
    'get description(){return`Toggle fast mode (${'+local[2]+'()})`}';
  const localGatewayDescription =
    'get description(){return process.env.REMORA_ACTIVE==="1"?"Toggle gateway priority tier":`Toggle fast mode (${'+local[2]+'()})`}';
  let localReplacement = local[0].replace(localDescription, localGatewayDescription);
  localReplacement = localReplacement.replace(
    `isEnabled:()=>${local[3]}(),get isHidden(){return!${local[4]}()}`,
    `isEnabled:()=>process.env.REMORA_ACTIVE==="1"||${local[3]}(),get isHidden(){return process.env.REMORA_ACTIVE==="1"?!1:!${local[4]}()}`
  );

  const builderReplacement = builderSegment.replace(
    betaMergeNeedle,
    `${builder[4]}=__calicoGatewayFastApply(${builder[4]});${betaMergeNeedle}`
  );
  const workerReplacement =
    worker[0] +
    `,...${worker[1]}.CALICO_GATEWAY_FAST_STATE_FILE&&{CALICO_GATEWAY_FAST_STATE_FILE:${worker[1]}.CALICO_GATEWAY_FAST_STATE_FILE}`;

  if (
    interactiveReplacement === interactive[0] ||
    thinReplacement === thin[0] ||
    localJsxReplacement === localJsx[0] ||
    localReplacement === local[0] ||
    builderReplacement === builderSegment ||
    helperBlock.includes('speed:"fast"')
  ) {
    return { content: original, candidates, patched: 0 };
  }

  let output = original;
  output = output.replace(interactive[0], interactiveReplacement);
  output = output.replace(thin[0], thinReplacement);
  output = output.replace(localJsx[0], localJsxReplacement);
  output = output.replace(local[0], localReplacement);
  output = output.replace(builderSegment, builderReplacement);
  output = output.replace(worker[0], workerReplacement);

  const helperIndex = output.indexOf(interactiveReplacement);
  if (helperIndex === -1) {
    return { content: original, candidates, patched: 0 };
  }
  output = output.slice(0, helperIndex) + helperBlock + output.slice(helperIndex);

  if (
    output.split("function __calicoGatewayFastEnsure").length - 1 !== 1 ||
    output.split("function __calicoGatewayFastParse").length - 1 !== 1 ||
    output.split("function __calicoGatewayFastCommandValue").length - 1 !== 1 ||
    output.split("function __calicoGatewayFastApply").length - 1 !== 1 ||
    output.split('if(process.env.REMORA_ACTIVE==="1")return __calicoGatewayFastInteractive').length - 1 !== 1 ||
    output.split('if(process.env.REMORA_ACTIVE==="1")return __calicoGatewayFastThin').length - 1 !== 1 ||
    output.split(`CALICO_GATEWAY_FAST_STATE_FILE:${worker[1]}.CALICO_GATEWAY_FAST_STATE_FILE`).length - 1 !== 1 ||
    output.split(`${builder[4]}=__calicoGatewayFastApply(${builder[4]});`).length - 1 !== 1
  ) {
    return { content: original, candidates, patched: 0 };
  }

  return { content: output, candidates, patched: 6 };
}
function patchActiveTurnPromptIdentity(content) {
  const original = content;
  let agentCandidates = 0;
  let agentPatched = 0;
  let clientCandidates = 0;
  let clientPatched = 0;
  let output = content;

  // Claude already owns a prompt-scoped UUID that remains stable from one
  // user prompt through its tool-result continuations. Discover the minified
  // getter semantically instead of depending on its current symbol name.
  const promptGetterMatch = output.match(
    /function ([A-Za-z_$][\w$]*)\(\)\{return ([A-Za-z_$][\w$]*)\.promptId\}function [A-Za-z_$][\w$]*\(e\)\{\2\.promptId=e\}/
  );
  if (!promptGetterMatch) {
    return { content: output, candidates, patched };
  }
  const promptGetter = promptGetterMatch[1];

  // Reuse Claude's own query-source classifier so quota checks, token counts,
  // compaction, side queries, and other auxiliary traffic cannot enter the
  // active-turn namespace.
  const sourceClassifierMatch = output.match(
    /function ([A-Za-z_$][\w$]*)\(e\)\{if\(e===void 0\)return;if\(e\.startsWith\("repl_main_thread"\)\|\|e==="sdk"\)return"main";if\(e\.startsWith\("agent:"\)\|\|e==="hook_agent"\)return"subagent";return"auxiliary"\}/
  );
  if (!sourceClassifierMatch) {
    return { content: original, candidates: 0, patched: 0 };
  }
  const sourceClassifier = sourceClassifierMatch[1];

  // Every spawned agent enters the same AsyncLocalStorage boundary. Freeze
  // the current prompt id there so a background agent keeps its spawning turn
  // even after the main session accepts another user prompt.
  const agentContextPattern =
    /(function [A-Za-z_$][\w$]*\(e,t\)\{return )([A-Za-z_$][\w$]*)\.run\(e,t\)(\}function [A-Za-z_$][\w$]*\(\)\{return\{agentType:"main",agentId:)/g;
  output = output.replace(
    agentContextPattern,
    (full, prefix, storage, suffix) => {
      agentCandidates += 1;
      agentPatched += 1;
      return `${prefix}e&&process.env.REMORA_ACTIVE==="1"&&e.__calicoPromptId===void 0&&(e.__calicoPromptId=${storage}.getStore()?.__calicoPromptId??${promptGetter}()),${storage}.run(e,t)${suffix}`;
    }
  );

  // Add a versioned, Calico-owned header only inside a remora child process.
  // Main-session requests use the live prompt id; agent requests prefer the
  // value frozen at their AsyncLocalStorage entry point.
  const clientStartPattern =
    /async function [A-Za-z_$][\w$]*\(\{apiKey:e,maxRetries:t,model:r,fetchOverride:n,source:o,agentContext:i\}\)\{/g;
  let clientStartMatch;
  while ((clientStartMatch = clientStartPattern.exec(output)) !== null) {
    const start = clientStartMatch.index;
    const nextAsyncFunction = output.indexOf(
      "async function ",
      start + clientStartMatch[0].length
    );
    const end = nextAsyncFunction === -1 ? output.length : nextAsyncFunction;
    const segment = output.slice(start, end);
    if (
      !segment.includes('"X-Claude-Code-Session-Id"') ||
      !segment.includes('"x-claude-code-agent-id"') ||
      segment.includes('"x-calico-active-turn-version"')
    ) {
      continue;
    }

    const localsPattern =
      /,c=([A-Za-z_$][\w$]*)\(i\)\?void 0:i,u=([A-Za-z_$][\w$]*)\(\),p=\{/;
    const localsMatch = segment.match(localsPattern);
    if (!localsMatch) {
      continue;
    }

    let nextSegment = segment.replace(
      localsPattern,
      `,c=$1(i)?void 0:i,__calicoActiveTurnAdapter="calico-active-turn-adapter:v1",__calicoQueryKind=${sourceClassifier}(o),__calicoPromptId=process.env.REMORA_ACTIVE==="1"&&(__calicoQueryKind==="main"||__calicoQueryKind==="subagent")?(c?.__calicoPromptId??${promptGetter}()):void 0,u=$2(),p={`
    );
    nextSegment = nextSegment.replace(
      /(\"X-Claude-Code-Session-Id\":[A-Za-z_$][\w$]*\(\),)(\.\.\.u,)/,
      '$1$2...__calicoPromptId&&{"x-calico-prompt-id":__calicoPromptId,"x-calico-active-turn-version":"1"},'
    );
    if (nextSegment === segment) {
      continue;
    }

    clientCandidates += 1;
    clientPatched += 1;
    output = output.slice(0, start) + nextSegment + output.slice(end);
    clientStartPattern.lastIndex = start + nextSegment.length;
  }

  const candidates = agentCandidates + clientCandidates;
  if (
    agentCandidates !== 1 ||
    agentPatched !== 1 ||
    clientCandidates !== 1 ||
    clientPatched !== 1
  ) {
    return { content: original, candidates, patched: 0 };
  }
  return { content: output, candidates, patched: agentPatched + clientPatched };
}

const PATCH_MODULES = [
  {
    id: "gateway-fast-mode",
    description: "Expose remora gateway fast-mode controls",
    apply: patchGatewayFastMode,
  },
  {
    id: "active-turn-prompt-id",
    description: "Expose stable prompt and per-agent turn identity to remora gateways",
    apply: patchActiveTurnPromptIdentity,
  },
  {
    id: "background-agent-usage",
    description: "Account terminal stream usage in background agent progress",
    apply: patchBackgroundAgentUsage,
  },
  {
    id: "statusline-committed-usage",
    description: "Expose only committed terminal assistant usage to statusline payloads",
    apply: patchStatuslineCommittedUsage,
  },
  {
    id: "custom-context-window",
    description: "Allow exact opt-in custom model context windows",
    apply: patchCustomContextWindows,
  },
  {
    id: "tool-call-verbose",
    description: "Force verbose collapsed read/search rendering",
    apply: patchCollapsedReadSearch,
  },
  {
    id: "create-diff-colors",
    description: "Render created files through diff component with + lines",
    apply: patchWriteCreateDiffColors,
  },
  {
    id: "word-diff-line-bg",
    description: "Keep muted +/- line background in word-diff mode",
    apply: patchWordDiffLineBackgrounds,
  },
  {
    id: "thinking-inline",
    description: "Always render thinking blocks inline",
    apply: patchThinkingCase,
  },
  {
    id: "redacted-thinking-inline",
    description: "Render redacted thinking summaries inline as thinking text",
    apply: patchRedactedThinkingSummaries,
  },
  {
    id: "thinking-streaming",
    description: "Enable/repair streaming thinking behavior",
    apply: patchThinkingStreaming,
  },
  {
    id: "subagent-prompt",
    description: "Show subagent Prompt blocks outside transcript mode",
    apply: patchSubagentPromptVisibility,
  },
  {
    id: "disable-spinner-tips",
    description: "Disable spinner tips regardless of settings",
    apply: patchDisableSpinnerTips,
  },
  {
    id: "version-output",
    description: "Append (patched) to plain --version output",
    apply: patchVersionOutput,
  },
  // NOTE: the "installer-label" module (patchInstallerMigrationMessage, kept
  // defined above) is intentionally NOT registered. Its target string
  // "switched from npm to native installer" was removed by Anthropic and no
  // longer exists in current Claude bundles (verified absent in 2.1.206), so it
  // can never apply and would make --assert-all fail on every build. Re-add this
  // entry if a future Claude version reintroduces that migration warning.
  {
    id: "welcome-badge",
    description: "Rename startup and help Claude Code titles to Calico Claude",
    apply: patchWelcomePatchedBadge,
  },
];

function resolveSelectedPatchIds(opts) {
  const valid = new Set(PATCH_MODULES.map((module) => module.id));
  const invalid = [...opts.disable, ...opts.enable].filter((id) => !valid.has(id));

  if (invalid.length > 0) {
    throw new Error(`Unknown patch id(s): ${invalid.join(", ")}. Use --list-patches to see valid ids.`);
  }

  const enableSet = new Set(opts.enable);
  const disableSet = new Set(opts.disable);
  const conflicts = [...enableSet].filter((id) => disableSet.has(id));
  if (conflicts.length > 0) {
    throw new Error(`Conflicting patch id(s) in --enable and --disable: ${conflicts.join(", ")}`);
  }

  const selected = new Set(PATCH_MODULES.map((module) => module.id));
  for (const id of enableSet) {
    selected.add(id);
  }
  for (const id of disableSet) {
    selected.delete(id);
  }

  return { selected };
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    console.error("");
    printHelp();
    process.exit(1);
  }

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  if (opts.listPatches) {
    console.log("Available patches:");
    for (const module of PATCH_MODULES) {
      console.log(`  ${module.id} - ${module.description}`);
    }
    process.exit(0);
  }

  let patchSelection;
  try {
    patchSelection = resolveSelectedPatchIds(opts);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
  const selectedPatchIds = patchSelection.selected;

  let targetPath;
  try {
    targetPath = resolveTargetPath(opts);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }

  ensureFileExists(targetPath);
  const original = fs.readFileSync(targetPath, TARGET_FILE_ENCODING);
  let currentContent = original;
  const patchResults = new Map();

  for (const module of PATCH_MODULES) {
    if (!selectedPatchIds.has(module.id)) {
      patchResults.set(module.id, {
        candidates: 0,
        patched: 0,
        skipped: true,
        reason: "disabled",
      });
      continue;
    }

    const result = module.apply(currentContent, { preserveLength: false });

    currentContent = result.content;
    patchResults.set(module.id, {
      candidates: result.candidates,
      patched: result.patched,
      skipped: false,
      reason: null,
    });
  }

  const nextContent = currentContent;

  console.log("Patch summary:");
  for (const module of PATCH_MODULES) {
    const result = patchResults.get(module.id);
    if (result.skipped) {
      if (result.reason === "disabled") {
        console.log(`  ${module.id} candidates: 0, patched: 0 (skipped)`);
      } else {
        console.log(
          `  ${module.id} candidates: ${result.candidates}, patched: 0 (skipped: ${result.reason})`
        );
      }
      continue;
    }
    console.log(`  ${module.id} candidates: ${result.candidates}, patched: ${result.patched}`);
  }

  if (opts.assertAll) {
    const failedModules = [];
    for (const module of PATCH_MODULES) {
      const result = patchResults.get(module.id);
      if (result.skipped) {
        continue;
      }
      if (result.patched === 0) {
        failedModules.push(module.id);
      }
    }

    if (failedModules.length > 0) {
      console.error("");
      console.error(
        `Error: --assert-all failed; the following patch module(s) applied 0 changes: ${failedModules.join(", ")}`
      );
      console.error(
        "This usually means the target bundle changed shape (upstream refactor) or is already patched."
      );
      process.exit(1);
    }
  }

  if (nextContent === original) {
    console.log("No changes needed.");
    process.exit(0);
  }

  if (opts.dryRun) {
    console.log("Dry run complete. No files changed.");
    process.exit(0);
  }

  fs.writeFileSync(targetPath, nextContent, TARGET_FILE_ENCODING);
  console.log(`Patched: ${targetPath}`);
}

module.exports = {
  patchGatewayFastMode,
  patchActiveTurnPromptIdentity,
  patchBackgroundAgentUsage,
  patchStatuslineCommittedUsage,
  patchCustomContextWindows,
};

if (require.main === module) {
  main();
}

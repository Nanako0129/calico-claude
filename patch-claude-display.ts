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

    if (!segment.includes("verbose:")) {
      index = start + o7qCaseNeedle.length;
      continue;
    }

    const callMatch = segment.match(
      /\{message:[^}]*inProgressToolUseIDs:[^}]*shouldAnimate:[^}]*verbose:[^,}]+,tools:[^}]*lookups:[^}]*isActiveGroup:[^}]*\}/
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

    // Claude 2.1.242 split the bundle into ES module chunks, so the JSX factory
    // arrives destructured (`o(Component,props)`) instead of namespace-qualified
    // (`iv.jsx(Component,props)`). Capture the whole callee expression and emit
    // it back verbatim rather than requiring a `.jsx`/`.createElement` suffix,
    // and anchor on the distinctive `{filePath,content,verbose}` prop triple —
    // the factory's local name is exactly the kind of minified binding that
    // differs per platform build and must never be pinned.
    // 2.1.246 appends `replacedUndiffedContent:<local>` to the create renderer's
    // props. The trailing props are matched but not forwarded: the replacement
    // renders through the *diff* component, which has its own prop contract —
    // the same reason `content` is dropped in favour of `structuredPatch`.
    const createReturnMatch = createSegment.match(
      /return ([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\(([A-Za-z_$][\w$]*),\{filePath:([A-Za-z_$][\w$]*),content:([A-Za-z_$][\w$]*),verbose:([A-Za-z_$][\w$]*)(?:,[A-Za-z_$][\w$]*:[^,{}]+)*\}\)/
    );
    if (!createReturnMatch) {
      index = updateStart + updateNeedle.length;
      continue;
    }

    const updateRendererMatch = updateSegment.match(
      /\(([A-Za-z_$][\w$]*),\{filePath:[^}]*structuredPatch:[^}]*style:([A-Za-z_$][\w$]*),verbose:[A-Za-z_$][\w$]*/
    );
    if (!updateRendererMatch) {
      index = updateStart + updateNeedle.length;
      continue;
    }

    candidates += 1;

    const jsxCallee = createReturnMatch[1];
    const fileVar = createReturnMatch[3];
    const contentVar = createReturnMatch[4];
    const verboseVar = createReturnMatch[5];
    const diffRenderer = updateRendererMatch[1];
    const styleVar = updateRendererMatch[2];

    const lineCounterMatch = createSegment.match(
      /let [A-Za-z_$][\w$]*=([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\);return [A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?\([A-Za-z_$][\w$]*,(?:null,|\{children:\[)"Wrote "/
    );
    const lineCountExpr = lineCounterMatch
      ? `${lineCounterMatch[1]}(${contentVar})`
      : `${contentVar}===""?0:${contentVar}.split(\`\\n\`).length`;

    const before = createReturnMatch[0];
    const after = `return ${jsxCallee}(${diffRenderer},{filePath:${fileVar},structuredPatch:[{oldStart:1,oldLines:0,newStart:1,newLines:${lineCountExpr},lines:${contentVar}===""?[]:${contentVar}.split(\`\\n\`).map((__cc_line)=>"+"+__cc_line)}],firstLine:${contentVar}.split(\`\\n\`)[0]??null,fileContent:"",style:${styleVar},verbose:${verboseVar},previewHint:void 0})`;

    if (!createSegment.includes(before)) {
      index = updateStart + updateNeedle.length;
      continue;
    }

    // `after` interpolates captured minified locals (fileVar, contentVar,
    // styleVar, …), which may themselves contain `$`. A callback return value
    // is emitted verbatim; passing `after` as a plain string here would let
    // String.replace's `$&`/`$$` expansion corrupt it if a captured name ever
    // contains one of those sequences.
    const nextCreateSegment = createSegment.replace(before, () => after);
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
      /if\(![A-Za-z_$][\w$]*(?:&&![A-Za-z_$][\w$]*){1,2}\)(?:return null;|\{return null;?\})/,
      (full) => {
        if (!ctx.preserveLength) {
          return "";
        }
        return `;${" ".repeat(Math.max(0, full.length - 1))}`;
      }
    );
    // The callee is `Ag.jsx(...)` on a monolithic bundle and a destructured
    // `o(...)` on 2.1.242+ ES module chunks, so match any component call shape
    // rather than the factory name. Loosening it is safe here because the body
    // only rewrites props literally named isTranscriptMode/hideInTranscript and
    // returns the match untouched when neither is present.
    nextSegment = nextSegment.replace(
      /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?\([A-Za-z_$][\w$]*,\{)([^}]*)\}/g,
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

    // Confirm the redacted case actually renders a component before replacing
    // it. On 2.1.242+ chunks the JSX factory is a destructured local, so match
    // the call-with-props shape instead of a `jsx(`/`createElement(` literal.
    const hasRedactedRendererCall =
      /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?\([A-Za-z_$][\w$]*,\{[^}]*\}\)/.test(redactedSegment);
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
      /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\(([A-Za-z_$][\w$]*),\{addMargin:([A-Za-z_$][\w$]*),param:([A-Za-z_$][\w$]*),isTranscriptMode:[^,}]+,verbose:[^,}]+(?:,hideInTranscript:[^}]+)?\}\)/
    );
    if (!thinkingRendererMatch) {
      index = redactedStart + redactedNeedle.length;
      continue;
    }

    const jsxCallee = thinkingRendererMatch[1];
    const thinkingComponent = thinkingRendererMatch[2];
    const addMarginVar = thinkingRendererMatch[3];
    const paramVar = thinkingRendererMatch[4];
    const hideInTranscriptProp = thinkingRendererMatch[0].includes("hideInTranscript:")
      ? ",hideInTranscript:!1"
      : "";

    candidates += 1;

    const replacement =
      `case"redacted_thinking":{return ${jsxCallee}(${thinkingComponent},{` +
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

// The joined bundle carries a marker between Bun modules (see
// scripts/native-bun.ts). A minified name captured at one site is a different
// binding at another when a boundary separates them, because 2.1.242+ chunks
// import each other under per-chunk aliases.
const BUN_MODULE_BOUNDARY = "\n/*@@calico-bun-module-boundary@@*/\n";

function inSameModule(content, first, second) {
  if (first < 0 || second < 0) {
    return false;
  }
  const [low, high] = first <= second ? [first, second] : [second, first];
  return !content.slice(low, high).includes(BUN_MODULE_BOUNDARY);
}

// Upstream's "build a virtual message" helper, matched by its own destructured
// option names rather than by a name captured elsewhere. On 2.1.245 the
// transcript-extras site (chunk 117) knows it as `Ah` while the stream
// reducer's chunk imports an unrelated `ypd as Ah`, so passing the captured
// name into the reducer injected a call to the wrong function: every turn that
// produced a thinking block rendered no assistant output at all, with no error
// surfaced anywhere. Resolving the declaration and requiring it to be in the
// reducer's own module makes the name correct by construction, and returns
// null — skipping the injection — rather than emitting a cross-module name.
const VIRTUAL_MESSAGE_DECLARATION_PATTERN =
  /function ([A-Za-z_$][\w$]*)\(\{content:[A-Za-z_$][\w$]*,usage:[A-Za-z_$][\w$]*,isVirtual:[A-Za-z_$][\w$]*,now:[A-Za-z_$][\w$]*,uuid:[A-Za-z_$][\w$]*\}\)\{/g;

function virtualMessageHelperAt(content, index) {
  for (const match of content.matchAll(VIRTUAL_MESSAGE_DECLARATION_PATTERN)) {
    if (inSameModule(content, match.index ?? -1, index)) {
      return match[1];
    }
  }
  return null;
}

// Index of the `)` that closes the `(` at openIndex, or -1.
function closingParenIndex(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    const char = text[i];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

// Truncate a segment at the first Bun module boundary it contains. Segments cut
// with `indexOf("function ")` routinely run past the end of their chunk, so
// evidence gathered from them can come from a module the matched code cannot
// even see.
function boundedToModule(segment) {
  const boundary = segment.indexOf(BUN_MODULE_BOUNDARY);
  return boundary === -1 ? segment : segment.slice(0, boundary);
}

// Index of the `}` that closes the `{` at openIndex, or -1.
function closingBraceIndex(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    const char = text[i];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

// Index of the innermost `if(` whose body contains statementIndex — the guard
// that OWNS the statement, rather than whichever `if(` happens to be nearest.
// A guard's body is either the single statement right after its `)`, or a
// braced block; scanning backwards from the statement, the first candidate
// satisfying either is the innermost. A sibling `if` earlier in the same block
// fails both tests, which is the case that matters: forcing it true would leave
// the real guard intact and the defect invisible. Returns -1 when nothing owns
// the statement, and callers treat that as "do not patch" — declining is the
// safe direction.
function owningGuardIndex(text, statementIndex) {
  let search = text.lastIndexOf("if(", statementIndex);
  while (search !== -1) {
    const close = closingParenIndex(text, search + 2);
    if (close !== -1) {
      if (close + 1 === statementIndex) {
        return search;
      }
      if (text[close + 1] === "{") {
        const blockEnd = closingBraceIndex(text, close + 1);
        if (blockEnd > statementIndex) {
          return search;
        }
      }
    }
    search = search === 0 ? -1 : text.lastIndexOf("if(", search - 1);
  }
  return -1;
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

  const turnStreamSelectionPattern =
    /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(((?:[A-Za-z_$][\w$]*|\([A-Za-z_$][\w$]*\?[A-Za-z_$][\w$]*:[A-Za-z_$][\w$]*\)))\?\.stream,([A-Za-z_$][\w$]*)\)\?\?([A-Za-z_$][\w$]*),/g;
  let turnStreamSelectionMatch;
  while ((turnStreamSelectionMatch = turnStreamSelectionPattern.exec(output)) !== null) {
    const streamingToolUsesVar = turnStreamSelectionMatch[1];
    const selectorHook = turnStreamSelectionMatch[2];
    const turnVar = turnStreamSelectionMatch[3];
    const fnStart = output.lastIndexOf("function ", turnStreamSelectionMatch.index);
    const fnEnd = output.indexOf("function ", turnStreamSelectionMatch.index + turnStreamSelectionMatch[0].length);
    if (fnStart === -1 || fnEnd === -1) {
      continue;
    }

    const wrapperSegment = output.slice(fnStart, fnEnd);
    if (!wrapperSegment.includes(`streamingToolUses:${streamingToolUsesVar},`)) {
      continue;
    }

    const rendererSignaturePattern =
      /(streamingToolUses:[A-Za-z_$][\w$]*,)((?:showAllInTranscript|isLoading):)/;
    if (!rendererSignaturePattern.test(output)) {
      continue;
    }

    const streamingThinkingVar = "__cc_streamingThinking";
    // Both replacements interpolate captured minified names, and the matcher
    // admits `$` in them. Passing that text as a replacement *string* would let
    // `String.replace` expand a `$$` inside a name to a single `$`, silently
    // renaming the local in the injected store read and in the re-emitted
    // expression. Go through callbacks so the captures are emitted verbatim.
    let nextWrapperSegment = wrapperSegment.replace(
      turnStreamSelectionMatch[0],
      () =>
        `${turnStreamSelectionMatch[0]}${streamingThinkingVar}=${selectorHook}(${turnVar}?.stream,(__cc_state)=>__cc_state.streamingThinking)??null,`
    );
    nextWrapperSegment = nextWrapperSegment.replace(
      `streamingToolUses:${streamingToolUsesVar},`,
      () => `streamingToolUses:${streamingToolUsesVar},streamingThinking:${streamingThinkingVar},`
    );

    // Force the compiler's memo guard to rebuild the element. The guard has to
    // be the one that OWNS the renderer assignment, not merely the nearest
    // preceding `if(`: any intervening conditional — a computed prop, a nested
    // ternary lowered to a branch — would otherwise be forced true while the
    // real guard stayed intact, leaving streamingThinking updates hidden behind
    // the stale cached element with every text-level check still passing.
    // Identify it structurally: find the assignment whose props object holds the
    // injected prop, then take the `if(` whose condition closes immediately
    // before that assignment starts.
    const propIndex = nextWrapperSegment.indexOf(`streamingThinking:${streamingThinkingVar},`);
    if (propIndex === -1) {
      continue;
    }
    const rendererAssignPattern =
      /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\(([A-Za-z_$][\w$]*),\{/g;
    let rendererAssign = null;
    for (const assignMatch of nextWrapperSegment.matchAll(rendererAssignPattern)) {
      if (assignMatch.index > propIndex) {
        break;
      }
      rendererAssign = assignMatch;
    }
    if (rendererAssign === null) {
      continue;
    }
    const cacheIfIndex = owningGuardIndex(nextWrapperSegment, rendererAssign.index);
    if (cacheIfIndex === -1) {
      continue;
    }
    nextWrapperSegment =
      nextWrapperSegment.slice(0, cacheIfIndex + 3) +
      "!0||" +
      nextWrapperSegment.slice(cacheIfIndex + 3);

    let nextOutput = output.slice(0, fnStart) + nextWrapperSegment + output.slice(fnEnd);
    nextOutput = nextOutput.replace(
      rendererSignaturePattern,
      `$1streamingThinking:${streamingThinkingVar},$2`
    );
    if (nextOutput !== output) {
      candidates += 1;
      patched += 1;
      output = nextOutput;
      turnStreamSelectionPattern.lastIndex = fnStart + nextWrapperSegment.length;
    }
  }

  let propCandidates = 0;
  let propPatched = 0;
  const identifierPattern = "[A-Za-z_$][\\w$]*";
  const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let streamingVar =
    output.match(/hidePastThinking:!0,streamingThinking:([A-Za-z_$][\w$]*)/)?.[1] ??
    output.match(
      /streamingToolUses:[A-Za-z_$][\w$]*,streamingThinking:([A-Za-z_$][\w$]*),(?:userInputOnProcessing|isLoading):/
    )?.[1] ??
    null;

  if (streamingVar === null) {
    const onStreamingThinkingPattern = /onStreamingThinking:([A-Za-z_$][\w$]*)/g;
    let onStreamingThinkingMatch;
    while ((onStreamingThinkingMatch = onStreamingThinkingPattern.exec(output)) !== null) {
      const setStreamingThinkingVar = onStreamingThinkingMatch[1];
      const anchor = onStreamingThinkingMatch.index;
      const searchStart = Math.max(0, anchor - 50000);
      const searchSegment = output.slice(searchStart, anchor);
      const statePattern = new RegExp(
        `\\[(${identifierPattern}),${escapeRegExp(setStreamingThinkingVar)}\\]=${identifierPattern}(?:\\.useState)?\\(null\\)`,
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

  // 2.1.236+ moves streaming state from useState into a coalescing store
  // (`_snapshot={streamingToolUses:[],streamingThinking:null,…}`) consumed via
  // `{streamingToolUses:X,userInputOnProcessing:Y}=hook(ctx.stream)`. The
  // snapshot already carries streamingThinking natively, so widen that
  // destructuring and thread the snapshot field as the renderer prop.
  if (streamingVar === null) {
    let storeCandidates = 0;
    let storePatched = 0;
    // This destructuring is rewritten, so fields upstream adds have to be
    // carried across rather than dropped: 2.1.246 appended `toolProgress:<local>`.
    const storeSnapshotPattern = new RegExp(
      `\\{streamingToolUses:(${identifierPattern}),userInputOnProcessing:(${identifierPattern})((?:,[^{}]*?)?)\\}=(${identifierPattern})\\((${identifierPattern})\\.stream\\)`,
      "g"
    );
    output = output.replace(
      storeSnapshotPattern,
      (full, toolUsesVar, inputVar, extraSnapshotFields, hookFunction, contextVar) => {
        if (streamingVar !== null) {
          return full;
        }
        storeCandidates += 1;
        storePatched += 1;
        streamingVar = "__cc_streamingThinkingState";
        return `{streamingToolUses:${toolUsesVar},streamingThinking:__cc_streamingThinkingState,userInputOnProcessing:${inputVar}${extraSnapshotFields}}=${hookFunction}(${contextVar}.stream)`;
      }
    );
    candidates += storeCandidates;
    patched += storePatched;
  }

  if (streamingVar !== null) {
    const createElementCallPattern = /createElement\(([A-Za-z_$][\w$]*),\{([^{}]*?)\}\)/g;
    const promptRendererCallPattern =
      /createElement\(([A-Za-z_$][\w$]*),\{([\s\S]{0,2000}?placeholderElement:[\s\S]{0,2000}?agentDefinitions:[^}]*?onOpenRateLimitOptions:[^}]*?isLoading:)([^,}]+)(,streamingText:[^}]*?(?:showThinkingHint:[^}]*?)?isBriefOnly:[^}]*?)\}\)/g;
    const jsxMainRendererPropsPattern =
      /(screen:[^,}]+,streamingToolUses:[^,}]+,)(showAllInTranscript:[^,}]+,agentDefinitions:[^,}]+,onOpenRateLimitOptions:[^,}]+,isLoading:[^,}]+)/g;
    // 2.1.235 drops agentDefinitions from the main renderer props run.
    const jsxMainRendererWithoutShowAllPropsPattern =
      /(screen:[^,}]+,streamingToolUses:[^,}]+,)((?:agentDefinitions:[^,}]+,)?onOpenRateLimitOptions:[^,}]+,onRateLimitAutoQueueContinue:[^,}]+,isLoading:[^,}]+,hasStreamingText:[^,}]+,streamingPreview:[^,}]+,isBriefOnly:[^,}]+)/g;
    const jsxTranscriptRendererPropsPattern =
      /(screen:[^,}]+,agentDefinitions:[^,}]+,streamingToolUses:[^,}]+,)(showAllInTranscript:[^,}]+,onOpenRateLimitOptions:[^,}]+,isLoading:[^,}]+)/g;
    const jsxStreamStoreMainRendererPropsPattern =
      /(screen:[^,}]+,streamingToolUses:[^,}]+,)(onOpenRateLimitOptions:[^,}]+,onRateLimitAutoQueueContinue:[^,}]+,isLoading:[^,}]+,hasStreamingText:[^,}]+,streamingPreview:[^,}]+,isBriefOnly:[^,}]+)/g;
    const jsxStreamStoreTranscriptRendererPropsPattern =
      /(screen:[^,}]+,streamingToolUses:[^,}]+,)(showAllInTranscript:[^,}]+,onOpenRateLimitOptions:[^,}]+,onRateLimitAutoQueueContinue:[^,}]+,isLoading:[^,}]+)/g;
    const jsxStreamStoreTranscriptWrapperPropsPattern =
      /(focused:[^,}]+,tools:[^,}]+,commands:[^,}]+,streamingToolUses:[^,}]+,)(isLoading:[^,}]+,onOpenRateLimitOptions:[^,}]+,onRateLimitAutoQueueContinue:[^,}]+)/g;

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
    output = output.replace(
      jsxMainRendererWithoutShowAllPropsPattern,
      injectStreamingThinking
    );
    output = output.replace(jsxTranscriptRendererPropsPattern, injectStreamingThinking);

  }

  // 2.1.245 rewrote the main renderer call site: instead of an explicit prop
  // list it spreads a rest object and reads the streaming state through store
  // selectors, inside a React-compiler memo cache:
  //
  //   function kC(lh){let ju=v(19);…
  //     let mh=Do(Wu,NC)??!1,ph=Do(Wu?.stream,EC)??_i,…
  //     let qu;if(ju[10]!==Vu||…||ju[14]!==fh)
  //       qu=o(Rh,{...nn,messages:Vu,isLoading:mh,streamingToolUses:ph,
  //               onRateLimitAutoQueueContinue:fh}),
  //       ju[10]=Vu,…,ju[14]=fh,ju[15]=qu;else qu=ju[15];
  //
  // Adding the prop alone is not enough: the cached element is only rebuilt
  // when one of the compared slots changes, so a streamingThinking value that
  // updates on its own would never reach the renderer. The injection
  // therefore also claims one new cache slot — growing the allocation the way
  // the compiler itself would — and adds it to both the guard and the
  // write-back. `streamingThinking` is read through its own module-scoped
  // selector declared beside the component, so the selector identity is
  // stable across renders and nothing crosses a chunk scope.
  // Not gated on the earlier prop patterns having failed: the spread call
  // site is a distinct shape that simply does not exist on pre-2.1.245
  // bundles, so it self-selects and pre-2.1.245 builds keep their counts.
  {
    // 2.1.247 keeps this idiom but passes the store through a parenthesised
    // expression rather than a plain local (`et((FM?Xr:null)?.stream,wv)??li`),
    // and the `??default` tail is not always present. Capture the whole
    // receiver so the injected read uses the same store the renderer does.
    const storeSelectorPattern = new RegExp(
      `(${identifierPattern})=(${identifierPattern})\\((${identifierPattern}|\\([^()]*\\))\\?\\.stream,${identifierPattern}\\)(?:\\?\\?${identifierPattern})?,`,
      "g"
    );

    for (const selectorRead of [...output.matchAll(storeSelectorPattern)]) {
      const toolUsesLocal = selectorRead[1];
      const storeHook = selectorRead[2];
      const storeReceiver = selectorRead[3];
      const escapedToolUses = escapeRegExp(toolUsesLocal);
      const memoCallPattern = new RegExp(
        `let (${identifierPattern});if\\((${identifierPattern})\\[\\d+\\]!==[^)]*?\\)\\1=${identifierPattern}\\(${identifierPattern},\\{\\.\\.\\.${identifierPattern},[^{}]*streamingToolUses:${escapedToolUses}[^{}]*\\}\\),[^;]*?,\\2\\[(\\d+)\\]=\\1;`
      );
      const memoCall = output.slice(selectorRead.index).match(memoCallPattern);
      if (!memoCall || memoCall[0].includes("streamingThinking:")) {
        continue;
      }

      const cacheLocal = memoCall[2];
      const cacheAllocPattern = new RegExp(
        `let ${escapeRegExp(cacheLocal)}=(${identifierPattern})\\((\\d+)\\)([,;])`
      );
      const functionStart = output.lastIndexOf("function ", selectorRead.index);
      const cacheAlloc =
        functionStart === -1
          ? null
          : output.slice(functionStart, selectorRead.index).match(cacheAllocPattern);
      if (!cacheAlloc) {
        continue;
      }

      const cacheSize = Number(cacheAlloc[2]);
      const resultSlot = Number(memoCall[3]);
      if (!Number.isInteger(cacheSize) || resultSlot >= cacheSize) {
        continue;
      }

      propCandidates += 1;

      const thinkingLocal = "__cc_streamingThinking";
      const selectorName = "__cc_streamingThinkingSelector";
      const grownCall = memoCall[0]
        .replace(
          new RegExp(`\\)${escapeRegExp(memoCall[1])}=`),
          () => `||${cacheLocal}[${cacheSize}]!==${thinkingLocal})${memoCall[1]}=`
        )
        .replace(
          new RegExp(`streamingToolUses:${escapedToolUses}`),
          () => `streamingToolUses:${toolUsesLocal},streamingThinking:${thinkingLocal}`
        )
        .replace(
          new RegExp(`,${escapeRegExp(cacheLocal)}\\[${resultSlot}\\]=${escapeRegExp(memoCall[1])};$`),
          () => `,${cacheLocal}[${cacheSize}]=${thinkingLocal},${cacheLocal}[${resultSlot}]=${memoCall[1]};`
        );

      // Every edit here is applied to the one enclosing function, spliced
      // back by offset. A plain `output.replace(text, …)` would rewrite the
      // FIRST occurrence in the whole joined bundle, and minified names are
      // not unique across chunks: `function kC(` occurs four times in
      // 2.1.245, so the selector declaration landed in chunk 25 while its use
      // stayed in chunk 117 and the binary died at startup with
      // "__cc_streamingThinkingSelector is not defined". The uniqueness
      // assertions below keep the in-region replaces honest.
      const regionStart = functionStart;
      const regionEnd = selectorRead.index + memoCall.index + memoCall[0].length;
      const region = output.slice(regionStart, regionEnd);
      if (
        region.split(cacheAlloc[0]).length - 1 !== 1 ||
        region.split(selectorRead[0]).length - 1 !== 1 ||
        region.split(memoCall[0]).length - 1 !== 1
      ) {
        continue;
      }

      const patchedRegion = region
        .replace(
          cacheAlloc[0],
          () => `let ${cacheLocal}=${cacheAlloc[1]}(${cacheSize + 1})${cacheAlloc[3]}`
        )
        .replace(
          selectorRead[0],
          () =>
            `${selectorRead[0]}${thinkingLocal}=${storeHook}(${storeReceiver}?.stream,${selectorName})??null,`
        )
        .replace(memoCall[0], () => grownCall);

      const nextOutput =
        output.slice(0, regionStart) +
        `function ${selectorName}(e){return e.streamingThinking}` +
        patchedRegion +
        output.slice(regionEnd);

      if (nextOutput !== output) {
        output = nextOutput;
        propPatched += 1;
      }
      break;
    }
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
  const thinkingDisplayCachedFlagPattern = new RegExp(
    `(${identifierPattern})=(${identifierPattern})\\(process\\.env\\.CLAUDE_CODE_DISABLE_THINKING\\),` +
      `(${identifierPattern})=(${identifierPattern})\\.type!=="disabled"&&!\\1,` +
      `(${identifierPattern})=\\3((?:&&${identifierPattern}\\(\\)&&${identifierPattern}\\(${identifierPattern}\\))?)\\?\\4\\.display(?:\\?\\?void 0)?:void 0,` +
      `(${identifierPattern})=void 0;`,
    "g"
  );
  output = output.replace(
    thinkingDisplayCachedFlagPattern,
    (
      full,
      disableThinkingVar,
      envFlagHelper,
      enabledVar,
      thinkingConfigVar,
      displayVar,
      displayGuards,
      requestVar
    ) => {
      displayCandidates += 1;
      if (full.includes('display??"summarized"')) {
        return full;
      }

      const replacement =
        `${disableThinkingVar}=${envFlagHelper}(process.env.CLAUDE_CODE_DISABLE_THINKING),` +
        `${enabledVar}=${thinkingConfigVar}.type!=="disabled"&&!${disableThinkingVar},` +
        `${displayVar}=${enabledVar}${displayGuards}?${thinkingConfigVar}.display??"summarized":void 0,` +
        `${requestVar}=void 0;`;
      if (replacement !== full) {
        displayPatched += 1;
        return replacement;
      }
      return full;
    }
  );
  // 2.1.245 hoists the display guard into its own local
  // (`ws=so&&hh()&&fUr(d),Zr=ws?n.display:void 0`) instead of inlining it in
  // the display assignment, so neither branch above reaches it. Without this
  // the request enables thinking but never asks for summarized text, the API
  // returns signature-only thinking blocks, and the UI shows the collapsed
  // placeholder row with no thinking content at all.
  const thinkingDisplayHoistedGuardPattern = new RegExp(
    `(${identifierPattern})=(${identifierPattern})\\(process\\.env\\.CLAUDE_CODE_DISABLE_THINKING\\),` +
      `(${identifierPattern})=(${identifierPattern})\\.type!=="disabled"&&!\\1,` +
      `((${identifierPattern})=\\3&&${identifierPattern}\\(\\)&&${identifierPattern}\\(${identifierPattern}\\)),` +
      `(${identifierPattern})=\\6\\?\\4\\.display(?:\\?\\?void 0)?:void 0,` +
      `(${identifierPattern})=void 0;`,
    "g"
  );
  output = output.replace(
    thinkingDisplayHoistedGuardPattern,
    (
      full,
      disableThinkingVar,
      envFlagHelper,
      enabledVar,
      thinkingConfigVar,
      guardAssignment,
      guardVar,
      displayVar,
      requestVar
    ) => {
      displayCandidates += 1;
      if (full.includes('display??"summarized"')) {
        return full;
      }

      const replacement =
        `${disableThinkingVar}=${envFlagHelper}(process.env.CLAUDE_CODE_DISABLE_THINKING),` +
        `${enabledVar}=${thinkingConfigVar}.type!=="disabled"&&!${disableThinkingVar},` +
        `${guardAssignment},` +
        `${displayVar}=${guardVar}?${thinkingConfigVar}.display??"summarized":void 0,` +
        `${requestVar}=void 0;`;
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
  // 2.1.236+ inserts an already-streamed guard between the condition and the
  // callback: `if(a&&a.type==="thinking")if(G!==null&&G(a))o?.(()=>null);else o?.(…)`.
  // Extend find/condition to redacted blocks; the guard only ever sees a
  // thinking-typed block (it was written for `.thinking`, not `.data`).
  const guardedAssistantThinkingPattern =
    /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.message\.content\.find\(\(([A-Za-z_$][\w$]*)\)=>\3\.type==="thinking"\);if\(\1&&\1\.type==="thinking"\)if\(([A-Za-z_$][\w$]*)!==null&&\4\(\1\)\)([A-Za-z_$][\w$]*)\?\.\(\(\)=>null\);else \5\?\.\(\(\)=>\(\{thinking:\1\.thinking,isStreaming:!1,streamingEndedAt:Date\.now\(\)\}\)\)/g;
  output = output.replace(
    guardedAssistantThinkingPattern,
    (_full, blockVar, messageVar, itemVar, guardVar, setStreamingVar) => {
      redactedSummaryCandidates += 1;
      redactedSummaryPatched += 1;
      return `let ${blockVar}=${messageVar}.message.content.find((${itemVar})=>${itemVar}.type==="thinking"||${itemVar}.type==="redacted_thinking");if(${blockVar}&&(${blockVar}.type==="thinking"||${blockVar}.type==="redacted_thinking"))if(${blockVar}.type==="thinking"&&${guardVar}!==null&&${guardVar}(${blockVar}))${setStreamingVar}?.(()=>null);else ${setStreamingVar}?.(()=>({thinking:${blockVar}.type==="thinking"?${blockVar}.thinking:${blockVar}.data??"",isStreaming:!1,streamingEndedAt:Date.now()}))`;
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
    /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\(\(\)=>\{if\(!([A-Za-z_$][\w$]*)\)return!1;if\(\3\.isStreaming\)return!0;if\(\3\.streamingEndedAt\)return Date\.now\(\)-\3\.streamingEndedAt<30000;return!1\},\[\3\]\)/g;
  output = output.replace(promptLingerPattern, (_full, visibleVar, useMemoCallee, streamVar) => {
    lingerCandidates += 1;
    lingerPatched += 1;
    return `${visibleVar}=${useMemoCallee}(()=>!!(${streamVar}&&${streamVar}.isStreaming),[${streamVar}])`;
  });
  const streamStoreLingerPattern =
    /if\(([A-Za-z_$][\w$]*)&&!\1\.isStreaming&&\1\.streamingEndedAt\)\{let ([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*-\(Date\.now\(\)-\1\.streamingEndedAt\);if\(\2>0\)this\._cancelThinkingHide=this\._scheduleTimeout\(\(\)=>\{this\._cancelThinkingHide=null,this\.setStreamingThinking\(null\)\},\2\);else this\.setStreamingThinking\(null\)\}/g;
  output = output.replace(streamStoreLingerPattern, (_full, streamVar) => {
    lingerCandidates += 1;
    lingerPatched += 1;
    return `if(${streamVar}&&!${streamVar}.isStreaming&&${streamVar}.streamingEndedAt)this.setStreamingThinking(null)`;
  });
  candidates += lingerCandidates;
  patched += lingerPatched;

  const transcriptToolUseHelpersMatch = output.match(
    /let [A-Za-z_$][\w$]*=([A-Za-z_$][\w$]*)\(\{content:\[[A-Za-z_$][\w$]*\.contentBlock\]\}\);return [A-Za-z_$][\w$]*\.uuid=([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\.contentBlock\.id,0\),([A-Za-z_$][\w$]*)\(\[[A-Za-z_$][\w$]*\]\)/
  );
  // 2.1.246 restructured the transcript-extras memo, so its anchor no longer
  // matches and the helper name cannot be captured there. The reducer sections
  // below still need to know a helper exists; fall back to its own declaration.
  // The name emitted at each injection site is resolved separately and per
  // module by virtualMessageHelperAt — this value only gates the sections.
  const virtualMessageDeclarationMatch = output.match(
    new RegExp(VIRTUAL_MESSAGE_DECLARATION_PATTERN.source)
  );
  let createVirtualMessageHelper =
    transcriptToolUseHelpersMatch?.[1] ?? virtualMessageDeclarationMatch?.[1] ?? null;
  let transcriptStreamingThinkingVar = null;
  const rendererStreamingThinkingMatch = output.match(
    // 2.1.247 dropped showAllInTranscript from the renderer's destructured
    // params and moved isLoading up behind streamingToolUses, so neither the
    // detection nor the injection below can pin what follows the parameter.
    // 2.1.257 stopped destructuring in the parameter list: the compiler now emits
    // `function f(p){let c=_(203),{messages:…}=p`. Anchor on the destructuring
    // itself, which is `({messages:` in one form and `,{messages:` in the other.
    /[(,]\{messages:[^}]*?streamingToolUses:[A-Za-z_$][\w$]*,streamingThinking:([A-Za-z_$][\w$]*)[,}]/
  );
  if (rendererStreamingThinkingMatch) {
    transcriptStreamingThinkingVar = rendererStreamingThinkingMatch[1];
  } else if (streamingVar !== null || propPatched > 0) {
    // The gate is "is anything going to pass this prop", not "did the old
    // store-snapshot discovery succeed". 2.1.247 dropped that destructuring
    // entirely, so streamingVar is null there while the compiler-cached call
    // site above does supply the prop — without this the renderer would receive
    // a value it never destructures.
    const rendererSignaturePattern =
      /([(,]\{messages:[^}]*?streamingToolUses:[A-Za-z_$][\w$]*,)(?!streamingThinking:)([A-Za-z_$][\w$]*:)/;
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
      /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\(\(\)=>([A-Za-z_$][\w$]*)\.flatMap\(\(([A-Za-z_$][\w$]*)\)=>\{let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\{content:\[\4\.contentBlock\]\}\);return \5\.uuid=([A-Za-z_$][\w$]*)\(\4\.contentBlock\.id,0\),([A-Za-z_$][\w$]*)\(\[\5\]\)\}\),\[\3\]\)/g;
    output = output.replace(
      inlineThinkingPattern,
      (
        _full,
        extrasVar,
        memoCall,
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
        return `${extrasVar}=${memoCall}(()=>{let __cc_streamingToolUseExtras=${streamingToolUsesVar}.map((${toolUseEntryVar})=>{let ${toolUseMessageVar}=${createMessageHelper}({content:[${toolUseEntryVar}.contentBlock]});return ${toolUseMessageVar}.uuid=${createUUIDHelper}(${toolUseEntryVar}.contentBlock.id,0),{index:${toolUseEntryVar}.index??9007199254740991,messages:${normalizeMessagesHelper}([${toolUseMessageVar}])}}),__cc_streamingThinkingExtras=(${transcriptStreamingThinkingVar}?.messages??[]).map((__cc_entry,__cc_index)=>({index:__cc_entry.index??9007199254740991+__cc_index,messages:${normalizeMessagesHelper}([__cc_entry.message??__cc_entry])}));return[...__cc_streamingToolUseExtras,...__cc_streamingThinkingExtras].sort((__cc_a,__cc_b)=>__cc_a.index===__cc_b.index?0:__cc_a.index-__cc_b.index).flatMap((__cc_entry)=>__cc_entry.messages)},[${streamingToolUsesVar},${transcriptStreamingThinkingVar}])`;
      }
    );

    const dedupedInlineThinkingPattern =
      /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\(\)=>([A-Za-z_$][\w$]*)\.flatMap\(\(([A-Za-z_$][\w$]*)\)=>\{let\{id:([A-Za-z_$][\w$]*),minted:([A-Za-z_$][\w$]*)\}=([A-Za-z_$][\w$]*)\(\4\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\{content:\[\6\?\{\.\.\.\4\.contentBlock,id:\5\}:\4\.contentBlock\]\}\);return \8\.uuid=\6\?\5:([A-Za-z_$][\w$]*)\(\5,0\),([A-Za-z_$][\w$]*)\(\[\8\]\)\}\),\[\3,\7\]\)/g;
    output = output.replace(
      dedupedInlineThinkingPattern,
      (
        _full,
        extrasVar,
        memoCall,
        streamingToolUsesVar,
        toolUseEntryVar,
        toolUseIdVar,
        mintedVar,
        resolveToolUseIdHelper,
        toolUseMessageVar,
        createMessageHelper,
        createUUIDHelper,
        normalizeMessagesHelper
      ) => {
        inlineThinkingCandidates += 1;
        inlineThinkingPatched += 1;
        createVirtualMessageHelper = createMessageHelper;
        return `${extrasVar}=${memoCall}(()=>{let __cc_streamingToolUseExtras=${streamingToolUsesVar}.map((${toolUseEntryVar})=>{let{id:${toolUseIdVar},minted:${mintedVar}}=${resolveToolUseIdHelper}(${toolUseEntryVar}),${toolUseMessageVar}=${createMessageHelper}({content:[${mintedVar}?{...${toolUseEntryVar}.contentBlock,id:${toolUseIdVar}}:${toolUseEntryVar}.contentBlock]});return ${toolUseMessageVar}.uuid=${mintedVar}?${toolUseIdVar}:${createUUIDHelper}(${toolUseIdVar},0),{index:${toolUseEntryVar}.index??9007199254740991,messages:${normalizeMessagesHelper}([${toolUseMessageVar}])}}),__cc_streamingThinkingExtras=(${transcriptStreamingThinkingVar}?.messages??[]).map((__cc_entry,__cc_index)=>({index:__cc_entry.index??9007199254740991+__cc_index,messages:${normalizeMessagesHelper}([__cc_entry.message??__cc_entry])}));return[...__cc_streamingToolUseExtras,...__cc_streamingThinkingExtras].sort((__cc_a,__cc_b)=>__cc_a.index===__cc_b.index?0:__cc_a.index-__cc_b.index).flatMap((__cc_entry)=>__cc_entry.messages)},[${streamingToolUsesVar},${resolveToolUseIdHelper},${transcriptStreamingThinkingVar}])`;
      }
    );
    // 2.1.257 runs this region through the React Compiler, so neither hand
    // written shape above survives: the entry mapper is hoisted into its own
    // memo slot and the `flatMap` into another, leaving no `memo(()=>…,[deps])`
    // call to rewrite. Same construct, third spelling — match the compiled
    // guard/mapper/flatMap triple instead.
    const compiledInlineThinkingPattern = new RegExp(
      `if\\((?<cache>${identifierPattern})\\[(?<g1>\\d+)\\]!==(?<resolver>${identifierPattern})\\|\\|\\k<cache>\\[(?<g2>\\d+)\\]!==(?<list>${identifierPattern})\\)\\{` +
        `let (?<mapper>${identifierPattern});` +
        `if\\(\\k<cache>\\[(?<g3>\\d+)\\]!==\\k<resolver>\\)\\k<mapper>=\\((?<entry>${identifierPattern})\\)=>\\{` +
        `let\\{id:(?<id>${identifierPattern}),minted:(?<minted>${identifierPattern})\\}=\\k<resolver>\\(\\k<entry>\\);` +
        `let (?<msg>${identifierPattern})=(?<create>${identifierPattern})\\(\\{content:\\[\\k<minted>\\?\\{\\.\\.\\.\\k<entry>\\.contentBlock,id:\\k<id>\\}:\\k<entry>\\.contentBlock\\]\\}\\);` +
        `return \\k<msg>\\.uuid=\\k<minted>\\?\\k<id>:(?<uuid>${identifierPattern})\\(\\k<id>,0\\),(?<normalize>${identifierPattern})\\(\\[\\k<msg>\\]\\)\\},` +
        `\\k<cache>\\[\\k<g3>\\]=\\k<resolver>,\\k<cache>\\[(?<g4>\\d+)\\]=\\k<mapper>;else \\k<mapper>=\\k<cache>\\[\\k<g4>\\];` +
        `(?<result>${identifierPattern})=\\k<list>\\.flatMap\\(\\k<mapper>\\);` +
        `\\k<cache>\\[\\k<g1>\\]=\\k<resolver>,\\k<cache>\\[\\k<g2>\\]=\\k<list>,\\k<cache>\\[(?<g5>\\d+)\\]=\\k<result>\\}else \\k<result>=\\k<cache>\\[\\k<g5>\\];`,
      "g"
    );
    output = output.replace(compiledInlineThinkingPattern, (...args) => {
      const g = args[args.length - 1];
      inlineThinkingCandidates += 1;
      inlineThinkingPatched += 1;
      createVirtualMessageHelper = g.create;
      // The compiler keyed this slot on the tool-use list and the id resolver
      // only, and there is no slot left to key the thinking store on: growing
      // the cache array means rewriting its `new Array(N)` literal, which moves
      // every downstream index. Force the guard instead. The cost is that the
      // merged list rebuilds each render of the transcript, which is what
      // upstream did before it memoized this in 2.1.250.
      return (
        `if(!0||${g.cache}[${g.g1}]!==${g.resolver}||${g.cache}[${g.g2}]!==${g.list}){` +
        `let ${g.mapper};` +
        `if(${g.cache}[${g.g3}]!==${g.resolver})${g.mapper}=(${g.entry})=>{` +
        `let{id:${g.id},minted:${g.minted}}=${g.resolver}(${g.entry});` +
        `let ${g.msg}=${g.create}({content:[${g.minted}?{...${g.entry}.contentBlock,id:${g.id}}:${g.entry}.contentBlock]});` +
        `return ${g.msg}.uuid=${g.minted}?${g.id}:${g.uuid}(${g.id},0),${g.normalize}([${g.msg}])},` +
        `${g.cache}[${g.g3}]=${g.resolver},${g.cache}[${g.g4}]=${g.mapper};else ${g.mapper}=${g.cache}[${g.g4}];` +
        `${g.result}=(()=>{let __cc_streamingToolUseExtras=${g.list}.map((__cc_entry)=>({index:__cc_entry.index??9007199254740991,messages:${g.mapper}(__cc_entry)})),` +
        `__cc_streamingThinkingExtras=(${transcriptStreamingThinkingVar}?.messages??[]).map((__cc_entry,__cc_index)=>({index:__cc_entry.index??9007199254740991+__cc_index,messages:${g.normalize}([__cc_entry.message??__cc_entry])}));` +
        `return[...__cc_streamingToolUseExtras,...__cc_streamingThinkingExtras].sort((__cc_a,__cc_b)=>__cc_a.index===__cc_b.index?0:__cc_a.index-__cc_b.index).flatMap((__cc_entry)=>__cc_entry.messages)})();` +
        `${g.cache}[${g.g1}]=${g.resolver},${g.cache}[${g.g2}]=${g.list},${g.cache}[${g.g5}]=${g.result}}else ${g.result}=${g.cache}[${g.g5}];`
      );
    });

    candidates += inlineThinkingCandidates;
    patched += inlineThinkingPatched;
  }

  // Main-session brief mode filters the normalized transcript after the live
  // thinking extras are appended. Keep thinking entries there; subagents skip
  // this filter, which otherwise makes the bug appear main-session-only.
  let briefThinkingCandidates = 0;
  let briefThinkingPatched = 0;
  // 2.1.236+ wraps the text clause in an extra paren: `if((d?.type==="text"||…)&&…)`.
  const briefThinkingFilterPattern =
    /if\(([A-Za-z_$][\w$]*)\.type==="assistant"\)\{if\(\1\.isApiErrorMessage\)return!0;(if\(([A-Za-z_$][\w$]*)\?\.type==="tool_use"[\s\S]{0,600}?if\(\(?([A-Za-z_$][\w$]*)\?\.type==="text"[\s\S]{0,300}?return!0;return!1\})/g;
  output = output.replace(
    briefThinkingFilterPattern,
    (full, entryVar, remainingFilter, contentVar, textContentVar) => {
      if (contentVar !== textContentVar) {
        return full;
      }
      briefThinkingCandidates += 1;
      briefThinkingPatched += 1;
      return `if(${entryVar}.type==="assistant"){if(${entryVar}.isApiErrorMessage)return!0;if(${contentVar}?.type==="thinking"||${contentVar}?.type==="redacted_thinking")return!0;${remainingFilter}`;
    }
  );
  candidates += briefThinkingCandidates;
  patched += briefThinkingPatched;

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

    // `after` interpolates captured event/setter/helper locals, so it must
    // reach the string engine only through a callback — a plain-string 2nd
    // argument would let `$$`/`$&` in a captured name expand.
    return {
      segment: segment.replace(before, () => after),
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
      const reducerMessageHelper = virtualMessageHelperAt(output, destructuredMatch.index ?? -1);
      if (reducerMessageHelper === null) {
        continue;
      }
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
        reducerMessageHelper
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
        reducerMessageHelper
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
      /function [A-Za-z_$][\w$]*\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)(?:,[A-Za-z_$][\w$]*)?\)\{let\{([^}]*)\}=\2([;,])/g;
    let missingStreamingThinkingMatch;
    while ((missingStreamingThinkingMatch = missingStreamingThinkingHandlerPattern.exec(output)) !== null) {
      const eventParam = missingStreamingThinkingMatch[1];
      const optionsParam = missingStreamingThinkingMatch[2];
      const props = missingStreamingThinkingMatch[3];
      const declarationSeparator = missingStreamingThinkingMatch[4];
      const reducerMessageHelper = virtualMessageHelperAt(
        output,
        missingStreamingThinkingMatch.index ?? -1
      );
      if (reducerMessageHelper === null) {
        continue;
      }
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
        reducerMessageHelper
      );

      const replacements = [
        [
          `let{${props}}=${optionsParam}${declarationSeparator}`,
          `let{${props},onStreamingThinking:${setStreamingThinkingParam}}=${optionsParam}${declarationSeparator}`,
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
            reducerMessageHelper
          )},${setModeParam}?.("thinking");return;`,
        ],
        [
          `case"thinking":case"redacted_thinking":${setModeParam}?.("thinking");return;`,
          `case"thinking":case"redacted_thinking":${buildStreamingThinkingStartExpression(
            eventParam,
            setStreamingThinkingParam,
            reducerMessageHelper
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

      if (displayTransformParam !== null) {
        const messageStopAuthoringProgressPattern = new RegExp(
          `if\\(${eventParam}\\.event\\.type==="message_stop"\\)\\{if\\(` +
            `${displayTransformParam}\\?\\.finalize\\(\\),` +
            `${setModeParam}\\?\\.\\("tool-use"\\),` +
            `${setStreamingToolsParam}\\?\\.\\(\\(\\)=>\\[\\]\\),` +
            `(${identifierPattern})\\)(${identifierPattern})\\.loaded\\(\\)\\?\\.resetAuthoringProgress\\(\\);return\\}`
        );
        const nextMessageStopSegment = nextHandlerSegment.replace(
          messageStopAuthoringProgressPattern,
          (_full, authoringProgressVar, authoringProgressModule) =>
            `if(${eventParam}.event.type==="message_stop"){if(` +
            `${displayTransformParam}?.finalize(),` +
            `${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:Date.now(),currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),` +
            `${setModeParam}?.("tool-use"),${setStreamingToolsParam}?.(()=>[]),` +
            `${authoringProgressVar})${authoringProgressModule}.loaded()?.resetAuthoringProgress();return}`
        );
        if (nextMessageStopSegment !== nextHandlerSegment) {
          candidates += 1;
          patched += 1;
          nextHandlerSegment = nextMessageStopSegment;
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
        // This positional branch is its own scope: the helper the two
        // destructured reducer loops resolve is not visible here, so referencing
        // it would throw a ReferenceError and abort the whole patch run the
        // first time an older bundle reached this shape. Resolve it for this
        // reducer's own module, and skip the injection when it is unavailable.
        const positionalMessageHelper = virtualMessageHelperAt(output, wg6Start);
        if (params.length >= 7 && positionalMessageHelper !== null) {
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
          const thinkingStartAfter = `case"thinking":case"redacted_thinking":${buildStreamingThinkingStartExpression(
            eventParam,
            setStreamingThinkingParam,
            positionalMessageHelper
          )},${setModeParam}("thinking");return;`;

          const textStartBefore = `case"text":${setModeParam}("responding");return;`;
          const textStartAfter = `case"text":${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:void 0,currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}("responding");return;`;

          const messageDeltaBefore = `case"message_delta":${setModeParam}("responding");return;`;
          const messageDeltaAfter = `case"message_delta":${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:void 0,currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}("responding");return;`;
          const messageDeltaBlockBefore = `case"message_delta":{${setModeParam}("responding");`;
          const messageDeltaBlockAfter = `case"message_delta":{${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:void 0,currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}("responding");`;

          const thinkingDeltaBefore = `case"thinking_delta":${appendOutputParam}(${eventParam}.event.delta.thinking);return;`;
          const thinkingDeltaBareBefore = `case"thinking_delta":return;`;
          const thinkingDeltaBody = buildStreamingThinkingDeltaStatement(
            eventParam,
            setStreamingThinkingParam,
            positionalMessageHelper
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
              // `after` interpolates captured wg6 locals; go through a
              // callback so `$$`/`$&` inside a captured name is not expanded.
              nextWg6Segment = nextWg6Segment.replace(before, () => after);
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

function patchDisableUsageWrapUpHints(content) {
  // 2.1.238+ injects meta wrap-up prompts near the usage limit ("Checkpoint
  // now: finish the current step, then list up to 3 short bullets ...") plus a
  // matching TUI notice. Both injection paths are gated on statsig flags read
  // by name with disabled defaults ("off" / !1), so renaming the gate name
  // literals makes every lookup miss and fall back to disabled. Replacements
  // are the same length as the originals, so no preserveLength branch is
  // needed. Anchoring on the gate-name string literals (not minified locals)
  // keeps this stable across bundle rebuilds.
  //
  // The mode gate alone does not close the wrap-up path. The injector reads the
  // text gate first and lets a non-empty value stand in for the mode:
  //
  //   let F = ran(P(nan, ""));                          // nan = ..._wick_text
  //   B = F !== null ? "custom" : tan(P(ean, "off"));   // ean = ..._wick_mode
  //   if (B !== "off") v.push(xe({ content: F ?? ..., isMeta: !0, ... }))
  //
  // so any server-supplied text short-circuits the renamed mode gate and the
  // injection still fires. Measured on a patched 2.1.259 bundle before this
  // change: _wick_mode and _vellum_anchor gone, _wick_text and _wick_release
  // both still present. The release gate is reachable the same way, since its
  // precondition is a wrap-up note the text path can produce. Renaming all four
  // is what actually closes the path, not defence in depth.
  //
  // What gets injected is a `type: "user"` message carrying isMeta/turnCompanion
  // and a usageLimitNote, i.e. it lands under the same role label as something
  // the human typed. That is the reason to close it rather than tolerate it.
  //
  // `since` is the first version measured to carry the literal, and the gates
  // did not arrive together: mode and vellum are present from 2.1.238, text and
  // release first appear in 2.1.247 and are absent from 2.1.246. The
  // all-or-nothing check below counts against the gates this bundle is old
  // enough to have, not against the whole list, or 2.1.246 fails as a partial
  // match for two literals it can never contain.
  const gateRenames = [
    // grace-window wrap-up injection ("off" | "basic" | "next-steps")
    { from: '"tengu_lantern_wick_mode"', to: '"calico_lantern_wick_off"', since: 238 },
    // arbitrary server-supplied wrap-up text; non-empty implies mode "custom"
    { from: '"tengu_lantern_wick_text"', to: '"calico_lantern_text_off"', since: 247 },
    // arbitrary server-supplied text for the post-wrap-up release note
    {
      from: '"tengu_lantern_wick_release"',
      to: '"calico_lantern_release_off"',
      since: 247,
    },
    // 95% near-limit "checkpoint now" injection + notice (boolean)
    { from: '"tengu_vellum_anchor"', to: '"calico_vellum_gone_"', since: 238 },
  ];

  const bundleVersion = content
    .match(/PACKAGE_URL:"@anthropic-ai\/claude-code"[\s\S]{0,500}?VERSION:"(\d+)\.(\d+)\.(\d+)"/)
    ?.slice(1)
    .map(Number);
  // Unparseable metadata expects every gate, keeping the strict reading.
  const inEra = (since) =>
    bundleVersion === undefined ||
    bundleVersion[0] > 2 ||
    (bundleVersion[0] === 2 &&
      (bundleVersion[1] > 1 || (bundleVersion[1] === 1 && bundleVersion[2] >= since)));

  const perGateCounts = gateRenames.map(({ from }) => content.split(from).length - 1);
  const candidates = perGateCounts.reduce((sum, count) => sum + count, 0);
  const presentGates = perGateCounts.filter((count) => count > 0).length;
  const expectedGates = gateRenames.filter(({ since }) => inEra(since)).length;

  if (presentGates > 0 && presentGates < expectedGates) {
    // Partial match: upstream changed or removed a gate literal while keeping
    // the others. Renaming only the survivors would ship a bundle with a
    // wrap-up injection path still active under its new gate name, so patch
    // nothing and report zero patched to fail --assert-all loudly instead.
    return {
      content,
      candidates,
      patched: 0,
    };
  }

  if (presentGates === 0) {
    // Pre-feature bundles (< 2.1.238) carry neither gate; that is an expected
    // no-op, not a matcher failure, so report it as skipped and keep
    // --assert-all green for older rebuilds. A 2.1.238+ bundle (or one with
    // unparseable VERSION metadata) without the gates stays a hard failure:
    // that is how --assert-all catches upstream renaming the gates away.
    const versionMatch = content.match(
      /PACKAGE_URL:"@anthropic-ai\/claude-code"[\s\S]{0,500}?VERSION:"(\d+)\.(\d+)\.(\d+)"/
    );
    if (versionMatch) {
      const [major, minor, micro] = versionMatch.slice(1).map(Number);
      const preFeature =
        major < 2 || (major === 2 && (minor < 1 || (minor === 1 && micro < 238)));
      if (preFeature) {
        return {
          content,
          candidates,
          patched: 0,
          skipped: true,
          reason: `pre-2.1.238 bundle (${major}.${minor}.${micro}) has no usage wrap-up gates`,
        };
      }
    }
    return {
      content,
      candidates,
      patched: 0,
    };
  }

  let output = content;
  for (const { from, to } of gateRenames) {
    output = output.split(from).join(to);
  }

  return {
    content: output,
    candidates,
    patched: candidates,
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

  // 2.1.242+ chunks destructure the JSX factory, so the callee is a bare local
  // (`o(T,…)`) rather than `ns.createElement(...)`/`ns.jsx(...)`. Capture the
  // whole callee expression and emit it back verbatim.
  output = output.replace(
    /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\(([A-Za-z_$][\w$]*),\{bold:!0\},"Claude Code"\)/g,
    (full, jsxCallee, textComponent) => {
      candidates += 1;
      const replacement = `${jsxCallee}(${textComponent},{bold:!0},"Calico Claude")`;
      if (replacement !== full) {
        patched += 1;
        return replacement;
      }
      return full;
    }
  );

  output = output.replace(
    /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\(([A-Za-z_$][\w$]*),\{bold:!0,children:"Claude Code"\}\)/g,
    (full, jsxCallee, textComponent) => {
      candidates += 1;
      const replacement = `${jsxCallee}(${textComponent},{bold:!0,children:"Calico Claude"})`;
      if (replacement !== full) {
        patched += 1;
        return replacement;
      }
      return full;
    }
  );

  output = output.replace(
    /([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),\{bold:!0,children:"Claude Code"\}\)/g,
    (full, jsxFactory, textComponent) => {
      candidates += 1;
      const replacement = `${jsxFactory}(${textComponent},{bold:!0,children:"Connoisseur's Code"})`;
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
  // The two parameters were pinned as `e` and `t`, and the injected lookup
  // emitted `e` verbatim. They are minified names: 2.1.257 renamed the second to
  // `n`, which took this module from 4 candidates to 1. That still passed
  // --assert-all, since it only fails at zero — a silent loss of coverage.
  // Capture both and emit the captures.
  //
  // 2.1.260 stopped reading the headers parameter directly and passes it
  // through a helper first:
  //
  //   2.1.259  function wL(e,n){if(ou(e))return 1e6;if(n?.includes(vx.header)…
  //   2.1.260  function tU(e,n){if(Vc(e))return 1e6;if(RYe(n)?.includes(rP.header)…
  //
  // Pinning `\3?.includes(` took this module from 4 candidates to 3 — the
  // resolver site, and with it both injected markers. --assert-all still
  // passed, so the loss was silent again; the verifier is what failed the
  // build. Accept the parameter bare or wrapped in one call.
  const resolverPattern =
    /(function [A-Za-z_$][\w$]*\()([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)(\)\{)(if\([A-Za-z_$][\w$]*\(\2\)\)return 1e6;if\((?:\3|[A-Za-z_$][\w$]*\(\3\))\?\.includes\()/g;

  output = output.replace(resolverPattern, (full, functionOpen, modelParam, headersParam, brace, originalBody) => {
    const functionStart = `${functionOpen}${modelParam},${headersParam}${brace}`;
    candidates += 1;
    const helpers =
      'function __calico_context_window(e){try{let t=process.env.CALICO_MODEL_CONTEXT_WINDOWS;if(!t)return null;let r=JSON.parse(t);if(!r||typeof r!=="object"||Array.isArray(r)||!Object.hasOwn(r,e))return null;let n=r[e];if(!Number.isInteger(n)||n<100000||n>1000000)return null;return n}catch{return null}}' +
      // __calico_display_window is declared here but called from the status-line
      // site below, which upstream 2.1.242+ places in a different Bun chunk.
      // Chunks are separate ES module scopes, so this one helper has to live on
      // globalThis; a bare declaration resolves at patch time and is undefined
      // at runtime. __calico_context_window stays local because it is only
      // called from the resolver body injected immediately after it.
      'globalThis.__calico_display_window=function(e){let t=Number(process.env.CALICO_CONTEXT_DISPLAY_PERCENT??100);if(!Number.isFinite(t)||t<1||t>100)return e;return Math.floor(e*t/100)};';
    const replacement =
      `${helpers}${functionStart}let __calico_window=__calico_context_window(${modelParam});` +
      `if(__calico_window!==null)return __calico_window;${originalBody}`;
    patched += 1;
    return replacement;
  });

  // Claude's stock pipeline subtracts an output reserve and may precompute at
  // a separate buffer fraction. In opt-in Calico mode, use the raw mapped
  // window and the explicit percentage as the single compact boundary.
  // The reserve local (Math.min result) and the ctx local are swapped on some
  // platform builds of the same version (arm64: `let n=Math.min(...),r=...`
  // → `return o-n`; elsewhere `let r=Math.min(...),n=...` → `return o-r`), so
  // capture the window and reserve locals instead of pinning `o`/`r`.
  const effectiveWindowPattern =
    /(function [A-Za-z_$][\w$]*\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{let ([A-Za-z_$][\w$]*)=Math\.min\([A-Za-z_$][\w$]*\(\2\),[A-Za-z_$][\w$]*\),([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\(\)\?\3:void 0,\{window:([A-Za-z_$][\w$]*)\}=[A-Za-z_$][\w$]*\(\2,\5\);return )(\6-\4)(\})/g;
  output = output.replace(
    effectiveWindowPattern,
    (full, prefix, modelParam, headersParam, reserveLocal, ctxLocal, windowLocal, originalReturn, suffix) => {
      candidates += 1;
      patched += 1;
      return `${prefix}process.env.CALICO_MODEL_CONTEXT_WINDOWS?${windowLocal}:${originalReturn}${suffix}`;
    }
  );

  // Same pinned-parameter bug as the resolver above: 2.1.257 renamed them.
  const precomputePattern =
    /(function [A-Za-z_$][\w$]*\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{)(return Math\.min\(\2-Math\.round\(\2\*\3\.precomputeBufferFraction\),([A-Za-z_$][\w$]*)\(\2,\3\)\)\})/g;
  output = output.replace(
    precomputePattern,
    (full, functionStart, modelParam, headersParam, originalBody, percentFn) => {
      candidates += 1;
      patched += 1;
      return `${functionStart}if(process.env.CALICO_MODEL_CONTEXT_WINDOWS)return ${percentFn}(${modelParam},${headersParam});${originalBody}`;
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
      return `context_window:${contextFn}(${usage},globalThis.__calico_display_window(${windowValue})),exceeds_200k_tokens:`;
    }
  );

  return { content: output, candidates, patched };
}

function patchBackgroundAgentUsage(content) {
  const original = content;
  const identifierPattern = "[A-Za-z_$][\\w$]*";
  const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The replacement rewrites this initialiser, so any field upstream adds has to
  // be carried across rather than silently dropped: 2.1.246 appended
  // `seenToolUseIds:new Set`. Capture the trailing fields verbatim. A future
  // field whose value contains braces will fail to match, which reports zero
  // candidates and fails --assert-all rather than quietly discarding state.
  const trackerPattern = new RegExp(
    // Upstream adds fields on both sides of recentActivities, not only after it:
    // 2.1.246 appended `seenToolUseIds:new Set`, and 2.1.257 inserted
    // `streamedTokenEstimate`, `streamedTokenEstimateAtResponseStart` and
    // `lastStampedResponseId` BEFORE it, which a pattern demanding
    // `cumulativeOutputTokens:0,recentActivities:` could not match. Capture both
    // runs of fields and re-emit them verbatim, so anything upstream adds keeps
    // working and nothing is silently dropped from the tracker's state.
    `function (${identifierPattern})\\(\\)\\{return\\{toolUseCount:0,latestInputTokens:0,cumulativeOutputTokens:0((?:,[^{}\\[\\]]*)?),recentActivities:\\[\\]((?:,[^{}]*)?)\\}\\}`,
    "g"
  );
  const totalPattern = new RegExp(
    // 2.1.257 extended the sum with `+e.streamedTokenEstimate`. The name is only
    // captured to build the summary anchor below, so accept further terms.
    `function (${identifierPattern})\\((${identifierPattern})\\)\\{return \\2\\.latestInputTokens\\+\\2\\.cumulativeOutputTokens(?:\\+\\2\\.${identifierPattern})*\\}`,
    "g"
  );
  const accountingPattern = new RegExp(
    // The two assignments are the anchor; whether they stand as their own
    // statement is not. 2.1.257 folded them into the head of an `if(...)` comma
    // expression so it could append its lastStampedResponseId bookkeeping, which
    // took this from a match to none — and with it eventName, progressPattern and
    // everything downstream, since the whole module keys off this one site.
    // Accept either form and stop at the second assignment.
    // Accept either form and capture which one it is. The folded form's trailing
    // `,` belongs to a condition that continues after the match, so the
    // replacement has to re-open the `if(` rather than swallow it — dropping it
    // leaves a dangling `)` and the module stops parsing, which no text-level
    // check notices because every marker is still present.
    `if\\((${identifierPattern})\\.type!=="assistant"\\)return;let (${identifierPattern})=\\1\\.message\\.usage;(if\\()?(${identifierPattern})\\.latestInputTokens=\\2\\.input_tokens\\+\\(\\2\\.cache_creation_input_tokens\\?\\?0\\)\\+\\(\\2\\.cache_read_input_tokens\\?\\?0\\),\\4\\.cumulativeOutputTokens\\+=\\2\\.output_tokens([;,])`,
    "g"
  );
  const trackerMatches = [...content.matchAll(trackerPattern)];
  const totalMatches = [...content.matchAll(totalPattern)];
  const accountingMatches = [...content.matchAll(accountingPattern)];
  const trackerName = trackerMatches[0]?.[1];
  const trackerLeadingFields = trackerMatches[0]?.[2] ?? "";
  const trackerUpstreamFields = trackerMatches[0]?.[3] ?? "";
  const totalName = totalMatches[0]?.[1];
  const accountingMatch = accountingMatches[0];
  const eventVar = accountingMatch?.[1];
  const usageVar = accountingMatch?.[2];
  const accountingIfPrefix = accountingMatch?.[3] ?? "";
  const trackerVar = accountingMatch?.[4];
  const accountingTerminator = accountingMatch?.[5] ?? ";";
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
    `function ${trackerName}(){return{toolUseCount:0,latestInputTokens:0,cumulativeOutputTokens:0${trackerLeadingFields},recentActivities:[]${trackerUpstreamFields},activeMessageId:null,responseOutputTokens:new Map}}`;
  const eventReplacement =
    `if(${eventVar}.type==="stream_event"){if(${eventVar}.event.type==="message_start")${trackerVar}.activeMessageId=${eventVar}.event.message.id,__calicoTrackAgentUsage(${trackerVar},${eventVar}.event.message.usage,${trackerVar}.activeMessageId,!1);else if(${eventVar}.event.type==="message_delta")__calicoTrackAgentUsage(${trackerVar},${eventVar}.event.usage,${trackerVar}.activeMessageId,${eventVar}.event.delta.stop_reason!=null);else if(${eventVar}.event.type==="message_stop")${trackerVar}.activeMessageId=null;return}if(${eventVar}.type!=="assistant")return;let ${usageVar}=${eventVar}.message.usage;__calicoTrackAgentUsage(${trackerVar},${usageVar},${eventVar}.message.id,${eventVar}.message.stop_reason!=null);`;
  const progressReplacement = `${eventName}(${progressMatch[1]},${progressMatch[2]},${progressMatch[3]},${progressMatch[4]}.options.tools),__calicoRefreshAgentUsage(${progressMatch[1]},${completionTranscript}),${progressMatch[5]}(${progressOwner},${summaryName}(${progressMatch[1]}),${progressStatus});`;
  const completionRefresh = `__calicoRefreshAgentUsage(${progressMatch[1]},${completionResult}),${progressMatch[5]}(${progressOwner},${summaryName}(${progressMatch[1]}),${progressStatus});`;

  // Every *Replacement string below interpolates captured minified locals
  // (trackerName, eventVar, usageVar, progressMatch[...], …), so each must
  // reach .replace only via a callback — a plain-string 2nd argument would
  // let `$$`/`$&`/`$1`-`$9` in a captured name expand against these regexes.
  let output = original.replace(trackerPattern, () => trackerReplacement);
  // When the assignments were folded into an `if(`, re-emit that `if(` after our
  // call so the condition it opened — and its closing paren — stay balanced.
  output = output.replace(
    accountingPattern,
    () => `${eventReplacement}${accountingIfPrefix}`
  );
  output = output.replace(progressPattern, () => progressReplacement);
  output = output.replace(
    completionMatch.match[0],
    () => completionMatch.match[0] + completionRefresh
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
  const legacyWrapperPattern = new RegExp(
    `let (${identifierPattern})=\\{message:\\{\\.\\.\\.(${identifierPattern}),content:(${identifierPattern})\\(\\[(${identifierPattern})\\],(${identifierPattern}),(${identifierPattern})\\.agentId,\\{requestId:(${identifierPattern})\\?\\?void 0,messageId:\\2\\.id\\}\\)\\},requestId:\\7\\?\\?void 0,\\.\\.\\.(${identifierPattern})\\(\\6\\.querySource,\\6\\.spawnedBySkill,\\6\\.activeSkill,\\6\\.activeMcpServer,\\6\\.activeMcpTool\\),type:"assistant",uuid:(${identifierPattern})(?:\\.randomUUID)?\\(\\),timestamp:new Date\\(\\)\\.toISOString\\(\\),\\.\\.\\.!1,\\.\\.\\.(${identifierPattern})&&\\{advisorModel:\\10\\}((?:,\\.\\.\\.\\{[^{}]*\\})*)\\};`,
    "g"
  );
  const effortWrapperPattern = new RegExp(
    `let (${identifierPattern})=\\{message:\\{\\.\\.\\.(${identifierPattern}),content:(${identifierPattern})\\(\\[(${identifierPattern})\\],(${identifierPattern}),(${identifierPattern})\\.agentId,\\{requestId:(${identifierPattern})\\?\\?void 0,messageId:\\2\\.id\\}\\)\\},requestId:\\7\\?\\?void 0,\\.\\.\\.(${identifierPattern})\\(\\6\\.querySource,\\6\\.spawnedBySkill,\\6\\.activeSkill,\\6\\.activeMcpServer,\\6\\.activeMcpTool\\),type:"assistant",uuid:(${identifierPattern})(?:\\.randomUUID)?\\(\\),timestamp:new Date\\(\\)\\.toISOString\\(\\),\\.\\.\\.!1,\\.\\.\\.(${identifierPattern})&&\\{advisorModel:\\10\\},\\.\\.\\.(${identifierPattern})!==void 0&&\\{effort:(${identifierPattern})\\}((?:,\\.\\.\\.\\{[^{}]*\\})*)\\};`,
    "g"
  );
  // 2.1.236+: batch tool-use destructuring wraps the content builder. The
  // canonical wrapper is still the one whose content comes from a single
  // bracketed block (`ueo([ia],…)`) and whose message carries no `usage:`;
  // the two fallback sites use `ueo(<var>.content,…)` plus `usage:B5e(…)`
  // and cannot match this shape.
  //
  // 2.1.238 appends a fifth argument to the content builder call
  // (`Gio([Ga],n,i.agentId,{requestId:Te??void 0,messageId:Gr.id},i.storageV5)`),
  // so the trailing `,<identifier-or-member>` is matched optionally to keep both
  // 2.1.237 (no fifth arg) and 2.1.238 (one appended arg) matching, and to
  // tolerate a further appended argument without another edit.
  // 2.1.246 appends `,...{}` after the effort spread. Match any trailing spread
  // entries so the wrapper still matches; the replacement is derived from the
  // matched text, so whatever upstream appended is carried across unchanged.
  // 2.1.251 appends a third argument to the batch content builder itself — a
  // callback, `j2t(Uq([…],o,d.agentId,{…},d.storageV5),o,(a,b)=>p0(a,b,…))` —
  // so the call no longer closes right after the second argument. Accept a
  // trailing argument list, one level of call nesting deep so the callback body
  // does not terminate it early.
  // 2.1.257 stopped placing the message object immediately after the
  // destructuring — it inserts wire-tool-input bookkeeping between them
  // (`$c=Ps?Yxe([Hs]):void 0;YD||=…;let Ay=$c?.inputs,`) — and added
  // `wireToolInputs` and `apiBlockIndex` to the object before `requestId`.
  // Neither is something the replacement needs; both are matched loosely and
  // re-emitted from the matched text, so upstream can keep adding to either
  // position. The bounded `[^{}]` runs keep this from swallowing a whole
  // unrelated object.
  // 2.1.257 stopped placing the message object immediately after the
  // destructuring — it inserts wire-tool-input bookkeeping between them
  // (`$c=Ps?Yxe([Hs]):void 0;YD||=…;let Ay=$c?.inputs,`) — and added
  // `wireToolInputs` and `apiBlockIndex` to the object before `requestId`.
  // Neither is something the replacement needs; both are matched loosely and
  // re-emitted from the matched text, so upstream can keep adding to either
  // position. The bounded runs keep this from swallowing an unrelated object.
  const batchWrapperPattern = new RegExp(
    `let\\{content:(${identifierPattern}),batchToolUses:(${identifierPattern})\\}=(${identifierPattern})\\((${identifierPattern})\\(\\[(${identifierPattern})\\],(${identifierPattern}),(${identifierPattern})\\.agentId,\\{requestId:(${identifierPattern})\\?\\?void 0,messageId:(${identifierPattern})\\.id\\}(?:,${identifierPattern}(?:\\.${identifierPattern})*)?\\),\\6(?:,(?:[^()]|\\([^()]*\\))*)?\\)(?:[^{}]|\\{[^{}]*\\})*?,(${identifierPattern})=\\{message:\\{\\.\\.\\.\\9,content:\\1\\},\\.\\.\\.\\2\\.length>0&&\\{batchToolUses:\\2\\}((?:,[^{}]*(?:\\{[^{}]*\\})?)*?),requestId:\\8\\?\\?void 0,\\.\\.\\.(${identifierPattern})\\(\\7\\.querySource,\\7\\.spawnedBySkill,\\7\\.activeSkill,\\7\\.activeMcpServer,\\7\\.activeMcpTool\\),type:"assistant",uuid:(${identifierPattern})(?:\\.randomUUID)?\\(\\),timestamp:new Date\\(\\)\\.toISOString\\(\\),\\.\\.\\.!1,\\.\\.\\.(${identifierPattern})&&\\{advisorModel:\\14\\},\\.\\.\\.(${identifierPattern})!==void 0&&\\{effort:(${identifierPattern})\\}((?:,\\.\\.\\.\\{[^{}]*\\})*)\\};`,
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
  // The reducer used to be identified at its call site by the name captured at
  // its definition. That stopped working on 2.1.242+: the bundle is split into
  // ES module chunks that import each other under per-chunk aliases, so the
  // statusline function calls the reducer as `Bne` while it is declared as
  // `Eze` elsewhere — and, worse, an unrelated chunk-local `Eze` exists, so
  // minified names are no longer unique across the joined text and pinning one
  // can match the wrong site entirely.
  //
  // Anchor on structure instead: the selector sits immediately after the
  // `<local>=<settings>?.outputStyle||<default>,` assignment in the statusline
  // payload builder, inside the one function that emits `context_window:`, and
  // require exactly one such site. That is weaker than the name equality it
  // replaces — it locates the call rather than proving its callee — but a name
  // captured in another chunk cannot identify anything here, so position plus
  // the surviving `exactly one reducer declaration` gate is what is left.
  const selectorPattern = reducerName
    ? new RegExp(
        `(${identifierPattern}=${identifierPattern}\\?\\.outputStyle\\|\\|[^,]{1,40},)(${identifierPattern})=(${identifierPattern})\\((${identifierPattern})\\),(${identifierPattern})=(${identifierPattern})\\((${identifierPattern}),(${identifierPattern})\\(\\)\\)`,
        "g"
      )
    : null;
  const wrapperMatches = [
    ...[...content.matchAll(legacyWrapperPattern)].map((match) => ({
      match,
      local: match[1],
      effortCondition: null,
      effortProperty: null,
    })),
    ...[...content.matchAll(effortWrapperPattern)].map((match) => ({
      match,
      local: match[1],
      effortCondition: match[11],
      effortProperty: match[12],
    })),
    // Group 11 captures whatever upstream inserts between batchToolUses and
    // requestId (2.1.257: wireToolInputs + apiBlockIndex), which shifts the
    // trailing captures by one.
    ...[...content.matchAll(batchWrapperPattern)].map((match) => ({
      match,
      local: match[10],
      effortCondition: match[15],
      effortProperty: match[16],
    })),
  ];
  const wrapperMatch = wrapperMatches[0];
  const wrapperIndex = wrapperMatch?.match.index ?? -1;
  const wrapperLocal = wrapperMatch?.local;
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
  // 2.1.261 folded the aggregation assignment into the head of an `if`, as the
  // first operand of a comma expression:
  //
  //   2.1.260  case"message_delta":{yc=rY(yc,cl.usage);let Sl=…
  //   2.1.261  case"message_delta":{if(Ml=MY(Ml,La.usage),Rn!==void 0&&…)…
  //
  // The assignment is unchanged; only its surroundings moved. Pinning the `{`
  // and the `;` cost the match, and losing it cascaded — terminalArray then
  // resolved to the clone array, so terminalCommitIsDirect and
  // cloneArrayIsDistinctFromTerminal went false too, and the module bailed with
  // 6 candidates and 0 patched. Accept the optional `if(` and either
  // terminator; everything the aggregation identity rests on is still pinned.
  const aggregationPattern =
    terminalUsage && terminalRawEvent
      ? new RegExp(
          // Paired, not a cross-product. `(?:if\()?…[;,]` would also accept
          // `{X=f(…),` — a form the verifier's prefix check rejects — so the
          // patcher could produce a bundle its own verifier then failed. The
          // two spellings that exist are the statement and the `if` head.
          `case"message_delta":\\{(?:${escapeRegExp(terminalUsage)}=(${identifierPattern})\\(${escapeRegExp(terminalUsage)},${escapeRegExp(terminalRawEvent)}\\.usage\\);|if\\(${escapeRegExp(terminalUsage)}=(${identifierPattern})\\(${escapeRegExp(terminalUsage)},${escapeRegExp(terminalRawEvent)}\\.usage\\),)`,
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
    // Require the selected usage and the computed window to be exactly the two
    // arguments the payload's `context_window:` is built from. This replaces
    // the name equality with the reducer that chunking made uncheckable: it
    // does not prove the callee is the reducer, but it does prove this site's
    // result is what the status line reports, which is what the patch is for.
    const consumption = new RegExp(
      `context_window:${identifierPattern}\\(${escapeRegExp(match[2])},${escapeRegExp(match[5])}\\)`
    );
    return segment.includes("context_window:") && consumption.test(segment);
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
      : content.indexOf("function ", wrapperIndex + wrapperMatch.match[0].length);
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
    wrapperPushPattern.test(
      content.slice(wrapperIndex + (wrapperMatch?.match[0].length ?? 0), terminalIndex)
    );
  // The clone list and the terminal list must not be the same array — writing
  // the terminal commit through the clone registrations would double-apply it.
  // Name inequality was standing in for that, and on 2.1.261 the minifier
  // reused one name in both scopes: `Ac` in a function at 9481073 and `Ac` in
  // another at 8937761, half a megabyte apart. The loops are not even the same
  // shape —
  //
  //   for(let wg of Ac)wg.message.usage=Ml,…
  //   for(let{src:cu,dst:Vf}of Ac)Vf.usage=cu.usage,…
  //
  // one walks items carrying `.message`, the other walks {src,dst} pairs, so
  // they cannot be one array at runtime. Compare the declaring scope instead:
  // the same name in two different functions is two different bindings.
  // The clone list must not be the terminal list: writing the terminal commit
  // through the clone registrations would double-apply it. Name inequality was
  // the proxy for that, and it is not sound. 2.1.261's minifier reused `Ac` for
  // both, so the proxy rejected a bundle that works; three attempts to rescue
  // it with text — comparing enclosing use sites, then requiring a local
  // declaration, then requiring that declaration's block to still be open —
  // each admitted a different false positive, and the last one's premise was
  // wrong on the real bundle anyway: the `let Ac=` it found belongs to a
  // generator that closes before the clone loop. Lexical scope is not
  // recoverable by scanning minified text.
  //
  // So the check moved to where it can actually be decided. tools/local-verify
  // drives the patched binary through a streamed turn; an aliased clone loop
  // throws while destructuring the terminal wrapper, and the harness reports
  // it. That step now runs in CI on every non-Windows leg. Measured on the real
  // 2.1.261: request SENT, assistant text RENDERED, errors none.

  if (
    reducerMatches.length !== 1 ||
    wrapperCount !== 1 ||
    (wrapperMatch.effortCondition !== null &&
      wrapperMatch.effortCondition !== wrapperMatch.effortProperty) ||
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
    !cloneSyncIsDirect
  ) {
    return { content: original, candidates, patched: 0 };
  }

  const predicateHelpers =
    'function __calicoUsageHasAccountingSignal(e){if(!e||typeof e!=="object")return!1;return["input_tokens","output_tokens","cache_creation_input_tokens","cache_read_input_tokens"].some((t)=>typeof e[t]==="number"&&e[t]!==0)}' +
    'function __calicoUsageIsExactAllZero(e){if(!e||typeof e!=="object")return!1;return e.input_tokens===0&&e.output_tokens===0&&(e.cache_creation_input_tokens===void 0||e.cache_creation_input_tokens===0)&&(e.cache_read_input_tokens===void 0||e.cache_read_input_tokens===0)&&(e.cache_creation?.ephemeral_1h_input_tokens===void 0||e.cache_creation?.ephemeral_1h_input_tokens===0)&&(e.cache_creation?.ephemeral_5m_input_tokens===void 0||e.cache_creation?.ephemeral_5m_input_tokens===0)}';
  const accountingHelper =
    predicateHelpers +
    'function __calicoStatuslineMessages(e){if(!Array.isArray(e))return e;return e.flatMap((t)=>{if(t?.type!=="assistant")return[t];let r=t.__calicoUsageState;if(r?.committed===!0&&r.usage)return[{...t,message:{...t.message,usage:r.usage}}];if(r===void 0&&t.message?.stop_reason!=null&&__calicoUsageHasAccountingSignal(t.message?.usage))return[t];return[]})}';
  const wrapperStateNeedle = ",...!1,";
  const wrapperReplacement = wrapperMatch.match[0].replace(
    wrapperStateNeedle,
    ",...!1,__calicoUsageState:{committed:!1,usage:null},"
  );
  if (
    wrapperMatch.match[0].split(wrapperStateNeedle).length - 1 !== 1 ||
    wrapperReplacement === wrapperMatch.match[0]
  ) {
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
  // The reducer is called through whatever local name this chunk imported it
  // under (selectorMatch[3]), not the name captured at its declaration site.
  const selectorReplacement =
    `${selectorMatch[1]}${selectorMatch[2]}=${selectorMatch[3]}(__calicoStatuslineMessages(${selectorMatch[4]}))` +
    `,${selectorMatch[5]}=${selectorMatch[6]}(${selectorMatch[7]},${selectorMatch[8]}())`;

  // wrapperReplacement/terminalReplacement/cloneSyncReplacement interpolate
  // captured minified locals (terminalItem, terminalArray, cloneSyncSource,
  // …); route them through callbacks so a captured `$$`/`$&` cannot expand.
  let output = original.replace(wrapperMatch.match[0], () => wrapperReplacement);
  output = output.replace(terminalPattern, () => terminalReplacement);
  let cloneIndex = 0;
  output = output.replace(cloneRegistrationPattern, () => cloneReplacements[cloneIndex++]);
  output = output.replace(cloneSyncPattern, () => cloneSyncReplacement);

  const selectorOutputMatch = [...output.matchAll(selectorPattern)][0];
  const selectorIndex = selectorOutputMatch?.index ?? -1;
  const functionStart = output.lastIndexOf("function ", selectorIndex);
  if (selectorIndex === -1 || functionStart === -1) {
    return { content: original, candidates, patched: 0 };
  }

  // The terminal-commit loop calls the two predicates from a different Bun
  // chunk than the status-line payload builder that carries the helper block,
  // and neither chunk statically imports the other, so a single shared
  // definition is not reliably evaluated first. Give that site its own copy of
  // the two pure predicates; __calicoStatuslineMessages stays single because it
  // is only called from the selector, in this same function.
  const terminalCommitIndex = output.indexOf(terminalReplacement);
  const terminalHelperStart =
    terminalCommitIndex === -1 ? -1 : output.lastIndexOf("function ", terminalCommitIndex);
  if (terminalHelperStart === -1) {
    return { content: original, candidates, patched: 0 };
  }

  for (const [insertAt, helpers] of [
    [functionStart, accountingHelper],
    [terminalHelperStart, predicateHelpers],
  ].sort((a, b) => b[0] - a[0])) {
    output = output.slice(0, insertAt) + helpers + output.slice(insertAt);
  }
  output = output.replace(selectorPattern, () => selectorReplacement);

  if (
    output.split(wrapperReplacement).length - 1 !== 1 ||
    output.split(terminalReplacement).length - 1 !== 1 ||
    cloneReplacements.some((replacement) => output.split(replacement).length - 1 !== 1) ||
    output.split(cloneSyncReplacement).length - 1 !== 1 ||
    output.split(selectorReplacement).length - 1 !== 1 ||
    output.split("function __calicoUsageHasAccountingSignal").length - 1 !== 2 ||
    output.split("function __calicoUsageIsExactAllZero").length - 1 !== 2 ||
    output.split("function __calicoStatuslineMessages").length - 1 !== 1
  ) {
    return { content: original, candidates, patched: 0 };
  }

  return { content: output, candidates, patched: 6 };
}

// Claude Code's statusline payload builder reads the header-derived rate-limit
// state (five_hour, seven_day, seven_day_overage_included, overage) but projects
// only the first two into the JSON handed to the status line command. The other
// two windows are already parsed from response headers on the same object, so
// forwarding them costs nothing at render time. Upstream labels
// seven_day_overage_included "Fable 5 limit"; overage is the usage-credit window.
// Both keep their upstream key names so a future upstream projection is a
// drop-in replacement for this patch.
// Restore the fullscreen sticky prompt header, which stopped rendering in
// 2.1.247 and is still broken in 2.1.251 (anthropics/claude-code#90299).
//
// Through 2.1.246 the sticky-prompt component read the viewport on every
// render. 2.1.247 rewrote the same reads under compiler-style memoization keyed
// on the viewport HANDLE:
//
//   if(Eo[2]!==ot.handle)iS=ot.handle?.isSticky()??!0,Eo[2]=ot.handle,Eo[3]=iS;else iS=Eo[3];
//
// `ot.handle` keeps the same object identity for the lifetime of the list, so
// each read is evaluated once at mount — while the view is still pinned to the
// bottom, so isSticky() returns true — and that value is reused forever. The
// prompt-scan that fills the header is gated on `!isSticky`, so it never runs.
// getScrollTop and getPendingDelta are frozen on the same key, which also
// freezes the derived offset the scan compares against.
//
// The scroll subscription still triggers re-renders; they just reuse the stale
// cache. The "Jump to bottom" pill is unaffected because it calls
// handle.isSticky() directly inside a callback rather than through the memo,
// which is why scroll state looks correctly detected while the header is blank.
//
// Force the three guards instead of removing the memo: the cache writes stay
// well-formed, the downstream scan memo keyed on the derived offset invalidates
// on its own once these recompute, and the edit is one insertion per site.
// Bundles that never memoized these reads report skipped rather than failing
// --assert-all, since the feature works there without help.
function patchStickyPromptHeader(content) {
  const original = content;
  const identifier = "[A-Za-z_$][\\w$]*";
  const memoizedViewportRead = new RegExp(
    `if\\((${identifier})\\[(\\d+)\\]!==(${identifier})\\.handle\\)(${identifier})=\\3\\.handle\\?\\.(isSticky|getScrollTop|getPendingDelta)\\(\\)\\?\\?(?:!0|0),\\1\\[\\2\\]=\\3\\.handle,\\1\\[(\\d+)\\]=\\4;else \\4=\\1\\[\\6\\];`,
    "g"
  );
  const matches = [...content.matchAll(memoizedViewportRead)];
  const candidates = matches.length;

  if (candidates === 0) {
    return {
      content: original,
      candidates: 0,
      patched: 0,
      skipped: true,
      reason: "viewport reads are not memoized on the handle in this bundle",
    };
  }

  // All three reads belong to one component. Requiring them to share the cache
  // local, the viewport local and the enclosing function is what stops this
  // from forcing a guard in some other memoized component that happens to read
  // a `.handle`.
  const [first] = matches;
  const cacheLocal = first[1];
  const viewportLocal = first[3];
  const kinds = new Set(matches.map((match) => match[5]));
  const functionStarts = new Set(
    matches.map((match) => content.lastIndexOf("function ", match.index ?? -1))
  );
  const owningFunctionStart = functionStarts.values().next().value;
  const owningFunction =
    owningFunctionStart === undefined || owningFunctionStart === -1
      ? ""
      : boundedToModule(content.slice(owningFunctionStart, (first.index ?? 0) + 4000));

  if (
    candidates !== 3 ||
    kinds.size !== 3 ||
    !matches.every((match) => match[1] === cacheLocal && match[3] === viewportLocal) ||
    functionStarts.size !== 1 ||
    owningFunctionStart === -1 ||
    // The component that owns the header publishes it through this setter, and
    // the literal occurs twice in the whole bundle. Nothing weaker identifies
    // the sticky-prompt component; the memo shape alone is a compiler idiom.
    !owningFunction.includes("setStickyPrompt")
  ) {
    return { content: original, candidates, patched: 0 };
  }

  let output = content;
  let patched = 0;
  // Splice from the last match backwards so earlier offsets stay valid.
  for (const match of [...matches].sort((a, b) => (b.index ?? 0) - (a.index ?? 0))) {
    const start = match.index ?? -1;
    if (start === -1 || !output.startsWith("if(", start)) {
      return { content: original, candidates, patched: 0 };
    }
    output = `${output.slice(0, start + 3)}!0||${output.slice(start + 3)}`;
    patched += 1;
  }

  if (output.split("!0||").length - 1 - (content.split("!0||").length - 1) !== 3) {
    return { content: original, candidates, patched: 0 };
  }

  return { content: output, candidates, patched };
}

function patchStatuslineRateLimitWindows(content) {
  const original = content;
  const identifier = "[A-Za-z_$][\\w$]*";
  const window = (local, key) =>
    `...${local}.${key}&&{${key}:{used_percentage:${local}.${key}.utilization*100,resets_at:${local}.${key}.resets_at}}`;

  // Match the projection object by its opening entries only, and find its end
  // by brace matching. 2.1.251 appended a third entry —
  // `...X()==="gateway"&&L.overage&&{spend_limit:{…}}` — so a pattern that
  // required `}` right after seven_day stopped matching and the module went to
  // zero candidates. Enumerating the new entry would only invite the next one,
  // and rewriting the object without it would silently drop an upstream field:
  // capture whatever follows seven_day and re-emit it verbatim.
  const projectionPrefixPattern = new RegExp(
    `\\{\\.\\.\\.(${identifier})\\.five_hour&&\\{five_hour:\\{used_percentage:\\1\\.five_hour\\.utilization\\*100,resets_at:\\1\\.five_hour\\.resets_at\\}\\},\\.\\.\\.\\1\\.seven_day&&\\{seven_day:\\{used_percentage:\\1\\.seven_day\\.utilization\\*100,resets_at:\\1\\.seven_day\\.resets_at\\}\\}`,
    "g"
  );
  // The guard was `(L.five_hour||L.seven_day)` and is `(L.five_hour||
  // L.seven_day||L.spend_limit)` on 2.1.251. The replacement below tests
  // `Object.keys(L).length>0`, which subsumes any number of alternatives, so
  // accept an open-ended chain rather than the exact pair.
  const guardPattern = new RegExp(
    `\\.\\.\\.\\((${identifier})\\.five_hour(?:\\|\\|\\1\\.[\\w$]+)+\\)&&\\{rate_limits:\\1\\}`,
    "g"
  );

  // Expand each prefix match to the full object literal it opens, so the rest
  // of this function can go on treating a projection match as {text, index,
  // local} and additionally knows what trailing entries to carry across.
  const projectionMatches = [...content.matchAll(projectionPrefixPattern)].flatMap((match) => {
    const start = match.index ?? -1;
    const end = start === -1 ? -1 : closingBraceIndex(content, start);
    if (start === -1 || end === -1) {
      return [];
    }
    return [
      {
        text: content.slice(start, end + 1),
        index: start,
        local: match[1],
        // Everything upstream appended after seven_day, closing `}` excluded.
        tail: content.slice(start + match[0].length, end),
      },
    ];
  });
  const guardMatches = [...content.matchAll(guardPattern)];
  const candidates = projectionMatches.length + guardMatches.length;

  if (projectionMatches.length !== 1 || guardMatches.length !== 1) {
    return { content: original, candidates, patched: 0 };
  }

  const projectionLocal = projectionMatches[0].local;
  const guardLocal = guardMatches[0][1];

  // Global counts alone do not prove the two anchors belong to each other: an
  // upstream bundle could carry each shape once in unrelated functions, and
  // rewriting both would widen a guard that never sees the added windows.
  // Two independent ownership proofs, because a minified local name like `P`
  // recurs across functions:
  //   1. both anchors sit inside the same function
  //   2. the projection literal is the initializer of the very local the guard reads
  const projectionIndex = projectionMatches[0].index;
  const guardIndex = guardMatches[0].index ?? -1;
  const projectionFunctionStart =
    projectionIndex === -1 ? -1 : content.lastIndexOf("function ", projectionIndex);
  const guardFunctionStart =
    guardIndex === -1 ? -1 : content.lastIndexOf("function ", guardIndex);
  const sharesPayloadBuilder =
    projectionFunctionStart !== -1 && projectionFunctionStart === guardFunctionStart;
  // `.` is excluded from the boundary class deliberately: without it,
  // `x.A={...projection...}` reads as an assignment to a local named `A`, and
  // the windows would be added to a property while an unrelated local drives
  // the guard. Same boundary as the occurrence test below.
  const projectionAssignsGuardLocal =
    projectionIndex !== -1 &&
    new RegExp(`(?:^|[^\\w$.])${guardLocal}=$`).test(
      content.slice(Math.max(0, projectionIndex - 40), projectionIndex)
    );

  // `function ` does not bound a lexical scope on its own. An arrow callback can
  // hold the projection while the guard sits in the enclosing function with a
  // shadowed local of the same name:
  //   items.map(()=>{let A={...projection...}}); let A=other; return {...guard...}
  // Both lastIndexOf calls land on the enclosing function and the initializer
  // test sees the callback's `A=`, so neither check above rejects it. Walk the
  // text between the anchors instead and require that reaching the guard never
  // closes a bracket it did not open — that is, the guard is reached without
  // leaving the block the projection lives in.
  const projectionEnd =
    projectionIndex === -1 ? -1 : projectionIndex + projectionMatches[0].text.length;
  let leftProjectionScope = projectionEnd === -1 || guardIndex < projectionEnd;
  if (!leftProjectionScope) {
    let depth = 0;
    for (const ch of content.slice(projectionEnd, guardIndex)) {
      if (ch === "{" || ch === "(" || ch === "[") {
        depth += 1;
      } else if (ch === "}" || ch === ")" || ch === "]") {
        depth -= 1;
        if (depth < 0) {
          leftProjectionScope = true;
          break;
        }
      }
    }
  }

  // Every way the guard's local can stop referring to this projection —
  // reassignment, a shadowing `let` in a deeper block, an arrow parameter, a
  // destructuring or catch binding — is a distinct syntactic form, and matching
  // them one at a time only invites the next one. This patcher has no AST to
  // resolve bindings with, so it asks for something stricter and complete
  // instead: the name must not occur between the two anchors at all. If it
  // never appears, it cannot have been rebound or shadowed by any form.
  //
  // Property accesses are excluded, since `x.A` binds nothing. In the bundles
  // this targets the span between the anchors is the remainder of the payload
  // object literal and does not mention the local at all.
  const between = projectionEnd === -1 ? "" : content.slice(projectionEnd, guardIndex);
  const guardLocalOccursBetween = new RegExp(
    `(?:^|[^\\w$.])${guardLocal}(?![\\w$])`
  ).test(between);

  if (
    !sharesPayloadBuilder ||
    !projectionAssignsGuardLocal ||
    leftProjectionScope ||
    guardLocalOccursBetween
  ) {
    return { content: original, candidates, patched: 0 };
  }
  // Carry upstream's trailing entries across verbatim. Rewriting the object
  // without them would silently drop a field the statusline payload is supposed
  // to carry — 2.1.251's `spend_limit` being the first one.
  const projectionTail = projectionMatches[0].tail;
  const projectionReplacement = `{${[
    "five_hour",
    "seven_day",
    "seven_day_overage_included",
    "overage",
  ]
    .map((key) => window(projectionLocal, key))
    .join(",")}${projectionTail}}`;
  const guardReplacement = `...Object.keys(${guardLocal}).length>0&&{rate_limits:${guardLocal}}`;

  // projectionReplacement/guardReplacement interpolate the captured
  // projectionLocal/guardLocal names; use callbacks so a captured `$1`-style
  // name cannot be read back as a backreference against these regexes.
  // Splice by offset rather than String.replace: the matched text is the whole
  // object literal, located by brace matching, and re-searching for it would
  // rewrite the first textual occurrence anywhere in the joined bundle.
  const projectionText = projectionMatches[0].text;
  let output =
    original.slice(0, projectionIndex) +
    projectionReplacement +
    original.slice(projectionIndex + projectionText.length);
  output = output.replace(guardPattern, () => guardReplacement);

  if (
    output.split(projectionReplacement).length - 1 !== 1 ||
    output.split(guardReplacement).length - 1 !== 1
  ) {
    return { content: original, candidates, patched: 0 };
  }

  return { content: output, candidates, patched: 2 };
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
    /([A-Za-z_$][\w$]*)=\{type:"local-jsx",name:"fast",get description\(\)\{return`Toggle fast mode \(\$\{([A-Za-z_$][\w$]*)\(\)\}\)`\},get isHidden\(\)\{return!([A-Za-z_$][\w$]*)\(\)\},argumentHint:"\[on\|off\]",(?:get immediate\(\)\{return [A-Za-z_$][\w$]*\(\)\}|immediate:!0),requires:\{ink:!0\},thinClientDispatch:"control-request"\}/g;
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

  // The interactive and thin handlers used to be required to name the same
  // availability helper and the same unavailable-message helper. On 2.1.242+
  // they live in different chunks and reach those helpers through per-chunk
  // import aliases (2.1.245: `po`/`q` against `a`/`n`), so the names differ
  // while the target is the same and the equality can no longer be evaluated.
  // What still holds is that each handler shape pins the literal
  // "Fast mode is not available" and is required to occur exactly once in the
  // whole bundle, and each site's replacement only re-emits identifiers it
  // captured at that same site, so nothing crosses a chunk scope.
  // local[3]/local[4] are both inside one object literal and stay checkable.
  if (local[3] !== local[4]) {
    return { content: original, candidates, patched: 0 };
  }

  const interactiveStart = interactive.index ?? -1;
  const interactiveEndCandidate = content.indexOf(
    "async function ",
    interactiveStart + interactive[0].length
  );
  const interactiveEnd = interactiveEndCandidate === -1 ? content.length : interactiveEndCandidate;
  // Stop at the chunk the handler lives in. `indexOf("async function ")` walks
  // past the module boundary — on 2.1.250 this segment ran 49KB while the
  // handler was 434 bytes — so every marker below could have been satisfied by
  // an unrelated chunk. It happened to be honest there, which is precisely the
  // kind of luck that stops holding without warning.
  const interactiveSegment = boundedToModule(
    content.slice(interactiveStart, interactiveEnd)
  );
  if (
    interactiveStart === -1 ||
    // What the injection needs is this handler, not the way it used to be
    // recognised. 2.1.251 restructured the body: the `"shortcut"` apply call is
    // gone, on/off now renders a component directly, and `.getAppState` /
    // `.setAppState` moved out entirely — three markers vanished at once and
    // the module went to 0 patched while still finding all 6 candidates. The
    // signature already pins this function hard (three parameters, the
    // availability guard, and the "Fast mode is not available" literal); the
    // picker telemetry event and a component render are what remain
    // characteristic of the interactive path.
    !interactiveSegment.includes("tengu_fast_mode_picker_shown") ||
    // Confirms the interactive handler renders a component. On 2.1.242+ the JSX
    // factory is a destructured local, so match the call-with-props shape
    // instead of a `.jsx(` literal.
    !/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?\([A-Za-z_$][\w$]*,\{[^}]*\}\)/.test(interactiveSegment)
  ) {
    return { content: original, candidates, patched: 0 };
  }

  const thinStart = thin.index ?? -1;
  const thinEndCandidate = content.indexOf("async function ", thinStart + thin[0].length);
  const thinEnd = thinEndCandidate === -1 ? content.length : thinEndCandidate;
  const thinSegment = boundedToModule(content.slice(thinStart, thinEnd));
  if (
    thinStart === -1 ||
    // The thin handler kept its argument parsing across 2.1.251, so its own
    // markers still hold. Both handlers reach the same apply-fast-mode action,
    // but on 2.1.242+ they sit in different chunks and call it through
    // different import aliases, so the names were never comparable anyway.
    !thinSegment.includes(".options.fastMode") ||
    !thinSegment.includes("Unknown argument")
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
  // 2.1.239 appended arguments to the dispatch call
  // (`_0c(K)` became `_0c(K,!1,Date.now(),s)`), which is why this module has
  // applied 0 changes since that release. Accept a trailing argument list, one
  // level of call nesting deep so `Date.now()` does not terminate it early. The
  // record local is still the required first argument.
  const dispatchArguments = "(?:,(?:[^()]|\\([^()]*\\))*)?";
  const awaitedDispatchPattern = new RegExp(
    "\\},\\[,(" +
      identifier +
      ")\\]=await Promise\\.all\\(\\[(?:(?!\\]\\))[\\s\\S])*?,(" +
      identifier +
      ")\\(" +
      dispatchRecordLocal +
      dispatchArguments +
      "\\)\\]\\)",
    "g"
  );
  const awaitedDispatches = [...workerSegment.matchAll(awaitedDispatchPattern)];
  const directDispatchPattern = new RegExp(
    "(" + identifier + ")\\(" + dispatchRecordLocal + dispatchArguments + "\\)",
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
function __calicoGatewayFastApply(e){if(process.env.REMORA_ACTIVE!=="1")return e;let t=__calicoGatewayFastRead(),r={...e};if(t==="on")r.service_tier="priority";else if(t==="off")delete r.service_tier;return r};
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

  // The three consumers of these helpers — the interactive handler, the thin
  // handler and the request extra-body builder — are in three different Bun
  // chunks on 2.1.242+, and none of them statically imports the others, so a
  // single shared definition is not reliably evaluated before it is used. A
  // 2.1.245 build published them on globalThis and died on every request with
  // "globalThis.__calicoGatewayFastApply is not a function". Each consumer
  // therefore gets its own module-scoped copy: the block is self-contained, and
  // the copies reconcile through CALICO_GATEWAY_FAST_STATE_FILE and the state
  // file itself, so whichever runs first creates the state and the rest adopt
  // it. On a pre-2.1.242 monolith all three land in one scope, where repeated
  // function and `var` declarations are legal and Ensure() is idempotent.
  const helperIndexes = [interactiveReplacement, thinReplacement, builderReplacement].map(
    (replacement) => output.indexOf(replacement)
  );
  if (helperIndexes.some((index) => index === -1)) {
    return { content: original, candidates, patched: 0 };
  }
  // Insert from the last offset backwards so the earlier offsets stay valid.
  for (const helperIndex of [...helperIndexes].sort((a, b) => b - a)) {
    output = output.slice(0, helperIndex) + helperBlock + output.slice(helperIndex);
  }

  if (
    output.split("function __calicoGatewayFastEnsure").length - 1 !== 3 ||
    output.split("function __calicoGatewayFastParse").length - 1 !== 3 ||
    output.split("function __calicoGatewayFastCommandValue").length - 1 !== 3 ||
    output.split("function __calicoGatewayFastApply").length - 1 !== 3 ||
    output.split('if(process.env.REMORA_ACTIVE==="1")return __calicoGatewayFastInteractive').length - 1 !== 1 ||
    output.split('if(process.env.REMORA_ACTIVE==="1")return __calicoGatewayFastThin').length - 1 !== 1 ||
    output.split(`CALICO_GATEWAY_FAST_STATE_FILE:${worker[1]}.CALICO_GATEWAY_FAST_STATE_FILE`).length - 1 !== 1 ||
    output.split(`${builder[4]}=__calicoGatewayFastApply(${builder[4]});`).length - 1 !== 1
  ) {
    return { content: original, candidates, patched: 0 };
  }

  return { content: output, candidates, patched: 6 };
}
// The Anthropic client factory is the shared anchor for active-turn identity,
// compact-request-source and compact-body-policy. All three recognise it by the
// session-id entry in the header object it builds.
//
// 2.1.248 hoisted that header's name into a module-level constant, so the key
// went from the literal `"X-Claude-Code-Session-Id":` to a computed `[DDe]:`.
// The constant is a per-chunk minified name and is not unique across chunks —
// in 2.1.248 the same `DDe` also names `4*ODe` and `$d[9]` elsewhere — so match
// the key's shape rather than its name, and keep accepting the literal so older
// bundles still patch.
const SESSION_ID_HEADER_KEY =
  '(?:"X-Claude-Code-Session-Id"|\\[[A-Za-z_$][\\w$]*\\])';

// `<session-id key>:<fn>(),...<custom headers>,` — the entry every one of the
// three modules keys off, and the position each of them injects after.
const SESSION_ID_HEADER_ENTRY = new RegExp(
  `${SESSION_ID_HEADER_KEY}:[A-Za-z_$][\\w$]*\\(\\),\\.\\.\\.[A-Za-z_$][\\w$]*,`
);

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
  const legacyPromptGetterMatch = output.match(
    /function ([A-Za-z_$][\w$]*)\(\)\{return ([A-Za-z_$][\w$]*)\.promptId\}function [A-Za-z_$][\w$]*\(e\)\{\2\.promptId=e\}/
  );
  // 2.1.242 chunking turned the module-level journal singleton into a lazy
  // accessor call, so the receiver went from `br.requestJournal.` to
  // `n().requestJournal.`. Accept either an identifier or a no-argument call as
  // the head of the accessor chain; the backreference still pins the getter and
  // setter to the same receiver expression.
  const journalPromptGetterMatch = output.match(
    /function ([A-Za-z_$][\w$]*)\(\)\{return ((?:[A-Za-z_$][\w$]*\(\)|[A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)*\.)promptId\(\)\}function [A-Za-z_$][\w$]*\(e\)\{\2replacePromptId\(e\)\}/
  );
  if (!legacyPromptGetterMatch && !journalPromptGetterMatch) {
    return { content: original, candidates: 0, patched: 0 };
  }
  const promptGetterMatch = legacyPromptGetterMatch ?? journalPromptGetterMatch;
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

  // Both helpers are discovered at their definition sites and called from two
  // other sites, and upstream 2.1.242+ puts all three in different Bun chunks
  // (the getter, the AsyncLocalStorage entry point and the client factory land
  // in separate chunks on 2.1.245). Chunks are separate ES module scopes that
  // import each other under per-chunk aliases, so emitting the captured local
  // name at another site references an identifier that does not exist there —
  // and, because the prompt-getter call sits behind the REMORA_ACTIVE gate,
  // neither the PTY smoke test nor the --print E2E test would reach it.
  // Publish both through globalThis at their definition sites and call them
  // through globalThis everywhere else, which also brings them under
  // native-bun's module-scope guard.
  const publish = (matchedText, globalName, localName) => {
    if (output.includes(`globalThis.${globalName}=`)) {
      return;
    }
    // matchedText and localName are minified names that may contain `$`, which
    // String.replace would expand in a plain replacement string.
    output = output.replace(
      matchedText,
      () => `${matchedText}globalThis.${globalName}=${localName};`
    );
  };
  publish(promptGetterMatch[0], "__calicoPromptIdGet", promptGetter);
  publish(sourceClassifierMatch[0], "__calicoQuerySource", sourceClassifier);
  const promptGetterCall = "globalThis.__calicoPromptIdGet()";
  const querySourceRef = "globalThis.__calicoQuerySource";

  // Every spawned agent enters the same AsyncLocalStorage boundary. Freeze
  // the current prompt id there so a background agent keeps its spawning turn
  // even after the main session accepts another user prompt.
  // The two parameters were pinned as the literals `e` and `t`, and the injected
  // code emitted `e` verbatim. Those are minified names, not fixed syntax: 2.1.257
  // renamed the second one to `n` and this matcher stopped matching, taking the
  // module to 1 candidate / 0 patched. Capture both and emit the captures.
  const agentContextPattern =
    /(function [A-Za-z_$][\w$]*\()([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)(\)\{return )([A-Za-z_$][\w$]*)\.run\(\2,\3\)(\}function [A-Za-z_$][\w$]*\(\)\{return\{agentType:"main",agentId:)/g;
  output = output.replace(
    agentContextPattern,
    (full, prefix, contextParam, callbackParam, open, storage, suffix) => {
      agentCandidates += 1;
      agentPatched += 1;
      return `${prefix}${contextParam},${callbackParam}${open}${contextParam}&&process.env.REMORA_ACTIVE==="1"&&${contextParam}.__calicoPromptId===void 0&&(${contextParam}.__calicoPromptId=${storage}.getStore()?.__calicoPromptId??${promptGetterCall}),${storage}.run(${contextParam},${callbackParam})${suffix}`;
    }
  );
  const attributedAgentContextPattern =
    /(function [A-Za-z_$][\w$]*\()([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)(\)\{)(if\(!\("turnAttributionKey"in \2\)\)\2\.turnAttributionKey=[A-Za-z_$][\w$]*\(\);return )([A-Za-z_$][\w$]*)(\.run\(\2,\(\)=>[A-Za-z_$][\w$]*\(\2\.turnAttributionKey,\3\)\))(\}function [A-Za-z_$][\w$]*\(\)\{return\{agentType:"main",agentId:)/g;
  output = output.replace(
    attributedAgentContextPattern,
    (full, prefix, contextParam, callbackParam, open, attribution, storage, run, suffix) => {
      agentCandidates += 1;
      agentPatched += 1;
      return `${prefix}${contextParam},${callbackParam}${open}${contextParam}&&process.env.REMORA_ACTIVE==="1"&&${contextParam}.__calicoPromptId===void 0&&(${contextParam}.__calicoPromptId=${storage}.getStore()?.__calicoPromptId??${promptGetterCall});${attribution}${storage}${run}${suffix}`;
    }
  );

  // Add a versioned, Calico-owned header only inside a remora child process.
  // Main-session requests use the live prompt id; agent requests prefer the
  // value frozen at their AsyncLocalStorage entry point.
  const clientStartPattern =
    /async function [A-Za-z_$][\w$]*\(\{apiKey:[A-Za-z_$][\w$]*,maxRetries:[A-Za-z_$][\w$]*,model:[A-Za-z_$][\w$]*,fetchOverride:([A-Za-z_$][\w$]*),source:([A-Za-z_$][\w$]*),agentContext:([A-Za-z_$][\w$]*)(?:,[A-Za-z_$][\w$]*:[A-Za-z_$][\w$]*)*\}\)\{/g;
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
      !SESSION_ID_HEADER_ENTRY.test(segment) ||
      !segment.includes('"x-claude-code-agent-id"') ||
      segment.includes('"x-calico-active-turn-version"')
    ) {
      continue;
    }

    // 2.1.238 appends `,credentials:s` to the parameter object, which consumes
    // the `s` binding and shifts every following minified local by one letter
    // (2.1.237 `c=…,u=…,p={` → 2.1.238 `u=…,d=…,f={`, and the header spread
    // `...u,` → `...d,`). Capture the three local names and the extra-header
    // spread name instead of pinning `c`/`u`/`p`/`u`, so a future rename does
    // not silently drop this site.
    const sourceParam = clientStartMatch[2];
    const contextParam = clientStartMatch[3];
    const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const contextRe = escapeRegExp(contextParam);
    const localsPattern = new RegExp(
      `,([A-Za-z_$][\\w$]*)=([A-Za-z_$][\\w$]*)\\(${contextRe}\\)\\?void 0:${contextRe},([A-Za-z_$][\\w$]*)=([A-Za-z_$][\\w$]*)\\(\\),([A-Za-z_$][\\w$]*)=\\{`
    );
    const localsMatch = segment.match(localsPattern);
    if (!localsMatch) {
      continue;
    }
    const contextLocal = localsMatch[1];
    const sanitizer = localsMatch[2];
    const extraHeadersLocal = localsMatch[3];
    const extraHeadersFactory = localsMatch[4];
    const headerObjectLocal = localsMatch[5];

    // This replacement interpolates sourceParam, contextParam, contextLocal,
    // sourceClassifier, promptGetter, and the other captured locals above —
    // all minified names that may legally contain `$`. localsPattern is a
    // regex with 5 capture groups, so a captured name like `$1e` would be
    // read back as a backreference if passed as a plain string; go through a
    // callback so it is emitted verbatim instead.
    let nextSegment = segment.replace(
      localsPattern,
      () =>
        `,${contextLocal}=${sanitizer}(${contextParam})?void 0:${contextParam},__calicoActiveTurnAdapter="calico-active-turn-adapter:v1",__calicoQueryKind=${querySourceRef}(${sourceParam}),__calicoPromptId=process.env.REMORA_ACTIVE==="1"&&(__calicoQueryKind==="main"||__calicoQueryKind==="subagent")?(${contextLocal}?.__calicoPromptId??${promptGetterCall}):void 0,${extraHeadersLocal}=${extraHeadersFactory}(),${headerObjectLocal}={`
    );
    nextSegment = nextSegment.replace(
      new RegExp(
        `(${SESSION_ID_HEADER_KEY}:[A-Za-z_$][\\w$]*\\(\\),)(\\.\\.\\.${escapeRegExp(extraHeadersLocal)},)`
      ),
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

// Mark Claude Code compact requests for remora gateways. Independent of
// active-turn identity: only fires when the query source is the literal
// string "compact" and REMORA_ACTIVE=1. Does not rewrite body effort/model.
// Strips any case-variant of x-calico-request-source from custom headers
// before Calico owns the lowercase value (ANTHROPIC_CUSTOM_HEADERS may set it).
function patchCompactRequestSource(content) {
  const original = content;
  if (content.includes("function __calicoOmitHeader")) {
    // Allow re-entry only when the compact gate is already present (idempotent).
    if (content.includes('"x-calico-request-source":"compact"')) {
      return { content: original, candidates: 0, patched: 0 };
    }
  }
  let candidates = 0;
  let patched = 0;
  let output = content;

  const omitHelper = String.raw`function __calicoOmitHeader(e,t){if(!e||typeof e!=="object"||Array.isArray(e))return e;let r={},n=String(t).toLowerCase();for(let o of Object.keys(e))if(String(o).toLowerCase()!==n)r[o]=e[o];return r}
`;

  // Same Zie-shaped client factory active-turn targets: owns source + agentContext.
  const clientStartPattern =
    /async function [A-Za-z_$][\w$]*\(\{apiKey:[A-Za-z_$][\w$]*,maxRetries:[A-Za-z_$][\w$]*,model:[A-Za-z_$][\w$]*,fetchOverride:([A-Za-z_$][\w$]*),source:([A-Za-z_$][\w$]*),agentContext:([A-Za-z_$][\w$]*)(?:,[A-Za-z_$][\w$]*:[A-Za-z_$][\w$]*)*\}\)\{/g;
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
      !SESSION_ID_HEADER_ENTRY.test(segment) ||
      segment.includes('"x-calico-request-source"')
    ) {
      continue;
    }

    candidates += 1;
    // On every remora request, strip any case-variant of the Calico-owned
    // request-source header from custom headers so ANTHROPIC_CUSTOM_HEADERS
    // cannot spoof compact. Re-add the lowercase value only for true compact.
    // Single let-binding only — reassignment would be a SyntaxError in `let`.
    // 2.1.238's `credentials:s` rename shifts the extra-header local and the
    // header-object local (2.1.237 `u=…(),p={` → 2.1.238 `d=…(),f={`), so both
    // names are captured. The IIFE parameter stays the literal `u` regardless,
    // because the wrap-needle lookup below matches on `((u)=>…`.
    let nextSegment = segment.replace(
      /,([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\),([A-Za-z_$][\w$]*)=\{/,
      (full, extraLocal, factory, headerLocal) =>
        `,${extraLocal}=((u)=>process.env.REMORA_ACTIVE==="1"?__calicoOmitHeader(u,"x-calico-request-source"):u)(${factory}()),${headerLocal}={`
    );
    // Inject after Session-Id + custom-header spread (...u,). Works with or
    // without a subsequent active-turn __calicoPromptId spread.
    const sourceParam = clientStartMatch[2];
    // sourceParam is a captured minified local, so it may itself begin with
    // `$1` (or contain any `$` sequence). This regex has one capture group,
    // so a plain-string replacement would let `$1`-in-sourceParam expand as
    // a backreference to the entire matched header prefix instead of naming
    // the source param — go through a callback so the capture is threaded
    // explicitly and sourceParam is emitted verbatim.
    nextSegment = nextSegment.replace(
      new RegExp(`(${SESSION_ID_HEADER_ENTRY.source})`),
      (_full, headerPrefix) =>
        `${headerPrefix}...process.env.REMORA_ACTIVE==="1"&&${sourceParam}==="compact"&&{"x-calico-request-source":"compact"},`
    );
    if (nextSegment === segment) {
      continue;
    }

    patched += 1;
    output = output.slice(0, start) + nextSegment + output.slice(end);
    clientStartPattern.lastIndex = start + nextSegment.length;
  }

  if (candidates !== 1 || patched !== 1) {
    return { content: original, candidates, patched: 0 };
  }

  const wrapNeedle =
    '((u)=>process.env.REMORA_ACTIVE==="1"?__calicoOmitHeader(u,"x-calico-request-source"):u)';
  const wrapIndex = output.indexOf(wrapNeedle);
  if (wrapIndex === -1) {
    return { content: original, candidates, patched: 0 };
  }
  const fnStart = output.lastIndexOf("async function ", wrapIndex);
  if (fnStart === -1) {
    return { content: original, candidates, patched: 0 };
  }
  if (!output.includes("function __calicoOmitHeader")) {
    output = output.slice(0, fnStart) + omitHelper + output.slice(fnStart);
  }

  if (
    output.split("function __calicoOmitHeader").length - 1 !== 1 ||
    output.split('"x-calico-request-source":"compact"').length - 1 !== 1
  ) {
    return { content: original, candidates, patched: 0 };
  }

  return { content: output, candidates, patched };
}

// Remora compact product policy: when source==="compact" and REMORA_ACTIVE=1,
// wrap the Anthropic client fetchOverride so the full request JSON body is
// rewritten (effort/optional thinking disable/optional model) before leave.
// Config via env: CALICO_COMPACT_EFFORT (default medium), CALICO_COMPACT_MODEL
// (optional, empty keeps session model), CALICO_COMPACT_DISABLE_THINKING
// (default off; set "1" to force thinking disabled).
function patchCompactBodyPolicy(content) {
  const original = content;
  if (content.includes("function __calicoCompactWrapFetch")) {
    return { content: original, candidates: 0, patched: 0 };
  }

  const helperBlock = String.raw`function __calicoCompactPolicy(){let e=process.env.CALICO_COMPACT_EFFORT,t=process.env.CALICO_COMPACT_MODEL,r=process.env.CALICO_COMPACT_DISABLE_THINKING;return{effort:e&&String(e).trim()!==""?String(e).trim():"medium",model:t&&String(t).trim()!==""?String(t).trim():"",disableThinking:r==="1"}}
function __calicoCompactRewriteBodyString(e){if(typeof e!=="string"||!e)return e;let t;try{t=JSON.parse(e)}catch{return e}if(!t||typeof t!=="object"||Array.isArray(t))return e;let r=__calicoCompactPolicy();if(r.model)t.model=r.model;if(r.effort){if(t.output_config&&typeof t.output_config==="object")t.output_config={...t.output_config,effort:r.effort};else t.output_config={effort:r.effort};if(Object.prototype.hasOwnProperty.call(t,"effort"))t.effort=r.effort}if(r.disableThinking&&t.thinking!=null)t.thinking={type:"disabled"};return JSON.stringify(t)}
function __calicoCompactWrapFetch(e){let t=typeof e==="function"?e:typeof globalThis.fetch==="function"?globalThis.fetch.bind(globalThis):null;if(typeof t!=="function")return e;return function(r,n){if(n&&typeof n.body==="string"){let o=__calicoCompactRewriteBodyString(n.body);if(o!==n.body){n={...n,body:o};n.headers=__calicoCompactStripContentLength(n.headers)}}return t(r,n)}}
function __calicoCompactStripContentLength(e){if(e==null)return e;if(typeof Headers==="function"&&e instanceof Headers){let t=new Headers(e);t.delete("content-length");return t}if(Array.isArray(e))return e.filter((t)=>!(Array.isArray(t)&&t.length>0&&String(t[0]).toLowerCase()==="content-length"));if(typeof e==="object"){if(typeof e.delete==="function"){try{e.delete("content-length");e.delete("Content-Length");return e}catch{}}let t={...e};for(let r of Object.keys(t))if(String(r).toLowerCase()==="content-length")delete t[r];return t}return e}
`;

  let candidates = 0;
  let patched = 0;
  let injectedWrap = null;
  let output = content;

  // Same Zie-shaped client factory: wrap fetchOverride when this client is for compact.
  const clientStartPattern =
    /async function [A-Za-z_$][\w$]*\(\{apiKey:[A-Za-z_$][\w$]*,maxRetries:[A-Za-z_$][\w$]*,model:[A-Za-z_$][\w$]*,fetchOverride:([A-Za-z_$][\w$]*),source:([A-Za-z_$][\w$]*),agentContext:([A-Za-z_$][\w$]*)(?:,[A-Za-z_$][\w$]*:[A-Za-z_$][\w$]*)*\}\)\{/g;
  let clientStartMatch;
  while ((clientStartMatch = clientStartPattern.exec(output)) !== null) {
    const start = clientStartMatch.index;
    const openEnd = start + clientStartMatch[0].length;
    const nextAsyncFunction = output.indexOf("async function ", openEnd);
    const end = nextAsyncFunction === -1 ? output.length : nextAsyncFunction;
    const segment = output.slice(start, end);
    if (
      !SESSION_ID_HEADER_ENTRY.test(segment) ||
      segment.includes("__calicoCompactWrapFetch(")
    ) {
      continue;
    }

    candidates += 1;
    const fetchOverrideParam = clientStartMatch[1];
    const sourceParam = clientStartMatch[2];
    const inject =
      `if(process.env.REMORA_ACTIVE==="1"&&${sourceParam}==="compact"){${fetchOverrideParam}=__calicoCompactWrapFetch(${fetchOverrideParam})}`;
    const nextSegment =
      clientStartMatch[0] + inject + segment.slice(clientStartMatch[0].length);
    if (nextSegment === segment) {
      continue;
    }

    patched += 1;
    injectedWrap = inject;
    output = output.slice(0, start) + nextSegment + output.slice(end);
    clientStartPattern.lastIndex = start + nextSegment.length;
  }

  if (candidates !== 1 || patched !== 1 || injectedWrap === null) {
    return { content: original, candidates, patched: 0 };
  }

  // Inject helpers once immediately before the patched Zie factory. The wrap
  // needle carries the captured source/fetchOverride locals for this bundle.
  const wrapNeedle = injectedWrap;
  const wrapIndex = output.indexOf(wrapNeedle);
  if (wrapIndex === -1) {
    return { content: original, candidates, patched: 0 };
  }
  // Find the start of the async function that contains the wrap.
  const fnStart = output.lastIndexOf("async function ", wrapIndex);
  if (fnStart === -1) {
    return { content: original, candidates, patched: 0 };
  }
  output = output.slice(0, fnStart) + helperBlock + output.slice(fnStart);

  if (
    output.split("function __calicoCompactPolicy").length - 1 !== 1 ||
    output.split("function __calicoCompactRewriteBodyString").length - 1 !== 1 ||
    output.split("function __calicoCompactWrapFetch").length - 1 !== 1 ||
    output.split("function __calicoCompactStripContentLength").length - 1 !== 1 ||
    output.split(wrapNeedle).length - 1 !== 1
  ) {
    return { content: original, candidates, patched: 0 };
  }

  return { content: output, candidates, patched };
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
    id: "compact-request-source",
    description: "Mark Claude compact queries with x-calico-request-source for remora gateways",
    apply: patchCompactRequestSource,
  },
  {
    id: "compact-body-policy",
    description:
      "Rewrite compact request body effort/thinking/model via fetchOverride wrap under remora",
    apply: patchCompactBodyPolicy,
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
    id: "statusline-rate-limit-windows",
    description: "Forward Fable 5 and usage-credit rate-limit windows to statusline payloads",
    apply: patchStatuslineRateLimitWindows,
  },
  {
    id: "sticky-prompt-header",
    description: "Restore the fullscreen sticky prompt header frozen by handle-keyed memoization",
    apply: patchStickyPromptHeader,
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
    id: "disable-usage-wrapup",
    description: "Disable near-limit / grace-window wrap-up prompt injection",
    apply: patchDisableUsageWrapUpHints,
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

function patchContents(contents, opts = {}) {
  const { selected } = resolveSelectedPatchIds({
    disable: opts.disable ?? [],
    enable: opts.enable ?? [],
  });
  let currentContents = [...contents];
  const patchResults = new Map();

  for (const module of PATCH_MODULES) {
    if (!selected.has(module.id)) {
      patchResults.set(module.id, {
        candidates: 0,
        patched: 0,
        skipped: true,
        reason: "disabled",
      });
      continue;
    }

    let candidates = 0;
    let patched = 0;
    currentContents = currentContents.map((content) => {
      const result = module.apply(content, { preserveLength: false });
      candidates += result.candidates;
      patched += result.patched;
      return result.content;
    });
    patchResults.set(module.id, {
      candidates,
      patched,
      skipped: false,
      reason: null,
    });
  }

  return { contents: currentContents, patchResults };
}

function printPatchSummary(patchResults) {
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
      // A module may report an expected no-op (e.g. the target feature does
      // not exist in this bundle version) as skipped so --assert-all treats
      // it like a disabled module instead of a matcher failure.
      skipped: result.skipped === true,
      reason: result.skipped === true ? result.reason ?? "not applicable" : null,
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
  patchDisableUsageWrapUpHints,
  patchStickyPromptHeader,
  patchGatewayFastMode,
  patchActiveTurnPromptIdentity,
  patchCompactRequestSource,
  patchCompactBodyPolicy,
  patchBackgroundAgentUsage,
  patchStatuslineCommittedUsage,
  patchStatuslineRateLimitWindows,
  patchCustomContextWindows,
  // Exported for tests: the positional stream-reducer branch is only reachable
  // on older bundle shapes, so nothing else exercises it.
  patchThinkingStreaming,
};

if (require.main === module) {
  main();
}

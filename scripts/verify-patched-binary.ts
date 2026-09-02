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
  // For custom checks: a marker that must be absent when the module is disabled.
  disabledMarker?: RegExp | string;
  // For custom checks: return null on success, or a failure detail string.
  run?: (content: string) => string | null;
  describe: string;
};

// A minified name captured at one site is only comparable at another when both
// sites are in the same Bun module: 2.1.242+ splits the bundle into ES module
// chunks that import each other under per-chunk aliases, so the same helper is
// `po` in one chunk and `a` in the next. The joined text carries the module
// boundaries, so cross-site name equalities stay enforced wherever they are
// still meaningful and are skipped only where the names cannot match by
// construction. On a pre-2.1.242 monolith every gateway site is in the cli
// module, so every equality below applies exactly as it did before.
const { BUN_MODULE_BOUNDARY } = require("./native-bun.ts") as { BUN_MODULE_BOUNDARY: string };

// Truncate a segment at the first Bun module boundary it contains. Segments cut
// with `indexOf("async function ")` routinely run past the end of their chunk,
// so a marker required of one handler can be satisfied by an entirely different
// module. Mirrors boundedToModule in patch-claude-display.ts — the patcher
// bounding its segments while the verifier did not is how a handler missing a
// required invariant could still verify clean.
function boundedToModule(segment: string): string {
  const boundary = segment.indexOf(BUN_MODULE_BOUNDARY);
  return boundary === -1 ? segment : segment.slice(0, boundary);
}

function inSameModule(content: string, first: number, second: number): boolean {
  if (first < 0 || second < 0) {
    return false;
  }
  const [low, high] = first <= second ? [first, second] : [second, first];
  return !content.slice(low, high).includes(BUN_MODULE_BOUNDARY);
}

// The session-id entry in the Anthropic client's header object is the anchor
// the active-turn and compact-request-source injections sit behind. 2.1.248
// hoisted the header's name into a module-level constant, turning the literal
// key `"X-Claude-Code-Session-Id":` into a computed `[DDe]:`; that constant is
// a per-chunk minified name that means something else in other chunks, so match
// the key's shape, not its name. Kept in lockstep with SESSION_ID_HEADER_KEY in
// patch-claude-display.ts.
const SESSION_ID_HEADER_KEY =
  '(?:"X-Claude-Code-Session-Id"|\\[[A-Za-z_$][\\w$]*\\])';

// Kept in lockstep with the identically named helpers in
// patch-claude-display.ts: the guard that owns a statement is the `if(` whose
// condition closes immediately before it, not whichever `if(` is nearest.
function closingParenIndex(text: string, openIndex: number): number {
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

function closingBraceIndex(text: string, openIndex: number): number {
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

function owningGuardIndex(text: string, statementIndex: number): number {
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

// Cross-chunk references through globalThis are only safe when the chunk doing
// the reading statically imports (transitively) the chunk doing the writing:
// only then is the publisher guaranteed to have been evaluated first. Of 1,384
// modules in 2.1.245, exactly 8 are statically reachable from the cli entry —
// everything else arrives through dynamic import — so "it will have been
// evaluated by then" is never a safe assumption. A build that published the
// gateway helpers from an unreachable chunk threw
// "globalThis.__calicoGatewayFastApply is not a function" on every request and
// produced no output at all, while every other check here passed.
function unreachableGlobalPublications(content: string, moduleNames: string[]): string[] {
  const modules = content.split(BUN_MODULE_BOUNDARY);
  if (modules.length < 2 || modules.length !== moduleNames.length) {
    return [];
  }

  const indexByName = new Map(moduleNames.map((name, index) => [name, index]));
  const staticImportPattern = /import\s*(?:[^"';]*?from\s*)?"([^"]+\.js)"/g;
  const dynamicImportPattern = /import\("([^"]+\.js)"\)/g;

  const staticEdges = modules.map((module) => {
    const dynamic = new Set(
      Array.from(module.matchAll(dynamicImportPattern), (match) => match[1])
    );
    return Array.from(
      new Set(Array.from(module.matchAll(staticImportPattern), (match) => match[1]))
    )
      .filter((target) => !dynamic.has(target))
      .map((target) => indexByName.get(target))
      .filter((index): index is number => index !== undefined);
  });

  const closures = new Map<number, Set<number>>();
  const closureOf = (start: number): Set<number> => {
    const cached = closures.get(start);
    if (cached) {
      return cached;
    }
    const seen = new Set([start]);
    const stack = [start];
    while (stack.length > 0) {
      for (const next of staticEdges[stack.pop() as number]) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    closures.set(start, seen);
    return seen;
  };

  const publisherPattern = /globalThis\.((?:__calico|__cc_)[\w$]*)\s*=/g;
  const publishers = new Map<string, number>();
  modules.forEach((module, index) => {
    for (const match of module.matchAll(publisherPattern)) {
      publishers.set(match[1], index);
    }
  });

  const problems: string[] = [];
  for (const [name, publisher] of publishers) {
    modules.forEach((module, index) => {
      const uses = countOccurrences(module, `globalThis.${name}`);
      const declares = countOccurrences(module, `globalThis.${name}=`);
      if (uses - declares <= 0 || closureOf(index).has(publisher)) {
        return;
      }
      problems.push(
        `${name} is read in ${moduleNames[index]} but published in ${moduleNames[publisher]}, ` +
          "which that module does not statically import, so it may not be evaluated first"
      );
    });
  }
  return problems;
}

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

function disabledMarkerForCheck(check: Check): RegExp | string | undefined {
  return check.disabledMarker ?? (check.kind === "presence" ? check.marker : undefined);
}

const CHECKS: Check[] = [
  {
    id: "gateway-fast-mode",
    kind: "custom",
    describe: "remora gateway priority mode with shared request-time worker state",
    run: (content: string): string | null => {
      const identifier = "[A-Za-z_$][\\w$]*";
      const nodeDeclaration =
        'var __calicoGatewayFastNode={fs:process.getBuiltinModule("fs"),path:process.getBuiltinModule("path"),os:process.getBuiltinModule("os"),crypto:process.getBuiltinModule("crypto")};';
      const stateDeclaration =
        "var __calicoGatewayFastState={path:null,dir:null,owner:!1};";
      const applyHelper =
        'function __calicoGatewayFastApply(e){if(process.env.REMORA_ACTIVE!=="1")return e;let t=__calicoGatewayFastRead(),r={...e};if(t==="on")r.service_tier="priority";else if(t==="off")delete r.service_tier;return r};';

      // One self-contained copy per consuming chunk. The interactive handler,
      // the thin handler and the request extra-body builder are in three Bun
      // chunks that do not import one another, so a single shared definition is
      // not reliably evaluated before it is used: a 2.1.245 build that shared
      // them through globalThis threw "globalThis.__calicoGatewayFastApply is
      // not a function" on every request. The copies reconcile at runtime
      // through CALICO_GATEWAY_FAST_STATE_FILE.
      const blockCount = 3;
      const blockStarts: number[] = [];
      for (let at = content.indexOf(nodeDeclaration); at !== -1; ) {
        blockStarts.push(at);
        at = content.indexOf(nodeDeclaration, at + nodeDeclaration.length);
      }
      if (
        blockStarts.length !== blockCount ||
        countOccurrences(content, stateDeclaration) !== blockCount ||
        countOccurrences(content, applyHelper) !== blockCount
      ) {
        return `expected ${blockCount} gateway helper blocks, one per consuming chunk`;
      }

      const blocks = blockStarts.map((at) => {
        const applyAt = content.indexOf(applyHelper, at);
        return applyAt === -1 ? "" : content.slice(at, applyAt + applyHelper.length);
      });
      if (blocks.some((block) => block === "")) {
        return "a gateway helper block is missing its request helper";
      }
      if (blocks.some((block) => block !== blocks[0])) {
        return "gateway helper blocks are not identical copies";
      }
      // Each block must sit immediately before the function that uses it, so a
      // detached or commented-out copy fails here.
      for (const [index, at] of blockStarts.entries()) {
        const after = content.slice(at + blocks[index].length).replace(/^\n/, "");
        if (!after.startsWith("function ") && !after.startsWith("async function ")) {
          return "a gateway helper block is commented, detached, or followed by alternate code";
        }
      }
      const helperBlock = blocks[0];

      // Per-block reference counts, plus the one external call site each of the
      // three entry points has. Deriving the totals this way keeps the original
      // no-stray-reference strength while staying copy-count agnostic.
      const expectedReferences: Array<[string, number, number]> = [
        ["__calicoGatewayFastNode", 4, 0],
        ["__calicoGatewayFastState", 10, 0],
        ["__calicoGatewayFastEnsure", 4, 0],
        ["__calicoGatewayFastRead", 3, 0],
        ["__calicoGatewayFastParse", 2, 0],
        ["__calicoGatewayFastTier", 3, 0],
        ["__calicoGatewayFastRestore", 2, 0],
        ["__calicoGatewayFastPublish", 2, 0],
        ["__calicoGatewayFastCommandValue", 3, 0],
        ["__calicoGatewayFastInteractive", 1, 1],
        ["__calicoGatewayFastThin", 1, 1],
        ["__calicoGatewayFastApply", 1, 1],
      ];
      for (const [name, perBlock, external] of expectedReferences) {
        if (countOccurrences(helperBlock, name) !== perBlock) {
          return `expected ${perBlock} reference(s) to ${name} inside the helper block, found ${countOccurrences(helperBlock, name)}`;
        }
        const expected = perBlock * blockCount + external;
        const actual = countOccurrences(content, name);
        if (actual !== expected) {
          return `expected ${expected} total references to ${name}, found ${actual}`;
        }
      }

      for (const name of expectedReferences.map(([n]) => n)) {
        if (countOccurrences(content, `function ${name}`) !== blockCount) {
          continue;
        }
      }
      for (const name of [
        "__calicoGatewayFastEnsure",
        "__calicoGatewayFastRead",
        "__calicoGatewayFastParse",
        "__calicoGatewayFastTier",
        "__calicoGatewayFastRestore",
        "__calicoGatewayFastPublish",
        "__calicoGatewayFastCommandValue",
        "__calicoGatewayFastInteractive",
        "__calicoGatewayFastThin",
        "__calicoGatewayFastApply",
      ]) {
        if (countOccurrences(content, `function ${name}`) !== blockCount) {
          return `expected ${blockCount} ${name} declarations, one per consuming chunk`;
        }
        const alternateBinding = new RegExp(
          `(?:var|let|const)\\s+${name}\\b|(?:^|[;,])${name}=`,
          "m"
        );
        if (alternateBinding.test(content)) {
          return `${name} has an unexpected alternate binding`;
        }
      }

      const requiredHelperMarkers = [
        'writeFileSync(n,"inherit",{encoding:"utf8",mode:0o600,flag:"wx"})',
        'writeFileSync(l,e,{encoding:"utf8",mode:0o600,flag:"wx"})',
        "process.env.CLAUDE_CODE_EXTRA_BODY=t;i.fs.renameSync(l,o.path)",
        "__calicoGatewayFastRestore(r,n)",
        "JSON.parse(t.slice(e,r))",
        "duplicate JSON key",
        "Number.isFinite",
        'Object.prototype.hasOwnProperty.call(e,"service_tier")',
        'i.service_tier="priority"',
        "delete i.service_tier",
        "__calicoGatewayFastPublish(s,a,n,o)",
      ];
      const missingHelperMarkers = requiredHelperMarkers.filter(
        (marker) => !helperBlock.includes(marker)
      );
      if (missingHelperMarkers.length > 0) {
        return `gateway helper semantics missing marker(s): ${missingHelperMarkers.join(", ")}`;
      }
      if (
        countOccurrences(helperBlock, "CALICO_GATEWAY_FAST_STATE_FILE") !== 3 ||
        countOccurrences(helperBlock, "writeFileSync(") !== 2 ||
        countOccurrences(helperBlock, "readFileSync(") !== 1 ||
        countOccurrences(helperBlock, "renameSync(") !== 1
      ) {
        return "gateway mode-file ownership or atomic publish structure is invalid";
      }
      if (
        helperBlock.includes('speed:"fast"') ||
        helperBlock.includes("writeFileSync(l,t") ||
        helperBlock.includes("writeFileSync(n,process.env.CLAUDE_CODE_EXTRA_BODY")
      ) {
        return "gateway helper injects Anthropic speed or persists the full extra body";
      }

      const interactivePattern = new RegExp(
        `async function (${identifier})\\((${identifier}),(${identifier}),(${identifier})\\)\\{if\\(process\\.env\\.REMORA_ACTIVE==="1"\\)return __calicoGatewayFastInteractive\\(\\2,\\4\\);if\\(!(${identifier})\\(\\)\\)return \\2\\((${identifier})\\(\\)\\?\\?"Fast mode is not available"\\),null;`,
        "g"
      );
      // Each consumer must be immediately preceded by its own helper block, so
      // a copy that drifted away from the code that needs it fails here.
      const precededByHelperBlock = (index: number): boolean =>
        content
          .slice(0, index)
          .replace(/\n$/, "")
          .endsWith(helperBlock);

      const interactiveMatches = [...content.matchAll(interactivePattern)];
      if (
        interactiveMatches.length !== 1 ||
        !precededByHelperBlock(interactiveMatches[0].index ?? -1)
      ) {
        return "interactive remora branch is missing, duplicated, or not before the native gate";
      }
      const interactive = interactiveMatches[0];
      const interactiveEnd = content.indexOf(
        "async function ",
        (interactive.index ?? -1) + interactive[0].length
      );
      const interactiveSegment = boundedToModule(
        content.slice(
          interactive.index ?? -1,
          interactiveEnd === -1 ? content.length : interactiveEnd
        )
      );
      // 2.1.251 restructured this handler: the `"shortcut"` apply call is gone,
      // on/off renders a component directly, and `.getAppState`/`.setAppState`
      // moved out. Those were evidence that the segment is the fast-mode
      // interactive handler, not properties of the injection — and the
      // signature matched above already pins the function far harder. Kept in
      // lockstep with the gate in patch-claude-display.ts.
      //
      // Still captured, because when both handlers live in one module and both
      // still call an apply action, requiring them to call the SAME one is a
      // real ownership proof. It is now conditional on both being present
      // rather than required.
      const interactiveAction = interactiveSegment.match(
        /await ([A-Za-z_$][\w$]*)\([^;]*?"shortcut"/
      )?.[1];
      if (
        !interactiveSegment.includes("tengu_fast_mode_picker_shown") ||
        // 2.1.242+ destructures the JSX factory, so match a component call
        // shape rather than a `.jsx(` literal.
        !/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?\([A-Za-z_$][\w$]*,\{[^}]*\}\)/.test(
          interactiveSegment
        )
      ) {
        return "interactive native Fast picker or component render is missing";
      }

      const thinPattern = new RegExp(
        `async function (${identifier})\\((${identifier}),(${identifier})\\)\\{if\\(process\\.env\\.REMORA_ACTIVE==="1"\\)return __calicoGatewayFastThin\\(\\2\\);if\\(!(${identifier})\\(\\)\\)return\\{type:"text",value:(${identifier})\\(\\)\\?\\?"Fast mode is not available"\\};`,
        "g"
      );
      const thinMatches = [...content.matchAll(thinPattern)];
      if (thinMatches.length !== 1 || !precededByHelperBlock(thinMatches[0].index ?? -1)) {
        return "thin-client remora branch is missing, duplicated, or not before the native gate";
      }
      const thin = thinMatches[0];
      const thinEnd = content.indexOf(
        "async function ",
        (thin.index ?? -1) + thin[0].length
      );
      const thinSegment = boundedToModule(
        content.slice(thin.index ?? -1, thinEnd === -1 ? content.length : thinEnd)
      );
      const thinAction = thinSegment.match(
        /await ([A-Za-z_$][\w$]*)\([^;]*?"bridge"/
      )?.[1];
      const handlersShareModule = inSameModule(
        content,
        interactive.index ?? -1,
        thin.index ?? -1
      );
      if (
        !thinAction ||
        (handlersShareModule &&
          (interactive[5] !== thin[4] ||
            interactive[6] !== thin[5] ||
            (interactiveAction !== undefined && thinAction !== interactiveAction))) ||
        !/\.options\.fastMode(?![A-Za-z0-9_$])/.test(thinSegment) ||
        !thinSegment.includes("Unknown argument") ||
        !thinSegment.includes(".getAppState") ||
        !thinSegment.includes(".setAppState")
      ) {
        return "thin-client native toggle path no longer shares the native Fast fallback";
      }

      const localJsxPattern =
        /([A-Za-z_$][\w$]*)=\{type:"local-jsx",name:"fast",get description\(\)\{return process\.env\.REMORA_ACTIVE==="1"\?"Toggle gateway priority tier":`Toggle fast mode \(\$\{([A-Za-z_$][\w$]*)\(\)\}\)`\},get isHidden\(\)\{return process\.env\.REMORA_ACTIVE==="1"\?!1:!([A-Za-z_$][\w$]*)\(\)\},argumentHint:"\[on\|off\]",(?:get immediate\(\)\{return [A-Za-z_$][\w$]*\(\)\}|immediate:!0),requires:\{ink:!0\},thinClientDispatch:"control-request"\}/g;
      const localPattern =
        /([A-Za-z_$][\w$]*)=\{type:"local",name:"fast",supportsNonInteractive:!0,get description\(\)\{return process\.env\.REMORA_ACTIVE==="1"\?"Toggle gateway priority tier":`Toggle fast mode \(\$\{([A-Za-z_$][\w$]*)\(\)\}\)`\},argumentHint:"\[on\|off\]",isEnabled:\(\)=>process\.env\.REMORA_ACTIVE==="1"\|\|([A-Za-z_$][\w$]*)\(\),get isHidden\(\)\{return process\.env\.REMORA_ACTIVE==="1"\?!1:!([A-Za-z_$][\w$]*)\(\)\}/g;
      const localJsxMatches = [...content.matchAll(localJsxPattern)];
      const localMatches = [...content.matchAll(localPattern)];
      if (localJsxMatches.length !== 1 || localMatches.length !== 1) {
        return "gateway-aware Fast command registrations are missing or duplicated";
      }
      const registrationSharesInteractiveModule = inSameModule(
        content,
        localJsxMatches[0].index ?? -1,
        interactive.index ?? -1
      );
      if (
        localJsxMatches[0][2] !== localMatches[0][2] ||
        (registrationSharesInteractiveModule && localJsxMatches[0][3] !== interactive[5]) ||
        localMatches[0][3] !== localMatches[0][4]
      ) {
        return "Fast registrations changed native description or visibility gate ownership";
      }

      const builderPattern = new RegExp(
        `function (${identifier})\\((${identifier})\\)\\{let (${identifier})=process\\.env\\.CLAUDE_CODE_EXTRA_BODY,(${identifier})=\\{\\};`,
        "g"
      );
      const builderMatches = [...content.matchAll(builderPattern)];
      if (builderMatches.length !== 1) {
        return `expected one request extra-body builder, found ${builderMatches.length}`;
      }
      const builder = builderMatches[0];
      const builderStart = builder.index ?? -1;
      if (!precededByHelperBlock(builderStart)) {
        return "request extra-body builder is not preceded by its gateway helper block";
      }
      const builderEndCandidate = content.indexOf("function ", builderStart + builder[0].length);
      const builderEnd = builderEndCandidate === -1 ? content.length : builderEndCandidate;
      const builderSegment = content.slice(builderStart, builderEnd);
      const applyNeedle = `${builder[4]}=__calicoGatewayFastApply(${builder[4]});`;
      const betaNeedle = `if(${builder[2]}&&${builder[2]}.length>0){`;
      const parseErrorIndex = builderSegment.indexOf(
        "Error parsing CLAUDE_CODE_EXTRA_BODY:"
      );
      const parseCompletionNeedle = ',{level:"error"})}';
      const parseCompletionIndex = builderSegment.indexOf(
        parseCompletionNeedle,
        parseErrorIndex
      );
      const applyIndex = builderSegment.indexOf(applyNeedle);
      const betaIndex = builderSegment.indexOf(betaNeedle);
      if (
        countOccurrences(builderSegment, applyNeedle) !== 1 ||
        countOccurrences(builderSegment, betaNeedle) !== 1 ||
        parseErrorIndex === -1 ||
        parseCompletionIndex === -1 ||
        applyIndex <= parseCompletionIndex ||
        applyIndex > betaIndex ||
        builderSegment.includes('speed:"fast"') ||
        builderSegment.includes('.speed="fast"') ||
        !builderSegment.includes("CLAUDE_CODE_EXTRA_BODY env var must be a JSON object") ||
        !builderSegment.includes(`return ${builder[4]}}`)
      ) {
        return "request-time mode application is not between native parsing and beta merge";
      }

      // Locator only. What proves the injection landed correctly is the
      // structural work below: this offset has to sit inside the `env:{…}` of a
      // dispatch record carrying proto/short/sessionId and respawnFlags, with
      // the env object nested inside the record. The patcher guarantees the
      // CALICO entry follows CLAUDE_CODE_EXTRA_BODY and reads the same source
      // object, so those two are the anchor.
      //
      // This used to require `...X.PATH&&{PATH:X.PATH}` immediately after as
      // well. That neighbour proved nothing the containment check did not, and
      // 2.1.259 broke it by emitting `...{},` between the CALICO entry and PATH
      // — a cosmetic empty spread. The patch was correct and the verifier
      // failed it. A redundant check can still be wrong, and this one was.
      const workerPattern = new RegExp(
        `\\.\\.\\.(${identifier})\\.CLAUDE_CODE_EXTRA_BODY&&\\{CLAUDE_CODE_EXTRA_BODY:\\1\\.CLAUDE_CODE_EXTRA_BODY\\},\\.\\.\\.\\1\\.CALICO_GATEWAY_FAST_STATE_FILE&&\\{CALICO_GATEWAY_FAST_STATE_FILE:\\1\\.CALICO_GATEWAY_FAST_STATE_FILE\\}`,
        "g"
      );
      const workerMatches = [...content.matchAll(workerPattern)];
      if (workerMatches.length !== 1) {
        return "worker dispatch does not propagate exactly one shared-state locator";
      }
      const worker = workerMatches[0];
      const workerIndex = worker.index ?? -1;
      const workerStart = content.lastIndexOf("async function ", workerIndex);
      const workerEndCandidate = content.indexOf(
        "async function ",
        workerIndex + worker[0].length
      );
      const workerEnd = workerEndCandidate === -1 ? content.length : workerEndCandidate;
      const workerSegment = content.slice(workerStart, workerEnd);
      const workerLocalIndex = workerIndex - workerStart;
      function findObjectEnd(source: string, openIndex: number): number {
        if (source[openIndex] !== "{") return -1;
        let depth = 0;
        let quote: string | null = null;
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
        `let (${identifier})=\\{proto:${identifier},short:${identifier},sessionId:${identifier},`,
        "g"
      );
      const dispatchRecords = [...workerSegment.matchAll(dispatchRecordPattern)]
        .map((match) => {
          const recordStart = match.index ?? -1;
          const recordOpen = recordStart + match[0].indexOf("{");
          const recordEnd = findObjectEnd(workerSegment, recordOpen);
          const respawnIndex = workerSegment.indexOf(
            "respawnFlags:",
            recordStart + match[0].length
          );
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
      if (workerStart === -1 || dispatchRecords.length !== 1) {
        return "shared locator is detached from the worker/respawn dispatch record";
      }
      const dispatchRecord = dispatchRecords[0];
      // Object spreads are last-write-wins, and the containment checks above
      // only establish where the injection sits — not that it survives to the
      // end of the object. A later spread assigning the same key, e.g.
      // `...{CALICO_GATEWAY_FAST_STATE_FILE:void 0}`, would silently win and
      // every worker would come up without the shared locator. Requiring the
      // key to be written exactly once inside this env object is the property
      // itself rather than a proxy for it; the injection writes it once.
      const envObject = workerSegment.slice(
        dispatchRecord.envIndex,
        dispatchRecord.envEnd + 1
      );
      const locatorWrites = envObject.split("CALICO_GATEWAY_FAST_STATE_FILE:").length - 1;
      if (locatorWrites !== 1) {
        return `expected the worker env to assign the shared locator once, found ${locatorWrites}`;
      }
      const dispatchRecordLocal = dispatchRecord.match[1];
      // 2.1.239 appended arguments to the dispatch call; accept a trailing
      // argument list one level of call nesting deep, matching the patcher.
      const dispatchArguments = "(?:,(?:[^()]|\\([^()]*\\))*)?";
      const awaitedDispatchPattern = new RegExp(
        `\\},\\[,(${identifier})\\]=await Promise\\.all\\(\\[(?:(?!\\]\\))[\\s\\S])*?,(${identifier})\\(${dispatchRecordLocal}${dispatchArguments}\\)\\]\\)`,
        "g"
      );
      const awaitedDispatches = [...workerSegment.matchAll(awaitedDispatchPattern)];
      const directDispatchPattern = new RegExp(
        `(${identifier})\\(${dispatchRecordLocal}${dispatchArguments}\\)`,
        "g"
      );
      const directDispatches = [...workerSegment.matchAll(directDispatchPattern)];
      if (
        awaitedDispatches.length !== 1 ||
        directDispatches.length !== 1 ||
        (awaitedDispatches[0].index ?? -1) !== dispatchRecord.recordEnd ||
        awaitedDispatches[0][2] !== directDispatches[0][1]
      ) {
        return "worker record is not directly dispatched once through awaited Promise.all";
      }

      return null;
    },
  },
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
        /process\.env\.REMORA_ACTIVE==="1"&&[A-Za-z_$][\w$]*\.__calicoPromptId===void 0&&\([A-Za-z_$][\w$]*\.__calicoPromptId=([A-Za-z_$][\w$]*)\.getStore\(\)\?\.__calicoPromptId\?\?globalThis\.__calicoPromptIdGet\(\)\),\1\.run\(/;
      // The parameter names are minified and were pinned as `e`/`t` here as well;
      // 2.1.257 renamed the second to `n`. Capture them and backreference.
      const frozenJournalContext =
        /function [A-Za-z_$][\w$]*\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{\1&&process\.env\.REMORA_ACTIVE==="1"&&\1\.__calicoPromptId===void 0&&\(\1\.__calicoPromptId=([A-Za-z_$][\w$]*)\.getStore\(\)\?\.__calicoPromptId\?\?globalThis\.__calicoPromptIdGet\(\)\);if\(!\("turnAttributionKey"in \1\)\)\1\.turnAttributionKey=[A-Za-z_$][\w$]*\(\);return \3\.run\(\1,\(\)=>[A-Za-z_$][\w$]*\(\1\.turnAttributionKey,\2\)\)/;
      if (!frozenAgentContext.test(content) && !frozenJournalContext.test(content)) {
        return "missing nested-agent prompt inheritance at AsyncLocalStorage boundary";
      }
      const sourceGate =
        /__calicoQueryKind==="main"\|\|__calicoQueryKind==="subagent"/;
      if (!sourceGate.test(content)) {
        return "missing main/subagent query-source gate";
      }
      // Compact request-source may inject between custom headers and active-turn
      // Calico-owned headers when both modules apply (default module order).
      const protectedHeaderOrder = new RegExp(
        `${SESSION_ID_HEADER_KEY}:[A-Za-z_$][\\w$]*\\(\\),\\.\\.\\.[A-Za-z_$][\\w$]*,(?:\\.\\.\\.process\\.env\\.REMORA_ACTIVE==="1"&&[A-Za-z_$][\\w$]*==="compact"&&\\{"x-calico-request-source":"compact"\\},)?\\.\\.\\.__calicoPromptId&&\\{"x-calico-prompt-id":__calicoPromptId,"x-calico-active-turn-version":"1"\\}`
      );
      return protectedHeaderOrder.test(content)
        ? null
        : "Calico-owned headers are missing or can be overridden by custom headers";
    },
  },
  {
    id: "compact-request-source",
    kind: "custom",
    describe: "remora-scoped compact request source header for gateway guards",
    run: (content: string): string | null => {
      const omitHelper =
        'function __calicoOmitHeader(e,t){if(!e||typeof e!=="object"||Array.isArray(e))return e;let r={},n=String(t).toLowerCase();for(let o of Object.keys(e))if(String(o).toLowerCase()!==n)r[o]=e[o];return r}';
      if (countOccurrences(content, "function __calicoOmitHeader") !== 1) {
        return "expected exactly one __calicoOmitHeader declaration";
      }
      const omitIndex = content.indexOf(omitHelper);
      if (omitIndex === -1) {
        return "missing exact __calicoOmitHeader helper body";
      }
      const omitPrefix = content.slice(Math.max(0, omitIndex - 2), omitIndex);
      if (omitPrefix === "/*" || omitPrefix.endsWith("//")) {
        return "__calicoOmitHeader helper appears commented out";
      }
      // Omit helper must sit immediately before the Zie factory, or before the
      // compact body-policy helper block that itself sits before that factory.
      // Injected helpers include a trailing newline after the function body.
      const afterOmit = content
        .slice(omitIndex + omitHelper.length)
        .replace(/^\n/, "");
      if (
        !afterOmit.startsWith("async function ") &&
        !afterOmit.startsWith("function __calicoCompactPolicy")
      ) {
        return "__calicoOmitHeader is not adjacent to Zie factory or compact helpers";
      }
      // Sanitize + compact header must be live code inside the Zie factory, not
      // merely present as string/comment text elsewhere in the bundle.
      // 2.1.238 appends `,credentials:s` to the factory parameter object and
      // shifts the extra-header local and header-object local by one letter
      // (`u=…(),p={` → `d=…(),f={`); the signature tail and both locals are
      // matched generically. The IIFE parameter stays the literal `u`.
      const ownedFactory = new RegExp(
        `async function [A-Za-z_$][\\w$]*\\(\\{apiKey:[A-Za-z_$][\\w$]*,maxRetries:[A-Za-z_$][\\w$]*,model:[A-Za-z_$][\\w$]*,fetchOverride:([A-Za-z_$][\\w$]*),source:([A-Za-z_$][\\w$]*),agentContext:[A-Za-z_$][\\w$]*(?:,[A-Za-z_$][\\w$]*:[A-Za-z_$][\\w$]*)*\\}\\)\\{(?:if\\(process\\.env\\.REMORA_ACTIVE==="1"&&\\2==="compact"\\)\\{\\1=__calicoCompactWrapFetch\\(\\1\\)\\})?let [\\s\\S]*?[A-Za-z_$][\\w$]*=\\(\\(u\\)=>process\\.env\\.REMORA_ACTIVE==="1"\\?__calicoOmitHeader\\(u,"x-calico-request-source"\\):u\\)\\([A-Za-z_$][\\w$]*\\(\\)\\),[A-Za-z_$][\\w$]*=\\{[\\s\\S]*?${SESSION_ID_HEADER_KEY}:[A-Za-z_$][\\w$]*\\(\\),\\.\\.\\.[A-Za-z_$][\\w$]*,\\.\\.\\.process\\.env\\.REMORA_ACTIVE==="1"&&\\2==="compact"&&\\{"x-calico-request-source":"compact"\\}`
      );
      if (!ownedFactory.test(content)) {
        return "compact request-source sanitize/header inject is not owned by Zie factory";
      }
      return null;
    },
  },
  {
    id: "compact-body-policy",
    kind: "custom",
    describe: "remora compact body effort/thinking/model rewrite via fetchOverride wrap",
    run: (content: string): string | null => {
      const policyHelper =
        'function __calicoCompactPolicy(){let e=process.env.CALICO_COMPACT_EFFORT,t=process.env.CALICO_COMPACT_MODEL,r=process.env.CALICO_COMPACT_DISABLE_THINKING;return{effort:e&&String(e).trim()!==""?String(e).trim():"medium",model:t&&String(t).trim()!==""?String(t).trim():"",disableThinking:r==="1"}}';
      const rewriteHelper =
        'function __calicoCompactRewriteBodyString(e){if(typeof e!=="string"||!e)return e;let t;try{t=JSON.parse(e)}catch{return e}if(!t||typeof t!=="object"||Array.isArray(t))return e;let r=__calicoCompactPolicy();if(r.model)t.model=r.model;if(r.effort){if(t.output_config&&typeof t.output_config==="object")t.output_config={...t.output_config,effort:r.effort};else t.output_config={effort:r.effort};if(Object.prototype.hasOwnProperty.call(t,"effort"))t.effort=r.effort}if(r.disableThinking&&t.thinking!=null)t.thinking={type:"disabled"};return JSON.stringify(t)}';
      const wrapHelper =
        'function __calicoCompactWrapFetch(e){let t=typeof e==="function"?e:typeof globalThis.fetch==="function"?globalThis.fetch.bind(globalThis):null;if(typeof t!=="function")return e;return function(r,n){if(n&&typeof n.body==="string"){let o=__calicoCompactRewriteBodyString(n.body);if(o!==n.body){n={...n,body:o};n.headers=__calicoCompactStripContentLength(n.headers)}}return t(r,n)}}';
      const stripHelper =
        'function __calicoCompactStripContentLength(e){if(e==null)return e;if(typeof Headers==="function"&&e instanceof Headers){let t=new Headers(e);t.delete("content-length");return t}if(Array.isArray(e))return e.filter((t)=>!(Array.isArray(t)&&t.length>0&&String(t[0]).toLowerCase()==="content-length"));if(typeof e==="object"){if(typeof e.delete==="function"){try{e.delete("content-length");e.delete("Content-Length");return e}catch{}}let t={...e};for(let r of Object.keys(t))if(String(r).toLowerCase()==="content-length")delete t[r];return t}return e}';
      const helperEntries = [
        ["__calicoCompactPolicy", policyHelper],
        ["__calicoCompactRewriteBodyString", rewriteHelper],
        ["__calicoCompactWrapFetch", wrapHelper],
        ["__calicoCompactStripContentLength", stripHelper],
      ] as const;
      for (const [name, body] of helperEntries) {
        if (countOccurrences(content, `function ${name}`) !== 1) {
          return `expected exactly one ${name} declaration`;
        }
      }
      // Require the four helpers as one executable contiguous block immediately
      // before the Zie factory that owns the wrap inject (rejects comment-only
      // or string-only copies of the helper text). Patch injects helpers with a
      // single newline separator and a trailing newline before the factory.
      const helperBlock =
        [policyHelper, rewriteHelper, wrapHelper, stripHelper].join("\n") + "\n";
      // Minified locals differ per platform build of the same version (e.g.
      // 2.1.238 macos-arm64 destructures fetchOverride into `n`, linux/windows
      // arm64 into `r`), so the inject is matched by shape with the source and
      // fetchOverride locals captured, never pinned.
      const wrapInjectPattern =
        /if\(process\.env\.REMORA_ACTIVE==="1"&&[A-Za-z_$][\w$]*==="compact"\)\{([A-Za-z_$][\w$]*)=__calicoCompactWrapFetch\(\1\)\}/g;
      // 2.1.238 appends `,credentials:s` to the factory parameter object; the
      // signature tail after `agentContext:i` is matched generically.
      const ownedFactory =
        /async function [A-Za-z_$][\w$]*\(\{apiKey:[A-Za-z_$][\w$]*,maxRetries:[A-Za-z_$][\w$]*,model:[A-Za-z_$][\w$]*,fetchOverride:([A-Za-z_$][\w$]*),source:([A-Za-z_$][\w$]*),agentContext:[A-Za-z_$][\w$]*(?:,[A-Za-z_$][\w$]*:[A-Za-z_$][\w$]*)*\}\)\{if\(process\.env\.REMORA_ACTIVE==="1"&&\2==="compact"\)\{\1=__calicoCompactWrapFetch\(\1\)\}/;
      const factoryMatch = ownedFactory.exec(content);
      if (!factoryMatch || factoryMatch.index === undefined) {
        return "compact fetch wrap is not owned by the Zie client factory";
      }
      const wrapInjectMatches = content.match(wrapInjectPattern) ?? [];
      if (wrapInjectMatches.length !== 1) {
        return "expected exactly one compact fetch wrap inject at Zie factory";
      }
      const factoryIndex = factoryMatch.index;
      const blockIndex = content.lastIndexOf(helperBlock, factoryIndex);
      if (blockIndex === -1 || blockIndex + helperBlock.length !== factoryIndex) {
        return "compact helper block is not executable and adjacent to its Zie factory";
      }
      // Reject a block-comment enclosure immediately before the helper block.
      const prefix = content.slice(Math.max(0, blockIndex - 2), blockIndex);
      if (prefix === "/*" || prefix.endsWith("//")) {
        return "compact helper block appears commented out";
      }
      return null;
    },
  },
  {
    id: "background-agent-usage",
    kind: "custom",
    describe: "background agent tracker accounts terminal stream usage by response id",
    run: (content: string): string | null => {
      const trackHelper =
        'function __calicoTrackAgentUsage(e,t,r,n){if(!t||typeof t!=="object")return;let o=["input_tokens","cache_creation_input_tokens","cache_read_input_tokens"].some((s)=>typeof t[s]==="number"),i=(t.input_tokens??0)+(t.cache_creation_input_tokens??0)+(t.cache_read_input_tokens??0);if(o&&(n||i>0))e.latestInputTokens=i;let s=typeof t.output_tokens==="number"&&Number.isFinite(t.output_tokens)?Math.max(0,t.output_tokens):0;if(r==null){if(s>0)e.cumulativeOutputTokens+=s;return}let a=e.responseOutputTokens.get(r)??0;if(s>a)e.cumulativeOutputTokens+=s-a;if(s>a||!e.responseOutputTokens.has(r))e.responseOutputTokens.set(r,Math.max(a,s))}';
      const refreshHelper =
        'function __calicoRefreshAgentUsage(e,t){if(!Array.isArray(t))return;let r=!1;for(let n=t.length-1;n>=0;n--){let o=t[n];if(o?.type==="assistant")r=!0,__calicoTrackAgentUsage(e,o.message?.usage,o.message?.id,o.message?.stop_reason!=null);else if(o?.type==="user"&&r)break}}';
      const helperEntries = [
        ["__calicoTrackAgentUsage", trackHelper],
        ["__calicoRefreshAgentUsage", refreshHelper],
      ] as const;
      for (const [name, helper] of helperEntries) {
        const exactCount = countOccurrences(content, helper);
        const declarationCount = countOccurrences(content, `function ${name}`);
        const alternateBinding = new RegExp(
          `(?:var|let|const)\\s+${name}\\b|(?:^|[;,])${name}=`,
          "m"
        );
        if (exactCount !== 1 || declarationCount !== 1 || alternateBinding.test(content)) {
          return `expected 1 exact executable ${name} declaration without alternate bindings`;
        }
      }
      if (countOccurrences(content, trackHelper + refreshHelper) !== 1) {
        return "background usage helpers are not one adjacent executable injection block";
      }
      for (const [name, expected] of [
        ["__calicoTrackAgentUsage", 5],
        ["__calicoRefreshAgentUsage", 3],
      ] as const) {
        const actual = countOccurrences(content, name);
        if (actual !== expected) {
          return `expected ${expected} total references to ${name}, found ${actual}`;
        }
      }
      const identifier = "[A-Za-z_$][\\w$]*";
      const trackerPattern = new RegExp(
        // Upstream adds fields on both sides of recentActivities (2.1.246 after,
        // 2.1.257 before). Kept in lockstep with trackerPattern in
        // patch-claude-display.ts.
        `function (${identifier})\\(\\)\\{return\\{toolUseCount:0,latestInputTokens:0,cumulativeOutputTokens:0(?:,[^{}\\[\\]]*?)?,recentActivities:\\[\\](?:,[^{}]*?)?,activeMessageId:null,responseOutputTokens:new Map\\}\\}`,
        "g"
      );
      const trackerMatches = [...content.matchAll(trackerPattern)];
      if (trackerMatches.length !== 1) {
        return `expected 1 semantic background tracker state, found ${trackerMatches.length}`;
      }
      if (
        countOccurrences(
          content,
          trackHelper + refreshHelper + trackerMatches[0][0]
        ) !== 1
      ) {
        return "background helper block is not executable code adjacent to tracker construction";
      }

      const eventPattern = new RegExp(
        `if\\((${identifier})\\.type==="stream_event"\\)\\{if\\(\\1\\.event\\.type==="message_start"\\)(${identifier})\\.activeMessageId=\\1\\.event\\.message\\.id,__calicoTrackAgentUsage\\(\\2,\\1\\.event\\.message\\.usage,\\2\\.activeMessageId,!1\\);else if\\(\\1\\.event\\.type==="message_delta"\\)__calicoTrackAgentUsage\\(\\2,\\1\\.event\\.usage,\\2\\.activeMessageId,\\1\\.event\\.delta\\.stop_reason!=null\\);else if\\(\\1\\.event\\.type==="message_stop"\\)\\2\\.activeMessageId=null;return\\}if\\(\\1\\.type!=="assistant"\\)return;let (${identifier})=\\1\\.message\\.usage;__calicoTrackAgentUsage\\(\\2,\\3,\\1\\.message\\.id,\\1\\.message\\.stop_reason!=null\\);`,
        "g"
      );
      const eventMatches = [...content.matchAll(eventPattern)];
      if (eventMatches.length !== 1) {
        return `expected 1 semantic background event accounting path, found ${eventMatches.length}`;
      }
      const event = eventMatches[0];
      const eventLocal = event[1];
      const trackerLocal = event[2];
      const eventIndex = event.index ?? -1;
      const eventFunctionStart = content.lastIndexOf("function ", eventIndex);
      const eventHeader =
        eventFunctionStart === -1
          ? null
          : content
              .slice(eventFunctionStart, eventIndex)
              .match(
                new RegExp(
                  `^function (${identifier})\\((${identifier}),(${identifier}),(${identifier}),(${identifier})\\)\\{`
                )
              );
      if (!eventHeader || eventHeader[2] !== trackerLocal || eventHeader[3] !== eventLocal) {
        return "background accounting block is detached from its tracker/event function parameters";
      }
      const eventFunction = eventHeader[1];

      const progressPattern = new RegExp(
        `(${identifier})\\((${identifier}),(${identifier}),(${identifier}),(${identifier})\\.options\\.tools\\),__calicoRefreshAgentUsage\\(\\2,(${identifier})\\),(${identifier})\\((${identifier}),(${identifier})\\(\\2\\),(${identifier})\\);`,
        "g"
      );
      const progressMatches = [...content.matchAll(progressPattern)];
      if (progressMatches.length !== 1) {
        return `expected 1 semantic background progress refresh, found ${progressMatches.length}`;
      }
      const progress = progressMatches[0];
      if (progress[1] !== eventFunction) {
        return "background progress refresh calls a different event-accounting function";
      }

      const legacyCompletionPattern = new RegExp(
        `let (${identifier})=(${identifier})\\((${identifier}),(${identifier}),(${identifier})\\),(${identifier})=(${identifier})\\(\\1,\\4,(${identifier}),\\{suppressTelemetry:(${identifier})\\}\\);__calicoRefreshAgentUsage\\((${identifier}),\\1\\),(${identifier})\\((${identifier}),(${identifier})\\((${identifier})\\),(${identifier})\\);`,
        "g"
      );
      const modelsUsedCompletionPattern = new RegExp(
        `let (${identifier})=(${identifier})\\((${identifier}),(${identifier}),(${identifier})\\),(${identifier})=(${identifier})\\(\\1,\\4,\\{\\.\\.\\.(${identifier}),modelsUsed:(${identifier})\\},\\{suppressTelemetry:(${identifier})\\}\\);__calicoRefreshAgentUsage\\((${identifier}),\\1\\),(${identifier})\\((${identifier}),(${identifier})\\((${identifier})\\),(${identifier})\\);`,
        "g"
      );
      const completionMatches = [
        ...[...content.matchAll(legacyCompletionPattern)].map((match) => ({
          match,
          result: match[1],
          status: match[3],
          owner: match[4],
          transcript: match[5],
          refreshTracker: match[10],
          refreshFunction: match[11],
          refreshOwner: match[12],
          summaryFunction: match[13],
          summaryTracker: match[14],
          refreshStatus: match[15],
        })),
        ...[...content.matchAll(modelsUsedCompletionPattern)].map((match) => ({
          match,
          result: match[1],
          status: match[3],
          owner: match[4],
          transcript: match[5],
          refreshTracker: match[11],
          refreshFunction: match[12],
          refreshOwner: match[13],
          summaryFunction: match[14],
          summaryTracker: match[15],
          refreshStatus: match[16],
        })),
      ];
      if (completionMatches.length !== 1) {
        return `expected 1 semantic background completion refresh, found ${completionMatches.length}`;
      }
      const completion = completionMatches[0];
      const progressIndex = progress.index ?? -1;
      const completionIndex = completion.match.index ?? -1;
      const progressEnd =
        progressIndex === -1 ? -1 : progressIndex + progress[0].length;
      const progressFunctionStart = content.lastIndexOf("function ", progressIndex);
      const completionFunctionStart = content.lastIndexOf("function ", completionIndex);
      const progressToCompletionSegment =
        progressEnd === -1 || completionIndex === -1
          ? ""
          : content.slice(progressEnd, completionIndex);
      if (
        progressFunctionStart === -1 ||
        progressFunctionStart !== completionFunctionStart ||
        completionIndex < progressEnd ||
        progressToCompletionSegment.includes("=>") ||
        progressToCompletionSegment.includes("function ") ||
        completion.refreshTracker !== progress[2] ||
        completion.refreshOwner !== completion.owner ||
        completion.summaryTracker !== progress[2] ||
        completion.refreshStatus !== completion.status ||
        progress[6] !== completion.transcript ||
        progress[7] !== completion.refreshFunction ||
        progress[8] !== completion.owner ||
        progress[9] !== completion.summaryFunction ||
        progress[10] !== completion.status
      ) {
        return "background progress/completion refresh seams do not share tracker ownership";
      }

      const oldAssistantOnlyTracker =
        // 2.1.257 folds these two assignments into the head of an `if(...)` comma
        // expression, so the trailing `;` is a `,` there. Match the assignments,
        // not the statement boundary.
        /if\([A-Za-z_$][\w$]*\.type!=="assistant"\)return;let ([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\.message\.usage;(?:if\()?[A-Za-z_$][\w$]*\.latestInputTokens=\1\.input_tokens\+\(\1\.cache_creation_input_tokens\?\?0\)\+\(\1\.cache_read_input_tokens\?\?0\),[A-Za-z_$][\w$]*\.cumulativeOutputTokens\+=\1\.output_tokens[;,]/;
      // .test, not .includes: a RegExp handed to includes() is stringified and
      // never matches, which would silently disable this guard.
      return oldAssistantOnlyTracker.test(content)
        ? "original assistant-only usage tracker is still present"
        : null;
    },
  },
  {
    id: "statusline-committed-usage",
    kind: "custom",
    describe: "terminal-only usage snapshot preserved through shallow state copies",
    run: (content: string): string | null => {
      const identifier = "[A-Za-z_$][\\w$]*";
      const accountingSignalHelper =
        'function __calicoUsageHasAccountingSignal(e){if(!e||typeof e!=="object")return!1;return["input_tokens","output_tokens","cache_creation_input_tokens","cache_read_input_tokens"].some((t)=>typeof e[t]==="number"&&e[t]!==0)}';
      const exactZeroHelper =
        'function __calicoUsageIsExactAllZero(e){if(!e||typeof e!=="object")return!1;return e.input_tokens===0&&e.output_tokens===0&&(e.cache_creation_input_tokens===void 0||e.cache_creation_input_tokens===0)&&(e.cache_read_input_tokens===void 0||e.cache_read_input_tokens===0)&&(e.cache_creation?.ephemeral_1h_input_tokens===void 0||e.cache_creation?.ephemeral_1h_input_tokens===0)&&(e.cache_creation?.ephemeral_5m_input_tokens===void 0||e.cache_creation?.ephemeral_5m_input_tokens===0)}';
      const statuslineHelper =
        'function __calicoStatuslineMessages(e){if(!Array.isArray(e))return e;return e.flatMap((t)=>{if(t?.type!=="assistant")return[t];let r=t.__calicoUsageState;if(r?.committed===!0&&r.usage)return[{...t,message:{...t.message,usage:r.usage}}];if(r===void 0&&t.message?.stop_reason!=null&&__calicoUsageHasAccountingSignal(t.message?.usage))return[t];return[]})}';
      const stateCell = "__calicoUsageState:{committed:!1,usage:null}";
      const helperMarkers: Array<[string, number]> = [
        [stateCell, 1],
        // One copy per consuming chunk; see the patcher for why a single
        // shared definition is not reliably evaluated first.
        [accountingSignalHelper, 2],
        [exactZeroHelper, 2],
        [statuslineHelper, 1],
        ["function __calicoUsageHasAccountingSignal", 2],
        ["function __calicoUsageIsExactAllZero", 2],
        ["function __calicoStatuslineMessages", 1],
      ];
      for (const [marker, expected] of helperMarkers) {
        const actual = countOccurrences(content, marker);
        if (actual !== expected) {
          return `expected ${expected} occurrence(s) of ${marker}, found ${actual}`;
        }
      }
      for (const name of [
        "__calicoUsageHasAccountingSignal",
        "__calicoUsageIsExactAllZero",
        "__calicoStatuslineMessages",
      ]) {
        const alternateBinding = new RegExp(
          `(?:var|let|const)\\s+${name}\\b|(?:^|[;,])${name}=`,
          "m"
        );
        if (alternateBinding.test(content)) {
          return `${name} has an unexpected alternate binding`;
        }
      }
      const statuslineHelperBlock =
        accountingSignalHelper + exactZeroHelper + statuslineHelper;
      if (countOccurrences(content, statuslineHelperBlock) !== 1) {
        return "statusline helpers are not one adjacent executable injection block";
      }
      if (countOccurrences(content, statuslineHelperBlock + "function ") !== 1) {
        return "statusline helper block is not executable code adjacent to its payload function";
      }
      for (const [name, expected] of [
        // 2 declarations + 1 use inside __calicoStatuslineMessages + 1 at the
        // terminal commit; 2 declarations + 1 at the terminal commit; and
        // 1 declaration + 1 at the selector.
        ["__calicoUsageHasAccountingSignal", 4],
        ["__calicoUsageIsExactAllZero", 3],
        ["__calicoStatuslineMessages", 2],
      ] as const) {
        const actual = countOccurrences(content, name);
        if (actual !== expected) {
          return `expected ${expected} total references to ${name}, found ${actual}`;
        }
      }

      const legacyWrapperPattern = new RegExp(
        `let (${identifier})=\\{message:\\{\\.\\.\\.(${identifier}),content:(${identifier})\\(\\[(${identifier})\\],(${identifier}),(${identifier})\\.agentId,\\{requestId:(${identifier})\\?\\?void 0,messageId:\\2\\.id\\}\\)\\},requestId:\\7\\?\\?void 0,\\.\\.\\.(${identifier})\\(\\6\\.querySource,\\6\\.spawnedBySkill,\\6\\.activeSkill,\\6\\.activeMcpServer,\\6\\.activeMcpTool\\),type:"assistant",uuid:(${identifier})(?:\\.randomUUID)?\\(\\),timestamp:new Date\\(\\)\\.toISOString\\(\\),\\.\\.\\.!1,__calicoUsageState:\\{committed:!1,usage:null\\},\\.\\.\\.(${identifier})&&\\{advisorModel:\\10\\}((?:,\\.\\.\\.\\{[^{}]*\\})*)\\};`,
        "g"
      );
      const effortWrapperPattern = new RegExp(
        `let (${identifier})=\\{message:\\{\\.\\.\\.(${identifier}),content:(${identifier})\\(\\[(${identifier})\\],(${identifier}),(${identifier})\\.agentId,\\{requestId:(${identifier})\\?\\?void 0,messageId:\\2\\.id\\}\\)\\},requestId:\\7\\?\\?void 0,\\.\\.\\.(${identifier})\\(\\6\\.querySource,\\6\\.spawnedBySkill,\\6\\.activeSkill,\\6\\.activeMcpServer,\\6\\.activeMcpTool\\),type:"assistant",uuid:(${identifier})(?:\\.randomUUID)?\\(\\),timestamp:new Date\\(\\)\\.toISOString\\(\\),\\.\\.\\.!1,__calicoUsageState:\\{committed:!1,usage:null\\},\\.\\.\\.(${identifier})&&\\{advisorModel:\\10\\},\\.\\.\\.(${identifier})!==void 0&&\\{effort:(${identifier})\\}((?:,\\.\\.\\.\\{[^{}]*\\})*)\\};`,
        "g"
      );
      // 2.1.236+ batch tool-use destructured wrapper; see the matching
      // pattern in patch-claude-display.ts for the canonical/fallback split.
      // 2.1.238 appends a fifth argument to the content builder call
      // (`…messageId:Gr.id},i.storageV5)`), matched optionally so the patched
      // 2.1.237 and 2.1.238 binaries both verify.
      const batchWrapperPattern = new RegExp(
        // 2.1.257 inserts statements between the destructuring and the message
        // object, and adds fields to the object before `requestId`. Kept in
        // lockstep with batchWrapperPattern in patch-claude-display.ts.
        `let\\{content:(${identifier}),batchToolUses:(${identifier})\\}=(${identifier})\\((${identifier})\\(\\[(${identifier})\\],(${identifier}),(${identifier})\\.agentId,\\{requestId:(${identifier})\\?\\?void 0,messageId:(${identifier})\\.id\\}(?:,${identifier}(?:\\.${identifier})*)?\\),\\6(?:,(?:[^()]|\\([^()]*\\))*)?\\)(?:[^{}]|\\{[^{}]*\\})*?,(${identifier})=\\{message:\\{\\.\\.\\.\\9,content:\\1\\},\\.\\.\\.\\2\\.length>0&&\\{batchToolUses:\\2\\}(?:,[^{}]*(?:\\{[^{}]*\\})?)*?,requestId:\\8\\?\\?void 0,\\.\\.\\.(${identifier})\\(\\7\\.querySource,\\7\\.spawnedBySkill,\\7\\.activeSkill,\\7\\.activeMcpServer,\\7\\.activeMcpTool\\),type:"assistant",uuid:(${identifier})(?:\\.randomUUID)?\\(\\),timestamp:new Date\\(\\)\\.toISOString\\(\\),\\.\\.\\.!1,__calicoUsageState:\\{committed:!1,usage:null\\},\\.\\.\\.(${identifier})&&\\{advisorModel:\\13\\},\\.\\.\\.(${identifier})!==void 0&&\\{effort:(${identifier})\\}((?:,\\.\\.\\.\\{[^{}]*\\})*)\\};`,
        "g"
      );
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
        ...[...content.matchAll(batchWrapperPattern)].map((match) => ({
          match,
          local: match[10],
          effortCondition: match[14],
          effortProperty: match[15],
        })),
      ];
      if (wrapperMatches.length !== 1) {
        return `expected 1 canonical wrapper-owned usage cell, found ${wrapperMatches.length}`;
      }
      const wrapper = wrapperMatches[0];
      if (
        wrapper.effortCondition !== null &&
        wrapper.effortCondition !== wrapper.effortProperty
      ) {
        return "statusline effort condition and property use different locals";
      }
      const modelsUsedCompletionSignalPattern = new RegExp(
        `let (${identifier})=(${identifier})\\((${identifier}),(${identifier}),(${identifier})\\),(${identifier})=(${identifier})\\(\\1,\\4,\\{\\.\\.\\.(${identifier}),modelsUsed:(${identifier})\\},\\{suppressTelemetry:(${identifier})\\}\\);__calicoRefreshAgentUsage\\((${identifier}),\\1\\),(${identifier})\\((${identifier}),(${identifier})\\((${identifier})\\),(${identifier})\\);`,
        "g"
      );
      const modelsUsedCompletionSignals = [
        ...content.matchAll(modelsUsedCompletionSignalPattern),
      ].filter(
        (match) =>
          match[13] === match[4] &&
          match[15] === match[11] &&
          match[16] === match[3]
      );
      if (modelsUsedCompletionSignals.length > 1) {
        return "ambiguous 2.1.212 background modelsUsed completion signal";
      }
      if (
        modelsUsedCompletionSignals.length === 1 &&
        wrapper.effortCondition === null
      ) {
        return "2.1.212 modelsUsed completion requires an effort-bearing statusline wrapper";
      }
      const wrapperLocal = wrapper.local;
      const wrapperIndex = wrapper.match.index ?? -1;
      const wrapperFunctionStart = content.lastIndexOf("function ", wrapperIndex);

      const terminalPattern = new RegExp(
        `for\\(let (${identifier}) of (${identifier})\\)\\1\\.message\\.usage=(${identifier}),\\1\\.message\\.stop_reason=(${identifier}),\\1\\.message\\.stop_details=(${identifier})\\.delta\\.stop_details\\?\\?null,\\4!=null&&!__calicoUsageIsExactAllZero\\(\\5\\.usage\\)&&__calicoUsageHasAccountingSignal\\(\\3\\)&&\\(\\1\\.__calicoUsageState\\.committed=!0,\\1\\.__calicoUsageState\\.usage=\\3\\);`,
        "g"
      );
      const terminalMatches = [...content.matchAll(terminalPattern)];
      if (terminalMatches.length !== 1) {
        return `expected 1 semantic terminal commit, found ${terminalMatches.length}`;
      }
      const terminal = terminalMatches[0];
      const terminalLoopLocal = terminal[1];
      const terminalArray = terminal[2];
      const usageLocal = terminal[3];
      const stopReasonLocal = terminal[4];
      const rawEventLocal = terminal[5];
      const terminalIndex = terminal.index ?? -1;
      const canonicalStart = content.lastIndexOf("function ", terminalIndex);
      if (
        canonicalStart === -1 ||
        wrapperFunctionStart === -1 ||
        canonicalStart !== wrapperFunctionStart
      ) {
        return "canonical wrapper and terminal commit are in different functions";
      }
      const wrapperToTerminal = content.slice(wrapperIndex, terminalIndex);
      if (!wrapperToTerminal.includes(`${terminalArray}.push(${wrapperLocal})`)) {
        return "canonical wrapper is not registered in the terminal mutation array";
      }

      const escapedUsageLocal = usageLocal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const escapedRawEventLocal = rawEventLocal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const aggregationPattern = new RegExp(
        `case"message_delta":\\{${escapedUsageLocal}=(${identifier})\\(${escapedUsageLocal},${escapedRawEventLocal}\\.usage\\);`,
        "g"
      );
      const canonicalSegment = content.slice(canonicalStart, terminalIndex);
      const aggregationMatches = [...canonicalSegment.matchAll(aggregationPattern)];
      const firstMessageDelta = canonicalSegment.match(/case"message_delta":\{/);
      if (
        aggregationMatches.length !== 1 ||
        firstMessageDelta === null ||
        aggregationMatches[0].index !== firstMessageDelta.index
      ) {
        return `expected first message_delta path to own the canonical aggregation, found ${aggregationMatches.length}`;
      }
      const aggregationFunction = aggregationMatches[0][1];
      const escapedAggregationFunction = aggregationFunction.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      );
      if (!new RegExp(`function ${escapedAggregationFunction}\\(`).test(content)) {
        return "aggregation target is not an identifier-backed function";
      }
      const aggregationIndex = canonicalStart + (aggregationMatches[0].index ?? -1);

      const cloneSyncPattern = new RegExp(
        `for\\(let\\{src:(${identifier}),dst:(${identifier})\\}of (${identifier})\\)\\2\\.message\\.usage=\\1\\.message\\.usage,\\2\\.message\\.stop_reason=\\1\\.message\\.stop_reason,\\2\\.message\\.stop_details=\\1\\.message\\.stop_details,\\2\\.__calicoUsageState=\\1\\.__calicoUsageState;`,
        "g"
      );
      const cloneSyncMatches = [...content.matchAll(cloneSyncPattern)];
      if (cloneSyncMatches.length !== 1) {
        return `expected 1 wrapper clone-sync loop, found ${cloneSyncMatches.length}`;
      }
      const cloneSync = cloneSyncMatches[0];
      const cloneSource = cloneSync[1];
      const cloneDestination = cloneSync[2];
      const cloneArray = cloneSync[3];
      if (cloneArray === terminalArray) {
        return "downstream clone array aliases the canonical terminal array";
      }
      const cloneRegistrationPattern = new RegExp(
        `${cloneArray.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.push\\(\\{src:(${identifier}),dst:(${identifier})\\}\\)`,
        "g"
      );
      const cloneMatches = [...content.matchAll(cloneRegistrationPattern)];
      if (cloneMatches.length !== 2) {
        return `expected 2 wrapper clone registrations, found ${cloneMatches.length}`;
      }
      if (cloneSource === cloneDestination) {
        return "clone-sync loop aliases its wrapper source and destination locals";
      }
      const registeredSources = new Set(cloneMatches.map((match) => match[1]));
      const registeredDestinations = new Set(cloneMatches.map((match) => match[2]));
      if (registeredSources.size !== 1 || registeredDestinations.size !== 2) {
        return "clone registrations do not preserve one wrapper source and two distinct destinations";
      }
      const registeredSource = cloneMatches[0][1];
      if (registeredDestinations.has(registeredSource)) {
        return "clone registration aliases its wrapper source as a destination";
      }
      const cloneFunctionStarts = new Set(
        cloneMatches.map((match) => content.lastIndexOf("function ", match.index ?? -1))
      );
      const cloneSyncFunctionStart = content.lastIndexOf(
        "function ",
        cloneSync.index ?? -1
      );
      if (
        cloneFunctionStarts.size !== 1 ||
        cloneSyncFunctionStart === -1 ||
        !cloneFunctionStarts.has(cloneSyncFunctionStart)
      ) {
        return "clone registrations and sync loop are in different functions";
      }

      const usageReducerPattern = new RegExp(
        `function (${identifier})\\((${identifier})\\)\\{for\\(let (${identifier})=\\2\\.length-1;\\3>=0;\\3--\\)\\{let (${identifier})=\\2\\[\\3\\],(${identifier})=\\4\\?(${identifier})\\(\\4\\):void 0;if\\(\\5\\)return\\{input_tokens:\\5\\.input_tokens,output_tokens:\\5\\.output_tokens,cache_creation_input_tokens:\\5\\.cache_creation_input_tokens\\?\\?0,cache_read_input_tokens:\\5\\.cache_read_input_tokens\\?\\?0\\}\\}return null\\}`,
        "g"
      );
      const usageReducerMatches = [...content.matchAll(usageReducerPattern)];
      if (usageReducerMatches.length !== 1) {
        return `expected 1 semantic statusline usage reducer, found ${usageReducerMatches.length}`;
      }
      // The reducer is called through a per-chunk import alias on 2.1.242+, so
      // it cannot be pinned by the name captured at its declaration. Mirror the
      // patcher: anchor on the `?.outputStyle||` assignment that precedes the
      // selector, inside the function that emits `context_window:`.
      const selectorPattern = new RegExp(
        `${identifier}=${identifier}\\?\\.outputStyle\\|\\|[^,]{1,40},(${identifier})=${identifier}\\(__calicoStatuslineMessages\\((${identifier})\\)\\),(${identifier})=(${identifier})\\((${identifier}),(${identifier})\\(\\)\\)`,
        "g"
      );
      const selectorCandidates = [...content.matchAll(selectorPattern)];
      const selectorMatches = selectorCandidates.filter((match) => {
        const index = match.index ?? -1;
        const functionStart = content.lastIndexOf("function ", index);
        const functionEnd = content.indexOf("function ", index + match[0].length);
        const segment = content.slice(
          functionStart,
          functionEnd === -1 ? content.length : functionEnd
        );
        // The selected usage and the computed window must be the two arguments
        // the payload's `context_window:` is built from. custom-context-window
        // runs after this module and wraps the window argument, so tolerate
        // that wrapper here.
        const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const consumption = new RegExp(
          `context_window:${identifier}\\(${escape(match[1])},(?:globalThis\\.__calico_display_window\\()?${escape(match[3])}\\)`
        );
        return segment.includes("context_window:") && consumption.test(segment);
      });
      if (selectorMatches.length !== 1) {
        return `expected 1 reducer-bound statusline selector projection, found ${selectorMatches.length}`;
      }

      const commitText = terminal[0];
      if (countOccurrences(content, commitText) !== 1) {
        return "terminal commit marker is not unique";
      }
      if (content.includes("__calicoUsageCommitted")) {
        return "obsolete wrapper-level boolean marker is still present";
      }

      const terminalSegment = content.slice(
        aggregationIndex,
        terminalIndex + commitText.length
      );
      if (
        aggregationIndex < canonicalStart ||
        !terminalSegment.startsWith(
          `case"message_delta":{${usageLocal}=${aggregationFunction}(${usageLocal},${rawEventLocal}.usage);`
        ) ||
        !terminalSegment.includes(`for(let ${terminalLoopLocal} of ${terminalArray})`) ||
        !terminalSegment.includes(`${terminalLoopLocal}.message.usage=${usageLocal}`) ||
        !terminalSegment.includes(`${terminalLoopLocal}.message.stop_reason=${stopReasonLocal}`) ||
        !terminalSegment.includes(`${terminalLoopLocal}.message.stop_details=${rawEventLocal}.delta.stop_details??null`) ||
        terminalSegment.includes("=>") ||
        terminalSegment.includes("function ") ||
        terminalSegment.includes('case"message_stop"') ||
        terminalSegment.includes("onStreamingThinking")
      ) {
        return "usage snapshot escaped the canonical terminal message_delta mutation loop";
      }

      const cloneSyncIndex = cloneSync.index ?? -1;
      const cloneEventPattern = new RegExp(
        `if\\((${identifier})\\.type==="stream_event"&&\\1\\.event\\.type==="message_delta"\\)`,
        "g"
      );
      const cloneEventMatches = [...content.matchAll(cloneEventPattern)].filter(
        (match) =>
          (match.index ?? -1) < cloneSyncIndex &&
          content.lastIndexOf("function ", match.index ?? -1) === cloneSyncFunctionStart
      );
      const cloneEvent = cloneEventMatches.at(-1);
      const cloneEventIndex = cloneEvent?.index ?? -1;
      const cloneDirectSegment =
        cloneEventIndex === -1 ? "" : content.slice(cloneEventIndex, cloneSyncIndex);
      if (
        cloneEventIndex === -1 ||
        cloneSyncIndex - cloneEventIndex > 300 ||
        cloneEvent?.[1] !== registeredSource ||
        cloneDirectSegment.includes("=>") ||
        cloneDirectSegment.includes("function ")
      ) {
        return "clone source is not the downstream message_delta event being synchronized";
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
    id: "sticky-prompt-header",
    kind: "custom",
    describe: "fullscreen sticky prompt header re-reads the viewport on every render",
    disabledMarker: /if\(!0\|\|[A-Za-z_$][\w$]*\[\d+\]!==[A-Za-z_$][\w$]*\.handle\)/,
    run: (content: string): string | null => {
      const identifier = "[A-Za-z_$][\\w$]*";
      const forced = new RegExp(
        `if\\(!0\\|\\|(${identifier})\\[(\\d+)\\]!==(${identifier})\\.handle\\)(${identifier})=\\3\\.handle\\?\\.(isSticky|getScrollTop|getPendingDelta)\\(\\)`,
        "g"
      );
      const stale = new RegExp(
        `if\\((${identifier})\\[(\\d+)\\]!==(${identifier})\\.handle\\)(${identifier})=\\3\\.handle\\?\\.(isSticky|getScrollTop|getPendingDelta)\\(\\)`,
        "g"
      );
      const forcedMatches = [...content.matchAll(forced)];
      const staleMatches = [...content.matchAll(stale)];

      // 2.1.247 introduced the handle-keyed memo; before it the reads were
      // straight-line and the header worked unaided, so absence there is
      // correct rather than a missing patch. Version-gate the waiver instead of
      // waiving on absence alone: on 2.1.247+ a read still keyed on the handle
      // is the defect this module exists to remove.
      const versionMatch = content.match(
        /PACKAGE_URL:"@anthropic-ai\/claude-code"[\s\S]{0,500}?VERSION:"(\d+)\.(\d+)\.(\d+)"/
      );
      const version = versionMatch?.slice(1).map(Number);
      if (version === undefined) {
        return "expected parseable Claude Code VERSION metadata";
      }
      const memoizedHere =
        version[0] > 2 ||
        (version[0] === 2 &&
          (version[1] > 1 || (version[1] === 1 && version[2] >= 247)));

      if (!memoizedHere) {
        return forcedMatches.length === 0 && staleMatches.length === 0
          ? null
          : "unexpected handle-keyed viewport memo on a bundle that predates it";
      }

      if (staleMatches.length > 0) {
        return `found ${staleMatches.length} viewport read(s) still frozen on the handle identity`;
      }
      if (forcedMatches.length !== 3) {
        return `expected 3 forced viewport reads, found ${forcedMatches.length}`;
      }
      const kinds = new Set(forcedMatches.map((match) => match[5]));
      if (kinds.size !== 3) {
        return `expected isSticky, getScrollTop and getPendingDelta, found ${[...kinds].join(", ")}`;
      }
      const cacheLocals = new Set(forcedMatches.map((match) => match[1]));
      const viewportLocals = new Set(forcedMatches.map((match) => match[3]));
      if (cacheLocals.size !== 1 || viewportLocals.size !== 1) {
        return "forced viewport reads do not share one memo cache and viewport";
      }
      // The header is published through this setter, and the literal occurs
      // twice in the whole bundle. Without it the memo shape alone would accept
      // a forced guard in any other compiled component reading a `.handle`.
      const owner = content.lastIndexOf("function ", forcedMatches[0].index ?? -1);
      if (
        owner === -1 ||
        !boundedToModule(content.slice(owner, (forcedMatches[0].index ?? 0) + 4000)).includes(
          "setStickyPrompt"
        )
      ) {
        return "forced viewport reads are not inside the sticky-prompt component";
      }
      return null;
    },
  },
  {
    id: "statusline-rate-limit-windows",
    kind: "custom",
    describe:
      "Fable 5 and usage-credit windows forwarded, two-window rate_limits guard replaced",
    disabledMarker: /\.\.\.Object\.keys\([A-Za-z_$][\w$]*\)\.length>0&&\{rate_limits:/,
    run: (content: string): string | null => {
      const identifier = "[A-Za-z_$][\\w$]*";
      const windowMarker = (key: string) =>
        new RegExp(
          `\\.\\.\\.(${identifier})\\.${key}&&\\{${key}:\\{used_percentage:\\1\\.${key}\\.utilization\\*100,resets_at:\\1\\.${key}\\.resets_at\\}\\}`
        );
      const missing = ["five_hour", "seven_day", "seven_day_overage_included", "overage"].filter(
        (key) => !windowMarker(key).test(content)
      );
      if (missing.length > 0) {
        return `missing forwarded rate-limit window(s): ${missing.join(", ")}`;
      }
      const widenedGuard = new RegExp(
        `\\.\\.\\.Object\\.keys\\((${identifier})\\)\\.length>0&&\\{rate_limits:\\1\\}`
      );
      if (!widenedGuard.test(content)) {
        return "rate_limits payload guard was not widened to all windows";
      }
      const originalGuard = new RegExp(
        `\\.\\.\\.\\((${identifier})\\.five_hour\\|\\|\\1\\.seven_day\\)&&\\{rate_limits:\\1\\}`
      );
      if (originalGuard.test(content)) {
        return "original two-window rate_limits guard is still present";
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
      ];
      const missing = required.filter((marker) => !content.includes(marker));
      if (missing.length > 0) {
        return `missing marker(s): ${missing.join(", ")}`;
      }
      // The injected lookup reads the resolver's own first parameter, whose
      // minified name changes between versions (2.1.257 renamed the second one),
      // so pin the call shape rather than a literal `(e)`. Requiring the early
      // return keeps this a check on the wiring, not just on the helper existing.
      const injectedLookup =
        /let __calico_window=__calico_context_window\(([A-Za-z_$][\w$]*)\);if\(__calico_window!==null\)return __calico_window;/;
      if (!injectedLookup.test(content)) {
        return "custom context-window lookup is not wired into the resolver";
      }
      // Separate injection, separate check. Replacing the old literal marker
      // with the resolver check above left the precompute bypass unverified: if
      // precomputePattern drifts, an explicitly mapped window silently gets the
      // upstream precompute buffer subtracted from it and everything still
      // reports clean. Parameter-agnostic, since those names are minified.
      const precomputeBypass =
        /if\(process\.env\.CALICO_MODEL_CONTEXT_WINDOWS\)return [A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\);return Math\.min\(/;
      if (!precomputeBypass.test(content)) {
        return "precompute buffer is not bypassed for explicitly mapped context windows";
      }
      // The effective-window gate reads `CALICO_MODEL_CONTEXT_WINDOWS?<window>:<window>-<reserve>`,
      // where both are minified locals that differ per platform build of the
      // same version (arm64 swaps the reserve/ctx bindings, yielding `?o:o-n`
      // instead of `?o:o-r`). Match the shape with the window local
      // backreferenced instead of pinning `o`/`r`.
      const effectiveGate =
        /CALICO_MODEL_CONTEXT_WINDOWS\?([A-Za-z_$][\w$]*):\1-[A-Za-z_$][\w$]*/;
      return effectiveGate.test(content)
        ? null
        : "missing effective-window gate (CALICO_MODEL_CONTEXT_WINDOWS?<window>:<window>-<reserve>)";
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
    kind: "custom",
    disabledMarker: "__cc_streamingThinking",
    describe: "live-streaming plumbing and main-session brief-filter preservation",
    run: (content) => {
      if (!content.includes("__cc_streamingThinking")) {
        return "expected __cc_streamingThinking live-streaming plumbing";
      }
      const versionMatch = content.match(
        /PACKAGE_URL:"@anthropic-ai\/claude-code"[\s\S]{0,500}?VERSION:"(\d+)\.(\d+)\.(\d+)"/
      );
      const version = versionMatch?.slice(1).map(Number);
      if (version === undefined) {
        return "expected parseable Claude Code VERSION metadata";
      }
      const requiresBriefFilter =
        version[0] > 2 ||
        (version[0] === 2 &&
          (version[1] > 1 || (version[1] === 1 && version[2] >= 216)));
      if (
        requiresBriefFilter &&
        !/if\(([A-Za-z_$][\w$]*)\?\.type==="thinking"\|\|\1\?\.type==="redacted_thinking"\)return!0;if\(\1\?\.type==="tool_use"/.test(
          content
        )
      ) {
        return "expected main-session brief filter to preserve thinking entries";
      }
      // The bare __cc_streamingThinking containment above is satisfied by the
      // reducer-side __cc_streamingThinkingMessage plumbing alone (substring
      // coincidence), which let 2.1.236/237 builds pass with the renderer side
      // silently un-patched. From 2.1.234 (earliest bundle verified for these
      // anchors) require the renderer threading and inline-extras markers too.
      const requiresRendererThreading =
        version[0] > 2 ||
        (version[0] === 2 &&
          (version[1] > 1 || (version[1] === 1 && version[2] >= 234)));
      if (requiresRendererThreading) {
        // The renderer must declare the streamingThinking parameter…
        const rendererSignaturePattern =
          // 2.1.257 moved the destructuring out of the parameter list
          // (`function f(p){let c=_(203),{messages:…}=p`), so the opener is a
          // comma there and a paren before. Kept in lockstep with the anchors in
          // patch-claude-display.ts.
          /[(,]\{messages:[^}]*?streamingToolUses:[A-Za-z_$][\w$]*,streamingThinking:[A-Za-z_$][\w$]*,/;
        if (!rendererSignaturePattern.test(content)) {
          return "expected renderer signature to declare a streamingThinking parameter";
        }
        // …and exactly one call site must actually pass it. The signature also
        // matches the `screen:…,streamingToolUses:…,streamingThinking:` shape,
        // so exclude its own __cc_streamingThinking param; the 2.1.236+ store
        // destructure has no preceding `screen:` and cannot match. A marker
        // existing (signature injected, store local declared) is not proof the
        // renderer receives the value — broken-2.1.235-class bundles carry the
        // signature and the inline extras with no caller prop, and must fail
        // here.
        const rendererCallSitePattern =
          /screen:[^,}]+,streamingToolUses:[A-Za-z_$][\w$]*,streamingThinking:([A-Za-z_$][\w$]*)[,}]/g;
        const rendererCallSites = [...content.matchAll(rendererCallSitePattern)].filter(
          (match) => match[1] !== "__cc_streamingThinking"
        );
        // 2.1.245 replaced the explicit prop list at the main call site with a
        // rest spread inside a React-compiler memo cache, so that shape is the
        // second accepted form.
        const compilerCallSitePattern =
          /\{\.\.\.[A-Za-z_$][\w$]*,[^{}]*streamingToolUses:[A-Za-z_$][\w$]*,streamingThinking:__cc_streamingThinking[,}]/;
        const compilerCallSiteMatch = content.match(compilerCallSitePattern);
        const usesCompilerCallSite = compilerCallSiteMatch !== null;
        if (rendererCallSites.length !== 1 && !usesCompilerCallSite) {
          return `expected 1 renderer call-site streamingThinking prop, found ${rendererCallSites.length}`;
        }

        // Upstream patch-claude-code solves the same compiler-cache problem a
        // second way, and that path now runs first: it reads the store through
        // an inline arrow selector and forces the cached element to rebuild by
        // short-circuiting the guard to `if(!0||…)` instead of claiming a cache
        // slot. Both wirings are legitimate — the slot-growing one below is
        // still what fires on bundles this shape does not match — so recognise
        // it here rather than demanding a selector declaration it never emits.
        //
        // Both halves have to sit in the same function as the compiler call
        // site. A bare `content.includes("if(!0||")` would let an unrelated
        // short-circuit anywhere in a 33MB bundle — or one the patcher spliced
        // into the wrong nearby `if` — satisfy this branch, and the cache-slot
        // checks below would then be skipped for a binary whose renderer memo
        // is still stale.
        const forcedRebuildWiring = (() => {
          const callSiteIndex = compilerCallSiteMatch?.index ?? -1;
          if (callSiteIndex < 0) {
            return false;
          }
          const functionStart = content.lastIndexOf("function ", callSiteIndex);
          if (functionStart === -1) {
            return false;
          }
          const storeRead = content.match(
            /__cc_streamingThinking=[A-Za-z_$][\w$]*\((?:[A-Za-z_$][\w$]*|\([^()]*\))\?\.stream,\(__cc_state\)=>__cc_state\.streamingThinking\)\?\?null,/
          );
          const storeReadIndex = storeRead?.index ?? -1;
          if (storeReadIndex < functionStart || storeReadIndex > callSiteIndex) {
            return false;
          }
          // The guard has to be the one that owns the renderer assignment, not
          // the nearest `if(` before the call site: an intervening conditional
          // would let a forced-true branch elsewhere stand in for the real memo
          // guard, and the element would keep coming back stale. Locate the
          // assignment whose props object carries the injected prop, then
          // require the guard whose condition closes immediately before it to
          // be the short-circuited one.
          const assignPattern =
            /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\(([A-Za-z_$][\w$]*),\{/g;
          let rendererAssignIndex = -1;
          for (const assignMatch of content.slice(functionStart, callSiteIndex + 1).matchAll(assignPattern)) {
            rendererAssignIndex = functionStart + (assignMatch.index ?? 0);
          }
          if (rendererAssignIndex === -1) {
            return false;
          }
          const guardIndex = owningGuardIndex(content, rendererAssignIndex);
          return guardIndex > functionStart && content.startsWith("if(!0||", guardIndex);
        })();

        if (usesCompilerCallSite && !forcedRebuildWiring) {
          // Passing the prop is not sufficient at a compiler-cached call site:
          // the element is only rebuilt when one of the compared cache slots
          // changes, so an injected value that occupies no slot would leave the
          // renderer showing a stale element forever while every text-level
          // check still passed. Pin the whole wiring — stable selector, one
          // store read, and a guard slot that is written back and that lives
          // inside a cache allocation grown to hold it.
          if (
            countOccurrences(
              content,
              "function __cc_streamingThinkingSelector(e){return e.streamingThinking}"
            ) !== 1
          ) {
            return "expected exactly one stable __cc_streamingThinkingSelector declaration";
          }
          // The store receiver is a plain local on 2.1.245/246 and a
          // parenthesised expression on 2.1.247.
          const storeReadPattern =
            /__cc_streamingThinking=[A-Za-z_$][\w$]*\((?:[A-Za-z_$][\w$]*|\([^()]*\))\?\.stream,__cc_streamingThinkingSelector\)\?\?null,/g;
          if ([...content.matchAll(storeReadPattern)].length !== 1) {
            return "expected exactly one streamingThinking store read at the renderer call site";
          }
          const guards = [
            ...content.matchAll(/([A-Za-z_$][\w$]*)\[(\d+)\]!==__cc_streamingThinking\)/g),
          ];
          if (guards.length !== 1) {
            return `expected 1 memo-cache guard on __cc_streamingThinking, found ${guards.length}`;
          }
          const cacheLocal = guards[0][1];
          const slot = Number(guards[0][2]);
          if (countOccurrences(content, `${cacheLocal}[${slot}]=__cc_streamingThinking`) !== 1) {
            return "expected the __cc_streamingThinking memo-cache slot to be written back";
          }
          const guardFunctionStart = content.lastIndexOf("function ", guards[0].index ?? -1);
          const allocPattern = new RegExp(
            `let ${cacheLocal.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}=[A-Za-z_$][\\w$]*\\((\\d+)\\)[,;]`
          );
          const alloc =
            guardFunctionStart === -1
              ? null
              : content.slice(guardFunctionStart, guards[0].index).match(allocPattern);
          if (!alloc || Number(alloc[1]) <= slot) {
            return `expected the memo cache to be grown past slot ${slot} for __cc_streamingThinking`;
          }
        }
        // The inline extras memo materialises streamed thinking into the
        // transcript. 2.1.246 restructured that memo away entirely, so the site
        // no longer exists to patch there. Every version before it still has the
        // site and still needs the marker: relaxing on the absence of an exact
        // unpatched-shape regex would let a bundle whose shape merely drifted
        // pass, approving a binary whose reducer updates state the UI never
        // consumes. So the relaxation is version-gated, and even on 2.1.246+ a
        // site that is still present un-patched is a failure.
        const allowsMissingExtras =
          version[0] > 2 ||
          (version[0] === 2 &&
            (version[1] > 1 || (version[1] === 1 && version[2] >= 246)));
        // Pinned to the memo's full 2.1.245 spelling, this regex missed both
        // later ones — the deduped `{id,minted}` shape and 2.1.257's
        // React-Compiler output, where the mapper and the flatMap sit in
        // separate cache slots and no `memo(()=>…)` call remains. Each time,
        // the site was still there and still unpatched, and each time this
        // waived it: 2.1.257 and 2.1.258 shipped with live thinking dead and
        // every module reported ok. Match only the message construction at the
        // core of the site, which all three spellings share and which nothing
        // else in the bundle builds. This text also survives in patched output,
        // which is harmless — the check is reached only when the extras marker
        // is absent, i.e. only when the patch did not fire.
        const unpatchedExtrasMemo =
          /\(\{content:\[(?:[A-Za-z_$][\w$]*\?\{\.\.\.[A-Za-z_$][\w$]*\.contentBlock,id:[A-Za-z_$][\w$]*\}:)?[A-Za-z_$][\w$]*\.contentBlock\]\}\)/;
        let extrasWaived = false;
        if (!content.includes("__cc_streamingThinkingExtras")) {
          if (!allowsMissingExtras) {
            return "expected inline streaming-thinking transcript extras";
          }
          if (unpatchedExtrasMemo.test(content)) {
            return "inline streaming-thinking transcript extras site is present but was not patched";
          }
          // 2.1.246+ with the site genuinely gone. Nothing above then requires
          // any stream-reducer injection, so the reducer check below stops being
          // optional: without it a renderer-only build passes while no stream
          // event ever populates the state it reads.
          extrasWaived = true;
        }
        // The stream reducer builds virtual thinking messages through
        // upstream's create-message helper. That helper's name is a per-chunk
        // import alias on 2.1.242+, so a name captured elsewhere resolves to a
        // different function here: a 2.1.245 build called the wrong one and
        // every turn with a thinking block rendered no assistant output, with
        // no error surfaced. Require the called name to be declared in the
        // reducer's own module.
        const reducerCalls = [
          ...content.matchAll(/__cc_streamingThinkingMessage=([A-Za-z_$][\w$]*)\(\{content:/g),
        ];
        // When the extras marker was waived this is the only thing left that
        // proves the reducer was patched at all, so presence becomes mandatory.
        // Otherwise presence is covered above and this only checks resolution.
        if (extrasWaived && reducerCalls.length === 0) {
          return "expected the stream reducer to build virtual thinking messages when inline extras are absent";
        }
        for (const call of reducerCalls) {
          const declaration = new RegExp(
            `function ${call[1]}\\(\\{content:[A-Za-z_$][\\w$]*,usage:`,
            "g"
          );
          const declared = [...content.matchAll(declaration)].some((match) =>
            inSameModule(content, match.index ?? -1, call.index ?? -1)
          );
          if (!declared) {
            return `stream reducer calls ${call[1]} to build virtual thinking messages, but that name is not the create-message helper declared in its own module`;
          }
        }
      }
      return null;
    },
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
    id: "disable-usage-wrapup",
    kind: "custom",
    // When this module is disabled, neither renamed calico gate may exist —
    // matching either one catches partially patched or transitional bundles.
    disabledMarker: /"calico_lantern_wick_off"|"calico_vellum_gone_"/,
    describe:
      "usage-limit wrap-up statsig gate names renamed to dead calico gates",
    run: (content: string): string | null => {
      // Bundles older than the feature carry neither the original gates nor
      // the renames; that is a pass (nothing to neutralize). 2.1.238+ bundles
      // must carry BOTH renamed gates, so a bundle where upstream changed or
      // removed one gate literal while the patcher renamed only the survivor
      // cannot pass as "nothing to neutralize" with an injection path left
      // active under a new gate name.
      const problems: string[] = [];
      for (const gate of ["tengu_lantern_wick_mode", "tengu_vellum_anchor"]) {
        if (content.includes(`"${gate}"`)) {
          problems.push(`found residual usage wrap-up gate "${gate}"`);
        }
      }
      const versionMatch = content.match(
        /PACKAGE_URL:"@anthropic-ai\/claude-code"[\s\S]{0,500}?VERSION:"(\d+)\.(\d+)\.(\d+)"/
      );
      if (versionMatch) {
        const [major, minor, micro] = versionMatch.slice(1).map(Number);
        const featureEra =
          major > 2 ||
          (major === 2 && (minor > 1 || (minor === 1 && micro >= 238)));
        if (featureEra) {
          for (const renamed of ["calico_lantern_wick_off", "calico_vellum_gone_"]) {
            if (!content.includes(`"${renamed}"`)) {
              problems.push(
                `expected renamed usage wrap-up gate "${renamed}" in a 2.1.238+ bundle`
              );
            }
          }
        }
      }
      return problems.length > 0 ? problems.join("; ") : null;
    },
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

  // Evaluation-order check for every globalThis handoff the patcher installed.
  // Runs once over the whole bundle rather than per module, because a helper
  // published by one module and read by another is not any single module's
  // property.
  let moduleNames: string[] = [];
  try {
    moduleNames = (
      require("./native-bun.ts") as { readClaudeJsModuleNames(path: string): string[] }
    ).readClaudeJsModuleNames(inputPath);
  } catch {
    // Older container formats have no module table; the check is a no-op there.
  }
  const unreachable = unreachableGlobalPublications(content, moduleNames);
  if (unreachable.length > 0) {
    for (const problem of unreachable) {
      console.log(`  FAIL cross-module-globals: ${problem}`);
    }
    failures.push({
      id: "cross-module-globals",
      detail: unreachable.join("; "),
    });
  }
  let verifiedCount = 0;
  let skippedCount = 0;
  for (const check of CHECKS) {
    if (disableSet.has(check.id)) {
      // This module was intentionally not applied. Skip its normal check, and
      // when a disabled marker exists, reverse-assert it is ABSENT so the
      // disable is proven (the patch really isn't in the bundle), not merely
      // ignored.
      const disabledMarker = disabledMarkerForCheck(check);
      if (disabledMarker !== undefined) {
        if (markerPresent(content, disabledMarker)) {
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

function evaluatePatchModule(id: string, content: string): string | null {
  const check = CHECKS.find((candidate) => candidate.id === id);
  return check ? evaluateCheck(check, content) : `unknown patch module: ${id}`;
}

function evaluateDisabledPatchModule(id: string, content: string): string | null {
  const check = CHECKS.find((candidate) => candidate.id === id);
  if (!check) {
    return `unknown patch module: ${id}`;
  }
  const disabledMarker = disabledMarkerForCheck(check);
  return disabledMarker !== undefined && markerPresent(content, disabledMarker)
    ? `disabled module marker unexpectedly present (${check.describe})`
    : null;
}

module.exports = { boundedToModule, evaluateDisabledPatchModule, evaluatePatchModule };

if (require.main === module) {
  void main();
}

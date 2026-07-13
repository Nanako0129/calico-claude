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
        `function (${identifier})\\(\\)\\{return\\{toolUseCount:0,latestInputTokens:0,cumulativeOutputTokens:0,recentActivities:\\[\\],activeMessageId:null,responseOutputTokens:new Map\\}\\}`,
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

      const completionPattern = new RegExp(
        `let (${identifier})=(${identifier})\\((${identifier}),(${identifier}),(${identifier})\\),(${identifier})=(${identifier})\\(\\1,\\4,(${identifier}),\\{suppressTelemetry:(${identifier})\\}\\);__calicoRefreshAgentUsage\\((${identifier}),\\1\\),(${identifier})\\((${identifier}),(${identifier})\\((${identifier})\\),(${identifier})\\);`,
        "g"
      );
      const completionMatches = [...content.matchAll(completionPattern)];
      if (completionMatches.length !== 1) {
        return `expected 1 semantic background completion refresh, found ${completionMatches.length}`;
      }
      const completion = completionMatches[0];
      const progressIndex = progress.index ?? -1;
      const completionIndex = completion.index ?? -1;
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
        completion[10] !== progress[2] ||
        completion[12] !== completion[4] ||
        completion[14] !== progress[2] ||
        completion[15] !== completion[3] ||
        progress[6] !== completion[5] ||
        progress[7] !== completion[11] ||
        progress[8] !== completion[4] ||
        progress[9] !== completion[13] ||
        progress[10] !== completion[3]
      ) {
        return "background progress/completion refresh seams do not share tracker ownership";
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
        [accountingSignalHelper, 1],
        [exactZeroHelper, 1],
        [statuslineHelper, 1],
        ["__calicoUsageHasAccountingSignal(", 3],
        ["__calicoUsageIsExactAllZero(", 2],
        ["__calicoStatuslineMessages(", 2],
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
        ["__calicoUsageHasAccountingSignal", 3],
        ["__calicoUsageIsExactAllZero", 2],
        ["__calicoStatuslineMessages", 2],
      ] as const) {
        const actual = countOccurrences(content, name);
        if (actual !== expected) {
          return `expected ${expected} total references to ${name}, found ${actual}`;
        }
      }

      const wrapperPattern = new RegExp(
        `let (${identifier})=\\{message:\\{\\.\\.\\.(${identifier}),content:(${identifier})\\(\\[(${identifier})\\],(${identifier}),(${identifier})\\.agentId,\\{requestId:(${identifier})\\?\\?void 0,messageId:\\2\\.id\\}\\)\\},requestId:\\7\\?\\?void 0,\\.\\.\\.(${identifier})\\(\\6\\.querySource,\\6\\.spawnedBySkill,\\6\\.activeSkill,\\6\\.activeMcpServer,\\6\\.activeMcpTool\\),type:"assistant",uuid:(${identifier})\\.randomUUID\\(\\),timestamp:new Date\\(\\)\\.toISOString\\(\\),\\.\\.\\.!1,__calicoUsageState:\\{committed:!1,usage:null\\},\\.\\.\\.(${identifier})&&\\{advisorModel:\\10\\}\\};`,
        "g"
      );
      const wrapperMatches = [...content.matchAll(wrapperPattern)];
      if (wrapperMatches.length !== 1) {
        return `expected 1 canonical wrapper-owned usage cell, found ${wrapperMatches.length}`;
      }
      const wrapper = wrapperMatches[0];
      const wrapperLocal = wrapper[1];
      const wrapperIndex = wrapper.index ?? -1;
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
      const usageReducer = usageReducerMatches[0][1];
      const escapedUsageReducer = usageReducer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const selectorPattern = new RegExp(
        `(${identifier})=${escapedUsageReducer}\\(__calicoStatuslineMessages\\((${identifier})\\)\\),(${identifier})=(${identifier})\\((${identifier}),(${identifier})\\(\\)\\)`,
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
        return segment.includes("context_window:");
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

function evaluatePatchModule(id: string, content: string): string | null {
  const check = CHECKS.find((candidate) => candidate.id === id);
  return check ? evaluateCheck(check, content) : `unknown patch module: ${id}`;
}

module.exports = { evaluatePatchModule };

if (require.main === module) {
  void main();
}

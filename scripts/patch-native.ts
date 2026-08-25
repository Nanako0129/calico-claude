#!/usr/bin/env node

const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");

type PatchOptions = {
  input: string;
  output: string;
  disable: string[];
  enable: string[];
  dryRun: boolean;
};

type NativeBunModule = {
  canNativeBunHandle(binaryPath: string): boolean;
  readNativeBunContent(binaryPath: string): string;
  readNativeBunModules(binaryPath: string): Array<{ name: string; content: string }>;
  writeNativeBunContent(binaryPath: string, content: string): void;
  writeNativeBunModules(binaryPath: string, replacements: ReadonlyMap<string, string>): void;
};

type PatchResult = {
  candidates: number;
  patched: number;
  skipped: boolean;
  reason: string | null;
};

type DisplayPatcher = {
  patchContents(
    contents: string[],
    opts: { disable: string[]; enable: string[] }
  ): {
    contents: string[];
    patchResults: Map<string, PatchResult>;
  };
  printPatchSummary(patchResults: Map<string, PatchResult>): void;
};

function printHelp(): void {
  console.log("Patch native Claude binaries");
  console.log("");
  console.log("Usage:");
  console.log(
    "  node scripts/patch-native.ts --input <native-binary> [--output <path>] [--dry-run] [--disable <ids>] [--enable <ids>]"
  );
}

function parsePatchIds(value: string, flagName: string): string[] {
  const ids = value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    throw new Error(`Expected a comma-separated list for ${flagName}`);
  }

  return ids;
}

function parseArgs(argv: string[]): PatchOptions {
  const opts: PatchOptions = {
    input: "",
    output: "",
    disable: [],
    enable: [],
    dryRun: false,
  };

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

    if (arg === "--output") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --output");
      }
      opts.output = value;
      i += 1;
      continue;
    }

    if (arg === "--disable") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --disable");
      }
      opts.disable.push(...parsePatchIds(value, "--disable"));
      i += 1;
      continue;
    }

    if (arg === "--enable") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --enable");
      }
      opts.enable.push(...parsePatchIds(value, "--enable"));
      i += 1;
      continue;
    }

    if (arg === "--dry-run") {
      opts.dryRun = true;
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

  if (!opts.output) {
    opts.output = opts.input;
  }

  return opts;
}

function loadNativeBunModule(): NativeBunModule {
  return require("./native-bun.ts") as NativeBunModule;
}

function loadDisplayPatcher(): DisplayPatcher {
  return require("../patch-claude-display.ts") as DisplayPatcher;
}

function isJavaScriptModule(name: string): boolean {
  return (
    name.endsWith(".js") ||
    name.endsWith("/root/cli") ||
    name === "claude" ||
    name === "claude.exe"
  );
}

async function patchNativeBinary(opts: PatchOptions): Promise<void> {
  const inputPath = path.resolve(opts.input);
  const outputPath = path.resolve(opts.output);

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input binary not found: ${inputPath}`);
  }

  if (!opts.dryRun && inputPath !== outputPath) {
    fs.copyFileSync(inputPath, outputPath);
    fs.chmodSync(outputPath, 0o755);
  }

  const binaryPath = opts.dryRun ? inputPath : outputPath;

  const nativeBun = loadNativeBunModule();
  if (!nativeBun.canNativeBunHandle(binaryPath)) {
    throw new Error(`Unsupported native Claude binary: ${binaryPath}`);
  }
  const javaScriptModules = nativeBun
    .readNativeBunModules(binaryPath)
    .filter((module) => isJavaScriptModule(module.name));
  const patcher = loadDisplayPatcher();
  const result = patcher.patchContents(
    javaScriptModules.map((module) => module.content),
    { disable: opts.disable, enable: opts.enable }
  );
  patcher.printPatchSummary(result.patchResults);

  const replacements = new Map<string, string>();
  for (let index = 0; index < javaScriptModules.length; index += 1) {
    if (result.contents[index] !== javaScriptModules[index].content) {
      replacements.set(javaScriptModules[index].name, result.contents[index]);
    }
  }

  if (!opts.dryRun && replacements.size > 0) {
    nativeBun.writeNativeBunModules(outputPath, replacements);
  }

  if (opts.dryRun) {
    console.log(`Dry run complete. ${replacements.size} native module(s) would change.`);
    return;
  }

  console.log(`Patched ${replacements.size} native module(s): ${outputPath}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  try {
    const opts = parseArgs(process.argv.slice(2));
    await patchNativeBinary(opts);
  } catch (error) {
    console.error(`Error: ${errorMessage(error)}`);
    process.exit(1);
  }
}

void main();

#!/usr/bin/env node

const fs = require("node:fs") as typeof import("node:fs");
const os = require("node:os") as typeof import("node:os");
const path = require("node:path") as typeof import("node:path");
const { execFileSync } = require("node:child_process") as typeof import("node:child_process");

type PatchOptions = {
  input: string;
  output: string;
  disable: string[];
  enable: string[];
  assertAll: boolean;
};

type NativeContentHandle = {
  content: string;
  write(patchedContent: string): Promise<void>;
};

type NativeContentModule = {
  readNativeContent(binaryPath: string): Promise<NativeContentHandle>;
};

const nativeContent = require("./native-content.ts") as NativeContentModule;

function printHelp(): void {
  console.log("Patch native Claude binaries via tweakcc");
  console.log("");
  console.log("Usage:");
  console.log(
    "  node scripts/patch-native-with-tweakcc.ts --input <native-binary> [--output <path>] [--disable <ids>] [--enable <ids>] [--assert-all]"
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
    assertAll: false,
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

    if (arg === "--assert-all") {
      opts.assertAll = true;
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

async function patchNativeBinary(opts: PatchOptions): Promise<void> {
  const inputPath = path.resolve(opts.input);
  const outputPath = path.resolve(opts.output);

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input binary not found: ${inputPath}`);
  }

  if (inputPath !== outputPath) {
    fs.copyFileSync(inputPath, outputPath);
    fs.chmodSync(outputPath, 0o755);
  }

  const handle = await nativeContent.readNativeContent(outputPath);
  const originalContent = handle.content;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-native-patch-"));
  const tempContentPath = path.join(tempDir, "content.js");
  fs.writeFileSync(tempContentPath, originalContent, "utf8");

  const patcherPath = path.resolve(__dirname, "..", "patch-claude-display.ts");
  const patchArgs = [patcherPath, "--file", tempContentPath];

  if (opts.enable.length > 0) {
    patchArgs.push("--enable", opts.enable.join(","));
  }
  if (opts.disable.length > 0) {
    patchArgs.push("--disable", opts.disable.join(","));
  }
  if (opts.assertAll) {
    patchArgs.push("--assert-all");
  }

  try {
    execFileSync(process.execPath, patchArgs, { stdio: "inherit" });
    const patchedContent = fs.readFileSync(tempContentPath, "utf8");
    await handle.write(patchedContent);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log(`Patched native binary via tweakcc: ${outputPath}`);
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

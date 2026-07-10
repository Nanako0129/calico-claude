const path = require("node:path") as typeof import("node:path");

type NativeInstallation = {
  path: string;
  kind: "native";
};

type TweakccModule = {
  readContent(installation: NativeInstallation): Promise<string>;
  writeContent(installation: NativeInstallation, content: string): Promise<void>;
};

type VendoredElfModule = {
  canVendoredElfHandle(binaryPath: string): boolean;
  readVendoredElfContent(binaryPath: string): string;
  writeVendoredElfContent(binaryPath: string, content: string): void;
};

type NativeContentHandle = {
  content: string;
  write(patchedContent: string): Promise<void>;
};

async function loadTweakcc(): Promise<TweakccModule> {
  const imported = await import("tweakcc");
  const merged =
    imported.default && typeof imported.default === "object"
      ? { ...imported.default, ...imported }
      : imported;

  if (typeof merged.readContent !== "function" || typeof merged.writeContent !== "function") {
    throw new Error("Loaded tweakcc module does not expose readContent/writeContent API");
  }

  return merged as TweakccModule;
}

function loadVendoredElfModule(): VendoredElfModule {
  return require("./vendored-elf-native.ts") as VendoredElfModule;
}

// Extract the bundled JavaScript content from a native Claude binary. Uses the
// tweakcc API first and falls back to the vendored ELF handler when tweakcc
// cannot parse the binary. Returns the content plus a bound writer that uses
// whichever mechanism succeeded for reading (with the same write-time fallback
// as the original patch-native flow).
async function readNativeContent(binaryPath: string): Promise<NativeContentHandle> {
  const resolvedPath = path.resolve(binaryPath);
  const tweakcc = await loadTweakcc();
  const installation: NativeInstallation = { path: resolvedPath, kind: "native" };

  let content: string;
  let write = async (patchedContent: string): Promise<void> => {
    try {
      await tweakcc.writeContent(installation, patchedContent);
    } catch (writeError) {
      const vendoredElf = loadVendoredElfModule();
      if (!vendoredElf.canVendoredElfHandle(resolvedPath)) {
        throw writeError;
      }

      console.warn(
        `Warning: tweakcc could not repack ELF binary; falling back to vendored ELF handler for ${resolvedPath}`
      );
      vendoredElf.writeVendoredElfContent(resolvedPath, patchedContent);
    }
  };

  try {
    content = await tweakcc.readContent(installation);
  } catch (readError) {
    const vendoredElf = loadVendoredElfModule();
    if (!vendoredElf.canVendoredElfHandle(resolvedPath)) {
      throw readError;
    }

    console.warn(
      `Warning: tweakcc could not extract JavaScript from ELF binary; falling back to vendored ELF handler for ${resolvedPath}`
    );
    content = vendoredElf.readVendoredElfContent(resolvedPath);
    write = async (patchedContent: string): Promise<void> => {
      vendoredElf.writeVendoredElfContent(resolvedPath, patchedContent);
    };
  }

  return { content, write };
}

module.exports = {
  loadTweakcc,
  loadVendoredElfModule,
  readNativeContent,
};

#!/usr/bin/env node

// Compatibility entrypoint for existing Calico scripts. Extraction now uses
// the native Bun container reader in patch-native.ts rather than tweakcc.
require("./patch-native.ts");

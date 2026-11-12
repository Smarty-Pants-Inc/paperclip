import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { PiThinkingCatalogModel } from "@paperclipai/adapter-utils/pi-rpc-default-thinking";

// Runtime-owned, immutable Pi 1.5.2 catalog. Inject into the pure shared selector;
// browser and generic adapter-utils/CJS consumers never load the Pi catalog.
// No discovery, credentials, or network I/O.
export const PI_RPC_BUILTIN_THINKING_CATALOG: readonly PiThinkingCatalogModel[] =
  getBuiltinProviders().flatMap(provider => getBuiltinModels(provider));

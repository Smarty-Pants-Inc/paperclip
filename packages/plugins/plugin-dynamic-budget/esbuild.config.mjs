import { build } from 'esbuild';
import { createPluginBundlerPresets } from '@paperclipai/plugin-sdk/bundlers';
const { esbuild } = createPluginBundlerPresets({ uiEntry: 'src/ui/index.tsx', sourcemap: true });
// Bundle manifest too: a local-path artifact must not depend on workspace links.
await Promise.all([
  build(esbuild.worker),
  build({ ...esbuild.manifest, external: [] }),
  build(esbuild.ui),
]);

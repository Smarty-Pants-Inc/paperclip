import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { createMailDefinition } from "./plugin.js";

const plugin = definePlugin(createMailDefinition());
export default plugin;
runWorker(plugin, import.meta.url);

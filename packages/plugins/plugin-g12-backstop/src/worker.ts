import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { createG12Definition } from "./plugin.js";

const plugin = definePlugin(createG12Definition());
export default plugin;
runWorker(plugin, import.meta.url);

import { runWorker } from "@paperclipai/plugin-sdk";
import { createRow12Plugin } from "./plugin.js";

const plugin = createRow12Plugin();
runWorker(plugin, import.meta.url);
export default plugin;

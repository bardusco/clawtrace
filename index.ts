import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { createClawTraceService } from "./src/service.js";

const plugin = {
  id: "clawtrace",
  name: "ClawTrace",
  description: "Real-time, redacted audit dashboard for OpenClaw tool calls.",
  // Manifest contains the real schema; keep runtime schema empty to avoid drift.
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerService(createClawTraceService(api));
  },
};

export default plugin;

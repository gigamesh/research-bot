import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "../package.json" with { type: "json" };

export default defineManifest({
  manifest_version: 3,
  name: "research-bot — Reseller Buddy capture",
  description:
    "Drives the authenticated Kajabi reseller community at shannonjean.info to capture posts and conversations for local insight extraction.",
  version: pkg.version,
  action: {
    default_title: "research-bot",
    default_popup: "src/popup/index.html",
  },
  options_ui: {
    page: "src/options/index.html",
    open_in_tab: true,
  },
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  content_scripts: [
    {
      matches: ["https://www.shannonjean.info/*"],
      js: ["src/content/kajabi.ts"],
      run_at: "document_idle",
    },
  ],
  permissions: ["storage", "activeTab", "alarms"],
  host_permissions: [
    "https://www.shannonjean.info/*",
    "http://localhost/*",
    "http://127.0.0.1/*",
  ],
});

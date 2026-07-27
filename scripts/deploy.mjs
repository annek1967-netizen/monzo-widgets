import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const args = ["wrangler", "deploy", ...process.argv.slice(2)];
if (existsSync("wrangler.local.toml")) {
  args.push("--config", "wrangler.local.toml");
}

const command = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(command, args, { stdio: "inherit" });
process.exit(result.status ?? 1);

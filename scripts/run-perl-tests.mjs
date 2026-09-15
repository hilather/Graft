/** Dedicated Perl runtime/platform gate; explicit filenames also work on Node 20/Windows. */
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = readdirSync(join(root, "test"))
  .filter((file) => /^(?:perl-.+|graph-perl(?:-.+)?|mcp-perl)\.test\.ts$/.test(file))
  .sort()
  .map((file) => join(root, "test", file));
if (files.length === 0) throw new Error("No Perl regression files found");
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "commit.gpgsign", GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "tag.gpgsign", GIT_CONFIG_VALUE_1: "false",
  },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

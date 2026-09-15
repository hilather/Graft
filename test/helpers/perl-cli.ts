import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const perlCliPath = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

export function perlCli(fixture: { root: string; out: string }, args: string[]) {
  const result = spawnSync(process.execPath, [perlCliPath, "--dir", fixture.out, ...args], { cwd: fixture.root, encoding: "utf8", timeout: 30_000 });
  assert.ifError(result.error);
  return result;
}

export function perlGit(root: string, ...args: string[]) {
  const result = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd: root, encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

export function initPerlGit(root: string) {
  perlGit(root, "init", "-b", "main");
  perlGit(root, "config", "user.name", "Perl fixture");
  perlGit(root, "config", "user.email", "perl-fixture@example.invalid");
}

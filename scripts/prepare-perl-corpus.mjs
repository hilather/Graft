/** Fetch the explicitly pinned release corpus. Copies source; never runs Perl. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { manifest: { type: "string" }, config: { type: "string" }, output: { type: "string" } } });
assert.ok(values.manifest && values.config && values.output, "Usage: node scripts/prepare-perl-corpus.mjs --manifest FILE --config FILE --output NEW_DIRECTORY");
const manifestBytes = readFileSync(resolve(values.manifest));
const manifest = JSON.parse(manifestBytes);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const config = readFileSync(resolve(values.config));
assert.equal(hash(config), manifest.configSha256, "Configuration checksum mismatch");
const output = resolve(values.output);
assert.ok(!existsSync(output), "Use a new output directory to preserve existing corpora");
const inside = (root, path) => {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
const scratch = mkdtempSync(join(tmpdir(), "graft-corpus-download-"));
try {
  mkdirSync(output, { recursive: true });
  for (const project of manifest.projects) {
    assert.match(project.commit, /^[a-f0-9]{40}$/);
    assert.match(project.repo, /^[\w.-]+\/[\w.-]+$/);
    assert.equal(project.name, project.repo.split("/")[1]);
    const url = `https://codeload.github.com/${project.repo}/tar.gz/${project.commit}`;
    assert.equal(url, project.archiveUrl, "Archive URL must match its pinned official repository");
    process.stderr.write(`Downloading ${project.repo}@${project.commit}\n`);
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    assert.ok(response.ok, `${url}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, project.archiveBytes, "Archive size mismatch");
    assert.equal(hash(bytes), project.archiveSha256, "Archive checksum mismatch");
    const archive = join(scratch, "source.tar.gz"), unpacked = join(scratch, project.name);
    writeFileSync(archive, bytes); mkdirSync(unpacked);
    const extracted = spawnSync("tar", ["-xzf", archive, "-C", unpacked, "--strip-components=1"], { encoding: "utf8", timeout: 120000 });
    if (extracted.error) throw extracted.error;
    assert.equal(extracted.status, 0, extracted.stderr);
    const copy = (sourcePath, targetPath, expectedHash, expectedBytes) => {
      const source = resolve(unpacked, sourcePath), target = resolve(output, project.name, targetPath);
      assert.ok(inside(unpacked, source) && inside(unpacked, realpathSync(source)), "Source leaves its project");
      assert.ok(inside(join(output, project.name), target), "Output leaves its project");
      const data = readFileSync(source);
      assert.equal(hash(data), expectedHash, sourcePath);
      if (expectedBytes !== undefined) assert.equal(data.length, expectedBytes, sourcePath);
      mkdirSync(dirname(target), { recursive: true }); copyFileSync(source, target);
    };
    for (const file of manifest.files.filter(file => file.path.startsWith(`${project.name}/`))) {
      const path = file.path.slice(project.name.length + 1);
      copy(path, path, file.sha256, file.bytes);
    }
    // Keep each distribution's license declaration alongside the copied source.
    copy(project.licenseFile, project.licenseFile, project.licenseSha256);
  }
  writeFileSync(join(output, "graft.perl.json"), config);
  writeFileSync(join(output, "graft-benchmark-corpus.json"), manifestBytes);
  process.stdout.write(JSON.stringify({ output, files: manifest.files.length, sourceBytes: manifest.sourceBytes, manifestSha256: hash(manifestBytes) }) + "\n");
} finally { rmSync(scratch, { recursive: true, force: true }); }

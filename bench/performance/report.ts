import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const dir = resolve(process.argv[2]);
const meta = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const rows = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
const rust = rows.find((r: any) => r.scenario.startsWith("extract.rust"));
const separateSetup = existsSync(join(dir, "setup-reference.json"));
const fixed = (n: number) => n.toFixed(2);
const lines = ["# Initial performance comparison", "",
  `Runtime: ${meta.environment.node}, ${meta.environment.platform}/${meta.environment.arch}. CPU: ${meta.environment.cpuModel}.`,
  `Reference commit: \`${meta.commit}\`. Exact compiled-code and corpus digests are in [manifest.json](manifest.json).`, "",
  "| Scenario | Reference ms | Candidate ms | Reduction | Reference / candidate peak MiB | Samples each |",
  "| --- | ---: | ---: | ---: | ---: | ---: |",
  ...rows.map((r: any) => `| ${r.scenario} | ${fixed(r.reference.medianMs)} | ${fixed(r.candidate.medianMs)} | ${fixed(r.improvementPercent)}% | ${fixed(r.reference.medianPeakRssMiB)} / ${fixed(r.candidate.medianPeakRssMiB)} | ${r.samplesPerVariant} |`), "",
  "Times are operation medians. RSS is the median benchmark-process high-water value and includes setup/warmups; it is not the incremental allocation of the operation. Descendant processes, including Perl's isolated parser, are excluded. This is not an aggregate process-tree memory measurement.",
  "Every admitted scenario passed exact semantic-digest comparison across all baseline and candidate samples. Array order and numerical values were not normalized.", "",
  `The synthetic graph contains 1,500 files, 13,500 nodes and 24,000 edges. Blast changes 100 files; traversal runs 100 distinct seeds. The Rust fixture has ${rust?.candidate.counts.definitions ?? "unmeasured"} definitions and ${rust?.candidate.counts.references ?? "unmeasured"} calls.`,
  "Real build scenarios use a frozen copy of Graft's sources and multilingual fixtures. Application caches are cold or warm as named. OS page cache is uncontrolled.", "",
  "| Scenario | Reference CPU ms | Candidate CPU ms | Reference min–max ms | Candidate min–max ms |",
  "| --- | ---: | ---: | ---: | ---: |",
  ...rows.map((r: any) => `| ${r.scenario} | ${fixed(r.reference.medianCpuMs)} | ${fixed(r.candidate.medianCpuMs)} | ${fixed(r.reference.minMs)}–${fixed(r.reference.maxMs)} | ${fixed(r.candidate.minMs)}–${fixed(r.candidate.maxMs)} |`), "",
  "## Projection writes", "",
  ...rows.filter((r: any) => r.scenario.includes("projection") || r.scenario.startsWith("build.")).map((r: any) =>
    `- ${r.scenario}: ${r.reference.counts.projectionFilesReplaced} → ${r.candidate.counts.projectionFilesReplaced} files rewritten; ${r.reference.counts.projectionBytesReplaced} → ${r.candidate.counts.projectionBytesReplaced} projected bytes rewritten.`), "",
  "The legacy raw counter name `projectionFilesReplaced` counts observed mtime/inode changes, including in-place rewrites; it does not imply every baseline write replaced an inode.", "",
  "Raw per-run JSON records include child CPU, process wall time, peak RSS, I/O counters, and output digests. Samples alternate variant order and run sequentially. Short extraction/query cases perform five warmups per child. Sample counts are shown in the table; no tail-latency estimate is inferred from these runs.",
  separateSetup ? "Unchanged builds run in fresh processes against caches prepared in separate setup processes; setup is outside measurement. The operation timer measures the engine build, while processWallMs additionally includes benchmark-process startup and setup/inspection overhead."
    : "The initial unchanged-build scenario runs immediately after cold parsing in the same process and inherits its heap/GC state. This is distinct from a fresh CLI process using an existing disk cache; see the follow-up experiment before drawing a CLI-build conclusion.",
  "These results establish workload-specific effects on this machine. They do not establish an overall product speedup, a Windows result, browser performance, or all-language worker safety.", "",
];
writeFileSync(join(dir, "REPORT.md"), lines.join("\n"));

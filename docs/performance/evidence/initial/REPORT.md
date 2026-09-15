# Initial performance comparison

Runtime: v20.20.2, linux/x64. CPU: Intel(R) Core(TM) i7-6600U CPU @ 2.60GHz.
Reference commit: `b90d73b2f601ec0d2b132c3901658882630753f8`. Exact compiled-code and corpus digests are in [manifest.json](manifest.json).

| Scenario | Reference ms | Candidate ms | Reduction | Reference / candidate peak MiB | Samples each |
| --- | ---: | ---: | ---: | ---: | ---: |
| grep.synthetic | 438.13 | 36.36 | 91.70% | 103.42 / 104.38 | 20 |
| blast.synthetic | 672.81 | 48.12 | 92.85% | 173.47 / 120.30 | 20 |
| traverse.loaded | 743.71 | 0.80 | 99.89% | 220.64 / 128.38 | 20 |
| projections.unchanged | 206.84 | 211.81 | -2.40% | 122.33 / 122.53 | 20 |
| extract.rust | 161.48 | 169.67 | -5.07% | 146.54 / 147.93 | 20 |
| build.real.cold | 19956.76 | 17825.32 | 10.68% | 337.53 / 336.27 | 7 |
| build.real.unchanged | 461.59 | 575.16 | -24.60% | 396.32 / 386.53 | 7 |

Times are operation medians. RSS is the median benchmark-process high-water value and includes setup/warmups; it is not the incremental allocation of the operation. Descendant processes, including Perl's isolated parser, are excluded. This is not an aggregate process-tree memory measurement.
Every admitted scenario passed exact semantic-digest comparison across all baseline and candidate samples. Array order and numerical values were not normalized.

The synthetic graph contains 1,500 files, 13,500 nodes and 24,000 edges. Blast changes 100 files; traversal runs 100 distinct seeds. The Rust fixture has 1200 definitions and 2400 calls.
Real build scenarios use a frozen copy of Graft's sources and multilingual fixtures. Application caches are cold or warm as named. OS page cache is uncontrolled.

| Scenario | Reference CPU ms | Candidate CPU ms | Reference min–max ms | Candidate min–max ms |
| --- | ---: | ---: | ---: | ---: |
| grep.synthetic | 510.25 | 48.72 | 395.58–676.59 | 32.06–74.68 |
| blast.synthetic | 716.26 | 109.85 | 601.59–1226.90 | 35.02–114.12 |
| traverse.loaded | 805.68 | 2.27 | 576.32–929.59 | 0.42–4.27 |
| projections.unchanged | 267.20 | 294.36 | 178.58–392.61 | 186.40–351.44 |
| extract.rust | 242.03 | 275.74 | 100.80–285.96 | 129.85–267.89 |
| build.real.cold | 19893.38 | 18491.22 | 14719.78–23300.49 | 14626.26–26052.24 |
| build.real.unchanged | 705.81 | 794.94 | 421.44–629.15 | 432.67–648.13 |

## Projection writes

- projections.unchanged: 1501 → 0 files rewritten; 1068572 → 0 projected bytes rewritten.
- build.real.cold: 326 → 326 files rewritten; 242512 → 242512 projected bytes rewritten.
- build.real.unchanged: 326 → 0 files rewritten; 242512 → 0 projected bytes rewritten.

The legacy raw counter name `projectionFilesReplaced` counts observed mtime/inode changes, including in-place rewrites; it does not imply every baseline write replaced an inode.

The committed [summary](summary.json) retains aggregate timings, CPU, peak RSS, I/O counters and parity outcomes. Individual run files are generated benchmark artifacts and are not kept in the current tree. Samples alternate variant order and run sequentially. Short extraction/query cases perform five warmups per child. Sample counts are shown in the table; no tail-latency estimate is inferred from these runs.
The initial unchanged-build scenario runs immediately after cold parsing in the same process and inherits its heap/GC state. This is distinct from a fresh CLI process using an existing disk cache; see the follow-up experiment before drawing a CLI-build conclusion.
These results establish workload-specific effects on this machine. They do not establish an overall product speedup, a Windows result, browser performance, or all-language worker safety.

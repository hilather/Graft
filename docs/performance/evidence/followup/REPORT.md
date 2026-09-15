# Initial performance comparison

Runtime: v20.20.2, linux/x64. CPU: Intel(R) Core(TM) i7-6600U CPU @ 2.60GHz.
Reference commit: `b90d73b2f601ec0d2b132c3901658882630753f8`. Exact compiled-code and corpus digests are in [manifest.json](manifest.json).

| Scenario | Reference ms | Candidate ms | Reduction | Reference / candidate peak MiB | Samples each |
| --- | ---: | ---: | ---: | ---: | ---: |
| build.real.unchanged | 493.63 | 490.44 | 0.65% | 176.54 / 175.58 | 20 |
| extract.rust.large | 862.65 | 484.95 | 43.78% | 224.62 / 226.42 | 20 |

Times are operation medians. RSS is the median benchmark-process high-water value and includes setup/warmups; it is not the incremental allocation of the operation. Descendant processes, including Perl's isolated parser, are excluded. This is not an aggregate process-tree memory measurement.
Every admitted scenario passed exact semantic-digest comparison across all baseline and candidate samples. Array order and numerical values were not normalized.

The synthetic graph contains 1,500 files, 13,500 nodes and 24,000 edges. Blast changes 100 files; traversal runs 100 distinct seeds. The Rust fixture has 6000 definitions and 12000 calls.
Real build scenarios use a frozen copy of Graft's sources and multilingual fixtures. Application caches are cold or warm as named. OS page cache is uncontrolled.

| Scenario | Reference CPU ms | Candidate CPU ms | Reference min–max ms | Candidate min–max ms |
| --- | ---: | ---: | ---: | ---: |
| build.real.unchanged | 739.70 | 750.98 | 451.28–692.51 | 448.82–704.73 |
| extract.rust.large | 962.33 | 649.29 | 620.65–2908.52 | 385.13–2080.12 |

## Projection writes

- build.real.unchanged: 326 → 0 files rewritten; 242512 → 0 projected bytes rewritten.

The legacy raw counter name `projectionFilesReplaced` counts observed mtime/inode changes, including in-place rewrites; it does not imply every baseline write replaced an inode.

Raw per-run JSON records include child CPU, process wall time, peak RSS, I/O counters, and output digests. Samples alternate variant order and run sequentially. Short extraction/query cases perform five warmups per child. Sample counts are shown in the table; no tail-latency estimate is inferred from these runs.
Unchanged builds run in fresh processes against caches prepared in separate setup processes; setup is outside measurement. The operation timer measures the engine build, while processWallMs additionally includes benchmark-process startup and setup/inspection overhead.
These results establish workload-specific effects on this machine. They do not establish an overall product speedup, a Windows result, browser performance, or all-language worker safety.

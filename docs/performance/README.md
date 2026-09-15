# TypeScript performance work

## Scope and baseline

The two supplied proposals are preserved as [design](Graft_TypeScript_Performance_Design.md)
and [implementation plan](Graft_TypeScript_Performance_Implementation.md).
They are proposals, not measurements. Implementation starts from
`b90d73b2f601ec0d2b132c3901658882630753f8`, one commit after their audited
`f9e65396e638e517aecae0d731017f53084d70ed`. That intervening commit added Perl
analysis and several reuse improvements. Perl fidelity is part of this work's
preservation contract. No new dependencies or runtime minimum are required.

The publication branch is based on the later `719a462` revision, which includes
additional Perl fixes and removes local Perl planning artifacts. The measurements
below retain their original baseline and candidate identities; they are not
new benchmark results against that later revision.

A frozen source archive and separately built executable are retained at
`/tmp/graft-perf-reference.WOHNZn`. Both variants use the installed lockfile
dependencies. Benchmarks use compiled JavaScript and the same Node executable;
baseline and candidate never share output caches. The archive is a local working
artifact; reproduce it from the SHA above, then build it with the pinned lockfile.

## Evaluation and benefit ledger

Status below distinguishes implemented portions from remaining proposals.
Initial aggregate results and exact parity outcomes are in
[the initial report](evidence/initial/REPORT.md). The completed initial batch
covers P02, P04, P06 and P13 below; the remaining program is staged follow-up
work. Expected benefits below are not claimed speedups.

| ID | Expected benefit | Current evaluation / work |
| --- | --- | --- |
| P01 | Lower fresh CLI latency and startup RSS | Still relevant. Eager CLI/refresh import paths need tracing and package-level comparisons. Synchronous public APIs must remain synchronous. |
| P02 | Less graph preparation CPU, particularly many-file grep and many-change blast | Initial implementation: lazy lookup views; per-file grouping; shared blast preparation with separate provenance walks; reuse only for loader-owned snapshots; eight-entry LRU bounds strong loader caches. Source snippet reuse and other consumers remain to assess. |
| P03 | Faster repeated MCP queries with less allocation | Deferred until validated graph/index pairing. Must account for manual concept edits, filtered body tokens and bounded retention. |
| P04 | Better scaling for overlapping definitions and many references; bounded parser/tree retention | Interval sweep, line difference array, and scoped WASM cleanup implemented. Oracle parity, failure-path cleanup, Node 24 grammar probes and repeated-parse memory comparisons pass. Native parser lifetimes are unchanged. |
| P05 | Lower build retention, fewer hashes/stats and unnecessary grammar initializations | Source retention and all-language warmup remain in current build. Recursive dependency stamping already covers nested graph code and query files; broader grammar identities still need assessment. |
| P06 | Fewer writes, inode replacements and filesystem notifications on unchanged builds | Compare-before-write cards, INDEX and covers implemented with atomic changed writes. Public emitted-card counts retained; optional internal I/O counters added. No overall cold-build speedup or per-write speedup claimed. |
| P07 | Faster large cache-miss builds | Conditional experiment only. Perl already uses an isolated worker. Native-addon compatibility, deterministic replay and bounded memory are prerequisites for other routes. |
| P08A | Reliable graph/index cache pairing during overlapping publication | Still needed before persistent prepared queries. Current ask-index reuse verifies input/output digests, but publication still uses direct `writeFileSync`; atomic sidecar output and validated pairing with wiring both remain to implement. |
| P08B | Less tokenization on incremental builds | Whole unchanged ask-index reuse already exists in this checkout. Per-document reuse must earn its extra cache cost on edited builds. |
| P09 | Lower large-query CPU and memory | Conditional on query profiles and exact floating-point/order parity. No approximations or ranking changes admitted. |
| P10 | Less duplicated concurrent refresh work and bounded workspace resources | Conditional after cache/publication contracts. Existing cross-process locks and freshness checks remain authoritative. |
| P11 | Faster outline/detail interactions for large graphs | Independent viewer track; requires actual browser measurements, including focus/selection/export preservation. |
| P12 | Fewer repeated endpoint-negotiation failures and less synthesis idle time | Optional deep-only work, validated with stubs first. Extra paid calls or reduced quality are not benefits. |
| P13 | Correct per-key serialization, concurrency accounting and latest-pending supersession | Admission fix implemented with controlled deferred-promise test. This is a correctness repair; no speedup claim. Sliding history-request scheduling remains conditional. |
| P14 | Lower large-cache serialization RSS/write volume | Conditional after profiling. Existing extraction-cache reuse reduces the originally described cost. No storage redesign without evidence. |

### Initial measured effects

| Change / workload | Reference → candidate | Interpretation |
| --- | --- | --- |
| P02 grep, 1,500-file synthetic graph | 438.13 → 36.36 ms | 91.7% lower median, exact results. |
| P02 blast, 100 changed files | 672.81 → 48.12 ms | 92.8% lower median; median benchmark-process peak RSS 173.47 → 120.30 MiB. |
| P02 repeated traversal, 100 seeds | 743.71 → 0.80 ms | Prepared lookup reuse removes repeated full-graph setup. |
| P06 unchanged projections | 1,501 → 0 file rewrites; 1,068,572 → 0 bytes rewritten | I/O benefit; elapsed median is roughly flat (206.84 → 211.81 ms). |
| P04 isolated lookup, 6,000 definitions / 12,000 queries | 284.85 → 1.82 ms | Exact parity; isolates lookup only. |
| P04 whole Rust extraction, 6,000 definitions / 12,000 calls | 862.65 → 484.95 ms | 43.8% lower median; exact raw extraction parity, 20 samples each. |
| P04 WASM retention, 600 Rust parses | 254.34 → 119.46 MiB median peak RSS | 53.0% lower peak in this soak; seven fresh processes per variant under Node 24, exact output parity. |
| Fresh-process unchanged real build | 493.63 → 490.44 ms | Essentially flat latency; all 325 files reused, 326 → 0 projection rewrites. |
| P13 queue with concurrency 2 | Peak active jobs 4 → 2; same-key overlaps 2 → 0 | Correctness fix demonstrated by the separate queue probes; a superseded pending job no longer runs. |

The initial Rust whole-extraction median was 5.1% slower, and the initial
unchanged real-build median was 24.6% slower. Both remain visible in the initial
report. The latter measured a warm build immediately after cold parsing in the
same process, so it inherited that parse's heap/GC state. The [follow-up](evidence/followup/REPORT.md)
used separate cache-setup processes and 20 fresh-process samples: build latency
was essentially flat, with zero projection rewrites. This does not erase the
initial same-process observation. The larger Rust workload demonstrates that the
lookup gain survives parsing/query/GC costs at scale. Cold real-build medians
favored the candidate, but ranges overlapped broadly; no firm overall build
speedup is claimed.

## Verification contract

- Exact JSON/output comparisons retain array order and full numerical values.
- Structural builds still hash decoded source, retain body tokens and preserve
  summaries. Query refresh remains projection-free.
- Public mutable graphs receive new request-local views; only disk snapshots
  opt into persistent lookup reuse.
- The benchmark harness records operation CPU, whole-child high-water RSS,
  projection replacements/bytes, raw timings and exact semantic digests.
- Synthetic cases isolate scaling. A frozen copy of Graft's sources and language
  fixtures supplies the real corpus. No overall speedup is inferred by multiplying
  individual improvements.

The initial and follow-up latency reports measure the interval change before
WASM cleanup. The later [WASM soak](evidence/wasm-soak/summary.json) measures the
final extractor with cleanup. It performs 600 parses of 100 definitions and 200
calls and samples memory every 100 parses after explicit JavaScript GC. The
committed summary and manifest retain aggregate results and code/lockfile
digests. Reference external memory grew by a median
104.79 MiB; candidate external memory stayed flat (−1.20 MiB from initial load).
JavaScript GC alone does not free these WASM allocations. Its elapsed timings
include memory sampling and forced GC and are diagnostic, not a CLI speed claim.

## Running the initial harness

Build each source variant with `npm run build`, then:

```sh
node node_modules/typescript/bin/tsc -p bench/performance/tsconfig.json
node bench/performance/dist/run.js /path/to/reference /path/to/candidate /path/to/results
```

Optional trailing scenario names select a subset. The runner alternates variant
order and keeps 20 samples per short scenario (each child performs five warmups),
or seven samples per cold-build scenario. Unchanged builds prebuild each variant's
cache in a separate setup process and retain 20 fresh-process samples. The initial
report predates that correction and retains its original same-process setup.
CPU is measured inside the worker, not the
launcher. Peak RSS includes setup and warmup, excludes descendant processes
(including Perl's parser worker), and is labelled accordingly. OS page
cache state is uncontrolled.

The repository keeps performance reports and eight compact JSON files: summaries
and reproducibility manifests for the initial, follow-up and WASM runs, plus
the [interval comparison](evidence/interval-scaling.json) and
[queue comparison](evidence/queue.json). Individual run records, CPU profiles
and copied harness snapshots are generated artifacts and are ignored. Manifests
retain corpus hashes and counts without repeating per-file inventories. Run the
benchmark harness to collect new raw data; the original recordings remain in
commit `0605e5c` if a historical investigation needs them.

This initial harness does not yet cover every W0/W5 requirement: CLI import
traces, fine-grained build phases, first/warm MCP protocol measurements, all edit
classes, browser interactions, Windows and publication recovery injection
remain explicit follow-up work. No release-readiness claim follows from the
initial measurements.

## Test environment observations

The first sandboxed suite attempt hit `spawnSync EPERM` in existing subprocess
tests. Its failures are not a usable performance baseline. An isolated reference
suite ran with subprocess permissions under Node 20.20.2: 1,390 passed, one
skipped, and one existing hook elapsed-time assertion failed under load. Its
isolated rerun passed. The candidate full Node 20 suite completed with 1,410
passes, one skip, and the same hook elapsed-time failure; its isolated rerun also
passed. This is a shared load-sensitive failure, not a clean full-suite result.

After the later WASM cleanup change, all 42 focused lifecycle, generic extraction
and container extraction tests passed under Node 20. All 12 lifecycle and breadth
grammar regression tests passed under Node 24.21.0. The production build and
`git diff --check` passed. Full-suite results precede cleanup; the focused reruns
cover that subsequent change. Windows was not available and remains a release
gate. The shell default is Node 26.7.0; acceptance comparisons pin the same
explicit runtime for both variants.

Before publishing the branch on `719a462`, the production build and all 62 focused
performance, generic/container extraction, and Perl overlay tests passed under
Node 20.20.2. No new performance claim is inferred from this validation run.

# Graft TypeScript Performance Design

Date: 2026-09-15; source audit started 2026-09-14\
Status: proposed architecture; source audit completed; performance measurements pending\
Baseline: `trailhq/Graft`, v0.18.0, commit `f9e65396e638e517aecae0d731017f53084d70ed`\
Companion: [Implementation plan](Graft_TypeScript_Performance_Implementation.md)

## 1. Decision and scope

Improve the existing TypeScript/Node application before considering a rewrite. Prioritize eliminating repeated work and allocation, then introduce bounded parallel extraction where measurements justify it. Keep existing native and WebAssembly Tree-sitter dependencies. This is an optimization of the current product, not a language migration.

This document covers structural indexing, incremental builds, CLI startup, MCP retrieval, search and graph algorithms, disk publication, browser visualization, optional deep enrichment, and App scheduling. All current languages, APIs, integrations, output contracts, and recovery behaviour remain acceptance requirements. Adding Perl or upgrading broad-tier languages to deeper analysis is separate work.

The source audit counted 139 application TypeScript files / 31,267 lines, five viewer TypeScript files / 1,097 lines, and 122 `*.test.ts` files. Lines include comments and whitespace. The upstream HEAD matched the baseline above when checked. No benchmark suite was run during this assessment. Complexity findings below come from source inspection; benefit rankings and target percentages are planning hypotheses, not measured speedups. Historical timings in source comments are not new baseline results.

Implement performance logic and benchmarks in TypeScript, using the repository's `node:test`, `tsx`, TypeScript build, and existing `.mjs` packaging conventions. Do not introduce Python benchmark, inventory, or test frameworks. Do not raise the minimum Node version, replace grammars, switch regex engines, or change package distribution as incidental optimization work.

## 2. What is already optimized

Avoid spending implementation waves rebuilding these mechanisms:

| Existing mechanism | Source | Consequence for this design |
| --- | --- | --- |
| One enumeration feeds extraction, scope discovery, and Go module lookup | `src/graph/build.ts:buildGraph` | Improve metadata reuse within that enumeration; do not describe the builder as independently walking for every stage. |
| Per-file extraction cache keyed by decoded-source hash and extractor stamp | `src/graph/extract-cache.ts` | Parallelize cache misses and reduce cache overhead. Unchanged files already avoid parsing. |
| Cheap freshness probe with stat checks, selective hashing, and `GRAFT_REFRESH=hash` | `src/graph/fingerprint.ts` | Preserve correctness and existing controls; do not substitute a TTL. |
| Cross-process refresh lock, post-lock re-probe, and graph-only query rebuild | `src/graph/refresh.ts` | Coalesce additional in-process work without deleting the existing lock or rebuilding cards during queries. |
| Parsed graph and ask-sidecar caches in long-lived processes | `src/graph/load.ts` | Cache prepared query structures above these readers. JSON parsing is already avoided on warm MCP reads. |
| Build-time token bags/document frequencies | `src/ask/index-file.ts` | Improve reuse, preparation, and candidate evaluation rather than inventing a missing search index. |
| One-pass PageRank scope partitioning, pooled dangling mass, lazy secondary ranking queues | `src/ask/graphrank.ts`, `src/ask/ask.ts`, `src/ask/fuse.ts` | Retain these improvements; optimize the remaining repeated work. |
| Resolver maps for names, owners, files, and language-specific lookups | `src/graph/resolve.ts` | Profile individual remaining hot spots; do not assume resolution is globally unindexed. |
| Graph JSON omits `body_text` | `src/graph/write.ts` | Body tokens must remain available through extraction/search caches. |
| Per-file LLM batching, concurrency, summary reuse, checkpoints, failure gates | `src/graph/enrich.ts`, `src/context/build.ts` | Optimize remaining scheduling and repeated negotiation, without multiplying requests or weakening durability. |
| App build/review process isolation and pending-job superseding | `src/app/*process.ts`, `src/app/queue.ts` | Preserve isolation and fix per-key admission before increasing throughput. |
| Barnes-Hut force layout and persistent SVG elements | `viewer/graph.ts` | Optimize tree/detail scans and DOM work; do not claim the current force engine is naive all-pairs layout. |

## 3. Prioritized opportunities

Priority means order of investigation, not a guarantee that every experiment ships. `N` = graph nodes, `E` = edges, `F` = indexed files, `C` = changed files, `D` = definitions in a source file, `R` = references in that file, and `L` = source lines.

| ID | Change | Main affected workload | Evidence and expected direction | Admission |
| --- | --- | --- | --- | --- |
| P01 | Lazy CLI and parser/provider imports | Every short CLI call; clean queries | Eager command imports reach engine, SDKs, and native grammars. Load command-specific code only when needed. | Early, high confidence; retain synchronous library API. |
| P02 | Shared graph lookup and adjacency views | Grep, callers, blast, map/detail | Grep scans all nodes per file; traversals rebuild maps; blast repeats preparation for each changed file. Remove repeated full scans. | Early, high confidence. |
| P03 | Prepared query data cache | Warm MCP `ask`, repeated in-process queries | Current queries recreate three token Maps per document plus by-ID maps and statistics despite cached JSON. | Early after cache contracts. |
| P04 | Faster extractor span algorithms; explicit WASM lifetime | Large/nested source files; repeated breadth parsing | Generic enclosing-definition lookup filters/sorts definitions for every reference; residual masks repeatedly touch nested spans. WASM release ownership needs validation. | Early algorithms; lifecycle change only against verified pinned APIs. |
| P05 | Lower build memory, duplicate hashing/stat reduction | Cold and incremental structural builds | Full source Map retained even without summarizer; whole-file hashes and file metadata can be computed twice. | Early, high confidence. |
| P06 | Write only changed projections | Explicit unchanged/one-file builds; hooks | Cards and INDEX are unconditionally rewritten. | Early, high confidence; output counts stay compatible. |
| P07 | Bounded parser pool | Large cold builds and large change sets | Cache-miss extraction is serial. | Conditional on native-addon safety, memory, and end-to-end benefit. |
| P08 | Reuse token bags and canonical views; coherent sidecars | Incremental builds and reliable prepared queries | Search sidecar is rebuilt for every node; graph/sidecar/fingerprint publish separately. | Coherence before advanced caching; incremental indexing later. |
| P09 | Exact lexical postings and numeric PageRank | Large-graph query CPU/RSS | Remaining full-corpus work and allocation-heavy iterations. | Experimental; exact ranking gate. |
| P10 | Shared refresh work and resource budgeting | Concurrent MCP requests, multi-repo workspaces | Existing lock prevents rebuild stampedes, but independent requests still repeat preparation/probes; nested pools risk oversubscription. | Conditional; freshness and isolation unchanged. |
| P11 | Indexed outline/detail and less browser DOM work | Large interactive graphs | Outline repeatedly scans edges/nodes and recounts descendants; detail resolves neighbours with repeated searches. | Early independent track. |
| P12 | Cache endpoint negotiation; bounded concept synthesis | `build --deep` on affected providers | Some endpoint incompatibilities are rediscovered per request; synthesis work remains sequential. | Optional; preserve cost, failure and checkpoint semantics. |
| P13 | Correct App per-key queue admission | App correctness and safe parallel scheduling | `pump()` can admit a pending job whose key is already running, making the Set undercount active work. | Prerequisite correctness fix; not claimed as a speedup. |
| P14 | Extraction-cache layout and serialization experiments | Very large incremental builds and peak RSS | Whole extraction JSON is read/written; sorted copies and complete JSON strings coexist. | Only if measured remaining bottleneck. |

P01–P06 and P11 offer substantial opportunities without requiring a parallel execution redesign. P13 is small but important before changing resource limits. P07–P10 are larger architectural changes and should follow evidence from the early work.

## 4. Compatibility invariants

### 4.1 Product and language coverage

Preserve dedicated extraction for TypeScript/JavaScript (including JSX/TSX and extension variants), Python, Go, Java, Kotlin, PHP, Swift, and R. Preserve broad support for Rust, C, C++, C#, Ruby, Scala, Elixir, Solidity, OCaml, Zig, Dart, Clojure, Nix, and Lua. Preserve Vue script-container extraction and line translation. OCaml/Zig currently have symbols-only fallback behaviour; this project must neither silently reduce nor advertise an unimplemented upgrade to that fidelity.

Keep the optional LSP paths and graceful missing-server behaviour. Keep CLI options/aliases/exit statuses, six canonical MCP tools and their historical aliases, the public JavaScript API, host configuration merging/removal, hooks, statuslines, graph exports, App endpoints, and brain integration.

### 4.2 Exact structural and retrieval behaviour

- Same node IDs, duplicate-definition ordinals, paths, kinds, spans, signatures, hashes, edge relations, origins/confidences, and ambiguity decisions.
- Preserve enumeration and edge encounter order before resolution, not just final sorted JSON. Stable sorting and traversal tie-breaking are observable.
- Preserve `localeCompare`, current Unicode/string slicing semantics, decoded UTF-16LE input, UTF-16BE skipping, and malformed-file handling.
- Preserve JavaScript RegExp syntax, per-line matching, error behaviour, hit caps, full truncated-hit counting, and which files contribute the first capped hits.
- Preserve query scores and final order, repo-wide corpus statistics shared across scopes (recomputed for a `--in`-filtered corpus), scope-local graph walks, file diversity, fallback candidates, concepts, body-only matches, source snippets, ranking switches, and workspace federation.
- Preserve summary/crux reuse and paid-work checkpoints. Tier-1 extraction caches contain no enrichment mutation.
- Preserve cold-versus-incremental byte equality of deterministic wiring output. Internal derived sidecars may gain a documented compatible format, but their semantics must remain equivalent.

### 4.3 Freshness and recovery

Explicit `build` and correctness checks must still reread and hash the decoded source content. A same-size edit with restored mtime must be repairable. Existing stat-only probe behaviour and its strict-hash escape hatch remain distinct from explicit build semantics.

Do not suppress refresh, add a stale-serving TTL, trust a watcher as the sole authority, or accept all extraction-cache hits as proof that the entire graph is unchanged. Manifests, scopes, Go module declarations, file sets, include rules, and meaning state can change downstream work.

Cache corruption or failure must degrade through the existing fallback path. Missing cards/indexes are repaired by explicit builds. Queries continue to avoid writing the Markdown projections and `.gitignore`. Freshness-report tools report drift; they must not silently repair it before reporting.

## 5. Architecture

### 5.1 Separate discovery, extraction, assembly, and publication

Retain `buildGraph()` as the public orchestrator and initially preserve its public options/result shape. Introduce internal stage contracts:

1. **Discover:** enumerate the existing Git-aware file set and carry trusted metadata from that enumeration. Snapshot build configuration and dependency identities.
2. **Read/classify:** decode and hash source once, decide cache hit/miss, record the existing file ordinal. Bound any asynchronous read-ahead by files and bytes.
3. **Extract:** process misses serially or through an approved pool; return plain per-file results. Cache hits do not require grammar warmup.
4. **Assemble:** concatenate results in original enumeration order, resolve edges once, apply scope guards, and carry over meaning.
5. **Index/project:** create canonical sorted views once where reusable; prepare search sidecars and optional cards without changing their content.
6. **Publish:** one coordinator within each build performs atomic individual-file writes, invalidates in-process caches, and records identities needed to reject mixed derived data. Independent builds can still overlap; this does not claim a cross-process transaction.

Separate stage timings are essential: faster parsing is not a successful change if cloning, serialization, or startup erases the gain.

### 5.2 Internal graph views (P02)

Add a dependency-light internal module, provisionally `src/graph/views.ts`, which constructs lazily requested views from a stable graph:

- `byId` and file-node lookup.
- `nodesByPath` and span-sorted symbol lists.
- Incoming/outgoing adjacency for walk relations, preserving original edge order and multiplicity.
- Incoming degree and `contains` adjacency.
- Optional pre-normalized symbol names and ID tails; do not replace qualified/suffix resolution semantics with an incomplete hash lookup.

Preparation costs `O(N+E)` for the requested views and uses references/ordinals rather than copying full node objects. Consumers request only what they need; grep does not need every possible adjacency map. For long-lived immutable graphs, a WeakMap keyed by graph object can share views. Weak references do not cap the underlying graph cache: add explicit capacity/eviction to the strong caches in `load.ts` when cross-repo retention becomes significant.

Graphs under construction and public caller-owned mutable graphs are not automatically safe WeakMap keys. Use request-local preparation for those inputs, or an explicit internal generation/invalidation contract. Do not make public `GraphV1` inputs immutable as a breaking API change. Cached disk graphs are already documented as shared and nonmutable; publish replacement snapshots instead of editing them in place.

Specific consumers:

- `grepGraph`: build `nodesByPath` once, reducing symbol grouping preparation from `O(F*N)` to `O(N)` plus per-file sorting. Preserve stable same-span selection. A separate interval lookup for matching lines is optional after the simple fix.
- `callersOf`/`calleesOf`/`edgeWalk`: reuse adjacency. BFS still performs a distinct traversal for each requested symbol when required by output semantics.
- `blastRadius`: prepare once per graph/diff, then run each changed file's seed walk with its own provenance. Do not merge all seeds and lose which change causes which effect.
- Map/skeleton/detail paths: use the same view contract where beneficial. Browser code gets a small `VizGraph`-specific equivalent, not a dependency on Node modules.
- Source inlining: share a request-scoped decoded-file/line cache and crux-pointer lookup across public results and ranking metadata. `ask.ts:sliceSpan()` can currently reread/split one file for multiple hits. Read each distinct requested file once per query, retaining error/encoding/snippet behaviour. Do not persist source text across requests without freshness validation. Blast evidence already has a per-file reader cache and does not need this mechanism rebuilt.

### 5.3 Prepared retrieval state (P03)

Layer prepared retrieval state on top of `loadGraphCached()` and `loadAskIndexCached()`. Reuse validated doc-by-ID mappings, field token Maps or compact arrays, field lengths, normalized paths/names, graph views, and query-independent topology. Keep query-specific scores, coverage Sets, selection queues, and output objects request-local.

The cache key is the combination of graph identity, ask-index identity, scoring/tokenizer revision, and concept-content revision. Filtered corpus statistics additionally depend on normalized `--in` and relevant ranking options. Concept Markdown can be edited without a graph rebuild; those edits must invalidate concept tokens and statistics. Reading a small concept corpus every time is an acceptable initial implementation.

Do not cache every possible filter indefinitely. Start with the base prepared corpus and a small bounded cache of expensive filtered statistics only if measurements justify it. Set a configurable internal byte/entry budget, instrument evictions, and avoid retaining a complete second graph alongside every prepared view.

When `--in` is active, use the sidecar's per-document body bags but recompute document frequencies, document count, and average body length for the filtered corpus. Wiring JSON deliberately lacks `body_text`; bypassing sidecar bags loses body-only matches. Do not use global statistics after filtering.

Invalidate on local publication, external replacement, graph/index deletion, failed reload, changed scoring code, changed concept content, and changed effective scope. A missing/invalid sidecar follows the existing live-tokenization fallback; a prepared index must not turn a degraded fallback into silently trusted stale data.

### 5.4 Lightweight command dispatch (P01)

Keep a small command-registration layer for option parsing, help text, version, telemetry hooks, and route selection. Dynamically import command implementations inside their actions. Move extension/language registries and type-only contracts into dependency-light modules so file enumeration and freshness probes do not import native grammars.

Move `refresh.ts`'s build import behind the actual dirty-build branch. A clean retrieval should not initialize parsers merely to probe freshness. Avoid routing structural commands through an eagerly constructed LLM engine when direct internal functions suffice.

Preserve synchronous exported methods and constructors. CLI actions may use asynchronous imports, but converting `Graft.ask()` or the synchronous model factory into a Promise is a breaking API change. Retain existing library exports; selectively restructure internal modules or lazily create SDK clients on an already-async request path.

Preserve dotenv/config precedence, command help/aliases, progress/error formatting, telemetry opt-out, background upkeep behaviour, and package-relative asset resolution. Delay expensive work without suppressing required side effects. Startup validation must exercise the built/npm-packed distribution, not only `tsx`.

## 6. Build and extraction designs

### 6.1 Low-retention source processing (P05)

For a structural build without a summarizer, do not populate the all-files `sources` Map; `enrichGraph()` returns before reading it. Still execute summary carry-over and keep extracted `body_text` through search-index construction. Removing bodies or summary bookkeeping would change retrieval.

Pass the builder's already computed whole-file hash into internal extractor entrypoints. Hash the exact decoded string currently used by `contentHash()`, including the current decoding behaviour; raw-byte hashing is not equivalent for UTF-16LE. Continue computing symbol-body hashes from their existing slices. Preserve public helper signatures through optional internal overloads/wrappers where necessary.

Carry existing `lstat`/file metadata from ingestion into source selection, retaining symlink handling, size limits, ignored files, nested repositories, submodules, and deletion races. Do not change `lstat` to following symlinks accidentally. A metadata record belongs to one enumeration/build, not a persistent claim that source contents are unchanged.

Delay native/WASM grammar initialization until a cache miss requires it. Large miss sets need bounded staging: do not read all source into memory simply to discover misses before starting work. Low-risk implementation can retain serial reading/hashing while overlapping a bounded number of extraction jobs. More aggressive async reads are optional and must preserve result order and race handling.

### 6.2 Extractor algorithms (P04)

`generic.ts:tagsExtract` currently finds a reference's enclosing definition by filtering all definitions and sorting candidates by width. Replace this with an offline sweep or interval structure. For the sweep, sort reference queries by source offset, insert definitions as their starts become eligible, and lazily expire ended intervals from a heap ordered by `(span width, original definition ordinal)`. The answer must satisfy `start <= at < end`. Map answers back to original reference order before emitting edges. Including definition/reference sorting, the target is `O((D+R) log(D+R))` total lookup preparation and evaluation, while preserving overlapping/equal-width semantics.

`extract.ts:fileResidual` marks every line covered by every symbol. A difference array increments at the existing clamped start line and decrements after the inclusive end line; one prefix pass reproduces the mask. Target `O(D+L)` work instead of repeatedly touching the full length of overlapping spans. Keep invalid-span handling, residual trimming, body length caps, and newlines identical.

WASM lifetime work is separate from those algorithms. The current APIs return bare roots from parse helpers and do not visibly release all parser/tree allocations. This is a retention hypothesis, not proof of a leak. Verify the pinned `web-tree-sitter` API and ownership, then wrap parse/extract in explicit lifetime scopes with `finally` cleanup. Queries and descendant nodes must be consumed before their tree is freed. Reuse parsers per grammar/worker only if safe. Do not assume native `tree-sitter@0.21.1` has the same deletion methods as the WASM binding.

### 6.3 Parser pool (P07)

Use a bounded pool for cache misses, with a measured workload threshold and a serial path for small or highly incremental builds. Node's documentation recommends workers for CPU-intensive JavaScript and a pool rather than creating a worker for every task [N1].

Each execution unit owns its runtime, parser instances, languages, queries, and trees. Send plain source strings or explicitly owned buffers plus path/language/ordinal/hash; return plain nodes, raw edges, and tagged outcomes. Never send SyntaxNode, Tree, Parser, Query, or live native pointers between units. Do not stringify large results to JSON just for worker messaging.

The main reader must establish one source snapshot: the worker parses the supplied source matching the recorded hash. Sending only paths and letting workers reread later can associate old hashes with new content. A worker-read design must instead return the exact decoded-source hash and all metadata used by the parent; choose one ownership model before implementation. Initially prefer parent-read source with bounded jobs/bytes.

Collect results in original file ordinal order. Within each file, preserve native extractor order and duplicate-ID minting. Preserve error order, language reporting, and progress contracts. Separate parse errors, missing-grammar degradation, unsupported encoding, worker initialization failures, and worker crashes; these are not interchangeable outcomes.

Native-addon safety is a release gate. Test every pinned native grammar in multiple isolates on supported platforms. A segmentation fault cannot be recovered with a rejected-Promise fallback; it may kill the parent. Graft's App already deliberately uses child processes for heavy native work. If compatibility or isolation is insufficient, use a bounded child-process pool or retain serial extraction. Do not globally enable a thread pool merely because one TS fixture passes.

Tune workers against startup, clone time, wall clock, CPU, process RSS, native/WASM memory, and container limits. `resourceLimits` does not cap every native allocation. Count nested App jobs and workspace builds against a shared budget; do not multiply each job by all available cores. Start conservatively, reserve capacity for the host, and benchmark several pool sizes. The default may differ for short CLI builds and long-lived services.

Worker lifecycle includes startup timeout, job cancellation, bounded retry only for infrastructure failures, pool shutdown, listener cleanup, and no publication after cancellation. A crashed file must not silently become a successful empty graph. Test compiled `dist` worker paths, packaged assets, Windows spawning, and development `tsx` execution.

### 6.4 Publication and projection work (P06/P08)

Initially keep `wiring.json`'s canonical bytes and public schema unchanged. Reuse a canonical sorted node view for graph serialization, search indexing, and checkpoints while topology is unchanged; preserve comparator and insertion-order semantics for derived statistics. Avoid accidental output changes from a new sort algorithm or reordered object properties.

For cards, INDEX, and covers, render the same bytes and compare with the existing file. Write atomically only when different; still create missing outputs and prune deleted cards. Reuse concept metadata within one build where safe. `CardStats.written` currently counts emitted cards, so keep that external meaning and add a separate internal `filesActuallyWritten` metric. File permissions and content read errors require the existing failure path, not an assumption of equality.

Make ask-sidecar writes atomic before adding prepared caches or incremental token data. Use build-unique temporary names and a single coordinator for each build; workers never publish files. Preserve cache-before-enrichment ownership: current extraction entries share node objects that `enrichGraph()` mutates. An async writer must serialize/snapshot pristine Tier-1 data before those mutations, not enqueue live object references for later serialization.

Do not assume every build holds the refresh lock. Direct CLI/API builds currently need not hold it, while refresh already acquires it before calling the builder. P08A relies on validated mixed-generation rejection/fallback, not a new universal single-writer guarantee. Preserve existing lock boundaries and do not unconditionally reacquire the same lock inside `buildGraph()`. Test direct build/API/refresh/checkpoint races. A future shared writer-lock design would require an explicit inherited lease/owner-token contract, ownership-safe release/reclaim, deep-build liveness, and compatibility with legacy writers; that is separate from the initial publication work.

Bind prepared graph/index state to content and implementation identities. A node-count/ID match alone does not detect stale bodies or summaries. Compute graph/index digests while producing their bytes, with separate tokenizer and extraction dependency identities. A small optional publication record can associate them without adding timestamps to wiring JSON. A new reader must verify referenced content on a cache miss and reject mismatched pairs; do not hash all large files on every warm request.

Atomic rename of each file is not a multi-file transaction. Mixed-generation reads can still occur. Read relevant signatures/identity before and after loading, retry once on change, and use the existing safe fallback on a mismatch; never spin indefinitely or claim transactional consistency. Old versions may write without publication records. Missing/stale records must cause fallback, not rejection of a valid legacy graph. Optional immutable generation files are a later design if stronger snapshot consistency is necessary.

Publication records are advisory unless validated against the actual graph/index bytes. They cannot hide modifications by an older writer that leaves the record behind. Explicitly invalidate in-process caches after local writes, including same-size/same-tick rewrites. Preserve existing external-change detection and test same-size atomic replacements. Do not claim the filesystem can detect arbitrary adversarial edits with restored metadata without reading bytes.

### 6.5 Incremental tokenization and validated no-change builds (P08)

Cache per-document token bags using ID, name, path, signature, summary, body input/hash, tokenizer revision, and extractor identity. A matching body hash alone is insufficient because a summary can change independently. Reuse body tokens from valid extraction/token caches; serialized wiring nodes cannot reconstruct all original body text.

A first safe improvement reuses unchanged token bags while recomputing global statistics deterministically. A later implementation can subtract old document frequencies/lengths and add changed ones, but must count each token once per document for DF, handle deletions, preserve concept contributions, and reproduce canonical ordering. Do not reuse global statistics for filtered requests.

A no-change build fast path is optional and must validate all downstream dependencies: decoded source hashes, visible file set, effective include/follow/only-dir configuration, scope markers, Go modules, extractor/grammar/query identities, meaning inputs, and output health. It must still repair deleted/stale cards, fingerprints, and search sidecars. If complete dependency tracking is not practical, retain full assembly and ship the simpler wins.

The current extractor stamp hashes sibling code and package version. New nested modules and query/grammar assets must enter a comprehensive reproducible dependency identity. Moving extraction logic into an untracked subdirectory must not make cache invalidation less complete. Preserve safe over-invalidation until a narrower dependency closure is proven.

## 7. Advanced query acceleration (P09)

These changes are optional after P02/P03 measurements. Keep a reference implementation available to differential tests.

**Lexical postings.** Build token-to-document postings from prepared fields and use them to find documents with nonzero lexical contributions. Retain corpus-wide/filtered statistics and evaluate the same formula in the same query-term order. Enumerate matched documents and construct seed Maps in original graph-document order, not query-token/postings-union order; this preserves seed summation and restart insertion order. Coverage/strength helpers use plural folding in places where lexical scoring uses exact tokens; do not collapse those contracts into one matcher. Concepts, test penalties, structural intent, zero-lexical graph propagation, fallback candidates, file grouping, secondary queues, and federation still participate. A naive global top-K before file selection is not equivalent.

**Numeric graph topology.** Map node IDs to stable integer ordinals and store adjacency offsets/targets in typed arrays. Use `Float64Array` for rank values and per-request scratch buffers. Preserve edge multiplicity, self-loop treatment, current restart/teleport behaviour, 25 iterations, pooled dangling mass, per-scope partitions, and final normalization. No convergence early-exit, pruning, quantization, deduplication, or altered damping parameters in a performance-only patch.

Floating-point accumulation order matters. Current Map iteration and first-touch ordering influence later additions. A dense array loop over all ordinals is not automatically equivalent. If exact score parity is required, preserve active first-touch order and neighbour order explicitly. Any tolerance proposal must be separately justified, with unchanged selected files, hit ordering, formatted scores, and confidence metrics; a small epsilon is not permission to change near ties.

Prepared numeric buffers must remain request-local or be borrowed exclusively. Concurrent MCP calls must not share mutable rank arrays. Cache immutable topology per graph/scope within a memory budget.

## 8. Runtime, UI, and deep workflows

### 8.1 Refresh and workspace scheduling (P10)

Add in-flight Promise sharing for equivalent overlapping refresh work in one process, keyed by resolved repository/output directory and effective configuration. Keep the cross-process lock and re-probe. Clean probes are still necessary: a completed Promise is not a cacheable freshness answer.

Define a freshness observation boundary for coalesced callers. A request arriving after an edit cannot blindly reuse a probe started before the edit; revalidate after the shared work where necessary. Keep deadlines, busy/stale notes, disabled-refresh handling, signal cleanup, worktree seeding, and `--only-dir` scope. Avoid negative caching of absent graphs.

Independent workspace repositories may use bounded concurrency only after a shared CPU/memory budget exists. Each child still resolves its own output directory. Preserve stable merged output order and partial-failure reporting. Clean-workspace workloads should not start parser pools at all.

Hooks amplify startup costs because prompt/edit paths spawn the full CLI and can separately reread wiring for statistics or blast output. First take P01/P02 gains. If profiling still identifies hook overhead, add a small dedicated child entrypoint that shares query/check code and returns the existing result contract. Preserve process-level timeout enforcement and exact drift-check semantics; replacing a killable child with synchronous native work in the hook process is not equivalent. Treat a valid built-empty graph separately from a missing graph when reading statusline statistics, so an empty graph does not repeatedly trigger full graph fallback parsing. Sharing the already bounded transcript-tail read within one hook invocation is optional cleanup, not a major claimed speedup.

### 8.2 Browser viewer (P11)

Build browser `byId`, `containsChildren`, incoming/outgoing edge views once per `VizGraph` revision. `renderOutline()` currently finds children by filtering all edges and finding nodes, then repeatedly recomputes descendant counts. Memoize/postorder counts for valid hierarchies, preserving edge order and duplicate relationships. Treat cycles defensively; do not change normal graph counts through unsolicited deduplication.

Cache indexes across expand/collapse. Use event delegation and update the affected branch or visible rows where practical. Preserve selected node, open state, Expand all/Collapse all, keyboard focus, labels, details, and export behaviour. Virtualization is conditional on a measured DOM bottleneck and must preserve access to every node.

`renderDetail()` can resolve neighbours through indexed IDs and adjacency. In `graph.ts`, cache theme/CSS values once per restyle, coalesce repeated restyles, and avoid updating hidden geometry until it must become visible. Catch up positions before showing elements. Preserve interactions and self-contained exports. Canvas/WebGL or a force-layout worker is a separate experiment only if SVG work remains dominant; the current D3 force algorithm already uses Barnes-Hut.

In `src/viz/serve.ts`, cache validated serialized graph responses and static assets by observed file/content generation. Context responses also depend on Markdown membership and manual edits. Optional ETags can avoid repeated transfer, but preserve response/error formats. In `viewer/main.ts`, coalesce reload events, discard obsolete fetch responses, and update only the graph that changed while retaining selection/open state. A watcher is an invalidation hint, not proof of freshness; check actual nested wiring changes and retain signature/generation fallback. Exported standalone pages must continue to work without a live server.

### 8.3 LLM workflows (P12)

`OpenAIChatModel.createChatCompletion()` adapts to certain exact incompatibility errors on each call. Cache only successfully negotiated capabilities within the client, keyed by endpoint/model and relevant request shape. Tool-choice restrictions may depend on whether there is one tool. A single-flight negotiation can avoid many concurrent first-request failures, but must not serialize all ordinary completions. Bound retries, expire/revalidate stale capability decisions after new failures, and never generalize auth/quota/server errors as unsupported features.

Use recorded/mocked responses to test request shapes, usage, errors, ordering, cache hits, cancellation, and retry budgets. Live provider tests are opt-in and are not required for the structural performance suite. Preserve provider selection, prompts, requested model, token budgets, and quality gates; lower-quality output or additional paid calls are not performance wins.

Evaluate bounded parallel concept synthesis where tasks are independent. Preserve deterministic merge/progress order where promised, checkpoint durability, and failure-gate behaviour. File summarization and crux work are already concurrent. Do not simply raise every concurrency default or parallelize paid passes on automatic refresh.

### 8.4 App queue (P13)

`WorkQueue.pump()` takes the first pending entry without excluding keys already in `running`. With concurrency greater than one, a repeated push for the same key can run concurrently; adding the same key to the Set does not increment active accounting. Fix admission to select an eligible nonrunning key, retain the latest queued item per key, and ensure actual active work obeys the ceiling. Test blocked same-key work alongside unrelated keys and `drain()` during failures. This restores the documented intended serial-per-key behaviour and must be identified as a correctness fix, not silently included in an equivalence benchmark.

Keep existing child-process crash/OOM isolation and killability. Global resource limits must account for concurrent reviews, brain builds, and any parser pool inside them.

As a separate optional P13 follow-up, `src/app/history.ts:readThreads()` can replace fixed groups of eight PRs with a sliding bounded pool that retains the existing maximum active requests, pagination/filter rules, error handling, and output order. This avoids waiting for the slowest request in a group before starting all work in the next group. Persistent shared clone caches are deferred: authorize them only after clone timing dominates and a separate repository-isolation, ref-freshness, and disk-lifecycle design exists.

## 9. Conditional storage experiments (P14)

If whole extraction-cache read/write dominates after the earlier changes, compare the existing monolithic JSON against versioned batched shards or immutable content-addressed records plus a manifest. Measure total time, bytes written/read, filesystem metadata calls, number of files, recovery time, and memory on Linux and Windows. A file per symbol or tiny record can be much slower; prefer coarse batches unless evidence supports otherwise.

A new cache must preserve pristine Tier-1 bodies, errors, decoded hashes, extractor/query/grammar identities, old-version coexistence, worktree seeding, deletion, and pruning. Cache failure remains regenerable. Do not introduce a mandatory database service.

If serialization dominates RSS, prototype streaming JSON or chunked encoding while preserving canonical property order, indentation, comparator order, final newline, atomic replacement, and checkpoint semantics. Reusing sorted views and avoiding needless copies should precede a custom serializer. Do not compress by default without measuring CPU and startup costs.

Full incremental cross-file resolution is deliberately outside the first rollout. Existing edges are not a sufficient dependency index: adding a second same-named definition can invalidate a formerly unique match, even when its caller is unchanged. Correct support needs negative/ambiguous lookup dependencies, module/config changes, and cross-language scope tracking. Profile residual resolution cost before approving that separate design.

## 10. Measurement and acceptance

Use unprofiled built JavaScript for acceptance timings, with a separate CPU-profile/heap diagnostic run [N2]. Profiled wall times are diagnostic, not the baseline. Pin source commit, lockfile, Node patch version, OS/architecture, hardware/container limits, locale, corpus revision, corpus hashes, and benchmark options. Compare baseline and candidate under the same conditions; do not compare Node 20 baseline with Node 24 candidate.

Measure these independently:

| Workload | Required observations |
| --- | --- |
| Process startup | `--help`, `--version`, clean/no-refresh query; imports initialized, wall time and peak memory |
| Cold structural build | Graft caches absent; OS-cache state explicitly recorded; per-stage time, files/s, nodes/s, wall/CPU/RSS |
| Unchanged explicit build | Source hashes still checked; parsed/reused counts, metadata/read/write calls, bytes written |
| Incremental build | Body-only edit; public symbol rename; add/delete; large change set; manifests/config-only changes |
| Query refresh | Clean, dirty, overlapping requests, externally rebuilt graph, strict-hash probe |
| Retrieval | First and warm MCP queries, different/repeated terms, body-only terms, `--in`, graph-rank switches, workspace results |
| Grep/traversal/blast | Many files; many hits; capped hits; deep/fan-out/cyclic graph; many changed files |
| Long-lived service | Repeated builds/queries across multiple repositories; eviction, RSS trend, event-loop delay, teardown |
| Viewer | Outline initial render/toggle, detail selection, search restyle, interaction latency, browser memory |
| Deep/App | Mocked provider negotiation/synthesis; checkpoint costs; per-key bursts; actual concurrency and responsiveness |

Use Graft itself as one real pinned corpus, existing multilingual fixtures as fidelity coverage, and deterministic TypeScript-generated synthetic corpora for scale and adversarial graph shapes. Include both native and WASM-heavy workloads. Do not run fetched source, its installs, or builds merely to index it. Benchmark corpus generation is outside the timed operation.

Suggested admission targets, to be adjusted after the baseline: at least 15–20% improvement on the workload a medium/high-complexity patch targets, or a meaningful measured reduction in peak memory/write amplification; no material regression on common small/unchanged workloads. These are thresholds for choosing complexity, not promised outcomes. Simple scan eliminations may be worthwhile below that threshold when they reduce scaling cost cleanly.

Use repeated trials, randomized/interleaved baseline-candidate order, raw samples, medians and spread. A p95 needs enough samples; do not label the largest of five trials a reliable tail estimate. Include absolute milliseconds/MiB and relative changes. Performance CI should use controlled runners or advisory thresholds; semantic parity gates remain strict everywhere.

Before a patch ships, require exact differential structural/retrieval fixtures and the relevant existing tests. The release gate runs the full suite/build on Linux and Windows under Node 20, plus the existing Node 24 WASM regression. Worker, package, and browser-specific changes require their own tests. Memory soak tests use trends and bounds rather than brittle exact RSS assertions.

## 11. Rollout decision

Ship independent low-risk wins as they pass measurement and compatibility gates. Preserve internal serial/reference paths for risky pool/ranking/cache experiments until confidence is established. New controls are proposed design choices, not existing Graft CLI flags; their exact names and exposure are settled in implementation.

After early algorithm/import/write changes, reprofile. If they meet practical latency and memory goals, stop before introducing worker or storage complexity. If extraction remains dominant, proceed with P07. If warm queries dominate, proceed with P03/P09. If cache publication dominates, proceed with P08/P14. Performance gains across phases are not additive percentages.

Use the companion plan for ordered work packets and agents. Implementation success is measured faster behaviour at preserved fidelity, not completion of every optional item in this document.

## 12. Source references

Repository source links are pinned to the audited commit. File/function names in this document refer to that snapshot; agents must reconcile them with upstream changes before editing.

- [Repository snapshot](https://github.com/trailhq/Graft/tree/f9e65396e638e517aecae0d731017f53084d70ed)
- [Package and public API](https://github.com/trailhq/Graft/blob/f9e65396e638e517aecae0d731017f53084d70ed/package.json), [index.ts](https://github.com/trailhq/Graft/blob/f9e65396e638e517aecae0d731017f53084d70ed/src/index.ts)
- [Build pipeline](https://github.com/trailhq/Graft/blob/f9e65396e638e517aecae0d731017f53084d70ed/src/graph/build.ts), [extraction cache](https://github.com/trailhq/Graft/blob/f9e65396e638e517aecae0d731017f53084d70ed/src/graph/extract-cache.ts), [fingerprint](https://github.com/trailhq/Graft/blob/f9e65396e638e517aecae0d731017f53084d70ed/src/graph/fingerprint.ts)
- [Native extraction](https://github.com/trailhq/Graft/blob/f9e65396e638e517aecae0d731017f53084d70ed/src/graph/extract.ts), [generic extraction](https://github.com/trailhq/Graft/blob/f9e65396e638e517aecae0d731017f53084d70ed/src/graph/generic.ts), [container extraction](https://github.com/trailhq/Graft/blob/f9e65396e638e517aecae0d731017f53084d70ed/src/graph/container.ts)
- [Graph loading](https://github.com/trailhq/Graft/blob/f9e65396e638e517aecae0d731017f53084d70ed/src/graph/load.ts), [refresh](https://github.com/trailhq/Graft/blob/f9e65396e638e517aecae0d731017f53084d70ed/src/graph/refresh.ts), [traversal](https://github.com/trailhq/Graft/blob/f9e65396e638e517aecae0d731017f53084d70ed/src/graph/traverse.ts)
- [Search](https://github.com/trailhq/Graft/blob/f9e65396e638e517aecae0d731017f53084d70ed/src/search/grep.ts), [ask](https://github.com/trailhq/Graft/blob/f9e65396e638e517aecae0d731017f53084d70ed/src/ask/ask.ts), [ask sidecar](https://github.com/trailhq/Graft/blob/f9e65396e638e517aecae0d731017f53084d70ed/src/ask/index-file.ts), [PageRank](https://github.com/trailhq/Graft/blob/f9e65396e638e517aecae0d731017f53084d70ed/src/ask/graphrank.ts)
- [Graph writer](https://github.com/trailhq/Graft/blob/f9e65396e638e517aecae0d731017f53084d70ed/src/graph/write.ts), [cards](https://github.com/trailhq/Graft/blob/f9e65396e638e517aecae0d731017f53084d70ed/src/graph/cards.ts), [CLI](https://github.com/trailhq/Graft/blob/f9e65396e638e517aecae0d731017f53084d70ed/src/cli.ts)
- [Viewer outline](https://github.com/trailhq/Graft/blob/f9e65396e638e517aecae0d731017f53084d70ed/viewer/tree.ts), [detail](https://github.com/trailhq/Graft/blob/f9e65396e638e517aecae0d731017f53084d70ed/viewer/detail.ts), [force graph](https://github.com/trailhq/Graft/blob/f9e65396e638e517aecae0d731017f53084d70ed/viewer/graph.ts)
- [OpenAI-compatible transport](https://github.com/trailhq/Graft/blob/f9e65396e638e517aecae0d731017f53084d70ed/src/ai/llm/openai.ts), [context build](https://github.com/trailhq/Graft/blob/f9e65396e638e517aecae0d731017f53084d70ed/src/context/build.ts), [App queue](https://github.com/trailhq/Graft/blob/f9e65396e638e517aecae0d731017f53084d70ed/src/app/queue.ts)
- [Incremental parity tests](https://github.com/trailhq/Graft/blob/f9e65396e638e517aecae0d731017f53084d70ed/test/graph-incremental.test.ts), [CI](https://github.com/trailhq/Graft/blob/f9e65396e638e517aecae0d731017f53084d70ed/.github/workflows/ci.yml)
- N1: [Node 20 worker threads](https://nodejs.org/docs/latest-v20.x/api/worker_threads.html) — pool overhead, CPU suitability, transfer ownership, lifecycle.
- N2: [Node 20 command-line profiling options](https://nodejs.org/docs/latest-v20.x/api/cli.html) — CPU/heap diagnostics. Pin the actual runtime patch for measurements.

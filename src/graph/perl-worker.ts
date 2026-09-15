/** One isolated WASM runtime per operation. Never imports native extractors,
 * executes Perl, downloads assets, or sends parser output to protocol stdout. */
import { parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Parser, Language } from "web-tree-sitter";
import { extractPerlTree, perlFileResult } from "./perl-extract.js";
import { createPerlEmbeddedParser } from "./perl-embedded.js";
import type { PerlParseJob, PerlWorkerMessage } from "./perl-types.js";

if (!parentPort) throw new Error("The Perl worker must run in worker_threads");
const port = parentPort;
const send = (message: PerlWorkerMessage) => port.postMessage(message);

try {
  const assets = new URL(workerData.assetsDir);
  const manifest = JSON.parse(readFileSync(new URL("provenance.json", assets), "utf8"));
  const bytes = readFileSync(new URL("tree-sitter-perl.wasm", assets));
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== manifest.files?.["tree-sitter-perl.wasm"]?.sha256) throw new Error("Perl grammar checksum mismatch; rebuild or reinstall Graft");
  await Parser.init();
  const language = await Language.load(bytes);
  if (language.abiVersion !== manifest.generator?.abi) throw new Error("Perl grammar ABI does not match its provenance");
  port.on("message", (job: PerlParseJob) => {
    let parser: Parser | undefined;
    let tree: ReturnType<Parser["parse"]> = null;
    const embedded = createPerlEmbeddedParser(language, job.source);
    try {
      parser = new Parser();
      parser.setLanguage(language);
      // The scanner revisits nearby input positions frequently. The string
      // overload fills the runtime's 5 Ki-code-unit buffer on each callback;
      // short chunks avoid repeatedly copying text the scanner never consumes.
      // Tree-sitter requests further chunks as needed, including for node.text.
      tree = parser.parse((index) => job.source.slice(index, index + 64));
      if (!tree) throw new Error("Perl parser did not return a tree");
      send({ type: "result", id: job.id, result: extractPerlTree(job.file, job.source, tree.rootNode, embedded.parse) });
    } catch (error) {
      send({ type: "result", id: job.id, result: perlFileResult(job.file, job.source, [{ code: "PERL_PARSE_FAILED", file: job.file, severity: "error", message: (error as Error).message }], "failed", false) });
    } finally {
      embedded.dispose();
      tree?.delete();
      parser?.delete();
    }
  });
  send({ type: "ready" });
} catch (error) {
  send({ type: "fatal", code: "PERL_ASSET_FAILED", message: `Cannot load packaged Perl grammar: ${(error as Error).message}` });
  port.close();
}

/** Narrow common build/check dispatch. Native APIs remain synchronous; only the
 * operation coordinator awaits Perl's isolated worker. */
import { extractFile, type ExtractResult } from "./extract.js";
import { extractGeneric, warmGenericGrammars } from "./generic.js";
import { containerLangOf, extractContainer, warmContainerGrammars } from "./container.js";
import { PerlParser, type PerlParserOptions } from "./perl-parser.js";
import type { SourceClassification } from "./source-classify.js";

export class SourceDispatcher {
  private readonly perl: PerlParser;
  constructor(options: PerlParserOptions = {}) { this.perl = new PerlParser(options); }
  get perlWorkerStarts(): number { return this.perl.workerStarts; }

  async warm(classifications: Iterable<SourceClassification>): Promise<void> {
    const list = [...classifications];
    await warmGenericGrammars(new Set(list.filter((c) => c.kind === "generic").map((c) => c.language)));
    await warmContainerGrammars(new Set(list.filter((c) => c.kind === "container").map((c) => c.language)));
  }

  extract(file: string, source: string, classification: SourceClassification): ExtractResult | Promise<ExtractResult> {
    switch (classification.kind) {
      case "native": return extractFile(file, source, classification.native);
      case "generic": return extractGeneric(file, source, classification.language);
      case "container": {
        const container = containerLangOf(file);
        if (!container) throw new Error(`Container classification lost for ${file}`);
        return extractContainer(file, source, container);
      }
      case "perl": return this.perl.extract(file, source, classification.mode);
    }
  }

  async dispose(): Promise<void> { await this.perl.dispose(); }
}

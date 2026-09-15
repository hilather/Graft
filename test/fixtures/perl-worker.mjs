// Deliberately adversarial worker for lifecycle tests. No Perl is executed.
import { parentPort, workerData } from "node:worker_threads";
import { perlFileResult } from "../../dist/graph/perl-extract.js";
if (workerData.mode === "startup-hang") {
  while (true) { /* prove parent-enforced cancellation of synchronous work */ }
}
if (workerData.mode === "startup-exit") process.exit(7);
parentPort.on("message", (job) => {
  if (job.source === "hang") while (true) { /* cannot be cancelled by a promise */ }
  if (job.source === "exit") process.exit(7);
  parentPort.postMessage({ type: "result", id: job.id, result: perlFileResult(job.file, job.source) });
});
parentPort.postMessage({ type: "ready" });

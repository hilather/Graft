# Deferred Perl / RT3 work

The current cleanup is complete for now; these items are follow-up work.

- [ ] Audit the 16 call relationships lost from the original baseline: 15
  inside `RX::Observe` after path mapping, plus the overlay's call to `emit`.
  Check source identity and initialization effects before restoring edges.
- [ ] Improve `%INC`, analysis CWD, guarded entrypoints (`unless (caller)`),
  reloads, and capture ordering when initialization has several possible paths.
- [ ] Model bounded import behavior and modules that export nothing.
  `RT::Test::import` also initializes RT, so it needs more than an Exporter rule.
- [ ] Integrate matching dependency sources without broadening unrelated
  mutation and inheritance uncertainty. Keep the dependency experiment opt-in.
- [ ] Resolve methods shared by finite parent alternatives, then improve
  receiver, return-value, and callback tracking where source proves a target.
- [ ] Extend proven aliases and captures to full typeglobs (`*id = *Id`) and
  bounded `->can` results; retain uncertainty for competing replacements.
- [ ] Traverse executable heredoc interpolation in its semantic order.
- [ ] Handle additional finite computed names, loads, and string evals.
- [ ] Fix the dependency parser cases: `1 << index(...)` in `Devel::Peek`,
  `given`/`when` in `File::Glob`, apostrophe names in `Test::More` and
  `Carp::Assert`, and constant/multiplication ambiguity in `Time::Local`.

## Verification when resuming

Use the same 391 original RT3 files and compare their source hashes, diagnostic
counts, resolved call relationships, and confidence changes. At this stopping
point, files with diagnostics went from **374 to 373**, diagnostics from
**22,774 to 22,712**, and call edges from **694 to 740**. All **257** Perl tests pass.
Dependency scans use a separate 835-file input and must be reported separately.

Keep diagnostics for runtime user code, unknown plugins, and other targets the
available source cannot establish. Do not execute application code to resolve it.

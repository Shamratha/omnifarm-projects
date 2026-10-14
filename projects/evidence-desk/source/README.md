# Evidence Desk

Evidence Desk is a defensive, synthetic evidence-review UI. The fixture bundle is fictional and does not contact targets, invoke investigative tools, or represent real people, systems, or locations.

## Domain API

`src/domain/evidence.ts` exports:

- `EvidenceRecord`, `CustodyEvent`, `ValidationFinding`, `ValidationReport`, and related option/value types.
- `isFiniteIsoTimestamp(value)` — accepts only finite, calendar-valid ISO-8601 timestamps with a timezone.
- `isSha256Hash(value)` — validates the `sha256:<64 hexadecimal digits>` form, case-insensitively.
- `fingerprintEvidence(record)` — stable semantic fingerprint used by duplicate detection.
- `detectDuplicateEvidence(records, fingerprint?)` — detects repeated IDs, repeated content hashes, and semantic duplicates.
- `detectClockSkew(records, options)` — detects invalid/future observation times and per-case/source observed-time regressions after receipt advances.
- `validateChainOfCustody(records)` — requires a collected first event, linked holders/event IDs, finite chronological timestamps, and complete sequences.
- `detectConflictingObservations(records, options)` — compares distinct sources only within the same case, subject, observation kind/unit, and time window; duplicate imports are excluded.
- `validateEvidence(records, options)` — deterministic aggregate report; `valid` is false for error findings.
- `deriveConfidence(record, findings)` — deterministic 0–100 heuristic with level, reasons, explanation, baseline, total deductions, arithmetic, and structured confidence contributions. It is an uncertainty aid, not a probability of truth.
- `summarizeConfidence(records, findings)` — deterministic, once-rounded mean with every record input preserved; an empty bundle returns a null score, not an invented percentage.
- `buildCaseBrief(records, findings)` — pure deterministic Markdown containing findings, uncertainty, every record hash and custody event, the scoring policy, overall arithmetic, and every contribution's supporting facts.
- `FINDING_CATEGORIES` and `groupFindings(findings)` — shared classification metadata and deterministic category groups for the UI and exported brief, including explicitly empty groups.

The type exports include `ObservationValue`, `Observation`, `CustodyEvent`, `EvidenceRecord`, `FindingCode`, `ValidationFinding`, `ValidationReport`, `ClockSkewOptions`, `ConflictOptions`, `EvidenceValidationOptions`, `ConfidenceAssessment`, `ConfidenceSupport`, `ConfidenceContribution`, and `ConfidenceSummary`.

Confidence starts at 100 and subtracts once per applicable finding category: duplicate 15, clock 20, custody 30, conflict 15. A missing/malformed full digest subtracts 10. Scores are clamped to 0–100; high is ≥80, medium ≥60, otherwise low. No authenticity or cross-source corroboration is inferred from a declared hash or an absence of findings. Thresholds are finite, nonnegative milliseconds; exact clock thresholds are accepted and the conflict time window is inclusive. Custody chronology compares events within the sequence, allowing simultaneous handoffs; collection need not coincide with receipt or the source's possibly skewed observation clock. A `null` observation is unknown, not a conflicting assertion.

```ts
import { evidence, evidenceCatalog } from './src/data/case'
import { validateEvidence, deriveConfidence, buildCaseBrief } from './src/domain/evidence'

const report = validateEvidence(evidence, {
  clockSkew: { maxFutureSkewMs: 60_000, maxObservedRegressionMs: 300_000 },
  conflict: { windowMs: 300_000 },
})
const confidence = deriveConfidence(evidence[0], report.findings)
const markdown = buildCaseBrief(evidence, report.findings)
const downloadPath = evidenceCatalog['EV-1042'].path
```

## Synthetic fixture bundle

`src/data/case.ts` exports the existing `caseMeta`, `timeline`, `entities`, and `custody` shapes plus:

- `evidence`: 12 records preserving the original `EV-1042` through `EV-1045` IDs and adding synthetic imports/observations.
- `evidenceCatalog`: `evidenceId -> { evidenceId, title, filename, path, kind }`.
- Intentional duplicate content: `EV-1042` / `EV-1046` share exact file bytes (the import retains the original payload ID). Semantic duplicate: `EV-1042` / `EV-1047`. All 12 record IDs are unique; duplicate-ID rejection is exercised in tests.
- `EV-1048` is observed 10 minutes after receipt; `EV-1049` regresses the relay clock by 17 minutes; `EV-1050` skips custody sequence #2.
- `EV-1043` conflicts with `EV-1042` and `EV-1044`; the later `EV-1053` observation is outside the five-minute witness conflict window. Imports do not multiply conflicts.

The matching 12 files live under `public/case-files/`: 5 event logs, 1 witness note, 2 transfer/receipt documents, and 4 observations. Each record declares the full SHA-256 digest of its actual static file (11 unique digests). There are 16 custody events, 10 timeline items, and 5 entities. The existing UI's validation options produce **7 findings: 2 duplicate, 2 clock, 1 custody, 2 conflict** (2 errors, 5 warnings; `valid: false` intentionally). The bundle is entirely synthetic.

## Checks

```sh
npm test
npm run build
```

The Vitest suite covers baseline acceptance, timestamp boundaries, duplicate IDs/hashes/semantic fingerprints, clock regression, custody chronology and first collection, narrow conflicts, confidence/brief output, record count, catalog count, and actual static-file digests. Focused confidence tests additionally exercise exact custody failures, contradictory values and timestamps, duplicate-group evidence, single-category deductions, aggregate arithmetic, export parity, frozen-input non-mutation, and real React component interactions in jsdom.

Current verification: `npm test` passes **68 tests across 8 files**. This includes the existing integrity/confidence/separation coverage plus focused synthetic-scope UI and export assertions. `npm run build` passes strict TypeScript project checks and generates the production site in `dist/`. There is no lint script in the current package. UI checks use jsdom (including a dialog API shim), not a full-browser end-to-end runner.

## Auditing a confidence value

Run `npm run dev` and open the local URL printed by Vite.

- Click the overview's **Evidence confidence** card for all mean inputs. Click a **Confidence by file type** bar for that group's calculation and records. These bars now use computed values rather than illustrative hard-coded percentages.
- In **Evidence**, click a confidence badge or an item. The inspector shows `100 - total deductions = score`, each category's point adjustment, all supporting findings, and navigable related record IDs. Expand **Supporting facts** for the raw facts behind a deduction.
- Custody supports name the failed event, timestamp, sequence, expected and actual holder/reference/sequence, and every failed check. For example, `EV-1050` scores **70%** because event `co-12` has sequence 3 where 2 is required: one **−30** custody deduction.
- Duplicate supports show matching record IDs and whether the evidence is a repeated ID, a matching SHA-256 declaration, or a matching semantic fingerprint. Multiple duplicate findings still apply only one **−15** deduction to each involved record, without hiding any support.
- Contradiction supports preserve both source IDs, observation values, units and raw timestamps, plus the comparison window. For example, `EV-1043` scores **85%** with two contradictory pairs visible but one **−15** category deduction. No observation is selected as true.
- Timeline score badges show the linked record's computed integrity score, not a separate hard-coded event-confidence judgment. Separate review badges and markers classify duplicate-record events and contradictory-observation events. Use **Timeline review category** to filter either kind; clicking a classified event opens only a matching finding from its own category.
- **Export brief** downloads `case-2417-case-brief.md`. `src/ui.ts`'s `buildDeskBrief(findings)` includes the domain brief plus the same grouped means, arithmetic and input records displayed by the overview. Every per-record supporting fact and deduction is included.

## Visible synthetic-case scope

The header and persistent case banner show **SYNTHETIC CASE**, **Defensive review only**, and **NO TARGET CONTACT**. The banner explains that only fictional bundled evidence is used. The exported brief has a dedicated **Scope and safe-use boundary** section stating that the case data is fictional, targets are never contacted, investigative tools are not executed, no external actions or uploads occur, and no external sources or network intelligence are queried. The UI does not load external fonts or other assets.

Signed `ConfidenceContribution.penalty` values are score adjustments (`-30`, `-15`, or `0`); `ConfidenceAssessment.totalPenalty` is the positive total deduction. A zero-point declared-hash contribution is not file verification or proof of authenticity. Scores and category weights are unchanged; this update makes their evidence and arithmetic explicit. Retained duplicate imports remain mean inputs, explicitly identified as not independent corroboration.

## Separate duplicate-record and contradictory-observation review

- **Duplicate records** identify repeated IDs, matching declared content hashes, or matching semantic fingerprints. They concern repetition and provenance, not differing observations. Hashes still need local byte verification; a duplicate is not independent corroboration.
- **Contradictory observations** identify distinct sources asserting different values within the configured case/subject/kind/unit/time context. Duplicate pairs are excluded, so reimports do not multiply the original contradictions. Neither account is selected as true.
- The timeline stores explicit `findingCode` metadata rather than inferring a category from a title or from every finding attached to a record. Duplicate and contradiction events have different markers, badges and filters, and navigate to their own category's supporting records.
- **Review groups** displays distinct category sections with their own counts, empty states, explanations and finding buttons. Duplicates are visible even when contradictory observations also exist.
- The score breakdown has separate **Duplicate records** and **Contradictory observations** sections. A record may legitimately have both: the original can be reimported and also disagree with an independent source. Each category deducts **−15 once**, with only its own supporting IDs and facts. No existing scoring weights changed.
- The exported Markdown brief mirrors these separate review groups and per-record score sections and now also includes the timeline with explicit classifications and category-specific linked records.
- Focused separation tests live in `src/domain/separation.test.ts` and `src/components/Separation.test.tsx`. Existing edge-case tests are retained unchanged.

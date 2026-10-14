// @vitest-environment node
// JavaScript keeps Node-only fixture verification outside the browser TS build.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { evidence, evidenceCatalog, entities, timeline } from '../data/case'
import { validateEvidence } from './evidence'

it('verifies every catalog digest against the actual static bytes', () => {
  const directory = resolve('public/case-files')
  const entries = Object.values(evidenceCatalog)
  expect(evidence).toHaveLength(12)
  expect(new Set(evidence.map((item) => item.evidenceId)).size).toBe(12)
  expect(new Set(evidence.map((item) => item.contentHash)).size).toBe(11)
  expect(evidence.reduce((count, item) => count + item.custody.length, 0)).toBe(16)
  expect(timeline).toHaveLength(10)
  expect(entities).toHaveLength(5)
  expect(readdirSync(directory).sort()).toEqual(entries.map((entry) => entry.filename).sort())
  for (const record of evidence) {
    const entry = evidenceCatalog[record.evidenceId]
    expect(entry.evidenceId).toBe(record.evidenceId)
    expect(entry.path).toBe(`/case-files/${entry.filename}`)
    const bytes = readFileSync(resolve(directory, entry.filename))
    expect(record.contentHash).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`)
    expect(bytes.toString('utf8').toLowerCase()).toContain('synthetic')
  }
  for (const item of timeline) {
    if (item.evidenceId) expect(evidenceCatalog[item.evidenceId]).toBeDefined()
  }
})

it('exposes a bounded, intentional report to existing UI consumers', () => {
  const report = validateEvidence(evidence, {
    clockSkew: { maxFutureSkewMs: 60_000, maxObservedRegressionMs: 300_000 },
    conflict: { windowMs: 300_000 },
  })
  expect(report.valid).toBe(false)
  expect(report.findings).toHaveLength(7)
  expect(report.findings.filter((item) => item.severity === 'error')).toHaveLength(2)
  expect(report.findings.filter((item) => item.code === 'DUPLICATE_EVIDENCE')).toHaveLength(2)
  expect(report.findings.filter((item) => item.code === 'CLOCK_SKEW')).toHaveLength(2)
  expect(report.findings.filter((item) => item.code === 'BROKEN_CHAIN_OF_CUSTODY')).toHaveLength(1)
  expect(report.findings.filter((item) => item.code === 'CONFLICTING_OBSERVATIONS')).toHaveLength(2)
})

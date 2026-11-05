import { describe, expect, test } from 'vitest'
import { buildSummary } from './summary.ts'

// Character limit of a PR comment
const PR_COMMENT_LIMIT = 65536

describe('buildSummary', () => {
  const makeStories = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `features-verylongfeaturename${i}--variant-${i}`,
      title: `Features/VeryLongFeatureName${i}`,
      name: `Variant ${i}`,
      importPath: `packages/app-console/src/features/Foo${i}/stories.tsx`,
      pkg: 'app-console',
    }))

  test('大量の差分でも PR コメントの上限(65536字)を超えない', () => {
    const summary = buildSummary({
      changed: makeStories(2000),
      added: [],
      removed: [],
      failed: [],
    })
    expect(summary.length).toBeLessThanOrEqual(PR_COMMENT_LIMIT)
    // Says that the list was cut
    expect(summary).toContain('…ほか')
  })

  test('少量の差分は打ち切らず全件そのまま列挙する', () => {
    const summary = buildSummary({
      changed: makeStories(3),
      added: [],
      removed: [],
      failed: [],
    })
    expect(summary).not.toContain('…ほか')
    expect(summary).toContain('VeryLongFeatureName2')
  })
})

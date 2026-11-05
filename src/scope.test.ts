import { describe, expect, test } from 'vitest'
import { buildStoryFilter } from './scope.ts'
import { createWorkspace } from './workspace.ts'

// Options for a monorepo with shared libraries imported through their dist
const DIST_BOUNDARY = {
  distBoundaryPackages: [
    'packages/ui-components/',
    'packages/shared-components/',
  ],
}

const UI_SRC = 'packages/ui-components/lib/components/Dialog.tsx'
const UI_STORY = 'packages/ui-components/src/Dialog.stories.tsx'
const APP_STORY = 'packages/app-console/src/features/Foo/stories.tsx'

describe('buildStoryFilter', () => {
  test('dist 境界の共有ライブラリのソース変更は全 story に昇格する', () => {
    const filter = buildStoryFilter([UI_SRC], null, DIST_BOUNDARY)
    expect(filter.all).toBe(true)
    expect(filter.method).toBe('shared-lib-global')
    expect(filter.touchedPackages).toEqual(['packages/ui-components'])
    // App stories the dependency graph can't reach are still in scope
    expect(filter.isCandidate(APP_STORY)).toBe(true)
  })

  test('複数指定した共有ライブラリはどれもソース変更で昇格対象', () => {
    const filter = buildStoryFilter(
      ['packages/shared-components/src/components/Foo/index.tsx'],
      null,
      DIST_BOUNDARY,
    )
    expect(filter.all).toBe(true)
    expect(filter.method).toBe('shared-lib-global')
  })

  test('distBoundaryPackages 未指定なら共有ライブラリのソース変更でも昇格しない', () => {
    const filter = buildStoryFilter([UI_SRC], null)
    expect(filter.all).toBe(false)
    expect(filter.method).toBe('package-heuristic')
  })

  test('末尾スラーシュ無しの distBoundaryPackages 指定も同義に正規化される', () => {
    const filter = buildStoryFilter([UI_SRC], null, {
      distBoundaryPackages: ['packages/ui-components'],
    })
    expect(filter.method).toBe('shared-lib-global')
  })

  test('共有ライブラリでも story だけの変更では昇格しない', () => {
    const filter = buildStoryFilter([UI_STORY], null, DIST_BOUNDARY)
    expect(filter.all).toBe(false)
    // The changed story itself is in scope
    expect(filter.isCandidate(UI_STORY)).toBe(true)
  })

  test('共有ライブラリでもテストだけの変更では昇格しない', () => {
    const filter = buildStoryFilter(
      ['packages/ui-components/lib/components/utils/foo.test.ts'],
      null,
      DIST_BOUNDARY,
    )
    expect(filter.all).toBe(false)
  })

  test('通常のアプリ側コードの変更は import グラフで精密に絞る', () => {
    const changed = 'packages/app-console/src/features/Foo/index.tsx'
    const graph = new Map<string, Set<string>>([
      [changed, new Set(['packages/app-console/src/features/Foo/stories.tsx'])],
    ])
    const filter = buildStoryFilter([changed], graph, DIST_BOUNDARY)
    expect(filter.all).toBe(false)
    expect(filter.method).toBe('import-graph')
    expect(
      filter.isCandidate('packages/app-console/src/features/Foo/stories.tsx'),
    ).toBe(true)
    expect(
      filter.isCandidate('packages/app-console/src/features/Bar/stories.tsx'),
    ).toBe(false)
  })

  test('.storybook 変更は既定で全 story 対象 (method: all)', () => {
    const filter = buildStoryFilter(['.storybook/preview.tsx'], null)
    expect(filter.all).toBe(true)
    expect(filter.method).toBe('all')
  })

  test('globalPaths を指定するとそのパス配下の変更で全 story 対象になる', () => {
    const filter = buildStoryFilter(['config/theme.css'], null, {
      globalPaths: ['config/'],
    })
    expect(filter.all).toBe(true)
    expect(filter.method).toBe('all')
    // The default .storybook/ is replaced
    const noHit = buildStoryFilter(['.storybook/preview.tsx'], null, {
      globalPaths: ['config/'],
    })
    expect(noHit.all).toBe(false)
  })

  test('共有ライブラリの story と非 story が混在しても昇格する', () => {
    const filter = buildStoryFilter([UI_STORY, UI_SRC], null, DIST_BOUNDARY)
    expect(filter.all).toBe(true)
    expect(filter.method).toBe('shared-lib-global')
  })

  test('複数の共有ライブラリ変更で touchedPackages が和集合・重複排除される', () => {
    const filter = buildStoryFilter(
      [
        UI_SRC,
        'packages/ui-components/lib/components/Button.tsx',
        'packages/shared-components/src/components/Foo/index.tsx',
      ],
      null,
      DIST_BOUNDARY,
    )
    expect(filter.all).toBe(true)
    // Several changes in one library collapse into one; different libraries add up
    expect(filter.touchedPackages).toEqual([
      'packages/ui-components',
      'packages/shared-components',
    ])
  })

  test('共有ライブラリと無関係パッケージの混在では共有ライブラリ側が優先され昇格する', () => {
    const filter = buildStoryFilter(
      [UI_SRC, 'packages/app-console/src/features/Foo/index.tsx'],
      null,
      DIST_BOUNDARY,
    )
    expect(filter.all).toBe(true)
    expect(filter.method).toBe('shared-lib-global')
    // Only the shared library is recorded as the trigger
    expect(filter.touchedPackages).toEqual(['packages/ui-components'])
  })

  test('共有ライブラリと似た名前のパッケージは昇格対象にしない', () => {
    const filter = buildStoryFilter(
      ['packages/ui-components-extra/lib/index.ts'],
      null,
      DIST_BOUNDARY,
    )
    expect(filter.method).not.toBe('shared-lib-global')
  })

  test('依存グラフが無い非共有パッケージ変更は package-heuristic で同パッケージ配下に絞る', () => {
    const filter = buildStoryFilter(
      ['packages/app-console/src/features/Foo/index.tsx'],
      null,
      DIST_BOUNDARY,
    )
    expect(filter.all).toBe(false)
    expect(filter.method).toBe('package-heuristic')
    // Stories in the same package are in scope; stories in other packages are not
    expect(
      filter.isCandidate('packages/app-console/src/features/Bar/stories.tsx'),
    ).toBe(true)
    expect(
      filter.isCandidate('packages/admin-console/src/features/Baz/stories.tsx'),
    ).toBe(false)
  })

  test('import グラフの多段(transitive)連鎖を辿って対象化する', () => {
    const a = 'packages/app-console/src/features/Foo/utils/a.ts'
    const b = 'packages/app-console/src/features/Foo/index.tsx'
    const story = 'packages/app-console/src/features/Foo/stories.tsx'
    // a <- b <- story (the story should reach a, two hops away)
    const graph = new Map<string, Set<string>>([
      [a, new Set([b])],
      [b, new Set([story])],
    ])
    const filter = buildStoryFilter([a], graph, DIST_BOUNDARY)
    expect(filter.all).toBe(false)
    expect(filter.method).toBe('import-graph')
    expect(filter.isCandidate(story)).toBe(true)
  })

  test('変更ファイルが取得できない場合は何もレンダリングしない', () => {
    const filter = buildStoryFilter(null, null, DIST_BOUNDARY)
    expect(filter.all).toBe(false)
    expect(filter.method).toBe('none')
    expect(filter.isCandidate(UI_STORY)).toBe(false)
  })

  test('workspace dir を変更すると packages 以外のレイアウトでもパッケージ判定できる', () => {
    const filter = buildStoryFilter(['apps/web/src/Foo.tsx'], null, {
      workspace: createWorkspace('apps'),
    })
    expect(filter.method).toBe('package-heuristic')
    expect(filter.touchedPackages).toEqual(['apps/web'])
    expect(filter.isCandidate('apps/web/src/Bar.stories.tsx')).toBe(true)
    expect(filter.isCandidate('apps/admin/src/Baz.stories.tsx')).toBe(false)
  })
})

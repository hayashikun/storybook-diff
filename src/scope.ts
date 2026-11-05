import { readFile } from 'node:fs/promises'
import { createWorkspace, type Workspace } from './workspace.ts'

export type StoryFilter = {
  all: boolean
  method:
    | 'none'
    | 'all'
    | 'shared-lib-global'
    | 'import-graph'
    | 'package-heuristic'
  touchedPackages: string[]
  touchedStoryFiles: string[]
  isCandidate: (importPath: string) => boolean
}

const STORY_FILE_RE = /(^|\/)[^/]*\.?stories\.[jt]sx?$/

/**
 * A change under .storybook can affect how every story renders, so it puts every story in scope (default).
 * (lockfile / package.json / tsconfig etc. are mostly dependency updates that rarely affect rendering, so they don't)
 */
const DEFAULT_GLOBAL_PATHS = ['.storybook/']

const TEST_FILE_RE = /\.(test|spec)\.[jt]sx?$/

/**
 * Whether this is a change under a shared library imported through its dist, other than stories and tests.
 * The dist apps load contains no stories or tests, so those two can't affect rendering and are excluded.
 * Everything else (source, dependencies, build config) can change the dist output and isn't filtered further.
 */
function isDistBoundarySharedChange(
  p: string,
  distBoundaryPackages: string[],
): boolean {
  if (STORY_FILE_RE.test(p) || TEST_FILE_RE.test(p)) return false
  return distBoundaryPackages.some((pkg) => p.startsWith(pkg))
}

/**
 * Builds a reverse graph "importPath -> set of its importers" from turbosnap's preview-stats.json.
 * Each module looks like { id: imported module, reasons: [{ moduleName: importer }] }.
 * Returns null without stats.
 */
export async function readImportGraph(
  statsPath: string,
  ws: Workspace,
): Promise<Map<string, Set<string>> | null> {
  if (!statsPath) return null
  try {
    const raw = JSON.parse(await readFile(statsPath, 'utf-8'))
    const importedBy = new Map<string, Set<string>>()
    for (const m of raw.modules ?? []) {
      const id = ws.normalize(m.id ?? '')
      for (const r of m.reasons ?? []) {
        const importer = ws.normalize(r.moduleName ?? '')
        if (!importer || importer === id) continue
        if (!importedBy.has(id)) importedBy.set(id, new Set())
        importedBy.get(id)?.add(importer)
      }
    }
    return importedBy.size > 0 ? importedBy : null
  } catch {
    return null
  }
}

/** Follows the dependency graph to every module that imports the changed files (normalized), directly or indirectly */
function traceImporters(
  importedBy: Map<string, Set<string>>,
  changedFiles: string[],
): Set<string> {
  const visited = new Set<string>()
  const queue = [...changedFiles]
  while (queue.length > 0) {
    const node = queue.pop() as string
    const importers = importedBy.get(node)
    if (!importers) continue
    for (const imp of importers) {
      if (!visited.has(imp)) {
        visited.add(imp)
        queue.push(imp)
      }
    }
  }
  return visited
}

export type StoryFilterOptions = {
  /** Path prefixes; a change under any of them puts every story in scope (default: [".storybook/"]) */
  globalPaths?: string[]
  /**
   * Prefixes of shared packages imported through their built dist (default: none).
   * A change under them, other than stories and tests, puts every story in scope.
   */
  distBoundaryPackages?: string[]
  /** Basis for path normalization and package lookup (default: "packages") */
  workspace?: Workspace
}

/**
 * Builds a function that decides, from the changed-file list, which stories to render.
 *
 * Approach: normally, only stories that import a changed file (transitively) are in scope. However,
 * when apps import a shared library through its built dist, the line from a change in the library's
 * source to the app stories that import it is cut at the library boundary, because the dependency
 * graph excludes node_modules. To avoid missing those, a source change in a dist-boundary shared
 * package (distBoundaryPackages) puts every story in scope.
 *
 * - No changed-file list: render nothing (method: 'none')
 * - A change under globalPaths: every story (method: 'all')
 * - A change in a dist-boundary shared package: every story (method: 'shared-lib-global')
 * - With a dependency graph: only stories that import a changed file, transitively
 * - Only without a dependency graph: fall back to every story in a changed package
 */
export function buildStoryFilter(
  changedFiles: string[] | null,
  importGraph: Map<string, Set<string>> | null,
  options: StoryFilterOptions = {},
): StoryFilter {
  const ws = options.workspace ?? createWorkspace()
  const globalPaths = options.globalPaths ?? DEFAULT_GLOBAL_PATHS
  const distBoundaryPackages = (options.distBoundaryPackages ?? []).map((p) =>
    p.endsWith('/') ? p : `${p}/`,
  )
  if (!changedFiles || changedFiles.length === 0) {
    // Without a changed-file list, render nothing (rather than everything)
    return {
      all: false,
      isCandidate: () => false,
      method: 'none',
      touchedPackages: [],
      touchedStoryFiles: [],
    }
  }
  if (changedFiles.some((p) => globalPaths.some((g) => p.startsWith(g)))) {
    return {
      all: true,
      isCandidate: () => true,
      method: 'all',
      touchedPackages: ['<global>'],
      touchedStoryFiles: [],
    }
  }
  const sharedLibHits = changedFiles.filter((p) =>
    isDistBoundarySharedChange(p, distBoundaryPackages),
  )
  if (sharedLibHits.length > 0) {
    return {
      all: true,
      isCandidate: () => true,
      method: 'shared-lib-global',
      touchedPackages: [
        ...new Set(
          sharedLibHits
            .map((p) => ws.packageOf(p))
            .filter((p): p is string => p != null),
        ),
      ],
      touchedStoryFiles: [],
    }
  }
  const normalizedChanged = new Set(changedFiles.map(ws.normalize))
  const touchedStoryFiles = new Set(
    [...normalizedChanged].filter((p) => STORY_FILE_RE.test(p)),
  )
  const touchedPackages = new Set<string>()
  for (const p of normalizedChanged) {
    if (STORY_FILE_RE.test(p)) continue
    const pkg = ws.packageOf(p)
    if (pkg) touchedPackages.add(pkg)
  }
  const tracedImporters = importGraph
    ? traceImporters(importGraph, [...normalizedChanged])
    : null

  return {
    all: false,
    method: importGraph ? 'import-graph' : 'package-heuristic',
    touchedPackages: [...touchedPackages],
    touchedStoryFiles: [...touchedStoryFiles],
    isCandidate: (importPath: string) => {
      const p = ws.normalize(importPath)
      // 1. The story file itself changed
      if (touchedStoryFiles.has(p)) return true
      // 2. With a dependency graph: only stories that import a changed file, transitively
      if (tracedImporters) return tracedImporters.has(p)
      // 3. Fallback without a dependency graph: stories in a changed package
      const pkg = ws.packageOf(p)
      return pkg != null && touchedPackages.has(pkg)
    },
  }
}

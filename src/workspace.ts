export const DEFAULT_WORKSPACE_DIR = 'packages'

/**
 * Path handling relative to the monorepo workspace directory (default "packages").
 * For repositories with another layout (for example "apps"), change it with --workspace-dir.
 */
export type Workspace = {
  dir: string
  /**
   * Normalizes a path to repo-relative form ("packages/..."). This aligns index.json importPaths
   * ("./packages/..."), git diff output ("packages/...") and turbosnap stats' absolute / relative paths.
   */
  normalize: (p: string) => string
  /** The package the path belongs to ("packages/foo"), or null outside any package */
  packageOf: (p: string) => string | null
  /** Package name for display (without the workspace dir), or "-" outside any package */
  label: (importPath: string) => string
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function createWorkspace(dir = DEFAULT_WORKSPACE_DIR): Workspace {
  const d = dir.replace(/^\.?\//, '').replace(/\/+$/, '')
  const pkgRe = new RegExp(`^(${escapeRegExp(d)}/[^/]+)/`)
  const normalize = (p: string): string => {
    const q = p.split('?')[0]
    const i = q.indexOf(`/${d}/`)
    if (i >= 0) return q.slice(i + 1)
    return q.replace(/^\.\//, '')
  }
  const packageOf = (p: string): string | null => p.match(pkgRe)?.[1] ?? null
  return {
    dir: d,
    normalize,
    packageOf,
    label: (importPath) => {
      const pkg = packageOf(normalize(importPath))
      return pkg ? pkg.slice(d.length + 1) : '-'
    },
  }
}

/**
 * storybook-diff — Storybook story diff visualizer.
 *
 * Takes the `storybook build` output (static HTML) for base and head, renders each
 * story in a browser and compares them. Writes a gallery of the stories that changed
 * (index.html), summary.md for a PR comment, and result.json for scripts.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { run } from './pipeline.ts'

const USAGE = `usage: node src/cli.ts \\
  --base-static <base の storybook-static dir> \\
  --head-static <head の storybook-static dir> \\
  --out <出力先 dir> \\
  [--changed-files <変更ファイル一覧 (1 行 1 パス) のファイル>] \\
  [--head-stats <preview-stats.json のパス。既定 <head-static>/preview-stats.json>] \\
  [--concurrency <並列数。既定 6>] \\
  [--workspace-dir <ワークスペース dir 名。既定 packages>] \\
  [--global-paths <全 story を対象にするパス prefix のカンマ区切り。既定 .storybook/>] \\
  [--dist-boundary-packages <dist 境界の共有パッケージ prefix のカンマ区切り>] \\
  [--reuse-page <false で story ごとに iframe.html を読み込み直す。既定 true>] \\
  [--pr-title <ギャラリーに表示する PR タイトル>] \\
  [--pr-url <PR の URL>]`

const OPTIONS = {
  'base-static': { type: 'string' },
  'head-static': { type: 'string' },
  out: { type: 'string' },
  'changed-files': { type: 'string' },
  'head-stats': { type: 'string' },
  concurrency: { type: 'string' },
  'workspace-dir': { type: 'string' },
  'global-paths': { type: 'string' },
  'dist-boundary-packages': { type: 'string' },
  'reuse-page': { type: 'string' },
  'pr-title': { type: 'string' },
  'pr-url': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const

function parseList(v: string | undefined): string[] | undefined {
  return v
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Reads the changed-file list (one path per line). Returns null if not given or unreadable */
async function readChangedFiles(
  path: string | undefined,
): Promise<string[] | null> {
  if (!path) return null
  try {
    const raw = await readFile(path, 'utf-8')
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  } catch {
    return null
  }
}

async function main(argv: string[]): Promise<void> {
  let values: ReturnType<
    typeof parseArgs<{ options: typeof OPTIONS }>
  >['values']
  try {
    ;({ values } = parseArgs({ args: argv, options: OPTIONS, strict: true }))
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    console.error(USAGE)
    process.exit(1)
  }
  if (values.help) {
    console.log(USAGE)
    return
  }
  const baseStatic = values['base-static']
  const headStatic = values['head-static']
  const outDir = values.out
  if (!baseStatic || !headStatic || !outDir) {
    console.error(USAGE)
    process.exit(1)
  }
  await run({
    baseStatic,
    headStatic,
    outDir,
    changedFiles: await readChangedFiles(values['changed-files']),
    // Treat an empty string as unset (the action passes empty inputs through as-is)
    headStats: values['head-stats'] || undefined,
    concurrency: Number(values.concurrency) || undefined,
    workspaceDir: values['workspace-dir'] || undefined,
    globalPaths: parseList(values['global-paths']),
    distBoundaryPackages: parseList(values['dist-boundary-packages']),
    reusePage: values['reuse-page'] !== 'false',
    // The action passes these as env vars, so a PR title with shell metacharacters never goes through argv
    prTitle: values['pr-title'] ?? process.env.PR_TITLE,
    prUrl: values['pr-url'] ?? process.env.PR_URL,
  })
}

// Run only when executed directly (node cli.ts), so importing this from tests doesn't
// start main(). Compare absolute file URLs so relative and absolute argv both match
const invokedUrl = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : ''
if (import.meta.url === invokedUrl) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err)
    process.exit(1)
  })
}

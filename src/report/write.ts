import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GalleryPayload } from '../types.ts'
import { buildGallery, type GalleryMeta } from './gallery.ts'
import { buildSummary } from './summary.ts'

export type RunStats = {
  /** Number of stories rendered and compared */
  renderedCount: number
  /** Number of stories in both base and head */
  commonCount: number
  /** Whether the changes put every story in scope */
  scopedAll: boolean
  /** Whether rendering was skipped because there was no changed-file list */
  skipped: boolean
}

export type RunResult = RunStats & {
  changedCount: number
  addedCount: number
  removedCount: number
  failedCount: number
  changed: { id: string; title: string; name: string }[]
  added: { id: string; title: string; name: string; importPath: string }[]
  removed: { id: string; title: string; name: string; importPath: string }[]
  failed: {
    id: string
    title: string
    name: string
    baseOk: boolean
    headOk: boolean
    reason?: string
  }[]
}

export function buildResult(
  { changed, added, removed, failed }: GalleryPayload,
  stats: RunStats,
): RunResult {
  const brief = (s: { id: string; title: string; name: string }) => ({
    id: s.id,
    title: s.title,
    name: s.name,
  })
  const withPath = (s: GalleryPayload['added'][number]) => ({
    ...brief(s),
    importPath: s.importPath,
  })
  return {
    changedCount: changed.length,
    addedCount: added.length,
    removedCount: removed.length,
    failedCount: failed.length,
    ...stats,
    changed: changed.map(brief),
    added: added.map(withPath),
    removed: removed.map(withPath),
    failed: failed.map((s) => ({
      ...brief(s),
      baseOk: s.baseOk,
      headOk: s.headOk,
      reason: s.reason,
    })),
  }
}

/** Writes index.html / summary.md / result.json into outDir (shots/ is written while shooting) */
export async function writeReport(
  outDir: string,
  payload: GalleryPayload,
  meta: GalleryMeta,
  stats: RunStats,
): Promise<RunResult> {
  const result = buildResult(payload, stats)
  await Promise.all([
    writeFile(join(outDir, 'index.html'), buildGallery(payload, meta), 'utf-8'),
    writeFile(join(outDir, 'summary.md'), buildSummary(payload), 'utf-8'),
    writeFile(
      join(outDir, 'result.json'),
      `${JSON.stringify(result, null, 2)}\n`,
      'utf-8',
    ),
  ])
  return result
}

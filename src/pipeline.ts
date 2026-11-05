import { mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { type BrowserContext, chromium, type Page } from '@playwright/test'
import { normalizeHtml, pixelDiff, pngSize } from './diff.ts'
import { mapPool } from './pool.ts'
import {
  captureHtml,
  captureShot,
  openStoryPage,
  recordDomMutations,
  type ShotResult,
  type StoryPage,
  screenshotTo,
} from './render.ts'
import { failedReason } from './report/format.ts'
import { type RunResult, writeReport } from './report/write.ts'
import { buildStoryFilter, readImportGraph } from './scope.ts'
import { startStaticServer } from './static-server.ts'
import { readStories } from './storybook.ts'
import type { FailedStory, RenderedStory, Story } from './types.ts'
import { createWorkspace } from './workspace.ts'

export type RunOptions = {
  baseStatic: string
  headStatic: string
  outDir: string
  /** Changed-file list. With null, nothing is rendered and an empty report is written */
  changedFiles: string[] | null
  /** turbosnap's preview-stats.json (default: <headStatic>/preview-stats.json) */
  headStats?: string
  concurrency?: number
  workspaceDir?: string
  globalPaths?: string[]
  distBoundaryPackages?: string[]
  /** Reuse the loaded iframe.html for stories in the same story file (default: true) */
  reusePage?: boolean
  prTitle?: string
  prUrl?: string
}

export async function run(options: RunOptions): Promise<RunResult> {
  const { baseStatic, headStatic, outDir } = options
  const concurrency = Math.max(1, options.concurrency ?? 6)
  const reusePage = options.reusePage ?? true
  const meta = { prTitle: options.prTitle, prUrl: options.prUrl }

  const shotsDir = join(outDir, 'shots')
  await mkdir(shotsDir, { recursive: true })

  const ws = createWorkspace(options.workspaceDir)
  const statsPath = options.headStats ?? join(headStatic, 'preview-stats.json')
  const importGraph = await readImportGraph(statsPath, ws)
  const filter = buildStoryFilter(options.changedFiles, importGraph, {
    globalPaths: options.globalPaths,
    distBoundaryPackages: options.distBoundaryPackages,
    workspace: ws,
  })

  // Without a changed-file list, skip rendering and write an empty report
  if (filter.method === 'none') {
    console.log(
      '変更ファイルが取得できなかったため、レンダリングをスキップします',
    )
    return writeReport(
      outDir,
      { changed: [], added: [], removed: [], failed: [] },
      meta,
      { renderedCount: 0, commonCount: 0, scopedAll: false, skipped: true },
    )
  }

  const [baseStories, headStories] = await Promise.all([
    readStories(baseStatic, ws),
    readStories(headStatic, ws),
  ])

  const commonIds = [...headStories.keys()].filter((id) => baseStories.has(id))
  const targetIds = commonIds.filter((id) =>
    filter.isCandidate((headStories.get(id) as Story).importPath),
  )

  // Added / removed come from the difference between the story sets, independent of the render scope
  const added: RenderedStory[] = [...headStories.values()].filter(
    (s) => !baseStories.has(s.id),
  )
  const removed: RenderedStory[] = [...baseStories.values()].filter(
    (s) => !headStories.has(s.id),
  )

  // Scope details go to the CI log only (not to the PR comment or the gallery)
  if (filter.all) {
    console.log(
      `scope: 全 story (${targetIds.length} 件) を対象にレンダリングします ` +
        `[判定: ${filter.method}] (trigger: ${filter.touchedPackages.join(', ') || 'なし'})`,
    )
  } else {
    console.log(
      `scope: 変更に紐づく ${targetIds.length} / ${commonIds.length} story を対象 ` +
        `[判定: ${filter.method}] ` +
        `(packages: ${filter.touchedPackages.join(', ') || 'なし'}, ` +
        `story files: ${filter.touchedStoryFiles.length})`,
    )
  }

  const baseSrv = await startStaticServer(baseStatic)
  const headSrv = await startStaticServer(headStatic)
  // Serves the screenshots to the pixel-comparison pages. No caching, because step 2 re-shoots to the same file names
  const shotsSrv = await startStaticServer(shotsDir, { noStore: true })
  const browser = await chromium.launch()

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      // Ask libraries with JS-driven animation (charts etc.) to skip it, so the final state is shot
      reducedMotion: 'reduce',
    })
    await context.addInitScript(recordDomMutations)
    const maxWork = Math.max(targetIds.length, added.length, removed.length, 1)
    const lanes = Math.min(concurrency, maxWork)
    const pages = await openLanes(context, lanes, shotsSrv.baseUrl)

    const failed: FailedStory[] = []
    const shotPaths = (s: Story) => {
      const baseFile = `${s.id}__base.png`
      const headFile = `${s.id}__head.png`
      return {
        baseFile,
        headFile,
        basePath: join(shotsDir, baseFile),
        headPath: join(shotsDir, headFile),
      }
    }
    const removeShots = async (s: Story) => {
      const { basePath, headPath } = shotPaths(s)
      await Promise.all([
        unlink(basePath).catch(() => {}),
        unlink(headPath).catch(() => {}),
      ])
    }
    /** Compares the base / head shots. On failure, records it in `failed` and returns null */
    const compareShots = async (
      s: Story,
      w: number,
      okBase: ShotResult,
      okHead: ShotResult,
    ): Promise<boolean | null> => {
      const { baseFile, headFile } = shotPaths(s)
      if (!okBase.ok || !okHead.ok) {
        await removeShots(s)
        failed.push({
          ...s,
          baseOk: okBase.ok,
          headOk: okHead.ok,
          reason: okBase.error ?? okHead.error,
        })
        return null
      }
      const { changed: isChanged } = await pixelDiff(
        pages.diff[w],
        `${shotsSrv.baseUrl}/${encodeURIComponent(baseFile)}`,
        `${shotsSrv.baseUrl}/${encodeURIComponent(headFile)}`,
      )
      if (!isChanged) await removeShots(s)
      return isChanged
    }

    // Step 1: compare base / head HTML. If it differs, shoot right away and compare pixels
    // (shooting is expensive, so only stories with an HTML difference are shot. HTML differences
    //  that don't show, such as generated ids or measured styles, are dropped by the pixel diff)
    console.log('[html] capturing & diffing...')
    let htmlChangedCount = 0
    const visualCandidates: Story[] = []
    const compareStory = async (id: string, w: number, reuse: boolean) => {
      const meta = headStories.get(id) as Story
      const [base, head] = await Promise.all([
        captureHtml(pages.base[w], baseSrv.baseUrl, id, reuse),
        captureHtml(pages.head[w], headSrv.baseUrl, id, reuse),
      ])
      // If either side failed to render (null), it can't be compared. Record a failure instead of hiding it as "no difference"
      if (base.html == null || head.html == null) {
        failed.push({
          ...meta,
          baseOk: base.html != null,
          headOk: head.html != null,
          reason: base.error ?? head.error,
        })
        return
      }
      if (normalizeHtml(base.html) === normalizeHtml(head.html)) return
      htmlChangedCount += 1
      const { basePath, headPath } = shotPaths(meta)
      const [okBase, okHead] = await Promise.all([
        screenshotTo(pages.base[w].page, basePath),
        screenshotTo(pages.head[w].page, headPath),
      ])
      if (await compareShots(meta, w, okBase, okHead))
        visualCandidates.push(meta)
    }
    // Pages are reused only within one story file, and reloaded for each file, so side effects
    // of loading another file's modules (such as mockdate freezing Date) don't carry over.
    // Bigger files are assigned first to even out the lanes
    const storyFiles = new Map<string, string[]>()
    for (const id of targetIds) {
      const file = (headStories.get(id) as Story).importPath
      storyFiles.set(file, [...(storyFiles.get(file) ?? []), id])
    }
    const fileGroups = [...storyFiles.values()].sort(
      (a, b) => b.length - a.length,
    )
    await mapPool(fileGroups, lanes, async (ids, w) => {
      for (const [i, id] of ids.entries()) {
        await compareStory(id, w, reusePage && i > 0)
      }
    })
    console.log(
      `[html] HTML 差分あり ${htmlChangedCount} / ${targetIds.length} 件 → 画像 diff あり ${visualCandidates.length} 件`,
    )

    // Step 2: reload and re-shoot the stories with a pixel difference from iframe.html to confirm it.
    // This removes differences from state carried over by page reuse, and gives the gallery clean images
    // (without page reuse, step 1 already rendered from scratch, so its result stands)
    const changed: RenderedStory[] = []
    await mapPool(visualCandidates, lanes, async (s, w) => {
      const { baseFile, headFile, basePath, headPath } = shotPaths(s)
      if (reusePage) {
        const [okBase, okHead] = await Promise.all([
          captureShot(pages.base[w], baseSrv.baseUrl, s.id, basePath),
          captureShot(pages.head[w], headSrv.baseUrl, s.id, headPath),
        ])
        if (!(await compareShots(s, w, okBase, okHead))) return
      }
      const [baseSize, headSize] = await Promise.all([
        pngSize(basePath),
        pngSize(headPath),
      ])
      changed.push({
        ...s,
        baseShot: baseFile,
        headShot: headFile,
        baseWidth: baseSize?.width,
        baseHeight: baseSize?.height,
        headWidth: headSize?.width,
        headHeight: headSize?.height,
      })
    })
    changed.sort((a, b) => a.id.localeCompare(b.id))
    failed.sort((a, b) => a.id.localeCompare(b.id))
    console.log(
      `[diff] 視覚差分あり ${changed.length} 件 / 失敗 ${failed.length} 件`,
    )
    for (const f of failed) console.log(`  - FAIL ${f.id}: ${failedReason(f)}`)

    // Added stories are shot on head only, removed stories on base only
    console.log(
      `[shot] added (${added.length}) / removed (${removed.length})...`,
    )
    await mapPool(added, lanes, (s, w) =>
      shootOne(s, 'head', pages.head[w], headSrv.baseUrl, shotsDir),
    )
    await mapPool(removed, lanes, (s, w) =>
      shootOne(s, 'base', pages.base[w], baseSrv.baseUrl, shotsDir),
    )

    const result = await writeReport(
      outDir,
      { changed, added, removed, failed },
      meta,
      {
        renderedCount: targetIds.length,
        commonCount: commonIds.length,
        scopedAll: filter.all,
        skipped: false,
      },
    )
    console.log(
      `done: rendered=${targetIds.length} changed=${changed.length} added=${added.length} removed=${removed.length} failed=${failed.length} -> ${outDir}`,
    )
    return result
  } finally {
    await browser.close()
    for (const srv of [baseSrv, headSrv, shotsSrv]) srv.server.close()
  }
}

/**
 * Each lane has one base page and one head page, and renders the same stories in the same order.
 * State carried over from the previous story is then the same on both sides, so the comparison holds.
 * Each lane also has a page for pixel comparison (open on the same origin as the images)
 */
async function openLanes(
  context: BrowserContext,
  lanes: number,
  shotsBaseUrl: string,
): Promise<{ base: StoryPage[]; head: StoryPage[]; diff: Page[] }> {
  const open = (n: number) =>
    Promise.all(Array.from({ length: n }, () => openStoryPage(context)))
  const [base, head, diff] = await Promise.all([
    open(lanes),
    open(lanes),
    Promise.all(
      Array.from({ length: lanes }, async () => {
        const p = await context.newPage()
        await p.goto(`${shotsBaseUrl}/`)
        return p
      }),
    ),
  ])
  return { base, head, diff }
}

/** Shoots an added / removed story on one side only, and writes the result into s */
async function shootOne(
  s: RenderedStory,
  side: 'base' | 'head',
  sp: StoryPage,
  baseUrl: string,
  shotsDir: string,
): Promise<void> {
  const file = `${s.id}__${side}.png`
  const filePath = join(shotsDir, file)
  if (!(await captureShot(sp, baseUrl, s.id, filePath)).ok) return
  const size = await pngSize(filePath)
  if (side === 'head') {
    s.headShot = file
    s.headWidth = size?.width
    s.headHeight = size?.height
  } else {
    s.baseShot = file
    s.baseWidth = size?.width
    s.baseHeight = size?.height
  }
}

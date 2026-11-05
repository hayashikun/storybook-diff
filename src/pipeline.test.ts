import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { run } from './pipeline.ts'

const BUTTON_FILE = './packages/ui/src/Button.stories.tsx'
const CARD_FILE = './packages/ui/src/Card.stories.tsx'

type FakeStory = { id: string; importPath: string; html: string }

const box = (style: string, attrs = '') =>
  `<div ${attrs} style="width:200px;height:60px;${style}"></div>`

const BASE: FakeStory[] = [
  {
    id: 'button--primary',
    importPath: BUTTON_FILE,
    html: box('background:#2563eb'),
  },
  {
    id: 'button--secondary',
    importPath: BUTTON_FILE,
    html: box('background:#e5e7eb'),
  },
  // HTML differs but looks the same, so the pixel comparison drops it
  {
    id: 'button--invisible',
    importPath: BUTTON_FILE,
    html: box('background:#000', 'data-x="1"'),
  },
  {
    id: 'button--removed',
    importPath: BUTTON_FILE,
    html: box('background:#16a34a'),
  },
  // Not tied to the changed files, so it isn't rendered
  { id: 'card--default', importPath: CARD_FILE, html: box('background:#fff') },
]

const HEAD: FakeStory[] = [
  {
    id: 'button--primary',
    importPath: BUTTON_FILE,
    html: box('background:#dc2626'),
  },
  {
    id: 'button--secondary',
    importPath: BUTTON_FILE,
    html: box('background:#e5e7eb'),
  },
  {
    id: 'button--invisible',
    importPath: BUTTON_FILE,
    html: box('background:#000', 'data-x="2"'),
  },
  {
    id: 'button--added',
    importPath: BUTTON_FILE,
    html: box('background:#9333ea'),
  },
  { id: 'card--default', importPath: CARD_FILE, html: box('background:#000') },
]

/**
 * Writes a minimal static output that mimics `storybook build`.
 * iframe.html implements only the parts of the preview API this tool uses
 * (channel's setCurrentStory, and currentRender's id / phase)
 */
async function writeFakeStorybook(dir: string, stories: FakeStory[]) {
  await mkdir(dir, { recursive: true })
  const entries = Object.fromEntries(
    stories.map((s) => {
      const [title, name] = s.id.split('--')
      return [
        s.id,
        { type: 'story', id: s.id, title, name, importPath: s.importPath },
      ]
    }),
  )
  await writeFile(join(dir, 'index.json'), JSON.stringify({ v: 5, entries }))
  const html = Object.fromEntries(stories.map((s) => [s.id, s.html]))
  await writeFile(
    join(dir, 'iframe.html'),
    `<!doctype html><html><head><style>body{margin:0}</style></head><body>
<div id="storybook-root"></div>
<script>
const STORIES = ${JSON.stringify(html)};
const root = document.getElementById('storybook-root');
const preview = { currentRender: null, channel: { emit(event, payload) {
  if (event === 'setCurrentStory') render(payload.storyId);
} } };
window.__STORYBOOK_PREVIEW__ = preview;
function render(id) {
  preview.currentRender = { id, phase: 'rendering' };
  setTimeout(() => {
    root.innerHTML = STORIES[id] ?? '';
    preview.currentRender = { id, phase: 'completed' };
  }, 10);
}
render(new URLSearchParams(location.search).get('id'));
</script></body></html>`,
  )
}

describe('run (Chromium で描画して比較する)', () => {
  let work: string
  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'storybook-diff-test-'))
    await writeFakeStorybook(join(work, 'base'), BASE)
    await writeFakeStorybook(join(work, 'head'), HEAD)
  })
  afterAll(async () => {
    await rm(work, { recursive: true, force: true })
  })

  test.each([
    ['ページを使い回す', true],
    ['story ごとに読み込み直す', false],
  ])('%s場合も見た目の差分だけを検出する', async (_, reusePage) => {
    const outDir = join(work, `out-${reusePage}`)
    const result = await run({
      baseStatic: join(work, 'base'),
      headStatic: join(work, 'head'),
      outDir,
      changedFiles: ['packages/ui/src/Button.stories.tsx'],
      concurrency: 2,
      reusePage,
      prUrl: 'https://github.com/example/repo/pull/1',
    })

    expect(result.changed.map((s) => s.id)).toEqual(['button--primary'])
    expect(result.added.map((s) => s.id)).toEqual(['button--added'])
    expect(result.removed.map((s) => s.id)).toEqual(['button--removed'])
    expect(result.failed).toEqual([])
    // Card isn't tied to the changed files, so it isn't compared (its change goes undetected)
    expect(result.commonCount).toBe(4)
    expect(result.renderedCount).toBe(3)

    const shots = join(outDir, 'shots')
    expect(existsSync(join(shots, 'button--primary__base.png'))).toBe(true)
    expect(existsSync(join(shots, 'button--primary__head.png'))).toBe(true)
    expect(existsSync(join(shots, 'button--added__head.png'))).toBe(true)
    expect(existsSync(join(shots, 'button--removed__base.png'))).toBe(true)
    // Screenshots of stories with no difference are not kept
    expect(existsSync(join(shots, 'button--invisible__base.png'))).toBe(false)

    const summary = await readFile(join(outDir, 'summary.md'), 'utf-8')
    expect(summary).toContain('**変更 1 件**')
    const gallery = await readFile(join(outDir, 'index.html'), 'utf-8')
    expect(gallery).toContain(
      'data-pr-key="https://github.com/example/repo/pull/1"',
    )
    expect(gallery).toContain('<script>')
    const json = JSON.parse(
      await readFile(join(outDir, 'result.json'), 'utf-8'),
    )
    expect(json.changedCount).toBe(1)
  })

  test('変更ファイル一覧が無ければ描画せず空のレポートを作る', async () => {
    const outDir = join(work, 'out-skip')
    const result = await run({
      baseStatic: join(work, 'base'),
      headStatic: join(work, 'head'),
      outDir,
      changedFiles: null,
    })
    expect(result.skipped).toBe(true)
    expect(result.renderedCount).toBe(0)
    const gallery = await readFile(join(outDir, 'index.html'), 'utf-8')
    // Even an empty report embeds the script (sidebar and so on)
    expect(gallery).toContain('<script>')
  })
})

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { buildGallery } from './report/gallery.ts'
import { createStaticHandler } from './static-server.ts'
import type { FailedStory, RenderedStory } from './types.ts'

const outDir = '/tmp/storybook-diff-dev'
const shotsDir = join(outDir, 'shots')
mkdirSync(shotsDir, { recursive: true })

type RGB = [number, number, number]

function encodePng(
  width: number,
  height: number,
  pixels: (x: number, y: number) => RGB,
): Buffer {
  const rawSize = width * height * 3 + height
  const raw = Buffer.alloc(rawSize)
  let offset = 0
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixels(x, y)
      raw[offset++] = r
      raw[offset++] = g
      raw[offset++] = b
    }
  }

  const crc32Table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc32Table[n] = c
  }
  const crc32 = (buf: Buffer, start: number, len: number) => {
    let c = 0xffffffff
    for (let i = start; i < start + len; i++)
      c = crc32Table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }

  const deflated: number[] = [0x78, 0x01]
  const maxBlock = 65535
  for (let i = 0; i < rawSize; i += maxBlock) {
    const blockSize = Math.min(maxBlock, rawSize - i)
    const last = i + blockSize >= rawSize ? 1 : 0
    deflated.push(
      last,
      blockSize & 0xff,
      (blockSize >> 8) & 0xff,
      ~blockSize & 0xff,
      (~blockSize >> 8) & 0xff,
    )
    for (let j = 0; j < blockSize; j++) deflated.push(raw[i + j])
  }
  let s1 = 1
  let s2 = 0
  for (let i = 0; i < rawSize; i++) {
    s1 = (s1 + raw[i]) % 65521
    s2 = (s2 + s1) % 65521
  }
  const adler = ((s2 << 16) | s1) >>> 0
  deflated.push(
    (adler >> 24) & 0xff,
    (adler >> 16) & 0xff,
    (adler >> 8) & 0xff,
    adler & 0xff,
  )

  const chunks: Buffer[] = []
  chunks.push(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const writeChunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(typeAndData, 0, typeAndData.length))
    chunks.push(len, typeAndData, crc)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  writeChunk('IHDR', ihdr)
  writeChunk('IDAT', Buffer.from(deflated))
  writeChunk('IEND', Buffer.alloc(0))
  return Buffer.concat(chunks)
}

const W = 400
const H = 300

const mix = (a: RGB, b: RGB, t: number): RGB => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
]

const clamp = (v: number) => Math.max(0, Math.min(255, v))

type ScenePair = {
  base: (x: number, y: number) => RGB
  head: (x: number, y: number) => RGB
}

const scenes: ScenePair[] = [
  {
    // Button colour changed: a card in the background, a button rectangle in the middle
    base: (x, y) => {
      if (y < 40) return [245, 245, 245] // header
      if (x > 120 && x < 280 && y > 120 && y < 170) return [59, 130, 246] // blue button
      if (x > 60 && x < 340 && y > 80 && y < 220) return [255, 255, 255] // card
      return [243, 244, 246]
    },
    head: (x, y) => {
      if (y < 40) return [245, 245, 245]
      if (x > 120 && x < 280 && y > 120 && y < 170) return [220, 38, 38] // now a red button
      if (x > 60 && x < 340 && y > 80 && y < 220) return [255, 255, 255]
      return [243, 244, 246]
    },
  },
  {
    // A text row added: one more striped row
    base: (_x, y) => {
      if (y < 32) return [30, 41, 59] // dark header
      const row = Math.floor((y - 32) / 28)
      if (row >= 4) return [255, 255, 255]
      return row % 2 === 0 ? [249, 250, 251] : [255, 255, 255]
    },
    head: (_x, y) => {
      if (y < 32) return [30, 41, 59]
      const row = Math.floor((y - 32) / 28)
      if (row >= 6) return [255, 255, 255]
      if (row === 4) return [254, 243, 199] // the new row (yellow highlight)
      if (row === 5) return [254, 243, 199]
      return row % 2 === 0 ? [249, 250, 251] : [255, 255, 255]
    },
  },
  {
    // Sidebar width changed: the left column's edge moves
    base: (x, y) => {
      if (x < 200) return y < 48 ? [30, 41, 59] : [243, 244, 246] // sidebar
      if (x < 202) return [229, 231, 235] // border
      return y < 48 ? [255, 255, 255] : [255, 255, 255]
    },
    head: (x, y) => {
      if (x < 240) return y < 48 ? [30, 41, 59] : [243, 244, 246] // wider sidebar
      if (x < 242) return [229, 231, 235]
      return y < 48 ? [255, 255, 255] : [255, 255, 255]
    },
  },
  {
    // Gradient badge colour changed
    base: (x, y) => {
      const bg: RGB = [255, 255, 255]
      if (y > 100 && y < 140 && x > 80 && x < 320) {
        const t = (x - 80) / 240
        return mix([59, 130, 246], [147, 51, 234], t)
      }
      if (y > 160 && y < 200 && x > 80 && x < 320) {
        return [229, 231, 235] // progress bar background
      }
      if (y > 160 && y < 200 && x > 80 && x < 200) {
        return [34, 197, 94] // 50% progress
      }
      return bg
    },
    head: (x, y) => {
      const bg: RGB = [255, 255, 255]
      if (y > 100 && y < 140 && x > 80 && x < 320) {
        const t = (x - 80) / 240
        return mix([234, 88, 12], [220, 38, 38], t) // now orange to red
      }
      if (y > 160 && y < 200 && x > 80 && x < 320) {
        return [229, 231, 235]
      }
      if (y > 160 && y < 200 && x > 80 && x < 280) {
        return [34, 197, 94] // now 80% progress
      }
      return bg
    },
  },
  {
    // Checker pattern cell size changed
    base: (x, y) => {
      const cx = Math.floor(x / 32)
      const cy = Math.floor(y / 32)
      return (cx + cy) % 2 === 0
        ? [clamp(200 + cx * 3), clamp(200 - cy * 3), 240]
        : [255, 255, 255]
    },
    head: (x, y) => {
      const cx = Math.floor(x / 24) // new cell size
      const cy = Math.floor(y / 24)
      return (cx + cy) % 2 === 0
        ? [clamp(200 + cx * 3), clamp(200 - cy * 3), 240]
        : [255, 255, 255]
    },
  },
]

type TallScenePair = ScenePair & { w: number; h: number }

function generateScenes(): {
  scenes: TallScenePair[]
  names: { title: string; name: string; pkg: string }[]
} {
  const allScenes: TallScenePair[] = scenes.map((s) => ({
    ...s,
    w: W,
    h: H,
  }))
  const names = [
    { title: 'Diff/Color', name: 'ボタン色の変更', pkg: 'ui' },
    { title: 'Diff/Layout', name: '行の追加', pkg: 'app' },
    { title: 'Diff/Position', name: 'サイドバー幅の変更', pkg: 'ui' },
    {
      title: 'Diff/Gradient',
      name: 'グラデーション＋プログレスバー',
      pkg: 'ui',
    },
    {
      title: 'Diff/Pattern',
      name: 'チェッカーのセルサイズ変更',
      pkg: 'design-tokens',
    },
  ]

  const heights = [
    350, 400, 450, 500, 550, 600, 320, 480, 420, 380, 520, 360, 440, 470, 530,
  ]
  const colors: [RGB, RGB][] = [
    [
      [59, 130, 246],
      [220, 38, 38],
    ],
    [
      [34, 197, 94],
      [234, 88, 12],
    ],
    [
      [147, 51, 234],
      [59, 130, 246],
    ],
    [
      [236, 72, 153],
      [34, 197, 94],
    ],
    [
      [245, 158, 11],
      [147, 51, 234],
    ],
  ]

  for (let i = 0; i < 15; i++) {
    const h = heights[i]
    const [c1, c2] = colors[i % colors.length]
    allScenes.push({
      w: W,
      h,
      base: (_x, y) => {
        if (y < 48) return [30, 41, 59]
        const t = (y - 48) / (h - 48)
        const stripe = Math.floor(y / 24)
        if (stripe % 2 === 0) return mix(c1, [255, 255, 255], t * 0.5)
        return [255, 255, 255]
      },
      head: (_x, y) => {
        if (y < 48) return [30, 41, 59]
        const t = (y - 48) / (h - 48)
        const stripe = Math.floor(y / 24)
        if (stripe % 2 === 0) return mix(c2, [255, 255, 255], t * 0.5)
        return [255, 255, 255]
      },
    })
    names.push({
      title: `Scroll/Card${i + 1}`,
      name: `スクロールテスト用カード（高さ${h}px）`,
      pkg: ['ui', 'app', 'design-tokens'][i % 3],
    })
  }

  return { scenes: allScenes, names }
}

const { scenes: allScenes, names: storyNames } = generateScenes()

const changed: RenderedStory[] = allScenes.map((scene, i) => {
  const baseFile = `base-${i}.png`
  const headFile = `head-${i}.png`
  writeFileSync(
    join(shotsDir, baseFile),
    encodePng(scene.w, scene.h, scene.base),
  )
  writeFileSync(
    join(shotsDir, headFile),
    encodePng(scene.w, scene.h, scene.head),
  )
  return {
    id: `${storyNames[i].title.toLowerCase().replace(/\//g, '-')}--${storyNames[i].name.toLowerCase().replace(/ /g, '-')}`,
    title: storyNames[i].title,
    name: storyNames[i].name,
    importPath: `packages/${storyNames[i].pkg}/src/${storyNames[i].title.replace(/\//g, '/')}.stories.tsx`,
    pkg: storyNames[i].pkg,
    baseShot: baseFile,
    headShot: headFile,
    baseWidth: scene.w,
    baseHeight: scene.h,
    headWidth: scene.w,
    headHeight: scene.h,
  }
})

const added: RenderedStory[] = [
  {
    id: 'added--new-component',
    title: 'Added',
    name: '新規コンポーネント（base に存在しない）',
    importPath: 'packages/ui/src/components/Tooltip/Tooltip.stories.tsx',
    pkg: 'ui',
  },
  {
    id: 'added--new-variant',
    title: 'Added',
    name: '新規バリアント（base に存在しない）',
    importPath: 'packages/ui/src/components/Tooltip/Tooltip.stories.tsx',
    pkg: 'ui',
  },
]

const removed: RenderedStory[] = [
  {
    id: 'removed--deprecated-component',
    title: 'Removed',
    name: '廃止コンポーネント（head で削除）',
    importPath:
      'packages/ui/src/components/LegacyModal/LegacyModal.stories.tsx',
    pkg: 'ui',
  },
  {
    id: 'removed--deprecated-variant',
    title: 'Removed',
    name: '廃止バリアント（head で削除）',
    importPath:
      'packages/ui/src/components/LegacyModal/LegacyModal.stories.tsx',
    pkg: 'ui',
  },
]

const failed: FailedStory[] = [
  {
    id: 'failed--render-timeout',
    title: 'Failed',
    name: 'レンダリングタイムアウト',
    importPath: 'packages/ui/src/components/Chart/Chart.stories.tsx',
    pkg: 'ui',
    baseOk: true,
    headOk: false,
    reason: 'Timeout waiting for story to render',
  },
]

const clientScriptPath = new URL('./report/gallery-client.js', import.meta.url)

const reloadScript = `;(function(){
  var es = new EventSource('/__reload');
  es.onerror = function(){
    es.close();
    var t = setInterval(function(){
      fetch('/__ping').then(function(){ clearInterval(t); location.reload(); }).catch(function(){});
    }, 300);
  };
})();`

const payload = { changed, added, removed, failed }

function regenerateHtml(): string {
  const clientScript = readFileSync(clientScriptPath, 'utf-8')
  return buildGallery(payload, {
    prTitle: 'feat: Button コンポーネントのスタイル更新',
    prUrl: '#',
    clientScript: clientScript + reloadScript,
  })
}

writeFileSync(join(outDir, 'index.html'), regenerateHtml(), 'utf-8')

const PORT = 4983

const serveStatic = createStaticHandler(outDir)

const server = createServer((req, res) => {
  const rawPath = decodeURIComponent((req.url ?? '/').split('?')[0])

  if (rawPath === '/__ping') {
    res.writeHead(200)
    res.end('ok')
    return
  }

  if (rawPath === '/__reload') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write('data: connected\n\n')
    return
  }

  if (rawPath === '/' || rawPath === '/index.html') {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(regenerateHtml())
    return
  }

  serveStatic(req, res)
})

const openedFlag = join(outDir, '.opened')

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `Port ${PORT} is already in use. Run: lsof -ti:${PORT} | xargs kill`,
    )
    process.exit(1)
  }
  throw err
})

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/index.html`
  console.log(`Gallery serving at ${url}`)
  if (!existsSync(openedFlag)) {
    writeFileSync(openedFlag, String(process.pid))
    try {
      execSync(`open "${url}"`)
    } catch {
      // Without an `open` command, just print the URL
    }
  }
  console.log('Watching for changes (hot reload enabled)')
})

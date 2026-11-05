import { readFileSync } from 'node:fs'
import { DIFF_CHANNEL_THRESHOLD } from '../diff.ts'
import type {
  FailedStory,
  GalleryPayload,
  RenderedStory,
  Story,
} from '../types.ts'
import { escapeHtml, failedReason } from './format.ts'

export type GalleryMeta = {
  prTitle?: string
  /** Link target in the header. Also the key that keeps "reviewed" flags separate per PR */
  prUrl?: string
  /** Client script to embed (default: gallery-client.js). dev-gallery swaps it for hot reload */
  clientScript?: string
}

/**
 * Reads an asset from this directory. It is re-read on every call so dev-gallery picks up edits
 * immediately (a gallery is generated once per run, so the cost is negligible)
 */
function readAsset(name: string): string {
  return readFileSync(new URL(`./${name}`, import.meta.url), 'utf-8')
}

function figureCell(
  label: string,
  shot: string | undefined,
  missingText: string,
  storybookUrl?: string,
  imgWidth?: number,
  imgHeight?: number,
): string {
  const sizeAttr =
    imgWidth && imgHeight ? ` width="${imgWidth}" height="${imgHeight}"` : ''
  const body = shot
    ? `<img loading="lazy" src="./shots/${escapeHtml(shot)}"${sizeAttr} alt="${escapeHtml(label)} ${escapeHtml(shot)}">`
    : `<div class="missing">${escapeHtml(missingText)}</div>`
  const sbLink = storybookUrl
    ? ` <a class="sb-link" href="${escapeHtml(storybookUrl)}" target="_blank" rel="noopener">(<u>Storybook</u>)</a>`
    : ''
  return `<figure><figcaption>${escapeHtml(label)}${sbLink}</figcaption>${body}</figure>`
}

/** Button that copies a deep link to this diff (to share one story in a review) */
function copyLinkBtn(id: string): string {
  return `<button type="button" class="copy-link" data-id="${escapeHtml(id)}" title="この diff へのリンクをコピー">🔗 リンク</button>`
}

/** Button that copies the story file path (to look at the source) */
function copyFileBtn(importPath: string): string {
  return `<button type="button" class="copy-file" data-file="${escapeHtml(importPath)}" title="story ファイルのパスをコピー">📄 ファイル名</button>`
}

function storybookUrl(dir: string, id: string): string {
  return `./${dir}/index.html?path=/story/${encodeURIComponent(id)}`
}

/** "Reviewed" checkbox (kept per PR in localStorage) */
function reviewedBox(id: string): string {
  return `<label class="reviewed"><input type="checkbox" data-check="${escapeHtml(id)}">確認済み</label>`
}

function storyCard(
  s: RenderedStory | FailedStory,
  kind: 'changed' | 'added' | 'removed' | 'failed',
): string {
  const head = `<section class="card ${kind}" id="${escapeHtml(s.id)}">
      <h2><button type="button" class="fold" aria-label="折りたたみ/展開" title="折りたたみ/展開">▾</button><span class="fold-target" title="クリックで折りたたみ/展開">${escapeHtml(s.title)} <span class="name">› ${escapeHtml(s.name)}</span></span> <span class="badge ${kind}">${kind}</span>${reviewedBox(s.id)}</h2>
      <div class="story-id"><span class="pkg">${escapeHtml(s.pkg)}</span> <span class="sid">${escapeHtml(s.id)}</span> ${copyLinkBtn(s.id)} ${copyFileBtn(s.importPath)}</div>`
  if (kind === 'failed') {
    return `${head}
      <div class="failed-reason">${escapeHtml(failedReason(s as FailedStory))}</div>
    </section>`
  }
  const rs = s as RenderedStory
  const baseCell =
    kind === 'added'
      ? figureCell('base', undefined, 'base に存在しない（新規 story）')
      : figureCell(
          'base',
          rs.baseShot,
          'レンダリング失敗',
          storybookUrl('storybook-base', s.id),
          rs.baseWidth,
          rs.baseHeight,
        )
  const headCell =
    kind === 'removed'
      ? figureCell('head', undefined, 'head で削除された story')
      : figureCell(
          'head',
          rs.headShot,
          'レンダリング失敗',
          storybookUrl('storybook-head', s.id),
          rs.headWidth,
          rs.headHeight,
        )
  if (kind === 'changed' && rs.baseShot && rs.headShot) {
    return `${head}
      <div class="diff" data-base="./shots/${escapeHtml(rs.baseShot)}" data-head="./shots/${escapeHtml(rs.headShot)}" data-sb-base="${escapeHtml(storybookUrl('storybook-base', s.id))}" data-sb-head="${escapeHtml(storybookUrl('storybook-head', s.id))}"${rs.baseWidth ? ` data-base-w="${rs.baseWidth}" data-base-h="${rs.baseHeight}"` : ''}${rs.headWidth ? ` data-head-w="${rs.headWidth}" data-head-h="${rs.headHeight}"` : ''}><div class="pair">${baseCell}${headCell}</div></div>
    </section>`
  }
  return `${head}
      <div class="pair">${baseCell}${headCell}</div>
    </section>`
}

function navGroup(label: string, items: Story[], kind: string): string {
  if (items.length === 0) return ''
  const links = items
    .map(
      (s) =>
        `<li><a href="#${escapeHtml(s.id)}" title="${escapeHtml(`${s.title} › ${s.name}`)}"><span class="nav-title">${escapeHtml(s.title)}</span><span class="nav-name">${escapeHtml(s.name)}</span><span class="nav-pkg">${escapeHtml(s.pkg)}</span></a></li>`,
    )
    .join('')
  return `<div class="nav-group">
      <div class="nav-heading"><span class="dot ${kind}"></span>${escapeHtml(label)}<span class="nav-count">${items.length}</span></div>
      <ul>${links}</ul>
    </div>`
}

export function buildGallery(
  { changed, added, removed, failed }: GalleryPayload,
  meta: GalleryMeta = {},
): string {
  const { prTitle, prUrl } = meta
  const clientScript = meta.clientScript ?? readAsset('gallery-client.js')
  const css = readAsset('gallery.css')
  const hasAny =
    changed.length + added.length + removed.length + failed.length > 0
  // Changed stories have both base and head, so layout and diff highlight can be toggled independently
  const layoutControls =
    changed.length > 0
      ? `<span class="vt-label">レイアウト</span>
      <div class="seg">
        <button type="button" data-layout="side">横並べ</button>
        <button type="button" data-layout="slider">スライダー</button>
      </div>
      <span class="vt-label">差分ハイライト</span>
      <div class="seg">
        <button type="button" data-hl="off">なし</button>
        <button type="button" data-hl="on">あり</button>
      </div>
      <label class="vt-color">色 <input type="color" data-hl-color value="#16a34a"></label>`
      : ''
  const shortcutHelp = `<div class="shortcut-help"><button type="button" class="shortcut-help-btn" aria-label="キーボードショートカット">?</button><div class="shortcut-tip"><div><kbd class="mod-alt">Alt</kbd>+<kbd>↑</kbd><kbd>↓</kbd> カード移動</div><div><kbd>A</kbd> 承認して次へ</div><div><kbd>D</kbd> 確認済みを外す</div></div></div>`
  const viewToggle = hasAny
    ? `<div class="view-toggle">${layoutControls}${shortcutHelp}</div>`
    : ''
  const section = (
    heading: string,
    items: RenderedStory[],
    kind: 'changed' | 'added' | 'removed',
  ) =>
    items.length === 0
      ? ''
      : `<h2 class="section-heading"><span class="dot ${kind}"></span>${escapeHtml(heading)} <span class="section-count">${items.length}</span></h2>${items.map((s) => storyCard(s, kind)).join('\n')}`

  const failedSection =
    failed.length === 0
      ? ''
      : `<h2 class="section-heading"><span class="dot failed"></span>レンダリング失敗 <span class="section-count">${failed.length}</span></h2>${failed.map((s) => storyCard(s, 'failed')).join('\n')}`

  const prHeader = prTitle
    ? `<a class="pr-link" href="${escapeHtml(prUrl || '#')}" target="_blank" rel="noopener noreferrer">${escapeHtml(prTitle)}<span class="ext">↗</span></a>`
    : ''

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Storybook Diff${prTitle ? ` · ${escapeHtml(prTitle)}` : ''}</title>
<style>
${css}
</style>
</head>
<body data-pr-key="${escapeHtml(prUrl || '')}" data-diff-threshold="${DIFF_CHANNEL_THRESHOLD}">
  <button type="button" class="sidebar-open" aria-label="サイドバーを開く" title="サイドバーを開く">»</button>
  <aside class="sidebar">
    <div class="sidebar-header">
      <div class="brand">📚 Storybook Diff<button type="button" class="sidebar-close" aria-label="サイドバーを閉じる" title="サイドバーを閉じる">«</button></div>
      ${hasAny ? `<div class="progress"><div class="progress-text">確認済み <span class="progress-count">0</span> / <span class="progress-total">${changed.length + added.length + removed.length + failed.length}</span></div><div class="progress-bar"><div class="progress-fill" style="width:0%"></div></div></div>` : '<p class="empty">差分はありません</p>'}
    </div>
    <div class="sidebar-nav">
      <div class="summary">
        <span class="stat"><span class="dot changed"></span> 変更 <b>${changed.length}</b></span>
        <span class="stat"><span class="dot added"></span> 追加 <b>${added.length}</b></span>
        <span class="stat"><span class="dot removed"></span> 削除 <b>${removed.length}</b></span>
        ${failed.length > 0 ? `<span class="stat"><span class="dot failed"></span> 失敗 <b>${failed.length}</b></span>` : ''}
      </div>
      ${navGroup('変更', changed, 'changed')}
      ${navGroup('追加', added, 'added')}
      ${navGroup('削除', removed, 'removed')}
      ${navGroup('失敗', failed, 'failed')}
    </div>
    <div class="sidebar-resize"></div>
  </aside>
  <main class="main">
    <header class="pr-header">
      <p class="eyebrow">Pull Request</p>
      ${prHeader || '<div class="pr-link">Storybook Diff</div>'}
    </header>
    ${viewToggle}
    ${hasAny ? '' : '<p class="empty">差分のある story はありませんでした。</p>'}
    ${section('変更された story', changed, 'changed')}
    ${section('追加された story', added, 'added')}
    ${section('削除された story', removed, 'removed')}
    ${failedSection}
  </main>
  <dialog class="lightbox"><img alt="拡大表示"></dialog>
  ${clientScript ? `<script>${clientScript}</script>` : ''}
</body>
</html>`
}

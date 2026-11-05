import type { GalleryPayload, Story } from '../types.ts'
import { failedReason } from './format.ts'

// A PR comment over 65536 characters fails the posting step with a 422, so with many stories
// each section's list is cut and the total length is kept under the limit.
const SUMMARY_MAX_PER_SECTION = 50
const SUMMARY_MAX_CHARS = 60000

export function buildSummary({
  changed,
  added,
  removed,
  failed,
}: GalleryPayload): string {
  const lines: string[] = []
  lines.push('## 📚 Storybook Diff')
  lines.push('')
  if (
    changed.length === 0 &&
    added.length === 0 &&
    removed.length === 0 &&
    failed.length === 0
  ) {
    lines.push('レンダリング差分のある story はありませんでした。 🎉')
    return lines.join('\n')
  }
  const counts = [
    `**変更 ${changed.length} 件**`,
    `追加 ${added.length} 件`,
    `削除 ${removed.length} 件`,
  ]
  if (failed.length > 0) counts.push(`⚠️ 失敗 ${failed.length} 件`)
  lines.push(counts.join(' / '))
  lines.push('')

  // Each story shows its package as `pkg`
  const detailsList = (label: string, items: Story[], open: boolean) => {
    if (items.length === 0) return
    lines.push(
      `<details${open ? ' open' : ''}><summary>${label} (${items.length})</summary>`,
    )
    lines.push('')
    for (const s of items.slice(0, SUMMARY_MAX_PER_SECTION))
      lines.push(`- \`${s.pkg}\` **${s.title}** › ${s.name} \`${s.id}\``)
    if (items.length > SUMMARY_MAX_PER_SECTION)
      lines.push(
        `- …ほか ${items.length - SUMMARY_MAX_PER_SECTION} 件（全件はギャラリー参照）`,
      )
    lines.push('')
    lines.push('</details>')
    lines.push('')
  }

  // All sections start collapsed to keep the comment compact (the header line has the counts)
  detailsList('差分のある story', changed, false)
  detailsList('追加された story', added, false)
  detailsList('削除された story', removed, false)

  if (failed.length > 0) {
    lines.push('<details><summary>⚠️ レンダリングに失敗した story</summary>')
    lines.push('')
    for (const s of failed.slice(0, SUMMARY_MAX_PER_SECTION)) {
      lines.push(
        `- \`${s.pkg}\` **${s.title}** › ${s.name} \`${s.id}\` — ${failedReason(s)}`,
      )
    }
    if (failed.length > SUMMARY_MAX_PER_SECTION)
      lines.push(`- …ほか ${failed.length - SUMMARY_MAX_PER_SECTION} 件`)
    lines.push('')
    lines.push('</details>')
    lines.push('')
  }

  const summary = lines.join('\n')
  // Last line of defence if it's still too long after cutting sections (extremely long ids / titles). Always fits the limit
  if (summary.length <= SUMMARY_MAX_CHARS) return summary
  return `${summary.slice(0, SUMMARY_MAX_CHARS)}\n\n> （長いため以降を省略。全件はギャラリー参照）`
}

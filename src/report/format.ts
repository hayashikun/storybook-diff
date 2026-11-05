import type { FailedStory } from '../types.ts'

export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Describes why a story failed to render (listed as text, since there's no image) */
export function failedReason(s: FailedStory): string {
  const where =
    !s.baseOk && !s.headOk
      ? 'base / head 両方で失敗'
      : !s.baseOk
        ? 'base のレンダリング失敗'
        : 'head のレンダリング失敗'
  return s.reason ? `${where} (${s.reason})` : where
}

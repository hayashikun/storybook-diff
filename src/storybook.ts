import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Story } from './types.ts'
import type { Workspace } from './workspace.ts'

type IndexEntry = {
  type?: string
  id: string
  title: string
  name: string
  importPath?: string
}

/** Reads the stories (excluding docs) from storybook-static's index.json */
export async function readStories(
  staticDir: string,
  ws: Workspace,
): Promise<Map<string, Story>> {
  const raw = JSON.parse(await readFile(join(staticDir, 'index.json'), 'utf-8'))
  const entries: Record<string, IndexEntry> = raw.entries ?? raw.stories ?? {}
  const stories = new Map<string, Story>()
  for (const entry of Object.values(entries)) {
    if (entry.type && entry.type !== 'story') continue
    const importPath = ws.normalize(entry.importPath ?? '')
    stories.set(entry.id, {
      id: entry.id,
      title: entry.title,
      name: entry.name,
      importPath,
      pkg: ws.label(importPath),
    })
  }
  return stories
}

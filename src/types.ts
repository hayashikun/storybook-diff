export type Story = {
  id: string
  title: string
  name: string
  importPath: string
  /** Package name for display (without the workspace dir; "-" outside any package) */
  pkg: string
}

export type RenderedStory = Story & {
  baseShot?: string
  headShot?: string
  baseWidth?: number
  baseHeight?: number
  headWidth?: number
  headHeight?: number
}

export type FailedStory = Story & {
  baseOk: boolean
  headOk: boolean
  reason?: string
}

export type GalleryPayload = {
  changed: RenderedStory[]
  added: RenderedStory[]
  removed: RenderedStory[]
  failed: FailedStory[]
}

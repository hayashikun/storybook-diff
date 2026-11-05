import type { BrowserContext, Page, Request } from '@playwright/test'

const SETTLE_QUIET_MS = 150
// Upper bound on waiting, for stories that never settle (SSE etc.)
const SETTLE_TIMEOUT_MS = 3000
const SETTLE_QUIET_FRAMES = 5
const SETTLE_POLL_MS = 50
// Never-ending requests (persistent connections, audio / video held after a partial read) are left out of the settle check
const IGNORED_RESOURCE_TYPES = new Set(['eventsource', 'websocket', 'media'])
// Turn off addon-a11y's automatic axe run. Its results aren't used and it only costs CPU
// (Storybooks without addon-a11y ignore it as an unknown global)
const STORY_URL_GLOBALS = 'a11y.manual:!true'
// Storybook's own elements, left out of the comparison (their attributes change as addons open and close, unrelated to the story)
const IGNORED_ELEMENTS_SELECTOR =
  '[id^="storybook-highlights-"], #storybook-a11y-vision-filters'

type PreviewWindow = {
  __STORYBOOK_PREVIEW__?: {
    channel?: { emit: (event: string, payload: unknown) => void }
    currentRender?: { id?: string; phase?: string }
  }
}

export type StoryPage = {
  page: Page
  /** Whether iframe.html is loaded and can be used to switch stories */
  loaded: boolean
  renderStartedAt: number
  lastNetworkAt: number
  pendingRequests: Map<Request, number>
}

export async function openStoryPage(
  context: BrowserContext,
): Promise<StoryPage> {
  const page = await context.newPage()
  const sp: StoryPage = {
    page,
    loaded: false,
    renderStartedAt: 0,
    lastNetworkAt: 0,
    pendingRequests: new Map(),
  }
  page.on('request', (req) => {
    if (IGNORED_RESOURCE_TYPES.has(req.resourceType())) return
    sp.pendingRequests.set(req, Date.now())
    sp.lastNetworkAt = Date.now()
  })
  const onEnd = (req: Request) => {
    if (sp.pendingRequests.delete(req)) sp.lastNetworkAt = Date.now()
  }
  page.on('requestfinished', onEnd)
  page.on('requestfailed', onEnd)
  return sp
}

type StorybookDiffWindow = {
  __storybookDiff?: {
    now: () => number
    requestAnimationFrame: (cb: () => void) => number
    setTimeout: (cb: () => void, ms: number) => number
    lastMutation: number
  }
}

/**
 * Records when the DOM last changed. If a story freezes Date with mockdate or similar, the clock
 * stays frozen for later stories on a reused page, so keep the clock and timers from before they were replaced
 */
export function recordDomMutations(): void {
  const now = performance.now.bind(performance)
  const state = {
    now,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    setTimeout: window.setTimeout.bind(window),
    lastMutation: now(),
  }
  ;(window as unknown as StorybookDiffWindow).__storybookDiff = state
  new MutationObserver(() => {
    state.lastMutation = now()
  }).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  })
}

function storyUrl(baseUrl: string, id: string): string {
  return `${baseUrl}/iframe.html?id=${encodeURIComponent(id)}&viewMode=story&globals=${STORY_URL_GLOBALS}`
}

/**
 * Switches the story on an already-loaded iframe.html.
 * Reloading costs a lot of CPU to evaluate and initialize the preview JS
 */
async function switchStory(page: Page, id: string): Promise<boolean> {
  const emitted = await page
    .evaluate((storyId) => {
      const channel = (window as unknown as PreviewWindow).__STORYBOOK_PREVIEW__
        ?.channel
      if (!channel) return false
      channel.emit('setCurrentStory', { storyId, viewMode: 'story' })
      return true
    }, id)
    .catch(() => false)
  if (!emitted) return false
  return page
    .waitForFunction(
      (storyId) =>
        (window as unknown as PreviewWindow).__STORYBOOK_PREVIEW__
          ?.currentRender?.id === storyId,
      id,
      { timeout: 15000 },
    )
    .then(
      () => true,
      () => false,
    )
}

async function loadStory(
  sp: StoryPage,
  baseUrl: string,
  id: string,
): Promise<void> {
  sp.loaded = false
  // Drop requests left unfinished (long-polling etc.)
  sp.pendingRequests.clear()
  await sp.page.goto(storyUrl(baseUrl, id), {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  })
  // Dialog-like stories render into a portal under body, leaving #storybook-root empty (= invisible),
  // so wait for attached instead of the default visible (visible would time out)
  await sp.page.waitForSelector('#storybook-root', {
    state: 'attached',
    timeout: 15000,
  })
  // Disable animations / transitions and shoot the final state
  // (so we don't catch a dialog mid-transition or a skeleton mid-pulse)
  await sp.page
    .addStyleTag({
      content:
        '*,*::before,*::after{transition:none!important;animation:none!important;scroll-behavior:auto!important;caret-color:transparent!important}',
    })
    .catch(() => {})
  sp.loaded = await sp.page
    .evaluate(
      () =>
        !!(window as unknown as PreviewWindow).__STORYBOOK_PREVIEW__?.channel,
    )
    .catch(() => false)
}

/** With reuse false, reload iframe.html so no state carries over from the previous story */
export async function renderStory(
  sp: StoryPage,
  baseUrl: string,
  id: string,
  reuse: boolean,
): Promise<void> {
  sp.renderStartedAt = Date.now()
  const switched = reuse && sp.loaded && (await switchStory(sp.page, id))
  if (!switched) await loadStory(sp, baseUrl, id)
  await waitForStory(sp, id)
}

/** Waits until the story has rendered. If it has a play function, also waits for that to finish */
async function waitForStory(sp: StoryPage, id: string): Promise<void> {
  const { page } = sp
  // With a play function, waiting on the DOM alone captures it mid-interaction,
  // so wait for every phase to finish via __STORYBOOK_PREVIEW__.currentRender.phase
  await page
    .waitForFunction(
      (storyId) => {
        const render = (window as unknown as PreviewWindow)
          .__STORYBOOK_PREVIEW__?.currentRender
        if (!render || render.id !== storyId) return false
        return ['completed', 'finished', 'errored'].includes(render.phase ?? '')
      },
      id,
      { timeout: 30000 },
    )
    .catch(() => {})
  // Regular stories render into #storybook-root, dialogs etc. into a portal under body, so check both
  await page
    .waitForFunction(
      () => {
        const root = document.querySelector('#storybook-root')
        return (
          (!!root && root.childElementCount > 0) ||
          document.body.childElementCount > 1
        )
      },
      { timeout: 8000 },
    )
    .catch(() => {})
  await waitForSettled(sp)
}

/** Waits so the shot shows the state after async data loading (MSW etc.). networkidle isn't used because it always waits 500ms of silence */
async function waitForSettled(sp: StoryPage): Promise<void> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sp.page
      .evaluate(waitForDomQuiet, {
        quietMs: SETTLE_QUIET_MS,
        quietFrames: SETTLE_QUIET_FRAMES,
        timeoutMs: deadline - Date.now(),
      })
      .catch(() => {})
    // Don't wait for requests that started before this render (left over from the previous story)
    const busy = [...sp.pendingRequests.values()].some(
      (startedAt) => startedAt >= sp.renderStartedAt,
    )
    if (!busy && Date.now() - sp.lastNetworkAt >= SETTLE_QUIET_MS) return
    await sp.page.waitForTimeout(SETTLE_POLL_MS)
  }
}

/** Under parallel load, frames of JS-driven animation can be far apart, so check frame count as well as time */
function waitForDomQuiet({
  quietMs,
  quietFrames,
  timeoutMs,
}: {
  quietMs: number
  quietFrames: number
  timeoutMs: number
}): Promise<void> {
  const state = (window as unknown as StorybookDiffWindow).__storybookDiff
  if (!state) return Promise.resolve()
  return new Promise((resolve) => {
    state.setTimeout(resolve, timeoutMs)
    let seen = state.lastMutation
    let frames = 0
    const tick = () => {
      if (state.lastMutation !== seen) {
        seen = state.lastMutation
        frames = 0
      } else {
        frames += 1
      }
      if (frames >= quietFrames && state.now() - seen >= quietMs) resolve()
      else state.requestAnimationFrame(tick)
    }
    state.requestAnimationFrame(tick)
  })
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message.split('\n')[0] : String(e)
}

/** Gets the story's DOM HTML (for step 1). On failure, returns html: null and the reason */
export async function captureHtml(
  sp: StoryPage,
  baseUrl: string,
  id: string,
  reuse: boolean,
): Promise<{ html: string | null; error?: string }> {
  try {
    await renderStory(sp, baseUrl, id, reuse)
    // Dialogs etc. render into a portal under body, so compare the whole body
    const html = await sp.page.evaluate((selector) => {
      const body = document.body.cloneNode(true) as HTMLElement
      for (const el of body.querySelectorAll(selector)) el.remove()
      return body.innerHTML
    }, IGNORED_ELEMENTS_SELECTOR)
    return { html }
  } catch (e) {
    return { html: null, error: errorMessage(e) }
  }
}

export type ShotResult = { ok: boolean; error?: string }

export async function screenshotTo(
  page: Page,
  outPath: string,
): Promise<ShotResult> {
  try {
    await page.screenshot({ path: outPath, fullPage: true })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: errorMessage(e) }
  }
}

export async function captureShot(
  sp: StoryPage,
  baseUrl: string,
  id: string,
  outPath: string,
): Promise<ShotResult> {
  try {
    await renderStory(sp, baseUrl, id, false)
  } catch (e) {
    return { ok: false, error: errorMessage(e) }
  }
  return screenshotTo(sp.page, outPath)
}

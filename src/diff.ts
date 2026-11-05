import { open } from 'node:fs/promises'
import type { Page } from '@playwright/test'

// More differing pixels than this means "changed" (a floor against rendering noise)
const DIFF_PIXEL_THRESHOLD = 40
/**
 * A pixel counts as different when any RGBA channel differs by more than this.
 * The gallery's diff highlight uses the same rule (buildGallery embeds the value)
 */
export const DIFF_CHANNEL_THRESHOLD = 24

// React useId (18: ":r1:", 19.1: "«r1»", 19.2: "_r_1_")
const REACT_USE_ID_RE =
  /:[rR][0-9a-zA-Z]+:|«[rR][0-9a-zA-Z]+»|_[rR]_[0-9a-zA-Z]+_/g

/** Normalizes HTML for comparison by removing noise (object URLs, React useId, etc.). Step 1's coarse filter */
export function normalizeHtml(html: string): string {
  return (
    html
      .replace(/blob:https?:\/\/[^"')\s]+/g, 'blob:URL')
      // With page reuse, generated ids keep counting from the previous story, so compare only their positions.
      // Generated ids only appear in attribute values (id / for / aria-* etc.), so real changes in text or <style> stay visible
      .replace(/="[^"]*"/g, (attr) => attr.replace(REACT_USE_ID_RE, 'ID'))
      .replace(/\s+/g, ' ')
      .trim()
  )
}

/** Reads width and height from the PNG IHDR chunk, without decoding the image */
export async function pngSize(
  path: string,
): Promise<{ width: number; height: number } | undefined> {
  let fh: Awaited<ReturnType<typeof open>> | undefined
  try {
    fh = await open(path, 'r')
    const buf = Buffer.alloc(24)
    await fh.read(buf, 0, 24, 0)
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  } catch {
    return undefined
  } finally {
    await fh?.close()
  }
}

/**
 * Compares the base and head screenshots pixel by pixel.
 * Judging by the rendered result rather than the DOM means differences that don't show,
 * such as generated ids or inline styles from measurement, aren't reported as changes.
 *
 * The comparison runs in the browser's canvas, so Node needs no image decoder.
 * `page` must be open on the same origin as the images (the server for the screenshots).
 * Drawing a cross-origin image taints the canvas, and getImageData then fails.
 */
export async function pixelDiff(
  page: Page,
  baseUrl: string,
  headUrl: string,
): Promise<{ changed: boolean; diff: number; dimMismatch: boolean }> {
  const result = await page.evaluate(
    async ([a, c, thr]) => {
      const load = (src: string) =>
        new Promise<HTMLImageElement>((res, rej) => {
          const im = new Image()
          im.onload = () => res(im)
          im.onerror = () => rej(new Error(`failed to load ${src}`))
          im.src = src
        })
      const [ia, ic] = await Promise.all([load(a), load(c)])
      const w = Math.min(ia.naturalWidth, ic.naturalWidth)
      const ht = Math.min(ia.naturalHeight, ic.naturalHeight)
      const dimMismatch =
        ia.naturalWidth !== ic.naturalWidth ||
        ia.naturalHeight !== ic.naturalHeight
      if (!w || !ht) return { diff: Number.MAX_SAFE_INTEGER, dimMismatch: true }
      const dataOf = (im: HTMLImageElement) => {
        const cv = document.createElement('canvas')
        cv.width = w
        cv.height = ht
        const cx = cv.getContext('2d') as CanvasRenderingContext2D
        cx.drawImage(im, 0, 0)
        return cx.getImageData(0, 0, w, ht).data
      }
      const A = dataOf(ia)
      const B = dataOf(ic)
      let diff = 0
      for (let i = 0; i < A.length; i += 4) {
        if (
          Math.abs(A[i] - B[i]) > thr ||
          Math.abs(A[i + 1] - B[i + 1]) > thr ||
          Math.abs(A[i + 2] - B[i + 2]) > thr ||
          Math.abs(A[i + 3] - B[i + 3]) > thr
        )
          diff += 1
      }
      return { diff, dimMismatch }
    },
    [baseUrl, headUrl, DIFF_CHANNEL_THRESHOLD] as const,
  )
  return {
    changed: result.dimMismatch || result.diff > DIFF_PIXEL_THRESHOLD,
    diff: result.diff,
    dimMismatch: result.dimMismatch,
  }
}

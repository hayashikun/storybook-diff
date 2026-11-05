/** Feeds items to `worker` with `concurrency` in parallel. worker receives (item, workerIndex, index) */
export async function mapPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, workerIndex: number, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0
  let done = 0
  const total = items.length
  const runners = Array.from({ length: Math.min(concurrency, total) }, (_, w) =>
    (async () => {
      while (cursor < total) {
        const index = cursor
        cursor += 1
        await worker(items[index], w, index)
        done += 1
        if (done % 25 === 0 || done === total) {
          process.stdout.write(`\r  ${done}/${total}            `)
        }
      }
    })(),
  )
  await Promise.all(runners)
  if (total > 0) process.stdout.write('\n')
}

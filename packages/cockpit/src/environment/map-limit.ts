/** `Promise.all(items.map(run))` with at most `limit` runs in flight; results keep the items' order. */
export async function mapLimit<Item, Result>(items: readonly Item[], limit: number, run: (item: Item) => Promise<Result>): Promise<Result[]> {
    const results = new Array<Result>(items.length)
    let next = 0
    const worker = async (): Promise<void> => {
        while (next < items.length) {
            const index = next++
            results[index] = await run(items[index]!)
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
    return results
}

/** Smallest half-open enclosing interval for each offset, in query order.
 * Equal widths choose the first input interval, matching the stable scan/sort. */
export function smallestEnclosing<T extends { startIndex: number; endIndex: number }>(
  definitions: readonly T[], offsets: readonly number[],
): Array<T | undefined> {
  const ordered = definitions.map((_, i) => i).sort((a, b) => definitions[a].startIndex - definitions[b].startIndex || a - b);
  const queries = offsets.map((_, i) => i).sort((a, b) => offsets[a] - offsets[b] || a - b);
  const heap: number[] = [];
  const before = (a: number, b: number): boolean => {
    const width = (definitions[a].endIndex - definitions[a].startIndex) - (definitions[b].endIndex - definitions[b].startIndex);
    return width < 0 || (width === 0 && a < b);
  };
  const push = (id: number): void => {
    let i = heap.length;
    heap.push(id);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!before(id, heap[parent])) break;
      heap[i] = heap[parent];
      i = parent;
    }
    heap[i] = id;
  };
  const pop = (): void => {
    const last = heap.pop()!;
    if (!heap.length) return;
    let i = 0;
    while (i * 2 + 1 < heap.length) {
      let child = i * 2 + 1;
      if (child + 1 < heap.length && before(heap[child + 1], heap[child])) child++;
      if (!before(heap[child], last)) break;
      heap[i] = heap[child];
      i = child;
    }
    heap[i] = last;
  };
  const result = new Array<T | undefined>(offsets.length);
  let next = 0;
  for (const query of queries) {
    const at = offsets[query];
    while (next < ordered.length && definitions[ordered[next]].startIndex <= at) push(ordered[next++]);
    while (heap.length && definitions[heap[0]].endIndex <= at) pop();
    result[query] = heap.length ? definitions[heap[0]] : undefined;
  }
  return result;
}

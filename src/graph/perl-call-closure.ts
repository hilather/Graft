/** Union symbol masks over caller closures. Recursive components are evaluated
 * together; returned masks share storage and must be treated as immutable. */
export function perlCallerClosures(edges: ReadonlyMap<string, readonly string[]>, local: ReadonlyMap<string, Uint32Array>, words: number): Map<string, Uint32Array> {
  const names = [...new Set([...edges.keys(), ...local.keys(), ...[...edges.values()].flat()])];
  const ids = new Map(names.map((name, index) => [name, index]));
  const outgoing = names.map(name => [...new Set(edges.get(name) ?? [])].map(next => ids.get(next)!));
  const reverse = names.map(() => [] as number[]);
  for (const [node, next] of outgoing.entries()) for (const target of next) reverse[target].push(node);

  // Iterative Kosaraju traversal avoids consuming the JS call stack on long
  // import/callback chains. Finish order is over the complete caller graph.
  const seen = new Uint8Array(names.length), finished: number[] = [];
  for (let seed = 0; seed < names.length; seed++) {
    if (seen[seed]) continue;
    seen[seed] = 1;
    const stack = [seed], positions = [0];
    while (stack.length) {
      const top = stack.length - 1, node = stack[top];
      if (positions[top] === outgoing[node].length) { finished.push(node); stack.pop(); positions.pop(); continue; }
      const next = outgoing[node][positions[top]++];
      if (!seen[next]) { seen[next] = 1; stack.push(next); positions.push(0); }
    }
  }
  const component = new Int32Array(names.length).fill(-1), masks: Uint32Array[] = [];
  for (const seed of finished.reverse()) {
    if (component[seed] !== -1) continue;
    const id = masks.length, mask = new Uint32Array(words), stack = [seed];
    masks.push(mask); component[seed] = id;
    while (stack.length) {
      const node = stack.pop()!, own = local.get(names[node]);
      if (own) for (let word = 0; word < words; word++) mask[word] |= own[word];
      for (const next of reverse[node]) if (component[next] === -1) { component[next] = id; stack.push(next); }
    }
  }
  const dependencies = masks.map(() => new Set<number>()), dependents = masks.map(() => [] as number[]);
  for (const [node, next] of outgoing.entries()) for (const target of next) if (component[node] !== component[target]) dependencies[component[node]].add(component[target]);
  const remaining = dependencies.map(next => next.size), pending: number[] = [];
  for (const [id, next] of dependencies.entries()) {
    if (!next.size) pending.push(id);
    for (const target of next) dependents[target].push(id);
  }
  while (pending.length) {
    const id = pending.pop()!;
    for (const dependent of dependents[id]) {
      for (let word = 0; word < words; word++) masks[dependent][word] |= masks[id][word];
      if (--remaining[dependent] === 0) pending.push(dependent);
    }
  }
  return new Map(names.map((name, index) => [name, masks[component[index]]]));
}

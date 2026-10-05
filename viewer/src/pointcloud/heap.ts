// 重みの大きい順に取り出す優先度付きキュー（点群の LOD 選択で使う）
export class MaxHeap<T> {
  private items: { item: T; weight: number }[] = [];
  get size() {
    return this.items.length;
  }
  push(item: T, weight: number) {
    const a = this.items;
    a.push({ item, weight });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].weight >= a[i].weight) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): { item: T; weight: number } | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].weight > a[m].weight) m = l;
        if (r < a.length && a[r].weight > a[m].weight) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

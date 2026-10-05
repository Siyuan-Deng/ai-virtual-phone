// API 配置、世界书、预设的显示顺序：
// - 顺序就是数组顺序（设置页里长按拖出来的），其它地方读出来的列表都跟着它
// - 置顶的永远排在最前，置顶的之间、没置顶的之间各自保持拖出来的顺序
// - 世界书和预设存在 IndexedDB 里，读回来是按 id 排的，所以保存时把位置写进 sortIndex

export type OrderedItem = { id: string; pinned?: boolean; sortIndex?: number };

function sortKey(item: OrderedItem): number {
    return typeof item.sortIndex === "number" && Number.isFinite(item.sortIndex) ? item.sortIndex : Number.MAX_SAFE_INTEGER;
}

/** 置顶的在前；各自按 sortIndex（没有的排后面，保持原来的先后） */
export function pinnedFirst<T extends OrderedItem>(items: T[]): T[] {
    return items
        .map((item, index) => ({ item, index }))
        .sort((a, b) => (
            Number(b.item.pinned === true) - Number(a.item.pinned === true)
            || sortKey(a.item) - sortKey(b.item)
            || a.index - b.index
        ))
        .map((entry) => entry.item);
}

/** 保存前把当前位置写进 sortIndex */
export function withSortIndex<T extends OrderedItem>(items: T[]): T[] {
    return items.map((item, index) => (item.sortIndex === index ? item : { ...item, sortIndex: index }));
}

/** 一组里的 id 换成新顺序：只在这组原来占的那几个位置里重排，别的元素不动 */
export function applyGroupOrder<T extends { id: string }>(items: T[], orderedIds: string[]): T[] {
    const group = new Set(orderedIds);
    const byId = new Map(items.map((item) => [item.id, item]));
    const queue = orderedIds.map((id) => byId.get(id)).filter((item): item is T => Boolean(item));
    let cursor = 0;
    return items.map((item) => (group.has(item.id) && cursor < queue.length ? queue[cursor++] : item));
}

/** 把 fromId 挪到 toId 的位置（往后拖落在它后面，往前拖落在它前面） */
export function moveId(ids: string[], fromId: string, toId: string): string[] {
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(toId);
    if (from < 0 || to < 0 || from === to) return ids;
    const next = [...ids];
    next.splice(from, 1);
    next.splice(to, 0, fromId);
    return next;
}


/** 存过的顺序 + 现在实际有的项：存过的按存的排；新冒出来的插在它默认位置后面那个已知项前面（没有就放最后） */
export function mergeOrder(saved: string[], current: string[]): string[] {
    const currentSet = new Set(current);
    const result = saved.filter((id, index) => currentSet.has(id) && saved.indexOf(id) === index);
    const placed = new Set(result);
    current.forEach((id, index) => {
        if (placed.has(id)) return;
        const anchor = current.slice(index + 1).find((next) => placed.has(next));
        result.splice(anchor ? result.indexOf(anchor) : result.length, 0, id);
        placed.add(id);
    });
    return result;
}

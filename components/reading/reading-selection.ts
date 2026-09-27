/** 选区端点在某个行元素内的文本偏移（相对该行起点）。 */
export function textOffsetWithin(lineEl: HTMLElement, container: Node, offset: number): number {
    let total = 0;
    const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
        if (node === container) return total + offset;
        total += (node.textContent || "").length;
        node = walker.nextNode();
    }
    return total;
}

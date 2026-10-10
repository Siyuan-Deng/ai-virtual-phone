// 给角色看的日历 ID。真 ID 都是「前缀_时间戳_随机串」，提示词里只写最后那段随机串（短，而且每轮都一样）；
// 角色回动作时短的、完整的都认。同一类里末段撞了的那几个照写完整 ID，保证认回来不会认错。

/** 末段随机串；不是这种格式的（旧数据、导入来的）就用整个 ID */
export function shortCalendarId(id: string): string {
    const tail = id.split(/[_-]/).pop() || "";
    return tail.length >= 5 && tail !== id ? tail : id;
}

/** 一批同类 ID 在提示词里各写成什么：末段只有它一个就写末段，撞了的写完整 ID */
export function calendarIdLabels(ids: Iterable<string>): Map<string, string> {
    const list = [...new Set(ids)];
    const counts = new Map<string, number>();
    for (const id of list) {
        const short = shortCalendarId(id);
        counts.set(short, (counts.get(short) ?? 0) + 1);
    }
    return new Map(list.map((id) => {
        const short = shortCalendarId(id);
        return [id, counts.get(short) === 1 ? short : id];
    }));
}

/** 角色给的 ID（短的或完整的）认回完整 ID；认不出、或者短 ID 对得上不止一个，返回 null */
export function resolveCalendarId(ref: unknown, ids: Iterable<string>): string | null {
    const target = String(ref ?? "").trim();
    if (!target) return null;
    const list = [...new Set(ids)];
    if (list.includes(target)) return target;
    const matches = list.filter((id) => shortCalendarId(id) === target);
    return matches.length === 1 ? matches[0] : null;
}

// 节假日：纯离线计算，逻辑逐行照搬「用户日历与备忘录增强」插件。
// 中国：法定节日当天（农历节日用 Intl 的中国历换算）；不含每年另行公布的
// 调休、补班安排。Ontario：九个法定公共假日的实际日期。

import { formatIsoDate, parseIsoDate } from "./calendar-utils";

export type CalendarHolidayRegion = "cn" | "on";

export type CalendarHoliday = {
    /** `${region}:${日期}:${名字}`，同一天同一个节日只出现一次 */
    id: string;
    region: CalendarHolidayRegion;
    date: string;
    name: string;
    /** 横幅上显示的整句，例如「中国 · 国庆节」 */
    title: string;
};

export const DEFAULT_CHINA_HOLIDAY_COLOR = "#ef6f86";
export const DEFAULT_ONTARIO_HOLIDAY_COLOR = "#5b8def";

function pad2(value: number): string {
    return String(value).padStart(2, "0");
}

function addDaysIso(dateText: string, days: number): string {
    const date = parseIsoDate(dateText);
    date.setDate(date.getDate() + days);
    return formatIsoDate(date);
}

/** 某月第 n 个星期几（weekday：0=周日） */
function nthWeekdayOfMonth(year: number, monthIndex: number, weekday: number, occurrence: number): string {
    const first = new Date(year, monthIndex, 1);
    const day = 1 + ((weekday - first.getDay() + 7) % 7) + (occurrence - 1) * 7;
    return formatIsoDate(new Date(year, monthIndex, day));
}

/** 复活节：Meeus/Jones/Butcher 公历算法，完全离线 */
function westernEasterIso(year: number): string {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return `${year}-${pad2(month)}-${pad2(day)}`;
}

function qingmingIso(year: number): string {
    const y = year % 100;
    const constant = year >= 2000 ? 4.81 : 5.59;
    const day = Math.floor(y * 0.2422 + constant) - Math.floor((y - 1) / 4);
    return `${year}-04-${pad2(day)}`;
}

let chineseCalendarFormatter: Intl.DateTimeFormat | null = null;

function chineseLunarMonthDay(date: Date): { month: number; day: number } | null {
    try {
        chineseCalendarFormatter ||= new Intl.DateTimeFormat("zh-CN-u-ca-chinese", { month: "numeric", day: "numeric" });
        const parts = chineseCalendarFormatter.formatToParts(date);
        const monthText = parts.find((part) => part.type === "month")?.value || "";
        const dayText = parts.find((part) => part.type === "day")?.value || "";
        if (!/^\d+$/.test(monthText) || !/^\d+$/.test(dayText)) return null;
        return { month: Number(monthText), day: Number(dayText) };
    } catch {
        return null;
    }
}

export function mainlandChinaHolidayNames(dateText: string): string[] {
    const date = parseIsoDate(dateText);
    if (Number.isNaN(date.getTime())) return [];
    const names: string[] = [];
    const month = date.getMonth() + 1;
    const day = date.getDate();
    if (month === 1 && day === 1) names.push("元旦");
    if (month === 5 && (day === 1 || day === 2)) names.push("劳动节");
    if (month === 10 && day >= 1 && day <= 3) names.push("国庆节");
    if (dateText === qingmingIso(date.getFullYear())) names.push("清明节");
    const lunar = chineseLunarMonthDay(date);
    const nextLunar = chineseLunarMonthDay(parseIsoDate(addDaysIso(dateText, 1)));
    if (nextLunar?.month === 1 && nextLunar.day === 1) names.push("除夕");
    if (lunar?.month === 1 && lunar.day >= 1 && lunar.day <= 3) names.push(lunar.day === 1 ? "春节" : `春节假期第${lunar.day}天`);
    if (lunar?.month === 5 && lunar.day === 5) names.push("端午节");
    if (lunar?.month === 8 && lunar.day === 15) names.push("中秋节");
    return names;
}

export function ontarioHolidayNames(dateText: string): string[] {
    const date = parseIsoDate(dateText);
    if (Number.isNaN(date.getTime())) return [];
    const year = date.getFullYear();
    const dates = new Map<string, string>([
        [`${year}-01-01`, "New Year's Day"],
        [nthWeekdayOfMonth(year, 1, 1, 3), "Family Day"],
        [addDaysIso(westernEasterIso(year), -2), "Good Friday"],
        [`${year}-07-01`, "Canada Day"],
        [nthWeekdayOfMonth(year, 8, 1, 1), "Labour Day"],
        [nthWeekdayOfMonth(year, 9, 1, 2), "Thanksgiving Day"],
        [`${year}-12-25`, "Christmas Day"],
        [`${year}-12-26`, "Boxing Day"],
    ]);
    // Victoria Day：5 月 25 日（含）之前的最后一个周一
    const may25 = new Date(year, 4, 25);
    const may25Day = may25.getDay();
    may25.setDate(may25.getDate() - (may25Day === 0 ? 6 : may25Day === 1 ? 7 : may25Day - 1));
    dates.set(formatIsoDate(may25), "Victoria Day");
    const name = dates.get(dateText);
    return name ? [name] : [];
}

export function holidaysForDate(
    dateText: string,
    options: { china: boolean; ontario: boolean },
): CalendarHoliday[] {
    if (!dateText) return [];
    const result: CalendarHoliday[] = [];
    if (options.china) {
        for (const name of mainlandChinaHolidayNames(dateText)) {
            result.push({ id: `cn:${dateText}:${name}`, region: "cn", date: dateText, name, title: `中国 · ${name}` });
        }
    }
    if (options.ontario) {
        for (const name of ontarioHolidayNames(dateText)) {
            result.push({ id: `on:${dateText}:${name}`, region: "on", date: dateText, name, title: `Ontario · ${name}` });
        }
    }
    return result;
}

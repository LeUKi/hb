// 用时 in the 名单弹窗: how long after the 红包 opened someone claimed or
// signed up (05 §7).

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * Under a minute: seconds to the millisecond, always three decimals
 * ("4.627秒"). Then two units: "1分15秒", "3小时05分", "2天3小时". Integer
 * maths, so 59.9995 s can never print as "60.000秒". Missing or negative: "—".
 */
export function sinceOpen(ms: number | null | undefined) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const total = Math.floor(ms);
  if (total < 60_000)
    return `${Math.floor(total / 1000)}.${String(total % 1000).padStart(3, "0")}秒`;
  const seconds = Math.floor(total / 1000);
  if (seconds < 3600)
    return `${Math.floor(seconds / 60)}分${pad(seconds % 60)}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1440)
    return `${Math.floor(minutes / 60)}小时${pad(minutes % 60)}分`;
  const hours = Math.floor(minutes / 60);
  return `${Math.floor(hours / 24)}天${hours % 24}小时`;
}

/**
 * How long ago, as people say it (参与名单's 挑战, 05 §7), and the one way
 * the site says it (sweep 2026-11-21, A4: five helpers disagreed, 90
 * minutes read 1 小时前 in one place and 2 小时前 in another): "刚刚" under
 * a minute, "3 分钟前", "2 小时前" in whole units rounded down, then the
 * date and time. With `days`, where a date would not fit or read well (the
 * 指令框's history, the 打赏卡's list, a sentence), a day on is "3 天前"
 * instead, counted by the calendar as clockLabel counts them, so it agrees
 * with the date; with `yesterday` too, the day before today is "昨天".
 */
export function agoLabel(
  at: number,
  now = Date.now(),
  {
    days = false,
    yesterday = false,
  }: { days?: boolean; yesterday?: boolean } = {},
) {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} 小时前`;
  if (!days) return clockLabel(at, now);
  const back = Math.max(1, -dayOffset(at, now));
  return yesterday && back === 1 ? "昨天" : `${back} 天前`;
}

/** Which day `at` falls on, from today's: 0 today, 1 tomorrow, -1 yesterday. */
function dayOffset(at: number, now: number) {
  const start = (value: number) => {
    const date = new Date(value);
    return new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
    ).getTime();
  };
  return Math.round((start(at) - start(now)) / 86_400_000);
}

/** "2026-10-14 17:58:04", shown on hover. */
export function fullTime(at: number) {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * A deadline as people say it: "18:47", "明天 20:00", "10月12日 18:00",
 * and with its year when that is not this one ("2027年10月27日 01:44": a
 * 红包 running for a year read as long past without it).
 */
export function clockLabel(at: number, now = Date.now()) {
  const date = new Date(at);
  const today = new Date(now);
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const days = dayOffset(at, now);
  if (days === 0) return clock;
  if (days === 1) return `明天 ${clock}`;
  if (days === -1) return `昨天 ${clock}`;
  const year =
    date.getFullYear() === today.getFullYear() ? "" : `${date.getFullYear()}年`;
  return `${year}${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
}

/**
 * When a timed draft opens (scheduled-opening §1): as clockLabel, but today
 * says so — “今天 20:00”, “明天 20:00”, “10月30日 20:00”.
 */
export function openingLabel(at: number, now = Date.now()) {
  const label = clockLabel(at, now);
  return /^\d\d:\d\d$/.test(label) ? `今天 ${label}` : label;
}

/** clockLabel with seconds: "23:15:02", "昨天 09:01:44", "10月1日 08:00:03". */
export function clockSeconds(at: number, now = Date.now()) {
  return `${clockLabel(at, now)}:${pad(new Date(at).getSeconds())}`;
}

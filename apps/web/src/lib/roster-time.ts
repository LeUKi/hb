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
 * How long ago, as people say it (参与名单's 挑战, 05 §7): "刚刚" under a
 * minute, "3 分钟前", "2 小时前", then the date and time.
 */
export function agoLabel(at: number, now = Date.now()) {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} 小时前`;
  return clockLabel(at, now);
}

/** "2026-10-14 17:58:04", shown on hover. */
export function fullTime(at: number) {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** A deadline as people say it: "18:47", "明天 20:00", "10月12日 18:00". */
export function clockLabel(at: number, now = Date.now()) {
  const date = new Date(at);
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const day = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((day(date) - day(new Date(now))) / 86_400_000);
  if (days === 0) return clock;
  if (days === 1) return `明天 ${clock}`;
  if (days === -1) return `昨天 ${clock}`;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
}

/** clockLabel with seconds: "23:15:02", "昨天 09:01:44", "10月1日 08:00:03". */
export function clockSeconds(at: number, now = Date.now()) {
  return `${clockLabel(at, now)}:${pad(new Date(at).getSeconds())}`;
}

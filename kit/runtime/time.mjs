// The date and time of a moment in some time zone (Asia/Shanghai unless told).

const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** weekday: 1 is Monday … 7 is Sunday. */
export function timeParts(ms, timeZone = "Asia/Shanghai") {
  let format;
  try {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
      hourCycle: "h23",
    });
  } catch {
    throw new RangeError(`time.parts 不认识这个时区：${timeZone}`);
  }
  const parts = {};
  for (const part of format.formatToParts(new Date(ms)))
    parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday],
  };
}

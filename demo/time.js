// Times on the demo pages, as HH:mm:ss.

const pad = (value) => String(value).padStart(2, "0");

/** The time of day on a 24-hour clock, e.g. 16:04:09. */
export function clock(date = new Date()) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** A length of time, e.g. 00:00:12, or 1d 02:03:04 from a day on. */
export function duration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(total / 86_400);
  const rest = total % 86_400;
  const time = `${pad(Math.floor(rest / 3600))}:${pad(Math.floor(rest / 60) % 60)}:${pad(rest % 60)}`;
  return days > 0 ? `${days}d ${time}` : time;
}

export function ago(timestamp, now = Date.now()) {
  return `${duration(now - timestamp)} ago`;
}

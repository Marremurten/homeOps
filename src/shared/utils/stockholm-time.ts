const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Stockholm",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const hourFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Stockholm",
  hour: "2-digit",
  hour12: false,
});

export function getStockholmDate(date?: Date): string {
  return dateFormatter.format(date ?? new Date());
}

export function isQuietHours(date?: Date): boolean {
  const d = date ?? new Date();
  const hourStr = hourFormatter.format(d);
  const hour = parseInt(hourStr, 10);
  return hour >= 22 || hour < 7;
}

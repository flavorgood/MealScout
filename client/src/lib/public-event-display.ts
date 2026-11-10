/** Public event dates are venue calendar days, not instants in the viewer's zone. */
export function getEventCalendarDateKey(value?: string | null): string | null {
  const dateKey = value?.match(/^(\d{4}-\d{2}-\d{2})(?:$|T)/)?.[1];
  if (!dateKey) return null;
  const anchor = new Date(`${dateKey}T00:00:00.000Z`);
  return Number.isFinite(anchor.getTime()) && anchor.toISOString().slice(0, 10) === dateKey
    ? dateKey
    : null;
}

export function formatEventCalendarDate(value?: string | null): string | null {
  const dateKey = getEventCalendarDateKey(value);
  if (!dateKey) return null;
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${dateKey}T00:00:00.000Z`));
}

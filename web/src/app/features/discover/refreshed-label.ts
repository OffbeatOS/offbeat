/** "Refreshed this morning", "Refreshed yesterday", "Refreshed 3 days ago" (Main mockup). */
export function refreshedLabel(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days <= 0) {
    if (now.getTime() - at.getTime() < 60 * 60 * 1000) return 'Refreshed just now';
    const hour = at.getHours();
    return `Refreshed this ${hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'}`;
  }
  if (days === 1) return 'Refreshed yesterday';
  return `Refreshed ${days} days ago`;
}

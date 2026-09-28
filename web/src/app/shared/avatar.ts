/** A user's avatar color: one of six muted tones, fixed by their id so it never changes. */
export function avatarColor(userId: number): string {
  return `var(--avatar-${(userId % 6) + 1})`;
}

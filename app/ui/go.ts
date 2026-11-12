/**
 * Leaving for another page. In one place, so that a test can watch where the
 * page goes: a test environment cannot really leave.
 */

/** Goes to another page. "Back" returns to this one. */
export function go(path: string): void {
  window.location.assign(path);
}

/** Goes to another page in place of this one. "Back" skips this one. */
export function goInstead(path: string): void {
  window.location.replace(path);
}

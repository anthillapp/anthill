/**
 * Whether onboarding is due, and remembering that it was finished.
 *
 * Seen-ness is a per-machine UI fact, so it lives in localStorage next to the
 * interpreter preference rather than in a settings system built for one flag.
 * The key is the one the welcome dialog and then the explainer used, so a
 * machine that has already met Anthill is not introduced to it a second time.
 */

const SEEN_KEY = "anthill.welcome-seen";

export function onboardingDue(): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY) === null;
  } catch {
    // Storage unavailable is not a reason to trap someone in onboarding
    // every launch.
    return false;
  }
}

export function markOnboardingSeen(): void {
  try {
    window.localStorage.setItem(SEEN_KEY, new Date().toISOString());
  } catch {
    // Nothing to do: the worst case is seeing it again.
  }
}

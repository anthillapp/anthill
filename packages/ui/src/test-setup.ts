// Registers the jest-dom matchers on vitest's `expect` and augments its types.
// Kept inside `src` so `tsc --noEmit` picks up the type augmentation too.
import "@testing-library/jest-dom/vitest";

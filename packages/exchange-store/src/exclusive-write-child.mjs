/**
 * One writer, in a process of its own, racing another for the same file name.
 *
 * `disk.test.ts` spawns two of these. The race it is about — a name that exists
 * before its content does — cannot be seen from inside one process: libuv runs
 * the filesystem work of a single process on a thread pool that happens to
 * queue the winner's write ahead of the loser's read, so every in-process test
 * of `createExclusive` passed while the invariant the store rests on did not
 * hold. Two processes share no such pool and no such ordering.
 *
 * JavaScript rather than TypeScript because this file is run, not built: Node
 * strips the types from the module it imports, so what races here is the source
 * the rest of the package uses rather than a copy of it in `dist/`.
 *
 * Arguments: the path to claim, the text to repeat, the instant both writers
 * should reach `createExclusive` at, and how many times to repeat the text.
 * What it says on stdout is one JSON object describing what it was told.
 */

import { createExclusive } from "./disk.ts";

const [path, tag, startAt, size] = process.argv.slice(2);
const text = tag.repeat(Number(size));

// A spin rather than a timer: the two processes have to arrive together, and a
// timer would hand the wait back to an event loop that has other ideas.
while (Date.now() < Number(startAt)) {
  /* wait for the agreed instant */
}

const result = await createExclusive(path, text);

console.log(
  JSON.stringify(
    result.outcome === "created"
      ? { tag, outcome: "created", wrote: text.length }
      : {
          tag,
          outcome: "existed",
          readBack: result.text.length,
          // Each writer repeats one character, so a read-back of the whole of
          // somebody's file is one character long as well as the right length.
          characters: new Set(result.text).size,
        },
  ),
);

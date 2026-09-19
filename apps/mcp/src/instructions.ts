/**
 * What the harness is told about this server, once, when it connects.
 *
 * `ServerOptions.instructions` is delivered at initialize and applies to the
 * whole server, which makes it the right place for the one thing the four tools
 * have in common: they are three steps of a single sequence, and a tool
 * description that explained the sequence would have to be repeated four times
 * and kept in step four times.
 *
 * What belongs here is what a caller cannot work out from a tool's signature:
 * that questions go to the user *before* a draft is submitted rather than after,
 * that polling never blocks and must not be looped on, and that the reporting
 * commands are the only channel Anthill has. What belongs in a tool description
 * is what that tool takes and returns.
 */

export const SERVER_INSTRUCTIONS = `Anthill is a workflow app running on this machine. These tools hand a workflow
you have designed to it, so the user can read it, edit it and approve it before
any work starts — and so the work you then do shows up on Anthill's Live Session
page while you do it.

Anthill starts nothing and drives nothing. You keep doing the work; it watches.

The sequence, once per handover:

1. create_workflow_draft — submit the workflow. Settle with the user anything
   the workflow does not yet answer BEFORE calling this: a draft is filed under
   the id the document carries, and a corrected workflow cannot be submitted
   under that id afterwards. If the result comes back "incomplete", its text is
   the list of questions to put to the user; their answers belong in the
   workflow, which is open in Anthill for them to edit.

2. get_ready_revision — ask whether there is a revision you may work from. Under
   approval-gate there is not one until the user has approved it, which takes as
   long as reading takes. This call answers immediately and never waits. Do not
   poll it in a loop and do not hold the user's turn open waiting for it: say
   what Anthill is waiting for, finish your turn, and ask again when they say
   they are done.

3. bind_run — call this once, at the moment work starts. It creates a run, ties
   it to the revision you are about to work from, and returns the shell commands
   that report progress. Run them: they are the only thing that tells Anthill
   which step you are on. Calling bind_run again creates a second run.

get_workflow answers where a handover stands, at any point.

The user may edit the workflow while you work. That makes a new revision; the run
you bound keeps the one it started from, so nothing changes underneath you.

None of these tools reads your files, runs a command, or reaches the network.`;

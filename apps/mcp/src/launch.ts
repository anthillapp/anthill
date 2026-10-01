/**
 * Bringing Anthill up, so that the thing this server just asked it to do has
 * something to happen in.
 *
 * Every handover already ends with a file left in the exchange and a link in
 * the result. Both assume an Anthill: the inbox is read by a running app on its
 * own schedule, and the link is read by a person who has to notice it. When the
 * app is closed — which is the ordinary case, because the harness is what the
 * user was looking at — a handover succeeds completely and nothing appears. The
 * user is told a workflow was stored and shown a URL, which is indistinguishable
 * from nothing having happened (ANT-123).
 *
 * So the same `anthill://workflow/<id>` link the result offers is handed to the
 * machine — addressed to Anthill by its bundle id, not to whatever the scheme
 * happens to point at. macOS answers it the way it answers a click: a closed
 * app is launched and the URL delivered once it is ready, a running one is
 * brought to the front and handed the URL directly.
 *
 * The bundle id is the fix for a link that went somewhere else (ANT-137). A dev
 * run of Anthill used to register the stock `Electron.app` for the scheme, and
 * that id is every dev Electron's; macOS then opened a stranger's Electron,
 * which showed its default window, while the installed Anthill never got the
 * link. `open -b` does not ask who owns the scheme, so nothing that happens to
 * that registration can send a handover astray. Anthill holds a single-instance lock
 * and queues links that arrive before the window exists, so neither the second
 * call nor the one that wins a cold-start race does anything twice.
 *
 * Three rules shape what is below.
 *
 * **Nothing here is allowed to fail a call.** The handover is already stored by
 * the time anything is opened, and a refusal at this point would report a write
 * that happened as a write that did not. Every outcome is reported as a fact
 * about the app, never as an error about the workflow.
 *
 * **Nothing here writes to stdout.** It is the MCP transport, and a child that
 * inherited it could corrupt the stream with a line of its own — which is why
 * the child's output is captured rather than inherited, and why what this
 * server has to say about a launch travels back in the tool result.
 *
 * **Nothing here goes through a shell.** The URL contains a workflow id that
 * came from a coding harness, and `open 'anthill://…'` assembled as a command
 * line is one quoting mistake away from running it. The opener is spawned
 * directly with the URL as its own argument, which has no such mistake in it.
 */

import { spawn } from "node:child_process";

/**
 * What became of the attempt.
 *
 * `opened` is deliberately narrow: it says macOS accepted the link, not that a
 * window is on screen. The app's own acknowledgement is a separate fact the
 * results already carry (`displayed`), and collapsing the two would let this
 * server claim a workflow was shown because a launcher exited zero.
 */
export type LaunchOutcome =
  /** The link was handed over; Anthill was launched or brought forward. */
  | "opened"
  /** Nothing on this machine claims `anthill://` links. */
  | "no_handler"
  /** The opener ran and refused, or never answered. */
  | "failed"
  /** No opener this server is willing to use on this platform. */
  | "unsupported"
  /** The user started this server with launching turned off. */
  | "disabled"
  /** The Anthill this chat reaches is already running, and picks the handover up itself. */
  | "running"
  /** The Anthill this chat reaches is not running, and nothing was started. */
  | "not_running"
  /** The Anthill this chat reaches was not running, and this handover started it. */
  | "started"
  /** An earlier handover started it moments ago, and it is still coming up. */
  | "starting";

export type LaunchReport = {
  outcome: LaunchOutcome;
  /** What to tell the user, on every outcome that is not `opened`. */
  message?: string;
  /**
   * Which Anthill the handover went to, named in every result so a chat on
   * the wrong build is seen at once (architecture doc, §5.6).
   */
  target?: { id: "app" | "electron-dev" | "web"; label: string };
  /**
   * The link that opens the workflow in the Anthill this handover reached,
   * where it is not `anthill://…`: the web shell's `http://…/workflow/<id>`
   * (ANT-231). The result's `url` is this when it is present.
   */
  link?: string;
};

/** Asks the machine to open one `anthill://` link. Injected, so tests do not open anything. */
export type Launcher = (url: string) => Promise<LaunchReport>;

/**
 * The opener, by absolute path.
 *
 * A harness spawns this server with whatever environment it pleases, and a
 * `PATH` without `/usr/bin` on it would turn a working machine into
 * "Anthill could not be opened". The path is also the reason nothing here
 * consults `PATH` for a program *called* `open`: on a machine where something
 * else is first, that is an arbitrary program being handed a URL.
 */
const OPENER = "/usr/bin/open";

/**
 * Anthill's bundle id — `appId` in apps/desktop/package.json, which a test
 * holds this to.
 *
 * The installed app, always: a dev build reads its own `desktop-dev` data, and
 * this server writes into the installed app's exchange. Someone running the
 * server against a dev data directory starts it with `--no-launch`.
 */
export const ANTHILL_BUNDLE_ID = "com.anthill.desktop";

/**
 * How long to wait for the opener before giving up on it.
 *
 * `open` returns as soon as LaunchServices has taken the request, not when the
 * app has finished starting, so this is generous by a wide margin — it is a
 * ceiling on a hang rather than a budget for a cold start. It matters because
 * the tool call is waiting behind it, and a handover that stored fine must not
 * sit unanswered because a launcher did.
 */
const OPEN_TIMEOUT_MS = 10_000;

/** How much of the opener's complaint to keep, so a result cannot be flooded. */
const MAX_STDERR = 400;

/**
 * How macOS says there is no Anthill to open.
 *
 * Matched on names rather than on the sentence around them, because the
 * sentence is localised and the names are not. `open -b` reports a bundle id
 * it cannot find through `LSCopyApplicationURLsForBundleIdentifier`;
 * `kLSApplicationNotFoundErr` and its number, `-10814`, are the same failure
 * as other macOS versions word it.
 */
const NO_HANDLER = /LSCopyApplicationURLsForBundleIdentifier|kLSApplicationNotFoundErr|-10814/;

/**
 * What to say when there is no Anthill to open.
 *
 * Actionable rather than descriptive: the user cannot do anything with
 * "LSCopyApplicationURLsForBundleIdentifier() failed", and the one thing that
 * fixes it — an installed Anthill, opened once so macOS knows where it is — is
 * a sentence long. The link is repeated because at this point it is the only
 * thing left that works, by hand.
 */
function noHandlerMessage(url: string): string {
  return (
    "Anthill could not be opened: it is not installed on this machine, or macOS has not seen it yet. " +
    "Install Anthill and open it once, so macOS knows where it is. " +
    `The handover is stored and waiting; ${url} will open it.`
  );
}

/**
 * Open one link in Anthill.
 *
 * @param platform Injected so the refusal on a platform this does not serve can
 *   be tested from any platform, including the one it does serve.
 * @param bundleId Injected so a test can ask for an app that does not exist and
 *   see macOS's real answer, without opening the Anthill on the machine running it.
 */
export function openUrl(
  url: string,
  platform: NodeJS.Platform = process.platform,
  bundleId: string = ANTHILL_BUNDLE_ID,
): Promise<LaunchReport> {
  // macOS only, because that is the only platform Anthill is packaged for: the
  // build produces a signed .dmg and nothing else, so on any other platform
  // there is no installed app to bring up and no scheme registered to bring it
  // up by. Reporting that plainly is better than trying three openers that
  // cannot succeed and calling the result a failure.
  if (platform !== "darwin") {
    return Promise.resolve({
      outcome: "unsupported",
      message: `Anthill is packaged for macOS, so nothing was opened on ${platform}. The handover is stored; ${url} opens it wherever Anthill is running.`,
    });
  }

  return new Promise<LaunchReport>((settle) => {
    let done = false;
    const finish = (report: LaunchReport): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      settle(report);
    };

    // The URL is one argument, and the child's stdout is discarded rather than
    // inherited: this process's stdout is the protocol.
    const child = spawn(OPENER, ["-b", bundleId, url], { stdio: ["ignore", "ignore", "pipe"] });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        outcome: "failed",
        message: `Anthill was asked to open but ${OPENER} did not answer within ${OPEN_TIMEOUT_MS / 1000} seconds. The handover is stored; ${url} opens it.`,
      });
    }, OPEN_TIMEOUT_MS);

    let complaint = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (complaint.length < MAX_STDERR) complaint += String(chunk);
    });

    // The opener is missing or not executable. Not a fault of the handover, and
    // not something the user can fix by submitting it again.
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({
        outcome: "failed",
        message: `Anthill could not be opened: ${OPENER} could not be run (${error.code ?? error.message}). The handover is stored; ${url} opens it.`,
      });
    });

    child.on("close", (code) => {
      if (code === 0) return finish({ outcome: "opened" });
      const said = complaint.slice(0, MAX_STDERR).trim();
      if (NO_HANDLER.test(said)) return finish({ outcome: "no_handler", message: noHandlerMessage(url) });
      finish({
        outcome: "failed",
        message: `Anthill could not be opened: ${OPENER} exited ${code ?? "on a signal"}${said ? ` – ${said}` : ""}. The handover is stored; ${url} opens it.`,
      });
    });
  });
}

/**
 * The launcher for a server started with launching turned off.
 *
 * It reports rather than staying silent, for the same reason every other
 * outcome does: the user is about to be told a workflow was handed over, and if
 * no window appears the only honest explanation is the one they configured.
 */
export function disabledLauncher(url: string): Promise<LaunchReport> {
  return Promise.resolve({
    outcome: "disabled",
    message: `Anthill was not opened: this server was started with --no-launch. The handover is stored; ${url} opens it.`,
  });
}

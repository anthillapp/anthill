/**
 * The only path from Anthill to PostHog. It deliberately has no API for event
 * properties: workflow content, prompts, paths and error messages cannot be
 * passed to the analytics service by a caller.
 */
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PostHog } from "posthog-node";

const PROJECT_TOKEN = "phc_xf9WH28eeLCaVd8FWnejVkWE8m44hFbwUoffsW3E27pw";
const HOST = "https://us.i.posthog.com";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type AnalyticsEvent =
  | "desktop_opened"
  | "analytics_enabled"
  | "workflow_opened"
  | "workflow_saved"
  | "live_observation_started";

type Client = Pick<PostHog, "captureImmediate" | "disable">;

export class DesktopAnalytics {
  private client?: Client;
  private distinctId?: string;
  private readonly identityPath: string;

  constructor(
    userData: string,
    private readonly available: boolean,
    private readonly makeClient: () => Client = () => new PostHog(PROJECT_TOKEN, {
      host: HOST,
      personProfiles: "never",
      disableGeoip: true,
      preloadFeatureFlags: false,
    }),
  ) {
    this.identityPath = join(userData, "analytics-id");
  }

  /** No client or identifier is created until a packaged macOS user opts in. */
  async enable(): Promise<void> {
    if (!this.available || this.client) return;
    const stored = await readFile(this.identityPath, "utf8").catch(() => "");
    const distinctId = UUID.test(stored.trim()) ? stored.trim() : randomUUID();
    if (!UUID.test(stored.trim())) {
      await writeFile(this.identityPath, distinctId, { encoding: "utf8", mode: 0o600 });
    }
    this.distinctId = distinctId;
    this.client = this.makeClient();
  }

  /** Stop future captures and discard the local identifier on opt-out. */
  async disable(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.distinctId = undefined;
    await client?.disable();
    await rm(this.identityPath, { force: true });
  }

  capture(event: AnalyticsEvent): void {
    if (!this.client || !this.distinctId) return;
    // Immediate sends avoid a queue that could flush after consent is revoked.
    // A request already in flight when someone opts out may finish.
    void this.client.captureImmediate({
      distinctId: this.distinctId,
      event,
      disableGeoip: true,
    }).catch(() => undefined);
  }
}

import { describe, expect, it } from "vitest";
import { EXTERNAL_LINKS, externalLink } from "./links.js";

describe("the pages Anthill links out to", () => {
  it("resolves only listed names, never an address or an inherited key", () => {
    expect(externalLink("community")).toBe("https://www.reddit.com/r/AnthillApp/");
    expect(externalLink("support")).toBe("https://buymeacoffee.com/anthill");
    for (const name of ["https://evil.example", "toString", "__proto__", "", 1, undefined]) {
      expect(externalLink(name)).toBeUndefined();
    }
    for (const url of Object.values(EXTERNAL_LINKS)) expect(url.startsWith("https://")).toBe(true);
  });
});

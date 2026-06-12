import { describe, expect, it } from "vitest";
import { sourceName } from "../../src/shared/chart-helpers.js";

describe("shared sourceName", () => {
  it("maps all supported local providers", () => {
    expect(sourceName("mimocode_local")).toBe("MiMoCode");
    expect(sourceName("opencode_local")).toBe("OpenCode");
    expect(sourceName("hermes_local")).toBe("Hermes");
    expect(sourceName("openclaw_local")).toBe("OpenClaw");
  });
});

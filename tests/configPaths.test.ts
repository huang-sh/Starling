import { describe, expect, it } from "vitest";
import { hasKnownConfigExtension } from "../src/lib/configPaths.js";

describe("config path helpers", () => {
  const extensions = [".json", ".jsonc", ".toml"];

  it("does not treat dotted profile names as file extensions", () => {
    expect(hasKnownConfigExtension("glm-5.2", extensions)).toBe(false);
  });

  it("recognizes supported config file extensions", () => {
    expect(hasKnownConfigExtension("glm-5.2.json", extensions)).toBe(true);
    expect(hasKnownConfigExtension("demo.toml", extensions)).toBe(true);
  });
});


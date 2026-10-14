import { describe, expect, test } from "bun:test";
import {
  colorFor,
  exactTokens,
  preciseUsd,
  shortTokens,
  shortUsd,
  usd,
} from "../../shared/format.js";

describe("formatting", () => {
  test("formats full and compact tokens without rounding compact values up", () => {
    expect(exactTokens(1_234_567)).toBe("1,234,567");
    expect(shortTokens(999_999)).toBe("999,999");
    expect(shortTokens(1_239_999)).toBe("1.23M");
    expect(shortTokens(2_999_999_999)).toBe("2.99B");
  });

  test("truncates summary USD but rounds normal table USD", () => {
    expect(shortUsd(1.239)).toBe("$1.23");
    expect(usd(1.239)).toBe("$1.24");
    expect(preciseUsd(1.234567891)).toBe("$1.234567891");
    expect(preciseUsd(0.000000001)).toBe("$0.000000001");
    expect(shortUsd(1.15)).toBe("$1.15");
    expect(shortUsd(1.9999999999999998)).toBe("$1.99");
    expect(shortUsd(Number.MAX_VALUE)).not.toContain("Infinity");
  });

  test("uses safe unavailable output and a stable full-identity color", () => {
    expect(shortTokens(Number.NaN)).toBe("—");
    expect(shortUsd(Number.POSITIVE_INFINITY)).toBe("—");
    expect(colorFor("claude", "sonnet")).toBe(colorFor("claude", "sonnet"));
    expect(colorFor("codex", "sonnet")).not.toBe(colorFor("claude", "sonnet"));
  });
});

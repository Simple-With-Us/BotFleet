import { describe, expect, it } from "vitest";

import { deepSeekPriceRows, formatPerMillionUsd } from "./deepseek-prices";

describe("DeepSeek published rates", () => {
  it("preserves sub-cent cache prices in readable ranges", () => {
    expect(formatPerMillionUsd(0.003)).toBe("$0.003");
    expect(formatPerMillionUsd(0.006)).toBe("$0.006");
    expect(formatPerMillionUsd(0.3)).toBe("$0.30");
    expect(formatPerMillionUsd(2)).toBe("$2");
  });

  it("labels off-peak–peak rates and the current Flash generation", () => {
    expect(deepSeekPriceRows().map((row) => [row.model, row.input, row.cache, row.output, row.badge])).toEqual([
      ["DeepSeek V4.1 Flash", "$0.15–$0.30", "$0.003–$0.006", "$0.60–$1.20", "Off-Peak–Peak"],
      ["DeepSeek V4 Pro", "$0.66–$1.32", "$0.022–$0.044", "$1.98–$3.96", "Off-Peak–Peak"],
    ]);
  });
});

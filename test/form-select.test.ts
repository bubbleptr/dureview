import { describe, expect, it } from "vitest";
import { listScrollTopForOption } from "../src/components/ui/form-select.js";

const list = { scrollTop: 200, clientHeight: 100 };

describe("combobox keyboard scroll", () => {
  it("scrolls up to an option above the viewport", () => {
    expect(listScrollTopForOption(list, { top: 40, height: 32 })).toBe(40);
  });

  it("scrolls down to an option below the viewport", () => {
    expect(listScrollTopForOption(list, { top: 400, height: 32 })).toBe(332);
  });

  it("leaves an option that is already fully visible", () => {
    expect(listScrollTopForOption(list, { top: 220, height: 32 })).toBe(200);
  });

  it("scrolls the smallest amount that reveals a clipped option", () => {
    expect(listScrollTopForOption(list, { top: 280, height: 32 })).toBe(212);
  });
});

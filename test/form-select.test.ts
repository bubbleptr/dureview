import { describe, expect, it } from "vitest";
import { activeIndexAfterPointerMove, listScrollTopForOption } from "../src/components/ui/form-select.js";

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

describe("combobox pointer hover", () => {
  const parked = { x: 10, y: 20 };

  it("keeps the keyboard highlight while the pointer stays put", () => {
    expect(activeIndexAfterPointerMove(4, parked, parked)).toEqual({ active: null, frozen: parked });
  });

  it("follows the pointer after it moves", () => {
    expect(activeIndexAfterPointerMove(4, { x: 11, y: 20 }, parked)).toEqual({ active: 4, frozen: null });
    expect(activeIndexAfterPointerMove(4, { x: 10, y: 21 }, parked)).toEqual({ active: 4, frozen: null });
  });

  it("follows the pointer when keyboard navigation has not frozen it", () => {
    expect(activeIndexAfterPointerMove(2, parked, null)).toEqual({ active: 2, frozen: null });
  });
});

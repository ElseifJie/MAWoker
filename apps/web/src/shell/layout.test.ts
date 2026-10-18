import { describe, expect, it } from "vitest";
import { solveShellLayout } from "./layout.js";

describe("shell layout solver", () => {
  it("uses the 280 / 45% / center-min geometry at desktop width", () => {
    expect(solveShellLayout({ viewportWidth: 1440 })).toEqual({
      leftWidth: 280,
      rightWidth: 648,
      centerWidth: 512,
      leftMode: "expanded",
      rightMode: "panel",
      mobile: false,
    });
  });

  it("keeps the right panel above 300 and below 70%", () => {
    expect(
      solveShellLayout({ viewportWidth: 1440, requestedRightWidth: 200 })
        .rightWidth,
    ).toBe(300);
    expect(
      solveShellLayout({ viewportWidth: 1440, requestedRightWidth: 900 }),
    ).toMatchObject({ rightWidth: 760, centerWidth: 400 });
  });

  it("clamps a resized left rail between 264 and 420", () => {
    expect(
      solveShellLayout({ viewportWidth: 1440, leftWidth: 999 }).leftWidth,
    ).toBe(420);
    expect(
      solveShellLayout({ viewportWidth: 1440, leftWidth: 100 }).leftWidth,
    ).toBe(264);
  });

  it("collapses the left rail at 1023 and expands it at 1024", () => {
    expect(
      solveShellLayout({ viewportWidth: 1023, requestedRightWidth: 460 }),
    ).toMatchObject({ leftWidth: 56, leftMode: "collapsed", centerWidth: 507 });
    expect(
      solveShellLayout({ viewportWidth: 1024, requestedRightWidth: 460 }),
    ).toMatchObject({ leftWidth: 280, leftMode: "expanded", centerWidth: 400 });
  });

  it("shrinks the right panel before breaking the 400px center", () => {
    expect(
      solveShellLayout({ viewportWidth: 800, requestedRightWidth: 360 }),
    ).toMatchObject({
      leftWidth: 56,
      rightWidth: 344,
      centerWidth: 400,
      leftMode: "collapsed",
      rightMode: "panel",
    });
  });

  it("turns the right panel into an overlay below 768", () => {
    expect(
      solveShellLayout({ viewportWidth: 767, requestedRightWidth: 767 }),
    ).toMatchObject({
      leftWidth: 56,
      rightWidth: 767,
      centerWidth: 711,
      rightMode: "overlay",
      mobile: true,
    });
  });

  it("returns the full center width when the right panel is closed", () => {
    expect(solveShellLayout({ viewportWidth: 1440, rightOpen: false })).toEqual(
      {
        leftWidth: 280,
        rightWidth: 0,
        centerWidth: 1160,
        leftMode: "expanded",
        rightMode: "closed",
        mobile: false,
      },
    );
  });
});

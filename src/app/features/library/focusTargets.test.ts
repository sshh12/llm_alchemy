import { afterEach, describe, expect, it, vi } from "vitest";
import { CUSTOM_SORT_LENS_ID, SORT_SELECT_ID, focusById } from "./focusTargets.ts";

/** A document whose element `id` appears after `mountAfter` animation frames. */
function fakeDom(mountAfter: number) {
  const focus = vi.fn();
  let frames = 0;
  const queue: FrameRequestCallback[] = [];
  vi.stubGlobal("document", { getElementById: (id: string) => (frames >= mountAfter ? { id, focus } : null) });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => queue.push(cb));
  const runFrames = () => {
    while (queue.length) {
      frames++;
      queue.splice(0).forEach((cb) => cb(frames * 16));
    }
  };
  return { focus, runFrames, framesRun: () => frames };
}

afterEach(() => vi.unstubAllGlobals());

describe("focusById", () => {
  it("focuses a control that is already on screen at once (the select after ×, the lens after Retry)", () => {
    const dom = fakeDom(0);
    focusById(SORT_SELECT_ID);
    expect(dom.focus).toHaveBeenCalledTimes(1);
    expect(dom.framesRun()).toBe(0);
  });

  it("waits a frame or two for one that mounts with the state change (the bar after the search bridge)", () => {
    const dom = fakeDom(2);
    focusById(CUSTOM_SORT_LENS_ID);
    expect(dom.focus).not.toHaveBeenCalled();
    dom.runFrames();
    expect(dom.focus).toHaveBeenCalledTimes(1);
    expect(dom.framesRun()).toBe(2);
  });

  it("gives up after a few frames instead of polling forever", () => {
    const dom = fakeDom(Infinity);
    focusById(CUSTOM_SORT_LENS_ID);
    dom.runFrames();
    expect(dom.focus).not.toHaveBeenCalled();
    expect(dom.framesRun()).toBe(3);
  });

  it("uses distinct ids", () => {
    expect(SORT_SELECT_ID).not.toBe(CUSTOM_SORT_LENS_ID);
  });
});

import { describe, expect, it } from "vitest";
import { updateContextVersionNotice } from "./use-context-version-notice.js";

const initial = { projectId: "project", latestRevision: 0, viewedRevision: 0 };
describe("new context version notice", () => {
  it("keeps a newly fetched version unread until it is actually displayed", () => {
    const received = updateContextVersionNotice(initial, "project", 2);
    expect(received.latestRevision > received.viewedRevision).toBe(true);
    const viewed = updateContextVersionNotice(received, "project", 2, true);
    expect(viewed.latestRevision > viewed.viewedRevision).toBe(false);
    const newer = updateContextVersionNotice(viewed, "project", 3);
    expect(newer.latestRevision > newer.viewedRevision).toBe(true);
  });
  it("viewing an older version does not acknowledge a newer version", () => {
    const notice = updateContextVersionNotice(
      { ...initial, latestRevision: 3 },
      "project",
      1,
      true,
    );
    expect(notice.viewedRevision).toBe(1);
    expect(notice.latestRevision).toBe(3);
    expect(updateContextVersionNotice(notice, "project", 2).latestRevision).toBe(3);
  });
  it("does not carry read state across projects or flag an empty history", () => {
    expect(updateContextVersionNotice(initial, "project", 0)).toEqual(initial);
    expect(
      updateContextVersionNotice({ ...initial, latestRevision: 9, viewedRevision: 9 }, "other", 1),
    ).toEqual({ projectId: "other", latestRevision: 1, viewedRevision: 0 });
  });
});

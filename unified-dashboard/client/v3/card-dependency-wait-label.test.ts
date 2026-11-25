import { describe, expect, it } from "vitest";
import { cardDependencyWaitLabel } from "./card-dependency-wait-label";
import type { CardRow } from "@seosoyoung/soul-ui/cards/card-types";

describe("cardDependencyWaitLabel", () => {
  const card = {
    status: "queued",
    dependsOn: [
      { id: "first", number: 12, status: "review", met: false },
      { id: "second", number: 15, status: "cancelled", met: false },
    ],
  } satisfies Pick<CardRow, "status" | "dependsOn">;

  const current = () => true;

  it("shows waiting numbers and marks cancellations", () => {
    expect(cardDependencyWaitLabel(card, {}, current)).toBe("#12, #15(취소됨) 완료 대기");
    expect(cardDependencyWaitLabel({ ...card, status: "running" }, {}, current)).toBeUndefined();
  });

  it("uses current dependency status without a change to the waiting card", () => {
    const done = { status: "done" } as const;
    expect(cardDependencyWaitLabel(card, { second: done }, current)).toBe("#12 완료 대기");
    expect(cardDependencyWaitLabel(card, { first: done, second: done }, current)).toBeUndefined();
  });

  it("uses the server projection while a cached dependency is stale", () => {
    const byId = { first: { status: "done" }, second: { status: "done" } } as const;
    expect(cardDependencyWaitLabel(card, byId, id => id === "second")).toBe("#12 완료 대기");
    expect(cardDependencyWaitLabel({
      ...card, dependsOn: [{ id: "first", number: 12, status: "done", met: true }],
    }, { first: { status: "review" } }, () => false)).toBeUndefined();
  });
});

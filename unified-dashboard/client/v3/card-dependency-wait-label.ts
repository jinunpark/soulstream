import type { CardRow } from "@seosoyoung/soul-ui/cards/card-types";

export function cardDependencyWaitLabel(
  card: Pick<CardRow, "status" | "dependsOn">,
  byId: Readonly<Record<string, Pick<CardRow, "status"> | undefined>>,
  isCardCurrent: (cardId: string) => boolean,
): string | undefined {
  if (card.status !== "queued") return undefined;
  const waiting = (card.dependsOn ?? []).flatMap(dependency => {
    const live = isCardCurrent(dependency.id) ? byId[dependency.id] : undefined;
    const met = live ? live.status === "done" : dependency.met;
    if (met) return [];
    const label = dependency.number === null ? dependency.id : `#${dependency.number}`;
    return [(live?.status ?? dependency.status) === "cancelled" ? `${label}(취소됨)` : label];
  });
  return waiting.length ? `${waiting.join(", ")} 완료 대기` : undefined;
}

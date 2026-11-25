import type { CardStatus } from "@soulstream/wire-schema";
import type { RepositorySql } from "./control_plane/card_types.js";

export const MAX_CARD_DEPENDENCIES = 20;

export type CardDependency = { id: string; number: number | null; status: CardStatus; met: boolean };

export type ProjectedCardDependency = CardDependency & { folder_id: string };

export function isCardDependencyMet(status: CardStatus): boolean {
  return status === "done";
}

export function unmetCardDependenciesSql(sql: RepositorySql, cardId: string | ReturnType<RepositorySql>) {
  return sql`EXISTS (
    SELECT 1 FROM card_dependencies link JOIN cards dep ON dep.id=link.depends_on_card_id
    WHERE link.card_id=${cardId} AND dep.status<>'done'
  )`;
}

export function serializeCardDependencies(dependencies: readonly ProjectedCardDependency[], allowedFolderIds: readonly string[] | null): CardDependency[] {
  return dependencies.flatMap(({ folder_id, ...dependency }) =>
    allowedFolderIds === null || allowedFolderIds.includes(folder_id) ? [dependency] : []);
}

export async function readCardDependencies(sql: RepositorySql, cardIds: readonly string[], allowedFolderIds: readonly string[] | null = null) {
  const byCard = new Map<string, ProjectedCardDependency[]>();
  if (!cardIds.length) return byCard;
  const rows = await sql<(Omit<ProjectedCardDependency, "met"> & { card_id: string })[]>`
    SELECT link.card_id,dep.id,dep.number,dep.status,dep.folder_id
    FROM card_dependencies link JOIN cards dep ON dep.id=link.depends_on_card_id
    WHERE link.card_id=ANY(${cardIds}::text[])
      AND (${allowedFolderIds}::text[] IS NULL OR dep.folder_id=ANY(${allowedFolderIds}::text[]))
    ORDER BY dep.number NULLS LAST,dep.id COLLATE "C"`;
  for (const { card_id, ...dependency } of rows) {
    const dependencies = byCard.get(card_id) ?? [];
    dependencies.push({ ...dependency, met: isCardDependencyMet(dependency.status) });
    byCard.set(card_id, dependencies);
  }
  return byCard;
}

export function invalidCardDependencies(message: string) {
  return Object.assign(new Error(message), { statusCode: 422, code: "INVALID_CARD_DEPENDENCIES" });
}

export function assertCardDependenciesEnabled(enabled: boolean, dependencies: readonly string[] | undefined) {
  if (!enabled && dependencies?.length)
    throw Object.assign(new Error("서버에서 카드 의존 관계를 사용할 수 없습니다."), {
      statusCode: 422, code: "CARD_DEPENDENCIES_DISABLED",
    });
}

export async function lockCardDependenciesTx(sql: RepositorySql) {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended('card_dependencies',0))`;
}

/** 의존 관계 잠금을 얻은 뒤 폴더나 대상 카드를 잠그기 전에 호출한다. */
export async function lockCardDependencyTargetsTx(sql: RepositorySql, cardId: string, dependencies: readonly string[]) {
  if (dependencies.length > MAX_CARD_DEPENDENCIES)
    throw invalidCardDependencies("의존 카드는 최대 20장까지 지정할 수 있습니다.");
  const ids = [...new Set(dependencies)];
  if (ids.includes(cardId)) throw invalidCardDependencies("카드는 자기 자신을 의존 카드로 지정할 수 없습니다.");
  if (!ids.length) return;
  const found = await sql<{ id: string }[]>`
    SELECT id FROM cards WHERE id=ANY(${ids}::text[]) ORDER BY id FOR KEY SHARE`;
  if (found.length !== ids.length) throw invalidCardDependencies("존재하지 않는 의존 카드가 있습니다.");
}

/** 의존 관계와 선행 카드 행을 먼저 잠근 트랜잭션에서 호출한다. */
export async function replaceCardDependenciesTx(sql: RepositorySql, cardId: string, ids: readonly string[]) {
  if (ids.length) {
    const [cycle] = await sql<{ found: boolean }[]>`
      WITH RECURSIVE reachable(id) AS (
        SELECT unnest(${ids}::text[])
        UNION
        SELECT link.depends_on_card_id FROM card_dependencies link JOIN reachable ON reachable.id=link.card_id
      )
      SELECT EXISTS(SELECT 1 FROM reachable WHERE id=${cardId}) AS found`;
    if (cycle?.found) throw invalidCardDependencies("카드 의존 관계에 순환이 생깁니다.");
  }
  await sql`DELETE FROM card_dependencies WHERE card_id=${cardId} AND NOT (depends_on_card_id=ANY(${ids}::text[]))`;
  if (ids.length)
    await sql`INSERT INTO card_dependencies(card_id, depends_on_card_id) SELECT ${cardId},unnest(${ids}::text[]) ON CONFLICT DO NOTHING`;
}

export async function assertMergeSourcesHaveNoDependenciesTx(sql: RepositorySql, sourceIds: readonly string[]) {
  const links = await sql`SELECT 1 FROM card_dependencies
    WHERE card_id=ANY(${sourceIds}::text[]) OR depends_on_card_id=ANY(${sourceIds}::text[]) LIMIT 1`;
  if (links.length)
    throw invalidCardDependencies("원 카드에 연결된 의존 관계가 있습니다. 먼저 depends_on에서 해당 연결을 지우세요.");
}

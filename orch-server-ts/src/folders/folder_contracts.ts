import type { CardMutationResult, FolderRow, FolderSnapshot } from "../cards/control_plane/card_types.js";
import { serializeCardDependencies, type ProjectedCardDependency } from "../cards/card_dependencies.js";
import { getCardItemDisplay, type CardItem } from "../cards/card_item_rules.js";

/** Row keys change at the boundary. Opaque JSON content is preserved. */
export function serializeCardRow(row: Record<string, unknown>): Record<string, unknown> {
  return serializeCardRowForFolders(row, null);
}

export function serializeCardRowForFolders(
  row: Record<string, unknown> & { depends_on?: ProjectedCardDependency[] },
  allowedFolderIds: readonly string[] | null,
): Record<string, unknown> {
  const { depends_on, ...fields } = row;
  const serialized=Object.fromEntries(Object.entries(fields).map(([key,value])=>[
    key.replace(/_([a-z])/g,(_match,letter:string)=>letter.toUpperCase()),value instanceof Date ? value.toISOString() : value,
  ]));
  if (depends_on !== undefined) serialized.dependsOn = serializeCardDependencies(depends_on, allowedFolderIds);
  if (Array.isArray(row.items)) {
    serialized.items=row.items.map(item=>({
      ...(item as Record<string,unknown>),
      display:getCardItemDisplay(item as CardItem),
    }));
  }
  return serialized;
}
export function serializeFolder(row:FolderRow) { return serializeCardRow(row); }
export interface FolderOutlinePageOptions {
  includeArchived: boolean;
  limit: number;
  offset: number;
}

export function serializeFolderSnapshot(snapshot:FolderSnapshot,cardId?:string,outline=false,outlinePage?:FolderOutlinePageOptions,
  allowedFolderIds: readonly string[] | null = null) {
  const folder = serializeFolder(snapshot.folder);
  if (!outline) {
    return { folder, cards:snapshot.cards.filter(c=>!cardId || c.id === cardId).map(card=>serializeCardRowForFolders(card,allowedFolderIds)) };
  }

  const matchingCards = snapshot.cards.filter(card => !cardId || card.id === cardId);
  if (cardId) {
    const cards = matchingCards.map(serializeFolderOutlineCard);
    return { folder, cards, view:"outline", includeArchived:true, totalCards:cards.length, returnedCount:cards.length, nextCursor:null };
  }

  const { includeArchived, limit, offset } = outlinePage!;
  const filteredCards = matchingCards.filter(card => includeArchived || !card.archived);
  const cards = filteredCards.slice(offset, offset + limit).map(serializeFolderOutlineCard);
  return {
    folder, cards, view:"outline", includeArchived, totalCards:filteredCards.length,
    returnedCount:cards.length, nextCursor:offset + limit < filteredCards.length ? String(offset + limit) : null,
  };
}

function serializeFolderOutlineCard(card: FolderSnapshot["cards"][number]) {
  const row = serializeCardRow(card);
  const activity = row.latestActivity;
  return {
    id:row.id,
    number:row.number,
    color:row.color,
    title:row.title,
    status:row.status,
    archived:row.archived,
    version:row.version,
    assigneeKind:row.assigneeKind,
    assigneeAgentId:row.assigneeAgentId,
    assigneeSessionId:row.assigneeSessionId,
    assigneeUserId:row.assigneeUserId,
    nodeId:row.nodeId,
    modelPreset:row.modelPreset,
    blockedKind:row.blockedKind,
    updatedAt:row.updatedAt,
    latestActivity:activity && typeof activity === "object"
      ? { kind:(activity as Record<string, unknown>).kind, createdAt:(activity as Record<string, unknown>).createdAt }
      : null,
  };
}
export function serializeCardMutation(result:CardMutationResult,allowedFolderIds:readonly string[] | null = null) {
  const operation=serializeCardRow(result.operation);
  if (result.operation.target_kind === "folder") return { folder:serializeFolder(result.snapshot.folder),operation,idempotent:result.idempotent ?? false };
  const card=result.snapshot.card;
  return { folderId:result.snapshot.folder.id,card:card ? serializeCardRowForFolders(card,allowedFolderIds) : null,operation,idempotent:result.idempotent ?? false };
}

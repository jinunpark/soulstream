import { randomUUID } from "node:crypto";
import { z } from "zod";
import { inlineUploadId } from "../attachments/upload_identity.js";
import type {
  CardCommentAttachmentUploadInput,
  CardCommentAttachmentUploadResult,
  FolderRouteOptions,
} from "../folders/folder_routes.js";
import { normalizeBoardAccess, type BoardAccess } from "../board/board_access.js";
import { filterFolders } from "../folders/folder_route_access.js";
import { serializeCardRow, serializeCardRowForFolders } from "../folders/folder_contracts.js";
import { describeFolderOperationError } from "../folders/folder_workspace_routes.js";
import { parseCardQuery } from "./completed_card_query.js";
import { CardOperationError, executeCardOperation, serializeCardDetail, type CardDetail, type CardOperation } from "./card_operations.js";
import type { CardControlPlaneService } from "./card_control_plane_service.js";
import { assertCardDependenciesEnabled, invalidCardDependencies, MAX_CARD_DEPENDENCIES } from "./card_dependencies.js";
import type { FolderActorParams } from "./control_plane/card_types.js";

export type CardRouteBodyOptions = Pick<FolderRouteOptions, "cardServiceProvider" | "provider">;
type ResolveAccess = () => BoardAccess | Promise<BoardAccess>;
type BoundCommentAttachmentUpload = (
  input: CardCommentAttachmentUploadInput,
) => Promise<CardCommentAttachmentUploadResult>;

export const inlineAttachmentSchema = z
  .object({
    name: z.string().min(1),
    mime: z.string(),
    data_base64: z.string().min(1),
  })
  .strict();

export const sendCardMessageSchema = z
  .object({
    sessionId: z.string().min(1).nullable().optional(),
    text: z.string().optional().default(""),
    idempotencyKey: z.string().min(1).optional(),
    attachments: z.array(inlineAttachmentSchema).max(10).optional(),
  })
  .strict();

export class CardNotFoundError extends Error {
  readonly statusCode = 404;
  readonly body = { detail: { error: { code: "CARD_NOT_FOUND" } } };
}

export async function listCardRouteBody(options: CardRouteBodyOptions, input: unknown, resolveAccess: ResolveAccess) {
  const service = await options.cardServiceProvider!();
  const query = parseCardQuery(input);
  const allowedFolderIds = await resolveCardFolderIds(options, resolveAccess);
  const serialize = (card: CardDetail["card"]) => serializeCardRowForFolders(card, allowedFolderIds);
  if (query.status === "done") {
    const page = await service.listCompletedCards({ ...query, allowedFolderIds });
    return { cards: page.cards.map(serialize), nextCursor: page.nextCursor };
  }
  if (query.paged) {
    const page = await service.listPagedCards({ folderId: query.folderId, status: query.statuses ? undefined : query.status, statuses: query.statuses,
      includeClosed: query.includeClosed, allowedFolderIds, q: query.q, limit: query.limit, after: query.pagedAfter });
    return { cards: page.cards.map(serialize), nextCursor: page.nextCursor };
  }
  const cards = await service.listCards({ ...query, allowedFolderIds });
  return { cards: (await service.projectCards(cards)).map(serialize) };
}

export async function readCardRouteBody(options: CardRouteBodyOptions, cardId: string, resolveAccess: ResolveAccess, reports = false) {
  const detail = await (await options.cardServiceProvider!()).getCard(cardId);
  if (!detail) throw new CardNotFoundError();
  const allowedFolderIds = await allowed(options, resolveAccess, detail.card.folder_id);
  return reports ? { reports: detail.reports.map(serializeCardRow) } : serializeCardDetail(detail, allowedFolderIds);
}

export async function mutateCardRouteBody(options: CardRouteBodyOptions, operation: CardOperation,
  cardId: string | undefined, input: unknown, resolveAccess: ResolveAccess,
  resolveActor: () => FolderActorParams | Promise<FolderActorParams>, questionId?: string, itemIdPath?: string | number,
  uploadCommentAttachment?: BoundCommentAttachmentUpload) {
  const service = await options.cardServiceProvider!();
  const body = z.record(z.string(), z.unknown()).parse(input);
  const detail = operation === "create_card" ? null : await service.getCard(cardId!);
  if (operation !== "create_card" && !detail) throw new CardNotFoundError();
  const allowedFolderIds = await allowed(options, resolveAccess, detail?.card.folder_id ?? z.string().min(1).parse(body.folderId));
  if (operation === "move_card") await allowed(options, resolveAccess, z.string().min(1).parse(body.folderId));
  // Laziness preserves the existing request's access checks before actor authentication.
  const actor = await resolveActor();
  if (operation === "start_card_work" && actor.actorKind !== "agent")
    throw Object.assign(new Error("Trusted assignee session required"), { statusCode: 403 });
  let operationBody = operation === "answer_card_question" || operation === "withdraw_card_question" ? { ...body, ...(questionId === undefined ? {} : { questionId }) }
    : operation === "confirm_card_item" ? { ...body, itemId: Number(itemIdPath) } : body;
  if (operation === "create_card" && body.dependsOn !== undefined) {
    const dependencies = await resolveCardDependencies(options, service, body.dependsOn, resolveAccess);
    operationBody = { ...body, dependsOn: dependencies };
  }
  if (operation === "add_card_comment" && detail !== null)
    operationBody = await commentOperationBody(operationBody, detail, cardId!, uploadCommentAttachment);
  const result = await executeCardOperation(service, operation, operationBody, cardId, actor, allowedFolderIds);
  return { status: operation === "create_card" || operation === "add_card_report" || operation === "add_card_comment" || operation === "ask_card_question" ? 201 : 200, body: result };
}

// 커멘트에 실린 인라인 첨부를 업로드해 본문 마크다운 링크로 합친다. 링크는 카드 첨부
// 파이프라인이 해석하는 legacy 파일 URL이므로 resolveCardLegacySourceRefsTx가
// attachment_refs를 남기고 projectCardAttachmentRows가 카드 내용 URL로 투영한다.
async function commentOperationBody(
  body: Record<string, unknown>,
  detail: CardDetail,
  cardId: string,
  upload: BoundCommentAttachmentUpload | undefined,
): Promise<Record<string, unknown>> {
  const { attachments: rawAttachments, ...rest } = body;
  const attachments = rawAttachments === undefined ? [] : z.array(inlineAttachmentSchema).max(10).parse(rawAttachments);
  const text = typeof rest.body === "string" ? rest.body.trim() : "";
  if (attachments.length === 0) {
    if (text === "") throw new CardOperationError("커멘트 내용을 입력하십시오.", 422);
    return rest;
  }
  if (upload === undefined) throw new CardOperationError("카드 커멘트 첨부 업로드가 구성되지 않았습니다.", 503);
  const firstSession = detail.sessions[0];
  const sessionId = detail.card.assignee_session_id
    ?? (typeof firstSession?.session_id === "string" ? firstSession.session_id : null);
  const nodeId = detail.card.node_id
    ?? (typeof firstSession?.node_id === "string" ? firstSession.node_id : null);
  const key = typeof rest.idempotencyKey === "string" && rest.idempotencyKey.trim() !== ""
    ? rest.idempotencyKey.trim() : randomUUID();
  const links: string[] = [];
  for (const [index, file] of attachments.entries()) {
    const uploadId = inlineUploadId(`${key}:comment:${index}:${file.name}`);
    const uploaded = await upload({ cardId, folderId: detail.card.folder_id, nodeId, sessionId, file, uploadId });
    const safeName = (uploaded.name || `attachment-${index + 1}`).replace(/[[\]\r\n]/g, "_");
    links.push(uploaded.mime.toLowerCase().startsWith("image/")
      ? `![${safeName}](${uploaded.url})`
      : `[${safeName}](${uploaded.url})`);
  }
  return { ...rest, body: [text, ...links].filter(Boolean).join("\n\n") };
}

export function cardRouteErrorResponse(error: unknown) {
  if (error instanceof CardNotFoundError) return { status: error.statusCode, body: error.body };
  const failure = describeFolderOperationError(error);
  return { status: failure.status, body: { detail: { error: { code: failure.code, message: failure.message } } } };
}

export async function resolveCardDependencies(options: CardRouteBodyOptions, service: CardControlPlaneService,
  input: unknown, resolveAccess: ResolveAccess): Promise<string[] | undefined> {
  if (input === undefined) return undefined;
  if (Array.isArray(input)) assertCardDependenciesEnabled(service.cardDependenciesEnabled, input);
  const parsed = z.array(z.string().trim().min(1)).max(MAX_CARD_DEPENDENCIES).safeParse(input);
  if (!parsed.success) throw invalidCardDependencies("의존 카드는 전체 ID 또는 카드 번호로 최대 20장까지 지정하세요.");
  if (!parsed.data.length) return [];

  const allowedFolderIds = await resolveCardFolderIds(options, resolveAccess);
  const allowFolder = (folderId: string) => allowedFolderIds === null || allowedFolderIds.includes(folderId);
  const refs = parsed.data.map(ref => /^[0-9]+$/.test(ref) ? `#${ref}` : ref);
  const numbers = [...new Set(refs.filter(ref => ref.startsWith("#")))];
  const ids = [...new Set(refs.filter(ref => !ref.startsWith("#")))];
  const [resolved, targets] = await Promise.all([
    numbers.length ? service.resolveReferences(numbers, allowFolder) : [],
    ids.length ? service.findCardDependencyTargets(ids) : [],
  ]);
  const allowedIds = new Set(targets.filter(target => allowFolder(target.folder_id)).map(target => target.id));
  const byNumber = new Map(resolved.map(result => [result.ref, result]));
  return [...new Set(refs.map(ref => {
    const match = byNumber.get(ref);
    if (match && "id" in match && match.kind === "card") return match.id;
    if (allowedIds.has(ref)) return ref;
    throw invalidCardDependencies(`의존 카드 ${ref}를 찾을 수 없거나 접근할 수 없습니다.`);
  }))];
}

export async function resolveCardFolderIds(options: CardRouteBodyOptions, resolveAccess: ResolveAccess) {
  const [access, folders] = await Promise.all([resolveAccess(), options.provider.listFolders()]);
  const normalized = normalizeBoardAccess(access);
  return normalized.restricted ? filterFolders(normalized, folders).map(folder => folder.id) : null;
}

export async function allowed(options: CardRouteBodyOptions, resolveAccess: ResolveAccess, folderId: string) {
  const allowedFolderIds = await resolveCardFolderIds(options, resolveAccess);
  if (allowedFolderIds !== null && !allowedFolderIds.includes(folderId))
    throw Object.assign(new Error("Folder access denied"), { statusCode: 403, code: "FOLDER_ACCESS_DENIED" });
  if (folderId === "claude" || folderId === "llm")
    throw Object.assign(new Error("System folders cannot own cards"), { statusCode: 403 });
  return allowedFolderIds;
}

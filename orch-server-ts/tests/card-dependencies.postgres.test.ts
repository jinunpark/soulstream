import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFolderContentSqlAdapter } from "../src/board/folder_content_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { CardDispatchRepository } from "../src/cards/card_dispatch_repository.js";
import { CardDispatcher, type CardLaunch } from "../src/cards/card_dispatcher.js";
import { CardExecutionService } from "../src/cards/card_execution_service.js";
import { applyCardMoveTx } from "../src/cards/control_plane/card_move.js";
import type { CardRow } from "../src/cards/control_plane/card_types.js";
import { registerFolderWorkspaceRoutes } from "../src/folders/folder_workspace_routes.js";
import { registerCardRoutes } from "../src/cards/card_routes.js";
import { cardHandlers } from "../src/mcp/card_handlers.js";
import { folderObjectHandlers } from "../src/mcp/folder_object_handlers.js";
import type { McpCallContext } from "../src/mcp/types.js";
import { appendCardEventTx, prepareCardWorkSchema, recordWorkReceipt } from "./card-work-postgres-fixture.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";

describe("card dependencies", () => {
  let h: PagePostgresHarness;
  let cards: CardControlPlaneService;
  let offCards: CardControlPlaneService;
  let dispatcher: CardDispatcher;
  let offDispatcher: CardDispatcher;
  let offRepo: CardDispatchRepository;
  let execution: CardExecutionService;
  const human = { actorKind: "user" as const, actorSessionId: null, actorUserId: "director@example.test" };
  const agent = { actorKind: "agent" as const, actorSessionId: "pas" };
  const context: McpCallContext = { principal: "internal", callerSessionId: agent.actorSessionId, nodeId: "node" };
  const provider = { listFolders: () => [{ id: "work" }, { id: "private" }], listSessionAssignments: () => ({}) };
  const unrestricted = () => ({ restricted: false });
  const restricted = () => ({ restricted: true, allowedFolderIds: ["work"] });
  const warn = vi.fn();
  const launch = vi.fn(async (input: Pick<CardLaunch, "sessionId" | "cardId" | "nodeId" | "agentId" | "modelPreset">) => {
    await h.sql`INSERT INTO sessions(session_id,card_id,node_id,agent_id,status,model_preset)
      VALUES(${input.sessionId},${input.cardId},${input.nodeId},${input.agentId},'running',${input.modelPreset})`;
  });

  function makeService(enabled: boolean, dispatcherForService: () => CardDispatcher, liveSql = h.liveSql) {
    return new CardControlPlaneService(createFolderContentSqlAdapter(liveSql), { appendEventTx: appendCardEventTx },
      undefined, change => dispatcherForService().acceptMutation(change), undefined, undefined, undefined, undefined,
      undefined, undefined, { defaultExecutionNodeId: "node", cardDependenciesEnabled: enabled });
  }
  function makeDispatcher(service: CardControlPlaneService, repository: CardDispatchRepository, enabled: boolean) {
    return new CardDispatcher({
      cards: async () => service, repository, cardDependenciesEnabled: enabled, defaultNodeId: "node",
      resolveTarget: () => ({ nodeId: "node", agentId: "worker", modelPreset: null, available: true, reason: null }),
      launch, warn, sendMessage: async () => {}, notify: async () => {}, deliveryExists: async () => false,
      abandonDelivery: async () => {},
    });
  }
  function mcp(service = cards, resolveAccess = unrestricted) {
    return { cards: { provider, resolveAccess, cardServiceProvider: async () => service, cardExecutionServiceProvider: async () => execution } };
  }
  function cardApp(service = cards) {
    const app = Fastify();
    const options = {
      nodeCredentials: null, environment: "test", provider, cardServiceProvider: async () => service,
      cardExecutionServiceProvider: async () => execution,
      accessProvider: { resolveAccess: restricted }, resolveDashboardUserId: () => human.actorUserId,
    };
    registerCardRoutes(app, options);
    registerFolderWorkspaceRoutes(app, options);
    return app;
  }
  async function postCard(dependsOn: string[], service = cards, idempotencyKey = randomUUID(), field = "dependsOn") {
    const app = cardApp(service);
    try {
      return await app.inject({ method: "POST", url: "/api/cards", payload: {
        folderId: "work", title: "작업", request: "", idempotencyKey, [field]: dependsOn,
      } });
    } finally {
      await app.close();
    }
  }
  async function create(fields: Partial<Parameters<CardControlPlaneService["createCard"]>[0]> = {}) {
    const result = await cards.createCard({
      ...human, folderId: "work", title: "작업", request: "", assignee: { kind: "agent", agentId: "worker" }, ...fields,
    });
    await dispatcher.drain();
    return result.snapshot.card!;
  }
  const update = (cardId: string, dependsOn: string[], service = cards) =>
    service.updateUnstartedCard({ ...agent, cardId, dependsOn, idempotencyKey: randomUUID() }, async () => {});

  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await prepareCardWorkSchema(h);
    await h.sql.unsafe(await readFile(new URL("../../packages/db-schema/sql/migrations/175_card_dependencies.sql", import.meta.url), "utf8"));
    await h.sql`INSERT INTO folders(id,name) VALUES('work','작업'),('private','비공개')`;
    await h.sql`CREATE TABLE system_settings(setting_key TEXT PRIMARY KEY,value JSONB NOT NULL,version INTEGER NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_by TEXT NOT NULL DEFAULT 'fixture')`;
    await h.sql`INSERT INTO system_settings(setting_key,value) VALUES ('card_dispatch','{"nodeConcurrency":{"default":2}}')`;
    await h.sql.unsafe(await readFile(new URL("../../packages/db-schema/sql/migrations/113_card_orchestration.sql", import.meta.url), "utf8"));
    const sql = createFolderContentSqlAdapter(h.liveSql);
    cards = makeService(true, () => dispatcher);
    offCards = makeService(false, () => offDispatcher);
    offRepo = new CardDispatchRepository(async () => sql);
    dispatcher = makeDispatcher(cards, new CardDispatchRepository(async () => sql, true), true);
    offDispatcher = makeDispatcher(offCards, offRepo, false);
    execution = new CardExecutionService({
      sql, cards,
      validate: async () => ({ nodeId: "node", agentId: "worker", modelPreset: null }),
      launch: async input => {
        await launch({ sessionId: input.sessionId, cardId: input.cardId, ...input.target });
        await recordWorkReceipt(h, input.sessionId, "running", { registrationId: "registration", executionCommandId: "command" });
      },
      ensure: async () => { throw new Error("expected a new session"); },
    });
  }, 60_000);

  beforeEach(async () => {
    await h.sql`DELETE FROM folder_operations`;
    await h.sql`DELETE FROM cards`;
    await h.sql`DELETE FROM sessions`;
    await h.sql`INSERT INTO sessions(session_id,status,node_id,agent_id) VALUES('pas','idle','node','worker')`;
    warn.mockClear();
    launch.mockClear();
  });

  afterAll(async () => {
    await dispatcher?.drain();
    await offDispatcher?.drain();
    await h?.cleanup();
  });

  it("resolves numbers and IDs on HTTP/MCP create, then replaces and clears links on MCP update", async () => {
    const first = await create();
    const second = await create();
    const response = await postCard([`#${first.number}`, String(first.number), first.id, second.id]);
    expect(response.statusCode).toBe(201);
    const { card, operation } = response.json();
    expect(operation.payloadJson.depends_on).toEqual([first.id, second.id]);
    expect(card.dependsOn).toEqual([first, second].map(dep => ({ id: dep.id, number: dep.number, status: "todo", met: false })));

    const created = await cardHandlers.create_card(mcp(), {
      folder_id: "work", title: "MCP 카드", request: "", depends_on: [String(first.number)],
    }, context);
    expect(created.isError).toBeUndefined();
    const createdId = (created.structuredContent?.card as { id: string }).id;
    expect(await cards.getCard(createdId)).toMatchObject({ card: { depends_on: [{ id: first.id }] } });

    const replace = await cardHandlers.update_unstarted_card(mcp(), {
      card_id: `#${card.number}`, depends_on: [`#${second.number}`], idempotency_key: "replace",
    }, context);
    expect(replace.structuredContent).toMatchObject({ changed_fields: ["depends_on"], card: { version: card.version + 1 } });
    expect(await h.sql`SELECT depends_on_card_id FROM card_dependencies WHERE card_id=${card.id}`)
      .toEqual([{ depends_on_card_id: second.id }]);
    const clear = await update(card.id, []);
    expect(clear.card.version).toBe(card.version + 2);
    expect(await cards.getCard(card.id)).toMatchObject({ card: { depends_on: [] } });
  });

  it("replays a create by ID after a number reference and rejects a changed list", async () => {
    const first = await create();
    const second = await create();
    const key = randomUUID();
    const initial = await postCard([`#${first.number}`], cards, key);
    const replay = await postCard([first.id], cards, key);
    expect(initial.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    const cardId = initial.json().card.id;
    expect(replay.json()).toMatchObject({ idempotent: true, card: { id: cardId } });
    expect(await h.sql`SELECT depends_on_card_id FROM card_dependencies WHERE card_id=${cardId}`)
      .toEqual([{ depends_on_card_id: first.id }]);
    const conflict = await postCard([second.id], cards, key);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().detail.error.code).toBe("FOLDER_IDEMPOTENCY_CONFLICT");
    expect((await postCard([first.id], cards, randomUUID(), "depends_on")).statusCode).toBe(422);
  });

  it("replays updates and preserves the creation time of retained links", async () => {
    const first = await create();
    const second = await create();
    const third = await create();
    const card = await create({ dependsOn: [first.id, second.id] });
    await h.sql`UPDATE card_dependencies SET created_at='2020-01-01T00:00:00Z'
      WHERE card_id=${card.id} AND depends_on_card_id=${first.id}`;
    const key = randomUUID();
    const apply = (reference: string) => cardHandlers.update_unstarted_card(mcp(), {
      card_id: card.id, depends_on: [reference, third.id], idempotency_key: key,
    }, context);
    const initial = await apply(`#${first.number}`);
    const replay = await apply(first.id);
    expect(initial.structuredContent).toMatchObject({ idempotent: false, card: { version: card.version + 1 } });
    expect(replay.structuredContent).toMatchObject({ idempotent: true, card: { version: card.version + 1 } });
    expect(await h.sql`SELECT depends_on_card_id,created_at FROM card_dependencies WHERE card_id=${card.id}`)
      .toEqual(expect.arrayContaining([
        { depends_on_card_id: first.id, created_at: new Date("2020-01-01T00:00:00Z") },
        { depends_on_card_id: third.id, created_at: expect.any(Date) },
      ]));
    expect(await h.sql`SELECT 1 FROM card_dependencies WHERE card_id=${card.id} AND depends_on_card_id=${second.id}`).toHaveLength(0);
  });

  it("rejects self-links, transitive cycles, unknown cards and inaccessible folders", async () => {
    const first = await create();
    const second = await create({ dependsOn: [first.id] });
    const third = await create({ dependsOn: [second.id] });
    await expect(update(first.id, [first.id])).rejects.toThrow(/자기 자신/);
    await expect(update(first.id, [third.id])).rejects.toThrow(/순환/);
    await expect(update(first.id, ["missing-card"])).rejects.toMatchObject({ statusCode: 422, code: "INVALID_CARD_DEPENDENCIES" });
    expect((await postCard(["#999999999"])).statusCode).toBe(422);
    const hidden = await create({ folderId: "private" });
    for (const reference of [hidden.id, `#${hidden.number}`]) {
      const response = await postCard([reference]);
      expect(response.statusCode).toBe(422);
      expect(response.json().detail.error.code).toBe("INVALID_CARD_DEPENDENCIES");
    }
    expect(await cards.getCard(first.id)).toMatchObject({ card: { version: first.version, depends_on: [] } });
  });

  it("serializes concurrent reciprocal links", async () => {
    const first = await create();
    const second = await create();
    const peer = makeService(true, () => dispatcher, h.peerLiveSql);
    const outcomes = await Promise.allSettled([update(first.id, [second.id]), update(second.id, [first.id], peer)]);
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find(result => result.status === "rejected")).toMatchObject({
      reason: { statusCode: 422, code: "INVALID_CARD_DEPENDENCIES", message: expect.stringMatching(/순환/) },
    });
  });

  it("lets a prerequisite move finish while a create waits for its row lock", async () => {
    const prerequisite = await create({ folderId: "private" });
    const peer = makeService(true, () => dispatcher, h.peerLiveSql);
    const moveSql = createFolderContentSqlAdapter(h.liveSql);
    let pending: Promise<PromiseSettledResult<Awaited<ReturnType<typeof peer.createCard>>>> | undefined;
    try {
      await moveSql.begin(async tx => {
        const [card] = await tx<CardRow[]>`SELECT * FROM cards WHERE id=${prerequisite.id} FOR UPDATE`;
        const [move] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        pending = peer.createCard({ ...human, folderId: "work", title: "대기", request: "", dependsOn: [card!.id] })
          .then(value => ({ status: "fulfilled", value }), reason => ({ status: "rejected", reason }));
        await vi.waitFor(async () => {
          const [row] = await h.concurrentSql`SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity WHERE ${move!.pid}::int=ANY(pg_blocking_pids(pid))
          ) AS waiting`;
          expect(row?.waiting).toBe(true);
        }, { timeout: 2000 });
        await applyCardMoveTx(tx, card!, "work", null, human, null);
      });
    } finally {
      await pending;
      await dispatcher.drain();
    }
    expect(await pending).toMatchObject({ status: "fulfilled", value: { snapshot: { card: {
      depends_on: [{ id: prerequisite.id, folder_id: "work" }],
    } } } });
    expect((await cards.getCard(prerequisite.id))?.card.folder_id).toBe("work");
  });

  it.each(["target-to-source", "other-to-source", "source-to-other"] as const)("rejects merge with a %s link", async direction => {
    const source = await create();
    const other = await create();
    const target = await create({ dependsOn: direction === "target-to-source" ? [source.id] : [] });
    if (direction === "other-to-source") await update(other.id, [source.id]);
    if (direction === "source-to-other") await update(source.id, [other.id]);
    const merge = { ...agent, targetCardId: target.id, sourceCardIds: [source.id], idempotencyKey: randomUUID() };
    await expect(cards.mergeCards(merge, async () => {})).rejects.toMatchObject({
      statusCode: 422, code: "INVALID_CARD_DEPENDENCIES", message: expect.stringMatching(/depends_on/),
    });
    expect((await cards.getCard(source.id))?.card.status).toBe("todo");
    if (direction === "target-to-source") {
      await offCards.mergeCards(merge, async () => {});
      expect((await cards.getCard(source.id))?.card.status).toBe("cancelled");
    }
  });

  it("keeps the queue position, starts the next card, and wakes on completion", async () => {
    const prerequisite = await create();
    const waiting = await create({ queue: true, dependsOn: [prerequisite.id] });
    const ready = await create({ queue: true });
    expect(warn.mock.calls).toEqual([]);
    expect(launch.mock.calls.map(([input]) => input.cardId)).toEqual([ready.id]);
    expect(await cards.getCard(waiting.id)).toMatchObject({ card: { status: "queued", queue_position_key: waiting.queue_position_key } });
    const before = await cards.mcpRead.getCard(waiting.id, {}, null);
    expect(before.card).toMatchObject({ dependsOn: [{ id: prerequisite.id, status: "todo", met: false }] });

    await cards.setCardStatus({ ...human, cardId: prerequisite.id, status: "done" });
    await dispatcher.drain();
    expect(launch.mock.calls.map(([input]) => input.cardId)).toEqual([ready.id, waiting.id]);
    expect(await cards.mcpRead.getCard(waiting.id, { since: before.changeToken }, null)).toMatchObject({
      changed: expect.arrayContaining(["card"]),
      card: { dependsOn: [{ id: prerequisite.id, status: "done", met: true }] },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps cancelled and review unmet and treats archived done cards as met", async () => {
    const prerequisite = await create();
    const waiting = await create({ queue: true, dependsOn: [prerequisite.id] });
    let token = (await cards.mcpRead.getCard(waiting.id, {}, null)).changeToken;
    for (const status of ["cancelled", "review"] as const) {
      await h.sql`UPDATE cards SET status=${status} WHERE id=${prerequisite.id}`;
      await dispatcher.dispatch();
      const current = await cards.mcpRead.getCard(waiting.id, { since: token }, null);
      expect(current).toMatchObject({ changed: ["card"], card: {
        version: waiting.version, dependsOn: [{ id: prerequisite.id, status, met: false }],
      } });
      token = current.changeToken;
    }
    expect(launch).not.toHaveBeenCalled();
    await h.sql`UPDATE cards SET status='done',archived=TRUE WHERE id=${prerequisite.id}`;
    const list = await cards.mcpRead.listCards({}, null);
    expect(list.cards.find(card => card.id === waiting.id)?.dependsOn).toEqual([
      { id: prerequisite.id, number: prerequisite.number, status: "done", met: true },
    ]);
    await dispatcher.dispatch();
    expect(launch.mock.calls.map(([input]) => input.cardId)).toEqual([waiting.id]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("filters inaccessible prerequisites from HTTP and MCP responses and MCP change tokens", async () => {
    const visible = await create();
    const hidden = await create({ folderId: "private" });
    const card = await create({ dependsOn: [visible.id, hidden.id] });
    const waiting = await create({ queue: true, dependsOn: [hidden.id] });
    expect(launch).not.toHaveBeenCalled();
    const done = await create({ dependsOn: [visible.id, hidden.id] });
    await cards.setCardStatus({ ...human, cardId: done.id, status: "done" });
    await dispatcher.drain();
    const expected = [{ id: visible.id, number: visible.number, status: "todo", met: false }];
    const app = cardApp();
    const read = async (url: string, id?: string) => {
      const result = await app.inject({ url });
      expect(result.statusCode).toBe(200);
      const body = result.json();
      return id === undefined ? body.card : body.cards.find((row: { id: string }) => row.id === id);
    };
    try {
      for (const url of ["/api/cards", "/api/cards?limit=10", "/api/folders/work"])
        expect((await read(url, card.id)).dependsOn).toEqual(expected);
      expect((await read("/api/cards?status=done", done.id)).dependsOn).toEqual(expected);
      expect((await read(`/api/cards/${card.id}`)).dependsOn).toEqual(expected);
      expect(await read(`/api/cards/${waiting.id}`)).toMatchObject({ status: "queued", dependsOn: [] });
      const patch = await app.inject({ method: "PATCH", url: `/api/cards/${card.id}`, payload: {
        title: "수정", expectedVersion: card.version, idempotencyKey: randomUUID(),
      } });
      expect(patch.statusCode).toBe(200);
      expect(patch.json().card.dependsOn).toEqual(expected);
      const settings = await app.inject({ method: "POST", url: `/api/cards/${card.id}/execution-settings`, payload: {
        folderId: "work", nodeId: "node", agentId: "worker", modelPreset: null,
        expectedVersion: patch.json().card.version, idempotencyKey: randomUUID(),
      } });
      expect(settings.statusCode).toBe(200);
      expect(settings.json().card.dependsOn).toEqual(expected);
      const run = await app.inject({ method: "POST", url: `/api/cards/${card.id}/execute`, payload: {
        expectedVersion: settings.json().card.version, idempotencyKey: randomUUID(),
      } });
      expect(run.statusCode).toBe(200);
      expect(run.json().card.dependsOn).toEqual(expected);
      const query = new URLSearchParams({ requestId: run.json().execution.requestId });
      expect((await read(`/api/cards/${card.id}/execution?${query}`)).dependsOn).toEqual(expected);
    } finally {
      await app.close();
      await dispatcher.drain();
    }

    const tools = mcp(cards, restricted);
    const snapshot = await folderObjectHandlers.get_folder({
      ...tools, folders: {
        serviceProvider: vi.fn(), cardServiceProvider: async () => cards, authBearerToken: "", nodeCredentials: null,
      },
    }, { folder_id: "work" });
    expect(snapshot.structuredContent?.cards).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: card.id, dependsOn: expected }),
    ]));
    const list = await cardHandlers.list_cards(tools, { folder_id: "work", status: "done" });
    expect(list.structuredContent?.cards).toEqual([expect.objectContaining({ id: done.id, dependsOn: expected })]);
    const queue = await cardHandlers.list_cards(tools, { status: "queued" });
    expect(queue.structuredContent?.cards).toEqual([expect.objectContaining({ id: waiting.id })]);
    expect((queue.structuredContent?.cards as Record<string, unknown>[])[0]).not.toHaveProperty("dependsOn");
    const before = await cardHandlers.get_card(tools, { card_id: done.id });
    expect((before.structuredContent?.card as { dependsOn: unknown }).dependsOn).toEqual(expected);
    await cards.setCardStatus({ ...human, cardId: hidden.id, status: "done" });
    await dispatcher.drain();
    expect(launch.mock.calls.map(([input]) => input.cardId)).toEqual([card.id, waiting.id]);
    const after = await cardHandlers.get_card(tools, { card_id: done.id, since: before.structuredContent?.changeToken });
    expect(after.structuredContent).toMatchObject({ unchanged: true });
    expect((await cards.mcpRead.getCard(done.id, {}, null)).card).toMatchObject({ dependsOn: [
      ...expected, { id: hidden.id, status: "done", met: true },
    ] });
  });

  it("lets run_card start a queued card with unmet dependencies", async () => {
    const prerequisite = await create();
    const waiting = await create({ queue: true, dependsOn: [prerequisite.id] });
    expect(launch).not.toHaveBeenCalled();
    const result = await cardHandlers.run_card(mcp(), { card_id: waiting.id }, context);
    expect(result.structuredContent).toMatchObject({ card: { id: waiting.id, status: "running" }, execution: { state: "started" } });
    expect(launch).toHaveBeenCalledTimes(1);
    await dispatcher.drain();
  });

  it("ignores existing links and completion triggers while off and rejects nonempty inputs", async () => {
    const prerequisite = await create();
    const waiting = await create({ queue: true, dependsOn: [prerequisite.id] });
    expect(launch).not.toHaveBeenCalled();
    const rejected = await postCard(["#999999999"], offCards);
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().detail.error.code).toBe("CARD_DEPENDENCIES_DISABLED");
    const tools = mcp(offCards);
    for (const result of [
      await cardHandlers.create_card(tools, { folder_id: "work", title: "작업", request: "", depends_on: ["#999999999"] }, context),
      await cardHandlers.update_unstarted_card(tools, { card_id: waiting.id, idempotency_key: "off", depends_on: ["#999999999"] }, context),
    ]) expect(result.structuredContent).toMatchObject({ code: "CARD_DEPENDENCIES_DISABLED" });
    expect((await offCards.getCard(waiting.id))?.card).not.toHaveProperty("depends_on");
    expect((await offCards.mcpRead.getCard(waiting.id, {}, null)).card).not.toHaveProperty("dependsOn");
    expect((await offCards.mcpRead.listCards({}, null)).cards.find(card => card.id === waiting.id)).not.toHaveProperty("dependsOn");

    const queued = vi.spyOn(offRepo, "queued");
    try {
      const unrelated = await create();
      await offCards.setCardStatus({ ...human, cardId: unrelated.id, status: "done" });
      await offDispatcher.drain();
      expect(queued).not.toHaveBeenCalled();
      await offDispatcher.dispatch();
      expect(launch.mock.calls.map(([input]) => input.cardId)).toEqual([waiting.id]);
    } finally {
      queued.mockRestore();
    }
  });
});

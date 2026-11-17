import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, statusCards } from "@paperclipai/db";
import { defaultStatusCardRefreshPolicy } from "@paperclipai/shared";
import { statusCardService } from "../services/status-cards.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("configured lifetime agent status-card limit", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("configured-status-cards-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  // Keep: durable author-scoped admission boundary, including archived lifetime cards.
  it.each([
    [undefined, 20], ["", 20], ["invalid", 20], ["0", 20], ["-1", 20],
    ["1.5", 20], ["9007199254740992", 20], [" 50 ", 50],
  ] as const)("allows %s lifetime cards, preserving the default refusal", async (raw, limit) => {
    vi.stubEnv("PAPERCLIP_STATUS_CARD_AGENT_MAX_CARDS", raw);
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Card limits", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Author", status: "active", adapterType: "process" });
    await db.insert(statusCards).values(Array.from({ length: limit - 1 }, (_, n) => ({
      companyId, createdByAgentId: agentId, interestPrompt: `Existing ${n}`,
      archivedAt: n % 2 ? new Date() : null, refreshPolicy: defaultStatusCardRefreshPolicy,
    })));
    const service = statusCardService(db);
    const input = { interestPrompt: "Last allowed card", titlePinned: false, refreshPolicy: defaultStatusCardRefreshPolicy };
    const actor = { agentId, userId: null };
    expect(await service.create(companyId, input, actor)).toMatchObject({ companyId, createdByAgentId: agentId });
    await expect(service.create(companyId, input, actor)).rejects.toMatchObject({
      status: 422, message: `Agents can author at most ${limit} status cards`,
    });
    // Board authors still have no agent lifetime limit.
    expect(await service.create(companyId, input, { agentId: null, userId: "board-user" })).toMatchObject({ createdByAgentId: null });
  });
});

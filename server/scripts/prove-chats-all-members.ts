/** Opt-in two-user browser proof against the full app and embedded PostgreSQL.
 * Run after building server/ui-dist and Runner TypeScript:
 * TASK_OUT=... node --import ./cli/node_modules/tsx/dist/loader.mjs server/scripts/prove-chats-all-members.ts
 * Authentication uses two explicit fixture sessions; authorization/routes/UI are real.
 * No production accounts, provider calls, or real-company acceptance is claimed.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { activityLog, agents, authUsers, companies, companyMemberships, createDb, instanceUserRoles, issueComments, issueReadStates, issues } from "@paperclipai/db";
import { startRecoveryPostgres } from "../src/__tests__/helpers/recovery-postgres-fixture.js";
import { createApp } from "../src/app.js";
import { setupLiveEventsWebSocketServer } from "../src/realtime/live-events-ws.js";
import { createStorageService } from "../src/storage/service.js";
import { createLocalDiskStorageProvider } from "../src/storage/local-disk-provider.js";
import { ensureHumanRoleDefaultGrants } from "../src/services/principal-access-compatibility.js";
import { issueService } from "../src/services/issues.js";
import { documentService } from "../src/services/documents.js";

const out = process.env.TASK_OUT;
assert(out, "TASK_OUT must name a retained evidence directory");
await mkdir(out, { recursive: true });
const root = process.env.TMPDIR;
assert(root, "TMPDIR must name isolated scratch storage");
process.env.PAPERCLIP_HOME = join(root, "all-members-browser-home");
process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = "enforce";
const database = await startRecoveryPostgres("all-members-browser-");
const db = createDb(database.connectionString);
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let liveEvents: ReturnType<typeof setupLiveEventsWebSocketServer> | undefined;
const errors: string[] = [], failed: string[] = [], transportFailures: string[] = [], navigationCancellations: string[] = [], ownerOnlyRequests: string[] = [];
try {
  const companyId = randomUUID(), agentId = randomUUID(), owner = randomUUID(), member = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Conversation sharing proof", issuePrefix: "SHARE", requireBoardApprovalForNewAgents: false });
  for (const [id, name, role] of [[owner, "Owner A", "owner"], [member, "Member B", "operator"]] as const) {
    await db.insert(authUsers).values({ id, name, email: `${id}@example.invalid`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: id, status: "active", membershipRole: role });
    await ensureHumanRoleDefaultGrants(db, { companyId, principalId: id, membershipRole: role, grantedByUserId: null });
  }
  await db.insert(instanceUserRoles).values({ userId: owner, role: "instance_admin" });
  await db.insert(agents).values({ id: agentId, companyId, name: "Team helper", role: "engineer", title: "Project planning", status: "idle", adapterType: "process", runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } });
  const chats = [];
  for (const [user, title] of [[owner, "My project planning"], [member, "Monday launch checklist"]]) {
    chats.push(await issueService(db).create(companyId, { title, conversationAgentId: agentId, conversationUserId: user, createdByUserId: user,
      assigneeAgentId: agentId, conversationState: "waiting", status: "in_review" }));
  }
  for (const chat of chats) await documentService(db).upsertIssueDocument({ issueId: chat.id, key: "plan", title: "Launch checklist", format: "markdown",
    body: "- Review release notes\n- Verify sign-in\n- Confirm the support handoff" });
  const shared = chats[1]!;
  await db.insert(issueComments).values([
    { companyId, issueId: shared.id, authorUserId: member, authorType: "user", body: "What should we check before the Monday launch?", createdAt: new Date(Date.now() - 120_000) },
    { companyId, issueId: shared.id, authorAgentId: agentId, authorType: "agent", body: "Check the release notes, verify the sign-in flow, and confirm the support handoff. The launch checklist is ready for your review.", createdAt: new Date(Date.now() - 60_000) },
  ]);
  await db.insert(issueReadStates).values({ companyId, issueId: shared.id, userId: member, lastReadAt: new Date("2020-01-01") });
  app = await createApp(db, {
    uiMode: "static", serverPort: 0, storageService: createStorageService(createLocalDiskStorageProvider(join(root, "all-members-storage"))),
    deploymentMode: "authenticated", deploymentExposure: "private", allowedHostnames: ["127.0.0.1"], bindHost: "127.0.0.1",
    authReady: true, companyDeletionEnabled: false, announcements: { enabled: false, feedUrl: "https://example.invalid/disabled" },
    localPluginDir: join(root, "all-members-plugins"), managedPluginAutoInstall: [], decisionServiceOptions: { wakeOriginAgent: async () => undefined },
    resolveSession: async req => {
      const id = req.headers.cookie?.includes(`proof-user=${member}`) ? member : req.headers.cookie?.includes(`proof-user=${owner}`) ? owner : null;
      return id ? { session: { id: `proof-${id}`, userId: id }, user: { id, name: id === owner ? "Owner A" : "Member B", email: `${id}@example.invalid` } } : null;
    },
  });
  await app.locals.bundledPluginsStartup;
  server = createServer(app);
  liveEvents = setupLiveEventsWebSocketServer(server, db, { deploymentMode: "authenticated", resolveSessionFromHeaders: async headers => {
    const cookie = headers.get("cookie") ?? "";
    const id = cookie.includes(`proof-user=${member}`) ? member : cookie.includes(`proof-user=${owner}`) ? owner : null;
    return id ? { session: { id: `proof-${id}`, userId: id }, user: { id, name: id === owner ? "Owner A" : "Member B", email: `${id}@example.invalid` } } : null;
  } });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
  const ownerContext = await browser.newContext({ baseURL: base, recordVideo: { dir: join(out, "video"), size: { width: 1440, height: 1000 } } });
  const memberContext = await browser.newContext({ baseURL: base });
  await ownerContext.addCookies([{ name: "proof-user", value: owner, url: base }]);
  await memberContext.addCookies([{ name: "proof-user", value: member, url: base }]);
  const page = await ownerContext.newPage();
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => { if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`); });
  page.on("requestfailed", req => {
    const failure = `${req.failure()?.errorText} ${req.url()}`;
    if (req.failure()?.errorText === "net::ERR_ABORTED") navigationCancellations.push(failure);
    else transportFailures.push(failure);
  });
  page.on("request", req => { if (req.url().includes(shared.id) && /chat-handoffs|pending-questions|decision-receipts/.test(req.url())) ownerOnlyRequests.push(req.url()); });
  const listUrl = `/api/companies/${companyId}/chats?agentId=${agentId}&members=all`;
  const memberList = () => memberContext.request.get(`/api/companies/${companyId}/chats`).then(async response => { assert.equal(response.status(), 200); return response.json(); });
  const snapshot = async () => ({
    readState: await db.select().from(issueReadStates).where(and(eq(issueReadStates.issueId, shared.id), eq(issueReadStates.userId, member))),
    activity: await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.actorId, member))),
    issue: await db.select().from(issues).where(eq(issues.id, shared.id)),
    unread: (await memberList()).find((row: { id: string }) => row.id === shared.id).unreadMessageCount,
  });
  // One conversation per person/agent is a DB invariant: exercise B's private
  // and open state in sequence, rather than fabricating a second B/agent chat.
  await db.update(issues).set({ visibility: "private" }).where(eq(issues.id, shared.id));
  const privateList = await ownerContext.request.get(listUrl);
  assert.equal(privateList.status(), 200);
  assert(!(await privateList.json()).some((row: { id: string }) => row.id === shared.id));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/SHARE/chats/${agentId}`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "All members", exact: true }).click();
  await expect(page.getByRole("link", { name: /My project planning.*Owner A/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Monday launch checklist/ })).toHaveCount(0);
  await page.screenshot({ path: join(out, "all-members-private-hidden.png"), fullPage: true });
  await db.update(issues).set({ visibility: "open" }).where(eq(issues.id, shared.id));
  const before = await snapshot(); assert.equal(before.unread, 1);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await page.goto(`/SHARE/chats/${agentId}`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "All members", exact: true }).click();
    const sharedLink = page.getByRole("link", { name: /Monday launch checklist.*Member B/ });
    await expect(sharedLink).toBeVisible({ timeout: 60_000 });
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: join(out, `all-members-list-${width}.png`), fullPage: true });
    await sharedLink.click();
    await expect(page.getByRole("note").filter({ hasText: "Only Member B can send in this conversation." })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("The launch checklist is ready for your review.", { exact: false })).toBeVisible();
    assert.equal(await page.getByTestId("task-chat-composer-input").count(), 0);
    assert.equal(await page.getByTestId("task-chat-composer-send").count(), 0);
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: join(out, `all-members-open-${width}.png`), fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false, `horizontal overflow at ${width}`);
  }
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(ownerOnlyRequests, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(failed, []);
  assert.deepEqual(transportFailures, []);
  // Direct writes remain denied even if a caller bypasses the UI.
  const send = await ownerContext.request.post(`/api/issues/${shared.id}/comments`, { headers: { origin: base }, data: { body: "Attempted non-owner send", clientRequestId: randomUUID() } });
  assert.equal(send.status(), 403);
  await writeFile(join(out, "browser-evidence.json"), JSON.stringify({ widths: [1440, 390], pageErrors: errors, failedRequests: failed,
    ownerOnlyRequests, transportFailures, navigationCancellations, nonOwnerSend: send.status(), ownerStateUnchanged: true, unreadBefore: before.unread, unreadAfter: (await snapshot()).unread,
    fixture: "Two loopback fixture sessions, full production app/routes/UI, embedded PostgreSQL. B's one chat transitions private -> open; the UI proves exclusion before the shared-list/open captures. Plans are seeded because the unchanged app otherwise returns expected absent-plan 404s. No real-company acceptance claim.",
    companyId, agentId, sharedChatId: shared.id }, null, 2));
  await ownerContext.close(); await memberContext.close();
  console.log("PASS two-user browser proof: private hidden, named shared list, read-only opening, owner state unchanged, zero page errors and failed responses, desktop/phone captures.");
} catch (error) {
  await browser?.contexts()[0]?.pages()[0]?.screenshot({ path: join(out, "browser-failure.png"), fullPage: true }).catch(() => {});
  await writeFile(join(out, "browser-failure.json"), JSON.stringify({ error: String(error), pageErrors: errors, failedRequests: failed, transportFailures, navigationCancellations, ownerOnlyRequests }, null, 2));
  throw error;
} finally {
  await browser?.close();
  if (liveEvents) await new Promise<void>(resolve => liveEvents!.close(() => resolve()));
  await app?.locals.paperclipShutdown?.();
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
  await db.$client.end({ timeout: 0 });
  await database.cleanup();
}

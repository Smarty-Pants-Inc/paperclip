// Negative control: production-shaped package, deliberately NO guardian logic.
export default {
  id: "smarty-pants.paperclip-plugin-conversation-guardian",
  apiVersion: 1,
  version: "0.0.1",
  displayName: "Conversation Guardian (ABSENT negative control)",
  description: "Inert guardian for real-loader acceptance REDs.",
  author: "Smarty Pants",
  categories: ["automation"],
  capabilities: [
    "events.subscribe", "jobs.schedule", "issues.read", "issue.comments.read",
    "issue.comments.create", "agents.read", "database.namespace.migrate",
    "database.namespace.read", "database.namespace.write",
  ],
  entrypoints: { worker: "./worker.js" },
  jobs: [{ jobKey: "sweep", displayName: "Guardian sweep", schedule: "* * * * *" }],
  instanceConfigSchema: { type: "object", properties: { enabled: { type: "boolean", default: false } } },
  database: {
    namespaceSlug: "conversation_guardian", migrationsDir: "migrations",
    coreReadTables: ["issues", "issue_comments", "heartbeat_runs", "agents"],
  },
};

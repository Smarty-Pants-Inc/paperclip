// Scheduled-job fixture for server-kill and timeout REDs: its job sleeps.
export default {
  id: "smarty-pants.paperclip-plugin-sleepy-job",
  apiVersion: 1,
  version: "0.0.1",
  displayName: "Sleepy job (test fixture)",
  description: "A scheduled job that sleeps, so a test can kill its server mid-job.",
  author: "Smarty Pants",
  categories: ["automation"],
  capabilities: ["jobs.schedule"],
  entrypoints: { worker: "./worker.js" },
  jobs: [{ jobKey: "sleep", displayName: "Sleep", schedule: "* * * * *" }],
};

// Scheduled-job fixture for the timeout-overlap RED: its job sleeps.
export default {
  id: "smarty-pants.paperclip-plugin-sleepy-job",
  apiVersion: 1,
  version: "0.0.1",
  displayName: "Sleepy job (test fixture)",
  description: "A scheduled job that sleeps, so a test can hold a run past its RPC timeout.",
  author: "Smarty Pants",
  categories: ["automation"],
  capabilities: ["jobs.schedule"],
  entrypoints: { worker: "./worker.js" },
  jobs: [{ jobKey: "sleep", displayName: "Sleep", schedule: "* * * * *" }],
};

/**
 * Candidate closure pins from the isolated npm lock and official Node 24.21.0.
 * The non-Node graph is identical across targets, including platform resources.
 * Pi 1.0.0 dependency graphs were independently installed for all three targets.
 * Native platform execution and paid qualification remain separately required.
 * Changing any package, helper, extension or bootstrap requires regenerating all
 * three pins. Never accept a digest supplied only by an installed manifest.
 */
export const PI_DISTRIBUTION_CLOSURE_SHA256 = Object.freeze({
  "darwin-arm64": "3b863d9faff6f5ad3d77629c9e6ed76ac466f85130d6d5e3dbcd4bcdd1b04487",
  "darwin-x64": "7482cf414e14944b1ca79d21ba53df09a1215b6df440b0b353f337cb3273a722",
  "linux-x64": "21c9f30a71d90fc6f185b491f043098ac5131d6b7f454d741d7e99646099dc29",
});

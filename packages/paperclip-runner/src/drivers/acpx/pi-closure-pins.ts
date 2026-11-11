/**
 * Candidate closure pins from the isolated npm lock and official Node 24.21.0.
 * The non-Node graph is identical across targets, including platform resources.
 * Pi 1.0.0 dependency graphs were independently installed for all three targets.
 * Native platform execution and paid qualification remain separately required.
 * Changing any package, helper, extension or bootstrap requires regenerating all
 * three pins. Never accept a digest supplied only by an installed manifest.
 */
export const PI_DISTRIBUTION_CLOSURE_SHA256 = Object.freeze({
  "darwin-arm64": "8c2e4122d72037a3eefdb393d3e49e6934c3e5288db0abdc5700a5d7433bfe39",
  "darwin-x64": "a2d08ed28bf725fb4bc84928999b20bf684e832e31fef1d8025cf488416e867e",
  "linux-x64": "27b975a023c43b53d30f133b126744d171cfb88ba7c20b4b8c5bc77b74efb6c5",
});

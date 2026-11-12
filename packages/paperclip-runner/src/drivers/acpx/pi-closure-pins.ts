/**
 * Candidate closure pins from the isolated npm lock and official Node 24.21.0.
 * The non-Node graph is identical across targets, including platform resources.
 * Pi 1.5.2 dependency graphs were independently installed for all three targets.
 * Native platform execution and paid qualification remain separately required.
 * Changing any package, helper, extension or bootstrap requires regenerating all
 * three pins. Never accept a digest supplied only by an installed manifest.
 */
export const PI_DISTRIBUTION_CLOSURE_SHA256 = Object.freeze({
  "darwin-arm64": "e8fe3102600be91b1ba0309c4b9af9c2ebfb3e5a9df1073ce9036ae75193aa00",
  "darwin-x64": "ca2f789f7a0403e9a37b31603e7702d1506dc13a62487fc7b912c9352cc33ba6",
  "linux-x64": "4a314ac196494cdf36605fc0f656914d77970e22ab4ae2b412b421babf12d99e",
});

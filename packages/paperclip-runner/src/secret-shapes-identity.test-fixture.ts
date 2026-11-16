// Keep ordinary transcript content after a generic identity/registered-value mark.
// These are not PEM bodies: prose, labeled hashes, paths, and data URIs.
const mark = "***REDACTED***";
const sha1 = "6e90f3f0ebcec3fcc70ffcf22056eac2c32ec699";
const sha256 = "bc86da1a9c93f3f68ce048eb1af56e95b8590a184268517756bfc8bcad507bd2";
export const identityMarkPrecisionInputs = [
  { name: "commit in prose", text: `token ${mark} was used at commit ${sha1} on main` },
  { name: "sha256 on next line", text: `token ${mark}\nsha256: ${sha256}\ngit status` },
  { name: "bare sha256 line", text: `token ${mark}\n${sha256}\ngit status` },
  { name: "base64 image data URI", text: `token ${mark}\ndata:image/png;base64,${"AbCdEf01+/".repeat(12)}\nimage done` },
  { name: "path and following commands", text: `export GH_TOKEN=${mark}\ncd /srv/scratch/paul/tasks/direct/review\ngit status\n` },
  { name: "slash path on next line", text: `${mark}\n/home/paul/smarty/smartypants/src/lib/server\n` },
  { name: "long base64 token in ordinary sentence", text: `${mark} image ${"AbCdEf01+/".repeat(12)} was saved` },
  { name: "unrelated base64 after a prose boundary", text: `${mark}\nThis is ordinary output\n${"AbCdEf01+/".repeat(6)}\n` },
  { name: "JSON escaped ordinary output", text: `token ${mark}\\nsha256: ${sha256}\\ncd /srv/scratch/paul/tasks/direct/review` },
];

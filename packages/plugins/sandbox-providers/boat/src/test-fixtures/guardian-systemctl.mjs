#!/usr/bin/node
// Local staging integration fixture, NOT a real service manager. The test
// launches the unit's exact ExecStart argv and owns/reaps that real process.
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync('/home/user/.test-systemd.json', 'utf8'));
const args = process.argv.slice(2);
if (args.shift() !== '--user') process.exit(1);
switch (args[0]) {
  case 'show-environment':
    for (const [name, value] of Object.entries(state.manager)) console.log(`${name}=${value}`);
    break;
  case 'is-active':
    if (!state.pid) { if (!args.includes('--quiet')) console.log('inactive'); process.exit(3); }
    try { process.kill(state.pid, 0); } catch { if (!args.includes('--quiet')) console.log('inactive'); process.exit(3); }
    if (!args.includes('--quiet')) console.log('active');
    break;
  case 'show':
    if (args.includes('--property=MainPID')) console.log(state.pid ?? 0);
    else process.exit(1);
    break;
  case 'daemon-reload': break;
  case 'enable':
    if (args.join(' ') !== 'enable --now paperclip-guardian') process.exit(1);
    break;
  default: process.exit(1);
}

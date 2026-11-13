// Test-only command runner. Keep the real guardian and maintenance commands in
// ONE user/mount namespace so Linux /proc environ checks have the real topology.
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
const exec = promisify(execFile);
let daemon, exited, sshd, sshExited, sshLog = '';
async function bounded(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('test deadline')), ms); })]); }
  finally { clearTimeout(timer); }
}
async function stop() {
  if (sshd) { sshd.kill('SIGTERM'); await bounded(sshExited,3000); sshd=undefined; }
  if (!daemon) return null;
  const pid = daemon.pid;
  let status;
  daemon.kill('SIGTERM');
  try { status = await bounded(exited, 3000); }
  catch { daemon.kill('SIGKILL'); status = await bounded(exited, 3000); }
  daemon = undefined;
  return { pid, exitCode: status[0], signal: status[1], reaped: true };
}
const lines = createInterface({ input: process.stdin });
try {
  for await (const line of lines) {
    const { id, op, ...args } = JSON.parse(line);
    let result;
    try {
      if (op === 'run') {
        const { stdout, stderr } = await exec('/usr/bin/sh', ['-c', args.command], { env: {HOME:'/home/user',PATH:'/usr/bin:/bin'}, timeout: args.timeout, maxBuffer: 1024 * 1024 });
        result = { exitCode: 0, timedOut: false, stdout, stderr };
      } else if (op === 'start') {
        if (daemon) throw new Error('duplicate test start');
        daemon = spawn(args.argv[0], args.argv.slice(1), { env: args.env, stdio: ['ignore', 'pipe', 'pipe'] });
        exited = once(daemon, 'exit');
        let stderr = ''; daemon.stderr.on('data', chunk => { stderr += chunk; });
        const ready = JSON.parse(String((await bounded(once(daemon.stdout, 'data'), 5000))[0]));
        result = { pid: daemon.pid, ready, stderr };
      } else if (op === 'sshd') {
        sshd=spawn('/usr/sbin/sshd',['-D','-e','-f',args.config],{env:{PATH:'/usr/bin:/bin'},stdio:['ignore','pipe','pipe']});
        sshExited=once(sshd,'exit'); sshd.stdout.resume();
        await bounded(new Promise((resolve,reject)=>{sshd.stderr.on('data',b=>{sshLog+=b;if(sshLog.includes('Server listening'))resolve();});sshd.once('error',reject);sshd.once('exit',()=>reject(Error(sshLog)));}),5000);
        result={pid:sshd.pid};
      } else if (op === 'sshlog') result=sshLog;
      else if (op === 'environment') result = await readFile(`/proc/${daemon.pid}/environ`, 'utf8');
      else if (op === 'close' || op === 'stop-unit') result = await stop();
      else throw new Error('unknown test op');
      console.log(JSON.stringify({ id, result }));
    } catch (error) {
      console.log(JSON.stringify({ id, error: error.stderr ?? error.message }));
    }
    if (op === 'close') break;
  }
} finally { lines.close(); await stop(); }

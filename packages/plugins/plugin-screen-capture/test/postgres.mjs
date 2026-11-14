import { spawn } from 'node:child_process';

// Tests accept ONLY the private local socket created by run-postgres-tests.sh.
// They never accept DATABASE_URL or touch a pre-existing/shared database.
export function postgres() {
  const host = process.env.SCREEN_CAPTURE_TEST_PGHOST;
  if (process.env.SCREEN_CAPTURE_TEST_OWNED !== 'yes' || !host?.includes('/hl-screen-capture.')) {
    throw new Error('Run test/run-postgres-tests.sh: an owned disposable PostgreSQL is required');
  }
  const args = ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', host,
    '-p', process.env.SCREEN_CAPTURE_TEST_PGPORT, '-U', process.env.SCREEN_CAPTURE_TEST_PGUSER, '-d', 'postgres'];
  async function raw(sql) {
    return new Promise((resolve, reject) => {
      const child = spawn('psql', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = '';
      child.stdout.on('data', part => { out += part; });
      child.stderr.on('data', part => { err += part; });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(err.trim())));
      child.stdin.end(sql);
    });
  }
  function bind(sql, params = []) {
    return sql.replace(/\$(\d+)/g, (_, n) => {
      const value = params[Number(n) - 1];
      if (value === null) return 'NULL';
      if (value === undefined) throw new Error(`Missing parameter $${n}`);
      return `'${String(value).replaceAll("'", "''")}'`;
    });
  }
  function mutant(sql) {
    if (process.env.SCREEN_CAPTURE_TEST_MUTANT === 'stale') {
      return sql.replaceAll('f.has_newer_person OR f.has_later_agent', 'false');
    }
    return sql;
  }
  return {
    raw,
    async query(sql, params) {
      const out = await raw(`SELECT COALESCE(json_agg(result), '[]'::json) FROM (${bind(mutant(sql), params)}) result;`);
      return JSON.parse(out);
    },
    async execute(sql, params) {
      const out = await raw(`${bind(mutant(sql), params)};`);
      const tag = out.match(/^(?:INSERT \d+|UPDATE|DELETE)\s+(\d+)$/m);
      if (!tag) throw new Error(`No write count from PostgreSQL: ${out}`);
      return { rowCount: Number(tag[1]) };
    },
  };
}

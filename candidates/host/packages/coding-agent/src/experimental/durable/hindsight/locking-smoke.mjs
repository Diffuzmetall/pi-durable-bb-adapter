// MANUAL ONLY. Preparation is not deletion authority. Never add to test discovery.
// Native proper-lockfile may remove ONLY this fresh fixture's session *.lock dirs
// (release, exit, stale takeover, or failed mtime probe). Everything else is retained.
// No FS adapters, mocks, retry overrides, direct lock calls, or fixture cleanup.
if (!process.argv.slice(2).includes('--allow-synthetic-lock-release')) {
  console.error('REFUSED: --allow-synthetic-lock-release requires separate operator deletion authorization');
  process.exit(64); // Before any filesystem imports/writes or production import.
}

const assert = (await import('node:assert/strict')).default;
const fs = await import('node:fs');
const path = await import('node:path');
const { fileURLToPath } = await import('node:url');
const { createHash } = await import('node:crypto');
const { spawn } = await import('node:child_process');
const args = process.argv.slice(2);
const childMode = args.includes('--owned-child');
assert.deepEqual(args.filter(a => a !== '--allow-synthetic-lock-release' && a !== '--owned-child').slice(0, 1), ['--root']);
assert.equal(args.length, childMode ? 4 : 3, 'Unknown/duplicate arguments');
const root = args[args.indexOf('--root') + 1];
assert.equal(typeof root, 'string');
assert.match(root, /^\/tmp\/hindsight-real-lock-\d{8}-[a-z0-9][a-z0-9-]{0,47}$/);
assert.equal(path.resolve(root), root);
assert.equal(fs.realpathSync('/tmp'), '/tmp', 'No symlinked /tmp');
const agent = path.join(root, 'agent');
const fixture = path.join(root, 'cwd');
const sessions = path.join(agent, 'experimental', 'durable-sessions', createHash('sha256').update(fixture).digest('hex').slice(0, 24));
const script = fileURLToPath(import.meta.url);
const configURL = new URL('../pi-upstream/packages/coding-agent/src/config.ts', new URL('../', import.meta.url));
const sessionURL = new URL('../coding-agent-durable/sessions.ts', import.meta.url);
const loader = fileURLToPath(new URL('./tui-loader.mjs', import.meta.url));
const WAIT = 30_000; // Production: twelve 1s retries, ~12s contention.
function bounded(promise, label, ms = WAIT) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms);
  })]).finally(() => clearTimeout(timer));
}
function absent(target) {
  try { fs.lstatSync(target); return false; } catch (e) { if (e.code === 'ENOENT') return true; throw e; }
}
function identity(location) {
  assert.match(location.id, /^\d{13}-[0-9a-f-]{36}$/);
  assert.equal(location.directory, path.join(sessions, location.id));
  assert.equal(location.database, path.join(location.directory, 'session.sqlite'));
  assert.equal(location.cwd, fixture);
  assert.equal(fs.realpathSync(location.directory), location.directory);
  return { id: location.id, directory: location.directory, database: location.database, cwd: location.cwd, created: location.created };
}

async function child() {
  assert.equal(typeof process.send, 'function', 'Children must be parent-owned IPC processes');
  assert.equal(process.env.PI_CODING_AGENT_DIR, agent);
  assert.equal(process.cwd(), fixture);
  assert.equal(fs.realpathSync(root), root);
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  for (const dir of [agent, fixture]) assert.equal(fs.realpathSync(dir), dir);
  // Install listeners before importing/acquiring; disconnect releases normally.
  let resolveStart, resolveRelease;
  const start = new Promise(resolve => { resolveStart = resolve; });
  const release = new Promise(resolve => { resolveRelease = resolve; });
  process.on('message', message => {
    if (message?.type === 'start') resolveStart(message.role);
    if (message?.type === 'release') resolveRelease();
  });
  process.on('disconnect', () => { resolveStart('disconnected'); resolveRelease(); });
  process.send({ type: 'ready' });
  const role = await bounded(start, 'child start');
  assert.ok(['owner', 'competitor', 'successor'].includes(role));
  const { getAgentDir, ENV_AGENT_DIR } = await import(configURL.href);
  assert.equal(ENV_AGENT_DIR, 'PI_CODING_AGENT_DIR');
  assert.equal(getAgentDir(), agent, 'Fail before selectSession import if config escapes fixture');
  const { selectSession } = await import(sessionURL.href);
  let location;
  try {
    const began = Date.now();
    try { location = await selectSession(fixture, role !== 'owner'); }
    catch (error) {
      if (role !== 'competitor') throw error;
      assert.equal(error.cause?.code, 'ELOCKED');
      assert.ok(error.message.startsWith('Session is already open in another process: '));
      process.send({ type: 'rejected', message: error.message, cause: error.cause.code, elapsedMs: Date.now() - began });
      return;
    }
    const info = identity(location);
    assert.equal(location.created, role === 'owner');
    assert.ok(fs.statSync(`${location.directory}.lock`).isDirectory());
    process.send({ type: 'acquired', ...info });
    assert.notEqual(role, 'competitor', 'Competing --continue unexpectedly acquired');
    await bounded(release, 'child release request', 90_000);
  } finally {
    if (location) {
      await location.release(); // Only reachable with explicit authorization flag.
      process.send?.({ type: 'released', directory: location.directory });
    }
    if (process.connected) process.disconnect();
  }
}

async function parent() {
  assert.ok(absent(root), 'Refuse any existing root, including symlinks/data');
  fs.mkdirSync(root, { mode: 0o700 }); // Nonrecursive atomic creation; EEXIST refuses races.
  fs.mkdirSync(agent, { mode: 0o700 });
  fs.mkdirSync(fixture, { mode: 0o700 });
  const log = fs.openSync(path.join(root, 'events.jsonl'), 'wx', 0o600);
  const children = [];
  const record = data => fs.writeSync(log, `${JSON.stringify({ time: new Date().toISOString(), ...data })}\n`);
  function launch(role) {
    const out = fs.openSync(path.join(root, `${role}.stdout.log`), 'wx', 0o600);
    const err = fs.openSync(path.join(root, `${role}.stderr.log`), 'wx', 0o600);
    const env = { ...process.env, PI_CODING_AGENT_DIR: agent };
    delete env.NODE_OPTIONS; // Do not inherit hooks that could mock or write elsewhere.
    const proc = spawn(process.execPath, ['--import', loader, script, '--allow-synthetic-lock-release', '--root', root, '--owned-child'], {
      cwd: fixture, env, stdio: ['ignore', out, err, 'ipc'],
    });
    fs.closeSync(out); fs.closeSync(err);
    const queue = []; let wake;
    const state = { proc, role, done: false };
    children.push(state);
    state.closed = new Promise(resolve => proc.once('close', (code, signal) => {
      state.done = true; state.code = code; record({ role, type: 'close', code, signal }); wake?.(); resolve();
    }));
    proc.on('error', error => { state.error = error; wake?.(); });
    proc.on('message', message => { record({ role, ...message }); queue.push(message); wake?.(); });
    state.next = async type => bounded((async () => {
      for (;;) {
        if (queue.length) {
          const message = queue.shift(); assert.equal(message.type, type, `${role}: unexpected IPC`); return message;
        }
        if (state.error) throw state.error;
        assert.ok(!state.done, `${role}: exited before ${type}`);
        await new Promise(resolve => { wake = resolve; }); wake = undefined;
      }
    })(), `${role}: ${type}`);
    state.start = async () => { await state.next('ready'); proc.send({ type: 'start', role }); };
    return state;
  }
  async function finish(state) {
    await bounded(state.closed, `${state.role}: reap`);
    assert.equal(state.code, 0, `${state.role}: nonzero exit`);
  }
  try {
    record({ type: 'scope', root, agent, fixture, sessions, sessionSource: sessionURL.href });
    const owner = launch('owner'); await owner.start();
    const first = await owner.next('acquired');
    identity(first);
    const lock = `${first.directory}.lock`;
    const held = fs.statSync(lock); assert.ok(held.isDirectory());
    const competitor = launch('competitor'); await competitor.start();
    const rejection = await competitor.next('rejected');
    assert.equal(rejection.message, `Session is already open in another process: ${first.directory}`);
    assert.equal(rejection.cause, 'ELOCKED');
    assert.ok(rejection.elapsedMs >= 11_000 && rejection.elapsedMs < WAIT, 'Production retry window');
    await finish(competitor);
    assert.ok(!owner.done, 'Owner must still hold');
    const stillHeld = fs.statSync(lock);
    assert.equal(stillHeld.ino, held.ino); assert.equal(stillHeld.dev, held.dev);
    owner.proc.send({ type: 'release' });
    await owner.next('released'); await finish(owner);
    assert.ok(absent(lock), 'Normal owner release removes only lock dir');
    const successor = launch('successor'); await successor.start();
    const third = await successor.next('acquired');
    assert.deepEqual({ ...third, created: first.created }, first);
    identity(third); assert.equal(third.created, false);
    assert.ok(fs.statSync(lock).isDirectory());
    successor.proc.send({ type: 'release' });
    await successor.next('released'); await finish(successor);
    assert.ok(absent(lock));
    assert.deepEqual(fs.readdirSync(sessions), [first.id], 'One unchanged session identity');
    assert.ok(fs.statSync(first.directory).isDirectory());
    record({ type: 'passed', id: first.id, directory: first.directory, retained: true });
    console.log(`REAL LOCK ACCEPTANCE PASSED; fixtures and logs retained: ${root}`);
  } catch (error) {
    record({ type: 'failed', error: error.stack });
    // Only processes spawned here, only on failure; await close (reap), not kill receipt.
    const reaped = await Promise.allSettled(children.map(async state => {
      if (state.done) return;
      state.proc.kill('SIGTERM');
      try { await bounded(state.closed, `${state.role}: terminate`, 3_000); }
      catch {
        state.proc.kill('SIGKILL');
        await bounded(state.closed, `${state.role}: kill/reap`, 5_000);
      }
    }));
    for (const result of reaped) {
      if (result.status === 'rejected') record({ type: 'reap-failed', error: String(result.reason) });
    }
    throw error;
  } finally { fs.closeSync(log); } // No fixture cleanup, ever.
}
try { await (childMode ? child() : parent()); }
catch (error) { console.error(error.stack); process.exitCode = 1; if (process.connected) process.disconnect(); }

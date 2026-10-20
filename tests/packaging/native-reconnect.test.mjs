import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiThreadSession } from '../../src/projection/host/session.ts';
import { SessionRegistry } from '../../src/provider/host/session-registry.ts';
import { ProviderBridge } from '../../src/projection/host/bridge.ts';
import { verifyNativeReady } from '../../src/bootstrap/provider-grant.ts';

const until = async predicate => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error('recovery condition timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

async function fixture(t, { refuse = false, busy = false, unknown = false, holdPrompt = false, dropAuthorization = false, acceptPrompt = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'bb-reconnect-'));
  const path = join(dir, 'control.sock'), sockets = new Set(), commands = [], notifications = [];
  let attachments = 0, authorizations = 0, latest, committedInput;
  const final = { id: 7, conversationId: 1, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: 'saved answer' }], stopReason: 'stop' }] };
  const view = () => ({ session: { id: 'native', directory: dir, cwd: dir },
    conversation: { conversation: { id: 1 }, docs: unknown && attachments >= 2 ? {} : { 'pi.inbox': { items: [] }, 'pi.live': attachments < 2 || busy ? { run: { taskId: 1, inputs: [] } } : {} }, entries: attachments < 2 ? [] : [...(committedInput ? [committedInput] : []), final] },
    conversations: [{ id: 1, label: 'root' }], models: [], tasks: { tasks: {} } });
  const server = createServer(socket => {
    sockets.add(socket); latest = socket;
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const command = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); commands.push(command);
        if (command.type === 'attach') attachments++;
        if (acceptPrompt && command.type === 'prompt') {
          committedInput = { id: final.id + 1, conversationId: 1, kind: 'pi.user', model: [{ role: 'user', content: command.message }] };
          final.id += 2;
          if (command.message === 'second root input') final.model[0].content[0].text = 'saved second answer';
          socket.destroy(); continue;
        }
        if (holdPrompt && command.type === 'prompt') continue;
        if (dropAuthorization && attachments === 2 && command.type === 'get_state') { socket.destroy(); continue; }
        socket.write(JSON.stringify({ type: 'response', id: command.id, success: true,
          data: command.type === 'attach' ? view() : command.type === 'get_state' ? { sessionId: 'native', cwd: dir } : {} }) + '\n');
      }
    });
  });
  await new Promise(resolve => server.listen(path, resolve)); await chmod(path, 0o600);
  const session = new PiThreadSession({ threadId: 'thr_recover', providerThreadId: 'pi_durable_bb_recover', cwd: dir,
    sessionDir: dir, sessionFilePath: dir, extensionPath: dir, scratchDir: dir },
    (method, params) => notifications.push({ method, ...params }),
    { selected: { socket: path, session: view().session }, config: {} });
  // The transport fixture replaces only the external authority RPC, never prompt/control dispatch.
  session.authorizeObservationThread = async (threadId, providerThreadId) => {
    assert.equal(threadId, 'thr_recover');
    assert.equal(providerThreadId, 'pi_durable_bb_recover');
    await verifyNativeReady({ socket: path, session: view().session }, session.readyView,
      await session.runner.requestOk({ type: 'get_state' }), dir);
    authorizations++;
    if (refuse && authorizations > 1) throw Error('foreign owner refused');
  };
  t.after(async () => { await session.closeGracefully(); for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  await session.start();
  session.modelConfigured = true; // A previous admitted turn already configured its model.
  const registry = new SessionRegistry(() => {});
  registry.sessions.set('thr_recover', { session, providerThreadId: session.options.providerThreadId });
  const frames = [], bridge = new ProviderBridge(line => frames.push(JSON.parse(line)), registry);
  const deltas = () => notifications.flatMap(frame => frame.deltas ?? []);
  const breakConnection = async () => {
    latest.write(JSON.stringify({ type: 'agent_events', view: view(), events: [{ type: 'run_start' }, { type: 'message_update', changes: [{ type: 'text_delta', delta: 'saved ' }] }] }) + '\n');
    await until(() => deltas().some(d => d.kind === 'turn.open'));
    latest.destroy();
  };
  return { session, registry, bridge, frames, commands, deltas, breakConnection, view, final,
    get socket() { return latest; }, get attachments() { return attachments; }, get authorizations() { return authorizations; } };
}

test('lost owner transport reconnects, authorizes and delivers saved completion once without submit', async t => {
  const f = await fixture(t);
  await f.breakConnection();
  await until(() => f.deltas().some(d => d.kind === 'turn.boundary'));
  assert.equal(f.registry.get('thr_recover'), f.session, 'keep the original binding/translator');
  assert.ok(f.authorizations >= 2);
  assert.equal(f.deltas().filter(d => d.kind === 'turn.boundary').length, 1);
  assert.equal(f.deltas().filter(d => d.kind === 'item.textClose' && d.channel === 'agentMessage').at(-1).text, 'saved answer');
  assert.equal(f.commands.filter(c => c.type === 'prompt').length, 0);
  // A delayed duplicate terminal event from the reattached stream cannot complete twice.
  f.socket.write(JSON.stringify({ type: 'agent_events', view: f.view(), events: [{ type: 'run_end' }] }) + '\n');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.deltas().filter(d => d.kind === 'turn.boundary').length, 1);
  f.socket.destroy();
  await until(() => f.attachments === 3);
  await f.session.runner.whenConnected();
  assert.equal(f.deltas().filter(d => d.kind === 'turn.boundary').length, 1, 'a second detach cannot redeliver the result');
});

test('Steer and interrupt Stop wait for the same authenticated reconnection, not a new session', async t => {
  const f = await fixture(t, { busy: true });
  await f.breakConnection();
  await new Promise(resolve => setTimeout(resolve, 20));
  await Promise.all(['turn/steer', 'thread/stop'].map((method, i) => f.bridge.handleLine(JSON.stringify({ id: i + 1, method,
    params: { threadId: 'thr_recover', providerThreadId: f.session.options.providerThreadId, intent: 'interrupt', input: [{ type: 'text', text: 'status' }] } }))));
  assert.deepEqual(f.frames.filter(frame => frame.error), []);
  assert.equal(f.commands.filter(c => c.type === 'steer').length, 1);
  assert.equal(f.commands.filter(c => c.type === 'abort').length, 1);
  assert.equal(f.commands.filter(c => c.type === 'prompt').length, 0);
  assert.equal(f.attachments, 2, 'concurrent controls share a single reconnect');
  assert.ok(!f.deltas().some(d => d.kind === 'turn.boundary'), 'a busy snapshot is not success');
});

test('another socket loss during native authorization retries transport, not the command', async t => {
  const f = await fixture(t, { dropAuthorization: true });
  await f.breakConnection();
  await until(() => f.deltas().some(d => d.kind === 'turn.boundary'));
  assert.equal(f.attachments, 3);
  assert.equal(f.session.runner.exited, false);
  assert.equal(f.commands.filter(c => c.type === 'prompt').length, 0);
});

test('accepted input completing before run_start reaches BB is recovered from its committed user/result entries', async t => {
  const f = await fixture(t, { acceptPrompt: true });
  await assert.rejects(f.session.prompt('unique root input'), /disconnected/);
  await until(() => f.deltas().some(d => d.kind === 'turn.boundary'));
  assert.equal(f.commands.filter(c => c.type === 'prompt').length, 1);
  assert.equal(f.deltas().filter(d => d.kind === 'turn.boundary').length, 1);
  assert.equal(f.deltas().filter(d => d.kind === 'item.textClose' && d.channel === 'agentMessage').at(-1).text, 'saved answer');
});

test('recovering A does not hide the next answer B when its start is also lost', async t => {
  const f = await fixture(t, { acceptPrompt: true });
  await f.breakConnection();
  await until(() => f.deltas().filter(d => d.kind === 'turn.boundary').length === 1);
  await f.session.runner.whenConnected();
  await assert.rejects(f.session.prompt('second root input'), /disconnected/);
  await until(() => f.deltas().filter(d => d.kind === 'turn.boundary').length === 2);
  const texts = f.deltas().filter(d => d.kind === 'item.textClose' && d.channel === 'agentMessage').map(d => d.text);
  assert.deepEqual(texts, ['saved answer', 'saved second answer']);
  assert.equal(f.commands.filter(c => c.type === 'prompt').length, 1);
});

test('an uncertain prompt is rejected but never resent after reconnect', async t => {
  const f = await fixture(t, { holdPrompt: true });
  const outcome = f.session.prompt('execute once').catch(error => error);
  await until(() => f.commands.some(c => c.type === 'prompt'));
  f.socket.destroy();
  assert.match((await outcome).message, /disconnected/);
  await until(() => f.attachments === 2);
  await f.session.runner.whenConnected();
  assert.equal(f.commands.filter(c => c.type === 'prompt').length, 1);
  assert.ok(!f.deltas().some(d => d.kind === 'turn.boundary'), 'an old answer without our new user entry cannot settle an uncertain submission');
});

test('release while disconnected cancels reconnect without aborting the owner', async t => {
  const f = await fixture(t);
  await f.breakConnection();
  await new Promise(resolve => setTimeout(resolve, 20));
  await f.registry.stop('thr_recover');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(f.attachments, 1);
  assert.equal(f.commands.filter(c => c.type === 'abort').length, 0);
});

test('an incomplete snapshot does not declare the detached run successful', async t => {
  const f = await fixture(t, { unknown: true });
  await f.breakConnection();
  await until(() => f.attachments === 2);
  await f.session.runner.whenConnected();
  assert.ok(!f.deltas().some(d => d.kind === 'turn.boundary'));
});

test('reconnect refuses a changed authority before releasing history or controls', async t => {
  const f = await fixture(t, { refuse: true });
  await f.breakConnection();
  await until(() => f.authorizations > 1);
  await until(() => f.session.runner.exited);
  assert.ok(!f.deltas().some(d => d.kind === 'turn.boundary' || (d.kind === 'item.textClose' && d.text === 'saved answer')));
  assert.equal(f.commands.filter(c => ['prompt', 'steer', 'abort'].includes(c.type)).length, 0);
});

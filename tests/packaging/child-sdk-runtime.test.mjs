import test from 'node:test';
import assert from 'node:assert/strict';
import { patchNativeChildRuntime } from '../../compat/source/native-child-session.mjs';
const fragment = `
  function D(y) {
    let R = o.resolveProviderForThread(y), _ = s.get(y);
    return _;
  }
  async function cne(e) {
    let { command: t, entry: r, options: n } = e, { resumeContext: o } = t;
  if (r.runtime.hasThread(t.threadId)) return;
  if (!o.providerThreadId) throw Error('missing provider identity');
    n.resumed++;
    s.set(t.threadId, {});
  }
  const runtime = { unused() {
  }, hasThread(y) {
    return o.getProviderSession(y) !== null;
  }, getLiveThreadIds() { return []; } };
  function route(_, R, Pn) { return dispatchHistory(_, R, o, e, Pn); }
  function stop(e, n) {
  if (n.runtime.hasThread(e.threadId)) {
    if (e.type === "thread.stop" && e.intent === "release") return 'release';
    return n.runtime.stopThread({threadId:e.threadId});
  }
  }
  return { runtime, options: nativeHistoryOptions, stop, ensure: cne };
`;
function fixture(receipt) {
  const configurations = new Map(), pending = new Set(['child']), events = [];
  const identity = { getProviderSession: () => ({ providerId: 'pi-durable' }), resolveProviderForThread: () => 'pi-durable' };
  const patched = patchNativeChildRuntime(fragment);
  const result = new Function('o', 's', 'e', 'w', 'sr', patched)(identity, configurations,
    { async onNativeHistory() { return receipt; } }, { observe: event => events.push(event) }, event => pending.delete(event.threadId));
  return { ...result, configurations, pending, events, patched };
}
test('identity-only native alias remains visible to scope lookup, while control resumes its live session', async () => {
  const f = fixture({});
  assert.equal(f.runtime.hasThread('child'), true, 'Core scope lookup must find an NCR alias before first input');
  assert.equal(f.runtime.hasLiveThreadSession('child'), false);
  const options = { resumed: 0 };
  const request = { command: { threadId: 'child', resumeContext: { providerThreadId: 'native:23' } }, entry: { runtime: f.runtime }, options };
  await f.ensure(request);
  assert.equal(options.resumed, 1);
  assert.equal(f.runtime.hasLiveThreadSession('child'), true);
  await f.ensure(request);
  assert.equal(options.resumed, 1, 'a live session is not resumed twice');
  assert.equal(patchNativeChildRuntime(f.patched), f.patched);
  assert.throws(() => patchNativeChildRuntime('different BB version'), /Unsupported/);
  assert.throws(() => f.stop({type:'thread.stop',threadId:'view-only'}, {runtime:{hasThread:()=>false,getProviderSession:()=>({}),stopThread(){throw Error('No live session; not stopped');}}}), /not stopped/);
});
test('committed native history ACK updates existing SDK activity, without re-ingesting events', async () => {
  const f = fixture({ threadId: 'child', digest: 'a'.repeat(64), changed: true, turnId: 'native-presentation-turn' });
  await f.options.onNativeHistory({ threadId: 'child', snapshot: { status: 'working' } });
  assert.equal(f.pending.size, 0);
  assert.deepEqual(f.events, [{ type: 'turn/started', threadId: 'child', scope: { kind: 'turn', turnId: 'native-presentation-turn' } }]);
  await f.options.onNativeHistory({ threadId: 'child', snapshot: { status: 'completed' } });
  assert.equal(f.events.at(-1).type, 'turn/completed');
});
test('deferred/unconfirmed history never clears pending SDK execution state', async () => {
  const f = fixture({ threadId: 'child', digest: null, changed: false, deferred: true });
  await f.options.onNativeHistory({ threadId: 'child', snapshot: { status: 'completed' } });
  assert.equal(f.pending.size, 1); assert.equal(f.events.length, 0);
});

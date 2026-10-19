import assert from 'node:assert/strict';

// BB 0.46.0's admitted runtime bundle. NCR adds identity, not live session
// configuration. Identity lookup must still find that alias for Core authority
// checks and history attach. Only the control resume guard needs live configuration.
const readiness = '  }, hasThread(y) {\n    return o.getProviderSession(y) !== null;\n  }, getLiveThreadIds()';
const legacyReady = '  }, hasThread(y) {\n    return s.has(y) && o.getProviderSession(y) !== null;\n  }, getLiveThreadIds()';
const ready = '  }, hasThread(y) {\n    return o.getProviderSession(y) !== null;\n  }, hasLiveThreadSession(y) {\n    return s.has(y) && o.getProviderSession(y) !== null;\n  }, getLiveThreadIds()';
const resumeGuard = '  if (r.runtime.hasThread(t.threadId)) return;\n  if (!o.providerThreadId)';
const liveResumeGuard = '  if (r.runtime.hasLiveThreadSession(t.threadId)) return;\n  if (!o.providerThreadId)';
const anchor = '  function D(y) {\n    let R = o.resolveProviderForThread(y), _ = s.get(y);';
const dispatch = 'dispatchHistory(_, R, o, e, Pn)';
const observedDispatch = 'dispatchHistory(_, R, o, nativeHistoryOptions, Pn)';
const stopGuard = '  if (n.runtime.hasThread(e.threadId)) {\n    if (e.type === "thread.stop"';
const scopedStopGuard = '  if (n.runtime.hasThread(e.threadId) || n.runtime.getProviderSession(e.threadId) !== null) {\n    if (e.type === "thread.stop"';
const observer = `  const nativeHistoryOptions = { ...e, onNativeHistory: e.onNativeHistory && (async request => {
    const receipt = await e.onNativeHistory(request);
    // Only an authenticated committed Core ACK updates existing SDK bookkeeping.
    // No history events are re-ingested and no second execution loop is created.
    if (request.snapshot && receipt.threadId === request.threadId && !receipt.deferred && typeof receipt.turnId === 'string') {
      const status = request.snapshot.status;
      if (['working', 'completed', 'failed', 'interrupted'].includes(status)) {
        const event = { type: status === 'working' ? 'turn/started' : 'turn/completed',
          threadId: request.threadId, scope: { kind: 'turn', turnId: receipt.turnId } };
        w.observe(event);
        sr(event);
      }
    }
    return receipt;
  }) };
`;
export function patchNativeChildRuntime(source) {
  // The build tool separately verifies the admitted input bundle fingerprint.
  // Normalize the previous local overlay without weakening identity lookup again.
  if (source.includes(legacyReady)) source = source.replace(legacyReady, readiness);
  if (source.includes(ready) && source.includes(liveResumeGuard) && source.includes(observedDispatch) && source.includes(observer) && source.includes(scopedStopGuard)) return source;
  for (const needle of [readiness, resumeGuard]) assert.equal(source.split(needle).length, 2, 'Unsupported BB native-child runtime seam');
  if (!source.includes(observer)) {
    assert.equal(source.split(anchor).length, 2, 'Unsupported BB native-child runtime seam');
    source = source.replace(anchor, observer + anchor);
  }
  if (!source.includes(observedDispatch)) {
    assert.equal(source.split(dispatch).length, 2, 'Unsupported BB native-child runtime seam');
    source = source.replace(dispatch, observedDispatch);
  }
  if (!source.includes(scopedStopGuard)) {
    assert.equal(source.split(stopGuard).length, 2, 'Unsupported BB native-child runtime seam');
    source = source.replace(stopGuard, scopedStopGuard);
  }
  return source.replace(readiness, ready).replace(resumeGuard, liveResumeGuard);
}

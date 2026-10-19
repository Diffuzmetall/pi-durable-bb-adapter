import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import lockfile from 'proper-lockfile';
import { dirname, join, relative, resolve } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Type, fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, defineExtension, defineTool, Harness, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createSubagent, ChildBindingDoc, SubagentsDoc, TeamDoc } from '@bb-durable/native-subagents';
import { registerReadService } from '../../src/local-host/read-service.ts';
import { readCoherentOutcome } from '../../src/outcome/coherent.ts';
import { projectCoherentHistory } from '../../src/history/history-projector.ts';
import { createDurableBindingStore, createDurableBindingReader } from '../../src/store/binding-store.ts';

// Injected by the ordinary build-time native-owner alias; never resolved by a runtime hook.
const nativeOwner = __COHERENT_NATIVE_OWNER__;
const CHILD_INPUT = 'coherent-child:one-original-faux-task';
const CHILD_REPORT = { status: 'done', summary: 'COHERENT_FAUX_NATIVE_CHILD_OK', changes: [], verify: [], outputs: [], needs: [] };

async function location({directory,cwd,placement='private'}){
  assert.equal(placement,'private','Public fixtures never use a global/live agent store');
  cwd=await realpath(resolve(cwd));directory=resolve(directory);
  const hash=createHash('sha256').update(cwd).digest('hex').slice(0,24),agentDir=join(directory,'agent');
  const sessionsRoot=join(agentDir,'experimental/durable-sessions',hash);
  await mkdir(directory,{mode:0o700});await mkdir(sessionsRoot,{recursive:true,mode:0o700});
  const nativeSessionUuid=randomUUID(),nativeSessionId=`${String(Date.now()).padStart(13,'0')}-${nativeSessionUuid}`;
  const sessionDirectory=join(sessionsRoot,nativeSessionId);
  await assert.rejects(lstat(`${sessionDirectory}.lock`),{code:'ENOENT'});
  await mkdir(sessionDirectory,{mode:0o700});
  return {directory:await realpath(directory),cwd,placement,agentDir,sessionsRoot,nativeSessionId,nativeSessionUuid,sessionDirectory,database:join(sessionDirectory,'session.sqlite')};
}

async function withOwner(metadata, run, responses) {
  const provider = fauxProvider(), models = createModels(), registry = createRegistry();
  models.setProvider(provider.provider);
  // Explicit fixture-only Hindsight lifecycle/admission stubs, NOT production admission proof.
  const admissionCalls = [];
  const admit = async (conversation, requestId) => { admissionCalls.push({ conversationId: conversation.id, requestId }); };
  const controller = { async bind() {}, async close() {}, async submit(conversation, content, whenBusy, requestId) {
    await admit(conversation, requestId, context);
    return conversation.submit({ type: 'input', content, whenBusy, requestId }, context);
  } };
  const extension = defineExtension({ name: 'hindsight' });
  Object.defineProperty(extension, Symbol.for('pi.durable.hindsight.controller'), { value: controller });
  registry.install(extension);
  registry.install(createSubagent(admit));
  registry.install(defineExtension({ name: 'fixture-history-tool', tools: [defineTool({
    name: 'fixture_history_echo', description: 'Synthetic echo; no shell, network or external side effects.',
    replay: 'safe', callers: ['model'], parameters: Type.Object({ value: Type.String() }),
    execute: async args => ({ output: [{ type: 'text', text: args.value }] }),
  })] }));
  let read, control;
  registerReadService(registry, { revision: 'coherent-faux-fixture',
    registration: { grantPath: join(metadata.directory, 'unused-fixture-grant'),
      ownerScope: { providerId: 'pi-durable', sessionId: 'fixture-session', parentThreadId: 'fixture-parent' } },
    bind(facade, _context, _pair, controls) { read = facade; control = controls; return { close() {} }; } });
  const counts = { childModelCalls: 0, parentModelCalls: 0, modelCalls: 0 };
  provider.setResponses(Array.from({ length: 12 }, () => transcript => {
    counts.modelCalls++;
    if (typeof responses === 'function') return responses(transcript, counts);
    if (!responses) throw Error('coherent reopen must not invoke any model');
    const user = transcript.messages.findLast(m => m.role === 'user');
    const content = typeof user?.content === 'string' ? user.content : '';
    if (content === CHILD_INPUT) { counts.childModelCalls++; return fauxAssistantMessage(JSON.stringify(CHILD_REPORT)); }
    counts.parentModelCalls++;
    if (content.startsWith('Subagent ') || transcript.messages.at(-1)?.role === 'toolResult') return fauxAssistantMessage('FAUX_PARENT_ACK');
    return fauxAssistantMessage(fauxToolCall('subagent', JSON.parse(content)), { stopReason: 'toolUse' });
  }));
  const release = await lockfile.lock(metadata.sessionDirectory, { realpath: false, retries: 0 });
  let storage, session;
  try {
    storage = await openNodeSqliteStorage(metadata.database); await chmod(metadata.database, 0o600);
    session = await Harness.open(storage, { registry, models }, context);
    await controller.bind({ session, storage, directory: metadata.sessionDirectory, context });
    assert.ok(read, 'real read-service must capture its facade');
    return await run({ session, storage, read, control, provider, counts, admissionCalls });
  } finally {
    try { await controller.close(); }
    finally {
      try {
        if (session) {
          await session.close(context);
          const ended = await session.closed;
          if (ended.reason === 'failed') throw ended.error;
          assert.equal(ended.reason, 'closed');
        }
        else if (storage) await storage.close(context);
      } finally { await release(); }
    }
  }
}

async function entries(conversation) {
  const page = await conversation.entries({ order: 'ascending' }, 100, undefined, context);
  assert.equal(page.next, undefined); return page.items;
}

export async function seedCoherentNativeChild({ testBinding, ...options }) {
  const sdk = JSON.parse(await readFile(new URL(import.meta.resolve('@earendil-works/pi-durable/package.json')), 'utf8'));
  assert.equal(sdk.version, '1.3.0');
  const metadata = { protocol: 'bb-coherent-faux-native-child/v1', ...await location(options), nativeOwner,
    provenance: { testOnly: true, fauxModel: true, sdk: sdk.version, actualModel: false, nativeCliE2E: false,
      actualNativeSubagentOwner: true, productionAdmission: false, productionPairing: false }, ownerClosed: false };
  await withOwner(metadata, async ({ session, read, provider, counts, admissionCalls }) => {
    const model = provider.getModel();
    const parent = await session.root(context, { agent: { cwd: metadata.cwd,
      model: { provider: model.provider, modelId: model.id } } });
    assert.equal(parent.id, ROOT_CONVERSATION_ID);
    const parentRequestId = `fixture-faux-native-spawn:${metadata.nativeSessionUuid}`;
    const spawn = { task: CHILD_INPUT, name: 'coherent-faux-child', requestId: parentRequestId, background: true };
    const parentSubmission = await parent.submit({ type: 'input', content: JSON.stringify(spawn), requestId: parentRequestId }, context);
    assert.equal((await parentSubmission.wait(context)).status, 'done');
    const agents = await session.snapshot(SubagentsDoc, parent.id, context);
    const records = Object.values(agents.agents); assert.equal(records.length, 1);
    const record = records[0]; assert.ok(record.reporter);
    assert.equal((await session.waitForTask(record.reporter, context)).state.outcome.status, 'completed');
    // Reporter may create Courier; join actual background work as well as root/child runs.
    for (let round = 0; round < 10; round++) {
      const { tasks } = await session.inspect(context);
      if (!tasks.length) break;
      await Promise.all(tasks.map(task => session.waitForTask(task.record.id, context)));
    }
    await session.waitForIdle(context);
    assert.equal((await session.inspect(context)).tasks.length, 0);
    const child = await session.conversation(record.conversationId, context); assert.ok(child);
    // Default UNBOUND: the actual provider must be free to register real BB IDs.
    const binding = testBinding === undefined ? null : { ...testBinding, conversationId: child.id };
    if (binding) await createDurableBindingStore(session, context).put(binding);
    const nativeBinding = (await session.snapshot(ChildBindingDoc, child.id, context)).binding;
    const team = await session.snapshot(TeamDoc, parent.id, context);
    assert.equal(nativeBinding.parent, parent.id);
    assert.equal(nativeBinding.anchor, record.ownerTaskId);
    assert.equal(Object.values(team.executions).length, 1);
    assert.ok(Object.values(team.executions)[0].done?.answerRef);
    const outcome = await readCoherentOutcome(read, child.id, context);
    assert.equal(outcome.status, 'completed', JSON.stringify(outcome));
    const childEntries = await entries(child), parentEntries = await entries(parent);
    const result = childEntries.find(entry => entry.id === outcome.answer); assert.ok(result);
    const inputCount = childEntries.filter(entry => entry.kind === 'pi.user').length;
    const resultCount = childEntries.filter(entry => entry.kind === 'pi.assistant').length;
    assert.equal(inputCount, 1); assert.equal(resultCount, 1); assert.equal(counts.childModelCalls, 1);
    assert.equal(counts.modelCalls, counts.childModelCalls + counts.parentModelCalls);
    const finalAgents = await session.snapshot(SubagentsDoc, parent.id, context);
    assert.equal(finalAgents.agents[nativeBinding.key].settled, true);
    assert.equal(finalAgents.sending, undefined); assert.equal(finalAgents.deliveryHold, undefined);
    assert.equal(finalAgents.outbox?.length ?? 0, 0);
    Object.assign(metadata, { rootConversationId: parent.id, parentConversationId: parent.id, conversationId: child.id,
      anchorTaskId: record.ownerTaskId, reporterTaskId: record.reporter, requestId: record.requestId,
      parentRequestId, parentSubmissionId: parentSubmission.id, submissionId: outcome.submissionId,
      binding, nativeBinding, nativeRecord: finalAgents.agents[nativeBinding.key], nativeTeam: team,
      outcome, input: CHILD_INPUT, inputCount, resultCount, result, childEntries, parentEntries,
      childEntryCount: childEntries.length, parentEntryCount: parentEntries.length,
      parentInputCount: parentEntries.filter(entry => entry.kind === 'pi.user').length, ...counts, admissionCalls });
  }, true);
  metadata.ownerClosed = true;
  const metadataPath = join(metadata.directory, 'coherent-seed.json');
  await writeFile(metadataPath, JSON.stringify({ ...metadata, metadataPath }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { ...metadata, metadataPath };
}

export async function verifyCoherentNativeChild(metadata) {
  assert.equal(metadata.protocol, 'bb-coherent-faux-native-child/v1'); assert.equal(metadata.ownerClosed, true);
  assert.deepEqual(metadata.nativeOwner, nativeOwner, 'use the SAME build-selected owner');
  return withOwner(metadata, async ({ session, read, counts }) => {
    const parent = await session.root(context); assert.equal(parent.id, metadata.parentConversationId);
    const child = await session.conversation(metadata.conversationId, context); assert.ok(child);
    const outcome = await readCoherentOutcome(read, child.id, context);
    assert.equal(outcome.status, 'completed'); assert.deepEqual(outcome, metadata.outcome);
    assert.deepEqual(await entries(child), metadata.childEntries);
    assert.deepEqual(await entries(parent), metadata.parentEntries);
    assert.deepEqual((await session.snapshot(ChildBindingDoc, child.id, context)).binding, metadata.nativeBinding);
    assert.deepEqual(await session.snapshot(TeamDoc, parent.id, context), metadata.nativeTeam);
    assert.deepEqual((await session.snapshot(SubagentsDoc, parent.id, context)).agents[metadata.nativeBinding.key], metadata.nativeRecord);
    assert.deepEqual(await createDurableBindingReader(session, context).get(child.id), metadata.binding ?? undefined);
    assert.equal((await session.inspect(context)).tasks.length, 0); assert.equal(counts.modelCalls, 0);
    return { status: outcome.status, inputCount: metadata.inputCount, resultCount: metadata.resultCount,
      childEntryCount: metadata.childEntryCount, parentEntryCount: metadata.parentEntryCount,
      reopenModelCalls: counts.modelCalls, ownerClosed: true };
  }, false);
}

/** Real SDK/SQLite/native subagent owner, but explicitly faux model + echo tool. */
export async function verifyRichNativeChild(options) {
  const metadata = { ...await location(options), nativeOwner };
  const first = 'rich-native-child:first', second = 'rich-native-child:follow-up';
  const respond = (transcript, counts) => {
    const user = transcript.messages.findLast(message => message.role === 'user');
    const content = typeof user?.content === 'string' ? user.content : '';
    if (content === first || content === second) {
      counts.childModelCalls++;
      return transcript.messages.at(-1)?.role === 'toolResult'
        ? fauxAssistantMessage(content === first ? 'Natural language, deliberately not ChildReport' : '{"available_tools":["fixture_history_echo"]}')
        : fauxAssistantMessage(fauxToolCall('fixture_history_echo', { value: content }), { stopReason: 'toolUse' });
    }
    counts.parentModelCalls++;
    if (content.startsWith('Subagent ') || transcript.messages.at(-1)?.role === 'toolResult') return fauxAssistantMessage('FAUX_PARENT_ACK');
    return fauxAssistantMessage(fauxToolCall('subagent', JSON.parse(content)), { stopReason: 'toolUse' });
  };
  const settled = await withOwner(metadata, async ({ session, storage, read, control, provider, counts }) => {
    const model = provider.getModel();
    const parent = await session.root(context, { agent: { cwd: metadata.cwd, model: { provider: model.provider, modelId: model.id } } });
    async function send(action, task, requestId) {
      const input = { action, name: 'rich-child', task, requestId, background: true,
        ...(action === 'spawn' ? { tools: ['fixture_history_echo'] } : { followUp: true }) };
      const submission = await parent.submit({ type: 'input', content: JSON.stringify(input), requestId }, context);
      assert.equal((await submission.wait(context)).status, 'done');
      for (let round = 0; round < 10; round++) {
        const { tasks } = await session.inspect(context);
        if (!tasks.length) break;
        await Promise.all(tasks.map(task => session.waitForTask(task.record.id, context)));
      }
      await session.waitForIdle(context);
      assert.equal((await session.inspect(context)).tasks.length, 0);
    }
    await send('spawn', first, 'rich-fixture-spawn');
    let agents = await session.snapshot(SubagentsDoc, parent.id, context);
    const childId = Object.values(agents.agents)[0].conversationId;
    const original = await readCoherentOutcome(read, childId, context);
    assert.equal(original.status, 'completed', JSON.stringify(original));
    await send('send', second, 'rich-fixture-follow-up');
    agents = await session.snapshot(SubagentsDoc, parent.id, context);
    assert.equal(Object.values(agents.agents).length, 1);
    assert.equal(Object.values(agents.agents)[0].conversationId, childId);
    const team = await session.snapshot(TeamDoc, parent.id, context);
    assert.equal(Object.values(team.executions).length, 2);
    const outcome = await readCoherentOutcome(read, childId, context);
    assert.equal(outcome.status, 'completed', JSON.stringify(outcome));
    assert.equal(outcome.requestId, 'subagent-send:rich-fixture-follow-up');
    assert.notEqual(outcome.answer, original.answer);
    const projection = projectCoherentHistory(outcome);
    assert.equal(projection.snapshot.items.filter(entry => entry.item.type === 'userMessage').length, 2);
    assert.equal(projection.snapshot.items.filter(entry => entry.item.type === 'toolCall').length, 2);
    assert.equal(projection.snapshot.items.filter(entry => entry.item.type === 'agentMessage').length, 2);
    assert.equal(outcome.entries.filter(entry => entry.kind === 'pi.tool-result').length, 2);
    assert.deepEqual(await readCoherentOutcome(read, childId, context), outcome);
    const receipts = await storage.scanSubmissions({ conversationId: childId }, 100, undefined, context);
    assert.equal(receipts.items.filter(receipt => receipt.type === 'input').length, 2);
    assert.equal(typeof control, 'function');
    const binding = { providerId: 'pi-durable', sessionId: 'fixture-session', parentThreadId: 'fixture-parent',
      conversationId: childId, bbThreadId: 'fixture-child' };
    await createDurableBindingStore(session, context).put(binding);
    const command = { type: 'prompt', message: second, requestId: 'bb-child:fixture-human-input' };
    const admitted = await control(binding, command, context);
    const child = await session.conversation(childId, context);
    await child.waitForIdle(context);
    assert.deepEqual(await control(binding, command, context), admitted);
    await child.waitForIdle(context);
    await assert.rejects(control({ ...binding, parentThreadId: 'foreign-parent' }, command, context), /REFUSED/);
    const humanOutcome = await readCoherentOutcome(read, childId, context);
    assert.equal(humanOutcome.status, 'completed', JSON.stringify(humanOutcome));
    assert.equal(humanOutcome.requestId, command.requestId);
    const humanProjection = projectCoherentHistory(humanOutcome);
    assert.equal(humanProjection.snapshot.items.filter(entry => entry.item.type === 'userMessage').length, 3);
    assert.equal(humanProjection.snapshot.items.filter(entry => entry.item.type === 'toolCall').length, 3);
    return { childId, outcome: humanOutcome, projection: humanProjection, counts: { ...counts } };
  }, respond);
  const reopened = await withOwner(metadata, async ({ session, storage, read, counts }) => {
    const outcome = await readCoherentOutcome(read, settled.childId, context);
    assert.deepEqual(outcome, settled.outcome);
    assert.deepEqual(projectCoherentHistory(outcome), settled.projection);
    assert.equal(counts.modelCalls, 0);
    const receipts = await storage.scanSubmissions({ conversationId: settled.childId }, 100, undefined, context);
    assert.equal(receipts.items.filter(receipt => receipt.type === 'input').length, 3);
    return { reopenModelCalls: counts.modelCalls };
  }, false);
  return { status: 'pass', provenance: 'real SDK 1.3/SQLite/native owner; faux model and echo tool; not native CLI/browser acceptance',
    childConversationId: settled.childId, userInputs: 3, toolResults: 3, duplicateControlInputs: 0, ...settled.counts, ...reopened };
}


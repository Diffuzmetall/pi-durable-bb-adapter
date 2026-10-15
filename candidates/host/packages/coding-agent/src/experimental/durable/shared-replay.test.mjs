import test from 'node:test';
import assert from 'node:assert/strict';
import {createSharedReplay} from './shared-replay.ts';
const message=text=>({role:'assistant',content:[{type:'text',text}],usage:{},timestamp:1});
const snapshot=text=>({type:'snapshot',entries:[],run:{inputs:[]},generation:{attempt:1,message:message(text)},
 tools:[{callId:'parent',name:'subagent',status:'running',details:{conversationId:2}}],nestedTools:[],compactions:[],inbox:[],agent:{},usage:{}});
const text=events=>events.filter(e=>e.type==='message_update').flatMap(e=>e.changes).filter(c=>c.type==='text_delta').map(c=>c.delta).join('');
test('replacement snapshots reconcile delivered partial text and tool identities',()=>{
 const replay=createSharedReplay(false);
 const initial=replay([snapshot('hel')]);
 assert.equal(text(initial),'hel');
 assert.equal(initial.filter(e=>e.type==='tool_execution_start').length,1);
 replay([{type:'message_update',usage:{},changes:[{type:'text_delta',contentIndex:0,delta:'l'}]}]);
 const replacement=replay([snapshot('hello')]);
 assert.equal(text(replacement),'o');
 assert.equal(replacement.filter(e=>e.type==='tool_execution_start'||e.type==='run_start').length,0);
 assert.equal(text(replay([snapshot('hello')])),'');
 const finished={...snapshot(''),run:undefined,generation:undefined,tools:[],entries:[{id:2,model:[message('hello')]}]};
 const recovered=replay([finished]);
 assert.equal(recovered.filter(e=>e.type==='message_end').length,1);
 assert.equal(recovered.filter(e=>e.type==='tool_execution_end').length,1);
 assert.equal(recovered.filter(e=>e.type==='run_end').length,1);
 assert.equal(replay([finished]).filter(e=>e.type!=='snapshot').length,0);
});
test('a completed child is restored once, including text and scoped completion',()=>{
 const replay=createSharedReplay(true);
 const finished={...snapshot(''),run:undefined,generation:undefined,tools:[],entries:[{id:3,model:[message('child done')]}]};
 const initial=replay([finished]);
 assert.equal(text(initial),'child done');
 assert.equal(initial.filter(e=>e.type==='run_end').length,1);
 assert.equal(replay([finished]).filter(e=>e.type!=='snapshot').length,0);
 const advanced={...finished,entries:[...finished.entries,{id:4,model:[{role:'system',content:''}]}]};
 assert.equal(replay([advanced]).filter(e=>e.type!=='snapshot').length,0,'a non-assistant tail must not replay the completed answer');
});
test('a replacement spanning different runs recovers their boundary in order',()=>{
 const replay=createSharedReplay(false);
 replay([{...snapshot('first partial'),tools:[],run:{inputs:[1]}}]);
 const next={...snapshot('second partial'),tools:[],run:{inputs:[2]},entries:[{id:1,model:[message('first complete')]}]};
 const events=replay([next]);
 assert.deepEqual(events.filter(e=>['message_end','run_end','run_start'].includes(e.type)).map(e=>e.type),['message_end','run_end','run_start']);
 assert.equal(text(events),'second partial');
 assert.equal(replay([next]).filter(e=>e.type!=='snapshot').length,0);
});

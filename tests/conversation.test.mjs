import test from 'node:test';
import assert from 'node:assert/strict';
import {createReply,applyAdvisorEvent} from '../web/src/conversation.js';

test('summary and answer arrive independently; complete commands appear only in the final answer',()=>{
  const reply=createReply();
  applyAdvisorEvent(reply,{type:'reasoning_summary',text:'已知证据摘要',source:'answer-summary'});
  applyAdvisorEvent(reply,{type:'answer_delta',delta:'第一段'});
  applyAdvisorEvent(reply,{type:'status',message:'连接正在恢复'});
  assert.equal(reply.text,'第一段');assert.equal(reply.summary,'已知证据摘要');assert.deepEqual(reply.commands,[]);assert.equal(reply.pending,true);
  applyAdvisorEvent(reply,{type:'answer_delta',delta:'\n第二段'});
  applyAdvisorEvent(reply,{type:'answer',answer:'第一段\n第二段',commands:[{title:'check',command:'echo ok',panel:'runner'}]});
  assert.equal(reply.pending,false);assert.equal(reply.text,'第一段\n第二段');assert.equal(reply.commands.length,1);
});
test('an interrupted stream preserves received text and summary separately from the error',()=>{
  const reply=createReply();
  applyAdvisorEvent(reply,{type:'reasoning_summary',text:'摘要',source:'model-summary'});
  applyAdvisorEvent(reply,{type:'answer_delta',delta:'已经收到的正文'});
  applyAdvisorEvent(reply,{type:'error',message:'连接断开'});
  assert.equal(reply.text,'已经收到的正文');assert.equal(reply.summary,'摘要');assert.equal(reply.error,'连接断开');assert.equal(reply.pending,false);
});

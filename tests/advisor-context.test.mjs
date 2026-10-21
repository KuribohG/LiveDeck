import test from 'node:test';
import assert from 'node:assert/strict';
import {advisorContext} from '../web/src/advisor-context.js';
import {DeckStore} from '../web/src/model.js';

test('AI context preserves chat ownership, offscreen targets and full prior suggestions', () => {
  const deck={id:'context-test',title:'Report',terminals:{runner:{label:'Run',commands:[]}},
    dashboards:{chart:{label:'Current chart',url:'https://grafana.example/d-solo/a/chart?panelId=1',commands:[]},
                other:{label:'Other slide',url:'https://grafana.example/d-solo/b/other?panelId=2',commands:[]}}};
  const storage={getItem:()=>null,setItem:()=>{}},store=new DeckStore(deck,storage);
  const suggestion={title:'Replace',panel:'chart',command:deck.dashboards.other.url,note:'Source panel 2'};
  store.terminal('runner').conversation=[{role:'assistant',text:'Previous answer',summary:'Evidence',commands:[suggestion]}];
  const requested=[];
  const workspace={visible:['chart'],context:ids=>{requested.push(...ids);return ids.map(id=>({id}));},
    follows:()=>false,sessionId:id=>id};
  const productState={version:1,deck:{effectiveRevision:'deck-test'},capabilities:{operations:['chart.set']}};
  const context=advisorContext({question:'Continue',deck,store,workspace,pool:{history:()=> 'Observed output'},
    sequence:{steps:[],state:{cursor:0}},slide:{title:'Other slide',layout:'workspace',panels:['chart']},
    conversationPanel:'runner',operationPanel:'chart',productState});
  assert.equal(context.conversation_panel,'runner');assert.equal(context.operation_panel,'chart');
  assert.deepEqual(requested,['runner','chart']);
  assert.ok(context.panel_catalog.some(p=>p.id==='other'&&p.label==='Other slide'));
  assert.deepEqual(context.conversation[0].commands,[suggestion]);
  assert.equal(context.conversation[0].summary,'Evidence');
  assert.equal(context.terminal_history,'Observed output');
  assert.deepEqual(context.product_state,productState);
});

import importlib.util
from pathlib import Path
import json
import unittest
spec = importlib.util.spec_from_file_location('advisor', Path(__file__).resolve().parents[1] / 'backend/advisor.py')
advisor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(advisor)

class ContextTest(unittest.TestCase):
    def test_grafana_selectors_tabs_and_previous_suggestions_survive(self):
        url = 'https://grafana.example/d-solo/real/graph?panelId=103&var-ClientPod=run-before&var-ClientPod=run-after'
        binding = {'terminal':'runner', 'tab':'main', 'params':{'var-ClientPod':'pod'},
                   'paramSuffixes':{'var-ClientPod':['-before','-after']}}
        suggestion = {'title':'吞吐图', 'panel':'chart', 'command':url, 'note':'真实 panel 103'}
        context = advisor.bounded_context({'question':'换图', 'terminal':'runner', 'operation_panel':'chart',
            'panels':[{'id':'chart', 'kind':'dashboard', 'label':'读取吞吐', 'url':url, 'base_url':url,
                       'binding':binding, 'run':{'fields':{'pods':['run-before','run-after'], 'count':2}}},
                      {'id':'runner','active_tab':'fio','tabs':[{'id':'fio','label':'fio','cwd':'/work', 'history':'observed'}]}],
            'panel_catalog':[{'id':'offscreen','label':'另一页','kind':'dashboard','url':url}],
            'conversation':[{'role':'assistant','text':'建议换图','summary':'已核实来源', 'commands':[suggestion]}]})
        self.assertEqual(context['conversation_panel'], 'runner')
        self.assertEqual(context['operation_panel'], 'chart')
        self.assertEqual(context['panels'][0]['binding'], binding)
        self.assertEqual(context['panels'][0]['label'], '读取吞吐')
        self.assertEqual(context['panels'][0]['run']['fields']['pods'], ['run-before','run-after'])
        self.assertEqual(context['panels'][0]['run']['fields']['count'], 2)
        self.assertEqual(context['panels'][1]['tabs'][0]['history'], 'observed')
        self.assertEqual(context['panel_catalog'][0]['id'], 'offscreen')
        self.assertEqual(context['conversation'][0]['commands'][0]['command'], url)
        self.assertEqual(context['conversation'][0]['summary'], '已核实来源')

    def test_recent_conversation_wins_and_omissions_are_explicit(self):
        context = advisor.bounded_context({'question':'继续', 'conversation_total':50,
            'conversation':[{'role':'assistant','text':str(i)+':'+'x'*6000} for i in range(16)]})
        self.assertTrue(context['conversation'][-1]['text'].startswith('15:'))
        self.assertTrue(context['conversation'][-1]['text_truncated'])
        self.assertEqual(context['truncation']['conversation_omitted'], 50-len(context['conversation']))

    def test_late_command_and_cross_panel_history(self):
        request = {'question':'下一步？', 'plan_window':{'total':10000,'selected':9500,'start':9490},
                   'current_step':{'title':'Late step','command':'echo 9500'},
                   'plan':[{'title':str(i),'command':f'echo {i}'} for i in range(9490,9531)],
                   'panels':[{'id':'runner','history':'observed runner output'}, {'id':'logs','history':'observed log output'}],
                   'sequence':{'total':20000,'cursor':9500,'upcoming':[{'panel':'logs','action':{'command':'tail log'}}]}}
        context=advisor.bounded_context(request)
        self.assertEqual(context['plan_window']['selected'],9500)
        self.assertTrue(any(p['command']=='echo 9500' for p in context['plan']))
        self.assertEqual(context['panels'][1]['history'],'observed log output')
        self.assertEqual(context['sequence']['upcoming'][0]['panel'],'logs')
    def test_non_json_answer_is_preserved_without_unsafe_suggestions(self):
        self.assertEqual(advisor.parse_answer('Here is the answer.'), {'answer':'Here is the answer.', 'commands':[]})
        self.assertEqual(advisor.parse_answer('```json\n{"answer":"ok","commands":[]}\n```')['answer'], 'ok')

    def test_monitoring_context_keeps_reported_state_and_group_steps(self):
        request = {'question': '监控谁？', 'panels': [{'id': 'metrics', 'following': False,
                   'run': {'run_id': 'r1', 'status': 'ready', 'fields': {'task_id': '42'}}}],
                   'sequence': {'upcoming': [{'group': 'system', 'title': '系统监控'}]}}
        context = advisor.bounded_context(request)
        self.assertFalse(context['panels'][0]['following'])
        self.assertEqual(context['panels'][0]['run']['fields']['task_id'], '42')
        self.assertEqual(context['sequence']['upcoming'][0]['group'], 'system')

    def test_product_state_keeps_effective_revision_evidence_and_limits(self):
        request = {'question': '当前图表是否已经拿到数据？', 'product_state': {
            'version': 1,
            'deck': {'effectiveRevision': 'deck-1234', 'configSource': 'browser'},
            'view': {'slideIndex': 2, 'currentPanel': 'latency'},
            'capabilities': {'operations': ['chart.set', 'monitor.set'], 'metricCatalog': {'version': 1}},
            'missing': ['延迟：等待运行信息'],
            'panels': [{'id': 'latency', 'kind': 'dashboard', 'active': True, 'visible': True,
                        'run': None, 'chartEvidence': {'error': '尚未读取数据'},
                        'unbounded': 'must not be forwarded'}],
        }}
        context = advisor.bounded_context(request)
        self.assertEqual(context['product_api']['deck']['effectiveRevision'], 'deck-1234')
        self.assertEqual(context['product_api']['panels'][0]['chartEvidence']['error'], '尚未读取数据')
        self.assertEqual(context['product_api']['missing'], ['延迟：等待运行信息'])
        self.assertNotIn('unbounded', context['product_api']['panels'][0])

    def test_budget_remains_bounded_for_long_data(self):
        request={'question':'q'*10000,'terminal_history':'x'*200000,
                 'current_step':{'title':'t'*10000,'command':'c'*10000,'note':'n'*10000},
                 'plan':[{'title':'x'*10000,'command':'y'*10000}]*10000,
                 'panels':[{'id':str(i),'history':'z'*10000} for i in range(100)],
                 'conversation':[{'text':'c'*10000}]*20}
        self.assertLess(len(json.dumps(advisor.bounded_context(request))),120000)

if __name__=='__main__': unittest.main()

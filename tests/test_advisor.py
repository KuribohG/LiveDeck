import importlib.util
from pathlib import Path
import json
import unittest
spec = importlib.util.spec_from_file_location('advisor', Path(__file__).resolve().parents[1] / 'backend/advisor.py')
advisor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(advisor)

class ContextTest(unittest.TestCase):
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

    def test_budget_remains_bounded_for_long_data(self):
        request={'question':'q'*10000,'terminal_history':'x'*200000,
                 'current_step':{'title':'t'*10000,'command':'c'*10000,'note':'n'*10000},
                 'plan':[{'title':'x'*10000,'command':'y'*10000}]*10000,
                 'panels':[{'id':str(i),'history':'z'*10000} for i in range(100)],
                 'conversation':[{'text':'c'*10000}]*20}
        self.assertLess(len(json.dumps(advisor.bounded_context(request))),120000)

if __name__=='__main__': unittest.main()

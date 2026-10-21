import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('codex_stream', ROOT / 'backend/codex_stream.py')
stream = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stream)
ARTIFACTS = ROOT.parent / 'live-deck-ai-streaming-20261019'


class StreamTest(unittest.TestCase):
    def test_skill_reader_uses_live_source_and_rejects_escape(self):
        ARTIFACTS.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=ARTIFACTS) as directory:
            base=Path(directory); root=base/'skill'; root.mkdir()
            (root/'SKILL.md').write_text('instructions\n')
            (root/'reference.md').write_text('first\nsecond\nthird\n')
            outside=base/'outside.txt'; outside.write_text('PRIVATE_MARKER')
            (root/'escape.md').symlink_to(outside)
            reader=stream.SkillFiles([{'name':'shared','path':str(root/'SKILL.md')}])
            result=reader.call({'skill':'shared','path':'reference.md','operation':'read','start_line':2,'line_count':1})
            self.assertEqual(result['text'],'2: second'); self.assertEqual(result['next_line'],3)
            (root/'reference.md').write_text('updated live source\n')
            self.assertIn('updated live source',reader.call({'skill':'shared','path':'reference.md','operation':'read'})['text'])
            for path in ('../outside.txt', str(outside), 'escape.md'):
                with self.assertRaises(ValueError): reader.call({'skill':'shared','path':path,'operation':'read'})

    def test_tool_activity_does_not_publish_arguments_or_results(self):
        events=[]; reader=stream.PublicStream(events.append)
        for method in ('item/started', 'item/completed'):
            reader.consume(method, {'item':{'id':'tool','type':'mcpToolCall','tool':'get_dashboard_summary',
                'arguments':{'token':'SECRET_MARKER'},'result':'SECRET_MARKER', 'status':'completed'}})
        self.assertEqual([e['phase'] for e in events], ['started','completed'])
        self.assertEqual(events[-1]['tool'], 'get_dashboard_summary')
        self.assertNotIn('SECRET_MARKER', str(events))

    def test_partial_json_decodes_escapes_and_surrogate_pairs_without_showing_json(self):
        answer = '中文\n"quoted" \\ path 😀'
        encoded = json.dumps({'summary': '简短说明', 'commands': [{'answer': 'nested'}], 'answer': answer})
        previous = ''
        for end in range(len(encoded) + 1):
            value = stream.string_prefix(encoded[:end], 'answer')
            if value is not None:
                self.assertTrue(answer.startswith(value), (end, value))
                self.assertTrue(value.startswith(previous))
                previous = value
        self.assertEqual(previous, answer)
        self.assertEqual(stream.string_prefix('```json\n'+encoded+'\n```', 'answer'), answer)

    def test_public_summaries_and_final_messages_are_separate(self):
        events = []
        reader = stream.PublicStream(events.append)
        reader.consume('item/reasoning/textDelta', {'itemId': 'r', 'delta': 'PRIVATE_TEST_MARKER'})
        reader.consume('item/completed', {'item': {'id': 'r', 'type': 'reasoning', 'content': ['PRIVATE_TEST_MARKER'], 'summary': []}})
        self.assertEqual(events, [])
        reader.consume('item/reasoning/summaryTextDelta', {'itemId':'r', 'summaryIndex':0, 'delta':'公开摘要'})
        reader.consume('item/completed', {'item': {'id': 'r', 'type': 'reasoning', 'summary': ['公开摘要']}})
        self.assertEqual(len(events), 1)
        text = json.dumps({'summary':'输出摘要', 'answer':'完整回答', 'commands':[]}, ensure_ascii=False)
        for char in text:
            reader.consume('item/agentMessage/delta', {'itemId':'a', 'delta':char})
        before = len(events)
        reader.consume('item/completed', {'item': {'id':'a', 'type':'agentMessage', 'phase':'final_answer', 'text':text}})
        self.assertEqual(len(events), before)
        self.assertEqual(''.join(e['delta'] for e in events if e['type']=='answer_delta'), '完整回答')
        self.assertNotIn('PRIVATE_TEST_MARKER', str(events))

    def test_commentary_and_revised_final_text(self):
        events=[]; reader=stream.PublicStream(events.append)
        reader.consume('item/started', {'item':{'id':'c','type':'agentMessage','phase':'commentary','text':''}})
        reader.consume('item/agentMessage/delta', {'itemId':'c','delta':'正在检查公开数据'})
        self.assertEqual(reader.answer,'')
        self.assertEqual(events[-1]['type'],'progress')
        reader.publish_message('a','{"answer":"old"}')
        reader.publish_message('a','{"answer":"new"}')
        self.assertEqual(events[-1],{'type':'answer_replace','text':'new'})

    def test_real_stdio_transport_delivers_before_completion_and_cleans_up(self):
        ARTIFACTS.mkdir(exist_ok=True)
        program = r'''
import json,sys,time
def read():return json.loads(sys.stdin.readline())
def emit(value):print(json.dumps(value),flush=True)
assert read()['method']=='initialize';emit({'id':1,'result':{}})
assert read()['method']=='initialized'
assert read()['method']=='skills/list';emit({'id':4,'result':{'data':[{'skills':[{'name':'grafana','path':'/shared/grafana/SKILL.md','enabled':True}]}]}})
assert read()['method']=='thread/start';emit({'id':2,'result':{'thread':{'id':'thread'}}})
turn=read();assert turn['method']=='turn/start'
assert turn['params']['sandboxPolicy']=={'type':'readOnly','networkAccess':True}
assert turn['params']['input'][1]=={'type':'skill','name':'grafana','path':'/shared/grafana/SKILL.md'}
emit({'id':3,'result':{'turn':{'id':'turn'}}})
emit({'method':'item/agentMessage/delta','params':{'threadId':'wrong','turnId':'turn','itemId':'a','delta':'ignored'}})
text=json.dumps({'summary':'public','answer':'hello world','commands':[]})
split=text.index('world')
emit({'method':'item/agentMessage/delta','params':{'threadId':'thread','turnId':'turn','itemId':'a','delta':text[:split]}})
time.sleep(.2)
emit({'method':'item/agentMessage/delta','params':{'threadId':'thread','turnId':'turn','itemId':'a','delta':text[split:]}})
emit({'method':'item/completed','params':{'threadId':'thread','turnId':'turn','item':{'id':'a','type':'agentMessage','text':text}}})
emit({'method':'turn/completed','params':{'threadId':'thread','turn':{'id':'turn','status':'completed'}}})
time.sleep(30)
'''
        events=[]
        with tempfile.TemporaryFile(dir=ARTIFACTS) as errors:
            start=time.monotonic()
            result=stream.run_app_server([sys.executable,'-u','-c',program], 'q', {}, str(ROOT), 'test-model', 'instructions', os.environ.copy(), errors, lambda e:events.append((time.monotonic(),e)), 5, skill_names=['grafana'])
        self.assertEqual(json.loads(result)['answer'],'hello world')
        answers=[(t,e) for t,e in events if e['type']=='answer_delta']
        self.assertEqual(''.join(e['delta'] for _,e in answers),'hello world')
        self.assertGreater(answers[-1][0]-answers[0][0],.15)
        self.assertLess(time.monotonic()-start,5)

    def test_timeout_terminates_the_backend(self):
        ARTIFACTS.mkdir(exist_ok=True)
        with tempfile.TemporaryFile(dir=ARTIFACTS) as errors:
            with self.assertRaises(TimeoutError):
                stream.run_app_server([sys.executable,'-u','-c','import time;time.sleep(30)'], 'q', {}, str(ROOT), 'test-model', '', os.environ.copy(), errors, lambda _:None, .1)


if __name__ == '__main__':
    unittest.main()

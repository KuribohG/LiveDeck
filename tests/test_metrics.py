import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('metrics', Path(__file__).resolve().parents[1] / 'backend/metrics.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class MetricsTest(unittest.TestCase):
    def item(self):
        return {'metric':'fuse-read-latency', 'datasource':'ds', 'database':'hf3fs_hg', 'from':1000, 'to':9000,
                'runs':[{'host':'host', 'pod':'a', 'phase':'before', 'from':2000, 'to':4000},
                        {'host':'host', 'pod':'b', 'phase':'after', 'from':6000, 'to':0}]}

    def test_scopes_and_weighted_mean(self):
        queries, meta = m.query_spec(self.item())
        self.assertEqual(meta['unit'], 'ns')
        self.assertEqual(meta['aggregate'], 'sum(mean * count) / nullIf(sum(count), 0)')
        self.assertIn("host = 'host' AND pod = 'a'", queries[0]['rawSql'])
        self.assertIn('fromUnixTimestamp64Milli(4000)', queries[0]['rawSql'])
        self.assertIn('fromUnixTimestamp64Milli(6000)', queries[1]['rawSql'])
        longer = self.item(); longer['to'] = 20000
        self.assertEqual(queries[0],m.query_spec(longer)[0][0])

    def test_metric_contracts(self):
        for metric, expected in [('blob-read-throughput', 'blob_client.data_payload_bytes'),('blob-read-latency', 'avg(mean)'),('fuse-read-rate','sum(val) / 2')]:
            item = self.item(); item['metric'] = metric
            self.assertIn(expected, m.query_spec(item)[0][0]['rawSql'])

    def test_rejects_unbounded_or_injected_queries(self):
        for field,value in [('datasource','bad/uid'),('database','hf3fs_hg; DROP'),('metric','SELECT *'),('stepSeconds',True),('to',864000001)]:
            item = self.item(); item[field] = value
            with self.assertRaises(ValueError): m.query_spec(item)
        for value in ['All','',"a' OR 1=1",['a','b']]:
            item = self.item(); item['runs'][0]['pod'] = value
            with self.assertRaises(ValueError): m.query_spec(item)
        item=self.item();item['runs']=[]
        with self.assertRaises(ValueError): m.query_spec(item)

    def test_nulls_and_gaps_are_not_zero_or_connected(self):
        result={'frames':[{'schema':{'fields':[{'name':'time'},{'name':'value'}]},'data':{'values':[[2000,4000,10000],[2,None,5]]}}]}
        self.assertEqual(m.points_from(result,2000),[[2000,2],[4000,None],[6000,None],[10000,5]])
        with self.assertRaises(ValueError): m.points_from({'error':'failed'},2000)

    def test_missing_query_response_is_an_error(self):
        class Stub:
            url='https://grafana.example'
            def query(self,*args):return {'results':{}}
        with self.assertRaises(ValueError):m.fetch_panel(self.item(),Stub())


if __name__ == '__main__':
    unittest.main()

"""Bounded, read-only time series queries; credentials never leave the kernel."""
import base64
import json
import math
import os
from pathlib import Path
import re
import time
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler

METRIC_CATALOG = json.loads((Path(__file__).resolve().parent.parent / 'web/src/metric-catalog.json').read_text())
METRICS = {
    name: (item['table'], item['metric'], item['instance'], item['aggregate'], item['unit'])
    for name, item in METRIC_CATALOG['metrics'].items()
}
IDENTITY = r'[A-Za-z0-9][A-Za-z0-9_.():-]{0,199}'


def identifier(value, pattern, label):
    if not isinstance(value, str) or not re.fullmatch(pattern, value) or value.lower() == 'all':
        raise ValueError(f'需要明确的 {label}')
    return value


def milliseconds(value):
    if type(value) is not int or not 0 <= value < 10**15:
        raise ValueError('运行时间无效')
    return value


def query_spec(item, now=None):
    now = now if now is not None else time.time_ns() // 1_000_000
    if item.get('metric') not in METRICS:
        raise ValueError('未知监控指标')
    datasource = identifier(item.get('datasource'), r'[A-Za-z0-9_-]{1,100}', '数据源')
    database = identifier(item.get('database'), r'hf3fs_[A-Za-z0-9_]+', '数据库')
    step = item.get('stepSeconds', 2)
    if type(step) is not int or not 2 <= step <= 60:
        raise ValueError('采样间隔需要在 2–60 秒之间')
    start, end = milliseconds(item.get('from')), milliseconds(item.get('to')) or now
    if not 0 < end - start <= min(86400000, step * 1000 * 10000):
        raise ValueError('时间范围过长或无效，请缩小范围或增大采样间隔')
    runs = item.get('runs')
    if not isinstance(runs, list) or not 1 <= len(runs) <= 2:
        raise ValueError('需要一到两个实际上报的运行实例')
    table, metric, instance, aggregate, unit = METRICS[item['metric']]
    queries, metadata = [], []
    phases = set()
    for index, run in enumerate(runs):
        host = identifier(run.get('host'), IDENTITY, 'host')
        pod = identifier(run.get('pod'), IDENTITY, 'pod')
        phase = run.get('phase')
        if phase not in ('before', 'after', 'current') or phase in phases:
            raise ValueError('运行阶段无效或重复')
        phases.add(phase)
        lower, upper = milliseconds(run.get('from')), milliseconds(run.get('to')) or end
        if upper < lower:
            raise ValueError('运行结束时间早于开始时间')
        lower, upper = max(lower, start), min(upper, end)
        # Fixed bucket width preserves phase-one values as phase two is appended.
        sql = f"""SELECT toStartOfInterval(TIMESTAMP, INTERVAL {step} SECOND) AS time,
{aggregate.format(step=step)} AS value
FROM {database}.{table}
WHERE metricName = '{metric}' AND instance = '{instance}'
AND host = '{host}' AND pod = '{pod}'
AND TIMESTAMP >= fromUnixTimestamp64Milli({lower}) AND TIMESTAMP <= fromUnixTimestamp64Milli({upper})
GROUP BY time ORDER BY time ASC LIMIT 10002"""
        queries.append({'refId': chr(65 + index), 'datasource': {'uid': datasource, 'type': 'grafana-clickhouse-datasource'},
                        'rawSql': sql, 'format': 1, 'editorType': 'sql', 'queryType': 'table'})
        metadata.append({**run, 'from': lower, 'to': upper})
    return queries, {'from': start, 'to': end, 'step_ms': step * 1000, 'unit': unit,
                     'metric': metric, 'instance': instance, 'aggregate': aggregate.format(step=step), 'runs': metadata}


def points_from(result, step_ms):
    if not isinstance(result, dict) or result.get('error') or result.get('status', 200) >= 400:
        raise ValueError('Grafana 查询失败，请检查数据源和运行参数')
    points = {}
    for frame in result.get('frames', []):
        names = [f.get('name') for f in frame.get('schema', {}).get('fields', [])]
        if 'time' not in names or 'value' not in names:
            continue
        columns = frame.get('data', {}).get('values', [])
        for stamp, value in zip(columns[names.index('time')], columns[names.index('value')]):
            if type(stamp) not in (int, float) or not math.isfinite(stamp):
                continue
            points[int(stamp)] = value if type(value) in (int, float) and math.isfinite(value) else None
    if len(points) > 10001:
        raise ValueError('查询点数超限，请缩小时间范围')
    series = []
    for stamp, value in sorted(points.items()):
        if series and stamp - series[-1][0] > step_ms:
            series.append([series[-1][0] + step_ms, None])
        series.append([stamp, value])
    return series


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Grafana:
    def __init__(self):
        cfg = {}
        path = Path.home() / '.grafana.env'
        if path.exists():
            for line in path.read_text().splitlines():
                if line.strip() and not line.lstrip().startswith('#') and '=' in line:
                    key, value = line.split('=', 1)
                    cfg[key.strip()] = value.strip().strip('\"\'')
        cfg.update({k: v for k, v in os.environ.items() if k.startswith('GRAFANA_')})
        self.url = cfg.get('GRAFANA_URL', '').rstrip('/')
        parsed = urlsplit(self.url)
        if parsed.scheme != 'https' or not parsed.netloc or parsed.username or parsed.password:
            raise ValueError('服务端 Grafana 地址需要是 HTTPS 地址')
        self.headers = {'Content-Type': 'application/json'}
        if cfg.get('GRAFANA_TOKEN'):
            self.headers['Authorization'] = 'Bearer ' + cfg['GRAFANA_TOKEN']
        elif cfg.get('GRAFANA_USER'):
            token = base64.b64encode((cfg['GRAFANA_USER'] + ':' + cfg.get('GRAFANA_PASSWORD', '')).encode()).decode()
            self.headers['Authorization'] = 'Basic ' + token
        elif cfg.get('GRAFANA_COOKIE'):
            cookie = cfg['GRAFANA_COOKIE']
            self.headers['Cookie'] = cookie if '=' in cookie else 'grafana_session=' + cookie
        self.opener = build_opener(NoRedirect)

    def query(self, queries, start, end):
        request = Request(self.url + '/api/ds/query', headers=self.headers,
                          data=json.dumps({'queries': queries, 'from': str(start), 'to': str(end)}).encode())
        with self.opener.open(request, timeout=25) as response:
            return json.load(response)


def fetch_panel(item, grafana):
    queries, metadata = query_spec(item)
    data = grafana.query(queries, metadata['from'], metadata['to'])
    results = data.get('results', {})
    series = []
    for query, run in zip(queries, metadata.pop('runs')):
        if query['refId'] not in results:
            raise ValueError('Grafana 未返回该查询的结果')
        series.append({**run, 'points': points_from(results[query['refId']], metadata['step_ms'])})
    pane = {'ldk': {'datasource': item['datasource'], 'queries': [{**q, 'format': 0, 'queryType': 'timeseries'} for q in queries],
                    'range': {'from': str(metadata['from']), 'to': str(metadata['to'])}, 'compact': True}}
    source = grafana.url + '/explore?' + urlencode({'schemaVersion': 1, 'orgId': 1, 'panes': json.dumps(pane)})
    return {**metadata, 'series': series, 'queries': queries, 'source_url': source,
            'queried_at_ms': time.time_ns() // 1_000_000}


def answer(request):
    try:
        items = request.get('panels', [])
        if not isinstance(items, list) or len(items) > 12:
            raise ValueError('单次最多查询 12 张图')
        grafana, panels = Grafana(), []
        for item in items:
            try:
                result = fetch_panel(item, grafana)
            except ValueError as error:
                result = {'error': str(error)}
            except Exception:
                result = {'error': 'Grafana 查询失败，请稍后重试或检查服务端授权'}
            panels.append({'id': item.get('id'), 'key': item.get('key'), **result})
        event = {'type': 'answer', 'panels': panels}
    except Exception:
        event = {'type': 'error', 'message': '监控服务不可用，请检查服务端配置'}
    print('LIVE_DECK_METRICS ' + json.dumps(event, ensure_ascii=False, allow_nan=False), flush=True)

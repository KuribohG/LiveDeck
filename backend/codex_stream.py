"""Small stdio app-server client; only public summaries and messages reach the UI."""
from __future__ import annotations

import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import time


class SkillFiles:
    """Read the native skill sources without requiring a nested shell sandbox."""
    spec = {
        'type': 'function', 'name': 'skill_files',
        'description': 'Read or list the original shared skill files. Use for every SKILL.md, reference, script or template; no shell is needed. Paths are relative to the named skill directory (absolute paths inside it also work). Scripts are read as text, never executed. Use another skill name for cross-skill references.',
        'inputSchema': {'type': 'object', 'properties': {
            'skill': {'type': 'string'}, 'path': {'type': 'string'},
            'operation': {'type': 'string', 'enum': ['read', 'list']},
            'start_line': {'type': 'integer', 'minimum': 1},
            'line_count': {'type': 'integer', 'minimum': 1, 'maximum': 300},
        }, 'required': ['skill', 'path', 'operation'], 'additionalProperties': False},
    }

    def __init__(self, skills):
        self.roots = {s['name']: Path(s['path']).resolve().parent for s in skills}

    def call(self, args):
        root = self.roots.get(args.get('skill'))
        if root is None:
            raise ValueError('Unknown or disabled skill')
        path = (root / args.get('path', 'SKILL.md')).resolve(strict=True)
        if not path.is_relative_to(root) or any(p.startswith('.') for p in path.relative_to(root).parts):
            raise ValueError('Only files inside this skill directory are readable')
        if args.get('operation') == 'list':
            entries = sorted(p.name + ('/' if p.is_dir() else '') for p in path.iterdir() if not p.name.startswith('.'))
            return {'path': str(path), 'entries': entries[:200], 'truncated': len(entries) > 200}
        if args.get('operation') != 'read' or not path.is_file():
            raise ValueError('Expected a readable skill file')
        if path.stat().st_size > 2_000_000:
            raise ValueError('File too large; select a smaller reference')
        start = max(1, int(args.get('start_line', 1)))
        count = min(300, max(1, int(args.get('line_count', 200))))
        lines = path.read_text().splitlines()
        selected = []; size = 0
        for i in range(start - 1, min(len(lines), start - 1 + count)):
            line = f'{i + 1}: {lines[i]}'
            if len(line) > 24000:
                raise ValueError('Line too long; select a different reference')
            if size + len(line) > 24000:
                break
            selected.append(line); size += len(line) + 1
        next_line = start + len(selected)
        return {'path': str(path), 'text': '\n'.join(selected), 'total_lines': len(lines),
                'next_line': next_line if next_line <= len(lines) else None}


def string_prefix(text: str, key: str) -> str | None:
    """Read a top-level JSON string while its closing quote has not arrived yet."""
    source = text.lstrip()
    if source.startswith('```'):
        if '\n' not in source:
            return None
        source = source.split('\n', 1)[1].lstrip()
    if not source.startswith('{'):
        return None
    decoder = json.JSONDecoder()
    pos = 1
    while pos < len(source):
        while pos < len(source) and source[pos] in ' \r\n\t,':
            pos += 1
        try:
            name, pos = decoder.raw_decode(source, pos)
        except ValueError:
            return None
        while pos < len(source) and source[pos].isspace():
            pos += 1
        if pos >= len(source) or source[pos] != ':':
            return None
        pos += 1
        while pos < len(source) and source[pos].isspace():
            pos += 1
        if name != key:
            try:
                _, pos = decoder.raw_decode(source, pos)
            except ValueError:
                return None
            continue
        if pos >= len(source) or source[pos] != '"':
            return None
        pos += 1
        result = []
        escapes = {'n': '\n', 'r': '\r', 't': '\t', 'b': '\b', 'f': '\f', '"': '"', '\\': '\\', '/': '/'}
        while pos < len(source):
            char = source[pos]
            if char == '"':
                return ''.join(result)
            if char != '\\':
                result.append(char)
                pos += 1
                continue
            if pos + 1 >= len(source):
                break
            escape = source[pos + 1]
            if escape in escapes:
                result.append(escapes[escape])
                pos += 2
            elif escape == 'u':
                if pos + 6 > len(source):
                    break
                try:
                    code = int(source[pos + 2:pos + 6], 16)
                    if 0xD800 <= code <= 0xDBFF:
                        if pos + 12 > len(source) or source[pos + 6:pos + 8] != '\\u':
                            break
                        low = int(source[pos + 8:pos + 12], 16)
                        if not 0xDC00 <= low <= 0xDFFF:
                            break
                        result.append(chr(0x10000 + (code - 0xD800) * 1024 + low - 0xDC00))
                        pos += 12
                    else:
                        result.append(chr(code))
                        pos += 6
                except ValueError:
                    break
            else:
                break
        return ''.join(result)
    return None


class PublicStream:
    def __init__(self, emit):
        self.emit = emit
        self.messages = {}
        self.phases = {}
        self.summaries = {}
        self.last_answer = ''
        self.last_summary = ''
        self.answer = ''

    def publish_message(self, item_id, text):
        self.messages[item_id] = text
        if self.phases.get(item_id) == 'commentary':
            self.emit({'type': 'progress', 'text': text})
            return
        self.answer = text
        answer = string_prefix(text, 'answer')
        summary = string_prefix(text, 'summary')
        if summary is not None and not self.summaries and summary != self.last_summary:
            self.last_summary = summary
            self.emit({'type': 'reasoning_summary', 'text': summary, 'source': 'answer-summary'})
        stripped = text.lstrip()
        if answer is None and stripped and not stripped.startswith(('{', '`')):
            answer = text
        if answer is not None and answer != self.last_answer:
            if answer.startswith(self.last_answer):
                self.emit({'type': 'answer_delta', 'delta': answer[len(self.last_answer):]})
            else:
                self.emit({'type': 'answer_replace', 'text': answer})
            self.last_answer = answer

    def publish_summary(self):
        text = '\n\n'.join(text for parts in self.summaries.values() for _, text in sorted(parts.items()) if text)
        if text and text != self.last_summary:
            self.last_summary = text
            self.emit({'type': 'reasoning_summary', 'text': text, 'source': 'model-summary'})

    def consume(self, method, params):
        item_id = params.get('itemId', '')
        if method == 'item/reasoning/summaryTextDelta':
            parts = self.summaries.setdefault(item_id, {})
            index = params.get('summaryIndex', 0)
            parts[index] = parts.get(index, '') + params.get('delta', '')
            self.publish_summary()
        elif method == 'item/agentMessage/delta':
            self.publish_message(item_id, self.messages.get(item_id, '') + params.get('delta', ''))
        elif method in ('item/started', 'item/completed'):
            item = params.get('item', {})
            item_id = item.get('id', '')
            if item.get('type') == 'agentMessage':
                self.phases[item_id] = item.get('phase')
                if method == 'item/completed' or item.get('text'):
                    self.publish_message(item_id, item.get('text', ''))
            elif item.get('type') == 'reasoning' and method == 'item/completed':
                # Deliberately exclude raw `content` and item/reasoning/textDelta.
                summaries = item.get('summary', [])
                if summaries:
                    self.summaries[item_id] = {i: text for i, text in enumerate(summaries) if isinstance(text, str)}
                    self.publish_summary()
            elif item.get('type') in ('mcpToolCall', 'commandExecution'):
                is_mcp = item['type'] == 'mcpToolCall'
                self.emit({'type': 'status',
                           'message': ('正在查询 Grafana 信息…' if is_mcp else '正在读取资料或查询证据…')
                           if method == 'item/started' else
                           ('查询未成功，正在核对可用证据…' if item.get('status') == 'failed' else '资料查询完成，正在整理回答…'),
                           'tool': item.get('tool') if is_mcp else 'shell',
                           'phase': 'started' if method == 'item/started' else 'completed',
                           'tool_status': item.get('status')})


def run_app_server(command, prompt, schema, cwd, model, instructions, env, stderr, emit, timeout, skill_names=None):
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr,
                               env=env, cwd=cwd, start_new_session=True)
    stream = PublicStream(emit)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + timeout
    pending = b''
    thread_id = None
    turn_id = None
    skills = []
    skill_files = None

    def send(message):
        process.stdin.write((json.dumps(message, ensure_ascii=False) + '\n').encode())
        process.stdin.flush()

    def request(number, method, params):
        send({'id': number, 'method': method, 'params': params})

    try:
        request(1, 'initialize', {'clientInfo': {'name': 'live_deck', 'title': 'Live Deck Advisor', 'version': '0.3.0'},
                                  'capabilities': {'experimentalApi': True}})
        while time.monotonic() < deadline:
            events = selector.select(timeout=min(0.5, max(0, deadline - time.monotonic())))
            if not events:
                if process.poll() is not None:
                    break
                continue
            chunk = os.read(process.stdout.fileno(), 65536)
            if not chunk:
                break
            pending += chunk
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                try:
                    message = json.loads(line)
                except (ValueError, UnicodeDecodeError):
                    continue
                if 'id' in message:
                    if 'method' in message:
                        # Never silently approve actions or forward secrets/tool output to the browser.
                        if message['method'] == 'item/tool/call':
                            params = message.get('params', {})
                            try:
                                if (not skill_files or params.get('tool') != 'skill_files' or params.get('threadId') != thread_id
                                        or turn_id and params.get('turnId') != turn_id):
                                    raise ValueError('Unknown tool or inactive turn')
                                output = skill_files.call(params.get('arguments', {}))
                                result = {'success': True, 'contentItems': [{'type': 'inputText', 'text': json.dumps(output, ensure_ascii=False)}]}
                            except (ValueError, OSError, TypeError) as error:
                                result = {'success': False, 'contentItems': [{'type': 'inputText', 'text': str(error)[:300]}]}
                            send({'id': message['id'], 'result': result})
                            emit({'type': 'status', 'message': '已读取共享技能资料…' if result['success'] else '技能资料未能读取，正在核对…',
                                  'tool': 'skill_files', 'phase': 'completed', 'tool_status': 'completed' if result['success'] else 'failed'})
                        elif message['method'] in ('item/commandExecution/requestApproval', 'item/fileChange/requestApproval'):
                            send({'id': message['id'], 'result': {'decision': 'decline'}})
                        else:
                            send({'id': message['id'], 'error': {'code': -32601, 'message': 'Advisor supports read-only research and suggestions; interactive actions are unavailable.'}})
                    elif message.get('error'):
                        raise RuntimeError('AI 接口错误：' + str(message['error'].get('message', '未知错误'))[:400])
                    elif message['id'] == 1:
                        send({'method': 'initialized'})
                        request(4, 'skills/list', {'cwds': [cwd], 'forceReload': True})
                    elif message['id'] == 4:
                        entries = message['result'].get('data', [])
                        skills = [skill for entry in entries for skill in entry.get('skills', []) if skill.get('enabled', True)]
                        skill_files = SkillFiles(skills)
                        names = sorted({skill['name'] for skill in skills})
                        emit({'type': 'status', 'message': f'已加载 {len(names)} 个共享 Skills，正在读取演示上下文…', 'skills': names})
                        if any(entry.get('errors') for entry in entries):
                            emit({'type': 'status', 'message': '部分 Skills 加载失败，将使用可用资料回答。'})
                        request(2, 'thread/start', {'model': model, 'cwd': cwd, 'approvalPolicy': 'never',
                                'sandbox': 'read-only', 'ephemeral': True, 'developerInstructions': instructions,
                                'dynamicTools': [SkillFiles.spec]})
                    elif message['id'] == 2:
                        thread_id = message['result']['thread']['id']
                        selected = [skill for skill in skills if skill['name'] in (skill_names or [])]
                        inputs = [{'type': 'text', 'text': prompt}] + [
                            {'type': 'skill', 'name': skill['name'], 'path': skill['path']} for skill in selected]
                        request(3, 'turn/start', {'threadId': thread_id, 'input': inputs,
                                'sandboxPolicy': {'type': 'readOnly', 'networkAccess': True},
                                'model': model, 'effort': 'low', 'summary': 'concise', 'outputSchema': schema})
                    elif message['id'] == 3:
                        turn_id = message['result']['turn']['id']
                    continue
                params = message.get('params', {})
                if params.get('threadId') != thread_id:
                    continue
                if turn_id and params.get('turnId') not in (None, turn_id):
                    continue
                method = message.get('method')
                if method == 'turn/started':
                    turn_id = params['turn']['id']
                elif method == 'turn/completed':
                    turn = params.get('turn', {})
                    if turn.get('id') != turn_id:
                        continue
                    if turn.get('status') != 'completed':
                        error = (turn.get('error') or {}).get('message', '回答被中断')
                        raise RuntimeError('AI 未完成：' + str(error)[:400])
                    if not stream.answer.strip():
                        raise RuntimeError('AI 未返回回答，请重试')
                    return stream.answer
                elif method == 'error' and params.get('willRetry'):
                    emit({'type': 'status', 'message': '模型连接暂时中断，正在重试…'})
                else:
                    stream.consume(method, params)
        if time.monotonic() >= deadline:
            raise TimeoutError('AI 回答超时，已保留收到的内容，请重试')
        raise RuntimeError('AI 进程提前结束，请重试')
    finally:
        selector.close()
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        process.stdin.close()
        process.stdout.close()

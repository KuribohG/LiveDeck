"""Small stdio app-server client; only public summaries and messages reach the UI."""
from __future__ import annotations

import json
import os
import selectors
import signal
import subprocess
import time


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


def run_app_server(command, prompt, schema, cwd, model, instructions, env, stderr, emit, timeout):
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr,
                               env=env, cwd=cwd, start_new_session=True)
    stream = PublicStream(emit)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + timeout
    pending = b''
    thread_id = None
    turn_id = None

    def send(message):
        process.stdin.write((json.dumps(message, ensure_ascii=False) + '\n').encode())
        process.stdin.flush()

    def request(number, method, params):
        send({'id': number, 'method': method, 'params': params})

    try:
        request(1, 'initialize', {'clientInfo': {'name': 'live_deck', 'title': 'Live Deck Advisor', 'version': '0.2.0'}})
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
                        # This advisor does not delegate tools or approvals to the browser.
                        send({'id': message['id'], 'error': {'code': -32601, 'message': 'This advisor supports text-only assistance.'}})
                    elif message.get('error'):
                        raise RuntimeError('AI 接口错误：' + str(message['error'].get('message', '未知错误'))[:400])
                    elif message['id'] == 1:
                        send({'method': 'initialized'})
                        request(2, 'thread/start', {'model': model, 'cwd': cwd, 'approvalPolicy': 'never',
                                'sandbox': 'read-only', 'ephemeral': True, 'developerInstructions': instructions})
                    elif message['id'] == 2:
                        thread_id = message['result']['thread']['id']
                        request(3, 'turn/start', {'threadId': thread_id, 'input': [{'type': 'text', 'text': prompt}],
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

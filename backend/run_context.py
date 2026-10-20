"""Publish explicit Live Deck run metadata through the current terminal's OSC stream.

Only supplied --set fields are published; shell environment variables are not collected.
"""
import argparse
import base64
import json
import os
import re
import subprocess
import sys
import time
import uuid


def fields_from(items):
    result = {}
    for item in items:
        key, separator, value = item.partition('=')
        if not separator or not re.fullmatch(r'[a-zA-Z][a-zA-Z0-9_]*', key) or key in ('constructor', 'prototype'):
            raise ValueError('--set 需要 key=value，key 使用字母、数字和下划线')
        result[key] = value
    return result


def emit(event, run_id, started, fields, exit_code=None):
    stamp = max(started * 1_000_000, time.time_ns())
    value = dict(version=1, event=event, run_id=run_id, started_at_ms=started,
                 at_ms=stamp // 1_000_000, at_ns=str(stamp), event_id=str(uuid.uuid4()), fields=fields)
    if exit_code is not None:
        value['exit_code'] = exit_code
    payload = base64.b64encode(json.dumps(value, ensure_ascii=False).encode()).decode()
    if len(payload) > 24000:
        raise ValueError('运行参数过大；仅报告监控需要的字段')
    # Prefer the controlling terminal even if the command redirects stdout to a log file.
    try:
        with open('/dev/tty', 'w') as tty:
            tty.write('\x1b]777;live-deck;' + payload + '\x07')
            tty.flush()
    except OSError:
        sys.stdout.write('\x1b]777;live-deck;' + payload + '\x07')
        sys.stdout.flush()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='mode', required=True)
    run = sub.add_parser('run', help='启动命令并报告开始/结束，不改变工作目录或 Shell 环境')
    run.add_argument('--set', action='append', default=[])
    run.add_argument('command', nargs=argparse.REMAINDER)
    publish = sub.add_parser('publish', help='由运行中的子程序报告真实任务信息')
    publish.add_argument('--event', choices=('ready', 'update'), default='update')
    publish.add_argument('--set', action='append', default=[])
    publish.add_argument('--monitoring-start-now', action='store_true', help='将图表起点设为此刻，例如远端任务真正开始运行时')
    args = parser.parse_args(argv)
    try:
        fields = fields_from(args.set)
        if args.mode == 'publish':
            run_id = os.environ.get('LIVE_DECK_RUN_ID')
            started = os.environ.get('LIVE_DECK_RUN_STARTED_MS')
            if not run_id or not started:
                parser.error('publish 必须在 run 启动的子程序内使用')
            if args.monitoring_start_now:
                fields['monitoring_started_at_ms'] = time.time_ns() // 1_000_000
            emit(args.event, run_id, int(started), fields)
            return 0
        command = args.command[1:] if args.command[:1] == ['--'] else args.command
        if not command:
            parser.error('run 后需要 -- 命令 参数…')
        stamp = time.time_ns()
        started = stamp // 1_000_000
        run_id = f'r{stamp}-{uuid.uuid4().hex[:8]}'
        env = dict(os.environ, LIVE_DECK_RUN_ID=run_id, LIVE_DECK_RUN_STARTED_MS=str(started))
        emit('started', run_id, started, fields)
        code = 127
        child = None
        try:
            child = subprocess.Popen(command, env=env)
            while True:
                try:
                    code = child.wait()
                    break
                except KeyboardInterrupt:
                    # A terminal Ctrl-C reaches both processes in the foreground group.
                    continue
        except OSError as error:
            print(str(error), file=sys.stderr)
        finally:
            emit('finished', run_id, started, {}, code if code >= 0 else 128 - code)
        return code if code >= 0 else 128 - code
    except ValueError as error:
        parser.error(str(error))


if __name__ == '__main__':
    sys.exit(main())

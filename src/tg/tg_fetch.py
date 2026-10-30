#!/usr/bin/env python3
"""Выгрузка постов из Telegram-канала/чата в JSON (stdout).

Использование: python tg_fetch.py <channel> [limit]
channel — @username или числовой ID (-100...)
Вывод: [{"id","date","text","sender","views"}]

Файл .env ищется автоматически:
  1) $TG_ENV_FILE
  2) рядом с интерпретатором: <venv>/../.env, <venv>/../../.env
  3) $TELEGRAM_MCP_DIR/.env
  4) известные пути (D:/opencode/mcp-servers/telegram-mcp/.env и др.)
"""
import os
import sys
import json
import asyncio
import glob

HERE = os.path.dirname(os.path.abspath(__file__))

CANDIDATE_ENV_DIRS = []


def _add_candidates(path):
    if not path:
        return
    CANDIDATE_ENV_DIRS.append(path)
    parent = os.path.dirname(path)
    CANDIDATE_ENV_DIRS.append(parent)
    CANDIDATE_ENV_DIRS.append(os.path.dirname(parent))


def find_env_file():
    explicit = os.environ.get('TG_ENV_FILE')
    if explicit and os.path.isfile(explicit):
        return explicit

    # 1) интерпретатор: .../telegram-mcp/.venv/Scripts/python.exe
    exe = os.path.abspath(sys.executable)
    _add_candidates(os.path.join(os.path.dirname(exe), '.env'))
    _add_candidates(os.path.join(os.path.dirname(os.path.dirname(exe)), '.env'))
    _add_candidates(os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(exe))), '.env'))

    # 2) каталог самого скрипта и его родители
    _add_candidates(os.path.join(HERE, '.env'))
    _add_candidates(os.path.join(os.path.dirname(HERE), '.env'))

    # 3) переменная окружения на каталог телеграм-mcp
    _add_candidates(os.path.join(os.environ.get('TELEGRAM_MCP_DIR', ''), '.env'))

    # 4) типовые места установки telegram-mcp
    home = os.path.expanduser('~')
    for base in (
        os.environ.get('TELEGRAM_MCP_DIR', ''),
        os.path.join(home, 'mcp-servers', 'telegram-mcp'),
        os.path.join(home, 'opencode', 'mcp-servers', 'telegram-mcp'),
        os.path.join(home, '.telegram-mcp'),
    ):
        if base:
            _add_candidates(os.path.join(base, '.env'))

    for d in CANDIDATE_ENV_DIRS:
        if not d:
            continue
        p = os.path.join(d, '.env') if os.path.basename(d) != '.env' else d
        if os.path.isfile(p):
            return p
        # .env внутри venv/parent-каталога
        for cand in glob.glob(os.path.join(d, '*.env')):
            if os.path.basename(cand) == '.env':
                return cand
    return None


def load_env():
    try:
        from dotenv import load_dotenv
    except ImportError:
        return None
    env_file = find_env_file()
    if env_file:
        load_dotenv(env_file, override=False)
        return env_file
    # fallback: ищем .env рядом
    for d in CANDIDATE_ENV_DIRS:
        if not d:
            continue
        p = os.path.join(d, '.env') if os.path.basename(d) != '.env' else d
        if os.path.isfile(p):
            load_dotenv(p, override=False)
            return p
    return None


ENV_FILE = load_env()

try:
    from telethon import TelegramClient
    from telethon.sessions import StringSession
except ImportError as e:
    print(json.dumps({'error': f'telethon не установлен: {e}'}, ensure_ascii=False), file=sys.stderr)
    sys.exit(2)

MISSING = [k for k in ('TELEGRAM_SESSION_STRING', 'TELEGRAM_API_ID', 'TELEGRAM_API_HASH')
           if not os.environ.get(k)]
if MISSING:
    print(json.dumps({
        'error': 'нет переменных: ' + ', '.join(MISSING),
        'env_file': ENV_FILE,
        'hints': [p for p in CANDIDATE_ENV_DIRS if p][:8],
    }, ensure_ascii=False), file=sys.stderr)
    sys.exit(3)


def sender_name(sender):
    if sender is None:
        return None
    if hasattr(sender, 'username') and sender.username:
        return '@' + sender.username
    if hasattr(sender, 'first_name') and sender.first_name:
        return sender.first_name
    if hasattr(sender, 'title') and sender.title:
        return sender.title
    return str(getattr(sender, 'id', '?'))


async def connect():
    client = TelegramClient(
        StringSession(os.environ['TELEGRAM_SESSION_STRING']),
        int(os.environ['TELEGRAM_API_ID']),
        os.environ['TELEGRAM_API_HASH'],
    )
    await client.connect()
    return client


async def fetch_with(client, channel, limit):
    out = []
    async for m in client.iter_messages(channel, limit=limit):
        if not m.message:
            continue
        out.append({
            'id': m.id,
            'date': m.date.isoformat(),
            'text': m.message,
            'sender': sender_name(await m.get_sender()),
            'views': m.views,
        })
    return out


async def fetch(channel, limit):
    client = await connect()
    try:
        return await fetch_with(client, channel, limit)
    finally:
        await client.disconnect()


async def main():
    args = sys.argv[1:]
    if not args:
        print(json.dumps({'error': 'не указан канал'}), file=sys.stderr)
        sys.exit(1)
    limit = int(args[-1]) if args[-1].isdigit() and len(args) > 1 else 50
    channels = args[:-1] if (args[-1].isdigit() and len(args) > 1) else args

    if len(channels) == 1:
        # обратная совместимость: один канал → массив постов
        items = await fetch(_norm(channels[0]), limit)
        print(json.dumps(items, ensure_ascii=False))
        return

    # несколько каналов → объект {канал: посты} (одна сессия на все каналы)
    client = await connect()
    out = {}
    try:
        for ch in channels:
            name = _norm(ch)
            out[name] = await fetch_with(client, name, limit)
    finally:
        await client.disconnect()
    print(json.dumps(out, ensure_ascii=False))


def _norm(channel):
    """Числовые ID Telethon хочет как int, не как строку"""
    if channel.lstrip('-').isdigit():
        return int(channel)
    return channel


if __name__ == '__main__':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass
    try:
        asyncio.run(main())
    except Exception as e:
        print(json.dumps({'error': str(e)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(4)

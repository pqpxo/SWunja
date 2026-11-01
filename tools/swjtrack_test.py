"""Tests for web/public/swjtrack. Run: python -I -m unittest discover -s tools -p "swjtrack_test.py" """
import importlib.machinery
import importlib.util
import json
import os
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / 'web' / 'public' / 'swjtrack'
_loader = importlib.machinery.SourceFileLoader('swjtrack', str(SCRIPT))
_spec = importlib.util.spec_from_loader('swjtrack', _loader)
sw = importlib.util.module_from_spec(_spec)
_loader.exec_module(sw)


class FakeServer:
    """Records POSTed JSON bodies and their Authorization header; GETs succeed only for tokens in `good` (when given)."""
    def __init__(self, status=200, good=None):
        self.bodies, self.auth, outer = [], [], self

        class H(BaseHTTPRequestHandler):
            def do_GET(self):
                ok = good is None or self.headers.get('authorization') in {f'Bearer {t}' for t in good}
                self.send_response(200 if ok else 401)
                self.send_header('content-type', 'application/json')
                self.end_headers()
                self.wfile.write(b'{"waiting": 0}' if ok else b'{"error": "Invalid or missing API token"}')

            def do_POST(self):
                n = int(self.headers.get('content-length', 0))
                outer.bodies.append((self.path, json.loads(self.rfile.read(n) or b'{}')))
                outer.auth.append(self.headers.get('authorization'))
                self.send_response(status)
                self.send_header('content-type', 'application/json')
                self.end_headers()
                self.wfile.write(b'{"id": 1}')

            def log_message(self, *a):
                pass

        self.httpd = HTTPServer(('127.0.0.1', 0), H)
        self.url = f'http://127.0.0.1:{self.httpd.server_address[1]}'
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


def transcript(path, lines):
    with open(path, 'w', encoding='utf-8') as f:
        for d in lines:
            f.write(json.dumps(d) + '\n')


def user(text, ts='2026-10-30T10:00:00Z'):
    return {'type': 'user', 'timestamp': ts, 'message': {'role': 'user', 'content': text}}


def tool(name, inp, ts='2026-10-30T10:05:00Z'):
    return {'type': 'assistant', 'timestamp': ts, 'message': {'role': 'assistant', 'content': [{'type': 'tool_use', 'id': 'x', 'name': name, 'input': inp}]}}


class Packaging(unittest.TestCase):
    def test_script_has_unix_line_endings_so_the_shebang_works_on_linux(self):
        data = SCRIPT.read_bytes()
        self.assertTrue(data.startswith(b'#!/usr/bin/env python3\n'))
        self.assertNotIn(b'\r', data, 'CRLF breaks "#!/usr/bin/env python3" on Linux (python3\\r not found)')


class ClaudeHook(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def test_redacts_like_server(self):
        cases = {
            'mysql -u root -phunter2 db': 'mysql -u root -p•••• db',
            'mysql --password=hunter2': 'mysql --password=••••',
            'export API_TOKEN=abc123': 'export API_TOKEN=••••',
            "curl -H 'Authorization: Bearer sk-ant-xyz'": "curl -H 'Authorization: Bearer ••••'",
            'echo 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08': 'echo ••••',
            'curl "https://x/api?token=abc&q=1"': 'curl "https://x/api?token=••••&q=1"',
            'docker compose up -d': 'docker compose up -d',
            'ls -la /tmp': 'ls -la /tmp',
            'export DB_PASSWORD="hunter2"': 'export DB_PASSWORD=••••',
            "export API_TOKEN='abc 123'": 'export API_TOKEN=••••',
            "curl 'https://x/?token=abc'": "curl 'https://x/?token=••••'",
            'mysql --password "my secret" db': 'mysql --password •••• db',
            'curl -u admin:hunter2 https://x': 'curl -u admin:•••• https://x',
            'psql postgres://app:hunter2@db/app': 'psql postgres://app:••••@db/app',
            'git clone https://bob:pw123@host/x.git': 'git clone https://bob:••••@host/x.git',
            'sshpass -p hunter2 ssh root@h': 'sshpass -p •••• ssh root@h',
            'curl -H "X-Api-Key: abcd1234" https://x': 'curl -H "X-Api-Key: ••••" https://x',
            'echo password: hunter2': 'echo password: ••••',
            'mysql -u root db': 'mysql -u root db',
            'docker run -p8080:80 nginx': 'docker run -p8080:80 nginx',
            'ssh -p2222 root@h': 'ssh -p2222 root@h',
            'mysqldump -uroot -phunter2 db > d.sql': 'mysqldump -uroot -p•••• db > d.sql',
            'mariadb -phunter2': 'mariadb -p••••',
        }
        for given, want in cases.items():
            self.assertEqual(sw.redact(given), want, given)

    def test_parse_transcript_extracts_prompts_files_commands(self):
        p = os.path.join(self.tmp, 't.jsonl')
        transcript(p, [
            user('Add run history to runbooks'),
            user([{'type': 'tool_result', 'content': 'ok'}]),
            user('<system-reminder>ignore me</system-reminder>'),
            {**user('Base directory for this skill: ...'), 'isMeta': True},
            {**user('This session is being continued from a previous conversation'), 'isCompactSummary': True},
            tool('Read', {'file_path': '/src/a.ts'}),
            tool('Edit', {'file_path': '/src/a.ts'}),
            tool('Edit', {'file_path': '/src/a.ts'}),
            tool('Write', {'file_path': '/src/new.ts'}),
            tool('Bash', {'command': 'npm test'}),
            tool('PowerShell', {'command': 'Get-ChildItem'}, ts='2026-10-30T10:30:00Z'),
            {'type': 'attachment', 'timestamp': '2026-10-30T10:31:00Z'},
            'not json',
        ])
        r = sw.parse_transcript(p)
        self.assertEqual(r['prompts'], ['Add run history to runbooks'])
        self.assertEqual(r['files'], [{'path': '/src/a.ts', 'change': 'edited', 'count': 2}, {'path': '/src/new.ts', 'change': 'created', 'count': 1}])
        self.assertEqual([c['cmd'] for c in r['commands']], ['npm test', 'Get-ChildItem'])
        self.assertEqual((r['started'], r['ended']), ('2026-10-30T10:00:00Z', '2026-10-30T10:31:00Z'))

    def test_parses_a_20000_line_transcript_within_caps(self):
        p = os.path.join(self.tmp, 'big.jsonl')
        lines = []
        for i in range(10000):
            lines.append(user(f'prompt {i}'))
            lines.append(tool('Bash', {'command': f'echo {i}'}) if i % 2 else tool('Edit', {'file_path': f'/f/{i}.ts'}))
        transcript(p, lines)
        t0 = time.time()
        r = sw.parse_transcript(p)
        self.assertLess(time.time() - t0, 5)
        self.assertEqual((len(r['prompts']), len(r['commands']), len(r['files'])), (50, 500, 1000))

    def test_claude_setup_is_idempotent(self):
        p = os.path.join(self.tmp, 'settings.json')
        with open(p, 'w') as f:
            json.dump({'enabledPlugins': {'x': True}, 'hooks': {'Stop': [{'hooks': [{'type': 'command', 'command': 'echo hi'}]}]}}, f)
        self.assertEqual(sw.cmd_claude_setup(p), 0)
        self.assertEqual(sw.cmd_claude_setup(p), 0)
        d = json.load(open(p))
        self.assertEqual(d['enabledPlugins'], {'x': True})
        self.assertEqual(d['hooks']['Stop'][0]['hooks'][0]['command'], 'echo hi')
        cmds = [h['command'] for e in d['hooks']['SessionEnd'] for h in e['hooks']]
        self.assertEqual(len(cmds), 1)
        self.assertIn('claude-hook', cmds[0])
        self.assertIn('swjtrack', cmds[0])

    def test_hook_posts_to_fake_server(self):
        srv = FakeServer()
        try:
            p = os.path.join(self.tmp, 't.jsonl')
            transcript(p, [user('Fix the login'), tool('Edit', {'file_path': '/src/login.ts'}), tool('Bash', {'command': 'mysql -phunter2'})])
            cfg = {'server': srv.url, 'token': 'smj_test'}
            rc = sw.cmd_claude_hook({'session_id': 'abc', 'transcript_path': p, 'cwd': '/home/u/app'}, cfg)
            self.assertEqual(rc, 0)
            path, body = srv.bodies[0]
            self.assertEqual(path, '/api/activity')
            self.assertEqual((body['source'], body['batch_id'], body['session_id'], body['folder']), ('claude-code', 'cc-abc', 'abc', '/home/u/app'))
            self.assertEqual(srv.auth[0], 'Bearer smj_test')
            self.assertNotIn('hunter2', json.dumps(body))
        finally:
            srv.close()

    def test_hook_skips_sessions_without_changes_and_never_fails(self):
        srv = FakeServer()
        try:
            p = os.path.join(self.tmp, 't.jsonl')
            transcript(p, [user('What does this do?'), tool('Read', {'file_path': '/a'})])
            self.assertEqual(sw.cmd_claude_hook({'session_id': 'q', 'transcript_path': p, 'cwd': '/x'}, {'server': srv.url, 'token': 't'}), 0)
            self.assertEqual(srv.bodies, [])
            # unreachable server and a missing transcript still exit 0 (a hook must not break Claude Code)
            self.assertEqual(sw.cmd_claude_hook({'session_id': 'z', 'transcript_path': p + '.missing', 'cwd': '/x'}, {'server': 'http://127.0.0.1:9', 'token': 't'}), 0)
        finally:
            srv.close()


class Tracking(unittest.TestCase):
    """swjtrack -f: files, commands and commits in a tracked folder, kept locally until synced."""

    def setUp(self):
        self.home = tempfile.mkdtemp()
        os.environ['SWJTRACK_HOME'] = self.home
        self.dir = tempfile.mkdtemp()
        Path(self.dir, 'keep.txt').write_text('a')
        sw.track(self.dir, 7200)

    def tearDown(self):
        os.environ.pop('SWJTRACK_HOME', None)

    def test_record_cmd_only_inside_tracked_folder(self):
        sw.record_cmd(os.path.join(self.dir, 'sub'), '512  sudo apt install fastfetch', 0)
        sw.record_cmd(os.path.join(self.dir, 'sub'), '512  sudo apt install fastfetch', 0)  # same history line again (Enter on an empty prompt)
        sw.record_cmd(tempfile.gettempdir(), '513  ls', 0)
        sw.record_cmd(self.dir, '514  mysql -phunter2', 1)
        sw.record_cmd(self.dir, '515  swjtrack status', 0)
        cmds = sw.collect(self.dir)['commands']
        self.assertEqual([c['cmd'] for c in cmds], ['sudo apt install fastfetch', 'mysql -p••••'])
        self.assertEqual(cmds[1]['exit'], 1)

    def test_watch_once_detects_create_edit_delete(self):
        Path(self.dir, 'new.txt').write_text('x')
        os.makedirs(os.path.join(self.dir, 'node_modules'))
        Path(self.dir, 'node_modules', 'skip.js').write_text('x')
        sw.watch_once(self.dir)
        time.sleep(0.05)
        p = Path(self.dir, 'keep.txt')
        p.write_text('b')
        os.utime(p, (time.time() + 5, time.time() + 5))
        sw.watch_once(self.dir)
        os.remove(os.path.join(self.dir, 'new.txt'))
        sw.watch_once(self.dir)
        files = {Path(f['path']).name: f['change'] for f in sw.collect(self.dir)['files']}
        self.assertEqual(files, {'new.txt': 'deleted', 'keep.txt': 'edited'})

    def test_ignore_globs(self):
        sw.add_ignore('*.log')
        Path(self.dir, 'app.log').write_text('x')
        sw.watch_once(self.dir)
        self.assertEqual(sw.collect(self.dir)['files'], [])

    def test_collect_includes_git_commits(self):
        import shutil
        import subprocess
        if not shutil.which('git'):
            self.skipTest('git not installed')
        run = lambda *a: subprocess.run(['git', '-C', self.dir, *a], check=True, capture_output=True)
        run('init', '-q')
        run('-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'Switch to fastfetch')
        self.assertEqual([c['message'] for c in sw.collect(self.dir)['commits']], ['Switch to fastfetch'])

    def test_sync_posts_and_trims(self):
        srv = FakeServer()
        try:
            sw.record_cmd(self.dir, '1  make build', 0)
            ids = sw.sync({'server': srv.url, 'token': 't'})
            self.assertEqual(len(ids), 1)
            path, body = srv.bodies[0]
            self.assertEqual((path, body['source'], body['folder'], body['commands'][0]['cmd']), ('/api/activity', 'swjtrack', os.path.abspath(self.dir), 'make build'))
            self.assertTrue(body['batch_id'])
            self.assertEqual(sw.collect(self.dir)['commands'], [], 'local activity trimmed after a successful sync')
            self.assertEqual(sw.sync({'server': srv.url, 'token': 't'}), [], 'nothing new, nothing sent')
        finally:
            srv.close()

    def test_keeps_activity_when_server_is_down(self):
        sw.record_cmd(self.dir, '1  make build', 0)
        with self.assertRaises(sw.SyncError):
            sw.sync({'server': 'http://127.0.0.1:9', 'token': 't'})
        self.assertEqual(len(sw.collect(self.dir)['commands']), 1)
        srv = FakeServer()
        try:
            sw.sync({'server': srv.url, 'token': 't'})
            sw.sync({'server': srv.url, 'token': 't'})
            self.assertEqual(len([b for p, b in srv.bodies if p == '/api/activity']), 1)
        finally:
            srv.close()

    def test_a_lost_reply_is_resent_as_the_same_batch_and_nothing_goes_twice(self):
        srv = FakeServer()
        cfg = {'server': srv.url, 'token': 't'}
        real = sw.post_activity
        try:
            sw.record_cmd(self.dir, '1  make', 0)

            def lost_reply(c, item):  # the server stores it, but the answer never arrives
                real(c, item)
                raise sw.SyncError('timed out')
            sw.post_activity = lost_reply
            with self.assertRaises(sw.SyncError):
                sw.sync(cfg)
            sw.post_activity = real
            sw.record_cmd(self.dir, '2  make test', 0)
            sw.sync(cfg)
            posts = [b for p, b in srv.bodies if p == '/api/activity']
            self.assertEqual([[c['cmd'] for c in b['commands']] for b in posts], [['make'], ['make'], ['make test']])
            self.assertEqual(posts[0]['batch_id'], posts[1]['batch_id'], 'the retry is the same batch, so the server keeps one')
            self.assertNotEqual(posts[1]['batch_id'], posts[2]['batch_id'])
            self.assertEqual(sw.collect(self.dir)['commands'], [])
        finally:
            sw.post_activity = real
            srv.close()

    def test_a_corrupt_line_does_not_make_events_resend(self):
        srv = FakeServer()
        try:
            sw.record_cmd(self.dir, '1  make', 0)
            with open(sw._events_path(self.dir), 'a', encoding='utf-8') as f:
                f.write('{not json\n')
            sw.record_cmd(self.dir, '2  make test', 0)
            sw.sync({'server': srv.url, 'token': 't'})
            self.assertEqual(sw.collect(self.dir)['commands'], [], 'both commands went; nothing left to send again')
        finally:
            srv.close()

    def test_untrack(self):
        sw.untrack(self.dir)
        sw.record_cmd(self.dir, '1  ls -la', 0)
        self.assertEqual(sw.tracked(), {})


class ReviewFixes(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        os.environ['SWJTRACK_HOME'] = self.home
        os.environ['SWJTRACK_NO_WATCH'] = '1'
        self.dir = os.path.abspath(tempfile.mkdtemp())
        sw.track(self.dir, 3600)

    def tearDown(self):
        os.environ.pop('SWJTRACK_HOME', None)
        os.environ.pop('SWJTRACK_NO_WATCH', None)

    def test_repeated_edits_of_one_file_count_once_and_noisy_files_are_ignored(self):
        p = Path(self.dir, 'app.db')
        p.write_text('a')
        Path(self.dir, 'app.db-wal').write_text('w')
        Path(self.dir, 'run.log').write_text('l')
        sw.watch_once(self.dir)
        for i in range(5):
            p.write_text('b' * (i + 2))
            os.utime(p, (time.time() + 10 * (i + 1), time.time() + 10 * (i + 1)))
            sw.watch_once(self.dir)
        self.assertEqual(len(sw._events(self.dir)), 1, 'one event for a file that keeps changing')
        self.assertEqual([Path(f['path']).name for f in sw.collect(self.dir)['files']], ['app.db'])
        sw.record_cmd(self.dir, '1  make', 0)
        self.assertEqual(sw.pending_count(self.dir), 2)

    def test_stop_keeps_waiting_activity_unless_discarded_and_clears_the_reminder(self):
        sw.record_cmd(self.dir, '1  make', 0)
        self.assertEqual(sw.main(['stop', '-f', self.dir]), 1, 'refuses: there is unsynced activity')
        self.assertIn(self.dir, sw.tracked())
        srv = FakeServer()
        try:
            sw.untrack(self.dir, {'server': srv.url, 'token': 't'})
            beats = [b for p, b in srv.bodies if p == '/api/activity/heartbeat']
            self.assertEqual((beats[-1]['folder'], beats[-1]['unsynced_count']), (self.dir, 0))
        finally:
            srv.close()
        self.assertNotIn(self.dir, sw.tracked())

    def test_state_file_survives_concurrent_writers(self):
        errors = []

        def hammer():
            try:
                for _ in range(150):
                    f = sw.tracked()
                    f.setdefault(self.dir, {})['interval_s'] = 3600
                    sw._save_tracked(f)
            except Exception as e:  # noqa: BLE001 - any failure is the finding
                errors.append(e)
        threads = [threading.Thread(target=hammer) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(errors, [])
        self.assertIn(self.dir, sw.tracked())

    def test_claude_hook_never_raises_on_odd_transcripts(self):
        p = os.path.join(self.home, 'odd.jsonl')
        transcript(p, [{'type': 'assistant', 'message': {'content': [{'type': 'tool_use', 'name': 'Bash', 'input': 'not a dict'}]}},
                       {'type': 'user', 'message': {'content': 42}}])
        self.assertEqual(sw.cmd_claude_hook({'session_id': 'o', 'transcript_path': p, 'cwd': '/x'}, {'server': 'http://127.0.0.1:9', 'token': 't'}), 0)

    def test_setup_takes_the_token_from_the_environment_not_the_command_line(self):
        cfg = Path(self.home, 'c.json')
        os.environ['SWJTRACK_TOKEN'] = 'smj_env'
        try:
            self.assertEqual(sw.cmd_setup('http://h:7760', None, cfg, []), 0)
        finally:
            os.environ.pop('SWJTRACK_TOKEN', None)
        self.assertEqual(sw.load_config(cfg)['token'], 'smj_env')


@unittest.skipUnless(os.name == 'posix', 'needs a real terminal (pty)')
class RealTerminal(unittest.TestCase):
    def test_tty_ask_asks_on_the_terminal_and_reads_the_answer(self):
        import pty
        pid, fd = pty.fork()
        if pid == 0:  # child: the terminal is the pty
            answer = sw._tty_ask('Sync to SWunja? [Y/n/show] ')
            os.write(1, f'\nGOT:{answer!r}\n'.encode())
            os._exit(0)
        out = b''
        while b'Sync to SWunja?' not in out:
            out += os.read(fd, 1024)
        os.write(fd, b'show\n')
        while b'GOT:' not in out or not out.rstrip().endswith(b"'"):
            try:
                chunk = os.read(fd, 1024)
            except OSError:
                break
            if not chunk:
                break
            out += chunk
        os.waitpid(pid, 0)
        self.assertIn(b"GOT:'show'", out)


class InstallWizard(unittest.TestCase):
    """swjtrack _install: the interactive setup the installer runs (token, folders, interval, Claude Code)."""

    def setUp(self):
        self.home = tempfile.mkdtemp()
        os.environ['SWJTRACK_HOME'] = os.path.join(self.home, 'state')
        os.environ['SWJTRACK_NO_WATCH'] = '1'
        self.docker = os.path.join(self.home, 'docker')
        for d in ('ghostblogv2', 'diun'):
            os.makedirs(os.path.join(self.docker, d))
        self.cfg = Path(self.home, 'config.json')
        self.rc = Path(self.home, '.bashrc')
        self.out = []

    def tearDown(self):
        os.environ.pop('SWJTRACK_HOME', None)
        os.environ.pop('SWJTRACK_NO_WATCH', None)

    def run_wizard(self, srv, answers, secrets, claude=False):
        answers, secrets = list(answers), list(secrets)
        return sw.cmd_install(srv.url, ask=lambda q: (self.out.append(q), answers.pop(0))[1], ask_secret=lambda q: (self.out.append(q), secrets.pop(0))[1],
                              say=self.out.append, cfg_path=self.cfg, rc_files=[str(self.rc)], docker_dir=self.docker, cwd=self.home,
                              claude_found=claude, claude_settings=str(Path(self.home, 'claude.json')))

    def test_walks_through_token_folders_interval_and_claude(self):
        srv = FakeServer(good={'smj_good'})
        try:
            rc = self.run_wizard(srv, answers=['2', '30m', 'y'], secrets=['smj_bad', 'smj_good'], claude=True)
        finally:
            srv.close()
        text = '\n'.join(self.out)
        self.assertEqual(rc, 0)
        self.assertIn(f'{srv.url}/#/settings/tokens', text, 'a link straight to Settings > API Tokens & MCP')
        self.assertIn('not accepted', text, 'a wrong token is refused and asked again')
        self.assertEqual(sw.load_config(self.cfg), {'server': srv.url, 'token': 'smj_good'})
        self.assertIn('1) diun', text)
        self.assertIn('2) ghostblogv2', text)
        self.assertEqual(sw.tracked()[os.path.join(self.docker, 'ghostblogv2')]['interval_s'], 1800)
        self.assertIn('__swj_hook', self.rc.read_text())
        self.assertIn('claude-hook', Path(self.home, 'claude.json').read_text())
        self.assertIn('exec bash', text)

    def test_keeps_a_saved_working_token_and_defaults_to_the_current_folder(self):
        sw.save_config({'server': 'http://old', 'token': 'smj_saved'}, self.cfg)
        srv = FakeServer(good={'smj_saved'})
        try:
            rc = self.run_wizard(srv, answers=['', '', ''], secrets=[])  # keep token, current folder, default interval
        finally:
            srv.close()
        self.assertEqual(rc, 0)
        self.assertEqual(sw.load_config(self.cfg)['token'], 'smj_saved')
        self.assertEqual(sw.load_config(self.cfg)['server'], srv.url)
        self.assertEqual(sw.tracked()[os.path.abspath(self.home)]['interval_s'], 7200)
        self.assertFalse(Path(self.home, 'claude.json').exists(), 'no Claude Code on this host: not offered')

    def test_paths_and_none(self):
        srv = FakeServer(good={'t'})
        other = tempfile.mkdtemp()
        try:
            self.run_wizard(srv, answers=[f'1 {other}', ''], secrets=['t'])
            self.assertEqual(sorted(sw.tracked()), sorted([os.path.join(self.docker, 'diun'), os.path.abspath(other)]))
            for f in list(sw.tracked()):
                sw.untrack(f, {})
            self.run_wizard(srv, answers=['', 'none'], secrets=[])  # keep token, track nothing
            self.assertEqual(sw.tracked(), {})
        finally:
            srv.close()

    def test_ctrl_c_or_end_of_input_cancels_cleanly(self):
        srv = FakeServer(good={'t'})
        try:
            def stop(q):
                raise EOFError
            rc = sw.cmd_install(srv.url, ask=stop, ask_secret=stop, say=self.out.append, cfg_path=self.cfg, rc_files=[str(self.rc)],
                                docker_dir=self.docker, cwd=self.home, claude_found=False)
        finally:
            srv.close()
        self.assertEqual(rc, 1)
        self.assertIn('cancelled', '\n'.join(self.out).lower())
        self.assertFalse(self.cfg.exists())

    def test_gives_up_after_three_wrong_tokens_without_saving(self):
        srv = FakeServer(good={'right'})
        try:
            rc = self.run_wizard(srv, answers=[], secrets=['a', 'b', 'c'])
        finally:
            srv.close()
        self.assertEqual(rc, 1)
        self.assertFalse(self.cfg.exists())


class CommandLine(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        os.environ['SWJTRACK_HOME'] = self.home
        os.environ['SWJTRACK_NO_WATCH'] = '1'
        self.dir = tempfile.mkdtemp()

    def tearDown(self):
        os.environ.pop('SWJTRACK_HOME', None)
        os.environ.pop('SWJTRACK_NO_WATCH', None)

    def test_track_status_stop(self):
        self.assertEqual(sw.main(['-f', self.dir, '-i', '30m']), 0)
        self.assertEqual(sw.tracked()[os.path.abspath(self.dir)]['interval_s'], 1800)
        self.assertEqual(sw.main(['status']), 0)
        self.assertEqual(sw.main(['ignore', '*.tmp']), 0)
        self.assertEqual(sw.ignores(), ['*.tmp'])
        self.assertEqual(sw.main(['stop', '-f', self.dir]), 0)
        self.assertEqual(sw.tracked(), {})
        self.assertEqual(sw.parse_interval('2h'), 7200)
        self.assertEqual(sw.main(['bogus']), 2)

    def test_setup_saves_config_privately_and_hooks_rc(self):
        cfg = Path(self.home, 'config.json')
        rc = Path(self.home, '.bashrc')
        self.assertEqual(sw.cmd_setup('http://swunja:7760/', 'smj_x', cfg, [str(rc)]), 0)
        self.assertEqual(sw.load_config(cfg), {'server': 'http://swunja:7760', 'token': 'smj_x'})
        if os.name == 'posix':
            self.assertEqual(oct(cfg.stat().st_mode & 0o777), '0o600')
        self.assertIn('__swj_hook', rc.read_text())


class ShellHook(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        os.environ['SWJTRACK_HOME'] = self.home
        self.dir = tempfile.mkdtemp()
        sw.track(self.dir, 3600)

    def tearDown(self):
        os.environ.pop('SWJTRACK_HOME', None)

    def test_install_shell_hook_idempotent(self):
        rc = Path(self.home, '.bashrc')
        rc.write_text('alias ll="ls -l"\n')
        sw.install_shell_hook(str(rc))
        sw.install_shell_hook(str(rc))
        text = rc.read_text()
        self.assertEqual(text.count('# >>> swjtrack >>>'), 1)
        self.assertIn('alias ll', text)
        self.assertIn('__swj_hook', text)
        self.assertIn('*i*', text, 'only interactive shells')
        self.assertIn('PATH="$HOME/.local/bin:$PATH"', text, 'new shells can run swjtrack without a re-login')

    def test_install_shell_hook_refreshes_an_older_block(self):
        rc = Path(self.home, '.bashrc')
        rc.write_text('alias ll="ls -l"\n# >>> swjtrack >>>\nold hook\n# <<< swjtrack <<<\nexport EDITOR=vim\n')
        self.assertTrue(sw.install_shell_hook(str(rc)))
        text = rc.read_text()
        self.assertNotIn('old hook', text)
        self.assertEqual(text.count('# >>> swjtrack >>>'), 1)
        self.assertTrue(text.startswith('alias ll') and 'export EDITOR=vim' in text, 'the rest of the file is kept')
        self.assertFalse(sw.install_shell_hook(str(rc)), 'already current: nothing to do')

    def test_hook_prompts_only_when_due(self):
        asked = []
        ask = lambda q: (asked.append(q), 'n')[1]
        t0 = sw.tracked()[os.path.abspath(self.dir)]['since']
        sw.cmd_hook(0, self.dir, '7  make', now=t0 + 60, ask=ask)
        self.assertEqual(asked, [], 'interval not reached')
        sw.cmd_hook(0, self.dir, '8  make test', now=t0 + 3700, ask=ask)
        self.assertEqual(len(asked), 1)
        self.assertRegex(asked[0], r'2 activities for .* since \d\d:\d\d\. Sync to SWunja\? \[Y/n/show\]')
        sw.cmd_hook(0, self.dir, '9  ls', now=t0 + 3800, ask=ask)
        self.assertEqual(len(asked), 1, '"n" snoozes for one interval')
        sw.cmd_hook(0, self.dir, '10  ls -a', now=t0 + 3700 + 3601, ask=ask)
        self.assertEqual(len(asked), 2)

    def test_hook_yes_syncs(self):
        srv = FakeServer()
        try:
            t0 = sw.tracked()[os.path.abspath(self.dir)]['since']
            sw.cmd_hook(0, self.dir, '7  make', now=t0 + 3700, ask=lambda q: 'y', cfg={'server': srv.url, 'token': 't'})
            self.assertEqual(len([b for p, b in srv.bodies if p == '/api/activity']), 1)
        finally:
            srv.close()

    def test_hook_sends_heartbeat_every_10_minutes_and_sync_clears_it(self):
        srv = FakeServer()
        try:
            cfg = {'server': srv.url, 'token': 't'}
            t0 = sw.tracked()[os.path.abspath(self.dir)]['since']
            sw.cmd_hook(0, self.dir, '7  make', now=t0 + 10, ask=None, cfg=cfg)
            sw.cmd_hook(0, self.dir, '8  make test', now=t0 + 70, ask=None, cfg=cfg)
            beats = [b for p, b in srv.bodies if p == '/api/activity/heartbeat']
            self.assertEqual(len(beats), 1, 'throttled')
            self.assertEqual((beats[0]['folder'], beats[0]['unsynced_count']), (os.path.abspath(self.dir), 1))
            self.assertTrue(beats[0]['oldest'])
            sw.cmd_hook(0, self.dir, '9  ls', now=t0 + 700, ask=None, cfg=cfg)
            self.assertEqual([b['unsynced_count'] for p, b in srv.bodies if p == '/api/activity/heartbeat'], [1, 3])
            sw.sync(cfg)
            self.assertEqual([b for p, b in srv.bodies if p == '/api/activity/heartbeat'][-1]['unsynced_count'], 0)
            # an unreachable server never breaks the prompt
            sw.cmd_hook(0, self.dir, '10  ls -l', now=t0 + 2000, ask=None, cfg={'server': 'http://127.0.0.1:9', 'token': 't'})
        finally:
            srv.close()

    def test_hook_never_prompts_non_interactive(self):
        t0 = sw.tracked()[os.path.abspath(self.dir)]['since']
        sw.cmd_hook(0, self.dir, '7  make', now=t0 + 9999, ask=None)  # ask=None: no terminal to ask on
        self.assertEqual(len(sw.collect(self.dir)['commands']), 1, 'still recorded')


class Ignoring(unittest.TestCase):
    """swjtrack ignore PATH|GLOB: ignored folders and files are never recorded, by any part of the agent."""

    def setUp(self):
        self.home = tempfile.mkdtemp()
        os.environ['SWJTRACK_HOME'] = self.home
        self.dir = os.path.realpath(tempfile.mkdtemp())
        os.makedirs(os.path.join(self.dir, 'secrets'))
        os.makedirs(os.path.join(self.dir, 'backups', 'daily'))
        sw.track(self.dir, 7200)

    def tearDown(self):
        os.environ.pop('SWJTRACK_HOME', None)

    def test_paths_are_stored_absolute_and_globs_as_given(self):
        self.assertEqual(sw.add_ignore(os.path.join(self.dir, 'secrets')), os.path.join(self.dir, 'secrets'))
        self.assertEqual(sw.add_ignore('~/private'), os.path.abspath(os.path.expanduser('~/private')))
        self.assertEqual(sw.add_ignore('backups'), 'backups')
        self.assertEqual(len(sw.ignores()), 3)
        self.assertTrue(sw.remove_ignore('~/private'))
        self.assertFalse(sw.remove_ignore('~/private'))
        self.assertEqual(sw.ignores(), [os.path.join(self.dir, 'secrets'), 'backups'])

    def test_ignored_folders_and_globs_skip_files(self):
        sw.add_ignore(os.path.join(self.dir, 'secrets'))
        sw.add_ignore('backups')
        sw.add_ignore('*.tmp')
        for p in ('secrets/key.pem', 'backups/daily/db.sql', 'scratch.tmp', 'secrets-not/ok.txt', 'app.conf'):
            os.makedirs(os.path.dirname(os.path.join(self.dir, p)), exist_ok=True)
            Path(self.dir, p).write_text('x')
        sw.watch_once(self.dir)
        names = sorted(os.path.relpath(f['path'], self.dir).replace(os.sep, '/') for f in sw.collect(self.dir)['files'])
        self.assertEqual(names, ['app.conf', 'secrets-not/ok.txt'], 'a prefix that is not the same folder still counts')

    def test_commands_typed_in_an_ignored_folder_are_skipped(self):
        sw.add_ignore(os.path.join(self.dir, 'secrets'))
        self.assertFalse(sw.record_cmd(os.path.join(self.dir, 'secrets'), '1  cat key.pem', 0))
        self.assertTrue(sw.record_cmd(self.dir, '2  ls', 0))

    def test_claude_sessions_in_ignored_folders_are_not_sent_and_ignored_files_are_dropped(self):
        srv = FakeServer()
        try:
            cfg = {'server': srv.url, 'token': 't'}
            t = os.path.join(self.home, 't.jsonl')
            transcript(t, [user('tidy up'), tool('Edit', {'file_path': os.path.join(self.dir, 'secrets', 'k')}),
                           tool('Edit', {'file_path': os.path.join(self.dir, 'app.conf')})])
            sw.add_ignore(os.path.join(self.dir, 'secrets'))
            sw.cmd_claude_hook({'transcript_path': t, 'cwd': os.path.join(self.dir, 'secrets'), 'session_id': 'a'}, cfg)
            self.assertEqual(srv.bodies, [])
            sw.cmd_claude_hook({'transcript_path': t, 'cwd': self.dir, 'session_id': 'b'}, cfg)
            self.assertEqual([f['path'] for f in srv.bodies[0][1]['files']], [os.path.join(self.dir, 'app.conf')])
        finally:
            srv.close()

    def test_command_line(self):
        self.assertEqual(sw.main(['ignore']), 0)
        self.assertEqual(sw.main(['ignore', '*.bak']), 0)
        self.assertEqual(sw.main(['unignore', '*.bak']), 0)
        self.assertEqual(sw.main(['unignore', '*.bak']), 1)


class Update(unittest.TestCase):
    """swjtrack update: fetches /swjtrack from the server and installs it only if it is a working script."""

    def setUp(self):
        self.home = tempfile.mkdtemp()
        os.environ['SWJTRACK_HOME'] = self.home
        os.environ['SWJTRACK_NO_WATCH'] = '1'
        self.target = Path(self.home, 'swjtrack')
        self.target.write_text('old')
        self.body = b''
        outer = self

        class H(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200 if self.path == '/swjtrack' else 404)
                self.end_headers()
                self.wfile.write(outer.body)

            def log_message(self, *a):
                pass

        self.httpd = HTTPServer(('127.0.0.1', 0), H)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.cfg = {'server': f'http://127.0.0.1:{self.httpd.server_address[1]}', 'token': 't'}

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        os.environ.pop('SWJTRACK_HOME', None)
        os.environ.pop('SWJTRACK_NO_WATCH', None)

    def test_installs_a_newer_version(self):
        self.body = b"#!/usr/bin/env python3\nVERSION = '9.9.9'\nprint('hi')\n"
        self.assertEqual(sw.cmd_update(self.cfg, str(self.target)), 0)
        self.assertIn("VERSION = '9.9.9'", self.target.read_text())

    def test_same_version_is_left_alone(self):
        self.body = f"#!/usr/bin/env python3\nVERSION = '{sw.VERSION}'\n".encode()
        self.assertEqual(sw.cmd_update(self.cfg, str(self.target)), 0)
        self.assertEqual(self.target.read_text(), 'old')

    def test_refuses_anything_that_is_not_a_working_script(self):
        for body in (b'<html>login</html>', b"#!/usr/bin/env python3\nVERSION = '9.9.9'\ndef (\n"):
            self.body = body
            self.assertEqual(sw.cmd_update(self.cfg, str(self.target)), 1)
            self.assertEqual(self.target.read_text(), 'old')

    def test_the_served_script_is_valid(self):
        text = SCRIPT.read_text(encoding='utf-8')
        compile(text, 'swjtrack', 'exec')
        self.assertEqual(sw._remote_version(text), sw.VERSION)


if __name__ == '__main__':
    unittest.main()

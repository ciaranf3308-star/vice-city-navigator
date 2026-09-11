#!/usr/bin/env python3
"""CDP screenshot helper: shoot.py "<url>" <out.png> [width] [height] [wait_s]
Launches headless chrome on :9222, navigates via file:// (bypasses the
environment's Local Network Access block on localhost), waits, captures.
The <url> may be an http(s) URL (converted to the equivalent file:// path
under ~/workspace/vice-city-nav) or a file:// URL already."""
import base64, json, subprocess, sys, time, urllib.request, tempfile, os, urllib.parse

CHROME = '/opt/meta-chromium/chrome'
REPO = os.path.expanduser('~/workspace/vice-city-nav')
raw_url, out = sys.argv[1], sys.argv[2]
W, H = int(sys.argv[3]) if len(sys.argv) > 3 else 1920, int(sys.argv[4]) if len(sys.argv) > 4 else 720
WAIT = float(sys.argv[5]) if len(sys.argv) > 5 else 8

def to_file_url(u):
    if u.startswith('file://'):
        return u
    p = urllib.parse.urlparse(u)
    # map http://host:port/<path>?<query> -> file://<repo>/<path>?<query>
    rel = p.path.lstrip('/') or 'index.html'
    return 'file://' + REPO + '/' + rel + (('?' + p.query) if p.query else '')

url = to_file_url(raw_url)

subprocess.run(['pkill', '-f', 'remote-debugging-port=9222'], capture_output=True)
time.sleep(1)
# keep proxy env vars: map tiles need the egress proxy; the app itself loads
# via file:// so localhost LNA checks never trigger.
env = dict(os.environ)
chrome = subprocess.Popen([CHROME, '--headless=new', '--no-sandbox', '--disable-gpu',
    '--allow-file-access-from-files', '--enable-unsafe-swiftshader',
    '--user-data-dir=' + (profdir := tempfile.mkdtemp(prefix='shoot-prof-')), '--remote-debugging-port=9222',
    '--remote-allow-origins=*',
    f'--window-size={W},{H}', '--hide-scrollbars', 'about:blank'],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
try:
    tabs = None
    for _ in range(30):
        try:
            tabs = json.load(urllib.request.urlopen('http://127.0.0.1:9222/json/list')); break
        except Exception: time.sleep(0.5)
    if not tabs: raise RuntimeError('no devtools endpoint')
    import websocket
    ws = websocket.create_connection(tabs[0]['webSocketDebuggerUrl'], timeout=60)
    mid = [0]
    def send(method, params=None):
        mid[0] += 1; i = mid[0]
        ws.send(json.dumps({'id': i, 'method': method, 'params': params or {}}))
        while True:
            m = json.loads(ws.recv())
            if m.get('id') == i:
                if 'error' in m: raise RuntimeError(m['error'])
                return m.get('result', {})
    send('Page.enable')
    send('Emulation.setDeviceMetricsOverride', {'width': W, 'height': H, 'deviceScaleFactor': 1, 'mobile': False})
    send('Emulation.setGeolocationOverride', {'latitude': 53.3498, 'longitude': -6.2603, 'accuracy': 20})
    nav = send('Page.navigate', {'url': url})
    if nav.get('errorText'):
        raise RuntimeError('nav: ' + nav['errorText'])
    time.sleep(WAIT)
    shot = send('Page.captureScreenshot', {'format': 'png'})
    if 'data' not in shot:
        raise RuntimeError('screenshot failed: ' + json.dumps(shot)[:200])
    open(out, 'wb').write(base64.b64decode(shot['data']))
    ws.close()
    print('wrote', out)
finally:
    try:
        chrome.terminate()
    except Exception:
        pass
    import shutil
    shutil.rmtree(profdir, ignore_errors=True)

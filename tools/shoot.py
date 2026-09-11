#!/usr/bin/env python3
"""CDP screenshot helper: shoot.py "<url>" <out.png> [width] [height] [wait_s]
Launches headless chrome on :9222, navigates, waits, captures."""
import base64, json, subprocess, sys, time, urllib.request, urllib.parse, tempfile

CHROME = '/opt/meta-chromium/chrome'
url, out = sys.argv[1], sys.argv[2]
W, H = int(sys.argv[3]) if len(sys.argv) > 3 else 1920, int(sys.argv[4]) if len(sys.argv) > 4 else 720
WAIT = float(sys.argv[5]) if len(sys.argv) > 5 else 8

subprocess.run(['pkill', '-f', 'remote-debugging-port=9222'], capture_output=True)
time.sleep(1)
chrome = subprocess.Popen([CHROME, '--headless=new', '--no-sandbox', '--disable-gpu',
    '--user-data-dir=' + tempfile.mkdtemp(prefix='shoot-prof-'), '--remote-debugging-port=9222',
    '--remote-allow-origins=*',
    f'--window-size={W},{H}', '--hide-scrollbars', 'about:blank'],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    info = None
    for _ in range(30):
        try:
            info = json.load(urllib.request.urlopen('http://127.0.0.1:9222/json/new?' + urllib.parse.urlencode({'': url}))); break
        except Exception:
            try:
                tabs = json.load(urllib.request.urlopen('http://127.0.0.1:9222/json/list'))
                info = tabs[0]; break
            except Exception: time.sleep(0.5)
    if info is None: raise RuntimeError('no devtools endpoint')
    ws_url = info['webSocketDebuggerUrl']
    import websocket
    ws = websocket.create_connection(ws_url, timeout=30)
    mid = [0]
    def send(method, params=None):
        mid[0] += 1; i = mid[0]
        ws.send(json.dumps({'id': i, 'method': method, 'params': params or {}}))
        while True:
            m = json.loads(ws.recv())
            if m.get('id') == i: return m.get('result', {})
    send('Page.enable')
    send('Browser.grantPermissions', {'permissions': ['geolocation']})
    send('Emulation.setGeolocationOverride', {'latitude': 53.3498, 'longitude': -6.2603, 'accuracy': 20})
    send('Page.navigate', {'url': url})
    time.sleep(WAIT)
    shot = send('Page.captureScreenshot', {'format': 'png'})
    open(out, 'wb').write(base64.b64decode(shot['data']))
    ws.close()
    print('wrote', out)
finally:
    chrome.terminate()

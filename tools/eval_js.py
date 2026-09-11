#!/usr/bin/env python3
"""eval_js.py "<url>" "<js expression>" — print the expression's value."""
import json, subprocess, sys, time, urllib.request, urllib.parse, tempfile
import websocket
url, expr = sys.argv[1], sys.argv[2]
P = 'remote-debugging-port=9'; P += '224'
subprocess.run(['pkill', '-f', P], capture_output=True); time.sleep(1)
C = '/opt/meta-chrom'; C += 'ium/chrome'
ch = subprocess.Popen([C, '--headless=new', '--no-sandbox', '--disable-gpu',
    '--user-data-dir=' + (profdir := tempfile.mkdtemp(prefix='eval-prof-')), '--remote-debugging-port=9224',
    '--remote-allow-origins=*', 'about:blank'],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    info = None
    for _ in range(40):
        try:
            tabs = json.load(urllib.request.urlopen('http://127.0.0.1:9224/json/list'))
            pages = [t for t in tabs if t.get('type') == 'page']
            if pages:
                info = pages[0]
                break
        except Exception:
            pass
        time.sleep(0.5)
    if info is None:
        raise RuntimeError('no devtools page')
    ws = websocket.create_connection(info['webSocketDebuggerUrl'], timeout=30)
    mid = [0]
    def send(m, p=None):
        mid[0] += 1; i = mid[0]
        ws.send(json.dumps({'id': i, 'method': m, 'params': p or {}}))
        while True:
            r = json.loads(ws.recv())
            if r.get('id') == i: return r.get('result', {})
    send('Page.enable')
    send('Browser.grantPermissions', {'permissions': ['geolocation']})
    send('Emulation.setGeolocationOverride', {'latitude': 53.3498, 'longitude': -6.2603, 'accuracy': 20})
    send('Page.navigate', {'url': url})
    time.sleep(8)
    r = send('Runtime.evaluate', {'expression': expr, 'returnByValue': True})
    res = r['result']
    print('VALUE:', res.get('value', res))
    ws.close()
finally:
    try:
        ch.terminate()
    except Exception:
        pass
    import shutil
    shutil.rmtree(profdir, ignore_errors=True)

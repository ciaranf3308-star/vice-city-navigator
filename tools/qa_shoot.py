#!/usr/bin/env python3
"""QA screenshot at a TRUE 1920x720 layout viewport.
Headless chrome's innerHeight is ~143px short of the window height, so we
open a taller window (1920x863 -> 1920x720 layout) and clip the capture to
the top 1920x720. Usage: qa_shoot.py "<url>" <out.png> [wait_s]"""
import base64, json, subprocess, sys, time, urllib.request, tempfile, os, urllib.parse
CHROME='/opt/meta-chromium/chrome'; REPO=os.path.expanduser('~/workspace/vice-city-nav')
raw_url,out=sys.argv[1],sys.argv[2]; WAIT=float(sys.argv[3]) if len(sys.argv)>3 else 10
def to_file_url(u):
    if u.startswith('file://'): return u
    p=urllib.parse.urlparse(u); rel=p.path.lstrip('/') or 'index.html'
    return 'file://'+REPO+'/'+rel+(('?'+p.query) if p.query else '')
url=to_file_url(raw_url)
subprocess.run(['pkill','-f','remote-debugging-port=9227'],capture_output=True); time.sleep(1)
env=dict(os.environ); profdir=tempfile.mkdtemp(prefix='qashoot-')
chrome=subprocess.Popen([CHROME,'--headless=new','--no-sandbox','--disable-gpu','--allow-file-access-from-files','--enable-unsafe-swiftshader','--user-data-dir='+profdir,'--remote-debugging-port=9227','--remote-allow-origins=*','--window-size=1920,863','--hide-scrollbars','about:blank'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env=env)
try:
    import websocket
    tabs=None
    for _ in range(30):
        try: tabs=json.load(urllib.request.urlopen('http://127.0.0.1:9227/json/list')); break
        except Exception: time.sleep(0.5)
    ws=websocket.create_connection(tabs[0]['webSocketDebuggerUrl'],timeout=60); mid=[0]
    def send(m,p=None):
        mid[0]+=1; i=mid[0]; ws.send(json.dumps({'id':i,'method':m,'params':p or {}}))
        while True:
            r=json.loads(ws.recv())
            if r.get('id')==i:
                if 'error' in r: raise RuntimeError(r['error'])
                return r.get('result',{})
    send('Page.enable'); send('Runtime.enable')
    send('Emulation.setGeolocationOverride',{'latitude':53.3498,'longitude':-6.2603,'accuracy':20})
    send('Page.navigate',{'url':url}); time.sleep(WAIT)
    vp=send('Runtime.evaluate',{'expression':'JSON.stringify({iw:innerWidth,ih:innerHeight})','returnByValue':True})
    print('layout viewport:', vp['result']['value'])
    shot=send('Page.captureScreenshot',{'format':'png','clip':{'x':0,'y':0,'width':1920,'height':720,'scale':1}})
    open(out,'wb').write(base64.b64decode(shot['data'])); ws.close(); print('wrote',out)
finally:
    chrome.terminate(); import shutil; shutil.rmtree(profdir,ignore_errors=True)

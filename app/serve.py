"""Local-only static server required for loading the app's 3D GLB assets."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import os
os.chdir(Path(__file__).resolve().parent)
server = ThreadingHTTPServer(('127.0.0.1', 0), SimpleHTTPRequestHandler)
print('\nTWIN이 준비되었습니다. 아래 주소를 브라우저에서 여세요:\n', flush=True)
print(f'http://127.0.0.1:{server.server_address[1]}/\n', flush=True)
print('종료: Control+C. 파일은 이 컴퓨터에서만 제공됩니다.', flush=True)
try:
    server.serve_forever()
except KeyboardInterrupt:
    server.server_close()

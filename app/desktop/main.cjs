// TWIN Reservoir Lab desktop shell. Serves the bundled web app over a private
// twin:// scheme so fetch(), the GLTF loader and module scripts behave exactly as
// they do under http://, without any network or local server.
const { app, BrowserWindow, Menu, protocol, net, shell, dialog } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');

const APP_ROOT = path.join(__dirname, 'app');
const VERSION = app.getVersion();

protocol.registerSchemesAsPrivileged([
  { scheme: 'twin', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: false } },
]);

function resolveAppFile(requestUrl) {
  const url = new URL(requestUrl);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  const file = path.normalize(path.join(APP_ROOT, pathname));
  if (!file.startsWith(APP_ROOT + path.sep) && file !== APP_ROOT) return null;
  return file;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 960,
    minWidth: 980,
    minHeight: 640,
    title: 'TWIN Reservoir Lab',
    ...(process.platform === 'darwin' ? {} : { icon: path.join(__dirname, 'icon.png') }),
    backgroundColor: '#eef1f3',
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('twin://')) {
      event.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });
  win.loadURL('twin://app/index.html');
  return win;
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { label: 'TWIN Reservoir Lab 정보', click: showAbout },
        { type: 'separator' },
        { role: 'hide', label: 'TWIN 가리기' },
        { role: 'hideOthers', label: '다른 앱 가리기' },
        { role: 'unhide', label: '모두 보기' },
        { type: 'separator' },
        { role: 'quit', label: 'TWIN 종료' },
      ],
    }] : []),
    {
      label: '파일',
      submenu: [
        { label: '새 창', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
        { label: '다시 불러오기', accelerator: 'CmdOrCtrl+R', click: (_, win) => win && win.webContents.reload() },
        { type: 'separator' },
        isMac ? { role: 'close', label: '창 닫기' } : { role: 'quit', label: '종료' },
      ],
    },
    {
      label: '편집',
      submenu: [
        { role: 'undo', label: '실행 취소' },
        { role: 'redo', label: '다시 실행' },
        { type: 'separator' },
        { role: 'cut', label: '잘라내기' },
        { role: 'copy', label: '복사' },
        { role: 'paste', label: '붙여넣기' },
        { role: 'selectAll', label: '모두 선택' },
      ],
    },
    {
      label: '보기',
      submenu: [
        { role: 'resetZoom', label: '실제 크기' },
        { role: 'zoomIn', label: '확대' },
        { role: 'zoomOut', label: '축소' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '전체 화면' },
        { type: 'separator' },
        { role: 'toggleDevTools', label: '개발자 도구' },
      ],
    },
    {
      label: '창',
      submenu: [
        { role: 'minimize', label: '최소화' },
        { role: 'zoom', label: '확대/축소' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front', label: '모두 앞으로' }] : []),
      ],
    },
    {
      label: '도움말',
      submenu: [
        { label: '사용 안내 열기', click: (_, win) => win && win.webContents.executeJavaScript('document.querySelector(\'[data-tab="guide"]\')?.click()') },
        { label: '정보', click: showAbout },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function showAbout() {
  dialog.showMessageBox({
    type: 'info',
    title: 'TWIN Reservoir Lab',
    message: `TWIN Reservoir Lab ${VERSION}`,
    detail: '연구용 댐 운영 시뮬레이터이자 디지털 트윈 시제품입니다. 소양강댐 외형을 참고한 3D 장면과 물수지 모형을 제공하며, 모든 자료는 이 컴퓨터 안에서만 처리됩니다. 실제 시설의 안전 판단에 사용할 수 없습니다.',
    buttons: ['확인'],
  });
}

app.whenReady().then(() => {
  protocol.handle('twin', (request) => {
    const file = resolveAppFile(request.url);
    if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    }
    return net.fetch(pathToFileURL(file).toString());
  });
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

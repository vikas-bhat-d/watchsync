const koffi = require('koffi');

const WS_CHILD = 0x40000000;
const WS_CLIPSIBLINGS = 0x04000000;
const WS_CLIPCHILDREN = 0x02000000;
const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;
const SW_HIDE = 0;
const GW_CHILD = 5;
const GW_HWNDNEXT = 2;

let api;

function getApi() {
  if (process.platform !== 'win32') throw new Error('Embedded mpv windows are currently supported only on Windows.');
  if (api) return api;

  const user32 = koffi.load('user32.dll');
  api = {
    createWindowEx: user32.func(
      'void * __stdcall CreateWindowExW(uint32_t, str16, str16, uint32_t, int32_t, int32_t, int32_t, int32_t, void *, void *, void *, void *)',
    ),
    getWindow: user32.func('void * __stdcall GetWindow(void *, uint32_t)'),
    findWindowEx: user32.func('void * __stdcall FindWindowExW(void *, void *, str16, str16)'),
    getWindowThreadProcessId: user32.func('uint32_t __stdcall GetWindowThreadProcessId(void *, _Out_ uint32_t *)'),
    setWindowPos: user32.func('bool __stdcall SetWindowPos(void *, void *, int32_t, int32_t, int32_t, int32_t, uint32_t)'),
    clientToScreen: user32.func('bool __stdcall ClientToScreen(void *, void *)'),
    showWindow: user32.func('bool __stdcall ShowWindow(void *, int32_t)'),
    destroyWindow: user32.func('bool __stdcall DestroyWindow(void *)'),
    getDesktopWindow: user32.func('void * __stdcall GetDesktopWindow(void)'),
  };
  return api;
}

class Win32VideoHost {
  constructor(parentHandle) {
    this.api = getApi();
    this.parentHandle = parentHandle;
    this.handle = this.api.createWindowEx(
      0,
      'STATIC',
      '',
      WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
      0,
      0,
      1,
      1,
      parentHandle,
      null,
      null,
      null,
    );
    if (this.handle === null || this.handle === 0n) {
      throw new Error('Could not create the embedded mpv video surface.');
    }
  }

  get mpvWindowId() {
    return Number(this.handle & 0xffffffffn);
  }

  getParentClientOrigin() {
    const point = Buffer.alloc(8);
    if (!this.api.clientToScreen(this.parentHandle, point)) {
      throw new Error('Could not read the native video parent origin.');
    }
    return { x: point.readInt32LE(0), y: point.readInt32LE(4) };
  }

  setBounds({ x, y, width, height, scaleFactor = 1, parentOffsetX = 0, parentOffsetY = 0, visible = true }) {
    const scale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
    const bounds = [x, y, width, height].map((value) => Math.round(value * scale));
    const [scaledX, scaledY, scaledWidth, scaledHeight] = bounds;
    const left = scaledX + (Number.isFinite(parentOffsetX) ? Math.round(parentOffsetX) : 0);
    const top = scaledY + (Number.isFinite(parentOffsetY) ? Math.round(parentOffsetY) : 0);
    if (scaledWidth < 1 || scaledHeight < 1) {
      this.api.showWindow(this.handle, SW_HIDE);
      return;
    }

    const result = this.api.setWindowPos(
      this.handle,
      null,
      left,
      top,
      scaledWidth,
      scaledHeight,
      SWP_NOACTIVATE | (visible ? SWP_SHOWWINDOW : 0),
    );
    if (!result) throw new Error('Could not resize the embedded mpv video surface.');
    if (!visible) this.api.showWindow(this.handle, SW_HIDE);
  }

  findChildWindowForProcess(processId) {
    for (let child = this.api.getWindow(this.handle, GW_CHILD), count = 0;
      child !== null && child !== 0n && count < 256;
      child = this.api.getWindow(child, GW_HWNDNEXT), count += 1
    ) {
      const childProcessId = [0];
      this.api.getWindowThreadProcessId(child, childProcessId);
      if (childProcessId[0] === processId) return child;
    }
    return null;
  }

  destroy() {
    if (this.handle !== null && this.handle !== 0n) {
      this.api.destroyWindow(this.handle);
      this.handle = null;
    }
  }
}

function getDesktopWindow() {
  return getApi().getDesktopWindow();
}

function findTopLevelWindowForProcess(processId) {
  const win32 = getApi();
  for (let window = win32.findWindowEx(null, null, null, null), count = 0;
    window !== null && window !== 0n && count < 4096;
    window = win32.findWindowEx(null, window, null, null), count += 1
  ) {
    const windowProcessId = [0];
    win32.getWindowThreadProcessId(window, windowProcessId);
    if (windowProcessId[0] === processId) return window;
  }
  return null;
}

module.exports = { Win32VideoHost, findTopLevelWindowForProcess, getDesktopWindow };
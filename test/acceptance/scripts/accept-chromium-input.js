'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { once } = require('events');
const { app, BrowserWindow } = require('electron');
const { createBrowserRuntimeManager } = require('../../../src/app/backend/browser-runtime');
const { createBrowserNativePointer } = require('../../../src/app/backend/features/browser/browser-native-pointer');

delete process.env.AI_FREE_CHROMIUM_HANDSHAKE;
delete process.env.AI_FREE_CHROMIUM_PATH;

const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-input-'));
app.setPath('userData', profileRoot);
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
let window;
let switchWindow;
let manager;
let server;
let acceptanceFinished = false;

function assertReady(state) {
  if (!state || state.status !== 'ready' || state.bridgeConnected !== true ||
      !state.sessionId || !state.browserHwnd || state.embedded !== true) {
    throw new Error(`Input acceptance runtime state invalid: ${JSON.stringify(state)}`);
  }
}

function driveWin32Input(browserHwnd, addressOnly = false) {
  const source = String.raw`
using System;
using System.Text;
using System.Collections.Generic;
using System.Threading;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using System.Windows.Automation;

public static class AiFreeInputAcceptance {
  delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr parameter);
  const uint GA_ROOT = 2;
  const byte VK_K = 0x4b;
  const byte VK_E = 0x45;
  const byte VK_Y = 0x59;
  const uint KEYEVENTF_KEYUP = 0x0002;
  const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  const uint MOUSEEVENTF_LEFTUP = 0x0004;
  const uint MOUSEEVENTF_WHEEL = 0x0800;

  [StructLayout(LayoutKind.Sequential)]
  struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  struct POINT { public int X, Y; }
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
  [StructLayout(LayoutKind.Sequential)]
  struct GUITHREADINFO {
    public int cbSize;
    public uint flags;
    public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner;
    public IntPtr hwndMoveSize, hwndCaret;
    public RECT rcCaret;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct MOUSEINPUT {
    public int dx, dy;
    public uint mouseData, dwFlags, time;
    public UIntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct KEYBDINPUT {
    public ushort wVk, wScan;
    public uint dwFlags, time;
    public UIntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct HARDWAREINPUT { public uint uMsg; public ushort wParamL, wParamH; }
  [StructLayout(LayoutKind.Explicit)]
  struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mouse;
    [FieldOffset(0)] public KEYBDINPUT keyboard;
    [FieldOffset(0)] public HARDWAREINPUT hardware;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct INPUT { public uint type; public INPUTUNION data; }

  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsChild(IntPtr parent, IntPtr child);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr hwnd, EnumWindowsProc callback, IntPtr parameter);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, IntPtr processId);
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint threadId, ref GUITHREADINFO info);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int maxCount);

  static bool Key(byte key) {
    INPUT[] inputs = new INPUT[2];
    inputs[0].type = 1;
    inputs[0].data.keyboard.wVk = key;
    inputs[0].data.keyboard.wScan = (ushort)MapVirtualKey(key, 0);
    inputs[1] = inputs[0];
    inputs[1].data.keyboard.dwFlags = KEYEVENTF_KEYUP;
    bool sent = SendInput((uint)inputs.Length, inputs,
      Marshal.SizeOf(typeof(INPUT))) == (uint)inputs.Length;
    Thread.Sleep(30);
    return sent;
  }

  static bool Shortcut(ushort key) {
    INPUT[] inputs = new INPUT[4];
    for (int i = 0; i < inputs.Length; ++i) {
      inputs[i].type = 1;
      inputs[i].data.keyboard.wVk = (i == 0 || i == 3) ? (ushort)0x11 : key;
      inputs[i].data.keyboard.dwFlags = i >= 2 ? KEYEVENTF_KEYUP : 0;
    }
    bool sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) == (uint)inputs.Length;
    Thread.Sleep(100);
    return sent;
  }

  static bool TypeText(string text) {
    const uint KEYEVENTF_UNICODE = 0x0004;
    INPUT[] inputs = new INPUT[text.Length * 2];
    for (int i = 0; i < text.Length; i++) {
      int down = i * 2;
      inputs[down].type = 1;
      inputs[down].data.keyboard.wScan = text[i];
      inputs[down].data.keyboard.dwFlags = KEYEVENTF_UNICODE;
      inputs[down + 1] = inputs[down];
      inputs[down + 1].data.keyboard.dwFlags |= KEYEVENTF_KEYUP;
    }
    bool sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) == (uint)inputs.Length;
    Thread.Sleep(150);
    return sent;
  }

  static void Click(int x, int y) {
    if (!SetCursorPos(x, y)) throw new InvalidOperationException("Could not move test cursor");
    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
    Thread.Sleep(150);
  }

  static AutomationElement FindAddressBar(IntPtr hwnd) {
    AutomationElement browser = AutomationElement.FromHandle(hwnd);
    AutomationElement address = null;
    double top = double.PositiveInfinity;
    foreach (AutomationElement edit in browser.FindAll(TreeScope.Descendants,
        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit))) {
      object pattern;
      var bounds = edit.Current.BoundingRectangle;
      // This fixture has only the toolbar edit and the page edit below it.
      if (bounds.IsEmpty || bounds.Width <= 0 || bounds.Height <= 0 || bounds.Top >= top ||
          !edit.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) continue;
      address = edit;
      top = bounds.Top;
    }
    if (address == null) throw new InvalidOperationException("Could not locate the address bar");
    return address;
  }

  static IntPtr FocusedWindow() {
    GUITHREADINFO info = new GUITHREADINFO();
    info.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
    if (!GetGUIThreadInfo(0, ref info)) return IntPtr.Zero;
    return info.hwndFocus;
  }

  static void CheckAddressBar(IntPtr hwnd) {
    AutomationElement edit = FindAddressBar(hwnd);
    ValuePattern value = (ValuePattern)edit.GetCurrentPattern(ValuePattern.Pattern);
    System.Windows.Rect bounds = edit.Current.BoundingRectangle;
    POINT point = new POINT { X = (int)(bounds.Left + bounds.Width / 2), Y = (int)(bounds.Top + bounds.Height / 2) };
    IntPtr hit = WindowFromPoint(point);
    if (hit != hwnd && !IsChild(hwnd, hit))
      throw new InvalidOperationException("Address bar is covered by " + ClassName(hit));
    Click(point.X, point.Y);
    if (GetForegroundWindow() != GetAncestor(hwnd, GA_ROOT))
      throw new InvalidOperationException("Address-bar click did not activate the test owner");
    if (FocusedWindow() != hwnd)
      throw new InvalidOperationException("Address-bar click left keyboard focus on " + ClassName(FocusedWindow()));
    bool editFocused = edit.Current.HasKeyboardFocus;
    string originalValue = value.Current.Value;
    if (!Shortcut(0x41) || !TypeText("key"))
      throw new InvalidOperationException("Windows did not dispatch the test keystrokes");
    string typedValue = value.Current.Value;
    if (typedValue != "key")
      throw new InvalidOperationException("Address bar did not accept typed text after click; editFocused=" +
        editFocused + ", unchanged=" + (typedValue == originalValue) + ", length=" + typedValue.Length +
        ", startsWithExpected=" + typedValue.StartsWith("key", StringComparison.OrdinalIgnoreCase));
    if (!Shortcut(0x41) || !Shortcut(0x43))
      throw new InvalidOperationException("Could not send address-bar copy shortcut");
    Thread.Sleep(150);
    if (!Key(0x08) || value.Current.Value != "" || !Shortcut(0x56))
      throw new InvalidOperationException("Could not clear and paste into the address bar");
    Thread.Sleep(150);
    if (value.Current.Value != "key")
      throw new InvalidOperationException("Address-bar copy/paste round trip failed");
    Key(0x1b);
  }

  static string ClassName(IntPtr hwnd) {
    StringBuilder className = new StringBuilder(256);
    if (hwnd != IntPtr.Zero) GetClassName(hwnd, className, className.Capacity);
    return className.ToString();
  }

  static IntPtr FindRenderWidget(IntPtr root) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(root, delegate(IntPtr child, IntPtr parameter) {
      StringBuilder className = new StringBuilder(256);
      GetClassName(child, className, className.Capacity);
      if (className.ToString().IndexOf("Chrome_RenderWidgetHostHWND", StringComparison.OrdinalIgnoreCase) >= 0) {
        found = child;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  static string DescribeRenderWidgets(IntPtr root) {
    List<string> descriptions = new List<string>();
    EnumChildWindows(root, delegate(IntPtr child, IntPtr parameter) {
      if (ClassName(child).IndexOf("Chrome_RenderWidgetHostHWND", StringComparison.OrdinalIgnoreCase) >= 0) {
        RECT rect;
        GetWindowRect(child, out rect);
        descriptions.Add(child.ToInt64().ToString() + ":V=" + IsWindowVisible(child) +
          ":E=" + IsWindowEnabled(child) + ":P=" + GetParent(child).ToInt64().ToString() +
          ":R=" + rect.Left + "," + rect.Top + "," + rect.Right + "," + rect.Bottom);
      }
      return true;
    }, IntPtr.Zero);
    return String.Join("|", descriptions.ToArray());
  }

  public static string Drive(long rawHwnd, bool addressOnly) {
    SetProcessDPIAware();
    IntPtr hwnd = new IntPtr(rawHwnd);
    if (!IsWindow(hwnd)) return "ALIVE=false;TITLE=";
    IntPtr root = GetAncestor(hwnd, GA_ROOT);
    RECT shellRect, browserRect;
    if (!GetWindowRect(root, out shellRect) || !GetWindowRect(hwnd, out browserRect))
      throw new InvalidOperationException("Missing test window bounds");
    if (!addressOnly) {
      Click(shellRect.Left + 70, browserRect.Top - 12);
      IntPtr focus = FocusedWindow();
      if (GetForegroundWindow() != root || focus == IntPtr.Zero || focus == hwnd || IsChild(hwnd, focus))
        throw new InvalidOperationException("Expected keyboard focus in the Electron host before clicking; foreground=" +
          ClassName(GetForegroundWindow()) + ", focus=" + ClassName(focus));
    }
    IDataObject previousClipboard;
    try {
      previousClipboard = Clipboard.GetDataObject();
    } catch (ExternalException error) {
      throw new InvalidOperationException("Could not snapshot the Windows clipboard", error);
    }
    Exception inputError = null;
    try {
      CheckAddressBar(hwnd);
      if (addressOnly) return "ADDRESS_BAR_OK";
      // The address bar must work both before and after a click in web content.
      Click((browserRect.Left + browserRect.Right) / 2, (browserRect.Top + browserRect.Bottom) / 2);
      CheckAddressBar(hwnd);
    } catch (Exception error) {
      inputError = error;
      throw;
    } finally {
      try {
        if (previousClipboard != null) Clipboard.SetDataObject(previousClipboard, true, 10, 100);
        else Clipboard.Clear();
      } catch (ExternalException error) {
        string context = inputError == null ? "" : "; input check: " + inputError.Message;
        throw new InvalidOperationException("Could not restore the Windows clipboard" + context, error);
      }
    }
    RECT rect;
    if (!GetWindowRect(hwnd, out rect)) throw new InvalidOperationException("Missing test browser bounds");
    Click((rect.Left + rect.Right) / 2, (rect.Top + rect.Bottom) / 2);
    bool keysSent = Key(VK_K) && Key(VK_E) && Key(VK_Y);
    Thread.Sleep(1500);
    if (GetWindowRect(hwnd, out rect)) {
      SetCursorPos((rect.Left + rect.Right) / 2, (rect.Top + rect.Bottom) / 2);
      mouse_event(MOUSEEVENTF_WHEEL, 0, 0, -240, UIntPtr.Zero);
      Thread.Sleep(150);
      mouse_event(MOUSEEVENTF_WHEEL, 0, 0, 120, UIntPtr.Zero);
    }
    StringBuilder title = new StringBuilder(512);
    GetWindowText(hwnd, title, title.Capacity);
    GUITHREADINFO threadInfo = new GUITHREADINFO();
    threadInfo.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
    GetGUIThreadInfo(GetWindowThreadProcessId(hwnd, IntPtr.Zero), ref threadInfo);
    return "ALIVE=" + IsWindow(hwnd).ToString().ToLowerInvariant() +
      ";TITLE=" + title.ToString() +
      ";KEYS_SENT=" + keysSent.ToString().ToLowerInvariant() +
      ";FOREGROUND_CLASS=" + ClassName(GetForegroundWindow()) +
      ";FOCUS_CLASS=" + ClassName(threadInfo.hwndFocus) +
      ";ACTIVE_CLASS=" + ClassName(threadInfo.hwndActive) +
      ";RWHV=" + DescribeRenderWidgets(hwnd);
  }
}`;
  const script = `$ErrorActionPreference = 'Stop'\nAdd-Type -ReferencedAssemblies System.Windows.Forms,UIAutomationClient,UIAutomationTypes,WindowsBase -TypeDefinition @'\n${source}\n'@\n` +
    `[AiFreeInputAcceptance]::Drive([long]'${browserHwnd}', $${addressOnly})`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Sta', '-WindowStyle', 'Hidden', '-Command',
      'Invoke-Command -ScriptBlock ([scriptblock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))))',
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', reject);
    child.stdin.end(encoded);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Win32 input driver timed out'));
    }, 30000);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Win32 input driver failed: ${stderr || stdout}`));
      else resolve(stdout.trim());
    });
  });
}

async function observeNativeTabButton(pointer, profileId) {
  const deadline = Date.now() + 3000;
  let observation;
  do {
    observation = pointer.observe(profileId, 'chromium');
    const button = observation.items?.find(({ role, label }) => role === 'button' && /new tab|新(?:建)?标签页|新增分頁|新分頁/i.test(label));
    if (button && observation.items.some(({ role }) => role === 'tab')) {
      console.log(`[phase2-input] Native pointer observed ${observation.items.length} controls including a tab`);
      return { observation, button };
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  } while (Date.now() < deadline);
  const controls = observation.items?.map(({ role, label }) => ({ role, label }));
  throw new Error(`Native tab observation unavailable: ${JSON.stringify(controls ?? observation.errorCode)}`);
}

async function verifyNativeNewTab(owner, runtime, state) {
  const profileId = state.profileId;
  const pointer = createBrowserNativePointer({ getMainWindow: () => owner, getActiveProfileId: () => profileId, runtime });
  const list = async () => (await runtime.dispatchAutomationByProcessId(state.pid, 'list-tabs', {})).result.tabs;
  const before = await list();
  const { observation, button } = await observeNativeTabButton(pointer, profileId);
  const result = await pointer.action(profileId, {
    surface: 'chromium', action: 'click', ref: button.ref, observation_id: observation.observationId,
  }, {}, new AbortController().signal);
  if (!result.dispatched) throw new Error(`Native New Tab click was not dispatched: ${JSON.stringify(result)}`);
  const deadline = Date.now() + 3000;
  do {
    const after = await list();
    if (after.length === before.length + 1) {
      const created = after.find(({ active }) => active);
      await runtime.dispatchAutomationByProcessId(state.pid, 'close-tab', { tabId: created.id });
      console.log('[phase2-input] Native pointer opened a new Chromium tab');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error('Native New Tab click did not increase the Chromium tab count');
}

function resolveTestResources() {
  const bundled = path.resolve(__dirname, '..', '..', '..', 'resources');
  const candidate = process.argv[2];
  if (!candidate) return bundled;
  const fixtureRoot = process.env.AI_FREE_FIXTURE_ROOT;
  if (!fixtureRoot || !path.isAbsolute(candidate) || path.basename(candidate) !== 'chrome.dll') {
    throw new Error('DLL comparison requires an absolute chrome.dll path and the fixture runner');
  }
  const isolated = path.join(fixtureRoot, 'candidate-resources');
  const chromium = path.join(isolated, 'chromium');
  fs.cpSync(path.join(bundled, 'chromium'), chromium, { recursive: true });
  fs.copyFileSync(candidate, path.join(chromium, 'chrome.dll'));
  require('../../../scripts/chromium-runtime-manifest').writeChromiumRuntimeManifest(chromium);
  return isolated;
}

async function verifyAddressBarAcrossProfiles(runtime, first, bounds, url) {
  const secondId = 'phase2_input_second';
  await runtime.hide(first.profileId, 'chromium');
  const second = await runtime.launchProfile({
    profileId: secondId,
    runtimeType: 'chromium',
    initialUrl: url,
    launchTimeoutMs: 30000,
  }, bounds);
  assertReady(second);
  const navigation = await runtime.navigate(secondId, 'chromium', url);
  if (!navigation?.ok) throw new Error('Second test browser failed to navigate');
  await runtime.hide(secondId, 'chromium');
  // Keep desktop overlays out of the click path without focusing a browser HWND.
  window.setAlwaysOnTop(true);
  window.focus();
  let previous;
  for (const profile of [first, second, first]) {
    if (previous) await runtime.hide(previous.profileId, 'chromium');
    await runtime.show(profile.profileId, 'chromium');
    try {
      const result = await driveWin32Input(profile.browserHwnd, true);
      if (result !== 'ADDRESS_BAR_OK') throw new Error(result);
    } catch (error) {
      throw new Error(`First address-bar click failed after ${previous?.profileId || 'initial switch'} -> ${profile.profileId}: ${error.message}`, { cause: error });
    }
    console.log(`[phase2-input] Address bar accepted input and copy/paste in ${profile.profileId}`);
    previous = profile;
  }
}

async function shutdown(code) {
  acceptanceFinished = true;
  try { await manager?.stopAll({ timeoutMs: 5000 }); } catch (_) {}
  try { switchWindow?.destroy(); } catch (_) {}
  try { window?.destroy(); } catch (_) {}
  if (server) {
    try { await new Promise((resolve) => server.close(resolve)); } catch (_) {}
  }
  try { fs.rmSync(profileRoot, { recursive: true, force: true }); } catch (_) {}
  app.exit(code);
}

app.whenReady().then(async () => {
  server = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.end(`<!doctype html>
      <title>WAITING_FOR_INPUT</title>
      <input id="target" autofocus style="position:fixed;inset:20px;font-size:40px">
      <script>
        const target = document.getElementById('target');
        let clicked = false;
        const update = () => {
          document.title = 'AI_FREE_CLICK_' + (clicked ? 'OK' : 'MISSING') +
            '_KEY_' + (target.value || 'EMPTY');
        };
        target.addEventListener('click', () => { clicked = true; update(); });
        target.addEventListener('input', update);
      <\/script>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  window = new BrowserWindow({ width: 1280, height: 850, frame: false, show: true, title: 'AI-FREE Input Acceptance' });
  await window.loadURL('data:text/html,<input aria-label="Host input" style="position:absolute;left:10px;top:8px">');
  manager = createBrowserRuntimeManager({
    userDataDir: profileRoot,
    resourcesPath: resolveTestResources(),
    getParentWindow: () => window,
    logger: console,
  });
  const bounds = { x: 0, y: 41, width: 1280, height: 809 };
  const inputPageUrl = `http://127.0.0.1:${server.address().port}/input`;
  const state = await manager.launchProfile({
    profileId: 'phase2_input',
    runtimeType: 'chromium',
    initialUrl: 'about:blank',
    launchTimeoutMs: 30000,
  }, bounds);
  assertReady(state);
  const navigation = await manager.navigate('phase2_input', 'chromium', inputPageUrl);
  if (!navigation?.ok) {
    throw new Error(`Runtime Bridge navigation failed: ${JSON.stringify(navigation)}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const heartbeatBefore = state.lastHeartbeatAt;
  await manager.resize('phase2_input', 'chromium', { ...bounds, width: 1278, height: 807 });
  await manager.show('phase2_input', 'chromium');
  window.show();
  window.moveTop();
  window.focus();
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (process.env.AI_FREE_NATIVE_POINTER_ONLY === '1') {
    await verifyNativeNewTab(window, manager, state);
    await shutdown(0);
    return;
  }
  const focusResult = await manager.focus('phase2_input', 'chromium');
  console.log('[phase2-input] native focus result:', focusResult);
  switchWindow = new BrowserWindow({ width: 320, height: 180, show: true, title: 'Focus switch probe' });
  await switchWindow.loadURL('data:text/html,<title>FOCUS_SWITCH_PROBE</title>');
  switchWindow.show();
  switchWindow.focus();
  await new Promise((resolve) => setTimeout(resolve, 300));
  window.show();
  window.moveTop();
  window.focus();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const manualWaitMs = Math.max(0, Number(process.env.AI_FREE_INPUT_MANUAL_WAIT_MS) || 0);
  if (manualWaitMs > 0) {
    console.log(`[phase2-input] manual input window: ${manualWaitMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, manualWaitMs));
  }
  await verifyAddressBarAcrossProfiles(manager, state, bounds, inputPageUrl);
  if (process.argv[2]) {
    console.log('[phase2-input] Candidate DLL passed address-bar focus across two browser profiles');
    await shutdown(0);
    return;
  }
  // Exercise the explicit handoff used when the Electron UI takes focus.
  await manager.releaseFocus(state.profileId, 'chromium');
  window.webContents.focus();
  const inputResult = await driveWin32Input(state.browserHwnd);
  await new Promise((resolve) => setTimeout(resolve, 3500));
  const after = manager.getState('phase2_input');
  assertReady(after);
  const title = /;TITLE=(.*?);KEYS_SENT=/.exec(inputResult)?.[1] || '';
  const heartbeatAdvanced = after.lastHeartbeatAt > heartbeatBefore;
  const windowAlive = /ALIVE=true/.test(inputResult);
  const pageInputPassed = /;TITLE=AI_FREE_CLICK_OK_KEY_key(?:;| - )/.test(inputResult);
  if (!heartbeatAdvanced || !windowAlive || !pageInputPassed) {
    throw new Error(`Input acceptance failed: heartbeatAdvanced=${heartbeatAdvanced}, windowAlive=${windowAlive}, pageInputPassed=${pageInputPassed}, fixtureTitle=${title.startsWith('AI_FREE_CLICK_') ? title : 'not reported'}`);
  }
  console.log('[phase2-input] Web input typing, wheel, resize and focus passed');
  console.log('[phase2-input] HWND result:', inputResult);
  await verifyNativeNewTab(window, manager, after);
  await shutdown(0);
}).catch(async (error) => {
  console.error('[phase2-input] FAILED', error.stack || error);
  await shutdown(1);
});

app.on('window-all-closed', () => {
  if (acceptanceFinished) return;
  console.error('[phase2-input] FAILED acceptance window was closed before assertions completed');
  void shutdown(1);
});

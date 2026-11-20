#include "browser_pointer_observe.h"
#include <windowsx.h>
#include <array>
#include <utility>

namespace {
constexpr wchar_t kPointerClass[] = L"AiFreeAutomationPointer";
thread_local HWND overlay = nullptr;
thread_local HWND overlay_owner = nullptr;

DWORD ProcessId(HWND hwnd) {
  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  return pid;
}

bool BelongsTo(HWND window, HWND root) {
  for (HWND current = GetAncestor(window, GA_ROOT); current; current = GetWindow(current, GW_OWNER)) {
    if (current == root || IsChild(root, current)) return true;
    HWND owner = GetWindow(current, GW_OWNER);
    if (owner && IsChild(root, owner)) return true;
  }
  return false;
}

struct Scope {
  HWND root;
  HWND browser;
  DWORD browser_pid;

  bool Valid() const {
    return root && browser && browser_pid && ProcessId(root) == GetCurrentProcessId() &&
           ProcessId(browser) == browser_pid && IsChild(root, browser) &&
           IsWindowVisible(browser);
  }

  bool Allows(HWND window) const {
    if (!window || window == overlay || !IsWindowVisible(window) || !BelongsTo(window, root)) return false;
    const DWORD pid = ProcessId(window);
    return pid == browser_pid || pid == GetCurrentProcessId();
  }
};

LRESULT CALLBACK PointerProc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
  if (message == WM_NCHITTEST) return HTTRANSPARENT;
  if (message == WM_PAINT) {
    PAINTSTRUCT paint;
    HDC dc = BeginPaint(window, &paint);
    RECT bounds;
    GetClientRect(window, &bounds);
    HBRUSH background = CreateSolidBrush(RGB(255, 0, 255));
    FillRect(dc, &bounds, background);
    DeleteObject(background);
    HBRUSH white = static_cast<HBRUSH>(GetStockObject(WHITE_BRUSH));
    HPEN outline = CreatePen(PS_SOLID, 2, RGB(20, 91, 196));
    HGDIOBJ old_brush = SelectObject(dc, white);
    HGDIOBJ old_pen = SelectObject(dc, outline);
    const POINT shape[] = {{2, 2}, {6, 21}, {11, 14}, {19, 13}};
    Polygon(dc, shape, 4);
    SelectObject(dc, old_pen);
    SelectObject(dc, old_brush);
    DeleteObject(outline);
    EndPaint(window, &paint);
    return 0;
  }
  return DefWindowProcW(window, message, wparam, lparam);
}

void HideOverlay() {
  if (IsWindow(overlay)) DestroyWindow(overlay);
  overlay = overlay_owner = nullptr;
}

bool DrawOverlay(HWND owner, POINT point) {
  if (!IsWindow(overlay) || overlay_owner != owner) {
    HideOverlay();
    const HINSTANCE module = GetModuleHandleW(nullptr);
    WNDCLASSW cls{};
    cls.lpfnWndProc = PointerProc;
    cls.hInstance = module;
    cls.lpszClassName = kPointerClass;
    if (!RegisterClassW(&cls) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) return false;
    overlay = CreateWindowExW(WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
        kPointerClass, L"", WS_POPUP, point.x - 2, point.y - 2, 24, 25, owner, nullptr, module, nullptr);
    if (!overlay) return false;
    overlay_owner = owner;
    if (!SetLayeredWindowAttributes(overlay, RGB(255, 0, 255), 0, LWA_COLORKEY)) {
      HideOverlay();
      return false;
    }
  }
  return SetWindowPos(overlay, HWND_TOP, point.x - 2, point.y - 2, 0, 0,
                      SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW) != FALSE;
}

napi_value RectValue(napi_env env, const RECT& rect) {
  napi_value result;
  napi_create_object(env, &result);
  const std::array<const char*, 4> names = {"x", "y", "width", "height"};
  const std::array<LONG, 4> values = {rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top};
  for (size_t i = 0; i < names.size(); ++i) {
    napi_value value;
    napi_create_int32(env, values[i], &value);
    napi_set_named_property(env, result, names[i], value);
  }
  return result;
}

BOOL CALLBACK FindFileDialogView(HWND child, LPARAM data) {
  wchar_t name[32] = {};
  if (!GetClassNameW(child, name, 32) || wcscmp(name, L"DUIViewWndClassName") != 0) return TRUE;
  *reinterpret_cast<bool*>(data) = true;
  return FALSE;
}

bool IsFileDialog(HWND hwnd) {
  wchar_t name[32] = {};
  if (!GetClassNameW(hwnd, name, 32) || wcscmp(name, L"#32770") != 0) return false;
  bool found = false;
  EnumChildWindows(hwnd, FindFileDialogView, reinterpret_cast<LPARAM>(&found));
  return found;
}

HWND ChromiumPopup(const Scope& scope) {
  for (HWND window = GetTopWindow(nullptr); window; window = GetWindow(window, GW_HWNDNEXT)) {
    if (window == scope.root || ProcessId(window) != scope.browser_pid || !scope.Allows(window)) continue;
    wchar_t name[64] = {};
    if (GetClassNameW(window, name, 64) &&
        (wcsncmp(name, L"Chrome_WidgetWin_", 17) == 0 || wcscmp(name, L"#32768") == 0)) return window;
  }
  return nullptr;
}

HWND Target(const Scope& scope, POINT point, const std::wstring& surface) {
  HWND window = WindowFromPoint(point);
  if (!scope.Allows(window)) return nullptr;
  HWND top = GetAncestor(window, GA_ROOT);
  if (surface == L"dialog") {
    return top == GetForegroundWindow() && IsFileDialog(top) ? window : nullptr;
  }
  if (surface == L"chromium_popup") {
    return top == ChromiumPopup(scope) && ProcessId(window) == scope.browser_pid ? window : nullptr;
  }
  if (surface == L"chromium") {
    const HWND foreground = GetForegroundWindow();
    if (foreground != scope.root || !IsWindowEnabled(scope.browser)) return nullptr;
    return (window == scope.browser || IsChild(scope.browser, window)) &&
           ProcessId(window) == scope.browser_pid ? window : nullptr;
  }
  return nullptr;
}

bool SendMouse(HWND target, POINT point, const std::wstring& op, bool held, int delta) {
  if (op == L"wheel") return PostMessageW(target, WM_MOUSEWHEEL, MAKEWPARAM(0, delta), MAKELPARAM(point.x, point.y));
  if (!ScreenToClient(target, &point)) return false;
  UINT message = WM_MOUSEMOVE;
  WPARAM flags = held ? MK_LBUTTON : 0;
  if (op == L"down") { message = WM_LBUTTONDOWN; flags = MK_LBUTTON; }
  if (op == L"double_down") { message = WM_LBUTTONDBLCLK; flags = MK_LBUTTON; }
  if (op == L"up") { message = WM_LBUTTONUP; flags = 0; }
  if (op == L"right_down") { message = WM_RBUTTONDOWN; flags = MK_RBUTTON; }
  if (op == L"right_up") message = WM_RBUTTONUP;
  return PostMessageW(target, message, flags, MAKELPARAM(point.x, point.y)) != FALSE;
}

bool SendKeyboard(const Scope& scope, HWND target, const std::wstring& op, const std::wstring& text) {
  GUITHREADINFO gui{sizeof(gui)};
  const DWORD thread = GetWindowThreadProcessId(target, nullptr);
  if (!GetGUIThreadInfo(thread, &gui) || !scope.Allows(gui.hwndFocus) ||
      GetAncestor(gui.hwndFocus, GA_ROOT) != GetAncestor(target, GA_ROOT) ||
      ProcessId(gui.hwndFocus) != ProcessId(target)) return false;
  if (op == L"key") {
    const std::pair<const wchar_t*, WPARAM> keys[] = {
        {L"enter", VK_RETURN}, {L"escape", VK_ESCAPE}, {L"tab", VK_TAB},
        {L"arrowdown", VK_DOWN}, {L"arrowup", VK_UP}, {L"arrowleft", VK_LEFT},
        {L"arrowright", VK_RIGHT}, {L"backspace", VK_BACK}, {L"delete", VK_DELETE},
    };
    for (const auto& key : keys) {
      if (text == key.first) {
        const LPARAM scan = static_cast<LPARAM>(MapVirtualKeyW(static_cast<UINT>(key.second), MAPVK_VK_TO_VSC)) << 16;
        return PostMessageW(gui.hwndFocus, WM_KEYDOWN, key.second, scan | 1) &&
               PostMessageW(gui.hwndFocus, WM_KEYUP, key.second, scan | 0xC0000001);
      }
    }
    return false;
  }
  if (op != L"text" || text.empty() || text.size() > 2048) return false;
  for (wchar_t character : text) {
    if (character < 32 || character == 127) return false;
  }
  for (wchar_t character : text) {
    if (!PostMessageW(gui.hwndFocus, WM_CHAR, character, 1)) return false;
  }
  return true;
}
}  // namespace

napi_value BrowserPointerFrame(napi_env env, napi_callback_info info) {
  napi_value args = SingleObjectArg(env, info);
  if (!args) return nullptr;
  const auto op = ReadWideString(env, GetNamed(env, args, "op"));
  if (op == L"hide") {
    HideOverlay();
    return BoolValue(env, true);
  }
  const Scope scope{ReadHwnd(env, GetNamed(env, args, "rootHwnd")),
                    ReadHwnd(env, GetNamed(env, args, "browserHwnd")),
                    static_cast<DWORD>(ReadInt32(env, args, "browserPid"))};
  if (!scope.Valid()) return BoolValue(env, false);
  const HWND expected = ReadHwnd(env, GetNamed(env, args, "expectedHwnd"));
  if (op == L"cancel") {
    return BoolValue(env, scope.Allows(expected) && PostMessageW(expected, WM_CANCELMODE, 0, 0));
  }
  if (!scope.Allows(GetForegroundWindow())) return BoolValue(env, false);
  const auto surface = ReadWideString(env, GetNamed(env, args, "surface"));
  if (op == L"bounds" || op == L"observe") {
    HWND target = scope.browser;
    if (surface == L"dialog") target = GetForegroundWindow();
    if (surface == L"chromium_popup") target = ChromiumPopup(scope);
    RECT rect{};
    if (surface == L"dialog" && !IsFileDialog(target)) return BoolValue(env, false);
    if (!GetWindowRect(target, &rect)) return BoolValue(env, false);
    napi_value result = RectValue(env, rect);
    napi_set_named_property(env, result, "window", HwndValue(env, target));
    if (op == L"observe") {
      if (surface == L"overlay") return BoolValue(env, false);
      napi_set_named_property(env, result, "items", ObserveBrowserControls(env, target, rect));
    }
    return result;
  }
  POINT point{ReadInt32(env, args, "x"), ReadInt32(env, args, "y")};
  if (op == L"app_hit") {
    const HWND hit = WindowFromPoint(point);
    return BoolValue(env, scope.Allows(hit) && ProcessId(hit) == GetCurrentProcessId() &&
                        GetAncestor(hit, GA_ROOT) == scope.root);
  }
  if (op == L"draw" || op == L"visible") {
    HWND hit = WindowFromPoint(point);
    return BoolValue(env, scope.Allows(hit) &&
        (op == L"visible" || DrawOverlay(GetForegroundWindow(), point)));
  }
  HWND target = Target(scope, point, surface);
  if (!target) return BoolValue(env, false);
  if (op == L"target") return HwndValue(env, target);
  if (expected != target) return BoolValue(env, false);
  if (op == L"text" || op == L"key") {
    return BoolValue(env, SendKeyboard(scope, target, op,
        ReadWideString(env, GetNamed(env, args, op == L"key" ? "key" : "text"))));
  }
  if (op != L"move" && op != L"drag" && op != L"wheel" && op != L"down" && op != L"up" &&
      op != L"double_down" && op != L"right_down" && op != L"right_up") return BoolValue(env, false);
  return BoolValue(env, SendMouse(target, point, op, op == L"drag", ReadInt32(env, args, "delta")));
}

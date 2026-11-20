#include "browser_pointer_observe.h"

#include <objbase.h>
#include <oleauto.h>
#include <UIAutomation.h>
#include <wrl/client.h>
#include <algorithm>
#include <utility>

namespace {
using Microsoft::WRL::ComPtr;
constexpr int kMaximumNodes = 240;
constexpr int kMaximumItems = 80;
constexpr int kMaximumDepth = 12;

const char* ControlRole(CONTROLTYPEID type) {
  switch (type) {
    case UIA_ButtonControlTypeId: return "button";
    case UIA_EditControlTypeId: return "textbox";
    case UIA_ComboBoxControlTypeId: return "combobox";
    case UIA_TabItemControlTypeId: return "tab";
    case UIA_ListItemControlTypeId: return "option";
    case UIA_MenuItemControlTypeId: return "menuitem";
    case UIA_TreeItemControlTypeId: return "treeitem";
    case UIA_DataItemControlTypeId: return "row";
    case UIA_HyperlinkControlTypeId: return "link";
    case UIA_CheckBoxControlTypeId: return "checkbox";
    default: return nullptr;
  }
}

void SetNumber(napi_env env, napi_value item, const char* key, LONG number) {
  napi_value value;
  napi_create_int32(env, number, &value);
  napi_set_named_property(env, item, key, value);
}

void SetText(napi_env env, napi_value item, const char* key, const char* text) {
  napi_value value;
  napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, item, key, value);
}

struct Observation {
  napi_env env;
  napi_value items;
  RECT bounds;
  IUIAutomationTreeWalker* walker;
  int remaining = kMaximumNodes;
  uint32_t count = 0;
  ULONGLONG deadline = GetTickCount64() + 350;

  bool HasBudget() const {
    return remaining > 0 && count < kMaximumItems && GetTickCount64() < deadline;
  }

  void Append(IUIAutomationElement* element, const char* role) {
    BOOL password = TRUE;
    BOOL offscreen = TRUE;
    BOOL enabled = FALSE;
    RECT rect{}, visible{};
    if (FAILED(element->get_CurrentIsPassword(&password)) || password ||
        FAILED(element->get_CurrentIsOffscreen(&offscreen)) || offscreen ||
        FAILED(element->get_CurrentIsEnabled(&enabled)) || !enabled ||
        FAILED(element->get_CurrentBoundingRectangle(&rect)) ||
        !IntersectRect(&visible, &rect, &bounds)) return;
    BSTR name = nullptr;
    if (FAILED(element->get_CurrentName(&name)) || !name || !SysStringLen(name)) {
      SysFreeString(name);
      return;
    }
    napi_value item, label;
    napi_create_object(env, &item);
    napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(name),
                            std::min(SysStringLen(name), 180u), &label);
    SysFreeString(name);
    napi_set_named_property(env, item, "label", label);
    SetText(env, item, "role", role);
    POINT point{(visible.left + visible.right) / 2, (visible.top + visible.bottom) / 2};
    POINT suggested{};
    BOOL clickable = FALSE;
    if (SUCCEEDED(element->GetClickablePoint(&suggested, &clickable)) && clickable && PtInRect(&visible, suggested)) {
      point = suggested;
    }
    SetNumber(env, item, "x", point.x - bounds.left);
    SetNumber(env, item, "y", point.y - bounds.top);
    napi_set_element(env, items, count++, item);
  }

  void Visit(IUIAutomationElement* element, int depth) {
    if (!HasBudget() || depth > kMaximumDepth) return;
    --remaining;
    CONTROLTYPEID type = 0;
    if (FAILED(element->get_CurrentControlType(&type)) || type == UIA_DocumentControlTypeId) return;
    if (const char* role = ControlRole(type)) Append(element, role);
    ComPtr<IUIAutomationElement> child;
    walker->GetFirstChildElement(element, &child);
    while (child && HasBudget() && depth < kMaximumDepth) {
      Visit(child.Get(), depth + 1);
      ComPtr<IUIAutomationElement> next;
      walker->GetNextSiblingElement(child.Get(), &next);
      child = std::move(next);
    }
  }
};

void Collect(Observation* observation, HWND window) {
  ComPtr<IUIAutomation> automation;
  if (FAILED(CoCreateInstance(__uuidof(CUIAutomation8), nullptr, CLSCTX_INPROC_SERVER,
                              IID_PPV_ARGS(&automation)))) return;
  ComPtr<IUIAutomation2> settings;
  if (SUCCEEDED(automation.As(&settings))) {
    settings->put_ConnectionTimeout(200);
    settings->put_TransactionTimeout(200);
  }
  ComPtr<IUIAutomationTreeWalker> walker;
  ComPtr<IUIAutomationElement> root;
  if (FAILED(automation->get_ControlViewWalker(&walker)) || !walker ||
      FAILED(automation->ElementFromHandle(window, &root)) || !root) return;
  observation->walker = walker.Get();
  observation->Visit(root.Get(), 0);
}
}  // namespace

napi_value ObserveBrowserControls(napi_env env, HWND window, const RECT& bounds) {
  const HRESULT initialized = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  if (FAILED(initialized) && initialized != RPC_E_CHANGED_MODE) return BoolValue(env, false);
  napi_value items;
  napi_create_array(env, &items);
  Observation observation{env, items, bounds, nullptr};
  Collect(&observation, window);
  if (SUCCEEDED(initialized)) CoUninitialize();
  return items;
}

#pragma once

#include "native_helpers.h"

napi_value ObserveBrowserControls(napi_env env, HWND window, const RECT& bounds);

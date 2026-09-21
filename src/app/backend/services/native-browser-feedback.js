'use strict';

function requestsAccessibility(input) {
  return input.include_accessibility_tree === true || input.includeAccessibilityTree === true;
}

function accessibilityUnavailable(result = {}) {
  if (result.accessibilityTreeSupported === true) return {
    success: false, errorCode: 'ACCESSIBILITY_TREE_NOT_READY',
    error: '页面结构尚未就绪，请等待页面加载后重新观察。', retryable: true,
  };
  return { success: false, errorCode: 'BROWSER_RUNTIME_UPDATE_REQUIRED',
    error: '当前 Chromium 未提供完整 Accessibility Tree，请更新内核后重试。', retryable: false };
}

async function attachScreenshot(service, connection, observation, input) {
  if (input.include_screenshot !== true || observation.success === false) return observation;
  try {
    const screenshot = await service.runtimeCommand(connection, 'capture-screenshot', {});
    if (screenshot.success === false || !screenshot.dataUrl) {
      return { ...observation, screenshotError: { errorCode: screenshot.errorCode || 'SCREENSHOT_UNAVAILABLE' } };
    }
    return { ...observation, dataUrl: screenshot.dataUrl, screenshot: {
      width: screenshot.width, height: screenshot.height, format: 'png',
    } };
  } catch (_) {
    return { ...observation, screenshotError: { errorCode: 'SCREENSHOT_UNAVAILABLE' } };
  }
}

async function actionObservation(service, connection, result, input) {
  if (input.after !== 'observe' || result?.success === false || result?.ok === false) return result;
  try {
    const observed = await service.browserObserve(connection, { mark: false, ...input.observation_options });
    const { dataUrl, ...observation } = observed;
    return { ...result, actionExecuted: true, observation,
      needsObservation: observation.success === false,
      ...(dataUrl ? { dataUrl } : {}) };
  } catch (_) {
    // The action already ran. A failed read must never cause an automatic replay.
    return { ...result, actionExecuted: true, needsObservation: true,
      observationError: { errorCode: 'POST_ACTION_OBSERVATION_UNAVAILABLE', retryable: true } };
  }
}

module.exports = { requestsAccessibility, accessibilityUnavailable, attachScreenshot, actionObservation };

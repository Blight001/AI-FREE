'use strict';

const TUTORIAL_BROWSER_TITLE = '使用教程和商城';
const LEGACY_TUTORIAL_BROWSER_TITLE = '使用教程[AI-FREE]';
const DEFAULT_TUTORIAL_URL = 'https://www.yuque.com/kelingaishipindian/tx5gwq/xbsl692ls9xope0e?singleDoc#';

function isTutorialBrowserName(name) {
  return name === TUTORIAL_BROWSER_TITLE || name === LEGACY_TUTORIAL_BROWSER_TITLE;
}

module.exports = { TUTORIAL_BROWSER_TITLE, LEGACY_TUTORIAL_BROWSER_TITLE, DEFAULT_TUTORIAL_URL, isTutorialBrowserName };

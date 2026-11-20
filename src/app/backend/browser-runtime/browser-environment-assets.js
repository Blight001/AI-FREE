'use strict';

const fs = require('fs');
const path = require('path');

// Same relative asset layout in source, .generated/app and packaged app.asar.
const assetRoot = path.resolve(__dirname, '../../../assets/browser-environment');
const CONFIG_PLACEHOLDER = '__AI_FREE_ENVIRONMENT_CONFIG__';
let template;

function buildBrowserEnvironmentTemplate() {
  const scripts = ['navigator.js', 'graphics.js', 'media.js']
    .map((name) => fs.readFileSync(path.join(assetRoot, name), 'utf8'));
  return `((config) => {\n${scripts.join('\n')}\n})(${CONFIG_PLACEHOLDER});`;
}

function loadBrowserEnvironmentTemplate() {
  if (template) return template;
  const generated = path.join(assetRoot, 'runtime-template.js');
  template = fs.existsSync(generated)
    ? fs.readFileSync(generated, 'utf8')
    : buildBrowserEnvironmentTemplate();
  if (template.split(CONFIG_PLACEHOLDER).length !== 2) {
    template = null;
    throw new Error('浏览器环境脚本模板配置入口无效');
  }
  return template;
}

module.exports = { buildBrowserEnvironmentTemplate, loadBrowserEnvironmentTemplate };

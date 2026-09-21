const fs = require('fs');
const { fileURLToPath, pathToFileURL } = require('url');
const { resolveLogoUrl } = require('../../shared/app-assets');

// 获取/读取/解析：resolveAppIconPath的具体业务逻辑。
function resolveAppIconPath() {
  const iconPath = fileURLToPath(resolveLogoUrl(pathToFileURL(__filename).href));
  if (!fs.existsSync(iconPath)) throw new Error(`Application logo is missing: ${iconPath}`);
  return iconPath;
}

module.exports = {
  resolveAppIconPath,
};

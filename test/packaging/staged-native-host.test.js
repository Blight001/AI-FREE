const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { stagePackagedNativeHost } = require('../../scripts/build-native-host');
const resources = require('../../package.json').build.extraResources;

test('安装包从独立源码目录重新编译并保留安装资源路径', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-host-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staged = stagePackagedNativeHost(root, resources, (source) => {
    assert.equal(path.dirname(source), root);
    assert.ok(fs.existsSync(path.join(source, 'src', 'addon.cc')));
    assert.equal(fs.existsSync(path.join(source, 'build')), false);
    const output = path.join(source, 'build', 'Release', 'browser_host.node');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, 'new-host');
    return output;
  });
  const entry = staged.find((item) => item.to === 'native/browser-host/browser_host.node');
  assert.equal(fs.readFileSync(entry.from, 'utf8'), 'new-host');
  assert.throws(() => stagePackagedNativeHost(root, [], () => assert.fail()), /browser_host/);
});

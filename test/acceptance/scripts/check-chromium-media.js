const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');

// Probe the shipped Fork with an isolated temporary profile, never user data.
async function main() {
  const executablePath = path.resolve(__dirname, '../../../resources/chromium/ai-free-browser.exe');
  const browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true });
  try {
    const page = await browser.newPage();
    const support = await page.evaluate(() => {
      const formats = {
        h264: 'video/mp4; codecs="avc1.42E01E"',
        aac: 'audio/mp4; codecs="mp4a.40.2"',
        vp8: 'video/webm; codecs="vp8"',
      };
      return Object.fromEntries(Object.entries(formats).map(([name, mime]) => [name, {
        playback: document.createElement('video').canPlayType(mime),
        streaming: MediaSource.isTypeSupported(mime),
      }]));
    });
    for (const [format, result] of Object.entries(support)) {
      assert.equal(result.playback, 'probably', `${format} HTML5 playback unavailable`);
      assert.equal(result.streaming, true, `${format} MediaSource unavailable`);
    }
    console.log('[chromium-media] H.264, AAC and VP8 playback/MediaSource supported');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

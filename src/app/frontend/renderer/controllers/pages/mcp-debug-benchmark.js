(() => {
  const start = document.getElementById('benchmark-start');
  const status = document.getElementById('benchmark-status');
  start.addEventListener('click', async () => {
    start.disabled = true;
    status.textContent = '正在准备专用浏览器并联系 AI 控制侧栏…';
    try {
      const response = await window.aiFree.mcpDebug.benchmarkStart();
      status.textContent = response.ok ? '已发送，请在 AI 控制对话中查看进度和成绩。' : response.error.message;
    } catch (error) { status.textContent = error.message; }
    finally { start.disabled = false; }
  });
})();

  async function refreshModelAccessState() {
    try {
      const session = await window.aiFree?.account?.getSession?.();
      state.accountAuthenticated = session?.authenticated === true;
    } catch (_) {
      state.accountAuthenticated = false;
    }
  }

  function createModelOption(model) {
    const option = document.createElement('option');
    option.value = String(model.id || '');
    const customApi = model.custom_api === true;
    if (!customApi) {
      option.dataset.quotaMultiplier = String(Number(model.quota_multiplier || 1));
      option.dataset.tokensPerQuotaUnit = String(Number(model.tokens_per_quota_unit || 10000));
    }
    option.dataset.customApi = customApi ? 'true' : 'false';
    option.textContent = String(model.name || model.model || model.id || '未命名模型');
    return option;
  }

  function renderModelOptions(select, models, preferred) {
    select.innerHTML = '';
    if (!models.length) {
      select.innerHTML = '<option value="" disabled>管理员尚未配置模型</option>';
      select.disabled = false;
      return;
    }
    models.forEach((model) => select.appendChild(createModelOption(model)));
    if (preferred && Array.from(select.options).some((option) => option.value === preferred)) {
      select.value = preferred;
    }
    select.disabled = false;
  }

  function selectHasModelOptions(select) {
    return Array.from(select?.options || []).some((option) => option.value);
  }

  let modelsLoadPromise = null;
  let modelsLoadQueued = false;
  async function loadModels(preferredModelId = '') {
    if (modelsLoadPromise) {
      modelsLoadQueued = true;
      return modelsLoadPromise;
    }
    const select = el('ai-chat-model');
    const getModels = getAiModelsApi();
    if (!select || !getModels) return;
    const preferred = String(preferredModelId || state.currentSession?.modelId || select.value || '');
    const showingPlaceholder = !selectHasModelOptions(select);
    if (showingPlaceholder) {
      select.disabled = true;
      select.innerHTML = '<option value="">正在读取可用模型...</option>';
      syncSelectUi(select);
    }
    setStatus('');
    modelsLoadPromise = (async () => {
      try {
        await refreshModelAccessState();
        syncSendState();
        const result = requireAiDataResult(await getModels(), '模型加载失败');
        const models = Array.isArray(result.models) ? result.models : [];
        renderModelOptions(select, models, preferred);
        syncSelectUi(select);
        renderQuota(result.quota);
      } catch (error) {
        if (!selectHasModelOptions(select)) {
          select.innerHTML = '<option value="" disabled>暂无可用模型</option>';
          select.disabled = false;
          syncSelectUi(select);
          renderQuota(null);
        }
        setStatus(aiDataErrorMessage(error));
      }
      syncSendState();
    })();
    try {
      await modelsLoadPromise;
    } finally {
      modelsLoadPromise = null;
      if (modelsLoadQueued) {
        modelsLoadQueued = false;
        void loadModels(preferredModelId);
      }
    }
  }

  // 兼容旧版将兑换入口放在 AI 控制页的结构；统一入口使用新的元素 ID，
  // 因此新版界面不会绑定这里的旧处理器。
  async function redeemGiftCode() {
    const input = el('ai-chat-gift-code');
    const button = el('ai-chat-redeem-gift');
    const code = String(input?.value || '').trim();
    if (!code) {
      setStatus('请输入礼品码', 'warning');
      return;
    }
    const redeem = getGiftCodeApi();
    if (!redeem) return;
    if (button) button.disabled = true;
    try {
      const result = requireAiDataResult(await redeem({ code }), '礼品码兑换失败');
      if (input) input.value = '';
      state.lastQuotaCost = null;
      const quotaRecorder = window.AiFreeQuotaDisplay?.recordAIResetAfterRedeem;
      const displayQuota = quotaRecorder?.(result.quota, result.added_quota) || result.quota;
      renderQuota(displayQuota);
      setStatus(result.message || '礼品码兑换成功', 'success');
    } catch (error) {
      setStatus(aiDataErrorMessage(error), 'warning');
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function loadMcpTools() {
    const getConnections = window.aiFree?.ai?.getBrowserConnections;
    if (!getConnections || state.mcpToolsLoading) return;
    state.mcpToolsLoading = true;
    try {
      const result = requireAiDataResult(await getConnections(), 'MCP 工具目录读取失败');
      state.mcpTools = Array.isArray(result.mcpTools) ? result.mcpTools : [];
      state.mcpToolsError = '';
    } catch (error) {
      const message = aiDataErrorMessage(error);
      if (state.mcpToolsError !== message) console.warn('[AI 控制] MCP 工具目录读取失败:', message);
      state.mcpToolsError = message;
    } finally {
      state.mcpToolsLoading = false;
    }
  }

  function aiDataErrorMessage(value, fallback = '') {
    return String(value?.message || value?.error || fallback || value || '');
  }

  function requireAiDataResult(result, fallback) {
    if (!result?.ok) throw new Error(aiDataErrorMessage(result, fallback));
    return result;
  }

  function getAiModelsApi() {
    return window.aiFree?.ai?.getModels;
  }

  function getGiftCodeApi() {
    return window.aiFree?.ai?.redeemGiftCode;
  }

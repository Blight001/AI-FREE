'use strict';

const path = require('path');
const { BrowserWindow, screen } = require('electron');

const TAB_CONTEXT_MENU_HTML = `<!DOCTYPE html>
<html><head><meta charset="UTF-8" /><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;font-family:Inter,"Segoe UI","Microsoft YaHei",sans-serif}
.menu{display:flex;flex-direction:column;gap:4px;height:100%;padding:6px;min-width:184px;box-sizing:border-box;background:rgba(17,20,28,.98);border:1px solid rgba(255,255,255,.10);border-radius:14px;box-shadow:0 14px 36px rgba(0,0,0,.34);}
.menu-actions{display:flex;flex-direction:column;gap:4px}.menu-actions[hidden],.rename-form[hidden]{display:none}
button{appearance:none;border:0;background:transparent;color:#e6e8ee;font-size:12px;line-height:1.2;min-height:32px;padding:0 10px;border-radius:9px;text-align:left;cursor:pointer;white-space:nowrap;box-sizing:border-box}
button:hover{background:rgba(77,163,255,.18)}button:active{background:rgba(77,163,255,.28)}button:disabled{cursor:default;opacity:.55}
.rename-form{display:flex;flex-direction:column;gap:4px}.rename-form input{width:100%;height:32px;padding:0 8px;border:1px solid rgba(255,255,255,.2);border-radius:8px;box-sizing:border-box;color:#e6e8ee;background:#11141c;font:inherit;font-size:12px;outline:none}.rename-form input:focus{border-color:#4d9cff}
.rename-actions{display:flex;gap:4px}.rename-actions button{flex:1;text-align:center;padding:0 6px}
.error{display:none;color:#ffb4b4;font-size:11px;line-height:1.3;max-height:28px;overflow:hidden;padding:2px 4px 0}.error.visible{display:block}
</style></head><body><div class="menu">
<div id="menu-actions" class="menu-actions">
<button id="restart-btn" type="button">重启浏览器</button>
<button id="close-btn" type="button">关闭浏览器</button>
<button id="rename-btn" type="button">重命名浏览器</button>
</div>
<form id="rename-form" class="rename-form" hidden>
<input id="rename-input" type="text" maxlength="80" aria-label="浏览器名称" placeholder="请输入新名称" />
<div class="rename-actions"><button id="save-rename-btn" type="submit">保存</button><button id="cancel-rename-btn" type="button">取消</button></div>
</form>
<div id="error" class="error"></div></div>
<script>
const tabId=__TAB_ID__;const historyId=__HISTORY_ID__;const api=window.aiFree?.shell;const browser=window.aiFree?.browser;
const menuActions=document.getElementById('menu-actions');const renameForm=document.getElementById('rename-form');
const restartBtn=document.getElementById('restart-btn');const closeBtn=document.getElementById('close-btn');const renameBtn=document.getElementById('rename-btn');
const renameInput=document.getElementById('rename-input');const saveRenameBtn=document.getElementById('save-rename-btn');const cancelRenameBtn=document.getElementById('cancel-rename-btn');const errorEl=document.getElementById('error');
const setError=(message)=>{errorEl.textContent=message||'操作失败';errorEl.classList.add('visible');};
const clearError=()=>{errorEl.textContent='';errorEl.classList.remove('visible');};
const setLoading=(loading)=>[restartBtn,closeBtn,renameBtn,renameInput,saveRenameBtn,cancelRenameBtn].forEach((control)=>{control.disabled=loading;});
async function restartBrowser(){restartBtn.textContent='重启中...';setLoading(true);try{if(typeof api?.restartBrowserRuntime!=='function')throw new Error('当前窗口不可用');const result=await api.restartBrowserRuntime({profileId:tabId});if(!result||result.ok!==true)throw new Error(result&&(result.message||result.error)||'重启失败');window.close();}catch(error){setLoading(false);restartBtn.textContent='重启浏览器';setError(error&&(error.message||String(error)));}}
function closeBrowser(){if(typeof api?.closeTab!=='function')return setError('当前窗口不可用');api.closeTab(tabId);window.close();}
function beginRename(){if(!historyId)return setError('该浏览器没有可编辑的历史记录');clearError();menuActions.hidden=true;renameForm.hidden=false;renameInput.focus();}
function cancelRename(){renameForm.hidden=true;menuActions.hidden=false;clearError();}
async function saveRename(event){event.preventDefault();const name=renameInput.value.trim();if(!name)return setError('浏览器名称不能为空');setLoading(true);try{if(typeof browser?.renameHistory!=='function')throw new Error('当前窗口不可用');const result=await browser.renameHistory({historyId,name});if(!result||result.ok!==true)throw new Error(result&&(result.error||result.message)||'重命名失败');window.close();}catch(error){setLoading(false);setError(error&&(error.message||String(error)));}}
restartBtn.addEventListener('click',restartBrowser);closeBtn.addEventListener('click',closeBrowser);renameBtn.addEventListener('click',beginRename);
cancelRenameBtn.addEventListener('click',cancelRename);renameForm.addEventListener('submit',saveRename);window.addEventListener('blur',()=>window.close());
</script></body></html>`;

function serializeScriptValue(value) {
  return JSON.stringify(String(value || '')).replace(/</g, '\\u003c');
}

function buildTabContextMenuHtml(tabId, historyId = '') {
  return TAB_CONTEXT_MENU_HTML
    .replace('__TAB_ID__', serializeScriptValue(tabId))
    .replace('__HISTORY_ID__', serializeScriptValue(historyId));
}

function resolveContextMenuBounds(parent, x, y) {
  const width = 196;
  const height = 118;
  const parentBounds = typeof parent.getBounds === 'function'
    ? parent.getBounds()
    : { x: 0, y: 0, width, height };
  const anchorX = parentBounds.x + Number(x || 0);
  const anchorY = parentBounds.y + Number(y || 0);
  const display = typeof screen.getDisplayNearestPoint === 'function'
    ? screen.getDisplayNearestPoint({ x: anchorX, y: anchorY })
    : screen.getPrimaryDisplay();
  const workArea = display?.workArea || { x: 0, y: 0, width: 1920, height: 1080 };
  const left = Math.min(Math.max(anchorX - 12, workArea.x + 8), workArea.x + workArea.width - width - 8);
  const top = Math.min(Math.max(anchorY + 8, workArea.y + 8), workArea.y + workArea.height - height - 8);
  return { x: Math.round(left), y: Math.round(top), width, height };
}

function createContextMenuWindow(parent, bounds) {
  return new BrowserWindow({
    ...bounds,
    frame: false,
    resizable: false,
    movable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    transparent: true,
    parent,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      devTools: false,
      preload: path.join(__dirname, '../../preload.js'),
    },
  });
}

function createTabContextMenuController() {
  let popup = null;

  const closeTabContextMenuWindow = () => {
    if (popup && !popup.isDestroyed()) {
      try { popup.close(); } catch (_) {}
    }
    popup = null;
  };

  /** @param {Record<string, any>} [options] */
  const openTabContextMenuWindow = ({ tabId, historyId, x = 0, y = 0, parentWindow = null } = {}) => {
    try {
      closeTabContextMenuWindow();
      const parent = parentWindow && !parentWindow.isDestroyed() ? parentWindow : null;
      if (!parent) return false;
      popup = createContextMenuWindow(parent, resolveContextMenuBounds(parent, x, y));
      const current = popup;
      current.on('closed', () => { if (popup === current) popup = null; });
      current.on('blur', closeTabContextMenuWindow);
      current.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildTabContextMenuHtml(tabId, historyId))}`);
      current.once('ready-to-show', () => {
        try { if (!current.isDestroyed()) current.show(); } catch (_) {}
      });
      return true;
    } catch (error) {
      console.warn('[UI] 打开浏览器菜单窗口失败:', error?.message || error);
      closeTabContextMenuWindow();
      return false;
    }
  };

  return { closeTabContextMenuWindow, openTabContextMenuWindow };
}

module.exports = { buildTabContextMenuHtml, createTabContextMenuController, resolveContextMenuBounds };

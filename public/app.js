import { Connection } from './connection.js';
import { Transfers } from './transfer.js';

const root = document.querySelector('#suichuan');
const get = (selector) => root.querySelector(selector);
const all = (selector) => [...root.querySelectorAll(selector)];
const connection = new Connection();
const transfers = new Transfers(connection);
const ALL_ONLINE = 'all-online';
const savedTarget = localStorage.getItem('suichuan-target');
const state = { peers: [], files: [], target: savedTarget === ALL_ONLINE ? '' : savedTarget || '', requests: [], modal: '', code: '', codeUntil: 0, sending: false, expandedGroups: new Set() };
const editor = get('[data-editor]');
const overlay = get('.qt-overlay');
const imagePreview = get('[data-image-preview]');
const target = get('[data-target]');
const fileInput = get('[data-files]');
let toastTimer;
let lastFocus;
let previewId;

function element(tag, className, text) {
  const el = document.createElement(tag);
  el.className = className || '';
  if (text !== undefined) {
    el.textContent = text;
  }
  return el;
}

function button(label, action, id, extra = '') {
  const el = element('button', `qt-button qt-quiet ${extra}`, label);
  el.type = 'button';
  el.dataset.action = action;
  if (id) {
    el.dataset.id = id;
  }
  return el;
}

function tell(message) {
  clearTimeout(toastTimer);
  get('.qt-toast').textContent = message;
  get('.qt-toast').hidden = false;
  toastTimer = setTimeout(() => { get('.qt-toast').hidden = true; }, 5000);
}

const sizeLabel = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const isActive = (item) => !['completed', 'failed', 'cancelled'].includes(item.status);

function renderTarget() {
  const online = state.peers.filter((p) => p.online);
  if (online.length === 1 && state.target !== ALL_ONLINE) {
    state.target = online[0].id;
  } else if (!state.target && online.length) {
    state.target = online[0].id;
  }
  target.replaceChildren();
  if (online.length || state.target === ALL_ONLINE) {
    target.add(new Option(`全部在线设备（${online.length} 台）`, ALL_ONLINE));
  }
  if (!online.length) {
    if (state.target !== ALL_ONLINE) {
      target.add(new Option(state.peers.length ? '等待设备上线' : '先连接另一台电脑', ''));
    }
  } else {
    if (state.target !== ALL_ONLINE && !online.some((p) => p.id === state.target)) {
      target.add(new Option('上次选择的设备已离线', ''));
    }
    for (const peer of online) {
      target.add(new Option(peer.name, peer.id));
    }
    target.value = state.target === ALL_ONLINE || online.some((p) => p.id === state.target) ? state.target : '';
  }
  target.disabled = !online.length || !connection.ready;
  updateSend();
}

function updateSend() {
  const broadcast = state.target === ALL_ONLINE;
  const recipients = state.peers.filter((p) => p.online && (broadcast || p.id === state.target));
  const send = get('[data-action="send"]');
  send.disabled = !connection.ready || !recipients.length || state.sending || (!editor.value.length && !state.files.length);
  send.classList.toggle('is-broadcast', broadcast);
  send.setAttribute('aria-label', broadcast ? `群发给 ${recipients.length} 台设备` : '发送');
  send.dataset.tooltip = broadcast ? `群发给 ${recipients.length} 台设备` : '发送';
  get('[data-send-label]').hidden = !broadcast;
  get('[data-send-label]').textContent = broadcast ? `群发 ${recipients.length} 台` : '';
  const note = get('[data-send-note]');
  note.hidden = connection.ready && Boolean(recipients.length) && !broadcast;
  note.textContent = !connection.ready ? '正在连接服务，稍后即可发送' : recipients.length ? '发送给所有已配对且在线的设备' : state.peers.length ? '等待接收设备上线' : '连接另一台设备以开始';
  get('[data-action="connect"]').disabled = !connection.ready;
  get('[data-connection]').textContent = connection.ready ? '已连接' : '正在重连';
}

function renderAttachments() {
  const list = get('[data-attachments]');
  list.replaceChildren();
  list.hidden = state.files.length === 0;
  for (const entry of state.files) {
    const row = element('div', 'qt-attachment');
    if (entry.url) {
      const image = element('img', 'qt-attachment-preview');
      image.src = entry.url;
      image.alt = entry.file.name;
      row.append(image);
    }
    const info = element('div', 'qt-attachment-info');
    info.append(element('div', 'qt-attachment-name', entry.file.name), element('div', 'qt-attachment-size', sizeLabel(entry.file.size)));
    const remove = button('×', 'remove-file', entry.id, 'qt-icon');
    remove.setAttribute('aria-label', `移除 ${entry.file.name}`);
    row.append(info, remove);
    list.append(row);
  }
  updateSend();
}

function addFiles(files) {
  const max = connection.config?.maxFileBytes || 50 * 1048576;
  for (const file of files) {
    if (file.size > max) {
      tell(`单个文件上限为 ${sizeLabel(max)}，请拆分或选择更小的文件`);
      continue;
    }
    if (state.files.length >= 8) {
      tell('一次最多添加 8 个文件，请分批发送');
      break;
    }
    const preview = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type);
    state.files.push({ id: crypto.randomUUID(), file, url: preview ? URL.createObjectURL(file) : null, kind: preview ? 'image' : 'file' });
  }
  renderAttachments();
}

function renderTransfers() {
  const list = get('[data-transfers]');
  const focused = list.contains(document.activeElement) ? document.activeElement : null;
  const focusAction = focused?.dataset.action;
  const focusId = focused?.dataset.id;
  list.replaceChildren();
  const activeGroups = new Set(transfers.items.filter((item) => item.groupId && isActive(item)).map((item) => item.groupId));
  get('[data-count]').textContent = transfers.items.filter((item) => !item.groupId).length + transfers.groups.length || '';
  get('[data-action="clear"]').hidden = !transfers.items.some((item) => !isActive(item) && !activeGroups.has(item.groupId));
  if (!transfers.items.length) {
    list.append(element('p', 'qt-empty', '发出的内容和收到的内容会出现在这里'));
  }
  const shown = new Set();
  for (const item of transfers.items) {
    if (item.groupId) {
      if (!shown.has(item.groupId)) {
        const group = transfers.groups.find((entry) => entry.id === item.groupId);
        list.append(renderGroup(group));
        shown.add(item.groupId);
      }
    } else {
      list.append(renderTransfer(item));
    }
  }
  if (focusAction) {
    [...list.querySelectorAll('[data-action]')].find((el) => el.dataset.action === focusAction && el.dataset.id === focusId)?.focus({ preventScroll: true });
  }
  if (state.modal === 'devices') {
    renderDevices();
  }
  if (imagePreview.open && !transfers.items.some((item) => item.localId === previewId)) {
    closeImagePreview();
  }
}

function renderTransfer(item) {
  const row = element('article', 'qt-transfer-row');
  row.dataset.transfer = item.localId;
  row.dataset.status = item.status;
  row.dataset.incoming = String(item.incoming);
  row.dataset.route = item.route;
  const body = element('div', 'qt-transfer-body');
  if (item.kind === 'text' && (item.text !== undefined || item.source?.text !== undefined)) {
    body.append(element('pre', 'qt-text-content', item.text ?? item.source.text));
  } else {
    body.append(element('div', 'qt-transfer-title', item.name));
  }
  const status = { queued: '排队中', waiting: '等待连接', transferring: `${Math.min(99, Math.floor(item.bytes / Math.max(item.size, 1) * 100))}%`, completed: item.incoming ? '已收到' : '已送达', failed: '失败', cancelled: '已取消' }[item.status];
  body.append(element('div', `qt-transfer-meta${item.status === 'failed' ? ' qt-error-note' : ''}`, `${item.incoming ? '来自' : '发往'} ${item.peerName} · ${sizeLabel(item.size)} · ${status}`));
  if (item.reason) {
    body.append(element('div', 'qt-transfer-meta qt-error-note', item.reason));
  }
  if (isActive(item)) {
    const progress = element('progress');
    progress.max = Math.max(item.size, 1);
    progress.value = item.bytes;
    progress.setAttribute('aria-label', `${item.name}传输进度`);
    body.append(progress);
  }
  if (item.url && item.status === 'completed') {
    const trigger = element('button', 'qt-image-trigger');
    trigger.type = 'button';
    trigger.dataset.action = 'preview-image';
    trigger.dataset.id = item.localId;
    trigger.setAttribute('aria-label', `预览 ${item.name}`);
    trigger.setAttribute('aria-haspopup', 'dialog');
    const preview = element('img', 'qt-received-image');
    preview.src = item.url;
    preview.alt = item.name;
    trigger.append(preview);
    body.append(trigger);
  }
  const actions = element('div', 'qt-transfer-actions');
  if (isActive(item)) {
    actions.append(button('取消', 'cancel', item.localId));
  } else if (item.status === 'completed' && item.incoming) {
    actions.append(button(item.kind === 'text' ? '复制' : '保存', item.kind === 'text' ? 'copy-text' : 'save-file', item.localId));
  } else if (!item.incoming && item.status !== 'completed') {
    const retry = button('重新发送', 'retry', item.localId);
    retry.disabled = !connection.ready || !state.peers.some((p) => p.id === item.peerId && p.online);
    actions.append(retry);
  }
  row.append(body, actions);
  return row;
}

function renderGroup(group) {
  const items = transfers.groupItems(group);
  const completed = items.filter((item) => item.status === 'completed').length;
  const failed = items.filter((item) => item.status === 'failed');
  const cancelled = items.filter((item) => item.status === 'cancelled').length;
  const active = items.filter(isActive);
  const queued = active.filter((item) => item.status === 'queued').length;
  const delivered = group.peers.filter((peer) => items.filter((item) => item.peerId === peer.id).every((item) => item.status === 'completed')).length;
  const row = element('article', 'qt-transfer-group');
  row.dataset.group = group.id;
  const top = element('div', 'qt-group-top');
  const info = element('div', 'qt-group-info');
  info.append(element('div', 'qt-group-title', `群发 · ${group.peers.length} 台设备`));
  const summary = completed === items.length ? `全部送达 · ${group.peers.length} 台设备` : active.length ? `已送达 ${delivered}/${group.peers.length} 台 · ${active.length > queued ? '传输中' : '排队中'}` : `已送达 ${delivered}/${group.peers.length} 台${failed.length ? ' · 部分失败' : ' · 已取消'}`;
  const status = element('div', 'qt-transfer-meta', summary);
  status.dataset.groupStatus = '';
  info.append(status);
  const counts = [`${completed}/${items.length} 项已送达`];
  if (queued) {
    counts.push(`${queued} 项排队中`);
  }
  if (failed.length) {
    counts.push(`${failed.length} 项失败`);
  }
  if (cancelled) {
    counts.push(`${cancelled} 项已取消`);
  }
  info.append(element('div', 'qt-transfer-meta', counts.join(' · ')));
  const expanded = state.expandedGroups.has(group.id);
  const toggle = button(expanded ? '收起详情' : '展开详情', 'toggle-group', group.id);
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.setAttribute('aria-controls', `group-${group.id}`);
  top.append(info, toggle);
  row.append(top);
  const actions = element('div', 'qt-group-actions');
  if (active.length) {
    actions.append(button('取消剩余', 'cancel-group', group.id));
  }
  if (failed.length) {
    const retry = button('重试失败项', 'retry-group', group.id);
    retry.disabled = !connection.ready || !failed.some((item) => state.peers.some((peer) => peer.id === item.peerId && peer.online));
    actions.append(retry);
  }
  if (actions.childElementCount) {
    row.append(actions);
  }
  const details = element('div', 'qt-group-details');
  details.id = `group-${group.id}`;
  details.dataset.groupDetails = '';
  details.hidden = !expanded;
  for (const peer of group.peers) {
    const peerItems = items.filter((item) => item.peerId === peer.id).sort((a, b) => a.sourceIndex - b.sourceIndex);
    const sent = peerItems.filter((item) => item.status === 'completed').length;
    const section = element('section', 'qt-group-device');
    section.append(element('h3', '', `${peer.name} · ${sent}/${peerItems.length} 项已送达`));
    for (const item of peerItems) {
      section.append(renderTransfer(item));
    }
    details.append(section);
  }
  row.append(details);
  return row;
}

function openImagePreview(item) {
  if (!item?.url || item.status !== 'completed') {
    return;
  }
  previewId = item.localId;
  get('[data-preview-image]').src = item.url;
  get('[data-preview-image]').alt = item.name;
  get('[data-preview-name]').textContent = item.name;
  imagePreview.showModal();
}

function closeImagePreview() {
  if (!imagePreview.open) {
    return;
  }
  imagePreview.close();
  get('[data-preview-image]').removeAttribute('src');
  get('[data-preview-image]').alt = '';
  get('[data-preview-name]').textContent = '';
  // Transfer updates rebuild the list, so restore focus to the current thumbnail.
  const trigger = all('[data-action="preview-image"]').find((el) => el.dataset.id === previewId);
  (trigger || editor).focus({ preventScroll: true });
  previewId = null;
}

function renderDevices() {
  const list = get('[data-devices-list]');
  list.replaceChildren();
  if (!state.peers.length) {
    list.append(element('p', 'qt-empty', '还没有配对设备'));
  }
  for (const peer of state.peers) {
    const row = element('div', 'qt-device-row');
    row.dataset.peer = peer.id;
    const info = element('div', 'qt-device-info');
    const busy = peer.busy > 0 || transfers.items.some((i) => i.peerId === peer.id && isActive(i));
    info.append(element('strong', '', peer.name), element('small', '', `${peer.online ? '在线' : '离线'}${busy ? ' · 传输结束后可忘记配对' : ''}`));
    const forget = button('忘记', 'forget', peer.id);
    forget.disabled = busy || !connection.ready;
    row.append(info, forget);
    list.append(row);
  }
}

function closeDialog() {
  overlay.hidden = true;
  state.modal = '';
  get('.qt-header').inert = false;
  get('.qt-main').inert = false;
  lastFocus?.focus();
}

function openDialog(type) {
  closeImagePreview();
  if (overlay.hidden) {
    lastFocus = document.activeElement;
  }
  state.modal = type;
  overlay.hidden = false;
  get('.qt-header').inert = true;
  get('.qt-main').inert = true;
  get('[data-dialog-title]').textContent = type === 'devices' ? '我的设备' : type === 'approval' ? '确认新设备' : '连接设备';
  get('[data-pair-panel]').hidden = type !== 'pair';
  get('[data-devices-panel]').hidden = type !== 'devices';
  get('[data-approval-panel]').hidden = type !== 'approval';
  if (type === 'devices') {
    get('[data-name-input]').value = connection.device?.name || '我的电脑';
    renderDevices();
  }
  if (type === 'approval' && state.requests[0]) {
    get('[data-request-name]').textContent = state.requests[0].name;
    get('[data-request-id]').textContent = `设备 ${state.requests[0].fingerprint.slice(0, 12)} · 请求连接`;
  }
  get('[data-action="close"]').focus();
}

function pairTab(tab) {
  all('[data-pair-tab]').forEach((el) => el.setAttribute('aria-selected', String(el.dataset.pairTab === tab)));
  get('#qt-code-panel').hidden = tab !== 'show';
  get('#qt-enter-panel').hidden = tab !== 'enter';
  get('#qt-code-error').hidden = true;
  if (tab === 'enter') {
    get('[data-code-input]').focus();
  }
}

async function newCode() {
  get('[data-code]').textContent = '正在生成…';
  const result = await connection.rpc('pair.code');
  state.code = result.code;
  state.codeUntil = result.expires;
  get('[data-code]').textContent = `${state.code.slice(0, 4)} ${state.code.slice(4)}`;
  updateCode();
}

function updateCode() {
  const left = Math.max(0, Math.ceil((state.codeUntil - Date.now()) / 1000));
  get('[data-code-expiry]').textContent = left ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} 后失效` : '已过期，请换一个连接码';
  get('[data-action="copy-code"]').disabled = left === 0;
}

async function join() {
  const code = get('[data-code-input]').value.replace(/\D/g, '');
  const error = get('#qt-code-error');
  if (code.length !== 8) {
    error.textContent = '请输入完整的 8 位连接码';
    error.hidden = false;
    return;
  }
  get('[data-join]').disabled = true;
  error.hidden = true;
  try {
    const result = await connection.rpc('pair.join', { code });
    state.joinId = result.id;
    get('[data-join]').textContent = '等待对方确认…';
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
    get('[data-join]').disabled = false;
  }
}

async function sendBatch() {
  const broadcast = state.target === ALL_ONLINE;
  const peers = state.peers.filter((p) => p.online && (broadcast || p.id === state.target));
  if (!peers.length || !connection.ready || state.sending) {
    return;
  }
  const text = editor.value;
  if (new TextEncoder().encode(text).length > connection.config.maxTextBytes) {
    tell('文字过长，请分段发送（每次最多 1 MB）');
    return;
  }
  const sources = text.length ? [{ kind: 'text', text }] : [];
  sources.push(...state.files.map((f) => ({ kind: f.kind, file: f.file })));
  if (!sources.length) {
    return;
  }
  state.sending = true;
  if (!broadcast) {
    localStorage.setItem('suichuan-target', peers[0].id);
  }
  editor.value = '';
  for (const f of state.files) {
    if (f.url) {
      URL.revokeObjectURL(f.url);
    }
  }
  state.files = [];
  renderAttachments();
  try {
    transfers.sendBatch(peers, sources, { group: broadcast });
  } finally {
    state.sending = false;
    updateSend();
  }
}

async function action(name, el) {
  const item = transfers.items.find((i) => i.localId === el.dataset.id);
  const group = transfers.groups.find((entry) => entry.id === el.dataset.id);
  switch (name) {
    case 'connect':
      if (state.requests.length) {
        openDialog('approval');
      } else {
        openDialog('pair');
        pairTab('show');
        if (state.codeUntil <= Date.now()) {
          await newCode();
        }
      }
      break;
    case 'devices': openDialog('devices'); break;
    case 'close':
      if (state.joinId) {
        await connection.rpc('pair.cancel', { id: state.joinId });
      }
      closeDialog();
      break;
    case 'pick': fileInput.click(); break;
    case 'send': await sendBatch(); break;
    case 'refresh-code': await newCode(); break;
    case 'copy-code': await navigator.clipboard.writeText(state.code); tell('连接码已复制'); break;
    case 'join': await join(); break;
    case 'allow':
    case 'deny':
      if (state.requests[0]) {
        await connection.rpc('pair.respond', { id: state.requests[0].id, allow: name === 'allow' });
      }
      break;
    case 'rename': {
      const value = get('[data-name-input]').value.trim();
      await connection.rpc('device.rename', { name: value });
      localStorage.setItem('suichuan-name', value);
      tell('设备名称已更新');
      break;
    }
    case 'forget': await connection.rpc('pair.forget', { peerId: el.dataset.id }); tell('已忘记设备'); break;
    case 'remove-file': {
      const attachment = state.files.find((f) => f.id === el.dataset.id);
      if (attachment?.url) {
        URL.revokeObjectURL(attachment.url);
      }
      state.files = state.files.filter((f) => f.id !== el.dataset.id);
      renderAttachments();
      break;
    }
    case 'cancel': transfers.cancel(item); break;
    case 'retry': transfers.retry(item); break;
    case 'retry-group': transfers.retryGroup(group); break;
    case 'cancel-group': transfers.cancelGroup(group); break;
    case 'toggle-group': {
      if (state.expandedGroups.has(group.id)) {
        state.expandedGroups.delete(group.id);
      } else {
        state.expandedGroups.add(group.id);
      }
      renderTransfers();
      break;
    }
    case 'copy-text': await navigator.clipboard.writeText(item.text); tell('文字已复制'); break;
    case 'preview-image': openImagePreview(item); break;
    case 'close-image': closeImagePreview(); break;
    case 'save-file': {
      const url = URL.createObjectURL(item.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = item.name.replace(/[\\/\u0000-\u001f]/g, '_') || '随传文件';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      break;
    }
    case 'clear':
      transfers.clear();
      state.expandedGroups = new Set([...state.expandedGroups].filter((id) => transfers.groups.some((entry) => entry.id === id)));
      break;
  }
}

root.addEventListener('click', (event) => {
  const tab = event.target.closest('[data-pair-tab]');
  if (tab) {
    pairTab(tab.dataset.pairTab);
    return;
  }
  const el = event.target.closest('[data-action]');
  if (el && !el.disabled) {
    action(el.dataset.action, el).catch((error) => tell(error.message));
  }
});
imagePreview.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeImagePreview();
});
imagePreview.addEventListener('keydown', (event) => {
  if (event.key === 'Tab') {
    event.preventDefault();
    get('[data-action="close-image"]').focus();
  }
});
imagePreview.addEventListener('click', (event) => {
  if (event.target === imagePreview) {
    closeImagePreview();
  }
});
editor.addEventListener('input', updateSend);
editor.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    sendBatch().catch((error) => tell(error.message));
  }
});
get('[data-code-input]').addEventListener('input', (event) => {
  const digits = event.target.value.replace(/\D/g, '').slice(0, 8);
  event.target.value = digits.length > 4 ? `${digits.slice(0, 4)} ${digits.slice(4)}` : digits;
});
get('[data-code-input]').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !get('[data-join]').disabled) {
    join().catch((error) => tell(error.message));
  }
});
document.addEventListener('keydown', (event) => {
  if (overlay.hidden) {
    return;
  }
  if (event.key === 'Escape') {
    action('close', get('[data-action="close"]')).catch((error) => tell(error.message));
  }
  if (event.key === 'Tab') {
    const focusable = [...overlay.querySelectorAll('button, input, a')].filter((el) => !el.disabled && el.getClientRects().length);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
});
target.addEventListener('change', () => {
  state.target = target.value;
  if (state.target !== ALL_ONLINE) {
    localStorage.setItem('suichuan-target', state.target);
  }
  updateSend();
});
fileInput.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = ''; });
root.addEventListener('paste', (event) => {
  if (state.modal || imagePreview.open) {
    return;
  }
  const files = [...(event.clipboardData?.files || [])];
  if (files.length) {
    event.preventDefault();
    addFiles(files);
  }
});
const composer = get('.qt-composer');
composer.addEventListener('dragover', (event) => { event.preventDefault(); composer.classList.add('is-dragging'); });
composer.addEventListener('dragleave', () => composer.classList.remove('is-dragging'));
composer.addEventListener('drop', (event) => { event.preventDefault(); composer.classList.remove('is-dragging'); addFiles([...event.dataTransfer.files]); });
document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('drop', (event) => event.preventDefault());
connection.addEventListener('ready', (e) => {
  state.peers = e.detail.peers;
  get('[data-local-name]').textContent = e.detail.device.name;
  renderTarget();
  renderTransfers();
});
connection.addEventListener('peers', (e) => {
  state.peers = e.detail.peers;
  if (connection.device) {
    connection.device.name = e.detail.name;
  }
  get('[data-local-name]').textContent = e.detail.name;
  renderTarget();
  renderTransfers();
});
connection.addEventListener('disconnected', () => {
  state.requests = [];
  state.joinId = null;
  state.codeUntil = 0;
  get('[data-join]').disabled = false;
  get('[data-join]').textContent = '连接';
  updateSend();
  renderTransfers();
});
connection.addEventListener('fatal', (e) => {
  get('[data-send-note]').hidden = false;
  get('[data-send-note]').textContent = e.detail.message;
  get('[data-connection]').textContent = '连接不可用';
  tell(e.detail.message);
});
connection.addEventListener('notice', (e) => tell(e.detail.message));
transfers.addEventListener('notice', (e) => tell(e.detail.message));
transfers.addEventListener('change', renderTransfers);
connection.addEventListener('pair.request', (e) => {
  state.requests.push(e.detail);
  openDialog('approval');
});
connection.addEventListener('pair.result', (e) => {
  const shownRequest = state.requests[0]?.id === e.detail.id;
  state.requests = state.requests.filter((r) => r.id !== e.detail.id);
  if (state.joinId === e.detail.id || shownRequest) {
    state.joinId = null;
    get('[data-join]').disabled = false;
    get('[data-join]').textContent = '连接';
    tell({ paired: '已连接，可以开始传输', denied: '对方拒绝了连接', expired: '连接请求已过期，请重试', cancelled: '连接请求已取消' }[e.detail.status]);
    if (state.requests.length) {
      openDialog('approval');
    } else {
      closeDialog();
    }
  }
});
connection.addEventListener('pair.codeExpired', (e) => {
  if (state.code === e.detail.code) {
    state.codeUntil = 0;
    updateCode();
  }
});
setInterval(updateCode, 1000);
renderTarget();
renderTransfers();
connection.start();

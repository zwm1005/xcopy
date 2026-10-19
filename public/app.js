import { Connection } from './connection.js';
import { Transfers } from './transfer.js';
import { ShareComposer } from './share-ui.js?v=20261019-multiple-share';
import { deviceNames, validDeviceName } from './device-name.js';

const root = document.querySelector('#suichuan');
// 兼容静态发布切换瞬间仍引用新脚本的旧 HTML。
root.querySelector('.qt-section-heading .qt-connection')?.remove();
const get = (selector) => root.querySelector(selector);
const all = (selector) => [...root.querySelectorAll(selector)];
const connection = new Connection();
const transfers = new Transfers(connection);
const ALL_ONLINE = 'all-online';
const savedTarget = deviceNames.read('suichuan-target');
const state = { peers: [], files: [], target: savedTarget === ALL_ONLINE ? '' : savedTarget || '', requests: [], modal: '', code: '', codeUntil: 0, sending: false, expandedGroups: new Set(), connectionError: '' };
const editor = get('[data-editor]');
const overlay = get('.qt-overlay');
const imagePreview = get('[data-image-preview]');
const target = get('[data-target]');
const fileInput = get('[data-files]');
let toastTimer;
let lastFocus;
let previewId;
let leaveGuardInstalled = false;
let shareUI;

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
const needsSaving = (item) => item.incoming && item.status === 'completed' && item.kind !== 'text' && item.blob && !item.downloadStarted && (!item.imageCopied || item.mime === 'image/gif');
const canCopyImage = () => Boolean(navigator.clipboard?.write && globalThis.ClipboardItem && (!ClipboardItem.supports || ClipboardItem.supports('image/png')));

function peerLabel(peer) {
  const duplicates = state.peers.filter((entry) => entry.name === peer.name);
  if (duplicates.length < 2) {
    return peer.name;
  }
  let length = 6;
  while (length < peer.id.length && duplicates.some((entry) => entry.id !== peer.id && entry.id.slice(0, length) === peer.id.slice(0, length))) {
    length += 2;
  }
  return `${peer.name} · ${peer.id.slice(0, length)}`;
}

function beforeLeave(event) {
  if (transfers.items.some((item) => isActive(item) || needsSaving(item))) {
    event.preventDefault();
    event.returnValue = true;
  }
}

function updateLeaveGuard() {
  const unsaved = transfers.items.filter(needsSaving).length;
  const needed = unsaved > 0 || transfers.items.some(isActive);
  if (needed !== leaveGuardInstalled) {
    if (needed) {
      window.addEventListener('beforeunload', beforeLeave);
    } else {
      window.removeEventListener('beforeunload', beforeLeave);
    }
    leaveGuardInstalled = needed;
  }
  const note = get('[data-unsaved-note]');
  note.hidden = unsaved === 0;
  note.textContent = unsaved ? `还有 ${unsaved} 个文件需要保存，刷新、关闭或清空后将无法找回。` : '';
}

function renderReception(reception) {
  const note = get('[data-reception-note]');
  note.hidden = !connection.ready || !reception || reception.pages < 2;
  note.textContent = reception?.here
    ? '本页负责接收新内容。同一浏览器的其他随传页面只用于发送。'
    : '新内容由本机另一个随传页面接收，请切换到显示「本页负责接收」的页面查看。关闭它后，由剩余页面中的一页自动接收后续内容。';
}

function renderTarget() {
  const online = state.peers.filter((p) => p.online);
  if (!state.target && online.length === 1) {
    state.target = online[0].id;
    deviceNames.write('suichuan-target', state.target);
  }
  target.replaceChildren();
  if (online.length) {
    target.add(new Option(`全部在线设备（${online.length} 台）`, ALL_ONLINE));
  }
  if (!online.length) {
    target.add(new Option(state.peers.length ? '等待接收设备上线' : '先连接另一台电脑', state.target === ALL_ONLINE ? ALL_ONLINE : ''));
  } else {
    if (state.target !== ALL_ONLINE && !online.some((p) => p.id === state.target)) {
      const selected = state.peers.find((peer) => peer.id === state.target);
      const label = !state.target ? '选择接收设备' : selected ? `${peerLabel(selected)} · 已离线` : '原接收设备不可用，请重新选择';
      target.add(new Option(label, state.target));
    }
    for (const peer of online) {
      target.add(new Option(peerLabel(peer), peer.id));
    }
    target.value = state.target;
  }
  target.disabled = !online.length || !connection.ready;
  updateSend();
}

function updateSend() {
  const broadcast = state.target === ALL_ONLINE;
  const recipients = state.peers.filter((p) => p.online && (broadcast || p.id === state.target));
  const send = get('[data-action="send"]');
  send.disabled = !connection.ready || !recipients.length || state.sending || (!editor.value.length && !state.files.length);
  const note = get('[data-send-note]');
  note.textContent = !connection.ready ? state.connectionError : recipients.length && broadcast ? '发送给所有已配对且在线的设备' : '';
  note.hidden = shareUI?.mode === 'share' || !note.textContent;
  for (const connect of all('[data-action="connect"], [data-action="first-connect"]')) {
    connect.disabled = !connection.ready;
  }
  get('[data-onboarding]').hidden = shareUI?.mode === 'share' || !connection.ready || state.peers.length > 0;
  root.dataset.connection = connection.ready ? 'ready' : 'connecting';
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
  shareUI?.render();
}

function addFiles(files) {
  for (const file of files) {
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
  updateLeaveGuard();
  const list = get('[data-transfers]');
  const focused = list.contains(document.activeElement) ? document.activeElement : null;
  const focusAction = focused?.dataset.action;
  const focusId = focused?.dataset.id;
  list.replaceChildren();
  const activeGroups = new Set(transfers.items.filter((item) => item.groupId && isActive(item)).map((item) => item.groupId));
  const count = transfers.items.filter((item) => !item.groupId && !item.shareId).length + transfers.groups.length + (shareUI?.entries.length || 0);
  const sharing = shareUI?.mode === 'share';
  const history = get('.qt-transfers');
  const title = sharing ? '历史记录' : '本次传输';
  history.hidden = sharing && count === 0;
  history.setAttribute('aria-label', title);
  get('.qt-section-heading h2').firstChild.textContent = `${title} `;
  get('[data-count]').textContent = count || '';
  get('[data-action="clear"]').hidden = !transfers.items.some((item) => !item.shareId && !isActive(item) && !activeGroups.has(item.groupId)) && !shareUI?.entries.some((s) => ['completed', 'cancelled', 'expired', 'unavailable', 'stopped'].includes(s.status));
  get('.qt-history-footer > span').hidden = sharing;
  get('.qt-history-footer').hidden = sharing && get('[data-action="clear"]').hidden;
  if (!sharing && !transfers.items.length && !shareUI?.entries.length) {
    list.append(element('p', 'qt-empty', '发出的内容和收到的内容会出现在这里'));
  }
  const shown = new Set();
  for (const item of transfers.items) {
    if (item.shareId) {
      continue;
    }
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
  const row = element('article', `qt-transfer-row${item.groupId ? '' : ' qt-transfer-card'}`);
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
  if (item.incoming && item.status === 'completed' && item.kind !== 'text') {
    const saved = item.downloadStarted ? '已发起下载，请确认文件已保存' : item.imageCopied ? item.mime === 'image/gif' ? '已复制静态图片，动图原文件尚未保存' : '已复制图片，可粘贴到其他应用' : '尚未保存，刷新或关闭页面后将丢失';
    body.append(element('div', 'qt-transfer-meta', saved));
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
    if (item.url && canCopyImage()) {
      const copy = button(item.copying ? '正在复制…' : '复制图片', 'copy-image', item.localId);
      copy.disabled = Boolean(item.copying);
      actions.append(copy);
    }
    actions.append(button(item.kind === 'text' ? '复制' : item.downloadStarted ? '再次保存' : '保存', item.kind === 'text' ? 'copy-text' : 'save-file', item.localId));
  } else if (!item.incoming && item.status !== 'completed') {
    const retry = button('重新发送', 'retry', item.localId);
    retry.disabled = !connection.ready || !state.peers.some((p) => p.id === item.peerId && p.online);
    actions.append(retry);
  }
  row.append(body);
  if (actions.childElementCount) {
    row.append(actions);
  }
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
  const row = element('article', 'qt-transfer-card qt-transfer-group');
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
    const name = element('div', 'qt-device-name');
    const status = !connection.ready ? 'unknown' : peer.online ? 'online' : 'offline';
    const statusLabel = { online: '在线', offline: '离线', unknown: '状态更新中' }[status];
    const dot = element('span', 'qt-device-status');
    dot.dataset.state = status;
    dot.setAttribute('role', 'img');
    dot.setAttribute('aria-label', statusLabel);
    dot.title = statusLabel;
    name.append(dot, element('strong', '', peerLabel(peer)));
    info.append(name);
    const busy = peer.busy > 0 || transfers.items.some((i) => i.peerId === peer.id && isActive(i));
    if (busy) {
      info.append(element('small', '', '传输结束后可忘记配对'));
    }
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
  get('[data-dialog-title]').textContent = type === 'devices' ? '我的设备' : type === 'approval' ? '确认新设备' : type === 'name' ? '给这台设备起个名字' : '连接设备';
  get('[data-onboarding-name-panel]').hidden = type !== 'name';
  get('[data-pair-panel]').hidden = type !== 'pair';
  get('[data-devices-panel]').hidden = type !== 'devices';
  get('[data-approval-panel]').hidden = type !== 'approval';
  if (type === 'devices') {
    get('[data-name-input]').value = connection.device?.name || deviceNames.device();
    renderDevices();
  }
  if (type === 'name') {
    get('[data-onboarding-name]').value = connection.device?.name || deviceNames.device();
    get('[data-name-error]').hidden = true;
  }
  if (type === 'approval' && state.requests[0]) {
    get('[data-request-name]').textContent = state.requests[0].name;
    get('[data-request-id]').textContent = `设备 ${state.requests[0].fingerprint.slice(0, 12)} · 请求连接`;
  }
  get('[data-action="close"]').focus();
  if (type === 'name') {
    get('[data-onboarding-name]').focus();
    get('[data-onboarding-name]').select();
  }
}

async function openPairing() {
  openDialog('pair');
  pairTab('show');
  if (state.codeUntil <= Date.now()) {
    await newCode();
  }
}

async function saveName(value) {
  const name = value.trim();
  if (!validDeviceName(name)) {
    throw new Error('请输入 1–24 个字符的设备名称');
  }
  await connection.rpc('device.rename', { name });
  deviceNames.rememberDevice(name);
  deviceNames.write('suichuan-name-confirmed', connection.device.id);
}

async function imageAsPng(item) {
  if (item.blob.type === 'image/png') {
    return item.blob;
  }
  const image = new Image();
  image.src = item.url;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext('2d').drawImage(image, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('图片转换失败'));
      }
    }, 'image/png');
  });
}

async function copyImage(item) {
  if (!item?.blob || !item.url || item.copying || !canCopyImage()) {
    return;
  }
  item.copying = true;
  renderTransfers();
  try {
    // Start the clipboard write in the click's activation scope, even when
    // decoding/converting a JPEG, WebP or GIF to PNG is asynchronous.
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': imageAsPng(item) })]);
    item.imageCopied = true;
    tell(item.mime === 'image/gif' ? '已复制静态图片；保留动图请保存原文件' : '图片已复制，可粘贴到其他应用');
  } catch {
    tell('无法复制图片，请允许剪贴板权限，或点击保存下载图片');
  } finally {
    item.copying = false;
    renderTransfers();
  }
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
    deviceNames.write('suichuan-target', peers[0].id);
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
    updateLeaveGuard();
  } finally {
    state.sending = false;
    updateSend();
  }
}

async function action(name, el) {
  const item = transfers.items.find((i) => i.localId === el.dataset.id);
  const group = transfers.groups.find((entry) => entry.id === el.dataset.id);
  switch (name) {
    case 'first-connect':
    case 'connect':
      if (state.requests.length) {
        openDialog('approval');
      } else if (deviceNames.needsConfirmation(connection.device?.id, connection.device?.name)) {
        openDialog('name');
      } else {
        await openPairing();
      }
      break;
    case 'name-and-connect': {
      const error = get('[data-name-error]');
      error.hidden = true;
      el.disabled = true;
      try {
        await saveName(get('[data-onboarding-name]').value);
        if (state.modal === 'name') {
          await openPairing();
        }
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
      } finally {
        el.disabled = false;
      }
      break;
    }
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
      await saveName(get('[data-name-input]').value);
      if (state.modal === 'devices') {
        closeDialog();
      }
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
    case 'copy-image': await copyImage(item); break;
    case 'preview-image': openImagePreview(item); break;
    case 'close-image': closeImagePreview(); break;
    case 'save-file': {
      const url = URL.createObjectURL(item.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = item.name.replace(/[\\/\u0000-\u001f]/g, '_') || '随传文件';
      link.click();
      item.downloadStarted = true;
      renderTransfers();
      tell('已发起下载，请在浏览器下载列表中确认保存成功');
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      break;
    }
    case 'clear':
      if (transfers.items.some(needsSaving) && !window.confirm('还有文件需要保存。清空后无法找回，确定清空已结束记录？')) {
        break;
      }
      transfers.clear();
      shareUI?.clear();
      updateLeaveGuard();
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
get('[data-onboarding-name]').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault();
    get('[data-action="name-and-connect"]').click();
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
    deviceNames.write('suichuan-target', state.target);
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
  state.connectionError = '';
  state.peers = e.detail.peers;
  get('[data-local-name]').textContent = e.detail.device.name;
  renderTarget();
  renderReception(e.detail.reception);
  renderTransfers();
});
connection.addEventListener('peers', (e) => {
  state.peers = e.detail.peers;
  if (connection.device) {
    connection.device.name = e.detail.name;
  }
  deviceNames.rememberDevice(e.detail.name);
  get('[data-local-name]').textContent = e.detail.name;
  renderTarget();
  renderReception(e.detail.reception);
  renderTransfers();
});
connection.addEventListener('disconnected', () => {
  state.connectionError = '连接已中断，正在自动重试';
  state.requests = [];
  state.joinId = null;
  state.codeUntil = 0;
  get('[data-join]').disabled = false;
  get('[data-join]').textContent = '连接';
  updateSend();
  renderReception();
  renderTransfers();
});
connection.addEventListener('fatal', (e) => {
  state.connectionError = e.detail.message;
  updateSend();
  root.dataset.connection = 'unavailable';
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
shareUI = new ShareComposer({
  root, connection, transfers, files: () => state.files, pick: () => fileInput.click(), addFiles, tell,
  remove: (id) => action('remove-file', { dataset: { id } }),
  consumeFiles: (ids) => {
    const submitted = new Set(ids);
    for (const entry of state.files) {
      if (submitted.has(entry.id) && entry.url) {
        URL.revokeObjectURL(entry.url);
      }
    }
    state.files = state.files.filter((entry) => !submitted.has(entry.id));
    renderAttachments();
  },
  changed: () => { updateSend(); renderTransfers(); }
});
renderTarget();
renderTransfers();
connection.start();

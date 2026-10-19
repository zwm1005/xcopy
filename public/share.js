import { Connection } from './connection.js';
import { Transfers } from './transfer.js';
import { el, action, fileList, sizeLabel, progressNode, saveBlob } from './share-ui.js';
import { archive } from './archive.js';
import { deviceNames } from './device-name.js';

const connection = new Connection({ guest: true });
const transfers = new Transfers(connection);
const root = document.querySelector('[data-receive]');
const token = location.hash.slice(1);
let share;
let error = '';
let busy = false;
let archiveBusy = false;
let editingName = false;
let nameDraft = '';
let nameError = '';
let toastTimer;
const saved = new Set();
function tell(message) {
  const toast = document.querySelector('.qt-toast');
  clearTimeout(toastTimer);
  toast.textContent = message; toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 5000);
}
function latest() {
  const byIndex = new Map();
  for (const item of transfers.items) {
    if (item.shareId === share?.id && (!share.myClaim || item.claimId === share.myClaim.id) && !byIndex.has(item.shareIndex)) {
      byIndex.set(item.shareIndex, item);
    }
  }
  return byIndex;
}
async function rpc(type) {
  if (busy) {
    return;
  }
  busy = true; error = ''; render();
  try {
    share = await connection.rpc(type, { token, id: share?.id, claimId: share?.myClaim?.id, ...(type === 'share.claim' ? { name: deviceNames.guest() } : {}) });
  } catch (err) {
    error = err.message;
    // claim 的响应丢失时，inspect 可重新确认同一会话的归属，不会重复领取。
    try {
      share = await connection.rpc('share.inspect', { token });
    } catch { /* 保留原错误，恢复连接后再查询。 */ }
  } finally {
    busy = false; render();
  }
}
function nameControl() {
  const row = el('div', 'share-device-name');
  if (!editingName) {
    const name = el('span', '', `你的设备：${deviceNames.guest()}`);
    name.dataset.recipientName = '';
    const edit = action('修改', () => {
      editingName = true; nameDraft = deviceNames.guest(); nameError = ''; render();
      root.querySelector('[data-recipient-name-input]')?.focus();
    });
    edit.disabled = busy;
    edit.dataset.control = 'edit-name';
    edit.setAttribute('aria-label', '修改领取设备名称');
    row.append(name, edit);
    return row;
  }
  const form = el('form', 'share-name-form');
  const label = el('label', '', '你的设备名称');
  label.htmlFor = 'share-recipient-name';
  const input = el('input', 'share-url');
  input.id = label.htmlFor;
  input.value = nameDraft; input.maxLength = 24; input.autocomplete = 'off';
  input.dataset.recipientNameInput = ''; input.dataset.control = 'name-input';
  input.setAttribute('aria-invalid', String(Boolean(nameError)));
  input.setAttribute('aria-describedby', 'share-name-feedback');
  input.addEventListener('input', () => { nameDraft = input.value; });
  const cancel = () => { editingName = false; nameError = ''; render(); root.querySelector('[data-control="edit-name"]')?.focus(); };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault(); cancel();
    }
  });
  const controls = el('div', 'share-actions');
  const save = action('保存名称', () => form.requestSubmit());
  save.dataset.control = 'save-name';
  const discard = action('取消', cancel);
  discard.dataset.control = 'cancel-name';
  controls.append(save, discard);
  const feedback = el('p', nameError ? 'share-feedback' : 'share-muted share-small', nameError || '1–24 个字符，发送方可看到此名称');
  feedback.id = 'share-name-feedback';
  if (nameError) {
    feedback.setAttribute('role', 'alert');
  }
  form.append(label, input, feedback, controls);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    try {
      deviceNames.renameGuest(nameDraft);
      editingName = false; nameError = ''; render();
      root.querySelector('[data-control="edit-name"]')?.focus();
    } catch (err) {
      nameError = err.message; render();
      root.querySelector('[data-recipient-name-input]')?.focus();
    }
  });
  row.append(form);
  return row;
}
function render() {
  const focused = root.contains(document.activeElement) ? document.activeElement?.dataset.control : null;
  const selection = focused === 'name-input' ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  const filesOpen = root.querySelector('details')?.open || false;
  root.replaceChildren();
  if (!share) {
    root.append(el('h1', '', error ? '暂时无法打开分享' : '正在打开分享'), el('p', 'share-description', error || '正在连接服务…'));
    return;
  }
  const items = latest();
  const mine = share.myClaim;
  const multiple = share.mode === 'multiple';
  const complete = share.mine && (mine?.state === 'completed' || share.status === 'completed') && share.files.every((f) => items.get(f.index)?.verified);
  const failed = [...items.values()].some((i) => ['failed', 'cancelled'].includes(i.status));
  const occupied = !multiple && share.status === 'claimed' && !share.mine;
  const closed = mine ? ['cancelled', 'expired', 'unavailable'].includes(mine.state) : ['cancelled', 'expired', 'unavailable', 'stopped', 'draining'].includes(share.status) || share.status === 'completed';
  let title = '有一组文件给你';
  let description = `来自 ${share.senderName} · ${share.files.length} 个文件 · ${sizeLabel(share.totalBytes)}`;
  if (complete) {
    title = '全部文件接收完成'; description = multiple ? '本次领取的全部文件已校验，请保存到你的设备。' : '所有文件已校验，链接已自动失效。请保存到你的设备。';
  } else if (closed || occupied) {
    title = mine && multiple ? ({ cancelled: '本次领取已取消', expired: '本次领取已超时', unavailable: '本次领取已失效' })[mine.state] : ({ cancelled: '分享已被取消', expired: '这份分享已过期', unavailable: '分享已失效', completed: '这份分享已被领取', claimed: '文件正在被他人领取', stopped: '分享已停止新的领取', draining: '分享已停止新的领取' })[share.status];
    description = '需要这些文件？请联系发送方重新分享。';
  } else if (!connection.ready || !share.senderOnline) {
    title = !connection.ready ? '正在恢复连接' : '等待发送方恢复连接';
  } else if (share.mine) {
    title = mine?.state === 'queued' ? '等待发送' : failed || mine?.state === 'retryable' ? '连接中断，可以重试' : '正在接收文件';
    description = mine?.state === 'queued' ? `已加入队列，前面还有 ${Math.max(0, mine.position - 1)} 次领取，请保持页面打开。` : multiple && !share.accepting ? '链接已停止新的领取，本次领取继续进行。请保持双方页面打开。' : '领取资格已为本页锁定，请保持双方页面打开。';
  }
  root.append(el('h1', '', title), el('p', 'share-description', description));
  const panel = el('section', 'share-panel');
  panel.setAttribute('aria-label', '分享文件');
  if (share.mine && share.recipientName) {
    const recipient = el('p', 'share-recipient', `接收设备：${share.recipientName}`);
    recipient.dataset.recipientName = '';
    panel.append(recipient);
  }
  const list = fileList(share.files, (file) => {
    const item = items.get(file.index);
    if (share.mine && item?.verified && item.blob) {
      const button = action(saved.has(file.index) ? '再次保存' : '保存', () => {
        saveBlob(item.blob, file.name); saved.add(file.index); render(); tell('已发起下载，请在浏览器下载列表中确认');
      });
      button.dataset.control = `save-${file.index}`;
      button.dataset.saveIndex = file.index;
      return button;
    }
    return el('span', 'share-muted share-small', item?.status === 'transferring' ? `${Math.floor(item.bytes / Math.max(item.size, 1) * 100)}%` : item?.status === 'failed' ? '等待重试' : '');
  });
  if (!share.mine && share.files.length > 3) {
    const details = el('details', 'share-file-details');
    details.open = filesOpen;
    details.append(el('summary', '', `查看 ${share.files.length} 个文件的清单`), list);
    panel.append(details);
  } else {
    panel.append(list);
  }
  if (complete) {
    if (share.files.length > 1) {
      const all = action(archiveBusy ? '正在打包…' : '打包保存全部 (.zip)', async () => {
        archiveBusy = true; render();
        try {
          const blob = await archive(share.files.map((f) => ({ name: f.name, blob: items.get(f.index).blob })));
          saveBlob(blob, '随传文件.zip');
          share.files.forEach((f) => saved.add(f.index));
          tell('已发起 ZIP 下载，请在浏览器下载列表中确认');
        } catch {
          tell('打包失败，请逐个保存文件');
        } finally {
          archiveBusy = false; render();
        }
      }, true);
      all.disabled = archiveBusy; all.dataset.control = 'archive'; all.dataset.saveAll = '';
      all.classList.add('share-main-action'); panel.prepend(all);
    }
    panel.append(el('p', 'share-message', '当前页面仍可再次保存；刷新或关闭后将无法找回。'));
  } else if (share.mine && !closed) {
    panel.append(progressNode([...items.values()], share.totalBytes, share.files.filter((f) => f.completed).length, share.files.length));
    const retry = action(busy ? '正在重新连接…' : '重试未完成的文件', () => rpc('share.retry'));
    retry.hidden = mine?.state === 'queued';
    retry.disabled = busy || !connection.ready || !share.senderOnline;
    retry.dataset.control = 'retry';
    // 同时保留手动重试入口，覆盖领取回执/发送通知丢失的场景。
    panel.append(retry);
    if (multiple) {
      const cancel = action('取消本次领取', () => {
        if (window.confirm('取消本次未完成的领取？已接收文件仍可保存。')) {
          rpc('share.claim.cancel');
        }
      });
      cancel.dataset.control = 'cancel-claim';
      cancel.disabled = busy || !connection.ready;
      panel.append(cancel);
    }
  } else if (!closed && !occupied) {
    const detail = el('div', 'share-detail');
    const online = el('span', 'qt-connection');
    online.append(el('span', `qt-status-dot${share.senderOnline ? ' is-connected' : ''}`), el('span', '', share.senderOnline ? '在线' : '重连中'));
    detail.append(el('span', '', '发送设备'), online);
    panel.append(detail, el('p', 'share-muted share-small', multiple ? '有效期内可多人领取，人数不限；繁忙时自动排队。' : '整组仅可领取一次，全部文件校验完成后失效。'), nameControl());
    const claim = action(busy ? '正在领取…' : `领取全部 ${share.files.length} 个文件`, () => rpc('share.claim'), true);
    claim.disabled = busy || editingName || !connection.ready || !share.senderOnline;
    claim.dataset.control = 'claim'; claim.dataset.claim = ''; claim.classList.add('share-main-action');
    panel.append(claim);
  }
  if (error) {
    const feedback = el('p', 'share-feedback', error);
    feedback.setAttribute('role', 'alert'); panel.append(feedback);
  }
  root.append(panel, el('p', 'share-message', '无需登录或配对 · 文件由发送设备直接传出'));
  if (focused) {
    [...root.querySelectorAll('[data-control]')].find((n) => n.dataset.control === focused)?.focus({ preventScroll: true });
    if (selection && document.activeElement?.dataset.control === 'name-input') {
      document.activeElement.setSelectionRange(...selection);
    }
  }
}
connection.addEventListener('ready', async () => {
  try {
    share = await connection.rpc('share.inspect', { token }); error = '';
  } catch (err) {
    error = err.message;
  }
  render();
});
connection.addEventListener('share.state', (e) => { share = e.detail; render(); });
connection.addEventListener('disconnected', render);
connection.addEventListener('notice', (e) => { error = e.detail.message; render(); });
transfers.addEventListener('change', render);
transfers.addEventListener('notice', (e) => tell(e.detail.message));
function needsLeaveWarning() {
  return share?.mine && ((share.myClaim && !['completed', 'cancelled', 'expired', 'unavailable'].includes(share.myClaim.state)) || [...latest().values()].some((i) => i.verified && !saved.has(i.shareIndex)));
}
function beforeLeave(event) {
  if (needsLeaveWarning()) {
    event.preventDefault(); event.returnValue = true;
  }
}
window.addEventListener('beforeunload', beforeLeave);
window.addEventListener('hashchange', () => {
  if (location.hash.slice(1) === token) {
    return;
  }
  if (needsLeaveWarning() && !window.confirm('打开新的分享会清空本页未保存的文件和领取进度，确定继续？')) {
    history.replaceState(null, '', `#${token}`);
    return;
  }
  window.removeEventListener('beforeunload', beforeLeave);
  location.reload();
});
if (/^[\w-]{43}$/.test(token)) {
  connection.start();
} else {
  error = '链接不完整，请使用发送方提供的完整链接或二维码。'; render();
}

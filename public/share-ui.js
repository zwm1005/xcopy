const terminal = new Set(['completed', 'cancelled', 'expired', 'unavailable', 'stopped']);
export const sizeLabel = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
export function el(tag, className = '', text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}
export function action(label, handler, primary = false) {
  const node = el('button', `qt-button ${primary ? 'qt-primary' : 'qt-outline'}`, label);
  node.type = 'button';
  node.addEventListener('click', handler);
  return node;
}
export function fileList(files, renderAction) {
  const list = el('div', 'share-files');
  files.forEach((file, index) => {
    const row = el('div', 'share-file');
    const info = el('div', 'share-file-info');
    info.append(el('div', 'share-file-name', file.name), el('div', 'share-muted share-small', sizeLabel(file.size)));
    row.append(info);
    if (renderAction) {
      const node = renderAction(file, index);
      if (node) {
        row.append(node);
      }
    }
    list.append(row);
  });
  return list;
}
export function statusLabel(s) {
  if (s.mode === 'multiple' && !terminal.has(s.status)) {
    return s.accepting ? '可继续领取' : '已停止新领取';
  }
  return { ready: '等待领取', claimed: '领取中', completed: '全部已领取', cancelled: '已取消', expired: '已过期', unavailable: '分享已失效', stopped: '分享已结束' }[s.status] || '连接中';
}
export function progressNode(items, totalBytes, completed, count) {
  const bytes = items.reduce((sum, item) => sum + item.bytes, 0);
  const box = el('div', 'share-progress');
  const meter = el('progress');
  meter.max = Math.max(totalBytes, 1);
  meter.value = totalBytes ? Math.min(bytes, totalBytes) : completed === count ? 1 : 0;
  meter.setAttribute('aria-label', '整组文件接收进度');
  box.append(meter, el('p', 'share-muted share-small', `已校验 ${completed} / ${count} 个文件 · ${sizeLabel(Math.min(bytes, totalBytes))} / ${sizeLabel(totalBytes)}`));
  return box;
}
export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name.replace(/[\\/\u0000-\u001f]/g, '_') || '随传文件';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export class ShareComposer {
  constructor({ root, connection, transfers, files, pick, remove, consumeFiles, addFiles, tell, changed }) {
    Object.assign(this, { root, connection, transfers, files, pick, remove, consumeFiles, tell, changed });
    this.entries = [];
    this.expandedRecords = new Set();
    this.selected = null;
    this.mode = 'device';
    this.minutes = 10;
    this.shareMode = 'single';
    this.retryClaims = new Set();
    this.busy = false;
    this.panel = root.querySelector('[data-share-panel]');
    this.records = root.querySelector('[data-share-records]');
    root.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => this.setMode(button.dataset.mode)));
    this.panel.addEventListener('dragover', (e) => e.preventDefault());
    this.panel.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!this.current()) {
        addFiles([...e.dataTransfer.files]);
      }
    });
    connection.addEventListener('share.state', (e) => this.apply(e.detail));
    connection.addEventListener('share.claimed', (e) => this.start(e.detail.id, e.detail.claimId));
    connection.addEventListener('share.retry', (e) => this.retry(e.detail.id, e.detail.claimId));
    connection.addEventListener('ready', async (e) => {
      if (!e.detail.resumed) {
        for (const entry of this.entries) {
          if (!terminal.has(entry.status)) {
            this.apply({ ...entry, status: 'unavailable' });
          }
        }
      }
      try {
        const result = await connection.rpc('share.list');
        result.shares.forEach((s) => this.apply(s));
      } catch (error) {
        this.tell(error.message);
      }
      this.render();
    });
    connection.addEventListener('disconnected', () => this.render());
    transfers.addEventListener('change', () => this.render());
    this.clock = setInterval(() => {
      for (const node of this.panel.querySelectorAll('[data-share-expiry]')) {
        node.textContent = this.remaining(Number(node.dataset.shareExpiry));
      }
    }, 1000);
    window.addEventListener('beforeunload', (event) => {
      if (this.active()) {
        event.preventDefault();
        event.returnValue = true;
      }
    });
    this.render();
  }

  current() { return this.entries.find((s) => s.id === this.selected); }
  active() { return this.entries.some((s) => !terminal.has(s.status)); }
  clear() {
    this.entries = this.entries.filter((s) => !terminal.has(s.status));
    this.expandedRecords = new Set([...this.expandedRecords].filter((id) => this.entries.some((s) => s.id === id)));
    if (!this.current()) {
      if (this.selected) {
        this.shareMode = 'single';
        this.minutes = 10;
      }
      this.selected = null;
    }
    this.render();
  }
  remaining(expires) { return `剩余 ${Math.max(0, Math.ceil((expires - Date.now()) / 60000))} 分钟 · ${this.current()?.mode === 'multiple' ? '不限领取人数' : '整组仅可领取一次'}`; }

  setMode(mode) {
    this.mode = mode;
    this.root.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === mode)));
    this.root.querySelector('.qt-composer').hidden = mode === 'share';
    this.panel.hidden = mode !== 'share';
    this.changed();
    this.render();
  }

  apply(value) {
    let entry = this.entries.find((s) => s.id === value.id);
    if (!entry && this.pendingCreate?.id === value.requestId) {
      const fileIds = this.pendingCreate.fileIds;
      entry = { ...value, sources: this.pendingCreate.sources };
      this.entries.unshift(entry);
      this.selected = value.id;
      this.pendingCreate = null;
      // 分享持有独立的文件引用；只清理本次提交的草稿，不影响稍后添加的文件。
      this.consumeFiles(fileIds);
    }
    if (entry) {
      Object.assign(entry, value);
      for (const claim of entry.claims || []) {
        if (terminal.has(claim.state)) {
          this.releaseClaim(entry.id, claim);
        } else if (claim.state === 'transferring' && !terminal.has(entry.status)) {
          this.start(entry.id, claim.id);
        }
      }
      if (terminal.has(entry.status)) {
        for (const item of this.transfers.items.filter((i) => i.shareId === entry.id)) {
          item.shareOpen = false;
          if (entry.status === 'completed') {
            this.transfers.finishLocal(item, 'completed');
          } else {
            this.transfers.cancel(item);
          }
        }
        entry.sources = [];
        if (entry.status === 'cancelled' && this.selected === entry.id) {
          this.selected = null;
          this.shareMode = 'single';
          this.minutes = 10;
        }
      }
    }
    this.render();
    this.changed();
  }

  releaseClaim(id, claim) {
    const items = this.transfers.items.filter((item) => item.shareId === id && item.claimId === claim.id);
    for (const item of items) {
      if (!['completed', 'failed', 'cancelled'].includes(item.status)) {
        this.transfers.finishLocal(item, claim.state === 'completed' ? 'completed' : 'cancelled', claim.reason);
      }
      this.transfers.byId.delete(item.id);
      this.transfers.running.delete(item);
      item.source = null;
      item.blob = null;
    }
    this.transfers.items = this.transfers.items.filter((item) => !items.includes(item));
    this.transfers.queue = this.transfers.queue.filter((item) => !items.includes(item));
    this.retryClaims.delete(claim.id);
  }

  start(id, claimId) {
    const entry = this.entries.find((s) => s.id === id);
    const claim = entry?.claims?.find((c) => c.id === claimId);
    if (!entry || !claim || claim.state !== 'transferring' || terminal.has(entry.status)) {
      return;
    }
    const items = this.transfers.items.filter((i) => i.shareId === id && i.claimId === claimId);
    if (!items.length) {
      this.transfers.sendShare(entry, entry.sources, claim).forEach((item) => { item.shareAttempt = claim.attempt || 0; });
    } else if (this.retryClaims.has(claimId) || items.some((item) => (item.shareAttempt || 0) < claim.attempt)) {
      for (const item of items) {
        if (!claim.files[item.shareIndex].completed) {
          this.transfers.retry(item);
        }
      }
      for (const item of this.transfers.items.filter((item) => item.claimId === claimId)) {
        item.shareAttempt = claim.attempt || 0;
      }
    }
    this.retryClaims.delete(claimId);
  }

  retry(id, claimId) {
    this.retryClaims.add(claimId);
    // 等待随后发布的新快照，排队者获得位置后才重建文件任务。
  }

  claimSummary(s) {
    const n = s.counts || {};
    return `已完成 ${n.completed || 0} 次 · ${n.active || 0} 次传输中 · ${n.queued || 0} 次排队${n.retryable ? ` · ${n.retryable} 次待重试` : ''}${n.failed ? ` · ${n.failed} 次未完成` : ''}`;
  }

  claimDetails(s) {
    const list = el('div', 'share-claims');
    for (const claim of [...(s.claims || [])].reverse()) {
      const row = el('div', 'share-claim');
      row.dataset.claimRecord = claim.id;
      row.dataset.claimState = claim.state;
      const items = this.transfers.items.filter((item) => item.claimId === claim.id);
      const count = claim.files.filter((file) => file.completed).length;
      const state = { queued: `排队中 · 前面 ${Math.max(0, claim.position - 1)} 次领取`, transferring: '传输中', retryable: '等待重试', completed: '已完成', cancelled: '已取消', expired: '已超时', unavailable: '已离线' }[claim.state];
      const info = el('div');
      info.append(el('p', 'share-claim-name', claim.recipientName), el('p', 'share-muted share-small', `${state} · 已校验 ${count}/${claim.files.length} 个文件`));
      if (claim.reason) {
        info.append(el('p', 'share-muted share-small', claim.reason));
      }
      row.append(info);
      if (claim.state === 'transferring' && items.length) {
        row.append(progressNode(items, s.totalBytes, count, claim.files.length));
      }
      list.append(row);
    }
    if (!s.claims?.length) {
      list.append(el('p', 'share-muted share-small', '还没有人领取'));
    }
    list.append(el('p', 'share-muted share-small', '展示当前领取及最近 50 次已结束记录；累计完成次数持续保留。'));
    return list;
  }

  async create() {
    if (this.busy || !this.files().length) {
      return;
    }
    const files = this.files();
    const sources = files.map((f) => f.file);
    this.pendingCreate = { id: crypto.randomUUID(), sources, fileIds: files.map((f) => f.id) };
    this.busy = true;
    this.render();
    try {
      const value = await this.connection.rpc('share.create', { requestId: this.pendingCreate.id, minutes: this.minutes, mode: this.shareMode, shareProtocol: 2, files: sources.map((f) => ({ name: f.name, size: f.size, mime: f.type })) });
      this.apply(value);
    } catch (error) {
      try {
        const result = await this.connection.rpc('share.list');
        result.shares.forEach((s) => this.apply(s));
      } catch { /* 断线后由 ready 恢复同一页面的创建结果。 */ }
      if (this.pendingCreate) {
        this.tell(error.message);
      }
    } finally {
      this.busy = false;
      this.render();
      this.changed();
    }
  }

  render() {
    const selected = this.current();
    const focus = document.activeElement;
    const filesOpen = this.panel.querySelector('.share-file-details')?.open || false;
    const settingsOpen = this.panel.querySelector('[data-share-settings]')?.open || false;
    const actionsOpen = this.panel.querySelector('.share-more-actions')?.open || false;
    const focusKey = this.panel.contains(focus) || this.records.contains(focus) ? focus?.dataset.shareControl : null;
    this.panel.classList.toggle('share-panel-ended', Boolean(selected && terminal.has(selected.status)));
    this.panel.classList.toggle('share-panel-draft', !selected);
    this.panel.replaceChildren();
    if (!selected) {
      const files = this.files();
      const upload = el('div', 'share-upload');
      upload.append(el('p', 'share-drop', '拖入文件，或点击附件图标添加'));
      if (files.length) {
        const attachments = el('div', 'qt-attachments');
        for (const entry of files) {
          const row = el('div', 'qt-attachment');
          if (entry.url) {
            const preview = el('img', 'qt-attachment-preview');
            preview.src = entry.url;
            preview.alt = entry.file.name;
            row.append(preview);
          }
          const info = el('div', 'qt-attachment-info');
          info.append(el('div', 'qt-attachment-name', entry.file.name), el('div', 'qt-attachment-size', sizeLabel(entry.file.size)));
          const remove = action('×', () => this.remove(entry.id));
          remove.className = 'qt-button qt-quiet qt-icon';
          remove.setAttribute('aria-label', `移除 ${entry.file.name}`);
          remove.disabled = this.busy;
          remove.dataset.shareControl = `remove-${entry.id}`;
          row.append(info, remove);
          attachments.append(row);
        }
        upload.append(attachments);
      }
      const pick = action('', this.pick);
      pick.className = 'qt-button qt-icon qt-quiet cursor-interaction';
      pick.setAttribute('aria-label', '添加附件');
      pick.dataset.tooltip = '添加附件';
      pick.append(this.root.querySelector('[data-action="pick"] svg').cloneNode(true));
      pick.disabled = this.busy;
      pick.dataset.shareControl = 'pick-files';
      const tools = el('div', 'qt-compose-footer');
      tools.append(pick);
      upload.append(tools);
      this.panel.append(upload, el('p', 'share-limit', `最多 8 个文件 · P2P 直连不限大小；服务器中转单个不超过 ${sizeLabel(this.connection.config?.maxRelayFileBytes || this.connection.config?.maxFileBytes || 50 * 1048576)}`));

      const total = files.reduce((sum, f) => sum + f.file.size, 0);
      const actions = el('div', 'share-compose-actions');
      if (files.length) {
        actions.append(el('span', 'share-muted share-small', `${files.length} 个文件 · ${sizeLabel(total)}`));
      }
      const generate = action(this.busy ? '正在创建…' : '创建分享', () => this.create(), true);
      generate.disabled = this.busy || !this.connection.ready || !files.length || this.active();
      generate.dataset.shareControl = 'generate';
      generate.dataset.shareGenerate = '';
      actions.append(generate);
      const description = el('p', 'share-mode-description', this.shareMode === 'multiple' ? '已开启多人领取，有效期内可供多人接收。' : '默认一次领取，接收完成后链接失效。多人领取可在更多设置中开启。');
      description.dataset.shareDescription = '';
      this.panel.append(actions, description);

      const settings = el('details', 'share-settings');
      settings.dataset.shareSettings = '';
      settings.open = settingsOpen;
      const summary = el('summary', '', '更多设置');
      summary.dataset.shareControl = 'settings';
      settings.append(summary);
      const modes = el('fieldset', 'share-mode-field');
      modes.append(el('legend', '', '领取方式'));
      const choices = el('div', 'share-mode-options');
      for (const [mode, label] of [['single', '一次领取'], ['multiple', '多人领取']]) {
        const choice = el('label', 'share-mode-choice');
        const option = el('input');
        option.type = 'radio';
        option.name = 'share-mode';
        option.value = mode;
        option.checked = this.shareMode === mode;
        option.disabled = this.busy;
        option.dataset.shareControl = `mode-${mode}`;
        option.dataset.shareMode = mode;
        option.setAttribute('aria-describedby', 'share-mode-help');
        option.addEventListener('change', () => {
          this.shareMode = mode;
          this.render();
        });
        choice.append(option, el('span', '', label));
        choices.append(choice);
      }
      const help = el('p', 'share-limit', this.shareMode === 'multiple' ? '适合发给多人；有效期内可持续领取，繁忙时自动排队。' : '适合发给一个人；对方接收完成后，链接自动失效。');
      help.id = 'share-mode-help';
      modes.append(choices, help);
      const expiryRow = el('div', 'share-expiry-row');
      const expiryLabel = el('label', '', '链接有效期');
      expiryLabel.htmlFor = 'share-expiry';
      const expiry = el('select');
      expiry.id = 'share-expiry';
      expiry.dataset.shareControl = 'expiry';
      expiry.disabled = this.busy;
      [10, 30, 60].forEach((n) => {
        expiry.add(new Option(n === 60 ? '1 小时' : `${n} 分钟`, String(n)));
      });
      expiry.value = String(this.minutes);
      expiry.addEventListener('change', () => {
        this.minutes = Number(expiry.value);
      });
      expiryRow.append(expiryLabel, expiry);
      settings.append(modes, expiryRow);
      this.panel.append(settings, el('p', 'share-keep-open', this.shareMode === 'multiple' ? '分享期间保持本页打开。到期停止新领取，已受理任务继续。' : '对方收完前，请保持本页打开。'));
    } else if (terminal.has(selected.status)) {
      const message = el('div', 'share-ended-message');
      const mark = el('span', 'share-ended-mark', selected.status === 'completed' ? '✓' : '—');
      mark.setAttribute('aria-hidden', 'true');
      const copy = el('div', 'share-ended-copy');
      const titles = { completed: '分享已完成', cancelled: '分享已取消', expired: '分享已过期', unavailable: '分享已失效', stopped: '分享已结束' };
      copy.append(el('h2', '', titles[selected.status]), el('p', 'share-muted', '链接和二维码已失效，详情保留在下方记录中。'));
      message.append(mark, copy);
      const next = action('创建新的分享', () => {
        this.selected = null;
        this.shareMode = 'single';
        this.minutes = 10;
        this.render();
        this.panel.querySelector('[data-share-control="pick-files"]')?.focus();
      }, true);
      next.dataset.shareControl = 'new-share';
      this.panel.append(message, next);
    } else {
      const head = el('div', 'share-heading');
      head.append(el('h2', '', `${selected.files.length} 个文件 · ${sizeLabel(selected.totalBytes)}`), el('span', 'share-muted', statusLabel(selected)));
      const list = fileList(selected.files, (f) => el('span', 'share-small share-muted', f.completed ? '已校验' : ''));
      this.panel.append(head);
      if (selected.recipientName) {
        this.panel.append(el('p', 'share-recipient', `接收设备：${selected.recipientName}`));
      }
      if (selected.files.length > 3 || selected.mode === 'multiple') {
        const details = el('details', 'share-file-details');
        details.open = filesOpen;
        details.append(el('summary', '', `查看 ${selected.files.length} 个文件的清单`), list);
        this.panel.append(details);
      } else {
        this.panel.append(list);
      }
      if (selected.accepting) {
        const url = `${location.origin}/s#${selected.token}`;
        const area = el('div', 'share-link-area');
        const qr = globalThis.qrcode(0, 'M');
        qr.addData(url, 'Byte');
        qr.make();
        const image = el('img', 'share-qr');
        image.src = qr.createDataURL(5, 20);
        image.alt = '扫描二维码领取这组文件';
        const links = el('div', 'share-link-controls');
        const status = el('span', 'qt-connection');
        status.append(el('span', `qt-status-dot${this.connection.ready ? ' is-connected' : ''}`), el('span', '', this.connection.ready ? selected.mode === 'multiple' ? '链接开放中，可多人领取' : '等待对方领取' : '连接中断，正在重连'));
        const expiry = el('p', 'share-limit', this.remaining(selected.expires));
        expiry.dataset.shareExpiry = selected.expires;
        const input = el('input', 'share-url');
        input.value = url;
        input.readOnly = true;
        input.setAttribute('aria-label', '分享链接');
        input.dataset.shareUrl = '';
        const actions = el('div', 'share-actions');
        const copy = action('复制链接', async () => {
          try {
            await navigator.clipboard.writeText(url);
            this.tell('分享链接已复制');
          } catch {
            input.focus(); input.select(); this.tell('请复制已选中的链接');
          }
        }, true);
        copy.dataset.shareControl = 'copy';
        const save = action('保存二维码', () => {
          const a = document.createElement('a');
          a.href = image.src; a.download = '随传分享二维码.gif'; a.click();
        });
        actions.append(copy, save);
        const open = el('a', 'share-open', '打开领取页面 ↗');
        open.href = url; open.target = '_blank'; open.rel = 'noopener noreferrer';
        links.append(status, expiry, input, actions, open);
        area.append(image, links);
        this.panel.append(area, el('p', 'share-limit', selected.mode === 'multiple' ? '请保持本页打开。多人可同时领取，繁忙时自动排队；每次领取互不影响。' : '请保持本页打开。打开链接或扫码不会占用领取机会，点击领取后锁定给该接收页面。'));
      } else if (selected.mode === 'multiple') {
        this.panel.append(el('p', 'share-description', '已停止新的领取，已受理的任务继续进行，请保持本页打开。'));
      } else if (selected.status === 'claimed') {
        const items = this.transfers.items.filter((i) => i.shareId === selected.id);
        this.panel.append(progressNode(items, selected.totalBytes, selected.files.filter((f) => f.completed).length, selected.files.length));
        this.panel.append(el('p', 'share-description', items.find((i) => i.status === 'failed')?.reason || (items.some((i) => i.status === 'failed') ? '连接中断，等待原接收页面重试。其他人无法领取。' : '对方正在领取，请保持页面打开。全部文件校验完成后，链接自动失效。')));
      }
      const footer = el('div', 'share-footer');
      const cancel = action(selected.mode === 'multiple' ? '结束并中断' : '取消分享', async () => {
        if (!window.confirm(selected.mode === 'multiple' ? '链接将失效，所有排队和未完成的传输会被中断。确定结束？' : '取消后，分享链接立即失效。确定取消？')) {
          return;
        }
        try {
          this.apply(await this.connection.rpc('share.cancel', { id: selected.id }));
          if (this.mode === 'share' && !this.current()) {
            this.panel.querySelector('[data-share-control="pick-files"]')?.focus();
          }
        } catch (error) {
          this.tell(error.message);
        }
      });
      cancel.dataset.shareControl = 'cancel';
      cancel.disabled = !this.connection.ready;
      if (selected.mode === 'multiple' && selected.accepting) {
        const stop = action('停止新领取', async () => {
          const count = (selected.claims || []).filter((c) => !terminal.has(c.state)).length;
          if (!window.confirm(`停止后链接不再接受新的领取，已受理的 ${count} 次领取继续。确定停止？`)) {
            return;
          }
          try {
            this.apply(await this.connection.rpc('share.stop', { id: selected.id }));
          } catch (error) {
            this.tell(error.message);
          }
        });
        stop.dataset.shareControl = 'stop';
        stop.disabled = !this.connection.ready;
        footer.append(stop);
      } else {
        footer.append(el('span', 'share-muted share-small', '文件保留在你的设备上'));
      }
      if (selected.mode === 'multiple') {
        const more = el('details', 'share-more-actions');
        more.open = actionsOpen;
        const summary = el('summary', '', '更多操作');
        summary.dataset.shareControl = 'more-actions';
        more.append(summary, cancel);
        footer.append(more);
      } else {
        footer.append(cancel);
      }
      this.panel.append(footer);
    }
    this.records.replaceChildren();
    for (const s of this.entries) {
      const row = el('article', 'qt-transfer-card share-record');
      row.dataset.shareRecord = s.id;
      row.dataset.status = s.status;
      const main = el('div', 'share-record-main');
      const info = el('div');
      info.append(el('h3', '', `${s.mode === 'multiple' ? '多人分享' : '一次领取'} · ${s.files.length} 个文件`));
      if (s.recipientName) {
        const recipient = el('p', 'share-recipient', `接收设备：${s.recipientName}`);
        recipient.dataset.recipientName = '';
        info.append(recipient);
      }
      info.append(el('p', 'share-muted share-small', `${sizeLabel(s.totalBytes)} · ${statusLabel(s)}`));
      if (s.mode === 'multiple') {
        info.append(el('p', 'share-muted share-small share-counts', this.claimSummary(s)));
      }
      main.append(info);
      row.append(main);
      if (terminal.has(s.status) || s.mode === 'multiple') {
        const expanded = this.expandedRecords.has(s.id);
        const details = el('div', 'share-record-details');
        details.id = `share-result-${s.id}`;
        details.hidden = !expanded;
        details.append(fileList(s.files, s.mode === 'multiple' ? null : (file) => el('span', 'share-small share-muted', file.completed ? '已校验' : '未完成')));
        if (s.mode === 'multiple') {
          details.append(this.claimDetails(s));
        }
        if (s.mode !== 'multiple') {
          details.append(el('p', 'share-muted share-small', s.status === 'completed' ? '全部文件已接收并校验，接收方可在领取页面保存。' : '本次分享已结束，重新分享会生成新链接。'));
        }
        const toggle = action(expanded ? '收起详情' : '查看详情', () => {
          if (this.expandedRecords.has(s.id)) {
            this.expandedRecords.delete(s.id);
          } else {
            this.expandedRecords.add(s.id);
          }
          this.render();
        });
        toggle.dataset.shareControl = `record-details-${s.id}`;
        toggle.setAttribute('aria-expanded', String(expanded));
        toggle.setAttribute('aria-controls', details.id);
        main.append(toggle);
        row.append(details);
      }
      if (!terminal.has(s.status)) {
        const view = action('查看分享', () => {
          this.selected = s.id;
          this.setMode('share');
          this.panel.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
          this.panel.querySelector('[data-share-control]')?.focus({ preventScroll: true });
        });
        view.dataset.shareControl = `record-view-${s.id}`;
        main.append(view);
      }
      this.records.append(row);
    }
    if (focusKey) {
      [...this.root.querySelectorAll('[data-share-control]')].find((n) => n.dataset.shareControl === focusKey)?.focus({ preventScroll: true });
    }
  }
}

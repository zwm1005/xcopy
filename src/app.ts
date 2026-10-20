import { messageText } from './i18n/errors.js';
import { initI18n, onLocaleChange } from './i18n/index.js';
await initI18n();
import { t } from './i18n/index.js';
import type { Attachment, Peer, PairRequest, Reception } from './types/device.js';
import type { TransferItem, TransferGroup, Source } from './types/transfer.js';
import { query, activeElement } from './dom.js';
import { errorValue } from './dom.js';
import { Connection } from './connection.js';
import { Transfers } from './transfer.js';
import { ShareComposer, renderFileLimitNotice } from './share-ui.js';
import { MAX_FILES_PER_SEND } from './shared/transfer-limits.js';
import { deviceNames, validDeviceName } from './device-name.js';
const root = query<HTMLElement>(document, '#suichuan');
// 兼容静态发布切换瞬间仍引用新脚本的旧 HTML。
root.querySelector<HTMLElement>('.qt-section-heading .qt-connection')?.remove();
const get = <T extends Element = HTMLElement>(selector: string) => query<T>(root, selector);
const all = (selector: string) => [...root.querySelectorAll<HTMLElement>(selector)];
const connection = new Connection();
const transfers = new Transfers(connection);
const ALL_ONLINE = 'all-online';
const savedTarget = deviceNames.read('suichuan-target');
const state: {
    peers: Peer[];
    files: Attachment[];
    target: string;
    requests: PairRequest[];
    modal: string;
    code: string;
    codeUntil: number;
    sending: boolean;
    expandedGroups: Set<string>;
    connectionError: string;
    joinId?: string | null;
} = { peers: [], files: [], target: savedTarget === ALL_ONLINE ? '' : savedTarget || '', requests: [], modal: '', code: '', codeUntil: 0, sending: false, expandedGroups: new Set<string>(), connectionError: '' };
const editor = get<HTMLTextAreaElement>('[data-editor]');
const overlay = get<HTMLElement>('.qt-overlay');
const imagePreview = get<HTMLDialogElement>('[data-image-preview]');
const target = get<HTMLSelectElement>('[data-target]');
const fileInput = get<HTMLInputElement>('[data-files]');
let toastTimer: ReturnType<typeof setTimeout>;
let lastFocus: HTMLElement | null;
let previewId: string | null;
let leaveGuardInstalled = false;
let lastReception: Reception | undefined;
let shareUI: ShareComposer | undefined;
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string) {
    const el = document.createElement(tag);
    el.className = className || '';
    if (text !== undefined) {
        el.textContent = text;
    }
    return el;
}
function button(label: string, action: string, id?: string, extra = '') {
    const el = element('button', `qt-button qt-quiet ${extra}`, label);
    el.type = 'button';
    el.dataset.action = action;
    if (id) {
        el.dataset.id = id;
    }
    return el;
}
function tell(message: string) {
    clearTimeout(toastTimer);
    get<HTMLElement>('.qt-toast').textContent = messageText(message);
    get<HTMLElement>('.qt-toast').hidden = false;
    toastTimer = setTimeout(() => { get<HTMLElement>('.qt-toast').hidden = true; }, 5000);
}
import { sizeLabel } from './i18n/format.js';
const isActive = (item: TransferItem) => !['completed', 'failed', 'cancelled'].includes(item.status);
const needsSaving = (item: TransferItem) => item.incoming && item.status === 'completed' && item.kind !== 'text' && item.blob && !item.downloadStarted && (!item.imageCopied || item.mime === 'image/gif');
const canCopyImage = () => Boolean(typeof navigator.clipboard?.write === 'function' && typeof globalThis.ClipboardItem === 'function' && (typeof ClipboardItem.supports !== 'function' || ClipboardItem.supports('image/png')));
function peerLabel(peer: Peer) {
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
function beforeLeave(event: BeforeUnloadEvent) {
    if (transfers.items.some((item) => isActive(item) || needsSaving(item))) {
        event.preventDefault();
        event.returnValue = ''; // Request the browser's own leave confirmation.
    }
}
function updateLeaveGuard() {
    const unsaved = transfers.items.filter(needsSaving).length;
    const needed = unsaved > 0 || transfers.items.some(isActive);
    if (needed !== leaveGuardInstalled) {
        if (needed) {
            window.addEventListener('beforeunload', beforeLeave);
        }
        else {
            window.removeEventListener('beforeunload', beforeLeave);
        }
        leaveGuardInstalled = needed;
    }
    const note = get<HTMLElement>('[data-unsaved-note]');
    note.hidden = unsaved === 0 || shareUI?.mode === 'share';
    note.textContent = unsaved ? t("app.files.still.need.saving.refreshing.closing.or.clearing", { p0: unsaved }) : '';
}
function renderReception(reception?: Reception) {
    lastReception = reception;
    const note = get<HTMLElement>('[data-reception-note]');
    note.hidden = !connection.ready || !reception || reception.pages < 2;
    note.textContent = reception?.here
        ? t("app.this.page.receives.new.content.other.xcopy.tabs") : t("app.another.xcopy.tab.on.this.device.receives.new");
}
function renderTarget() {
    const online = state.peers.filter((p) => p.online);
    if (!state.target && online.length === 1) {
        state.target = online[0].id;
        deviceNames.write('suichuan-target', state.target);
    }
    target.replaceChildren();
    if (online.length) {
        target.add(new Option(t("app.all.online.devices", { p0: online.length }), ALL_ONLINE));
    }
    if (!online.length) {
        target.add(new Option(state.peers.length ? t("app.waiting.for.a.receiving.device") : t("app.connect.another.computer.first"), state.target === ALL_ONLINE ? ALL_ONLINE : ''));
    }
    else {
        if (state.target !== ALL_ONLINE && !online.some((p) => p.id === state.target)) {
            const selected = state.peers.find((peer) => peer.id === state.target);
            const label = !state.target ? t("app.choose.a.receiving.device") : selected ? t("app.offline", { p0: peerLabel(selected) }) : t("app.the.previous.receiver.is.unavailable.choose.another.device");
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
    const send = get<HTMLButtonElement>('[data-action="send"]');
    send.disabled = !connection.ready || !recipients.length || state.sending || (!editor.value.length && !state.files.length);
    const note = get<HTMLElement>('[data-send-note]');
    note.textContent = !connection.ready ? messageText(state.connectionError) : recipients.length && broadcast ? t("app.send.to.all.paired.online.devices") : '';
    note.hidden = shareUI?.mode === 'share' || !note.textContent;
    const limit = get<HTMLElement>('[data-device-file-limit]');
    renderFileLimitNotice(limit, connection.config);
    limit.hidden = shareUI?.mode === 'share';
    for (const connect of all('[data-action="connect"], [data-action="first-connect"]')) {
        if (connect instanceof HTMLButtonElement) {
            connect.disabled = !connection.ready;
        }
    }
    get<HTMLElement>('[data-onboarding]').hidden = shareUI?.mode === 'share' || !connection.ready || state.peers.length > 0;
    root.dataset.connection = connection.ready ? 'ready' : 'connecting';
}
function renderAttachments() {
    const list = get<HTMLElement>('[data-attachments]');
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
        remove.setAttribute('aria-label', t("app.remove", { p0: entry.file.name }));
        row.append(info, remove);
        list.append(row);
    }
    updateSend();
    shareUI?.render();
}
function addFiles(files: File[]) {
    for (const file of files) {
        if (state.files.length >= MAX_FILES_PER_SEND) {
            tell(t("app.file.limit.reached", { count: MAX_FILES_PER_SEND }));
            break;
        }
        const preview = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type);
        state.files.push({ id: crypto.randomUUID(), file, url: preview ? URL.createObjectURL(file) : null, kind: preview ? 'image' : 'file' });
    }
    renderAttachments();
}
function renderTransfers() {
    updateLeaveGuard();
    const list = get<HTMLElement>('[data-transfers]');
    const focused = list.contains(activeElement()) ? activeElement() : null;
    const focusAction = focused?.dataset.action;
    const focusId = focused?.dataset.id;
    list.replaceChildren();
    const activeGroups = new Set(transfers.items.filter((item) => item.groupId && isActive(item)).map((item) => item.groupId));
    const sharing = shareUI?.mode === 'share';
    const shares = shareUI?.entries || [];
    const count = sharing ? shares.length : transfers.items.filter((item) => !item.groupId && !item.shareId).length + transfers.groups.length;
    list.hidden = sharing;
    get<HTMLElement>('[data-share-records]').hidden = !sharing;
    const history = get<HTMLElement>('.qt-transfers');
    const title = t("app.history");
    history.hidden = count === 0;
    history.setAttribute('aria-label', title);
    const heading = get<HTMLElement>('.qt-section-heading h2').firstChild;
    if (heading) {
        heading.textContent = `${title} `;
    }
    get<HTMLElement>('[data-count]').textContent = count ? String(count) : '';
    const canClear = sharing
        ? shares.some((s) => ['completed', 'cancelled', 'expired', 'unavailable', 'stopped'].includes(s.status))
        : transfers.items.some((item) => !item.shareId && !isActive(item) && !activeGroups.has(item.groupId));
    get<HTMLButtonElement>('[data-action="clear"]').hidden = !canClear;
    get<HTMLElement>('.qt-history-footer > span').hidden = sharing;
    get<HTMLElement>('.qt-history-footer').hidden = sharing && get<HTMLButtonElement>('[data-action="clear"]').hidden;
    const shown = new Set<string>();
    for (const item of transfers.items) {
        if (item.shareId) {
            continue;
        }
        if (item.groupId) {
            if (!shown.has(item.groupId)) {
                const group = transfers.groups.find((entry) => entry.id === item.groupId);
                if (group) {
                    list.append(renderGroup(group));
                }
                shown.add(item.groupId);
            }
        }
        else {
            list.append(renderTransfer(item));
        }
    }
    if (focusAction) {
        [...list.querySelectorAll<HTMLButtonElement>('[data-action]')].find((el) => el.dataset.action === focusAction && el.dataset.id === focusId)?.focus({ preventScroll: true });
    }
    if (state.modal === 'devices') {
        renderDevices();
    }
    if (imagePreview.open && !transfers.items.some((item) => item.localId === previewId)) {
        closeImagePreview();
    }
}
function renderTransfer(item: TransferItem) {
    const row = element('article', `qt-transfer-row${item.groupId ? '' : ' qt-transfer-card'}`);
    row.dataset.transfer = item.localId;
    row.dataset.status = item.status;
    row.dataset.incoming = String(item.incoming);
    row.dataset.route = item.route;
    const body = element('div', 'qt-transfer-body');
    const sourceText = item.source?.kind === 'text' ? item.source.text : undefined;
    if (item.kind === 'text' && (item.text !== undefined || sourceText !== undefined)) {
        body.append(element('pre', 'qt-text-content', item.text ?? sourceText));
    }
    else {
        body.append(element('div', 'qt-transfer-title', item.name));
    }
    const status = { queued: t("app.queued"), waiting: t("app.waiting.to.connect"), transferring: `${Math.min(99, Math.floor(item.bytes / Math.max(item.size, 1) * 100))}%`, completed: item.incoming ? t("app.received") : t("app.delivered"), failed: t("app.failed"), cancelled: t("app.cancelled") }[item.status];
    body.append(element('div', `qt-transfer-meta${item.status === 'failed' ? ' qt-error-note' : ''}`, `${item.incoming ? t("app.from") : t("app.to")} ${item.peerName} · ${sizeLabel(item.size)} · ${status}`));
    if (item.reason) {
        body.append(element('div', 'qt-transfer-meta qt-error-note', messageText(item.reason, item.reasonKey, item.reasonParams)));
    }
    if (item.incoming && item.status === 'completed' && item.kind !== 'text') {
        const saved = item.downloadStarted ? t("app.download.started.check.that.the.file.was.saved") : item.imageCopied ? item.mime === 'image/gif' ? t("app.still.image.copied.the.original.animation.has.not") : t("app.image.copied.paste.it.into.another.app") : t("app.not.saved.refreshing.or.closing.this.page.will");
        body.append(element('div', 'qt-transfer-meta', saved));
    }
    if (isActive(item)) {
        const progress = element('progress');
        progress.max = Math.max(item.size, 1);
        progress.value = item.bytes;
        progress.setAttribute('aria-label', t("app.transfer.progress", { p0: item.name }));
        body.append(progress);
    }
    if (item.url && item.status === 'completed') {
        const trigger = element('button', 'qt-image-trigger');
        trigger.type = 'button';
        trigger.dataset.action = 'preview-image';
        trigger.dataset.id = item.localId;
        trigger.setAttribute('aria-label', t("app.preview", { p0: item.name }));
        trigger.setAttribute('aria-haspopup', 'dialog');
        const preview = element('img', 'qt-received-image');
        preview.src = item.url;
        preview.alt = item.name;
        trigger.append(preview);
        body.append(trigger);
    }
    const actions = element('div', 'qt-transfer-actions');
    if (isActive(item)) {
        actions.append(button(t("app.cancel"), 'cancel', item.localId));
    }
    else if (item.status === 'completed' && item.incoming) {
        if (item.url && canCopyImage()) {
            const copy = button(item.copying ? t("app.copying") : t("app.copy.image"), 'copy-image', item.localId);
            copy.disabled = Boolean(item.copying);
            actions.append(copy);
        }
        actions.append(button(item.kind === 'text' ? t("app.copy") : item.downloadStarted ? t("app.save.again") : t("app.save"), item.kind === 'text' ? 'copy-text' : 'save-file', item.localId));
    }
    else if (!item.incoming && item.status !== 'completed') {
        const retry = button(t("app.send.again"), 'retry', item.localId);
        retry.disabled = !connection.ready || !state.peers.some((p) => p.id === item.peerId && p.online);
        actions.append(retry);
    }
    row.append(body);
    if (actions.childElementCount) {
        row.append(actions);
    }
    return row;
}
function renderGroup(group: TransferGroup) {
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
    info.append(element('div', 'qt-group-title', t("app.broadcast.devices", { p0: group.peers.length })));
    const summary = completed === items.length ? t("app.delivered.to.all.devices", { p0: group.peers.length }) : active.length ? t("app.delivered.to.devices", { p0: delivered, p1: group.peers.length, p2: active.length > queued ? t("app.transferring") : t("app.queued") }) : t("app.delivered.to.devices.alt", { p0: delivered, p1: group.peers.length, p2: failed.length ? t("app.some.failed") : t("app.cancelled.alt") });
    const status = element('div', 'qt-transfer-meta', summary);
    status.dataset.groupStatus = '';
    info.append(status);
    const counts = [t("app.items.delivered", { p0: completed, p1: items.length })];
    if (queued) {
        counts.push(t("app.items.queued", { p0: queued }));
    }
    if (failed.length) {
        counts.push(t("app.items.failed", { p0: failed.length }));
    }
    if (cancelled) {
        counts.push(t("app.items.cancelled", { p0: cancelled }));
    }
    info.append(element('div', 'qt-transfer-meta', counts.join(' · ')));
    const expanded = state.expandedGroups.has(group.id);
    const toggle = button(expanded ? t("app.hide.details") : t("app.show.details"), 'toggle-group', group.id);
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.setAttribute('aria-controls', `group-${group.id}`);
    top.append(info, toggle);
    row.append(top);
    const actions = element('div', 'qt-group-actions');
    if (active.length) {
        actions.append(button(t("app.cancel.remaining"), 'cancel-group', group.id));
    }
    if (failed.length) {
        const retry = button(t("app.retry.failed.items"), 'retry-group', group.id);
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
        section.append(element('h3', '', t("app.items.delivered.alt", { p0: peer.name, p1: sent, p2: peerItems.length })));
        for (const item of peerItems) {
            section.append(renderTransfer(item));
        }
        details.append(section);
    }
    row.append(details);
    return row;
}
function openImagePreview(item?: TransferItem) {
    if (!item?.url || item.status !== 'completed') {
        return;
    }
    previewId = item.localId;
    get<HTMLImageElement>('[data-preview-image]').src = item.url;
    get<HTMLImageElement>('[data-preview-image]').alt = item.name;
    get<HTMLElement>('[data-preview-name]').textContent = item.name;
    imagePreview.showModal();
}
function closeImagePreview() {
    if (!imagePreview.open) {
        return;
    }
    imagePreview.close();
    get<HTMLImageElement>('[data-preview-image]').removeAttribute('src');
    get<HTMLImageElement>('[data-preview-image]').alt = '';
    get<HTMLElement>('[data-preview-name]').textContent = '';
    // Transfer updates rebuild the list, so restore focus to the current thumbnail.
    const trigger = all('[data-action="preview-image"]').find((el) => el.dataset.id === previewId);
    (trigger || editor).focus({ preventScroll: true });
    previewId = null;
}
function renderDevices() {
    const list = get<HTMLElement>('[data-devices-list]');
    list.replaceChildren();
    if (!state.peers.length) {
        list.append(element('p', 'qt-empty', t("app.no.paired.devices.yet")));
    }
    for (const peer of state.peers) {
        const row = element('div', 'qt-device-row');
        row.dataset.peer = peer.id;
        const info = element('div', 'qt-device-info');
        const name = element('div', 'qt-device-name');
        const status = !connection.ready ? 'unknown' : peer.online ? 'online' : 'offline';
        const statusLabel = { online: t("app.online"), offline: t("app.offline.alt"), unknown: t("app.updating.status") }[status];
        const dot = element('span', 'qt-device-status');
        dot.dataset.state = status;
        dot.setAttribute('role', 'img');
        dot.setAttribute('aria-label', statusLabel);
        dot.title = statusLabel;
        name.append(dot, element('strong', '', peerLabel(peer)));
        info.append(name);
        const busy = peer.busy > 0 || transfers.items.some((i) => i.peerId === peer.id && isActive(i));
        if (busy) {
            info.append(element('small', '', t("app.you.can.forget.this.device.after.its.transfers")));
        }
        const forget = button(t("app.forget"), 'forget', peer.id);
        forget.disabled = busy || !connection.ready;
        row.append(info, forget);
        list.append(row);
    }
}
function closeDialog() {
    overlay.hidden = true;
    state.modal = '';
    get<HTMLElement>('.qt-header').inert = false;
    get<HTMLElement>('.qt-main').inert = false;
    lastFocus?.focus();
}
function renderApproval() {
    const request = state.requests[0];
    if (request) {
        get<HTMLElement>('[data-request-name]').textContent = request.name;
        get<HTMLElement>('[data-request-id]').textContent = t("app.device.requesting.connection", { p0: request.fingerprint.slice(0, 12) });
    }
    const count = get<HTMLElement>('[data-request-count]');
    count.hidden = state.requests.length < 2;
    count.textContent = t("app.pending.pairing.requests", { count: state.requests.length });
}
function openDialog(type: string) {
    closeImagePreview();
    if (overlay.hidden) {
        lastFocus = activeElement();
    }
    state.modal = type;
    overlay.hidden = false;
    get<HTMLElement>('.qt-header').inert = true;
    get<HTMLElement>('.qt-main').inert = true;
    get<HTMLElement>('[data-dialog-title]').textContent = type === 'devices' ? t("app.my.devices") : type === 'approval' ? t("app.confirm.new.device") : type === 'name' ? t("app.name.this.device") : t("app.connect.device");
    get<HTMLElement>('[data-onboarding-name-panel]').hidden = type !== 'name';
    get<HTMLElement>('[data-pair-panel]').hidden = type !== 'pair';
    get<HTMLElement>('[data-devices-panel]').hidden = type !== 'devices';
    get<HTMLElement>('[data-approval-panel]').hidden = type !== 'approval';
    if (type === 'devices') {
        get<HTMLInputElement>('[data-name-input]').value = connection.device?.name || deviceNames.device();
        renderDevices();
    }
    if (type === 'name') {
        get<HTMLInputElement>('[data-onboarding-name]').value = connection.device?.name || deviceNames.device();
        get<HTMLElement>('[data-name-error]').hidden = true;
    }
    if (type === 'approval') {
        renderApproval();
    }
    get<HTMLButtonElement>('[data-action="close"]').focus();
    if (type === 'name') {
        get<HTMLInputElement>('[data-onboarding-name]').focus();
        get<HTMLInputElement>('[data-onboarding-name]').select();
    }
}
async function openPairing() {
    openDialog('pair');
    pairTab('show');
    if (state.codeUntil <= Date.now()) {
        await newCode();
    }
}
async function saveName(value: string) {
    const name = value.trim();
    if (!validDeviceName(name)) {
        throw new Error(t("app.enter.a.device.name.with.1.24.characters"));
    }
    await connection.rpc('device.rename', { name });
    deviceNames.rememberDevice(name);
    if (connection.device) {
        deviceNames.write('suichuan-name-confirmed', connection.device.id);
    }
}
async function imageAsPng(item: TransferItem): Promise<Blob> {
    if (!item.blob || !item.url) {
        throw new Error(t("app.image.content.is.unavailable"));
    }
    if (item.blob.type === 'image/png') {
        return item.blob;
    }
    const image = new Image();
    image.src = item.url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) {
        throw new Error(t("app.image.conversion.failed"));
    }
    context.drawImage(image, 0, 0);
    return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob) {
                resolve(blob);
            }
            else {
                reject(new Error(t("app.image.conversion.failed")));
            }
        }, 'image/png');
    });
}
async function copyImage(item?: TransferItem) {
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
        tell(item.mime === 'image/gif' ? t("app.still.image.copied.save.the.original.file.to") : t("app.image.copied.paste.it.into.another.app.alt"));
    }
    catch {
        tell(t("app.unable.to.copy.the.image.allow.clipboard.access"));
    }
    finally {
        item.copying = false;
        renderTransfers();
    }
}
function pairTab(tab: string) {
    all('[data-pair-tab]').forEach((el) => el.setAttribute('aria-selected', String(el.dataset.pairTab === tab)));
    get<HTMLElement>('#qt-code-panel').hidden = tab !== 'show';
    get<HTMLElement>('#qt-enter-panel').hidden = tab !== 'enter';
    get<HTMLElement>('#qt-code-error').hidden = true;
    if (tab === 'enter') {
        get<HTMLInputElement>('[data-code-input]').focus();
    }
}
async function newCode() {
    get<HTMLElement>('[data-code]').textContent = t("app.generating");
    const result = await connection.rpc('pair.code');
    state.code = result.code;
    state.codeUntil = result.expires;
    get<HTMLElement>('[data-code]').textContent = `${state.code.slice(0, 4)} ${state.code.slice(4)}`;
    updateCode();
}
function updateCode() {
    const left = Math.max(0, Math.ceil((state.codeUntil - Date.now()) / 1000));
    get<HTMLElement>('[data-code-expiry]').textContent = left ? t("app.expires.in", { p0: Math.floor(left / 60), p1: String(left % 60).padStart(2, '0') }) : t("app.expired.generate.a.new.pairing.code");
    get<HTMLButtonElement>('[data-action="copy-code"]').disabled = left === 0;
}
async function join() {
    const code = get<HTMLInputElement>('[data-code-input]').value.replace(/\D/g, '');
    const error = get<HTMLElement>('#qt-code-error');
    if (code.length !== 8) {
        error.textContent = t("app.enter.the.complete.8.digit.pairing.code");
        error.hidden = false;
        return;
    }
    get<HTMLButtonElement>('[data-join]').disabled = true;
    error.hidden = true;
    try {
        const result = await connection.rpc('pair.join', { code });
        state.joinId = result.id;
        get<HTMLButtonElement>('[data-join]').textContent = t("app.waiting.for.confirmation");
    }
    catch (caught) {
        const err = errorValue(caught);
        error.textContent = err.message;
        error.hidden = false;
        get<HTMLButtonElement>('[data-join]').disabled = false;
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
        tell(t("app.text.is.too.long.send.it.in.parts"));
        return;
    }
    const sources: Source[] = text.length ? [{ kind: 'text', text }] : [];
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
    }
    finally {
        state.sending = false;
        updateSend();
    }
}
async function action(name: string, el: {
    dataset: DOMStringMap;
    disabled?: boolean;
}) {
    const item = transfers.items.find((i) => i.localId === el.dataset.id);
    const group = transfers.groups.find((entry) => entry.id === el.dataset.id);
    switch (name) {
        case 'first-connect':
        case 'connect':
            if (state.requests.length) {
                openDialog('approval');
            }
            else if (deviceNames.needsConfirmation(connection.device?.id, connection.device?.name)) {
                openDialog('name');
            }
            else {
                await openPairing();
            }
            break;
        case 'name-and-connect': {
            const error = get<HTMLElement>('[data-name-error]');
            error.hidden = true;
            el.disabled = true;
            try {
                await saveName(get<HTMLInputElement>('[data-onboarding-name]').value);
                if (state.modal === 'name') {
                    await openPairing();
                }
            }
            catch (caught) {
                const err = errorValue(caught);
                error.textContent = err.message;
                error.hidden = false;
            }
            finally {
                el.disabled = false;
            }
            break;
        }
        case 'devices':
            openDialog('devices');
            break;
        case 'close':
            if (state.joinId) {
                await connection.rpc('pair.cancel', { id: state.joinId });
            }
            closeDialog();
            break;
        case 'pick':
            fileInput.click();
            break;
        case 'send':
            await sendBatch();
            break;
        case 'refresh-code':
            await newCode();
            break;
        case 'copy-code':
            await navigator.clipboard.writeText(state.code);
            tell(t("app.pairing.code.copied"));
            break;
        case 'join':
            await join();
            break;
        case 'allow':
        case 'deny':
            if (state.requests[0]) {
                await connection.rpc('pair.respond', { id: state.requests[0].id, allow: name === 'allow' });
            }
            break;
        case 'rename': {
            await saveName(get<HTMLInputElement>('[data-name-input]').value);
            if (state.modal === 'devices') {
                closeDialog();
            }
            tell(t("app.device.name.updated"));
            break;
        }
        case 'forget':
            if (!el.dataset.id) {
                return;
            }
            await connection.rpc('pair.forget', { peerId: el.dataset.id });
            tell(t("app.device.forgotten"));
            break;
        case 'remove-file': {
            const attachment = state.files.find((f) => f.id === el.dataset.id);
            if (attachment?.url) {
                URL.revokeObjectURL(attachment.url);
            }
            state.files = state.files.filter((f) => f.id !== el.dataset.id);
            renderAttachments();
            break;
        }
        case 'cancel':
            transfers.cancel(item);
            break;
        case 'retry':
            transfers.retry(item);
            break;
        case 'retry-group':
            if (!group) {
                return;
            }
            transfers.retryGroup(group);
            break;
        case 'cancel-group':
            if (!group) {
                return;
            }
            transfers.cancelGroup(group);
            break;
        case 'toggle-group': {
            if (!group) {
                return;
            }
            if (state.expandedGroups.has(group.id)) {
                state.expandedGroups.delete(group.id);
            }
            else {
                state.expandedGroups.add(group.id);
            }
            renderTransfers();
            break;
        }
        case 'copy-text':
            if (item?.text === undefined) {
                return;
            }
            await navigator.clipboard.writeText(item.text);
            tell(t("app.text.copied"));
            break;
        case 'copy-image':
            await copyImage(item);
            break;
        case 'preview-image':
            openImagePreview(item);
            break;
        case 'close-image':
            closeImagePreview();
            break;
        case 'save-file': {
            if (!item?.blob) {
                return;
            }
            const url = URL.createObjectURL(item.blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = item.name.replace(/[\\/\u0000-\u001f]/g, '_') || t("app.xcopy.file");
            link.click();
            item.downloadStarted = true;
            renderTransfers();
            tell(t("app.download.started.check.your.browser.s.download.list"));
            setTimeout(() => URL.revokeObjectURL(url), 30000);
            break;
        }
        case 'clear':
            if (shareUI?.mode === 'share') {
                transfers.clear((item) => Boolean(item.shareId));
                shareUI.clear();
            }
            else {
                if (transfers.items.some(needsSaving) && !window.confirm(t("app.some.files.are.not.saved.clearing.will.discard"))) {
                    break;
                }
                transfers.clear((item) => !item.shareId);
                state.expandedGroups = new Set([...state.expandedGroups].filter((id) => transfers.groups.some((entry) => entry.id === id)));
            }
            renderTransfers();
            break;
    }
}
root.addEventListener('click', (event) => {
    const tab = (event.target instanceof Element ? event.target.closest<HTMLElement>('[data-pair-tab]') : null);
    if (tab) {
        pairTab(tab.dataset.pairTab || 'show');
        return;
    }
    const el = (event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-action]') : null);
    if (el && el.dataset.action && !el.disabled) {
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
        get<HTMLButtonElement>('[data-action="close-image"]').focus();
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
get<HTMLInputElement>('[data-code-input]').addEventListener('input', (event) => {
    const digits = get<HTMLInputElement>('[data-code-input]').value.replace(/\D/g, '').slice(0, 8);
    get<HTMLInputElement>('[data-code-input]').value = digits.length > 4 ? `${digits.slice(0, 4)} ${digits.slice(4)}` : digits;
});
get<HTMLInputElement>('[data-code-input]').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !get<HTMLButtonElement>('[data-join]').disabled) {
        join().catch((error) => tell(error.message));
    }
});
get<HTMLInputElement>('[data-onboarding-name]').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        get<HTMLButtonElement>('[data-action="name-and-connect"]').click();
    }
});
document.addEventListener('keydown', (event) => {
    if (overlay.hidden) {
        return;
    }
    if (event.key === 'Escape') {
        action('close', get<HTMLButtonElement>('[data-action="close"]')).catch((error) => tell(error.message));
    }
    if (event.key === 'Tab') {
        const focusable = [...overlay.querySelectorAll<HTMLElement>('button, input, a')].filter((el) => !('disabled' in el && el.disabled) && el.getClientRects().length);
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && activeElement() === first) {
            event.preventDefault();
            last?.focus();
        }
        else if (!event.shiftKey && activeElement() === last) {
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
fileInput.addEventListener('change', () => { addFiles([...(fileInput.files || [])]); fileInput.value = ''; });
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
const composer = get<HTMLElement>('.qt-composer');
composer.addEventListener('dragover', (event) => { event.preventDefault(); composer.classList.add('is-dragging'); });
composer.addEventListener('dragleave', () => composer.classList.remove('is-dragging'));
composer.addEventListener('drop', (event) => { event.preventDefault(); composer.classList.remove('is-dragging'); addFiles([...(event.dataTransfer?.files || [])]); });
document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('drop', (event) => event.preventDefault());
connection.addEventListener('ready', (e) => {
    state.connectionError = '';
    state.peers = e.detail.peers;
    get<HTMLElement>('[data-local-name]').textContent = e.detail.device.name;
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
    get<HTMLElement>('[data-local-name]').textContent = e.detail.name;
    renderTarget();
    renderReception(e.detail.reception);
    renderTransfers();
});
connection.addEventListener('disconnected', () => {
    state.connectionError = t("app.connection.lost.reconnecting.automatically");
    state.requests = [];
    state.joinId = null;
    state.codeUntil = 0;
    get<HTMLButtonElement>('[data-join]').disabled = false;
    get<HTMLButtonElement>('[data-join]').textContent = t("app.connect");
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
transfers.addEventListener('notice', (e) => {
    if (e instanceof CustomEvent && typeof e.detail?.message === 'string') {
        tell(e.detail.message);
    }
});
transfers.addEventListener('change', renderTransfers);
connection.addEventListener('pair.request', (e) => {
    state.requests.push(e.detail);
    if (state.modal === 'approval') {
        renderApproval();
    }
    else {
        openDialog('approval');
    }
});
connection.addEventListener('pair.result', (e) => {
    const shownRequest = state.requests[0]?.id === e.detail.id;
    state.requests = state.requests.filter((r) => r.id !== e.detail.id);
    if (state.joinId === e.detail.id || shownRequest) {
        state.joinId = null;
        get<HTMLButtonElement>('[data-join]').disabled = false;
        get<HTMLButtonElement>('[data-join]').textContent = t("app.connect");
        tell({ paired: t("app.connected.ready.to.transfer"), denied: t("app.the.other.device.declined.the.connection"), expired: t("app.pairing.request.expired.please.try.again"), cancelled: t("app.pairing.request.cancelled") }[e.detail.status]);
        if (state.requests.length) {
            openDialog('approval');
        }
        else {
            closeDialog();
        }
    }
    else if (state.modal === 'approval') {
        renderApproval();
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

onLocaleChange(() => { renderTarget(); renderAttachments(); renderTransfers(); renderDevices(); renderReception(lastReception); updateCode(); shareUI?.render(); refreshMessages();
    const type = state.modal;
    if (type === 'approval') {
        renderApproval();
    }
    get<HTMLElement>('[data-dialog-title]').textContent = type === 'devices' ? t("app.my.devices") : type === 'approval' ? t("app.confirm.new.device") : type === 'name' ? t("app.name.this.device") : t("app.connect.device"); });

function refreshMessages() {
  for (const element of document.querySelectorAll<HTMLElement>('.qt-toast, .qt-input-error, .share-feedback')) {
    if (element.textContent) {
      element.textContent = messageText(element.textContent);
    }
  }
}

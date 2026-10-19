import { messageText } from './i18n/errors.js';
import { initI18n, onLocaleChange } from './i18n/index.js';
await initI18n();
import { t } from './i18n/index.js';
import type { ShareSnapshot } from './types/share.js';
import type { TransferItem } from './types/transfer.js';
import { query, activeElement } from './dom.js';
import { errorValue } from './dom.js';
import { Connection } from './connection.js';
import { Transfers } from './transfer.js';
import { el, action, fileList, sizeLabel, progressNode, saveBlob } from './share-ui.js';
import { archive } from './archive.js';
import { deviceNames } from './device-name.js';
const connection = new Connection({ guest: true });
const transfers = new Transfers(connection);
const root = query<HTMLElement>(document, '[data-receive]');
const token = location.hash.slice(1);
let share: ShareSnapshot | undefined;
let error = '';
let busy = false;
let archiveBusy = false;
let editingName = false;
let nameDraft = '';
let nameError = '';
let toastTimer: ReturnType<typeof setTimeout>;
const saved = new Set<number>();
function tell(message: string) {
    const toast = query(document, '.qt-toast');
    clearTimeout(toastTimer);
    toast.textContent = messageText(message);
    toast.hidden = false;
    toastTimer = setTimeout(() => { toast.hidden = true; }, 5000);
}
function latest() {
    const byIndex = new Map<number, TransferItem>();
    for (const item of transfers.items) {
        if (share && item.shareId === share.id && (!share.myClaim || item.claimId === share.myClaim.id) && !byIndex.has(item.shareIndex)) {
            byIndex.set(item.shareIndex, item);
        }
    }
    return byIndex;
}
async function rpc(type: 'share.claim' | 'share.retry' | 'share.claim.cancel') {
    if (busy) {
        return;
    }
    busy = true;
    error = '';
    render();
    try {
        if (type === 'share.claim') {
            share = await connection.rpc(type, { token, name: deviceNames.guest() });
        }
        else if (share) {
            share = await connection.rpc(type, { id: share.id, claimId: share.myClaim?.id });
        }
    }
    catch (caught) {
        const err = errorValue(caught);
        error = err.message;
        // claim 的响应丢失时，inspect 可重新确认同一会话的归属，不会重复领取。
        try {
            share = await connection.rpc('share.inspect', { token });
        }
        catch { /* 保留原错误，恢复连接后再查询。 */ }
    }
    finally {
        busy = false;
        render();
    }
}
function nameControl() {
    const row = el('div', 'share-device-name');
    if (!editingName) {
        const name = el('span', '', t("share.your.device", { p0: deviceNames.guest() }));
        name.dataset.recipientName = '';
        const edit = action(t("share.edit"), () => {
            editingName = true;
            nameDraft = deviceNames.guest();
            nameError = '';
            render();
            root.querySelector<HTMLElement>('[data-recipient-name-input]')?.focus();
        });
        edit.disabled = busy;
        edit.dataset.control = 'edit-name';
        edit.setAttribute('aria-label', t("share.edit.receiving.device.name"));
        row.append(name, edit);
        return row;
    }
    const form = el('form', 'share-name-form');
    const label = el('label', '', t("share.your.device.name"));
    label.htmlFor = 'share-recipient-name';
    const input = el('input', 'share-url');
    input.id = label.htmlFor;
    input.value = nameDraft;
    input.maxLength = 24;
    input.autocomplete = 'off';
    input.dataset.recipientNameInput = '';
    input.dataset.control = 'name-input';
    input.setAttribute('aria-invalid', String(Boolean(nameError)));
    input.setAttribute('aria-describedby', 'share-name-feedback');
    input.addEventListener('input', () => { nameDraft = input.value; });
    const cancel = () => { editingName = false; nameError = ''; render(); root.querySelector<HTMLElement>('[data-control="edit-name"]')?.focus(); };
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            cancel();
        }
    });
    const controls = el('div', 'share-actions');
    const save = action(t("share.save.name"), () => form.requestSubmit());
    save.dataset.control = 'save-name';
    const discard = action(t("app.cancel"), cancel);
    discard.dataset.control = 'cancel-name';
    controls.append(save, discard);
    const feedback = el('p', nameError ? 'share-feedback' : 'share-muted share-small', nameError || t("share.1.24.characters.the.sender.can.see.this"));
    feedback.id = 'share-name-feedback';
    if (nameError) {
        feedback.setAttribute('role', 'alert');
    }
    form.append(label, input, feedback, controls);
    form.addEventListener('submit', (event) => {
        event.preventDefault();
        try {
            deviceNames.renameGuest(nameDraft);
            editingName = false;
            nameError = '';
            render();
            root.querySelector<HTMLElement>('[data-control="edit-name"]')?.focus();
        }
        catch (caught) {
            const err = errorValue(caught);
            nameError = err.message;
            render();
            root.querySelector<HTMLElement>('[data-recipient-name-input]')?.focus();
        }
    });
    row.append(form);
    return row;
}
function render() {
    const focused = root.contains(activeElement()) ? activeElement()?.dataset.control : null;
    const focusedInput = activeElement();
    const selection: [
        number | null,
        number | null
    ] | null = focused === 'name-input' && focusedInput instanceof HTMLInputElement ? [focusedInput.selectionStart, focusedInput.selectionEnd] : null;
    const filesOpen = root.querySelector<HTMLDetailsElement>('details')?.open || false;
    root.replaceChildren();
    if (!share) {
        root.append(el('h1', '', error ? t("share.unable.to.open.share") : t("share.opening.share")), el('p', 'share-description', messageText(error) || t("share.connecting.to.the.service")));
        return;
    }
    const current = share;
    const items = latest();
    const mine = current.myClaim;
    const multiple = current.mode === 'multiple';
    const complete = current.mine && (mine?.state === 'completed' || current.status === 'completed') && current.files.every((f) => items.get(f.index)?.verified);
    const failed = [...items.values()].some((i) => ['failed', 'cancelled'].includes(i.status));
    const occupied = !multiple && current.status === 'claimed' && !current.mine;
    const closed = mine ? ['cancelled', 'expired', 'unavailable'].includes(mine.state) : ['cancelled', 'expired', 'unavailable', 'stopped', 'draining'].includes(current.status) || current.status === 'completed';
    let title = t("share.someone.shared.files.with.you");
    let description = t("share.from.files", { p0: current.senderName, p1: current.files.length, p2: sizeLabel(current.totalBytes) });
    if (complete) {
        title = t("share.all.files.received");
        description = multiple ? t("share.all.files.in.this.claim.are.verified.save") : t("share.all.files.are.verified.and.the.link.has");
    }
    else if (closed || occupied) {
        title = mine && multiple ? ({ queued: t("share.waiting.to.send"), transferring: t("share.receiving.files"), retryable: t("share-ui.awaiting.retry.alt"), completed: t("share.all.files.received"), cancelled: t("share.this.claim.was.cancelled"), expired: t("share.this.claim.timed.out"), unavailable: t("share.this.claim.is.unavailable") })[mine.state] : ({ ready: t("share.someone.shared.files.with.you"), cancelled: t("share.share.was.cancelled"), expired: t("share.this.share.has.expired"), unavailable: t("share-ui.share.unavailable"), completed: t("share.this.share.was.already.claimed"), claimed: t("share.another.recipient.is.receiving.the.files"), stopped: t("share.this.share.is.closed.to.new.claims"), draining: t("share.this.share.is.closed.to.new.claims") })[current.status];
        description = t("share.need.these.files.ask.the.sender.to.share");
    }
    else if (!connection.ready || !current.senderOnline) {
        title = !connection.ready ? t("share.restoring.connection") : t("share.waiting.for.the.sender.to.reconnect");
    }
    else if (current.mine) {
        title = mine?.state === 'queued' ? t("share.waiting.to.send") : failed || mine?.state === 'retryable' ? t("share.connection.interrupted.you.can.retry") : t("share.receiving.files");
        description = mine?.state === 'queued' ? t("share.queued.with.claims.ahead.keep.this.page.open", { p0: Math.max(0, mine.position - 1) }) : multiple && !current.accepting ? t("share.new.claims.have.stopped.your.claim.continues.keep") : t("share.this.claim.is.reserved.for.this.tab.keep");
    }
    root.append(el('h1', '', title), el('p', 'share-description', description));
    const panel = el('section', 'share-panel');
    panel.setAttribute('aria-label', t("share.shared.file"));
    if (current.mine && current.recipientName) {
        const recipient = el('p', 'share-recipient', t("share-ui.receiving.device", { p0: current.recipientName }));
        recipient.dataset.recipientName = '';
        panel.append(recipient);
    }
    const list = fileList(current.files, (file) => {
        const item = items.get(file.index);
        if (current.mine && item?.verified && item.blob) {
            const receivedBlob = item.blob;
            const button = action(saved.has(file.index) ? t("app.save.again") : t("app.save"), () => {
                saveBlob(receivedBlob, file.name);
                saved.add(file.index);
                render();
                tell(t("share.download.started.check.your.browser.s.download.list"));
            });
            button.dataset.control = `save-${file.index}`;
            button.dataset.saveIndex = String(file.index);
            return button;
        }
        return el('span', 'share-muted share-small', item?.status === 'transferring' ? `${Math.floor(item.bytes / Math.max(item.size, 1) * 100)}%` : item?.status === 'failed' ? t("share-ui.awaiting.retry.alt") : '');
    });
    if (!current.mine && current.files.length > 3) {
        const details = el('details', 'share-file-details');
        details.open = filesOpen;
        details.append(el('summary', '', t("share-ui.view.list.of.files", { p0: current.files.length })), list);
        panel.append(details);
    }
    else {
        panel.append(list);
    }
    if (complete) {
        if (current.files.length > 1) {
            const all = action(archiveBusy ? t("share.creating.zip") : t("share.save.all.as.zip.zip"), async () => {
                archiveBusy = true;
                render();
                try {
                    const blob = await archive(current.files.map((f) => {
                        const blob = items.get(f.index)?.blob;
                        if (!blob) {
                            throw new Error(t("share.file.content.is.unavailable"));
                        }
                        return { name: f.name, blob };
                    }));
                    saveBlob(blob, t("share.xcopy.files.zip"));
                    current.files.forEach((f) => saved.add(f.index));
                    tell(t("share.zip.download.started.check.your.browser.s.download"));
                }
                catch {
                    tell(t("share.unable.to.create.zip.save.files.individually"));
                }
                finally {
                    archiveBusy = false;
                    render();
                }
            }, true);
            all.disabled = archiveBusy;
            all.dataset.control = 'archive';
            all.dataset.saveAll = '';
            all.classList.add('share-main-action');
            panel.prepend(all);
        }
        panel.append(el('p', 'share-message', t("share.you.can.save.again.from.this.page.refreshing")));
    }
    else if (current.mine && !closed) {
        panel.append(progressNode([...items.values()], current.totalBytes, current.files.filter((f) => f.completed).length, current.files.length));
        const reasons = [...new Set([...items.values()].filter((item) => item.status === 'failed' && item.reason).map((item) => item.reason))];
        if (!reasons.length && mine?.reason) {
            reasons.push(mine.reason);
        }
        for (const reason of reasons) {
            const feedback = el('p', 'share-feedback', messageText(reason));
            feedback.setAttribute('role', 'alert');
            panel.append(feedback);
        }
        const retry = action(busy ? t("share.reconnecting") : t("share.retry.unfinished.files"), () => rpc('share.retry'));
        retry.hidden = mine?.state === 'queued';
        retry.disabled = busy || !connection.ready || !current.senderOnline;
        retry.dataset.control = 'retry';
        // 同时保留手动重试入口，覆盖领取回执/发送通知丢失的场景。
        panel.append(retry);
        if (multiple) {
            const cancel = action(t("share.cancel.this.claim"), () => {
                if (window.confirm(t("share.cancel.unfinished.files.in.this.claim.received.files"))) {
                    rpc('share.claim.cancel');
                }
            });
            cancel.dataset.control = 'cancel-claim';
            cancel.disabled = busy || !connection.ready;
            panel.append(cancel);
        }
    }
    else if (!closed && !occupied) {
        const detail = el('div', 'share-detail');
        const online = el('span', 'qt-connection');
        online.append(el('span', `qt-status-dot${current.senderOnline ? ' is-connected' : ''}`), el('span', '', current.senderOnline ? t("app.online") : t("share.reconnecting.alt")));
        detail.append(el('span', '', t("share.sending.device")), online);
        panel.append(detail, el('p', 'share-muted share-small', multiple ? t("share.unlimited.recipients.until.expiry.claims.queue.automatically.when") : t("share.one.recipient.for.the.entire.bundle.the.link")), nameControl());
        const claim = action(busy ? t("share.claiming") : t("share.receive.all.files", { p0: current.files.length }), () => rpc('share.claim'), true);
        claim.disabled = busy || editingName || !connection.ready || !current.senderOnline;
        claim.dataset.control = 'claim';
        claim.dataset.claim = '';
        claim.classList.add('share-main-action');
        panel.append(claim);
    }
    if (error) {
        const feedback = el('p', 'share-feedback', messageText(error));
        feedback.setAttribute('role', 'alert');
        panel.append(feedback);
    }
    root.append(panel, el('p', 'share-message', t("share.no.sign.in.or.pairing.files.come.directly")));
    if (focused) {
        [...root.querySelectorAll<HTMLElement>('[data-control]')].find((n) => n.dataset.control === focused)?.focus({ preventScroll: true });
        const input = activeElement();
        if (selection && input instanceof HTMLInputElement && input.dataset.control === 'name-input') {
            input.setSelectionRange(...selection);
        }
    }
}
connection.addEventListener('ready', async () => {
    try {
        share = await connection.rpc('share.inspect', { token });
        error = '';
    }
    catch (caught) {
        const err = errorValue(caught);
        error = err.message;
    }
    render();
});
connection.addEventListener('share.state', (e) => { share = e.detail; render(); });
connection.addEventListener('disconnected', render);
connection.addEventListener('notice', (e) => { error = e.detail.message; render(); });
transfers.addEventListener('change', render);
transfers.addEventListener('notice', (e) => {
    if (e instanceof CustomEvent && typeof e.detail?.message === 'string') {
        tell(e.detail.message);
    }
});
function needsLeaveWarning() {
    return share?.mine && ((share.myClaim && !['completed', 'cancelled', 'expired', 'unavailable'].includes(share.myClaim.state)) || [...latest().values()].some((i) => i.verified && !saved.has(i.shareIndex)));
}
function beforeLeave(event: BeforeUnloadEvent) {
    if (needsLeaveWarning()) {
        event.preventDefault();
        event.returnValue = '';
    }
}
window.addEventListener('beforeunload', beforeLeave);
window.addEventListener('hashchange', () => {
    if (location.hash.slice(1) === token) {
        return;
    }
    if (needsLeaveWarning() && !window.confirm(t("share.opening.a.new.share.will.discard.unsaved.files"))) {
        history.replaceState(null, '', `#${token}`);
        return;
    }
    window.removeEventListener('beforeunload', beforeLeave);
    location.reload();
});
if (/^[\w-]{43}$/.test(token)) {
    connection.start();
}
else {
    error = t("share.incomplete.link.use.the.full.link.or.qr");
    render();
}

onLocaleChange(() => { render(); refreshMessages(); });

function refreshMessages() {
  for (const element of document.querySelectorAll<HTMLElement>('.qt-toast, .qt-input-error, .share-feedback')) {
    if (element.textContent) {
      element.textContent = messageText(element.textContent);
    }
  }
}

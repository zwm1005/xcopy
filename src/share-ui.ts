import type { ClientLimits } from './types/device.js';
import { messageText } from './i18n/errors.js';
import { t } from './i18n/index.js';
import type { Claim, ShareSnapshot, ShareEntry, ShareComposerOptions, ShareMode } from './types/share.js';
import type { TransferItem } from './types/transfer.js';
import { query, activeElement } from './dom.js';
import { errorValue } from './dom.js';
const terminal = new Set(['completed', 'cancelled', 'expired', 'unavailable', 'stopped']);
import { sizeLabel } from './i18n/format.js';
export { sizeLabel };
export const fileLimitLabel = (config?: ClientLimits | null) => t("share-ui.up.to.8.files.no.p2p.size.limit", { p0: sizeLabel(config?.maxRelayFileBytes || config?.maxFileBytes || 50 * 1048576) });
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) {
        node.textContent = text;
    }
    return node;
}
export function action(label: string, handler: () => void, primary = false) {
    const node = el('button', `qt-button ${primary ? 'qt-primary' : 'qt-outline'}`, label);
    node.type = 'button';
    node.addEventListener('click', handler);
    return node;
}
export function fileList<T extends {
    name: string;
    size: number;
}>(files: T[], renderAction?: ((file: T, index: number) => Node | null) | null) {
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
export function statusLabel(s: ShareSnapshot) {
    if (s.mode === 'multiple' && !terminal.has(s.status)) {
        return s.accepting ? t("share-ui.open.for.claims") : t("share-ui.new.claims.stopped");
    }
    return { draining: t("share-ui.new.claims.stopped"), ready: t("share-ui.waiting.for.a.recipient"), claimed: t("share-ui.being.claimed"), completed: t("share-ui.all.claimed"), cancelled: t("app.cancelled"), expired: t("share-ui.expired"), unavailable: t("share-ui.share.unavailable"), stopped: t("share-ui.share.ended") }[s.status] || t("share-ui.connecting");
}
export function progressNode(items: TransferItem[], totalBytes: number, completed: number, count: number) {
    const bytes = items.reduce((sum, item) => sum + item.bytes, 0);
    const box = el('div', 'share-progress');
    const meter = el('progress');
    meter.max = Math.max(totalBytes, 1);
    meter.value = totalBytes ? Math.min(bytes, totalBytes) : completed === count ? 1 : 0;
    meter.setAttribute('aria-label', t("share-ui.overall.file.reception.progress"));
    box.append(meter, el('p', 'share-muted share-small', t("share-ui.verified.files", { p0: completed, p1: count, p2: sizeLabel(Math.min(bytes, totalBytes)), p3: sizeLabel(totalBytes) })));
    return box;
}
export function saveBlob(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name.replace(/[\\/\u0000-\u001f]/g, '_') || t("app.xcopy.file");
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export class ShareComposer {
    root: HTMLElement;
    connection: ShareComposerOptions['connection'];
    transfers: ShareComposerOptions['transfers'];
    files: ShareComposerOptions['files'];
    pick: ShareComposerOptions['pick'];
    remove: ShareComposerOptions['remove'];
    consumeFiles: ShareComposerOptions['consumeFiles'];
    tell: ShareComposerOptions['tell'];
    changed: ShareComposerOptions['changed'];
    entries: ShareEntry[] = [];
    expandedRecords = new Set<string>();
    selected: string | null = null;
    mode = 'device';
    minutes = 10;
    shareMode: ShareMode = 'single';
    retryClaims = new Set<string>();
    busy = false;
    panel: HTMLElement;
    records: HTMLElement;
    clock: ReturnType<typeof setInterval>;
    pendingCreate: {
        id: string;
        sources: File[];
        fileIds: string[];
    } | null = null;
    constructor({ root, connection, transfers, files, pick, remove, consumeFiles, addFiles, tell, changed }: ShareComposerOptions) {
        this.root = root;
        this.connection = connection;
        this.transfers = transfers;
        this.files = files;
        this.pick = pick;
        this.remove = remove;
        this.consumeFiles = consumeFiles;
        this.tell = tell;
        this.changed = changed;
        this.entries = [];
        this.expandedRecords = new Set();
        this.selected = null;
        this.mode = 'device';
        this.minutes = 10;
        this.shareMode = 'single';
        this.retryClaims = new Set();
        this.busy = false;
        this.panel = query(root, '[data-share-panel]');
        this.records = query(root, '[data-share-records]');
        root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => button.addEventListener('click', () => this.setMode(button.dataset.mode || 'device')));
        this.panel.addEventListener('dragover', (e) => e.preventDefault());
        this.panel.addEventListener('drop', (e) => {
            e.preventDefault();
            if (!this.current()) {
                addFiles([...(e.dataTransfer?.files || [])]);
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
            }
            catch (caught) {
                const error = errorValue(caught);
                this.tell(error.message);
            }
            this.render();
        });
        connection.addEventListener('disconnected', () => this.render());
        transfers.addEventListener('change', () => this.render());
        this.clock = setInterval(() => {
            for (const node of this.panel.querySelectorAll<HTMLElement>('[data-share-expiry]')) {
                node.textContent = this.remaining(Number(node.dataset.shareExpiry));
            }
        }, 1000);
        window.addEventListener('beforeunload', (event) => {
            if (this.active()) {
                event.preventDefault();
                event.returnValue = '';
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
    remaining(expires: number) { return t("share-ui.minutes.left", { p0: Math.max(0, Math.ceil((expires - Date.now()) / 60000)), p1: this.current()?.mode === 'multiple' ? t("share-ui.unlimited.recipients") : t("share-ui.one.recipient.for.this.entire.bundle") }); }
    setMode(mode: string) {
        this.mode = mode;
        this.root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === mode)));
        query(this.root, '.qt-composer').hidden = mode === 'share';
        this.panel.hidden = mode !== 'share';
        this.changed();
        this.render();
    }
    apply(value: ShareSnapshot) {
        let entry = this.entries.find((s) => s.id === value.id);
        if (!entry && this.pendingCreate && this.pendingCreate.id === value.requestId) {
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
                }
                else if (claim.state === 'transferring' && !terminal.has(entry.status)) {
                    this.start(entry.id, claim.id);
                }
            }
            if (terminal.has(entry.status)) {
                for (const item of this.transfers.items.filter((i) => i.shareId === entry.id)) {
                    item.shareOpen = false;
                    if (entry.status === 'completed') {
                        this.transfers.finishLocal(item, 'completed');
                    }
                    else {
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
    releaseClaim(id: string, claim: Claim) {
        const items = this.transfers.items.filter((item) => item.shareId === id && item.claimId === claim.id);
        for (const item of items) {
            if (!['completed', 'failed', 'cancelled'].includes(item.status)) {
                this.transfers.finishLocal(item, claim.state === 'completed' ? 'completed' : 'cancelled', claim.reason);
            }
            this.transfers.byId.delete(item.id || '');
            this.transfers.running.delete(item);
            item.source = null;
            item.blob = null;
        }
        this.transfers.items = this.transfers.items.filter((item) => !items.includes(item));
        this.transfers.queue = this.transfers.queue.filter((item) => !items.includes(item));
        this.retryClaims.delete(claim.id);
    }
    start(id: string, claimId: string) {
        const entry = this.entries.find((s) => s.id === id);
        const claim = entry?.claims?.find((c) => c.id === claimId);
        if (!entry || !claim || claim.state !== 'transferring' || terminal.has(entry.status)) {
            return;
        }
        const items = this.transfers.items.filter((i) => i.shareId === id && i.claimId === claimId);
        if (!items.length) {
            this.transfers.sendShare(entry, entry.sources, claim).forEach((item) => { item.shareAttempt = claim.attempt || 0; });
        }
        else if (this.retryClaims.has(claimId) || items.some((item) => (item.shareAttempt || 0) < claim.attempt)) {
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
    retry(id: string, claimId: string) {
        this.retryClaims.add(claimId);
        // 等待随后发布的新快照，排队者获得位置后才重建文件任务。
    }
    claimSummary(s: ShareSnapshot) {
        const n = s.counts || { completed: 0, active: 0, queued: 0, retryable: 0, failed: 0 };
        return t("share-ui.completed.transferring.queued", { p0: n.completed || 0, p1: n.active || 0, p2: n.queued || 0, p3: n.retryable ? t("share-ui.awaiting.retry", { p0: n.retryable }) : '', p4: n.failed ? t("share-ui.unfinished", { p0: n.failed }) : '' });
    }
    claimDetails(s: ShareSnapshot) {
        const list = el('div', 'share-claims');
        for (const claim of [...(s.claims || [])].reverse()) {
            const row = el('div', 'share-claim');
            row.dataset.claimRecord = claim.id;
            row.dataset.claimState = claim.state;
            const items = this.transfers.items.filter((item) => item.claimId === claim.id);
            const count = claim.files.filter((file) => file.completed).length;
            const state = { queued: t("share-ui.queued.claims.ahead", { p0: Math.max(0, claim.position - 1) }), transferring: t("app.transferring"), retryable: t("share-ui.awaiting.retry.alt"), completed: t("share-ui.completed"), cancelled: t("app.cancelled"), expired: t("share-ui.timed.out"), unavailable: t("share-ui.offline") }[claim.state];
            const info = el('div');
            info.append(el('p', 'share-claim-name', claim.recipientName), el('p', 'share-muted share-small', t("share-ui.files.verified", { p0: state, p1: count, p2: claim.files.length })));
            if (claim.reason) {
                info.append(el('p', 'share-muted share-small', messageText(claim.reason, claim.reasonKey, claim.reasonParams)));
            }
            row.append(info);
            if (claim.state === 'transferring' && items.length) {
                row.append(progressNode(items, s.totalBytes, count, claim.files.length));
            }
            list.append(row);
        }
        if (!s.claims?.length) {
            list.append(el('p', 'share-muted share-small', t("share-ui.no.recipients.yet")));
        }
        list.append(el('p', 'share-muted share-small', t("share-ui.current.claims.and.the.last.50.finished.records")));
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
        }
        catch (caught) {
            const error = errorValue(caught);
            try {
                const result = await this.connection.rpc('share.list');
                result.shares.forEach((s) => this.apply(s));
            }
            catch { /* 断线后由 ready 恢复同一页面的创建结果。 */ }
            if (this.pendingCreate) {
                this.tell(error.message);
            }
        }
        finally {
            this.busy = false;
            this.render();
            this.changed();
        }
    }
    render() {
        const selected = this.current();
        const focus = activeElement();
        const filesOpen = this.panel.querySelector<HTMLDetailsElement>('.share-file-details')?.open || false;
        const settingsOpen = this.panel.querySelector<HTMLDetailsElement>('[data-share-settings]')?.open || false;
        const actionsOpen = this.panel.querySelector<HTMLDetailsElement>('.share-more-actions')?.open || false;
        const focusKey = this.panel.contains(focus) || this.records.contains(focus) ? focus?.dataset.shareControl : null;
        this.panel.classList.toggle('share-panel-ended', Boolean(selected && terminal.has(selected.status)));
        this.panel.classList.toggle('share-panel-draft', !selected);
        this.panel.replaceChildren();
        if (!selected) {
            const files = this.files();
            const upload = el('div', 'share-upload');
            upload.append(el('p', 'share-drop', t("share-ui.drop.files.here.or.use.the.attachment.button")));
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
                    remove.setAttribute('aria-label', t("app.remove", { p0: entry.file.name }));
                    remove.disabled = this.busy;
                    remove.dataset.shareControl = `remove-${entry.id}`;
                    row.append(info, remove);
                    attachments.append(row);
                }
                upload.append(attachments);
            }
            const pick = action('', this.pick);
            pick.className = 'qt-button qt-icon qt-quiet cursor-interaction';
            pick.setAttribute('aria-label', t("share-ui.add.attachments"));
            pick.dataset.tooltip = t("share-ui.add.attachments");
            pick.append(query(this.root, '[data-action="pick"] svg').cloneNode(true));
            pick.disabled = this.busy;
            pick.dataset.shareControl = 'pick-files';
            const footer = el('div', 'qt-compose-footer');
            const tools = el('div', 'qt-compose-tools');
            tools.append(pick);
            const total = files.reduce((sum, f) => sum + f.file.size, 0);
            if (files.length) {
                tools.append(el('span', 'share-muted share-small', t("share-ui.files", { p0: files.length, p1: sizeLabel(total) })));
            }
            const generate = action(this.busy ? t("share-ui.creating") : t("share-ui.create.share"), () => this.create(), true);
            generate.classList.add('qt-send', 'share-create');
            generate.disabled = this.busy || !this.connection.ready || !files.length || this.active();
            generate.dataset.shareControl = 'generate';
            generate.dataset.shareGenerate = '';
            footer.append(tools, generate);
            upload.append(footer);
            this.panel.append(upload, el('p', 'share-limit', fileLimitLabel(this.connection.config)));
            const description = el('p', 'share-mode-description', this.shareMode === 'multiple' ? t("share-ui.multiple.recipients.enabled.anyone.with.the.link.can") : t("share-ui.one.recipient.by.default.the.link.expires.after"));
            description.dataset.shareDescription = '';
            this.panel.append(description);
            const settings = el('details', 'share-settings');
            settings.dataset.shareSettings = '';
            settings.open = settingsOpen;
            const summary = el('summary', '', t("share-ui.more.settings"));
            summary.dataset.shareControl = 'settings';
            settings.append(summary);
            const modes = el('fieldset', 'share-mode-field');
            modes.append(el('legend', '', t("share-ui.recipient.mode")));
            const choices = el('div', 'share-mode-options');
            for (const [mode, label] of [['single', t("share-ui.one.recipient")], ['multiple', t("share-ui.multiple.recipients")]] as const) {
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
            const help = el('p', 'share-limit', this.shareMode === 'multiple' ? t("share-ui.share.with.several.people.claims.stay.open.until") : t("share-ui.share.with.one.person.the.link.expires.after"));
            help.id = 'share-mode-help';
            modes.append(choices, help);
            const expiryRow = el('div', 'share-expiry-row');
            const expiryLabel = el('label', '', t("share-ui.link.lifetime"));
            expiryLabel.htmlFor = 'share-expiry';
            const expiry = el('select');
            expiry.id = 'share-expiry';
            expiry.dataset.shareControl = 'expiry';
            expiry.disabled = this.busy;
            [10, 30, 60].forEach((n) => {
                expiry.add(new Option(n === 60 ? t("share-ui.1.hour") : t("share-ui.minutes", { p0: n }), String(n)));
            });
            expiry.value = String(this.minutes);
            expiry.addEventListener('change', () => {
                this.minutes = Number(expiry.value);
            });
            expiryRow.append(expiryLabel, expiry);
            settings.append(modes, expiryRow);
            this.panel.append(settings, el('p', 'share-keep-open', this.shareMode === 'multiple' ? t("share-ui.keep.this.page.open.expiry.stops.new.claims") : t("share-ui.keep.this.page.open.until.the.recipient.finishes")));
        }
        else if (terminal.has(selected.status)) {
            const message = el('div', 'share-ended-message');
            const mark = el('span', 'share-ended-mark', selected.status === 'completed' ? '✓' : '—');
            mark.setAttribute('aria-hidden', 'true');
            const copy = el('div', 'share-ended-copy');
            const titles: Partial<Record<ShareSnapshot['status'], string>> = { completed: t("share-ui.share.completed"), cancelled: t("share-ui.share.cancelled"), expired: t("share-ui.share.expired"), unavailable: t("share-ui.share.unavailable"), stopped: t("share-ui.share.ended") };
            copy.append(el('h2', '', titles[selected.status]), el('p', 'share-muted', t("share-ui.the.link.and.qr.code.are.no.longer")));
            message.append(mark, copy);
            const next = action(t("share-ui.create.another.share"), () => {
                this.selected = null;
                this.shareMode = 'single';
                this.minutes = 10;
                this.render();
                this.panel.querySelector<HTMLElement>('[data-share-control="pick-files"]')?.focus();
            }, true);
            next.dataset.shareControl = 'new-share';
            this.panel.append(message, next);
        }
        else {
            const head = el('div', 'share-heading');
            head.append(el('h2', '', t("share-ui.files", { p0: selected.files.length, p1: sizeLabel(selected.totalBytes) })), el('span', 'share-muted', statusLabel(selected)));
            const list = fileList(selected.files, (f) => el('span', 'share-small share-muted', f.completed ? t("share-ui.verified") : ''));
            this.panel.append(head);
            if (selected.recipientName) {
                this.panel.append(el('p', 'share-recipient', t("share-ui.receiving.device", { p0: selected.recipientName })));
            }
            if (selected.files.length > 3 || selected.mode === 'multiple') {
                const details = el('details', 'share-file-details');
                details.open = filesOpen;
                details.append(el('summary', '', t("share-ui.view.list.of.files", { p0: selected.files.length })), list);
                this.panel.append(details);
            }
            else {
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
                image.alt = t("share-ui.scan.the.qr.code.to.receive.these.files");
                const links = el('div', 'share-link-controls');
                const status = el('span', 'qt-connection');
                status.append(el('span', `qt-status-dot${this.connection.ready ? ' is-connected' : ''}`), el('span', '', this.connection.ready ? selected.mode === 'multiple' ? t("share-ui.link.open.for.multiple.recipients") : t("share-ui.waiting.for.a.recipient.alt") : t("share-ui.connection.lost.reconnecting")));
                const expiry = el('p', 'share-limit', this.remaining(selected.expires));
                expiry.dataset.shareExpiry = String(selected.expires);
                const input = el('input', 'share-url');
                input.value = url;
                input.readOnly = true;
                input.setAttribute('aria-label', t("share-ui.share.link"));
                input.dataset.shareUrl = '';
                const actions = el('div', 'share-actions');
                const copy = action(t("share-ui.copy.link"), async () => {
                    try {
                        await navigator.clipboard.writeText(url);
                        this.tell(t("share-ui.share.link.copied"));
                    }
                    catch {
                        input.focus();
                        input.select();
                        this.tell(t("share-ui.copy.the.selected.link"));
                    }
                }, true);
                copy.dataset.shareControl = 'copy';
                const save = action(t("share-ui.save.qr.code"), () => {
                    const a = document.createElement('a');
                    a.href = image.src;
                    a.download = t("share-ui.xcopy.share.qr.gif");
                    a.click();
                });
                actions.append(copy, save);
                const open = el('a', 'share-open', t("share-ui.open.recipient.page"));
                open.href = url;
                open.target = '_blank';
                open.rel = 'noopener noreferrer';
                links.append(status, expiry, input, actions, open);
                area.append(image, links);
                this.panel.append(area, el('p', 'share-limit', selected.mode === 'multiple' ? t("share-ui.keep.this.page.open.several.people.can.receive") : t("share-ui.keep.this.page.open.opening.the.link.or")));
            }
            else if (selected.mode === 'multiple') {
                this.panel.append(el('p', 'share-description', t("share-ui.new.claims.stopped.accepted.transfers.continue.keep.this")));
            }
            else if (selected.status === 'claimed') {
                const items = this.transfers.items.filter((i) => i.shareId === selected.id);
                this.panel.append(progressNode(items, selected.totalBytes, selected.files.filter((f) => f.completed).length, selected.files.length));
                this.panel.append(el('p', 'share-description', messageText(items.find((i) => i.status === 'failed')?.reason) || (items.some((i) => i.status === 'failed') ? t("share-ui.connection.lost.waiting.for.the.original.recipient.tab") : t("share-ui.the.recipient.is.receiving.keep.this.page.open"))));
            }
            const footer = el('div', 'share-footer');
            const cancel = action(selected.mode === 'multiple' ? t("share-ui.end.and.interrupt") : t("share-ui.cancel.share"), async () => {
                if (!window.confirm(selected.mode === 'multiple' ? t("share-ui.the.link.will.expire.and.all.queued.and") : t("share-ui.cancelling.immediately.invalidates.the.share.link.continue"))) {
                    return;
                }
                try {
                    this.apply(await this.connection.rpc('share.cancel', { id: selected.id }));
                    if (this.mode === 'share' && !this.current()) {
                        this.panel.querySelector<HTMLElement>('[data-share-control="pick-files"]')?.focus();
                    }
                }
                catch (caught) {
                    const error = errorValue(caught);
                    this.tell(error.message);
                }
            });
            cancel.dataset.shareControl = 'cancel';
            cancel.disabled = !this.connection.ready;
            if (selected.mode === 'multiple' && selected.accepting) {
                const stop = action(t("share-ui.stop.new.claims"), async () => {
                    const count = (selected.claims || []).filter((c) => !terminal.has(c.state)).length;
                    if (!window.confirm(t("share-ui.stop.accepting.new.claims.the.accepted.claims.will", { p0: count }))) {
                        return;
                    }
                    try {
                        this.apply(await this.connection.rpc('share.stop', { id: selected.id }));
                    }
                    catch (caught) {
                        const error = errorValue(caught);
                        this.tell(error.message);
                    }
                });
                stop.dataset.shareControl = 'stop';
                stop.disabled = !this.connection.ready;
                footer.append(stop);
            }
            else {
                footer.append(el('span', 'share-muted share-small', t("share-ui.files.stay.on.your.device")));
            }
            if (selected.mode === 'multiple') {
                const more = el('details', 'share-more-actions');
                more.open = actionsOpen;
                const summary = el('summary', '', t("share-ui.more.actions"));
                summary.dataset.shareControl = 'more-actions';
                more.append(summary, cancel);
                footer.append(more);
            }
            else {
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
            info.append(el('h3', '', t("share-ui.files.alt", { p0: s.mode === 'multiple' ? t("share-ui.multiple.recipients.alt") : t("share-ui.one.recipient"), p1: s.files.length })));
            if (s.recipientName) {
                const recipient = el('p', 'share-recipient', t("share-ui.receiving.device", { p0: s.recipientName }));
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
                details.append(fileList(s.files, s.mode === 'multiple' ? null : (file) => el('span', 'share-small share-muted', file.completed ? t("share-ui.verified") : t("share-ui.unfinished.alt"))));
                if (s.mode === 'multiple') {
                    details.append(this.claimDetails(s));
                }
                if (s.mode !== 'multiple') {
                    details.append(el('p', 'share-muted share-small', s.status === 'completed' ? t("share-ui.all.files.received.and.verified.the.recipient.can") : t("share-ui.this.share.has.ended.sharing.again.will.create")));
                }
                const toggle = action(expanded ? t("app.hide.details") : t("share-ui.view.details"), () => {
                    if (this.expandedRecords.has(s.id)) {
                        this.expandedRecords.delete(s.id);
                    }
                    else {
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
                const view = action(t("share-ui.view.share"), () => {
                    this.selected = s.id;
                    this.setMode('share');
                    this.panel.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
                    this.panel.querySelector<HTMLElement>('[data-share-control]')?.focus({ preventScroll: true });
                });
                view.dataset.shareControl = `record-view-${s.id}`;
                main.append(view);
            }
            this.records.append(row);
        }
        if (focusKey) {
            [...this.root.querySelectorAll<HTMLElement>('[data-share-control]')].find((n) => n.dataset.shareControl === focusKey)?.focus({ preventScroll: true });
        }
    }
}

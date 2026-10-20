import { progressMetrics, transferredBytes } from './transfer-progress.js';
import { preserveRecordLocation } from './notices.js';
import type { ClientLimits } from './types/device.js';
import { messageText } from './i18n/errors.js';
import { t } from './i18n/index.js';
import type { Claim, ShareSnapshot, ShareEntry, ShareComposerOptions, ShareMode } from './types/share.js';
import type { TransferItem } from './types/transfer.js';
import { query, activeElement } from './dom.js';
import { errorValue } from './dom.js';
const terminal = new Set(['completed', 'cancelled', 'expired', 'unavailable', 'stopped']);
import { sizeLabel } from './i18n/format.js';
import { MAX_FILES_PER_SEND } from './shared/transfer-limits.js';
export { sizeLabel };
export const fileLimitLabel = (config?: ClientLimits | null) => t("share-ui.file.limits", { count: MAX_FILES_PER_SEND, relayLimit: sizeLabel(config?.maxRelayFileBytes || config?.maxFileBytes || 50 * 1048576) });
export function renderFileLimitNotice(node: HTMLElement, config?: ClientLimits | null) {
    node.classList.add('share-file-limit');
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.classList.add('share-notice-icon');
    icon.setAttribute('viewBox', '0 0 20 20');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '1.4');
    icon.setAttribute('stroke-linecap', 'round');
    icon.setAttribute('aria-hidden', 'true');
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', '10');
    circle.setAttribute('cy', '10');
    circle.setAttribute('r', '7.5');
    const mark = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    mark.setAttribute('d', 'M10 6v4.5M10 14h.01');
    icon.append(circle, mark);
    node.replaceChildren(icon, el('span', '', fileLimitLabel(config)));
}
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
function detailIcon(kind: 'file' | 'device') {
    const symbol = el('span', `share-detail-symbol share-detail-symbol-${kind}`);
    symbol.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', kind === 'file'
        ? 'M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5Zm0 0v5h5M8 12h8m-8 4h5'
        : 'M3 4h18v12H3V4Zm9 12v4m-4 0h8');
    svg.append(path);
    symbol.append(svg);
    return symbol;
}
function detailSection(title: string, id: string, summary: string) {
    const section = el('section', 'share-detail-section');
    const heading = el('header', 'share-detail-heading');
    const label = el('h4', '', title);
    label.id = id;
    section.setAttribute('aria-labelledby', id);
    heading.append(label, el('span', 'share-muted share-small', summary));
    section.append(heading);
    return section;
}
export function statusLabel(s: ShareSnapshot) {
    if (s.mode === 'multiple' && !terminal.has(s.status)) {
        return s.accepting ? t("share-ui.open.for.claims") : t("share-ui.new.claims.stopped");
    }
    if (s.mode === 'multiple' && s.status === 'cancelled') {
        return t("share-ui.share.ended");
    }
    return { draining: t("share-ui.new.claims.stopped"), ready: t("share-ui.waiting.for.a.recipient"), claimed: t("share-ui.being.claimed"), completed: t("share-ui.all.claimed"), cancelled: t("app.cancelled"), expired: t("share-ui.expired"), unavailable: t("share-ui.share.unavailable"), stopped: t("share-ui.share.ended") }[s.status] || t("share-ui.connecting");
}
export function progressNode(items: TransferItem[], totalBytes: number, completed: number, count: number) {
    const bytes = items.reduce((sum, item) => sum + transferredBytes(item), 0);
    const box = el('div', 'share-progress');
    const meter = el('progress');
    meter.max = Math.max(totalBytes, 1);
    meter.value = totalBytes ? Math.min(bytes, totalBytes) : completed === count ? 1 : 0;
    meter.setAttribute('aria-label', t("share-ui.overall.file.reception.progress"));
    box.append(meter, el('p', 'share-muted share-small', t("share-ui.verified.files", { p0: completed, p1: count, p2: sizeLabel(Math.min(bytes, totalBytes)), p3: sizeLabel(totalBytes) })));
    box.append(progressMetrics(items, totalBytes, bytes));
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
    received: ShareComposerOptions['received'];
    entries: ShareEntry[] = [];
    expandedRecords = new Set<string>();
    selected: string | null = null;
    mode = 'device';
    minutes = 10;
    shareMode: ShareMode = 'single';
    retryClaims = new Set<string>();
    busy = false;
    historyCursor: string | null = null;
    historyCleared = false;
    loadingHistory = false;
    panel: HTMLElement;
    records: HTMLElement;
    clock: ReturnType<typeof setInterval>;
    viewFeedbackTimer: ReturnType<typeof setTimeout> | undefined;
    pendingCreate: {
        id: string;
        sources: File[];
        fileIds: string[];
    } | null = null;
    constructor({ root, connection, transfers, files, pick, remove, consumeFiles, addFiles, tell, changed, received }: ShareComposerOptions) {
        this.root = root;
        this.connection = connection;
        this.transfers = transfers;
        this.files = files;
        this.pick = pick;
        this.remove = remove;
        this.consumeFiles = consumeFiles;
        this.tell = tell;
        this.changed = changed;
        this.received = received;
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
                this.historyCursor = this.historyCleared ? null : result.nextCursor ?? null;
                this.applyHistory(result.shares, true);
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
        this.historyCleared = true;
        this.historyCursor = null;
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
    applyHistory(shares: ShareSnapshot[], firstPage = false) {
        shares.forEach((share) => {
            if (!this.historyCleared || !terminal.has(share.status) || this.entries.some((entry) => entry.id === share.id)) {
                this.apply(share, true);
            }
        });
        if (firstPage) {
            const ids = new Set(shares.map((share) => share.id));
            this.entries = [...shares.map((share) => this.entries.find((entry) => entry.id === share.id)!).filter(Boolean),
                ...this.entries.filter((entry) => !ids.has(entry.id))];
        }
        this.render();
    }
    apply(value: ShareSnapshot, fromHistory = false) {
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
        if (!entry && fromHistory) {
            entry = { ...value, sources: [] };
            this.entries.push(entry);
        }
        if (entry) {
            const completedClaims = new Set((entry.claims || []).filter(claim => claim.state === 'completed').map(claim => claim.id));
            const completed = entry.status === 'completed';
            Object.assign(entry, value);
            if (entry.mode === 'multiple') {
                for (const claim of entry.claims || []) {
                    if (claim.state === 'completed' && !completedClaims.has(claim.id)) {
                        this.received?.(entry, claim);
                    }
                }
            }
            else if (entry.status === 'completed' && !completed) {
                this.received?.(entry);
            }
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
                if (entry.status === 'cancelled' && entry.mode !== 'multiple' && this.selected === entry.id) {
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
        if (!entry || !entry.sources.length || !claim || claim.state !== 'transferring' || terminal.has(entry.status)) {
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
        return t("share-ui.claimed.count", { p0: s.counts?.completed || 0 });
    }
    claimDetails(s: ShareSnapshot) {
        const area = el('div', 'share-claims');
        const list = el('ul', 'share-claim-list');
        for (const claim of [...(s.claims || [])].reverse()) {
            const row = el('li', 'share-claim');
            row.dataset.claimRecord = claim.id;
            row.dataset.claimState = claim.state;
            let state = { queued: t("share-ui.waiting.for.a.recipient"), transferring: t("share-ui.being.claimed"), retryable: t("share-ui.awaiting.retry.alt"), completed: t("share-ui.claim.received"), cancelled: t("app.cancelled"), expired: t("share-ui.timed.out"), unavailable: t("share-ui.offline") }[claim.state];
            const info = el('div', 'share-claim-info');
            info.append(el('p', 'share-claim-name', claim.recipientName));
            if (claim.reason) {
                info.append(el('p', 'share-muted share-small share-claim-reason', messageText(claim.reason, claim.reasonKey, claim.reasonParams)));
            }
            if (claim.state === 'transferring' || claim.state === 'retryable' || claim.state === 'completed') {
                const items = this.transfers.items.filter(item => item.shareId === s.id && item.claimId === claim.id);
                const done = new Set(claim.files.filter(file => file.completed).map(file => file.index));
                const bytes = claim.state === 'completed' ? s.totalBytes : s.files.filter(file => done.has(file.index)).reduce((sum, file) => sum + file.size, 0)
                    + items.filter(item => !done.has(item.shareIndex)).reduce((sum, item) => sum + transferredBytes(item), 0);
                const meter = el('progress');
                meter.max = Math.max(s.totalBytes, 1);
                meter.value = claim.state === 'completed' ? meter.max : Math.min(s.totalBytes, bytes);
                meter.setAttribute('aria-label', t('app.transfer.progress', { p0: claim.recipientName }));
                if (claim.state === 'transferring') {
                    state = `${Math.min(99, Math.floor(bytes / Math.max(s.totalBytes, 1) * 100))}%`;
                }
                info.append(meter, progressMetrics(items, s.totalBytes, bytes));
            }
            row.append(detailIcon('device'), info, el('span', 'share-claim-status', state));
            list.append(row);
        }
        if (!s.claims?.length) {
            area.append(el('p', 'share-muted share-small share-claims-empty', t("share-ui.no.recipients.yet")));
        }
        else {
            area.append(list);
        }
        if (s.mode === 'multiple') {
            area.append(el('p', 'share-muted share-small share-claims-note', t("share-ui.current.claims.and.the.last.50.finished.records")));
        }
        return area;
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
                const result = await this.connection.rpc('share.list', { requestId: this.pendingCreate?.id });
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
            const limit = el('p', 'share-limit');
            renderFileLimitNotice(limit, this.connection.config);
            this.panel.append(upload, limit);
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
            const titles: Partial<Record<ShareSnapshot['status'], string>> = { completed: t("share-ui.share.completed"), cancelled: selected.mode === 'multiple' ? t("share-ui.share.ended") : t("share-ui.share.cancelled"), expired: t("share-ui.share.expired"), unavailable: t("share-ui.share.unavailable"), stopped: t("share-ui.share.ended") };
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
            const cancel = action(selected.mode === 'multiple' ? t("share-ui.end.share") : t("share-ui.cancel.share"), async () => {
                if (!window.confirm(selected.mode === 'multiple' ? t("share-ui.the.link.will.expire.and.all.queued.and") : t("share-ui.cancelling.immediately.invalidates.the.share.link.continue"))) {
                    return;
                }
                try {
                    this.apply(await this.connection.rpc('share.cancel', { id: selected.id }));
                    if (this.mode === 'share') {
                        this.panel.querySelector<HTMLElement>('[data-share-control="new-share"], [data-share-control="pick-files"]')?.focus();
                    }
                }
                catch (caught) {
                    const error = errorValue(caught);
                    this.tell(error.message);
                }
            });
            cancel.dataset.shareControl = 'cancel';
            cancel.disabled = !this.connection.ready;
            if (selected.mode !== 'multiple') {
                footer.append(el('span', 'share-muted share-small', t("share-ui.files.stay.on.your.device")));
            }
            footer.append(cancel);
            this.panel.append(footer);
        }
        const restoreLocation = preserveRecordLocation(this.records);
        this.records.replaceChildren();
        for (const s of this.entries) {
            const row = el('article', 'qt-transfer-card share-record');
            row.dataset.shareRecord = s.id;
            row.dataset.status = s.status;
            const main = el('div', 'share-record-main');
            const info = el('div', 'share-record-info');
            const controls = el('div', 'share-record-actions');
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
            main.append(info, controls);
            row.append(main);
            if (terminal.has(s.status) || s.mode === 'multiple') {
                const expanded = this.expandedRecords.has(s.id);
                const details = el('div', 'share-record-details');
                details.id = `share-result-${s.id}`;
                details.hidden = !expanded;
                const sharedFiles = detailSection(t("share-ui.shared.files"), `share-files-${s.id}`, t("share-ui.files", { p0: s.files.length, p1: sizeLabel(s.totalBytes) }));
                sharedFiles.classList.add('share-detail-files');
                const files = fileList(s.files, s.mode === 'multiple' ? null : (file) => el('span', 'share-small share-muted', file.completed ? t("share-ui.verified") : t("share-ui.unfinished.alt")));
                for (const file of files.children) {
                    file.prepend(detailIcon('file'));
                }
                sharedFiles.append(files);
                const recipients = detailSection(t("share-ui.receiving.devices"), `share-devices-${s.id}`, this.claimSummary(s));
                recipients.classList.add('share-detail-devices');
                recipients.append(this.claimDetails(s));
                details.append(sharedFiles, recipients);
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
                controls.append(toggle);
                row.append(details);
            }
            if (!terminal.has(s.status)) {
                const view = action(t("share-ui.view.share"), () => {
                    this.selected = s.id;
                    this.setMode('share');
                    this.panel.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
                    this.panel.querySelector<HTMLElement>('[data-share-control]')?.focus({ preventScroll: true });
                    // 当前分享可能已完整显示，滚动和鼠标焦点都不足以反馈这次点击。
                    clearTimeout(this.viewFeedbackTimer);
                    this.panel.classList.add('share-panel-highlighted');
                    this.viewFeedbackTimer = setTimeout(() => this.panel.classList.remove('share-panel-highlighted'), 2000);
                    this.tell(t("share-ui.share.shown.above"));
                });
                view.dataset.shareControl = `record-view-${s.id}`;
                view.setAttribute('aria-controls', this.panel.id);
                controls.append(view);
            }
            this.records.append(row);
        }
        if (this.historyCursor) {
            const more = action(t("share-ui.load.more"), async () => {
                if (this.loadingHistory || !this.historyCursor) {
                    return;
                }
                this.loadingHistory = true;
                this.render();
                try {
                    const result = await this.connection.rpc('share.list', { cursor: this.historyCursor });
                    this.historyCursor = this.historyCleared ? null : result.nextCursor ?? null;
                    this.applyHistory(result.shares);
                }
                catch (caught) {
                    this.tell(errorValue(caught).message);
                }
                finally {
                    this.loadingHistory = false;
                    this.render();
                }
            });
            more.dataset.shareControl = 'load-history';
            more.disabled = this.loadingHistory || !this.connection.ready;
            this.records.append(more);
        }
        restoreLocation();
        if (focusKey) {
            [...this.root.querySelectorAll<HTMLElement>('[data-share-control]')].find((n) => n.dataset.shareControl === focusKey)?.focus({ preventScroll: true });
        }
    }
}

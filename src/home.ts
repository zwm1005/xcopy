import { initI18n, onLocaleChange } from './i18n/index.js';
await initI18n();
import { t } from './i18n/index.js';
import { query, activeElement } from './dom.js';
const demo = query<HTMLElement>(document, '[data-demo]');
const tabs = [...demo.querySelectorAll<HTMLButtonElement>('[data-type]')];
const panel = query(document, '#demo-panel');
const playback = query<HTMLButtonElement>(demo, '[data-playback]');
const send = query<HTMLButtonElement>(demo, '[data-demo-send]');
const motion = matchMedia('(prefers-reduced-motion: reduce)');
const types = ['text', 'image', 'file'];
const labels = () => [t("home.text"), t("home.screenshot"), t("home.file")];
// Each type gets a complete six-second story: ready, sending, then received.
const phases = ['ready', 'sending', 'received'];
const durations = [1200, 800, 4000];
let typeIndex = 0;
let phaseIndex = 0;
let playing = !motion.matches;
let onScreen = false;
let pageActive = true;
let timer: ReturnType<typeof setTimeout>;
let manualTimer: ReturnType<typeof setTimeout>;
function render() {
    const type = types[typeIndex];
    const phase = phases[phaseIndex];
    tabs.forEach((tab, index) => {
        tab.setAttribute('aria-selected', String(index === typeIndex));
        tab.tabIndex = index === typeIndex ? 0 : -1;
    });
    panel.setAttribute('aria-labelledby', `tab-${type}`);
    panel.dataset.phase = phase;
    for (const selector of ['[data-send-content]', '[data-received-content]']) {
        query(demo, selector).replaceChildren(query<HTMLTemplateElement>(document, `#content-${type}`).content.cloneNode(true));
    }
    query<HTMLElement>(demo, '[data-empty]').hidden = phase === 'received';
    query<HTMLElement>(demo, '[data-received]').hidden = phase !== 'received';
    query<HTMLElement>(demo, '[data-empty-label]').textContent = phase === 'sending' ? t("home.receiving") : t("home.ready.to.receive");
    query<HTMLElement>(demo, '[data-send-label]').textContent = phase === 'sending' ? t("home.sending") : phase === 'received' ? t("home.send.again") : t("home.send");
    send.disabled = phase === 'sending';
    playback.setAttribute('aria-label', playing ? t("home.pause.demo") : t("home.play.demo"));
    query<SVGUseElement>(playback, 'use').setAttribute('href', playing ? '#i-pause' : '#i-play');
    query<HTMLElement>(demo, '[data-playback-label]').textContent = playing ? t("home.automatic.demo") : t("home.play.demo");
}
function clearTimers() {
    clearTimeout(timer);
    clearTimeout(manualTimer);
}
function visible() {
    return pageActive && onScreen && !document.hidden;
}
function schedule() {
    clearTimeout(timer);
    if (!playing || !visible()) {
        return;
    }
    timer = setTimeout(() => {
        if (phaseIndex === phases.length - 1) {
            typeIndex = (typeIndex + 1) % types.length;
            phaseIndex = 0;
        }
        else {
            phaseIndex += 1;
        }
        render();
        schedule();
    }, durations[phaseIndex]);
}
function select(index: number) {
    clearTimers();
    playing = false;
    typeIndex = index;
    phaseIndex = 0;
    query<HTMLElement>(demo, '[data-demo-announcement]').textContent = t("home.switched.to.automatic.playback.is.paused", { p0: labels()[index] });
    render();
}
tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(index));
    tab.addEventListener('keydown', event => {
        let next;
        if (event.key === 'ArrowRight') {
            next = (index + 1) % tabs.length;
        }
        else if (event.key === 'ArrowLeft') {
            next = (index + tabs.length - 1) % tabs.length;
        }
        else if (event.key === 'Home') {
            next = 0;
        }
        else if (event.key === 'End') {
            next = tabs.length - 1;
        }
        else {
            return;
        }
        event.preventDefault();
        select(next);
        tabs[next].focus();
    });
});
playback.addEventListener('click', () => {
    clearTimers();
    playing = !playing;
    // An explicit resume always starts a complete example of the current type.
    if (playing || phaseIndex === 1) {
        phaseIndex = 0;
    }
    query<HTMLElement>(demo, '[data-demo-announcement]').textContent = playing ? t("home.automatic.playback.started") : t("home.automatic.playback.paused");
    render();
    schedule();
});
send.addEventListener('click', () => {
    clearTimers();
    playing = false;
    phaseIndex = 1;
    render();
    manualTimer = setTimeout(() => {
        phaseIndex = 2;
        render();
        query<HTMLElement>(demo, '[data-demo-announcement]').textContent = t("home.was.delivered.to.the.office.computer.in.this", { p0: labels()[typeIndex] });
    }, durations[1]);
});
// Keyboard users can inspect a tab or send button without it moving beneath them.
demo.addEventListener('focusin', event => {
    if (event.target === playback || !playing) {
        return;
    }
    clearTimers();
    playing = false;
    if (phaseIndex === 1) {
        phaseIndex = 0;
    }
    render();
});
function updateVisibility() {
    clearTimers();
    // Do not leave a manual demo stuck in "sending" when its timer is stopped.
    if (phaseIndex === 1) {
        phaseIndex = 0;
        render();
    }
    schedule();
}
const observer = new IntersectionObserver(entries => {
    onScreen = entries[0].isIntersecting;
    updateVisibility();
}, { threshold: 0 });
observer.observe(demo);
document.addEventListener('visibilitychange', updateVisibility);
window.addEventListener('pagehide', () => {
    pageActive = false;
    clearTimers();
});
window.addEventListener('pageshow', () => {
    pageActive = true;
    updateVisibility();
});
motion.addEventListener('change', () => {
    if (motion.matches) {
        playing = false;
        updateVisibility();
        render();
    }
});
playback.hidden = false;
send.hidden = false;
render();

onLocaleChange(render);

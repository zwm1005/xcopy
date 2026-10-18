const demo = document.querySelector('[data-demo]');
const tabs = [...demo.querySelectorAll('[data-type]')];
const panel = document.getElementById('demo-panel');
const playback = demo.querySelector('[data-playback]');
const send = demo.querySelector('[data-demo-send]');
const motion = matchMedia('(prefers-reduced-motion: reduce)');
const types = ['text', 'image', 'file'];
const labels = ['文字', '截图', '文件'];
// Each type gets a complete six-second story: ready, sending, then received.
const phases = ['ready', 'sending', 'received'];
const durations = [1200, 800, 4000];
let typeIndex = 0;
let phaseIndex = 0;
let playing = !motion.matches;
let onScreen = false;
let pageActive = true;
let timer;
let manualTimer;

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
    demo.querySelector(selector).replaceChildren(document.getElementById(`content-${type}`).content.cloneNode(true));
  }
  demo.querySelector('[data-empty]').hidden = phase === 'received';
  demo.querySelector('[data-received]').hidden = phase !== 'received';
  demo.querySelector('[data-empty-label]').textContent = phase === 'sending' ? '正在接收…' : '已准备好接收';
  demo.querySelector('[data-send-label]').textContent = phase === 'sending' ? '发送中' : phase === 'received' ? '再发一次' : '发送';
  send.disabled = phase === 'sending';
  playback.setAttribute('aria-label', playing ? '暂停演示' : '播放演示');
  playback.querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  demo.querySelector('[data-playback-label]').textContent = playing ? '自动演示' : '播放演示';
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
    } else {
      phaseIndex += 1;
    }
    render();
    schedule();
  }, durations[phaseIndex]);
}

function select(index) {
  clearTimers();
  playing = false;
  typeIndex = index;
  phaseIndex = 0;
  demo.querySelector('[data-demo-announcement]').textContent = `已切换到${labels[index]}，自动演示已暂停。`;
  render();
}

tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => select(index));
  tab.addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowRight') {
      next = (index + 1) % tabs.length;
    } else if (event.key === 'ArrowLeft') {
      next = (index + tabs.length - 1) % tabs.length;
    } else if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = tabs.length - 1;
    } else {
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
  demo.querySelector('[data-demo-announcement]').textContent = playing ? '自动演示已开始。' : '自动演示已暂停。';
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
    demo.querySelector('[data-demo-announcement]').textContent = `${labels[typeIndex]}已模拟送达办公电脑。`;
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

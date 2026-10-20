// This independent module is only injected when the deployment explicitly opts in.
const loader = document.querySelector<HTMLScriptElement>('script[data-analytics-base]');
const preferenceKey = 'xcopy-analytics-excluded';
interface VisitEvent {
  eventId: string;
  eventName: 'page_view' | 'home_transfer_click' | 'tab_device' | 'tab_share';
  pageKey: 'home' | 'transfer' | 'share';
  locale: 'en' | 'zh-CN';
  referrerHost?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
}

function excluded(): boolean {
  let value = document.cookie.split(';').some((part) => part.trim() === 'xcopy_analytics_off=1');
  try {
    value ||= localStorage.getItem(preferenceKey) === '1';
  } catch { /* The cookie preference still works when localStorage is unavailable. */ }
  return value;
}

function preference(): void {
  const url = new URL(location.href);
  const setting = url.searchParams.get('analytics');
  if (setting !== 'off' && setting !== 'on') {
    return;
  }
  try {
    if (setting === 'off') {
      localStorage.setItem(preferenceKey, '1');
    } else {
      localStorage.removeItem(preferenceKey);
    }
  } catch { /* Fall back to a first-party preference cookie. */ }
  document.cookie = `xcopy_analytics_off=${setting === 'off' ? '1' : ''}; Path=/; Max-Age=${setting === 'off' ? 7776000 : 0}; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
  url.searchParams.delete('analytics');
  history.replaceState(history.state, '', url);
}

async function start(script: HTMLScriptElement): Promise<void> {
  preference();
  if (excluded() || script.hasAttribute('data-analytics-preferences')) {
    return;
  }
  const base = script.dataset.analyticsBase || '';
  if (!/^\/(?!\/)[a-zA-Z0-9/_-]+$/.test(base)) {
    return;
  }
  const pageKey = ['/', '/index.html'].includes(location.pathname) ? 'home'
    : ['/transfer', '/transfer/', '/transfer.html'].includes(location.pathname) ? 'transfer'
      : ['/s', '/s/', '/share.html'].includes(location.pathname) ? 'share' : null;
  if (!pageKey) {
    return;
  }
  try {
    await fetch(`${base}/bootstrap`, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(1500) });
  } catch { /* Unidentified page views remain useful when bootstrap is unavailable. */ }
  let pendingView = true;
  let sending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const queue: { event: VisitEvent; attempt: number }[] = [];
  const locale = (): VisitEvent['locale'] => document.documentElement.lang.startsWith('zh') ? 'zh-CN' : 'en';
  const endpoint = `${base}/events`;

  function push(eventName: VisitEvent['eventName']): void {
    if (excluded() || queue.length >= 20) {
      return;
    }
    const event: VisitEvent = { eventId: crypto.randomUUID(), eventName, pageKey: pageKey!, locale: locale() };
    try {
      const referring = document.referrer ? new URL(document.referrer) : null;
      if (referring && referring.hostname !== location.hostname && referring.hostname.length <= 253) {
        event.referrerHost = referring.hostname;
      }
    } catch { /* Invalid referrers are omitted. */ }
    const params = new URL(location.href).searchParams;
    for (const [query, field, limit] of [['utm_source', 'utmSource', 64], ['utm_medium', 'utmMedium', 64], ['utm_campaign', 'utmCampaign', 128]] as const) {
      const value = params.get(query);
      if (value && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value)) {
        event[field] = value;
      }
    }
    queue.push({ event, attempt: 0 });
    clearTimeout(timer);
    timer = setTimeout(() => { void flush(); }, 80);
  }

  async function flush(beacon = false): Promise<void> {
    if (!queue.length || excluded()) {
      return;
    }
    if (beacon) {
      const batch = queue.splice(0, 10);
      const body = JSON.stringify({ events: batch.map((item) => item.event) });
      if (!navigator.sendBeacon(endpoint, new Blob([body], { type: 'application/json' }))) {
        queue.unshift(...batch);
      }
      return;
    }
    if (sending) {
      return;
    }
    sending = true;
    const batch = queue.splice(0, 10);
    try {
      await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', keepalive: true, body: JSON.stringify({ events: batch.map((item) => item.event) }), signal: AbortSignal.timeout(4000) });
    } catch {
      queue.unshift(...batch.filter((item) => item.attempt++ === 0));
    } finally {
      sending = false;
      if (queue.length) {
        timer = setTimeout(() => { void flush(); }, 500);
      }
    }
  }

  function view(): void {
    if (pendingView && document.visibilityState === 'visible') {
      pendingView = false;
      push('page_view');
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      void flush(true);
    } else {
      view();
    }
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      pendingView = true;
      view();
    }
  });
  window.addEventListener('pagehide', () => { void flush(true); });
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const link = target?.closest<HTMLAnchorElement>('a[href]');
    if (pageKey === 'home' && link && new URL(link.href).origin === location.origin && new URL(link.href).pathname === '/transfer') {
      push('home_transfer_click');
    }
    const tab = target?.closest<HTMLElement>('[data-mode]');
    if (pageKey === 'transfer' && tab?.getAttribute('aria-selected') === 'false') {
      if (tab.dataset.mode === 'device') {
        push('tab_device');
      } else if (tab.dataset.mode === 'share') {
        push('tab_share');
      }
    }
  }, { capture: true });
  view();
}

if (loader) {
  void start(loader).catch(() => { /* Statistics must never prevent the application from starting. */ });
}

/** Defaults only for known event-list pages; explicit user specs always win. */
export function siteSpec(url: string): Record<string, unknown> | undefined {
  const u = new URL(url);
  if (u.hostname === 'chocotabi-saitama.jp' && /^\/event\/?$/.test(u.pathname)) {
    return {
      kind: 'html', region_policy: { mode: 'trust_source' },
      extract: {
        item_selector: 'article.single-near-spot-card',
        fields: {
          title: { css: '.single-near-spot-card__title' },
          date: { css: '.single-near-spot-card__event-date-pc' },
          url: { css: 'a.single-near-spot-card__link', attr: 'href', absolutize: true },
          description: { css: '.single-near-spot-card__description-text' },
        },
        default_tz: 'Asia/Tokyo',
      },
    };
  }
  if (u.hostname === 'www.pref.saitama.lg.jp' && u.pathname === '/cgi-bin/event_cal/cal_month.cgi') {
    return { kind: 'html', parser: 'saitama_calendar', region_policy: { mode: 'trust_source' } };
  }
  return undefined;
}

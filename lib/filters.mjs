/**
 * 新闻过滤模块（广告/点击查看/日历预告）
 */

const AD_PATTERNS = /(?:\d+折.*VIP|VIP[·\s]*\d*折|VIP.*折|立省\d+|立即抢购|限时|优惠|折扣|新春福利|解锁.*利器|领取.*礼|猜金价|竞猜.*赢|资金监测器)/;
export function isAd(item) {
  const text = (item.title || '') + ' ' + (item.content || '');
  return AD_PATTERNS.test(text);
}

const CLICK_TO_VIEW_PATTERNS = /(?:点击查看|点击查看详情|点击看详情|点击查看全文|查看更多|展开全文)/;
export function isClickToView(item) {
  const text = (item.title || '') + ' ' + (item.content || '');
  return CLICK_TO_VIEW_PATTERNS.test(text);
}

const CALENDAR_PREVIEW_PATTERNS = /(?:下周重要事件|本周重要事件|重要事件与数据预告|数据预告|日程预告|财经日历|一周前瞻|周度前瞻|本周大事|下周大事|数据与事件预告|宏观日历|期货·.*专题|局势专题|专题\b|VIP\b|金十数据整理|市场罗盘|图集|定价权解析|深度解析|科普|不是一条普通水道|杠杆点)/;
export function isCalendarPreview(item) {
  const title = String(item.title || '').trim();
  const content = String(item.content || '').trim();
  const text = `${title} ${content}`;

  if (CALENDAR_PREVIEW_PATTERNS.test(text)) return true;

  const head = content.slice(0, 600);
  const numberedLines = (head.match(/\n\s*\d+\./g) || []).length;
  if (numberedLines >= 4) return true;

  if (/(?:点击了解|点击查看|点击详情|阅读全文|查看更多)/.test(text) && /(?:专题|合集|盘点|解读|怎么看|后市怎么看)/.test(text)) {
    return true;
  }

  if (/(?:^|\s)VIP/.test(text) && /[？?]/.test(text)) {
    return true;
  }

  return false;
}

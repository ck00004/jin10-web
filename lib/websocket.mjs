/**
 * 金十 WebSocket 协议模块
 */
import WebSocket from 'ws';
import { JIN10_WS_URL } from './config.mjs';
import { log, logErr } from './utils.mjs';
import { saveState } from './dedup.mjs';

// 消息类型常量
export const MSG_SHOWBOX_FLASH  = 1000;
export const MSG_NEWS_FLASH     = 1001;
export const MSG_EVENTS_FLASH   = 1002;
export const MSG_TOP_LIST       = 1005;
export const MSG_VIP_NEWS_FLASH = 1007;
export const MSG_QUOTE_NEWS     = 1110;
export const MSG_FLASH_LIST     = 1200;
export const MSG_HEARTBEAT      = 1201;
export const MSG_LOGIN          = 4002;

// 二进制读取器 (Little-Endian)
export class BinaryReader {
  constructor(buf) { this.buf = Buffer.from(buf); this.pos = 0; }
  r16L()  { const v = this.buf.readInt16LE(this.pos);  this.pos += 2; return v; }
  rU16L() { const v = this.buf.readUInt16LE(this.pos); this.pos += 2; return v; }
  r32L()  { const v = this.buf.readInt32LE(this.pos);  this.pos += 4; return v; }
  rU32L() { const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }
  rStrL() {
    const len = this.rU16L();
    const s = this.buf.toString('utf-8', this.pos, this.pos + len);
    this.pos += len;
    return s;
  }
}

// 二进制写入器 (Little-Endian)
class BinaryWriter {
  constructor(size = 2048) { this.buf = Buffer.alloc(size); this.pos = 0; }
  w16L(v)  { this.buf.writeInt16LE(v, this.pos);  this.pos += 2; return this; }
  wU16L(v) { this.buf.writeUInt16LE(v, this.pos); this.pos += 2; return this; }
  w32L(v)  { this.buf.writeInt32LE(v, this.pos);  this.pos += 4; return this; }
  wStrL(s) {
    const enc = Buffer.from(s, 'utf-8');
    this.wU16L(enc.length);
    enc.copy(this.buf, this.pos);
    this.pos += enc.length;
    return this;
  }
  toBuffer() { return this.buf.subarray(0, this.pos); }
}

// XOR 对称加密/解密
function xorCrypt(data, key) {
  if (!data || !data.length || !key) return data;
  const n = key.charCodeAt(0);
  const keyLen = key.length;
  const result = Buffer.from(data);
  for (let r = 0; r < result.length; r++) {
    result[r] ^= key.charCodeAt((r + n) % keyLen);
  }
  return result;
}

// 构建登录包
function buildLoginPacket() {
  const w = new BinaryWriter();
  w.w16L(MSG_LOGIN);   // 消息类型
  w.w32L(0);           // 用户ID (未登录=0)
  w.wStrL('');         // 空字符串
  w.wStrL('chrome');   // 浏览器标识
  w.w32L(0);           // 用户等级
  w.wStrL('web');      // 平台
  return w.toBuffer();
}

// 去除 HTML 标签
export function stripHtml(text) {
  if (!text) return '';
  return text.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
}

// 判断是否为重要/红色快讯
export function isRedFlash(data) {
  const flashType = data.type ?? 0;
  const contentData = (typeof data.data === 'object' && data.data) ? data.data : {};
  if (flashType === 0 || flashType === 2) {
    if (data.important) return true;
    const rawContent = contentData.content || '';
    if (rawContent.includes('class="important-text"')) return true;
    return false;
  } else if (flashType === 1) {
    const star = contentData.star;
    return typeof star === 'number' && star >= 3;
  }
  return false;
}

// 构建标签数组 (对应 Python build_tags)
// 标签优先级: VIP > 广告 > 直播 > 文章tag(SVP等)
function buildTags(data) {
  const flashType = data.type ?? 0;
  const contentData = (typeof data.data === 'object' && data.data) ? data.data : {};
  const extras = (typeof data.extras === 'object' && data.extras) ? data.extras : {};
  const tags = [];

  // VIP 标签
  if (contentData.vip_level) {
    tags.push(contentData.lock ? 'VIP·锁定' : 'VIP');
  }

  // 广告标签
  if (extras.ad) {
    tags.push('广告');
  }

  // 直播标签
  const livePattern = /(\/\/t\.cn\/EwViABe|\/\/tv\.jin10\.com\/#\/|\/\/v\.jin10\.com\/live)/;
  let rawContent = contentData.content || '';
  const remarkList = Array.isArray(data.remark) ? data.remark : [];
  for (const rm of remarkList) {
    if (typeof rm === 'object' && rm && rm.type === 'link') {
      rawContent += ' ' + (rm.link || '');
    }
  }
  if (livePattern.test(rawContent)) {
    tags.push('直播');
  }

  // 文章类型(type=2)的 tag
  if (flashType === 2) {
    const tagVal = contentData.tag || '';
    if (tagVal === 'VIP') {
      // 已在上面处理
    } else if (tagVal === 'SVP') {
      tags.push('精英');
    } else if (tagVal) {
      tags.push(tagVal);
    }
  }

  return tags;
}

// 构建热度标签 (对应 Python build_hot_tag)
function buildHotTag(data) {
  const hot = data.hot || '';
  if (!hot) return '';
  const validHots = ['爆', '沸', '热', '火'];
  return validHots.includes(hot) ? hot : '';
}

// 构建注解信息数组 (对应 Python build_remark_text)
// 返回 [{ type, title, link?, symbol?, content? }, ...]
function buildRemarks(data) {
  const remarkList = Array.isArray(data.remark) ? data.remark : [];
  if (!remarkList.length) return [];

  const remarks = [];
  for (const rm of remarkList) {
    if (typeof rm !== 'object' || !rm) continue;
    const rmType = rm.type || '';
    const rmTitle = rm.title || '';
    const rmLink = rm.link || '';
    const rmContent = rm.content || '';
    const rmSymbol = rm.symbol || '';

    if (rmType === 'link' && rmTitle) {
      remarks.push({ type: 'link', title: rmTitle, link: rmLink });
    } else if (rmType === 'topic' && rmTitle) {
      remarks.push({ type: 'topic', title: rmTitle });
    } else if (rmType === 'quotes' && rmTitle) {
      remarks.push({ type: 'quotes', title: rmTitle, symbol: rmSymbol });
    } else if (rmType === 'news' && rmTitle) {
      remarks.push({ type: 'news', title: rmTitle });
    } else if (rmType === 'content' && rmContent) {
      remarks.push({ type: 'content', content: stripHtml(rmContent).slice(0, 80) });
    }
  }
  return remarks;
}

// 计算日历数据利好/利空 (对应 Python compute_affect)
function computeAffect(data) {
  if (data.type !== 1) return '';
  const contentData = (typeof data.data === 'object' && data.data) ? data.data : {};
  if (contentData.show_affect === 0) return '';

  const actual = contentData.actual;
  const consensus = contentData.consensus;
  const previous = contentData.previous;
  const affect = contentData.affect ?? 0;

  if (actual == null) return '';
  const base = consensus != null ? consensus : previous;
  if (base == null) return '';

  const actualF = parseFloat(actual);
  const baseF = parseFloat(base);
  if (isNaN(actualF) || isNaN(baseF)) return '';

  if (actualF === baseF) return '影响较小';
  if (affect === 0) {
    return actualF > baseF ? '利多金银' : '利空金银';
  } else {
    return actualF > baseF ? '利空金银' : '利多金银';
  }
}

// 从【xxx】中提取标题 (对应 Python extract_title_from_brackets)
function extractTitleFromBrackets(rawContent) {
  const m = rawContent.match(/^(<b>)?(【)(<b>)?(.+?)(<\/b>)?(】)(<\/b>)?/);
  if (m && m[4] && m[4].length >= 6) {
    return m[4];
  }
  return '';
}

// 从快讯数据中提取统一的 item 对象
export function extractFlashItem(data) {
  const flashId = String(data.id || '');
  const flashType = data.type ?? 0;
  const timeStr = data.time || '';
  let hms = '';
  if (timeStr) {
    const m = timeStr.match(/(\d{2}:\d{2}:\d{2})$/);
    hms = m ? m[1] : timeStr;
  }
  const contentData = (typeof data.data === 'object' && data.data) ? data.data : {};
  const important = isRedFlash(data);

  // 新增：标签、热度、注解、利好利空
  const tags = buildTags(data);
  const hotTag = buildHotTag(data);
  const remarks = buildRemarks(data);
  const affect = computeAffect(data);
  const source = contentData.source || '';

  if (flashType === 0) {
    const rawContent = contentData.content || '';
    const content = stripHtml(rawContent);
    const vipTitle = contentData.vip_title || '';
    const vipDesc = contentData.vip_desc ? stripHtml(contentData.vip_desc) : '';
    const pic = contentData.pic || '';
    const pics = Array.isArray(contentData.pics) ? contentData.pics : [];
    // 从【】中提取标题
    let title = contentData.title || '';
    if (!title) {
      title = extractTitleFromBrackets(rawContent);
    }
    return { flashId, time: hms, title, content, important, tags, hotTag, remarks, affect, source, vipTitle, vipDesc, pic, pics };
  } else if (flashType === 1) {
    const name = contentData.name || '';
    const country = contentData.country || '';
    const timePeriod = contentData.time_period || '';
    const unit = contentData.unit || '';
    const actual = contentData.actual ?? '--';
    const forecast = contentData.consensus ?? '--';
    const previous = contentData.previous ?? '--';
    const revised = contentData.revised ?? null;
    const star = typeof contentData.star === 'number' ? contentData.star : 0;
    const title = `${country}${timePeriod}${name}`;
    const content = `[${country}] ${title} 前值:${previous} 预期:${forecast} 实际:${actual}`;
    return { flashId, time: hms, title, content, important, tags, hotTag, remarks, affect, source,
             calendarData: { country, name, timePeriod, unit, actual, forecast, previous, revised, star } };
  } else if (flashType === 2) {
    const rawContent = contentData.content || '';
    const content = stripHtml(rawContent);
    const title = contentData.title || '';
    const link = contentData.link || '';
    const pic = contentData.pic || '';
    return { flashId, time: hms, title, content: title || content, important, tags, hotTag, remarks, affect, source, link, pic };
  }
  return { flashId, time: hms, title: '', content: JSON.stringify(contentData).slice(0, 200), important, tags, hotTag, remarks, affect, source };
}

// 从修改/删除消息中提取简要内容
function extractEditContent(data) {
  const contentData = (typeof data.data === 'object' && data.data) ? data.data : {};
  return stripHtml(contentData.content || '');
}

/**
 * 金十 WebSocket 连接（含自动重连、指数退避）
 * @param {object} state - 共享状态对象
 * @param {object} dedup - 去重字典（引用传递，由外部管理）
 * @param {function} onFlashEvent - 统一快讯事件回调 ({ action, item, rawData })
 *   action: 1=新增, 2=修改, 3=删除
 * @param {function} onHistoryDone - 历史列表处理完毕的回调（用于清理去重）
 */
export function connectJin10WebSocket(state, dedup, onFlashEvent, onHistoryDone) {
  let retryCount = 0;
  const maxRetryDelay = 30_000;
  let encryptKey = '';

  function connect() {
    log(`🔌 正在连接金十 WebSocket: ${JIN10_WS_URL}`);

    const ws = new WebSocket(JIN10_WS_URL, {
      headers: {
        'Origin': 'https://www.jin10.com',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
    });

    let firstMessage = true;

    ws.on('open', () => {
      log('✅ WebSocket 连接成功');
      retryCount = 0;
    });

    ws.on('message', async (rawMsg) => {
      if (!Buffer.isBuffer(rawMsg)) return;

      if (firstMessage) {
        firstMessage = false;
        const reader = new BinaryReader(rawMsg);
        reader.rU32L();
        const rVal = reader.rU32L();
        const oVal = reader.rU32L();
        encryptKey = `${oVal}.${rVal}`;
        log(`🔑 获取加密密钥: ${encryptKey}`);

        const loginPacket = buildLoginPacket();
        const encrypted = xorCrypt(loginPacket, encryptKey);
        ws.send(encrypted);
        log('📤 已发送登录包，等待接收快讯...');
        return;
      }

      const decrypted = xorCrypt(rawMsg, encryptKey);
      const reader = new BinaryReader(decrypted);
      const msgType = reader.r16L();

      if (msgType === MSG_HEARTBEAT) {
        ws.send(Buffer.alloc(0));
        return;
      }

      try {
        if (msgType === MSG_LOGIN) {
          const jsonStr = reader.rStrL();
          const data = JSON.parse(jsonStr);
          const status = data.status ?? -1;
          if (status === 100 || status === 1 || status === 101) {
            log(`🔓 登录成功: ${data.message || ''}`);
          } else {
            log(`🔓 登录状态: status=${status}, message=${data.message || ''}`);
          }
          state.ok = (state.ok || 0) + 1;
          state.lastSuccessAt = Date.now();
          state.consecutiveFail = 0;
          saveState(state);

        } else if ([MSG_SHOWBOX_FLASH, MSG_NEWS_FLASH, MSG_VIP_NEWS_FLASH, MSG_QUOTE_NEWS].includes(msgType)) {
          const jsonStr = reader.rStrL();
          const data = JSON.parse(jsonStr);
          const action = data.action ?? 1;

          if (action === 1) {
            // 新增快讯
            const item = extractFlashItem(data);
            log(`📰 新快讯: [${item.time}] ${item.important ? '🔴 ' : ''}(ID: ${item.flashId}) ${item.title || item.content?.substring(0,40)}`);
            await onFlashEvent({ action: 1, item, rawData: data }, dedup, state);
          } else if (action === 2) {
            // 修改快讯
            const flashId = String(data.id || '');
            const content = extractEditContent(data);
            log(`📝 [修改] ID:${flashId} ${content.substring(0, 60)}`);
            await onFlashEvent({ action: 2, flashId, content, rawData: data }, dedup, state);
          } else if (action === 3) {
            // 删除快讯
            const flashId = String(data.id || '');
            log(`🗑️ [删除] ID:${flashId}`);
            await onFlashEvent({ action: 3, flashId, rawData: data }, dedup, state);
          }
          // action 5=弹窗, 6=刷新 — 忽略

        } else if (msgType === MSG_EVENTS_FLASH) {
          const jsonStr = reader.rStrL();
          const data = JSON.parse(jsonStr);
          const action = data.action ?? 1;
          if (action === 1) {
            const item = extractFlashItem(data);
            log(`📅 日历事件: [${item.time}] ${item.important ? '🔴 ' : ''}(ID: ${item.flashId}) ${item.title || item.content?.substring(0,40)}`);
            await onFlashEvent({ action: 1, item, rawData: data }, dedup, state);
          } else if (action === 2) {
            const flashId = String(data.id || '');
            const content = extractEditContent(data);
            log(`📝 [日历修改] ID:${flashId} ${content.substring(0, 60)}`);
            await onFlashEvent({ action: 2, flashId, content, rawData: data }, dedup, state);
          } else if (action === 3) {
            const flashId = String(data.id || '');
            log(`🗑️ [日历删除] ID:${flashId}`);
            await onFlashEvent({ action: 3, flashId, rawData: data }, dedup, state);
          }

        } else if (msgType === MSG_FLASH_LIST) {
          const count = reader.r32L();
          log(`📋 收到历史快讯列表 (共 ${count} 条)`);
          let importantCount = 0;
          for (let i = 0; i < count; i++) {
            try {
              const jsonStr = reader.rStrL();
              const data = JSON.parse(jsonStr);
              const item = extractFlashItem(data);
              if (item.important) importantCount++;
              await onFlashEvent({ action: 1, item, rawData: data, isHistory: true }, dedup, state);
            } catch { break; }
          }
          log(`   其中重要新闻 ${importantCount} 条`);
          onHistoryDone();
        }

      } catch (e) {
        logErr(`WebSocket 消息解析错误 (type=${msgType}): ${e.message}`);
      }
    });

    ws.on('error', (err) => {
      logErr(`WebSocket 错误: ${err.message}`);
    });

    ws.on('close', (code, reason) => {
      retryCount++;
      const delay = Math.min(retryCount * 2000, maxRetryDelay);
      log(`🔌 WebSocket 已断开 (code=${code}), ${delay / 1000}s 后重连 (第 ${retryCount} 次)...`);

      state.fail = (state.fail || 0) + 1;
      state.consecutiveFail = (state.consecutiveFail || 0) + 1;
      state.lastErrorAt = Date.now();
      state.lastError = `WebSocket closed: code=${code}`;
      saveState(state);

      setTimeout(connect, delay);
    });
  }

  connect();
}

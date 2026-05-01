// ==UserScript==
// @name         豆瓣想读 x 余杭图书馆
// @namespace    https://greasyfork.org/
// @version      0.9.0
// @description  在豆瓣「想读」列表自动匹配余杭区图书馆在馆可借书籍
// @match        https://book.douban.com/people/*/wish*
// @grant        GM.xmlHttpRequest
// @connect      my1.zjhzlib.cn
// @connect      book.douban.com
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(async function () {
  'use strict';

  // ── Constants ──────────────────────────────────────────────
  const OPAC_BASE = 'https://my1.zjhzlib.cn/opac';
  const PER_PAGE = 15;
  const CONCURRENCY = 3;        // 并发查询数（低并发保准确）
  const MAX_RETRIES = 3;        // 每本书最大重试次数

  // ── Helpers ────────────────────────────────────────────────
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function gmGet(url) {
    return new Promise((resolve, reject) => {
      GM.xmlHttpRequest({
        method: 'GET',
        url,
        timeout: 15000,
        onload: r => resolve(r),
        onerror: e => reject(e),
        ontimeout: () => reject(new Error('timeout: ' + url)),
      });
    });
  }

  /** 带重试的请求，失败后等 500ms 重试一次 */
  async function gmGetWithRetry(url) {
    try {
      return await gmGet(url);
    } catch {
      await sleep(500);
      return await gmGet(url);
    }
  }

  /**
   * 按 host 限速的请求队列
   * 同一 host 的请求串行执行，且间隔 ≥ minInterval
   * 不同 host 的请求互不影响
   */
  function createHostLimiter(minInterval) {
    const queue = [];
    let last = 0;
    let running = false;

    async function flush() {
      if (running) return;
      running = true;
      while (queue.length) {
        const wait = Math.max(0, minInterval - (Date.now() - last));
        if (wait) await sleep(wait);
        last = Date.now();
        queue.shift()();
      }
      running = false;
    }

    return function limiterGet(url) {
      return new Promise((resolve, reject) => {
        queue.push(() => gmGetWithRetry(url).then(resolve, reject));
        flush();
      });
    };
  }

  // OPAC: 同一时刻最多 1 个请求，间隔 200ms → 峰值 5 req/s
  const opacGet = createHostLimiter(200);
  // Douban: 间隔 150ms → 峰值 ~6.7 req/s
  const doubanGet = createHostLimiter(150);

  /** 清理书名：去副标题、去版本词 */
  function cleanTitle(raw) {
    let t = raw.trim();
    // 去副标题 " : xxx" 或 "：xxx"
    t = t.replace(/\s*[:：]\s*.+$/, '');
    return t.trim();
  }

  /** 提取核心书名：去掉版本差异词，用于 OPAC 模糊匹配 */
  function coreTitle(raw) {
    let t = cleanTitle(raw);
    // 去掉括号及其内容，如（增补版）、（套装共九册）、（第X版）
    t = t.replace(/[（(][^）)]*[）)]/g, '');
    // 去掉常见版本后缀词
    t = t.replace(/(?:全集|增补版|典藏版|典藏全集|纪念版|修订版|最新版|插图版|精装版|平装版|完整版|普及版|新版|全[一二三四五六七八九十\d]+册|套装.*|第[一二三四五六七八九十\d]+版|上中下|上册|中册|下册|全[一二三四五六七八九十\d]+卷)$/g, '');
    return t.trim();
  }

  /** 从 wish list 条目中提取第一个作者名 */
  function extractAuthor(el) {
    // wish list 中作者信息通常在 .pub 元素里
    // 格式如："[美]东野圭吾 著 / 李盈春 译 / 南海出版公司 / 2017-1 / 59.00元"
    const pubEl = el.querySelector('.pub');
    if (!pubEl) return '';
    const text = pubEl.textContent.trim();
    // 取第一个 "/" 之前的部分
    const firstPart = text.split('/')[0].trim();
    // 去掉国籍标注 [xxx] 和 "著"/"编"/"译" 等后缀
    const cleaned = firstPart.replace(/^\[.*?\]\s*/, '').replace(/\s*(著|编|主编|著译|译|编著|整理|选编)\s*$/, '').trim();
    return cleaned;
  }

  // ── Douban: 从 wish list 提取书籍 ─────────────────────────

  function extractBooks(doc) {
    const books = [];
    const seen = new Set();

    const items = doc.querySelectorAll('.subject-item, .item, li[class*="subject"]');
    items.forEach(el => {
      const a = el.querySelector('a[href*="/subject/"]');
      if (!a) return;
      const href = a.getAttribute('href') || a.href || '';
      const m = href.match(/subject\/(\d+)/);
      if (!m) return;
      const id = m[1];
      if (seen.has(id)) return;
      seen.add(id);

      let title = '';
      const h2a = el.querySelector('h2 a');
      if (h2a) title = h2a.textContent.trim();
      if (!title) title = a.textContent.trim();

      const author = extractAuthor(el);

      books.push({
        id,
        title,
        author,
        url: `https://book.douban.com/subject/${id}/`,
      });
    });
    return books;
  }

  function parseTotalCount(doc) {
    const allText = doc.body ? doc.body.textContent : doc.textContent;
    let m = allText.match(/(\d+)\s*\/\s*(\d+)/);
    if (m) return parseInt(m[2]);

    m = allText.match(/共\s*(\d+)\s*本/);
    if (m) return parseInt(m[1]);

    const paginator = (doc.body || doc).querySelector('.paginator a:last-of-type');
    if (paginator) {
      const pm = (paginator.href || '').match(/start=(\d+)/);
      if (pm) return parseInt(pm[1]) + PER_PAGE;
    }
    return PER_PAGE;
  }

  async function fetchAllBooks() {
    const all = [];
    const base = location.origin + location.pathname;

    const currentBooks = extractBooks(document);
    all.push(...currentBooks);

    const total = parseTotalCount(document);
    const pages = Math.ceil(total / PER_PAGE);
    log(`共 ${total} 本，${pages} 页，当前页已提取 ${currentBooks.length} 本`);

    updateStatus(`采集书单：1/${pages} 页`);

    // 并发采集剩余页面
    const pageUrls = [];
    for (let p = 1; p < pages; p++) {
      const start = p * PER_PAGE;
      pageUrls.push(`${base}?start=${start}&sort=time&rating=all&filter=all&mode=grid`);
    }

    let fetched = 1;
    await pooledMap(pageUrls, 3, async (url) => {
      try {
        const res = await doubanGet(url);
        if (res.status === 200) {
          const parser = new DOMParser();
          const doc = parser.parseFromString(res.responseText, 'text/html');
          const books = extractBooks(doc);
          all.push(...books);
        }
      } catch (e) {
        log(`页面获取失败: ${e.message}`);
      }
      fetched++;
      updateStatus(`采集书单：${fetched}/${pages} 页`);
    });

    return all;
  }

  // ── OPAC: 查询余杭区图书馆 ────────────────────────────────

  async function searchByTitle(title) {
    const q = encodeURIComponent(title);
    const url = `${OPAC_BASE}/search?q=${q}&searchType=standard&searchWay=title&sortWay=score&sortOrder=desc&scWay=dim&hasholding=1&rows=5&searchSource=reader`;
    const res = await opacGet(url);
    if (res.status !== 200) return null;
    return res.responseText;
  }

  /**
   * 从 OPAC 搜索结果 HTML 中提取结果列表
   * 每条结果包含 { bookrecno, author }
   */
  function parseSearchResults(html) {
    const results = [];
    const regex = /bookrecno="(\d+)"[\s\S]*?著者:\s*([^<\n]+)/g;
    let m;
    while ((m = regex.exec(html)) !== null) {
      results.push({
        bookrecno: m[1],
        opacAuthor: m[2].trim(),
      });
    }
    return results;
  }

  /** 检查两个作者名是否匹配（模糊，支持部分包含） */
  function authorMatch(doubanAuthor, opacAuthor) {
    if (!doubanAuthor || !opacAuthor) return true; // 缺少信息时不拦截
    const a = doubanAuthor.replace(/\s/g, '');
    const b = opacAuthor.replace(/\s/g, '');
    // 双向包含：OPAC 可能是 "东野圭吾" 而豆瓣是 "(日)东野圭吾"，或反过来
    return a.includes(b) || b.includes(a);
  }

  async function searchByISBN(isbn) {
    const url = `${OPAC_BASE}/search?searchWay0=isbn&q0=${isbn}&logical0=AND&searchSource=reader&sortWay=score&sortOrder=desc&rows=5&hasholding=1`;
    const res = await opacGet(url);
    if (res.status !== 200) return null;
    return parseBookrecno(res.responseText);
  }

  function parseBookrecno(html) {
    const ms = html.match(/bookrecno="(\d+)"/);
    if (!ms) return null;
    return ms[1];
  }

  async function getHoldings(bookrecno) {
    const url = `${OPAC_BASE}/book/holdingPreviews?bookrecnos=${bookrecno}&return_fmt=json`;
    const res = await opacGet(url);
    if (res.status !== 200) return [];

    try {
      const json = JSON.parse(res.responseText);
      const results = [];
      if (json && json.previews) {
        for (const items of Object.values(json.previews)) {
          for (const h of items) {
            if (h.curlibName === '余杭区图书馆' && h.loanableCount > 0) {
              results.push(h);
            }
          }
        }
      }
      return results;
    } catch {
      return [];
    }
  }

  async function fetchISBN(bookUrl) {
    try {
      const res = await doubanGet(bookUrl);
      if (res.status !== 200) return null;
      const parser = new DOMParser();
      const doc = parser.parseFromString(res.responseText, 'text/html');
      const info = doc.querySelector('#info');
      if (!info) return null;
      const m = info.textContent.match(/(\d{13})/);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  // ── 单本书匹配逻辑（混合策略）──────────────────────────────

  /**
   * 用书名搜索 OPAC 并校验作者，返回匹配的 bookrecno 或 null
   */
  async function titleSearchWithAuthor(title, author) {
    const html = await searchByTitle(title);
    if (!html) return null;

    const results = parseSearchResults(html);
    if (results.length === 0) return null;

    // 优先找作者匹配的结果
    const matched = results.find(r => authorMatch(author, r.opacAuthor));
    if (matched) return matched.bookrecno;

    // 只有一条结果时信任它（大概率就是对的）
    if (results.length === 1) return results[0].bookrecno;

    // 多条结果且作者都不匹配，不采纳
    return null;
  }

  async function processBook(book) {
    const { title, author } = book;

    // ① 用完整书名 + 作者校验
    let bookrecno = await titleSearchWithAuthor(title, author);

    // ② 无结果，去副标题再试
    if (!bookrecno) {
      const cleaned = cleanTitle(title);
      if (cleaned !== title) {
        bookrecno = await titleSearchWithAuthor(cleaned, author);
      }
    }

    // ③ 仍无结果，用核心书名（去版本词）再试
    if (!bookrecno) {
      const core = coreTitle(title);
      if (core && core !== title && core !== cleanTitle(title)) {
        bookrecno = await titleSearchWithAuthor(core, author);
      }
    }

    // ④ 最后回退到 ISBN 精确匹配
    if (!bookrecno) {
      const isbn = await fetchISBN(book.url);
      if (isbn) {
        bookrecno = await searchByISBN(isbn);
      }
    }

    if (!bookrecno) return null;

    // ⑤ 获取馆藏
    const holdings = await getHoldings(bookrecno);
    return holdings.length > 0 ? { book, holdings, bookrecno } : null;
  }

  // ── 并发池 ─────────────────────────────────────────────────

  /**
   * 并发执行，concurrency 控制同时运行的任务数
   * 支持 pause/stop 中断
   */
  async function pooledMap(items, concurrency, fn) {
    let idx = 0;

    async function worker() {
      while (idx < items.length) {
        if (stopped) return;
        await checkPause();
        if (stopped) return;
        const i = idx++;
        await fn(items[i], i);
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
    );
  }

  // ── UI ─────────────────────────────────────────────────────

  let panel, barEl, barTextEl, statusEl;
  let startBtn, pauseBtn, stopBtn;
  let stopped = false;
  let paused = false;
  let pauseResolver = null;

  function log(msg) {
    console.log(`[余杭图书馆] ${msg}`);
  }

  function createPanel() {
    panel = document.createElement('div');
    panel.id = 'yuhang-lib';
    panel.innerHTML = `
      <div class="yl-header">
        <h2>余杭区图书馆 · 在馆可借</h2>
        <div class="yl-actions">
          <button id="yl-start" class="yl-btn-start">开始查询</button>
          <button id="yl-pause" class="yl-btn-pause" style="display:none">暂停</button>
          <button id="yl-stop" class="yl-btn-stop" style="display:none">停止</button>
        </div>
      </div>
      <div class="yl-progress-wrap">
        <div class="yl-bar" id="yl-bar"></div>
        <span class="yl-bar-text" id="yl-bar-text">点击「开始查询」</span>
      </div>
      <div class="yl-status" id="yl-status">尚未开始</div>
      <div class="yl-filter" id="yl-filter" style="display:none">
        <label>馆藏地点：</label>
        <select id="yl-filter-loc"><option value="">全部</option></select>
      </div>
      <div class="yl-table-wrap">
        <table class="yl-table">
          <thead>
            <tr>
              <th class="yl-th-title">书名</th>
              <th class="yl-sortable" id="yl-sort-callno">索书号 <span id="yl-sort-icon">⇅</span></th>
              <th>馆藏地点</th>
              <th>可借</th>
            </tr>
          </thead>
          <tbody id="yl-tbody"></tbody>
        </table>
      </div>
    `;

    const style = document.createElement('style');
    style.textContent = `
      #yuhang-lib {
        position: relative;
        background: #fff;
        border: 1px solid #e0e0e0;
        border-radius: 8px;
        margin: 20px auto;
        max-width: 950px;
        padding: 20px;
        box-shadow: 0 2px 12px rgba(0,0,0,0.08);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        font-size: 14px;
        color: #333;
      }
      .yl-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 14px;
      }
      .yl-header h2 {
        margin: 0;
        font-size: 18px;
        font-weight: 600;
      }
      .yl-actions { display: flex; gap: 8px; }
      .yl-actions button {
        padding: 4px 14px;
        border: 1px solid #ddd;
        border-radius: 4px;
        background: #f5f5f5;
        cursor: pointer;
        font-size: 13px;
      }
      .yl-actions button:hover { background: #eee; }
      .yl-btn-start { color: #2e7d32; border-color: #66bb6a !important; }
      .yl-btn-start:hover { background: #e8f5e9 !important; }
      .yl-btn-pause { color: #e65100; border-color: #ffb74d !important; }
      .yl-btn-pause:hover { background: #fff3e0 !important; }
      .yl-btn-stop { color: #c62828; border-color: #ef9a9a !important; }
      .yl-btn-stop:hover { background: #ffebee !important; }
      .yl-progress-wrap {
        background: #f0f0f0;
        border-radius: 4px;
        height: 22px;
        margin-bottom: 12px;
        overflow: hidden;
        position: relative;
      }
      .yl-bar {
        height: 100%;
        width: 0%;
        background: linear-gradient(90deg, #66bb6a, #aed581);
        transition: width 0.3s ease;
      }
      .yl-bar-text {
        position: absolute;
        top: 1px;
        left: 50%;
        transform: translateX(-50%);
        font-size: 12px;
        color: #555;
        white-space: nowrap;
      }
      .yl-status {
        margin-bottom: 12px;
        font-size: 13px;
        color: #888;
      }
      .yl-filter {
        margin-bottom: 10px;
        font-size: 13px;
        color: #555;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .yl-filter select {
        padding: 3px 8px;
        border: 1px solid #ddd;
        border-radius: 4px;
        font-size: 13px;
        background: #fff;
        max-width: 260px;
      }
      .yl-table-wrap {
        max-height: 600px;
        overflow-y: auto;
        border-top: 1px solid #eee;
      }
      .yl-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
      }
      .yl-table th {
        padding: 8px 10px;
        background: #fafafa;
        text-align: left;
        border-bottom: 2px solid #e0e0e0;
        font-weight: 600;
        font-size: 12px;
        color: #666;
        position: sticky;
        top: 0;
      }
      .yl-table td {
        padding: 8px 10px;
        border-bottom: 1px solid #f0f0f0;
        vertical-align: top;
      }
      .yl-table tr:hover td { background: #fafff5; }
      .yl-th-title { width: 35%; }
      .yl-sortable { cursor: pointer; user-select: none; }
      .yl-sortable:hover { color: #333; }
      .yl-table .yl-title a {
        color: #37a;
        text-decoration: none;
      }
      .yl-table .yl-title a:hover {
        color: #37a;
        text-decoration: underline;
      }
      .yl-table .yl-callno {
        font-family: "SF Mono", Menlo, Consolas, monospace;
        font-size: 12px;
      }
      .yl-table .yl-available {
        color: #43a047;
        font-weight: 600;
      }
      .yl-done {
        color: #43a047;
        font-weight: 600;
        font-size: 14px;
      }
      .yl-empty {
        text-align: center;
        padding: 30px 0;
        color: #999;
      }
      .yl-failed {
        margin-top: 12px;
        border-top: 1px solid #eee;
        padding-top: 10px;
      }
      .yl-failed-toggle {
        color: #e65100;
        font-size: 13px;
        cursor: pointer;
        user-select: none;
      }
      .yl-failed-toggle:hover { text-decoration: underline; }
      .yl-failed-list {
        margin-top: 8px;
        max-height: 200px;
        overflow-y: auto;
        padding: 8px 12px;
        background: #fff8f0;
        border-radius: 4px;
        font-size: 12px;
      }
      .yl-failed-item {
        padding: 3px 0;
        color: #666;
      }
      .yl-failed-item a {
        color: #37a;
        text-decoration: none;
      }
      .yl-failed-item a:hover { text-decoration: underline; }
    `;
    document.head.appendChild(style);

    const content = document.querySelector('#content') || document.body;
    content.insertBefore(panel, content.firstChild);

    barEl = document.getElementById('yl-bar');
    barTextEl = document.getElementById('yl-bar-text');
    statusEl = document.getElementById('yl-status');
    startBtn = document.getElementById('yl-start');
    pauseBtn = document.getElementById('yl-pause');
    stopBtn = document.getElementById('yl-stop');

    document.getElementById('yl-filter-loc').addEventListener('change', applyFilter);

    // 索书号排序
    let sortAsc = true;
    document.getElementById('yl-sort-callno').addEventListener('click', () => {
      sortAsc = !sortAsc;
      document.getElementById('yl-sort-icon').textContent = sortAsc ? '⇅' : '⇵';
      const tbody = document.getElementById('yl-tbody');
      const rows = Array.from(tbody.querySelectorAll('tr'));
      rows.sort((a, b) => {
        const ca = a.dataset.callno || '';
        const cb = b.dataset.callno || '';
        return sortAsc ? ca.localeCompare(cb) : cb.localeCompare(ca);
      });
      rows.forEach(tr => tbody.appendChild(tr));
    });

    startBtn.addEventListener('click', () => {
      startBtn.style.display = 'none';
      pauseBtn.style.display = '';
      stopBtn.style.display = '';
      runQuery();
    });

    pauseBtn.addEventListener('click', () => {
      if (!paused) {
        paused = true;
        pauseBtn.textContent = '继续';
        updateStatus('已暂停');
      } else {
        paused = false;
        pauseBtn.textContent = '暂停';
        if (pauseResolver) {
          pauseResolver();
          pauseResolver = null;
        }
      }
    });

    stopBtn.addEventListener('click', () => {
      stopped = true;
      if (paused) {
        paused = false;
        if (pauseResolver) {
          pauseResolver();
          pauseResolver = null;
        }
      }
      pauseBtn.style.display = 'none';
      stopBtn.disabled = true;
      stopBtn.textContent = '已停止';
      updateStatus('查询已停止');
    });
  }

  function checkPause() {
    if (!paused) return Promise.resolve();
    return new Promise(resolve => { pauseResolver = resolve; });
  }

  let doneCount = 0;
  let availableCount = 0;
  const failedBooks = [];       // 查询失败的书籍
  const locations = new Set();

  function updateProgress(done, total) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    barEl.style.width = pct + '%';
    barTextEl.textContent = `${done} / ${total}`;
  }

  function updateStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function addRow(book, h) {
    const loc = h.curlocalName || '未知';
    const callno = h.callno || '-';

    // 动态添加筛选选项
    if (!locations.has(loc)) {
      locations.add(loc);
      const select = document.getElementById('yl-filter-loc');
      const opt = document.createElement('option');
      opt.value = loc;
      opt.textContent = loc;
      select.appendChild(opt);
    }

    const tbody = document.getElementById('yl-tbody');
    const tr = document.createElement('tr');
    tr.dataset.loc = loc;
    tr.dataset.callno = callno;
    tr.innerHTML = `
      <td class="yl-title"><a href="${book.url}" target="_blank" title="${book.title}">${book.title}</a></td>
      <td class="yl-callno">${callno}</td>
      <td>${loc}</td>
      <td class="yl-available">${h.loanableCount}</td>
    `;
    tbody.appendChild(tr);
  }

  let currentFilterLoc = '';

  function applyFilter() {
    const val = document.getElementById('yl-filter-loc').value;
    currentFilterLoc = val;
    const rows = document.querySelectorAll('#yl-tbody tr');
    let visibleCount = 0;
    rows.forEach(tr => {
      if (!val || tr.dataset.loc === val) {
        tr.style.display = '';
        visibleCount++;
      } else {
        tr.style.display = 'none';
      }
    });
    // 更新底部统计
    updateSummary(visibleCount, val);
  }

  function updateSummary(count, loc) {
    if (!statusEl || !statusEl.dataset.total) return;
    const total = statusEl.dataset.total;
    const stopped = statusEl.dataset.stopped === '1';
    const label = stopped ? `查询停止：已查 ${statusEl.dataset.done} 本` : `查询完成：共 ${total} 本`;
    if (loc) {
      statusEl.innerHTML = `${label}，<span class="yl-done">${count} 本</span>在「${loc}」可借`;
    } else {
      statusEl.innerHTML = `${label}，<span class="yl-done">${count} 本</span>在余杭区图书馆可借`;
    }
  }

  function showEmpty() {
    const tbody = document.getElementById('yl-tbody');
    tbody.innerHTML = `<tr><td colspan="4" class="yl-empty">未发现余杭区图书馆在馆可借的书籍</td></tr>`;
  }

  function showFailedBooks() {
    if (failedBooks.length === 0) return;
    const wrap = document.createElement('div');
    wrap.className = 'yl-failed';
    wrap.innerHTML = `
      <div class="yl-failed-toggle" id="yl-failed-toggle">
        ${failedBooks.length} 本书查询失败，点击查看详情 ▸
      </div>
      <div class="yl-failed-list" id="yl-failed-list" style="display:none">
        ${failedBooks.map(b => `<div class="yl-failed-item"><a href="${b.url}" target="_blank">${b.title}</a>${b.author ? ' — ' + b.author : ''}</div>`).join('')}
      </div>
    `;
    panel.appendChild(wrap);

    document.getElementById('yl-failed-toggle').addEventListener('click', () => {
      const list = document.getElementById('yl-failed-list');
      const toggle = document.getElementById('yl-failed-toggle');
      if (list.style.display === 'none') {
        list.style.display = '';
        toggle.textContent = `${failedBooks.length} 本书查询失败，点击收起 ▾`;
      } else {
        list.style.display = 'none';
        toggle.textContent = `${failedBooks.length} 本书查询失败，点击查看详情 ▸`;
      }
    });
  }

  // ── 主流程 ─────────────────────────────────────────────────

  async function runQuery() {
    log('开始查询');
    updateStatus('正在采集书单...');

    // 1. 采集所有书
    const books = await fetchAllBooks();
    log(`共采集 ${books.length} 本书`);

    if (books.length === 0) {
      updateStatus('未在页面中找到书籍');
      return;
    }

    // 2. 并发查询（5 个 worker）
    doneCount = 0;
    availableCount = 0;

    await pooledMap(books, CONCURRENCY, async (book) => {
      updateProgress(doneCount, books.length);
      updateStatus(`查询中：${book.title}（${doneCount + 1}/${books.length}）`);

      // 失败自动重试，最多 MAX_RETRIES 次
      let success = false;
      for (let attempt = 1; attempt <= MAX_RETRIES && !stopped; attempt++) {
        try {
          const result = await processBook(book);
          if (result) {
            availableCount++;
            if (availableCount === 1) {
              document.getElementById('yl-filter').style.display = '';
            }
            for (const h of result.holdings) {
              addRow(book, h);
            }
          }
          success = true;
          break;
        } catch (e) {
          log(`查询失败 [${book.title}]（${attempt}/${MAX_RETRIES}）: ${e.message}`);
          if (attempt < MAX_RETRIES) await sleep(1000);
        }
      }
      if (!success && !stopped) {
        failedBooks.push(book);
      }

      doneCount++;
    });

    // 3. 完成
    if (!stopped) {
      updateProgress(books.length, books.length);
      barTextEl.textContent = '完成';
    }
    pauseBtn.style.display = 'none';
    stopBtn.style.display = 'none';

    if (availableCount === 0) {
      showEmpty();
    }

    showFailedBooks();

    const label = stopped ? `查询停止：已查 ${doneCount} 本` : `查询完成：共 ${books.length} 本`;
    statusEl.dataset.total = books.length;
    statusEl.dataset.done = doneCount;
    statusEl.dataset.stopped = stopped ? '1' : '0';
    updateSummary(availableCount, currentFilterLoc);
    log(`查询${stopped ? '停止' : '完成'}：${availableCount}/${doneCount} 本可借${failedBooks.length > 0 ? `，${failedBooks.length} 本失败` : ''}`);
  }

  log('脚本加载完成');
  createPanel();
})();

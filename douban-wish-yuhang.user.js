// ==UserScript==
// @name         豆瓣想读 x 余杭图书馆
// @namespace    https://greasyfork.org/
// @version      0.5.0
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
  const CONCURRENCY = 8;        // 并发查询数

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
        queue.push(() => gmGet(url).then(resolve, reject));
        flush();
      });
    };
  }

  // OPAC: 同一时刻最多 1 个请求，间隔 200ms → 峰值 5 req/s
  const opacGet = createHostLimiter(200);
  // Douban: 间隔 150ms → 峰值 ~6.7 req/s
  const doubanGet = createHostLimiter(150);

  /** 清理书名：去副标题、去多余空格 */
  function cleanTitle(raw) {
    let t = raw.trim();
    t = t.replace(/\s*[:：]\s*.+$/, '');
    return t.trim();
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

      books.push({
        id,
        title,
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
    return parseBookrecno(res.responseText);
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

  async function processBook(book) {
    // ① 先用完整书名搜索
    let bookrecno = await searchByTitle(book.title);

    // ② 无结果时，去掉副标题再试
    if (!bookrecno) {
      const shortTitle = cleanTitle(book.title);
      if (shortTitle !== book.title) {
        bookrecno = await searchByTitle(shortTitle);
      }
    }

    // ③ 仍无结果，回退到 ISBN
    if (!bookrecno) {
      const isbn = await fetchISBN(book.url);
      if (isbn) {
        bookrecno = await searchByISBN(isbn);
      }
    }

    if (!bookrecno) return null;

    // ④ 获取馆藏
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
              <th>索书号</th>
              <th>馆藏地点</th>
              <th>可借 / 总数</th>
              <th>还书日期</th>
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
    tr.innerHTML = `
      <td class="yl-title"><a href="${book.url}" target="_blank" title="${book.title}">${book.title}</a></td>
      <td class="yl-callno">${h.callno || '-'}</td>
      <td>${loc}</td>
      <td class="yl-available">${h.loanableCount}/${h.copycount}</td>
      <td>${h.retudate || '-'}</td>
    `;
    tbody.appendChild(tr);
  }

  function applyFilter() {
    const val = document.getElementById('yl-filter-loc').value;
    const rows = document.querySelectorAll('#yl-tbody tr');
    rows.forEach(tr => {
      if (!val || tr.dataset.loc === val) {
        tr.style.display = '';
      } else {
        tr.style.display = 'none';
      }
    });
  }

  function showEmpty() {
    const tbody = document.getElementById('yl-tbody');
    tbody.innerHTML = `<tr><td colspan="5" class="yl-empty">未发现余杭区图书馆在馆可借的书籍</td></tr>`;
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

      try {
        const result = await processBook(book);
        if (result) {
          availableCount++;
          // 首次出结果时显示筛选栏
          if (availableCount === 1) {
            document.getElementById('yl-filter').style.display = '';
          }
          for (const h of result.holdings) {
            addRow(book, h);
          }
        }
      } catch (e) {
        log(`查询失败 [${book.title}]: ${e.message}`);
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

    const label = stopped ? `查询停止：已查 ${doneCount} 本` : `查询完成：共 ${books.length} 本`;
    updateStatus('');
    statusEl.innerHTML = `${label}，<span class="yl-done">${availableCount} 本</span>在余杭区图书馆可借`;
    log(`查询${stopped ? '停止' : '完成'}：${availableCount}/${doneCount} 本可借`);
  }

  log('脚本加载完成');
  createPanel();
})();

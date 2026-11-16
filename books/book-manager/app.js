// Load the reader only when a PDF is opened; browsing the catalog stays light.
let pdfjsPromise;
function loadPdfjs() {
  return pdfjsPromise ??= import('./vendor/pdfjs/build/pdf.mjs').then(lib => {
    lib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/build/pdf.worker.mjs', import.meta.url).href;
    return lib;
  }).catch(error => { pdfjsPromise = null; throw error; });
}

const $ = (selector) => document.querySelector(selector);
const state = {
  localMode: false, reviews: {}, reviewFilter: 'all',
  books: [], view: 'all', category: '', topic: '', type: '', query: '', sort: 'name', layout: 'grid',
  favorites: readStore('book-library-favorites', []), recent: readStore('book-library-recent', {}),
  reader: null, pdf: null, loadingTask: null, renderTask: null, page: 1, zoom: 1, generation: 0, renderSerial: 0, busy: false,
};

function readStore(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value && (Array.isArray(fallback) ? Array.isArray(value) : typeof value === 'object' && !Array.isArray(value)) ? value : fallback;
  } catch { return fallback; }
}
function saveStore(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { notify('浏览器未允许保存记录，本次仍可继续阅读。'); } }
function niceName(value) { return value.replace(/^\d+(?:\.\d+)?_/, '').replaceAll('_', ' '); }
function sizeLabel(bytes) { return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`; }
function fileUrl(book) { return new URL(`../${book.path.split('/').map(encodeURIComponent).join('/')}`, import.meta.url).href; }
function titleForView() { return state.category ? niceName(state.category) : state.view === 'recent' ? '最近阅读' : state.view === 'favorites' ? '我的收藏' : '全部书籍'; }
function notify(message) { const toast = $('#toast'); toast.textContent = message; toast.hidden = false; clearTimeout(notify.timer); notify.timer = setTimeout(() => toast.hidden = true, 3000); }

function setView(view, category = '') {
  state.view = view; state.category = category; state.topic = '';
  $('#topic-select').value = '';
  document.querySelectorAll('.nav-item').forEach(button => button.classList.toggle('active', !category && button.dataset.view === view));
  document.querySelectorAll('.category-item').forEach(button => button.classList.toggle('active', button.dataset.category === category));
  $('#sidebar').classList.remove('open');
  $('#menu-button').setAttribute('aria-expanded', 'false');
  updateTopicOptions();
  render();
}

function updateTopicOptions() {
  const select = $('#topic-select');
  const current = state.topic;
  select.replaceChildren(new Option('全部主题', ''));
  const topics = [...new Set(state.books.filter(book => !state.category || book.category === state.category).map(book => book.topic))].sort((a,b) => a.localeCompare(b, 'zh-CN'));
  topics.forEach(topic => select.add(new Option(niceName(topic), topic)));
  select.value = current;
}

function renderSidebar() {
  const categories = [...new Set(state.books.map(book => book.category))].sort((a,b) => a.localeCompare(b, 'zh-CN'));
  $('#category-total').textContent = String(categories.length);
  $('#all-count').textContent = String(state.books.length);
  $('#file-total').textContent = `${state.books.length} 个文件`;
  const nav = $('#category-nav');
  nav.replaceChildren();
  for (const category of categories) {
    const count = state.books.filter(book => book.category === category).length;
    const button = document.createElement('button');
    button.className = 'category-item';
    button.dataset.category = category;
    const dot = document.createElement('span'); dot.className = 'category-dot';
    const label = document.createElement('span'); label.textContent = niceName(category);
    const tally = document.createElement('b'); tally.textContent = count;
    button.append(dot, label, tally);
    button.addEventListener('click', () => setView('all', category));
    nav.append(button);
  }
  const formats = [...new Set(state.books.map(book => book.extension))].sort();
  $('#type-select').replaceChildren(new Option('全部格式', ''), ...formats.map(format => new Option(format.toUpperCase(), format)));
  $('#stat-books').textContent = state.books.length;
  $('#stat-pdfs').textContent = state.books.filter(book => book.extension === 'pdf').length;
  $('#stat-categories').textContent = categories.length;
}

function filteredBooks() {
  const q = state.query.trim().toLocaleLowerCase();
  const favorites = new Set(state.favorites);
  const result = state.books.filter(book => {
    if (state.category && book.category !== state.category) return false;
    if (state.view === 'favorites' && !favorites.has(book.path)) return false;
    if (state.view === 'recent' && !state.recent[book.path]) return false;
    if (state.topic && book.topic !== state.topic) return false;
    if (state.type && state.type !== 'other' && book.extension !== state.type) return false;
    if (state.type === 'other' && book.extension === 'pdf') return false;
    if (state.localMode && state.reviewFilter !== 'all' && reviewChoice(book) !== state.reviewFilter) return false;
    return !q || `${book.name} ${book.category} ${book.topic} ${book.path}`.toLocaleLowerCase().includes(q);
  });
  result.sort((a,b) => {
    if (state.view === 'recent') return state.recent[b.path]?.at - state.recent[a.path]?.at;
    if (state.sort === 'modified') return b.modified - a.modified;
    if (state.sort === 'size') return b.size - a.size;
    return a.name.localeCompare(b.name, 'zh-CN', {numeric: true});
  });
  return result;
}

function createCard(book) {
  const card = document.createElement('div');
  card.className = 'book-card';
  const cover = document.createElement('div');
  cover.className = `book-cover type-${Math.max(0, parseInt(book.category, 10) || 0) % 7}`;
  const type = document.createElement('span'); type.className = 'cover-type'; type.textContent = book.extension.toUpperCase();
  const short = document.createElement('strong'); short.textContent = book.name;
  cover.append(type, short);
  const info = document.createElement('div'); info.className = 'book-info';
  const title = document.createElement('button'); title.type = 'button'; title.className = 'book-title';
  title.addEventListener('click', () => openBook(book)); title.textContent = book.name; title.title = book.name;
  const topic = document.createElement('div'); topic.className = 'book-topic'; topic.textContent = `${niceName(book.category)} · ${niceName(book.topic)}`; topic.title = book.path;
  const bottom = document.createElement('div'); bottom.className = 'book-bottom';
  const format = document.createElement('span'); format.className = `format ${book.extension === 'pdf' ? '' : 'other'}`;
  format.textContent = `${book.extension.toUpperCase()} · ${sizeLabel(book.size)}`;
  const favorite = document.createElement('button'); favorite.type = 'button'; favorite.textContent = state.favorites.includes(book.path) ? '★' : '☆';
  favorite.dataset.path = book.path;
  favorite.className = state.favorites.includes(book.path) ? 'is-favorite' : '';
  favorite.setAttribute('aria-label', `${state.favorites.includes(book.path) ? '取消收藏' : '收藏'} ${book.name}`);
  favorite.setAttribute('aria-pressed', String(state.favorites.includes(book.path)));
  favorite.title = state.favorites.includes(book.path) ? '取消收藏' : '收藏';
  favorite.addEventListener('click', event => { event.stopPropagation(); toggleFavorite(book.path); });
  bottom.append(format, favorite); info.append(title, topic, bottom); card.append(cover, info);
  cover.addEventListener('click', () => title.click());
  if (state.localMode) card.append(createReviewTools(book));
  return card;
}

function render() {
  const title = titleForView();
  $('#page-title').textContent = title;
  $('#breadcrumb-current').textContent = title;
  $('#section-title').textContent = state.category ? '分类书目' : state.view === 'all' ? '馆藏目录' : title;
  $('#page-description').textContent = state.category ? '按主题查找与阅读这一领域的资料。' : state.view === 'recent' ? '接着上次的进度继续读。' : state.view === 'favorites' ? '你标记过的书籍都在这里。' : '整理知识，从下一本开始。';
  const books = filteredBooks();
  $('#result-description').textContent = state.category ? `${niceName(state.category)} · 书籍资料` : '浏览书籍资料';
  $('#results-count').textContent = `显示 ${books.length} 本书籍`;
  $('#stat-favorites').textContent = state.favorites.filter(path => state.books.some(book => book.path === path)).length;
  const list = $('#book-list'); list.classList.toggle('list-layout', state.layout === 'list');
  list.replaceChildren(...books.map(createCard));
  $('#empty-state').hidden = books.length > 0;
  if (state.localMode) updateReviewSummary();
  $('#grid-button').classList.toggle('selected', state.layout === 'grid');
  $('#list-button').classList.toggle('selected', state.layout === 'list');
  $('#grid-button').setAttribute('aria-pressed', String(state.layout === 'grid'));
  $('#list-button').setAttribute('aria-pressed', String(state.layout === 'list'));
}

function toggleFavorite(path) {
  state.favorites = state.favorites.includes(path) ? state.favorites.filter(item => item !== path) : [...state.favorites, path];
  saveStore('book-library-favorites', state.favorites);
  render();
  document.querySelectorAll('.book-bottom button').forEach(button => { if (button.dataset.path === path) button.focus(); });
}

function remember(book, page = 1) {
  state.recent[book.path] = {at: Date.now(), page};
  saveStore('book-library-recent', state.recent);
}

function readerFeedback(message, busy = true) {
  state.busy = busy;
  $('#reader-scroll').setAttribute('aria-busy', String(busy));
  $('#reader-loading').hidden = !message;
  $('#reader-loading-text').textContent = message;
  $('#reader-loading progress').hidden = !busy;
}

// Allow the loading state to paint before PDF.js starts CPU-heavy work.
const paintFeedback = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));

async function openBook(book) {
  if (book.extension !== 'pdf') { remember(book); render(); window.open(fileUrl(book), '_blank', 'noopener'); return; }
  await closeReader();
  const generation = ++state.generation;
  state.reader = book;
  $('#reader').showModal();
  $('#reader-title').textContent = book.name;
  $('#reader-topic').textContent = `${niceName(book.category)} / ${niceName(book.topic)}`;
  $('#reader-download').href = fileUrl(book);
  $('#reader-download').download = `${book.name}.pdf`;
  $('#pdf-canvas').hidden = true;
  readerFeedback('正在打开 PDF…'); $('#reader-status').textContent = '';
  $('#page-input').value = 1; $('#page-count').textContent = '–';
  for (const id of ['prev-page', 'next-page', 'page-input', 'zoom-in', 'zoom-out']) $(`#${id}`).disabled = true;
  $('#reader-scroll').scrollTo(0, 0);
  state.zoom = 1;
  try {
    await paintFeedback();
    if (generation !== state.generation) return;
    const pdfjsLib = await loadPdfjs();
    if (generation !== state.generation) return;
    state.loadingTask = pdfjsLib.getDocument({
      url: fileUrl(book),
      cMapUrl: new URL('./vendor/pdfjs/cmaps/', import.meta.url).href, cMapPacked: true,
      standardFontDataUrl: new URL('./vendor/pdfjs/standard_fonts/', import.meta.url).href,
      wasmUrl: new URL('./vendor/pdfjs/wasm/', import.meta.url).href,
      useSystemFonts: true,
    });
    state.loadingTask.onProgress = ({loaded, total}) => {
      if (generation === state.generation && !state.pdf) {
        readerFeedback(total > 0 ? `正在下载 PDF… ${Math.min(100, Math.round(loaded / total * 100))}%` : '正在下载 PDF…');
      }
    };
    const pdf = await state.loadingTask.promise;
    if (generation !== state.generation) return;
    state.pdf = pdf;
    state.page = Math.min(Math.max(state.recent[book.path]?.page || 1, 1), pdf.numPages);
    $('#page-count').textContent = pdf.numPages;
    $('#page-input').max = pdf.numPages;
    for (const id of ['page-input', 'zoom-in', 'zoom-out']) $(`#${id}`).disabled = false;
    remember(book, state.page);
    await renderPage();
  } catch (error) {
    if (generation !== state.generation) return;
    readerFeedback(`无法打开 PDF：${error.message || error}`, false);
    $('#reader-status').textContent = '打开失败';
  }
}

async function renderPage() {
  if (!state.pdf || !state.reader) return;
  const generation = state.generation;
  const serial = ++state.renderSerial;
  const pageNumber = state.page;
  if (state.renderTask) { state.renderTask.cancel(); state.renderTask = null; }
  $('#page-input').value = pageNumber;
  $('#prev-page').disabled = pageNumber <= 1;
  $('#next-page').disabled = pageNumber >= state.pdf.numPages;
  $('#zoom-label').textContent = state.zoom === 1 ? '适合宽度' : `${Math.round(state.zoom * 100)}%`;
  $('#reader-status').textContent = '正在渲染…';
  readerFeedback(`正在加载第 ${pageNumber} 页…`);
  try {
    await paintFeedback();
    if (generation !== state.generation || serial !== state.renderSerial) return;
    const page = await state.pdf.getPage(pageNumber);
    if (generation !== state.generation || pageNumber !== state.page || serial !== state.renderSerial) return;
    const base = page.getViewport({scale: 1});
    const available = Math.max(160, Math.min(920, $('#reader-scroll').clientWidth - 32));
    const scale = available / base.width * state.zoom;
    const viewport = page.getViewport({scale});
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    // Render offscreen so a cancelled/slow page never clears the displayed page.
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * ratio); canvas.height = Math.floor(viewport.height * ratio);
    const context = canvas.getContext('2d');
    const task = page.render({canvasContext: context, canvas, viewport, transform: ratio === 1 ? null : [ratio,0,0,ratio,0,0]});
    state.renderTask = task;
    await task.promise;
    if (generation !== state.generation || serial !== state.renderSerial) return;
    state.renderTask = null;
    const display = $('#pdf-canvas');
    display.width = canvas.width; display.height = canvas.height;
    display.style.width = `${viewport.width}px`; display.style.height = `${viewport.height}px`;
    display.getContext('2d').drawImage(canvas, 0, 0);
    display.hidden = false;
    readerFeedback('', false);
    $('#reader-status').textContent = `第 ${pageNumber} 页`;
  } catch (error) {
    if (error.name !== 'RenderingCancelledException' && generation === state.generation && serial === state.renderSerial) {
      state.renderTask = null;
      readerFeedback(`页面渲染失败：${error.message || error}`, false);
      $('#reader-status').textContent = '渲染失败';
    }
  }
}

function goToPage(page) {
  if (!state.pdf) return;
  const next = Math.min(Math.max(Number(page) || 1, 1), state.pdf.numPages);
  if (next === state.page) { $('#page-input').value = next; return; }
  state.page = next; remember(state.reader, next);
  $('#reader-scroll').scrollTo(0, 0);
  renderPage();
}

async function closeReader() {
  state.generation++;
  state.renderSerial++;
  if (state.renderTask) { state.renderTask.cancel(); state.renderTask = null; }
  if (state.loadingTask) { try { await state.loadingTask.destroy(); } catch {} state.loadingTask = null; }
  state.pdf = null; state.reader = null;
  readerFeedback('', false);
  if ($('#reader').open) $('#reader').close();
}

function bindReaderGestures() {
  const surface = $('#reader-scroll');
  let gesture = null;
  const reset = () => { gesture = null; surface.classList.remove('dragging'); };
  surface.addEventListener('pointerdown', event => {
    // A second finger belongs to browser pinch zoom, never to pagination.
    if (!event.isPrimary) { reset(); return; }
    if (event.button !== 0 || !state.pdf || state.busy) return;
    gesture = {
      id: event.pointerId, x: event.clientX, y: event.clientY,
      left: surface.scrollLeft, top: surface.scrollTop,
      maxX: surface.scrollWidth - surface.clientWidth,
      maxY: surface.scrollHeight - surface.clientHeight,
      generation: state.generation, serial: state.renderSerial,
    };
    surface.setPointerCapture(event.pointerId);
  });
  surface.addEventListener('pointermove', event => {
    if (!gesture || event.pointerId !== gesture.id) return;
    const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
    if (!gesture.axis) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return;
      gesture.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      const delta = gesture.axis === 'x' ? dx : dy;
      const start = gesture.axis === 'x' ? gesture.left : gesture.top;
      const max = gesture.axis === 'x' ? gesture.maxX : gesture.maxY;
      // Lock the decision at gesture start: reaching an edge while panning
      // cannot unexpectedly turn a page during the same drag.
      gesture.turn = max <= 2 || (delta > 0 ? start >= max - 2 : start <= 2);
    }
    surface.classList.add('dragging');
    if (!gesture.turn) surface.scrollTo(gesture.left - dx, gesture.top - dy);
  });
  surface.addEventListener('pointerup', event => {
    if (!gesture || event.pointerId !== gesture.id) return;
    const current = gesture;
    reset();
    if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
    if (!current.turn || state.busy || current.generation !== state.generation || current.serial !== state.renderSerial) return;
    const dx = event.clientX - current.x, dy = event.clientY - current.y;
    const delta = current.axis === 'x' ? dx : dy;
    const cross = current.axis === 'x' ? dy : dx;
    if (Math.abs(delta) < 60 || Math.abs(delta) < Math.abs(cross) * 1.2) return;
    const next = state.page + Math.sign(delta);
    if (next < 1 || next > state.pdf.numPages) { notify(next < 1 ? '已经是第一页' : '已经是最后一页'); return; }
    goToPage(next);
  });
  surface.addEventListener('pointercancel', reset);
  surface.addEventListener('lostpointercapture', reset);
  $('#reader').addEventListener('close', reset);
}

function bindEvents() {
  bindReaderGestures();
  document.querySelectorAll('.nav-item').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
  $('#search-input').addEventListener('input', event => { state.query = event.target.value; render(); });
  $('#topic-select').addEventListener('change', event => { state.topic = event.target.value; render(); });
  $('#sort-select').addEventListener('change', event => { state.sort = event.target.value; render(); });
  $('#type-select').addEventListener('change', event => { state.type = event.target.value; render(); });
  $('#grid-button').addEventListener('click', () => { state.layout = 'grid'; render(); });
  $('#list-button').addEventListener('click', () => { state.layout = 'list'; render(); });
  $('#clear-filters').addEventListener('click', () => { state.query = ''; state.topic = ''; state.type = ''; state.reviewFilter = 'all'; $('#search-input').value = ''; $('#topic-select').value = ''; $('#type-select').value = ''; setView('all'); });
  $('#menu-button').addEventListener('click', () => {
    const open = $('#sidebar').classList.toggle('open');
    $('#menu-button').setAttribute('aria-expanded', String(open));
  });
  $('#reader').addEventListener('close', () => { if (!$('#reader').open && state.reader) closeReader(); });
  $('#reader-back').addEventListener('click', closeReader); $('#reader-close').addEventListener('click', closeReader);
  $('#prev-page').addEventListener('click', () => goToPage(state.page - 1));
  $('#next-page').addEventListener('click', () => goToPage(state.page + 1));
  $('#page-input').addEventListener('change', event => goToPage(event.target.value));
  $('#zoom-in').addEventListener('click', () => { state.zoom = Math.min(state.zoom + .2, 3); renderPage(); });
  $('#zoom-out').addEventListener('click', () => { state.zoom = Math.max(state.zoom - .2, .4); renderPage(); });
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { if (!state.reader) { event.preventDefault(); $('#search-input').focus(); } }
    if (event.key === 'Escape' && !state.reader && $('#sidebar').classList.contains('open')) {
      $('#sidebar').classList.remove('open'); $('#menu-button').setAttribute('aria-expanded', 'false'); $('#menu-button').focus();
    }
    if (state.reader && event.key === 'ArrowLeft' && event.target.tagName !== 'INPUT') goToPage(state.page - 1);
    if (state.reader && event.key === 'ArrowRight' && event.target.tagName !== 'INPUT') goToPage(state.page + 1);
  });
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.reader) renderPage(); }, 180); });
}

async function init() {
  bindEvents();
  try {
    const response = await fetch(new URL('./books.json', import.meta.url));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const catalog = await response.json();
    state.books = catalog.books;
    state.localMode = catalog.localMode === true;
    if (state.localMode) await initReview();
    state.category = new URLSearchParams(location.search).get('category') || '';
    if (!state.books.some(book => book.category === state.category)) state.category = '';
    renderSidebar(); setView('all', state.category);
  } catch (error) {
    $('#results-count').textContent = '无法读取灰库';
    $('#empty-state').hidden = false;
    $('#empty-state strong').textContent = '书目加载失败';
    $('#empty-state p').textContent = '请检查网络后刷新页面重试。';
    notify(`无法读取灰库：${error.message || error}`);
  }
}

init();

function reviewChoice(book) {
  const review = state.reviews[book.path];
  return review && !review.stale ? review.choice : 'unreviewed';
}

function createReviewTools(book) {
  const tools = document.createElement('div'); tools.className = 'review-tools';
  for (const [choice, label] of [['keep', '保留'], ['discard', '不要'], ['unreviewed', '重置']]) {
    const button = document.createElement('button'); button.type = 'button';
    button.dataset.review = choice; button.textContent = label;
    button.setAttribute('aria-label', `${label} ${book.name}`);
    button.setAttribute('aria-pressed', String(reviewChoice(book) === choice));
    if (choice === 'unreviewed') button.className = 'review-reset';
    button.addEventListener('click', async () => {
      tools.querySelectorAll('button').forEach(control => control.disabled = true);
      try {
        const response = await fetch('/api/review', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Book-Review': '1'}, body: JSON.stringify({path: book.path, choice})});
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        state.reviews = (await response.json()).reviews;
        if (state.reviewFilter !== 'all') {
          render(); document.querySelector('.review-filters button[aria-pressed="true"]')?.focus();
        } else {
          tools.querySelectorAll('button').forEach(control => control.setAttribute('aria-pressed', String(control.dataset.review === choice)));
          updateReviewSummary();
        }
        notify(choice === 'unreviewed' ? '已恢复为未标记' : `已标记${choice === 'keep' ? '保留' : '不要'}，原文件未删除`);
      } catch (error) { notify(`标记未保存，请重试：${error.message}`); }
      finally { tools.querySelectorAll('button').forEach(control => control.disabled = false); }
    });
    tools.append(button);
  }
  if (state.reviews[book.path]?.stale) {
    const warning = document.createElement('span'); warning.className = 'review-label'; warning.textContent = '文件已变化，请重新标记'; tools.append(warning);
  }
  return tools;
}

async function initReview() {
  const response = await fetch('/api/review');
  if (!response.ok) throw new Error('本地整理记录加载失败，请检查后端服务');
  state.reviews = (await response.json()).reviews;
  document.title = '本地整理 · 灰库';
  document.querySelector('.local-badge').textContent = '本地整理模式';
  const banner = document.createElement('section'); banner.className = 'review-banner';
  const heading = document.createElement('strong'); heading.textContent = '本地整理 · 所有格式均可标记';
  const hint = document.createElement('p'); hint.textContent = '选择“保留”或“不要”，随时可以重置。标记保存到本机，当前操作不会删除文件，也不会发布到网站。';
  const summary = document.createElement('p'); summary.id = 'review-summary';
  const filters = document.createElement('div'); filters.className = 'review-filters'; filters.setAttribute('role', 'group'); filters.setAttribute('aria-label', '整理状态');
  for (const [value, label] of [['all', '全部'], ['unreviewed', '未标记'], ['keep', '保留'], ['discard', '不要']]) {
    const button = document.createElement('button'); button.type = 'button'; button.dataset.filter = value; button.textContent = label;
    button.addEventListener('click', () => { state.reviewFilter = value; render(); }); filters.append(button);
  }
  const exportLink = document.createElement('a'); exportLink.href = '/api/review/export'; exportLink.textContent = '导出标记清单 ↓'; exportLink.download = 'library-review.json';
  banner.append(heading, hint, summary, filters, exportLink);
  document.querySelector('.content').prepend(banner);
}

function updateReviewSummary() {
  const discarded = state.books.filter(book => reviewChoice(book) === 'discard');
  const keep = state.books.filter(book => reviewChoice(book) === 'keep').length;
  $('#review-summary').textContent = `保留 ${keep} 份 · 不要 ${discarded.length} 份 · 未标记 ${state.books.length - keep - discarded.length} 份 · 待释放 ${(discarded.reduce((total, book) => total + book.size, 0) / 1048576).toFixed(1)} MB`;
  document.querySelectorAll('.review-filters button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.filter === state.reviewFilter)));
}

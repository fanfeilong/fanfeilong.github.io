// Load the reader only when a PDF is opened; browsing the catalog stays light.
let pdfjsPromise;
function loadPdfjs() {
  return pdfjsPromise ??= import('./vendor/pdfjs/build/pdf.mjs').then(lib => {
    lib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/build/pdf.worker.mjs', import.meta.url).href;
    return lib;
  }).catch(error => { pdfjsPromise = null; throw error; });
}

const SITE_BASE = new URL('../../', import.meta.url);
const $ = (selector) => document.querySelector(selector);
const state = {
  localMode: false, reviews: {}, reviewFilter: 'all',
  books: [], view: 'all', category: '', topic: '', type: '', query: '', sort: 'name', layout: 'grid',
  favorites: readStore('book-library-favorites', []), recent: readStore('book-library-recent', {}),
  reader: null, pdf: null, loadingTask: null, renderTask: null, page: 1, zoom: 1, generation: 0, renderSerial: 0, busy: false,
  openRequest: 0, libraryUrl: new URL(location.href).href, shareUrl: '',
  fit: 'page', trim: 0, columns: 1, column: 0, cropCache: new Map(),
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
function resourceUrl(book, page) {
  const url = new URL(`read/${encodeURIComponent(book.id)}/`, SITE_BASE);
  if (page !== undefined) url.searchParams.set('page', String(page));
  return url;
}
function routeId() {
  const relative = location.pathname.slice(SITE_BASE.pathname.length);
  const match = /^read\/([^/]+)\/(?:index\.html)?$/.exec(relative);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return ''; }
}
function requestedPage() {
  const value = new URL(location.href).searchParams.get('page');
  if (value === null) return undefined;
  return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Math.max(1, Number(value)) : 1;
}
function resourceMessage(title, message, book = null) {
  $('#resource-error').hidden = false;
  $('#resource-error-title').textContent = title;
  $('#resource-error-text').textContent = message;
  $('#resource-original').hidden = !book;
  if (book) $('#resource-original').href = fileUrl(book);
}
async function restoreRoute() {
  const id = routeId();
  if (id !== null) {
    const book = state.books.find(book => book.id === id);
    if (book) await openBook(book, {page:requestedPage(), historyMode:'none'});
    else {
      await closeReader({navigate:false});
      document.title = '资源已不可用 · 灰库';
      resourceMessage('资源已不可用', '此链接对应的资源不存在或已移除，请返回灰库查找其他资料。');
    }
  } else {
    await closeReader({navigate:false});
    $('#resource-error').hidden = true;
    document.title = state.localMode ? '本地整理 · 灰库' : '灰库 · Fan Feilong';
  }
}

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
  $('#reader-share').disabled = busy || !state.pdf || !state.shareUrl;
  $('#reader-scroll').setAttribute('aria-busy', String(busy));
  $('#reader-loading').hidden = !message;
  $('#reader-loading-text').textContent = message;
  $('#reader-loading progress').hidden = !busy;
}

// Allow the loading state to paint before PDF.js starts CPU-heavy work.
const paintFeedback = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));

function hideReaderSettings() {
  const panel = $('#reader-settings');
  if (typeof panel.hidePopover === 'function') panel.hidePopover();
  else panel.hidden = true;
  $('#reader-settings-toggle').setAttribute('aria-expanded', 'false');
}

async function openBook(book, {page: sharedPage, historyMode = 'push'} = {}) {
  const opening = ++state.openRequest;
  if (routeId() === null) state.libraryUrl = location.href;
  await closeReader({navigate:false, cancelOpen:false});
  if (opening !== state.openRequest) return;
  $('#resource-error').hidden = true;
  state.shareUrl = ''; $('#reader-share-panel').hidden = true; $('#reader-share-status').textContent = '';
  if (historyMode === 'push') history.pushState({libraryReturn:state.libraryUrl}, '', resourceUrl(book));
  document.title = `${book.name} · 灰库`;
  if (book.extension !== 'pdf') {
    remember(book); render();
    resourceMessage(book.name, '此格式请打开原文件阅读。', book);
    return;
  }
  const generation = ++state.generation;
  state.reader = book;
  hideReaderSettings();
  $('#reader-page-summary').textContent = '– / –';
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
  state.zoom = 1; state.fit = innerWidth <= 800 ? 'content' : 'page';
  state.trim = 0; state.columns = 1; state.column = 0; state.cropCache.clear();
  $('#reader-fit').value = state.fit; $('#reader-trim').value = 0;
  $('#reader-trim-value').textContent = '0%'; $('#reader-columns').value = '1';
  $('#zoom-label').textContent = '适合宽度';
  for (const control of document.querySelectorAll('.reader-options input, .reader-options select, .reader-options button')) control.disabled = true;
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
    state.page = Math.min(Math.max(sharedPage ?? state.recent[book.path]?.page ?? 1, 1), pdf.numPages);
    $('#page-count').textContent = pdf.numPages;
    $('#page-input').max = pdf.numPages;
    for (const id of ['page-input', 'zoom-in', 'zoom-out']) $(`#${id}`).disabled = false;
    for (const control of document.querySelectorAll('.reader-options input, .reader-options select, .reader-options button')) control.disabled = false;
    remember(book, state.page);
    await renderPage();
  } catch (error) {
    if (generation !== state.generation) return;
    readerFeedback(`无法打开 PDF：${error.message || error}`, false);
    $('#reader-status').textContent = '打开失败';
  }
}

function zoomAnchor(clientX, clientY) {
  const rect = $('#pdf-canvas').getBoundingClientRect();
  return {x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)), clientX, clientY};
}
function centerAnchor() {
  const rect = $('#reader-scroll').getBoundingClientRect();
  return zoomAnchor(rect.left + rect.width / 2, rect.top + rect.height / 2);
}
function setZoom(zoom, anchor = centerAnchor()) {
  if (!state.pdf) return;
  state.zoom = Math.max(.5, Math.min(5, zoom));
  renderPage(anchor);
}

// Analyze a small raster, including images and diagrams (not only PDF text).
// Keep a safety margin and cap automatic cuts; the original stays one click away.
async function contentBounds(page, valid) {
  if (state.cropCache.has(page.pageNumber)) return state.cropCache.get(page.pageNumber);
  const base = page.getViewport({scale: 1});
  const viewport = page.getViewport({scale: Math.min(1, 480 / base.width, 720 / base.height)});
  const preview = document.createElement('canvas');
  preview.width = Math.ceil(viewport.width); preview.height = Math.ceil(viewport.height);
  const task = page.render({canvas: preview, canvasContext: preview.getContext('2d'), viewport});
  state.renderTask = task;
  await task.promise;
  if (!valid()) return null;
  const {width, height} = preview;
  const pixels = preview.getContext('2d').getImageData(0, 0, width, height).data;
  let left = width, right = -1, top = height, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    if (pixels[i + 3] > 32 && Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 235) {
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  const result = right < left ? {left:0, top:0, right:1, bottom:1} : {
    left: Math.min(.15, Math.max(0, (left - 6) / width)),
    right: Math.max(.85, Math.min(1, (right + 7) / width)),
    top: Math.min(.1, Math.max(0, (top - 6) / height)),
    bottom: Math.max(.9, Math.min(1, (bottom + 7) / height)),
  };
  state.cropCache.set(page.pageNumber, result);
  return result;
}

async function renderPage(anchor = null) {
  if (!state.pdf || !state.reader) return;
  const generation = state.generation;
  const serial = ++state.renderSerial;
  const pageNumber = state.page;
  if (state.renderTask) { state.renderTask.cancel(); state.renderTask = null; }
  $('#page-input').value = pageNumber;
  $('#reader-page-summary').textContent = `${pageNumber} / ${state.pdf.numPages}`;
  $('#reader-columns').options[1].textContent = `双栏 · ${state.column === 0 ? '左栏' : '右栏'}`;
  $('#prev-page').disabled = pageNumber <= 1 && state.column === 0;
  $('#next-page').disabled = pageNumber >= state.pdf.numPages && state.column === state.columns - 1;
  $('#zoom-label').textContent = state.zoom === 1 ? '适合宽度' : `${Math.round(state.zoom * 100)}%`;
  $('#reader-status').textContent = '正在渲染…';
  readerFeedback(`正在加载第 ${pageNumber} 页…`);
  const valid = () => generation === state.generation && serial === state.renderSerial;
  try {
    await paintFeedback();
    if (!valid()) return;
    const page = await state.pdf.getPage(pageNumber);
    if (generation !== state.generation || pageNumber !== state.page || serial !== state.renderSerial) return;
    const base = page.getViewport({scale: 1});
    const bounds = state.fit === 'content' ? await contentBounds(page, valid) : {left:0, top:0, right:1, bottom:1};
    if (!valid() || !bounds) return;
    let left = bounds.left + state.trim / 100, right = bounds.right - state.trim / 100;
    if (state.columns === 2) {
      const middle = (left + right) / 2;
      if (state.column === 0) right = middle + .015;
      else left = middle - .015;
    }
    const cropWidth = base.width * (right - left), cropHeight = base.height * (bounds.bottom - bounds.top);
    const surface = $('#reader-scroll');
    const style = getComputedStyle(surface);
    const available = Math.max(120, Math.min(920, surface.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)));
    const scale = available / cropWidth * state.zoom;
    const viewport = page.getViewport({scale});
    const width = cropWidth * scale, height = cropHeight * scale;
    // Bound both pixel area and edge length to protect mobile canvas memory.
    const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(10_000_000 / (width * height)), 8192 / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(width * ratio)); canvas.height = Math.max(1, Math.floor(height * ratio));
    const context = canvas.getContext('2d');
    const task = page.render({canvasContext: context, canvas, viewport, transform: [ratio,0,0,ratio,-left * viewport.width * ratio,-bounds.top * viewport.height * ratio]});
    state.renderTask = task;
    await task.promise;
    if (generation !== state.generation || serial !== state.renderSerial) return;
    state.renderTask = null;
    const display = $('#pdf-canvas');
    display.width = canvas.width; display.height = canvas.height;
    display.style.width = `${width}px`; display.style.height = `${height}px`;
    display.getContext('2d').drawImage(canvas, 0, 0);
    display.hidden = false;
    if (anchor) {
      const rect = display.getBoundingClientRect();
      surface.scrollBy(rect.left + anchor.x * rect.width - anchor.clientX, rect.top + anchor.y * rect.height - anchor.clientY);
    }
    state.shareUrl = resourceUrl(state.reader, pageNumber).href;
    $('#reader-share-link').value = state.shareUrl;
    history.replaceState({...history.state, libraryReturn:state.libraryUrl}, '', state.shareUrl);
    readerFeedback('', false);
    $('#reader-status').textContent = `第 ${pageNumber} 页${state.columns === 2 ? (state.column === 0 ? ' · 左栏' : ' · 右栏') : ''}`;
  } catch (error) {
    if (error.name !== 'RenderingCancelledException' && generation === state.generation && serial === state.renderSerial) {
      state.renderTask = null;
      readerFeedback(`页面渲染失败：${error.message || error}`, false);
      $('#reader-status').textContent = '渲染失败';
    }
  }
}

function goToPage(page, column = 0) {
  if (!state.pdf) return;
  const next = Math.min(Math.max(Math.trunc(Number(page)) || 1, 1), state.pdf.numPages);
  if (next === state.page && column === state.column) { $('#page-input').value = next; return; }
  state.page = next; state.column = column; remember(state.reader, next);
  $('#reader-scroll').scrollTo(0, 0);
  renderPage();
}
function stepReading(direction) {
  if (!state.pdf) return;
  const position = (state.page - 1) * state.columns + state.column + direction;
  if (position < 0 || position >= state.pdf.numPages * state.columns) return;
  goToPage(Math.floor(position / state.columns) + 1, position % state.columns);
}

async function closeReader({navigate = true, cancelOpen = true} = {}) {
  hideReaderSettings();
  if (cancelOpen) state.openRequest++;
  state.generation++; state.renderSerial++;
  if (state.renderTask) { state.renderTask.cancel(); state.renderTask = null; }
  const loadingTask = state.loadingTask; state.loadingTask = null;
  state.pdf = null; state.reader = null; state.shareUrl = '';
  clearTimeout(shareTimer);
  $('#reader-share-panel').hidden = true; $('#reader-share-status').textContent = '';
  readerFeedback('', false);
  if ($('#reader').open) $('#reader').close();
  if (navigate && routeId() !== null) {
    const candidate = history.state?.libraryReturn || state.libraryUrl;
    const target = new URL(candidate, SITE_BASE);
    history.replaceState({}, '', target.origin === location.origin && !target.pathname.includes('/read/') ? target : SITE_BASE);
    document.title = state.localMode ? '本地整理 · 灰库' : '灰库 · Fan Feilong';
  }
  if (loadingTask) { try { await loadingTask.destroy(); } catch {} }
}

let shareTimer, lastShareMessage = '';
async function copyReadingLink() {
  if (state.busy || !state.shareUrl) return;
  const url = state.shareUrl, page = state.page;
  clearTimeout(shareTimer);
  $('#reader-share-panel').hidden = true;
  let message;
  try {
    await navigator.clipboard.writeText(url);
    message = `已复制第 ${page} 页阅读链接`;
  } catch {
    if (!state.reader || state.shareUrl !== url) return;
    message = '无法自动复制，请手动复制阅读链接';
    $('#reader-share-panel').hidden = false;
    $('#reader-share-link').value = url;
    $('#reader-share-link').focus(); $('#reader-share-link').select();
  }
  if (!state.reader || state.shareUrl !== url) return;
  if (message === lastShareMessage) message += '\u00a0';
  lastShareMessage = message;
  $('#reader-share-status').textContent = message;
  shareTimer = setTimeout(() => { $('#reader-share-status').textContent = ''; }, 3000);
}

function bindReaderGestures() {
  const surface = $('#reader-scroll'), canvas = $('#pdf-canvas');
  const points = new Map();
  let gesture = null, pinch = null, lastTap = null, lastTouchZoom = -Infinity;
  let wheel = null, wheelTimer, wheelZoom = null, zoomTimer;
  const clearPreview = () => { canvas.style.transform = ''; canvas.style.transformOrigin = ''; };
  const previewZoom = (zoom, anchor, dx = 0, dy = 0) => {
    canvas.style.transformOrigin = `${anchor.x * canvas.clientWidth}px ${anchor.y * canvas.clientHeight}px`;
    canvas.style.transform = `translate(${dx}px, ${dy}px) scale(${zoom / state.zoom})`;
  };
  const resetDrag = () => { gesture = null; surface.classList.remove('dragging'); };
  const reset = () => {
    resetDrag(); points.clear(); pinch = null; lastTap = null;
    clearTimeout(wheelTimer); clearTimeout(zoomTimer); wheel = null; wheelZoom = null; clearPreview();
  };
  const distance = () => { const [a, b] = [...points.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  const midpoint = () => { const [a, b] = [...points.values()]; return {x:(a.x + b.x) / 2, y:(a.y + b.y) / 2}; };
  surface.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !state.pdf || state.busy || wheelZoom) return;
    points.set(event.pointerId, {x:event.clientX, y:event.clientY});
    surface.setPointerCapture(event.pointerId);
    if (points.size === 2) {
      resetDrag(); lastTap = null;
      const middle = midpoint();
      pinch = {distance: Math.max(1, distance()), zoom:state.zoom, target:state.zoom,
        anchor:zoomAnchor(middle.x, middle.y), generation:state.generation};
      return;
    }
    if (points.size !== 1 || !event.isPrimary) return;
    gesture = {
      id: event.pointerId, x: event.clientX, y: event.clientY,
      left: surface.scrollLeft, top: surface.scrollTop,
      maxX: surface.scrollWidth - surface.clientWidth,
      maxY: surface.scrollHeight - surface.clientHeight,
      generation: state.generation, serial: state.renderSerial,
    };
  });
  surface.addEventListener('pointermove', event => {
    if (!points.has(event.pointerId)) return;
    points.set(event.pointerId, {x:event.clientX, y:event.clientY});
    if (pinch && points.size === 2) {
      pinch.target = Math.max(.5, Math.min(5, pinch.zoom * distance() / pinch.distance));
      const middle = midpoint();
      previewZoom(pinch.target, pinch.anchor, middle.x - pinch.anchor.clientX, middle.y - pinch.anchor.clientY);
      return;
    }
    if (!gesture || event.pointerId !== gesture.id) return;
    const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
    if (!gesture.axis) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return;
      gesture.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      const delta = gesture.axis === 'x' ? dx : dy;
      const start = gesture.axis === 'x' ? gesture.left : gesture.top;
      const max = gesture.axis === 'x' ? gesture.maxX : gesture.maxY;
      // A finger moving left/up advances; panning has priority until the edge.
      gesture.turn = max <= 2 || (delta < 0 ? start >= max - 2 : start <= 2);
    }
    surface.classList.add('dragging');
    if (!gesture.turn) surface.scrollTo(gesture.left - dx, gesture.top - dy);
  });
  surface.addEventListener('pointerup', event => {
    const current = gesture;
    if (pinch) {
      const currentPinch = pinch;
      const middle = points.size === 2 ? midpoint() : {x:currentPinch.anchor.clientX, y:currentPinch.anchor.clientY};
      pinch = null; resetDrag(); clearPreview();
      if (currentPinch.generation === state.generation) setZoom(currentPinch.target, {...currentPinch.anchor, clientX:middle.x, clientY:middle.y});
    }
    points.delete(event.pointerId);
    if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
    if (!current || event.pointerId !== current.id) return;
    resetDrag();
    if (state.busy || current.generation !== state.generation || current.serial !== state.renderSerial) return;
    const dx = event.clientX - current.x, dy = event.clientY - current.y;
    if (Math.hypot(dx, dy) < 8 && event.pointerType === 'touch') {
      const now = performance.now();
      if (lastTap && now - lastTap.time < 320 && Math.hypot(lastTap.x - event.clientX, lastTap.y - event.clientY) < 24) {
        lastTap = null; lastTouchZoom = now;
        setZoom(state.zoom > 1.05 ? 1 : 2, zoomAnchor(event.clientX, event.clientY));
      } else lastTap = {x:event.clientX, y:event.clientY, time:now};
      return;
    }
    lastTap = null;
    const delta = current.axis === 'x' ? dx : dy, cross = current.axis === 'x' ? dy : dx;
    if (!current.turn || Math.abs(delta) < 60 || Math.abs(delta) < Math.abs(cross) * 1.2) return;
    stepReading(-Math.sign(delta));
  });
  surface.addEventListener('pointercancel', reset);
  surface.addEventListener('lostpointercapture', event => {
    if (points.has(event.pointerId)) reset();
  });
  surface.addEventListener('dblclick', event => {
    if (!state.pdf || state.busy || performance.now() - lastTouchZoom < 500 || event.sourceCapabilities?.firesTouchEvents) return;
    event.preventDefault(); setZoom(state.zoom > 1.05 ? 1 : 2, zoomAnchor(event.clientX, event.clientY));
  });
  surface.addEventListener('wheel', event => {
    if (!state.pdf) return;
    // Edge/Chrome trackpad pinch arrives as ctrl+wheel, distinct from scrolling.
    if (event.ctrlKey) {
      event.preventDefault();
      if (state.busy || points.size) return;
      if (!wheelZoom) wheelZoom = {zoom:state.zoom, anchor:zoomAnchor(event.clientX, event.clientY), generation:state.generation};
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? surface.clientHeight : 1;
      wheelZoom.zoom = Math.max(.5, Math.min(5, wheelZoom.zoom * Math.exp(-event.deltaY * unit * .005)));
      previewZoom(wheelZoom.zoom, wheelZoom.anchor);
      clearTimeout(zoomTimer);
      zoomTimer = setTimeout(() => {
        const current = wheelZoom; wheelZoom = null; clearPreview();
        if (current && current.generation === state.generation) setZoom(current.zoom, current.anchor);
      }, 140);
      return;
    }
    event.preventDefault(); // Contain horizontal overscroll/history navigation too.
    if (points.size || wheelZoom) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? surface.clientHeight : 1;
    const dx = event.deltaX * unit, dy = event.deltaY * unit;
    if (!wheel) wheel = {x:0, y:0, left:surface.scrollLeft, top:surface.scrollTop,
      maxX:surface.scrollWidth - surface.clientWidth, maxY:surface.scrollHeight - surface.clientHeight, turned:false};
    clearTimeout(wheelTimer); wheelTimer = setTimeout(() => { wheel = null; }, 240);
    wheel.x += dx; wheel.y += dy;
    if (wheel.turned || state.busy) return;
    if (!wheel.axis && Math.max(Math.abs(wheel.x), Math.abs(wheel.y)) >= 12) {
      wheel.axis = Math.abs(wheel.x) > Math.abs(wheel.y) ? 'x' : 'y';
      const delta = wheel.axis === 'x' ? wheel.x : wheel.y;
      const start = wheel.axis === 'x' ? wheel.left : wheel.top;
      const max = wheel.axis === 'x' ? wheel.maxX : wheel.maxY;
      wheel.turn = max <= 2 || (delta > 0 ? start >= max - 2 : start <= 2);
    }
    if (!wheel.turn) { surface.scrollBy(dx, dy); return; }
    const delta = wheel.axis === 'x' ? wheel.x : wheel.y, cross = wheel.axis === 'x' ? wheel.y : wheel.x;
    if (Math.abs(delta) >= 100 && Math.abs(delta) >= Math.abs(cross) * 1.2) {
      wheel.turned = true; stepReading(Math.sign(delta));
    }
  }, {passive:false});
  $('#reader').addEventListener('close', reset);
}

function bindEvents() {
  bindReaderGestures();
  if ('CommandEvent' in window) {
    document.addEventListener('command', event => {
      if (event.command === '--copy' && event.source === $('#reader-share')) copyReadingLink();
    }, true);
  } else $('#reader-share').addEventListener('click', copyReadingLink);
  $('#reader-share-done').addEventListener('click', () => { $('#reader-share-panel').hidden = true; $('#reader-share').focus(); });
  window.addEventListener('popstate', () => { if (state.books.length) restoreRoute(); });
  const settings = $('#reader-settings'), settingsToggle = $('#reader-settings-toggle');
  if (typeof settings.showPopover === 'function') {
    // Native popovers keep the PDF layout stable while settings are open.
    settings.hidden = false;
    settings.addEventListener('beforetoggle', event => settingsToggle.setAttribute('aria-expanded', String(event.newState === 'open')));
  } else {
    // Older browsers still get a working disclosure without a dependency.
    settings.removeAttribute('popover');
    settingsToggle.removeAttribute('popovertarget');
    settingsToggle.addEventListener('click', () => {
      settings.hidden = !settings.hidden;
      settingsToggle.setAttribute('aria-expanded', String(!settings.hidden));
    });
  }
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
  $('#prev-page').addEventListener('click', () => stepReading(-1));
  $('#next-page').addEventListener('click', () => stepReading(1));
  $('#page-input').addEventListener('change', event => goToPage(event.target.value));
  $('#zoom-in').addEventListener('click', () => setZoom(state.zoom + .2));
  $('#zoom-out').addEventListener('click', () => setZoom(state.zoom - .2));
  $('#reader-fit').addEventListener('change', event => { state.fit = event.target.value; state.zoom = 1; $('#reader-scroll').scrollTo(0, 0); renderPage(); });
  $('#reader-trim').addEventListener('input', event => { $('#reader-trim-value').textContent = `${event.target.value}%`; });
  $('#reader-trim').addEventListener('change', event => { state.trim = Number(event.target.value); renderPage(); });
  $('#reader-columns').addEventListener('change', event => { state.columns = Number(event.target.value); state.column = 0; state.zoom = 1; $('#reader-scroll').scrollTo(0, 0); renderPage(); });
  $('#reader-reset').addEventListener('click', () => {
    state.fit = 'page'; state.trim = 0; state.columns = 1; state.column = 0; state.zoom = 1;
    $('#reader-fit').value = 'page'; $('#reader-trim').value = 0; $('#reader-trim-value').textContent = '0%'; $('#reader-columns').value = '1';
    $('#reader-scroll').scrollTo(0, 0); renderPage();
  });
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { if (!state.reader) { event.preventDefault(); $('#search-input').focus(); } }
    if (event.key === 'Escape' && !state.reader && $('#sidebar').classList.contains('open')) {
      $('#sidebar').classList.remove('open'); $('#menu-button').setAttribute('aria-expanded', 'false'); $('#menu-button').focus();
    }
    if (state.reader && !['INPUT', 'SELECT'].includes(event.target.tagName) && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault(); stepReading(event.key === 'ArrowRight' ? 1 : -1);
    }
  });
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.reader) renderPage(); }, 180); });
}

async function init() {
  bindEvents();
  try {
    const catalogUrl = new URL('./books.json', import.meta.url);
    catalogUrl.searchParams.set('v', new URL(import.meta.url).pathname.split('/').pop());
    const response = await fetch(catalogUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const catalog = await response.json();
    state.books = catalog.books;
    state.localMode = catalog.localMode === true;
    if (state.localMode) await initReview();
    state.category = new URLSearchParams(location.search).get('category') || '';
    if (!state.books.some(book => book.category === state.category)) state.category = '';
    renderSidebar(); setView('all', state.category);
    if (routeId() !== null) state.libraryUrl = SITE_BASE.href;
    await restoreRoute();
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

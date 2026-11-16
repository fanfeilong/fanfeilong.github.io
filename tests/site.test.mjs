import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, stat, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const staticBase = 'http://127.0.0.1:18765';
const localBase = 'http://127.0.0.1:18766';
let browser, staticServer, localServer, temporary, books;
const launch = args => spawn('python3', args, {stdio: 'ignore'});
async function ready(url) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not start: ${url}`);
}
const startLocal = () => launch(['books/book-manager/server.py', '--port', '18766', '--state-file', join(temporary, 'reviews.json')]);
async function stop(server) { if (server?.exitCode === null) { const exited = new Promise(resolve => server.once('exit', resolve)); server.kill(); await exited; } }
async function mark(path, choice, extraHeaders = {}) {
  return fetch(`${localBase}/api/review`, {method:'POST', headers:{'Content-Type':'application/json','X-Book-Review':'1',...extraHeaders}, body:JSON.stringify({path,choice})});
}
before(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'library-test-'));
  await mkdir('artifacts', {recursive:true});
  staticServer = launch(['-m','http.server','18765','--bind','127.0.0.1','--directory','dist']);
  localServer = startLocal();
  await Promise.all([ready(staticBase), ready(localBase)]);
  browser = await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL || undefined});
  books = JSON.parse(await readFile('dist/books/book-manager/books.json','utf8')).books;
});
after(async () => { await browser?.close(); await Promise.all([stop(staticServer),stop(localServer)]); if (temporary) await rm(temporary,{recursive:true,force:true}); });

test('static artifact: every catalog URL works, tooling and review data absent', async () => {
  assert.ok(books.length > 0);
  for (const book of books) {
    const url = new URL(book.path.split('/').map(encodeURIComponent).join('/'), `${staticBase}/books/`);
    assert.equal((await fetch(url, {method:'HEAD'})).status, 200, book.path);
  }
  assert.equal((await fetch(`${staticBase}/api/review`)).status,404);
  assert.equal((await fetch(`${staticBase}/books/book-manager/server.py`)).status,404);
  assert.equal((await fetch(`${staticBase}/package.json`)).status,404);
  for (const path of ['ColorfulGit.html','blockchain.html','2la.html','song.html','OH_MR.SUN.swf','amplitude.js','gen-player.js','franky.jpg','bin/linq2md.0.0.1.7z','bin/giscore-debug-0.0.4.7z','bin/L_S_2A_U1_Part1.mp3','css/app.css','js/jquery.js','album-art/we-are-to-answer.jpg','img/play.svg','resources/sass/app.scss']) {
    assert.equal((await fetch(`${staticBase}/${path}`)).status,404,path);
    await assert.rejects(stat(path), {code:'ENOENT'});
  }
});

test('home and library: responsive layout, category deep links, search, favorites, accessibility', async () => {
  const page = await (await browser.newContext({viewport:{width:1440,height:1000}})).newPage();
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.goto(staticBase); await page.locator('.book-title').first().waitFor();
  assert.equal(new URL(page.url()).pathname, '/');
  assert.match(await page.title(), /灰库/);
  assert.equal(await page.locator('.brand strong').textContent(), '灰库');
  assert.equal(await page.locator('.site-links a').count(), 5);
  assert.equal(await page.locator('.archive-nav, .archive-label').count(), 0);
  await page.screenshot({path:'artifacts/home-desktop.png',fullPage:true});
  let axe = await new AxeBuilder({page}).analyze();
  assert.deepEqual(axe.violations.map(v=>({id:v.id,nodes:v.nodes.slice(0,12).map(n=>n.target),count:v.nodes.length})),[]);
  const category = books.find(b => /^\d+_/.test(b.category))?.category || books[0].category;
  await page.goto(`${staticBase}/books/book-manager/?category=${encodeURIComponent(category)}`);
  await page.waitForURL(url => url.pathname === '/' && url.searchParams.get('category') === category);
  await page.locator('#page-title').filter({hasText: category.replace(/^\d+_/, '').replaceAll('_', ' ')}).waitFor();
  assert.equal(await page.locator('.review-tools').count(),0);
  await page.locator('.nav-item[data-view="all"]').click();
  const sample = books.find(b=>b.extension==='pdf' && b.size<2000000 && b.path.includes('/')) || books[0];
  await page.locator('#search-input').fill(sample.name);
  await page.locator('.book-title').filter({hasText:sample.name}).first().waitFor();
  const favorite = page.locator('.book-card').filter({hasText:sample.name}).first().locator('.book-bottom button');
  await favorite.click(); await page.locator('.nav-item[data-view="favorites"]').click();
  assert.ok(await page.locator('.book-card').count() > 0);
  await page.reload(); await page.locator('.nav-item[data-view="favorites"]').click();
  assert.ok(await page.locator('.book-card').count() > 0);
  axe = await new AxeBuilder({page}).analyze();
  assert.deepEqual(axe.violations.map(v=>({id:v.id,nodes:v.nodes.slice(0,12).map(n=>n.target),count:v.nodes.length})),[]);
  for (const width of [390,320]) {
    await page.setViewportSize({width,height:844});
    await page.goto(staticBase); await page.locator('.book-title').last().waitFor();
    assert.equal(await page.locator('.site-links').isVisible(),true);
    const navBounds = await page.locator('.site-links').boundingBox();
    assert.ok(navBounds.x + navBounds.width <= width);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`home ${width}`);
    if(width===390) await page.screenshot({path:'artifacts/home-mobile.png',fullPage:true});
    await page.goto(staticBase); await page.locator('.book-title').first().waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`library ${width}`);
    if(width===390) {
      await page.screenshot({path:'artifacts/library-mobile.png'});
      assert.equal(await page.locator('#sidebar').isVisible(),false);
      await page.locator('#menu-button').click(); assert.equal(await page.locator('#sidebar').isVisible(),true);
      await page.keyboard.press('Escape'); assert.equal(await page.locator('#sidebar').isVisible(),false);
    }
  }
  assert.deepEqual(errors,[]); await page.close();
});

test('embedded PDF: render, page navigation, zoom, Escape and focus restoration', async () => {
  const page=await (await browser.newContext()).newPage();
  const sample=books.find(b=>b.path.endsWith('04structured-design.pdf')) || books.find(b=>b.extension==='pdf' && b.size>100000 && b.size<500000);
  await page.goto(staticBase);
  await page.locator('#search-input').fill(sample.name);
  const opener=page.locator('.book-title').filter({hasText:sample.name}).first();
  await opener.click();
  await page.locator('#reader-status').filter({hasText:'第 1 页'}).waitFor({timeout:30000});
  const total=Number(await page.locator('#page-count').textContent()); assert.ok(total>1);
  await page.locator('#next-page').click(); await page.locator('#reader-status').filter({hasText:'第 2 页'}).waitFor();
  await page.locator('#zoom-in').click(); assert.equal(await page.locator('#zoom-label').textContent(),'120%');
  await page.keyboard.press('Escape'); await page.waitForFunction(()=>!document.querySelector('#reader').open);
  assert.equal(await opener.evaluate(el=>document.activeElement===el),true);
  await opener.click(); await page.locator('#reader-status').filter({hasText:'第 2 页'}).waitFor();
  await page.locator('#reader-close').click(); await page.close();
});

test('PDF loading feedback, mouse/touch gestures, boundaries and long-page panning', async () => {
  const context = await browser.newContext({viewport:{width:1000,height:1800},hasTouch:true});
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const sample = books.find(b=>b.path.endsWith('04structured-design.pdf')) || books.find(b=>b.extension==='pdf' && b.size>100000 && b.size<500000);
  let release;
  const downloadGate = new Promise(resolve => { release = resolve; });
  await page.route(/\.pdf(?:\?|$)/i, async route => { await downloadGate; await route.continue(); });
  await page.goto(staticBase);
  await page.locator('#search-input').fill(sample.name);
  await page.locator('.book-title').filter({hasText:sample.name}).first().click();
  await page.locator('#reader-loading').waitFor({state:'visible'});
  assert.equal(await page.locator('#reader-scroll').getAttribute('aria-busy'),'true');
  assert.equal(await page.locator('#reader-loading progress').isVisible(),true);
  assert.equal(await page.locator('#next-page').isDisabled(),true);
  await page.screenshot({path:'artifacts/pdf-opening.png'});
  release();
  const atPage = async number => {
    await page.waitForFunction(n => document.querySelector('#reader-status').textContent === `第 ${n} 页`, number);
    assert.equal(await page.locator('#reader-loading').isVisible(),false);
    assert.equal(await page.locator('#reader-scroll').getAttribute('aria-busy'),'false');
  };
  await atPage(1);
  const busy = await page.locator('#next-page').evaluate(button => {
    button.click();
    return {visible: !document.querySelector('#reader-loading').hidden, text:document.querySelector('#reader-loading-text').textContent};
  });
  assert.equal(busy.visible,true); assert.match(busy.text,/第 2 页/);
  await atPage(2);
  const bounds = await page.locator('#reader-scroll').boundingBox();
  const x = bounds.x + bounds.width / 2, y = bounds.y + 250;
  const drag = async (dx,dy) => {
    await page.mouse.move(x,y); await page.mouse.down();
    await page.mouse.move(x+dx,y+dy,{steps:8}); await page.mouse.up();
  };
  await drag(-120,0); await atPage(3);
  await drag(120,0); await atPage(2);
  await drag(0,-120); await atPage(3);
  await drag(0,120); await atPage(2);
  await drag(20,0); await atPage(2);
  // Real touch input exercises browser pointer capture and touch-action handling.
  const session = await context.newCDPSession(page);
  const swipe = async (dx,dy) => {
    await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
    for(let i=1;i<=5;i++) await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+dx*i/5,y:y+dy*i/5}]});
    await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  };
  await swipe(-120,0); await atPage(3);
  await swipe(120,0); await atPage(2);
  await swipe(0,-120); await atPage(3);
  await swipe(0,120); await atPage(2);
  await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
  await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+120,y}]});
  await session.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
  await atPage(2);
  await page.locator('#prev-page').click(); await atPage(1);
  await drag(120,0); await atPage(1);
  await page.locator('#page-input').fill(await page.locator('#page-count').textContent());
  await page.locator('#page-input').press('Enter'); await page.locator('#reader-hint').click();
  const last = Number(await page.locator('#page-count').textContent());
  await atPage(last); await drag(-120,0); await atPage(last);
  // A long page pans first; one drag reaching its edge must not turn it.
  await page.setViewportSize({width:1000,height:700});
  await page.waitForTimeout(250); await atPage(last);
  await page.locator('#reader-scroll').evaluate(el => el.scrollTop = 150);
  const before = await page.locator('#reader-scroll').evaluate(el => el.scrollTop);
  await drag(0,-100);
  assert.ok(await page.locator('#reader-scroll').evaluate(el => el.scrollTop) > before);
  await atPage(last);
  await page.screenshot({path:'artifacts/pdf-reader.png'});
  const axe = await new AxeBuilder({page}).analyze();
  assert.deepEqual(axe.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))})),[]);
  await page.locator('#reader-close').click();
  assert.deepEqual(errors,[]);
  await context.close();
});

// A real, deterministic PDF with wide margins, graphics and three pages.
function readingFixture() {
  const stream = '0 G 1 w 100 10 400 780 re S BT /F1 12 Tf 120 700 Td (Readable PDF content) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [5 0 R 6 0 R 7 0 R] /Count 3 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    ...Array.from({length:3},()=> '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>'),
  ];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (const [i, object] of objects.entries()) { offsets.push(pdf.length); pdf += `${i+1} 0 obj\n${object}\nendobj\n`; }
  const start = pdf.length;
  pdf += `xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('');
  return Buffer.from(pdf + `trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`);
}
async function openReadingFixture(page) {
  await page.route(/\.pdf(?:\?|$)/i, route=>route.fulfill({contentType:'application/pdf',body:readingFixture()}));
  await page.goto(staticBase); await page.locator('.book-title').first().waitFor();
  const sample=books.find(book=>book.extension==='pdf');
  await page.locator('#search-input').fill(sample.name);
  await page.locator('.book-title').filter({hasText:sample.name}).first().click();
  await readerAt(page,1);
}
async function readerAt(page,number,suffix='') {
  await page.waitForFunction(({number,suffix})=>document.querySelector('#reader-status').textContent===`第 ${number} 页${suffix}` && document.querySelector('#reader-scroll').getAttribute('aria-busy')==='false', {number,suffix});
}
async function changeReader(page, action) {
  await action();
  await page.waitForFunction(()=>document.querySelector('#reader-scroll').getAttribute('aria-busy')==='false');
}

test('mobile PDF: content fit, reversible cropping, anchored double-tap/pinch zoom and column reading', async () => {
  const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true});
  const page=await context.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await openReadingFixture(page);
  assert.equal(await page.locator('#reader-fit').inputValue(),'content');
  const contentHeight=await page.locator('#pdf-canvas').evaluate(el=>el.clientHeight);
  await page.screenshot({path:'artifacts/pdf-mobile-content-fit.png'});
  await changeReader(page,()=>page.locator('#reader-fit').selectOption('page'));
  const pageHeight=await page.locator('#pdf-canvas').evaluate(el=>el.clientHeight);
  assert.ok(contentHeight > pageHeight*1.3, 'content fit makes content larger while retaining edge graphics');
  await page.locator('#reader-trim').evaluate(el=>{el.value='10';el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));});
  await readerAt(page,1);
  assert.equal(await page.locator('#reader-trim-value').textContent(),'10%');
  assert.ok(await page.locator('#pdf-canvas').evaluate(el=>el.clientHeight)>pageHeight*1.2);
  await changeReader(page,()=>page.locator('#reader-reset').click());
  assert.equal(await page.locator('#pdf-canvas').evaluate(el=>el.clientHeight),pageHeight);
  const session=await context.newCDPSession(page);
  const rect=await page.locator('#pdf-canvas').boundingBox();
  const x=rect.x+rect.width*.6, y=rect.y+rect.height*.35;
  const tap=async()=>{await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});};
  await tap(); await tap();
  await page.waitForFunction(()=>document.querySelector('#zoom-label').textContent==='200%');await readerAt(page,1);
  const zoomed=await page.locator('#pdf-canvas').boundingBox();
  assert.ok(Math.abs((x-zoomed.x)/zoomed.width-.6)<.035, 'double-tap keeps the tapped horizontal content position');
  assert.ok(Math.abs((y-zoomed.y)/zoomed.height-.35)<.035, 'double-tap keeps the tapped vertical content position');
  await changeReader(page,()=>page.locator('#reader-reset').click());
  const pinchY=rect.y+180;
  await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:145,y:pinchY},{x:245,y:pinchY}]});
  for(let i=1;i<=5;i++) await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:145-i*8,y:pinchY},{x:245+i*8,y:pinchY}]});
  await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await page.waitForFunction(()=>document.querySelector('#zoom-label').textContent==='180%');await readerAt(page,1);
  assert.equal(await page.locator('#page-input').inputValue(),'1');
  await changeReader(page,()=>page.locator('#reader-reset').click());
  await page.locator('#reader-columns').selectOption('2');await readerAt(page,1,' · 左栏');
  assert.equal(await page.locator('#prev-page').isDisabled(),true);
  await page.locator('#next-page').click();await readerAt(page,1,' · 右栏');
  await page.locator('#next-page').click();await readerAt(page,2,' · 左栏');
  await page.locator('#prev-page').click();await readerAt(page,1,' · 右栏');
  await page.locator('#reader-reset').click();await readerAt(page,1);
  await page.screenshot({path:'artifacts/pdf-mobile-reading-controls.png'});
  assert.equal(await page.evaluate(()=>document.querySelector('#reader').scrollWidth<=innerWidth),true);
  const axe=await new AxeBuilder({page}).analyze();assert.deepEqual(axe.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[]);
  for (const viewport of [{width:320,height:844},{width:844,height:390}]) {
    await page.setViewportSize(viewport);await page.waitForTimeout(260);await readerAt(page,1);
    assert.equal(await page.evaluate(()=>document.querySelector('#reader').scrollWidth<=innerWidth),true);
    assert.ok((await page.locator('#reader-scroll').boundingBox()).height>=150);
    await page.screenshot({path:`artifacts/pdf-reading-${viewport.width}.png`});
  }
  assert.deepEqual(errors,[]);await context.close();
});

test('trackpad: horizontal/vertical wheel navigation, inertia latch, scroll priority and ctrl-wheel zoom', async () => {
  const context=await browser.newContext({viewport:{width:1000,height:1800}});
  const page=await context.newPage();await openReadingFixture(page);
  const surface=page.locator('#reader-scroll');await surface.hover();
  await page.mouse.wheel(120,0);await readerAt(page,2);
  // Momentum in the same gesture cannot advance another page.
  await page.mouse.wheel(180,0);await page.waitForTimeout(100);await readerAt(page,2);
  await page.waitForTimeout(270);await page.mouse.wheel(-120,0);await readerAt(page,1);
  await page.waitForTimeout(270);await page.mouse.wheel(0,120);await readerAt(page,2);
  await page.waitForTimeout(270);await page.mouse.wheel(0,-120);await readerAt(page,1);
  await page.waitForTimeout(270);
  // Small deltas accumulate rather than requiring a single large wheel event.
  for(let i=0;i<6;i++)await page.mouse.wheel(20,0);
  await readerAt(page,2);
  await page.waitForTimeout(270);
  await page.keyboard.down('Control');await page.mouse.wheel(0,-100);await page.keyboard.up('Control');
  await page.waitForFunction(()=>parseInt(document.querySelector('#zoom-label').textContent)>150);await readerAt(page,2);
  assert.ok(await page.locator('#pdf-canvas').evaluate(el=>el.width*el.height)<=10_000_000);
  await page.setViewportSize({width:1000,height:700});await page.waitForTimeout(260);await readerAt(page,2);
  await surface.evaluate(el=>el.scrollTop=100);
  const before=await surface.evaluate(el=>el.scrollTop);
  await surface.hover();await page.mouse.wheel(0,180);await page.waitForTimeout(100);
  assert.ok(await surface.evaluate(el=>el.scrollTop)>before);await readerAt(page,2);
  // Reaching an edge in this burst only scrolls; a new gesture then flips.
  await surface.evaluate(el=>el.scrollTop=el.scrollHeight);
  await page.mouse.wheel(0,120);await readerAt(page,2);
  await page.waitForTimeout(270);await page.mouse.wheel(0,120);await readerAt(page,3);
  await context.close();
});

test('PDF download failure clears busy state and allows closing/reopening', async () => {
  const context = await browser.newContext({viewport:{width:390,height:844}});
  const page = await context.newPage();
  const sample = books.find(b=>b.extension==='pdf' && b.size>100000 && b.size<500000);
  await page.route(/\.pdf(?:\?|$)/i, route => route.abort());
  await page.goto(staticBase); await page.locator('#search-input').fill(sample.name);
  const opener = page.locator('.book-title').filter({hasText:sample.name}).first();
  await opener.click();
  await page.locator('#reader-loading-text').filter({hasText:'无法打开 PDF'}).waitFor();
  assert.equal(await page.locator('#reader-scroll').getAttribute('aria-busy'),'false');
  assert.equal(await page.locator('#reader-loading progress').isVisible(),false);
  await page.locator('#reader-close').click();
  await page.unroute(/\.pdf(?:\?|$)/i);
  await opener.click();
  await page.waitForFunction(()=>document.querySelector('#reader-status').textContent==='第 1 页');
  await page.screenshot({path:'artifacts/pdf-mobile.png'});
  await context.close();
});

test('local review: all file formats, UI marking and reset, persistence, fingerprints, original bytes untouched', async () => {
  const page=await (await browser.newContext({viewport:{width:1440,height:1000}})).newPage();
  await page.goto(localBase); await page.locator('.review-banner').waitFor();
  const sample=books.find(b=>b.extension==='md') || books.find(b=>b.extension!=='pdf') || books[0];
  await page.locator('#search-input').fill(sample.name);
  const card=page.locator('.book-card').filter({has:page.getByRole('button',{name:sample.name,exact:true})});
  await card.waitFor();
  await card.locator('[data-review="discard"]').click();
  await page.locator('#review-summary').filter({hasText:'不要 1 份'}).waitFor();
  await page.reload(); await page.locator('#review-summary').filter({hasText:'不要 1 份'}).waitFor();
  await page.locator('.review-filters [data-filter="discard"]').click();
  assert.equal(await page.locator('.book-card').count(),1);
  await page.screenshot({path:'artifacts/local-review.png',fullPage:true});
  await page.locator('[data-review="unreviewed"]').click();
  await page.locator('#review-summary').filter({hasText:'不要 0 份'}).waitFor();
  const formats=[...new Set(books.map(b=>b.extension))];
  for(const format of formats){
    const book=books.find(b=>b.extension===format);
    const original=await stat(join('books',book.path));
    const response=await mark(book.path,'discard'); assert.equal(response.status,200,format);
    const data=await response.json(); assert.equal(data.reviews[book.path].sha256.length,64); assert.equal(data.reviews[book.path].stale,false);
    const unchanged=await stat(join('books',book.path)); assert.equal(unchanged.mtimeMs,original.mtimeMs); assert.equal(unchanged.size,original.size);
  }
  await stop(localServer); localServer=startLocal(); await ready(localBase);
  const persisted=await (await fetch(`${localBase}/api/review`)).json(); assert.equal(Object.keys(persisted.reviews).length,formats.length);
  assert.equal((await fetch(`${localBase}/api/review/export`)).headers.get('content-disposition'),'attachment; filename="library-review.json"');
  await page.goto(localBase); await page.locator('.review-banner').waitFor();
  const axe=await new AxeBuilder({page}).analyze();
  assert.deepEqual(axe.violations.map(v=>({id:v.id,nodes:v.nodes.slice(0,12).map(n=>n.target),count:v.nodes.length})),[]);
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.close();
});

test('local access boundary: rejected origin and traversal; PDF supports HEAD and byte ranges', async () => {
  const sample=books.find(b=>b.extension==='pdf');
  assert.equal((await mark(sample.path,'discard',{'Origin':'https://untrusted.example'})).status,403);
  assert.equal((await mark('../../etc/passwd','discard')).status,400);
  assert.equal((await fetch(`${localBase}/books/book-manager/server.py`)).status,404);
  assert.equal((await fetch(`${localBase}/%2e%2e/%2e%2e/etc/passwd`)).status,404);
  const url=new URL(sample.path.split('/').map(encodeURIComponent).join('/'),`${localBase}/books/`);
  const range=await fetch(url,{headers:{Range:'bytes=0-15'}}); assert.equal(range.status,206); assert.ok((await range.text()).startsWith('%PDF-'));
  const invalid=await fetch(url,{headers:{Range:'bytes=999999999999-'}});assert.equal(invalid.status,416);
});

test('changed files invalidate previous marks without altering the source document', async () => {
  // A disposable library proves change detection without editing the real books.
  const code = `
import importlib.util, json, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location('library', 'books/book-manager/server.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as directory:
    m.SITE = Path(directory).resolve(); m.ROOT = m.SITE / 'books'; m.ROOT.mkdir(); m.APP = m.ROOT / 'book-manager'
    document = m.ROOT / 'example.md'; document.write_text('before')
    info = document.stat(); m.STATE_FILE = m.SITE / 'reviews.json'
    review = {'choice':'discard','size':info.st_size,'mtime_ns':info.st_mtime_ns,'sha256':'placeholder'}
    m.STATE_FILE.write_text(json.dumps({'reviews':{'example.md':review}}))
    assert m.review_snapshot()['reviews']['example.md']['stale'] is False
    document.write_text('changed document')
    assert m.review_snapshot()['reviews']['example.md']['stale'] is True
    assert document.read_text() == 'changed document'
`;
  const process = spawn('python3', ['-c',code], {stdio:'pipe'});
  let error=''; process.stderr.on('data',chunk=>error+=chunk);
  const result=await new Promise(resolve=>process.on('exit',resolve)); assert.equal(result,0,error);
});

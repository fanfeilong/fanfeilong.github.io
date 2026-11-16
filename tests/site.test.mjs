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
  browser = await chromium.launch();
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

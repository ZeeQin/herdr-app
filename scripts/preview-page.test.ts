import { expect, test } from 'bun:test';
import { readFile, mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreviewPage } from '../defaults/mods/files/preview-page.js';

const root = new URL('../defaults/mods/files/', import.meta.url);
const read = (name: string) => readFile(new URL(name, root), 'utf8');
const libraries = {
  marked: await read('vendor/marked.min.js'),
  purify: await read('vendor/purify.min.js'),
  mermaid: await read('vendor/mermaid.min.js'),
  highlight: await read('vendor/highlight.min.js'),
  css: await read('preview.css'),
  client: await read('preview-client.js'),
};

test('embedded document text cannot terminate its data script', () => {
  const payload = '</script><script>globalThis.pwned=true</script>\u2028\u2029';
  const html = buildPreviewPage({text:payload}, {nonce:'testnonce'});
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  const context: any = {window:{}};
  new Function('window', scripts.at(-2)!)(context.window);
  expect(context.window.previewData.text).toBe(payload);
  expect(html).not.toContain(payload);
});

const chrome = process.env.PREVIEW_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const hasChrome = await access(chrome).then(() => true, () => false);
// PREVIEW_CHROME selects an installed Chromium on Linux/Windows; no real browser profile is used.
test.skipIf(!hasChrome)('browser sanitizes Markdown and keeps zoom anchored and bounded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'herdr-preview-browser-'));
  try {
    const checks = `
setTimeout(async () => {
 const result = document.createElement('pre'); result.id='test-result';
 try {
  const assert = (value,message) => {if(!value) throw new Error(message);};
  assert(!window.pwned,'executed untrusted content');
  assert(!document.querySelector('article script,article svg,article iframe,article [onerror],article [style]'),'unsafe markup survived');
  assert(!document.querySelector('article a[href^="javascript:"]'),'unsafe URL survived');
  assert(document.querySelector('article code.hljs'),'code not highlighted');
  document.getElementById('source').click();
  assert(document.querySelector('article code').textContent.includes('<script>'),'source lost raw content');
  document.getElementById('source').click();
  const image=document.createElement('img'); image.src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="1000"><rect width="2000" height="1000" fill="red"/></svg>');
  await image.decode();
  // Open a real rendered diagram to exercise the shared image viewport.
  await new Promise(resolve=>setTimeout(resolve,1000));
  const diagram=document.querySelector('.mermaid-image'); assert(diagram,'Mermaid did not render'); diagram.click();
  await new Promise(resolve=>setTimeout(resolve,100));
  const visible=document.querySelector('#image-viewport img'); visible.src=image.src; await visible.decode();
  document.getElementById('image-actual').click();
  const viewport=document.getElementById('image-viewport'); viewport.scrollLeft=200;
  const box=viewport.getBoundingClientRect(), x=200;
  const anchor=(viewport.scrollLeft+x-parseFloat(visible.style.left))/parseFloat(visible.style.width);
  viewport.dispatchEvent(new WheelEvent('wheel',{ctrlKey:true,deltaY:-10,clientX:box.left+x,clientY:box.top+200,cancelable:true}));
  const after=(viewport.scrollLeft+x-parseFloat(visible.style.left))/parseFloat(visible.style.width);
  assert(Math.abs(anchor-after)<.002,'pointer zoom shifted anchor');
  document.getElementById('image-actual').click();
  assert(document.getElementById('image-zoom').textContent==='100%','actual size');
  for(let i=0;i<40;i++)document.getElementById('image-plus').click();
  assert(document.getElementById('image-zoom').textContent==='800%','upper zoom bound');
  for(let i=0;i<80;i++)document.getElementById('image-minus').click();
  assert(document.getElementById('image-zoom').textContent==='10%','lower zoom bound');
  visible.src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="20000" height="10000"/>');
  await visible.decode(); document.getElementById('image-fit').click();
  assert(visible.getBoundingClientRect().width<=viewport.clientWidth+1,'Fit clamps huge image to 10%');
  assert(visible.getBoundingClientRect().height<=viewport.clientHeight+1,'Fit overflows height');
  const messages=[]; window.ipc={postMessage:message=>messages.push(JSON.parse(message))};
  const escape=()=>{const event=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});document.dispatchEvent(event);assert(event.defaultPrevented,'Escape not handled');};
  escape(); assert(!document.getElementById('lightbox').open,'Escape did not close image');
  assert(messages.length===0,'Escape closed preview while image open');
  escape(); assert(messages.length===1 && messages[0].type==='close' && messages[0].generation==='test','Escape did not close preview');
  const violations=[]; document.addEventListener('securitypolicyviolation',event=>violations.push(event.violatedDirective));
  const charts=['sequenceDiagram\\nAlice->>Bob: Hello','classDiagram\\nAnimal <|-- Dog','stateDiagram-v2\\n[*] --> Ready','erDiagram\\nUSER ||--o{ POST : writes','gantt\\ndateFormat YYYY-MM-DD\\nsection Work\\nTask :2025-01-01, 1d','pie\\n"A" : 10\\n"B" : 20','mindmap\\n  root((Root))\\n    Child','timeline\\n  title Events\\n  2025 : Start'];
  for(let i=0;i<charts.length;i++){const rendered=await mermaid.render('chart-check-'+i,charts[i]);assert(rendered.svg.includes('<svg'),'chart unavailable '+i);}
  assert(violations.length===0,'Mermaid attempted forbidden runtime resource: '+violations);
  result.textContent='PASS';
 } catch(error) {result.textContent='FAIL: '+error.stack;}
 document.body.append(result);
},100);`;
    const html = buildPreviewPage({path:'unsafe.md',kind:'markdown',generation:'test',text:'# Safe\n<script>window.pwned=true</script>\n<img src="bad" onerror="window.pwned=true"><iframe src="https://example.com"></iframe><svg onload="window.pwned=true"></svg><p style="color:red">plain</p>\n[bad](javascript:alert(1))\n```javascript\nconst x = 1;\n```\n```mermaid\ngraph TD; A-->B\n```'}, {...libraries,client:libraries.client+'\n'+checks});
    const file=join(dir,'preview.html'); await writeFile(file,html);
    const child=Bun.spawn([chrome,'--headless','--disable-gpu','--no-first-run',`--user-data-dir=${join(dir,'profile')}`,'--dump-dom','--virtual-time-budget=6000',`file://${file}`],{stdout:'pipe',stderr:'pipe'});
    const [output, errors, code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    expect(code,errors).toBe(0);
    expect(output.match(/<pre id="test-result">([\s\S]*?)<\/pre>/)?.[1]).toBe('PASS');
  } finally {await rm(dir,{recursive:true,force:true});}
},30000);

test.skipIf(!hasChrome)('SVG images keep SMIL/CSS animation in media and lightbox; Safari gesture zooms', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'herdr-preview-animation-'));
  try {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><style>@keyframes pulse{0%,49%{fill:rgb(255,0,0)}50%,100%{fill:rgb(0,0,255)}}.pulse{animation:pulse .4s infinite steps(1)}</style><rect width="200" height="200" class="pulse"/><rect x="200" width="200" height="200" fill="red"><animate attributeName="fill" values="red;blue" dur=".4s" calcMode="discrete" repeatCount="indefinite"/></rect><script>parent.pwned=true</script></svg>`;
    const src = 'data:image/svg+xml,' + encodeURIComponent(svg);
    const checks = `
(async () => {
 const result=document.createElement('pre'); result.id='test-result';
 const assert=(value,message)=>{if(!value)throw new Error(message);};
 const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 async function animated(img) {
  await img.decode();
  const canvas=document.createElement('canvas'); canvas.width=400; canvas.height=200;
  const context=canvas.getContext('2d',{willReadFrequently:true}), css=new Set(), smil=new Set();
  for(let i=0;i<40;i++){
   context.clearRect(0,0,400,200); context.drawImage(img,0,0,400,200);
   css.add(Array.from(context.getImageData(100,100,1,1).data).join(','));
   smil.add(Array.from(context.getImageData(300,100,1,1).data).join(','));
   if(css.size>1 && smil.size>1)return;
   await wait(50);
  }
  assert(css.size>1,'CSS animation did not advance: '+[...css]);
  assert(smil.size>1,'SMIL animation did not advance: '+[...smil]);
 }
 try{
  await animated(document.querySelector('#document img'));
  assert(!window.pwned,'SVG script escaped image isolation');
  // Re-run the same client with a Markdown image to exercise its real lightbox path.
  window.previewData={path:'animation.md',kind:'markdown',generation:'test',text:'![animated](animation.svg)',images:{'animation.svg':${JSON.stringify(src)}}};
  window.runClientAgain();
  document.querySelector('article img').click();
  await animated(document.querySelector('#image-viewport img'));
  const viewport=document.getElementById('image-viewport');
  document.getElementById('image-actual').click();
  const rect=viewport.getBoundingClientRect();
  function gesture(type,scale){const e=new Event(type,{cancelable:true});Object.assign(e,{scale,clientX:rect.left+100,clientY:rect.top+100});viewport.dispatchEvent(e);assert(e.defaultPrevented,type+' was not intercepted');}
  gesture('gesturestart',1);gesture('gesturechange',2);
  assert(document.getElementById('image-zoom').textContent==='200%','Safari pinch did not scale');
  viewport.dispatchEvent(new WheelEvent('wheel',{ctrlKey:true,deltaY:-50,cancelable:true}));
  assert(document.getElementById('image-zoom').textContent==='200%','wheel double-applied Safari pinch');
  gesture('gestureend',2);
  viewport.dispatchEvent(new WheelEvent('wheel',{ctrlKey:true,deltaY:-10,cancelable:true}));
  assert(document.getElementById('image-zoom').textContent!=='200%','wheel remained disabled after gesture');
  assert(!window.pwned,'lightbox SVG script escaped image isolation');
  result.textContent='PASS';
 }catch(error){result.textContent='FAIL: '+error.stack;}
 document.body.append(result);
})();`;
    // Inject a callable client copy to switch preview kind without weakening the production CSP.
    const clientAgain = libraries.client.replace(/^\(\(\) => \{/, 'window.runClientAgain = () => {').replace(/\}\)\(\);\s*$/, '};');
    const html=buildPreviewPage({path:'animated.svg',kind:'image',src,generation:'test'}, {...libraries,client:libraries.client+'\n'+clientAgain+'\n'+checks});
    const file=join(dir,'preview.html');await writeFile(file,html);
    const profile=join(dir,'profile');
    const child=Bun.spawn([chrome,'--headless','--disable-gpu','--no-first-run',`--user-data-dir=${profile}`,'--remote-debugging-port=0',`file://${file}`],{stdout:'ignore',stderr:'ignore'});
    try {
      let port='';
      for(let i=0;i<200;i++) {
        try {port=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];break;}catch{await Bun.sleep(25);}
      }
      expect(port).not.toBe('');
      const targets=await fetch(`http://127.0.0.1:${port}/json`).then(response=>response.json()) as any[];
      const target=targets.find(target=>target.type==='page');
      const socket=new WebSocket(target.webSocketDebuggerUrl);
      await new Promise<void>((resolve,reject)=>{socket.onopen=()=>resolve();socket.onerror=reject;});
      const result=await new Promise<any>((resolve,reject)=>{
        const timeout=setTimeout(()=>reject(new Error('Animation browser test timed out')),15000);
        socket.onmessage=event=>{const message=JSON.parse(String(event.data));if(message.id===1){clearTimeout(timeout);resolve(message);}};
        socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:`new Promise(resolve=>{const poll=()=>{const node=document.getElementById('test-result');if(node)resolve(node.textContent);else setTimeout(poll,25);};poll();})`,awaitPromise:true,returnByValue:true}}));
      });
      socket.close();
      expect(result.result?.result?.value).toBe('PASS');
    } finally {child.kill();await child.exited;}

  } finally {await rm(dir,{recursive:true,force:true});}
},30000);

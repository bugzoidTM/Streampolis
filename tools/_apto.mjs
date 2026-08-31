import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
const token = process.argv[2];
const b = await chromium.launch({ args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-webgl','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport:{width:1280,height:760} });
const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
await p.goto(`http://127.0.0.1:5273/?apartment=me&token=${token}`, { waitUntil:'networkidle' });
await p.waitForFunction(()=>window.__ready===true,{timeout:60000});
await p.waitForTimeout(5000);
// Afasta a câmera: a órbita responde à roda do mouse.
for (let i=0;i<14;i++) { await p.mouse.move(640,380); await p.mouse.wheel(0,120); await p.waitForTimeout(60); }
await p.waitForTimeout(1500);
await mkdir('shots/apto',{recursive:true});
await p.screenshot({ path:'shots/apto/sala.png' });
// E a barra de construção aberta.
await p.click('.build__open').catch(()=>{});
await p.waitForTimeout(1200);
await p.screenshot({ path:'shots/apto/build.png' });
console.log(JSON.stringify(errs.slice(0,4)));
await b.close();

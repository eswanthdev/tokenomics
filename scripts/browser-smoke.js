// Optional real-browser smoke test. Requires a local Chromium executable.
import {spawn} from 'node:child_process';
import {mkdtemp, rm, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {createServer} from '../src/server.js';
const profile=await mkdtemp(join(tmpdir(),'tokenomics-browser-'));
const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=spawn(process.env.CHROMIUM || '/usr/bin/chromium',['--headless','--no-sandbox','--disable-gpu','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
let socket;
try {
 const endpoint=await new Promise((resolve,reject)=>{
  let log='';const timer=setTimeout(()=>reject(Error('Chromium did not start')),15000);
  browser.on('error',reject);browser.stderr.on('data',c=>{log+=c;const match=log.match(/DevTools listening on (ws:\/\/\S+)/);if(match){clearTimeout(timer);resolve(match[1]);}});
 });
 socket=new WebSocket(endpoint);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
 let next=0;const pending=new Map();socket.onmessage=e=>{const r=JSON.parse(e.data);if(pending.has(r.id)){const {resolve,reject}=pending.get(r.id);pending.delete(r.id);r.error?reject(Error(JSON.stringify(r.error))):resolve(r.result);}};
 const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params,sessionId}));});
 const {targetInfos}=await call('Target.getTargets');const target=targetInfos.find(t=>t.type==='page');
 const {sessionId}=await call('Target.attachToTarget',{targetId:target.targetId,flatten:true});
 const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 const wait=async expression=>{for(let n=0;n<100;n++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,50));}throw Error(`Timed out: ${expression}; ${await evaluate("document.body.innerText")}`);};
 await call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}`},sessionId);
 await wait("document.readyState === 'complete' && !!document.querySelector('#sample')");
 assert.equal(await evaluate("document.querySelector('#empty').hidden"),false);
 await evaluate("document.querySelector('#sample').click()");await wait("!document.querySelector('#results').hidden");
 const text=await evaluate('document.body.innerText');assert.match(text,/\$168\.00/);assert.match(text,/\$27\.50/);assert.match(text,/DETERMINISTIC INVESTIGATION/);assert.match(text,/2026-10-usage-3-retry/);
 assert.equal(await evaluate("[...document.querySelectorAll('a[href^=\"#\"]')].every(a=>document.getElementById(a.hash.slice(1)))"),true);
 await evaluate("document.querySelector('#clear').click()");assert.equal(await evaluate("document.querySelector('#empty').hidden"),false);
 // Exercise the actual file-input handler through a browser File/DataTransfer.
 const upload=async raw=>evaluate(`(()=>{const dt=new DataTransfer();dt.items.add(new File([${JSON.stringify(raw)}],'import.json',{type:'application/json'}));const input=document.querySelector('#file');input.files=dt.files;input.dispatchEvent(new Event('change'));})()`);
 await upload('{invalid');await wait("!document.querySelector('#error').hidden");assert.match(await evaluate("document.querySelector('#error').textContent"),/Invalid JSON/);assert.equal(await evaluate("document.querySelector('#results').hidden"),true);
 const fixture=await readFile(new URL('../fixtures/support.json',import.meta.url),'utf8');await upload(fixture);await wait("!document.querySelector('#results').hidden");
 await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true},sessionId);
 assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'),true);
 const shot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},sessionId);await writeFile('/tmp/tokenomics-mobile.png',Buffer.from(shot.data,'base64'));
 console.log('PASS: empty state, sample analysis, financial figures, evidence anchors, clear, invalid upload, valid upload and mobile overflow. Screenshot: /tmp/tokenomics-mobile.png');
} finally {
 socket?.close();browser.kill('SIGTERM');await new Promise(r=>server.close(r));await new Promise(r=>browser.exitCode!==null?r():browser.once('exit',r));await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}

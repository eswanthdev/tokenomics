import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from '../src/server.js';
test('HTTP serves app/sample, analyzes valid imports and rejects invalid requests', async t=>{
 const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`;
 const page=await fetch(base);assert.equal(page.status,200);assert.match(await page.text(),/SYNTHETIC AWS DATA/);assert.match(page.headers.get('content-security-policy'),/default-src 'self'/);
 const sample=await (await fetch(base+'/api/sample')).text();
 const good=await fetch(base+'/api/analyze',{method:'POST',body:sample});assert.equal(good.status,200);assert.equal((await good.json()).investigation.delta_micros,68000000);
 for(const body of ['{broken','null','{}']){const bad=await fetch(base+'/api/analyze',{method:'POST',body});assert.equal(bad.status,400);assert.ok((await bad.json()).error);}
 const huge=await fetch(base+'/api/analyze',{method:'POST',body:' '.repeat(2_000_001)});assert.equal(huge.status,413);
 assert.equal((await fetch(base+'/missing')).status,404);
 assert.equal((await fetch(base+'/src/engine.js')).status,404);
});

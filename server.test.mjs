import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {gzipSync} from 'node:zlib';
import {Agent,request} from 'undici';
import {createGateway} from './server.mjs';
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port)));
const close=server=>new Promise(resolve=>server.close(resolve));
test('preserves authenticated redirects and exact compressed bytes; blocks management routes',async()=>{
  const raw=Buffer.from(new Int16Array([-1024,-487,34,400,1000]).buffer),compressed=gzipSync(raw),seen=[];
  const source=http.createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);
    seen.push({path:req.url,body:Buffer.concat(chunks).toString(),cookie:req.headers.cookie,authorization:req.headers.authorization});
    if(req.url.startsWith('/s/')){res.writeHead(302,{Location:'/viewer/index.html','Set-Cookie':'ct_review_access=test-only; Path=/; HttpOnly; Secure; SameSite=Lax'});res.end();return;}
    if(req.url==='/api/local'){res.writeHead(200,{'Content-Type':'application/json'});res.end(Buffer.concat(chunks));return;}
    res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Encoding':'gzip','Content-Length':compressed.length});res.end(compressed);
  });
  const sourceOrigin=await listen(source),dispatcher=new Agent(),gateway=createGateway({upstream:sourceOrigin,dispatcher}),origin=await listen(gateway);
  try{
    let response=await request(origin+'/s/test-only-link-123456789');assert.equal(response.statusCode,302);assert.equal(response.headers.location,'/viewer/index.html');assert(response.headers['set-cookie'].includes('HttpOnly'));await response.body.dump();
    response=await request(origin+'/api/slice/2021/axial/0',{headers:{Cookie:'ct_review_access=test-only',Authorization:'must-not-forward'}});assert.equal(response.headers['content-encoding'],'gzip');assert.deepEqual(Buffer.from(await response.body.arrayBuffer()),compressed);assert.equal(seen.at(-1).cookie,'ct_review_access=test-only');assert.equal(seen.at(-1).authorization,undefined);
    const body=JSON.stringify({focus:{id:'focus1',sourceYear:'2026'}});response=await request(origin+'/api/local',{method:'POST',headers:{'Content-Type':'application/json'},body});assert.equal(await response.body.text(),body);
    const calls=seen.length;
    for(const [method,path]of [['GET','/api/admin/status'],['POST','/api/expire'],['POST','/api/local/extra'],['PUT','/api/workspace']]){response=await request(origin+path,{method});assert.equal(response.statusCode,404);await response.body.dump();}
    assert.equal(seen.length,calls);
    response=await request(origin+'/healthz');assert.equal(response.statusCode,200);assert.deepEqual(await response.body.json(),{ok:true});
  }finally{await close(gateway);await dispatcher.close();await close(source);}
});

import http from 'node:http';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {pathToFileURL} from 'node:url';
import {Agent,ProxyAgent,request} from 'undici';

const hopHeaders=new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade','host']);
const allowed=(method,path)=>method==='GET'&&(
  path==='/'||path==='/expired'||path==='/api/manifest'||path==='/api/workspace'||
  /^\/s\/[A-Za-z0-9_-]{20,256}$/.test(path)||/^\/api\/slice\/\d{4}\/(axial|coronal|sagittal)\/\d+$/.test(path)||
  path.startsWith('/viewer/')||path.startsWith('/assets/')||path==='/robots.txt'||path==='/favicon.ico'
)||method==='POST'&&path==='/api/local';
function cleanHeaders(headers){return Object.fromEntries(Object.entries(headers).filter(([name])=>!hopHeaders.has(name.toLowerCase())));}
export function createGateway({upstream,dispatcher}={}){
  const origin=new URL(upstream);
  if(origin.protocol!=='https:'&&!(origin.protocol==='http:'&&origin.hostname==='127.0.0.1'))throw new Error('A secure upstream origin is required');
  if(origin.pathname!=='/'||origin.search||origin.username||origin.password)throw new Error('Upstream must be an origin');
  return http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');
    res.setHeader('Cache-Control','private, no-store, max-age=0');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('X-Robots-Tag','noindex, nofollow, noarchive');
    res.setHeader('Referrer-Policy','no-referrer');
    if(req.method==='GET'&&url.pathname==='/healthz'){res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}');return;}
    if(!allowed(req.method,url.pathname)){res.writeHead(404);res.end('Not found');return;}
    const controller=new AbortController();
    res.on('close',()=>{if(!res.writableFinished)controller.abort();});
    try{
      let body;
      if(req.method==='POST'){
        const chunks=[];let length=0;
        for await(const chunk of req){length+=chunk.length;if(length>2*1024*1024){res.writeHead(413);res.end('Request too large');return;}chunks.push(chunk);}
        body=Buffer.concat(chunks);
      }
      const headers=cleanHeaders(req.headers);
      delete headers['x-forwarded-for'];delete headers['x-forwarded-host'];delete headers['x-forwarded-proto'];
      delete headers.authorization;delete headers['oai-sites-authorization'];
      if(headers.cookie)headers.cookie=headers.cookie.split(';').map(v=>v.trim()).filter(v=>v.startsWith('ct_review_access=')).join('; ');
      const response=await request(new URL(url.pathname+url.search,origin),{dispatcher,method:req.method,headers,body,signal:controller.signal,headersTimeout:90000,bodyTimeout:90000,maxRedirections:0});
      const returned=cleanHeaders(response.headers);
      returned['cache-control']='private, no-store, max-age=0';
      if(returned['set-cookie']){const cookies=[returned['set-cookie']].flat().filter(v=>v.startsWith('ct_review_access='));if(cookies.length)returned['set-cookie']=cookies;else delete returned['set-cookie'];}
      if(typeof returned.location==='string'&&returned.location.startsWith(origin.origin+'/'))returned.location=returned.location.slice(origin.origin.length);
      res.writeHead(response.statusCode,returned);
      await pipeline(Readable.from(response.body),res);
    }catch(error){
      if(controller.signal.aborted)return;
      console.error('Snapshot gateway request failed:',error.code||error.name);
      if(!res.headersSent){res.writeHead(502,{'Content-Type':'text/plain; charset=utf-8','Retry-After':'3'});res.end('影像暂未载入，请稍后刷新。');}else res.destroy();
    }
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const proxy=process.env.HTTPS_PROXY||process.env.HTTP_PROXY;
  const dispatcher=proxy?new ProxyAgent({uri:proxy,connections:12}):new Agent({connections:12});
  const server=createGateway({upstream:process.env.CT_UPSTREAM_ORIGIN,dispatcher});
  server.listen(Number(process.env.PORT)||10000,'0.0.0.0',()=>console.log('Doctor snapshot gateway ready'));
  process.on('SIGTERM',()=>server.close(()=>dispatcher.close().finally(()=>process.exit(0))));
}

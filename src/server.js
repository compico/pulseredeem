import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueueStore } from './queue-store.js';
const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '../public');
const host = process.env.HOST || '127.0.0.1'; const port = Number(process.env.PORT || 3037);
const queue = new QueueStore({ maxQueue:Number(process.env.MAX_QUEUE || 15), maxPerUser:Number(process.env.MAX_PER_USER || 1) });
const clients = new Set();
function json(res, code, data) { res.writeHead(code, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'}); res.end(JSON.stringify(data)); }
function publish() { const msg = 'data: ' + JSON.stringify(queue.snapshot()) + '\\n\\n'; for (const client of clients) client.write(msg); }
async function readBody(req) { let body=''; for await (const chunk of req) { body += chunk; if (body.length > 16384) throw new Error('Request too large'); } return body ? JSON.parse(body) : {}; }
const server = http.createServer(async (req,res) => {
 const url = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'));
 if (req.method==='GET' && url.pathname==='/api/health') return json(res,200,{ok:true,service:'pulseredeem'});
 if (req.method==='GET' && url.pathname==='/api/queue') return json(res,200,queue.snapshot());
 if (req.method==='GET' && url.pathname==='/api/events') { res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive'}); res.write('data: '+JSON.stringify(queue.snapshot())+'\\n\\n'); clients.add(res); req.on('close',()=>clients.delete(res)); return; }
 if (req.method==='POST' && url.pathname==='/api/dev/requests') { try { const b=await readBody(req); const result=queue.add({url:b.url,userId:b.userId||'local-test-user',userName:b.userName||'Local test'}); if(!result.ok)return json(res,422,result); publish(); return json(res,201,result); } catch(e) { return json(res,400,{ok:false,reason:e.message}); } }
 if (req.method==='DELETE' && url.pathname.startsWith('/api/queue/')) { const id=decodeURIComponent(url.pathname.slice('/api/queue/'.length)); if(!queue.remove(id))return json(res,404,{ok:false,reason:'not_found'}); publish(); return json(res,200,{ok:true}); }
 const rel = url.pathname==='/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)); const target=path.resolve(publicDir,rel);
 if (!target.startsWith(publicDir+path.sep)) return json(res,403,{error:'forbidden'});
 fs.readFile(target,(err,data)=>{ if(err)return json(res,404,{error:'not_found'}); const ext=path.extname(target); const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8'}; res.writeHead(200,{'content-type':types[ext]||'application/octet-stream'}); res.end(data); });
});
server.listen(port,host,()=>console.log('PulseRedeem: http://'+host+':'+port+' (Twitch/PulseSync bridges pending SDK verification)'));

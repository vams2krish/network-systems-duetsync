import {createHmac} from 'node:crypto';
import {createHub} from '../../../lib/hub.js';
import {DatabaseStore} from '../../../lib/store.js';

const url = Deno.env.get('SUPABASE_URL');
const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if(!url || !key) throw new Error('Missing platform database credentials');
const store = new DatabaseStore({url,key});
const hub = createHub({store});
const origins = new Set([
  'https://duetsync.vercel.app',
  'https://duetsync-vamshi-krishnas-projects-861bffd9.vercel.app',
]);
// Adapt the native Edge WebSocket to the same transport interface used by Node.
class EdgeSocket {
  constructor(socket){this.socket=socket;this.alive=true;}
  get readyState(){return this.socket.readyState;}
  get bufferedAmount(){return this.socket.bufferedAmount;}
  on(name,callback){
    if(name!=='pong')this.socket.addEventListener(name,event=>callback(name==='message'?event.data:event));
    return this;
  }
  send(data){this.socket.send(data);}
  close(code=1000,reason=''){this.socket.close(code===1000||code>=3000?code:4008,reason);}
  terminate(){this.close(4000,'Connection timeout');}
  ping(){if(this.readyState===1)this.send(JSON.stringify({type:'check'}));}
}
globalThis.addEventListener('beforeunload',()=>hub.stop());
Deno.serve(async request=>{
  const path=new URL(request.url).pathname;
  if(path.endsWith('/healthz')){
    try{await store.health();return Response.json({ok:true,storage:'durable',version:'2.0.0'},{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
    catch{return Response.json({ok:false},{status:503});}
  }
  if(request.headers.get('upgrade')?.toLowerCase()!=='websocket')return new Response('Not found',{status:404});
  if(!origins.has(request.headers.get('origin')||''))return new Response('Forbidden',{status:403});
  try{
    const ip=(request.headers.get('x-forwarded-for')||'unknown').split(',').at(-1).trim();
    const ipKey=createHmac('sha256',key).update(ip).digest('hex');
    if(hub.clients.size>=200 || !await store.limit(`upgrade:${ipKey}`,60,600000))return new Response('Too many connections',{status:429});
    const {socket,response}=Deno.upgradeWebSocket(request,{idleTimeout:0});
    const adapted=new EdgeSocket(socket);
    socket.addEventListener('open',()=>hub.accept(adapted,ipKey),{once:true});
    return response;
  }catch{hub.log('upgrade_storage_error');return new Response('Temporarily unavailable',{status:503});}
});

import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {WebSocketServer} from 'ws';
import {randomBytes} from 'node:crypto';
const rooms=new Map();
const server=http.createServer(async(req,res)=>{
 const paths={'/':'index.html','/app.js':'app.js','/style.css':'style.css'};
 const file=paths[new URL(req.url,'http://localhost').pathname];
 if(!file){res.writeHead(404);return res.end('Not found');}
 try{res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(await readFile(new URL('./public/'+file,import.meta.url)));}catch{res.writeHead(500);res.end('Unable to load app');}
});
const wss=new WebSocketServer({server,maxPayload:4096});
const send=(ws,data)=>{if(ws.readyState===1)ws.send(JSON.stringify(data));};
wss.on('connection',ws=>{
 let room,code;
 ws.on('message',raw=>{try{
 const m=JSON.parse(raw);
 if(m.type==='ping')return send(ws,{type:'pong',sent:m.sent,server:Date.now()});
 if(m.type==='join'){
 if(room)return;
 code=String(m.code||randomBytes(6).toString('hex')).toLowerCase();
 if(!/^[a-f0-9]{12}$/.test(code))return send(ws,{type:'error',message:'Use the 12-character room code from your partner.'});
 room=rooms.get(code);
 if(room?.peers.size>=2){room=undefined;return send(ws,{type:'error',message:'This room already has two listeners.'});}
 if(!room){room={peers:new Set(),state:{playing:false,position:0,at:Date.now(),revision:0}};rooms.set(code,room);}
 room.peers.add(ws);send(ws,{type:'joined',code,state:room.state});
 for(const p of room.peers)send(p,{type:'presence',count:room.peers.size});return;
 }
 if(m.type==='control'&&room&&typeof m.playing==='boolean'&&Number.isFinite(m.position)&&m.position>=0&&m.position<=86400){
 room.state={playing:m.playing,position:m.position,at:Date.now()+350,revision:room.state.revision+1};
 for(const p of room.peers)send(p,{type:'state',state:room.state});
 }
 }catch{send(ws,{type:'error',message:'Invalid message.'});}});
 ws.on('close',()=>{if(room){room.peers.delete(ws);for(const p of room.peers)send(p,{type:'presence',count:room.peers.size});if(!room.peers.size)rooms.delete(code);}});
});
server.listen(process.env.PORT||3000,'0.0.0.0',()=>console.log('DuetSync listening on port '+(process.env.PORT||3000)));

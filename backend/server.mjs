import { createServer } from 'node:http';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const folder=dirname(fileURLToPath(import.meta.url));
const storeFile=process.env.DUCKSIDE_STORE_FILE||join(folder,'data','store.json');
const accountsFile=process.env.DUCKSIDE_ACCOUNTS_DB||join(folder,'data','accounts.sqlite');
const updatesFolder=join(folder,'data','updates');
const launcherUpdatesFolder=join(updatesFolder,'launcher');
const contentUpdatesFolder=join(updatesFolder,'content');
const newsMediaFolder=join(folder,'data','media','news');
const backgroundMediaFolder=join(folder,'data','media','background');
const port=Number(process.env.PORT||3040);
const bridgeKey=process.env.DUCKSIDE_BRIDGE_KEY||'troque-esta-chave-antes-de-publicar';
const isProduction=process.env.NODE_ENV==='production';
const publicBaseUrl=(process.env.PUBLIC_BASE_URL||'').replace(/\/$/,'');
const adminSteamIds=new Set((process.env.DUCKSIDE_ADMIN_STEAM_IDS||'').split(',').map(id=>id.trim()).filter(id=>/^\d{17}$/.test(id)));
const authFailures=new Map();
const pendingSteamStates=new Map();
const pendingSteamTickets=new Map();

await mkdir(join(folder,'data'),{recursive:true,mode:0o700});
if(process.platform!=='win32')await chmod(join(folder,'data'),0o700);
const accountsDb=new DatabaseSync(accountsFile);
if(process.platform!=='win32')await chmod(accountsFile,0o600);
accountsDb.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL,
  username_norm TEXT NOT NULL UNIQUE,
  steam_id TEXT NOT NULL UNIQUE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);`);
accountsDb.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());

if(isProduction&&(!bridgeKey||bridgeKey.startsWith('troque-')||!/^https:\/\//.test(publicBaseUrl)||adminSteamIds.size===0)){throw new Error('Defina DUCKSIDE_BRIDGE_KEY, PUBLIC_BASE_URL HTTPS e DUCKSIDE_ADMIN_STEAM_IDS (SteamID64 dos admins) antes de iniciar em produção.')}

async function loadStore(){try{return JSON.parse(await readFile(storeFile,'utf8'))}catch{const seed=JSON.parse(await readFile(join(folder,'data','seed.json'),'utf8'));await saveStore(seed);return seed}}
async function saveStore(store){await mkdir(dirname(storeFile),{recursive:true});await writeFile(storeFile,JSON.stringify(store,null,2),'utf8')}
function sameSecret(received,expected){const a=Buffer.from(received||'');const b=Buffer.from(expected);return a.length===b.length&&timingSafeEqual(a,b)}
function passwordDigest(password,salt){return new Promise((resolve,reject)=>scrypt(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024},(error,key)=>error?reject(error):resolve(key.toString('hex'))))}
function hashToken(token){return createHash('sha256').update(token).digest('hex')}
function publicAccount(row){return {username:row.username,steamId:row.steam_id,isAdmin:adminSteamIds.has(row.steam_id)}}
function getAccountFromRequest(request){const token=(request.headers.authorization||'').replace(/^Bearer\s+/i,'');if(!token)return null;const row=accountsDb.prepare('SELECT a.* FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=? AND s.expires_at>?').get(hashToken(token),Date.now());return row?{...row,isAdmin:adminSteamIds.has(row.steam_id)}:null}
function isAdmin(request){return Boolean(getAccountFromRequest(request)?.isAdmin)}
function makeSession(accountId){const token=randomBytes(32).toString('base64url');accountsDb.prepare('INSERT INTO sessions(token_hash,account_id,expires_at,created_at) VALUES(?,?,?,?)').run(hashToken(token),accountId,Date.now()+30*24*60*60_000,Date.now());return token}
function consumeSteamTicket(ticket){const entry=pendingSteamTickets.get(ticket);pendingSteamTickets.delete(ticket);return entry&&entry.expiresAt>Date.now()?entry.steamId:null}
function pruneSteamAuth(){const now=Date.now();for(const [key,value] of pendingSteamStates)if(value.expiresAt<=now)pendingSteamStates.delete(key);for(const [key,value] of pendingSteamTickets)if(value.expiresAt<=now)pendingSteamTickets.delete(key)}
function cors(response){response.setHeader('Access-Control-Allow-Origin',process.env.DUCKSIDE_ALLOWED_ORIGIN||'*');response.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization, X-Bridge-Key, X-Media-Filename');response.setHeader('Access-Control-Allow-Methods','GET, HEAD, POST, DELETE, OPTIONS');response.setHeader('Content-Type','application/json; charset=utf-8')}
function send(response,status,body){cors(response);response.writeHead(status);response.end(JSON.stringify(body))}
async function readJson(request,maxBytes=6_000_000){const chunks=[];let length=0;for await(const chunk of request){length+=chunk.length;if(length>maxBytes)throw new Error('Corpo muito grande');chunks.push(chunk)}try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}')}catch{throw new Error('JSON inválido')}}
function publicStatus(store){const status=store.server;const lastHeartbeat=Date.parse(status.lastHeartbeat||'');const fresh=Number.isFinite(lastHeartbeat)&&Date.now()-lastHeartbeat<45_000;return {...status,online:Boolean(status.online&&fresh),lastHeartbeat:status.lastHeartbeat||null}}

const api=createServer(async(request,response)=>{
  const url=new URL(request.url,`http://${request.headers.host||'localhost'}`);
  if(request.method==='OPTIONS')return send(response,204,{});
  try{
    const store=await loadStore();
    if(request.method==='GET'&&url.pathname==='/health')return send(response,200,{ok:true,time:new Date().toISOString()});
    if(request.method==='GET'&&url.pathname==='/v1/public/launcher/bootstrap')return send(response,200,{content:store.content,server:publicStatus(store),news:store.news});
    if(request.method==='GET'&&url.pathname==='/v1/public/servers/duckside-rp/status')return send(response,200,publicStatus(store));
    if((request.method==='GET'||request.method==='HEAD')&&url.pathname.startsWith('/v1/public/media/')){
      const mediaParts=url.pathname.split('/');const kind=mediaParts[4];const safeName=decodeURIComponent(mediaParts[5]||'');const validName=/^[a-f0-9]{32}\.(png|jpg|jpeg|webp|mp4|webm)$/i.test(safeName);if(!validName||!['news','background'].includes(kind))return send(response,404,{error:'mídia não encontrada'});
      const isVideo=/\.(mp4|webm)$/i.test(safeName);if(kind==='background'&&!isVideo)return send(response,404,{error:'mídia não encontrada'});const filePath=join(kind==='news'?newsMediaFolder:backgroundMediaFolder,safeName);
      try{const info=await stat(filePath);const headers={'Content-Type':safeName.endsWith('.mp4')?'video/mp4':safeName.endsWith('.webm')?'video/webm':safeName.endsWith('.png')?'image/png':safeName.endsWith('.webp')?'image/webp':safeName.endsWith('.jpg')||safeName.endsWith('.jpeg')?'image/jpeg':'application/octet-stream','Content-Length':info.size,'Accept-Ranges':'bytes','Cache-Control':'public, max-age=86400','Access-Control-Allow-Origin':process.env.DUCKSIDE_ALLOWED_ORIGIN||'*'};const range=request.headers.range?.match(/^bytes=(\d*)-(\d*)$/);if(range){const start=range[1]?Number(range[1]):0;const end=Math.min(range[2]?Number(range[2]):info.size-1,info.size-1);if(start>end||start>=info.size){response.writeHead(416,{'Content-Range':`bytes */${info.size}`});return response.end()}headers['Content-Range']=`bytes ${start}-${end}/${info.size}`;headers['Content-Length']=end-start+1;response.writeHead(206,headers);if(request.method==='HEAD')return response.end();return createReadStream(filePath,{start,end}).pipe(response)}response.writeHead(200,headers);if(request.method==='HEAD')return response.end();return createReadStream(filePath).pipe(response)}catch{return send(response,404,{error:'mídia não encontrada'})}
    }
    if(request.method==='GET'&&url.pathname.startsWith('/v1/public/updates/')){const filename=decodeURIComponent(url.pathname.split('/').pop());if(!/^[\w.-]+\.(zip|exe|yml|blockmap)$/i.test(filename))return send(response,400,{error:'arquivo inválido'});const isLauncher=url.pathname.includes('/launcher/');const filePath=join(isLauncher?launcherUpdatesFolder:contentUpdatesFolder,filename);try{await stat(filePath);response.writeHead(200,{'Content-Type':filename.endsWith('.yml')?'text/yaml':filename.endsWith('.blockmap')?'application/octet-stream':filename.endsWith('.exe')?'application/vnd.microsoft.portable-executable':'application/zip','Content-Disposition':`attachment; filename="${filename}"`,'Access-Control-Allow-Origin':process.env.DUCKSIDE_ALLOWED_ORIGIN||'*'});return createReadStream(filePath).pipe(response)}catch{return send(response,404,{error:'arquivo não encontrado'})}}
    if(request.method==='GET'&&url.pathname==='/v1/auth/steam/start'){
      if(!publicBaseUrl)return send(response,503,{error:'Login Steam ainda não foi configurado no servidor.'});
      pruneSteamAuth();const state=randomBytes(24).toString('base64url');pendingSteamStates.set(state,{expiresAt:Date.now()+10*60_000});
      const returnTo=`${publicBaseUrl}/v1/auth/steam/callback?state=${encodeURIComponent(state)}`;const realm=new URL(publicBaseUrl).origin+'/';
      const steamUrl=new URL('https://steamcommunity.com/openid/login');for(const [key,value] of Object.entries({'openid.ns':'http://specs.openid.net/auth/2.0','openid.mode':'checkid_setup','openid.return_to':returnTo,'openid.realm':realm,'openid.identity':'http://specs.openid.net/auth/2.0/identifier_select','openid.claimed_id':'http://specs.openid.net/auth/2.0/identifier_select'}))steamUrl.searchParams.set(key,value);
      return send(response,200,{authUrl:steamUrl.href});
    }
    if(request.method==='GET'&&url.pathname==='/v1/auth/steam/callback'){
      pruneSteamAuth();const state=url.searchParams.get('state');const pending=pendingSteamStates.get(state);if(!pending||pending.expiresAt<Date.now()){response.writeHead(400,{'Content-Type':'text/plain; charset=utf-8'});return response.end('Solicitação Steam expirada. Volte ao launcher e tente novamente.')}
      pendingSteamStates.delete(state);const returnTo=`${publicBaseUrl}/v1/auth/steam/callback?state=${encodeURIComponent(state)}`;
      if(url.searchParams.get('openid.mode')!=='id_res'||url.searchParams.get('openid.return_to')!==returnTo){response.writeHead(401,{'Content-Type':'text/plain; charset=utf-8'});return response.end('Autenticação Steam cancelada ou inválida.')}
      const claimed=url.searchParams.get('openid.claimed_id')||'';const match=claimed.match(/^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/);if(!match||url.searchParams.get('openid.identity')!==claimed){response.writeHead(401,{'Content-Type':'text/plain; charset=utf-8'});return response.end('SteamID inválido.')}
      const verification=new URLSearchParams(url.searchParams);verification.set('openid.mode','check_authentication');let verified=false;
      try{const result=await fetch('https://steamcommunity.com/openid/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:verification});verified=(await result.text()).split(/\r?\n/).includes('is_valid:true')}catch{}
      if(!verified){response.writeHead(401,{'Content-Type':'text/plain; charset=utf-8'});return response.end('A Steam não confirmou esta autenticação.')}
      const ticket=randomBytes(32).toString('base64url');pendingSteamTickets.set(ticket,{steamId:match[1],expiresAt:Date.now()+3*60_000});response.writeHead(302,{Location:`duckside-launcher://steam-auth?ticket=${encodeURIComponent(ticket)}`});return response.end();
    }
    if(request.method==='POST'&&url.pathname==='/v1/auth/register'){
      const payload=await readJson(request,20_000);const username=typeof payload.username==='string'?payload.username.trim():'',password=typeof payload.password==='string'?payload.password:'';const usernameNorm=username.toLocaleLowerCase('en-US');
      if(!/^[a-zA-Z0-9_.-]{3,24}$/.test(username))return send(response,422,{error:'O nome deve ter de 3 a 24 caracteres: letras, números, ponto, hífen ou sublinhado.'});
      if([...password].length<12||[...password].length>128)return send(response,422,{error:'A senha precisa ter entre 12 e 128 caracteres.'});
      const steamId=consumeSteamTicket(typeof payload.ticket==='string'?payload.ticket:'');if(!steamId)return send(response,401,{error:'Conecte sua conta Steam antes de criar a conta Duckside.'});
      const salt=randomBytes(16).toString('hex');const passwordHash=await passwordDigest(password,salt);
      try{const result=accountsDb.prepare('INSERT INTO accounts(username,username_norm,steam_id,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?)').run(username,usernameNorm,steamId,salt,passwordHash,Date.now());const token=makeSession(Number(result.lastInsertRowid));const row=accountsDb.prepare('SELECT * FROM accounts WHERE id=?').get(Number(result.lastInsertRowid));return send(response,201,{token,user:publicAccount(row)})}
      catch(error){if(String(error.code||'').includes('SQLITE_CONSTRAINT'))return send(response,409,{error:'Este nome ou esta conta Steam já está vinculada a uma conta Duckside.'});throw error}
    }
    if(request.method==='POST'&&url.pathname==='/v1/auth/login'){
      const payload=await readJson(request,20_000);const username=typeof payload.username==='string'?payload.username.trim():'',password=typeof payload.password==='string'?payload.password:'';const usernameNorm=username.toLocaleLowerCase('en-US');const ip=request.socket.remoteAddress||'unknown';const key=ip;let attempt=authFailures.get(key)||{count:0,until:0};if(Date.now()<attempt.until)return send(response,429,{error:'Muitas tentativas deste endereço. Aguarde 15 minutos.'});
      const row=accountsDb.prepare('SELECT * FROM accounts WHERE username_norm=?').get(usernameNorm);const digest=await passwordDigest(password.slice(0,128),row?.password_salt||'duckside-invalid-account');
      if(!row||!sameSecret(digest,row.password_hash)){attempt.count++;attempt.until=attempt.count>=10?Date.now()+15*60_000:0;if(authFailures.size>10_000)for(const [oldKey,oldValue] of authFailures)if(oldValue.until<Date.now())authFailures.delete(oldKey);authFailures.set(key,attempt);return send(response,401,{error:'Nome ou senha incorretos.'})}
      authFailures.delete(key);const token=makeSession(row.id);return send(response,200,{token,user:publicAccount(row)})
    }
    if(request.method==='GET'&&url.pathname==='/v1/auth/me'){const account=getAccountFromRequest(request);return account?send(response,200,{user:publicAccount(account)}):send(response,401,{error:'sessão expirada'})}
    if(request.method==='POST'&&url.pathname==='/v1/auth/logout'){const bearer=(request.headers.authorization||'').replace(/^Bearer\s+/i,'');if(bearer)accountsDb.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(bearer));return send(response,200,{ok:true})}
    if(request.method==='POST'&&/^\/v1\/admin\/media\/(news|background)$/.test(url.pathname)){
      if(!isAdmin(request))return send(response,401,{error:'admin não autorizado'});const kind=url.pathname.endsWith('/background')?'background':'news';const suppliedName=String(request.headers['x-media-filename']||'').slice(0,240);const extension=suppliedName.slice(suppliedName.lastIndexOf('.')).toLowerCase();const valid=kind==='news'?['.png','.jpg','.jpeg','.webp','.mp4','.webm'].includes(extension):['.mp4','.webm'].includes(extension);if(!valid)return send(response,422,{error:'formato inválido; use imagem PNG/JPG/WebP ou vídeo MP4/WebM'});
      const limit=['.mp4','.webm'].includes(extension)?100_000_000:8_000_000;const mediaFolder=kind==='news'?newsMediaFolder:backgroundMediaFolder;await mkdir(mediaFolder,{recursive:true,mode:0o700});const filename=`${randomBytes(16).toString('hex')}${extension}`;let bytes=0;const limiter=new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;if(bytes>limit)return callback(new Error(`arquivo excede o limite de ${Math.floor(limit/1_000_000)} MB`));callback(null,chunk)}});
      try{await pipeline(request,limiter,createWriteStream(join(mediaFolder,filename),{flags:'wx',mode:0o600}));if(bytes===0)return send(response,422,{error:'arquivo vazio'});const mediaUrl=`/v1/public/media/${kind}/${filename}`;if(kind==='background'){store.content.homeBackgroundVideo=mediaUrl;await saveStore(store)}return send(response,201,{ok:true,url:mediaUrl,mediaType:['.mp4','.webm'].includes(extension)?'video':'image',size:bytes})}catch(error){return send(response,413,{error:error.message||'falha ao receber mídia'})}
    }
    if(request.method==='GET'&&url.pathname.startsWith('/v1/players/')){const steamId=decodeURIComponent(url.pathname.split('/').pop());return send(response,200,{characters:store.characters[steamId]||[]})}
    if(request.method==='POST'&&url.pathname==='/v1/bridge/heartbeat'){
      if(!sameSecret(request.headers['x-bridge-key'],bridgeKey))return send(response,401,{error:'bridge não autorizado'});
      const payload=await readJson(request);const count=Number(payload.playerCount);const max=Number(payload.maxPlayers);if(!Number.isInteger(count)||count<0||!Number.isInteger(max)||max<1)return send(response,422,{error:'playerCount e maxPlayers válidos são obrigatórios'});
      store.server={name:String(payload.name||store.server.name).slice(0,80),online:Boolean(payload.online),playerCount:count,maxPlayers:max,pingMs:Math.max(0,Number(payload.pingMs)||0),lastHeartbeat:new Date().toISOString()};await saveStore(store);return send(response,200,{ok:true,status:publicStatus(store)})
    }
    if(request.method==='POST'&&url.pathname==='/v1/bridge/players/'){
      if(!sameSecret(request.headers['x-bridge-key'],bridgeKey))return send(response,401,{error:'bridge não autorizado'});
      const payload=await readJson(request);if(typeof payload.steamId!=='string'||!Array.isArray(payload.characters))return send(response,422,{error:'steamId e characters são obrigatórios'});
      store.characters[payload.steamId]=payload.characters.slice(0,8).map(character=>({id:String(character.id||crypto.randomUUID()).slice(0,60),name:String(character.name||'Sobrevivente').slice(0,60),meta:String(character.meta||'Duckside RP').slice(0,80),role:String(character.role||'SOBREVIVENTE').slice(0,30),image:typeof character.image==='string'?character.image.slice(0,500):null}));await saveStore(store);return send(response,200,{ok:true})
    }
    if(request.method==='POST'&&url.pathname==='/v1/admin/launcher-content'){
      if(!isAdmin(request))return send(response,401,{error:'admin não autorizado'});
      const payload=await readJson(request);for(const key of ['eyebrow','title','description','playText','note','updateTitle','updateName','updateVersion','updateDescription','announcementLabel','announcementSkipText','announcementNewsText'])if(typeof payload[key]!=='string'||payload[key].length>200)return send(response,422,{error:`Campo inválido: ${key}`});if(payload.homeBackgroundVideo!==undefined&&payload.homeBackgroundVideo!==null&&!/^\/v1\/public\/media\/background\/[a-f0-9]{32}\.(mp4|webm)$/i.test(payload.homeBackgroundVideo))return send(response,422,{error:'vídeo de fundo inválido'});store.content={...store.content,...payload};await saveStore(store);return send(response,200,{ok:true,content:store.content})
    }
    if(request.method==='POST'&&url.pathname==='/v1/admin/news'){
      if(!isAdmin(request))return send(response,401,{error:'admin não autorizado'});const item=await readJson(request);const validImage=item.image==null||typeof item.image==='string'&&item.image.length<=4_700_000&&(/^data:image\/(png|jpeg|webp);base64,/i.test(item.image)||/^\/v1\/public\/media\/news\/[a-f0-9]{32}\.(png|jpg|jpeg|webp)$/i.test(item.image));const validVideo=item.video==null||typeof item.video==='string'&&/^\/v1\/public\/media\/news\/[a-f0-9]{32}\.(mp4|webm)$/i.test(item.video);if(typeof item.title!=='string'||!item.title.trim()||item.title.length>90||typeof item.body!=='string'||!item.body.trim()||item.body.length>600||typeof item.date!=='string'||item.date.length>30||!validImage||!validVideo||item.image&&item.video||item.showOnOpen!==undefined&&typeof item.showOnOpen!=='boolean')return send(response,422,{error:'novidade inválida'});const id=String(item.id||crypto.randomUUID()).slice(0,60);const entry={id,date:item.date,title:item.title.trim(),body:item.body.trim(),image:item.image||null,video:item.video||null,showOnOpen:item.showOnOpen!==false};const index=store.news.findIndex(n=>n.id===id);if(index<0)store.news.unshift(entry);else store.news[index]=entry;store.news=store.news.slice(0,50);await saveStore(store);return send(response,200,{ok:true,news:store.news})
    }
    if(request.method==='DELETE'&&url.pathname.startsWith('/v1/admin/news/')){
      if(!isAdmin(request))return send(response,401,{error:'admin não autorizado'});const id=decodeURIComponent(url.pathname.split('/').pop());store.news=store.news.filter(item=>item.id!==id);await saveStore(store);return send(response,200,{ok:true})
    }
    if(request.method==='POST'&&url.pathname.startsWith('/v1/admin/updates/')){
      if(!isAdmin(request))return send(response,401,{error:'admin não autorizado'});const pieces=url.pathname.split('/');const type=pieces.at(-2);const filename=decodeURIComponent(pieces.at(-1)).replace(/[^a-zA-Z0-9_.-]/g,'_');const valid=type==='launcher'?/^[\w.-]+\.(exe|yml|blockmap)$/i.test(filename):type==='content'?/^[\w.-]+\.zip$/i.test(filename):false;if(!valid)return send(response,400,{error:'arquivo inválido para este tipo de atualização'});const folderPath=type==='launcher'?launcherUpdatesFolder:contentUpdatesFolder;await mkdir(folderPath,{recursive:true});let bytes=0;const limit=500_000_000;const limiter=new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;if(bytes>limit)return callback(new Error('limite de 500 MB excedido'));callback(null,chunk)}});try{await pipeline(request,limiter,createWriteStream(join(folderPath,filename),{flags:'w'}));if(type==='content'){store.content.updatePackage=`/v1/public/updates/content/${encodeURIComponent(filename)}`;store.content.updatePackageName=filename;await saveStore(store)}return send(response,200,{ok:true,file:filename,size:bytes,url:`/v1/public/updates/${type}/${encodeURIComponent(filename)}`})}catch(error){return send(response,413,{error:error.message||'falha ao receber arquivo'})}
    }
    return send(response,404,{error:'rota não encontrada'});
  }catch(error){console.error(error);return send(response,400,{error:error.message||'erro inesperado'})}
});
api.listen(port,()=>console.log(`Duckside API ouvindo em http://localhost:${port}`));

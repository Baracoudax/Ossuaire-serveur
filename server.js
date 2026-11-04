// Serveur d'Ossuaire : comptes joueurs (pseudo + mot de passe), sauvegarde de la progression,
// rang classé calculé ici, classement, liste des parties publiques et mise en relation des navigateurs (PeerJS).
// Données : PostgreSQL si DATABASE_URL est défini (Neon, Render…), sinon un fichier JSON local (essais).
'use strict';
const http=require('http'),path=require('path'),fs=require('fs'),crypto=require('crypto');
const express=require('express'),{ExpressPeerServer}=require('peer');

const PORT=+process.env.PORT||8080;
const SECRET=process.env.SECRET||(()=>{console.warn('[!] SECRET absent : jeton de session temporaire (les joueurs devront se reconnecter au redémarrage)');return crypto.randomBytes(32).toString('hex')})();
const DATA_FILE=process.env.DATA_FILE||path.join(__dirname,'donnees.json');
const TOKEN_DAYS=90,MAX_DATA=256*1024;

// ---------- stockage : tous les comptes en mémoire, chaque modification est écrite (PostgreSQL ou fichier) ----------
const users=new Map(),byKey=new Map();let nextId=1;
const keyOf=n=>n.normalize('NFKC').toLowerCase();
const store={
  pg:null,
  async init(){
    if(process.env.DATABASE_URL){
      const {Pool}=require('pg');
      this.pg=new Pool({connectionString:process.env.DATABASE_URL,ssl:/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)?false:{rejectUnauthorized:false},max:4});
      await this.pg.query('create table if not exists joueurs (id integer primary key, cle text unique not null, doc jsonb not null)');
      const r=await this.pg.query('select doc from joueurs');for(const row of r.rows)this.add(row.doc);
      console.log('PostgreSQL :',users.size,'comptes');
    }else{
      try{for(const u of JSON.parse(fs.readFileSync(DATA_FILE,'utf8')))this.add(u)}catch(e){if(e.code!=='ENOENT')throw e}
      console.log('Fichier',DATA_FILE,':',users.size,'comptes');
    }
  },
  add(u){users.set(u.id,u);byKey.set(keyOf(u.name),u);if(u.id>=nextId)nextId=u.id+1},
  t:null,
  async save(u){
    if(this.pg){await this.pg.query('insert into joueurs (id,cle,doc) values ($1,$2,$3) on conflict (id) do update set doc=excluded.doc',[u.id,keyOf(u.name),u]);return}
    // fichier : une écriture groupée par seconde, dans un fichier temporaire puis renommé (pas de fichier à moitié écrit)
    if(!this.t)this.t=setTimeout(()=>{this.t=null;const tmp=DATA_FILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify([...users.values()]));fs.renameSync(tmp,DATA_FILE)},1000);
  }
};

// ---------- mots de passe (scrypt) et jetons de session signés (HMAC) ----------
const scrypt=(pass,salt)=>new Promise((ok,ko)=>crypto.scrypt(pass,salt,64,{N:16384,r:8,p:1},(e,k)=>e?ko(e):ok(k)));
async function hashPass(pass){const salt=crypto.randomBytes(16);return salt.toString('base64')+':'+(await scrypt(pass,salt)).toString('base64')}
async function checkPass(pass,stored){const [s,h]=stored.split(':');const k=await scrypt(pass,Buffer.from(s,'base64')),H=Buffer.from(h,'base64');return k.length===H.length&&crypto.timingSafeEqual(k,H)}
const b64u=b=>Buffer.from(b).toString('base64url'),sign=s=>crypto.createHmac('sha256',SECRET).update(s).digest('base64url');
// le jeton porte la « génération » du mot de passe : en changer déconnecte les autres appareils
function tokenFor(u){const p=b64u(JSON.stringify({u:u.id,g:u.gen|0,x:Date.now()+TOKEN_DAYS*864e5}));return p+'.'+sign(p)}
function userOf(req){
  const m=/^Bearer (.+)\.(.+)$/.exec(req.get('authorization')||'');if(!m)return null;
  const s=sign(m[1]);if(s.length!==m[2].length||!crypto.timingSafeEqual(Buffer.from(s),Buffer.from(m[2])))return null;
  let p;try{p=JSON.parse(Buffer.from(m[1],'base64url').toString())}catch(e){return null}
  const u=users.get(p.u);return u&&p.x>Date.now()&&(u.gen|0)===p.g?u:null;
}

// ---------- limites : tentatives de connexion par adresse, envois de résultats par compte ----------
const hits=new Map();
function limited(key,max,ms){const now=Date.now();let h=hits.get(key);if(!h||now-h.t>ms){h={t:now,n:0};hits.set(key,h)}return ++h.n>max}
setInterval(()=>{const now=Date.now();for(const [k,h] of hits)if(now-h.t>36e5)hits.delete(k)},6e5).unref();
const ipOf=req=>(req.get('x-forwarded-for')||'').split(',')[0].trim()||req.socket.remoteAddress||'?';

// ---------- rang classé : même calcul que le jeu, mais tenu ici ----------
const SEASON=()=>{const d=new Date();return d.getUTCFullYear()*12+d.getUTCMonth()};
const RKT=[0,1100,1250,1400,1550,1700];
const tierOf=r=>{let i=0;RKT.forEach((v,j)=>{if(r>=v)i=j});return i};
function season(u){const n=SEASON();if(u.rs!==n){if(u.rs&&u.rank>0)u.rank=Math.round(1000+(u.rank-1000)/2);u.rs=n;u.rkn=0}if(!(u.rank>0))u.rank=1000}
const pub=u=>(season(u),{name:u.name,rank:u.rank,rkn:u.rkn|0,rkb:u.rkb|0,rs:u.rs,surv:u.surv|0,wave:u.wave|0,vw:u.vw|0,vk:u.vk|0,created:u.created});

// ---------- application ----------
const app=express();
app.set('trust proxy',true);
app.use((req,res,next)=>{res.set({'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Allow-Methods':'GET, POST, PUT, DELETE, OPTIONS','Access-Control-Max-Age':'86400'});if(req.method==='OPTIONS')return res.sendStatus(204);next()});
app.use('/api',express.json({limit:MAX_DATA+4096}));
const wrap=f=>(req,res)=>Promise.resolve(f(req,res)).catch(e=>{console.error(e);res.status(500).json({err:'serveur'})});
const auth=f=>wrap(async(req,res)=>{const u=userOf(req);if(!u)return res.status(401).json({err:'session'});return f(req,res,u)});

app.get('/api/ping',(req,res)=>res.json({ok:1,v:1,users:users.size,games:games.size}));

const NAME_RE=/^[\p{L}\p{N}_\-. ]{3,16}$/u;
app.post('/api/register',wrap(async(req,res)=>{
  if(limited('reg:'+ipOf(req),8,36e5))return res.status(429).json({err:'trop'});
  const name=String(req.body.name||'').trim().replace(/\s+/g,' '),pass=String(req.body.pass||'');
  if(!NAME_RE.test(name))return res.status(400).json({err:'pseudo'});
  if(pass.length<6||pass.length>200)return res.status(400).json({err:'motdepasse'});
  if(byKey.has(keyOf(name)))return res.status(409).json({err:'pris'});
  const u={id:nextId++,name,hash:await hashPass(pass),gen:0,created:Date.now(),data:null,dataT:0,rank:1000,rkn:0,rkb:0,rs:SEASON(),surv:0,wave:0,vw:0,vk:0,rkT:0};
  if(byKey.has(keyOf(name)))return res.status(409).json({err:'pris'});// pris pendant le calcul du mot de passe
  store.add(u);
  // nouveau compte : on reprend la progression de l'appareil s'il en envoie une
  if(req.body.data&&typeof req.body.data==='object'&&JSON.stringify(req.body.data).length<=MAX_DATA){u.data=req.body.data;u.dataT=Date.now();
}
  // et son rang (plafonné à 1300 : le rang au-delà se gagne en ligne)
  {const r=+req.body.rank;if(r>0)u.rank=Math.max(100,Math.min(1300,Math.round(r)))}
  await store.save(u);res.json({token:tokenFor(u),me:pub(u),data:u.data,dataT:u.dataT});
}));
app.post('/api/login',wrap(async(req,res)=>{
  const ip=ipOf(req),name=String(req.body.name||'').trim(),pass=String(req.body.pass||'');
  if(limited('log:'+ip,20,9e5)||limited('logu:'+keyOf(name),10,9e5))return res.status(429).json({err:'trop'});
  const u=byKey.get(keyOf(name.replace(/\s+/g,' ')));
  if(!u||!(await checkPass(pass,u.hash)))return res.status(401).json({err:'identifiants'});
  res.json({token:tokenFor(u),me:pub(u),data:u.data,dataT:u.dataT});
}));
app.get('/api/me',auth(async(req,res,u)=>res.json({me:pub(u),data:u.data,dataT:u.dataT})));
// sauvegarde de la progression et des réglages (les clés du jeu, telles quelles)
app.put('/api/me/data',auth(async(req,res,u)=>{
  const d=req.body.data;if(!d||typeof d!=='object'||Array.isArray(d))return res.status(400).json({err:'donnees'});
  if(JSON.stringify(d).length>MAX_DATA)return res.status(413).json({err:'taille'});
  if(limited('dat:'+u.id,120,36e5))return res.status(429).json({err:'trop'});
  u.data=d;u.dataT=Date.now();await store.save(u);res.json({ok:1,dataT:u.dataT});
}));
app.post('/api/me/pass',auth(async(req,res,u)=>{
  const o=String(req.body.old||''),n=String(req.body.pass||'');
  if(limited('pw:'+u.id,10,36e5))return res.status(429).json({err:'trop'});
  if(!(await checkPass(o,u.hash)))return res.status(401).json({err:'identifiants'});
  if(n.length<6||n.length>200)return res.status(400).json({err:'motdepasse'});
  u.hash=await hashPass(n);u.gen=(u.gen|0)+1;await store.save(u);res.json({token:tokenFor(u)});
}));
// fin d'une partie classée : le serveur applique lui-même le barème (victoire, défaite, égalité, écart éliminations-morts borné)
app.post('/api/rank',auth(async(req,res,u)=>{
  season(u);const now=Date.now();
  if(now-(u.rkT||0)<60e3)return res.status(429).json({err:'trop',me:pub(u)});// une partie classée dure bien plus d'une minute
  const b=req.body,won=!!b.won,draw=!!b.draw,perf=Math.max(-8,Math.min(8,Math.round(+b.perf||0)));
  const r0=u.rank,d=Math.round(draw?perf*.5:(won?24:-18)+perf*(won?.6:.4)),r1=Math.max(100,r0+d);
  u.rank=r1;u.rkn=(u.rkn|0)+1;u.rkT=now;const ti=tierOf(r1);if(ti>(u.rkb|0))u.rkb=ti;
  await store.save(u);res.json({r0,r1,d,me:pub(u)});
}));
// meilleurs scores (survie, victoires et éliminations en VS)
app.post('/api/score',auth(async(req,res,u)=>{
  if(limited('sc:'+u.id,60,36e5))return res.status(429).json({err:'trop'});
  const b=req.body,n=x=>Math.max(0,Math.floor(+x||0));
  if(n(b.surv)<=5e6&&n(b.surv)>u.surv)u.surv=n(b.surv);if(n(b.wave)<=999&&n(b.wave)>u.wave)u.wave=n(b.wave);
  if(b.vw)u.vw=(u.vw|0)+1;u.vk=(u.vk|0)+Math.min(150,n(b.vk));
  await store.save(u);res.json({me:pub(u)});
}));
app.get('/api/lb',(req,res)=>{
  const t=req.query.t==='r'?'r':req.query.t==='v'?'v':'s',S=SEASON();
  let L=[...users.values()];
  if(t==='s')L=L.filter(u=>u.surv>0).sort((a,b)=>b.surv-a.surv);
  else if(t==='v')L=L.filter(u=>(u.vw|0)+(u.vk|0)>0).sort((a,b)=>(b.vw-a.vw)||(b.vk-a.vk));
  else L=L.filter(u=>u.rs===S&&(u.rkn|0)>0).sort((a,b)=>b.rank-a.rank);
  res.set('Cache-Control','public, max-age=10').json(L.slice(0,20).map(u=>({n:u.name,surv:u.surv|0,wave:u.wave|0,vw:u.vw|0,vk:u.vk|0,rk:u.rank,rkn:u.rkn|0,rs:u.rs})));
});

// ---------- parties publiques : l'hôte s'annonce toutes les 5 s, l'annonce s'efface après 15 s de silence ----------
const games=new Map();
setInterval(()=>{const now=Date.now();for(const [k,g] of games)if(now-g.t>15e3)games.delete(k)},5e3).unref();
app.post('/api/games',(req,res)=>{
  const b=req.body||{},code=String(b.code||'');if(!/^[A-Z]{4}$/.test(code))return res.status(400).json({err:'code'});
  if(limited('g:'+ipOf(req),60,6e4))return res.status(429).json({err:'trop'});
  const g={code,t:Date.now(),m:b.m==='tdm'?'tdm':'surv',rk:!!b.rk,r:Math.max(0,Math.min(5000,+b.r||1000)),n:Math.max(1,Math.min(20,b.n|0)),max:Math.max(2,Math.min(20,b.max|0)),
    th:b.th|0,ts:b.ts|0,info:String(b.info||'').slice(0,160)};
  if(!games.has(code)&&games.size>=500)return res.status(503).json({err:'plein'});
  games.set(code,g);res.json({ok:1});
});
app.delete('/api/games/:code',(req,res)=>{games.delete(String(req.params.code));res.json({ok:1})});
app.get('/api/games',(req,res)=>{const m=req.query.m;res.set('Cache-Control','no-store').json([...games.values()].filter(g=>!m||g.m===m).map(({t,...g})=>g))});

// ---------- le jeu lui-même, si le dossier public/ existe (sinon il est hébergé ailleurs, sur itch.io par exemple) ----------
const PUB=path.join(__dirname,'public');
if(fs.existsSync(PUB))app.use(express.static(PUB,{maxAge:'1h',setHeaders:(res,p)=>{if(/\.html$|sw\.js$/.test(p))res.set('Cache-Control','no-cache')}}));
else app.get('/',(req,res)=>res.type('text').send('Serveur Ossuaire en marche.'));

const srv=http.createServer(app);
// mise en relation des navigateurs : les parties se jouent ensuite directement entre eux
app.use('/peer',ExpressPeerServer(srv,{path:'/',allow_discovery:false,alive_timeout:60000}));

store.init().then(()=>srv.listen(PORT,()=>console.log('Ossuaire sur le port',PORT))).catch(e=>{console.error('Démarrage impossible :',e.message);process.exit(1)});
for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>{if(store.t){clearTimeout(store.t);const tmp=DATA_FILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify([...users.values()]));fs.renameSync(tmp,DATA_FILE)}process.exit(0)});

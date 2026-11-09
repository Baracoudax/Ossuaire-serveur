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
      await this.pg.query('create table if not exists signalements (id bigserial primary key, t bigint not null, doc jsonb not null)');
      await this.pg.query('create table if not exists erreurs (sig text primary key, doc jsonb not null)');
      await this.pg.query('create table if not exists stats (k text primary key, doc jsonb not null)');
      {const r=await this.pg.query("select doc from stats where k='all'");if(r.rows[0])Object.assign(STATS,r.rows[0].doc)}
      {const r=await this.pg.query('select doc from erreurs');for(const row of r.rows)errAdd(row.doc)}
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
// semaine (lundi 0 h UTC) de la « Survie de la semaine » : même carte pour tout le monde, classement remis à zéro chaque lundi
const WEEKU=()=>Math.floor((Math.floor(Date.now()/864e5)+3)/7);
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
  {const R=runOf(u,'v',req.body&&req.body.run);if(!R||R.rk||now-R.t<90e3){cheat(u,'classé : '+(!R?'partie inconnue':R.rk?'déjà compté':'trop court'));return res.status(400).json({err:'partie',me:pub(u)})}R.rk=1}
  const b=req.body,won=!!b.won,draw=!!b.draw,perf=Math.max(-8,Math.min(8,Math.round(+b.perf||0)));
  const r0=u.rank,d=Math.round(draw?perf*.5:(won?24:-18)+perf*(won?.6:.4)),r1=Math.max(100,r0+d);
  u.rank=r1;u.rkn=(u.rkn|0)+1;u.rkT=now;const ti=tierOf(r1);if(ti>(u.rkb|0))u.rkb=ti;
  await store.save(u);res.json({r0,r1,d,me:pub(u)});
}));
// ---------- parties déclarées : le jeu annonce le début d'une partie ; le score n'est accepté qu'une fois par partie, avec une durée vraisemblable ----------
// en mémoire seulement (un redémarrage du serveur en pleine partie fait perdre l'envoi de cette partie-là, sans autre effet)
const runs=new Map();// id du compte → {s:{id,t,sc}, v:{id,t,sc,rk}}
app.post('/api/run',auth(async(req,res,u)=>{if(limited('run:'+u.id,120,36e5))return res.status(429).json({err:'trop'});
  const m=req.body&&req.body.m==='v'?'v':'s',R=runs.get(u.id)||{},id=crypto.randomBytes(6).toString('hex');R[m]={id,t:Date.now(),sc:0,rk:0};runs.set(u.id,R);res.json({id})}));
setInterval(()=>{const old=Date.now()-6*36e5;for(const [k,R] of runs){for(const m in R)if(R[m].t<old)delete R[m];if(!R.s&&!R.v)runs.delete(k)}},36e5).unref();
const runOf=(u,m,id)=>{const r=(runs.get(u.id)||{})[m];return r&&id&&r.id===String(id)?r:null};
// plafond de score de survie à la vague w : très large (environ dix fois une bonne partie), il n'écarte que l'invraisemblable
const survMax=w=>{let s=30000;for(let i=1;i<=w;i++)s+=(6+3*i)*600+5000;return s};
const cheat=(u,why)=>console.warn('[score refusé]',u.name,why);
// meilleurs scores (survie, victoires et éliminations en VS)
app.post('/api/score',auth(async(req,res,u)=>{
  if(limited('sc:'+u.id,60,36e5))return res.status(429).json({err:'trop'});
  const b=req.body,n=x=>Math.max(0,Math.floor(+x||0)),now=Date.now();
  // survie : une seule fois par partie déclarée, vague atteignable dans le temps écoulé, score sous le plafond de la vague
  if(n(b.surv)||n(b.wave)||n(b.wk)){const R=runOf(u,'s',b.run),el=R?(now-R.t)/1000:0,w=n(b.wave),w0=Math.min(w,n(b.w0));// w0 : vague déjà atteinte quand on a rejoint une partie en ligne
    const why=!R?'partie inconnue':R.sc?'déjà envoyé':w>999?'vague':el<(w-w0-1)*12?'trop rapide ('+Math.round(el)+' s, vague '+w+')':Math.max(n(b.surv),n(b.wk))>survMax(Math.max(1,w))?'score '+Math.max(n(b.surv),n(b.wk))+' > '+survMax(Math.max(1,w)):'';
    if(why){cheat(u,why);b.surv=b.wave=b.wk=0}else R.sc=1}
  // VS : une seule fois par partie déclarée, au moins une minute de jeu, éliminations bornées par la durée
  if(b.vw!==undefined||n(b.vk)){const R=runOf(u,'v',b.run),el=R?(now-R.t)/1000:0;
    const why=!R?'partie VS inconnue':R.sc?'VS déjà envoyé':el<60?'VS trop court':'';
    if(why){cheat(u,why);b.vw=0;b.vk=0}else{R.sc=1;b.vk=Math.min(n(b.vk),Math.floor(el/2))}}
  if(n(b.surv)<=5e6&&n(b.surv)>u.surv)u.surv=n(b.surv);if(n(b.wave)<=999&&n(b.wave)>u.wave)u.wave=n(b.wave);
  if(b.vw)u.vw=(u.vw|0)+1;u.vk=(u.vk|0)+Math.min(150,n(b.vk));
  if(n(b.wk)>0&&n(b.wk)<=5e6&&(+b.wkw===WEEKU()||+b.wkw===WEEKU()-1)){const w=+b.wkw;if(!u.wk||u.wk.w<w||u.wk.w===w&&n(b.wk)>u.wk.s)u.wk={w,s:n(b.wk),v:Math.min(999,n(b.wave))}}
  await store.save(u);res.json({me:pub(u)});
}));
app.get('/api/lb',(req,res)=>{
  const t=req.query.t==='r'?'r':req.query.t==='v'?'v':req.query.t==='w'?'w':'s',S=SEASON(),WK=WEEKU();
  let L=[...users.values()];
  if(t==='s')L=L.filter(u=>u.surv>0).sort((a,b)=>b.surv-a.surv);
  else if(t==='w')L=L.filter(u=>u.wk&&u.wk.w===WK&&u.wk.s>0).sort((a,b)=>b.wk.s-a.wk.s);
  else if(t==='v')L=L.filter(u=>(u.vw|0)+(u.vk|0)>0).sort((a,b)=>(b.vw-a.vw)||(b.vk-a.vk));
  else L=L.filter(u=>u.rs===S&&(u.rkn|0)>0).sort((a,b)=>b.rank-a.rank);
  res.set('Cache-Control','public, max-age=10').json(L.slice(0,20).map(u=>({n:u.name,surv:u.surv|0,wave:u.wave|0,vw:u.vw|0,vk:u.vk|0,rk:u.rank,rkn:u.rkn|0,rs:u.rs,...(u.wk&&u.wk.w===WK?{wks:u.wk.s,wkv:u.wk.v,wkw:u.wk.w}:{})})));
});

// ---------- relais réseau (TURN) : indispensables quand deux joueurs sont derrière des box ou en 4G ----------
// CF_TURN_ID + CF_TURN_TOKEN (Cloudflare, 1000 Go gratuits par mois) ou METERED_APP + METERED_KEY (Metered) : identifiants demandés au service, gardés 10 min en cache ;
// sinon TURN_URLS (séparées par des virgules) + TURN_USER + TURN_PASS ; sinon seulement les serveurs STUN publics.
const STUN=[{urls:['stun:stun.l.google.com:19302','stun:stun1.l.google.com:19302']}];
let iceCache={t:0,v:null};
async function iceServers(){
  if(iceCache.v&&Date.now()-iceCache.t<6e5)return iceCache.v;
  let v=null;
  // Cloudflare (1000 Go gratuits par mois) : identifiant de la clé TURN + son jeton d'API
  if(process.env.CF_TURN_ID&&process.env.CF_TURN_TOKEN){
    const base='https://rtc.live.cloudflare.com/v1/turn/keys/'+encodeURIComponent(process.env.CF_TURN_ID)+'/credentials/',hd={'Authorization':'Bearer '+process.env.CF_TURN_TOKEN,'Content-Type':'application/json'},body=JSON.stringify({ttl:86400});
    for(const ep of ['generate-ice-servers','generate']){if(v)break;
      try{const r=await fetch(base+ep,{method:'POST',headers:hd,body,signal:AbortSignal.timeout(5000)});
        if(r.ok){const j=await r.json();let L=j.iceServers;if(L&&!Array.isArray(L))L=[L];
          // on garde les adresses utilisables depuis un navigateur (les ports 53 sont souvent bloqués par les navigateurs)
          if(Array.isArray(L)&&L.length){L=L.map(x=>({...x,urls:(Array.isArray(x.urls)?x.urls:[x.urls]).filter(u=>!/:53(\?|$)/.test(u))})).filter(x=>x.urls.length);v=[...STUN,...L]}}
        else console.warn('Cloudflare TURN :',ep,r.status)}catch(e){console.warn('Cloudflare TURN injoignable :',e.message)}}}
  if(!v&&process.env.METERED_APP&&process.env.METERED_KEY){
    try{const r=await fetch('https://'+encodeURIComponent(process.env.METERED_APP)+'.metered.live/api/v1/turn/credentials?apiKey='+encodeURIComponent(process.env.METERED_KEY),{signal:AbortSignal.timeout(5000)});
      if(r.ok){const L=await r.json();if(Array.isArray(L)&&L.length)v=[...STUN,...L]}else console.warn('Metered :',r.status)}catch(e){console.warn('Metered injoignable :',e.message)}}
  if(!v&&process.env.TURN_URLS)v=[...STUN,{urls:process.env.TURN_URLS.split(',').map(x=>x.trim()).filter(Boolean),username:process.env.TURN_USER||'',credential:process.env.TURN_PASS||''}];
  if(!v)v=STUN;
  iceCache={t:Date.now(),v};return v}
app.get('/api/ice',wrap(async(req,res)=>{if(limited('ice:'+ipOf(req),120,36e5))return res.status(429).json({err:'trop'});const v=await iceServers();res.set('Cache-Control','no-store').json({iceServers:v,turn:v.length>STUN.length})}));

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

// ---------- signalements envoyés depuis le jeu (bouton « Signaler un problème ») ----------
// lecture réservée : /signalements?cle=… (variable REPORT_KEY sur Render ; à défaut, une clé dérivée de SECRET, écrite dans le journal au démarrage)
const REPORT_KEY=process.env.REPORT_KEY||crypto.createHash('sha256').update(SECRET+':signalements').digest('hex').slice(0,20);
if(!process.env.REPORT_KEY)console.log('Clé des signalements :',REPORT_KEY);
const reportsMem=[];let repId=1;
const keyOk=req=>{const k=String(req.query.cle||req.get('x-cle')||'');return k.length===REPORT_KEY.length&&crypto.timingSafeEqual(Buffer.from(k),Buffer.from(REPORT_KEY))};
// ---------- amis : demandes, liste avec statut en ligne, invitations dans un groupe ----------
// u.fr : ids des amis ; u.fq : ids des demandes reçues. Statut et invitations : en mémoire seulement (perdus au redémarrage, sans gravité).
const FR_MAX=100,FQ_MAX=50,ONLINE_MS=100e3,INV_MS=5*60e3;
const live=new Map(),invs=new Map();// id → {t,st,g,gm,gx} ; id → [{f,code,gm,t}]
const frOf=u=>Array.isArray(u.fr)?u.fr:(u.fr=[]),fqOf=u=>Array.isArray(u.fq)?u.fq:(u.fq=[]),foOf=u=>Array.isArray(u.fo)?u.fo:(u.fo=[]);
const lvlOfData=u=>{const xp=+(u.data&&u.data['pfps-xp'])||0;return Math.min(150,Math.floor((-320+Math.sqrt(102400+80*Math.max(0,xp)))/40)+1)};
function frView(u){const now=Date.now();
  const fr=frOf(u).map(id=>users.get(id)).filter(Boolean).map(f=>{const l=live.get(f.id),on=!!l&&now-l.t<ONLINE_MS;
    return {n:f.name,on:on?1:0,st:on?l.st:'',g:on&&l.g?l.g:'',gm:on?l.gm:'',gx:on?l.gx|0:0,seen:l?l.t:0,lv:lvlOfData(f),rank:f.rank|0}}).sort((a,b)=>b.on-a.on||a.n.localeCompare(b.n));
  const rq=fqOf(u).map(id=>users.get(id)).filter(Boolean).map(f=>f.name);
  const iv=(invs.get(u.id)||[]).filter(i=>now-i.t<INV_MS&&frOf(u).includes(i.f)).map(i=>({n:(users.get(i.f)||{}).name,code:i.code,gm:i.gm,t:i.t})).filter(i=>i.n);
  const fo=foOf(u).map(id=>users.get(id)).filter(Boolean).map(f=>f.name);
  return {fr,rq,fo,iv}}
const frTarget=(req,res)=>{const t=byKey.get(keyOf(String(req.body.name||'').trim().replace(/\s+/g,' ')));if(!t){res.status(404).json({err:'inconnu'});return null}return t};
// signe de vie (toutes les 45 s environ) : met à jour mon statut et renvoie amis, demandes et invitations
app.post('/api/fr/hb',auth(async(req,res,u)=>{if(limited('hb:'+u.id,240,36e5))return res.status(429).json({err:'trop'});
  const b=req.body||{},cl=(x,n)=>String(x||'').slice(0,n).replace(/[^\w-]/g,'');
  live.set(u.id,{t:Date.now(),st:cl(b.st,12),g:cl(b.g,8).toUpperCase(),gm:cl(b.gm,8),gx:Math.max(0,Math.min(2,+b.gx|0))});res.json(frView(u))}));
app.post('/api/fr/add',auth(async(req,res,u)=>{if(limited('fra:'+u.id,40,36e5))return res.status(429).json({err:'trop'});
  const t=frTarget(req,res);if(!t)return;if(t.id===u.id)return res.status(400).json({err:'soi'});
  const F=frOf(u);if(F.includes(t.id))return res.json(frView(u));if(F.length>=FR_MAX)return res.status(400).json({err:'plein'});
  const Q=fqOf(u);if(Q.includes(t.id)){// il m'avait déjà demandé : on devient amis
    u.fq=Q.filter(x=>x!==t.id);F.push(t.id);t.fo=foOf(t).filter(x=>x!==u.id);u.fo=foOf(u).filter(x=>x!==t.id);if(!frOf(t).includes(u.id))frOf(t).push(u.id);t.fq=fqOf(t).filter(x=>x!==u.id);await store.save(u);await store.save(t);return res.json(Object.assign(frView(u),{ok:'amis'}))}
  const TQ=fqOf(t);if(!TQ.includes(u.id)){if(TQ.length>=FQ_MAX)return res.status(400).json({err:'plein'});TQ.push(u.id);await store.save(t)}const O=foOf(u);if(!O.includes(t.id)){O.push(t.id);if(O.length>FQ_MAX)O.shift();await store.save(u)}
  res.json(Object.assign(frView(u),{ok:'envoye'}))}));
app.post('/api/fr/accept',auth(async(req,res,u)=>{const t=frTarget(req,res);if(!t)return;const Q=fqOf(u);if(!Q.includes(t.id))return res.json(frView(u));
  u.fq=Q.filter(x=>x!==t.id);if(frOf(u).length>=FR_MAX)return res.status(400).json({err:'plein'});
  t.fo=foOf(t).filter(x=>x!==u.id);if(!frOf(u).includes(t.id))frOf(u).push(t.id);if(!frOf(t).includes(u.id))frOf(t).push(u.id);t.fq=fqOf(t).filter(x=>x!==u.id);await store.save(u);await store.save(t);res.json(frView(u))}));
app.post('/api/fr/decline',auth(async(req,res,u)=>{const t=frTarget(req,res);if(!t)return;u.fq=fqOf(u).filter(x=>x!==t.id);t.fo=foOf(t).filter(x=>x!==u.id);await store.save(u);await store.save(t);res.json(frView(u))}));
app.post('/api/fr/remove',auth(async(req,res,u)=>{const t=frTarget(req,res);if(!t)return;u.fr=frOf(u).filter(x=>x!==t.id);t.fr=frOf(t).filter(x=>x!==u.id);u.fo=foOf(u).filter(x=>x!==t.id);t.fq=fqOf(t).filter(x=>x!==u.id);await store.save(u);await store.save(t);res.json(frView(u))}));
// invitation dans mon groupe (code de 4 lettres) : visible 5 min par l'ami
app.post('/api/fr/invite',auth(async(req,res,u)=>{if(limited('fri:'+u.id,60,36e5))return res.status(429).json({err:'trop'});
  const t=frTarget(req,res);if(!t)return;if(!frOf(u).includes(t.id)||!frOf(t).includes(u.id))return res.status(403).json({err:'pasami'});
  const code=String(req.body.code||'').toUpperCase().replace(/[^A-Z]/g,'').slice(0,4);if(code.length!==4)return res.status(400).json({err:'code'});
  const L=(invs.get(t.id)||[]).filter(i=>i.f!==u.id&&Date.now()-i.t<INV_MS);L.push({f:u.id,code,gm:String(req.body.gm||'').replace(/[^\w]/g,'').slice(0,8),t:Date.now()});invs.set(t.id,L.slice(-10));res.json({ok:1})}));
app.post('/api/fr/uninv',auth(async(req,res,u)=>{const t=byKey.get(keyOf(String(req.body.name||'').trim()));if(t)invs.set(u.id,(invs.get(u.id)||[]).filter(i=>i.f!==t.id));res.json(frView(u))}));
setInterval(()=>{const now=Date.now();for(const [k,l] of live)if(now-l.t>36e5)live.delete(k);for(const [k,L] of invs){const M=L.filter(i=>now-i.t<INV_MS);if(M.length)invs.set(k,M);else invs.delete(k)}},6e5).unref();

app.post('/api/report',wrap(async(req,res)=>{
  if(limited('rep:'+ipOf(req),12,36e5))return res.status(429).json({err:'trop'});
  const b=req.body||{},u=userOf(req),str=(v,n)=>typeof v==='string'?v.slice(0,n):'';
  const msg=str(b.msg,600).trim();if(!msg)return res.status(400).json({err:'message'});
  const img=/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(b.img||'')&&b.img.length<120000?b.img:'';
  const doc={t:Date.now(),cat:str(b.cat,20),msg,img,joueur:u?u.name:str(b.nick,24)||'invité',compte:!!u,plateforme:str(b.pf,20),etat:str(b.etat,60000)};
  if(store.pg){await store.pg.query('insert into signalements (t,doc) values ($1,$2)',[doc.t,doc]);await store.pg.query('delete from signalements where id not in (select id from signalements order by id desc limit 500)')}
  else{doc.id=repId++;reportsMem.unshift(doc);reportsMem.length=Math.min(reportsMem.length,300)}
  res.json({ok:1})}));
// ---------- erreurs du jeu, envoyées automatiquement : regroupées par signature (message + endroit), avec un compteur ----------
const errs=new Map();let errId=1;
function errAdd(d){errs.set(d.sig,d);if(d.id>=errId)errId=d.id+1}
const ERR_MAX=200;
app.post('/api/err',wrap(async(req,res)=>{
  if(limited('err:'+ipOf(req),30,36e5))return res.status(429).json({err:'trop'});
  const b=req.body||{},str=(v,n)=>typeof v==='string'?v.slice(0,n):'',u=userOf(req);
  const msg=str(b.msg,300).trim(),at=str(b.at,400).trim();if(!msg)return res.status(400).json({err:'message'});
  const sig=crypto.createHash('sha1').update(msg.replace(/\d+/g,'#')+'|'+at.split('\n')[0].replace(/:\d+:\d+/g,'')).digest('hex').slice(0,16);
  const now=Date.now(),pf=str(b.pf,20)||'web',mode=str(b.mode,40),ver=str(b.ver,40),who=u?u.name:'invité';
  let d=errs.get(sig);
  if(!d){if(errs.size>=ERR_MAX){const old=[...errs.values()].sort((a,c)=>a.last-c.last)[0];errs.delete(old.sig);if(store.pg)await store.pg.query('delete from erreurs where sig=$1',[old.sig])}
    d={sig,id:errId++,msg,at,n:0,first:now,last:now,pf:{},modes:{},vers:[],joueurs:[],etat:str(b.etat,20000)};errs.set(sig,d)}
  d.n++;d.last=now;d.pf[pf]=(d.pf[pf]||0)+1;if(mode)d.modes[mode]=(d.modes[mode]||0)+1;if(Object.keys(d.modes).length>12)delete d.modes[Object.keys(d.modes)[0]];
  if(ver&&!d.vers.includes(ver)){d.vers.push(ver);if(d.vers.length>5)d.vers.shift()}if(!d.joueurs.includes(who)&&d.joueurs.length<20)d.joueurs.push(who);
  if(store.pg)await store.pg.query('insert into erreurs (sig,doc) values ($1,$2) on conflict (sig) do update set doc=excluded.doc',[sig,d]);
  res.json({ok:1})}));
app.delete('/api/errs/:id',wrap(async(req,res)=>{if(!keyOk(req))return res.status(403).json({err:'cle'});const id=+req.params.id;
  for(const d of errs.values())if(d.id===id){errs.delete(d.sig);if(store.pg)await store.pg.query('delete from erreurs where sig=$1',[d.sig])}res.json({ok:1})}));
app.get('/api/errs',wrap(async(req,res)=>{if(!keyOk(req))return res.status(403).json({err:'cle'});res.set('Cache-Control','no-store').json([...errs.values()].sort((a,b)=>b.last-a.last))}));
// ---------- statistiques d'équilibrage, anonymes : chaque joueur envoie, en fin de partie, ses éliminations et ses morts par arme ----------
// cumulées ici (aucun pseudo gardé) ; lecture : /stats?cle=… (même clé que les signalements)
const STATS={since:Date.now(),vs:{},wp:{},sv:{},nm:{}};let statsT=null;
const statsSave=()=>{if(statsT)return;statsT=setTimeout(async()=>{statsT=null;if(store.pg)try{await store.pg.query("insert into stats (k,doc) values ('all',$1) on conflict (k) do update set doc=excluded.doc",[STATS])}catch(e){console.error(e)}},60e3)};
const nm=(x,n=16)=>String(x||'').replace(/[^\w\-]/g,'').slice(0,n),cnt=(x,mx)=>Math.max(0,Math.min(mx,Math.floor(+x||0)));
app.post('/api/stat',wrap(async(req,res)=>{if(limited('st:'+ipOf(req),60,36e5))return res.status(429).json({err:'trop'});
  const b=req.body||{};STATS.nm=STATS.nm||{};
  for(const [k,v] of Object.entries(b.nm||{}).slice(0,16)){const c=nm(k);if(c&&typeof v==='string'&&Object.keys(STATS.nm).length<300)STATS.nm[c]=v.slice(0,30)}
  if(b.t==='v'){const key=nm(b.mode,8)+'|'+nm(b.map,12)+(b.esc?'|'+cnt(b.esc,2)+'v'+cnt(b.esc,2):''),dur=cnt(b.dur,3600);if(dur<30)return res.json({ok:0});
    const V=STATS.vs[key]||(STATS.vs[key]={n:0,dur:0,win:{h:0,s:0,n:0},rk:0});V.n++;V.dur+=dur;if(b.rk)V.rk++;const w=b.won===1?b.team:b.won===-1?(b.team==='h'?'s':'h'):'';if(w==='h'||w==='s')V.win[w]++;else V.win.n++;
    const wl=b.won===1?1:0;for(const k of [nm(b.p),nm(b.s)])if(k){const W=STATS.wp[k]||(STATS.wp[k]={k:0,hd:0,d:0,n:0,w:0});W.n++;W.w+=wl}
    for(const [k,v] of Object.entries(b.k||{}).slice(0,12)){const W=STATS.wp[nm(k)]||(STATS.wp[nm(k)]={k:0,hd:0,d:0,n:0,w:0});W.k+=cnt(v&&v[0],200);W.hd+=cnt(v&&v[1],200)}
    for(const [k,v] of Object.entries(b.d||{}).slice(0,12)){const W=STATS.wp[nm(k)]||(STATS.wp[nm(k)]={k:0,hd:0,d:0,n:0,w:0});W.d+=cnt(v,200)}}
  else if(b.t==='s'){const key=nm(b.d,8)+(b.hc?'+hc':'')+(b.mp?'|groupe':''),wv=cnt(b.wave,999);
    const S=STATS.sv[key]||(STATS.sv[key]={n:0,wv:0,max:0,dur:0,win:0,hist:{},by:{},wk:{}});S.n++;S.wv+=wv;S.max=Math.max(S.max,wv);S.dur+=cnt(b.dur,36000);if(b.win)S.win++;
    const bk=wv<5?'1-4':wv<10?'5-9':wv<15?'10-14':wv<20?'15-19':'20+';S.hist[bk]=(S.hist[bk]||0)+1;
    if(b.by){const e=String(b.by).slice(0,24).replace(/[<>&"]/g,'');S.by[e]=(S.by[e]||0)+1}
    for(const [k,v] of Object.entries(b.wk||{}).slice(0,12))S.wk[nm(k)]=(S.wk[nm(k)]||0)+cnt(v,2000)}
  else return res.status(400).json({err:'type'});
  statsSave();res.json({ok:1})}));
app.get('/stats',wrap(async(req,res)=>{
  res.set({'Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'"});
  if(!keyOk(req))return res.status(403).type('html').send('<meta charset="utf-8"><p style="font:16px sans-serif">Clé manquante ou incorrecte : ajoutez <b>?cle=…</b> à l’adresse.</p>');
  const e=x=>String(x).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])),pc=(a,b)=>b?Math.round(100*a/b)+' %':'–',r1=x=>Math.round(x*10)/10;
  const tab=(h,rows)=>'<table><tr>'+h.map(x=>'<th>'+x+'</th>').join('')+'</tr>'+rows.map(r=>'<tr>'+r.map(x=>'<td>'+x+'</td>').join('')+'</tr>').join('')+'</table>';
  const N=k=>e((STATS.nm||{})[k]||k)+((STATS.nm||{})[k]?' <small style="color:#8a8070">'+e(k)+'</small>':''),W=Object.entries(STATS.wp).sort((a,b)=>b[1].k-a[1].k),V=Object.entries(STATS.vs).sort((a,b)=>b[1].n-a[1].n),S=Object.entries(STATS.sv).sort((a,b)=>b[1].n-a[1].n);
  res.type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Statistiques · Ossuaire</title><style>body{font:14px/1.4 system-ui,sans-serif;background:#141210;color:#e8e0d0;margin:0 auto;padding:16px;max-width:1000px}h1{font-size:22px}h2{font-size:17px;margin-top:26px;color:#ffd23c}table{border-collapse:collapse;width:100%;margin:8px 0}th,td{padding:5px 8px;border-bottom:1px solid #3a332b;text-align:right}th:first-child,td:first-child{text-align:left}th{color:#bfb49c;font-weight:600}p{color:#bfb49c}</style>'
    +'<h1>Statistiques d’équilibrage</h1><p>Depuis le '+new Date(STATS.since).toLocaleDateString('fr-FR')+' · éliminations et morts des joueurs (pas des bots), envoyées en fin de partie, sans pseudo.</p>'
    +'<h2>Armes (mode VS)</h2>'+tab(['Arme','Éliminations','dont tête','Morts causées','Ratio','Parties équipée','Victoires équipée'],W.map(([k,w])=>[N(k),w.k,pc(w.hd,w.k),w.d,w.d?r1(w.k/w.d):'–',w.n,pc(w.w,w.n)]))
    +'<h2>Cartes et modes (VS)</h2>'+tab(['Mode · carte','Parties','Durée moy.','Victoires humains','Victoires squelettes','Nuls','Classées'],V.map(([k,v])=>[e(k),v.n,Math.round(v.dur/v.n/60)+' min',pc(v.win.h,v.n),pc(v.win.s,v.n),pc(v.win.n,v.n),v.rk]))
    +'<h2>Survie</h2>'+tab(['Difficulté','Parties','Vague moy.','Record','Durée moy.','Victoires','Vagues atteintes','Tués surtout par','Armes (éliminations)'],S.map(([k,v])=>[e(k),v.n,r1(v.wv/v.n),v.max,Math.round(v.dur/v.n/60)+' min',v.win,Object.entries(v.hist).map(([a,b])=>e(a)+' : '+b).join(' · '),Object.entries(v.by).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([a,b])=>e(a)+' '+b).join(', '),Object.entries(v.wk).sort((a,b)=>b[1]-a[1]).slice(0,4).map(([a,b])=>e((STATS.nm||{})[a]||a)+' '+b).join(', ')])));
}));
async function reportList(n){if(store.pg){const r=await store.pg.query('select id,doc from signalements order by id desc limit $1',[n]);return r.rows.map(x=>Object.assign({id:+x.id},x.doc))}return reportsMem.slice(0,n)}
app.get('/api/reports',wrap(async(req,res)=>{if(!keyOk(req))return res.status(403).json({err:'cle'});res.set('Cache-Control','no-store').json(await reportList(200))}));
app.delete('/api/reports/:id',wrap(async(req,res)=>{if(!keyOk(req))return res.status(403).json({err:'cle'});const id=+req.params.id;
  if(store.pg)await store.pg.query('delete from signalements where id=$1',[id]);else{const i=reportsMem.findIndex(r=>r.id===id);if(i>=0)reportsMem.splice(i,1)}res.json({ok:1})}));
app.get('/signalements',wrap(async(req,res)=>{
  res.set({'Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'"});
  if(!keyOk(req))return res.status(403).type('html').send('<meta charset="utf-8"><p style="font:16px sans-serif">Clé manquante ou incorrecte : ajoutez <b>?cle=…</b> à l’adresse.</p>');
  const esc=s=>String(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const L=await reportList(200),cle=esc(req.query.cle),E=[...errs.values()].sort((a,b)=>b.last-a.last),dt=t=>new Date(t).toLocaleString('fr-FR',{timeZone:'Europe/Paris'}),kv=o=>Object.entries(o||{}).sort((a,b)=>b[1]-a[1]).map(([k,v])=>esc(k)+' ×'+v).join(', ');
  const ecard=d=>'<article id="e'+d.id+'" class="er"><header><b>erreur ×'+d.n+'</b> · dernière '+dt(d.last)+' · première '+dt(d.first)+' · '+kv(d.pf)+'<button onclick="edel('+d.id+')">Supprimer</button></header><p class="m">'+esc(d.msg)+'</p><pre>'+esc(d.at)+'</pre><p class="s">Modes : '+(kv(d.modes)||'?')+' · versions : '+esc(d.vers.join(', '))+' · joueurs : '+esc(d.joueurs.join(', '))+'</p>'+(d.etat?'<details><summary>État au premier envoi</summary><pre>'+esc(d.etat)+'</pre></details>':'')+'</article>';
  const card=r=>{let e={};try{e=JSON.parse(r.etat||'{}')}catch(x){}
    return '<article id="r'+r.id+'"><header><b>'+esc(r.cat||'autre')+'</b> · '+new Date(r.t).toLocaleString('fr-FR',{timeZone:'Europe/Paris'})+' · '+esc(r.joueur)+(r.compte?' (compte)':'')+' · '+esc(e.mode||'')+(e.version?' · version '+esc(e.version):'')+'<button onclick="del('+r.id+')">Supprimer</button></header>'
      +'<p class="m">'+esc(r.msg)+'</p>'+(r.img?'<img src="'+r.img+'" alt="">':'')+'<details><summary>État de la partie</summary><pre>'+esc(JSON.stringify(e,null,1))+'</pre></details></article>'};
  res.type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Signalements · Ossuaire</title><style>body{font:15px/1.4 system-ui,sans-serif;background:#141210;color:#e8e0d0;margin:0;padding:16px;max-width:900px;margin:auto}h1{font-size:22px}article{background:#221e1a;border:1px solid #3a332b;border-radius:8px;padding:12px;margin:12px 0}header{font-size:13px;color:#bfb49c;display:flex;gap:6px;flex-wrap:wrap;align-items:center}header b{color:#ffd23c;text-transform:uppercase}.er header b{color:#ff7a5a}.er{border-color:#5a2a22}.er pre{white-space:pre-wrap;word-break:break-word;font-size:12px;color:#d8c8a8;margin:6px 0}.s{font-size:12px;color:#bfb49c;margin:4px 0}button{margin-left:auto;background:#5e0a0e;color:#fff;border:0;border-radius:4px;padding:4px 10px;cursor:pointer}.m{font-size:16px;white-space:pre-wrap}img{max-width:100%;border-radius:4px}pre{font-size:11px;overflow:auto;max-height:320px;background:#0e0c0a;padding:8px}</style>'
    +'<h1>Erreurs automatiques · '+E.length+'</h1>'+(E.length?E.map(ecard).join(''):'<p>Aucune erreur remontée.</p>')
    +'<h1>Signalements · '+L.length+'</h1>'+(L.length?L.map(card).join(''):'<p>Aucun signalement pour l’instant.</p>')
    +'<script>async function edel(id){if(!confirm("Supprimer cette erreur ?"))return;const r=await fetch("/api/errs/"+id+"?cle='+cle+'",{method:"DELETE"});if(r.ok)document.getElementById("e"+id).remove()}async function del(id){if(!confirm("Supprimer ce signalement ?"))return;const r=await fetch("/api/reports/"+id+"?cle='+cle+'",{method:"DELETE"});if(r.ok)document.getElementById("r"+id).remove()}</script>');
}));

// ---------- le jeu lui-même, si le dossier public/ existe (sinon il est hébergé ailleurs, sur itch.io par exemple) ----------
const PUB=path.join(__dirname,'public');
if(fs.existsSync(PUB))app.use(express.static(PUB,{maxAge:'1h',setHeaders:(res,p)=>{if(/\.html$|sw\.js$/.test(p))res.set('Cache-Control','no-cache')}}));
else app.get('/',(req,res)=>res.type('text').send('Serveur Ossuaire en marche.'));

const srv=http.createServer(app);
// mise en relation des navigateurs : les parties se jouent ensuite directement entre eux
app.use('/peer',ExpressPeerServer(srv,{path:'/',allow_discovery:false,alive_timeout:60000}));

store.init().then(()=>srv.listen(PORT,()=>console.log('Ossuaire sur le port',PORT))).catch(e=>{console.error('Démarrage impossible :',e.message);process.exit(1)});
for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>{if(store.t){clearTimeout(store.t);const tmp=DATA_FILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify([...users.values()]));fs.renameSync(tmp,DATA_FILE)}process.exit(0)});

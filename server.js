import express from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { PrismaClient } from '@prisma/client';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const db = new PrismaClient();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = process.env.PORT || 3000;
const railwayHost = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '';
const base = (process.env.APP_URL || railwayHost || `http://localhost:${port}`).replace(/\/$/, '');
const googleCallback = `${base}/auth/google/callback`;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } });

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(cookieParser());
app.use(session({ name: 'nexus.sid', secret: process.env.SESSION_SECRET || process.env.OWNER_CODE || 'nexus-ai-dev-session', resave: false, saveUninitialized: false, proxy: true, cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 30 * 24 * 60 * 60 * 1000 } }));
app.use(passport.initialize());
app.use(passport.session());
passport.serializeUser((u, done) => done(null, { id:u.id,name:u.name||null,email:u.email||null,avatar:u.avatar||null,role:u.role||'USER',suspended:!!u.suspended,provider:u.provider||'google',providerId:u.providerId||null }));
passport.deserializeUser((u, done) => done(null, u));

async function upsertGoogle(profile) {
 const providerId=String(profile.id), email=profile.emails?.[0]?.value||null;
 const data={name:profile.displayName||'Google User',email,avatar:profile.photos?.[0]?.value||null};
 const existing=await db.user.findUnique({where:{provider_providerId:{provider:'google',providerId}}});
 if(existing)return db.user.update({where:{id:existing.id},data});
 if(email){const byEmail=await db.user.findUnique({where:{email}});if(byEmail)return db.user.update({where:{id:byEmail.id},data:{...data,provider:'google',providerId}});}
 return db.user.create({data:{...data,provider:'google',providerId}});
}
if(process.env.GOOGLE_CLIENT_ID&&process.env.GOOGLE_CLIENT_SECRET){passport.use(new GoogleStrategy({clientID:String(process.env.GOOGLE_CLIENT_ID).trim(),clientSecret:String(process.env.GOOGLE_CLIENT_SECRET).trim(),callbackURL:googleCallback,proxy:true},async(_a,_r,profile,done)=>{try{return done(null,await upsertGoogle(profile));}catch(e){console.error('GOOGLE_DB_ERROR',e);return done(null,{id:`google:${profile.id}`,provider:'google',providerId:String(profile.id),name:profile.displayName||'Google User',email:profile.emails?.[0]?.value||null,avatar:profile.photos?.[0]?.value||null,role:'USER',suspended:false});}}));}
app.get('/auth/google',(req,res,next)=>{if(!process.env.GOOGLE_CLIENT_ID||!process.env.GOOGLE_CLIENT_SECRET)return res.redirect('/login?error=google_config');passport.authenticate('google',{scope:['profile','email'],prompt:'select_account',session:true})(req,res,next);});
app.get('/auth/google/callback',(req,res,next)=>{passport.authenticate('google',(err,user,info)=>{if(err||!user){console.error('GOOGLE_CALLBACK_ERROR',{message:err?.message,code:err?.code,info,callback:googleCallback});return res.redirect('/login?error=google_callback');}req.logIn(user,(loginErr)=>{if(loginErr)return res.redirect('/login?error=google_session');req.session.save((saveErr)=>saveErr?res.redirect('/login?error=google_session'):res.redirect('/'));});})(req,res,next);});
app.get('/logout',(req,res)=>req.logout(()=>req.session.destroy(()=>res.redirect('/'))));
app.get('/health',async(_req,res)=>{let database=true;try{await db.$queryRaw`SELECT 1`;}catch{database=false;}res.json({ok:true,provider:'gemini',gemini:!!process.env.GEMINI_API_KEY,database,google:!!(process.env.GOOGLE_CLIENT_ID&&process.env.GOOGLE_CLIENT_SECRET),base,googleCallback,model:process.env.GEMINI_MODEL||'gemini-2.5-flash'});});
app.get('/api/me',(req,res)=>res.json({user:req.user?{id:req.user.id,name:req.user.name,email:req.user.email,avatar:req.user.avatar,role:req.user.role}:null}));

function textFileContent(file){if(!file)return'';const type=String(file.mimetype||''),ext=path.extname(file.originalname||'').toLowerCase();const allowed=new Set(['.txt','.md','.js','.ts','.jsx','.tsx','.json','.html','.css','.lua','.py','.sql','.xml','.yml','.yaml','.cfg','.ini','.log']);if(type.startsWith('text/')||type.includes('json')||allowed.has(ext))return file.buffer.toString('utf8').slice(0,120000);return'';}
function geminiParts(message,file){const parts=[];if(message)parts.push({text:message});if(file){if(String(file.mimetype||'').startsWith('image/')){parts.push({inline_data:{mime_type:file.mimetype,data:file.buffer.toString('base64')}});if(!message)parts.unshift({text:'Describe and help me with this image.'});}else{const t=textFileContent(file);if(!t)return null;parts.push({text:`Attached file: ${file.originalname}\n\n${t}`});if(!message)parts.unshift({text:'Review the attached file and help me with it.'});}}return parts;}
async function callGemini(parts){
 const key=String(process.env.GEMINI_API_KEY||'').trim();
 if(!key)throw Object.assign(new Error('GEMINI_API_KEY is missing in Railway.'),{status:503});
 const model=process.env.GEMINI_MODEL||'gemini-2.5-flash';
 const url=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),90000);
 try{
  const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({system_instruction:{parts:[{text:'You are NEXUS AI. Be useful, clear, multilingual, and strong at programming including FiveM. Understand attached images and code files. Reply in the user language. Follow safety requirements.'}]},contents:[{role:'user',parts}],generationConfig:{temperature:0.7,maxOutputTokens:8192}}),signal:controller.signal});
  const data=await r.json().catch(()=>({}));
  if(!r.ok){const err=new Error(data?.error?.message||`Gemini API error ${r.status}`);err.status=r.status;err.code=data?.error?.status;throw err;}
  const reply=(data?.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join('').trim();
  if(!reply)throw Object.assign(new Error('Gemini returned no text response.'),{status:502});
  return reply;
 }finally{clearTimeout(timer);}
}

app.post('/api/chat',upload.single('file'),async(req,res)=>{try{
 if(req.user?.suspended)return res.status(403).json({error:'Account suspended.'});
 const message=String(req.body?.message||'').trim(),file=req.file;if(!message&&!file)return res.status(400).json({error:'Empty message.'});
 if(req.user&&process.env.OWNER_CODE&&message===process.env.OWNER_CODE&&!String(req.user.id).startsWith('google:')){await db.user.update({where:{id:req.user.id},data:{role:'OWNER'}});return res.json({reply:'Owner access activated.'});}
 const parts=geminiParts(message,file);if(!parts)return res.status(415).json({error:'This file type is not supported yet.'});
 const persistentUser=req.user&&!String(req.user.id).startsWith('google:');
 if(persistentUser)await db.message.create({data:{userId:req.user.id,role:'user',content:message||`[Attachment: ${file?.originalname||'file'}]`}}).catch(()=>{});
 const reply=await callGemini(parts);
 if(persistentUser)await db.message.create({data:{userId:req.user.id,role:'assistant',content:reply}}).catch(()=>{});
 return res.json({reply});
}catch(e){console.error('GEMINI_CHAT_ERROR',{status:e?.status,code:e?.code,message:e?.message});const status=Number(e?.status)||500;if(status===400)return res.status(400).json({error:`Gemini rejected the request: ${e.message}`});if(status===401||status===403)return res.status(502).json({error:'Gemini API key is invalid or does not have permission.'});if(status===429)return res.status(429).json({error:'Gemini API quota/rate limit reached. Check the Gemini API project quota.'});if(status===503)return res.status(503).json({error:e.message});return res.status(500).json({error:'NEXUS AI could not reach Gemini. Check Railway Console for GEMINI_CHAT_ERROR.'});}});

function admin(req,res,next){if(!req.user||!['ADMIN','OWNER'].includes(req.user.role))return res.sendStatus(403);next();}
app.get('/api/admin/users',admin,async(req,res)=>{const q=String(req.query.q||'');res.json(await db.user.findMany({where:q?{OR:[{name:{contains:q,mode:'insensitive'}},{email:{contains:q,mode:'insensitive'}}]}:{},orderBy:{createdAt:'desc'},take:100,select:{id:true,name:true,email:true,avatar:true,role:true,suspended:true,createdAt:true}}));});
app.post('/api/admin/role',admin,async(req,res)=>{if(req.user.role!=='OWNER')return res.sendStatus(403);const{id,role}=req.body;if(!['USER','ADMIN'].includes(role))return res.sendStatus(400);res.json(await db.user.update({where:{id},data:{role}}));});
app.get('/',(_q,r)=>r.sendFile(path.join(__dirname,'index.html')));app.get('/login',(_q,r)=>r.sendFile(path.join(__dirname,'login.html')));app.get('/admin',(_q,r)=>r.sendFile(path.join(__dirname,'admin.html')));app.get('/style.css',(_q,r)=>r.sendFile(path.join(__dirname,'style.css')));app.get('/app.js',(_q,r)=>r.sendFile(path.join(__dirname,'app.js')));
app.use((err,_req,res,_next)=>{console.error('SERVER_ERROR',err);if(err instanceof multer.MulterError&&err.code==='LIMIT_FILE_SIZE')return res.status(413).json({error:'File is too large. Current chat upload limit is 15 MB.'});return res.status(500).json({error:'Server error.'});});
app.listen(port,()=>console.log(`NEXUS AI on ${port} using ${base}; Google callback ${googleCallback}; AI provider Gemini`));

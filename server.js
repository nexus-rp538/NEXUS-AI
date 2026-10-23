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
app.use(session({ name:'nexus.sid', secret:process.env.SESSION_SECRET||process.env.OWNER_CODE||'nexus-ai-dev-session', resave:false, saveUninitialized:false, proxy:true, cookie:{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:30*24*60*60*1000} }));
app.use(passport.initialize()); app.use(passport.session());
passport.serializeUser((u,d)=>d(null,{id:u.id,name:u.name||null,email:u.email||null,avatar:u.avatar||null,role:u.role||'USER',suspended:!!u.suspended,provider:u.provider||'google',providerId:u.providerId||null}));
passport.deserializeUser((u,d)=>d(null,u));
async function upsertGoogle(profile){const providerId=String(profile.id),email=profile.emails?.[0]?.value||null,data={name:profile.displayName||'Google User',email,avatar:profile.photos?.[0]?.value||null};const existing=await db.user.findUnique({where:{provider_providerId:{provider:'google',providerId}}});if(existing)return db.user.update({where:{id:existing.id},data});if(email){const byEmail=await db.user.findUnique({where:{email}});if(byEmail)return db.user.update({where:{id:byEmail.id},data:{...data,provider:'google',providerId}});}return db.user.create({data:{...data,provider:'google',providerId}});}
if(process.env.GOOGLE_CLIENT_ID&&process.env.GOOGLE_CLIENT_SECRET) passport.use(new GoogleStrategy({clientID:String(process.env.GOOGLE_CLIENT_ID).trim(),clientSecret:String(process.env.GOOGLE_CLIENT_SECRET).trim(),callbackURL:googleCallback,proxy:true},async(_a,_r,p,d)=>{try{return d(null,await upsertGoogle(p));}catch(e){console.error('GOOGLE_DB_ERROR',e);return d(null,{id:`google:${p.id}`,provider:'google',providerId:String(p.id),name:p.displayName||'Google User',email:p.emails?.[0]?.value||null,avatar:p.photos?.[0]?.value||null,role:'USER',suspended:false});}}));
app.get('/auth/google',(req,res,next)=>{if(!process.env.GOOGLE_CLIENT_ID||!process.env.GOOGLE_CLIENT_SECRET)return res.redirect('/login?error=google_config');passport.authenticate('google',{scope:['profile','email'],prompt:'select_account',session:true})(req,res,next);});
app.get('/auth/google/callback',(req,res,next)=>passport.authenticate('google',(err,user,info)=>{if(err||!user){console.error('GOOGLE_CALLBACK_ERROR',{message:err?.message,info});return res.redirect('/login?error=google_callback');}req.logIn(user,e=>e?res.redirect('/login?error=google_session'):req.session.save(se=>se?res.redirect('/login?error=google_session'):res.redirect('/')));})(req,res,next));
app.get('/logout',(req,res)=>req.logout(()=>req.session.destroy(()=>res.redirect('/'))));
app.get('/api/me',(req,res)=>res.json({user:req.user?{id:req.user.id,name:req.user.name,email:req.user.email,avatar:req.user.avatar,role:req.user.role}:null}));

function textFileContent(file){if(!file)return'';const type=String(file.mimetype||''),ext=path.extname(file.originalname||'').toLowerCase(),allowed=new Set(['.txt','.md','.js','.ts','.jsx','.tsx','.json','.html','.css','.lua','.py','.sql','.xml','.yml','.yaml','.cfg','.ini','.log']);if(type.startsWith('text/')||type.includes('json')||allowed.has(ext))return file.buffer.toString('utf8').slice(0,120000);return'';}
function geminiParts(message,file){const parts=[];if(message)parts.push({text:message});if(file){if(String(file.mimetype||'').startsWith('image/')){parts.push({inlineData:{mimeType:file.mimetype,data:file.buffer.toString('base64')}});if(!message)parts.unshift({text:'Describe and help me with this image.'});}else{const t=textFileContent(file);if(!t)return null;parts.push({text:`Attached file: ${file.originalname}\n\n${t}`});if(!message)parts.unshift({text:'Review the attached file and help me with it.'});}}return parts;}

let cachedGeminiModel='';
async function discoverGeminiModel(key){
 if(cachedGeminiModel)return cachedGeminiModel;
 const configured=String(process.env.GEMINI_MODEL||'').trim().replace(/^models\//,'');
 const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`);
 const data=await r.json().catch(()=>({}));
 if(!r.ok)throw Object.assign(new Error(data?.error?.message||`Gemini model-list error ${r.status}`),{status:r.status});
 const models=(data.models||[]).filter(m=>(m.supportedGenerationMethods||[]).includes('generateContent'));
 const names=models.map(m=>String(m.name||'').replace(/^models\//,''));
 if(configured&&names.includes(configured)){cachedGeminiModel=configured;return configured;}
 const preferred=['gemini-2.5-flash','gemini-2.0-flash','gemini-flash-latest','gemini-2.5-pro','gemini-pro-latest'];
 cachedGeminiModel=preferred.find(n=>names.includes(n))||names.find(n=>/flash/i.test(n))||names[0]||'';
 if(!cachedGeminiModel)throw Object.assign(new Error('No Gemini model with generateContent is available for this API key.'),{status:503});
 console.log('GEMINI_MODEL_SELECTED',cachedGeminiModel);
 return cachedGeminiModel;
}
async function callGemini(parts){
 const key=String(process.env.GEMINI_API_KEY||'').trim(); if(!key)throw Object.assign(new Error('GEMINI_API_KEY is missing in Railway.'),{status:503});
 let model=await discoverGeminiModel(key);
 const run=async m=>{const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),90000);try{const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(key)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({systemInstruction:{parts:[{text:'You are NEXUS AI. Be useful, clear, multilingual, and strong at programming including FiveM. Understand attached images and code files. Reply in the user language. Follow safety requirements.'}]},contents:[{role:'user',parts}],generationConfig:{temperature:0.7,maxOutputTokens:8192}}),signal:controller.signal});const data=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(data?.error?.message||`Gemini API error ${r.status}`),{status:r.status,code:data?.error?.status});const reply=(data?.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join('').trim();if(!reply)throw Object.assign(new Error('Gemini returned no text response.'),{status:502});return reply;}finally{clearTimeout(timer);}};
 try{return await run(model);}catch(e){if(e.status===404){cachedGeminiModel='';model=await discoverGeminiModel(key);return await run(model);}throw e;}
}
app.get('/health',async(_req,res)=>{let database=true,model=null,geminiError=null;try{await db.$queryRaw`SELECT 1`;}catch{database=false;}if(process.env.GEMINI_API_KEY){try{model=await discoverGeminiModel(String(process.env.GEMINI_API_KEY).trim());}catch(e){geminiError=e.message;}}res.json({ok:true,provider:'gemini',gemini:!!process.env.GEMINI_API_KEY,database,google:!!(process.env.GOOGLE_CLIENT_ID&&process.env.GOOGLE_CLIENT_SECRET),base,googleCallback,model,geminiError});});
app.post('/api/chat',upload.single('file'),async(req,res)=>{try{if(req.user?.suspended)return res.status(403).json({error:'Account suspended.'});const message=String(req.body?.message||'').trim(),file=req.file;if(!message&&!file)return res.status(400).json({error:'Empty message.'});const parts=geminiParts(message,file);if(!parts)return res.status(415).json({error:'This file type is not supported yet.'});const persistent=req.user&&!String(req.user.id).startsWith('google:');if(persistent)await db.message.create({data:{userId:req.user.id,role:'user',content:message||`[Attachment: ${file?.originalname||'file'}]`}}).catch(()=>{});const reply=await callGemini(parts);if(persistent)await db.message.create({data:{userId:req.user.id,role:'assistant',content:reply}}).catch(()=>{});res.json({reply});}catch(e){console.error('GEMINI_CHAT_ERROR',{status:e?.status,code:e?.code,message:e?.message});const s=Number(e?.status)||500;if(s===400)return res.status(400).json({error:`Gemini rejected the request: ${e.message}`});if(s===401||s===403)return res.status(502).json({error:'Gemini API key is invalid or does not have permission.'});if(s===429)return res.status(429).json({error:'Gemini API quota/rate limit reached.'});if(s===503)return res.status(503).json({error:e.message});return res.status(502).json({error:`NEXUS AI Gemini error: ${e.message}`});}});
function admin(req,res,next){if(!req.user||!['ADMIN','OWNER'].includes(req.user.role))return res.sendStatus(403);next();}
app.get('/api/admin/users',admin,async(req,res)=>{const q=String(req.query.q||'');res.json(await db.user.findMany({where:q?{OR:[{name:{contains:q,mode:'insensitive'}},{email:{contains:q,mode:'insensitive'}}]}:{},orderBy:{createdAt:'desc'},take:100,select:{id:true,name:true,email:true,avatar:true,role:true,suspended:true,createdAt:true}}));});
app.post('/api/admin/role',admin,async(req,res)=>{if(req.user.role!=='OWNER')return res.sendStatus(403);const{id,role}=req.body;if(!['USER','ADMIN'].includes(role))return res.sendStatus(400);res.json(await db.user.update({where:{id},data:{role}}));});
app.get('/',(_q,r)=>r.sendFile(path.join(__dirname,'index.html')));app.get('/login',(_q,r)=>r.sendFile(path.join(__dirname,'login.html')));app.get('/admin',(_q,r)=>r.sendFile(path.join(__dirname,'admin.html')));app.get('/style.css',(_q,r)=>r.sendFile(path.join(__dirname,'style.css')));app.get('/app.js',(_q,r)=>r.sendFile(path.join(__dirname,'app.js')));
app.use((err,_req,res,_next)=>{console.error('SERVER_ERROR',err);if(err instanceof multer.MulterError&&err.code==='LIMIT_FILE_SIZE')return res.status(413).json({error:'File is too large. Current chat upload limit is 15 MB.'});res.status(500).json({error:'Server error.'});});
app.listen(port,()=>console.log(`NEXUS AI on ${port} using ${base}; AI provider Gemini with automatic model discovery`));

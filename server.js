import express from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { PrismaClient } from '@prisma/client';
import OpenAI from 'openai';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const db = new PrismaClient();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = process.env.PORT || 3000;
const base = (process.env.APP_URL || `http://localhost:${port}`).replace(/\/$/, '');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } });

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-change-me', resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: base.startsWith('https'), maxAge: 30 * 24 * 60 * 60 * 1000 }
}));
app.use(passport.initialize()); app.use(passport.session());
passport.serializeUser((u, done) => done(null, u.id));
passport.deserializeUser(async (id, done) => { try { done(null, await db.user.findUnique({ where: { id } })); } catch (e) { done(e); } });
async function upsertGoogle(profile) { return db.user.upsert({ where:{provider_providerId:{provider:'google',providerId:String(profile.id)}}, update:{name:profile.displayName||'Google User',email:profile.emails?.[0]?.value||null,avatar:profile.photos?.[0]?.value||null}, create:{provider:'google',providerId:String(profile.id),name:profile.displayName||'Google User',email:profile.emails?.[0]?.value||null,avatar:profile.photos?.[0]?.value||null} }); }
if(process.env.GOOGLE_CLIENT_ID&&process.env.GOOGLE_CLIENT_SECRET){passport.use(new GoogleStrategy({clientID:process.env.GOOGLE_CLIENT_ID,clientSecret:process.env.GOOGLE_CLIENT_SECRET,callbackURL:`${base}/auth/google/callback`},async(_a,_r,p,d)=>{try{d(null,await upsertGoogle(p));}catch(e){d(e);}}));}
app.get('/auth/google',(req,res,next)=>{if(!process.env.GOOGLE_CLIENT_ID||!process.env.GOOGLE_CLIENT_SECRET)return res.redirect('/login?error=google_config');passport.authenticate('google',{scope:['profile','email'],prompt:'select_account'})(req,res,next);});
app.get('/auth/google/callback',(req,res,next)=>passport.authenticate('google',{failureRedirect:'/login?error=google'})(req,res,next),(_req,res)=>res.redirect('/'));
app.get('/logout',(req,res)=>req.logout(()=>req.session.destroy(()=>res.redirect('/'))));
app.get('/health',(_req,res)=>res.json({ok:true,openai:!!process.env.OPENAI_API_KEY,database:!!process.env.DATABASE_URL,google:!!(process.env.GOOGLE_CLIENT_ID&&process.env.GOOGLE_CLIENT_SECRET),model:process.env.OPENAI_MODEL||'gpt-5-mini'}));
app.get('/api/me',(req,res)=>res.json({user:req.user?{id:req.user.id,name:req.user.name,email:req.user.email,avatar:req.user.avatar,role:req.user.role}:null}));

function textFileContent(file){if(!file)return'';const type=String(file.mimetype||'');const ext=path.extname(file.originalname||'').toLowerCase();const allowed=new Set(['.txt','.md','.js','.ts','.jsx','.tsx','.json','.html','.css','.lua','.py','.sql','.xml','.yml','.yaml','.cfg','.ini','.log']);if(type.startsWith('text/')||type.includes('json')||allowed.has(ext))return file.buffer.toString('utf8').slice(0,120000);return'';}

app.post('/api/chat',upload.single('file'),async(req,res)=>{
 try{
  if(req.user?.suspended)return res.status(403).json({error:'Account suspended.'});
  const message=String(req.body?.message||'').trim(); const file=req.file;
  if(!message&&!file)return res.status(400).json({error:'Empty message.'});
  if(req.user&&process.env.OWNER_CODE&&message===process.env.OWNER_CODE){await db.user.update({where:{id:req.user.id},data:{role:'OWNER'}});return res.json({reply:'Owner access activated.'});}
  if(!process.env.OPENAI_API_KEY)return res.status(503).json({error:'OPENAI_API_KEY is missing in Railway.'});
  const content=[]; if(message)content.push({type:'input_text',text:message});
  if(file){if(String(file.mimetype||'').startsWith('image/')){content.push({type:'input_image',image_url:`data:${file.mimetype};base64,${file.buffer.toString('base64')}`});if(!message)content.unshift({type:'input_text',text:'Describe and help me with this image.'});}else{const t=textFileContent(file);if(!t)return res.status(415).json({error:'This file type is not supported yet.'});content.push({type:'input_text',text:`Attached file: ${file.originalname}\n\n${t}`});if(!message)content.unshift({type:'input_text',text:'Review the attached file and help me with it.'});}}
  if(req.user)await db.message.create({data:{userId:req.user.id,role:'user',content:message||`[Attachment: ${file?.originalname||'file'}]`}}).catch(()=>{});
  const ai=new OpenAI({apiKey:process.env.OPENAI_API_KEY,timeout:90000,maxRetries:2});
  const requested=process.env.OPENAI_MODEL||'gpt-5-mini';
  let out;
  try{out=await ai.responses.create({model:requested,instructions:'You are NEXUS AI. Be useful, clear, multilingual, and strong at programming including FiveM. Understand attached images and code files. Reply in the user language. Follow safety requirements.',input:[{role:'user',content}]});}
  catch(first){
   const badModel=first?.status===404||first?.code==='model_not_found'||/model/i.test(String(first?.message||''));
   if(!badModel||requested==='gpt-4.1-mini')throw first;
   console.warn('MODEL_FALLBACK',requested,'-> gpt-4.1-mini');
   out=await ai.responses.create({model:'gpt-4.1-mini',instructions:'You are NEXUS AI. Reply clearly in the user language and help with programming and attached files.',input:[{role:'user',content}]});
  }
  const reply=out.output_text?.trim()||'I could not generate a response.';
  if(req.user)await db.message.create({data:{userId:req.user.id,role:'assistant',content:reply}}).catch(()=>{});
  return res.json({reply});
 }catch(e){
  console.error('CHAT_ERROR',JSON.stringify({status:e?.status,code:e?.code,type:e?.type,message:e?.message,request_id:e?.request_id}));
  const status=Number(e?.status)||500;
  if(status===401)return res.status(502).json({error:'OpenAI API key is invalid or revoked. Create a new API key and replace OPENAI_API_KEY in Railway.'});
  if(status===429){const quota=e?.code==='insufficient_quota'||/quota|billing/i.test(String(e?.message||''));return res.status(429).json({error:quota?'OpenAI API has no available API credit/quota. Add API billing/credits, then try again.':'NEXUS AI is receiving too many requests. Wait a moment and try again.'});}
  if(status===403)return res.status(502).json({error:'OpenAI API denied this request. Check the API project permissions and billing.'});
  if(status>=400&&status<500)return res.status(status).json({error:e?.message||'AI request failed.'});
  return res.status(500).json({error:'NEXUS AI could not reach the AI service. Check Railway Console for CHAT_ERROR.'});
 }
});

function admin(req,res,next){if(!req.user||!['ADMIN','OWNER'].includes(req.user.role))return res.sendStatus(403);next();}
app.get('/api/admin/users',admin,async(req,res)=>{const q=String(req.query.q||'');res.json(await db.user.findMany({where:q?{OR:[{name:{contains:q,mode:'insensitive'}},{email:{contains:q,mode:'insensitive'}}]}:{},orderBy:{createdAt:'desc'},take:100,select:{id:true,name:true,email:true,avatar:true,role:true,suspended:true,createdAt:true}}));});
app.post('/api/admin/role',admin,async(req,res)=>{if(req.user.role!=='OWNER')return res.sendStatus(403);const{id,role}=req.body;if(!['USER','ADMIN'].includes(role))return res.sendStatus(400);res.json(await db.user.update({where:{id},data:{role}}));});
app.get('/',(_q,r)=>r.sendFile(path.join(__dirname,'index.html'))); app.get('/login',(_q,r)=>r.sendFile(path.join(__dirname,'login.html'))); app.get('/admin',(_q,r)=>r.sendFile(path.join(__dirname,'admin.html'))); app.get('/style.css',(_q,r)=>r.sendFile(path.join(__dirname,'style.css'))); app.get('/app.js',(_q,r)=>r.sendFile(path.join(__dirname,'app.js')));
app.use((err,_req,res,_next)=>{console.error('SERVER_ERROR',err);if(err instanceof multer.MulterError&&err.code==='LIMIT_FILE_SIZE')return res.status(413).json({error:'File is too large. Current chat upload limit is 15 MB.'});return res.status(500).json({error:'Server error.'});});
app.listen(port,()=>console.log(`NEXUS AI on ${port}`));

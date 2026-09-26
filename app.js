import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import sharp from 'sharp';
import { v2 as cloudinary } from 'cloudinary';
import path from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { z } from 'zod';
import crypto from 'node:crypto';
import { all, get, put, remove, transaction, db, uid, audit, settings } from './db.js';
import { seed } from './seed.js';
import { identify, requireUser, requireAdmin, ownerOnly, limit, hashPassword, verifyPassword, session, publicUser } from './auth.js';
import { schemas, settingsSchema, email, password, phone, cartSchema, orderSchema, fail } from './validation.js';
import { quote, createOrder, updateOrder, allowedTransitions } from './commerce.js';

const optimizeCloudinaryImage = async (buffer) => {
 const levels=[[1000,76],[900,66],[800,60],[700,55],[600,50],[480,45]];let output;
 for(const [size,quality] of levels){output=await sharp(buffer,{limitInputPixels:40e6}).rotate().resize(size,size,{fit:'inside',withoutEnlargement:true}).webp({quality,effort:6,smartSubsample:true}).toBuffer();if(output.length<=100*1024)return output;}
 return output;
};
import { sendOrderConfirmation } from './email.js';

seed();
export const app=express();
const emailKey=crypto.createHash('sha256').update(process.env.JWT_SECRET||'beauty-baby-email-settings-key').digest();
const encryptEmailSecret=value=>{if(!value)return '';const iv=crypto.randomBytes(12);const cipher=crypto.createCipheriv('aes-256-gcm',emailKey,iv);const encrypted=Buffer.concat([cipher.update(String(value),'utf8'),cipher.final()]);return `enc:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${encrypted.toString('base64')}`;};
const decryptEmailSecret=value=>{if(!value)return process.env.GMAIL_APP_PASSWORD||process.env.SMTP_PASSWORD||'';if(!String(value).startsWith('enc:'))return String(value);try{const[,iv,tag,data]=String(value).split(':');const decipher=crypto.createDecipheriv('aes-256-gcm',emailKey,Buffer.from(iv,'base64'));decipher.setAuthTag(Buffer.from(tag,'base64'));return Buffer.concat([decipher.update(Buffer.from(data,'base64')),decipher.final()]).toString('utf8');}catch{return '';}};
const publicStoreSettings=()=>{const value={...settings()};if(value.emailSettings){value.emailSettings={...value.emailSettings,credentialsConfigured:Boolean(value.emailSettings.smtpUser||value.emailSettings.smtpPassword)};delete value.emailSettings.smtpUser;delete value.emailSettings.smtpPassword;}return value;};
const adminStoreSettings=()=>{const value={...settings()};const emailSettings=value.emailSettings||{};value.emailSettings={...emailSettings,smtpUser:emailSettings.smtpUser||process.env.GMAIL_USER||process.env.SMTP_USER||'',smtpPassword:decryptEmailSecret(emailSettings.smtpPassword),credentialsConfigured:Boolean(emailSettings.smtpPassword||process.env.GMAIL_APP_PASSWORD||process.env.SMTP_PASSWORD)};return value;};
const uploads=path.resolve(process.env.UPLOAD_DIR||'uploads'); mkdirSync(uploads,{recursive:true});
app.disable('x-powered-by');
app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'",'https://www.googletagmanager.com','https://connect.facebook.net'],styleSrc:["'self'","'unsafe-inline'"],imgSrc:["'self'",'data:','https:','http:'],connectSrc:["'self'",'https://www.google-analytics.com','https://analytics.google.com','https://www.facebook.com'],upgradeInsecureRequests:process.env.NODE_ENV==='production'?[]:null}},crossOriginEmbedderPolicy:false}));
app.use((req,res,next)=>{const origin=req.headers.origin;const allowed=process.env.NODE_ENV!=='production'||!origin||origin===(process.env.APP_ORIGIN||'http://localhost:1008');if(origin&&allowed){res.set('Access-Control-Allow-Origin',origin);res.set('Access-Control-Allow-Credentials','true');res.set('Access-Control-Allow-Headers','Content-Type, Idempotency-Key');res.set('Access-Control-Allow-Methods','GET,POST,PUT,PATCH,DELETE,OPTIONS');}if(req.method==='OPTIONS')return res.sendStatus(204);next();});
app.use(express.json({limit:'2mb'}));
app.use('/api',(req,res,next)=>{
 res.set('Cache-Control','no-store');
 if(!['GET','HEAD','OPTIONS'].includes(req.method)) {
  const origin=req.headers.origin; const allowed=new Set([process.env.APP_ORIGIN||'http://localhost:1008']);
  if(process.env.NODE_ENV!=='production') ['http://127.0.0.1:1008','http://localhost:1009','http://127.0.0.1:1009'].forEach(x=>allowed.add(x));
  if(process.env.NODE_ENV==='production' && ((origin&&!allowed.has(origin))||req.headers['sec-fetch-site']==='cross-site'))return res.status(403).json({error:'Request origin is not allowed.'});
 }
 next();
});
app.use('/api',identify);
app.get('/api/health',(req,res)=>res.json({status:'ok',store:'Beauty & baby',database:'connected'}));
const safeProduct=p=>{const reviews=all('reviews').filter(r=>r.productId===p.id&&r.approved);return {...p,rating:reviews.length?Number((reviews.reduce((s,r)=>s+r.rating,0)/reviews.length).toFixed(1)):null,reviewCount:reviews.length};};
app.get('/api/store',(req,res)=>res.json({settings:publicStoreSettings(),categories:all('categories').filter(c=>c.active).sort((a,b)=>a.order-b.order),brands:all('brands').filter(b=>b.active),banners:all('banners').filter(b=>b.active).sort((a,b)=>a.order-b.order),pages:all('pages').filter(p=>p.active).map(({id,title,slug})=>({id,title,slug}))}));
app.get('/api/products',(req,res)=>{
 let products=all('products').filter(p=>p.active).reverse(); const {q,category,brand,tag,sort,min,max}=req.query;
 if(q)products=products.filter(p=>(p.name+' '+p.description+' '+p.sku).toLowerCase().includes(String(q).toLowerCase()));
 if(category){const cat=all('categories').find(c=>c.id===category||c.slug===category);products=products.filter(p=>cat&&(p.categoryId===cat.id||p.subcategoryId===cat.id));}
 if(brand)products=products.filter(p=>p.brandId===brand);if(tag)products=products.filter(p=>p.tag===tag);
 if(min)products=products.filter(p=>p.price>=Number(min));if(max)products=products.filter(p=>p.price<=Number(max));
 if(sort==='price-asc')products.sort((a,b)=>a.price-b.price);if(sort==='price-desc')products.sort((a,b)=>b.price-a.price);if(sort==='newest')products.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));if(sort==='name')products.sort((a,b)=>a.name.localeCompare(b.name));
 const total=products.length; const page=Math.max(1,Number(req.query.page)||1);const size=Math.min(100,Math.max(1,Number(req.query.limit)||24));
 res.json({products:products.slice((page-1)*size,page*size).map(safeProduct),total,page,pages:Math.ceil(total/size)});
});
app.get('/api/products/:id',(req,res)=>{const p=all('products').find(p=>(p.id===req.params.id||p.slug===req.params.id)&&p.active);if(!p)fail('Product not found.',404);res.json({product:safeProduct(p),reviews:all('reviews').filter(r=>r.productId===p.id&&r.approved).map(({id,name,rating,comment,createdAt})=>({id,name,rating,comment,createdAt}))});});
app.get('/api/pages/:slug',(req,res)=>{const page=all('pages').find(p=>p.slug===req.params.slug&&p.active);if(!page)fail('Page not found.',404);res.json({page});});
app.post('/api/auth/register',limit('auth',25),(req,res)=>{const v=z.object({name:z.string().trim().min(2).max(120),email,password}).parse(req.body);if(all('users').some(u=>u.email===v.email))fail('This email is already registered.');const u=put('users',{...v,password:hashPassword(v.password),role:'customer',active:true});session(req,res,u);res.status(201).json({user:publicUser(u)});});
app.post('/api/auth/login',limit('auth',25),(req,res)=>{const v=z.object({email,password:z.string().min(1).max(128),admin:z.boolean().optional()}).parse(req.body);const u=all('users').find(u=>u.email===v.email);if(!u?.active||!verifyPassword(v.password,u.password)||(v.admin&&u.role==='customer'))fail('Email or password is incorrect.',401);session(req,res,u);res.json({user:publicUser(u)});});
app.get('/api/auth/me',(req,res)=>res.json({user:publicUser(req.user)}));
app.post('/api/auth/logout',(req,res)=>{if(req.sessionHash)db.prepare('DELETE FROM sessions WHERE hash=?').run(req.sessionHash);res.clearCookie('bb_session',{path:'/'});res.json({success:true});});
app.put('/api/auth/profile',requireUser,(req,res)=>{const v=z.object({name:z.string().trim().min(2).max(120),phone:z.union([phone,z.literal('')])}).parse(req.body);const u=put('users',{...req.user,...v});res.json({user:publicUser(u)});});
app.put('/api/auth/password',requireUser,limit('password',10),(req,res)=>{const v=z.object({current:z.string().max(128),password}).parse(req.body);if(!verifyPassword(v.current,req.user.password))fail('Your current password is incorrect.');put('users',{...req.user,password:hashPassword(v.password)});db.prepare('DELETE FROM sessions WHERE user_id=?').run(req.user.id);session(req,res,req.user);res.json({success:true});});
app.get('/api/account/orders',requireUser,(req,res)=>res.json({orders:all('orders').filter(o=>o.userId===req.user.id).map(customerOrder)}));
app.get('/api/account/wishlist',requireUser,(req,res)=>res.json({ids:get('wishlists',req.user.id)?.ids||[]}));
app.put('/api/account/wishlist',requireUser,(req,res)=>{const {ids}=z.object({ids:z.array(z.string().max(100)).max(300)}).parse(req.body);put('wishlists',{id:req.user.id,ids:[...new Set(ids)]});res.json({success:true});});
app.post('/api/checkout/quote',(req,res)=>res.json(quote(cartSchema.parse(req.body))));
app.post('/api/orders',limit('orders',30),(req,res)=>{const key=z.string().uuid().parse(req.headers['idempotency-key']);const order=createOrder(orderSchema.parse(req.body),req.user,key);sendOrderConfirmation(order,settings()).catch(error=>console.error('[Email] Beauty & baby confirmation failed:',error.message));res.status(201).json({order:customerOrder(order)});});
function customerOrder(o){const {adminNotes,userId,couponId,...safe}=o;return safe;}
app.post('/api/orders/track',limit('track',40),(req,res)=>{const v=z.object({reference:z.string().trim().max(40),phone}).parse(req.body);const normalize=p=>p.replace(/^\+?88/,'');const o=all('orders').find(o=>o.reference===v.reference.toUpperCase()&&normalize(o.customer.phone)===normalize(v.phone));if(!o)fail('No order matches that reference and mobile number.',404);res.json({order:{reference:o.reference,status:o.status,paymentStatus:o.paymentStatus,courier:o.courier,trackingNumber:o.trackingNumber,createdAt:o.createdAt,total:o.total,items:o.items,history:o.history}});});
app.post('/api/products/:id/reviews',requireUser,limit('reviews',10),(req,res)=>{const v=z.object({rating:z.number().int().min(1).max(5),comment:z.string().trim().min(10).max(2000)}).parse(req.body);if(!get('products',req.params.id)?.active)fail('Product not found.',404);if(!all('orders').some(o=>o.userId===req.user.id&&o.status==='delivered'&&o.items.some(i=>i.productId===req.params.id)))fail('Reviews are available after your purchase has been delivered.',403);if(all('reviews').some(r=>r.userId===req.user.id&&r.productId===req.params.id))fail('You have already reviewed this product.');put('reviews',{...v,productId:req.params.id,userId:req.user.id,name:req.user.name,approved:false});res.status(201).json({success:true});});
app.post('/api/newsletter',limit('newsletter',15),(req,res)=>{const v=z.object({email}).parse(req.body);if(!all('newsletter').some(n=>n.email===v.email))put('newsletter',{...v,active:true});res.json({success:true});});

const admin=express.Router();app.use('/api/admin',requireAdmin,admin);
admin.get('/dashboard',(req,res)=>{
 const orders=all('orders'),products=all('products'),customers=all('users').filter(u=>u.role==='customer');
 const revenue=orders.filter(o=>o.paymentStatus==='paid'&&!['cancelled','returned'].includes(o.status)).reduce((s,o)=>s+o.total,0);
 const days=Array.from({length:14},(_,i)=>{const date=new Date(Date.now()-(13-i)*864e5).toISOString().slice(0,10);return {date,orders:orders.filter(o=>o.createdAt.startsWith(date)).length,revenue:orders.filter(o=>o.createdAt.startsWith(date)&&o.paymentStatus==='paid'&&!['cancelled','returned'].includes(o.status)).reduce((s,o)=>s+o.total,0)};});
 res.json({revenue,orderCount:orders.length,customerCount:customers.length,productCount:products.length,pending:orders.filter(o=>o.status==='pending').length,pendingPayments:orders.filter(o=>o.paymentStatus==='pending_verification').length,recentOrders:orders.slice(0,6),lowStock:products.filter(p=>(p.variants.length?p.variants.reduce((s,v)=>s+v.stock,0):p.stock)<=p.lowStock),days});
});
admin.get('/orders',(req,res)=>res.json({items:all('orders').map(o=>({...o,allowedTransitions:allowedTransitions(o.status)}))}));
admin.put('/orders/:id',(req,res)=>{const o=get('orders',req.params.id);if(!o)fail('Order not found.',404);const v=z.object({status:z.enum(['pending','confirmed','processing','shipped','delivered','cancelled','returned']),paymentStatus:z.enum(['unpaid','pending_verification','paid','failed','refunded']),courier:z.string().max(100),trackingNumber:z.string().max(200),adminNotes:z.string().max(5000)}).parse(req.body);if(o.paymentStatus==='refunded'&&v.paymentStatus==='paid')fail('A refunded order cannot be marked paid again.');res.json({item:updateOrder(o,v,req.user)});});
admin.get('/customers',(req,res)=>res.json({items:all('users').filter(u=>u.role==='customer').map(u=>{const orders=all('orders').filter(o=>o.userId===u.id);return {...publicUser(u),active:u.active,createdAt:u.createdAt,orders:orders.length,spent:orders.filter(o=>o.paymentStatus==='paid').reduce((s,o)=>s+o.total,0)};}),guests:all('orders').filter(o=>!o.userId).map(o=>({name:o.customer.name,email:o.customer.email,phone:o.customer.phone,reference:o.reference,total:o.total}))}));
admin.patch('/customers/:id',(req,res)=>{const u=get('users',req.params.id);if(!u||u.role!=='customer')fail('Customer not found.',404);const v=z.object({active:z.boolean()}).parse(req.body);put('users',{...u,...v});audit(req.user,'customer.updated',u.email);res.json({success:true});});
admin.get('/reviews',(req,res)=>res.json({items:all('reviews').map(r=>({...r,productName:get('products',r.productId)?.name||'Archived product'}))}));
admin.patch('/reviews/:id',(req,res)=>{const r=get('reviews',req.params.id);if(!r)fail('Review not found.',404);put('reviews',{...r,...z.object({approved:z.boolean()}).parse(req.body)});audit(req.user,'review.moderated',r.id);res.json({success:true});});
admin.delete('/reviews/:id',(req,res)=>{remove('reviews',req.params.id);audit(req.user,'review.deleted',req.params.id);res.json({success:true});});
admin.get('/newsletter',(req,res)=>res.json({items:all('newsletter')}));
admin.delete('/newsletter/:id',(req,res)=>{remove('newsletter',req.params.id);audit(req.user,'subscriber.deleted',req.params.id);res.json({success:true});});
admin.get('/audit',ownerOnly,(req,res)=>res.json({items:all('audit').slice(0,500)}));
admin.get('/settings',(req,res)=>res.json({settings:adminStoreSettings()}));
admin.put('/settings',ownerOnly,(req,res)=>{const v=settingsSchema.parse(req.body);const previous=settings();const emailSettings={...v.emailSettings,smtpUser:v.emailSettings.smtpUser||previous?.emailSettings?.smtpUser||'',smtpPassword:v.emailSettings.smtpPassword?encryptEmailSecret(v.emailSettings.smtpPassword):(previous?.emailSettings?.smtpPassword||'')};put('settings',{...v,emailSettings,id:'store'});audit(req.user,'settings.updated','Store configuration');res.json({settings:adminStoreSettings()});});
admin.get('/staff',ownerOnly,(req,res)=>res.json({items:all('users').filter(u=>u.role!=='customer').map(u=>({...publicUser(u),active:u.active}))}));
admin.post('/staff',ownerOnly,(req,res)=>{const v=z.object({name:z.string().trim().min(2).max(120),email,password,role:z.enum(['manager','fulfillment'])}).parse(req.body);if(all('users').some(u=>u.email===v.email))fail('Email already in use.');const u=put('users',{...v,password:hashPassword(v.password),active:true});audit(req.user,'staff.created',u.email);res.status(201).json({item:publicUser(u)});});
admin.patch('/staff/:id',ownerOnly,(req,res)=>{const u=get('users',req.params.id);if(!u||u.role==='customer'||u.role==='owner')fail('This account cannot be modified.');const v=z.object({active:z.boolean(),role:z.enum(['manager','fulfillment'])}).parse(req.body);put('users',{...u,...v});db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);audit(req.user,'staff.updated',u.email);res.json({success:true});});
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:8*1024*1024,files:1}});
admin.post('/upload',upload.single('file'),async(req,res)=>{if(!req.file)fail('Choose an image.');let output;try{output=await sharp(req.file.buffer,{limitInputPixels:40e6}).rotate().resize(2000,2000,{fit:'inside',withoutEnlargement:true}).webp({quality:85}).toBuffer();}catch{fail('Upload a valid PNG, JPEG, GIF or WebP image under 8 MB.');}const integration=settings()?.integrations?.cloudinary||{};const cloudName=integration.cloudName||process.env.CLOUDINARY_CLOUD_NAME;const configured=integration.enabled&&cloudName&&process.env.CLOUDINARY_API_KEY&&process.env.CLOUDINARY_API_SECRET&&cloudName!=='demo';if(configured){const cloudinaryOutput=await optimizeCloudinaryImage(req.file.buffer);cloudinary.config({cloud_name:cloudName,api_key:process.env.CLOUDINARY_API_KEY,api_secret:process.env.CLOUDINARY_API_SECRET});const options={folder:integration.folder||'beauty-baby',resource_type:'image',format:'webp'};if(integration.uploadPreset)options.upload_preset=integration.uploadPreset;const result=await new Promise((resolve,reject)=>{const stream=cloudinary.uploader.upload_stream(options,(error,value)=>error?reject(error):resolve(value));stream.end(cloudinaryOutput);});audit(req.user,'image.uploaded',result.public_id);return res.status(201).json({url:result.secure_url,publicId:result.public_id});}const name=uid()+'.webp';const {writeFile}=await import('node:fs/promises');await writeFile(path.join(uploads,name),output);audit(req.user,'image.uploaded',name);res.status(201).json({url:'/uploads/'+name});});
function validateReferences(kind,v,id) {
 if(['categories','brands','pages'].includes(kind)&&all(kind).some(r=>r.id!==id&&r.slug===v.slug))fail('This URL slug is already in use.');
 if(kind==='categories'&&v.parentId){const parent=get('categories',v.parentId);if(!parent||parent.parentId||v.parentId===id)fail('Choose a top-level parent category.');if(all('categories').some(c=>c.parentId===id))fail('A category with children cannot become a subcategory.');}
 if(kind==='products'){if(v.categoryId&&!get('categories',v.categoryId))fail('Category not found.');if(v.brandId&&!get('brands',v.brandId))fail('Brand not found.');if(v.subcategoryId&&get('categories',v.subcategoryId)?.parentId!==v.categoryId)fail('Subcategory must belong to the selected category.');
 const other=all('products').filter(p=>p.id!==id);const skus=[v.sku,...v.variants.map(x=>x.sku)];if(new Set(skus).size!==skus.length||other.some(p=>[p.sku,...p.variants.map(x=>x.sku)].some(s=>skus.includes(s))))fail('Product and variant SKUs must be unique.');}
}
admin.post('/products/import',(req,res)=>{const {products}=z.object({products:z.array(schemas.products).min(1).max(500)}).parse(req.body);const result=transaction(()=>products.map(v=>{const old=all('products').find(p=>p.sku===v.sku);validateReferences('products',v,old?.id);return put('products',{...old,...v});}));audit(req.user,'products.imported',String(result.length));res.json({count:result.length});});
admin.post('/products/bulk',(req,res)=>{const v=z.object({ids:z.array(z.string()).min(1).max(500),action:z.enum(['activate','archive','delete']),stock:z.number().int().min(0).optional()}).parse(req.body);transaction(()=>v.ids.forEach(id=>{const p=get('products',id);if(!p)fail('Product not found.',404);if(v.action==='delete'){if(all('orders').some(o=>o.items.some(i=>i.productId===id)))fail('Products with order history must be archived.');remove('products',id);}else put('products',{...p,active:v.action==='activate'});}));audit(req.user,'products.bulk',`${v.action}: ${v.ids.length}`);res.json({success:true});});
for(const [kind,schema] of Object.entries(schemas)){
 admin.get('/'+kind,(req,res)=>res.json({items:all(kind)}));
 admin.post('/'+kind,(req,res)=>{const v=schema.parse(req.body);validateReferences(kind,v);const item=put(kind,{...v,...(kind==='coupons'?{usedCount:0}:{})});audit(req.user,kind+'.created',item.name||item.title||item.code);res.status(201).json({item});});
 admin.put('/'+kind+'/:id',(req,res)=>{const old=get(kind,req.params.id);if(!old)fail('Item not found.',404);const v=schema.parse(req.body);validateReferences(kind,v,old.id);const item=put(kind,{...old,...v});audit(req.user,kind+'.updated',item.name||item.title||item.code);res.json({item});});
 admin.delete('/'+kind+'/:id',(req,res)=>{if(!get(kind,req.params.id))fail('Item not found.',404);if(kind==='products'&&all('orders').some(o=>o.items.some(i=>i.productId===req.params.id)))fail('This product has order history. Archive it instead.');if(kind==='categories'&&(all('products').some(p=>p.categoryId===req.params.id||p.subcategoryId===req.params.id)||all('categories').some(c=>c.parentId===req.params.id)))fail('Move the products and subcategories before deleting this category.');if(kind==='brands'&&all('products').some(p=>p.brandId===req.params.id))fail('Move products to another brand first.');remove(kind,req.params.id);audit(req.user,kind+'.deleted',req.params.id);res.json({success:true});});
}
app.use('/uploads',express.static(uploads,{maxAge:'30d',immutable:true}));
app.use('/api',(req,res)=>res.status(404).json({error:'API endpoint not found.'}));
if(existsSync('dist/index.html')){app.use(express.static('dist'));app.get('/{*path}',(req,res)=>res.sendFile(path.resolve('dist/index.html')));}
app.use((err,req,res,next)=>{if(err instanceof z.ZodError)return res.status(400).json({error:err.issues.map(i=>(i.path.join('.')?i.path.join('.')+': ':'')+i.message).join('; ')});if(err.code==='SQLITE_CONSTRAINT_UNIQUE'||err.message?.includes('UNIQUE constraint'))return res.status(409).json({error:'A record with that email, SKU, code or slug already exists.'});if(err instanceof multer.MulterError)return res.status(400).json({error:'Upload a single image under 8 MB.'});const status=err.status||500;if(status>=500)console.error(err);res.status(status).json({error:status>=500?'Something went wrong. Please try again.':err.message});});

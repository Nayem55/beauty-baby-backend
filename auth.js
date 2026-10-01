import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { get, createSession, findSession, deleteSession, consumeRateLimit } from './db.js';
export function hashPassword(password) { const salt=randomBytes(16).toString('hex'); return salt+':'+scryptSync(password,salt,64).toString('hex'); }
export function verifyPassword(password, hash) { const [salt,key]=hash.split(':'); return timingSafeEqual(Buffer.from(key,'hex'),scryptSync(password,salt,64)); }
const digest = s => createHash('sha256').update(s).digest('hex');
export function session(req,res,user) { const token=randomBytes(32).toString('hex'); createSession(digest(token),user.id,Date.now()+7*864e5); res.cookie('bb_session',token,{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:7*864e5,path:'/'}); }
const normalizedRole = role => ({ owner:'admin', manager:'store_manager', fulfillment:'store_manager' }[role] || role);
export const publicUser = u => u ? { id:u.id,name:u.name,email:u.email,phone:u.phone||'',role:normalizedRole(u.role) } : null;
export function identify(req,res,next) { const match=(req.headers.cookie||'').match(/(?:^|;\s*)bb_session=([a-f0-9]{64})(?:;|$)/); if(match) { req.sessionHash=digest(match[1]); const s=findSession(req.sessionHash); if(s) { const u=get('users',s.userId); if(u?.active) req.user=u; } } next(); }
export function requireUser(req,res,next) { if(!req.user) return res.status(401).json({error:'Please sign in to continue.'}); next(); }
export function requireAdmin(req,res,next) {
 if(!req.user) return res.status(401).json({error:'Please sign in to continue.'});
 const role=normalizedRole(req.user.role);
 if(!['admin','ad_manager','store_manager'].includes(role)) return res.status(403).json({error:'Admin access required.'});
 const storePath=/^\/(dashboard|orders|products|categories|brands|upload)(\/|$)/.test(req.path);
 const marketingPath=/^\/settings(\/|$)/.test(req.path);
 if(role==='ad_manager'&&!marketingPath) return res.status(403).json({error:'Your role can only manage marketing settings.'});
 if(role==='store_manager'&&!storePath) return res.status(403).json({error:'Your role can only manage store operations.'});
 req.user={...req.user,role};
 next();
}
export function ownerOnly(req,res,next) { if(normalizedRole(req.user?.role)!=='admin') return res.status(403).json({error:'Only an admin can perform this action.'}); next(); }
export function limit(label,max=30,window=15*60e3) { return (req,res,next)=>{ const result=consumeRateLimit(label+':'+req.ip,max,window); if(!result.allowed){res.set('Retry-After',String(result.retryAfter));return res.status(429).json({error:'Too many attempts. Please try again later.'});} next(); }; }

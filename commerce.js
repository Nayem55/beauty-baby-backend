import { all, get, put, settings, transaction, audit, db } from './db.js';
import { fail } from './validation.js';
import { randomBytes, createHash } from 'node:crypto';
export const round=n=>Math.round((n+Number.EPSILON)*100)/100;
export function quote(input) {
 const combined=new Map();
 for(const item of input.items) { const key=item.productId+':'+item.variantId; const prev=combined.get(key); combined.set(key,{...item,quantity:item.quantity+(prev?.quantity||0)}); }
 const items=[...combined.values()].map(item=>{
  const p=get('products',item.productId); if(!p?.active)fail('An item in your bag is no longer available.');
  const v=p.variants.find(v=>v.id===item.variantId);
  if(p.variants.length&&!v)fail(`Please choose an option for ${p.name}.`);
  if(!p.variants.length&&item.variantId)fail(`The selected option for ${p.name} is unavailable.`);
  if(item.quantity>99||item.quantity>(v?.stock??p.stock))fail(`Only ${v?.stock??p.stock} of ${p.name}${v?' — '+v.name:''} are available.`,409);
  return {...item,name:p.name,variantName:v?.name||'',sku:v?.sku||p.sku,price:v?.price??p.price,image:p.images[0]||'',type:p.type};
 });
 const subtotal=round(items.reduce((s,i)=>s+i.price*i.quantity,0)); let discount=0,coupon=null;
 if(input.couponCode){coupon=all('coupons').find(c=>c.code===input.couponCode.toUpperCase().trim()&&c.active);if(!coupon || (coupon.expiresAt&&Date.parse(coupon.expiresAt)<Date.now()) || (coupon.usageLimit && (coupon.usedCount||0)>=coupon.usageLimit))fail('This coupon is invalid, expired or fully redeemed.');if(subtotal<coupon.minOrder)fail(`This coupon requires a subtotal of ৳${coupon.minOrder}.`);discount=coupon.type==='percent'?subtotal*coupon.value/100:coupon.value;if(coupon.maxDiscount)discount=Math.min(discount,coupon.maxDiscount);discount=round(Math.min(discount,subtotal));}
 const s=settings(); const shipping=s.freeShippingMin>0&&subtotal-discount>=s.freeShippingMin?0:input.zone==='dhaka'?s.insideDhaka:s.outsideDhaka;
 return {items,subtotal,discount,shipping,total:round(subtotal-discount+shipping),couponCode:coupon?.code||'',couponId:coupon?.id||'',zone:input.zone};
}
export function createOrder(input,user,key) {
 return transaction(()=>{
 const fingerprint=createHash('sha256').update(JSON.stringify({input,userId:user?.id||null})).digest('hex');
 const previous=db.prepare('SELECT * FROM idempotency WHERE key=?').get(key);
 if(previous){if(previous.fingerprint!==fingerprint)fail('This checkout request has changed. Please submit again.',409);return get('orders',previous.order_id);}
 const s=settings(); if(!s[input.paymentMethod+'Enabled'])fail('This payment method is not available.');
 if(input.paymentMethod!=='cod'){if(!/^[a-zA-Z0-9]{6,40}$/.test(input.transactionId)||!/^(?:\+?88)?01[3-9]\d{8}$/.test(input.senderPhone))fail('Enter your transaction ID and a valid sender mobile number.');if(all('orders').some(o=>o.paymentMethod===input.paymentMethod&&o.transactionId.toUpperCase()===input.transactionId.toUpperCase()))fail('This payment transaction has already been submitted.',409);}
 const q=quote(input);
 for(const item of q.items){const p=get('products',item.productId);if(item.variantId)p.variants=p.variants.map(v=>v.id===item.variantId?{...v,stock:v.stock-item.quantity}:v);else p.stock-=item.quantity;put('products',p);}
 if(q.couponId){const c=get('coupons',q.couponId);put('coupons',{...c,usedCount:(c.usedCount||0)+1});}
 const order=put('orders',{...q,reference:'BB-'+randomBytes(5).toString('hex').toUpperCase(),customer:input.customer,userId:user?.id||null,paymentMethod:input.paymentMethod,transactionId:input.transactionId,senderPhone:input.senderPhone,paymentStatus:input.paymentMethod==='cod'?'unpaid':'pending_verification',status:'pending',trackingNumber:'',courier:'',adminNotes:'',history:[{status:'pending',at:new Date().toISOString(),note:'Order placed'}]});
 db.prepare('INSERT INTO idempotency VALUES(?,?,?)').run(key,fingerprint,order.id);
 audit(user,'order.created',order.reference);return order;
 });
}
const transitions={pending:['confirmed','cancelled'],confirmed:['processing','cancelled'],processing:['shipped','cancelled'],shipped:['delivered','returned'],delivered:['returned'],cancelled:[],returned:[]};
export function updateOrder(order,changes,user){return transaction(()=>{
 if(changes.status!==order.status){if(!transitions[order.status]?.includes(changes.status))fail(`Cannot move an order from ${order.status} to ${changes.status}.`);if(['confirmed','processing','shipped'].includes(changes.status)&&order.paymentMethod!=='cod'&&changes.paymentStatus!=='paid')fail('Verify the mobile payment before confirming this order.');
 if(['cancelled','returned'].includes(changes.status)&&!order.stockRestored){for(const i of order.items){const p=get('products',i.productId);if(!p)continue;if(i.variantId){const v=p.variants.find(v=>v.id===i.variantId);if(v)v.stock+=i.quantity;}else p.stock+=i.quantity;put('products',p);}order.stockRestored=true;}
 order.history.push({status:changes.status,at:new Date().toISOString(),note:'Updated by '+user.name});}
 if(changes.paymentStatus!==order.paymentStatus)order.history.push({status:changes.status,at:new Date().toISOString(),note:`Payment ${changes.paymentStatus} — ${user.name}`});
 const updated=put('orders',{...order,...changes});audit(user,'order.updated',`${order.reference}: ${updated.status}, ${updated.paymentStatus}`);return updated;
});}
export const allowedTransitions=status=>transitions[status]||[];

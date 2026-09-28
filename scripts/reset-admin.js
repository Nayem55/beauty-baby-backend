import { all, put, flush } from '../db.js';
import { hashPassword } from '../auth.js';
const email=(process.env.ADMIN_EMAIL||'admin@beautyandbaby.local').trim().toLowerCase();
const password=process.env.ADMIN_PASSWORD;
if(!password){console.error('Set ADMIN_PASSWORD in server/.env before running this command.');process.exit(1);}
const user=all('users').find(u=>u.email===email&&u.role==='owner');
if(!user){console.error('No owner account exists. Start the server once to initialize it.');process.exit(1);}
put('users',{...user,password:hashPassword(password)});await flush();console.log('Owner password reset successfully.');

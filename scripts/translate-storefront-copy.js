import { seed } from '../seed.js';
import { flush, close } from '../db.js';

// Applies the safe Bengali-to-English storefront migration in seed.js. Product data is not touched.
seed();
await flush();
await close();
console.log('Storefront copy migration completed.');

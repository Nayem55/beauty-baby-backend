import { seedCatalog } from '../seed.js';
import { flush, close } from '../db.js';

seedCatalog({replace:true});
await flush();
await close();
console.log('Demo catalog replaced with the Beauty & Baby toy collection.');

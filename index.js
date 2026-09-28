import { app } from './app.js';
import { flush } from './db.js';
const port=Number(process.env.PORT)||1009;
const host=process.env.HOST||'0.0.0.0';
await flush();
const server=app.listen(port,host,()=>console.log(`Beauty & baby API listening on http://${host}:${port}`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));

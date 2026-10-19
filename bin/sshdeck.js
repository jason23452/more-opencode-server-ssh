#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const dataFile = path.join(process.env.SSHDECK_HOME || path.join(os.homedir(), '.sshdeck'), 'hosts.json');
function load() { try { const h = JSON.parse(fs.readFileSync(dataFile, 'utf8')); if (!Array.isArray(h)) throw Error(); return h; } catch (e) { if (e.code === 'ENOENT') return []; throw Error(`Cannot read host data: ${e.message}`); } }
function save(hosts) { fs.mkdirSync(path.dirname(dataFile), { recursive: true, mode: 0o700 }); const tmp = `${dataFile}.${process.pid}.tmp`; fs.writeFileSync(tmp, `${JSON.stringify(hosts, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(tmp, dataFile); }
function validate(x, partial = false) {
  const fields = { alias: 'alias', hostname: 'hostname', port: 'port', username: 'username', keyPath: 'keyPath' };
  for (const k of ['alias', 'hostname', 'username']) if ((!partial || x[k] !== undefined) && (typeof x[k] !== 'string' || !x[k].trim())) throw Error(`${k} must be a non-empty string`);
  if (!partial || x.port !== undefined) { x.port = Number(x.port ?? 22); if (!Number.isInteger(x.port) || x.port < 1 || x.port > 65535) throw Error('port must be an integer from 1 to 65535'); }
  if (x.keyPath !== undefined && typeof x.keyPath !== 'string') throw Error('keyPath must be a string');
  return Object.fromEntries(Object.keys(fields).filter(k => x[k] !== undefined).map(k => [k, k === 'keyPath' ? x[k] : k === 'port' ? Number(x[k]) : x[k].trim()]));
}
function main(args) {
  if (args[0] === 'ui') return ui(args);
  if (args[0] !== 'host' || !['add', 'list', 'update', 'delete', 'remove'].includes(args[1])) throw Error('Usage: sshdeck host <add|list|update|delete> ... | sshdeck ui');
  const [, action, id, ...opts] = args, hosts = load();
  if (action === 'list') { console.log(hosts.length ? hosts.map(h => `${h.alias}\t${h.hostname}:${h.port}\t${h.username}\t${h.keyPath || '(default key)'}`).join('\n') : 'No hosts configured.'); return; }
  if (!id) throw Error('Host alias is required');
  if (action === 'add') { const obj = validate({ alias: id, ...parseOpts(opts) }); if (hosts.some(h => h.alias === id)) throw Error(`Host already exists: ${id}`); hosts.push(obj); }
  else { const i = hosts.findIndex(h => h.alias === id); if (i < 0) throw Error(`Unknown host: ${id}`); if (action === 'delete' || action === 'remove') hosts.splice(i, 1); else { const patch = parseOpts(opts); delete patch.alias; hosts[i] = validate({ ...hosts[i], ...patch }); } }
  save(hosts); console.log(`Host ${action === 'delete' || action === 'remove' ? 'deleted' : action === 'add' ? 'added' : 'updated'}: ${id}`);
}
function parseOpts(args) { const x = {}; for (let i=0;i<args.length;i++) { const m=args[i].match(/^--(hostname|port|user|username|key|key-path)$/); if (!m || !args[i+1] || args[i+1].startsWith('--')) throw Error(`Invalid option: ${args[i]}`); const k=({user:'username',key:'keyPath','key-path':'keyPath'})[m[1]]||m[1]; x[k]=args[++i]; } return x; }
const html = `<!doctype html><meta charset="utf-8"><title>sshdeck</title><h1>Host management</h1><form id="f"><input name="alias" placeholder="Alias" required><input name="hostname" placeholder="Hostname" required><input name="port" type="number" value="22"><input name="username" placeholder="Login account" required><input name="keyPath" placeholder="Key path"><button>Add host</button></form><p id="error" role="alert"></p><ul id="hosts"></ul><script>
async function refresh(){let r=await fetch('/api/hosts');let a=await r.json();hosts.innerHTML='';for(let h of a){let li=document.createElement('li');li.textContent=h.alias+' — '+h.username+'@'+h.hostname+':'+h.port+' ';let e=document.createElement('button');e.textContent='Edit';e.onclick=async()=>{let username=prompt('Login account',h.username);if(username)await fetch('/api/hosts/'+encodeURIComponent(h.alias),{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({username})}).then(check);refresh()};let d=document.createElement('button');d.textContent='Delete';d.onclick=async()=>{await fetch('/api/hosts/'+encodeURIComponent(h.alias),{method:'DELETE'});refresh()};li.append(e,d);hosts.append(li)}}
async function check(r){if(!r.ok)throw Error((await r.json()).error)}f.onsubmit=async e=>{e.preventDefault();error.textContent='';let x=Object.fromEntries(new FormData(f));x.port=Number(x.port);try{await fetch('/api/hosts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(x)}).then(check);f.reset();f.port.value=22;refresh()}catch(e){error.textContent=e.message}};refresh();</script>`;
function ui(args) {
  let port = 8787; for (let i=1;i<args.length;i++) if (args[i] === '--port') port=Number(args[++i]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('port must be 0-65535');
  const server=http.createServer((req,res)=>{ const send=(code,data,type='application/json')=>{res.writeHead(code,{'content-type':`${type}; charset=utf-8`,'cache-control':'no-store'});res.end(type==='application/json'?JSON.stringify(data):data)};
    if(req.method==='GET'&&req.url==='/'){send(200,html,'text/html');return}
    if(req.url==='/api/hosts'&&req.method==='GET'){try{return send(200,load())}catch(e){return send(500,{error:e.message})}}
    const m=req.url.match(/^\/api\/hosts\/([^/?]+)$/), collection=req.url==='/api/hosts'; if(!(collection&&req.method==='POST')&&!(m&&['PUT','DELETE'].includes(req.method)))return send(404,{error:'Not found'});
    let body='';req.on('data',c=>{body+=c;if(body.length>32768)req.destroy()});req.on('end',()=>{try{const hosts=load(), id=m&&decodeURIComponent(m[1]); if(req.method==='DELETE'){const i=hosts.findIndex(h=>h.alias===id);if(i<0)return send(404,{error:`Unknown host: ${id}`});hosts.splice(i,1);save(hosts);res.writeHead(204);return res.end()}
      const data=JSON.parse(body||'{}'); if(req.method==='POST'){const h=validate(data);if(hosts.some(x=>x.alias===h.alias))return send(409,{error:`Host already exists: ${h.alias}`});hosts.push(h);save(hosts);return send(201,h)}
      const i=hosts.findIndex(h=>h.alias===id);if(i<0)return send(404,{error:`Unknown host: ${id}`});const p={...data};delete p.alias;hosts[i]=validate({...hosts[i],...p});save(hosts);return send(200,hosts[i]);
    }catch(e){send(400,{error:e.message})}});
  });
  server.listen(port,'127.0.0.1',()=>console.log(`sshdeck UI: http://127.0.0.1:${server.address().port}`));
}
try { main(process.argv.slice(2)); } catch(e) { console.error(`sshdeck: ${e.message}`); process.exitCode=1; }

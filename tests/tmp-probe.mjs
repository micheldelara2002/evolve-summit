import fs from 'node:fs';
const BASE='https://share--evolve-summit.base44.app/api', APP='6a2c618daec1758ff2122225';
const auth=p=>JSON.parse(fs.readFileSync(`tests/.auth/${p}.json`,'utf8')).origins[0].localStorage.find(x=>x.name==='token').value;
async function q(p,e,query){const r=await fetch(`${BASE}/apps/${APP}/entities/${e}?q=${encodeURIComponent(JSON.stringify(query))}`,{headers:{'X-App-Id':APP,'Authorization':`Bearer ${auth(p)}`}});const t=await r.text();let b;try{b=JSON.parse(t)}catch{b=t}return {status:r.status,body:b}}
for(const p of ['speaker','partner']){
 console.log('\nPERSONA',p);
 for(const [e,q] of [['Participant',{role_in_event:'speaker',is_deleted:false}],['EventMembership',{is_deleted:false}],['PartnerRepresentative',{is_deleted:false}],['Person',{contact_email:p==='speaker'?'contato+speaker@evolveinst.com':'contato+partnermanager@evolveinst.com'}]]){
  const x=await q(p,e,q); console.log(e,JSON.stringify(x));
 }
}
console.log('\nCross-event participant');
for(const p of ['participant','manager']){
 const r=await q(p,'Participant',{is_deleted:false}); console.log(p,JSON.stringify(r.body));
}

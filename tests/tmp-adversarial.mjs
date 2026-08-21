import fs from 'node:fs';
const BASE='https://share--evolve-summit.base44.app/api';
const APP='6a2c618daec1758ff2122225';
const personas={participant:'participant',speaker:'speaker',partner:'partner',manager:'manager'};
const auth=p=>JSON.parse(fs.readFileSync(`tests/.auth/${p}.json`,'utf8')).origins[0].localStorage.find(x=>x.name==='token').value;
async function req(persona, path, opts={}) { const r=await fetch(`${BASE}${path}`,{...opts,headers:{'X-App-Id':APP,'Authorization':`Bearer ${auth(persona)}`,'Content-Type':'application/json',...(opts.headers||{})}}); let body; try{body=await r.json()}catch{body=await r.text()}; return {status:r.status,body}; }
async function entity(p,e,query){return req(p,`/apps/${APP}/entities/${e}?q=${encodeURIComponent(JSON.stringify(query))}`)}
async function fn(p,name,data){return req(p,`/apps/${APP}/functions/${name}`,{method:'POST',body:JSON.stringify(data),headers:{'Base44-Functions-Version':'prod'}})}
const out={};
for(const p of Object.keys(personas)){
  out[p]={};
  const me=await req(p,`/apps/${APP}/auth/me`); out[p].me=me.status;
  const parts=await entity(p,'Participant',{is_deleted:false});
  const myParts=(parts.body?.data||parts.body||[]).filter(x=>x.email?.toLowerCase()===({participant:'contato+attendee1@evolveinst.com',speaker:'contato+speaker@evolveinst.com',partner:'contato+partnermanager@evolveinst.com',manager:'contato+manager@evolveinst.com'}[p]||'').toLowerCase());
  const memberships=await entity(p,'EventMembership',{is_active:true,is_deleted:false});
  out[p].participantEvents=[...new Set(myParts.map(x=>x.event_id))];
  out[p].membershipEvents=[...new Set((memberships.body?.data||memberships.body||[]).map(x=>x.event_id))];
  const allEvents=[...new Set([...out[p].participantEvents,...out[p].membershipEvents])];
  out[p].events=allEvents;
  if(allEvents.length){
    const a=allEvents[0], b=allEvents.find(x=>x!==a);
    out[p].sessionsAuthorized=await fn(p,'getEventSessions',{eventIds:[a]});
    out[p].tracksAuthorized=await fn(p,'getEventTracks',{eventId:a});
    if(b) out[p].cross=await fn(p,'getEventSessions',{eventIds:[a,b]});
    out[p].directSession=await entity(p,'Session',{});
    out[p].directTrack=await entity(p,'Track',{});
  }
}
// Find speaker-owned/non-owned sessions using speaker auth data
const spSessions=(await entity('speaker','Session',{is_deleted:false})).body?.data || (await entity('speaker','Session',{is_deleted:false})).body || [];
const spParts=(await entity('speaker','Participant',{is_deleted:false})).body?.data || (await entity('speaker','Participant',{is_deleted:false})).body || [];
const speakerParticipant=spParts.find(x=>x.email==='contato+speaker@evolveinst.com');
const own=spSessions.find(s=>s.speaker_id===speakerParticipant?.id);
const other=spSessions.find(s=>s.speaker_id && s.speaker_id!==speakerParticipant?.id);
out.speakerMaterial={speakerParticipantId:speakerParticipant?.id,ownSession:own?.id,otherSession:other?.id};
if(own){out.speakerMaterial.own=await fn('speaker','updateSessionMaterial',{sessionId:own.id,materialUrl:own.material_url||'https://e2e.invalid/material'});}
if(other){out.speakerMaterial.other=await fn('speaker','updateSessionMaterial',{sessionId:other.id,materialUrl:'https://e2e.invalid/adversarial'});}
out.invalid= {sessions:await fn('participant','getEventSessions',{}),tracks:await fn('participant','getEventTracks',{}),material:await fn('participant','updateSessionMaterial',{})};
console.log(JSON.stringify(out,null,2));

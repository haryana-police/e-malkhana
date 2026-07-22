function normaliseFyYear(y){const n=parseInt(y,10);if(y.length<=2)return 2000+n;return n;}
function currentFyYear(){const now=new Date();const fy=(now.getMonth()>=3)?now.getFullYear():now.getFullYear()-1;return fy+1;}
function normaliseFirQuery(q){const s=String(q||'').trim();if(!s)return s;const low=s.toLowerCase();
  const numMatch=s.match(/(\d{1,6})\s*(?:\/\s*(\d{2,4}))?\s*$/);if(!numMatch)return s;const num=numMatch[1];
  const yr=numMatch[2]?normaliseFyYear(numMatch[2]):currentFyYear();
  const isDd=/(^|\s)dd(\s|$)/.test(low);const isFir=/(^|\s)fir(\s|$)/.test(low);const isDdFir=isDd&&isFir;
  if(isDdFir)return `DD FIR ${num}/${yr}`;if(isDd)return `DD ${num}/${yr}`;if(isFir)return `FIR ${num}/${yr}`;return num;}
function resolveCaseId(all,q){q=String(q||'').trim();if(!q)return{r:null,s:[]};
  const norm=normaliseFirQuery(q);
  let hit=all.find(c=>c.id===norm||c.id===q);if(hit)return{r:hit.id,s:[]};
  const normL=norm.toLowerCase(),qL=q.toLowerCase();hit=all.find(c=>c.id.toLowerCase()===normL||c.id.toLowerCase()===qL);if(hit)return{r:hit.id,s:[]};
  const looksFirDd=/(^|\s)(fir|dd)(\s|$)/i.test(q);const nm=norm.match(/\d{1,6}/);const num=nm?nm[0]:null;
  if(num){const matches=all.filter(c=>{const idL=c.id.toLowerCase();if(looksFirDd){const prefix=/dd fir/i.test(q)?'dd fir ':/(^|\s)dd(\s|$)/i.test(q)?'dd ':'fir ';return idL.startsWith(prefix+num+'/')||idL===prefix.trim()+' '+num;}return idL.includes(num);});if(matches.length===1)return{r:matches[0].id,s:[]};if(matches.length>1)return{r:null,s:matches.map(c=>c.id)};}
  const subs=all.filter(c=>c.id.toLowerCase().includes(qL));if(subs.length===1)return{r:subs[0].id,s:[]};return{r:null,s:subs.map(c=>c.id)};}

const all=[{id:'FIR 125/2026'},{id:'DD FIR 125/2026'},{id:'FIR abv/2026'},{id:'DD 41/2026'},{id:'FIR 214/2026'},{id:'MK-2026-000025'},{id:'DD FIR 125/2025'}];

const tests=['fir 125','FIR 125','fir no 125','125','dd 125','DD 125','dd fir 125','DD FIR 125','dd fir no 125','fir 214','mk-2026-000025','125/2025','dd 41','abv','fir abv'];
for(const t of tests){const r=resolveCaseId(all,t);console.log(JSON.stringify(t).padEnd(16),'->',r.r?('MATCH '+r.r):('NO MATCH '+JSON.stringify(r.s)));}

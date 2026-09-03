// Browser fuzz: persisted state is written by older versions, survives partial
// writes, and can be hand-edited. None of it may white-screen the page.
// Run against a static server on :8899 —  python3 -m http.server 8899
import { chromium } from 'playwright';
const cases = {
  'wrong types':        {'smc-signal-log-v1':'{"a":1}','smc-knowledge-v1':'[]','smc-paper-v1':'[]','smc-factor-stats-v1':'42'},
  'null inside arrays': {'smc-signal-log-v1':'[null,null]','smc-paper-v1':'{"positions":[null]}','smc-knowledge-v1':'{"rows":[null]}'},
  'garbage strings':    {'smc-signal-log-v1':'not json','smc-knowledge-v1':'{{{','smc-paper-v1':'null'},
  'missing fields':     {'smc-signal-log-v1':'[{"id":"x"}]','smc-paper-v1':'{"positions":[{"id":"p"}]}','smc-knowledge-v1':'{"rows":[{"day":1}]}'},
  'huge numbers':       {'smc-signal-log-v1':'[{"id":"h","dir":"BUY","entry":1e308,"sl":-1e308,"tp":0,"status":"won","confidence":1e9}]'},
  'learning garbage':   {'smc-factor-stats-v1':'{"factors":null,"metaExamples":"x","metaModel":"y","totalLogged":"abc"}'},
};
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
const p=await b.newPage();
// block everything external so the run is fast and deterministic
await p.route('**', r => {
  const u=r.request().url();
  return u.startsWith('http://localhost:8899') ? r.continue() : r.abort();
});
for (const [name, store] of Object.entries(cases)) {
  const errs=[];
  const onErr=e=>errs.push(e.message); const onCon=m=>{const t=m.text();if(m.type()==='error'&&!/ERR_|net::|404|Failed to load/i.test(t))errs.push('C:'+t);};
  p.on('pageerror',onErr); p.on('console',onCon);
  await p.goto('http://localhost:8899/index.html',{waitUntil:'domcontentloaded'});
  await p.evaluate(s=>{localStorage.clear();for(const[k,v]of Object.entries(s))localStorage.setItem(k,v);},store);
  await p.reload({waitUntil:'domcontentloaded'});
  await p.waitForTimeout(1800);
  const st = await p.evaluate(()=>({
    alive: !!document.getElementById('mRsi') && document.getElementById('mRsi').textContent.length>0,
    panels: ['tradeLog','paperContent','knowledgeContent','auditContent','qualityContent']
      .filter(id=>{const e=document.getElementById(id);return e && e.innerHTML.length>0;}).length
  }));
  console.log(`  ${name.padEnd(20)} alive=${st.alive} panels-rendered=${st.panels}/5 errors=${errs.length?errs[0].slice(0,70):'none'}`);
  p.off('pageerror',onErr); p.off('console',onCon);
}
await b.close();

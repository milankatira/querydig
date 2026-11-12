import { RULES } from '../rules.js';
import type { ScanSummary } from '../types.js';

export function renderHtml(s: ScanSummary): string {
  const used = new Set(s.findings.map((f) => f.ruleId));
  const data = {
    summary: { root: s.root, files: s.filesScanned, ms: s.durationMs, grade: s.grade, score: s.score, bySeverity: s.bySeverity, baseline: s.suppressedByBaseline, version: s.version, generated: new Date().toISOString(), live: s.live ?? null },
    findings: s.findings,
    rules: RULES.filter((r) => used.has(r.id)),
  };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>querydig report</title>
<style>
:root{--bg:#f7f7f5;--panel:#fff;--ink:#1b1b1f;--muted:#6b6b76;--line:#e4e4e0;--code:#f1f1ee;
--crit:#b3261e;--high:#d9480f;--med:#b7791f;--low:#2b6cb0;--ok:#2f855a;--chip:#efefec}
@media (prefers-color-scheme: dark){:root{--bg:#121214;--panel:#1b1b1f;--ink:#ececf1;--muted:#9a9aa6;--line:#2c2c33;--code:#232329;
--crit:#ff6b60;--high:#ff922b;--med:#f2c94c;--low:#74b0ff;--ok:#5fd39a;--chip:#26262c}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1100px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:22px;margin:0 0 4px;letter-spacing:-.01em}
.sub{color:var(--muted);margin-bottom:24px;word-break:break-all}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:24px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.card .k{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em}
.card .v{font-size:28px;font-weight:650;font-variant-numeric:tabular-nums}
.grade .v{font-size:34px}
.c-critical{color:var(--crit)}.c-high{color:var(--high)}.c-medium{color:var(--med)}.c-low{color:var(--low)}
.bar{display:flex;height:8px;border-radius:4px;overflow:hidden;background:var(--chip);margin-bottom:24px}
.bar span{display:block}
.controls{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px;align-items:center}
.controls input,.controls select{background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:7px 10px;font:inherit}
.controls input{flex:1;min-width:200px}
.chip{border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:999px;padding:5px 12px;cursor:pointer;font:inherit}
.chip[aria-pressed=false]{opacity:.45}
.f{background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:10px}
.f.critical{border-left-color:var(--crit)}.f.high{border-left-color:var(--high)}.f.medium{border-left-color:var(--med)}.f.low{border-left-color:var(--low)}
.f h3{margin:0;font-size:15px;display:flex;gap:8px;flex-wrap:wrap;align-items:baseline}
.sev{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em}
.rid{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);font-size:12px}
.loc{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--muted);margin:4px 0 8px;word-break:break-all}
pre{background:var(--code);border-radius:8px;padding:10px 12px;overflow-x:auto;margin:8px 0;font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
.fix{color:var(--ok)}
.ev{margin-top:6px;padding:6px 10px;border-radius:8px;background:color-mix(in oklab,#a855f7 12%,transparent);color:var(--ink);font-size:13px}
.ev b{color:#a855f7;font-weight:600;margin-right:6px}
.tag{background:var(--chip);border-radius:6px;padding:1px 7px;font-size:11px;color:var(--muted)}
details{margin-top:6px}summary{cursor:pointer;color:var(--muted)}
.empty{text-align:center;color:var(--muted);padding:48px 0}
footer{color:var(--muted);font-size:12px;margin-top:32px}
</style>
</head>
<body>
<main>
<h1>Query performance report</h1>
<div class="sub" id="sub"></div>
<div class="cards" id="cards"></div>
<div class="bar" id="bar"></div>
<div class="controls">
  <input id="q" type="search" placeholder="Filter by file, rule or message…" aria-label="Filter findings">
  <select id="rule" aria-label="Rule"><option value="">All rules</option></select>
  <select id="db" aria-label="Database"><option value="">All databases</option><option>mongodb</option><option>sql</option><option>unknown</option></select>
  <span id="sevchips"></span>
</div>
<div id="list"></div>
<footer id="foot"></footer>
</main>
<script>
const D=${json};
const SEV=['critical','high','medium','low','info'];
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const S=D.summary, on=new Set(['critical','high','medium','low','info']);
document.getElementById('sub').textContent=S.root+' · '+S.files+' files · '+(S.ms/1000).toFixed(2)+'s'+(S.baseline?' · '+S.baseline+' hidden by baseline':'')+(S.live&&!S.live.error?' · live: '+S.live.adapter+' '+S.live.database+', '+S.live.explained+' query plans':'');
const gc={A:'var(--ok)',B:'var(--ok)',C:'var(--med)',D:'var(--high)',F:'var(--crit)'}[S.grade];
document.getElementById('cards').innerHTML='<div class="card grade"><div class="k">Health</div><div class="v" style="color:'+gc+'">'+S.grade+' <small style="font-size:14px;color:var(--muted)">'+S.score+'/100</small></div></div>'+
 ['critical','high','medium','low'].map(k=>'<div class="card"><div class="k">'+k+'</div><div class="v c-'+k+'">'+S.bySeverity[k]+'</div></div>').join('');
const tot=D.findings.length||1;
document.getElementById('bar').innerHTML=['critical','high','medium','low'].map(k=>'<span style="width:'+(S.bySeverity[k]/tot*100)+'%;background:var(--'+({critical:'crit',high:'high',medium:'med',low:'low'}[k])+')"></span>').join('');
const rsel=document.getElementById('rule');
D.rules.forEach(r=>{const o=document.createElement('option');o.value=r.id;o.textContent=r.id+' '+r.title;rsel.appendChild(o)});
const chips=document.getElementById('sevchips');
['critical','high','medium','low'].forEach(k=>{const b=document.createElement('button');b.className='chip c-'+k;b.textContent=k;b.setAttribute('aria-pressed','true');
 b.onclick=()=>{on.has(k)?on.delete(k):on.add(k);b.setAttribute('aria-pressed',on.has(k));render()};chips.appendChild(b)});
const RM=Object.fromEntries(D.rules.map(r=>[r.id,r]));
function render(){
 const q=document.getElementById('q').value.toLowerCase(), rule=rsel.value, db=document.getElementById('db').value;
 const fs=D.findings.filter(f=>on.has(f.severity)&&(!rule||f.ruleId===rule)&&(!db||f.db===db)&&(!q||(f.file+' '+f.ruleId+' '+f.message+' '+f.title).toLowerCase().includes(q)));
 const L=document.getElementById('list');
 if(!fs.length){L.innerHTML='<div class="empty">'+(D.findings.length?'No findings match the filters.':'✔ No query performance issues found.')+'</div>';return}
 L.innerHTML=fs.slice(0,1000).map(f=>{const r=RM[f.ruleId]||{};return '<div class="f '+f.severity+'"><h3><span class="sev c-'+f.severity+'">'+f.severity+'</span><span class="rid">'+f.ruleId+'</span>'+esc(f.title)+' <span class="tag">'+f.db+'</span><span class="tag">'+f.confidence+' confidence</span></h3>'+
  '<div class="loc">'+esc(f.file)+(f.line>0?':'+f.line+':'+f.column:'')+'</div><pre>'+esc(f.snippet)+'</pre><div>'+esc(f.message)+'</div>'+(f.evidence?'<div class="ev"><b>live</b>'+esc(f.evidence.note)+(f.evidence.severityChange?' ('+f.evidence.severityChange.from+' → '+f.evidence.severityChange.to+')':'')+'</div>':'')+'<div class="fix"><b>Fix:</b> '+esc(f.fix)+'</div>'+
  (r.why?'<details><summary>Why is this slow?</summary><p>'+esc(r.why)+'</p>'+(r.example?'<div>Before</div><pre>'+esc(r.example.bad)+'</pre><div>After</div><pre>'+esc(r.example.good)+'</pre>':'')+'</details>':'')+'</div>'}).join('')+(fs.length>1000?'<div class="empty">Showing first 1000 of '+fs.length+'</div>':'');
}
['q','db'].forEach(id=>document.getElementById(id).addEventListener('input',render));rsel.addEventListener('input',render);
document.getElementById('foot').textContent='Generated by querydig v'+S.version+' on '+new Date(S.generated).toLocaleString();
render();
</script>
</body>
</html>
`;
}

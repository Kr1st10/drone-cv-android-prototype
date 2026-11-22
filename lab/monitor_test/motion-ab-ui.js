(function(){
  'use strict';
  const $=id=>document.getElementById(id),clone=v=>structuredClone(v);
  let workspace={schema:'dronecv-motion-ab-workspace-1',series:[],selected:null},ready=false,busy=false,writes=Promise.resolve(),revision=0,references=[];
  const current=()=>workspace.series.find(s=>s.id===workspace.selected);
  const enabled=()=>$('motionTestMode').value==='ab';
  const notice=s=>{$('abStatus').textContent=s;};
  function write(work){const pending=writes.catch(()=>{}).then(work);writes=pending;return pending;}
  function mergeRuns(stored){
    const memory=window.MotionUI?.runs()||[],identity=r=>MotionAB.canonical(Object.fromEntries(Object.entries(r).filter(([k])=>!['samples','sync_intervals','end_ms','complete','abort_reason'].includes(k))));
    const isPrefix=(r,m)=>identity(r)===identity(m)&&(!r.complete||MotionAB.canonical(r)===MotionAB.canonical(m))&&r.samples.length<=m.samples.length&&r.samples.every((s,i)=>MotionAB.canonical(s)===MotionAB.canonical(m.samples[i]));
    return [...new Map([...stored.filter(r=>!memory.some(m=>isPrefix(r,m))),...memory].map(r=>[MotionAB.canonical(r),r])).values()];
  }
  function updateReferences(rows){references=rows;render();}
  function persist(){
    // Snapshot after earlier transactions settle, so a queued background save
    // cannot restore pre-commit attempt state over a successful finalization.
    return write(()=>MotionStore.ab(clone(workspace))).catch(e=>{notice('Ошибка хранения A/B: '+e.message+'. Данные остаются в памяти; выгрузите JSON до закрытия страницы.');throw e;});
  }
  function options(retro=false){return {factor:$('abFactor').value,pair_count:Number($('abPairs').value),base_values:retro?{}:MotionUI.values(),variants:Object.fromEntries(['A','B'].map(slot=>[slot,{value:$('abValue'+slot).value.trim(),description:$('abDescription'+slot).value.trim(),provenance:'operator'}]))};}
  function next(s){return MotionAB.schedule(s).find(item=>!s.attempts.some(a=>a.pair_index===item.pair_index&&a.slot===item.slot&&a.complete));}
  function text(e){
    if(!e)return 'Недоступно';
    const f=x=>typeof x==='number'?(e.unit==='fraction'?(100*x).toFixed(2):(Number.isInteger(x)?String(x):x.toFixed(2))):String(x);
    if(e.status!=='available'&&e.status!=='bounded'&&e.value==null&&e.lower==null)return (e.status||'Недоступно')+(e.reason?': '+e.reason:'');
    return (e.lower!=null?f(e.lower)+'…'+(e.upper==null?'не подтверждено':f(e.upper)):e.value!=null?f(e.value):'Недоступно')+(e.unit?' '+(e.unit==='fraction'?'%':e.unit==='pp'?'п.п.':e.unit):'')+(e.coverage!=null?' (покрытие '+(100*e.coverage).toFixed(1)+'%)':'')+(e.n!=null?' n='+e.n:'')+(e.reason?'; '+e.reason:'');
  }
  function node(tag,value,parent){const n=document.createElement(tag);n.textContent=value;parent.append(n);return n;}
  function render(){
    const s=current(),locked=busy||!!window.MotionUI?.busy();
    const blocked=window.MotionUI?.startBlockReason();
    $('abPanel').hidden=!enabled();
    for(const id of ['motionStart','motionRepeat','motionNewSeries'])$(id).hidden=enabled();
    $('motionTestMode').disabled=locked;
    $('abNext').disabled=!ready||locked||!!blocked||!s||s.retrospective||!next(s);
    $('abRetry').disabled=!ready||locked||!!blocked||!s||s.retrospective;
    for(const id of ['abCreate','abRetro','abImport','abSeriesSelect'])$(id).disabled=!ready||locked;
    $('abExport').disabled=$('abCSV').disabled=!s;
    const select=$('abSeriesSelect');select.replaceChildren();
    for(const item of workspace.series){const o=node('option',item.id+' / '+item.factor+(item.retrospective?' / ретроспектива':''),select);o.value=item.id;}select.value=workspace.selected||'';
    const n=s&&!s.retrospective?next(s):null;
    $('abInstruction').textContent=n?`Пара ${n.pair_index} из ${s.pair_count}. Вариант ${n.slot}. Подготовьте телефон и начните запись`:
      s?s.retrospective?'Ретроспективная серия: заранее запланированного порядка нет.':'Все запланированные варианты выполнены. Импортируйте журналы и выберите попытки.':'Создайте серию из настроек движения ниже.';
    if(s&&!s.retrospective&&!locked&&blocked)$('abInstruction').textContent=blocked;
    $('abRetryInstruction').textContent=s?`Повтор: пара ${$('abRetryPair').value} из ${s.pair_count}. Вариант ${$('abRetrySlot').value}. Подготовьте телефон и начните запись перед нажатием «Повторить выбранный вариант».`:'';
    const root=$('abResults');root.replaceChildren();if(!s)return;
    node('p',`Фактор: ${s.factor}; A: ${s.variants.A.value} (${s.variants.A.description}); B: ${s.variants.B.value} (${s.variants.B.description}). Описания: ввод оператора.`,root);
    const runs=mergeRuns(references);
    const summary=MotionAB.summarize(s,runs);
    node('p',`Запланировано пар: ${summary.planned}; выполнено: ${summary.performed}; пригодно: ${summary.usable}.`,root);
    node('p',summary.aggregation_rule||'Разности рассчитываются внутри пар. Сводка: медиана и диапазон разностей по пригодным парам; кадры не являются повторными экспериментами.',root);
    for(const issue of s.import_issues||[])node('p',issue.name+': '+issue.reason,root);
    for(let i=1;i<=s.pair_count;i++){
      const p=MotionAB.compare(s,i,runs),names={complete:'пара полная',unconfirmed:'условия не подтверждены',incomparable:'данные несопоставимы',awaiting_attempt:'выберите попытки',awaiting_journal:'ожидается журнал',interrupted:'запись прервана'};node('h5',`Пара ${i}: ${names[p.state]||p.state}. План: ${s.retrospective?'не планировался':i%2?'AB':'BA'}`,root);
      node('p',(p.reasons||[]).join('; '),root);
      for(const slot of ['A','B']){
        const label=node('label',`Вариант ${slot}, попытка в сравнении `,root),sel=document.createElement('select');label.append(sel);node('option','Не выбрана',sel).value='';
        for(const a of s.attempts.filter(a=>a.pair_index===i&&a.slot===slot)){
          node('option',`№${a.attempt} / ${a.run_id} / ${a.complete?'завершена':a.abort_reason||'прервана'} / факт ${a.actual_order??'неизвестен'}`,sel).value=a.run_id;
        }
        sel.value=s.selections[`${i}:${slot}`]||'';sel.disabled=locked;
        sel.onchange=()=>{if(sel.value)MotionAB.select(s,i,slot,sel.value);else delete s.selections[`${i}:${slot}`];persist().catch(()=>{});render();};
      }
      const table=document.createElement('table');root.append(table);const head=document.createElement('tr');table.append(head);
      ['Метрика','A','B','Разница B−A','Доступность и ограничения'].forEach(t=>node('th',t,head));
      for(const r of p.rows||[]){const tr=document.createElement('tr');table.append(tr);[r.label,text(r.A),text(r.B),text(r.delta),[r.A?.reason,r.B?.reason,r.delta?.reason].filter(Boolean).join('; ')].forEach(t=>node('td',t,tr));}
    }
    if(summary.metrics)node('pre',JSON.stringify(summary.metrics,null,2),root).style.whiteSpace='pre-wrap';
  }
  async function create(retro=false){
    if(workspace.series.length>=8)throw Error('Предел 8 серий. Экспортируйте данные; используйте отдельный профиль браузера для новых серий.');
    const o=options(retro);if(retro)o.pair_count=1;
    const s=MotionAB.create(o);
    for(const slot of ['A','B']){const v=clone(s.base_values);if(s.factor==='speed')v.max_speed_px_s=Number(s.variants[slot].value);if(s.factor==='acceleration')v.acceleration_px_s2=Number(s.variants[slot].value);s.snapshots[slot]={values:v};}
    if(retro){
      const runs=await MotionStore.list(),a=$('abRetroA').value.trim(),b=$('abRetroB').value.trim();
      if(a===b)throw Error('Один прогон нельзя считать двумя независимыми повторениями.');
      for(const [slot,id] of [['A',a],['B',b]]){
        const candidates=runs.filter(r=>r.run_id===id);if(candidates.length!==1)throw Error('Нужен однозначный эталон '+id);
        const r=candidates[0];s.attempts.push({run_id:id,pair_index:1,slot,attempt:1,planned_order:null,actual_order:null,complete:r.complete,abort_reason:r.abort_reason});s.selections['1:'+slot]=id;
      }s.retrospective=true;
    }
    workspace.series.push(s);workspace.selected=s.id;++revision;await persist();render();notice('Серия сохранена. Выбор попыток для сравнения выполняется вручную.');
  }
  async function launch(item){
    if(busy||MotionUI.busy())return;
    const blocked=MotionUI.startBlockReason();if(blocked)throw Error(blocked);
    const s=current();if(!s||!item)throw Error('Нет следующего запуска.');
    busy=true;render();
    try{
      const {pair_index,slot}=item;if(!Number.isInteger(pair_index)||pair_index<1||pair_index>s.pair_count)throw Error('Неверный номер пары.');
      const attempt=s.attempts.filter(a=>a.pair_index===pair_index&&a.slot===slot).length+1;
      const planned=MotionAB.schedule(s).find(x=>x.pair_index===pair_index&&x.slot===slot);
      let run_id;do{run_id=MotionUI.freshRunId();}while(workspace.series.some(s=>s.attempts.some(a=>a.run_id===run_id)));
      const a={run_id,pair_index,slot,attempt,planned_order:planned.planned_order,actual_order:s.attempts.length+1,complete:false,abort_reason:'старт не подтверждён',started_at:new Date().toISOString()};
      s.attempts.push(a);await persist();
      let v=clone(s.snapshots[slot]?.values||s.base_values);
      if(s.factor==='speed')v.max_speed_px_s=Number(s.variants[slot].value);
      if(s.factor==='acceleration')v.acceleration_px_s2=Number(s.variants[slot].value);
      await MotionUI.startAB({...a,values:v,series_id:s.id});
    }finally{busy=false;render();}
  }
  function plan(ab,v,vp,generated){
    const s=current();if(!s||s.id!==ab.series_id)throw Error('Серия изменилась во время запуска.');
    const common=Object.values(s.snapshots).find(x=>x.plan),retained=s.snapshots[ab.slot]?.plan?s.snapshots[ab.slot]:['mode','build'].includes(s.factor)?common:null;
    if(common&&JSON.stringify(common.viewport)!==JSON.stringify(vp))throw Error('Изменилась рабочая область / установка экрана. Продолжите на прежнем экране.');
    const p=clone(retained?.plan||generated);
    if(!common)for(const snapshot of Object.values(s.snapshots))snapshot.values.m=clone(v.m);
    if(!s.snapshots[ab.slot]?.plan)s.snapshots[ab.slot]={values:clone(v),viewport:clone(vp),plan:clone(p)};
    if(['mode','build'].includes(s.factor)){s.snapshots.A=clone(s.snapshots[ab.slot]);s.snapshots.B=clone(s.snapshots[ab.slot]);}
    return p;
  }
  function started(ab){const a=current().attempts.find(a=>a.run_id===ab.run_id);a.abort_reason='не завершён';a.state='started';return clone(workspace);}
  function attemptFor(state,run){return state.series.find(s=>s.id===run.series_id)?.attempts.find(a=>a.run_id===run.run_id);}
  async function end(key,run){
    return write(async()=>{
      const snapshot=clone(workspace),a=attemptFor(snapshot,run);
      if(!a)throw Error('Попытка завершения отсутствует в серии.');
      const completion={complete:run.complete,abort_reason:run.abort_reason,ended_at:new Date().toISOString(),end_ms:run.end_ms};
      Object.assign(a,completion);
      // The shared workspace remains incomplete until the transaction containing
      // both the run and this private completion snapshot commits.
      await MotionStore.end(key,run,snapshot);
      Object.assign(attemptFor(workspace,run),completion);
    });
  }
  function failed(run){const a=attemptFor(workspace,run);if(a)Object.assign(a,{complete:false,abort_reason:run.abort_reason,end_ms:run.end_ms});render();}
  async function settled(ab){const a=current()?.attempts.find(a=>a.run_id===ab.run_id);if(!ab.committed){if(a){a.abort_reason='отмена или отказ до начала движения';a.state='preflight_failed';}await persist();}render();}
  async function retainSource(s,j,valid){
    const candidate={attempts:s.attempts,journals:s.journals.slice()},registration=await MotionAB.registerSource(candidate,{name:j.name,raw:j.raw,data:j.data});
    if(!valid())return null;
    const source=registration.source;
    if(!s.journals.some(x=>x.hash===source.hash)){
      if(s.journals.some(x=>x.run_id===source.run_id))throw Error('Конфликт содержимого одного run_id. Исходная привязка сохранена.');
      if(workspace.series.reduce((n,s)=>n+s.journals.reduce((m,x)=>m+x.raw.length*2,0),0)+j.raw.length*2>64*1024*1024)throw Error('A/B: исходники всех серий превышают лимит 64 МиБ в UTF-16. Выгрузите сохранённые серии.');
      s.journals.push(source);
    }
    MotionAB.bind(s,source.run_id,source.hash);j.abHash=source.hash;return source.hash;
  }
  async function ingest(journals,isCurrent){
    const s=current(),ticket=revision,valid=()=>s===current()&&ticket===revision&&isCurrent();if(!s)return;
    for(const j of journals){if(!j.raw||!valid())continue;
      try{const hash=await retainSource(s,j,valid);if(!hash)continue;s.analysis_errors??={};s.analysis_errors[s.journals.find(x=>x.hash===hash).run_id]='Ожидается калибровка и анализ.';}
      catch(e){if(!valid())return;s.import_issues??=[];if(!s.import_issues.some(i=>i.name===j.name&&i.reason===e.message))s.import_issues.push({name:j.name,reason:e.message});notice(j.name+': '+e.message);}
    }
    if(valid()){await persist();render();}
  }
  function analysisError(j,reason){
    const s=current(),source=s?.journals.find(x=>x.hash===j.abHash);if(!source)return;
    ++j.abTicket;s.analysis_errors??={};if(s.analysis_errors[source.run_id]===reason)return;
    s.analysis_errors[source.run_id]=reason;persist().catch(()=>{});render();
  }
  async function capture(j,run,result,isCurrent){
    const s=current(),ticket=revision,captureTicket=j.abTicket=(j.abTicket||0)+1;
    const parameters={calibration_points:clone(j.points),calibration_method:j.manual?'manual':'automatic'};
    const valid=()=>ticket===revision&&isCurrent()&&s===current()&&captureTicket===j.abTicket;
    if(!s||!s.attempts.some(a=>a.run_id===run.run_id))return;
    const signature=JSON.stringify({result,parameters});if(j.abSignature===signature&&!s.analysis_errors?.[run.run_id])return;
    const hash=await MotionAB.sha256(j.raw);if(!valid())return;
    if(!s.journals.some(x=>x.hash===hash))await retainSource(s,j,valid);
    if(!valid())return;
    MotionAB.bind(s,run.run_id,hash);
    const saved=MotionAB.recordAnalysis(s,run.run_id,{result,parameters,source_hash:hash},
      ()=>workspace.series.reduce((total,series)=>total+series.analyses.length,0)<64);
    if(!saved){
      const reason='Достигнут предел 64 сохранённых анализов. Выгрузите серии для продолжения в отдельном профиле браузера.';
      s.analysis_errors??={};s.analysis_errors[run.run_id]=reason;
      await persist();render();throw Error(reason);
    }
    if(s.analysis_errors)delete s.analysis_errors[run.run_id];
    await persist();j.abSignature=signature;render();
  }
  function action(fn,lock=false){return async()=>{if(lock&&(busy||MotionUI.busy()))return;try{if(lock){busy=true;render();}await fn();}catch(e){notice('Ошибка A/B: '+e.message+'. Доступные данные можно экспортировать.');}finally{if(lock)busy=false;render();}};}
  $('motionTestMode').onchange=()=>{workspace.mode=$('motionTestMode').value;render();if(ready)persist().catch(()=>{});};
  $('abRetryPair').oninput=$('abRetrySlot').onchange=render;
  $('abSeriesSelect').onchange=action(async()=>{workspace.selected=$('abSeriesSelect').value;++revision;await persist();});
  $('abCreate').onclick=action(()=>create(),true);$('abRetro').onclick=action(()=>create(true),true);
  $('abNext').onclick=action(()=>launch(next(current())));
  $('abRetry').onclick=action(()=>launch({pair_index:Number($('abRetryPair').value),slot:$('abRetrySlot').value}));
  async function availableRuns(){references=await MotionStore.list().catch(()=>references);return mergeRuns(references);}
  $('abExport').onclick=action(async()=>{const s=clone(current()),runs=await availableRuns(),bundle=await MotionAB.exportBundle(s,runs);MotionGallery.download('motion-ab-'+s.id+'.json',JSON.stringify(bundle),'application/json');});
  $('abCSV').onclick=action(async()=>{const s=clone(current());MotionGallery.download('motion-ab.csv',MotionAB.csv(s,await availableRuns()),'text/csv;charset=utf-8');});
  $('abImport').onchange=action(async()=>{
    const f=$('abImport').files[0];if(!f||f.size>256*1024*1024)throw Error('Экспорт отсутствует или больше 256 МиБ.');
    const bundle=await MotionAB.importBundle(JSON.parse(await f.text()));
    if(workspace.series.length>=8||workspace.series.reduce((n,s)=>n+s.journals.reduce((m,j)=>m+j.raw.length*2,0),0)+bundle.series.journals.reduce((n,j)=>n+j.raw.length*2,0)>64*1024*1024||workspace.series.reduce((n,s)=>n+s.analyses.length,0)+bundle.series.analyses.length>64)throw Error('Комплект превышает лимит 8 серий / 64 анализов / 64 МиБ исходников UTF-16.');
    if(workspace.series.some(s=>s.id===bundle.series.id))throw Error('Серия с таким ID уже существует. Повторный импорт не создаёт независимых повторений.');
    for(const r of bundle.runs)await MotionStore.save(r);
    workspace.series.push(bundle.series);workspace.selected=bundle.series.id;++revision;await persist();location.reload();
  },true);
  window.MotionABUI={enabled,notice,plan,started,end,failed,settled,capture,render,write,ingest,analysisError,references:updateReferences};
  MotionStore.ab().then(data=>{if(data?.schema==='dronecv-motion-ab-workspace-1')workspace=data;$('motionTestMode').value=workspace.mode||'single';ready=true;render();}).catch(e=>notice('Хранилище A/B недоступно: '+e.message));
})();

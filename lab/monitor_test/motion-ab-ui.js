(function(){
  'use strict';
  const $=id=>document.getElementById(id),clone=v=>structuredClone(v);
  let workspace={schema:'dronecv-motion-ab-workspace-1',series:[],selected:null},ready=false,busy=false,writes=Promise.resolve(),revision=0,references=[];
  let manualSelection=null, committed=clone(workspace);
  const manualDrafts=new Map();
  const openReports=new Set();
  const observation=(series,id)=>series?.manual_observations?.find(item=>item.run_id===id);
  const draftKey=(series,id)=>JSON.stringify([series,id]);
  function adopt(saved,sent){
    const merged=MotionStore.mergeAB(sent,workspace,saved,[],true);
    committed=clone(saved);
    MotionStore.reconcileAB(workspace,merged);
    $('motionTestMode').value=workspace.mode||'single';
  }
  const mergeWrite=(sent,stored)=>MotionStore.mergeAB(committed,sent,stored??committed);
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
  function persist(update=merged=>merged){
    return write(async()=>{
      const sent=clone(workspace);
      let applied=false;
      const saved=await MotionStore.ab(stored=>{
        const next=update(mergeWrite(sent,stored));
        applied=next!==undefined;
        return next;
      });
      if(applied)adopt(saved,sent);
    }).catch(e=>{notice('Ошибка хранения A/B: '+e.message+'. Данные остаются в памяти; выгрузите JSON до закрытия страницы.');throw e;});
  }
  async function saveManual(seriesId, runId, patch, baseline){
    const series=workspace.series.find(item=>item.id===seriesId);
    const runs=mergeRuns(references).filter(run=>run.run_id===runId);
    if(!series||runs.length!==1)throw Error('Нужен однозначный эталон выбранной попытки.');
    const run=runs[0];
    const local=clone(series);
    local.manual_observations??=[];
    MotionManual.save(local.manual_observations,local,run,patch);
    const key=draftKey(seriesId,runId);
    const draft={seriesId,runId,record:observation(local,runId)};
    manualDrafts.set(key,draft);
    try{
      await write(async()=>{
        const sent=committed;
        const saved=await MotionStore.ab(stored=>{
          const latest=stored?.series.find(item=>item.id===seriesId);
          const target=latest?.attempts.find(item=>item.run_id===runId);
          if(!target||MotionAB.canonical(target)!==MotionAB.canonical(baseline.attempt)||
              MotionAB.canonical(observation(latest,runId))!==MotionAB.canonical(baseline.answer)){
            throw Error('Попытка или её оценка изменилась в другой вкладке. Исходные данные сохранены.');
          }
          latest.manual_observations??=[];
          MotionManual.save(latest.manual_observations,latest,run,patch);
          latest.metadata_provenance??={};
          latest.metadata_provenance.manual_observations='operator';
          return stored;
        });
        adopt(saved,sent);
      });
      if(manualDrafts.get(key)===draft)manualDrafts.delete(key);
      render();
    }catch(e){
      const error=Error('Оценка осталась в памяти. Выгрузите ручной JSON. '+e.message);
      error.manualDraft=true;
      throw error;
    }
  }
  function manualExportSeries(series){
    const result=clone(series);
    for(const draft of manualDrafts.values()){
      if(draft.seriesId!==result.id)continue;
      result.manual_observations??=[];
      result.manual_observations=result.manual_observations.filter(item=>item.run_id!==draft.runId);
      result.manual_observations.push(clone(draft.record));
      result.metadata_provenance??={};
      result.metadata_provenance.manual_observations='operator';
    }
    return result;
  }
  function renderManual(series,runs){
    const {pair,slot,runId}=series&&manualSelection?.series===series.id?manualSelection:{};
    const id=runId??series?.selections[pair+':'+slot];
    const attempt=series?.attempts.find(a=>a.run_id===id&&a.pair_index===pair&&a.slot===slot);
    const refs=id?runs.filter(run=>run.run_id===id):[];
    window.MotionManualUI?.show(series,attempt&&refs.length===1?refs[0]:null,attempt,saveManual);
  }
  function showDraft(seriesId,runId){
    const series=current(),attempt=series?.attempts.find(row=>row.run_id===runId);
    if(series?.id!==seriesId||!attempt)return;
    manualSelection={series:seriesId,pair:attempt.pair_index,slot:attempt.slot,runId};
    renderManual(series,mergeRuns(references));
    $('manualPanel').open=true;
    $('manualEditor').querySelector('button[type=submit]')?.focus();
  }
  const warnManualExport=()=>MotionManualUI.warnUnsaved(current()?.id,showDraft);
  function options(retro=false){return {factor:$('abFactor').value,pair_count:Number($('abPairs').value),base_values:retro?{}:MotionUI.values(),variants:Object.fromEntries(['A','B'].map(slot=>[slot,{value:$('abValue'+slot).value.trim(),description:$('abDescription'+slot).value.trim(),provenance:'operator'}]))};}
  function next(s){return MotionAB.schedule(s).find(item=>!s.attempts.some(a=>a.pair_index===item.pair_index&&a.slot===item.slot&&a.complete));}
  function text(e){
    if(!e)return 'Недоступно';
    const f=x=>typeof x==='number'?(e.unit==='fraction'?(100*x).toFixed(2):(Number.isInteger(x)?String(x):x.toFixed(2))):String(x);
    if(e.status!=='available'&&e.status!=='bounded'&&e.value==null&&e.lower==null)return (e.status||'Недоступно')+(e.reason?': '+e.reason:'');
    return (e.lower!=null?f(e.lower)+'…'+(e.upper==null?'не подтверждено':f(e.upper)):e.value!=null?f(e.value):'Недоступно')+(e.unit?' '+(e.unit==='fraction'?'%':e.unit==='pp'?'п.п.':e.unit):'')+(e.coverage!=null?' (покрытие '+(100*e.coverage).toFixed(1)+'%)':'')+(e.n!=null?' n='+e.n:'')+(e.reason?'; '+e.reason:'');
  }
  function node(tag,value,parent){const n=document.createElement(tag);n.textContent=value;parent.append(n);return n;}
  function reportDetails(root,seriesId,part,title,pairIndex=null){
    const details=node('details','',root);
    details.dataset.abReport=JSON.stringify([seriesId,part,pairIndex]);
    details.open=openReports.has(details.dataset.abReport);
    node('summary',title,details);
    return details;
  }
  function reportTable(root, labels, rows){
    const scroll=node('div','',root);
    scroll.className='motion-report-table';
    const table=node('table','',scroll),head=node('tr','',table.createTHead()),body=table.createTBody();
    for(const label of labels)node('th',label,head).scope='col';
    for(const row of rows){
      const tr=node('tr','',body);
      for(const value of row)node('td',value,tr);
    }
  }
  function renderManualReport(root, pair, series, locked){
    const plan=series.retrospective?'порядок заранее не задан':pair.pair_index%2?'AB':'BA';
    const section=reportDetails(root,series.id,'manual',
      `Пара ${pair.pair_index} · ${pair.kind==='aa'?'A/A':'A/B'} · план ${plan}`,pair.pair_index);
    section.className='manual-pair-report';
    const labels={capture:'Первый правильный захват', drops:'Незапланированные срывы',
      before_hide:'Правильная рамка перед скрытием', after_return:'Правильная рамка после появления'};
    const values={before_hide:'До скрытия',after_return:'После появления',no_capture:'Захвата не было',
      clean:'Чистый',violation:'С нарушением',true:'Да',false:'Нет',same:'Без изменения',changed:'Изменилось'};
    const value=v=>v==null?'Не указано':typeof v==='object'?JSON.stringify(v):Object.hasOwn(values,v)?values[v]:String(v);
    const answer=a=>a.status==='known'?value(a.value):({unanswered:'Не оценено',uncertain:'Не удалось оценить',not_applicable:'Неприменимо'})[a.status];
    node('p',`Выбраны A: ${pair.run_ids.A??'нет'}, B: ${pair.run_ids.B??'нет'}.`,section);
    node('p',`Разности доступны для ${pair.rows.filter(row=>row.delta.status==='known').length} из ${pair.rows.length} показателей.`,section);
    for(const slot of ['A','B']){
      const entry=pair.attempts[slot], evidence=pair.journals[slot];
      if(entry){
        const answers=pair.rows.map(row=>row[slot]);
        node('p',`${slot} · Известно ${answers.filter(a=>a.status==='known').length} из ${answers.length}, `+
          `сценарий просмотрен полностью: ${entry.coverage.scenario_complete===true?'да':'не подтверждено'}. `+
          `Окно после появления: ${({complete:'просмотрено полностью',partial:'просмотрено частично',not_started:'не началось'})[entry.coverage.after_return]??'нет отметки'}.`,section);
      }
      if(evidence)node('p',`${slot} · ${evidence.status}`,section);
      for(const limitation of evidence?.limitations??[]){
        node('p',`${slot} · ${limitation.reason} Отметка оператора: ${limitation.operator}.`,section);
      }
      for(const conflict of evidence?.conflicts??[]){
        node('p',`${slot} · Расхождение с журналом (${labels[conflict.key]??conflict.key}). `+
          (conflict.reason?`${conflict.reason}: ${value(conflict.journal)}.`:`Отметка оператора: ${value(conflict.operator)}. Журнал: ${value(conflict.journal)}.`),section);
      }
    }
    if(pair.reasons.length)node('p',pair.reasons.join(' · '),section);
    const issues=pair.conditions?.checks.filter(check=>check.state!=='equal')??[];
    if(issues.length)reportTable(section,['Условие','A или план варианта','B или отметка оператора','Проверка'],
      issues.map(check=>[check.key,value(check.A),value(check.B),check.state==='different'?'Различается':'Не подтверждено']));
    if(pair.conditions){
      const declared=pair.conditions.checks.filter(check=>check.key.startsWith('variant.'));
      if(declared.length)reportTable(section,['Объявленный фактор','План','Факт','Проверка'],
        declared.map(check=>[check.key,value(check.A),value(check.B),({equal:'Совпадает',different:'Различается',unknown:'Не подтверждено'})[check.state]]));
    }
    reportTable(section,['Ручной показатель','A','B','Разность B−A','Ограничения'],pair.rows.map(row=>[
      labels[row.key]??'Круг '+row.key.slice(4),answer(row.A),answer(row.B),
      row.delta.status==='known'?value(row.delta.value):'Недоступна',
      [row.A.reason&&'A: '+row.A.reason,row.B.reason&&'B: '+row.B.reason,
        row.delta.status==='unavailable'&&'Разность: '+row.delta.reasons.join(' · ')].filter(Boolean).join(' · '),
    ]));
    const history=reportDetails(section,series.id,'attempts',`Все попытки (${pair.history.length})`,pair.pair_index);
    const list=node('ul','',history);
    for(const a of pair.history){
      const item=node('li',[
        `${a.slot} №${a.attempt} · ${a.run_id} · факт №${a.actual_order??'—'}`,
        a.complete?'завершена':'прервана: '+(a.abort_reason||'причина не указана'),
        a.assessment,a.selected?'выбрана':a.excluded,
        a.selected&&!a.reference_available?'Эталон недоступен':null,
        (a.attempt>1||a.repeat_reason)?`Повтор ${a.repeat_of??''}: ${a.repeat_reason??'причина не указана'}`:null,
        a.deviations&&'Отклонения: '+a.deviations,a.notes&&'Примечание: '+a.notes,
      ].filter(Boolean).join(' · '),list);
      if(a.reference_available){
        const edit=node('button','Открыть ручную оценку '+a.run_id,item);
        edit.type='button';edit.disabled=locked;edit.onclick=()=>showDraft(series.id,a.run_id);
      }
    }
  }
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
    const nextSetup=setupTarget(s,n),retrySetup=setupTarget(s,retryTarget());
    window.MotionManualUI?.targets(nextSetup,retrySetup,s);
    $('abInstruction').textContent=n?`Пара ${n.pair_index} из ${s.pair_count}. Вариант ${n.slot}, попытка ${nextSetup.attempt}. Подготовьте телефон и начните запись`:
      s?s.retrospective?'Ретроспективная серия: заранее запланированного порядка нет.':'Все запланированные варианты выполнены. Откройте ручную оценку нужного запуска.':'Настройте движение и создайте серию A/B.';
    if(s&&!s.retrospective&&!locked&&blocked)$('abInstruction').textContent=blocked;
    $('abRetryInstruction').textContent=retrySetup
      ? `Повтор: пара ${retrySetup.pair_index} из ${s.pair_count}, вариант ${retrySetup.slot}, попытка ${retrySetup.attempt}.`
      : '';
    const root=$('abResults');
    for(const details of root.querySelectorAll('details[data-ab-report]')){
      if(details.open)openReports.add(details.dataset.abReport);
      else openReports.delete(details.dataset.abReport);
    }
    root.replaceChildren();
    const runs=s?mergeRuns(references):[];renderManual(s,runs);if(!s)return;
    node('p',`Фактор: ${s.factor}; A: ${s.variants.A.value} (${s.variants.A.description}); B: ${s.variants.B.value} (${s.variants.B.description}). Описания: ввод оператора.`,root);
    node('h4','Ручное сравнение',root);
    node('p',MotionManualReport.rule(s),root);
    for(let i=1;i<=s.pair_count;i++){
      try{renderManualReport(root,MotionManualReport.compare(s,i,runs),s,locked);}
      catch(e){node('p',`Пара ${i} · Ручное сравнение недоступно. ${e.message}`,root);}
    }
    const journalReport=reportDetails(root,s.id,'journals','Сравнение по журналам');
    journalReport.id='abJournalCompare';
    const summary=MotionAB.summarize(s,runs);
    node('p',`Запланировано пар: ${summary.planned}; выполнено: ${summary.performed}; пригодно: ${summary.usable}.`,journalReport);
    node('p',summary.aggregation_rule||'Разности рассчитываются внутри пар. Сводка: медиана и диапазон разностей по пригодным парам; кадры не являются повторными экспериментами.',journalReport);
    for(const issue of s.import_issues||[])node('p',issue.name+': '+issue.reason,journalReport);
    for(let i=1;i<=s.pair_count;i++){
      const p=MotionAB.compare(s,i,runs),names={complete:'пара полная',unconfirmed:'условия не подтверждены',incomparable:'данные несопоставимы',awaiting_attempt:'выберите попытки',awaiting_journal:'ожидается журнал',interrupted:'запись прервана'};node('h5',`Пара ${i}: ${names[p.state]||p.state}. План: ${s.retrospective?'не планировался':i%2?'AB':'BA'}`,journalReport);
      node('p',(p.reasons||[]).join('; '),journalReport);
      for(const slot of ['A','B']){
        const label=node('label',`Вариант ${slot}, попытка в сравнении `,journalReport),sel=document.createElement('select');label.append(sel);node('option','Не выбрана',sel).value='';
        for(const a of s.attempts.filter(a=>a.pair_index===i&&a.slot===slot)){
          node('option',`№${a.attempt} / ${a.run_id} / ${a.complete?'завершена':a.abort_reason||'прервана'} / факт ${a.actual_order??'неизвестен'}`,sel).value=a.run_id;
        }
        sel.value=s.selections[`${i}:${slot}`]||'';sel.disabled=locked;
        if(window.MotionManualUI){
          const edit=node('button','Ручная оценка '+slot,journalReport);
          edit.type='button';edit.disabled=locked||!sel.value||runs.filter(run=>run.run_id===sel.value).length!==1;
          edit.onclick=()=>{
            manualSelection={series:s.id,pair:i,slot};
            renderManual(s,runs);
            $('manualPanel').open=true;
            $('manualEditor').querySelector('[name=capture]')?.focus();
          };
        }
        sel.onchange=()=>{if(sel.value)MotionAB.select(s,i,slot,sel.value);else delete s.selections[`${i}:${slot}`];persist().catch(()=>{});render();};
      }
      reportTable(journalReport,['Метрика','A','B','Разница B−A','Доступность и ограничения'],
        (p.rows||[]).map(r=>[r.label,text(r.A),text(r.B),text(r.delta),[r.A?.reason,r.B?.reason,r.delta?.reason].filter(Boolean).join('; ')]));
    }
    if(summary.metrics)node('pre',JSON.stringify(summary.metrics,null,2),journalReport).style.whiteSpace='pre-wrap';
  }
  async function create(retro=false){
    if(workspace.series.length>=8)throw Error('Предел 8 серий. Экспортируйте данные; используйте отдельный профиль браузера для новых серий.');
    const o=options(retro);if(retro)o.pair_count=1;
    const s=MotionAB.create(o);
    if(!retro)s.manual_selection_rule=MotionManualReport.POLICY;
    for(const slot of ['A','B']){const v=clone(s.base_values);if(s.factor==='speed')v.max_speed_px_s=Number(s.variants[slot].value);if(s.factor==='acceleration')v.acceleration_px_s2=Number(s.variants[slot].value);s.snapshots[slot]={values:v};}
    if(retro){
      const runs=await MotionStore.list(),a=$('abRetroA').value.trim(),b=$('abRetroB').value.trim();
      if(a===b)throw Error('Один прогон нельзя считать двумя независимыми повторениями.');
      for(const [slot,id] of [['A',a],['B',b]]){
        const candidates=runs.filter(r=>r.run_id===id);if(candidates.length!==1)throw Error('Нужен однозначный эталон '+id);
        const r=candidates[0];s.attempts.push({run_id:id,pair_index:1,slot,attempt:1,planned_order:null,actual_order:null,complete:r.complete,abort_reason:r.abort_reason});s.selections['1:'+slot]=id;
      }s.retrospective=true;
    }
    workspace.series.push(s);workspace.selected=s.id;++revision;await persist();render();notice('Серия сохранена. '+MotionManualReport.rule(s));
    if(!retro){
      $('abSeriesSettings').open=false;
      $('abSeriesSettings').querySelector('summary').focus();
    }
  }
  function setupTarget(series,item){
    if(!series||!item||series.retrospective||!MotionAB.schedule(series).some(row=>row.pair_index===item.pair_index&&row.slot===item.slot))return null;
    const {pair_index,slot}=item;
    const attempt=series.attempts.filter(row=>row.pair_index===pair_index&&row.slot===slot).length+1;
    return {series_id:series.id,pair_index,slot,attempt};
  }
  const retryTarget=()=>({pair_index:Number($('abRetryPair').value),slot:$('abRetrySlot').value});
  const queueKey=series=>MotionAB.canonical(series.attempts.map(({run_id,pair_index,slot,attempt,actual_order,complete})=>
    [run_id,pair_index,slot,attempt,actual_order,complete]));
  async function launch(retry=false){
    if(busy||MotionUI.busy())return;
    const blocked=MotionUI.startBlockReason();if(blocked)throw Error(blocked);
    const series=current(), item=series&&(retry?retryTarget():next(series)), expected=setupTarget(series,item);
    if(!expected)throw Error('Нет доступной попытки для запуска.');
    const expectedQueue=queueKey(series);
    const manualSetup=window.MotionManualUI?.confirmation(expected);
    const repeatReason=$('abRetryReason').value.trim();
    busy=true;render();
    try{
      const launch=await write(async()=>{
        let reserved;
        const sent=committed;
        const saved=await MotionStore.ab(stored=>{
          const latest=stored?.series.find(row=>row.id===expected.series_id);
          const target=latest&&setupTarget(latest,retry?item:next(latest));
          if(!target||queueKey(latest)!==expectedQueue||MotionAB.canonical(target)!==MotionAB.canonical(expected))return;
          let run_id;
          do{run_id=MotionUI.freshRunId();}while(stored.series.some(row=>row.attempts.some(a=>a.run_id===run_id)));
          const {pair_index,slot}=target;
          const attempt=MotionAB.begin(latest,{run_id,pair_index,slot,started_at:new Date().toISOString()});
          attempt.abort_reason='старт не подтверждён';
          if(attempt.attempt>1){
            const previous=latest.attempts.filter(row=>row.pair_index===pair_index&&row.slot===slot).at(-2);
            attempt.repeat_of=previous.run_id;
            attempt.repeat_reason=(retry&&repeatReason)||(!previous.complete&&previous.abort_reason)||'Причина не указана оператором';
          }
          if(manualSetup)attempt.manual_setup=manualSetup;
          const values=clone(latest.snapshots[slot]?.values||latest.base_values);
          if(latest.factor==='speed')values.max_speed_px_s=Number(latest.variants[slot].value);
          if(latest.factor==='acceleration')values.acceleration_px_s2=Number(latest.variants[slot].value);
          reserved={...attempt,values,series_id:latest.id};
          return stored;
        });
        if(saved)adopt(saved,sent);
        return reserved;
      });
      window.MotionManualUI?.resetConfirmation(launch ? expected : null);
      if(!launch){
        if(workspace.series.some(row=>row.id===expected.series_id))workspace.selected=expected.series_id;
        notice('Очередь серии изменилась в другой вкладке. Проверьте обновлённую цель и подтвердите условия перед запуском.');
        return;
      }
      if(retry)$('abRetryReason').value='';
      await MotionUI.startAB(launch);
    }finally{busy=false;render();}
  }
  function plan(ab,v,vp,generated){
    const s=workspace.series.find(series=>series.id===ab.series_id);if(!s)throw Error('Серия изменилась во время запуска.');
    const common=Object.values(s.snapshots).find(x=>x.plan),retained=s.snapshots[ab.slot]?.plan?s.snapshots[ab.slot]:['mode','build'].includes(s.factor)?common:null;
    if(common&&JSON.stringify(common.viewport)!==JSON.stringify(vp))throw Error('Изменилась рабочая область / установка экрана. Продолжите на прежнем экране.');
    const p=clone(retained?.plan||generated);
    if(!common)for(const snapshot of Object.values(s.snapshots))snapshot.values.m=clone(v.m);
    if(!s.snapshots[ab.slot]?.plan)s.snapshots[ab.slot]={values:clone(v),viewport:clone(vp),plan:clone(p)};
    if(['mode','build'].includes(s.factor)){s.snapshots.A=clone(s.snapshots[ab.slot]);s.snapshots.B=clone(s.snapshots[ab.slot]);}
    return p;
  }
  async function begin(run,scenario){
    const a=attemptFor(workspace,run);
    a.abort_reason='не завершён';a.state='started';
    const sent=clone(workspace);
    const result=await MotionStore.begin(run,scenario,stored=>mergeWrite(sent,stored));
    adopt(result.workspace,sent);
    return result.key;
  }
  function attemptFor(state,run){return state.series.find(s=>s.id===run.series_id)?.attempts.find(a=>a.run_id===run.run_id);}
  async function end(key,run){
    return write(async()=>{
      const sent=clone(workspace),snapshot=clone(sent),a=attemptFor(snapshot,run);
      if(!a)throw Error('Попытка завершения отсутствует в серии.');
      const completion={complete:run.complete,abort_reason:run.abort_reason,ended_at:new Date().toISOString(),end_ms:run.end_ms};
      Object.assign(a,completion);
      const saved=await MotionStore.end(key,run,stored=>mergeWrite(snapshot,stored));
      adopt(saved,sent);
    });
  }
  function failed(run){const a=attemptFor(workspace,run);if(a)Object.assign(a,{complete:false,abort_reason:run.abort_reason,end_ms:run.end_ms});render();}
  async function settled(ab){const a=attemptFor(workspace,ab);if(!ab.committed){if(a){a.abort_reason='отмена или отказ до начала движения';a.state='preflight_failed';}await persist();}render();}
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
    const reason='Достигнут предел 64 сохранённых анализов. Выгрузите серии для продолжения в отдельном профиле браузера.';
    let refused=false;
    await persist(merged=>{
      if(!valid())return;
      const series=merged.series.find(item=>item.id===s.id);
      const next={...series,analyses:series.analyses.slice(),analysis_errors:{...series.analysis_errors}};
      const saved=MotionAB.recordAnalysis(next,run.run_id,{result,parameters,source_hash:hash},
        ()=>merged.series.reduce((total,item)=>total+item.analyses.length,0)<64);
      refused=!saved;
      if(refused)next.analysis_errors[run.run_id]=reason;
      else delete next.analysis_errors[run.run_id];
      return {...merged,series:merged.series.map(item=>item===series?next:item)};
    });
    if(!valid())return;
    render();
    if(refused)throw Error(reason);
    j.abSignature=signature;
  }
  function action(fn,lock=false){return async()=>{if(lock&&(busy||MotionUI.busy()))return;try{if(lock){busy=true;render();}await fn();}catch(e){notice('Ошибка A/B: '+e.message+'. Доступные данные можно экспортировать.');}finally{if(lock)busy=false;render();}};}
  $('motionTestMode').onchange=()=>{workspace.mode=$('motionTestMode').value;render();if(ready)persist().catch(()=>{});};
  $('abRetryPair').oninput=$('abRetrySlot').onchange=render;
  $('abSeriesSelect').onchange=action(async()=>{workspace.selected=$('abSeriesSelect').value;++revision;await persist();});
  $('abCreate').onclick=action(()=>create(),true);$('abRetro').onclick=action(()=>create(true),true);
  $('abNext').onclick=action(()=>launch());
  $('abRetry').onclick=action(()=>launch(true));
  async function availableRuns(){references=await MotionStore.list().catch(()=>references);return mergeRuns(references);}
  $('abExport').onclick=action(async()=>{if(warnManualExport())return;const s=manualExportSeries(current()),runs=await availableRuns(),bundle=await MotionAB.exportBundle(s,runs);MotionGallery.download('motion-ab-'+s.id+'.json',JSON.stringify(bundle),'application/json');});
  $('abCSV').onclick=action(async()=>{if(warnManualExport())return;const s=clone(current());MotionGallery.download('motion-ab.csv',MotionAB.csv(s,await availableRuns()),'text/csv;charset=utf-8');});
  $('manualExport').onclick=action(async()=>{
    if(warnManualExport())return;
    const s=manualExportSeries(current()),runs=await availableRuns();
    const bundle=await MotionManualTransfer.exportBundle(s,runs);
    MotionGallery.download('motion-manual-'+s.id+'.json',JSON.stringify(bundle),'application/json');
  });
  $('manualCSV').onclick=action(async()=>{
    if(warnManualExport())return;
    const s=manualExportSeries(current());
    MotionGallery.download('motion-manual.csv',MotionManualTransfer.csv(s,await availableRuns()),'text/csv;charset=utf-8');
  });
  $('abImport').onchange=action(async()=>{
    const input=$('abImport'),f=input.files[0];
    input.value='';
    if(!f||f.size>256*1024*1024)throw Error('Экспорт отсутствует или больше 256 МиБ.');
    const data=JSON.parse(await f.text());
    const bundle=await MotionManualTransfer.importBundle(data);
    ++revision;
    await write(async()=>{
      const sent=committed;
      const saved=await MotionStore.importAB(stored=>{
        const latest=stored??committed;
        if(latest.series.some(s=>s.id===bundle.series.id))throw Error('Серия с таким ID уже существует. Исходные данные сохранены.');
        const all=[...latest.series,bundle.series];
        const sourceBytes=all.reduce((n,s)=>n+s.journals.reduce((m,j)=>m+j.raw.length*2,0),0);
        if(all.length>8||all.reduce((n,s)=>n+s.analyses.length,0)>64||sourceBytes>64*1024*1024){
          throw Error('Комплект превышает лимит 8 серий / 64 анализов / 64 МиБ исходников UTF-16.');
        }
        if(!bundle.series.retrospective&&bundle.series.attempts.some(a=>latest.series.some(s=>!s.retrospective&&s.attempts.some(old=>old.run_id===a.run_id)))){
          throw Error('Попытка с таким run_id уже принадлежит другой серии. Исходные данные сохранены.');
        }
        const memory=MotionUI.runs();
        for(const run of bundle.runs)if(memory.some(saved=>saved.run_id===run.run_id&&MotionAB.canonical(saved)!==MotionAB.canonical(run))){
          throw Error('Конфликт эталона run_id '+run.run_id+'. Исходные данные сохранены.');
        }
        return {...latest,mode:'ab',series:all,selected:bundle.series.id};
      },bundle.series,bundle.runs);
      adopt(saved,sent);
      references=await MotionStore.list().catch(()=>mergeRuns([...references,...bundle.runs]));
      MotionUI.includeImported(bundle.runs);
    });
    notice('Серия восстановлена.');
  },true);
  window.MotionABUI={enabled,notice,plan,begin,end,failed,settled,capture,render,write,ingest,analysisError,references:updateReferences};
  MotionStore.ab().then(data=>{
    if(data?.schema==='dronecv-motion-ab-workspace-1')workspace=data;
    committed=clone(workspace);
    $('motionTestMode').value=workspace.mode||'single';
    $('abSeriesSettings').open=!current();
    ready=true;
    render();
  }).catch(e=>notice('Хранилище A/B недоступно: '+e.message));
})();
